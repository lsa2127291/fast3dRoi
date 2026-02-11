/**
 * 医疗图像可视化系统 - 主入口
 * Phase 2: 集成 VTK.js 渲染管线（ES Module 导入）
 */

import './style.css';

// VTK.js ES Module 导入 - 使用 All Profile 包含 ImageMapper 的 OpenGL 实现
import '@kitware/vtk.js/Rendering/Profiles/All';

import vtkRenderWindow from '@kitware/vtk.js/Rendering/Core/RenderWindow';
import vtkRenderer from '@kitware/vtk.js/Rendering/Core/Renderer';
import vtkRenderWindowInteractor from '@kitware/vtk.js/Rendering/Core/RenderWindowInteractor';
import vtkImageMapper from '@kitware/vtk.js/Rendering/Core/ImageMapper';
import vtkImageSlice from '@kitware/vtk.js/Rendering/Core/ImageSlice';
import vtkOpenGLRenderWindow from '@kitware/vtk.js/Rendering/OpenGL/RenderWindow';
import vtkInteractorStyleImage from '@kitware/vtk.js/Interaction/Style/InteractorStyleImage';
import vtkImageData from '@kitware/vtk.js/Common/DataModel/ImageData';
import vtkDataArray from '@kitware/vtk.js/Common/Core/DataArray';

// 从 vtkImageMapper 获取正确的 SlicingMode
import { SlicingMode } from '@kitware/vtk.js/Rendering/Core/ImageMapper/Constants';

// WebGPU 渲染系统
import { initWebGPU, WebGPUInitError } from './gpu/WebGPUContext';
import { WebGPURenderer } from './gpu/WebGPURenderer';
import {
    AnnotationPerformanceTracker,
    AnnotationInteractionController,
    createAnnotationRuntime,
} from './gpu/annotation';
import { resolveAnnotationInteractionTargets } from './gpu/annotation/resolveAnnotationInteractionTarget';
import type {
    AnnotationPerformanceSample,
    AnnotationRuntime,
    AnnotationStatus,
    ViewSyncEvent,
} from './gpu/annotation';
import { packVertexQ } from './gpu/data/VertexQ';
import type { VertexQEncoded } from './gpu/data/VertexQ';
import { QUANT_STEP_MM, WORKSPACE_SIZE_MM } from './gpu/constants';
import {
    computeCircularOverlayPixelRadii,
    projectOverlayCircle,
} from './gpu/annotation/SliceOverlayProjector';
import { SliceOverlayAccumulator } from './gpu/annotation/SliceOverlayAccumulator';
import { eventBus } from './core/EventBus';

// dcmjs 全局变量（通过 CDN 加载）
declare const dcmjs: {
    data: {
        DicomMessage: {
            readFile: (arrayBuffer: ArrayBuffer) => {
                dict: Record<string, { Value: unknown[] }>;
            };
        };
    };
};

type ViewType = 'axial' | 'sagittal' | 'coronal';

// ========== MPR 视图类 ==========
class VTKMPRView {
    private container: HTMLElement;
    private viewType: ViewType;
    private renderWindow: any = null;
    private renderer: any = null;
    private openGLRenderWindow: any = null;
    private interactor: any = null;
    private imageMapper: any = null;
    private imageSlice: any = null;
    private windowWidth = 400;
    private windowCenter = 40;
    private dimensions: number[] = [1, 1, 1];
    private imageSpacing: number[] = [1, 1, 1];
    private isMiddleButtonDown = false;
    private initialParallelScale = 1;
    private initialFocalPoint: [number, number, number] = [0, 0, 0];
    private overlayCanvas: HTMLCanvasElement | null = null;
    private overlayContext: CanvasRenderingContext2D | null = null;
    private overlayMaskCanvas: HTMLCanvasElement | null = null;
    private overlayMaskContext: CanvasRenderingContext2D | null = null;
    private overlayEdgeCanvas: HTMLCanvasElement | null = null;
    private overlayEdgeContext: CanvasRenderingContext2D | null = null;
    private readonly overlayAccumulator = new SliceOverlayAccumulator();

    constructor(container: HTMLElement, viewType: ViewType) {
        this.container = container;
        this.viewType = viewType;
    }

    initialize(): void {
        // 确保容器使用相对定位
        this.container.style.position = 'relative';

        // 创建渲染窗口
        this.renderWindow = vtkRenderWindow.newInstance();
        this.renderer = vtkRenderer.newInstance();
        this.renderWindow.addRenderer(this.renderer);

        // 创建 OpenGL 渲染窗口
        this.openGLRenderWindow = vtkOpenGLRenderWindow.newInstance();
        this.openGLRenderWindow.setContainer(this.container);
        this.renderWindow.addView(this.openGLRenderWindow);
        this.updateSize();

        // 创建交互器
        this.interactor = vtkRenderWindowInteractor.newInstance();
        this.interactor.setView(this.openGLRenderWindow);
        const style = vtkInteractorStyleImage.newInstance();
        this.interactor.setInteractorStyle(style);

        // 修改交互按键绑定 (通过覆盖实例方法实现)
        // 用户需求: 左键=Pan, 右键=W/L, 中键=Zoom
        // 注意: vtkInteractorStyleImage 默认: 左键=WL, 右键=Zoom, 中键=Pan

        try {
            // 尝试覆盖实例方法
            // 注意：某些 VTK.js 对象可能是冻结的，导致赋值失败

            // 1. 左键: Pan (原默认是 WL)
            (style as any).handleLeftButtonPress = (_callData: any) => {
                style.startPan();
            };
            (style as any).handleLeftButtonRelease = () => {
                style.endPan();
            };

            // 2. 右键: Window/Level (原默认是 Zoom)
            (style as any).handleRightButtonPress = (_callData: any) => {
                style.startWindowLevel();
            };
            (style as any).handleRightButtonRelease = () => {
                style.endWindowLevel();
            };

            // 3. 中键: Zoom (原默认是 Pan)
            (style as any).handleMiddleButtonPress = (_callData: any) => {
                style.startDolly();
            };
            (style as any).handleMiddleButtonRelease = () => {
                style.endDolly();
            };
        } catch (e) {
            console.warn('Failed to rebind keys on vtkInteractorStyleImage:', e);
            // 降级回默认行为，保证应用不崩
        }

        this.interactor.bindEvents(this.container);
        this.interactor.initialize();

        // 创建图像映射器和切片
        this.imageMapper = vtkImageMapper.newInstance();
        this.imageSlice = vtkImageSlice.newInstance();
        this.imageSlice.setMapper(this.imageMapper);

        // 设置切片模式 - 使用世界坐标系 X/Y/Z
        switch (this.viewType) {
            case 'axial':
                this.imageMapper.setSlicingMode(SlicingMode.Z);
                break;
            case 'sagittal':
                this.imageMapper.setSlicingMode(SlicingMode.X);
                break;
            case 'coronal':
                this.imageMapper.setSlicingMode(SlicingMode.Y);
                break;
        }

        // 设置属性
        const property = this.imageSlice.getProperty();
        property.setInterpolationTypeToLinear();

        // 添加到渲染器
        this.renderer.addActor(this.imageSlice);
        this.renderer.setBackground(0.1, 0.1, 0.12);

        // 设置相机
        this.setupCamera();
        this.ensureOverlayLayer();

        // 监听窗口大小变化
        new ResizeObserver(() => {
            this.updateSize();
            this.render();
        }).observe(this.container);

        // 跟踪中键状态（用于中键+滚轮=缩放）
        this.container.addEventListener('mousedown', (e) => {
            if (e.button === 1) this.isMiddleButtonDown = true;
        });
        window.addEventListener('mouseup', (e) => {
            if (e.button === 1) this.isMiddleButtonDown = false;
        });

        // 鼠标滚轮事件
        this.container.addEventListener('wheel', (e) => {
            e.preventDefault();

            // 中键按住 + 滚轮 = 缩放（平行投影用 parallelScale）
            if (this.isMiddleButtonDown) {
                const camera = this.renderer?.getActiveCamera();
                if (camera) {
                    const scale = camera.getParallelScale();
                    // deltaY > 0 = 滚轮下 = 缩小（scale 变大）
                    const factor = e.deltaY > 0 ? 1.1 : 0.9;
                    camera.setParallelScale(scale * factor);
                    this.renderer.resetCameraClippingRange();
                    this.render();
                    this.paintOverlay(); // 缩放后刷新 overlay
                }
                return;
            }

            // 普通滚轮 = 翻页
            if (!this.imageMapper) return;
            const delta = e.deltaY > 0 ? 1 : -1;
            const current = this.imageMapper.getSlice();
            const startedAt = performance.now();
            this.setSlice(current + delta, true);
            const endedAt = performance.now();
            eventBus.emit('perf:page-flip', {
                viewType: this.viewType,
                durationMs: endedAt - startedAt,
                sliceIndex: this.getSlice(),
            });
        });
    }

