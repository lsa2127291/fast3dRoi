import { BRICK_SIZE, DIRTY_BRICK_LIMIT, QUANT_STEP_MM, WORKSPACE_SIZE_MM } from '../constants';
import { DirtyBrickScheduler } from './DirtyBrickScheduler';
import { MarchingCubesPipeline } from './MarchingCubesPipeline';
import { ROIWriteToken } from './ROIWriteToken';
import { ViewSyncCoordinator } from './ViewSyncCoordinator';
import type {
    AnnotationCommitResult,
    AnnotationStatus,
    BrushStroke,
    DirtyBrickEstimator,
    MPRSlicePipelineLike,
    MPRViewType,
    MarchingCubesPipelineLike,
    SDFPipelineLike,
    Vec3MM,
    ViewSyncCoordinatorLike,
    ViewSyncEvent,
    ViewSyncTargetMap,
} from './types';

export interface AnnotationEngineOptions {
    scheduler?: DirtyBrickScheduler;
    writeToken?: ROIWriteToken;
    sdfPipeline?: SDFPipelineLike;
    marchingCubes?: MarchingCubesPipelineLike;
    slicePipeline?: MPRSlicePipelineLike;
    viewSyncCoordinator?: ViewSyncCoordinatorLike;
    estimateDirtyBricks?: DirtyBrickEstimator;
    onStatus?: (status: AnnotationStatus) => void;
    onViewSync?: (event: ViewSyncEvent) => void;
    now?: () => number;
}

const DEFAULT_INITIAL_VERTEX_CAPACITY = 1024;

class NoopSDFPipeline implements SDFPipelineLike {
    async previewStroke(): Promise<void> {
        return Promise.resolve();
    }

    async applyStroke(): Promise<void> {
        return Promise.resolve();
    }
}

export class AnnotationEngine {
    private activeROI = 1;
    private brushRadiusMM = 5;
    private eraseMode = false;

    private readonly scheduler: DirtyBrickScheduler;
    private readonly writeToken: ROIWriteToken;
    private readonly sdfPipeline: SDFPipelineLike;
    private readonly marchingCubes: MarchingCubesPipelineLike;
    private readonly viewSyncCoordinator: ViewSyncCoordinatorLike;
    private readonly estimateDirtyBricks: DirtyBrickEstimator;
    private readonly onStatus?: (status: AnnotationStatus) => void;
    private readonly now: () => number;
    private sliceBounds: ViewSyncTargetMap = {
        axial: 512,
        sagittal: 512,
        coronal: 512,
    };

    constructor(options: AnnotationEngineOptions = {}) {
        this.scheduler = options.scheduler ?? new DirtyBrickScheduler(DIRTY_BRICK_LIMIT);
        this.writeToken = options.writeToken ?? new ROIWriteToken();
        this.sdfPipeline = options.sdfPipeline ?? new NoopSDFPipeline();
        this.marchingCubes = options.marchingCubes ?? new MarchingCubesPipeline();
        this.viewSyncCoordinator = options.viewSyncCoordinator ?? new ViewSyncCoordinator({
            slicePipeline: options.slicePipeline,
            onSync: options.onViewSync,
        });
        this.estimateDirtyBricks = options.estimateDirtyBricks ?? this.defaultDirtyBrickEstimator;
        this.onStatus = options.onStatus;
        this.now = options.now ?? (() => Date.now());
    }

    setActiveROI(roiId: number): void {
        if (roiId <= 0) {
            return;
        }
        this.activeROI = roiId;
    }

    setBrushRadius(radiusMM: number): void {
        this.brushRadiusMM = Math.max(0.5, radiusMM);
    }

    setEraseMode(enabled: boolean): void {
        this.eraseMode = enabled;
    }

    setSliceBounds(bounds: Partial<ViewSyncTargetMap>): void {
        if (typeof bounds.axial === 'number') {
            this.sliceBounds.axial = Math.max(1, Math.floor(bounds.axial));
        }
        if (typeof bounds.sagittal === 'number') {
            this.sliceBounds.sagittal = Math.max(1, Math.floor(bounds.sagittal));
        }
        if (typeof bounds.coronal === 'number') {
            this.sliceBounds.coronal = Math.max(1, Math.floor(bounds.coronal));
        }
    }

    getActiveROI(): number {
        return this.activeROI;
    }

    async previewStroke(centerMM: Vec3MM, viewType: MPRViewType): Promise<void> {
        const stroke = this.buildStroke(centerMM, viewType, 'preview');
        const dirtyBrickKeys = this.estimateDirtyBricks(stroke);
        this.scheduler.enqueue(stroke.roiId, dirtyBrickKeys);
        await this.sdfPipeline.previewStroke(stroke);
        this.emitStatus({
            phase: 'preview',
            roiId: stroke.roiId,
            pendingDirtyBricks: this.scheduler.pendingCount(stroke.roiId),
            message: `preview:${dirtyBrickKeys.length}`,
        });
    }

