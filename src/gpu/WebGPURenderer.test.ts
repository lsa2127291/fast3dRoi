import { describe, expect, it, vi } from 'vitest';
import { WebGPURenderer } from './WebGPURenderer';

type RendererInternals = {
    canvas: HTMLCanvasElement | null;
    container: HTMLElement | null;
    resizeObserver: ResizeObserver | null;
    setupInteraction: () => void;
};

function hasMatchingCall(calls: unknown[][], eventName: string, handler: unknown): boolean {
    return calls.some((call) => call[0] === eventName && call[1] === handler);
}

describe('WebGPURenderer lifecycle cleanup', () => {
    it('destroy 时应解除全局监听并断开 ResizeObserver', () => {
        const renderer = new WebGPURenderer({} as never);
        const internals = renderer as unknown as RendererInternals;

        const container = document.createElement('div');
        const canvas = document.createElement('canvas');
        container.appendChild(canvas);

        const canvasAddSpy = vi.spyOn(canvas, 'addEventListener');
        const canvasRemoveSpy = vi.spyOn(canvas, 'removeEventListener');
        const windowAddSpy = vi.spyOn(window, 'addEventListener');
        const windowRemoveSpy = vi.spyOn(window, 'removeEventListener');

        const disconnect = vi.fn();
        internals.resizeObserver = { disconnect } as unknown as ResizeObserver;
        internals.canvas = canvas;
        internals.container = container;
        internals.setupInteraction();

        const mouseDownHandler = canvasAddSpy.mock.calls.find((call) => call[0] === 'mousedown')?.[1];
        const wheelHandler = canvasAddSpy.mock.calls.find((call) => call[0] === 'wheel')?.[1];
        const mouseMoveHandler = windowAddSpy.mock.calls.find((call) => call[0] === 'mousemove')?.[1];
        const mouseUpHandler = windowAddSpy.mock.calls.find((call) => call[0] === 'mouseup')?.[1];

        expect(mouseDownHandler).toBeDefined();
        expect(wheelHandler).toBeDefined();
        expect(mouseMoveHandler).toBeDefined();
        expect(mouseUpHandler).toBeDefined();

        renderer.destroy();

        expect(hasMatchingCall(canvasRemoveSpy.mock.calls as unknown[][], 'mousedown', mouseDownHandler)).toBe(true);
        expect(hasMatchingCall(canvasRemoveSpy.mock.calls as unknown[][], 'wheel', wheelHandler)).toBe(true);
        expect(hasMatchingCall(windowRemoveSpy.mock.calls as unknown[][], 'mousemove', mouseMoveHandler)).toBe(true);
        expect(hasMatchingCall(windowRemoveSpy.mock.calls as unknown[][], 'mouseup', mouseUpHandler)).toBe(true);
        expect(disconnect).toHaveBeenCalledTimes(1);

        canvasAddSpy.mockRestore();
        canvasRemoveSpy.mockRestore();
        windowAddSpy.mockRestore();
        windowRemoveSpy.mockRestore();
    });
});
