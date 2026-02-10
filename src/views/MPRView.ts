/**
 * MPR 单视图组件
 * 封装 VTK.js 渲染管线，支持双层 Canvas 架构
 */

import type { VolumeData, ViewType, MPRViewState, Vec3 } from '@/core/types';
import { eventBus } from '@/core/EventBus';

// VTK.js 类型声明（简化）
declare const vtk: {
    Rendering: {
        Core: {
            vtkRenderWindow: { newInstance: () => VTKRenderWindow };
            vtkRenderer: { newInstance: () => VTKRenderer };
            vtkRenderWindowInteractor: { newInstance: () => VTKInteractor };
        };
        OpenGL: {
            vtkRenderWindow: { newInstance: () => VTKOpenGLRenderWindow };
        };
        Misc: {
            vtkInteractorStyleImage: { newInstance: () => VTKInteractorStyle };
        };
    };
    Filters: {
        General: {
            vtkImageSlice: { newInstance: () => VTKImageSlice };
            vtkImageMapper: { newInstance: () => VTKImageMapper };
        };
    };
    Common: {
        DataModel: {
            vtkImageData: { newInstance: () => VTKImageData };
        };
    };
};

interface VTKRenderWindow {
    addRenderer: (renderer: VTKRenderer) => void;
    render: () => void;
}

interface VTKRenderer {
    addActor: (actor: unknown) => void;
    setBackground: (r: number, g: number, b: number) => void;
    resetCamera: () => void;
    getActiveCamera: () => VTKCamera;
}

interface VTKCamera {
    setParallelProjection: (enabled: boolean) => void;
    setPosition: (x: number, y: number, z: number) => void;
    setFocalPoint: (x: number, y: number, z: number) => void;
    setViewUp: (x: number, y: number, z: number) => void;
    zoom: (factor: number) => void;
}

interface VTKOpenGLRenderWindow {
    setContainer: (container: HTMLElement) => void;
    setSize: (width: number, height: number) => void;
}

interface VTKInteractor {
    initialize: () => void;
    setInteractorStyle: (style: VTKInteractorStyle) => void;
    bindEvents: (container: HTMLElement) => void;
}

interface VTKInteractorStyle { }

interface VTKImageSlice {
    setMapper: (mapper: VTKImageMapper) => void;
    getProperty: () => VTKImageProperty;
}

interface VTKImageProperty {
    setColorWindow: (width: number) => void;
    setColorLevel: (level: number) => void;
    setInterpolationTypeToLinear: () => void;
}

interface VTKImageMapper {
    setInputData: (data: VTKImageData) => void;
    setSliceAtFocalPoint: (enabled: boolean) => void;
    setSlicingMode: (mode: number) => void;
    setSlice: (slice: number) => void;
    getSlice: () => number;
    getSliceRange: () => [number, number];
}

interface VTKImageData {
    setDimensions: (dims: number[]) => void;
    setSpacing: (spacing: number[]) => void;
    setOrigin: (origin: number[]) => void;
    getPointData: () => { setScalars: (arr: unknown) => void };
}

/**
 * 切片模式枚举
 */
const SlicingMode = {
    I: 0, // Axial (Z)
    J: 1, // Coronal (Y)
    K: 2, // Sagittal (X)
};

/**
 * MPR 单视图
 */
export class MPRView {
    private container: HTMLElement;
    private vtkContainer: HTMLElement;
    private viewType: ViewType;
    private state: MPRViewState;

    // VTK 对象
    private renderWindow: VTKRenderWindow | null = null;
    private renderer: VTKRenderer | null = null;
    private openGLRenderWindow: VTKOpenGLRenderWindow | null = null;
    private interactor: VTKInteractor | null = null;
    private imageMapper: VTKImageMapper | null = null;
    private imageSlice: VTKImageSlice | null = null;
    private imageData: VTKImageData | null = null;

    // 体数据
    private volume: VolumeData | null = null;

    constructor(container: HTMLElement, viewType: ViewType) {
        this.container = container;
        this.viewType = viewType;
        this.state = {
            sliceIndex: 0,
            windowWidth: 400,
            windowCenter: 40,
            zoom: 1,
            pan: [0, 0],
        };

        // 确保容器使用相对定位以支持叠加层
        this.container.style.position = 'relative';

        // 创建 VTK 容器（底层）
        this.vtkContainer = document.createElement('div');
        this.vtkContainer.className = 'vtk-container';
        this.vtkContainer.style.cssText = 'position: absolute; top: 0; left: 0; width: 100%; height: 100%; z-index: 1;';
        this.container.appendChild(this.vtkContainer);
    }

    /**
     * 初始化 VTK 渲染管线
     */
    initialize(): void {
        // 创建渲染窗口
        this.renderWindow = vtk.Rendering.Core.vtkRenderWindow.newInstance();
        this.renderer = vtk.Rendering.Core.vtkRenderer.newInstance();
        this.renderWindow.addRenderer(this.renderer);

        // 创建 OpenGL 渲染窗口（现在绑定到 vtkContainer）
        this.openGLRenderWindow = vtk.Rendering.OpenGL.vtkRenderWindow.newInstance();
        this.openGLRenderWindow.setContainer(this.vtkContainer);
        this.updateSize();

        // 创建交互器
        this.interactor = vtk.Rendering.Core.vtkRenderWindowInteractor.newInstance();
        const style = vtk.Rendering.Misc.vtkInteractorStyleImage.newInstance();
        this.interactor.setInteractorStyle(style);
        this.interactor.bindEvents(this.vtkContainer);
        this.interactor.initialize();

        // 创建图像映射器和切片
        this.imageMapper = vtk.Filters.General.vtkImageMapper.newInstance();
        this.imageSlice = vtk.Filters.General.vtkImageSlice.newInstance();
        this.imageSlice.setMapper(this.imageMapper);

        // 设置切片模式
        this.setSlicingMode();

        // 设置属性
        const property = this.imageSlice.getProperty();
        property.setInterpolationTypeToLinear();
        this.updateWindowLevel();

        // 添加到渲染器
        this.renderer.addActor(this.imageSlice);
        this.renderer.setBackground(0.1, 0.1, 0.1);

        // 设置相机
        this.setupCamera();

        // 监听窗口大小变化
        window.addEventListener('resize', this.handleResize);
    }

