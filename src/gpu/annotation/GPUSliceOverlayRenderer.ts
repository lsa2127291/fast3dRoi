export interface GPUSliceOverlayOperation {
    centerPx: [number, number];
    radiusPx: number;
    erase: boolean;
}

export interface GPUSliceOverlayRenderRequest {
    widthPx: number;
    heightPx: number;
    operations: GPUSliceOverlayOperation[];
    startOperationIndex: number;
    incremental: boolean;
    quality?: 'fast' | 'full';
}

const PARAMS_BUFFER_BYTES = 32;
const OP_BYTES = 16;
const DEFAULT_OPERATION_CAPACITY = 128;
const MAX_BATCH_SIZE = 128;

// language=wgsl
const APPLY_MASK_SHADER = `
struct Params {
    viewport: vec2<f32>,
    opCount: u32,
    _pad0: u32,
    fillAlpha: f32,
    edgeAlpha: f32,
    _pad1: vec2<f32>,
};

struct CircleOp {
    data: vec4<f32>, // x, y, radius, erase(0|1)
};

struct VSOut {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

@group(0) @binding(0) var overlaySampler: sampler;
@group(0) @binding(1) var maskTexture: texture_2d<f32>;
@group(0) @binding(2) var<uniform> params: Params;
@group(0) @binding(3) var<storage, read> ops: array<CircleOp>;

@vertex
fn vsMain(@builtin(vertex_index) vertexIndex: u32) -> VSOut {
    var positions = array<vec2<f32>, 4>(
        vec2<f32>(-1.0, -1.0),
        vec2<f32>(1.0, -1.0),
        vec2<f32>(-1.0, 1.0),
        vec2<f32>(1.0, 1.0)
    );
    var uvs = array<vec2<f32>, 4>(
        vec2<f32>(0.0, 1.0),
        vec2<f32>(1.0, 1.0),
        vec2<f32>(0.0, 0.0),
        vec2<f32>(1.0, 0.0)
    );
    var out: VSOut;
    out.position = vec4<f32>(positions[vertexIndex], 0.0, 1.0);
    out.uv = uvs[vertexIndex];
    return out;
}

@fragment
fn fsMain(in: VSOut) -> @location(0) vec4<f32> {
    var maskValue = textureSampleLevel(maskTexture, overlaySampler, in.uv, 0.0).r;
    let pixel = vec2<f32>(
        in.uv.x * params.viewport.x,
        in.uv.y * params.viewport.y
    );

    for (var i: u32 = 0u; i < params.opCount; i = i + 1u) {
        let op = ops[i].data;
        let inside = distance(pixel, op.xy) <= op.z;
        if (inside) {
            if (op.w > 0.5) {
                maskValue = 0.0;
            } else {
                maskValue = 1.0;
            }
        }
    }

    return vec4<f32>(maskValue, maskValue, maskValue, maskValue);
}
`;

// language=wgsl
const COMPOSITE_SHADER = `
struct Params {
    viewport: vec2<f32>,
    opCount: u32,
    _pad0: u32,
    fillAlpha: f32,
    edgeAlpha: f32,
    _pad1: vec2<f32>,
};

struct VSOut {
    @builtin(position) position: vec4<f32>,
};

@group(0) @binding(0) var maskTexture: texture_2d<f32>;
@group(0) @binding(1) var<uniform> params: Params;

@vertex
fn vsMain(@builtin(vertex_index) vertexIndex: u32) -> VSOut {
    var positions = array<vec2<f32>, 4>(
        vec2<f32>(-1.0, -1.0),
        vec2<f32>(1.0, -1.0),
        vec2<f32>(-1.0, 1.0),
        vec2<f32>(1.0, 1.0)
    );
    var out: VSOut;
    out.position = vec4<f32>(positions[vertexIndex], 0.0, 1.0);
    return out;
}

fn isOn(coord: vec2<i32>, width: i32, height: i32) -> bool {
    // 与 CPU 版本一致：越界视为 on，避免画布边缘产生假轮廓
    if (coord.x < 0 || coord.y < 0 || coord.x >= width || coord.y >= height) {
        return true;
    }
    return textureLoad(maskTexture, coord, 0).a > 0.5;
}

@fragment
fn fsMain(@builtin(position) fragPos: vec4<f32>) -> @location(0) vec4<f32> {
    let dims = textureDimensions(maskTexture);
    let width = max(1, i32(dims.x));
    let height = max(1, i32(dims.y));
    let pixel = vec2<i32>(
        clamp(i32(floor(fragPos.x)), 0, width - 1),
        clamp(i32(floor(fragPos.y)), 0, height - 1)
    );

    if (!isOn(pixel, width, height)) {
        return vec4<f32>(0.0);
    }

    // 与 CPU 版本一致：8 邻域轮廓判断
    let edge =
        !isOn(pixel + vec2<i32>(-1, 0), width, height)
        || !isOn(pixel + vec2<i32>(1, 0), width, height)
        || !isOn(pixel + vec2<i32>(0, -1), width, height)
        || !isOn(pixel + vec2<i32>(0, 1), width, height)
        || !isOn(pixel + vec2<i32>(-1, -1), width, height)
        || !isOn(pixel + vec2<i32>(1, -1), width, height)
        || !isOn(pixel + vec2<i32>(-1, 1), width, height)
        || !isOn(pixel + vec2<i32>(1, 1), width, height);

    let alpha = select(params.fillAlpha, params.edgeAlpha, edge);
    // Canvas alphaMode='premultiplied'，输出预乘 alpha 颜色以匹配 CPU 合成视觉
    let color = vec3<f32>(0.0, 224.0 / 255.0, 1.0) * alpha;
    return vec4<f32>(color, alpha);
}
`;

