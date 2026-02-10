// VertexQ: 8 bytes per vertex — 量化坐标 (§2.2)
struct VertexQ {
    xy: u32,  // low16=x(i16), high16=y(i16)
    zf: u32,  // low16=z(i16), high16=flags(u16)
};

// QuantMeta: per-chunk/ROI 原点 + 步长 (§2.3)
struct QuantMeta {
    origin_mm: vec4<f32>,  // xyz: origin(mm), w: scale_mm(固定 0.1)
};

// 计数器 — 溢出检测 (§3.2, §6.1)
struct Counters {
    vertex_count: atomic<u32>,
    index_count: atomic<u32>,
    overflow: atomic<u32>,
    quant_overflow: atomic<u32>,
};

// 间接绘制参数
struct IndirectArgs {
    vertex_count: u32,
    instance_count: u32,
    first_vertex: u32,
    first_instance: u32,
};