    getMaxSlice(): number {
        switch (this.viewType) {
            case 'axial': return this.dimensions[2] - 1;
            case 'sagittal': return this.dimensions[0] - 1;
            case 'coronal': return this.dimensions[1] - 1;
        }
    }

    private setupCamera(): void {
        if (!this.renderer) return;
        const camera = this.renderer.getActiveCamera();
        camera.setParallelProjection(true);

        switch (this.viewType) {
            case 'axial':
                camera.setViewUp(0, -1, 0);
                camera.setPosition(0, 0, -1);
                camera.setFocalPoint(0, 0, 0);
                break;
            case 'sagittal':
                camera.setViewUp(0, 0, 1);
                camera.setPosition(1, 0, 0);
                camera.setFocalPoint(0, 0, 0);
                break;
            case 'coronal':
                camera.setViewUp(0, 0, 1);
                camera.setPosition(0, -1, 0);
                camera.setFocalPoint(0, 0, 0);
                break;
        }
    }

    private updateSize(): void {
        if (!this.openGLRenderWindow) return;
        const { width, height } = this.container.getBoundingClientRect();
        this.openGLRenderWindow.setSize(Math.floor(width), Math.floor(height));
        this.resizeOverlayCanvas();
        this.paintOverlay();
    }

    private ensureOverlayLayer(): void {
        if (this.overlayCanvas) {
            return;
        }
        const canvas = document.createElement('canvas');
        canvas.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:3;';
        this.container.appendChild(canvas);
        this.overlayCanvas = canvas;
        this.overlayContext = canvas.getContext('2d');
        this.overlayMaskCanvas = document.createElement('canvas');
        this.overlayMaskContext = this.overlayMaskCanvas.getContext('2d');
        this.overlayEdgeCanvas = document.createElement('canvas');
        this.overlayEdgeContext = this.overlayEdgeCanvas.getContext('2d');
        this.resizeOverlayCanvas();
    }

    // offscreen canvas 额外 padding（CSS 像素），防止缩放后椭圆超出 canvas 被裁剪
    private static readonly OVERLAY_PAD = 300;

    private resizeOverlayCanvas(): void {
        if (!this.overlayCanvas || !this.overlayMaskCanvas || !this.overlayEdgeCanvas) return;
        const rect = this.container.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        const pixelWidth = Math.max(1, Math.floor(rect.width * dpr));
        const pixelHeight = Math.max(1, Math.floor(rect.height * dpr));
        const pad = VTKMPRView.OVERLAY_PAD;
        const padPx = Math.ceil(pad * dpr);
        const paddedW = pixelWidth + 2 * padPx;
        const paddedH = pixelHeight + 2 * padPx;

        // 可视 overlay canvas = viewport 大小
        if (this.overlayCanvas.width !== pixelWidth || this.overlayCanvas.height !== pixelHeight) {
            this.overlayCanvas.width = pixelWidth;
            this.overlayCanvas.height = pixelHeight;
            this.overlayCanvas.style.width = `${Math.floor(rect.width)}px`;
            this.overlayCanvas.style.height = `${Math.floor(rect.height)}px`;
        }
        // offscreen mask/edge canvas = viewport + 2*pad（每边各扩展 pad）
        if (this.overlayMaskCanvas.width !== paddedW || this.overlayMaskCanvas.height !== paddedH) {
            this.overlayMaskCanvas.width = paddedW;
            this.overlayMaskCanvas.height = paddedH;
        }
        if (this.overlayEdgeCanvas.width !== paddedW || this.overlayEdgeCanvas.height !== paddedH) {
            this.overlayEdgeCanvas.width = paddedW;
            this.overlayEdgeCanvas.height = paddedH;
        }

        if (this.overlayContext) {
            this.overlayContext.setTransform(dpr, 0, 0, dpr, 0, 0);
        }
        if (this.overlayMaskContext) {
            // 用 translate 把绘制原点偏移到 padding 区域内部，这样 CSS 坐标 (0,0) 对应 canvas 像素 (padPx, padPx)
            this.overlayMaskContext.setTransform(dpr, 0, 0, dpr, padPx, padPx);
        }
        if (this.overlayEdgeContext) {
            this.overlayEdgeContext.setTransform(dpr, 0, 0, dpr, 0, 0);
        }
    }

    private clearOverlayCanvas(): void {
        if (!this.overlayContext) return;
        const rect = this.container.getBoundingClientRect();
        this.overlayContext.clearRect(0, 0, rect.width, rect.height);
    }