// language=wgsl
const MORPHOLOGY_SHADER = `
struct Params {
    viewport: vec2<f32>,
    opCount: u32,
    mode: u32,
    fillAlpha: f32,
    edgeAlpha: f32,
    _pad1: vec2<f32>,
};

struct VSOut {
    @builtin(position) position: vec4<f32>,
};

@group(0) @binding(0) var maskTexture: texture_2d<f32>;
@group(0) @binding(1) var<uniform> params: Params;

@vertex
fn vsMain(@builtin(vertex_index) vertexIndex: u32) -> VSOut {
    var positions = array<vec2<f32>, 4>(
        vec2<f32>(-1.0, -1.0),
        vec2<f32>(1.0, -1.0),
        vec2<f32>(-1.0, 1.0),
        vec2<f32>(1.0, 1.0)
    );
    var out: VSOut;
    out.position = vec4<f32>(positions[vertexIndex], 0.0, 1.0);
    return out;
}

@fragment
fn fsMain(@builtin(position) fragPos: vec4<f32>) -> @location(0) vec4<f32> {
    let dims = textureDimensions(maskTexture);
    let width = max(1, i32(dims.x));
    let height = max(1, i32(dims.y));
    let pixel = vec2<i32>(
        clamp(i32(floor(fragPos.x)), 0, width - 1),
        clamp(i32(floor(fragPos.y)), 0, height - 1)
    );

    let erode = params.mode > 0u;
    var value = select(0.0, 1.0, erode);

    for (var oy: i32 = -1; oy <= 1; oy = oy + 1) {
        for (var ox: i32 = -1; ox <= 1; ox = ox + 1) {
            let sampleCoord = pixel + vec2<i32>(ox, oy);
            var sampleValue = select(0.0, 1.0, erode);
            if (
                sampleCoord.x >= 0
                && sampleCoord.y >= 0
                && sampleCoord.x < width
                && sampleCoord.y < height
            ) {
                sampleValue = select(0.0, 1.0, textureLoad(maskTexture, sampleCoord, 0).a >= 0.5);
            }
            if (erode) {
                value = min(value, sampleValue);
            } else {
                value = max(value, sampleValue);
            }
        }
    }

    return vec4<f32>(value, value, value, value);
}
`;

function nextPowerOfTwo(value: number): number {
    let n = 1;
    while (n < value) {
        n <<= 1;
    }
    return n;
}

export class GPUSliceOverlayRenderer {
    private readonly context: GPUCanvasContext | null;
    private device: GPUDevice | null = null;
    private format: GPUTextureFormat | null = null;
    private sampler: GPUSampler | null = null;
    private applyPipeline: GPURenderPipeline | null = null;
    private morphologyPipeline: GPURenderPipeline | null = null;
    private compositePipeline: GPURenderPipeline | null = null;
    private paramsBuffer: GPUBuffer | null = null;
    private opBuffer: GPUBuffer | null = null;
    private opCapacity = 0;
    private maskTextures: [GPUTexture | null, GPUTexture | null] = [null, null];
    private maskViews: [GPUTextureView | null, GPUTextureView | null] = [null, null];
    private frontMaskIndex = 0;
    private widthPx = 0;
    private heightPx = 0;
    private initPromise: Promise<void> | null = null;
    private initFailed = false;

    constructor(private readonly canvas: HTMLCanvasElement) {
        this.context = canvas.getContext('webgpu');
    }

