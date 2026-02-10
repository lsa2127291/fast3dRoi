/**
 * GPU 缓冲池管理 — 文档 §2.1, §2.2
 *
 * 设计原则:
 * - 使用"少量大 Buffer + 子范围绑定"
 * - 禁止"每页独立 storage buffer + 高频重绑"
 * - 逻辑分页，底层 2~4 个大 Buffer
 */

import type { WebGPUContext } from '../WebGPUContext';
import { VERTEX_POOL_SIZE, INDEX_POOL_SIZE, VERTEX_Q_BYTES } from '../constants';

// ========== 类型定义 ==========

/** 页分配记录 */
export interface PageAllocation {
    /** 底层 buffer 索引 */
    poolIndex: number;
    /** buffer 内字节偏移 */
    byteOffset: number;
    /** 分配的字节大小 */
    byteLength: number;
}

/** 池统计信息 */
export interface PoolStats {
    totalBytes: number;
    usedBytes: number;
    freeBytes: number;
    pageCount: number;
    bufferCount: number;
}

// ========== 基础池实现 ==========

/**
 * GPU 缓冲池基类
 *
 * 逻辑分页：将大 GPU Buffer 划分为可分配的页。
 * 使用简单的线性分配器（bump allocator），释放时记录到 free list。
 */
class BufferPool {
    private buffers: GPUBuffer[] = [];
    private allocations = new Map<string, PageAllocation>();
    private freeList: PageAllocation[] = [];

    /** 每个底层 buffer 的大小 */
    private readonly bufferSize: number;
    /** 当前 buffer 的写入偏移 */
    private currentOffset: number = 0;
    /** 当前使用的 buffer 索引 */
    private currentBufferIndex: number = 0;
    /** 总已用字节 */
    private usedBytes: number = 0;

    private readonly totalSize: number;
    private readonly label: string;
    private readonly usage: GPUBufferUsageFlags;

    constructor(
        private readonly ctx: WebGPUContext,
        totalSize: number,
        label: string,
        usage: GPUBufferUsageFlags
    ) {
        this.totalSize = totalSize;
        this.label = label;
        this.usage = usage;

        // 每个 buffer 最大 512MB（安全值，远低于 2GB maxBufferSize）
        const maxBufferSize = 512 * 1024 * 1024;
        this.bufferSize = Math.min(totalSize, maxBufferSize);

        // 创建初始 buffer
        this.createBuffer();
    }

    /**
     * 分配一个页
     *
     * @param pageId 唯一标识（如 chunkId）
     * @param byteLength 需要的字节数
     * @returns 分配记录，或 null（池已满）
     */
    allocate(pageId: string, byteLength: number): PageAllocation | null {
        // 检查是否已分配
        if (this.allocations.has(pageId)) {
            return this.allocations.get(pageId)!;
        }

        // 对齐到 256 字节（WebGPU 绑定对齐要求）
        const alignedSize = Math.ceil(byteLength / 256) * 256;

        // 尝试从 free list 复用
        const freeIdx = this.freeList.findIndex(f => f.byteLength >= alignedSize);
        if (freeIdx >= 0) {
            const free = this.freeList.splice(freeIdx, 1)[0];
            const alloc: PageAllocation = {
                poolIndex: free.poolIndex,
                byteOffset: free.byteOffset,
                byteLength: alignedSize,
            };
            this.allocations.set(pageId, alloc);
            this.usedBytes += alignedSize;
            return alloc;
        }

        // 当前 buffer 空间不足，尝试下一个
        if (this.currentOffset + alignedSize > this.bufferSize) {
            if ((this.currentBufferIndex + 1) * this.bufferSize >= this.totalSize) {
                console.warn(`[${this.label}] 池已满，无法分配 ${byteLength} 字节`);
                return null;
            }
            this.currentBufferIndex++;
            this.currentOffset = 0;
            if (this.currentBufferIndex >= this.buffers.length) {
                this.createBuffer();
            }
        }

        const alloc: PageAllocation = {
            poolIndex: this.currentBufferIndex,
            byteOffset: this.currentOffset,
            byteLength: alignedSize,
        };

        this.currentOffset += alignedSize;
        this.usedBytes += alignedSize;
        this.allocations.set(pageId, alloc);
        return alloc;
    }