    private paintOverlay(): void {
        this.clearOverlayCanvas();
        if (
            !this.overlayContext
            || !this.overlayMaskCanvas
            || !this.overlayMaskContext
            || !this.overlayEdgeCanvas
            || !this.overlayEdgeContext
        ) {
            return;
        }

        const rect = this.container.getBoundingClientRect();
        const ops = this.overlayAccumulator.getSliceOps(this.getSlice());
        if (ops.length === 0) return;

        const maskCtx = this.overlayMaskContext;
        const edgeCtx = this.overlayEdgeContext;
        const mainCtx = this.overlayContext;
        const pad = VTKMPRView.OVERLAY_PAD;

        // 清除 padded mask canvas
        maskCtx.save();
        maskCtx.setTransform(1, 0, 0, 1, 0, 0); // 临时重置变换来 clearRect 整个 canvas
        maskCtx.clearRect(0, 0, this.overlayMaskCanvas.width, this.overlayMaskCanvas.height);
        maskCtx.restore();
        maskCtx.globalCompositeOperation = 'source-over';

        // 计算缩放/平移补偿：让 overlay 跟随 VTK.js 相机变化
        const camera = this.renderer?.getActiveCamera();
        let zoomRatio = 1;
        let panOffsetX = 0;
        let panOffsetY = 0;
        if (camera && this.initialParallelScale > 0) {
            const currentScale = camera.getParallelScale();
            zoomRatio = this.initialParallelScale / currentScale;

            const fp = camera.getFocalPoint();
            const pxPerMM = Math.min(rect.width, rect.height) / (2 * this.initialParallelScale);
            switch (this.viewType) {
                case 'axial':
                    panOffsetX = -(fp[0] - this.initialFocalPoint[0]) * pxPerMM * zoomRatio;
                    panOffsetY = (fp[1] - this.initialFocalPoint[1]) * pxPerMM * zoomRatio;
                    break;
                case 'sagittal':
                    panOffsetX = -(fp[1] - this.initialFocalPoint[1]) * pxPerMM * zoomRatio;
                    panOffsetY = -(fp[2] - this.initialFocalPoint[2]) * pxPerMM * zoomRatio;
                    break;
                case 'coronal':
                    panOffsetX = -(fp[0] - this.initialFocalPoint[0]) * pxPerMM * zoomRatio;
                    panOffsetY = -(fp[2] - this.initialFocalPoint[2]) * pxPerMM * zoomRatio;
                    break;
            }
        }

        // 在 padded canvas 上绘制椭圆（坐标系已被 setTransform 偏移了 pad）
        for (const op of ops) {
            const projected = projectOverlayCircle({
                viewType: this.viewType,
                centerMM: op.centerMM,
                radiusMM: op.radiusMM,
                workspaceSizeMM: WORKSPACE_SIZE_MM,
            });
            const radii = computeCircularOverlayPixelRadii({
                radiusNorm: Math.max(projected.rx, projected.ry),
                viewportWidth: rect.width,
                viewportHeight: rect.height,
                minRadiusPx: 2,
            });

            const baseCx = projected.cx * rect.width;
            const baseCy = projected.cy * rect.height;
            const cx = (baseCx - rect.width / 2) * zoomRatio + rect.width / 2 + panOffsetX;
            const cy = (baseCy - rect.height / 2) * zoomRatio + rect.height / 2 + panOffsetY;
            const rx = radii.rxPx * zoomRatio;
            const ry = radii.ryPx * zoomRatio;

            maskCtx.beginPath();
            maskCtx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
            if (op.erase) {
                maskCtx.globalCompositeOperation = 'destination-out';
                maskCtx.fillStyle = 'rgba(0,0,0,1)';
            } else {
                maskCtx.globalCompositeOperation = 'source-over';
                maskCtx.fillStyle = 'rgba(255,255,255,1)';
            }
            maskCtx.fill();
        }
        maskCtx.globalCompositeOperation = 'source-over';

        // 读取完整 padded canvas 数据进行形态学处理
        const fullW = this.overlayMaskCanvas.width;
        const fullH = this.overlayMaskCanvas.height;
        const maskImage = maskCtx.getImageData(0, 0, fullW, fullH);
        this.binarizeMask(maskImage.data);
        this.closeMask(maskImage.data, maskImage.width, maskImage.height);
        maskCtx.putImageData(maskImage, 0, 0);

        const edgeImage = edgeCtx.createImageData(maskImage.width, maskImage.height);
        this.extractMaskEdges(maskImage.data, edgeImage.data, maskImage.width, maskImage.height);
        edgeCtx.putImageData(edgeImage, 0, 0);

        // 从 padded canvas 中提取 viewport 区域合成到可视 canvas
        const dpr = window.devicePixelRatio || 1;
        const padPx = Math.ceil(pad * dpr);
        const srcX = padPx;
        const srcY = padPx;
        const srcW = Math.max(1, Math.floor(rect.width * dpr));
        const srcH = Math.max(1, Math.floor(rect.height * dpr));

        // 填充区域
        mainCtx.save();
        mainCtx.drawImage(this.overlayMaskCanvas, srcX, srcY, srcW, srcH, 0, 0, rect.width, rect.height);
        mainCtx.globalCompositeOperation = 'source-in';
        mainCtx.fillStyle = 'rgba(0, 224, 255, 0.22)';
        mainCtx.fillRect(0, 0, rect.width, rect.height);
        mainCtx.restore();

        // 轮廓线
        mainCtx.save();
        mainCtx.drawImage(this.overlayEdgeCanvas, srcX, srcY, srcW, srcH, 0, 0, rect.width, rect.height);
        mainCtx.globalCompositeOperation = 'source-in';
        mainCtx.fillStyle = 'rgba(0, 224, 255, 0.96)';
        mainCtx.fillRect(0, 0, rect.width, rect.height);
        mainCtx.restore();
    }

    private binarizeMask(data: Uint8ClampedArray): void {
        for (let i = 0; i < data.length; i += 4) {
            const on = data[i + 3] >= 32;
            const v = on ? 255 : 0;
            data[i] = v;
            data[i + 1] = v;
            data[i + 2] = v;
            data[i + 3] = v;
        }
    }

    private closeMask(data: Uint8ClampedArray, width: number, height: number): void {
        const pixelCount = Math.max(1, width * height);
        const source = new Uint8Array(pixelCount);
        for (let i = 0, p = 0; p < pixelCount; p++, i += 4) {
            source[p] = data[i + 3] > 0 ? 1 : 0;
        }

        const dilated = new Uint8Array(pixelCount);
        const closed = new Uint8Array(pixelCount);
        this.dilateBinaryMask(source, dilated, width, height);
        this.erodeBinaryMask(dilated, closed, width, height);

        for (let i = 0, p = 0; p < pixelCount; p++, i += 4) {
            const v = closed[p] > 0 ? 255 : 0;
            data[i] = v;
            data[i + 1] = v;
            data[i + 2] = v;
            data[i + 3] = v;
        }
    }

