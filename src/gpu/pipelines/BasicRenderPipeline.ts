/**
 * 基础渲染管线 — 解码 VertexQ 并渲染彩色三角形
 *
 * 绑定布局:
 *   group(0): storage buffers — vertex_pool, index_pool, quant_meta
 *   group(1): uniform buffer — MVP, model, color, light_dir
 */

import type { WebGPUContext } from '../WebGPUContext';
import basicRenderWGSL from '../shaders/basic_render.wgsl?raw';

// ========== 类型定义 ==========

/** Uniform 数据（CPU 侧） */
export interface RenderUniforms {
    /** MVP 矩阵 (4×4 f32) */
    mvpMatrix: Float32Array;
    /** Model 矩阵 (4×4 f32) */
    modelMatrix: Float32Array;
    /** ROI 颜色 [r, g, b, a] (0-1) */
    color: [number, number, number, number];
    /** 光照方向 [x, y, z, 0] */
    lightDir: [number, number, number];
}

// Uniform buffer 布局: mat4(64) + mat4(64) + vec4(16) + vec4(16) = 160 bytes
const UNIFORM_BUFFER_SIZE = 160;

// ========== BasicRenderPipeline ==========

export class BasicRenderPipeline {
    private pipeline: GPURenderPipeline | null = null;
    private bindGroupLayout0: GPUBindGroupLayout | null = null;
    private bindGroupLayout1: GPUBindGroupLayout | null = null;
    private uniformBuffer: GPUBuffer | null = null;
    private uniformData = new Float32Array(UNIFORM_BUFFER_SIZE / 4); // 40 floats

    private readonly ctx: WebGPUContext;
    private readonly format: GPUTextureFormat;

    constructor(ctx: WebGPUContext, format?: GPUTextureFormat) {
        this.ctx = ctx;
        this.format = format ?? ctx.preferredFormat;
    }

    /**
     * 初始化渲染管线
     */
    async initialize(): Promise<void> {
        const { device } = this.ctx;

        // 创建 shader module
        const shaderModule = device.createShaderModule({
            label: 'basic_render',
            code: basicRenderWGSL,
        });

        // group(0): storage buffers
        this.bindGroupLayout0 = device.createBindGroupLayout({
            label: 'storage_layout',
            entries: [
                { // vertex_pool
                    binding: 0,
                    visibility: GPUShaderStage.VERTEX,
                    buffer: { type: 'read-only-storage' },
                },
                { // index_pool
                    binding: 1,
                    visibility: GPUShaderStage.VERTEX,
                    buffer: { type: 'read-only-storage' },
                },
                { // quant_meta
                    binding: 2,
                    visibility: GPUShaderStage.VERTEX,
                    buffer: { type: 'read-only-storage' },
                },
            ],
        });

        // group(1): uniforms
        this.bindGroupLayout1 = device.createBindGroupLayout({
            label: 'uniform_layout',
            entries: [
                {
                    binding: 0,
                    visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
                    buffer: { type: 'uniform' },
                },
            ],
        });

        const pipelineLayout = device.createPipelineLayout({
            label: 'basic_render_layout',
            bindGroupLayouts: [this.bindGroupLayout0, this.bindGroupLayout1],
        });

        // 创建渲染管线
        this.pipeline = device.createRenderPipeline({
            label: 'basic_render_pipeline',
            layout: pipelineLayout,
            vertex: {
                module: shaderModule,
                entryPoint: 'vs_main',
            },
            fragment: {
                module: shaderModule,
                entryPoint: 'fs_main',
                targets: [{
                    format: this.format,
                }],
            },
            primitive: {
                topology: 'triangle-list',
                cullMode: 'back',
                frontFace: 'ccw',
            },
            depthStencil: {
                format: 'depth24plus',
                depthWriteEnabled: true,
                depthCompare: 'less',
            },
        });

        // 创建 uniform buffer
        this.uniformBuffer = device.createBuffer({
            label: 'render_uniforms',
            size: UNIFORM_BUFFER_SIZE,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
    }

    /**
     * 创建 group(0) bind group（storage buffers）
     */
    createStorageBindGroup(
        vertexBuffer: GPUBuffer,
        indexBuffer: GPUBuffer,
        quantMetaBuffer: GPUBuffer,
        vertexSize?: number,
        indexSize?: number,
        quantMetaSize?: number,
    ): GPUBindGroup {
        if (!this.bindGroupLayout0) throw new Error('Pipeline not initialized');

        return this.ctx.device.createBindGroup({
            label: 'storage_bind_group',
            layout: this.bindGroupLayout0,
            entries: [
                { binding: 0, resource: { buffer: vertexBuffer, size: vertexSize } },
                { binding: 1, resource: { buffer: indexBuffer, size: indexSize } },
                { binding: 2, resource: { buffer: quantMetaBuffer, size: quantMetaSize } },
            ],
        });
    }

    /**
     * 创建 group(1) bind group（uniforms）
     */
    createUniformBindGroup(): GPUBindGroup {
        if (!this.bindGroupLayout1 || !this.uniformBuffer) {
            throw new Error('Pipeline not initialized');
        }

        return this.ctx.device.createBindGroup({
            label: 'uniform_bind_group',
            layout: this.bindGroupLayout1,
            entries: [
                { binding: 0, resource: { buffer: this.uniformBuffer } },
            ],
        });
    }

    /**
     * 更新 uniform 数据并上传到 GPU
     */
    updateUniforms(uniforms: RenderUniforms): void {
        if (!this.uniformBuffer) return;

        // 布局: mvp(16f) + model(16f) + color(4f) + lightDir(4f) = 40 floats
        this.uniformData.set(uniforms.mvpMatrix, 0);       // offset 0
        this.uniformData.set(uniforms.modelMatrix, 16);     // offset 64 bytes
        this.uniformData[32] = uniforms.color[0];           // offset 128 bytes
        this.uniformData[33] = uniforms.color[1];
        this.uniformData[34] = uniforms.color[2];
        this.uniformData[35] = uniforms.color[3];
        this.uniformData[36] = uniforms.lightDir[0];        // offset 144 bytes
        this.uniformData[37] = uniforms.lightDir[1];
        this.uniformData[38] = uniforms.lightDir[2];
        this.uniformData[39] = 0; // padding

        this.ctx.device.queue.writeBuffer(this.uniformBuffer, 0, this.uniformData);
    }

    /**
     * 编码渲染命令到 render pass
     */
    encode(
        passEncoder: GPURenderPassEncoder,
        storageBindGroup: GPUBindGroup,
        uniformBindGroup: GPUBindGroup,
        indexCount: number,
    ): void {
        if (!this.pipeline) return;

        passEncoder.setPipeline(this.pipeline);
        passEncoder.setBindGroup(0, storageBindGroup);
        passEncoder.setBindGroup(1, uniformBindGroup);
        passEncoder.draw(indexCount);
    }

    /**
     * 销毁资源
     */
    destroy(): void {
        this.uniformBuffer?.destroy();
        this.uniformBuffer = null;
        this.pipeline = null;
        this.bindGroupLayout0 = null;
        this.bindGroupLayout1 = null;
    }
}
