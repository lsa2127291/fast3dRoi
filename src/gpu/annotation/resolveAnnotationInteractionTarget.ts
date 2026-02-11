import type { MPRViewType } from './types';

export function resolveAnnotationInteractionTarget(
    viewContainer: HTMLElement | null,
    volumeCanvas: HTMLCanvasElement | null
): HTMLElement | null {
    if (viewContainer) {
        return viewContainer;
    }
    return volumeCanvas;
}

export type AnnotationInteractionCandidateMap = Record<MPRViewType, HTMLElement | null>;
export type AnnotationInteractionTargetMap = Record<MPRViewType, HTMLElement | null>;

export function resolveAnnotationInteractionTargets(
    candidates: AnnotationInteractionCandidateMap,
    volumeCanvas: HTMLCanvasElement | null
): AnnotationInteractionTargetMap {
    return {
        axial: resolveAnnotationInteractionTarget(candidates.axial, volumeCanvas),
        sagittal: resolveAnnotationInteractionTarget(candidates.sagittal, volumeCanvas),
        coronal: resolveAnnotationInteractionTarget(candidates.coronal, volumeCanvas),
    };
}
