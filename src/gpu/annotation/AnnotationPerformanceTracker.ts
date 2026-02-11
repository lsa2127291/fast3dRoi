import {
    TARGET_MOUSEMOVE_MS,
    TARGET_PAGE_FLIP_MS,
    TARGET_SYNC_MS,
} from '../constants';
import type { AnnotationPerformanceMetric, AnnotationPerformanceSample } from './types';

export interface AnnotationPerformanceTrackerOptions {
    maxSamplesPerMetric?: number;
    timestampQueryEnabled?: boolean;
}

export interface AnnotationPerformanceDiagnosticsInput {
    overflowCount?: number;
    quantOverflowCount?: number;
    deferredLines?: number;
    batchCount?: number;
    budgetHit?: boolean;
}

export interface AnnotationPerformanceDiagnosticsReport {
    overflowCount: number;
    quantOverflowCount: number;
    deferredLines: number;
    batchCount: number;
    budgetHitCount: number;
}

export interface AnnotationPerformanceMetricReport {
    metric: AnnotationPerformanceMetric;
    targetMs: number;
    p50: number | null;
    p95: number | null;
    p99: number | null;
    sampleCount: number;
    withinTarget: boolean;
}

export interface AnnotationPerformanceReport {
    generatedAt: number;
    timestampQueryEnabled: boolean;
    metrics: Record<AnnotationPerformanceMetric, AnnotationPerformanceMetricReport>;
    diagnostics: AnnotationPerformanceDiagnosticsReport;
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
    private timestampQueryEnabled: boolean;
    private readonly samples: Record<AnnotationPerformanceMetric, number[]> = {
        'mousemove-preview': [],
        'page-flip': [],
        'mouseup-sync': [],
    };
    private diagnostics: AnnotationPerformanceDiagnosticsReport = {
        overflowCount: 0,
        quantOverflowCount: 0,
        deferredLines: 0,
        batchCount: 0,
        budgetHitCount: 0,
    };

    constructor(options: AnnotationPerformanceTrackerOptions = {}) {
        this.maxSamplesPerMetric = Math.max(1, Math.floor(options.maxSamplesPerMetric ?? DEFAULT_MAX_SAMPLES));
        this.timestampQueryEnabled = options.timestampQueryEnabled ?? false;
    }

    setTimestampQueryEnabled(enabled: boolean): void {
        this.timestampQueryEnabled = enabled;
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
        this.recordDiagnostics(sample);
    }

    recordDiagnostics(input: AnnotationPerformanceDiagnosticsInput): void {
        this.diagnostics.overflowCount += this.normalizeCount(input.overflowCount);
        this.diagnostics.quantOverflowCount += this.normalizeCount(input.quantOverflowCount);
        this.diagnostics.deferredLines += this.normalizeCount(input.deferredLines);
        this.diagnostics.batchCount += this.normalizeCount(input.batchCount);
        if (input.budgetHit) {
            this.diagnostics.budgetHitCount += 1;
        }
    }

    getReport(): AnnotationPerformanceReport {
        const metrics = {} as Record<AnnotationPerformanceMetric, AnnotationPerformanceMetricReport>;
        for (const metric of METRICS) {
            const values = this.samples[metric];
            const p50 = this.computeQuantile(values, 0.5);
            const p95 = this.computeP95(values);
            const p99 = this.computeQuantile(values, 0.99);
            const targetMs = TARGETS[metric];
            metrics[metric] = {
                metric,
                targetMs,
                p50,
                p95,
                p99,
                sampleCount: values.length,
                withinTarget: p95 !== null && p95 <= targetMs,
            };
        }

        return {
            generatedAt: Date.now(),
            timestampQueryEnabled: this.timestampQueryEnabled,
            metrics,
            diagnostics: {
                ...this.diagnostics,
            },
        };
    }

    reset(): void {
        for (const metric of METRICS) {
            this.samples[metric] = [];
        }
        this.diagnostics = {
            overflowCount: 0,
            quantOverflowCount: 0,
            deferredLines: 0,
            batchCount: 0,
            budgetHitCount: 0,
        };
    }

    private computeP95(values: number[]): number | null {
        return this.computeQuantile(values, 0.95);
    }

    private computeQuantile(values: number[], quantile: number): number | null {
        if (values.length === 0) {
            return null;
        }
        const sorted = [...values].sort((a, b) => a - b);
        const q = Math.min(1, Math.max(0, quantile));
        const index = Math.max(0, Math.ceil(sorted.length * q) - 1);
        return sorted[index] ?? null;
    }

    private normalizeCount(value: number | undefined): number {
        if (!Number.isFinite(value)) {
            return 0;
        }
        return Math.max(0, Math.floor(value ?? 0));
    }
}

export type { AnnotationPerformanceSample };
