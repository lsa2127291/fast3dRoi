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
import { packVertexQ } from './gpu/data/VertexQ';
import type { VertexQEncoded } from './gpu/data/VertexQ';
import { QUANT_STEP_MM } from './gpu/constants';

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

        // 监听窗口大小变化
        new ResizeObserver(() => {
            this.updateSize();
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
        });
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

/** 初始化 WebGPU 3D 视图 */
async function initializeWebGPUView(): Promise<void> {
    const container = document.getElementById('volume-view');
    if (!container) {
        console.warn('[WebGPU] #volume-view 容器未找到');
        return;
    }

    try {
        // 初始化 WebGPU 上下文
        const ctx = await initWebGPU();
        console.log('[WebGPU] 初始化成功');

        // 创建渲染器
        webgpuRenderer = new WebGPURenderer(ctx);
        await webgpuRenderer.initialize(container);

        // 上传测试立方体
        const { vertices, indices } = createTestCube();
        webgpuRenderer.uploadMesh(vertices, indices);

        // 启动渲染循环
        webgpuRenderer.startRenderLoop();

        console.log('[WebGPU] 测试立方体已加载');
    } catch (err) {
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

    // 设置 ROI 绘制控件（WebGPU 勾画系统待接入）
    setupROIControls();

    // 初始化 WebGPU 渲染器并绑定到 #volume-view
    await initializeWebGPUView();

    // 自动加载测试数据
    await loadTestDicomData();

    console.log('Medical Imaging Viewer - Ready');
}

function setupROIControls(): void {
    // ROI 选择 — WebGPU 勾画系统待接入
    const roiSelect = document.getElementById('roi-select') as HTMLSelectElement;
    if (roiSelect) {
        roiSelect.addEventListener('change', () => {
            const roiId = parseInt(roiSelect.value);
            console.log(`ROI 切换为: ${roiId} (WebGPU annotation system not yet initialized)`);
        });
    }

    // 笔刷大小 — WebGPU 勾画系统待接入
    const brushSizeInput = document.getElementById('brush-size') as HTMLInputElement;
    const brushSizeLabel = document.getElementById('brush-size-label');
    if (brushSizeInput && brushSizeLabel) {
        brushSizeInput.addEventListener('input', () => {
            const size = parseInt(brushSizeInput.value);
            brushSizeLabel.textContent = String(size);
            console.log(`笔刷大小: ${size} (WebGPU annotation system not yet initialized)`);
        });
    }

    // 擦除模式 — WebGPU 勾画系统待接入
    const eraseModeInput = document.getElementById('erase-mode') as HTMLInputElement;
    if (eraseModeInput) {
        eraseModeInput.addEventListener('change', () => {
            console.log(`擦除模式: ${eraseModeInput.checked ? '开启' : '关闭'} (WebGPU annotation system not yet initialized)`);
        });
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

        const statsInfo = document.getElementById('stats-info');
        if (statsInfo) {
            statsInfo.innerHTML = `
                <div>尺寸: ${dims[0]} × ${dims[1]} × ${dims[2]}</div>
                <div>类型: ${useTestData ? '测试数据' : 'CT DICOM'}</div>
                <div>来源: ${useTestData ? '程序生成' : 'dcmtest/Anonymized0706'}</div>
                <div style="color: var(--accent);">WebGPU 勾画系统重构中...</div>
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