    private dilateBinaryMask(src: Uint8Array, dst: Uint8Array, width: number, height: number): void {
        const isOn = (x: number, y: number): boolean => {
            if (x < 0 || y < 0 || x >= width || y >= height) {
                return false;
            }
            return src[y * width + x] > 0;
        };

        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                let on = false;
                for (let oy = -1; oy <= 1 && !on; oy++) {
                    for (let ox = -1; ox <= 1; ox++) {
                        if (isOn(x + ox, y + oy)) {
                            on = true;
                            break;
                        }
                    }
                }
                dst[y * width + x] = on ? 1 : 0;
            }
        }
    }

    private erodeBinaryMask(src: Uint8Array, dst: Uint8Array, width: number, height: number): void {
        const isOn = (x: number, y: number): boolean => {
            // 越界视为 on，避免闭运算在画布边界侵蚀掩膜
            if (x < 0 || y < 0 || x >= width || y >= height) {
                return true;
            }
            return src[y * width + x] > 0;
        };

        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                let on = true;
                for (let oy = -1; oy <= 1 && on; oy++) {
                    for (let ox = -1; ox <= 1; ox++) {
                        if (!isOn(x + ox, y + oy)) {
                            on = false;
                            break;
                        }
                    }
                }
                dst[y * width + x] = on ? 1 : 0;
            }
        }
    }

    private extractMaskEdges(
        mask: Uint8ClampedArray,
        out: Uint8ClampedArray,
        width: number,
        height: number
    ): void {
        const isOn = (x: number, y: number): boolean => {
            // 越界视为 on，避免在画布边界产生假轮廓
            if (x < 0 || y < 0 || x >= width || y >= height) return true;
            return mask[(y * width + x) * 4 + 3] > 0;
        };

        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                if (!isOn(x, y)) {
                    continue;
                }
                const edge =
                    !isOn(x - 1, y)
                    || !isOn(x + 1, y)
                    || !isOn(x, y - 1)
                    || !isOn(x, y + 1)
                    || !isOn(x - 1, y - 1)
                    || !isOn(x + 1, y - 1)
                    || !isOn(x - 1, y + 1)
                    || !isOn(x + 1, y + 1);
                if (!edge) {
                    continue;
                }
                const idx = (y * width + x) * 4;
                out[idx] = 255;
                out[idx + 1] = 255;
                out[idx + 2] = 255;
                out[idx + 3] = 255;
            }
        }
    }

    setImageData(imageData: any): void {
        this.imageMapper?.setInputData(imageData);
        this.dimensions = imageData.getDimensions();
        this.imageSpacing = imageData.getSpacing();
        this.updateWindowLevel();

        // 设置初始切片为中间层
        if (this.imageMapper) {
            const midSlice = Math.floor(this.getMaxSlice() / 2);
            this.imageMapper.setSlice(midSlice);
        }

        // 设置相机位置（基于数据边界）
        this.setupCameraForData(imageData);

        this.render();
        this.updateLabel();
        this.clearAnnotationOverlay();
    }

    private setupCameraForData(imageData: any): void {
        if (!this.renderer || !this.imageMapper) return;

        const camera = this.renderer.getActiveCamera();
        camera.setParallelProjection(true);

        // 获取数据中心点作为焦点
        const bounds = imageData.getBounds();
        const center = [
            (bounds[0] + bounds[1]) / 2,
            (bounds[2] + bounds[3]) / 2,
            (bounds[4] + bounds[5]) / 2,
        ];
        camera.setFocalPoint(...center);

        // 使用 mapper 的法向量来设置相机位置（官方示例方法）
        const normal = this.imageMapper.getSlicingModeNormal();
        const position = [...center];
        const distance = Math.max(
            bounds[1] - bounds[0],
            bounds[3] - bounds[2],
            bounds[5] - bounds[4]
        );
        position[0] += normal[0] * distance;
        position[1] += normal[1] * distance;
        position[2] += normal[2] * distance;
        camera.setPosition(...position);

        // 设置向上方向
        switch (this.imageMapper.getSlicingMode()) {
            case SlicingMode.X:
                camera.setViewUp([0, 0, 1]);
                break;
            case SlicingMode.Y:
                camera.setViewUp([0, 0, 1]);
                break;
            case SlicingMode.Z:
                camera.setViewUp([0, -1, 0]);
                break;
            default:
                camera.setViewUp([0, 1, 0]);
        }

        this.renderer.resetCamera();
        this.renderer.resetCameraClippingRange();

        // 记录初始缩放和焦点，用于 overlay 补偿
        this.initialParallelScale = camera.getParallelScale();
        const fp = camera.getFocalPoint();
        this.initialFocalPoint = [fp[0], fp[1], fp[2]];
    }

    setWindowLevel(ww: number, wc: number): void {
        this.windowWidth = ww;
        this.windowCenter = wc;
        this.updateWindowLevel();
        this.render();
    }

    setSlice(index: number, emitEvent = false): void {
        if (!this.imageMapper) return;

        const maxSlice = this.getMaxSlice();
        const newSlice = Math.max(0, Math.min(maxSlice, Math.floor(index)));
        this.imageMapper.setSlice(newSlice);
        this.render();
        this.updateLabel();
        this.paintOverlay();

        if (emitEvent) {
            eventBus.emit('slice:change', {
                viewType: this.viewType,
                sliceIndex: newSlice,
            });
        }
    }

    getSlice(): number {
        return this.imageMapper?.getSlice() ?? 0;
    }

    getSliceCount(): number {
        return this.getMaxSlice() + 1;
    }

    renderAnnotationOverlay(
        centerMM: [number, number, number],
        radiusMM: number,
        erase: boolean,
        sliceIndex = this.getSlice()
    ): void {
        this.ensureOverlayLayer();
        this.overlayAccumulator.append({
            sliceIndex,
            centerMM: [...centerMM] as [number, number, number],
            radiusMM,
            erase,
        });
        this.paintOverlay();
    }

    clearAnnotationOverlay(): void {
        this.overlayAccumulator.clear();
        this.clearOverlayCanvas();
    }

    private updateWindowLevel(): void {
        if (!this.imageSlice) return;
        const property = this.imageSlice.getProperty();
        property.setColorWindow(this.windowWidth);
        property.setColorLevel(this.windowCenter);
    }

    private updateLabel(): void {
        const label = this.container.querySelector('.view-label');
        if (label && this.imageMapper) {
            const names: Record<ViewType, string> = {
                axial: 'Axial (轴位)',
                sagittal: 'Sagittal (矢状位)',
                coronal: 'Coronal (冠状位)',
            };
            const slice = this.imageMapper.getSlice();
            const maxSlice = this.getMaxSlice();
            label.textContent = `${names[this.viewType]} [${slice + 1}/${maxSlice + 1}]`;
        }
    }

    render(): void {
        this.renderWindow?.render();
    }

    /** 获取当前视图的维度信息（供外部模块使用） */
    getDimensions(): number[] {
        return [...this.dimensions];
    }

    /** 获取当前视图的 spacing 信息（供外部模块使用） */
    getSpacing(): number[] {
        return [...this.imageSpacing];
    }
}

// ========== 测试数据生成（用于验证渲染管线） ==========
function createSimpleTestData(): any {
    // 使用与 DICOM 完全相同的尺寸: 512x512x143
    const dims = [512, 512, 143];
    // 测试关键点：使用非整数 spacing 验证是否会导致 WebGL 计算错误
    const spacing = [0.703125, 0.703125, 3];
    const totalVoxels = dims[0] * dims[1] * dims[2];

    // 创建渐变数据（方便验证渲染）
    const pixelData = new Float32Array(totalVoxels);
    for (let z = 0; z < dims[2]; z++) {
        for (let y = 0; y < dims[1]; y++) {
            for (let x = 0; x < dims[0]; x++) {
                const idx = x + y * dims[0] + z * dims[0] * dims[1];
                // 创建一个球形渐变
                const cx = dims[0] / 2, cy = dims[1] / 2, cz = dims[2] / 2;
                const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2 + (z - cz) ** 2);
                pixelData[idx] = Math.max(0, 255 - dist * 10);
            }
        }
    }

    const imageData = vtkImageData.newInstance();
    imageData.setDimensions(dims);
    imageData.setSpacing(spacing);
    imageData.setOrigin([0, 0, 0]);

    const scalars = vtkDataArray.newInstance({
        values: pixelData,
        numberOfComponents: 1,
    });
    imageData.getPointData().setScalars(scalars);

    console.log('Test data created:', {
        dims: imageData.getDimensions(),
        numScalars: imageData.getPointData().getScalars()?.getNumberOfValues(),
    });

    return { imageData, windowWidth: 255, windowCenter: 127 };
}

// ========== DICOM 加载器 ==========
interface DicomImage {
    pixelData: ArrayBuffer;
    rows: number;
    columns: number;
    sliceLocation: number;
    sliceThickness: number;
    pixelSpacing: [number, number];
    rescaleSlope: number;
    rescaleIntercept: number;
    windowCenter?: number;
    windowWidth?: number;
    bitsAllocated: number;
    pixelRepresentation: number;
}

