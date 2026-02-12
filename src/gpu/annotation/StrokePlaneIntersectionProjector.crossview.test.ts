import { describe, expect, it } from 'vitest';
import type { MPRViewType, Vec3MM } from './types';
import {
    type StrokeProjectionSample,
    projectStrokeByPlaneIntersection,
} from './StrokePlaneIntersectionProjector';

const CROSS_HALF_MM = 20;
const BRUSH_RADIUS_MM = 5;
const TARGET_SLICE_COUNT = 11;
const TARGET_SLICE_INDEX = 5;
const TARGET_SLICE_SPAN_MM = 100;

function vecToKey(point: Vec3MM): string {
    return `${point[0].toFixed(6)},${point[1].toFixed(6)},${point[2].toFixed(6)}`;
}

function uniqueSortedPointKeys(samples: Array<{ centerMM: Vec3MM }>): string[] {
    return Array.from(new Set(samples.map((sample) => vecToKey(sample.centerMM)))).sort();
}

function assertProjectedCoordinatesEqual(
    source: StrokeProjectionSample[],
    targetViewType: MPRViewType,
    expectedCenters: Vec3MM[]
): void {
    const projected = projectStrokeByPlaneIntersection({
        source,
        targetViewType,
        targetSliceCount: TARGET_SLICE_COUNT,
        targetSliceIndex: TARGET_SLICE_INDEX,
        targetSliceSpanMM: TARGET_SLICE_SPAN_MM,
    });

    const actualKeys = uniqueSortedPointKeys(projected);
    const expectedKeys = uniqueSortedPointKeys(expectedCenters.map((centerMM) => ({ centerMM })));
    expect(actualKeys).toEqual(expectedKeys);
}

function createCenterCrossStroke(sourceViewType: MPRViewType): StrokeProjectionSample[] {
    switch (sourceViewType) {
        case 'axial':
            return [
                { centerMM: [-CROSS_HALF_MM, 0, 0], radiusMM: BRUSH_RADIUS_MM, erase: false, strokeStart: true },
                { centerMM: [CROSS_HALF_MM, 0, 0], radiusMM: BRUSH_RADIUS_MM, erase: false, strokeStart: false },
                { centerMM: [0, -CROSS_HALF_MM, 0], radiusMM: BRUSH_RADIUS_MM, erase: false, strokeStart: true },
                { centerMM: [0, CROSS_HALF_MM, 0], radiusMM: BRUSH_RADIUS_MM, erase: false, strokeStart: false },
            ];
        case 'sagittal':
            return [
                { centerMM: [0, -CROSS_HALF_MM, 0], radiusMM: BRUSH_RADIUS_MM, erase: false, strokeStart: true },
                { centerMM: [0, CROSS_HALF_MM, 0], radiusMM: BRUSH_RADIUS_MM, erase: false, strokeStart: false },
                { centerMM: [0, 0, -CROSS_HALF_MM], radiusMM: BRUSH_RADIUS_MM, erase: false, strokeStart: true },
                { centerMM: [0, 0, CROSS_HALF_MM], radiusMM: BRUSH_RADIUS_MM, erase: false, strokeStart: false },
            ];
        case 'coronal':
            return [
                { centerMM: [-CROSS_HALF_MM, 0, 0], radiusMM: BRUSH_RADIUS_MM, erase: false, strokeStart: true },
                { centerMM: [CROSS_HALF_MM, 0, 0], radiusMM: BRUSH_RADIUS_MM, erase: false, strokeStart: false },
                { centerMM: [0, 0, -CROSS_HALF_MM], radiusMM: BRUSH_RADIUS_MM, erase: false, strokeStart: true },
                { centerMM: [0, 0, CROSS_HALF_MM], radiusMM: BRUSH_RADIUS_MM, erase: false, strokeStart: false },
            ];
    }
}

describe('projectStrokeByPlaneIntersection cross-view strict coordinates', () => {
    it('axial center cross should map to expected sagittal/coronal coordinates', () => {
        const source = createCenterCrossStroke('axial');

        assertProjectedCoordinatesEqual(source, 'sagittal', [
            [0, -CROSS_HALF_MM, 0],
            [0, 0, 0],
            [0, CROSS_HALF_MM, 0],
        ]);

        assertProjectedCoordinatesEqual(source, 'coronal', [
            [-CROSS_HALF_MM, 0, 0],
            [0, 0, 0],
            [CROSS_HALF_MM, 0, 0],
        ]);
    });

    it('sagittal center cross should map to expected axial/coronal coordinates', () => {
        const source = createCenterCrossStroke('sagittal');

        assertProjectedCoordinatesEqual(source, 'axial', [
            [0, -CROSS_HALF_MM, 0],
            [0, 0, 0],
            [0, CROSS_HALF_MM, 0],
        ]);

        assertProjectedCoordinatesEqual(source, 'coronal', [
            [0, 0, -CROSS_HALF_MM],
            [0, 0, 0],
            [0, 0, CROSS_HALF_MM],
        ]);
    });

    it('coronal center cross should map to expected axial/sagittal coordinates', () => {
        const source = createCenterCrossStroke('coronal');

        assertProjectedCoordinatesEqual(source, 'axial', [
            [-CROSS_HALF_MM, 0, 0],
            [0, 0, 0],
            [CROSS_HALF_MM, 0, 0],
        ]);

        assertProjectedCoordinatesEqual(source, 'sagittal', [
            [0, 0, -CROSS_HALF_MM],
            [0, 0, 0],
            [0, 0, CROSS_HALF_MM],
        ]);
    });
});
