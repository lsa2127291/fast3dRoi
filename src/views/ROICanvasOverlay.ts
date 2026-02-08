/**
 * ROI Canvas Overlay
 * 独立的 Canvas 层，用于渲染 ROI 叠加层
 * 与 VTK.js 渲染的医疗图像分离，实现高性能 ROI 绘制
 */

import type { ViewType, Vec3 } from '@/core/types';
import { eventBus } from '@/core/EventBus';
import { roiManager } from '@/annotation/SparseROIManager';
import { extractContour } from '@/annotation/ContourExtractor';

/**
 * 坐标变换信息
 */
export interface ViewTransform {
    // 视口尺寸
    viewportWidth: number;
    viewportHeight: number;

    // 体数据元信息
    dimensions: [number, number, number];
    spacing: [number, number, number];
    origin: [number, number, number];

    // 当前切片索引
    sliceIndex: number;

    // 相机参数
    zoom: number;
    pan: [number, number];
}

/**
 * ROI 渲染配置
 */
export interface ROIRenderConfig {
    roiId: number;
    color: string;
    opacity: number;
    visible: boolean;
}

/**
 * ROI Canvas Overlay
 * 负责在独立的 Canvas 上渲染 ROI 数据
 */
export class ROICanvasOverlay {
    private canvas: HTMLCanvasElement;
    private ctx: CanvasRenderingContext2D;
    private viewType: ViewType;
    private transform: ViewTransform | null = null;

    // ROI 数据访问函数（由外部注入）
    private roiDataProvider: ((x: number, y: number, z: number) => number[]) | null = null;

    // ROI 配置
    private roiConfigs: Map<number, ROIRenderConfig> = new Map();

    // 脏标记
    private isDirty = true;

    constructor(container: HTMLElement, viewType: ViewType) {
        this.viewType = viewType;

        // 创建 Canvas 元素
        this.canvas = document.createElement('canvas');
        this.canvas.className = 'roi-canvas-overlay';
        this.canvas.style.cssText = `
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            pointer-events: none;
            z-index: 10;
        `;

        container.appendChild(this.canvas);

        const ctx = this.canvas.getContext('2d', { alpha: true });
        if (!ctx) {
            throw new Error('Failed to get 2D context');
        }
        this.ctx = ctx;

        // 初始化尺寸
        this.updateSize();

        // 监听事件
        window.addEventListener('resize', this.handleResize);
        eventBus.on('slice:change', this.handleSliceChange);
        eventBus.on('roi:update', this.handleROIUpdate);
    }

    /**
     * 设置 ROI 数据提供者
     */
    setROIDataProvider(provider: (x: number, y: number, z: number) => number[]): void {
        this.roiDataProvider = provider;
        this.markDirty();
    }

    /**
     * 设置坐标变换信息
     */
    setTransform(transform: ViewTransform): void {
        this.transform = transform;
        this.markDirty();
    }

    /**
     * 设置 ROI 配置
     */
    setROIConfig(config: ROIRenderConfig): void {
        this.roiConfigs.set(config.roiId, config);
        this.markDirty();
    }

    /**
     * 批量设置 ROI 配置
     */
    setROIConfigs(configs: ROIRenderConfig[]): void {
        for (const config of configs) {
            this.roiConfigs.set(config.roiId, config);
        }
        this.markDirty();
    }

    /**
     * 标记需要重绘
     */
    markDirty(): void {
        this.isDirty = true;
        requestAnimationFrame(() => this.render());
    }

