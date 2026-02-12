import type { MPRViewType, Vec3MM } from './types';

export interface StrokeProjectionSample {
    centerMM: Vec3MM;
    radiusMM: number;
    erase: boolean;
    strokeStart?: boolean;
}

export interface StrokePlaneIntersectionProjectRequest {
    source: StrokeProjectionSample[];
    targetViewType: MPRViewType;
    targetSliceCount: number;
    targetSliceIndex: number;
    targetSliceSpanMM: number;
}

export interface StrokePlaneIntersectionProjectedSample extends StrokeProjectionSample {
    sliceIndex: number;
    strokeStart: boolean;
}

const CENTER_ON_PLANE_EPSILON_MM = 0.01;
const DEDUPE_CENTER_EPSILON_MM = 0.05;
const MIN_PROJECTED_RADIUS_MM = 0.01;

function resolveAxis(viewType: MPRViewType): 0 | 1 | 2 {
    switch (viewType) {
        case 'axial':
            return 2;
        case 'sagittal':
            return 0;
        case 'coronal':
            return 1;
    }
}

function resolvePlaneWorldMM(sliceCount: number, sliceIndex: number, sliceSpanMM: number): number {
    if (sliceCount <= 1) {
        return 0;
    }
    const clampedSliceIndex = Math.max(0, Math.min(sliceCount - 1, Math.floor(sliceIndex)));
    const normalized = clampedSliceIndex / (sliceCount - 1);
    const safeSpan = targetSpanSafe(sliceSpanMM);
    return normalized * safeSpan - safeSpan * 0.5;
}

function targetSpanSafe(sliceSpanMM: number): number {
    return Math.max(1e-6, sliceSpanMM);
}

function centerDistanceSquaredMM(a: Vec3MM, b: Vec3MM): number {
    const dx = a[0] - b[0];
    const dy = a[1] - b[1];
    const dz = a[2] - b[2];
    return dx * dx + dy * dy + dz * dz;
}

function appendProjectedSample(
    out: StrokePlaneIntersectionProjectedSample[],
    sample: StrokeProjectionSample,
    sliceIndex: number,
    strokeStart: boolean
): void {
    const last = out[out.length - 1];
    if (last && last.erase === sample.erase) {
        const dist2 = centerDistanceSquaredMM(last.centerMM, sample.centerMM);
        if (dist2 <= DEDUPE_CENTER_EPSILON_MM * DEDUPE_CENTER_EPSILON_MM) {
            if (sample.radiusMM > last.radiusMM) {
                last.radiusMM = sample.radiusMM;
            }
            return;
        }
    }

    out.push({
        sliceIndex,
        centerMM: [...sample.centerMM] as Vec3MM,
        radiusMM: sample.radiusMM,
        erase: sample.erase,
        strokeStart,
    });
}

