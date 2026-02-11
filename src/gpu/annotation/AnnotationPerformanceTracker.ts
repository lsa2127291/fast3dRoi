import {
    TARGET_MOUSEMOVE_MS,
    TARGET_PAGE_FLIP_MS,
    TARGET_SYNC_MS,
} from '../constants';
import type { AnnotationPerformanceMetric, AnnotationPerformanceSample } from './types';

export interface AnnotationPerformanceTrackerOptions {
    maxSamplesPerMetric?: number;
}

export interface AnnotationPerformanceMetricReport {
    metric: AnnotationPerformanceMetric;
    targetMs: number;
    p95: number | null;
    sampleCount: number;
    withinTarget: boolean;
}

export interface AnnotationPerformanceReport {
    generatedAt: number;
    metrics: Record<AnnotationPerformanceMetric, AnnotationPerformanceMetricReport>;
}

const DEFAULT_MAX_SAMPLES = 120;
const METRICS: AnnotationPerformanceMetric[] = ['mousemove-preview', 'page-flip', 'mouseup-sync'];
const TARGETS: Record<AnnotationPerformanceMetric, number> = {
    'mousemove-preview': TARGET_MOUSEMOVE_MS,
    'page-flip': TARGET_PAGE_FLIP_MS,
    'mouseup-sync': TARGET_SYNC_MS,
};

export class AnnotationPerformanceTracker {
    private readonly maxSamplesPerMetric: number;
    private readonly samples: Record<AnnotationPerformanceMetric, number[]> = {
        'mousemove-preview': [],
        'page-flip': [],
        'mouseup-sync': [],
    };

    constructor(options: AnnotationPerformanceTrackerOptions = {}) {
        this.maxSamplesPerMetric = Math.max(1, Math.floor(options.maxSamplesPerMetric ?? DEFAULT_MAX_SAMPLES));
    }

    record(sample: AnnotationPerformanceSample): void {
        if (!Number.isFinite(sample.durationMs)) {
            return;
        }
        const list = this.samples[sample.metric];
        list.push(Math.max(0, sample.durationMs));
        if (list.length > this.maxSamplesPerMetric) {
            list.splice(0, list.length - this.maxSamplesPerMetric);
        }
    }

    getReport(): AnnotationPerformanceReport {
        const metrics = {} as Record<AnnotationPerformanceMetric, AnnotationPerformanceMetricReport>;
        for (const metric of METRICS) {
            const values = this.samples[metric];
            const p95 = this.computeP95(values);
            const targetMs = TARGETS[metric];
            metrics[metric] = {
                metric,
                targetMs,
                p95,
                sampleCount: values.length,
                withinTarget: p95 !== null && p95 <= targetMs,
            };
        }

        return {
            generatedAt: Date.now(),
            metrics,
        };
    }

    reset(): void {
        for (const metric of METRICS) {
            this.samples[metric] = [];
        }
    }

    private computeP95(values: number[]): number | null {
        if (values.length === 0) {
            return null;
        }
        const sorted = [...values].sort((a, b) => a - b);
        const index = Math.max(0, Math.ceil(sorted.length * 0.95) - 1);
        return sorted[index] ?? null;
    }
}

export type { AnnotationPerformanceSample };

