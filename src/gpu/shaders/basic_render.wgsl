// ========== 基础渲染着色器 ==========
// 从 VertexQ 解码顶点 → MVP 变换 → 方向光照

// --- 结构体定义 (内联，避免 WGSL import 依赖) ---

struct VertexQ {
    xy: u32,
    zf: u32,
};

struct QuantMeta {
    origin_mm: vec4<f32>,
};

struct Uniforms {
    mvp: mat4x4<f32>,
    model: mat4x4<f32>,
    color: vec4<f32>,
    light_dir: vec4<f32>,
};

// --- 绑定 ---

@group(0) @binding(0) var<storage, read> vertex_pool: array<VertexQ>;
@group(0) @binding(1) var<storage, read> index_pool: array<u32>;
@group(0) @binding(2) var<storage, read> quant_meta: array<QuantMeta>;
@group(1) @binding(0) var<uniform> uniforms: Uniforms;

// --- 工具函数 ---

fn unpack_i16(bits: u32) -> i32 {
    let v = i32(bits & 0xffffu);
    return select(v, v - 65536, v >= 32768);
}

fn decode_vertex(v: VertexQ, m: QuantMeta) -> vec3<f32> {
    let xq = unpack_i16(v.xy);
    let yq = unpack_i16(v.xy >> 16u);
    let zq = unpack_i16(v.zf);
    let local_mm = vec3<f32>(f32(xq), f32(yq), f32(zq)) * m.origin_mm.w;
    return m.origin_mm.xyz + local_mm;
}

// --- 顶点着色器 ---

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) world_normal: vec3<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vid: u32) -> VertexOutput {
    let idx = index_pool[vid];
    let v = vertex_pool[idx];
    let qmeta = quant_meta[0u];

    let pos_mm = decode_vertex(v, qmeta);

    var out: VertexOutput;
    out.position = uniforms.mvp * vec4<f32>(pos_mm, 1.0);

    // 使用相邻顶点估算法线（简化：使用面法线，在 CPU 侧预计算更好）
    // 这里暂时使用 (0,0,1) 占位，后续由 CPU 侧计算法线并传入
    out.world_normal = normalize((uniforms.model * vec4<f32>(0.0, 0.0, 1.0, 0.0)).xyz);

    return out;
}

// --- 片段着色器 ---

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let N = normalize(in.world_normal);
    let L = normalize(uniforms.light_dir.xyz);

    let ambient = 0.25;
    let diffuse = max(dot(N, L), 0.0) * 0.65;
    let specular_dir = reflect(-L, N);
    // 简化：无视角方向的高光
    let specular = pow(max(dot(specular_dir, vec3<f32>(0.0, 0.0, 1.0)), 0.0), 20.0) * 0.15;

    let color = uniforms.color.rgb * (ambient + diffuse) + vec3<f32>(specular);
    return vec4<f32>(color, uniforms.color.a);
}
