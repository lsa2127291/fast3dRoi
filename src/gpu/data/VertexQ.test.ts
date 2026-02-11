import { describe, expect, it } from 'vitest';
import { QUANT_STEP_MM } from '../constants';
import {
    createDefaultQuantMeta,
    decodeVertexQ,
    getVertexFlags,
    isQuantInRange,
    packVertexQ,
    quantize,
    writeQuantMetaToBuffer,
    writeVertexQToBuffer,
} from './VertexQ';

describe('VertexQ', () => {
    it('should quantize mm coordinates with 0.1mm step', () => {
        const result = quantize([0.14, -0.06, 1.04], [0, 0, 1]);
        expect(result).toEqual({
            x: 1,
            y: -1,
            z: 0,
            inRange: true,
        });
    });

    it('should report out-of-range quantized coordinates', () => {
        const result = quantize([2000, 0, 0], [0, 0, 0]);
        expect(result.inRange).toBe(false);
        expect(isQuantInRange(result.x)).toBe(false);
    });

    it('should pack/decode VertexQ and keep flags', () => {
        const encoded = packVertexQ(-123, 456, -789, 0xabcd);
        const decoded = decodeVertexQ(encoded, {
            originMM: [10, 20, 30],
            scaleMM: QUANT_STEP_MM,
        });

        expect(decoded[0]).toBeCloseTo(-2.3, 6);
        expect(decoded[1]).toBeCloseTo(65.6, 6);
        expect(decoded[2]).toBeCloseTo(-48.9, 6);
        expect(getVertexFlags(encoded)).toBe(0xabcd);
    });

    it('should write VertexQ buffer with contiguous [xy, zf] layout', () => {
        const vertices = [
            packVertexQ(1, 2, 3, 4),
            packVertexQ(-1, -2, -3, 5),
        ];
        const buffer = new ArrayBuffer(vertices.length * 8);
        writeVertexQToBuffer(vertices, buffer, 0);

        const view = new Uint32Array(buffer);
        expect(view.length).toBe(4);
        expect(view[0]).toBe(vertices[0].xy);
        expect(view[1]).toBe(vertices[0].zf);
        expect(view[2]).toBe(vertices[1].xy);
        expect(view[3]).toBe(vertices[1].zf);
    });

    it('should write QuantMeta as vec4<f32> layout', () => {
        const metas = [
            { originMM: [1, 2, 3] as [number, number, number], scaleMM: 0.1 },
            { originMM: [4, 5, 6] as [number, number, number], scaleMM: 0.2 },
        ];
        const buffer = new ArrayBuffer(metas.length * 16);
        writeQuantMetaToBuffer(metas, buffer, 0);

        const view = new Float32Array(buffer);
        expect(view[0]).toBeCloseTo(1, 6);
        expect(view[1]).toBeCloseTo(2, 6);
        expect(view[2]).toBeCloseTo(3, 6);
        expect(view[3]).toBeCloseTo(0.1, 6);
        expect(view[4]).toBeCloseTo(4, 6);
        expect(view[5]).toBeCloseTo(5, 6);
        expect(view[6]).toBeCloseTo(6, 6);
        expect(view[7]).toBeCloseTo(0.2, 6);
    });

    it('should create default quant meta at origin with default scale', () => {
        expect(createDefaultQuantMeta()).toEqual({
            originMM: [0, 0, 0],
            scaleMM: QUANT_STEP_MM,
        });
    });
});
