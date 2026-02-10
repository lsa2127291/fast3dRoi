/**
 * GPU 全局常量 — 来自文档 §0, §2.1, §2.4, §4.3, §8
 *
 * 所有数值均为设计文档中的硬编码值，不可运行时修改。
 */

// ========== 坐标量化 — §0, §2.4 ==========

/** 坐标量化步长 (mm) */
export const QUANT_STEP_MM = 0.1;

/** 量化值下界 */
export const QUANT_MIN = -15000;

/** 量化值上界 */
export const QUANT_MAX = 15000;

/** 工作空间总范围 (mm) — 3m × 3m × 3m */
export const WORKSPACE_SIZE_MM = 3000;

// ========== 稀疏砖 — §4.3 ==========

/** 砖尺寸 (体素) */
export const BRICK_SIZE = 64;

/** 单批脏砖上限 */
export const DIRTY_BRICK_LIMIT = 24;

// ========== ROI — §0 ==========

/** 最大 ROI 数量 */
export const MAX_ROI_COUNT = 100;

// ========== 资源池 — §2.1 ==========

/** VertexPool 总大小 (bytes) — 1 GB */
export const VERTEX_POOL_SIZE = 1 * 1024 * 1024 * 1024;

/** IndexPool 总大小 (bytes) — 1 GB */
export const INDEX_POOL_SIZE = 1 * 1024 * 1024 * 1024;

/** SDF Bricks 单侧大小 (bytes) — 1.5 GB */
export const SDF_BRICK_SIZE = 1.5 * 1024 * 1024 * 1024;

/** ChunkTable + ROIMeta + QuantMeta + IndirectArgs (bytes) — 160 MB */
export const METADATA_POOL_SIZE = 160 * 1024 * 1024;

/** Preview/Mask/TempTexture (bytes) — 512 MB */
export const PREVIEW_POOL_SIZE = 512 * 1024 * 1024;

/** Compute Scratch + PrefixSum + Readback (bytes) — 512 MB */
export const SCRATCH_POOL_SIZE = 512 * 1024 * 1024;

// ========== 顶点格式 — §2.2 ==========

/** VertexQ 字节大小 (8B/vertex) */
export const VERTEX_Q_BYTES = 8;

/** 最大顶点数 (VertexPool / 8B) */
export const MAX_VERTEX_COUNT = VERTEX_POOL_SIZE / VERTEX_Q_BYTES;

/** 最大索引数 (IndexPool / 4B) */
export const MAX_INDEX_COUNT = INDEX_POOL_SIZE / 4;

// ========== 交互 — §8 ==========

/** 笔刷最大半径 (mm) */
export const MAX_BRUSH_RADIUS_MM = 50;

// ========== 性能目标 — §8 ==========

/** mousemove 当前视图预览目标 (ms, P95) */
export const TARGET_MOUSEMOVE_MS = 30;

/** 翻页切面切换目标 (ms, P95) */
export const TARGET_PAGE_FLIP_MS = 60;

/** mouseup 后三视图同步目标 (ms, P95) */
export const TARGET_SYNC_MS = 300;

// ========== 精度目标 — §8 ==========

/** 量化单轴最大误差 (mm) */
export const MAX_QUANT_ERROR_SINGLE_AXIS_MM = 0.05;

/** 三维欧氏最大误差 (mm) */
export const MAX_QUANT_ERROR_3D_MM = 0.0866;

// ========== 显存预算 — §2.1 ==========

/** 常驻预算 (bytes) — ~6.2 GB */
export const RESIDENT_BUDGET = 6.2 * 1024 * 1024 * 1024;

/** 弹性预算 (bytes) — +2.0 GB */
export const ELASTIC_BUDGET = 2.0 * 1024 * 1024 * 1024;
