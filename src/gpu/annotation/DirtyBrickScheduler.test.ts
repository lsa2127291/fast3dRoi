import { describe, expect, it } from 'vitest';
import { DIRTY_BRICK_LIMIT } from '../constants';
import { DirtyBrickScheduler } from './DirtyBrickScheduler';

function buildBrickKeys(count: number): string[] {
    return Array.from({ length: count }, (_, i) => `${i}_0_0`);
}

describe('DirtyBrickScheduler', () => {
    it('should split dirty bricks by dirty_limit', () => {
        const scheduler = new DirtyBrickScheduler(DIRTY_BRICK_LIMIT);
        const roiId = 3;
        const total = DIRTY_BRICK_LIMIT + 5;

        scheduler.enqueue(roiId, buildBrickKeys(total));

        const first = scheduler.drainNextBatch(roiId);
        const second = scheduler.drainNextBatch(roiId);

        expect(first).toHaveLength(DIRTY_BRICK_LIMIT);
        expect(second).toHaveLength(5);
        expect(scheduler.hasPending(roiId)).toBe(false);
    });

    it('should deduplicate dirty bricks for the same ROI', () => {
        const scheduler = new DirtyBrickScheduler(4);
        const roiId = 9;

        scheduler.enqueue(roiId, ['1_2_3', '1_2_3', '4_5_6']);

        expect(scheduler.pendingCount(roiId)).toBe(2);
        expect(scheduler.drainNextBatch(roiId).sort()).toEqual(['1_2_3', '4_5_6']);
    });

    it('should keep queues isolated between ROIs', () => {
        const scheduler = new DirtyBrickScheduler(2);

        scheduler.enqueue(1, ['1_0_0', '2_0_0', '3_0_0']);
        scheduler.enqueue(2, ['a_0_0']);

        expect(scheduler.drainNextBatch(1)).toEqual(['1_0_0', '2_0_0']);
        expect(scheduler.drainNextBatch(2)).toEqual(['a_0_0']);
        expect(scheduler.drainNextBatch(1)).toEqual(['3_0_0']);
    });
});
