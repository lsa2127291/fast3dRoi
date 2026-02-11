import { describe, expect, it } from 'vitest';
import { MarchingCubesPipeline } from './MarchingCubesPipeline';
import type { MarchingCubesDispatchState } from './types';

describe('MarchingCubesPipeline retry policy', () => {
    it('should retry with doubled capacity on overflow', async () => {
        const calls: number[] = [];
        const pipeline = new MarchingCubesPipeline({
            maxRetries: 3,
            dispatchKernel: async (state) => {
                calls.push(state.capacity);
                if (calls.length === 1) {
                    return { overflow: 2, quantOverflow: 0, vertexCount: state.capacity, indexCount: 0 };
                }
                return { overflow: 0, quantOverflow: 0, vertexCount: 16, indexCount: 24 };
            },
        });

        const result = await pipeline.dispatchWithRetry({
            roiId: 1,
            dirtyBrickKeys: ['0_0_0'],
            initialCapacity: 32,
            quantOriginMM: [0, 0, 0],
        });

        expect(calls).toEqual([32, 64]);
        expect(result.attempts).toBe(2);
        expect(result.vertexCount).toBe(16);
        expect(result.rerunReason).toBe('overflow');
    });

    it('should retry with relocated origin on quantOverflow', async () => {
        const origins: MarchingCubesDispatchState['quantOriginMM'][] = [];
        const pipeline = new MarchingCubesPipeline({
            maxRetries: 3,
            dispatchKernel: async (state) => {
                origins.push(state.quantOriginMM);
                if (origins.length === 1) {
                    return { overflow: 0, quantOverflow: 1, vertexCount: 0, indexCount: 0 };
                }
                return { overflow: 0, quantOverflow: 0, vertexCount: 8, indexCount: 12 };
            },
        });

        const result = await pipeline.dispatchWithRetry({
            roiId: 5,
            dirtyBrickKeys: ['0_0_0'],
            initialCapacity: 32,
            quantOriginMM: [0, 0, 0],
            quantFallbackOriginMM: [12, -8, 4],
        });

        expect(origins).toEqual([[0, 0, 0], [12, -8, 4]]);
        expect(result.attempts).toBe(2);
        expect(result.rerunReason).toBe('quantOverflow');
    });

    it('should throw when retries are exhausted', async () => {
        const pipeline = new MarchingCubesPipeline({
            maxRetries: 2,
            dispatchKernel: async () => ({
                overflow: 1,
                quantOverflow: 0,
                vertexCount: 0,
                indexCount: 0,
            }),
        });

        await expect(
            pipeline.dispatchWithRetry({
                roiId: 1,
                dirtyBrickKeys: ['0_0_0'],
                initialCapacity: 16,
                quantOriginMM: [0, 0, 0],
            })
        ).rejects.toThrow('MarchingCubes retries exhausted');
    });
});
