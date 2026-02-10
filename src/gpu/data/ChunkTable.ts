/**
 * Chunk 元数据表 — 文档 §2.1, §6.2
 *
 * 管理所有活跃 chunk 的元数据，包括 QuantMeta、AABB、脏标记和版本号。
 * chunk_table 与 quant_meta 采用同版本号提交，禁止跨版本混用 (§6.2)。
 */

import type { QuantMeta } from './VertexQ';
import { writeQuantMetaToBuffer, createDefaultQuantMeta } from './VertexQ';

// ========== 类型定义 ==========

/** 轴对齐包围盒 */
export interface AABB {
    min: [number, number, number];
    max: [number, number, number];
}

/** Chunk 描述符 */
export interface ChunkDescriptor {
    /** 唯一标识，格式 "bx_by_bz" */
    chunkId: string;
    /** 所属 ROI */
    roiId: number;
    /** 砖坐标 */
    brickCoord: [number, number, number];
    /** 量化元数据 */
    quantMeta: QuantMeta;
    /** 顶点数 */
    vertexCount: number;
    /** 索引数 */
    indexCount: number;
    /** 轴对齐包围盒 (mm) */
    aabb: AABB;
    /** 是否脏（需要重建） */
    dirty: boolean;
    /** 版本号 — §6.2 */
    version: number;
}

// ========== ChunkTable ==========

/**
 * Chunk 元数据表
 *
 * 维护所有活跃 chunk 的注册信息，支持：
 * - 脏砖查询与调度 (§4.3)
 * - AABB 粗裁剪 (§5)
 * - 版本号同步 (§6.2)
 * - QuantMeta 序列化（用于 GPU 上传）
 */
export class ChunkTable {
    private chunks = new Map<string, ChunkDescriptor>();
    private version = 0;

    // ========== CRUD ==========

    /** 添加或更新 chunk */
    addChunk(desc: ChunkDescriptor): void {
        desc.version = this.version;
        this.chunks.set(desc.chunkId, desc);
    }

    /** 移除 chunk */
    removeChunk(chunkId: string): void {
        this.chunks.delete(chunkId);
    }

    /** 获取 chunk */
    getChunk(chunkId: string): ChunkDescriptor | undefined {
        return this.chunks.get(chunkId);
    }

    /** 获取所有 chunk */
    getAllChunks(): ChunkDescriptor[] {
        return Array.from(this.chunks.values());
    }

    /** chunk 数量 */
    get size(): number {
        return this.chunks.size;
    }

    // ========== 脏砖管理 — §4.3 ==========

    /** 标记为脏 */
    markDirty(chunkId: string): void {
        const chunk = this.chunks.get(chunkId);
        if (chunk) {
            chunk.dirty = true;
        }
    }

    /** 清除脏标记 */
    clearDirty(chunkId: string): void {
        const chunk = this.chunks.get(chunkId);
        if (chunk) {
            chunk.dirty = false;
        }
    }

    /** 获取所有脏 chunk */
    getDirtyChunks(): ChunkDescriptor[] {
        return Array.from(this.chunks.values()).filter(c => c.dirty);
    }

    // ========== 查询 ==========

    /** 获取指定 ROI 的所有 chunk */
    getChunksForROI(roiId: number): ChunkDescriptor[] {
        return Array.from(this.chunks.values()).filter(c => c.roiId === roiId);
    }

    /**
     * AABB 粗裁剪 — §5
     *
     * 返回与给定平面相交的 chunk。
     * 平面方程: dot(normal, point) + d = 0
     */
    cullByPlane(
        planeNormal: [number, number, number],
        planeD: number
    ): ChunkDescriptor[] {
        return Array.from(this.chunks.values()).filter(chunk => {
            return aabbIntersectsPlane(chunk.aabb, planeNormal, planeD);
        });
    }

    // ========== 版本管理 — §6.2 ==========

    /** 递增版本号（在提交时调用） */
    incrementVersion(): number {
        this.version++;
        return this.version;
    }

    /** 获取当前版本号 */
    getVersion(): number {
        return this.version;
    }

    // ========== 序列化 ==========

    /**
     * 序列化所有 chunk 的 QuantMeta 为 GPU buffer
     *
     * 返回带版本号的 ArrayBuffer，确保与 chunk_table 同版本 (§6.2)
     */
    serializeQuantMeta(): { buffer: ArrayBuffer; version: number } {
        const chunks = this.getAllChunks();
        const metas = chunks.length > 0
            ? chunks.map(c => c.quantMeta)
            : [createDefaultQuantMeta()]; // 至少一个默认 meta

        const buffer = new ArrayBuffer(metas.length * 16); // 4 × f32 = 16 bytes
        writeQuantMetaToBuffer(metas, buffer, 0);

        return { buffer, version: this.version };
    }

    /** 清空所有 chunk */
    clear(): void {
        this.chunks.clear();
        this.version = 0;
    }
}

// ========== 工具函数 ==========

/**
 * 检测 AABB 是否与平面相交
 *
 * 使用 AABB 的正/负顶点法：
 * 如果正顶点在平面正侧且负顶点在平面负侧，则相交。
 */
function aabbIntersectsPlane(
    aabb: AABB,
    normal: [number, number, number],
    d: number
): boolean {
    // 正顶点：沿法线方向最远的角
    const pVertex: [number, number, number] = [
        normal[0] >= 0 ? aabb.max[0] : aabb.min[0],
        normal[1] >= 0 ? aabb.max[1] : aabb.min[1],
        normal[2] >= 0 ? aabb.max[2] : aabb.min[2],
    ];

    // 负顶点：沿法线方向最近的角
    const nVertex: [number, number, number] = [
        normal[0] >= 0 ? aabb.min[0] : aabb.max[0],
        normal[1] >= 0 ? aabb.min[1] : aabb.max[1],
        normal[2] >= 0 ? aabb.min[2] : aabb.max[2],
    ];

    const pDist = dot3(normal, pVertex) + d;
    const nDist = dot3(normal, nVertex) + d;

    // 如果正负顶点在平面两侧（或正好在平面上），则相交
    return pDist >= 0 && nDist <= 0 || pDist <= 0 && nDist >= 0;
}

function dot3(a: [number, number, number], b: [number, number, number]): number {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