    requestInitialize(): void {
        if (!this.context || this.device || this.initPromise || this.initFailed || !navigator.gpu) {
            return;
        }
        this.initPromise = this.initializeInternal().catch(() => {
            this.initFailed = true;
        }).finally(() => {
            this.initPromise = null;
        });
    }

    isReady(): boolean {
        return this.device !== null && this.context !== null;
    }

    clear(): void {
        if (!this.device || !this.context) {
            return;
        }
        this.clearCanvasOutput();
        this.clearMaskTextures();
    }

    destroy(): void {
        this.opBuffer?.destroy();
        this.paramsBuffer?.destroy();
        this.maskTextures[0]?.destroy();
        this.maskTextures[1]?.destroy();
        this.opBuffer = null;
        this.paramsBuffer = null;
        this.maskTextures = [null, null];
        this.maskViews = [null, null];
        this.device = null;
        this.sampler = null;
        this.applyPipeline = null;
        this.morphologyPipeline = null;
        this.compositePipeline = null;
        this.format = null;
    }

    render(request: GPUSliceOverlayRenderRequest): boolean {
        if (this.initFailed) {
            return false;
        }
        if (
            !this.device
            || !this.context
            || !this.applyPipeline
            || !this.morphologyPipeline
            || !this.compositePipeline
            || !this.paramsBuffer
            || !this.sampler
        ) {
            this.requestInitialize();
            return false;
        }

        this.ensureCanvasSize(request.widthPx, request.heightPx);
        if (!this.maskViews[0] || !this.maskViews[1]) {
            return false;
        }

        if (request.operations.length === 0) {
            this.clear();
            return true;
        }

        const quality = request.quality ?? 'fast';
        let startOperationIndex = 0;
        if (request.incremental) {
            startOperationIndex = Math.max(0, Math.min(request.operations.length, request.startOperationIndex));
        } else {
            this.clearMaskTextures();
        }

        if (!request.incremental && request.operations.length > 0) {
            startOperationIndex = 0;
        }
        if (startOperationIndex === 0 && request.incremental && request.startOperationIndex <= 0) {
            this.clearMaskTextures();
        }

        if (startOperationIndex < request.operations.length) {
            for (let i = startOperationIndex; i < request.operations.length; i += MAX_BATCH_SIZE) {
                const batch = request.operations.slice(i, Math.min(request.operations.length, i + MAX_BATCH_SIZE));
                this.applyMaskBatch(batch);
            }
        }
        if (quality === 'full') {
            this.applyMorphologyClose();
        }
        this.compositeMask();
        return true;
    }

    private async initializeInternal(): Promise<void> {
        if (!this.context || !navigator.gpu) {
            throw new Error('WebGPU overlay context unavailable');
        }

        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) {
            throw new Error('WebGPU adapter unavailable');
        }
        const device = await adapter.requestDevice();
        const format = navigator.gpu.getPreferredCanvasFormat();

