import type { WebGPUContext } from '../WebGPUContext';
import weightedMCWGSL from '../shaders/weighted_mc.wgsl?raw';
import type {
    MarchingCubesDispatchCounters,
    MarchingCubesDispatchRequest,
    MarchingCubesDispatchResult,
    MarchingCubesDispatchState,
    RerunReason,
} from './types';

export interface MarchingCubesPipelineOptions {
    maxRetries?: number;
    growthFactor?: number;
    ctx?: WebGPUContext;
    dispatchKernel?: (state: MarchingCubesDispatchState) => Promise<MarchingCubesDispatchCounters>;
}

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_GROWTH_FACTOR = 2;

export class MarchingCubesPipeline {
    private readonly maxRetries: number;
    private readonly growthFactor: number;
    private readonly dispatchKernel: (state: MarchingCubesDispatchState) => Promise<MarchingCubesDispatchCounters>;
    private readonly ctx?: WebGPUContext;

    private pipeline: GPUComputePipeline | null = null;
    private bindGroupLayout: GPUBindGroupLayout | null = null;
    private sdfTexture: GPUTexture | null = null;
    private vertexBuffer: GPUBuffer | null = null;
    private indexBuffer: GPUBuffer | null = null;
    private quantMetaBuffer: GPUBuffer | null = null;
    private countersBuffer: GPUBuffer | null = null;
    private countersReadbackBuffer: GPUBuffer | null = null;
    private paramsBuffer: GPUBuffer | null = null;
    private vertexCapacity = 0;
    private indexCapacity = 0;

    constructor(options: MarchingCubesPipelineOptions = {}) {
        this.maxRetries = Math.max(1, options.maxRetries ?? DEFAULT_MAX_RETRIES);
        this.growthFactor = Math.max(2, options.growthFactor ?? DEFAULT_GROWTH_FACTOR);
        this.ctx = options.ctx;
        this.dispatchKernel = options.dispatchKernel
            ?? (this.ctx
                ? this.dispatchWithGPU
                : this.defaultDispatchKernel);
    }

    async dispatchWithRetry(request: MarchingCubesDispatchRequest): Promise<MarchingCubesDispatchResult> {
        let capacity = Math.max(1, request.initialCapacity);
        let origin = request.quantOriginMM;
        let rerunReason: RerunReason | undefined;

        for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
            const counters = await this.dispatchKernel({
                roiId: request.roiId,
                dirtyBrickKeys: request.dirtyBrickKeys,
                capacity,
                quantOriginMM: origin,
            });

            if (counters.overflow > 0) {
                rerunReason = 'overflow';
                capacity *= this.growthFactor;
                continue;
            }

            if (counters.quantOverflow > 0) {
                rerunReason = 'quantOverflow';
                origin = request.quantFallbackOriginMM ?? request.quantOriginMM;
                continue;
            }

            return {
                ...counters,
                attempts: attempt,
                rerunReason,
                finalCapacity: capacity,
            };
        }

