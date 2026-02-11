import { WORKSPACE_SIZE_MM } from '../constants';
import type { AnnotationEngine } from './AnnotationEngine';
import type { MPRViewType, Vec3MM } from './types';

export interface AnnotationInteractionControllerOptions {
    viewType?: MPRViewType;
    requireCtrlKey?: boolean;
}

export class AnnotationInteractionController {
    private readonly viewType: MPRViewType;
    private readonly requireCtrlKey: boolean;
    private isDrawing = false;

    private readonly onMouseDown = (event: MouseEvent): void => {
        if (event.button !== 0) {
            return;
        }
        if (this.requireCtrlKey && !event.ctrlKey) {
            return;
        }
        this.isDrawing = true;
        const world = this.screenToWorld(event);
        void this.engine.previewStroke(world, this.viewType);
    };

    private readonly onMouseMove = (event: MouseEvent): void => {
        if (!this.isDrawing) {
            return;
        }
        const world = this.screenToWorld(event);
        void this.engine.previewStroke(world, this.viewType);
    };

    private readonly onMouseUp = (event: MouseEvent): void => {
        if (!this.isDrawing) {
            return;
        }
        this.isDrawing = false;
        const world = this.screenToWorld(event);
        void this.engine.commitStroke(world, this.viewType);
    };

    constructor(
        private readonly canvas: HTMLCanvasElement,
        private readonly engine: AnnotationEngine,
        options: AnnotationInteractionControllerOptions = {}
    ) {
        this.viewType = options.viewType ?? 'axial';
        this.requireCtrlKey = options.requireCtrlKey ?? true;
    }

    attach(): void {
        this.canvas.addEventListener('mousedown', this.onMouseDown);
        this.canvas.addEventListener('mousemove', this.onMouseMove);
        window.addEventListener('mouseup', this.onMouseUp);
    }

    detach(): void {
        this.canvas.removeEventListener('mousedown', this.onMouseDown);
        this.canvas.removeEventListener('mousemove', this.onMouseMove);
        window.removeEventListener('mouseup', this.onMouseUp);
        this.isDrawing = false;
    }

    private screenToWorld(event: MouseEvent): Vec3MM {
        const rect = this.canvas.getBoundingClientRect();
        const width = Math.max(1, rect.width);
        const height = Math.max(1, rect.height);
        const nx = (event.clientX - rect.left) / width;
        const ny = (event.clientY - rect.top) / height;

        const worldX = (nx - 0.5) * WORKSPACE_SIZE_MM;
        const worldY = (0.5 - ny) * WORKSPACE_SIZE_MM;
        const worldZ = 0;
        return [worldX, worldY, worldZ];
    }
}
