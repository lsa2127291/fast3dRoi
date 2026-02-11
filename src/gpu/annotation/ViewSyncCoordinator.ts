import { MPRSlicePipeline } from './MPRSlicePipeline';
import type {
    MPRSlicePipelineLike,
    MPRViewType,
    ViewSyncCoordinatorLike,
    ViewSyncEvent,
    ViewSyncRequest,
} from './types';

export interface ViewSyncCoordinatorOptions {
    slicePipeline?: MPRSlicePipelineLike;
    onSliceSync?: (update: { viewType: MPRViewType; sliceIndex: number }) => void;
    onSync?: (event: ViewSyncEvent) => void;
    lineBudget?: number;
}

const SYNC_ORDER: MPRViewType[] = ['axial', 'sagittal', 'coronal'];

export class ViewSyncCoordinator implements ViewSyncCoordinatorLike {
    private readonly slicePipeline: MPRSlicePipelineLike;
    private readonly onSliceSync?: (update: { viewType: MPRViewType; sliceIndex: number }) => void;
    private readonly onSync?: (event: ViewSyncEvent) => void;

    constructor(options: ViewSyncCoordinatorOptions = {}) {
        this.slicePipeline = options.slicePipeline ?? new MPRSlicePipeline({
            lineBudget: options.lineBudget,
        });
        this.onSliceSync = options.onSliceSync;
        this.onSync = options.onSync;
    }

    async syncAfterCommit(request: ViewSyncRequest): Promise<ViewSyncEvent> {
        const sliceResult = await this.slicePipeline.extractSlices({
            roiId: request.roiId,
            dirtyBrickKeys: request.dirtyBrickKeys,
            targets: [
                { viewType: 'axial', sliceIndex: request.targets.axial },
                { viewType: 'sagittal', sliceIndex: request.targets.sagittal },
                { viewType: 'coronal', sliceIndex: request.targets.coronal },
            ],
        });

        for (const viewType of SYNC_ORDER) {
            this.onSliceSync?.({
                viewType,
                sliceIndex: sliceResult.viewResults[viewType].sliceIndex,
            });
        }

        const event: ViewSyncEvent = {
            ...sliceResult,
            centerMM: request.centerMM,
            brushRadiusMM: request.brushRadiusMM,
            erase: request.erase,
            targets: request.targets,
        };
        this.onSync?.(event);
        return event;
    }
}
