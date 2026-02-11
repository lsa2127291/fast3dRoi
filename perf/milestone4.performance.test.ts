import { describe, expect, it } from 'vitest';
import { AnnotationPerformanceTracker } from '../src/gpu/annotation/AnnotationPerformanceTracker';

describe('Milestone4 performance target verification', () => {
    it('marks all metrics as meeting phase12 targets when p95 stays below thresholds', () => {
        const tracker = new AnnotationPerformanceTracker({ maxSamplesPerMetric: 256 });

        for (let i = 0; i < 100; i++) {
            tracker.record({ metric: 'mousemove-preview', durationMs: 20 + (i % 5), timestamp: i });
            tracker.record({ metric: 'page-flip', durationMs: 45 + (i % 8), timestamp: i });
            tracker.record({ metric: 'mouseup-sync', durationMs: 220 + (i % 30), timestamp: i });
        }

        const report = tracker.getReport();
        expect(report.metrics['mousemove-preview'].withinTarget).toBe(true);
        expect(report.metrics['page-flip'].withinTarget).toBe(true);
        expect(report.metrics['mouseup-sync'].withinTarget).toBe(true);
    });
});