        this.device = device;
        this.format = format;
        this.configureContext();
        this.sampler = device.createSampler({
            magFilter: 'nearest',
            minFilter: 'nearest',
            mipmapFilter: 'nearest',
            addressModeU: 'clamp-to-edge',
            addressModeV: 'clamp-to-edge',
        });
        this.paramsBuffer = device.createBuffer({
            size: PARAMS_BUFFER_BYTES,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        this.ensureOperationBufferCapacity(DEFAULT_OPERATION_CAPACITY);

        const applyModule = device.createShaderModule({ code: APPLY_MASK_SHADER });
        this.applyPipeline = device.createRenderPipeline({
            layout: 'auto',
            vertex: {
                module: applyModule,
                entryPoint: 'vsMain',
            },
            fragment: {
                module: applyModule,
                entryPoint: 'fsMain',
                targets: [{ format: 'rgba8unorm' }],
            },
            primitive: {
                topology: 'triangle-strip',
            },
        });

        const morphologyModule = device.createShaderModule({ code: MORPHOLOGY_SHADER });
        this.morphologyPipeline = device.createRenderPipeline({
            layout: 'auto',
            vertex: {
                module: morphologyModule,
                entryPoint: 'vsMain',
            },
            fragment: {
                module: morphologyModule,
                entryPoint: 'fsMain',
                targets: [{ format: 'rgba8unorm' }],
            },
            primitive: {
                topology: 'triangle-strip',
            },
        });

        const compositeModule = device.createShaderModule({ code: COMPOSITE_SHADER });
        this.compositePipeline = device.createRenderPipeline({
            layout: 'auto',
            vertex: {
                module: compositeModule,
                entryPoint: 'vsMain',
            },
            fragment: {
                module: compositeModule,
                entryPoint: 'fsMain',
                targets: [{ format }],
            },
            primitive: {
                topology: 'triangle-strip',
            },
        });

        this.ensureCanvasSize(
            Math.max(1, this.canvas.width),
            Math.max(1, this.canvas.height)
        );
        this.clearMaskTextures();
    }

    private configureContext(): void {
        if (!this.context || !this.device || !this.format) {
            return;
        }
        this.context.configure({
            device: this.device,
            format: this.format,
            alphaMode: 'premultiplied',
        });
    }

    private ensureCanvasSize(widthPx: number, heightPx: number): void {
        if (!this.device) {
            return;
        }
        const nextWidth = Math.max(1, Math.floor(widthPx));
        const nextHeight = Math.max(1, Math.floor(heightPx));
        const changed = this.widthPx !== nextWidth || this.heightPx !== nextHeight;

        if (this.canvas.width !== nextWidth) {
            this.canvas.width = nextWidth;
        }
        if (this.canvas.height !== nextHeight) {
            this.canvas.height = nextHeight;
        }

        if (!changed && this.maskTextures[0] && this.maskTextures[1]) {
            return;
        }

        this.widthPx = nextWidth;
        this.heightPx = nextHeight;
        this.configureContext();
        this.maskTextures[0]?.destroy();
        this.maskTextures[1]?.destroy();

        const textureUsage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
        this.maskTextures[0] = this.device.createTexture({
            size: { width: nextWidth, height: nextHeight, depthOrArrayLayers: 1 },
            format: 'rgba8unorm',
            usage: textureUsage,
        });
        this.maskTextures[1] = this.device.createTexture({
            size: { width: nextWidth, height: nextHeight, depthOrArrayLayers: 1 },
            format: 'rgba8unorm',
            usage: textureUsage,
        });
        this.maskViews[0] = this.maskTextures[0].createView();
        this.maskViews[1] = this.maskTextures[1].createView();
        this.frontMaskIndex = 0;
        this.clearMaskTextures();
    }

    private ensureOperationBufferCapacity(operationCount: number): void {
        if (!this.device) {
            return;
        }
        if (operationCount <= this.opCapacity && this.opBuffer) {
            return;
        }
        const nextCapacity = nextPowerOfTwo(Math.max(DEFAULT_OPERATION_CAPACITY, operationCount));
        this.opBuffer?.destroy();
        this.opBuffer = this.device.createBuffer({
            size: OP_BYTES * nextCapacity,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        this.opCapacity = nextCapacity;
    }

    private applyMaskBatch(batch: GPUSliceOverlayOperation[]): void {
        if (!this.device || !this.applyPipeline || !this.paramsBuffer || !this.opBuffer || !this.sampler) {
            return;
        }
        if (!this.maskViews[0] || !this.maskViews[1]) {
            return;
        }
        this.ensureOperationBufferCapacity(batch.length);
        if (!this.opBuffer) {
            return;
        }

        const opData = new Float32Array(batch.length * 4);
        for (let i = 0; i < batch.length; i++) {
            const base = i * 4;
            const op = batch[i];
            opData[base] = op.centerPx[0];
            opData[base + 1] = op.centerPx[1];
            opData[base + 2] = Math.max(0, op.radiusPx);
            opData[base + 3] = op.erase ? 1 : 0;
        }
        this.device.queue.writeBuffer(this.opBuffer, 0, opData.buffer, opData.byteOffset, opData.byteLength);

        this.writeParams(batch.length, 0);

        const frontView = this.maskViews[this.frontMaskIndex];
        const backIndex = this.frontMaskIndex === 0 ? 1 : 0;
        const backView = this.maskViews[backIndex];
        if (!frontView || !backView) {
            return;
        }

        const bindGroup = this.device.createBindGroup({
            layout: this.applyPipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: this.sampler },
                { binding: 1, resource: frontView },
                { binding: 2, resource: { buffer: this.paramsBuffer } },
                { binding: 3, resource: { buffer: this.opBuffer } },
            ],
        });

        const encoder = this.device.createCommandEncoder();
        const pass = encoder.beginRenderPass({
            colorAttachments: [
                {
                    view: backView,
                    clearValue: { r: 0, g: 0, b: 0, a: 0 },
                    loadOp: 'clear',
                    storeOp: 'store',
                },
            ],
        });
        pass.setPipeline(this.applyPipeline);
        pass.setBindGroup(0, bindGroup);
        pass.draw(4, 1, 0, 0);
        pass.end();
        this.device.queue.submit([encoder.finish()]);
        this.frontMaskIndex = backIndex;
    }

    private compositeMask(): void {
        if (!this.device || !this.context || !this.compositePipeline || !this.paramsBuffer) {
            return;
        }
        const frontView = this.maskViews[this.frontMaskIndex];
        if (!frontView) {
            return;
        }

        this.writeParams(0, 0);

        const bindGroup = this.device.createBindGroup({
            layout: this.compositePipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: frontView },
                { binding: 1, resource: { buffer: this.paramsBuffer } },
            ],
        });