    /**
     * 渲染 ROI 叠加层（轮廓线模式）
     */
    render(): void {
        if (!this.isDirty || !this.transform || !this.roiDataProvider) {
            return;
        }

        this.isDirty = false;

        const { dimensions, sliceIndex } = this.transform;

        // 清空画布
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

        // 获取切片尺寸
        const [sliceWidth, sliceHeight] = this.getSliceDimensions();
        if (sliceWidth <= 0 || sliceHeight <= 0) return;

        // 获取当前切片所有 ROI 的 mask
        // volume3d 视图不渲染 2D 轮廓
        if (this.viewType === 'volume3d') return;

        const masks = roiManager.getSliceMasks(
            sliceIndex,
            this.viewType as 'axial' | 'sagittal' | 'coronal',
            sliceWidth,
            sliceHeight
        );

        // 计算缩放因子
        const scaleX = this.canvas.width / sliceWidth;
        const scaleY = this.canvas.height / sliceHeight;

        // 设置线条样式
        this.ctx.lineWidth = 2;
        this.ctx.lineCap = 'round';
        this.ctx.lineJoin = 'round';

        // 遍历每个 ROI 绘制轮廓
        for (const [roiId, mask] of masks) {
            const config = this.roiConfigs.get(roiId);
            if (!config || !config.visible) continue;

            // 提取轮廓
            const contour = extractContour(mask, sliceWidth, sliceHeight, roiId);

            if (contour.paths.length === 0) continue;

            // 设置颜色
            this.ctx.strokeStyle = config.color;

            // 绘制每条路径
            for (const path of contour.paths) {
                if (path.length < 2) continue;

                this.ctx.beginPath();

                // 转换并绘制第一个点
                const startX = path[0].x * scaleX;
                const startY = (sliceHeight - path[0].y) * scaleY; // Y 轴翻转
                this.ctx.moveTo(startX, startY);

                // 绘制后续点
                for (let i = 1; i < path.length; i++) {
                    const x = path[i].x * scaleX;
                    const y = (sliceHeight - path[i].y) * scaleY;
                    this.ctx.lineTo(x, y);
                }

                // 闭合路径
                this.ctx.closePath();
                this.ctx.stroke();
            }
        }
    }

    /**
     * 获取当前视图的切片尺寸
     */
    private getSliceDimensions(): [number, number] {
        if (!this.transform) return [1, 1];

        const dims = this.transform.dimensions;
        switch (this.viewType) {
            case 'axial':
                return [dims[0], dims[1]];
            case 'sagittal':
                return [dims[1], dims[2]];
            case 'coronal':
                return [dims[0], dims[2]];
            default:
                return [dims[0], dims[1]];
        }
    }

    /**
     * Canvas 坐标转体素坐标
     */
    canvasToVoxel(canvasX: number, canvasY: number): Vec3 | null {
        if (!this.transform) return null;

        const { sliceIndex, zoom, pan } = this.transform;
        const [dimX, dimY] = this.getSliceDimensions();

        // 反向变换：Canvas -> 归一化 -> 体素
        const normalizedX = ((canvasX / this.canvas.width) - 0.5) / zoom + 0.5 - pan[0] / dimX;
        const normalizedY = ((canvasY / this.canvas.height) - 0.5) / zoom + 0.5 - pan[1] / dimY;

        const voxelX = Math.floor(normalizedX * dimX);
        const voxelY = Math.floor(normalizedY * dimY);

        switch (this.viewType) {
            case 'axial':
                return [voxelX, voxelY, sliceIndex];
            case 'sagittal':
                return [sliceIndex, voxelX, voxelY];
            case 'coronal':
                return [voxelX, sliceIndex, voxelY];
            default:
                return null;
        }
    }

