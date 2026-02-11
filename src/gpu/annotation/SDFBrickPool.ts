import type { WebGPUContext } from '../WebGPUContext';
import { BRICK_SIZE } from '../constants';

export interface SDFBrickPoolOptions {
    brickSize?: number;
    atlasBricksPerAxis?: number;
}

export interface SDFBrickAllocation {
    brickKey: string;
    slotIndex: number;
    texelOrigin: [number, number, number];
}

export interface SDFBrickPoolStats {
    brickSize: number;
    atlasBricksPerAxis: number;
    capacity: number;
    allocated: number;
    dirtyCount: number;
    pingPongReadIndex: 0 | 1;
}

const DEFAULT_ATLAS_BRICKS_PER_AXIS = 4;

export class SDFBrickPool {
    private readonly brickSize: number;
    private readonly atlasBricksPerAxis: number;
    private readonly capacity: number;

    private readonly slotByBrickKey = new Map<string, number>();
    private readonly dirtyBrickKeys = new Set<string>();
    private readonly freeSlots: number[] = [];
    private readonly textures: [GPUTexture, GPUTexture];
    private pingPongReadIndex: 0 | 1 = 0;

    constructor(private readonly ctx: WebGPUContext, options: SDFBrickPoolOptions = {}) {
        this.brickSize = options.brickSize ?? BRICK_SIZE;
        this.atlasBricksPerAxis = options.atlasBricksPerAxis ?? DEFAULT_ATLAS_BRICKS_PER_AXIS;
        this.capacity = this.atlasBricksPerAxis * this.atlasBricksPerAxis * this.atlasBricksPerAxis;

        for (let i = this.capacity - 1; i >= 0; i--) {
            this.freeSlots.push(i);
        }

        const textureSize = this.brickSize * this.atlasBricksPerAxis;
        const descriptor: GPUTextureDescriptor = {
            label: 'sdf_bricks_r16float',
            size: [textureSize, textureSize, textureSize],
            format: 'r16float',
            usage: GPUTextureUsage.STORAGE_BINDING,
            dimension: '3d',
        };

        this.textures = [
            this.ctx.device.createTexture(descriptor),
            this.ctx.device.createTexture(descriptor),
        ];
    }

    allocateBrick(brickKey: string): SDFBrickAllocation {
        let slotIndex = this.slotByBrickKey.get(brickKey);
        if (slotIndex === undefined) {
            const free = this.freeSlots.pop();
            if (free === undefined) {
                throw new Error(`SDFBrickPool exhausted while allocating ${brickKey}`);
            }
            slotIndex = free;
            this.slotByBrickKey.set(brickKey, slotIndex);
        }

        return {
            brickKey,
            slotIndex,
            texelOrigin: this.slotToTexelOrigin(slotIndex),
        };
    }

    releaseBrick(brickKey: string): void {
        const slot = this.slotByBrickKey.get(brickKey);
        if (slot === undefined) {
            return;
        }
        this.slotByBrickKey.delete(brickKey);
        this.dirtyBrickKeys.delete(brickKey);
        this.freeSlots.push(slot);
    }

    markDirty(brickKey: string): void {
        if (this.slotByBrickKey.has(brickKey)) {
            this.dirtyBrickKeys.add(brickKey);
        }
    }

    clearDirty(brickKey: string): void {
        this.dirtyBrickKeys.delete(brickKey);
    }

    swapPingPong(): void {
        this.pingPongReadIndex = this.pingPongReadIndex === 0 ? 1 : 0;
    }

    getReadTextureView(): GPUTextureView {
        return this.textures[this.pingPongReadIndex].createView();
    }

    getWriteTextureView(): GPUTextureView {
        const writeIndex: 0 | 1 = this.pingPongReadIndex === 0 ? 1 : 0;
        return this.textures[writeIndex].createView();
    }

    getStats(): SDFBrickPoolStats {
        return {
            brickSize: this.brickSize,
            atlasBricksPerAxis: this.atlasBricksPerAxis,
            capacity: this.capacity,
            allocated: this.slotByBrickKey.size,
            dirtyCount: this.dirtyBrickKeys.size,
            pingPongReadIndex: this.pingPongReadIndex,
        };
    }

    destroy(): void {
        this.textures[0].destroy();
        this.textures[1].destroy();
        this.slotByBrickKey.clear();
        this.dirtyBrickKeys.clear();
        this.freeSlots.length = 0;
    }

    private slotToTexelOrigin(slotIndex: number): [number, number, number] {
        const x = slotIndex % this.atlasBricksPerAxis;
        const y = Math.floor(slotIndex / this.atlasBricksPerAxis) % this.atlasBricksPerAxis;
        const z = Math.floor(slotIndex / (this.atlasBricksPerAxis * this.atlasBricksPerAxis));
        return [
            x * this.brickSize,
            y * this.brickSize,
            z * this.brickSize,
        ];
    }
}
