import type { WebGPUContext } from '../WebGPUContext';
import { AnnotationEngine } from './AnnotationEngine';
import { MarchingCubesPipeline } from './MarchingCubesPipeline';
import { MPRSlicePipeline } from './MPRSlicePipeline';
import { SDFBrickPool } from './SDFBrickPool';
import { SDFGenerationPipeline } from './SDFGenerationPipeline';
import { ViewSyncCoordinator } from './ViewSyncCoordinator';
import type {
    AnnotationPerformanceSample,
    AnnotationStatus,
    SDFPipelineLike,
    ViewSyncEvent,
} from './types';

export interface AnnotationRuntime {
    engine: AnnotationEngine;
    sdfPool: SDFBrickPool | null;
    sdfPipeline: SDFGenerationPipeline | SDFPipelineLike;
    marchingCubes: MarchingCubesPipeline;
    slicePipeline: MPRSlicePipeline;
    viewSyncCoordinator: ViewSyncCoordinator;
    destroy(): void;
}

const noopSDFPipeline: SDFPipelineLike = {
    previewStroke: async () => undefined,
    applyStroke: async () => undefined,
};

const ENABLE_GPU_SDF_PIPELINE = false;
const MAX_UNDO_REDO_DEPTH = 6;

export function createAnnotationRuntime(
    ctx: WebGPUContext,
    onStatus?: (status: AnnotationStatus) => void,
    onViewSync?: (event: ViewSyncEvent) => void,
    onPerformanceSample?: (sample: AnnotationPerformanceSample) => void
): AnnotationRuntime {
    let sdfPool: SDFBrickPool | null = null;
    let sdfPipeline: SDFGenerationPipeline | SDFPipelineLike = noopSDFPipeline;
    if (ENABLE_GPU_SDF_PIPELINE) {
        sdfPool = new SDFBrickPool(ctx);
        sdfPipeline = new SDFGenerationPipeline(ctx, sdfPool);
    }

    const marchingCubes = new MarchingCubesPipeline();
    const slicePipeline = new MPRSlicePipeline();
    const viewSyncCoordinator = new ViewSyncCoordinator({
        slicePipeline,
        onSync: onViewSync,
    });

    const engine = new AnnotationEngine({
        sdfPipeline,
        marchingCubes,
        viewSyncCoordinator,
        onStatus,
        onPerformanceSample,
        historyLimit: MAX_UNDO_REDO_DEPTH,
    });

    return {
        engine,
        sdfPool,
        sdfPipeline,
        marchingCubes,
        slicePipeline,
        viewSyncCoordinator,
        destroy: () => {
            if (sdfPipeline instanceof SDFGenerationPipeline) {
                sdfPipeline.destroy();
            }
            sdfPool?.destroy();
            marchingCubes.destroy();
        },
    };
}
