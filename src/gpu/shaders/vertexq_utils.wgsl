// 符号扩展 u16 → i32，无 i16 依赖 — §2.4
fn unpack_i16(bits: u32) -> i32 {
    let v = i32(bits & 0xffffu);
    return select(v, v - 65536, v >= 32768);
}

// 解码 VertexQ → 世界空间 f32 坐标 — §2.4 规则 3
fn decode_vertex(v: VertexQ, m: QuantMeta) -> vec3<f32> {
    let xq = unpack_i16(v.xy);
    let yq = unpack_i16(v.xy >> 16u);
    let zq = unpack_i16(v.zf);
    let local_mm = vec3<f32>(f32(xq), f32(yq), f32(zq)) * m.origin_mm.w;
    return m.origin_mm.xyz + local_mm;
}

// 提取 flags 字段
fn get_vertex_flags(v: VertexQ) -> u32 {
    return (v.zf >> 16u) & 0xffffu;
}

// 量化 f32 坐标 → i32 — §2.4 规则 1
fn quantize_coord(p_mm: f32, origin_mm: f32, scale: f32) -> i32 {
    return i32(round((p_mm - origin_mm) / scale));
}

// 检查量化值范围 — §6.1
fn is_quant_in_range(q: i32) -> bool {
    return q >= -15000 && q <= 15000;
}
