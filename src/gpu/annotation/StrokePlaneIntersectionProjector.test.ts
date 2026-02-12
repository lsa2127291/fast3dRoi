import { describe, expect, it } from 'vitest';
import { projectStrokeByPlaneIntersection } from './StrokePlaneIntersectionProjector';

describe('projectStrokeByPlaneIntersection', () => {
    it('should emit two geometric intersections for coronal slice crossing twice', () => {
        const projected = projectStrokeByPlaneIntersection({
            source: [
                { centerMM: [-20, -20, 0], radiusMM: 6, erase: false, strokeStart: true },
                { centerMM: [0, 20, 0], radiusMM: 6, erase: false, strokeStart: false },
                { centerMM: [20, -20, 0], radiusMM: 6, erase: false, strokeStart: false },
            ],
            targetViewType: 'coronal',
            targetSliceCount: 11,
            targetSliceIndex: 5,
            targetSliceSpanMM: 100,
        });

        expect(projected).toHaveLength(2);
        expect(projected[0].centerMM[0]).toBeCloseTo(-10, 6);
        expect(projected[0].centerMM[1]).toBeCloseTo(0, 6);
        expect(projected[1].centerMM[0]).toBeCloseTo(10, 6);
        expect(projected[1].centerMM[1]).toBeCloseTo(0, 6);
        expect(projected[0].radiusMM).toBeCloseTo(6, 6);
        expect(projected[1].radiusMM).toBeCloseTo(6, 6);
        expect(projected[0].strokeStart).toBe(true);
        expect(projected[1].strokeStart).toBe(true);
    });

    it('should preserve on-plane samples for same-plane replay', () => {
        const projected = projectStrokeByPlaneIntersection({
            source: [
                { centerMM: [-5, 0, 2], radiusMM: 4, erase: false, strokeStart: true },
                { centerMM: [0, 0, 2], radiusMM: 4, erase: false, strokeStart: false },
                { centerMM: [5, 0, 2], radiusMM: 4, erase: false, strokeStart: false },
            ],
            targetViewType: 'coronal',
            targetSliceCount: 11,
            targetSliceIndex: 5,
            targetSliceSpanMM: 100,
        });

        expect(projected).toHaveLength(3);
        expect(projected[0].strokeStart).toBe(true);
        expect(projected[1].strokeStart).toBe(false);
        expect(projected[2].strokeStart).toBe(false);
    });

    it('should early-return empty result when axis range does not hit target plane', () => {
        const projected = projectStrokeByPlaneIntersection({
            source: [
                { centerMM: [0, 10, 0], radiusMM: 4, erase: false, strokeStart: true },
                { centerMM: [20, 30, 0], radiusMM: 4, erase: false, strokeStart: false },
            ],
            targetViewType: 'coronal',
            targetSliceCount: 11,
            targetSliceIndex: 5,
            targetSliceSpanMM: 100,
        });

        expect(projected).toHaveLength(0);
    });

    it('should avoid duplicate points when polyline vertex is on the target plane', () => {
        const projected = projectStrokeByPlaneIntersection({
            source: [
                { centerMM: [-10, -10, 0], radiusMM: 4, erase: false, strokeStart: true },
                { centerMM: [0, 0, 0], radiusMM: 4, erase: false, strokeStart: false },
                { centerMM: [10, -10, 0], radiusMM: 4, erase: false, strokeStart: false },
            ],
            targetViewType: 'coronal',
            targetSliceCount: 11,
            targetSliceIndex: 5,
            targetSliceSpanMM: 100,
        });

        expect(projected).toHaveLength(1);
        expect(projected[0].centerMM[0]).toBeCloseTo(0, 6);
        expect(projected[0].centerMM[1]).toBeCloseTo(0, 6);
    });

    it('should keep parallel segment as strip when target plane is offset but still inside radius', () => {
        const projected = projectStrokeByPlaneIntersection({
            source: [
                { centerMM: [0, -20, 0], radiusMM: 5, erase: false, strokeStart: true },
                { centerMM: [0, 20, 0], radiusMM: 5, erase: false, strokeStart: false },
            ],
            targetViewType: 'sagittal',
            targetSliceCount: 512,
            targetSliceIndex: 255,
            targetSliceSpanMM: 3000,
        });

        expect(projected.length).toBeGreaterThanOrEqual(2);
        const xSet = Array.from(new Set(projected.map((sample) => sample.centerMM[0].toFixed(3))));
        expect(xSet).toHaveLength(1);
        expect(Number(xSet[0])).toBeCloseTo(-2.935, 3);
        expect(projected.some((sample) => sample.centerMM[1] < -10)).toBe(true);
        expect(projected.some((sample) => sample.centerMM[1] > 10)).toBe(true);
    });
});
