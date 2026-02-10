/**
 * VertexQ 量化顶点格式 — 文档 §2.2, §2.4
 *
 * 每个顶点 8 字节:
 *   xy: u32 — low16=x(i16), high16=y(i16)
 *   zf: u32 — low16=z(i16), high16=flags(u16)
 *
 * 量化规则 (§2.4):
 *   编码: q = round((p_mm - origin_mm) / 0.1)
 *   范围: q ∈ [-15000, 15000]
 *   解码: p_mm = origin_mm + q * 0.1
 */

import { QUANT_STEP_MM, QUANT_MIN, QUANT_MAX } from '../constants';

// ========== 类型定义 ==========

/** 编码后的量化顶点 (2 × u32 = 8 bytes) */
export interface VertexQEncoded {
    /** low16=x(i16), high16=y(i16) */
    xy: number;
    /** low16=z(i16), high16=flags(u16) */
    zf: number;
}

/** 每个 chunk/ROI 的量化元数据 — §2.3 */
export interface QuantMeta {
    /** 局部原点 (mm) */
    originMM: [number, number, number];
    /** 量化步长 (mm)，固定 0.1 */
    scaleMM: number;
}

/** 量化结果 */
export interface QuantResult {
    /** 量化后的 i16 值 */
    x: number;
    y: number;
    z: number;
    /** 是否在有效范围内 */
    inRange: boolean;
}

// ========== 量化编解码 ==========

/**
 * 将物理坐标 (mm) 量化为 i16 值 — §2.4 规则 1
 *
 * @param pMM 物理坐标 [x, y, z] (mm)
 * @param origin 量化原点 [x, y, z] (mm)
 * @returns 量化结果，包含 i16 值和范围检查
 */
export function quantize(
    pMM: [number, number, number],
    origin: [number, number, number]
): QuantResult {
    const x = Math.round((pMM[0] - origin[0]) / QUANT_STEP_MM);
    const y = Math.round((pMM[1] - origin[1]) / QUANT_STEP_MM);
    const z = Math.round((pMM[2] - origin[2]) / QUANT_STEP_MM);

    const inRange =
        isQuantInRange(x) &&
        isQuantInRange(y) &&
        isQuantInRange(z);

    return { x, y, z, inRange };
}

/**
 * 检查量化值是否在有效范围内 — §6.1
 */
export function isQuantInRange(q: number): boolean {
    return q >= QUANT_MIN && q <= QUANT_MAX;
}

/**
 * 将 i16 值打包为 VertexQ 的 u32 对 — §2.2
 *
 * @param qx 量化 x (i16)
 * @param qy 量化 y (i16)
 * @param qz 量化 z (i16)
 * @param flags 标志位 (u16, 0-65535)
 */
export function packVertexQ(qx: number, qy: number, qz: number, flags: number): VertexQEncoded {
    // i16 → u16 (二进制补码)
    const ux = toU16(qx);
    const uy = toU16(qy);
    const uz = toU16(qz);
    const uf = (flags & 0xFFFF) >>> 0;

    return {
        xy: ((uy << 16) | ux) >>> 0,
        zf: ((uf << 16) | uz) >>> 0,
    };
}

/**
 * 解码 VertexQ 回物理坐标 (mm) — §2.4 规则 3
 */
export function decodeVertexQ(v: VertexQEncoded, meta: QuantMeta): [number, number, number] {
    const qx = fromU16(v.xy & 0xFFFF);
    const qy = fromU16((v.xy >>> 16) & 0xFFFF);
    const qz = fromU16(v.zf & 0xFFFF);

    return [
        meta.originMM[0] + qx * meta.scaleMM,
        meta.originMM[1] + qy * meta.scaleMM,
        meta.originMM[2] + qz * meta.scaleMM,
    ];
}

/**
 * 提取 VertexQ 的 flags 字段
 */
export function getVertexFlags(v: VertexQEncoded): number {
    return (v.zf >>> 16) & 0xFFFF;
}

// ========== GPU Buffer 写入 ==========

/**
 * 将 VertexQ 数组写入 ArrayBuffer（用于 GPU 上传）
 *
 * 布局: 每个顶点 8 字节 [xy: u32, zf: u32]
 */
export function writeVertexQToBuffer(
    vertices: VertexQEncoded[],
    buffer: ArrayBuffer,
    byteOffset: number
): void {
    const view = new Uint32Array(buffer, byteOffset, vertices.length * 2);
    for (let i = 0; i < vertices.length; i++) {
        view[i * 2] = vertices[i].xy;
        view[i * 2 + 1] = vertices[i].zf;
    }
}

/**
 * 将 QuantMeta 数组写入 ArrayBuffer（用于 GPU 上传）
 *
 * 布局: 每个 QuantMeta 16 字节 [origin_x: f32, origin_y: f32, origin_z: f32, scale: f32]
 * 对应 WGSL: vec4<f32>
 */
export function writeQuantMetaToBuffer(
    metas: QuantMeta[],
    buffer: ArrayBuffer,
    byteOffset: number
): void {
    const view = new Float32Array(buffer, byteOffset, metas.length * 4);
    for (let i = 0; i < metas.length; i++) {
        view[i * 4] = metas[i].originMM[0];
        view[i * 4 + 1] = metas[i].originMM[1];
        view[i * 4 + 2] = metas[i].originMM[2];
        view[i * 4 + 3] = metas[i].scaleMM;
    }
}

/**
 * 创建默认 QuantMeta（原点 0, 步长 0.1mm）
 */
export function createDefaultQuantMeta(): QuantMeta {
    return {
        originMM: [0, 0, 0],
        scaleMM: QUANT_STEP_MM,
    };
}

// ========== 内部工具 ==========

/** i16 → u16 (二进制补码) */
function toU16(val: number): number {
    return ((val & 0xFFFF) >>> 0);
}

/** u16 → i16 (符号扩展，与 WGSL unpack_i16 一致) */
function fromU16(bits: number): number {
    const v = bits & 0xFFFF;
    return v >= 32768 ? v - 65536 : v;
}
