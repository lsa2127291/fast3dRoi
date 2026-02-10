# 仿 RayStation 勾画架构文档 2.4（Chrome 136+ / RTX 4000 Ada / i7-14700K 性能优先 + 坐标量化版）

## 0. 目标与边界

本版本在 2.3 的性能优先策略上，增加“坐标量化存储”以降低显存与带宽压力：

1. 运行前提：`Chrome 136+`。
2. 目标硬件：`RTX 4000 Ada + 64GB RAM + i7-14700K`。
3. 关键能力硬依赖：`subgroups`、`shader-f16`、`texture-formats-tier1`。
4. 空间边界：勾画工作空间固定为总范围 `3m x 3m x 3m`。
5. 坐标精度：`0.1mm`；顶点坐标采用 `Int16` 量化（通过 `u32` 打包存储）。

设计原则：`峰值性能优先 + 稳定帧时 + 结果正确 + 精度可证明`。

---

## 1. 能力策略（Fail-Fast）

### 1.1 初始化策略

- 不再做低能力 fallback（不再提供 L0 Core/r32 路径）。
- 缺少任一关键 feature 时直接启动失败并给出明确提示。
- 启动时输出 feature/limits，用于硬件基线审计。

```ts
const adapter = await navigator.gpu.requestAdapter({
  powerPreference: "high-performance",
});
if (!adapter) throw new Error("No WebGPU adapter");

const required: GPUFeatureName[] = [
  "subgroups",
  "shader-f16",
  "texture-formats-tier1",
];

for (const f of required) {
  if (!adapter.features.has(f)) {
    throw new Error(`Missing required WebGPU feature: ${f}`);
  }
}

const optional: GPUFeatureName[] = [
  "timestamp-query",
  "float32-filterable",
  "bgra8unorm-storage",
];
const enabledOptional = optional.filter((f) => adapter.features.has(f));

const device = await adapter.requestDevice({
  requiredFeatures: [...required, ...enabledOptional],
  requiredLimits: {
    maxBufferSize: 2 * 1024 * 1024 * 1024,
    maxStorageBufferBindingSize: 1024 * 1024 * 1024,
    maxComputeInvocationsPerWorkgroup: 256,
    maxComputeWorkgroupStorageSize: 32 * 1024,
  },
});

const caps = {
  subgroup: true,
  f16: true,
  texFmtTier1: true,
  timestamp: enabledOptional.includes("timestamp-query"),
  f32Filter: enabledOptional.includes("float32-filterable"),
};

console.info("[WebGPU profile]", {
  chromeMin: 136,
  features: Array.from(adapter.features.values()),
  limits: {
    maxBufferSize: adapter.limits.maxBufferSize,
    maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
    maxComputeInvocationsPerWorkgroup: adapter.limits.maxComputeInvocationsPerWorkgroup,
  },
});
```

### 1.2 执行路径

- `P0（默认）`：`subgroups + f16 + tier1 + quantized-vertex`，全流程性能路径。
- `P1（增强）`：在浏览器支持更高版本 subgroup 语义时启用更激进 subgroup 内核。

> 说明：不再存在“兼容路径”。启动通过即进入高性能路径。

---

## 2. 全局数据架构（高带宽版 + 量化坐标）

### 2.1 资源布局

以 `RTX 4000 Ada`（20GB 显存）为目标：

- `VertexPool`：`1.0 GB`（逻辑分页；底层 2~4 个大 Buffer；`8B/vertex`）
- `IndexPool`：`1.0 GB`（逻辑分页；底层 2~4 个大 Buffer）
- `ChunkTable + ROIMeta + QuantMeta + IndirectArgs`：`160 MB`
- `SDF Bricks (Ping-Pong)`：`3.0 GB`（`1.5 GB x 2`，统一 `r16float`）
- `Preview/Mask/TempTexture`：`512 MB`
- `Compute Scratch + PrefixSum + Readback`：`512 MB`

显存策略：

- 常驻预算约 `6.2 GB`（2.3 为约 `7.1 GB`，下降约 `1.0 GB`）。
- 弹性预算建议 `+2.0 GB`（脏砖缓存、撤销日志、突发切面输出）。
- 预留交换链/深度/驱动空间至少 `35% VRAM`。

### 2.2 绑定模型约束

- 分页为逻辑分页：使用“少量大 Buffer + 子范围绑定”。
- 禁止“每页独立 storage buffer + 高频重绑”。
- 每帧 bindGroup 重绑次数需有硬上限并纳入性能计数器。
- `quant_meta` 按 chunk/ROI 只读绑定，生命周期与 chunk table 同步。

### 2.3 WGSL 资源布局

