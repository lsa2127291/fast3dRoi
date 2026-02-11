import { describe, expect, it } from 'vitest';
import { AnnotationEngine } from './AnnotationEngine';
import { AnnotationPerformanceTracker } from './AnnotationPerformanceTracker';

describe('Milestone4 integration', () => {
    it('should wire commit, history undo/redo and performance tracking together', async () => {
        let ticks = 0;
        const now = (): number => {
            ticks += 1;
            return ticks * 25;
        };

        const tracker = new AnnotationPerformanceTracker({ maxSamplesPerMetric: 50 });
        const engine = new AnnotationEngine({
            historyKeyframeInterval: 1,
            now,
            onPerformanceSample: (sample) => tracker.record(sample),
            estimateDirtyBricks: () => ['0_0_0', '1_0_0'],
            sdfPipeline: {
                previewStroke: async () => undefined,
                applyStroke: async () => undefined,
            },
            marchingCubes: {
                dispatchWithRetry: async ({ dirtyBrickKeys }) => ({
                    overflow: 0,
                    quantOverflow: 0,
                    vertexCount: dirtyBrickKeys.length * 3,
                    indexCount: dirtyBrickKeys.length * 3,
                    attempts: 1,
                }),
            },
            slicePipeline: {
                extractSlices: async ({ roiId, targets }) => ({
                    roiId,
                    budget: 128,
                    budgetHit: false,
                    totalLineCount: 6,
                    totalDeferredLines: 0,
                    overflow: 0,
                    quantOverflow: 0,
                    viewResults: {
                        axial: {
                            viewType: 'axial',
                            sliceIndex: targets.find((target) => target.viewType === 'axial')?.sliceIndex ?? 0,
                            lineCount: 2,
                            deferredLines: 0,
                            overflow: 0,
                            quantOverflow: 0,
                        },
                        sagittal: {
                            viewType: 'sagittal',
                            sliceIndex: targets.find((target) => target.viewType === 'sagittal')?.sliceIndex ?? 0,
                            lineCount: 2,
                            deferredLines: 0,
                            overflow: 0,
                            quantOverflow: 0,
                        },
                        coronal: {
                            viewType: 'coronal',
                            sliceIndex: targets.find((target) => target.viewType === 'coronal')?.sliceIndex ?? 0,
                            lineCount: 2,
                            deferredLines: 0,
                            overflow: 0,
                            quantOverflow: 0,
                        },
                    },
                }),
            },
        });

        await engine.previewStroke([0, 0, 0], 'axial');
        await engine.commitStroke([10, 20, 30], 'axial');

        expect(engine.canUndo()).toBe(true);
        expect(engine.getHistorySnapshot().latestKeyframe?.index).toBe(1);

        await engine.undoLast();
        expect(engine.canRedo()).toBe(true);

        await engine.redoLast();
        expect(engine.canUndo()).toBe(true);

        const report = tracker.getReport();
        expect(report.metrics['mousemove-preview'].sampleCount).toBeGreaterThan(0);
        expect(report.metrics['mouseup-sync'].sampleCount).toBeGreaterThan(0);
    });
});

