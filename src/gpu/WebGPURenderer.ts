/**
 * WebGPU 渲染器 — 管理 canvas、相机、渲染循环
 *
 * 替代原 VolumeView3D (VTK.js)，用于 3D ROI 表面渲染。
 * 当前阶段：渲染 VertexQ 编码的测试几何体，验证管线可行性。
 */

import type { WebGPUContext } from './WebGPUContext';
import { BasicRenderPipeline } from './pipelines/BasicRenderPipeline';
import type { RenderUniforms } from './pipelines/BasicRenderPipeline';
import type { VertexQEncoded, QuantMeta } from './data/VertexQ';
import { writeVertexQToBuffer, writeQuantMetaToBuffer, createDefaultQuantMeta } from './data/VertexQ';
import { VERTEX_Q_BYTES } from './constants';

// ========== 数学工具 ==========

/** 创建透视投影矩阵 */
function perspectiveMatrix(fovY: number, aspect: number, near: number, far: number): Float32Array {
    const f = 1.0 / Math.tan(fovY / 2);
    const rangeInv = 1.0 / (near - far);
    return new Float32Array([
        f / aspect, 0, 0, 0,
        0, f, 0, 0,
        0, 0, (near + far) * rangeInv, -1,
        0, 0, near * far * rangeInv * 2, 0,
    ]);
}

/** 创建 lookAt 视图矩阵 */
function lookAtMatrix(eye: number[], target: number[], up: number[]): Float32Array {
    const zAxis = normalize3(sub3(eye, target));
    const xAxis = normalize3(cross3(up, zAxis));
    const yAxis = cross3(zAxis, xAxis);

    return new Float32Array([
        xAxis[0], yAxis[0], zAxis[0], 0,
        xAxis[1], yAxis[1], zAxis[1], 0,
        xAxis[2], yAxis[2], zAxis[2], 0,
        -dot3(xAxis, eye), -dot3(yAxis, eye), -dot3(zAxis, eye), 1,
    ]);
}

/** 矩阵乘法 4×4 */
function multiplyMat4(a: Float32Array, b: Float32Array): Float32Array {
    const out = new Float32Array(16);
    for (let i = 0; i < 4; i++) {
        for (let j = 0; j < 4; j++) {
            out[j * 4 + i] =
                a[0 * 4 + i] * b[j * 4 + 0] +
                a[1 * 4 + i] * b[j * 4 + 1] +
                a[2 * 4 + i] * b[j * 4 + 2] +
                a[3 * 4 + i] * b[j * 4 + 3];
        }
    }
    return out;
}

/** 单位矩阵 */
function identityMat4(): Float32Array {
    const m = new Float32Array(16);
    m[0] = m[5] = m[10] = m[15] = 1;
    return m;
}