```wgsl
// 读取统一 f32 语义
@group(0) @binding(0) var sdf_read: texture_3d<f32>;

// 写入统一 r16float storage（tier1 前提）
@group(0) @binding(1) var sdf_write: texture_storage_3d<r16float, write>;

// 顶点量化格式：8 字节
struct VertexQ {
  xy: u32; // low16=x(i16), high16=y(i16)
  zf: u32; // low16=z(i16), high16=flags(u16)
};

struct QuantMeta {
  origin_mm: vec4<f32>; // xyz: chunk/roi 局部原点(mm), w: scale_mm(固定 0.1)
};

@group(0) @binding(2) var<storage, read_write> vertex_pool: array<VertexQ>;
@group(0) @binding(3) var<storage, read_write> index_pool: array<u32>;
@group(0) @binding(4) var<storage, read> quant_meta: array<QuantMeta>;
```

### 2.4 坐标量化规则

统一以 `mm` 为物理单位，量化步长固定 `0.1mm`：

1. 编码：`q = round((p_mm - origin_mm) / 0.1)`。
2. 范围：`q ∈ [-15000, 15000]`（对应总范围 3000mm）。
3. 解码：`p_mm = origin_mm + q * 0.1`。
4. 写入策略：只在“顶点落盘到 VertexPool”时量化一次；计算内核尽量保持 `f32`。

WGSL 解包采用无 `i16` 依赖的符号扩展，避免附加能力要求：

```wgsl
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
```

---

## 3. MPR 切面管线（Subgroup 主路径）

### 3.1 主算法

从 2.2/2.3 的 workgroup 聚合改为 subgroup 主路径：

1. 每线程执行三角形-平面求交（内部使用 `f32`）。
2. 使用 `subgroupBallot(hit)` 统计命中掩码。
3. 每 subgroup 仅一次全局 `atomicAdd` 申请写入区间。
4. lane 内偏移由 ballot 前缀位计数得到。
5. 写入前执行量化范围校验，通过后写入 `VertexQ`。
6. 可选再做“workgroup 二级聚合”进一步减少全局原子。

```wgsl
// 伪码：subgroup 压缩写入 + 量化
let hit = intersect_plane(fetch_triangle(gid.x));
let mask = subgroupBallot(hit.valid);
let subgroupCount = count_mask(mask);

var subgroupBase = 0u;
if (isSubgroupLeader()) {
  subgroupBase = atomicAdd(&counters.vertexCount, subgroupCount);
}
subgroupBase = subgroupBroadcastFirst(subgroupBase);

if (hit.valid) {
  let laneOffset = prefix_count(mask);
  let dst = subgroupBase + laneOffset;
  if (dst < counters.capacity) {
    let q = quantize_to_i16(hit.position_mm, meta.origin_mm.xyz, 0.1);
    if (q.inRange) {
      out_vertices[dst] = pack_vertex_q(q.xyz, hit.flags);
    } else {
      atomicAdd(&counters.quantOverflow, 1u);
    }
  } else {
    atomicAdd(&counters.overflow, 1u);
  }
}
```

### 3.2 溢出恢复（保正确性）

- 保留 counter 小回读（`overflow` + `vertexCount` + `quantOverflow`）。
- `overflow > 0`：必须扩容重跑（`x2` -> `x4`）。
- `quantOverflow > 0`：必须执行 `origin` 重定位或 chunk 细分后重跑。
- 结果正确性优先于单帧时延，禁止静默截断或静默夹断。

### 3.3 切面预算策略（稳帧）

- 每帧切面输出设置 `line_budget`（顶点/线段预算）。
- 超预算时把剩余 chunk 延后 1~2 帧补齐。
- 预算命中率与延后量纳入 `timestamp-query` 面板。

---

## 4. 交互编辑管线（高性能提交）

### 4.1 两阶段 + 预提交

1. `move`：当前视图预览 + 脏砖记录 + 轻量预提交（可并行准备下游参数/索引）。
2. `mouseup`：对脏砖执行 `Mesh -> SDF -> Soft Boolean -> Weighted MC` 的最终提交。
3. `commit-done`：刷新三视图并释放写锁。

### 4.2 保持一致性的同时提速

- 全流程固定质量：`0.1mm`，参数不漂移。
- `move` 预览与 `mouseup` commit 使用同源 `SDF + boolean` 参数。
- `move` 阶段不做全 3D mesh 重建，但允许对“当前切面相关数据”做增量预计算。
- `mouseup` 只消费“尚未完成”的脏砖，降低峰值尾延迟。
- 量化只在 VertexPool 写入边界执行，避免 move/commit 间反复量化。

### 4.3 脏砖调度

- 默认砖尺寸：`64^3`。
- 单批 `dirty_limit = 24`（可压测调优）。
- 超限强制分批 commit（每批全质量）。
- 分批顺序按“当前视图影响度 + ROI 关键度”排序，先交付用户最关注区域。

### 4.4 并发约束

- `ROIWriteToken` 保持“同一时刻一个 ROI 写入”。
- CPU 侧命令编码采用对象池、预分配、固定生命周期，避免高频分配。
- i7-14700K 可用 Worker 分担脏砖构建、参数打包和命令录制。

---

## 5. 三视图同步（提交后快速完成）

