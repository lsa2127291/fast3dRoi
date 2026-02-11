enable subgroups;

struct VertexQ {
    xy: u32,
    zf: u32,
};

struct QuantMeta {
    origin_mm: vec4<f32>,
};

struct Counters {
    vertex_count: atomic<u32>,
    index_count: atomic<u32>,
    overflow: atomic<u32>,
    quant_overflow: atomic<u32>,
};

struct MCParams {
    vertex_capacity: u32,
    index_capacity: u32,
    line_budget: u32,
    iso_value: f32,
};

@group(0) @binding(0) var sdf_read: texture_3d<f32>;
@group(0) @binding(1) var<storage, read_write> vertex_pool: array<VertexQ>;
@group(0) @binding(2) var<storage, read_write> index_pool: array<u32>;
@group(0) @binding(3) var<storage, read> quant_meta: array<QuantMeta>;
@group(0) @binding(4) var<storage, read_write> counters: Counters;
@group(0) @binding(5) var<uniform> params: MCParams;

fn pack_i16(v: i32) -> u32 {
    return u32(v & 0xffff);
}

fn pack_vertex_q(x: i32, y: i32, z: i32, flags: u32) -> VertexQ {
    let xy = (pack_i16(y) << 16u) | pack_i16(x);
    let zf = ((flags & 0xffffu) << 16u) | pack_i16(z);
    return VertexQ(xy, zf);
}

fn quantize_coord(p_mm: f32, origin_mm: f32, scale: f32) -> i32 {
    return i32(round((p_mm - origin_mm) / scale));
}

fn in_quant_range(q: i32) -> bool {
    return q >= -15000 && q <= 15000;
}

fn count_mask(mask: vec4<u32>) -> u32 {
    return countOneBits(mask.x) + countOneBits(mask.y) + countOneBits(mask.z) + countOneBits(mask.w);
}

fn prefix_count(mask: vec4<u32>, lane: u32) -> u32 {
    let word = lane / 32u;
    let bit = lane % 32u;

    var total = 0u;
    if (word > 0u) {
        total += countOneBits(mask.x);
    }
    if (word > 1u) {
        total += countOneBits(mask.y);
    }
    if (word > 2u) {
        total += countOneBits(mask.z);
    }

    var current = mask.x;
    if (word == 1u) {
        current = mask.y;
    } else if (word == 2u) {
        current = mask.z;
    } else if (word == 3u) {
        current = mask.w;
    }

    let lane_mask = select(0u, (1u << bit) - 1u, bit > 0u);
    total += countOneBits(current & lane_mask);
    return total;
}

@compute @workgroup_size(64)
fn main(
    @builtin(global_invocation_id) gid: vec3<u32>,
    @builtin(subgroup_invocation_id) lane: u32
) {
    let sample = vec3<i32>(
        i32(gid.x & 63u),
        i32((gid.x >> 6u) & 63u),
        i32((gid.x >> 12u) & 63u)
    );

    let sdf = textureLoad(sdf_read, sample, 0).x;
    let hit = abs(sdf) <= params.iso_value;

    let mask = subgroupBallot(hit);
    let subgroup_count = count_mask(mask);

    var subgroup_base = 0u;
    if (subgroupElect()) {
        subgroup_base = atomicAdd(&counters.vertex_count, subgroup_count);
    }
    subgroup_base = subgroupBroadcastFirst(subgroup_base);

    if (!hit) {
        return;
    }

    let lane_offset = prefix_count(mask, lane);
    let dst = subgroup_base + lane_offset;

    if (dst >= params.vertex_capacity) {
        atomicAdd(&counters.overflow, 1u);
        return;
    }

    let qmeta = quant_meta[0u];
    let pos_mm = vec3<f32>(f32(sample.x), f32(sample.y), f32(sample.z)) * qmeta.origin_mm.w + qmeta.origin_mm.xyz;
    let qx = quantize_coord(pos_mm.x, qmeta.origin_mm.x, qmeta.origin_mm.w);
    let qy = quantize_coord(pos_mm.y, qmeta.origin_mm.y, qmeta.origin_mm.w);
    let qz = quantize_coord(pos_mm.z, qmeta.origin_mm.z, qmeta.origin_mm.w);

    if (!(in_quant_range(qx) && in_quant_range(qy) && in_quant_range(qz))) {
        atomicAdd(&counters.quant_overflow, 1u);
        return;
    }

    vertex_pool[dst] = pack_vertex_q(qx, qy, qz, 0u);

    let idx = atomicAdd(&counters.index_count, 1u);
    if (idx >= params.index_capacity) {
        atomicAdd(&counters.overflow, 1u);
        return;
    }
    index_pool[idx] = dst;
}