    /**
     * 体素坐标转 Canvas 坐标
     */
    voxelToCanvas(vx: number, vy: number, vz: number): [number, number] | null {
        if (!this.transform) return null;

        const { sliceIndex, zoom, pan } = this.transform;
        const [dimX, dimY] = this.getSliceDimensions();

        let sliceCoordX: number, sliceCoordY: number;

        switch (this.viewType) {
            case 'axial':
                if (vz !== sliceIndex) return null;
                sliceCoordX = vx;
                sliceCoordY = vy;
                break;
            case 'sagittal':
                if (vx !== sliceIndex) return null;
                sliceCoordX = vy;
                sliceCoordY = vz;
                break;
            case 'coronal':
                if (vy !== sliceIndex) return null;
                sliceCoordX = vx;
                sliceCoordY = vz;
                break;
            default:
                return null;
        }

        // 归一化 -> 变换 -> Canvas
        const normalizedX = sliceCoordX / dimX;
        const normalizedY = sliceCoordY / dimY;

        const canvasX = ((normalizedX - 0.5 + pan[0] / dimX) * zoom + 0.5) * this.canvas.width;
        const canvasY = ((normalizedY - 0.5 + pan[1] / dimY) * zoom + 0.5) * this.canvas.height;

        return [canvasX, canvasY];
    }

    /**
     * 混合多个 ROI 的颜色
     */
    private blendROIColors(roiIds: number[]): { r: number; g: number; b: number; a: number } | null {
        let totalR = 0, totalG = 0, totalB = 0, totalA = 0;
        let count = 0;

        for (const roiId of roiIds) {
            const config = this.roiConfigs.get(roiId);
            if (!config || !config.visible) continue;

            const color = this.parseColor(config.color);
            if (!color) continue;

            const alpha = config.opacity * 255;
            totalR += color.r * alpha;
            totalG += color.g * alpha;
            totalB += color.b * alpha;
            totalA += alpha;
            count++;
        }

        if (count === 0 || totalA === 0) return null;

        return {
            r: Math.round(totalR / totalA),
            g: Math.round(totalG / totalA),
            b: Math.round(totalB / totalA),
            a: Math.min(255, Math.round(totalA / count)),
        };
    }

    /**
     * 解析颜色字符串
     */
    private parseColor(colorStr: string): { r: number; g: number; b: number } | null {
        // 支持 #RRGGBB 格式
        const hexMatch = colorStr.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
        if (hexMatch) {
            return {
                r: parseInt(hexMatch[1], 16),
                g: parseInt(hexMatch[2], 16),
                b: parseInt(hexMatch[3], 16),
            };
        }

        // 支持 rgb(r, g, b) 格式
        const rgbMatch = colorStr.match(/^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/);
        if (rgbMatch) {
            return {
                r: parseInt(rgbMatch[1], 10),
                g: parseInt(rgbMatch[2], 10),
                b: parseInt(rgbMatch[3], 10),
            };
        }

        return null;
    }

    /**
     * 更新 Canvas 尺寸
     */
    private updateSize(): void {
        const rect = this.canvas.parentElement?.getBoundingClientRect();
        if (rect) {
            // 使用设备像素比确保清晰度
            const dpr = window.devicePixelRatio || 1;
            this.canvas.width = rect.width * dpr;
            this.canvas.height = rect.height * dpr;
            this.ctx.scale(dpr, dpr);
        }
        this.markDirty();
    }

    /**
     * 处理窗口大小变化
     */
    private handleResize = (): void => {
        this.updateSize();
    };

    /**
     * 处理切片变化
     */
    private handleSliceChange = (data: { viewType: ViewType; sliceIndex: number }): void => {
        if (data.viewType === this.viewType && this.transform) {
            this.transform.sliceIndex = data.sliceIndex;
            this.markDirty();
        }
    };

    /**
     * 处理 ROI 更新
     */
    private handleROIUpdate = (): void => {
        this.markDirty();
    };

    /**
     * 获取 Canvas 元素
     */
    getCanvas(): HTMLCanvasElement {
        return this.canvas;
    }

    /**
     * 获取视图类型
     */
    getViewType(): ViewType {
        return this.viewType;
    }

    /**
     * 销毁
     */
    dispose(): void {
        window.removeEventListener('resize', this.handleResize);
        eventBus.off('slice:change', this.handleSliceChange);
        eventBus.off('roi:update', this.handleROIUpdate);
        this.canvas.remove();
    }
}
