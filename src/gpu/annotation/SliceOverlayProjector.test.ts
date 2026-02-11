import { describe, expect, it } from 'vitest';
import { projectOverlayCircle } from './SliceOverlayProjector';

describe('SliceOverlayProjector', () => {
    it('should map axial world coordinates into normalized overlay space', () => {
        const projected = projectOverlayCircle({
            viewType: 'axial',
            centerMM: [300, -300, 0],
            radiusMM: 30,
            workspaceSizeMM: 3000,
        });

        expect(projected.cx).toBeCloseTo(0.6, 5);
        expect(projected.cy).toBeCloseTo(0.6, 5);
        expect(projected.rx).toBeCloseTo(0.01, 5);
        expect(projected.ry).toBeCloseTo(0.01, 5);
    });

    it('should project sagittal/coronal using y-z and x-z planes', () => {
        const sagittal = projectOverlayCircle({
            viewType: 'sagittal',
            centerMM: [900, 150, -450],
            radiusMM: 45,
            workspaceSizeMM: 3000,
        });
        const coronal = projectOverlayCircle({
            viewType: 'coronal',
            centerMM: [900, 150, -450],
            radiusMM: 45,
            workspaceSizeMM: 3000,
        });

        expect(sagittal.cx).toBeCloseTo(0.55, 5);
        expect(sagittal.cy).toBeCloseTo(0.65, 5);
        expect(coronal.cx).toBeCloseTo(0.8, 5);
        expect(coronal.cy).toBeCloseTo(0.65, 5);
    });
});