    async commitStroke(centerMM: Vec3MM, viewType: MPRViewType): Promise<AnnotationCommitResult> {
        const stroke = this.buildStroke(centerMM, viewType, 'commit');
        return this.writeToken.runExclusive(stroke.roiId, async () => {
            const ownDirtyBricks = this.estimateDirtyBricks(stroke);
            this.scheduler.enqueue(stroke.roiId, ownDirtyBricks);

            const batches: AnnotationCommitResult['batches'] = [];
            let totalDirtyBricks = 0;
            let totalVertexCount = 0;
            let totalIndexCount = 0;
            const processedDirtyBricks: string[] = [];

            while (this.scheduler.hasPending(stroke.roiId)) {
                const batch = this.scheduler.drainNextBatch(stroke.roiId);
                if (batch.length === 0) {
                    break;
                }

                totalDirtyBricks += batch.length;
                processedDirtyBricks.push(...batch);
                await this.sdfPipeline.applyStroke(stroke, batch);
                const mesh = await this.marchingCubes.dispatchWithRetry({
                    roiId: stroke.roiId,
                    dirtyBrickKeys: batch,
                    initialCapacity: Math.max(DEFAULT_INITIAL_VERTEX_CAPACITY, batch.length * 128),
                    quantOriginMM: stroke.centerMM,
                    quantFallbackOriginMM: [0, 0, 0],
                });
                totalVertexCount += mesh.vertexCount;
                totalIndexCount += mesh.indexCount;
                batches.push({
                    dirtyBrickKeys: batch,
                    mesh,
                });
            }

            const result: AnnotationCommitResult = {
                roiId: stroke.roiId,
                totalDirtyBricks,
                totalVertexCount,
                totalIndexCount,
                batches,
            };

            try {
                result.viewSync = await this.viewSyncCoordinator.syncAfterCommit({
                    roiId: stroke.roiId,
                    centerMM: stroke.centerMM,
                    brushRadiusMM: stroke.radiusMM,
                    erase: stroke.erase,
                    dirtyBrickKeys: processedDirtyBricks,
                    targets: this.resolveSyncTargets(stroke.centerMM),
                });
            } catch (error) {
                const reason = error instanceof Error ? error.message : String(error);
                this.emitStatus({
                    phase: 'error',
                    roiId: stroke.roiId,
                    pendingDirtyBricks: this.scheduler.pendingCount(stroke.roiId),
                    message: `view-sync-failed:${reason}`,
                });
            }

            this.emitStatus({
                phase: 'commit',
                roiId: stroke.roiId,
                pendingDirtyBricks: this.scheduler.pendingCount(stroke.roiId),
                message: `commit:${totalDirtyBricks}`,
            });
            return result;
        });
    }

    private buildStroke(centerMM: Vec3MM, viewType: MPRViewType, phase: 'preview' | 'commit'): BrushStroke {
        return {
            roiId: this.activeROI,
            centerMM,
            radiusMM: this.brushRadiusMM,
            erase: this.eraseMode,
            viewType,
            phase,
            timestamp: this.now(),
        };
    }

    private readonly defaultDirtyBrickEstimator: DirtyBrickEstimator = (stroke) => {
        const brickWorldMM = BRICK_SIZE * QUANT_STEP_MM;
        const range = Math.max(0, Math.ceil(stroke.radiusMM / brickWorldMM));
        const cx = Math.floor(stroke.centerMM[0] / brickWorldMM);
        const cy = Math.floor(stroke.centerMM[1] / brickWorldMM);
        const cz = Math.floor(stroke.centerMM[2] / brickWorldMM);

        const keys: string[] = [];
        for (let dz = -range; dz <= range; dz++) {
            for (let dy = -range; dy <= range; dy++) {
                for (let dx = -range; dx <= range; dx++) {
                    keys.push(`${cx + dx}_${cy + dy}_${cz + dz}`);
                }
            }
        }
        return keys;
    };

    private emitStatus(status: AnnotationStatus): void {
        this.onStatus?.(status);
    }

    private resolveSyncTargets(centerMM: Vec3MM): ViewSyncTargetMap {
        return {
            axial: this.worldToSliceIndex(centerMM[2], this.sliceBounds.axial),
            sagittal: this.worldToSliceIndex(centerMM[0], this.sliceBounds.sagittal),
            coronal: this.worldToSliceIndex(centerMM[1], this.sliceBounds.coronal),
        };
    }

    private worldToSliceIndex(worldMM: number, sliceCount: number): number {
        if (sliceCount <= 1) {
            return 0;
        }
        const half = WORKSPACE_SIZE_MM * 0.5;
        const normalized = (worldMM + half) / WORKSPACE_SIZE_MM;
        const clamped = Math.min(1, Math.max(0, normalized));
        return Math.round(clamped * (sliceCount - 1));
    }
}
