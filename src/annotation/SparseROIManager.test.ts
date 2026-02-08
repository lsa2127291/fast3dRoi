/**
 * SparseROIManager 单元测试
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock WebGL2RenderingContext
const mockGl = {} as WebGL2RenderingContext;

describe('SparseROIManager', () => {
    beforeEach(() => {
        vi.resetModules();
    });

    describe('初始化', () => {
        it('应该正确初始化虚拟空间', async () => {
            const { SparseROIManager } = await import('@/annotation/SparseROIManager');
            const manager = new SparseROIManager();

            manager.initialize(mockGl, [512, 512, 300], [1, 1, 2]);

            const info = manager.getVirtualSpaceInfo();
            expect(info.dimensions).toEqual([3000, 3000, 300]);
            expect(info.blockSize).toBe(64);
        });

        it('应该计算正确的 CT 偏移', async () => {
            const { SparseROIManager } = await import('@/annotation/SparseROIManager');
            const manager = new SparseROIManager();

            manager.initialize(mockGl, [512, 512, 300], [1, 1, 2]);

            const info = manager.getVirtualSpaceInfo();
            // CT 应该居中放置: (3000 - 512) / 2 = 1244
            expect(info.ctOffset[0]).toBe(1244);
            expect(info.ctOffset[1]).toBe(1244);
            expect(info.ctOffset[2]).toBe(0);
        });
    });

    describe('体素 ROI 操作', () => {
        it('应该正确设置和获取体素 ROI', async () => {
            const { SparseROIManager } = await import('@/annotation/SparseROIManager');
            const manager = new SparseROIManager();
            manager.initialize(mockGl, [512, 512, 300], [1, 1, 2]);

            // 设置体素 ROI
            manager.setVoxelROI(100, 100, 50, 1, true);

            // 获取该体素的 ROI
            const rois = manager.getVoxelROIs(100, 100, 50);
            expect(rois).toContain(1);
        });

        it('应该支持多个 ROI 重叠', async () => {
            const { SparseROIManager } = await import('@/annotation/SparseROIManager');
            const manager = new SparseROIManager();
            manager.initialize(mockGl, [512, 512, 300], [1, 1, 2]);

            // 设置多个 ROI
            manager.setVoxelROI(100, 100, 50, 1, true);
            manager.setVoxelROI(100, 100, 50, 5, true);
            manager.setVoxelROI(100, 100, 50, 33, true); // 第二层

            const rois = manager.getVoxelROIs(100, 100, 50);
            expect(rois).toContain(1);
            expect(rois).toContain(5);
            expect(rois).toContain(33);
            expect(rois.length).toBe(3);
        });

        it('应该正确擦除体素 ROI', async () => {
            const { SparseROIManager } = await import('@/annotation/SparseROIManager');
            const manager = new SparseROIManager();
            manager.initialize(mockGl, [512, 512, 300], [1, 1, 2]);

            manager.setVoxelROI(100, 100, 50, 1, true);
            manager.setVoxelROI(100, 100, 50, 2, true);

            // 擦除 ROI 1
            manager.setVoxelROI(100, 100, 50, 1, false);

            const rois = manager.getVoxelROIs(100, 100, 50);
            expect(rois).not.toContain(1);
            expect(rois).toContain(2);
        });
    });

    describe('笔刷绘制', () => {
        it('paintSphere 应该绘制球形区域', async () => {
            const { SparseROIManager } = await import('@/annotation/SparseROIManager');
            const manager = new SparseROIManager();
            manager.initialize(mockGl, [512, 512, 300], [1, 1, 2]);

            const affectedVoxels = manager.paintSphere(100, 100, 50, 3, 1, false);

            // 半径 3 的球体应该包含多个体素
            expect(affectedVoxels.length).toBeGreaterThan(1);

            // 中心点应该被设置
            const centerRois = manager.getVoxelROIs(100, 100, 50);
            expect(centerRois).toContain(1);
        });

        it('paintSphere 擦除模式应该移除 ROI', async () => {
            const { SparseROIManager } = await import('@/annotation/SparseROIManager');
            const manager = new SparseROIManager();
            manager.initialize(mockGl, [512, 512, 300], [1, 1, 2]);

            // 先绘制
            manager.paintSphere(100, 100, 50, 5, 1, false);
            expect(manager.getVoxelROIs(100, 100, 50)).toContain(1);

            // 再擦除
            manager.paintSphere(100, 100, 50, 5, 1, true);
            expect(manager.getVoxelROIs(100, 100, 50)).not.toContain(1);
        });
    });

    describe('坐标转换', () => {
        it('ctToVirtual 应该正确转换坐标', async () => {
            const { SparseROIManager } = await import('@/annotation/SparseROIManager');
            const manager = new SparseROIManager();
            manager.initialize(mockGl, [512, 512, 300], [1, 1, 2]);

            const info = manager.getVirtualSpaceInfo();
            const [vx, vy, vz] = manager.ctToVirtual(0, 0, 0);

            expect(vx).toBe(info.ctOffset[0]);
            expect(vy).toBe(info.ctOffset[1]);
            expect(vz).toBe(info.ctOffset[2]);
        });

        it('virtualToCT 应该是 ctToVirtual 的逆操作', async () => {
            const { SparseROIManager } = await import('@/annotation/SparseROIManager');
            const manager = new SparseROIManager();
            manager.initialize(mockGl, [512, 512, 300], [1, 1, 2]);

            const ctCoord = [100, 200, 50] as const;
            const virtual = manager.ctToVirtual(ctCoord[0], ctCoord[1], ctCoord[2]);
            const backToCt = manager.virtualToCT(virtual[0], virtual[1], virtual[2]);

            expect(backToCt[0]).toBe(ctCoord[0]);
            expect(backToCt[1]).toBe(ctCoord[1]);
            expect(backToCt[2]).toBe(ctCoord[2]);
        });
    });

    describe('统计信息', () => {
        it('getStats 应该返回正确的块数量', async () => {
            const { SparseROIManager } = await import('@/annotation/SparseROIManager');
            const manager = new SparseROIManager();
            manager.initialize(mockGl, [512, 512, 300], [1, 1, 2]);

            // 初始状态无块
            expect(manager.getStats().blockCount).toBe(0);

            // 绘制后应该有块
            manager.setVoxelROI(100, 100, 50, 1, true);
            expect(manager.getStats().blockCount).toBe(1);
        });
    });

    describe('块压缩', () => {
        it('compactBlocks 应该移除空块', async () => {
            const { SparseROIManager } = await import('@/annotation/SparseROIManager');
            const manager = new SparseROIManager();
            manager.initialize(mockGl, [512, 512, 300], [1, 1, 2]);

            // 创建块
            manager.setVoxelROI(100, 100, 50, 1, true);
            expect(manager.getStats().blockCount).toBe(1);

            // 擦除使块变空
            manager.setVoxelROI(100, 100, 50, 1, false);

            // 压缩应该移除空块
            const removed = manager.compactBlocks();
            expect(removed).toBe(1);
            expect(manager.getStats().blockCount).toBe(0);
        });
    });
});
