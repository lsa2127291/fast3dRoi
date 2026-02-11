import { afterEach, describe, expect, it, vi } from 'vitest';
import { initWebGPU, resetWebGPUContext } from './WebGPUContext';

type NavigatorWithGPU = Navigator & {
    gpu?: GPU;
};

function installMockGPU(
    lostPromise: Promise<GPUDeviceLostInfo>
): void {
    const device = {
        lost: lostPromise,
        limits: {
            maxBufferSize: 2 * 1024 * 1024 * 1024,
            maxStorageBufferBindingSize: 1024 * 1024 * 1024,
            maxComputeInvocationsPerWorkgroup: 256,
            maxComputeWorkgroupStorageSize: 32 * 1024,
        },
    } as unknown as GPUDevice;

    const adapter = {
        features: new Set<GPUFeatureName>([
            'subgroups' as GPUFeatureName,
            'shader-f16' as GPUFeatureName,
            'timestamp-query' as GPUFeatureName,
        ]),
        limits: {
            maxBufferSize: 2 * 1024 * 1024 * 1024,
            maxStorageBufferBindingSize: 1024 * 1024 * 1024,
            maxComputeInvocationsPerWorkgroup: 256,
            maxComputeWorkgroupStorageSize: 32 * 1024,
        },
        requestDevice: vi.fn(async () => device),
    } as unknown as GPUAdapter;

    const gpu = {
        requestAdapter: vi.fn(async () => adapter),
        getPreferredCanvasFormat: vi.fn(() => 'bgra8unorm'),
    } as unknown as GPU;

    Object.defineProperty(navigator, 'gpu', {
        configurable: true,
        value: gpu,
    });
}

describe('WebGPUContext device lost recovery hook', () => {
    afterEach(() => {
        resetWebGPUContext();
        delete (navigator as NavigatorWithGPU).gpu;
    });

    it('should invoke onDeviceLost callback when device is lost', async () => {
        let resolveLost: ((info: GPUDeviceLostInfo) => void) | null = null;
        const lostPromise = new Promise<GPUDeviceLostInfo>((resolve) => {
            resolveLost = resolve;
        });

        installMockGPU(lostPromise);
        const onDeviceLost = vi.fn();
        await initWebGPU({ onDeviceLost });

        resolveLost?.({ reason: 'unknown', message: 'mock-lost' } as GPUDeviceLostInfo);
        await Promise.resolve();
        await Promise.resolve();

        expect(onDeviceLost).toHaveBeenCalledTimes(1);
        expect(onDeviceLost).toHaveBeenCalledWith(
            expect.objectContaining({
                reason: 'unknown',
                message: 'mock-lost',
            })
        );
    });
});

