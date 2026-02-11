import { describe, expect, it } from 'vitest';
import { SliceOverlayAccumulator } from './SliceOverlayAccumulator';

describe('SliceOverlayAccumulator', () => {
    it('should accumulate draw operations on the same slice', () => {
        const acc = new SliceOverlayAccumulator({ maxInterpolationSamples: 0 });
        acc.append({
            sliceIndex: 10,
            centerMM: [1, 2, 3],
            radiusMM: 5,
            erase: false,
        });
        acc.append({
            sliceIndex: 10,
            centerMM: [4, 5, 6],
            radiusMM: 5,
            erase: false,
        });

        const ops = acc.getSliceOps(10);
        expect(ops).toHaveLength(2);
        expect(ops[0].erase).toBe(false);
        expect(ops[1].erase).toBe(false);
    });

    it('should keep erase operation in sequence and clear all operations', () => {
        const acc = new SliceOverlayAccumulator({ maxInterpolationSamples: 0 });
        acc.append({
            sliceIndex: 7,
            centerMM: [0, 0, 0],
            radiusMM: 6,
            erase: false,
        });
        acc.append({
            sliceIndex: 7,
            centerMM: [0, 0, 0],
            radiusMM: 6,
            erase: true,
        });

        const beforeClear = acc.getSliceOps(7);
        expect(beforeClear).toHaveLength(2);
        expect(beforeClear[1].erase).toBe(true);

        acc.clear();
        expect(acc.getSliceOps(7)).toHaveLength(0);
    });

    it('should insert interpolated samples to keep long strokes connected', () => {
        const acc = new SliceOverlayAccumulator({
            samplingStepFactor: 0.5,
            maxInterpolationSamples: 64,
        });

        acc.append({
            sliceIndex: 3,
            centerMM: [0, 0, 0],
            radiusMM: 4,
            erase: false,
        });
        acc.append({
            sliceIndex: 3,
            centerMM: [20, 0, 0],
            radiusMM: 4,
            erase: false,
        });

        const ops = acc.getSliceOps(3);
        expect(ops.length).toBeGreaterThan(2);
        expect(ops[0].centerMM[0]).toBe(0);
        expect(ops[ops.length - 1].centerMM[0]).toBe(20);
        expect(ops.some((op) => op.centerMM[0] > 0 && op.centerMM[0] < 20)).toBe(true);
    });
});