function sub3(a: number[], b: number[]): number[] {
    return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function cross3(a: number[], b: number[]): number[] {
    return [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ];
}
function dot3(a: number[], b: number[]): number {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function normalize3(v: number[]): number[] {
    const len = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
    return len > 0 ? [v[0] / len, v[1] / len, v[2] / len] : [0, 0, 0];
}

// ========== WebGPURenderer ==========

export class WebGPURenderer {
    private canvas: HTMLCanvasElement | null = null;
    private gpuContext: GPUCanvasContext | null = null;
    private depthTexture: GPUTexture | null = null;

    private pipeline: BasicRenderPipeline | null = null;
    private storageBindGroup: GPUBindGroup | null = null;
    private uniformBindGroup: GPUBindGroup | null = null;

    // GPU buffers for mesh data
    private vertexBuffer: GPUBuffer | null = null;
    private indexBuffer: GPUBuffer | null = null;
    private quantMetaBuffer: GPUBuffer | null = null;
    private indexCount = 0;

    // Camera state
    private cameraDistance = 500;
    private cameraRotX = -0.4;  // pitch (radians)
    private cameraRotY = 0.6;   // yaw (radians)
    private cameraTarget = [0, 0, 0];
    private fov = Math.PI / 4;

    // Interaction state
    private isDragging = false;
    private lastMouseX = 0;
    private lastMouseY = 0;

    // Render loop
    private animFrameId = 0;
    private needsRender = true;

    private readonly ctx: WebGPUContext;
    private container: HTMLElement | null = null;

    constructor(ctx: WebGPUContext) {
        this.ctx = ctx;
    }

    /**
     * 初始化渲染器并绑定到容器
     */
    async initialize(container: HTMLElement): Promise<void> {
        this.container = container;

        // 创建 canvas
        this.canvas = document.createElement('canvas');
        this.canvas.style.cssText = 'width: 100%; height: 100%; display: block;';
        container.appendChild(this.canvas);

        // 配置 WebGPU canvas context
        this.gpuContext = this.canvas.getContext('webgpu') as GPUCanvasContext;
        if (!this.gpuContext) {
            throw new Error('无法获取 WebGPU canvas context');
        }

        this.gpuContext.configure({
            device: this.ctx.device,
            format: this.ctx.preferredFormat,
            alphaMode: 'premultiplied',
        });

        // 设置 canvas 尺寸
        this.updateSize();

        // 创建渲染管线
        this.pipeline = new BasicRenderPipeline(this.ctx);
        await this.pipeline.initialize();

        // 创建 uniform bind group
        this.uniformBindGroup = this.pipeline.createUniformBindGroup();

        // 监听窗口大小变化
        new ResizeObserver(() => {
            this.updateSize();
            this.needsRender = true;
        }).observe(container);

        // 绑定鼠标交互
        this.setupInteraction();

        console.log('[WebGPURenderer] 初始化完成');
    }

    /**
     * 上传网格数据到 GPU
     */
    uploadMesh(
        vertices: VertexQEncoded[],
        indices: number[],
        quantMeta?: QuantMeta
    ): void {
        const { device } = this.ctx;

        // 清理旧 buffer
        this.vertexBuffer?.destroy();
        this.indexBuffer?.destroy();
        this.quantMetaBuffer?.destroy();

        const meta = quantMeta ?? createDefaultQuantMeta();

        // 创建并填充 vertex buffer
        const vertexByteSize = vertices.length * VERTEX_Q_BYTES;
        this.vertexBuffer = device.createBuffer({
            label: 'mesh_vertices',
            size: Math.max(vertexByteSize, 8), // 最小 8 字节
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        if (vertices.length > 0) {
            const vertexData = new ArrayBuffer(vertexByteSize);
            writeVertexQToBuffer(vertices, vertexData, 0);
            device.queue.writeBuffer(this.vertexBuffer, 0, vertexData);
        }

        // 创建并填充 index buffer
        const indexByteSize = indices.length * 4;
        this.indexBuffer = device.createBuffer({
            label: 'mesh_indices',
            size: Math.max(indexByteSize, 4), // 最小 4 字节
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        if (indices.length > 0) {
            const indexData = new Uint32Array(indices);
            device.queue.writeBuffer(this.indexBuffer, 0, indexData);
        }

        // 创建并填充 quant_meta buffer
        this.quantMetaBuffer = device.createBuffer({
            label: 'mesh_quant_meta',
            size: 16, // 1 × vec4<f32>
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        const metaData = new ArrayBuffer(16);
        writeQuantMetaToBuffer([meta], metaData, 0);
        device.queue.writeBuffer(this.quantMetaBuffer, 0, metaData);

        this.indexCount = indices.length;

        // 创建 storage bind group
        if (this.pipeline) {
            this.storageBindGroup = this.pipeline.createStorageBindGroup(
                this.vertexBuffer,
                this.indexBuffer,
                this.quantMetaBuffer,
            );
        }

        this.needsRender = true;
        console.log(`[WebGPURenderer] 网格上传: ${vertices.length} 顶点, ${indices.length / 3} 三角形`);
    }

    /**
     * 渲染单帧
     */
    render(): void {
        if (!this.gpuContext || !this.pipeline || !this.canvas) return;
        if (!this.storageBindGroup || !this.uniformBindGroup) return;
        if (this.indexCount === 0) return;

        const { device } = this.ctx;

        // 更新 uniforms
        const aspect = this.canvas.width / this.canvas.height;
        const eye = this.getCameraPosition();
        const viewMatrix = lookAtMatrix(eye, this.cameraTarget, [0, 1, 0]);
        const projMatrix = perspectiveMatrix(this.fov, aspect, 1, 10000);
        const modelMatrix = identityMat4();
        const mvpMatrix = multiplyMat4(projMatrix, viewMatrix);

        const uniforms: RenderUniforms = {
            mvpMatrix,
            modelMatrix,
            color: [0.8, 0.2, 0.2, 1.0], // 红色
            lightDir: normalize3([1, 1, 1]) as [number, number, number],
        };
        this.pipeline.updateUniforms(uniforms);

        // 获取当前纹理
        const textureView = this.gpuContext.getCurrentTexture().createView();

        // 确保深度纹理存在且尺寸匹配
        this.ensureDepthTexture();
        if (!this.depthTexture) return;
        const depthView = this.depthTexture.createView();

        // 创建命令编码器
        const encoder = device.createCommandEncoder({ label: 'render_frame' });

        const passEncoder = encoder.beginRenderPass({
            colorAttachments: [{
                view: textureView,
                clearValue: { r: 0.12, g: 0.12, b: 0.15, a: 1.0 },
                loadOp: 'clear',
                storeOp: 'store',
            }],
            depthStencilAttachment: {
                view: depthView,
                depthClearValue: 1.0,
                depthLoadOp: 'clear',
                depthStoreOp: 'store',
            },
        });

        this.pipeline.encode(
            passEncoder,
            this.storageBindGroup,
            this.uniformBindGroup,
            this.indexCount,
        );

        passEncoder.end();
        device.queue.submit([encoder.finish()]);
    }

    /**
     * 启动渲染循环
     */
    startRenderLoop(): void {
        const loop = () => {
            if (this.needsRender) {
                this.render();
                this.needsRender = false;
            }
            this.animFrameId = requestAnimationFrame(loop);
        };
        this.animFrameId = requestAnimationFrame(loop);
    }

    /**
     * 停止渲染循环
     */
    stopRenderLoop(): void {
        if (this.animFrameId) {
            cancelAnimationFrame(this.animFrameId);
            this.animFrameId = 0;
        }
    }

    /**
     * 设置相机目标点
     */
    setCameraTarget(x: number, y: number, z: number): void {
        this.cameraTarget = [x, y, z];
        this.needsRender = true;
    }

    /**
     * 设置相机距离
     */
    setCameraDistance(distance: number): void {
        this.cameraDistance = Math.max(10, distance);
        this.needsRender = true;
    }

    /**
     * 销毁渲染器
     */
    destroy(): void {
        this.stopRenderLoop();
        this.pipeline?.destroy();
        this.vertexBuffer?.destroy();
        this.indexBuffer?.destroy();
        this.quantMetaBuffer?.destroy();
        this.depthTexture?.destroy();
        if (this.canvas && this.container) {
            this.container.removeChild(this.canvas);
        }
        this.canvas = null;
        this.gpuContext = null;
    }

    // ========== 内部方法 ==========

    private getCameraPosition(): number[] {
        const x = this.cameraTarget[0] + this.cameraDistance * Math.cos(this.cameraRotX) * Math.sin(this.cameraRotY);
        const y = this.cameraTarget[1] + this.cameraDistance * Math.sin(this.cameraRotX);
        const z = this.cameraTarget[2] + this.cameraDistance * Math.cos(this.cameraRotX) * Math.cos(this.cameraRotY);
        return [x, y, z];
    }

    private updateSize(): void {
        if (!this.canvas || !this.container) return;
        const { width, height } = this.container.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        this.canvas.width = Math.floor(width * dpr);
        this.canvas.height = Math.floor(height * dpr);

        // 深度纹理需要重建
        this.depthTexture?.destroy();
        this.depthTexture = null;
        this.needsRender = true;
    }

    private ensureDepthTexture(): void {
        if (!this.canvas) return;
        if (this.depthTexture) return;

        this.depthTexture = this.ctx.device.createTexture({
            label: 'depth_texture',
            size: [this.canvas.width, this.canvas.height],
            format: 'depth24plus',
            usage: GPUTextureUsage.RENDER_ATTACHMENT,
        });
    }

    private setupInteraction(): void {
        if (!this.canvas) return;

        // 鼠标拖拽旋转
        this.canvas.addEventListener('mousedown', (e) => {
            if (e.button === 0) { // 左键旋转
                this.isDragging = true;
                this.lastMouseX = e.clientX;
                this.lastMouseY = e.clientY;
            }
        });

        window.addEventListener('mousemove', (e) => {
            if (!this.isDragging) return;
            const dx = e.clientX - this.lastMouseX;
            const dy = e.clientY - this.lastMouseY;
            this.lastMouseX = e.clientX;
            this.lastMouseY = e.clientY;

            this.cameraRotY += dx * 0.005;
            this.cameraRotX = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01,
                this.cameraRotX - dy * 0.005));
            this.needsRender = true;
        });

        window.addEventListener('mouseup', () => {
            this.isDragging = false;
        });

        // 滚轮缩放
        this.canvas.addEventListener('wheel', (e) => {
            e.preventDefault();
            const factor = e.deltaY > 0 ? 1.1 : 0.9;
            this.cameraDistance = Math.max(10, Math.min(5000, this.cameraDistance * factor));
            this.needsRender = true;
        });
    }
}