1. `move` 阶段只刷新当前视图。
2. `mouseup` 后三视图同步执行：复用 `chunk_table`，每视图独立 `IndirectBuffer`。
3. 同步前统一做 chunk AABB 粗裁剪。
4. 若超预算，按批次推进并保持参数不变，不做降分辨率。

---

## 6. 稳定性与观测

### 6.1 正确性护栏

- append 写入统一 `dst < capacity` 检查。
- 量化写入统一 `q ∈ [-15000, 15000]` 检查。
- 出现 `overflow/quantOverflow` 只允许“重跑修复”，不允许“记录后丢弃作为最终结果”。
- draw 前统一 clamp `IndirectArgs`。

### 6.2 队列与资源一致性

- 固定队列顺序：`编辑 Compute -> 切面 Compute -> Render`。
- 同一 pass 内禁止资源读写别名；SDF 全程 ping-pong。
- chunk 元数据双缓冲，避免半更新可见。
- `quant_meta` 与 `chunk_table` 采用同版本号提交，禁止跨版本混用。

### 6.3 观测系统

- 若支持 `timestamp-query`：预览、SDF、boolean、MC、slice 全 pass 打点。
- 输出 P50/P95/P99 + overflow 次数 + quantOverflow 次数 + 分批次数 + 超预算延后量。
- 热路径仅允许小 readback（counter/flag），禁止全量回读。

### 6.4 失败策略

- `device.lost`：自动重建设备和资源。
- 缺关键 feature：直接失败并提示升级 Chrome/驱动，不再降级运行。
- 连续 `quantOverflow`：触发 ROI/chunk 原点重定位并记录诊断事件。

---

## 7. 撤销/重做

1. 操作日志（笔刷参数 + 影响砖块）作为主历史。
2. 每 N 步关键帧（ROI 元数据、砖块映射、quant origin 版本）。
3. 后台增量 GC 回收失效页，保持池内碎片可控。

---

## 8. 性能目标（Chrome 136+ 档）

数据规模：

- 总点数 `16,000,000`（约 `80 ROI`，平均 `200,000 点/ROI`）。

目标时延（P95）：

- `mousemove` 当前视图预览 `<= 30ms`。
- 翻页切面切换 `<= 60ms`。
- `mouseup` 后其余两视图同步完成 `<= 300ms`（常规输入：`dirty_bricks <= 24`）。

显存目标：

- 常驻预算约 `6.2 GB`。
- 相比 2.3 常驻预算降低约 `1.0 GB`。

量化收益预期：

- VertexPool 存储占用下降约 `50%`（`16B -> 8B`）。
- 对切面相关内核，预期 `5%~15%` 的带宽受限场景收益。
- 对端到端交互时延，预期 `0%~6%` 的整体收益（受 SDF/Boolean 占比影响）。

精度目标：

- 勾画与重建空间精度 `0.1mm`。
- 量化单轴最大误差 `<= 0.05mm`。
- 三维欧氏最大误差 `<= 0.0866mm`。

输入约束：

- 笔刷半径最大 `50mm`。
- 超过 `dirty_limit` 必须分批。

---

## 9. 相比上一版 2.3 的关键变化

1. 在保持 `subgroups + f16 + tier1` 硬依赖基础上，引入量化顶点路径。
2. `VertexPool` 从 `vec4<f32>` 升级为 `VertexQ(8B)`，并新增 `quant_meta`。
3. 常驻预算从约 `7.1 GB` 下调到约 `6.2 GB`。
4. SDF storage 仍固定 `r16float`，不引入额外格式分支。
5. 切面写入新增 `quantOverflow` 护栏与重跑机制。
6. 精度目标保持 `0.1mm`，并补充可计算的误差上界。
7. 保留 2.3 的高性能主路径与稳帧分批策略。

---

## 10. 实施优先级

1. 完成量化数据模型（`VertexQ + QuantMeta`）与资源绑定改造。
2. 在切面写入链路接入“量化编码 + quantOverflow 计数 + 重跑闭环”。
3. 接入解包读取路径，保证渲染、同步和回读一致。
4. 接入 timestamp 与计数器面板，验证 `P95/P99` 与量化收益。
5. 在压力场景验证原点重定位策略，确认无可见精度跳变。

成功标准：在 Chrome 136+ 目标环境中稳定达到 `30ms / 60ms / 300ms`（P95），并在 `3m` 总范围内保持 `0.1mm` 目标精度与结果一致性。

---

## 11. 可达性判断

1. 该改动不改变主算法拓扑，只改变顶点存储格式，工程风险可控。
2. 常驻显存约减少 `1.0 GB`，对 20GB 显卡可显著扩大弹性空间并降低 OOM 风险。
3. 带宽收益主要落在切面/顶点相关 pass，端到端收益取决于 SDF/Boolean 占比。
4. 在“总范围 3m + 步长 0.1mm”约束下，`Int16` 量化满足精度目标。
5. 只要严格执行 `quantOverflow -> 重定位/重跑`，可维持正确性与可解释性。
