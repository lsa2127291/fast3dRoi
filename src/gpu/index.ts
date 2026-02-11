/**
 * GPU 模块桶导出
 */

// WebGPU 上下文
export {
    initWebGPU,
    getWebGPUContext,
    getWebGPUContextSync,
    resetWebGPUContext,
    WebGPUInitError,
} from './WebGPUContext';

export type {
    WebGPUContext,
    GPUCapabilities,
    GPULimitsSnapshot,
    WebGPUInitErrorType,
} from './WebGPUContext';

// 常量
export * from './constants';

// 数据模型
export * from './data';

// 渲染管线
export * from './pipelines';

// 渲染器
export { WebGPURenderer } from './WebGPURenderer';

// 勾画核心（里程碑2）
export * from './annotation';