async function parseDicomFile(arrayBuffer: ArrayBuffer): Promise<DicomImage> {
    const dicomData = dcmjs.data.DicomMessage.readFile(arrayBuffer);

    const getValue = (tag: string, defaultValue: unknown = null): unknown => {
        const entry = dicomData.dict[tag];
        return entry?.Value?.[0] ?? defaultValue;
    };

    const pixelDataTag = '7FE00010';
    const pixelDataEntry = dicomData.dict[pixelDataTag];
    const pixelData = pixelDataEntry?.Value?.[0] as ArrayBuffer;

    if (!pixelData) {
        throw new Error('DICOM 文件缺少像素数据');
    }

    const pixelSpacingRaw = getValue('00280030', [1, 1]) as number[];

    return {
        pixelData,
        rows: getValue('00280010', 512) as number,
        columns: getValue('00280011', 512) as number,
        sliceLocation: getValue('00201041', 0) as number,
        sliceThickness: getValue('00180050', 1) as number,
        pixelSpacing: [pixelSpacingRaw[0], pixelSpacingRaw[1]],
        rescaleSlope: getValue('00281053', 1) as number,
        rescaleIntercept: getValue('00281052', 0) as number,
        windowCenter: getValue('00281050') as number | undefined,
        windowWidth: getValue('00281051') as number | undefined,
        bitsAllocated: getValue('00280100', 16) as number,
        pixelRepresentation: getValue('00280103', 0) as number,
    };
}

async function loadDicomFromUrls(
    urls: string[],
    onProgress?: (loaded: number, total: number) => void
): Promise<{ imageData: any; windowWidth: number; windowCenter: number }> {
    const images: DicomImage[] = [];

    for (let i = 0; i < urls.length; i++) {
        onProgress?.(i, urls.length);
        const response = await fetch(urls[i]);
        const arrayBuffer = await response.arrayBuffer();
        const image = await parseDicomFile(arrayBuffer);
        images.push(image);
    }

    // 按切片位置排序
    images.sort((a, b) => a.sliceLocation - b.sliceLocation);

    const firstImage = images[0];

    // 计算切片间距
    const sliceSpacing = images.length > 1 ? Math.abs(images[1].sliceLocation - images[0].sliceLocation) : firstImage.sliceThickness;

    // 安全获取 pixelSpacing (处理 dcmjs 可能返回 undefined 的情况)
    let pixelSpacing = [1, 1];
    if (firstImage.pixelSpacing && firstImage.pixelSpacing.length >= 2) {
        pixelSpacing = [
            Number(firstImage.pixelSpacing[0]) || 1,
            Number(firstImage.pixelSpacing[1]) || 1
        ];
    } else {
        console.warn('DICOM: pixelSpacing missing, defaulting to [1, 1]');
    }

    const dimensions = [
        Number(firstImage.columns),
        Number(firstImage.rows),
        Number(images.length)
    ];
    const spacing = [
        pixelSpacing[0],
        pixelSpacing[1],
        Number(sliceSpacing) || 1
    ];

    console.log('DICOM Metadata:', { dimensions, spacing });

    // 合并像素数据 - 使用 Float32Array 以获得更好的 WebGL 兼容性
    const totalVoxels = dimensions[0] * dimensions[1] * dimensions[2];
    const pixelData = new Float32Array(totalVoxels);

    const sliceSize = dimensions[0] * dimensions[1];

    // Track min/max for range
    let minVal = Infinity;
    let maxVal = -Infinity;

    for (let z = 0; z < images.length; z++) {
        const img = images[z];
        const srcView = new Int16Array(img.pixelData);
        const slope = img.rescaleSlope;
        const intercept = img.rescaleIntercept;
        const offset = z * sliceSize;

        for (let i = 0; i < sliceSize; i++) {
            const val = srcView[i] * slope + intercept;
            pixelData[offset + i] = val;
            if (val < minVal) minVal = val;
            if (val > maxVal) maxVal = val;
        }
    }

    // 创建 VTK ImageData
    const imageData = vtkImageData.newInstance();
    imageData.setDimensions(dimensions);
    imageData.setSpacing(spacing);
    imageData.setOrigin([0, 0, 0]);

    const scalars = vtkDataArray.newInstance({
        values: pixelData,
        numberOfComponents: 1,
        dataType: 'Float32Array',
    });

    // 显式设置 Range
    scalars.setRange({ min: minVal, max: maxVal }, 0);
    imageData.getPointData().setScalars(scalars);

    console.log('VTK ImageData created:', {
        dims: imageData.getDimensions(),
        numScalars: imageData.getPointData().getScalars()?.getNumberOfValues(),
    });

    return {
        imageData,
        windowWidth: firstImage.windowWidth || 400,
        windowCenter: firstImage.windowCenter || 40,
    };
}

// ========== WebGPU 3D 视图 ==========

/** 生成测试立方体（VertexQ 编码） */
function createTestCube(): { vertices: VertexQEncoded[]; indices: number[] } {
    // 立方体尺寸 100mm，中心在原点
    const size = 100;
    const positions = [
        [-size, -size, -size], [size, -size, -size], [size, size, -size], [-size, size, -size], // 前面
        [-size, -size, size], [size, -size, size], [size, size, size], [-size, size, size],   // 后面
    ];

    // 量化编码（原点 0, 步长 0.1mm）
    const vertices: VertexQEncoded[] = positions.map(([x, y, z]) => {
        const qx = Math.round(x / QUANT_STEP_MM);
        const qy = Math.round(y / QUANT_STEP_MM);
        const qz = Math.round(z / QUANT_STEP_MM);
        return packVertexQ(qx, qy, qz, 0);
    });

    // 立方体索引（12 个三角形）
    const indices = [
        0, 1, 2, 0, 2, 3, // 前
        4, 6, 5, 4, 7, 6, // 后
        0, 3, 7, 0, 7, 4, // 左
        1, 5, 6, 1, 6, 2, // 右
        3, 2, 6, 3, 6, 7, // 上
        0, 4, 5, 0, 5, 1, // 下
    ];

    return { vertices, indices };
}

let webgpuRenderer: WebGPURenderer | null = null;
let annotationRuntime: AnnotationRuntime | null = null;
let annotationControllers: AnnotationInteractionController[] = [];
const annotationPerformanceTracker = new AnnotationPerformanceTracker({
    maxSamplesPerMetric: 240,
    timestampQueryEnabled: false,
});
let webgpuSessionId = 0;
let webgpuRecoveryInFlight = false;
let webgpuRecoveryQueued = false;

function updateHistoryControlsState(): void {
    const undoBtn = document.getElementById('annotation-undo') as HTMLButtonElement | null;
    const redoBtn = document.getElementById('annotation-redo') as HTMLButtonElement | null;
    if (!undoBtn && !redoBtn) {
        return;
    }

    const snapshot = annotationRuntime?.engine.getHistorySnapshot();
    const canUndo = (snapshot?.undoDepth ?? 0) > 0;
    const canRedo = (snapshot?.redoDepth ?? 0) > 0;
    if (undoBtn) {
        undoBtn.disabled = !canUndo;
    }
    if (redoBtn) {
        redoBtn.disabled = !canRedo;
    }
}

function updateHistoryStatus(): void {
    const statsInfo = document.getElementById('stats-info');
    if (!statsInfo) return;

    let line = document.getElementById('annotation-history-line');
    if (!line) {
        line = document.createElement('div');
        line.id = 'annotation-history-line';
        line.style.marginTop = '4px';
        line.style.color = 'var(--text-secondary)';
        statsInfo.appendChild(line);
    }

    const snapshot = annotationRuntime?.engine.getHistorySnapshot();
    if (!snapshot) {
        line.textContent = '历史: unavailable';
        return;
    }

    const keyframeText = snapshot.latestKeyframe
        ? ` | keyframe #${snapshot.latestKeyframe.index}`
        : '';
    line.textContent = `历史: undo ${snapshot.undoDepth} | redo ${snapshot.redoDepth}${keyframeText}`;
}

