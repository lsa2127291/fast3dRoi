import { WORKSPACE_SIZE_MM } from '../constants';
import type { AnnotationEngine } from './AnnotationEngine';
import type { MPRViewType, Vec3MM } from './types';

export interface AnnotationInteractionControllerOptions {
    viewType?: MPRViewType;
    requireCtrlKey?: boolean;
    triggerButton?: 0 | 1 | 2;
    suppressContextMenu?: boolean;
    captureEvents?: boolean;
}

export class AnnotationInteractionController {
    private readonly viewType: MPRViewType;
    private readonly requireCtrlKey: boolean;
    private readonly triggerButton: 0 | 1 | 2;
    private readonly suppressContextMenu: boolean;
    private readonly captureEvents: boolean;
    private isDrawing = false;

    private readonly onMouseDown = (event: MouseEvent): void => {
        if (event.button !== this.triggerButton) {
            return;
        }
        if (this.requireCtrlKey && !event.ctrlKey) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        this.isDrawing = true;
        const world = this.screenToWorld(event);
        void this.engine.previewStroke(world, this.viewType);
    };

    private readonly onMouseMove = (event: MouseEvent): void => {
        if (!this.isDrawing) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        const world = this.screenToWorld(event);
        void this.engine.previewStroke(world, this.viewType);
    };

    private readonly onMouseUp = (event: MouseEvent): void => {
        if (!this.isDrawing) {
            return;
        }
        if (event.button !== this.triggerButton) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        this.isDrawing = false;
        const world = this.screenToWorld(event);
        void this.engine.commitStroke(world, this.viewType);
    };

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
    }

    attach(): void {
        this.targetElement.addEventListener('mousedown', this.onMouseDown, { capture: this.captureEvents });
        this.targetElement.addEventListener('mousemove', this.onMouseMove, { capture: this.captureEvents });
        this.targetElement.addEventListener('contextmenu', this.onContextMenu, { capture: this.captureEvents });
        window.addEventListener('mouseup', this.onMouseUp);
    }

    detach(): void {
        this.targetElement.removeEventListener('mousedown', this.onMouseDown, { capture: this.captureEvents });
        this.targetElement.removeEventListener('mousemove', this.onMouseMove, { capture: this.captureEvents });
        this.targetElement.removeEventListener('contextmenu', this.onContextMenu, { capture: this.captureEvents });
        window.removeEventListener('mouseup', this.onMouseUp);
        this.isDrawing = false;
    }

    private screenToWorld(event: MouseEvent): Vec3MM {
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
}
