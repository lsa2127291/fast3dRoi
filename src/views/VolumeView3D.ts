/**
 * VolumeView3D - 3D 体积渲染视图
 * 使用 VTK.js 渲染 ROI 的 3D 表面
 */

import vtkRenderWindow from '@kitware/vtk.js/Rendering/Core/RenderWindow';
import vtkRenderer from '@kitware/vtk.js/Rendering/Core/Renderer';
import vtkRenderWindowInteractor from '@kitware/vtk.js/Rendering/Core/RenderWindowInteractor';
import vtkOpenGLRenderWindow from '@kitware/vtk.js/Rendering/OpenGL/RenderWindow';
import vtkInteractorStyleTrackballCamera from '@kitware/vtk.js/Interaction/Style/InteractorStyleTrackballCamera';
import vtkActor from '@kitware/vtk.js/Rendering/Core/Actor';
import vtkMapper from '@kitware/vtk.js/Rendering/Core/Mapper';
import vtkPolyData from '@kitware/vtk.js/Common/DataModel/PolyData';

import type { ROIMesh } from '@/mesh/MarchingCubesMeshGenerator';
import { roiManager } from '@/annotation/SparseROIManager';

/**
 * 3D 体积视图
 */
export class VolumeView3D {
    private container: HTMLElement;
    private renderWindow: any = null;
    private renderer: any = null;
    private openGLRenderWindow: any = null;
    private interactor: any = null;

    // ROI Actors 映射
    private roiActors: Map<number, {
        actor: any;
        mapper: any;
        polyData: any;
    }> = new Map();

    private initialized = false;

    constructor(container: HTMLElement) {
        this.container = container;
    }

    /**
     * 初始化 VTK.js 3D 渲染管线
     */
    initialize(): void {
        if (this.initialized) return;

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

        // 创建交互器 - 使用 TrackballCamera 样式
        this.interactor = vtkRenderWindowInteractor.newInstance();
        this.interactor.setView(this.openGLRenderWindow);
        const style = vtkInteractorStyleTrackballCamera.newInstance();
        this.interactor.setInteractorStyle(style);
        this.interactor.bindEvents(this.container);
        this.interactor.initialize();

        // 设置背景色
        this.renderer.setBackground(0.15, 0.15, 0.18);

        // 添加初始光源
        this.renderer.setTwoSidedLighting(true);

        // 监听窗口大小变化
        new ResizeObserver(() => {
            this.updateSize();
            this.render();
        }).observe(this.container);

        this.initialized = true;
        console.log('[VolumeView3D] Initialized');
    }

    /**
     * 更新窗口尺寸
     */
    private updateSize(): void {
        if (!this.openGLRenderWindow) return;
        const { width, height } = this.container.getBoundingClientRect();
        this.openGLRenderWindow.setSize(Math.floor(width), Math.floor(height));
    }

    /**
     * 更新指定 ROI 的网格
     */
    updateROIMesh(roiId: number, mesh: ROIMesh): void {
        if (!this.initialized) {
            this.initialize();
        }

        // 获取或创建 Actor
        let roiData = this.roiActors.get(roiId);

        if (!roiData) {
            // 创建新的 Actor
            const polyData = vtkPolyData.newInstance();
            const mapper = vtkMapper.newInstance();
            const actor = vtkActor.newInstance();

            mapper.setInputData(polyData);
            actor.setMapper(mapper);

            // 设置颜色
            const meta = roiManager.getROIMetadata(roiId);
            if (meta) {
                actor.getProperty().setColor(
                    meta.color[0] / 255,
                    meta.color[1] / 255,
                    meta.color[2] / 255
                );
                actor.getProperty().setOpacity(meta.color[3] / 255);
            }

            // 设置材质属性
            actor.getProperty().setAmbient(0.2);
            actor.getProperty().setDiffuse(0.7);
            actor.getProperty().setSpecular(0.3);
            actor.getProperty().setSpecularPower(20);

            this.renderer.addActor(actor);

            roiData = { actor, mapper, polyData };
            this.roiActors.set(roiId, roiData);
        }

        // 更新 PolyData
        this.updatePolyData(roiData.polyData, mesh);

        // 重置相机以适应场景（仅在首次添加时）
        if (this.roiActors.size === 1) {
            this.renderer.resetCamera();
        }

        this.render();

        console.log(`[VolumeView3D] Updated ROI ${roiId}: ${mesh.triangleCount} triangles`);
    }

    /**
     * 更新 PolyData 数据
     */
    private updatePolyData(polyData: any, mesh: ROIMesh): void {
        // 设置顶点
        polyData.getPoints().setData(mesh.vertices, 3);

        // 设置三角形 (VTK.js 需要 cell 格式: [npts, pt0, pt1, pt2, ...])
        const numTriangles = mesh.indices.length / 3;
        const cells = new Uint32Array(numTriangles * 4);
        for (let i = 0; i < numTriangles; i++) {
            cells[i * 4] = 3;  // 每个三角形有 3 个顶点
            cells[i * 4 + 1] = mesh.indices[i * 3];
            cells[i * 4 + 2] = mesh.indices[i * 3 + 1];
            cells[i * 4 + 3] = mesh.indices[i * 3 + 2];
        }
        polyData.getPolys().setData(cells);

        // 设置法线 (VTK.js 会自动计算)
        // 如果需要手动设置，可以使用 polyData.getPointData().setNormals()
        // 暂时跳过法线设置，让 VTK.js 自动处理

        polyData.modified();
    }

    /**
     * 移除 ROI
     */
    removeROI(roiId: number): void {
        const roiData = this.roiActors.get(roiId);
        if (roiData) {
            this.renderer.removeActor(roiData.actor);
            this.roiActors.delete(roiId);
            this.render();
        }
    }

    /**
     * 设置 ROI 可见性
     */
    setROIVisible(roiId: number, visible: boolean): void {
        const roiData = this.roiActors.get(roiId);
        if (roiData) {
            roiData.actor.setVisibility(visible);
            this.render();
        }
    }

    /**
     * 更新 ROI 颜色
     */
    updateROIColor(roiId: number): void {
        const roiData = this.roiActors.get(roiId);
        if (roiData) {
            const meta = roiManager.getROIMetadata(roiId);
            if (meta) {
                roiData.actor.getProperty().setColor(
                    meta.color[0] / 255,
                    meta.color[1] / 255,
                    meta.color[2] / 255
                );
                roiData.actor.getProperty().setOpacity(meta.color[3] / 255);
                this.render();
            }
        }
    }

    /**
     * 清除所有 ROI
     */
    clearAll(): void {
        for (const [roiId] of this.roiActors) {
            this.removeROI(roiId);
        }
    }

    /**
     * 重置相机
     */
    resetCamera(): void {
        if (this.renderer) {
            this.renderer.resetCamera();
            this.render();
        }
    }

    /**
     * 渲染
     */
    render(): void {
        if (this.renderWindow) {
            this.renderWindow.render();
        }
    }

    /**
     * 销毁
     */
    dispose(): void {
        this.clearAll();
        if (this.interactor) {
            this.interactor.unbindEvents();
        }
        // VTK.js 资源清理
        this.renderWindow = null;
        this.renderer = null;
        this.openGLRenderWindow = null;
        this.interactor = null;
        this.initialized = false;
    }
}
