import { describe, expect, it } from 'vitest';
import { createDefaultQuantMeta, packVertexQ } from './VertexQ';
import { computeVertexNormals } from './VertexNormals';

describe('computeVertexNormals', () => {
    it('should compute +Z normal for CCW triangle on XY plane', () => {
        const vertices = [
            packVertexQ(0, 0, 0, 0),
            packVertexQ(10, 0, 0, 0),
            packVertexQ(0, 10, 0, 0),
        ];

        const normals = computeVertexNormals(vertices, [0, 1, 2], createDefaultQuantMeta());
        expect(Array.from(normals)).toEqual([
            0, 0, 1, 0,
            0, 0, 1, 0,
            0, 0, 1, 0,
        ]);
    });

    it('should fallback to +Z for degenerate geometry', () => {
        const vertices = [
            packVertexQ(0, 0, 0, 0),
            packVertexQ(0, 0, 0, 0),
            packVertexQ(0, 0, 0, 0),
        ];

        const normals = computeVertexNormals(vertices, [0, 1, 2], createDefaultQuantMeta());
        expect(Array.from(normals)).toEqual([
            0, 0, 1, 0,
            0, 0, 1, 0,
            0, 0, 1, 0,
        ]);
    });
});

