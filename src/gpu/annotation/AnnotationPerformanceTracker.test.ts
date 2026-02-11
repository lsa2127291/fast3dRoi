import { describe, expect, it } from 'vitest';
import {
    AnnotationPerformanceTracker,
    type AnnotationPerformanceSample,
} from './AnnotationPerformanceTracker';

function sample(metric: AnnotationPerformanceSample['metric'], durationMs: number): AnnotationPerformanceSample {
    return {
        metric,
        durationMs,
        timestamp: Date.now(),
    };
}

describe('AnnotationPerformanceTracker', () => {
    it('should compute p95 for each metric', () => {
        const tracker = new AnnotationPerformanceTracker({ maxSamplesPerMetric: 10 });
        tracker.record(sample('mousemove-preview', 10));
        tracker.record(sample('mousemove-preview', 20));
        tracker.record(sample('mousemove-preview', 30));
        tracker.record(sample('mousemove-preview', 40));
        tracker.record(sample('mousemove-preview', 50));

        const report = tracker.getReport();
        expect(report.metrics['mousemove-preview'].sampleCount).toBe(5);
        expect(report.metrics['mousemove-preview'].p95).toBe(50);
    });

    it('should evaluate milestone 4 target thresholds', () => {
        const tracker = new AnnotationPerformanceTracker({ maxSamplesPerMetric: 20 });
        tracker.record(sample('mousemove-preview', 22));
        tracker.record(sample('page-flip', 58));
        tracker.record(sample('mouseup-sync', 280));

        const report = tracker.getReport();
        expect(report.metrics['mousemove-preview'].withinTarget).toBe(true);
        expect(report.metrics['page-flip'].withinTarget).toBe(true);
        expect(report.metrics['mouseup-sync'].withinTarget).toBe(true);
    });

    it('should mark metric as failed when p95 exceeds target', () => {
        const tracker = new AnnotationPerformanceTracker({ maxSamplesPerMetric: 20 });
        tracker.record(sample('mousemove-preview', 31));

        const report = tracker.getReport();
        expect(report.metrics['mousemove-preview'].withinTarget).toBe(false);
        expect(report.metrics['mousemove-preview'].targetMs).toBe(30);
    });

    it('should keep only the latest samples by metric', () => {
        const tracker = new AnnotationPerformanceTracker({ maxSamplesPerMetric: 3 });
        tracker.record(sample('page-flip', 10));
        tracker.record(sample('page-flip', 20));
        tracker.record(sample('page-flip', 30));
        tracker.record(sample('page-flip', 40));

        const report = tracker.getReport();
        expect(report.metrics['page-flip'].sampleCount).toBe(3);
        expect(report.metrics['page-flip'].p95).toBe(40);
    });
});

