import { describe, expect, it, vi } from 'vitest';
import { AnnotationEngine } from './AnnotationEngine';
import { DirtyBrickScheduler } from './DirtyBrickScheduler';
import { ROIWriteToken } from './ROIWriteToken';
import type { BrushStroke, MarchingCubesDispatchResult } from './types';

describe('AnnotationEngine two-stage workflow', () => {
    it('should run preview on move and commit on mouseup', async () => {
        const previewCalls: BrushStroke[] = [];
        const applyCalls: { stroke: BrushStroke; bricks: string[] }[] = [];
        const meshCalls: string[][] = [];

        const engine = new AnnotationEngine({
            scheduler: new DirtyBrickScheduler(2),
            writeToken: new ROIWriteToken(),
            estimateDirtyBricks: () => ['0_0_0', '1_0_0', '2_0_0'],
            sdfPipeline: {
                previewStroke: async (stroke) => {
                    previewCalls.push(stroke);
                },
                applyStroke: async (stroke, dirtyBrickKeys) => {
                    applyCalls.push({ stroke, bricks: dirtyBrickKeys });
                },
            },
            marchingCubes: {
                dispatchWithRetry: async ({ dirtyBrickKeys }) => {
                    meshCalls.push(dirtyBrickKeys);
                    const result: MarchingCubesDispatchResult = {
                        overflow: 0,
                        quantOverflow: 0,
                        vertexCount: dirtyBrickKeys.length * 3,
                        indexCount: dirtyBrickKeys.length * 3,
                        attempts: 1,
                    };
                    return result;
                },
            },
        });

        engine.setActiveROI(2);
        engine.setBrushRadius(12);
        engine.setEraseMode(false);

        await engine.previewStroke([10, 20, 30], 'axial');
        const commit = await engine.commitStroke([10, 20, 30], 'axial');

        expect(previewCalls).toHaveLength(1);
        expect(previewCalls[0].phase).toBe('preview');
        expect(applyCalls).toHaveLength(2);
        expect(meshCalls).toEqual([['0_0_0', '1_0_0'], ['2_0_0']]);
        expect(commit.batches).toHaveLength(2);
        expect(commit.totalDirtyBricks).toBe(3);
        expect(commit.totalVertexCount).toBe(9);
    });

    it('should serialize commit for same ROI via ROIWriteToken', async () => {
        const started: number[] = [];
        const finished: number[] = [];
        const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

        const engine = new AnnotationEngine({
            scheduler: new DirtyBrickScheduler(8),
            writeToken: new ROIWriteToken(),
            estimateDirtyBricks: () => ['0_0_0'],
            sdfPipeline: {
                previewStroke: async () => undefined,
                applyStroke: async () => {
                    await sleep(15);
                },
            },
            marchingCubes: {
                dispatchWithRetry: async ({ roiId }) => {
                    started.push(roiId);
                    await sleep(5);
                    finished.push(roiId);
                    return { overflow: 0, quantOverflow: 0, vertexCount: 3, indexCount: 3, attempts: 1 };
                },
            },
        });

        engine.setActiveROI(1);
        await engine.previewStroke([0, 0, 0], 'axial');
        const first = engine.commitStroke([0, 0, 0], 'axial');
        const second = engine.commitStroke([0, 0, 0], 'axial');
        await Promise.all([first, second]);

        expect(started).toEqual([1, 1]);
        expect(finished).toEqual([1, 1]);
    });

    it('should emit status updates for UI observability', async () => {
        const onStatus = vi.fn();
        const engine = new AnnotationEngine({
            onStatus,
            estimateDirtyBricks: () => ['0_0_0'],
            sdfPipeline: {
                previewStroke: async () => undefined,
                applyStroke: async () => undefined,
            },
            marchingCubes: {
                dispatchWithRetry: async () => ({
                    overflow: 0,
                    quantOverflow: 0,
                    vertexCount: 3,
                    indexCount: 3,
                    attempts: 1,
                }),
            },
        });

        await engine.previewStroke([5, 5, 5], 'axial');
        await engine.commitStroke([5, 5, 5], 'axial');

        expect(onStatus).toHaveBeenCalled();
        expect(onStatus.mock.calls.some((call) => call[0].phase === 'preview')).toBe(true);
        expect(onStatus.mock.calls.some((call) => call[0].phase === 'commit')).toBe(true);
    });

    it('should trigger view sync after commit', async () => {
        const onViewSync = vi.fn();
        const engine = new AnnotationEngine({
            onViewSync,
            estimateDirtyBricks: () => ['0_0_0'],
            sdfPipeline: {
                previewStroke: async () => undefined,
                applyStroke: async () => undefined,
            },
            marchingCubes: {
                dispatchWithRetry: async () => ({
                    overflow: 0,
                    quantOverflow: 0,
                    vertexCount: 3,
                    indexCount: 3,
                    attempts: 1,
                }),
            },
            slicePipeline: {
                extractSlices: async () => ({
                    roiId: 7,
                    budget: 64,
                    budgetHit: false,
                    totalLineCount: 6,
                    totalDeferredLines: 0,
                    overflow: 0,
                    quantOverflow: 0,
                    viewResults: {
                        axial: { viewType: 'axial', sliceIndex: 12, lineCount: 2, deferredLines: 0, overflow: 0, quantOverflow: 0 },
                        sagittal: { viewType: 'sagittal', sliceIndex: 13, lineCount: 2, deferredLines: 0, overflow: 0, quantOverflow: 0 },
                        coronal: { viewType: 'coronal', sliceIndex: 14, lineCount: 2, deferredLines: 0, overflow: 0, quantOverflow: 0 },
                    },
                }),
            },
        });

        engine.setActiveROI(7);
        await engine.commitStroke([0, 0, 0], 'axial');

        expect(onViewSync).toHaveBeenCalledTimes(1);
        expect(onViewSync.mock.calls[0][0].viewResults.axial.sliceIndex).toBe(12);
    });
});
