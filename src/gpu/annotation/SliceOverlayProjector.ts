import type { MPRViewType, Vec3MM } from './types';

export interface OverlayProjectionInput {
    viewType: MPRViewType;
    centerMM: Vec3MM;
    radiusMM: number;
    workspaceSizeMM: number;
}

export interface OverlayProjectionResult {
    cx: number;
    cy: number;
    rx: number;
    ry: number;
}

export interface CircularOverlayPixelRadiiInput {
    radiusNorm: number;
    viewportWidth: number;
    viewportHeight: number;
    minRadiusPx?: number;
}

export interface CircularOverlayPixelRadiiResult {
    rxPx: number;
    ryPx: number;
}

function clamp01(value: number): number {
    return Math.min(1, Math.max(0, value));
}

function normalizeAxis(valueMM: number, workspaceSizeMM: number): number {
    return clamp01(valueMM / workspaceSizeMM + 0.5);
}

function normalizeY(valueMM: number, workspaceSizeMM: number): number {
    return clamp01(0.5 - valueMM / workspaceSizeMM);
}

export function projectOverlayCircle(input: OverlayProjectionInput): OverlayProjectionResult {
    const workspaceSizeMM = Math.max(1, input.workspaceSizeMM);
    const radiusNorm = Math.max(0, input.radiusMM / workspaceSizeMM);

    let cx = 0.5;
    let cy = 0.5;
    switch (input.viewType) {
        case 'axial':
            cx = normalizeAxis(input.centerMM[0], workspaceSizeMM);
            cy = normalizeY(input.centerMM[1], workspaceSizeMM);
            break;
        case 'sagittal':
            cx = normalizeAxis(input.centerMM[1], workspaceSizeMM);
            cy = normalizeY(input.centerMM[2], workspaceSizeMM);
            break;
        case 'coronal':
            cx = normalizeAxis(input.centerMM[0], workspaceSizeMM);
            cy = normalizeY(input.centerMM[2], workspaceSizeMM);
            break;
    }

    return {
        cx,
        cy,
        rx: radiusNorm,
        ry: radiusNorm,
    };
}

export function computeCircularOverlayPixelRadii(
    input: CircularOverlayPixelRadiiInput
): CircularOverlayPixelRadiiResult {
    const width = Math.max(1, input.viewportWidth);
    const height = Math.max(1, input.viewportHeight);
    const minRadiusPx = Math.max(0, input.minRadiusPx ?? 2);
    const baseRadius = Math.max(minRadiusPx, Math.max(0, input.radiusNorm) * Math.min(width, height));
    return {
        rxPx: baseRadius,
        ryPx: baseRadius,
    };
}