        const targetView = this.context.getCurrentTexture().createView();
        const encoder = this.device.createCommandEncoder();
        const pass = encoder.beginRenderPass({
            colorAttachments: [
                {
                    view: targetView,
                    clearValue: { r: 0, g: 0, b: 0, a: 0 },
                    loadOp: 'clear',
                    storeOp: 'store',
                },
            ],
        });
        pass.setPipeline(this.compositePipeline);
        pass.setBindGroup(0, bindGroup);
        pass.draw(4, 1, 0, 0);
        pass.end();
        this.device.queue.submit([encoder.finish()]);
    }

    private applyMorphologyClose(): void {
        this.applyMorphologyPass(0); // dilate
        this.applyMorphologyPass(1); // erode
    }

    private applyMorphologyPass(mode: 0 | 1): void {
        if (!this.device || !this.morphologyPipeline || !this.paramsBuffer) {
            return;
        }
        if (!this.maskViews[0] || !this.maskViews[1]) {
            return;
        }

        this.writeParams(0, mode);

        const frontView = this.maskViews[this.frontMaskIndex];
        const backIndex = this.frontMaskIndex === 0 ? 1 : 0;
        const backView = this.maskViews[backIndex];
        if (!frontView || !backView) {
            return;
        }

        const bindGroup = this.device.createBindGroup({
            layout: this.morphologyPipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: frontView },
                { binding: 1, resource: { buffer: this.paramsBuffer } },
            ],
        });

        const encoder = this.device.createCommandEncoder();
        const pass = encoder.beginRenderPass({
            colorAttachments: [
                {
                    view: backView,
                    clearValue: { r: 0, g: 0, b: 0, a: 0 },
                    loadOp: 'clear',
                    storeOp: 'store',
                },
            ],
        });
        pass.setPipeline(this.morphologyPipeline);
        pass.setBindGroup(0, bindGroup);
        pass.draw(4, 1, 0, 0);
        pass.end();
        this.device.queue.submit([encoder.finish()]);
        this.frontMaskIndex = backIndex;
    }

    private writeParams(opCount: number, mode: number): void {
        if (!this.device || !this.paramsBuffer) {
            return;
        }
        const buffer = new ArrayBuffer(PARAMS_BUFFER_BYTES);
        const f32 = new Float32Array(buffer);
        const u32 = new DataView(buffer);
        f32[0] = this.widthPx;
        f32[1] = this.heightPx;
        u32.setUint32(8, Math.max(0, Math.floor(opCount)), true);
        u32.setUint32(12, Math.max(0, Math.floor(mode)), true);
        f32[4] = 0.22;
        f32[5] = 0.96;
        f32[6] = 0;
        f32[7] = 0;
        this.device.queue.writeBuffer(this.paramsBuffer, 0, buffer);
    }

    private clearMaskTextures(): void {
        if (!this.device || !this.maskViews[0] || !this.maskViews[1]) {
            return;
        }
        const encoder = this.device.createCommandEncoder();
        for (const view of this.maskViews) {
            if (!view) {
                continue;
            }
            const pass = encoder.beginRenderPass({
                colorAttachments: [
                    {
                        view,
                        clearValue: { r: 0, g: 0, b: 0, a: 0 },
                        loadOp: 'clear',
                        storeOp: 'store',
                    },
                ],
            });
            pass.end();
        }
        this.device.queue.submit([encoder.finish()]);
        this.frontMaskIndex = 0;
    }

    private clearCanvasOutput(): void {
        if (!this.device || !this.context) {
            return;
        }
        const encoder = this.device.createCommandEncoder();
        const pass = encoder.beginRenderPass({
            colorAttachments: [
                {
                    view: this.context.getCurrentTexture().createView(),
                    clearValue: { r: 0, g: 0, b: 0, a: 0 },
                    loadOp: 'clear',
                    storeOp: 'store',
                },
            ],
        });
        pass.end();
        this.device.queue.submit([encoder.finish()]);
    }
}
