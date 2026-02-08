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

// ROI 系统导入
import { roiManager } from './annotation/SparseROIManager';
import { brushTool } from './annotation/BrushTool';
import { eventBus } from './core/EventBus';
import { extractContour } from './annotation/ContourExtractor';
import type { Vec3 } from './core/types';

// 3D 渲染系统导入
import { VolumeView3D } from './views/VolumeView3D';
import { meshGenerator } from './mesh/MarchingCubesMeshGenerator';

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

// 从 vtkImageMapper 获取正确的 SlicingMode
import { SlicingMode } from '@kitware/vtk.js/Rendering/Core/ImageMapper/Constants';

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

    // ROI 叠加层
    private roiCanvas: HTMLCanvasElement | null = null;
    private roiCtx: CanvasRenderingContext2D | null = null;
    private isDrawing = false;

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
            (style as any).handleLeftButtonPress = (callData: any) => {
                style.startPan();
            };
            (style as any).handleLeftButtonRelease = () => {
                style.endPan();
            };

            // 2. 右键: Window/Level (原默认是 Zoom)
            (style as any).handleRightButtonPress = (callData: any) => {
                style.startWindowLevel();
            };
            (style as any).handleRightButtonRelease = () => {
                style.endWindowLevel();
            };

            // 3. 中键: Zoom (原默认是 Pan)
            (style as any).handleMiddleButtonPress = (callData: any) => {
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

        // 创建 ROI 叠加层 Canvas
        this.createROICanvasOverlay();

        // 监听窗口大小变化
        new ResizeObserver(() => {
            this.updateSize();
            this.updateROICanvasSize();
            this.render();
        }).observe(this.container);

        // 鼠标滚轮事件
        this.container.addEventListener('wheel', (e) => {
            e.preventDefault();
            if (!this.imageMapper) return;
            const delta = e.deltaY > 0 ? 1 : -1;
            const current = this.imageMapper.getSlice();
            const maxSlice = this.getMaxSlice();
            const newSlice = Math.max(0, Math.min(maxSlice, current + delta));
            this.imageMapper.setSlice(newSlice);
            this.render();
            this.updateLabel();
            this.renderROIOverlay(); // 重新渲染 ROI
        });

        // ROI 绘制事件 (Ctrl + 左键)
        this.setupDrawingEvents();
    }

    private createROICanvasOverlay(): void {
        this.roiCanvas = document.createElement('canvas');
        this.roiCanvas.className = 'roi-overlay';
        this.roiCanvas.style.cssText = `
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            pointer-events: none;
            z-index: 5;
        `;
        this.container.appendChild(this.roiCanvas);
        this.roiCtx = this.roiCanvas.getContext('2d', { alpha: true });
        this.updateROICanvasSize();
    }

    private updateROICanvasSize(): void {
        if (!this.roiCanvas) return;
        const { width, height } = this.container.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        this.roiCanvas.width = width * dpr;
        this.roiCanvas.height = height * dpr;
        this.roiCtx?.scale(dpr, dpr);
    }

    private setupDrawingEvents(): void {
        // 使用 capture 阶段拦截事件，在 VTK 交互器之前处理
        this.container.addEventListener('mousedown', (e) => {
            // 当 Ctrl 按下时，阻止所有鼠标按键触发 VTK 交互（包括旋转）
            if (e.ctrlKey) {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();

                // 禁用 VTK 交互器
                if (this.interactor) {
                    this.interactor.disable();
                }

                // 只有左键才开始绘制
                if (e.button === 0) {
                    this.startDrawing(e);
                }
            }
        }, { capture: true });

        this.container.addEventListener('mousemove', (e) => {
            if (this.isDrawing) {
                e.preventDefault();
                e.stopPropagation();
                this.continueDrawing(e);
            }
        }, { capture: true });

        this.container.addEventListener('mouseup', () => {
            if (this.isDrawing) {
                this.stopDrawing();
            }
        }, { capture: true });

        this.container.addEventListener('mouseleave', () => {
            if (this.isDrawing) {
                this.stopDrawing();
            }
        });
    }

    private startDrawing(e: MouseEvent): void {
        this.isDrawing = true;
        brushTool.beginStroke();
        this.paintAtPosition(e);
    }

    private continueDrawing(e: MouseEvent): void {
        this.paintAtPosition(e);
    }

    private stopDrawing(): void {
        this.isDrawing = false;
        brushTool.endStroke();
        eventBus.emit('roi:update', {});

        // 重新启用 VTK 交互器前，先清除任何未完成的交互状态
        if (this.interactor) {
            const style = this.interactor.getInteractorStyle();
            if (style) {
                // 结束所有可能正在进行的交互状态
                try {
                    (style as any).endPan?.();
                    (style as any).endRotate?.();
                    (style as any).endDolly?.();
                    (style as any).endSpin?.();
                    (style as any).endWindowLevel?.();
                } catch (e) {
                    // 忽略错误
                }
            }
            this.interactor.enable();
        }
    }

    private paintAtPosition(e: MouseEvent): void {
        const rect = this.container.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        // 转换为体素坐标
        const voxelCoord = this.screenToVoxel(x, y, rect.width, rect.height);
        if (!voxelCoord) return;

        const [screenVoxelX, screenVoxelY] = voxelCoord;
        const sliceIndex = this.imageMapper?.getSlice() || 0;

        // 根据视图类型构建 3D 坐标
        let worldCoord: Vec3;
        switch (this.viewType) {
            case 'axial':
                worldCoord = [screenVoxelX, screenVoxelY, sliceIndex];
                break;
            case 'sagittal':
                worldCoord = [sliceIndex, screenVoxelX, screenVoxelY];
                break;
            case 'coronal':
                worldCoord = [screenVoxelX, sliceIndex, screenVoxelY];
                break;
            default:
                return;
        }

        // 转换到虚拟空间并绘制实心圆（连续笔刷）
        const [wx, wy, wz] = roiManager.ctToVirtual(worldCoord[0], worldCoord[1], worldCoord[2]);
        const config = brushTool.getConfig();

        // 根据视图类型使用正确的平面和坐标
        // paintCircle(center1, center2, fixedAxisValue, radius, roiId, erase, plane)
        switch (this.viewType) {
            case 'axial':
                // Axial: XY 平面，Z 固定
                roiManager.paintCircle(
                    Math.round(wx), Math.round(wy), Math.round(wz),
                    config.radius, config.roiId, config.eraseMode, 'xy'
                );
                break;
            case 'sagittal':
                // Sagittal: YZ 平面，X 固定
                roiManager.paintCircle(
                    Math.round(wy), Math.round(wz), Math.round(wx),
                    config.radius, config.roiId, config.eraseMode, 'yz'
                );
                break;
            case 'coronal':
                // Coronal: XZ 平面，Y 固定
                roiManager.paintCircle(
                    Math.round(wx), Math.round(wz), Math.round(wy),
                    config.radius, config.roiId, config.eraseMode, 'xz'
                );
                break;
        }

        // 实时渲染 ROI
        this.renderROIOverlay();
    }

    private screenToVoxel(screenX: number, screenY: number, viewWidth: number, viewHeight: number): [number, number] | null {
        // 归一化到 [0, 1]
        const normalizedX = screenX / viewWidth;
        const normalizedY = screenY / viewHeight;

        // 获取当前视图对应的尺寸
        let dimX: number, dimY: number;
        switch (this.viewType) {
            case 'axial':
                dimX = this.dimensions[0];
                dimY = this.dimensions[1];
                break;
            case 'sagittal':
                dimX = this.dimensions[1];
                dimY = this.dimensions[2];
                break;
            case 'coronal':
                dimX = this.dimensions[0];
                dimY = this.dimensions[2];
                break;
            default:
                return null;
        }

        // 映射到体素坐标
        const voxelX = Math.floor(normalizedX * dimX);
        const voxelY = Math.floor(normalizedY * dimY);

        return [voxelX, voxelY];
    }

    renderROIOverlay(): void {
        if (!this.roiCtx || !this.roiCanvas) return;

        const { width, height } = this.container.getBoundingClientRect();
        this.roiCtx.clearRect(0, 0, width, height);

        const sliceIndex = this.imageMapper?.getSlice() || 0;

        // 获取当前视图对应的尺寸和 spacing
        let dimX: number, dimY: number;
        let spacingX: number, spacingY: number;
        switch (this.viewType) {
            case 'axial':
                dimX = this.dimensions[0];
                dimY = this.dimensions[1];
                spacingX = this.imageSpacing[0];
                spacingY = this.imageSpacing[1];
                break;
            case 'sagittal':
                dimX = this.dimensions[1];
                dimY = this.dimensions[2];
                spacingX = this.imageSpacing[1];
                spacingY = this.imageSpacing[2];
                break;
            case 'coronal':
                dimX = this.dimensions[0];
                dimY = this.dimensions[2];
                spacingX = this.imageSpacing[0];
                spacingY = this.imageSpacing[2];
                break;
            default:
                return;
        }

        // 计算物理尺寸 (mm)
        const physicalWidth = dimX * spacingX;
        const physicalHeight = dimY * spacingY;

        // 计算缩放因子：体素坐标 -> 物理坐标 -> Canvas 像素
        // 需要保持宽高比，选择较小的缩放因子以适应视口
        const scaleToFitX = width / physicalWidth;
        const scaleToFitY = height / physicalHeight;
        const uniformScale = Math.min(scaleToFitX, scaleToFitY);

        // 最终缩放因子：体素坐标 * spacing * uniformScale = Canvas 像素
        const scaleX = spacingX * uniformScale;
        const scaleY = spacingY * uniformScale;

        // 居中偏移
        const offsetX = (width - physicalWidth * uniformScale) / 2;
        const offsetY = (height - physicalHeight * uniformScale) / 2;

        // 获取当前切片上所有 ROI 的 mask
        const masks = roiManager.getSliceMasks(
            sliceIndex,
            this.viewType as 'axial' | 'sagittal' | 'coronal',
            dimX,
            dimY
        );

        // 设置线条样式
        this.roiCtx.lineWidth = 2;
        this.roiCtx.lineCap = 'round';
        this.roiCtx.lineJoin = 'round';

        // 遍历每个 ROI 绘制轮廓线
        for (const [roiId, mask] of masks) {
            const meta = roiManager.getROIMetadata(roiId);
            if (!meta || !meta.visible) continue;

            // 提取轮廓
            const contour = extractContour(mask, dimX, dimY, roiId);
            console.log(`[ROI Render] ROI ${roiId}: contour paths=${contour.paths.length}`);
            if (contour.paths.length === 0) continue;

            // 设置颜色（使用 ROI 元数据中的颜色）
            const color = meta.color;
            this.roiCtx.strokeStyle = `rgba(${color[0]}, ${color[1]}, ${color[2]}, 1)`;

            // 绘制每条路径
            for (const path of contour.paths) {
                if (path.length < 2) continue;

                this.roiCtx.beginPath();

                // 转换并绘制第一个点（加上居中偏移）
                const startX = path[0].x * scaleX + offsetX;
                const startY = path[0].y * scaleY + offsetY;
                this.roiCtx.moveTo(startX, startY);

                // 绘制后续点
                for (let i = 1; i < path.length; i++) {
                    const x = path[i].x * scaleX + offsetX;
                    const y = path[i].y * scaleY + offsetY;
                    this.roiCtx.lineTo(x, y);
                }

                // 闭合路径并描边
                this.roiCtx.closePath();
                this.roiCtx.stroke();
            }
        }
    }


    private getMaxSlice(): number {
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
    }

    setWindowLevel(ww: number, wc: number): void {
        this.windowWidth = ww;
        this.windowCenter = wc;
        this.updateWindowLevel();
        this.render();
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

// ========== 主应用 ==========
const views: Map<ViewType, VTKMPRView> = new Map();
let currentImageData: any = null;
let currentWindowWidth = 400;
let currentWindowCenter = 40;

// 3D 视图实例
let volumeView3D: VolumeView3D | null = null;
let update3DTimer: ReturnType<typeof setTimeout> | null = null;
let currentROIId = 1; // 当前选中的 ROI ID

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

    // 设置 ROI 绘制控件
    setupROIControls();

    // 初始化 3D 视图
    const volumeContainer = document.getElementById('volume-view');
    if (volumeContainer) {
        volumeView3D = new VolumeView3D(volumeContainer);
        volumeView3D.initialize();
        console.log('[Main] VolumeView3D initialized');
    }

    // 设置 ROI 更新事件监听（实时更新 3D 视图）
    setup3DViewUpdateListener();

    // 自动加载测试数据
    await loadTestDicomData();

    console.log('Medical Imaging Viewer - Ready');
}

