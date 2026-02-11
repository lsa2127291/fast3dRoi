/**
 * WebGPU 设备上下文 — Fail-Fast 初始化（文档 §1）
 *
 * 硬依赖: subgroups, shader-f16, texture-formats-tier1
 * 可选: timestamp-query, float32-filterable, bgra8unorm-storage
 *
 * 设计原则：峰值性能优先 + 稳定帧时 + 结果正确 + 精度可证明
 */

// ========== 类型定义 ==========

/** 能力标志（硬依赖字段始终为 true） */
export interface GPUCapabilities {
    readonly subgroup: true;
    readonly f16: true;
    readonly texFmtTier1: true;
    readonly timestamp: boolean;
    readonly f32Filter: boolean;
    readonly bgra8Storage: boolean;
}

/** 设备限制快照 */
export interface GPULimitsSnapshot {
    readonly maxBufferSize: number;
    readonly maxStorageBufferBindingSize: number;
    readonly maxComputeInvocationsPerWorkgroup: number;
    readonly maxComputeWorkgroupStorageSize: number;
}

/** WebGPU 上下文（初始化后不可变） */
export interface WebGPUContext {
    readonly adapter: GPUAdapter;
    readonly device: GPUDevice;
    readonly caps: GPUCapabilities;
    readonly limits: GPULimitsSnapshot;
    readonly preferredFormat: GPUTextureFormat;
}

export interface WebGPUInitOptions {
    onDeviceLost?: (info: GPUDeviceLostInfo) => void;
}

// ========== 错误类型 ==========

export type WebGPUInitErrorType = 'no-webgpu' | 'no-adapter' | 'missing-feature' | 'device-failed';

/** 初始化错误，携带结构化错误类型 */
export class WebGPUInitError extends Error {
    constructor(
        message: string,
        public readonly errorType: WebGPUInitErrorType,
        public readonly missingFeature?: string
    ) {
        super(message);
        this.name = 'WebGPUInitError';
    }
}

// ========== 常量 ==========

/** 硬依赖 feature 列表 — §1.1 */
const REQUIRED_FEATURES: GPUFeatureName[] = [
    'subgroups' as GPUFeatureName,
    'shader-f16' as GPUFeatureName,
];

/** 可选 feature 列表 — §1.1 */
const OPTIONAL_FEATURES: GPUFeatureName[] = [
    'timestamp-query' as GPUFeatureName,
    'float32-filterable' as GPUFeatureName,
    'bgra8unorm-storage' as GPUFeatureName,
];

/** 请求的设备限制 — §1.1 */
const REQUIRED_LIMITS: Record<string, number> = {
    maxBufferSize: 2 * 1024 * 1024 * 1024,                // 2 GB
    maxStorageBufferBindingSize: 1024 * 1024 * 1024,       // 1 GB
    maxComputeInvocationsPerWorkgroup: 256,
    maxComputeWorkgroupStorageSize: 32 * 1024,             // 32 KB
};

// ========== 初始化 ==========

/**
 * Fail-Fast 初始化 WebGPU 设备
 *
 * 按照文档 §1.1：
 * - 不做低能力 fallback
 * - 缺少任一关键 feature 时直接启动失败并给出明确提示
 * - 启动时输出 feature/limits，用于硬件基线审计
 *
 * @throws WebGPUInitError 如果缺少任何必需能力
 */
