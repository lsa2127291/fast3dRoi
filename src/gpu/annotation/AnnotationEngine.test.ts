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

    it('should apply union and erase against accumulated ROI geometry', async () => {
        const onViewSync = vi.fn();
        const engine = new AnnotationEngine({
            onViewSync,
            estimateDirtyBricks: (stroke) => (
                stroke.centerMM[0] < 0 ? ['A_0_0'] : ['B_0_0']
            ),
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
                extractSlices: async ({ roiId, dirtyBrickKeys, targets }) => {
                    const lineCountPerView = dirtyBrickKeys.length;
                    return {
                        roiId,
                        budget: 128,
                        budgetHit: false,
                        totalLineCount: lineCountPerView * 3,
                        totalDeferredLines: 0,
                        overflow: 0,
                        quantOverflow: 0,
                        viewResults: {
                            axial: {
                                viewType: 'axial',
                                sliceIndex: targets.find((target) => target.viewType === 'axial')?.sliceIndex ?? 0,
                                lineCount: lineCountPerView,
                                deferredLines: 0,
                                overflow: 0,
                                quantOverflow: 0,
                            },
                            sagittal: {
                                viewType: 'sagittal',
                                sliceIndex: targets.find((target) => target.viewType === 'sagittal')?.sliceIndex ?? 0,
                                lineCount: lineCountPerView,
                                deferredLines: 0,
                                overflow: 0,
                                quantOverflow: 0,
                            },
                            coronal: {
                                viewType: 'coronal',
                                sliceIndex: targets.find((target) => target.viewType === 'coronal')?.sliceIndex ?? 0,
                                lineCount: lineCountPerView,
                                deferredLines: 0,
                                overflow: 0,
                                quantOverflow: 0,
                            },
                        },
                    };
                },
            },
        });

        await engine.commitStroke([-10, 0, 0], 'axial');
        await engine.commitStroke([10, 0, 0], 'axial');
        engine.setEraseMode(true);
        await engine.commitStroke([10, 0, 0], 'axial');

        expect(onViewSync).toHaveBeenCalledTimes(3);
        expect(onViewSync.mock.calls[0][0].totalLineCount).toBe(3);
        expect(onViewSync.mock.calls[1][0].totalLineCount).toBe(6);
        expect(onViewSync.mock.calls[2][0].totalLineCount).toBe(3);
    });

    it('should keep previous overlapping contribution after undoing latest stroke', async () => {
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
                extractSlices: async ({ roiId, dirtyBrickKeys, targets }) => {
                    const lineCountPerView = dirtyBrickKeys.length;
                    return {
                        roiId,
                        budget: 128,
                        budgetHit: false,
                        totalLineCount: lineCountPerView * 3,
                        totalDeferredLines: 0,
                        overflow: 0,
                        quantOverflow: 0,
                        viewResults: {
                            axial: {
                                viewType: 'axial',
                                sliceIndex: targets.find((target) => target.viewType === 'axial')?.sliceIndex ?? 0,
                                lineCount: lineCountPerView,
                                deferredLines: 0,
                                overflow: 0,
                                quantOverflow: 0,
                            },
                            sagittal: {
                                viewType: 'sagittal',
                                sliceIndex: targets.find((target) => target.viewType === 'sagittal')?.sliceIndex ?? 0,
                                lineCount: lineCountPerView,
                                deferredLines: 0,
                                overflow: 0,
                                quantOverflow: 0,
                            },
                            coronal: {
                                viewType: 'coronal',
                                sliceIndex: targets.find((target) => target.viewType === 'coronal')?.sliceIndex ?? 0,
                                lineCount: lineCountPerView,
                                deferredLines: 0,
                                overflow: 0,
                                quantOverflow: 0,
                            },
                        },
                    };
                },
            },
        });

        await engine.commitStroke([5, 0, 0], 'axial');
        await engine.commitStroke([5, 0, 0], 'axial');
        await engine.undoLast();

        expect(onViewSync).toHaveBeenCalledTimes(3);
        expect(onViewSync.mock.calls[0][0].totalLineCount).toBe(3);
        expect(onViewSync.mock.calls[1][0].totalLineCount).toBe(3);
        expect(onViewSync.mock.calls[2][0].totalLineCount).toBe(3);
    });

    it('should support undo and redo with operation history', async () => {
        const applyEraseFlags: boolean[] = [];
        const engine = new AnnotationEngine({
            estimateDirtyBricks: () => ['0_0_0'],
            sdfPipeline: {
                previewStroke: async () => undefined,
                applyStroke: async (stroke) => {
                    applyEraseFlags.push(stroke.erase);
                },
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

        engine.setEraseMode(false);
        await engine.commitStroke([1, 2, 3], 'axial');
        expect(engine.canUndo()).toBe(true);
        expect(engine.canRedo()).toBe(false);

        await engine.undoLast();
        expect(applyEraseFlags).toEqual([false, true]);
        expect(engine.canUndo()).toBe(false);
        expect(engine.canRedo()).toBe(true);

        await engine.redoLast();
        expect(applyEraseFlags).toEqual([false, true, false]);
        expect(engine.canUndo()).toBe(true);
        expect(engine.canRedo()).toBe(false);

        const snapshot = engine.getHistorySnapshot();
        expect(snapshot.undoDepth).toBe(1);
        expect(snapshot.redoDepth).toBe(0);
    });

    it('should cap undo and redo depth to 6 by default', async () => {
        const engine = new AnnotationEngine({
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

        for (let i = 0; i < 8; i++) {
            await engine.commitStroke([i, 0, 0], 'axial');
        }

        expect(engine.getHistorySnapshot().undoDepth).toBe(6);

        for (let i = 0; i < 6; i++) {
            const result = await engine.undoLast();
            expect(result).not.toBeNull();
        }
        expect(await engine.undoLast()).toBeNull();
        expect(engine.getHistorySnapshot().redoDepth).toBe(6);

        for (let i = 0; i < 6; i++) {
            const result = await engine.redoLast();
            expect(result).not.toBeNull();
        }
        expect(await engine.redoLast()).toBeNull();
    });

    it('should create keyframes at configured history interval', async () => {
        const engine = new AnnotationEngine({
            historyKeyframeInterval: 2,
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

        await engine.commitStroke([0, 0, 0], 'axial');
        await engine.commitStroke([1, 0, 0], 'axial');
        await engine.commitStroke([2, 0, 0], 'axial');

        const snapshot = engine.getHistorySnapshot();
        expect(snapshot.undoDepth).toBe(3);
        expect(snapshot.latestKeyframe?.index).toBe(2);
        expect(snapshot.latestKeyframe?.roiId).toBe(1);
    });

    it('should report preview and sync performance samples', async () => {
        const onPerformanceSample = vi.fn();
        const engine = new AnnotationEngine({
            onPerformanceSample,
            now: vi
                .fn()
                .mockReturnValueOnce(1000)
                .mockReturnValueOnce(1015)
                .mockReturnValueOnce(2000)
                .mockReturnValueOnce(2140),
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
                    roiId: 1,
                    budget: 128,
                    budgetHit: false,
                    totalLineCount: 3,
                    totalDeferredLines: 0,
                    overflow: 0,
                    quantOverflow: 0,
                    viewResults: {
                        axial: { viewType: 'axial', sliceIndex: 1, lineCount: 1, deferredLines: 0, overflow: 0, quantOverflow: 0 },
                        sagittal: { viewType: 'sagittal', sliceIndex: 1, lineCount: 1, deferredLines: 0, overflow: 0, quantOverflow: 0 },
                        coronal: { viewType: 'coronal', sliceIndex: 1, lineCount: 1, deferredLines: 0, overflow: 0, quantOverflow: 0 },
                    },
                }),
            },
        });

        await engine.previewStroke([0, 0, 0], 'axial');
        await engine.commitStroke([0, 0, 0], 'axial');

        expect(onPerformanceSample).toHaveBeenCalledWith(expect.objectContaining({
            metric: 'mousemove-preview',
            durationMs: 15,
        }));
        expect(onPerformanceSample).toHaveBeenCalledWith(expect.objectContaining({
            metric: 'mouseup-sync',
            durationMs: 140,
        }));
    });
});
