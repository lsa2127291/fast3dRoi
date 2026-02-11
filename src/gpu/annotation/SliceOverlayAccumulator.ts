import type { Vec3MM } from './types';

export interface OverlayStrokeOperation {
    sliceIndex: number;
    centerMM: Vec3MM;
    radiusMM: number;
    erase: boolean;
}

export interface SliceOverlayAccumulatorOptions {
    samplingStepFactor?: number;
    maxInterpolationSamples?: number;
}

const DEFAULT_SAMPLING_STEP_FACTOR = 0.5;
const DEFAULT_MAX_INTERPOLATION_SAMPLES = 32;

function normalizeSliceIndex(sliceIndex: number): number {
    return Math.max(0, Math.floor(sliceIndex));
}

function cloneOperation(op: OverlayStrokeOperation): OverlayStrokeOperation {
    return {
        sliceIndex: normalizeSliceIndex(op.sliceIndex),
        centerMM: [...op.centerMM] as Vec3MM,
        radiusMM: op.radiusMM,
        erase: op.erase,
    };
}

function distanceMM(a: Vec3MM, b: Vec3MM): number {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const dz = b[2] - a[2];
    return Math.hypot(dx, dy, dz);
}

export class SliceOverlayAccumulator {
    private readonly operationsBySlice = new Map<number, OverlayStrokeOperation[]>();
    private readonly samplingStepFactor: number;
    private readonly maxInterpolationSamples: number;

    constructor(options: SliceOverlayAccumulatorOptions = {}) {
        this.samplingStepFactor = Math.max(0.1, options.samplingStepFactor ?? DEFAULT_SAMPLING_STEP_FACTOR);
        this.maxInterpolationSamples = Math.max(
            0,
            Math.floor(options.maxInterpolationSamples ?? DEFAULT_MAX_INTERPOLATION_SAMPLES)
        );
    }

    append(operation: OverlayStrokeOperation): void {
        const normalized = cloneOperation(operation);
        const key = normalized.sliceIndex;
        const bucket = this.operationsBySlice.get(key);
        if (bucket) {
            const previous = bucket[bucket.length - 1];
            this.appendInterpolated(bucket, previous, normalized);
            return;
        }
        this.operationsBySlice.set(key, [normalized]);
    }

    getSliceOps(sliceIndex: number): OverlayStrokeOperation[] {
        const key = normalizeSliceIndex(sliceIndex);
        const bucket = this.operationsBySlice.get(key);
        if (!bucket) {
            return [];
        }
        return bucket.map(cloneOperation);
    }

    clear(): void {
        this.operationsBySlice.clear();
    }

    private appendInterpolated(
        bucket: OverlayStrokeOperation[],
        previous: OverlayStrokeOperation | undefined,
        next: OverlayStrokeOperation
    ): void {
        if (!previous || previous.erase !== next.erase) {
            bucket.push(next);
            return;
        }

        const minRadiusMM = Math.max(0.1, Math.min(previous.radiusMM, next.radiusMM));
        const stepMM = Math.max(0.1, minRadiusMM * this.samplingStepFactor);
        const travelMM = distanceMM(previous.centerMM, next.centerMM);
        if (travelMM <= stepMM || this.maxInterpolationSamples === 0) {
            bucket.push(next);
            return;
        }

        const totalSegments = Math.ceil(travelMM / stepMM);
        const interpolationCount = Math.max(
            0,
            Math.min(this.maxInterpolationSamples, totalSegments - 1)
        );
        for (let i = 1; i <= interpolationCount; i++) {
            const t = i / (interpolationCount + 1);
            bucket.push({
                sliceIndex: next.sliceIndex,
                centerMM: [
                    previous.centerMM[0] + (next.centerMM[0] - previous.centerMM[0]) * t,
                    previous.centerMM[1] + (next.centerMM[1] - previous.centerMM[1]) * t,
                    previous.centerMM[2] + (next.centerMM[2] - previous.centerMM[2]) * t,
                ],
                radiusMM: previous.radiusMM + (next.radiusMM - previous.radiusMM) * t,
                erase: next.erase,
            });
        }

        bucket.push(next);
    }
}