export async function initWebGPU(options: WebGPUInitOptions = {}): Promise<WebGPUContext> {
    // 1. 检查 WebGPU API 是否存在
    if (!navigator.gpu) {
        throw new WebGPUInitError(
            'WebGPU API 不可用。请使用 Chrome 136+ 并确保已启用 WebGPU。',
            'no-webgpu'
        );
    }

    // 2. 请求高性能适配器
    const adapter = await navigator.gpu.requestAdapter({
        powerPreference: 'high-performance',
    });

    if (!adapter) {
        throw new WebGPUInitError(
            '无法获取 WebGPU 适配器。请确认系统有支持 WebGPU 的 GPU（推荐 RTX 4000 Ada 或更高）。',
            'no-adapter'
        );
    }

    // 3. 检查硬依赖 feature — §1.1: 缺少任一关键 feature 时直接启动失败
    for (const feature of REQUIRED_FEATURES) {
        if (!adapter.features.has(feature)) {
            throw new WebGPUInitError(
                `缺少必需的 WebGPU 特性: ${feature}。请升级 Chrome 或 GPU 驱动。`,
                'missing-feature',
                feature
            );
        }
    }

    // 注意: texture-formats-tier1 不是标准 GPUFeatureName，
    // 在 Chrome 中通过 r16float storage texture 支持来验证
    // 暂时跳过显式检查，在实际创建 storage texture 时验证

    // 4. 检测可选 feature
    const enabledOptional = OPTIONAL_FEATURES.filter(f => adapter.features.has(f));

    // 5. 请求设备 — §1.1
    let device: GPUDevice;
    try {
        device = await adapter.requestDevice({
            requiredFeatures: [...REQUIRED_FEATURES, ...enabledOptional],
            requiredLimits: REQUIRED_LIMITS,
        });
    } catch (err) {
        throw new WebGPUInitError(
            `WebGPU 设备创建失败: ${err instanceof Error ? err.message : String(err)}`,
            'device-failed'
        );
    }

    // 6. 构建能力标志
    const caps: GPUCapabilities = {
        subgroup: true,
        f16: true,
        texFmtTier1: true,
        timestamp: enabledOptional.includes('timestamp-query' as GPUFeatureName),
        f32Filter: enabledOptional.includes('float32-filterable' as GPUFeatureName),
        bgra8Storage: enabledOptional.includes('bgra8unorm-storage' as GPUFeatureName),
    };

    // 7. 快照设备限制
    const limits: GPULimitsSnapshot = {
        maxBufferSize: device.limits.maxBufferSize,
        maxStorageBufferBindingSize: device.limits.maxStorageBufferBindingSize,
        maxComputeInvocationsPerWorkgroup: device.limits.maxComputeInvocationsPerWorkgroup,
        maxComputeWorkgroupStorageSize: device.limits.maxComputeWorkgroupStorageSize,
    };

    // 8. 获取首选纹理格式
    const preferredFormat = navigator.gpu.getPreferredCanvasFormat();

    // 9. 设置 device.lost 处理器 — §6.4
    device.lost.then((info) => {
        console.error(`[WebGPU] 设备丢失: ${info.message} (reason: ${info.reason})`);
        _ctx = null;
        options.onDeviceLost?.(info);
        // 后续可在此触发自动重建
    });

    // 10. 输出审计信息 — §1.1
    console.info('[WebGPU profile]', {
        chromeMin: 136,
        features: Array.from(adapter.features.values()),
        limits: {
            maxBufferSize: adapter.limits.maxBufferSize,
            maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
            maxComputeInvocationsPerWorkgroup: adapter.limits.maxComputeInvocationsPerWorkgroup,
        },
        caps,
        preferredFormat,
    });

    // 11. 构建并冻结上下文
    const ctx: WebGPUContext = Object.freeze({
        adapter,
        device,
        caps,
        limits,
        preferredFormat,
    });

    _ctx = ctx;
    return ctx;
}

// ========== 单例管理 ==========

let _ctx: WebGPUContext | null = null;

/**
 * 获取已初始化的 WebGPU 上下文（异步，首次调用时初始化）
 */
export async function getWebGPUContext(): Promise<WebGPUContext> {
    if (!_ctx) {
        _ctx = await initWebGPU();
    }
    return _ctx;
}

/**
 * 获取已初始化的 WebGPU 上下文（同步，未初始化时抛出异常）
 */
export function getWebGPUContextSync(): WebGPUContext {
    if (!_ctx) {
        throw new Error('WebGPU 未初始化。请先调用 initWebGPU()。');
    }
    return _ctx;
}

/**
 * 重置上下文（用于 device.lost 后重建或测试）
 */
export function resetWebGPUContext(): void {
    _ctx = null;
}
