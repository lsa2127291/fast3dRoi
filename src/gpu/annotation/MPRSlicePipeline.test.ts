import { describe, expect, it } from 'vitest';
import { MPRSlicePipeline } from './MPRSlicePipeline';

describe('MPRSlicePipeline budget strategy', () => {
    it('should throttle line output when line_budget is exceeded', async () => {
        const pipeline = new MPRSlicePipeline({
            lineBudget: 6,
            dispatchKernel: async ({ dirtyBrickKeys, targets }) => {
                const lineCount = dirtyBrickKeys.length * 2;
                return targets.map((target) => ({
                    viewType: target.viewType,
                    sliceIndex: target.sliceIndex,
                    lineCount,
                    overflow: 0,
                    quantOverflow: 0,
                }));
            },
        });

        const result = await pipeline.extractSlices({
            roiId: 2,
            dirtyBrickKeys: ['0_0_0', '1_0_0', '2_0_0'],
            targets: [
                { viewType: 'axial', sliceIndex: 12 },
                { viewType: 'sagittal', sliceIndex: 20 },
                { viewType: 'coronal', sliceIndex: 8 },
            ],
        });

        expect(result.budgetHit).toBe(true);
        expect(result.totalLineCount).toBe(6);
        expect(result.totalDeferredLines).toBe(12);
        expect(result.viewResults.axial.lineCount).toBe(6);
        expect(result.viewResults.sagittal.lineCount).toBe(0);
        expect(result.viewResults.coronal.lineCount).toBe(0);
    });

    it('should keep all output when within budget', async () => {
        const pipeline = new MPRSlicePipeline({
            lineBudget: 32,
            dispatchKernel: async ({ targets }) =>
                targets.map((target) => ({
                    viewType: target.viewType,
                    sliceIndex: target.sliceIndex,
                    lineCount: 4,
                    overflow: 0,
                    quantOverflow: 0,
                })),
        });

        const result = await pipeline.extractSlices({
            roiId: 1,
            dirtyBrickKeys: ['0_0_0'],
            targets: [
                { viewType: 'axial', sliceIndex: 1 },
                { viewType: 'sagittal', sliceIndex: 2 },
                { viewType: 'coronal', sliceIndex: 3 },
            ],
        });

        expect(result.budgetHit).toBe(false);
        expect(result.totalLineCount).toBe(12);
        expect(result.totalDeferredLines).toBe(0);
        expect(result.viewResults.axial.deferredLines).toBe(0);
        expect(result.viewResults.sagittal.deferredLines).toBe(0);
        expect(result.viewResults.coronal.deferredLines).toBe(0);
    });
});