export function projectStrokeByPlaneIntersection(
    request: StrokePlaneIntersectionProjectRequest
): StrokePlaneIntersectionProjectedSample[] {
    const { source, targetViewType, targetSliceCount, targetSliceIndex, targetSliceSpanMM } = request;
    if (source.length === 0) {
        return [];
    }

    const sliceCount = Math.max(1, Math.floor(targetSliceCount));
    const sliceIndex = Math.max(0, Math.min(sliceCount - 1, Math.floor(targetSliceIndex)));
    const axis = resolveAxis(targetViewType);
    const planeWorldMM = resolvePlaneWorldMM(sliceCount, sliceIndex, targetSliceSpanMM);

    let minAxis = Number.POSITIVE_INFINITY;
    let maxAxis = Number.NEGATIVE_INFINITY;
    let maxRadius = 0;
    for (const sample of source) {
        const axisValue = sample.centerMM[axis];
        minAxis = Math.min(minAxis, axisValue);
        maxAxis = Math.max(maxAxis, axisValue);
        maxRadius = Math.max(maxRadius, sample.radiusMM);
    }
    if (
        planeWorldMM < minAxis - maxRadius - CENTER_ON_PLANE_EPSILON_MM
        || planeWorldMM > maxAxis + maxRadius + CENTER_ON_PLANE_EPSILON_MM
    ) {
        return [];
    }

    if (source.length === 1) {
        const only = source[0];
        const signedDistanceMM = only.centerMM[axis] - planeWorldMM;
        const radiusMM = Math.max(0, only.radiusMM);
        const projectedRadiusMM = Math.sqrt(Math.max(0, radiusMM * radiusMM - signedDistanceMM * signedDistanceMM));
        if (projectedRadiusMM <= MIN_PROJECTED_RADIUS_MM) {
            return [];
        }
        const centerMM: Vec3MM = [...only.centerMM] as Vec3MM;
        centerMM[axis] = planeWorldMM;
        return [{
            sliceIndex,
            centerMM,
            radiusMM: projectedRadiusMM,
            erase: only.erase,
            strokeStart: true,
        }];
    }

    const projected: StrokePlaneIntersectionProjectedSample[] = [];
    const appendAtSegmentT = (
        previous: StrokeProjectionSample,
        next: StrokeProjectionSample,
        t: number,
        strokeStart: boolean
    ) => {
        const clampedT = Math.max(0, Math.min(1, t));
        const centerMM: Vec3MM = [
            previous.centerMM[0] + (next.centerMM[0] - previous.centerMM[0]) * clampedT,
            previous.centerMM[1] + (next.centerMM[1] - previous.centerMM[1]) * clampedT,
            previous.centerMM[2] + (next.centerMM[2] - previous.centerMM[2]) * clampedT,
        ];
        const radiusMM = Math.max(0, previous.radiusMM + (next.radiusMM - previous.radiusMM) * clampedT);
        const signedDistanceMM = centerMM[axis] - planeWorldMM;
        const projectedRadiusMM = Math.sqrt(Math.max(0, radiusMM * radiusMM - signedDistanceMM * signedDistanceMM));
        if (projectedRadiusMM <= MIN_PROJECTED_RADIUS_MM) {
            return;
        }
        centerMM[axis] = planeWorldMM;
        appendProjectedSample(
            projected,
            {
                centerMM,
                radiusMM: projectedRadiusMM,
                erase: next.erase,
                strokeStart,
            },
            sliceIndex,
            strokeStart
        );
    };

    for (let i = 1; i < source.length; i++) {
        const previous = source[i - 1];
        const next = source[i];
        if (previous.erase !== next.erase || next.strokeStart) {
            continue;
        }

        const prevAxis = previous.centerMM[axis] - planeWorldMM;
        const nextAxis = next.centerMM[axis] - planeWorldMM;
        const deltaAxis = nextAxis - prevAxis;
        const maxRadius = Math.max(previous.radiusMM, next.radiusMM);

        // 段与切面平行：若距离小于笔刷半径，切面交集是“胶囊条带”，用端点圆重建。
        if (Math.abs(deltaAxis) <= CENTER_ON_PLANE_EPSILON_MM) {
            const segmentDistanceMM = Math.abs(prevAxis);
            if (segmentDistanceMM > maxRadius + CENTER_ON_PLANE_EPSILON_MM) {
                continue;
            }
            appendAtSegmentT(previous, next, 0, true);
            appendAtSegmentT(previous, next, 1, false);
            continue;
        }

        const crossesPlane =
            (prevAxis < 0 && nextAxis > 0)
            || (prevAxis > 0 && nextAxis < 0)
            || Math.abs(prevAxis) <= CENTER_ON_PLANE_EPSILON_MM
            || Math.abs(nextAxis) <= CENTER_ON_PLANE_EPSILON_MM;
        if (crossesPlane) {
            const tCross = -prevAxis / deltaAxis;
            appendAtSegmentT(previous, next, tCross, true);
            continue;
        }

        // 同侧未穿面：若端点球与切面相交，保留最近端点的交圆。
        const prevDistanceMM = Math.abs(prevAxis);
        const nextDistanceMM = Math.abs(nextAxis);
        if (prevDistanceMM > previous.radiusMM + CENTER_ON_PLANE_EPSILON_MM
            && nextDistanceMM > next.radiusMM + CENTER_ON_PLANE_EPSILON_MM) {
            continue;
        }
        const usePrev = prevDistanceMM <= nextDistanceMM;
        appendAtSegmentT(previous, next, usePrev ? 0 : 1, true);
    }

    return projected;
}