        throw new Error('MarchingCubes retries exhausted');
    }

    destroy(): void {
        this.vertexBuffer?.destroy();
        this.indexBuffer?.destroy();
        this.quantMetaBuffer?.destroy();
        this.countersBuffer?.destroy();
        this.countersReadbackBuffer?.destroy();
        this.paramsBuffer?.destroy();
        this.sdfTexture?.destroy();

        this.vertexBuffer = null;
        this.indexBuffer = null;
        this.quantMetaBuffer = null;
        this.countersBuffer = null;
        this.countersReadbackBuffer = null;
        this.paramsBuffer = null;
        this.sdfTexture = null;
        this.pipeline = null;
        this.bindGroupLayout = null;
        this.vertexCapacity = 0;
        this.indexCapacity = 0;
    }

    private readonly defaultDispatchKernel = async (
        state: MarchingCubesDispatchState
    ): Promise<MarchingCubesDispatchCounters> => {
        const estimatedVertexCount = Math.min(state.capacity, state.dirtyBrickKeys.length * 96);
        return {
            overflow: estimatedVertexCount >= state.capacity ? 1 : 0,
            quantOverflow: 0,
            vertexCount: estimatedVertexCount,
            indexCount: Math.floor((estimatedVertexCount / 3) * 3),
        };
    };

    private readonly dispatchWithGPU = async (
        state: MarchingCubesDispatchState
    ): Promise<MarchingCubesDispatchCounters> => {
        if (!this.ctx) {
            return this.defaultDispatchKernel(state);
        }

        this.ensureGPUResources(state.capacity, Math.max(state.capacity, state.capacity * 3));
        if (
            !this.pipeline
            || !this.bindGroupLayout
            || !this.sdfTexture
            || !this.vertexBuffer
            || !this.indexBuffer
            || !this.quantMetaBuffer
            || !this.countersBuffer
            || !this.countersReadbackBuffer
            || !this.paramsBuffer
        ) {
            return this.defaultDispatchKernel(state);
        }

        const zeroCounters = new Uint32Array([0, 0, 0, 0]);
        this.ctx.device.queue.writeBuffer(this.countersBuffer, 0, zeroCounters);
        const quantMeta = new Float32Array([
            state.quantOriginMM[0],
            state.quantOriginMM[1],
            state.quantOriginMM[2],
            0.1,
        ]);
        this.ctx.device.queue.writeBuffer(this.quantMetaBuffer, 0, quantMeta);

        const paramsRaw = new ArrayBuffer(16);
        const paramsView = new DataView(paramsRaw);
        paramsView.setUint32(0, this.vertexCapacity, true);
        paramsView.setUint32(4, this.indexCapacity, true);
        paramsView.setUint32(8, Math.max(state.dirtyBrickKeys.length * 256, 256), true);
        paramsView.setFloat32(12, 0.5, true);
        this.ctx.device.queue.writeBuffer(this.paramsBuffer, 0, paramsRaw);

        const bindGroup = this.ctx.device.createBindGroup({
            label: 'weighted_mc_bind_group',
            layout: this.bindGroupLayout,
            entries: [
                { binding: 0, resource: this.sdfTexture.createView() },
                { binding: 1, resource: { buffer: this.vertexBuffer } },
                { binding: 2, resource: { buffer: this.indexBuffer } },
                { binding: 3, resource: { buffer: this.quantMetaBuffer } },
                { binding: 4, resource: { buffer: this.countersBuffer } },
                { binding: 5, resource: { buffer: this.paramsBuffer } },
            ],
        });

        const encoder = this.ctx.device.createCommandEncoder({ label: 'weighted_mc_encoder' });
        const pass = encoder.beginComputePass({ label: 'weighted_mc_pass' });
        pass.setPipeline(this.pipeline);
        pass.setBindGroup(0, bindGroup);
        pass.dispatchWorkgroups(Math.max(1, state.dirtyBrickKeys.length * 2));
        pass.end();

        encoder.copyBufferToBuffer(this.countersBuffer, 0, this.countersReadbackBuffer, 0, 16);
        this.ctx.device.queue.submit([encoder.finish()]);

        await this.countersReadbackBuffer.mapAsync(GPUMapMode.READ);
        const mapped = this.countersReadbackBuffer.getMappedRange();
        const data = new Uint32Array(mapped.slice(0));
        this.countersReadbackBuffer.unmap();

        return {
            vertexCount: data[0] ?? 0,
            indexCount: data[1] ?? 0,
            overflow: data[2] ?? 0,
            quantOverflow: data[3] ?? 0,
        };
    };

    private ensureGPUResources(vertexCapacity: number, indexCapacity: number): void {
        if (!this.ctx) {
            return;
        }

        if (!this.pipeline || !this.bindGroupLayout) {
            this.bindGroupLayout = this.ctx.device.createBindGroupLayout({
                label: 'weighted_mc_layout',
                entries: [
                    {
                        binding: 0,
                        visibility: GPUShaderStage.COMPUTE,
                        texture: {
                            sampleType: 'unfilterable-float',
                            viewDimension: '3d',
                        },
                    },
                    {
                        binding: 1,
                        visibility: GPUShaderStage.COMPUTE,
                        buffer: { type: 'storage' },
                    },
                    {
                        binding: 2,
                        visibility: GPUShaderStage.COMPUTE,
                        buffer: { type: 'storage' },
                    },
                    {
                        binding: 3,
                        visibility: GPUShaderStage.COMPUTE,
                        buffer: { type: 'read-only-storage' },
                    },
                    {
                        binding: 4,
                        visibility: GPUShaderStage.COMPUTE,
                        buffer: { type: 'storage' },
                    },
                    {
                        binding: 5,
                        visibility: GPUShaderStage.COMPUTE,
                        buffer: { type: 'uniform' },
                    },
                ],
            });

            const shaderModule = this.ctx.device.createShaderModule({
                label: 'weighted_mc_shader',
                code: weightedMCWGSL,
            });
            this.pipeline = this.ctx.device.createComputePipeline({
                label: 'weighted_mc_pipeline',
                layout: this.ctx.device.createPipelineLayout({
                    label: 'weighted_mc_pipeline_layout',
                    bindGroupLayouts: [this.bindGroupLayout],
                }),
                compute: {
                    module: shaderModule,
                    entryPoint: 'main',
                },
            });
        }

        if (!this.sdfTexture) {
            this.sdfTexture = this.ctx.device.createTexture({
                label: 'weighted_mc_dummy_sdf',
                size: [64, 64, 64],
                format: 'r16float',
                usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
                dimension: '3d',
            });
        }

        if (vertexCapacity > this.vertexCapacity) {
            this.vertexBuffer?.destroy();
            this.vertexCapacity = vertexCapacity;
            this.vertexBuffer = this.ctx.device.createBuffer({
                label: 'weighted_mc_vertex_pool',
                size: this.vertexCapacity * 8,
                usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
            });
        }

        if (indexCapacity > this.indexCapacity) {
            this.indexBuffer?.destroy();
            this.indexCapacity = indexCapacity;
            this.indexBuffer = this.ctx.device.createBuffer({
                label: 'weighted_mc_index_pool',
                size: this.indexCapacity * 4,
                usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
            });
        }

        if (!this.quantMetaBuffer) {
            this.quantMetaBuffer = this.ctx.device.createBuffer({
                label: 'weighted_mc_quant_meta',
                size: 16,
                usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
            });
        }

        if (!this.countersBuffer) {
            this.countersBuffer = this.ctx.device.createBuffer({
                label: 'weighted_mc_counters',
                size: 16,
                usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
            });
        }

        if (!this.countersReadbackBuffer) {
            this.countersReadbackBuffer = this.ctx.device.createBuffer({
                label: 'weighted_mc_counters_readback',
                size: 16,
                usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
            });
        }

        if (!this.paramsBuffer) {
            this.paramsBuffer = this.ctx.device.createBuffer({
                label: 'weighted_mc_params',
                size: 16,
                usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            });
        }
    }
}
