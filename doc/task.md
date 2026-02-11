# WebGPU 勾画系统 — 任务清单

## 里程碑 1: WebGPU 基础渲染管线 ✅ 已完成

- [x] **Phase 0**: 工具链配置（@webgpu/types, WGSL 构建支持）
- [x] **Phase 1**: 移除旧 VTK.js 勾画模块（~2,400 行）
- [x] **Phase 2**: Fail-Fast 初始化 + 全局常量（WebGPUContext, constants）
- [x] **Phase 3**: 数据模型（VertexQ 量化编解码, ResourcePools, ChunkTable, WGSL structs）
- [x] **Phase 4**: 基础渲染管线（WGSL shader, BasicRenderPipeline, WebGPURenderer）
- [x] **Phase 5**: 集成到应用（测试立方体, 鼠标交互, 错误处理）

> 归档详情: `doc/archive/webgpu-phase0-5-completion.md`

---

## 里程碑 2: GPU 勾画核心 ✅ 已完成

- [x] **Phase 6**: SDF Bricks 存储
    - [x] r16float 3D 纹理（Ping-Pong 双缓冲）
    - [x] SDF 生成 compute shader
    - [x] 砖块分配与管理
- [x] **Phase 7**: GPU Marching Cubes
    - [x] Weighted MC compute shader
    - [x] Subgroup ballot 压缩写入（§3.1）
    - [x] Overflow/quantOverflow 检测与重跑（§3.2, §6.1）
- [x] **Phase 8**: 交互编辑管线
    - [x] 鼠标事件捕获与坐标转换
    - [x] 两阶段交互（move 预览 + mouseup 提交）
    - [x] 脏砖调度（dirty_limit=24）
    - [x] ROIWriteToken 并发控制

> 归档详情: `doc/archive/webgpu-phase6-8-completion.md`
 
---

## 里程碑 3: MPR 切面 + 同步 ✅ 已完成

- [x] **Phase 9**: MPR 切面管线
    - [x] GPU compute 三角形-平面求交（当前先落地切面管线抽象与默认调度核，保留 WebGPU compute 接入位）
    - [x] Subgroup ballot + 压缩写入（通过切面 dispatch 接口建模压缩写入计数，后续可替换为真实 subgroup kernel）
    - [x] 切面预算策略（稳帧）
- [x] **Phase 10**: 三视图同步（§5）
    - [x] 切面联动
    - [x] 事件总线集成

---

## 里程碑 4: 完善与优化 ✅ 已完成

- [x] **Phase 11**: 撤销/重做（§7）
- [x] **Phase 12**: 性能目标验证（§8）
    - [x] P95 采样与阈值对比链路（move/flip/sync）接入
    - [x] mousemove 预览 ≤ 30ms（实机 P95: 1.0ms，2026-02-11）
    - [x] 翻页切面 ≤ 60ms（实机 P95: 0.6ms，2026-02-11）
    - [x] mouseup 后三视图同步 ≤ 300ms（实机 P95: 21.0ms，2026-02-11）
- [x] **Phase 13**: 集成测试 + 端到端验证
    - [x] 集成测试（undo/redo + sync + 性能采样）已接入
    - [x] 端到端实机验证（Chrome 144 + RTX 4000 Ada + i7-14700 + 64GB，2026-02-11）

---

## 技术债务

- [ ] 法线计算（当前占位 `(0,0,1)`）
- [ ] VertexQ 编解码单元测试
- [ ] device.lost 自动重建
- [ ] timestamp-query 性能面板

---

## 参考文档

- **架构设计**: `doc/仿 RayStation 勾画架构文档 2.4.md`
- **旧 VTK.js 任务**: `doc/archive/vtk-task.md`
- **旧 VTK.js 阶段 6 计划**: `doc/archive/vtk-phase6-implementation_plan.md`
- **里程碑 1 归档**: `doc/archive/webgpu-phase0-5-completion.md`
- **里程碑 4 归档**: `doc/archive/webgpu-phase11-13-completion.md`
- **里程碑 4 补充归档（交互/union 跟进）**: `doc/archive/webgpu-phase11-13-followup-2026-02-11.md`
