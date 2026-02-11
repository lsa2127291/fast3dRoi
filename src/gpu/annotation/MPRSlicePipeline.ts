import type {
    MPRSliceDispatchCounters,
    MPRSliceDispatchRequest,
    MPRSliceDispatchState,
    MPRSlicePipelineLike,
    MPRSliceResult,
    MPRSliceTarget,
    MPRSliceViewResultMap,
    MPRViewType,
} from './types';

export interface MPRSlicePipelineOptions {
    lineBudget?: number;
    dispatchKernel?: (state: MPRSliceDispatchState) => Promise<MPRSliceDispatchCounters[]>;
}

const DEFAULT_LINE_BUDGET = 4096;
const VIEWS: MPRViewType[] = ['axial', 'sagittal', 'coronal'];

function createEmptyViewResult(viewType: MPRViewType, sliceIndex: number) {
    return {
        viewType,
        sliceIndex,
        lineCount: 0,
        deferredLines: 0,
        overflow: 0,
        quantOverflow: 0,
    };
}

export class MPRSlicePipeline implements MPRSlicePipelineLike {
    private readonly lineBudget: number;
    private readonly dispatchKernel: (state: MPRSliceDispatchState) => Promise<MPRSliceDispatchCounters[]>;

    constructor(options: MPRSlicePipelineOptions = {}) {
        this.lineBudget = Math.max(1, options.lineBudget ?? DEFAULT_LINE_BUDGET);
        this.dispatchKernel = options.dispatchKernel ?? this.defaultDispatchKernel;
    }

    async extractSlices(request: MPRSliceDispatchRequest): Promise<MPRSliceResult> {
        const budget = Math.max(1, request.lineBudget ?? this.lineBudget);
        const targets = this.normalizeTargets(request.targets);
        const counters = await this.dispatchKernel({
            roiId: request.roiId,
            dirtyBrickKeys: request.dirtyBrickKeys,
            targets,
            lineBudget: budget,
        });

        const results = this.createResultMap(targets);
        let remaining = budget;
        let overflow = 0;
        let quantOverflow = 0;
        let totalLineCount = 0;
        let totalDeferredLines = 0;

        for (const counter of counters) {
            const current = results[counter.viewType];
            const allowed = Math.max(0, Math.min(remaining, counter.lineCount));
            const deferred = Math.max(0, counter.lineCount - allowed);

            current.sliceIndex = counter.sliceIndex;
            current.lineCount = allowed;
            current.deferredLines = deferred;
            current.overflow = counter.overflow;
            current.quantOverflow = counter.quantOverflow;

            remaining -= allowed;
            totalLineCount += allowed;
            totalDeferredLines += deferred;
            overflow += counter.overflow;
            quantOverflow += counter.quantOverflow;
        }

        return {
            roiId: request.roiId,
            budget,
            budgetHit: totalDeferredLines > 0,
            totalLineCount,
            totalDeferredLines,
            overflow,
            quantOverflow,
            viewResults: results,
        };
    }

    private normalizeTargets(targets: MPRSliceTarget[]): MPRSliceTarget[] {
        const existing = new Map<MPRViewType, MPRSliceTarget>();
        for (const target of targets) {
            existing.set(target.viewType, {
                viewType: target.viewType,
                sliceIndex: Math.max(0, Math.floor(target.sliceIndex)),
            });
        }

        for (const viewType of VIEWS) {
            if (!existing.has(viewType)) {
                existing.set(viewType, { viewType, sliceIndex: 0 });
            }
        }

        return VIEWS.map((viewType) => existing.get(viewType)!);
    }

    private createResultMap(targets: MPRSliceTarget[]): MPRSliceViewResultMap {
        const map = {} as MPRSliceViewResultMap;
        for (const target of targets) {
            map[target.viewType] = createEmptyViewResult(target.viewType, target.sliceIndex);
        }
        return map;
    }

    private readonly defaultDispatchKernel = async (
        state: MPRSliceDispatchState
    ): Promise<MPRSliceDispatchCounters[]> => {
        const baseLines = Math.max(0, state.dirtyBrickKeys.length * 2);
        return state.targets.map((target) => ({
            viewType: target.viewType,
            sliceIndex: target.sliceIndex,
            lineCount: baseLines,
            overflow: 0,
            quantOverflow: 0,
        }));
    };
}
