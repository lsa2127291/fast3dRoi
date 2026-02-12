import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnnotationInteractionController } from './AnnotationInteractionController';
import type { AnnotationEngine } from './AnnotationEngine';

function createMockEngine(): AnnotationEngine {
    return {
        previewStroke: vi.fn().mockResolvedValue(undefined),
        commitStroke: vi.fn().mockResolvedValue({
            batches: [],
            totalDirtyBricks: 0,
            totalVertexCount: 0,
            totalIndexCount: 0,
            totalOverflow: 0,
            totalQuantOverflow: 0,
            totalAttempts: 0,
        }),
        getBrushRadius: vi.fn().mockReturnValue(5),
        getEraseMode: vi.fn().mockReturnValue(false),
    } as unknown as AnnotationEngine;
}

function getEngineSpies(engine: AnnotationEngine): {
    previewStroke: ReturnType<typeof vi.fn>;
    commitStroke: ReturnType<typeof vi.fn>;
} {
    const previewStroke = engine.previewStroke as unknown as ReturnType<typeof vi.fn>;
    const commitStroke = engine.commitStroke as unknown as ReturnType<typeof vi.fn>;
    return { previewStroke, commitStroke };
}

describe('AnnotationInteractionController', () => {
    afterEach(() => {
        document.body.innerHTML = '';
    });

    it('should start drawing with left mouse button when triggerButton is configured to 0', () => {
        const canvas = document.createElement('canvas');
        document.body.appendChild(canvas);
        const engine = createMockEngine();
        const { previewStroke, commitStroke } = getEngineSpies(engine);
        const controller = new AnnotationInteractionController(canvas, engine, {
            viewType: 'axial',
            triggerButton: 0,
        });

        controller.attach();

        canvas.dispatchEvent(new MouseEvent('mousedown', {
            button: 2,
            clientX: 10,
            clientY: 20,
            bubbles: true,
        }));
        canvas.dispatchEvent(new MouseEvent('mousemove', {
            button: 2,
            clientX: 11,
            clientY: 21,
            bubbles: true,
        }));
        window.dispatchEvent(new MouseEvent('mouseup', {
            button: 2,
            clientX: 12,
            clientY: 22,
            bubbles: true,
        }));

        expect(previewStroke).not.toHaveBeenCalled();
        expect(commitStroke).not.toHaveBeenCalled();

        canvas.dispatchEvent(new MouseEvent('mousedown', {
            button: 0,
            clientX: 13,
            clientY: 23,
            bubbles: true,
        }));
        canvas.dispatchEvent(new MouseEvent('mousemove', {
            button: 0,
            clientX: 14,
            clientY: 24,
            bubbles: true,
        }));
        window.dispatchEvent(new MouseEvent('mouseup', {
            button: 0,
            clientX: 15,
            clientY: 25,
            bubbles: true,
        }));

        expect(previewStroke).toHaveBeenCalledTimes(2);
        expect(commitStroke).toHaveBeenCalledTimes(1);

        controller.detach();
    });

    it('should only start drawing with right mouse button by default', () => {
        const canvas = document.createElement('canvas');
        document.body.appendChild(canvas);
        const engine = createMockEngine();
        const { previewStroke, commitStroke } = getEngineSpies(engine);
        const controller = new AnnotationInteractionController(canvas, engine, { viewType: 'axial' });

        controller.attach();

        canvas.dispatchEvent(new MouseEvent('mousedown', {
            button: 0,
            clientX: 10,
            clientY: 20,
            bubbles: true,
        }));
        canvas.dispatchEvent(new MouseEvent('mousemove', {
            button: 0,
            clientX: 11,
            clientY: 21,
            bubbles: true,
        }));
        window.dispatchEvent(new MouseEvent('mouseup', {
            button: 0,
            clientX: 12,
            clientY: 22,
            bubbles: true,
        }));

        expect(previewStroke).not.toHaveBeenCalled();
        expect(commitStroke).not.toHaveBeenCalled();

        canvas.dispatchEvent(new MouseEvent('mousedown', {
            button: 2,
            clientX: 13,
            clientY: 23,
            bubbles: true,
        }));
        canvas.dispatchEvent(new MouseEvent('mousemove', {
            button: 2,
            clientX: 14,
            clientY: 24,
            bubbles: true,
        }));
        window.dispatchEvent(new MouseEvent('mouseup', {
            button: 2,
            clientX: 15,
            clientY: 25,
            bubbles: true,
        }));

        expect(previewStroke).toHaveBeenCalledTimes(2);
        expect(commitStroke).toHaveBeenCalledTimes(1);

        controller.detach();
    });

    it('should only commit once on mouseup while right-button dragging', () => {
        const canvas = document.createElement('canvas');
        document.body.appendChild(canvas);
        const engine = createMockEngine();
        const { commitStroke } = getEngineSpies(engine);
        const controller = new AnnotationInteractionController(canvas, engine, { viewType: 'axial' });

        controller.attach();

        canvas.dispatchEvent(new MouseEvent('mousedown', {
            button: 2,
            clientX: 20,
            clientY: 20,
            bubbles: true,
        }));
        canvas.dispatchEvent(new MouseEvent('mousemove', {
            button: 2,
            clientX: 24,
            clientY: 24,
            bubbles: true,
        }));
        canvas.dispatchEvent(new MouseEvent('mousemove', {
            button: 2,
            clientX: 28,
            clientY: 28,
            bubbles: true,
        }));
        window.dispatchEvent(new MouseEvent('mouseup', {
            button: 2,
            clientX: 32,
            clientY: 32,
            bubbles: true,
        }));

        expect(commitStroke).toHaveBeenCalledTimes(1);

        controller.detach();
    });

    it('should prevent browser context menu while controller is attached', () => {
        const canvas = document.createElement('canvas');
        document.body.appendChild(canvas);
        const engine = createMockEngine();
        const controller = new AnnotationInteractionController(canvas, engine, { viewType: 'axial' });

        controller.attach();

        const contextEvent = new MouseEvent('contextmenu', {
            button: 2,
            bubbles: true,
            cancelable: true,
        });
        const dispatchResult = canvas.dispatchEvent(contextEvent);

        expect(dispatchResult).toBe(false);
        expect(contextEvent.defaultPrevented).toBe(true);

        controller.detach();
    });

    it('should emit stroke callbacks for local realtime overlay updates', () => {
        const canvas = document.createElement('canvas');
        document.body.appendChild(canvas);
        const engine = createMockEngine();
        const onStrokeStart = vi.fn();
        const onStrokeSample = vi.fn();
        const onStrokeEnd = vi.fn();
        const controller = new AnnotationInteractionController(canvas, engine, {
            viewType: 'axial',
            onStrokeStart,
            onStrokeSample,
            onStrokeEnd,
        });

        controller.attach();

        canvas.dispatchEvent(new MouseEvent('mousedown', {
            button: 2,
            clientX: 20,
            clientY: 20,
            bubbles: true,
        }));
        canvas.dispatchEvent(new MouseEvent('mousemove', {
            button: 2,
            clientX: 24,
            clientY: 24,
            bubbles: true,
        }));
        window.dispatchEvent(new MouseEvent('mouseup', {
            button: 2,
            clientX: 28,
            clientY: 28,
            bubbles: true,
        }));

        expect(onStrokeStart).toHaveBeenCalledTimes(1);
        expect(onStrokeEnd).toHaveBeenCalledTimes(1);
        expect(onStrokeSample).toHaveBeenCalledTimes(2);
        expect(onStrokeSample.mock.calls[1][0]).toMatchObject({
            viewType: 'axial',
            brushRadiusMM: 5,
            erase: false,
        });

        controller.detach();
    });

    it('should commit with last sampled point instead of mouseup outside viewport point', () => {
        const canvas = document.createElement('canvas');
        document.body.appendChild(canvas);
        Object.defineProperty(canvas, 'getBoundingClientRect', {
            value: () => ({
                left: 10,
                top: 10,
                width: 100,
                height: 100,
                right: 110,
                bottom: 110,
                x: 10,
                y: 10,
                toJSON: () => ({}),
            }),
        });

        const engine = createMockEngine();
        const { commitStroke } = getEngineSpies(engine);
        const controller = new AnnotationInteractionController(canvas, engine, { viewType: 'axial' });
        controller.attach();

        canvas.dispatchEvent(new MouseEvent('mousedown', {
            button: 2,
            clientX: 60,
            clientY: 60,
            bubbles: true,
        }));
        canvas.dispatchEvent(new MouseEvent('mousemove', {
            button: 2,
            clientX: 70,
            clientY: 70,
            bubbles: true,
        }));
        window.dispatchEvent(new MouseEvent('mouseup', {
            button: 2,
            clientX: -100,
            clientY: -100,
            bubbles: true,
        }));

        expect(commitStroke).toHaveBeenCalledTimes(1);
        expect(commitStroke.mock.calls[0][0][0]).toBeCloseTo(300, 6);
        expect(commitStroke.mock.calls[0][0][1]).toBeCloseTo(-300, 6);
        expect(commitStroke.mock.calls[0][0][2]).toBe(0);

        controller.detach();
    });

    it('should ignore out-of-bounds mousemove samples while dragging', () => {
        const canvas = document.createElement('canvas');
        document.body.appendChild(canvas);
        Object.defineProperty(canvas, 'getBoundingClientRect', {
            value: () => ({
                left: 10,
                top: 10,
                width: 100,
                height: 100,
                right: 110,
                bottom: 110,
                x: 10,
                y: 10,
                toJSON: () => ({}),
            }),
        });

        const engine = createMockEngine();
        const { previewStroke, commitStroke } = getEngineSpies(engine);
        const onStrokeSample = vi.fn();
        const controller = new AnnotationInteractionController(canvas, engine, {
            viewType: 'axial',
            onStrokeSample,
        });
        controller.attach();

        canvas.dispatchEvent(new MouseEvent('mousedown', {
            button: 2,
            clientX: 60,
            clientY: 60,
            bubbles: true,
        }));
        canvas.dispatchEvent(new MouseEvent('mousemove', {
            button: 2,
            clientX: 70,
            clientY: 70,
            bubbles: true,
        }));
        canvas.dispatchEvent(new MouseEvent('mousemove', {
            button: 2,
            clientX: -100,
            clientY: -100,
            bubbles: true,
        }));
        window.dispatchEvent(new MouseEvent('mouseup', {
            button: 2,
            clientX: -100,
            clientY: -100,
            bubbles: true,
        }));

        expect(onStrokeSample).toHaveBeenCalledTimes(2);
        expect(previewStroke).toHaveBeenCalledTimes(2);
        expect(commitStroke).toHaveBeenCalledTimes(1);
        expect(commitStroke.mock.calls[0][0][0]).toBeCloseTo(300, 6);
        expect(commitStroke.mock.calls[0][0][1]).toBeCloseTo(-300, 6);
        expect(commitStroke.mock.calls[0][0][2]).toBe(0);

        controller.detach();
    });
});