function setupROIControls(): void {
    // ROI 选择
    const roiSelect = document.getElementById('roi-select') as HTMLSelectElement;
    if (roiSelect) {
        roiSelect.addEventListener('change', () => {
            const roiId = parseInt(roiSelect.value);
            brushTool.setROI(roiId);
            currentROIId = roiId;  // 同步更新当前 ROI ID
            console.log(`ROI 切换为: ${roiId}`);
        });
    }

    // 笔刷大小
    const brushSizeInput = document.getElementById('brush-size') as HTMLInputElement;
    const brushSizeLabel = document.getElementById('brush-size-label');
    if (brushSizeInput && brushSizeLabel) {
        brushSizeInput.addEventListener('input', () => {
            const size = parseInt(brushSizeInput.value);
            brushTool.setRadius(size);
            brushSizeLabel.textContent = String(size);
            console.log(`笔刷大小: ${size}`);
        });
    }

    // 擦除模式
    const eraseModeInput = document.getElementById('erase-mode') as HTMLInputElement;
    if (eraseModeInput) {
        eraseModeInput.addEventListener('change', () => {
            brushTool.setEraseMode(eraseModeInput.checked);
            console.log(`擦除模式: ${eraseModeInput.checked ? '开启' : '关闭'}`);
        });
    }

    // 监听 ROI 更新事件，刷新所有视图
    eventBus.on('roi:update', () => {
        for (const view of views.values()) {
            view.renderROIOverlay();
        }
    });
}

