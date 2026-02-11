import type { WebGPUContext } from '../WebGPUContext';
import { BRICK_SIZE, QUANT_STEP_MM } from '../constants';
import sdfGenerateWGSL from '../shaders/sdf_generate.wgsl?raw';
import type { BrushStroke, DirtyBrickKey, SDFPipelineLike } from './types';
import { SDFBrickPool } from './SDFBrickPool';

const WORKGROUP_SIZE = 8;
const BRICK_ORIGIN_STRIDE_BYTES = 16;
const PARAM_BUFFER_SIZE = 32;

export class SDFGenerationPipeline implements SDFPipelineLike {
    private pipeline: GPUComputePipeline | null = null;
    private bindGroupLayout: GPUBindGroupLayout | null = null;
    private paramsBuffer: GPUBuffer | null = null;
    private brickOriginBuffer: GPUBuffer | null = null;
    private brickOriginCapacity = 0;

    constructor(
        private readonly ctx: WebGPUContext,
        private readonly brickPool: SDFBrickPool
    ) {
    }

    async previewStroke(stroke: BrushStroke): Promise<void> {
        const key = this.worldToBrickKey(stroke.centerMM);
        await this.applyStroke(stroke, [key]);
    }

    async applyStroke(stroke: BrushStroke, dirtyBrickKeys: DirtyBrickKey[]): Promise<void> {
        if (dirtyBrickKeys.length === 0) {
            return;
        }

        await this.initialize();
        if (!this.pipeline || !this.bindGroupLayout || !this.paramsBuffer) {
            return;
        }

        const allocations = dirtyBrickKeys.map((brickKey) => this.brickPool.allocateBrick(brickKey));
        for (const alloc of allocations) {
            this.brickPool.markDirty(alloc.brickKey);
        }

        this.ensureBrickOriginBuffer(allocations.length);

        const originPayload = new Uint32Array(allocations.length * 4);
        for (let i = 0; i < allocations.length; i++) {
            const offset = i * 4;
            const origin = allocations[i].texelOrigin;
            originPayload[offset] = origin[0];
            originPayload[offset + 1] = origin[1];
            originPayload[offset + 2] = origin[2];
            originPayload[offset + 3] = 0;
        }

        const params = new Float32Array(8);
        params[0] = stroke.centerMM[0] / QUANT_STEP_MM;
        params[1] = stroke.centerMM[1] / QUANT_STEP_MM;
        params[2] = stroke.centerMM[2] / QUANT_STEP_MM;
        params[3] = stroke.radiusMM / QUANT_STEP_MM;
        params[4] = stroke.erase ? 1 : 0;
        params[5] = allocations.length;
        params[6] = BRICK_SIZE;
        params[7] = BRICK_SIZE / WORKGROUP_SIZE;

        this.ctx.device.queue.writeBuffer(this.paramsBuffer, 0, params);
        if (this.brickOriginBuffer) {
            this.ctx.device.queue.writeBuffer(this.brickOriginBuffer, 0, originPayload);
        }

        const bindGroup = this.ctx.device.createBindGroup({
            label: 'sdf_generate_bind_group',
            layout: this.bindGroupLayout,
            entries: [
                { binding: 0, resource: this.brickPool.getWriteTextureView() },
                { binding: 1, resource: { buffer: this.brickOriginBuffer! } },
                { binding: 2, resource: { buffer: this.paramsBuffer } },
            ],
        });

        const groupsPerBrickAxis = BRICK_SIZE / WORKGROUP_SIZE;
        const encoder = this.ctx.device.createCommandEncoder({ label: 'sdf_generate_encoder' });
        const pass = encoder.beginComputePass({ label: 'sdf_generate_pass' });
        pass.setPipeline(this.pipeline);
        pass.setBindGroup(0, bindGroup);
        pass.dispatchWorkgroups(
            groupsPerBrickAxis,
            groupsPerBrickAxis,
            groupsPerBrickAxis * allocations.length
        );
        pass.end();
        this.ctx.device.queue.submit([encoder.finish()]);

        for (const alloc of allocations) {
            this.brickPool.releaseBrick(alloc.brickKey);
        }
        this.brickPool.swapPingPong();
    }

    destroy(): void {
        this.paramsBuffer?.destroy();
        this.brickOriginBuffer?.destroy();
        this.paramsBuffer = null;
        this.brickOriginBuffer = null;
        this.pipeline = null;
        this.bindGroupLayout = null;
        this.brickOriginCapacity = 0;
    }

    private async initialize(): Promise<void> {
        if (this.pipeline) {
            return;
        }

        this.bindGroupLayout = this.ctx.device.createBindGroupLayout({
            label: 'sdf_generate_layout',
            entries: [
                {
                    binding: 0,
                    visibility: GPUShaderStage.COMPUTE,
                    storageTexture: {
                        access: 'write-only',
                        format: 'r16float',
                        viewDimension: '3d',
                    },
                },
                {
                    binding: 1,
                    visibility: GPUShaderStage.COMPUTE,
                    buffer: {
                        type: 'read-only-storage',
                    },
                },
                {
                    binding: 2,
                    visibility: GPUShaderStage.COMPUTE,
                    buffer: {
                        type: 'uniform',
                    },
                },
            ],
        });

        const module = this.ctx.device.createShaderModule({
            label: 'sdf_generate_shader',
            code: sdfGenerateWGSL,
        });

        const pipelineLayout = this.ctx.device.createPipelineLayout({
            label: 'sdf_generate_pipeline_layout',
            bindGroupLayouts: [this.bindGroupLayout],
        });

        this.pipeline = this.ctx.device.createComputePipeline({
            label: 'sdf_generate_pipeline',
            layout: pipelineLayout,
            compute: {
                module,
                entryPoint: 'main',
            },
        });

        this.paramsBuffer = this.ctx.device.createBuffer({
            label: 'sdf_generate_params',
            size: PARAM_BUFFER_SIZE,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
    }

    private ensureBrickOriginBuffer(brickCount: number): void {
        if (brickCount <= this.brickOriginCapacity && this.brickOriginBuffer) {
            return;
        }

        this.brickOriginBuffer?.destroy();
        this.brickOriginCapacity = Math.max(brickCount, this.brickOriginCapacity * 2, 1);
        this.brickOriginBuffer = this.ctx.device.createBuffer({
            label: 'sdf_generate_brick_origins',
            size: this.brickOriginCapacity * BRICK_ORIGIN_STRIDE_BYTES,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
    }

    private worldToBrickKey(centerMM: [number, number, number]): string {
        const brickWorldSize = BRICK_SIZE * QUANT_STEP_MM;
        const bx = Math.floor(centerMM[0] / brickWorldSize);
        const by = Math.floor(centerMM[1] / brickWorldSize);
        const bz = Math.floor(centerMM[2] / brickWorldSize);
        return `${bx}_${by}_${bz}`;
    }
}
