export type MPRViewType = 'axial' | 'sagittal' | 'coronal';

export type AnnotationPhase = 'idle' | 'preview' | 'commit' | 'error';

export type RerunReason = 'overflow' | 'quantOverflow';

export type DirtyBrickKey = string;

export type Vec3MM = [number, number, number];

export interface BrushStroke {
    roiId: number;
    centerMM: Vec3MM;
    radiusMM: number;
    erase: boolean;
    viewType: MPRViewType;
    phase: 'preview' | 'commit';
    timestamp: number;
}

export interface AnnotationStatus {
    phase: AnnotationPhase;
    roiId: number;
    pendingDirtyBricks: number;
    message?: string;
}

export interface MPRSliceTarget {
    viewType: MPRViewType;
    sliceIndex: number;
}

export interface MPRSliceDispatchRequest {
    roiId: number;
    dirtyBrickKeys: DirtyBrickKey[];
    targets: MPRSliceTarget[];
    lineBudget?: number;
}

export interface MPRSliceDispatchState {
    roiId: number;
    dirtyBrickKeys: DirtyBrickKey[];
    targets: MPRSliceTarget[];
    lineBudget: number;
}

export interface MPRSliceDispatchCounters {
    viewType: MPRViewType;
    sliceIndex: number;
    lineCount: number;
    overflow: number;
    quantOverflow: number;
}

export interface MPRSliceViewResult extends MPRSliceDispatchCounters {
    deferredLines: number;
}

export type MPRSliceViewResultMap = Record<MPRViewType, MPRSliceViewResult>;

export interface MPRSliceResult {
    roiId: number;
    budget: number;
    budgetHit: boolean;
    totalLineCount: number;
    totalDeferredLines: number;
    overflow: number;
    quantOverflow: number;
    viewResults: MPRSliceViewResultMap;
}

export interface ViewSyncTargetMap {
    axial: number;
    sagittal: number;
    coronal: number;
}

export interface ViewSyncRequest {
    roiId: number;
    centerMM: Vec3MM;
    brushRadiusMM: number;
    erase: boolean;
    dirtyBrickKeys: DirtyBrickKey[];
    targets: ViewSyncTargetMap;
}

export interface ViewSyncEvent extends MPRSliceResult {
    centerMM: Vec3MM;
    brushRadiusMM: number;
    erase: boolean;
    targets: ViewSyncTargetMap;
}

export interface MarchingCubesDispatchCounters {
    overflow: number;
    quantOverflow: number;
    vertexCount: number;
    indexCount: number;
}

export interface MarchingCubesDispatchState {
    roiId: number;
    dirtyBrickKeys: DirtyBrickKey[];
    capacity: number;
    quantOriginMM: Vec3MM;
}

export interface MarchingCubesDispatchRequest {
    roiId: number;
    dirtyBrickKeys: DirtyBrickKey[];
    initialCapacity: number;
    quantOriginMM: Vec3MM;
    quantFallbackOriginMM?: Vec3MM;
}

export interface MarchingCubesDispatchResult extends MarchingCubesDispatchCounters {
    attempts: number;
    rerunReason?: RerunReason;
    finalCapacity?: number;
}

export interface CommitBatchResult {
    dirtyBrickKeys: DirtyBrickKey[];
    mesh: MarchingCubesDispatchResult;
}

export interface AnnotationCommitResult {
    roiId: number;
    totalDirtyBricks: number;
    totalVertexCount: number;
    totalIndexCount: number;
    batches: CommitBatchResult[];
    viewSync?: ViewSyncEvent;
}

export interface AnnotationHistoryKeyframe {
    index: number;
    roiId: number;
    activeROI: number;
    brushRadiusMM: number;
    eraseMode: boolean;
    dirtyBrickKeys: DirtyBrickKey[];
    quantOriginVersion: number;
}

export interface AnnotationHistoryEntry {
    id: number;
    stroke: BrushStroke;
    dirtyBrickKeys: DirtyBrickKey[];
    createdAt: number;
    keyframe?: AnnotationHistoryKeyframe;
}

export interface AnnotationHistorySnapshot {
    undoDepth: number;
    redoDepth: number;
    latestKeyframe?: AnnotationHistoryKeyframe;
}

export type AnnotationPerformanceMetric = 'mousemove-preview' | 'page-flip' | 'mouseup-sync';

export interface AnnotationPerformanceSample {
    metric: AnnotationPerformanceMetric;
    durationMs: number;
    timestamp: number;
    roiId?: number;
    viewType?: MPRViewType;
    overflowCount?: number;
    quantOverflowCount?: number;
    deferredLines?: number;
    batchCount?: number;
    budgetHit?: boolean;
}

export type DirtyBrickEstimator = (stroke: BrushStroke) => DirtyBrickKey[];

export interface SDFPipelineLike {
    previewStroke(stroke: BrushStroke): Promise<void>;
    applyStroke(stroke: BrushStroke, dirtyBrickKeys: DirtyBrickKey[]): Promise<void>;
}

export interface MarchingCubesPipelineLike {
    dispatchWithRetry(request: MarchingCubesDispatchRequest): Promise<MarchingCubesDispatchResult>;
}

export interface MPRSlicePipelineLike {
    extractSlices(request: MPRSliceDispatchRequest): Promise<MPRSliceResult>;
}

export interface ViewSyncCoordinatorLike {
    syncAfterCommit(request: ViewSyncRequest): Promise<ViewSyncEvent>;
}
