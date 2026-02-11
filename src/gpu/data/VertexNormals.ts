import type { QuantMeta, VertexQEncoded } from './VertexQ';
import { decodeVertexQ } from './VertexQ';

const EPSILON = 1e-12;

function normalize3(x: number, y: number, z: number): [number, number, number] {
    const len = Math.hypot(x, y, z);
    if (len <= EPSILON) {
        return [0, 0, 1];
    }
    return [x / len, y / len, z / len];
}

/**
 * 基于三角面累加生成每顶点法线。
 * 输出布局为 vec4<f32> 数组，w 固定为 0，与 WGSL 读取布局一致。
 */
export function computeVertexNormals(
    vertices: VertexQEncoded[],
    indices: number[],
    meta: QuantMeta
): Float32Array {
    const count = vertices.length;
    const accum = new Float32Array(count * 3);
    const decoded = vertices.map((v) => decodeVertexQ(v, meta));

    for (let i = 0; i + 2 < indices.length; i += 3) {
        const ia = indices[i] ?? -1;
        const ib = indices[i + 1] ?? -1;
        const ic = indices[i + 2] ?? -1;
        if (ia < 0 || ib < 0 || ic < 0 || ia >= count || ib >= count || ic >= count) {
            continue;
        }

        const a = decoded[ia];
        const b = decoded[ib];
        const c = decoded[ic];

        const e1x = b[0] - a[0];
        const e1y = b[1] - a[1];
        const e1z = b[2] - a[2];
        const e2x = c[0] - a[0];
        const e2y = c[1] - a[1];
        const e2z = c[2] - a[2];

        const nx = e1y * e2z - e1z * e2y;
        const ny = e1z * e2x - e1x * e2z;
        const nz = e1x * e2y - e1y * e2x;
        if ((nx * nx + ny * ny + nz * nz) <= EPSILON) {
            continue;
        }

        accum[ia * 3] += nx;
        accum[ia * 3 + 1] += ny;
        accum[ia * 3 + 2] += nz;
        accum[ib * 3] += nx;
        accum[ib * 3 + 1] += ny;
        accum[ib * 3 + 2] += nz;
        accum[ic * 3] += nx;
        accum[ic * 3 + 1] += ny;
        accum[ic * 3 + 2] += nz;
    }

    const out = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
        const [nx, ny, nz] = normalize3(
            accum[i * 3],
            accum[i * 3 + 1],
            accum[i * 3 + 2]
        );
        out[i * 4] = nx;
        out[i * 4 + 1] = ny;
        out[i * 4 + 2] = nz;
        out[i * 4 + 3] = 0;
    }
    return out;
}

