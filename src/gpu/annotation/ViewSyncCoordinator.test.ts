import { describe, expect, it, vi } from 'vitest';
import type { MPRSlicePipelineLike } from './types';
import { ViewSyncCoordinator } from './ViewSyncCoordinator';

describe('ViewSyncCoordinator', () => {
    it('should sync all MPR views after commit', async () => {
        const slicePipeline: MPRSlicePipelineLike = {
            extractSlices: async () => ({
                roiId: 3,
                budget: 24,
                budgetHit: false,
                totalLineCount: 15,
                totalDeferredLines: 0,
                overflow: 0,
                quantOverflow: 0,
                viewResults: {
                    axial: {
                        viewType: 'axial',
                        sliceIndex: 10,
                        lineCount: 5,
                        deferredLines: 0,
                        overflow: 0,
                        quantOverflow: 0,
                    },
                    sagittal: {
                        viewType: 'sagittal',
                        sliceIndex: 20,
                        lineCount: 5,
                        deferredLines: 0,
                        overflow: 0,
                        quantOverflow: 0,
                    },
                    coronal: {
                        viewType: 'coronal',
                        sliceIndex: 30,
                        lineCount: 5,
                        deferredLines: 0,
                        overflow: 0,
                        quantOverflow: 0,
                    },
                },
            }),
        };

        const onSliceSync = vi.fn();
        const coordinator = new ViewSyncCoordinator({
            slicePipeline,
            onSliceSync,
        });

        const event = await coordinator.syncAfterCommit({
            roiId: 3,
            centerMM: [100, 200, 300],
            brushRadiusMM: 12,
            erase: false,
            dirtyBrickKeys: ['0_0_0'],
            targets: {
                axial: 10,
                sagittal: 20,
                coronal: 30,
            },
        });

        expect(event.roiId).toBe(3);
        expect(event.totalLineCount).toBe(15);
        expect(event.brushRadiusMM).toBe(12);
        expect(event.erase).toBe(false);
        expect(onSliceSync).toHaveBeenCalledTimes(3);
        expect(onSliceSync.mock.calls.map((call) => call[0].viewType)).toEqual([
            'axial',
            'sagittal',
            'coronal',
        ]);
    });

    it('should expose deferred line metrics when budget is hit', async () => {
        const coordinator = new ViewSyncCoordinator({
            slicePipeline: {
                extractSlices: async () => ({
                    roiId: 1,
                    budget: 4,
                    budgetHit: true,
                    totalLineCount: 4,
                    totalDeferredLines: 8,
                    overflow: 0,
                    quantOverflow: 0,
                    viewResults: {
                        axial: {
                            viewType: 'axial',
                            sliceIndex: 5,
                            lineCount: 4,
                            deferredLines: 2,
                            overflow: 0,
                            quantOverflow: 0,
                        },
                        sagittal: {
                            viewType: 'sagittal',
                            sliceIndex: 5,
                            lineCount: 0,
                            deferredLines: 3,
                            overflow: 0,
                            quantOverflow: 0,
                        },
                        coronal: {
                            viewType: 'coronal',
                            sliceIndex: 5,
                            lineCount: 0,
                            deferredLines: 3,
                            overflow: 0,
                            quantOverflow: 0,
                        },
                    },
                }),
            },
        });

        const event = await coordinator.syncAfterCommit({
            roiId: 1,
            centerMM: [0, 0, 0],
            brushRadiusMM: 20,
            erase: true,
            dirtyBrickKeys: ['0_0_0', '1_0_0'],
            targets: {
                axial: 5,
                sagittal: 5,
                coronal: 5,
            },
        });

        expect(event.budgetHit).toBe(true);
        expect(event.totalDeferredLines).toBe(8);
        expect(event.brushRadiusMM).toBe(20);
        expect(event.erase).toBe(true);
        expect(event.viewResults.sagittal.deferredLines).toBe(3);
    });
});