    /**
     * 设置切片模式
     */
    private setSlicingMode(): void {
        if (!this.imageMapper) return;

        switch (this.viewType) {
            case 'axial':
                this.imageMapper.setSlicingMode(SlicingMode.K);
                break;
            case 'sagittal':
                this.imageMapper.setSlicingMode(SlicingMode.I);
                break;
            case 'coronal':
                this.imageMapper.setSlicingMode(SlicingMode.J);
                break;
        }
        this.imageMapper.setSliceAtFocalPoint(true);
    }

    /**
     * 设置相机
     */
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

    /**
     * 设置体数据
     */
    setVolumeData(volume: VolumeData): void {
        this.volume = volume;

        // 创建 VTK ImageData
        this.imageData = vtk.Common.DataModel.vtkImageData.newInstance();
        this.imageData.setDimensions(volume.metadata.dimensions);
        this.imageData.setSpacing(volume.metadata.spacing);
        this.imageData.setOrigin(volume.metadata.origin);

        // 设置标量数据
        const scalars = this.imageData.getPointData();
        scalars.setScalars(volume.pixelData);

        // 连接到映射器
        this.imageMapper?.setInputData(this.imageData);

        // 设置窗宽窗位
        if (volume.metadata.windowWidth !== undefined) {
            this.state.windowWidth = volume.metadata.windowWidth;
        }
        if (volume.metadata.windowCenter !== undefined) {
            this.state.windowCenter = volume.metadata.windowCenter;
        }
        this.updateWindowLevel();

        // 设置初始切片为中间层
        const maxSlice = this.getMaxSlice();
        this.setSlice(Math.floor(maxSlice / 2));

        // 重置相机
        this.renderer?.resetCamera();
        this.render();
    }

    /**
     * 获取最大切片索引
     */
    getMaxSlice(): number {
        if (!this.imageMapper) return 0;
        const range = this.imageMapper.getSliceRange();
        return range[1];
    }

    /**
     * 设置切片
     */
    setSlice(index: number): void {
        if (!this.imageMapper) return;

        const maxSlice = this.getMaxSlice();
        const clampedIndex = Math.max(0, Math.min(index, maxSlice));

        this.state.sliceIndex = clampedIndex;
        this.imageMapper.setSlice(clampedIndex);
        this.render();

        // 发送事件
        eventBus.emit('slice:change', {
            viewType: this.viewType,
            sliceIndex: clampedIndex,
        });
    }

    /**
     * 获取当前切片
     */
    getSlice(): number {
        return this.state.sliceIndex;
    }

    /**
     * 设置窗宽窗位
     */
    setWindowLevel(width: number, center: number): void {
        this.state.windowWidth = width;
        this.state.windowCenter = center;
        this.updateWindowLevel();
        this.render();

        eventBus.emit('window:change', { windowWidth: width, windowCenter: center });
    }

    /**
     * 更新窗宽窗位
     */
    private updateWindowLevel(): void {
        if (!this.imageSlice) return;
        const property = this.imageSlice.getProperty();
        property.setColorWindow(this.state.windowWidth);
        property.setColorLevel(this.state.windowCenter);
    }

    /**
     * 更新尺寸
     */
    private updateSize(): void {
        if (!this.openGLRenderWindow) return;
        const { width, height } = this.container.getBoundingClientRect();
        this.openGLRenderWindow.setSize(width, height);
    }

    /**
     * 渲染
     */
    render(): void {
        this.renderWindow?.render();
    }

    /**
     * 处理窗口大小变化
     */
    private handleResize = (): void => {
        this.updateSize();
        this.render();
    };

    /**
     * 获取视图状态
     */
    getState(): MPRViewState {
        return { ...this.state };
    }

    /**
     * 获取视图类型
     */
    getViewType(): ViewType {
        return this.viewType;
    }

    /**
     * 屏幕坐标转体素坐标
     */
    screenToVoxel(screenX: number, screenY: number): Vec3 | null {
        if (!this.volume) return null;

        const rect = this.container.getBoundingClientRect();
        const dims = this.volume.metadata.dimensions;

        // 简化计算（实际需要考虑相机变换）
        const normalizedX = screenX / rect.width;
        const normalizedY = screenY / rect.height;

        switch (this.viewType) {
            case 'axial':
                return [
                    Math.floor(normalizedX * dims[0]),
                    Math.floor(normalizedY * dims[1]),
                    this.state.sliceIndex,
                ];
            case 'sagittal':
                return [
                    this.state.sliceIndex,
                    Math.floor(normalizedX * dims[1]),
                    Math.floor(normalizedY * dims[2]),
                ];
            case 'coronal':
                return [
                    Math.floor(normalizedX * dims[0]),
                    this.state.sliceIndex,
                    Math.floor(normalizedY * dims[2]),
                ];
            default:
                return null;
        }
    }

    /**
     * 销毁
     */
    dispose(): void {
        window.removeEventListener('resize', this.handleResize);
        // VTK 对象清理...
    }
}