/**
 * 设置 3D 视图更新监听器
 * 使用防抖策略，笔刷绘制结束后 300ms 触发 3D 网格更新
 */
function setup3DViewUpdateListener(): void {
    // 监听 ROI 绘制事件
    eventBus.on('roi:paint', (data: { roiId: number }) => {
        // 防抖处理
        if (update3DTimer) {
            clearTimeout(update3DTimer);
        }

        update3DTimer = setTimeout(() => {
            update3DMesh(data.roiId);
        }, 300);
    });

    // 监听 ROI 更新事件（笔刷结束时触发）
    eventBus.on('roi:update', () => {
        // 防抖处理
        if (update3DTimer) {
            clearTimeout(update3DTimer);
        }

        update3DTimer = setTimeout(() => {
            // 更新当前选中的 ROI
            update3DMesh(currentROIId);
        }, 200);
    });

    console.log('[Main] 3D View update listener registered');
}

/**
 * 更新指定 ROI 的 3D 网格
 */
function update3DMesh(roiId: number): void {
    if (!volumeView3D) return;

    console.log(`[Main] Updating 3D mesh for ROI ${roiId}...`);

    // 设置 spacing
    const spacing = roiManager.getSpacing();
    meshGenerator.setSpacing(spacing);

    // 生成网格
    const mesh = meshGenerator.generateMesh(roiId);

    if (mesh) {
        volumeView3D.updateROIMesh(roiId, mesh);
        console.log(`[Main] 3D mesh updated: ${mesh.triangleCount} triangles`);
    } else {
        // 如果没有网格数据，移除 Actor
        volumeView3D.removeROI(roiId);
        console.log(`[Main] ROI ${roiId} removed from 3D view (no data)`);
    }
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

        // 更新窗宽窗位输入框
        const wwInput = document.getElementById('window-width') as HTMLInputElement;
        const wcInput = document.getElementById('window-center') as HTMLInputElement;
        if (wwInput) wwInput.value = String(currentWindowWidth);
        if (wcInput) wcInput.value = String(currentWindowCenter);

        // 更新信息
        const dims = currentImageData.getDimensions();
        const spacing = currentImageData.getSpacing();

        // 初始化 ROI 管理器
        roiManager.initialize(null as unknown as WebGL2RenderingContext, dims as Vec3, spacing as Vec3);
        console.log('ROI Manager initialized with dimensions:', dims);

        const statsInfo = document.getElementById('stats-info');
        if (statsInfo) {
            statsInfo.innerHTML = `
                <div>尺寸: ${dims[0]} × ${dims[1]} × ${dims[2]}</div>
                <div>类型: ${useTestData ? '测试数据' : 'CT DICOM'}</div>
                <div>来源: ${useTestData ? '程序生成' : 'dcmtest/Anonymized0706'}</div>
                <div style="color: var(--accent);">ROI: 按住 Ctrl + 左键绘制</div>
            `;
        }

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
        });
        presetContainer.appendChild(btn);
    }

    const windowPanel = document.querySelector('.panel');
    windowPanel?.appendChild(presetContainer);
}

// 启动
document.addEventListener('DOMContentLoaded', initializeApp);
