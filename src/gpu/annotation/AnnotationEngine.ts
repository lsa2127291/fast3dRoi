import { BRICK_SIZE, DIRTY_BRICK_LIMIT, QUANT_STEP_MM, WORKSPACE_SIZE_MM } from '../constants';
import { DirtyBrickScheduler } from './DirtyBrickScheduler';
import { MarchingCubesPipeline } from './MarchingCubesPipeline';
import { ROIWriteToken } from './ROIWriteToken';
import { ViewSyncCoordinator } from './ViewSyncCoordinator';
import type {
    AnnotationCommitResult,
    AnnotationHistoryEntry,
    AnnotationHistoryKeyframe,
    AnnotationHistorySnapshot,
    AnnotationPerformanceSample,
    AnnotationStatus,
    BrushStroke,
    DirtyBrickKey,
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
    onPerformanceSample?: (sample: AnnotationPerformanceSample) => void;
    historyKeyframeInterval?: number;
    historyLimit?: number;
    now?: () => number;
}

interface CommitExecutionOptions {
    clearRedo: boolean;
    recordHistory: boolean;
    statusPrefix: 'commit' | 'undo' | 'redo';
}

const DEFAULT_INITIAL_VERTEX_CAPACITY = 1024;
const DEFAULT_HISTORY_KEYFRAME_INTERVAL = 8;
const DEFAULT_HISTORY_LIMIT = 6;

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
    private quantOriginVersion = 0;
    private historySequence = 0;
    private latestKeyframe: AnnotationHistoryKeyframe | undefined;

    private readonly scheduler: DirtyBrickScheduler;
    private readonly writeToken: ROIWriteToken;
    private readonly sdfPipeline: SDFPipelineLike;
    private readonly marchingCubes: MarchingCubesPipelineLike;
    private readonly viewSyncCoordinator: ViewSyncCoordinatorLike;
    private readonly estimateDirtyBricks: DirtyBrickEstimator;
    private readonly onStatus?: (status: AnnotationStatus) => void;
    private readonly onPerformanceSample?: (sample: AnnotationPerformanceSample) => void;
    private readonly historyKeyframeInterval: number;
    private readonly historyLimit: number;
    private readonly now: () => number;
    private readonly history: AnnotationHistoryEntry[] = [];
    private readonly redoStack: AnnotationHistoryEntry[] = [];
    private readonly roiActiveDirtyBricks = new Map<number, Map<DirtyBrickKey, number>>();
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
        this.onPerformanceSample = options.onPerformanceSample;
        this.historyKeyframeInterval = Math.max(1, options.historyKeyframeInterval ?? DEFAULT_HISTORY_KEYFRAME_INTERVAL);
        this.historyLimit = Math.max(1, options.historyLimit ?? DEFAULT_HISTORY_LIMIT);
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

    getBrushRadius(): number {
        return this.brushRadiusMM;
    }

    getEraseMode(): boolean {
        return this.eraseMode;
    }

    canUndo(): boolean {
        return this.history.length > 0;
    }

    canRedo(): boolean {
        return this.redoStack.length > 0;
    }

    getHistorySnapshot(): AnnotationHistorySnapshot {
        return {
            undoDepth: this.history.length,
            redoDepth: this.redoStack.length,
            latestKeyframe: this.latestKeyframe
                ? {
                    ...this.latestKeyframe,
                    dirtyBrickKeys: [...this.latestKeyframe.dirtyBrickKeys],
                }
                : undefined,
        };
    }

    async previewStroke(centerMM: Vec3MM, viewType: MPRViewType): Promise<void> {
        const startedAt = this.now();
        const stroke = this.buildStroke(centerMM, viewType, 'preview', startedAt);
        await this.sdfPipeline.previewStroke(stroke);

        const endedAt = this.now();
        this.emitPerformanceSample({
            metric: 'mousemove-preview',
            durationMs: endedAt - startedAt,
            timestamp: endedAt,
            roiId: stroke.roiId,
            viewType: stroke.viewType,
        });

        this.emitStatus({
            phase: 'preview',
            roiId: stroke.roiId,
            pendingDirtyBricks: this.scheduler.pendingCount(stroke.roiId),
            message: 'preview',
        });
    }

    async commitStroke(centerMM: Vec3MM, viewType: MPRViewType): Promise<AnnotationCommitResult> {
        const startedAt = this.now();
        const stroke = this.buildStroke(centerMM, viewType, 'commit', startedAt);
        return this.commitStrokeInternal(stroke, {
            clearRedo: true,
            recordHistory: true,
            statusPrefix: 'commit',
        });
    }

    async undoLast(): Promise<AnnotationCommitResult | null> {
        const entry = this.history.pop();
        if (!entry) {
            return null;
        }
        if (entry.keyframe && this.latestKeyframe?.index === entry.keyframe.index) {
            this.recomputeLatestKeyframe();
        }

        const inverseStroke = this.createReplayStroke(entry.stroke, !entry.stroke.erase);
        try {
            const result = await this.commitStrokeInternal(inverseStroke, {
                clearRedo: false,
                recordHistory: false,
                statusPrefix: 'undo',
            });
            this.redoStack.push(entry);
            if (this.redoStack.length > this.historyLimit) {
                this.redoStack.shift();
            }
            return result;
        } catch (error) {
            this.history.push(entry);
            if (entry.keyframe) {
                this.latestKeyframe = entry.keyframe;
            }
            throw error;
        }
    }

    async redoLast(): Promise<AnnotationCommitResult | null> {
        const entry = this.redoStack.pop();
        if (!entry) {
            return null;
        }

        const redoStroke = this.createReplayStroke(entry.stroke, entry.stroke.erase);
        try {
            const result = await this.commitStrokeInternal(redoStroke, {
                clearRedo: false,
                recordHistory: false,
                statusPrefix: 'redo',
            });
            this.history.push(entry);
            if (entry.keyframe) {
                this.latestKeyframe = entry.keyframe;
            }
            return result;
        } catch (error) {
            this.redoStack.push(entry);
            throw error;
        }
    }

    private async commitStrokeInternal(
        stroke: BrushStroke,
        options: CommitExecutionOptions
    ): Promise<AnnotationCommitResult> {
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
            const activeDirtyBricks = this.applyBooleanToROIState(
                stroke.roiId,
                processedDirtyBricks,
                stroke.erase
            );

            try {
                result.viewSync = await this.viewSyncCoordinator.syncAfterCommit({
                    roiId: stroke.roiId,
                    centerMM: stroke.centerMM,
                    brushRadiusMM: stroke.radiusMM,
                    erase: stroke.erase,
                    dirtyBrickKeys: activeDirtyBricks,
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

            if (options.recordHistory) {
                this.pushHistoryEntry(stroke, processedDirtyBricks);
                if (options.clearRedo) {
                    this.redoStack.length = 0;
                }
            }

            this.emitStatus({
                phase: 'commit',
                roiId: stroke.roiId,
                pendingDirtyBricks: this.scheduler.pendingCount(stroke.roiId),
                message: `${options.statusPrefix}:${totalDirtyBricks}`,
            });

            const endedAt = this.now();
            const overflowCount = batches.reduce((sum, batch) => sum + batch.mesh.overflow, 0);
            const quantOverflowCount = batches.reduce((sum, batch) => sum + batch.mesh.quantOverflow, 0);
            this.emitPerformanceSample({
                metric: 'mouseup-sync',
                durationMs: endedAt - stroke.timestamp,
                timestamp: endedAt,
                roiId: stroke.roiId,
                viewType: stroke.viewType,
                overflowCount,
                quantOverflowCount,
                batchCount: batches.length,
            });

            return result;
        });
    }

    private buildStroke(
        centerMM: Vec3MM,
        viewType: MPRViewType,
        phase: 'preview' | 'commit',
        timestamp: number
    ): BrushStroke {
        return {
            roiId: this.activeROI,
            centerMM,
            radiusMM: this.brushRadiusMM,
            erase: this.eraseMode,
            viewType,
            phase,
            timestamp,
        };
    }

    private createReplayStroke(original: BrushStroke, erase: boolean): BrushStroke {
        return {
            ...original,
            erase,
            phase: 'commit',
            timestamp: this.now(),
        };
    }

    private pushHistoryEntry(stroke: BrushStroke, dirtyBrickKeys: string[]): void {
        this.historySequence += 1;
        this.quantOriginVersion += 1;

        const keyframe = this.createOptionalKeyframe(stroke, dirtyBrickKeys, this.historySequence);
        const entry: AnnotationHistoryEntry = {
            id: this.historySequence,
            stroke: { ...stroke, centerMM: [...stroke.centerMM] as Vec3MM },
            dirtyBrickKeys: [...dirtyBrickKeys],
            createdAt: stroke.timestamp,
            keyframe,
        };

        this.history.push(entry);
        if (keyframe) {
            this.latestKeyframe = keyframe;
        }

        if (this.history.length > this.historyLimit) {
            const removed = this.history.shift();
            if (removed?.keyframe && this.latestKeyframe?.index === removed.keyframe.index) {
                this.recomputeLatestKeyframe();
            }
        }
    }

    private createOptionalKeyframe(
        stroke: BrushStroke,
        dirtyBrickKeys: string[],
        index: number
    ): AnnotationHistoryKeyframe | undefined {
        if (index % this.historyKeyframeInterval !== 0) {
            return undefined;
        }
        return {
            index,
            roiId: stroke.roiId,
            activeROI: this.activeROI,
            brushRadiusMM: this.brushRadiusMM,
            eraseMode: this.eraseMode,
            dirtyBrickKeys: [...dirtyBrickKeys],
            quantOriginVersion: this.quantOriginVersion,
        };
    }

    private recomputeLatestKeyframe(): void {
        this.latestKeyframe = undefined;
        for (let i = this.history.length - 1; i >= 0; i--) {
            const keyframe = this.history[i].keyframe;
            if (keyframe) {
                this.latestKeyframe = keyframe;
                break;
            }
        }
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

    private emitPerformanceSample(sample: AnnotationPerformanceSample): void {
        this.onPerformanceSample?.({
            ...sample,
            durationMs: Math.max(0, sample.durationMs),
        });
    }

    private resolveSyncTargets(centerMM: Vec3MM): ViewSyncTargetMap {
        return {
            axial: this.worldToSliceIndex(centerMM[2], this.sliceBounds.axial),
            sagittal: this.worldToSliceIndex(centerMM[0], this.sliceBounds.sagittal),
            coronal: this.worldToSliceIndex(centerMM[1], this.sliceBounds.coronal),
        };
    }

    private applyBooleanToROIState(
        roiId: number,
        dirtyBrickKeys: DirtyBrickKey[],
        erase: boolean
    ): DirtyBrickKey[] {
        let activeCounts = this.roiActiveDirtyBricks.get(roiId);
        if (!activeCounts) {
            activeCounts = new Map<DirtyBrickKey, number>();
            this.roiActiveDirtyBricks.set(roiId, activeCounts);
        }

        if (erase) {
            for (const key of dirtyBrickKeys) {
                const count = activeCounts.get(key) ?? 0;
                if (count <= 1) {
                    activeCounts.delete(key);
                } else {
                    activeCounts.set(key, count - 1);
                }
            }
        } else {
            for (const key of dirtyBrickKeys) {
                const count = activeCounts.get(key) ?? 0;
                activeCounts.set(key, count + 1);
            }
        }

        return Array.from(activeCounts.keys());
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