    /**
     * 释放一个页
     */
    free(pageId: string): void {
        const alloc = this.allocations.get(pageId);
        if (!alloc) return;

        this.allocations.delete(pageId);
        this.usedBytes -= alloc.byteLength;
        this.freeList.push(alloc);
    }

    /**
     * 获取页的 GPU buffer 和偏移（用于绑定）
     */
    getBinding(pageId: string): { buffer: GPUBuffer; offset: number; size: number } | null {
        const alloc = this.allocations.get(pageId);
        if (!alloc) return null;

        return {
            buffer: this.buffers[alloc.poolIndex],
            offset: alloc.byteOffset,
            size: alloc.byteLength,
        };
    }

    /**
     * 获取底层 buffer（用于整体绑定）
     */
    getBuffer(index: number = 0): GPUBuffer {
        return this.buffers[index];
    }

    /**
     * 获取底层 buffer 数量
     */
    getBufferCount(): number {
        return this.buffers.length;
    }

    /**
     * 获取统计信息
     */
    getStats(): PoolStats {
        return {
            totalBytes: this.totalSize,
            usedBytes: this.usedBytes,
            freeBytes: this.totalSize - this.usedBytes,
            pageCount: this.allocations.size,
            bufferCount: this.buffers.length,
        };
    }

    /**
     * 销毁所有 GPU buffer
     */
    destroy(): void {
        for (const buffer of this.buffers) {
            buffer.destroy();
        }
        this.buffers = [];
        this.allocations.clear();
        this.freeList = [];
        this.usedBytes = 0;
        this.currentOffset = 0;
        this.currentBufferIndex = 0;
    }

    private createBuffer(): void {
        const buffer = this.ctx.device.createBuffer({
            label: `${this.label}[${this.buffers.length}]`,
            size: this.bufferSize,
            usage: this.usage,
        });
        this.buffers.push(buffer);
    }
}

// ========== 导出的池类 ==========

/**
 * 顶点池 — 存储 VertexQ 数据 (8B/vertex)
 *
 * 默认 1GB，底层 2 个 512MB buffer
 */
export class VertexPool {
    private pool: BufferPool;

    constructor(ctx: WebGPUContext, totalSize: number = VERTEX_POOL_SIZE) {
        this.pool = new BufferPool(
            ctx,
            totalSize,
            'VertexPool',
            GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC
        );
    }

    /** 分配顶点页 */
    allocate(chunkId: string, vertexCount: number): PageAllocation | null {
        return this.pool.allocate(chunkId, vertexCount * VERTEX_Q_BYTES);
    }

    /** 释放顶点页 */
    free(chunkId: string): void {
        this.pool.free(chunkId);
    }

    /** 获取绑定信息 */
    getBinding(chunkId: string): { buffer: GPUBuffer; offset: number; size: number } | null {
        return this.pool.getBinding(chunkId);
    }

    /** 获取底层 buffer（用于整体绑定） */
    getBuffer(index: number = 0): GPUBuffer {
        return this.pool.getBuffer(index);
    }

    /** 获取统计信息 */
    getStats(): PoolStats {
        return this.pool.getStats();
    }

    /** 销毁 */
    destroy(): void {
        this.pool.destroy();
    }
}

/**
 * 索引池 — 存储 u32 索引数据 (4B/index)
 *
 * 默认 1GB，底层 2 个 512MB buffer
 */
export class IndexPool {
    private pool: BufferPool;

    constructor(ctx: WebGPUContext, totalSize: number = INDEX_POOL_SIZE) {
        this.pool = new BufferPool(
            ctx,
            totalSize,
            'IndexPool',
            GPUBufferUsage.STORAGE | GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC
        );
    }

    /** 分配索引页 */
    allocate(chunkId: string, indexCount: number): PageAllocation | null {
        return this.pool.allocate(chunkId, indexCount * 4);
    }

    /** 释放索引页 */
    free(chunkId: string): void {
        this.pool.free(chunkId);
    }

    /** 获取绑定信息 */
    getBinding(chunkId: string): { buffer: GPUBuffer; offset: number; size: number } | null {
        return this.pool.getBinding(chunkId);
    }

    /** 获取底层 buffer（用于整体绑定） */
    getBuffer(index: number = 0): GPUBuffer {
        return this.pool.getBuffer(index);
    }

    /** 获取统计信息 */
    getStats(): PoolStats {
        return this.pool.getStats();
    }

    /** 销毁 */
    destroy(): void {
        this.pool.destroy();
    }
}