function updatePerformanceStatus(): void {
    const statsInfo = document.getElementById('stats-info');
    if (!statsInfo) return;

    let summaryLine = document.getElementById('annotation-performance-line');
    if (!summaryLine) {
        summaryLine = document.createElement('div');
        summaryLine.id = 'annotation-performance-line';
        summaryLine.style.marginTop = '4px';
        summaryLine.style.color = 'var(--text-secondary)';
        statsInfo.appendChild(summaryLine);
    }

    let timestampLine = document.getElementById('annotation-timestamp-line');
    if (!timestampLine) {
        timestampLine = document.createElement('div');
        timestampLine.id = 'annotation-timestamp-line';
        timestampLine.style.marginTop = '4px';
        timestampLine.style.color = 'var(--text-secondary)';
        statsInfo.appendChild(timestampLine);
    }

    const report = annotationPerformanceTracker.getReport();
    const preview = report.metrics['mousemove-preview'];
    const pageFlip = report.metrics['page-flip'];
    const sync = report.metrics['mouseup-sync'];
    const diag = report.diagnostics;

    const formatMetric = (
        label: string,
        p50: number | null,
        p95: number | null,
        p99: number | null,
        targetMs: number,
        withinTarget: boolean
    ): string => {
        if (p95 === null) {
            return `${label} --/--/-- | target ${targetMs}ms`;
        }
        const state = withinTarget ? 'OK' : 'SLOW';
        const p50Text = p50 === null ? '--' : p50.toFixed(1);
        const p99Text = p99 === null ? '--' : p99.toFixed(1);
        return `${label} ${p50Text}/${p95.toFixed(1)}/${p99Text}ms | target ${targetMs}ms ${state}`;
    };

    summaryLine.textContent =
        `P50/P95/P99: ${formatMetric('move', preview.p50, preview.p95, preview.p99, preview.targetMs, preview.withinTarget)} | `
        + `${formatMetric('flip', pageFlip.p50, pageFlip.p95, pageFlip.p99, pageFlip.targetMs, pageFlip.withinTarget)} | `
        + `${formatMetric('sync', sync.p50, sync.p95, sync.p99, sync.targetMs, sync.withinTarget)}`;

    timestampLine.textContent =
        `timestamp-query: ${report.timestampQueryEnabled ? 'ON' : 'OFF'}`
        + ` | overflow ${diag.overflowCount}`
        + ` | quantOverflow ${diag.quantOverflowCount}`
        + ` | deferred ${diag.deferredLines}`
        + ` | budgetHit ${diag.budgetHitCount}`
        + ` | batches ${diag.batchCount}`;
}

function recordPerformanceSample(sample: AnnotationPerformanceSample): void {
    annotationPerformanceTracker.record(sample);
    updatePerformanceStatus();
}

function updateAnnotationStatus(status: AnnotationStatus): void {
    const statsInfo = document.getElementById('stats-info');
    if (!statsInfo) return;

    let line = document.getElementById('annotation-status-line');
    if (!line) {
        line = document.createElement('div');
        line.id = 'annotation-status-line';
        line.style.marginTop = '8px';
        line.style.color = 'var(--accent)';
        statsInfo.appendChild(line);
    }

    line.textContent = `勾画状态: ${status.phase} | ROI ${status.roiId} | dirty ${status.pendingDirtyBricks}`;
    updateHistoryStatus();
    updateHistoryControlsState();
    updatePerformanceStatus();
}

function updateSliceSyncStatus(text: string): void {
    const statsInfo = document.getElementById('stats-info');
    if (!statsInfo) return;

    let line = document.getElementById('slice-sync-status-line');
    if (!line) {
        line = document.createElement('div');
        line.id = 'slice-sync-status-line';
        line.style.marginTop = '4px';
        line.style.color = 'var(--text-secondary)';
        statsInfo.appendChild(line);
    }
    line.textContent = text;
}

function emitViewSyncToEventBus(event: ViewSyncEvent): void {
    eventBus.emit('slice:sync', {
        roiId: event.roiId,
        budgetHit: event.budgetHit,
        totalLineCount: event.totalLineCount,
        totalDeferredLines: event.totalDeferredLines,
        overflow: event.overflow,
        quantOverflow: event.quantOverflow,
        centerMM: event.centerMM,
        brushRadiusMM: event.brushRadiusMM,
        erase: event.erase,
        targets: [
            {
                viewType: 'axial',
                sliceIndex: event.viewResults.axial.sliceIndex,
                lineCount: event.viewResults.axial.lineCount,
                deferredLines: event.viewResults.axial.deferredLines,
                overflow: event.viewResults.axial.overflow,
                quantOverflow: event.viewResults.axial.quantOverflow,
            },
            {
                viewType: 'sagittal',
                sliceIndex: event.viewResults.sagittal.sliceIndex,
                lineCount: event.viewResults.sagittal.lineCount,
                deferredLines: event.viewResults.sagittal.deferredLines,
                overflow: event.viewResults.sagittal.overflow,
                quantOverflow: event.viewResults.sagittal.quantOverflow,
            },
            {
                viewType: 'coronal',
                sliceIndex: event.viewResults.coronal.sliceIndex,
                lineCount: event.viewResults.coronal.lineCount,
                deferredLines: event.viewResults.coronal.deferredLines,
                overflow: event.viewResults.coronal.overflow,
                quantOverflow: event.viewResults.coronal.quantOverflow,
            },
        ],
    });
}

function syncAnnotationControlsToEngine(): void {
    if (!annotationRuntime) return;

    const roiSelect = document.getElementById('roi-select') as HTMLSelectElement | null;
    const brushSizeInput = document.getElementById('brush-size') as HTMLInputElement | null;
    const eraseModeInput = document.getElementById('erase-mode') as HTMLInputElement | null;

    if (roiSelect) {
        const roiId = parseInt(roiSelect.value, 10);
        if (!Number.isNaN(roiId)) {
            annotationRuntime.engine.setActiveROI(roiId);
        }
    }

    if (brushSizeInput) {
        const size = parseInt(brushSizeInput.value, 10);
        if (!Number.isNaN(size)) {
            annotationRuntime.engine.setBrushRadius(size);
        }
    }

    if (eraseModeInput) {
        annotationRuntime.engine.setEraseMode(eraseModeInput.checked);
    }
}

async function recoverWebGPUAfterDeviceLost(reason: string): Promise<void> {
    if (webgpuRecoveryInFlight) {
        webgpuRecoveryQueued = true;
        return;
    }
    webgpuRecoveryInFlight = true;
    updateSliceSyncStatus(`WebGPU 设备丢失，正在自动重建: ${reason}`);
    try {
        await initializeWebGPUView();
        updateSliceSyncStatus('WebGPU 自动重建完成');
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('[WebGPU] 自动重建失败:', error);
        updateSliceSyncStatus(`WebGPU 自动重建失败: ${message}`);
    } finally {
        webgpuRecoveryInFlight = false;
        if (webgpuRecoveryQueued) {
            webgpuRecoveryQueued = false;
            void recoverWebGPUAfterDeviceLost('queued');
        }
    }
}

