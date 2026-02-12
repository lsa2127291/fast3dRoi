import { WORKSPACE_SIZE_MM } from '../constants';
import type { AnnotationEngine } from './AnnotationEngine';
import type { MPRViewType, Vec3MM } from './types';

type PointerLikeEvent = MouseEvent | PointerEvent;

export interface AnnotationStrokeLifecycleEvent {
    viewType: MPRViewType;
}

export interface AnnotationStrokeSampleEvent extends AnnotationStrokeLifecycleEvent {
    centerMM: Vec3MM;
    brushRadiusMM: number;
    erase: boolean;
}

export interface AnnotationInteractionControllerOptions {
    viewType?: MPRViewType;
    requireCtrlKey?: boolean;
    triggerButton?: 0 | 1 | 2;
    suppressContextMenu?: boolean;
    captureEvents?: boolean;
    screenToWorld?: (event: PointerLikeEvent, viewType: MPRViewType, targetElement: HTMLElement) => Vec3MM;
    onStrokeStart?: (event: AnnotationStrokeLifecycleEvent) => void;
    onStrokeSample?: (event: AnnotationStrokeSampleEvent) => void;
    onStrokeEnd?: (event: AnnotationStrokeLifecycleEvent) => void;
}

export class AnnotationInteractionController {
    private readonly viewType: MPRViewType;
    private readonly requireCtrlKey: boolean;
    private readonly triggerButton: 0 | 1 | 2;
    private readonly suppressContextMenu: boolean;
    private readonly captureEvents: boolean;
    private readonly usePointerEvents: boolean;
    private readonly customScreenToWorld?: (
        event: PointerLikeEvent,
        viewType: MPRViewType,
        targetElement: HTMLElement
    ) => Vec3MM;
    private readonly onStrokeStart?: (event: AnnotationStrokeLifecycleEvent) => void;
    private readonly onStrokeSample?: (event: AnnotationStrokeSampleEvent) => void;
    private readonly onStrokeEnd?: (event: AnnotationStrokeLifecycleEvent) => void;
    private isDrawing = false;
    private lastStrokeSampleWorld: Vec3MM | null = null;

    private readonly onMouseDown = (event: MouseEvent): void => {
        this.beginStroke(event);
    };

    private readonly onMouseMove = (event: MouseEvent): void => {
        this.updateStroke(event);
    };

    private readonly onMouseUp = (event: MouseEvent): void => {
        this.endStroke(event);
    };

    private readonly onPointerDown = (event: PointerEvent): void => {
        if (event.pointerType !== 'mouse') {
            return;
        }
        this.beginStroke(event);
    };

    private readonly onPointerMove = (event: PointerEvent): void => {
        if (event.pointerType !== 'mouse') {
            return;
        }
        this.updateStroke(event);
    };

    private readonly onPointerUp = (event: PointerEvent): void => {
        if (event.pointerType !== 'mouse') {
            return;
        }
        this.endStroke(event);
    };

    private beginStroke(event: PointerLikeEvent): void {
        if (event.button !== this.triggerButton) {
            return;
        }
        if (this.requireCtrlKey && !event.ctrlKey) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        this.isDrawing = true;
        this.onStrokeStart?.({ viewType: this.viewType });
        const world = this.screenToWorld(event);
        this.lastStrokeSampleWorld = [...world] as Vec3MM;
        void this.engine.previewStroke(world, this.viewType);
        this.emitStrokeSample(world);
    }

    private updateStroke(event: PointerLikeEvent): void {
        if (!this.isDrawing) {
            return;
        }
        if (!this.isEventInsideTarget(event)) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        const world = this.screenToWorld(event);
        this.lastStrokeSampleWorld = [...world] as Vec3MM;
        void this.engine.previewStroke(world, this.viewType);
        this.emitStrokeSample(world);
    }

    private endStroke(event: PointerLikeEvent): void {
        if (!this.isDrawing) {
            return;
        }
        if (event.button !== this.triggerButton) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        const world = this.lastStrokeSampleWorld
            ? [...this.lastStrokeSampleWorld] as Vec3MM
            : this.screenToWorld(event);
        this.isDrawing = false;
        this.lastStrokeSampleWorld = null;
        this.onStrokeEnd?.({ viewType: this.viewType });
        void this.engine.commitStroke(world, this.viewType);
    }

