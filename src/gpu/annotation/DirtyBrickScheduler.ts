import { DIRTY_BRICK_LIMIT } from '../constants';
import type { DirtyBrickKey } from './types';

export class DirtyBrickScheduler {
    private readonly dirtyByRoi = new Map<number, Set<DirtyBrickKey>>();
    private readonly dirtyLimit: number;

    constructor(dirtyLimit: number = DIRTY_BRICK_LIMIT) {
        this.dirtyLimit = Math.max(1, Math.floor(dirtyLimit));
    }

    enqueue(roiId: number, dirtyBrickKeys: Iterable<DirtyBrickKey>): void {
        const bucket = this.dirtyByRoi.get(roiId) ?? new Set<DirtyBrickKey>();
        for (const key of dirtyBrickKeys) {
            bucket.add(key);
        }
        if (bucket.size > 0) {
            this.dirtyByRoi.set(roiId, bucket);
        }
    }

    drainNextBatch(roiId: number): DirtyBrickKey[] {
        const bucket = this.dirtyByRoi.get(roiId);
        if (!bucket || bucket.size === 0) {
            return [];
        }

        const batch: DirtyBrickKey[] = [];
        for (const key of bucket) {
            batch.push(key);
            bucket.delete(key);
            if (batch.length >= this.dirtyLimit) {
                break;
            }
        }

        if (bucket.size === 0) {
            this.dirtyByRoi.delete(roiId);
        }

        return batch;
    }

    pendingCount(roiId: number): number {
        return this.dirtyByRoi.get(roiId)?.size ?? 0;
    }

    hasPending(roiId: number): boolean {
        return this.pendingCount(roiId) > 0;
    }

    clear(roiId: number): void {
        this.dirtyByRoi.delete(roiId);
    }
}