/** 初始化 WebGPU 3D 视图 */
async function initializeWebGPUView(): Promise<void> {
    const container = document.getElementById('volume-view');
    if (!container) {
        console.warn('[WebGPU] #volume-view 容器未找到');
        return;
    }
    const sessionId = ++webgpuSessionId;

    try {
        // 初始化 WebGPU 上下文
        for (const controller of annotationControllers) {
            controller.detach();
        }
        annotationControllers = [];
        annotationRuntime?.destroy();
        annotationRuntime = null;
        annotationPerformanceTracker.reset();
        updateHistoryControlsState();
        updateHistoryStatus();
        updatePerformanceStatus();
        webgpuRenderer?.destroy();
        webgpuRenderer = null;

        const ctx = await initWebGPU({
            onDeviceLost: (info) => {
                if (sessionId !== webgpuSessionId) {
                    return;
                }
                const reason = `${info.reason}: ${info.message}`;
                void recoverWebGPUAfterDeviceLost(reason);
            },
        });
        annotationPerformanceTracker.setTimestampQueryEnabled(ctx.caps.timestamp);
        console.log('[WebGPU] 初始化成功');

        // 创建渲染器
        webgpuRenderer = new WebGPURenderer(ctx);
        await webgpuRenderer.initialize(container);

        // 上传测试立方体
        const { vertices, indices } = createTestCube();
        webgpuRenderer.uploadMesh(vertices, indices);

        // 启动渲染循环
        webgpuRenderer.startRenderLoop();

        annotationRuntime = createAnnotationRuntime(
            ctx,
            updateAnnotationStatus,
            emitViewSyncToEventBus,
            recordPerformanceSample
        );
        syncAnnotationControlsToEngine();
        syncEngineSliceBoundsFromViews();

        const interactionTargets = resolveAnnotationInteractionTargets(
            {
                axial: document.getElementById('axial-view'),
                sagittal: document.getElementById('sagittal-view'),
                coronal: document.getElementById('coronal-view'),
            },
            webgpuRenderer.getCanvasElement()
        );
        const controllerViewTypes: ViewType[] = ['axial', 'sagittal', 'coronal'];
        for (const viewType of controllerViewTypes) {
            const interactionTarget = interactionTargets[viewType];
            if (!interactionTarget) {
                continue;
            }
            const controller = new AnnotationInteractionController(interactionTarget, annotationRuntime.engine, {
                viewType,
                requireCtrlKey: false,
                triggerButton: 2,
            });
            controller.attach();
            annotationControllers.push(controller);
        }

        updateAnnotationStatus({
            phase: 'idle',
            roiId: annotationRuntime.engine.getActiveROI(),
            pendingDirtyBricks: 0,
            message: 'ready',
        });
        updateHistoryStatus();
        updateHistoryControlsState();
        updatePerformanceStatus();

        console.log('[WebGPU] 测试立方体已加载');
    } catch (err) {
        annotationPerformanceTracker.setTimestampQueryEnabled(false);
        if (err instanceof WebGPUInitError) {
            console.error('[WebGPU] 初始化失败:', err.message);
            // 在容器中显示友好错误提示
            container.innerHTML = `
                <div style="display: flex; align-items: center; justify-content: center; height: 100%; color: #ff6b6b; text-align: center; padding: 20px;">
                    <div>
                        <h3>WebGPU 不可用</h3>
                        <p>${err.message}</p>
                        <p style="font-size: 0.9em; margin-top: 10px;">请使用 Chrome 136+ 并确保 GPU 驱动已更新。</p>
                    </div>
                </div>
            `;
        } else {
            console.error('[WebGPU] 未知错误:', err);
        }
    }
}

// ========== 主应用 ==========
const views: Map<ViewType, VTKMPRView> = new Map();
let currentImageData: any = null;
let currentWindowWidth = 400;
let currentWindowCenter = 40;

function syncEngineSliceBoundsFromViews(): void {
    if (!annotationRuntime) return;

    const axial = views.get('axial')?.getSliceCount() ?? 1;
    const sagittal = views.get('sagittal')?.getSliceCount() ?? 1;
    const coronal = views.get('coronal')?.getSliceCount() ?? 1;
    annotationRuntime.engine.setSliceBounds({ axial, sagittal, coronal });
}

function setupEventBusIntegration(): void {
    eventBus.on('perf:page-flip', ({ viewType, durationMs, sliceIndex }) => {
        recordPerformanceSample({
            metric: 'page-flip',
            durationMs,
            timestamp: Date.now(),
            viewType,
        });
        updateSliceSyncStatus(`切片变化: ${viewType} -> ${sliceIndex + 1} | flip ${durationMs.toFixed(1)}ms`);
    });

    eventBus.on('slice:sync', (payload) => {
        for (const target of payload.targets) {
            const view = views.get(target.viewType);
            if (!view) continue;
            // 不改变视图切片，在各视图的当前切片上渲染 overlay
            view.renderAnnotationOverlay(payload.centerMM, payload.brushRadiusMM, payload.erase, view.getSlice());
        }

        annotationPerformanceTracker.recordDiagnostics({
            overflowCount: payload.overflow,
            quantOverflowCount: payload.quantOverflow,
            deferredLines: payload.totalDeferredLines,
            budgetHit: payload.budgetHit,
        });
        updatePerformanceStatus();

        const status = payload.budgetHit
            ? `切面同步: ROI ${payload.roiId} | lines ${payload.totalLineCount} | deferred ${payload.totalDeferredLines} (budget hit)`
            : `切面同步: ROI ${payload.roiId} | lines ${payload.totalLineCount} | deferred ${payload.totalDeferredLines}`;
        updateSliceSyncStatus(status);
    });

    eventBus.on('volume:loaded', ({ metadata }) => {
        updateSliceSyncStatus(`体数据已加载: ${metadata.dimensions.join('×')}`);
    });
}

async function initializeApp(): Promise<void> {
    console.log('Medical Imaging Viewer - Initializing VTK.js...');

    // 创建 MPR 视图
    const viewTypes: ViewType[] = ['axial', 'sagittal', 'coronal'];
    for (const viewType of viewTypes) {
        const container = document.getElementById(`${viewType}-view`);
        if (container) {
            const view = new VTKMPRView(container, viewType);
            view.initialize();
            views.set(viewType, view);
        }
    }

    // 设置窗宽窗位控件
    setupWindowLevelControls();

    // 绑定事件总线（里程碑 3：切面 + 同步）
    setupEventBusIntegration();

    // 设置 ROI 绘制控件（WebGPU 勾画系统待接入）
    setupROIControls();

    // 初始化 WebGPU 渲染器并绑定到 #volume-view
    await initializeWebGPUView();

    // 自动加载测试数据
    await loadTestDicomData();

    console.log('Medical Imaging Viewer - Ready');
}

