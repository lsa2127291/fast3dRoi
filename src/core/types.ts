/**
 * 医疗图像可视化系统 - 核心类型定义
 */

// ============== 体数据类型 ==============

/** 3D 维度 */
export type Vec3 = [number, number, number];

/** 4x4 仿射变换矩阵（行主序） */
export type Mat4 = Float64Array;

/** 体数据元信息 */
export interface VolumeMetadata {
    /** 体素尺寸 [x, y, z] 单位：像素 */
    dimensions: Vec3;
    /** 体素间距 [x, y, z] 单位：毫米 */
    spacing: Vec3;
    /** 原点坐标 [x, y, z] 单位：毫米 */
    origin: Vec3;
    /** 方向余弦矩阵 (3x3, 行主序) */
    direction: Float64Array;
    /** 数据类型 */
    dataType: 'int8' | 'uint8' | 'int16' | 'uint16' | 'int32' | 'uint32' | 'float32' | 'float64';
    /** 窗宽 (CT) */
    windowWidth?: number;
    /** 窗位 (CT) */
    windowCenter?: number;
    /** 模态 */
    modality?: string;
    /** 患者信息 */
    patientInfo?: {
        name?: string;
        id?: string;
        birthDate?: string;
    };
}

/** 体数据 */
export interface VolumeData {
    /** 元信息 */
    metadata: VolumeMetadata;
    /** 像素数据 */
    pixelData: TypedArray;
}

/** 类型化数组联合类型 */
export type TypedArray =
    | Int8Array
    | Uint8Array
    | Int16Array
    | Uint16Array
    | Int32Array
    | Uint32Array
    | Float32Array
    | Float64Array;

// ============== ROI 类型 ==============

/** ROI 颜色 [R, G, B, A] 0-255 */
export type RGBAColor = [number, number, number, number];

/** 单个 ROI 的元数据 */
export interface ROIMetadata {
    /** ROI ID (1-100) */
    id: number;
    /** ROI 名称 */
    name: string;
    /** 显示颜色 */
    color: RGBAColor;
    /** 是否可见 */
    visible: boolean;
    /** 是否锁定（禁止编辑） */
    locked: boolean;
}

/** 稀疏块坐标 */
export interface BlockCoord {
    bx: number;
    by: number;
    bz: number;
}

/** 稀疏块数据 */
export interface SparseBlock {
    /** 块坐标 */
    coord: BlockCoord;
    /** 位掩码数据：4 个 Uint32Array，每个 64³ = 262144 元素 */
    bitmaskLayers: Uint32Array[];
    /** 预混合颜色纹理数据 (RGBA8) */
    blendedColorData?: Uint8Array;
    /** GPU 纹理句柄 */
    gpuTexture?: WebGLTexture;
    /** 脏标记 */
    dirty: boolean;
}

// ============== 视图类型 ==============

/** 视图类型 */
export type ViewType = 'axial' | 'sagittal' | 'coronal' | 'volume3d';

/** MPR 视图状态 */
export interface MPRViewState {
    /** 当前切片索引 */
    sliceIndex: number;
    /** 窗宽 */
    windowWidth: number;
    /** 窗位 */
    windowCenter: number;
    /** 缩放级别 */
    zoom: number;
    /** 平移偏移 [x, y] 像素 */
    pan: [number, number];
}

/** 扩展体素空间配置 */
export interface ExtendedVolumeSpaceConfig {
    /** CT 原始维度 */
    ctDimensions: Vec3;
    /** CT 原始间距 */
    ctSpacing: Vec3;
    /** 扩展边距 [x, y, z] 单位：毫米 */
    margins: Vec3;
    /** 虚拟空间总维度（自动计算） */
    virtualDimensions: Vec3;
    /** CT 在虚拟空间中的偏移（自动计算） */
    ctOffset: Vec3;
}

// ============== 事件类型 ==============

/** 事件总线事件类型 */
export interface EventMap {
    'slice:change': { viewType: ViewType; sliceIndex: number };
    'slice:sync': {
        roiId: number;
        budgetHit: boolean;
        totalLineCount: number;
        totalDeferredLines: number;
        centerMM: Vec3;
        brushRadiusMM: number;
        erase: boolean;
        targets: Array<{
            viewType: 'axial' | 'sagittal' | 'coronal';
            sliceIndex: number;
            lineCount: number;
            deferredLines: number;
        }>;
    };
    'window:change': { windowWidth: number; windowCenter: number };
    'roi:paint': { roiId: number; voxels: Vec3[] };
    'roi:visibility': { roiId: number; visible: boolean };
    'roi:update': { region?: { min: Vec3; max: Vec3 } };
    'volume:loaded': { metadata: VolumeMetadata };
}

// ============== 常量 ==============

/** 稀疏块大小 */
export const BLOCK_SIZE = 64;

/** 最大 ROI 数量 */
export const MAX_ROI_COUNT = 100;

/** 最大 GPU 块缓存数量 */
export const MAX_GPU_BLOCKS = 256;
