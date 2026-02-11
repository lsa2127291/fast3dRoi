import { describe, expect, it } from 'vitest';
import {
    resolveAnnotationInteractionTarget,
    resolveAnnotationInteractionTargets,
} from './resolveAnnotationInteractionTarget';

describe('resolveAnnotationInteractionTarget', () => {
    it('should prefer axial container when available', () => {
        const axial = document.createElement('div');
        const volumeCanvas = document.createElement('canvas');

        const target = resolveAnnotationInteractionTarget(axial, volumeCanvas);
        expect(target).toBe(axial);
    });

    it('should fall back to volume canvas when axial container is missing', () => {
        const volumeCanvas = document.createElement('canvas');

        const target = resolveAnnotationInteractionTarget(null, volumeCanvas);
        expect(target).toBe(volumeCanvas);
    });

    it('should return null when both candidates are missing', () => {
        const target = resolveAnnotationInteractionTarget(null, null);
        expect(target).toBeNull();
    });

    it('should resolve axial/sagittal/coronal targets independently', () => {
        const axial = document.createElement('div');
        const sagittal = document.createElement('div');
        const coronal = document.createElement('div');
        const volumeCanvas = document.createElement('canvas');

        const targets = resolveAnnotationInteractionTargets(
            { axial, sagittal, coronal },
            volumeCanvas
        );

        expect(targets.axial).toBe(axial);
        expect(targets.sagittal).toBe(sagittal);
        expect(targets.coronal).toBe(coronal);
    });

    it('should fall back each missing view target to volume canvas', () => {
        const volumeCanvas = document.createElement('canvas');
        const targets = resolveAnnotationInteractionTargets(
            { axial: null, sagittal: null, coronal: null },
            volumeCanvas
        );

        expect(targets.axial).toBe(volumeCanvas);
        expect(targets.sagittal).toBe(volumeCanvas);
        expect(targets.coronal).toBe(volumeCanvas);
    });
});