function setupROIControls(): void {
    const roiSelect = document.getElementById('roi-select') as HTMLSelectElement;
    if (roiSelect) {
        roiSelect.addEventListener('change', () => {
            syncAnnotationControlsToEngine();
            const roiId = parseInt(roiSelect.value, 10);
            console.log(`[Annotation] ROI 切换为 ${roiId}`);
        });
    }

    const brushSizeInput = document.getElementById('brush-size') as HTMLInputElement;
    const brushSizeLabel = document.getElementById('brush-size-label');
    if (brushSizeInput && brushSizeLabel) {
        brushSizeInput.addEventListener('input', () => {
            const size = parseInt(brushSizeInput.value, 10);
            brushSizeLabel.textContent = String(size);
            syncAnnotationControlsToEngine();
            console.log(`[Annotation] 笔刷大小 ${size}`);
        });
    }

    const eraseModeInput = document.getElementById('erase-mode') as HTMLInputElement;
    if (eraseModeInput) {
        eraseModeInput.addEventListener('change', () => {
            syncAnnotationControlsToEngine();
            console.log(`[Annotation] 擦除模式 ${eraseModeInput.checked ? '开启' : '关闭'}`);
        });
    }

    const executeUndo = async (): Promise<void> => {
        if (!annotationRuntime) {
            return;
        }
        // 先清除所有视图的 overlay，避免 undo 后残留痕迹
        for (const view of views.values()) {
            view.clearAnnotationOverlay();
        }
        await annotationRuntime.engine.undoLast();
        updateHistoryStatus();
        updateHistoryControlsState();
    };

    const executeRedo = async (): Promise<void> => {
        if (!annotationRuntime) {
            return;
        }
        // 先清除所有视图的 overlay，避免 redo 后残留痕迹
        for (const view of views.values()) {
            view.clearAnnotationOverlay();
        }
        await annotationRuntime.engine.redoLast();
        updateHistoryStatus();
        updateHistoryControlsState();
    };

    const undoBtn = document.getElementById('annotation-undo') as HTMLButtonElement | null;
    if (undoBtn) {
        undoBtn.addEventListener('click', () => {
            void executeUndo();
        });
    }

    const redoBtn = document.getElementById('annotation-redo') as HTMLButtonElement | null;
    if (redoBtn) {
        redoBtn.addEventListener('click', () => {
            void executeRedo();
        });
    }

    window.addEventListener('keydown', (event) => {
        if (!(event.ctrlKey || event.metaKey)) {
            return;
        }
        const target = event.target as HTMLElement | null;
        if (
            target instanceof HTMLInputElement
            || target instanceof HTMLTextAreaElement
            || target instanceof HTMLSelectElement
        ) {
            return;
        }

        const key = event.key.toLowerCase();
        if (!event.shiftKey && key === 'z') {
            event.preventDefault();
            void executeUndo();
            return;
        }
        if (key === 'y' || (event.shiftKey && key === 'z')) {
            event.preventDefault();
            void executeRedo();
        }
    });

    updateHistoryControlsState();
}

async function loadTestDicomData(): Promise<void> {
    const loadingOverlay = document.getElementById('loading-overlay');
    const loadingProgress = document.getElementById('loading-progress');

    if (loadingOverlay) loadingOverlay.style.display = 'flex';

    try {
        // === 使用测试数据验证渲染管线 (暂时禁用 DICOM 加载) ===
        if (loadingProgress) loadingProgress.textContent = '创建测试数据...';

        // 先使用简单测试数据验证渲染
        const useTestData = false; // 设置为 false 来使用真实 DICOM 数据

        let result;
        if (useTestData) {
            result = createSimpleTestData();
            console.log('Using simple test data for verification');
        } else {
            // 生成 DICOM 文件 URL 列表
            const baseUrl = '/dcmtest/Anonymized0706/';
            const urls: string[] = [];
            for (let i = 1; i <= 143; i++) {
                urls.push(`${baseUrl}ct_${i}.dcm`);
            }

            if (loadingProgress) loadingProgress.textContent = `加载 DICOM 文件 (0/${urls.length})...`;

            result = await loadDicomFromUrls(urls, (loaded, total) => {
                if (loadingProgress) {
                    loadingProgress.textContent = `加载 DICOM 文件 (${loaded + 1}/${total})...`;
                }
            });
        }

        currentImageData = result.imageData;
        currentWindowWidth = result.windowWidth;
        currentWindowCenter = result.windowCenter;

        // 设置到所有视图
        for (const view of views.values()) {
            view.setImageData(currentImageData);
            view.setWindowLevel(currentWindowWidth, currentWindowCenter);
        }
        syncEngineSliceBoundsFromViews();

        // 更新窗宽窗位输入框
        const wwInput = document.getElementById('window-width') as HTMLInputElement;
        const wcInput = document.getElementById('window-center') as HTMLInputElement;
        if (wwInput) wwInput.value = String(currentWindowWidth);
        if (wcInput) wcInput.value = String(currentWindowCenter);

        // 更新信息
        const dims = currentImageData.getDimensions();
        const spacing = currentImageData.getSpacing?.() ?? [1, 1, 1];
        const origin = currentImageData.getOrigin?.() ?? [0, 0, 0];
        eventBus.emit('volume:loaded', {
            metadata: {
                dimensions: [dims[0], dims[1], dims[2]],
                spacing: [spacing[0], spacing[1], spacing[2]],
                origin: [origin[0], origin[1], origin[2]],
                direction: new Float64Array([
                    1, 0, 0,
                    0, 1, 0,
                    0, 0, 1,
                ]),
                dataType: 'float32',
                windowWidth: currentWindowWidth,
                windowCenter: currentWindowCenter,
            },
        });

        const statsInfo = document.getElementById('stats-info');
        if (statsInfo) {
            statsInfo.innerHTML = `
                <div>尺寸: ${dims[0]} × ${dims[1]} × ${dims[2]}</div>
                <div>类型: ${useTestData ? '测试数据' : 'CT DICOM'}</div>
                <div>来源: ${useTestData ? '程序生成' : 'dcmtest/Anonymized0706'}</div>
                <div style="color: var(--accent);">WebGPU 里程碑4: 撤销/性能验证链路已接入</div>
            `;
        }

        if (annotationRuntime) {
            updateAnnotationStatus({
                phase: 'idle',
                roiId: annotationRuntime.engine.getActiveROI(),
                pendingDirtyBricks: 0,
                message: 'ready',
            });
        }
        updateSliceSyncStatus('切面同步: waiting');
        updateHistoryStatus();
        updateHistoryControlsState();
        updatePerformanceStatus();

        console.log('Test data loaded successfully');
    } catch (error) {
        console.error('Failed to load data:', error);
        if (loadingProgress) {
            loadingProgress.textContent = `加载失败: ${error}`;
        }
    } finally {
        if (loadingOverlay) loadingOverlay.style.display = 'none';
    }
}

function setupWindowLevelControls(): void {
    const applyBtn = document.getElementById('apply-window');
    if (applyBtn) {
        applyBtn.addEventListener('click', () => {
            const wwInput = document.getElementById('window-width') as HTMLInputElement;
            const wcInput = document.getElementById('window-center') as HTMLInputElement;
            const ww = parseInt(wwInput?.value || '400');
            const wc = parseInt(wcInput?.value || '40');

            currentWindowWidth = ww;
            currentWindowCenter = wc;

            for (const view of views.values()) {
                view.setWindowLevel(ww, wc);
            }
            eventBus.emit('window:change', { windowWidth: ww, windowCenter: wc });
        });
    }

    // 预设窗宽窗位
    const presets = [
        { name: '肺窗', ww: 1500, wc: -600 },
        { name: '骨窗', ww: 2000, wc: 400 },
        { name: '软组织', ww: 400, wc: 40 },
    ];

    const presetContainer = document.createElement('div');
    presetContainer.style.cssText = 'display: flex; gap: 4px; margin-top: 8px; flex-wrap: wrap;';

    for (const preset of presets) {
        const btn = document.createElement('button');
        btn.textContent = preset.name;
        btn.className = 'btn btn-secondary';
        btn.style.cssText = 'padding: 4px 8px; font-size: 0.75rem;';
        btn.addEventListener('click', () => {
            const wwInput = document.getElementById('window-width') as HTMLInputElement;
            const wcInput = document.getElementById('window-center') as HTMLInputElement;
            if (wwInput) wwInput.value = String(preset.ww);
            if (wcInput) wcInput.value = String(preset.wc);

            currentWindowWidth = preset.ww;
            currentWindowCenter = preset.wc;

            for (const view of views.values()) {
                view.setWindowLevel(preset.ww, preset.wc);
            }
            eventBus.emit('window:change', { windowWidth: preset.ww, windowCenter: preset.wc });
        });
        presetContainer.appendChild(btn);
    }

    const windowPanel = document.querySelector('.panel');
    windowPanel?.appendChild(presetContainer);
}

// 启动
document.addEventListener('DOMContentLoaded', initializeApp);