    private readonly onContextMenu = (event: MouseEvent): void => {
        if (this.suppressContextMenu) {
            event.preventDefault();
        }
    };

    constructor(
        private readonly targetElement: HTMLElement,
        private readonly engine: AnnotationEngine,
        options: AnnotationInteractionControllerOptions = {}
    ) {
        this.viewType = options.viewType ?? 'axial';
        this.requireCtrlKey = options.requireCtrlKey ?? false;
        this.triggerButton = options.triggerButton ?? 2;
        this.suppressContextMenu = options.suppressContextMenu ?? true;
        this.captureEvents = options.captureEvents ?? true;
        this.usePointerEvents = typeof window !== 'undefined' && typeof window.PointerEvent !== 'undefined';
        this.customScreenToWorld = options.screenToWorld;
        this.onStrokeStart = options.onStrokeStart;
        this.onStrokeSample = options.onStrokeSample;
        this.onStrokeEnd = options.onStrokeEnd;
    }

    attach(): void {
        this.targetElement.addEventListener('contextmenu', this.onContextMenu, { capture: this.captureEvents });
        if (this.usePointerEvents) {
            this.targetElement.addEventListener('pointerdown', this.onPointerDown, { capture: this.captureEvents });
            this.targetElement.addEventListener('pointermove', this.onPointerMove, { capture: this.captureEvents });
            window.addEventListener('pointerup', this.onPointerUp);
            return;
        }
        this.targetElement.addEventListener('mousedown', this.onMouseDown, { capture: this.captureEvents });
        this.targetElement.addEventListener('mousemove', this.onMouseMove, { capture: this.captureEvents });
        window.addEventListener('mouseup', this.onMouseUp);
    }

    detach(): void {
        this.targetElement.removeEventListener('contextmenu', this.onContextMenu, { capture: this.captureEvents });
        if (this.usePointerEvents) {
            this.targetElement.removeEventListener('pointerdown', this.onPointerDown, { capture: this.captureEvents });
            this.targetElement.removeEventListener('pointermove', this.onPointerMove, { capture: this.captureEvents });
            window.removeEventListener('pointerup', this.onPointerUp);
        } else {
            this.targetElement.removeEventListener('mousedown', this.onMouseDown, { capture: this.captureEvents });
            this.targetElement.removeEventListener('mousemove', this.onMouseMove, { capture: this.captureEvents });
            window.removeEventListener('mouseup', this.onMouseUp);
        }
        this.isDrawing = false;
        this.lastStrokeSampleWorld = null;
    }

    private screenToWorld(event: PointerLikeEvent): Vec3MM {
        if (this.customScreenToWorld) {
            return this.customScreenToWorld(event, this.viewType, this.targetElement);
        }

        const rect = this.targetElement.getBoundingClientRect();
        const width = Math.max(1, rect.width);
        const height = Math.max(1, rect.height);
        const nx = (event.clientX - rect.left) / width;
        const ny = (event.clientY - rect.top) / height;

        const screenX = (nx - 0.5) * WORKSPACE_SIZE_MM;
        const screenY = (0.5 - ny) * WORKSPACE_SIZE_MM;

        // 根据视图类型映射到正确的 3D 世界坐标轴
        switch (this.viewType) {
            case 'axial':    // Z 切面：屏幕 X/Y → 世界 X/Y
                return [screenX, screenY, 0];
            case 'sagittal': // X 切面：屏幕 X/Y → 世界 Y/Z
                return [0, screenX, screenY];
            case 'coronal':  // Y 切面：屏幕 X/Y → 世界 X/Z
                return [screenX, 0, screenY];
        }
    }

    private emitStrokeSample(centerMM: Vec3MM): void {
        if (!this.onStrokeSample) {
            return;
        }

        this.onStrokeSample({
            viewType: this.viewType,
            centerMM: [...centerMM] as Vec3MM,
            brushRadiusMM: this.engine.getBrushRadius(),
            erase: this.engine.getEraseMode(),
        });
    }

    private isEventInsideTarget(event: PointerLikeEvent): boolean {
        const rect = this.targetElement.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) {
            return true;
        }
        return (
            event.clientX >= rect.left
            && event.clientX <= rect.right
            && event.clientY >= rect.top
            && event.clientY <= rect.bottom
        );
    }
}
