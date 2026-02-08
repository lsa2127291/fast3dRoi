/**
 * ROICanvasOverlay 单元测试
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import type { ViewTransform } from '@/views/ROICanvasOverlay';

// Mock eventBus
vi.mock('@/core/EventBus', () => ({
    eventBus: {
        on: vi.fn(),
        off: vi.fn(),
        emit: vi.fn(),
    },
}));

// 由于 ROICanvasOverlay 依赖 DOM，我们需要创建 mock DOM 环境
describe('ROICanvasOverlay', () => {
    let container: HTMLElement;
    let originalCreateElement: typeof document.createElement;

    beforeEach(() => {
        // 保存原始的 createElement
        originalCreateElement = document.createElement.bind(document);

        // Mock createElement to provide a mock canvas with 2D context
        vi.spyOn(document, 'createElement').mockImplementation((tagName: string) => {
            const element = originalCreateElement(tagName);

            if (tagName.toLowerCase() === 'canvas') {
                // Mock canvas 2D context
                const mockContext = {
                    clearRect: vi.fn(),
                    createImageData: vi.fn(() => ({
                        data: new Uint8ClampedArray(512 * 512 * 4),
                        width: 512,
                        height: 512,
                    })),
                    putImageData: vi.fn(),
                    scale: vi.fn(),
                    getImageData: vi.fn(),
                    save: vi.fn(),
                    restore: vi.fn(),
                };

                vi.spyOn(element as HTMLCanvasElement, 'getContext').mockReturnValue(mockContext as any);
            }

            return element;
        });

        // 创建 mock 容器
        container = originalCreateElement('div');
        container.style.width = '512px';
        container.style.height = '512px';
        document.body.appendChild(container);

        // Mock getBoundingClientRect
        vi.spyOn(container, 'getBoundingClientRect').mockReturnValue({
            width: 512,
            height: 512,
            top: 0,
            left: 0,
            right: 512,
            bottom: 512,
            x: 0,
            y: 0,
            toJSON: () => ({}),
        });
    });

    afterEach(() => {
        if (document.body.contains(container)) {
            document.body.removeChild(container);
        }
        vi.restoreAllMocks();
    });

    describe('初始化', () => {
        it('应该创建 canvas 元素并添加到容器', async () => {
            const { ROICanvasOverlay } = await import('@/views/ROICanvasOverlay');
            const overlay = new ROICanvasOverlay(container, 'axial');

            const canvas = container.querySelector('.roi-canvas-overlay');
            expect(canvas).toBeTruthy();
            expect(canvas?.tagName.toLowerCase()).toBe('canvas');

            overlay.dispose();
        });

        it('应该正确设置视图类型', async () => {
            const { ROICanvasOverlay } = await import('@/views/ROICanvasOverlay');
            const overlay = new ROICanvasOverlay(container, 'sagittal');

            expect(overlay.getViewType()).toBe('sagittal');

            overlay.dispose();
        });
    });

    describe('坐标变换', () => {
        it('axial 视图: canvasToVoxel 应该正确映射坐标', async () => {
            const { ROICanvasOverlay } = await import('@/views/ROICanvasOverlay');
            const overlay = new ROICanvasOverlay(container, 'axial');

            const transform: ViewTransform = {
                viewportWidth: 512,
                viewportHeight: 512,
                dimensions: [512, 512, 300],
                spacing: [1, 1, 2],
                origin: [0, 0, 0],
                sliceIndex: 150,
                zoom: 1,
                pan: [0, 0],
            };

            overlay.setTransform(transform);

            // 中心点应该映射到体素中心
            const centerVoxel = overlay.canvasToVoxel(256, 256);
            expect(centerVoxel).toBeTruthy();
            expect(centerVoxel![2]).toBe(150); // Z 应该是切片索引

            overlay.dispose();
        });

        it('sagittal 视图: canvasToVoxel 应该正确映射坐标', async () => {
            const { ROICanvasOverlay } = await import('@/views/ROICanvasOverlay');
            const overlay = new ROICanvasOverlay(container, 'sagittal');

            const transform: ViewTransform = {
                viewportWidth: 512,
                viewportHeight: 512,
                dimensions: [512, 512, 300],
                spacing: [1, 1, 2],
                origin: [0, 0, 0],
                sliceIndex: 256,
                zoom: 1,
                pan: [0, 0],
            };

            overlay.setTransform(transform);

            const voxel = overlay.canvasToVoxel(256, 150);
            expect(voxel).toBeTruthy();
            expect(voxel![0]).toBe(256); // X 应该是切片索引

            overlay.dispose();
        });

        it('coronal 视图: canvasToVoxel 应该正确映射坐标', async () => {
            const { ROICanvasOverlay } = await import('@/views/ROICanvasOverlay');
            const overlay = new ROICanvasOverlay(container, 'coronal');

            const transform: ViewTransform = {
                viewportWidth: 512,
                viewportHeight: 512,
                dimensions: [512, 512, 300],
                spacing: [1, 1, 2],
                origin: [0, 0, 0],
                sliceIndex: 256,
                zoom: 1,
                pan: [0, 0],
            };

            overlay.setTransform(transform);

            const voxel = overlay.canvasToVoxel(256, 150);
            expect(voxel).toBeTruthy();
            expect(voxel![1]).toBe(256); // Y 应该是切片索引

            overlay.dispose();
        });
    });

    describe('ROI 配置', () => {
        it('应该正确设置和获取 ROI 配置', async () => {
            const { ROICanvasOverlay } = await import('@/views/ROICanvasOverlay');
            const overlay = new ROICanvasOverlay(container, 'axial');

            overlay.setROIConfig({
                roiId: 1,
                color: '#ff0000',
                opacity: 0.5,
                visible: true,
            });

            // 配置已设置，不会抛出错误
            expect(() => overlay.markDirty()).not.toThrow();

            overlay.dispose();
        });

        it('应该支持批量设置 ROI 配置', async () => {
            const { ROICanvasOverlay } = await import('@/views/ROICanvasOverlay');
            const overlay = new ROICanvasOverlay(container, 'axial');

            overlay.setROIConfigs([
                { roiId: 1, color: '#ff0000', opacity: 0.5, visible: true },
                { roiId: 2, color: '#00ff00', opacity: 0.5, visible: true },
                { roiId: 3, color: '#0000ff', opacity: 0.5, visible: false },
            ]);

            expect(() => overlay.markDirty()).not.toThrow();

            overlay.dispose();
        });
    });

    describe('资源管理', () => {
        it('dispose 应该移除 canvas 元素', async () => {
            const { ROICanvasOverlay } = await import('@/views/ROICanvasOverlay');
            const overlay = new ROICanvasOverlay(container, 'axial');

            expect(container.querySelector('.roi-canvas-overlay')).toBeTruthy();

            overlay.dispose();

            expect(container.querySelector('.roi-canvas-overlay')).toBeNull();
        });
    });
});
