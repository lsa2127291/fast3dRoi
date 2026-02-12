# AGENTS.md

本文件为本仓库中工作时提供指导。

## 项目概览

医学影像查看器（fast3dRoi），用于高精度 CT 可视化与 ROI 标注。支持 Axial/Sagittal/Coronal 三视图下的 MPR（多平面重建）。项目正在从 VTK.js/CPU 架构迁移到 WebGPU 原生架构，以实现高性能 ROI 勾画与 3D 表面渲染。

## 命令

```bash
npm run dev          # 启动开发服务器（http://localhost:3000，自动打开）
npm run build        # 生产构建
npm run preview      # 预览生产构建
npm run test         # 运行测试（Vitest + jsdom）
npm run test:perf    # 性能测试（详细输出）
```

## 当前架构

### 数据流

```
DICOM 文件（public/dcmtest/） -> dcmjs 解析器 -> VolumeData
  -> VTK ImageData -> 3 个 MPR 视图（Axial/Sagittal/Coronal）
  -> [WebGPU 勾画系统] -> 3D 渲染（#volume-view）
```

### 关键模块

#### MPR 视图（VTK.js，保留）

- **`src/main.ts`**（约 1800 行）：主入口文件。包含 `VTKMPRView` 类，负责管理 3 个 MPR 视图、DICOM 加载、overlay 渲染与勾画交互桥接（右键勾画），并通过 `initializeApp()` 完成应用初始化。

- **`src/loaders/`**：DICOM（基于 dcmjs）与 NIfTI 加载器，并统一抽象为 `VolumeData`。

- **`src/core/EventBus.ts`**：用于视图间通信的单例事件系统。关键事件：`slice:change`、`window:change`、`volume:loaded`。

- **`src/core/types.ts`**：中心类型定义。关键类型：`VolumeData`、`VolumeMetadata`、`Vec3`。

#### WebGPU 勾画系统（新架构）

- **`src/gpu/WebGPUContext.ts`**：WebGPU 设备管理器，Fail-Fast 初始化。硬依赖：`subgroups`、`shader-f16`。单例模式。

- **`src/gpu/constants.ts`**：全局 GPU 常量。量化参数（0.1mm 精度）、资源池大小（VertexPool 1GB, IndexPool 1GB）、性能目标（30ms/60ms/300ms）。

- **`src/gpu/data/VertexQ.ts`**：量化顶点格式（8B/vertex, Int16 编码）。编解码函数：`quantize()`, `packVertexQ()`, `decodeVertexQ()`。

- **`src/gpu/data/ResourcePools.ts`**：GPU 缓冲池管理。`VertexPool` 和 `IndexPool`，逻辑分页，底层 512MB 大 Buffer。

- **`src/gpu/data/ChunkTable.ts`**：Chunk 元数据表。脏砖管理、AABB 粗裁剪、版本号同步。

- **`src/gpu/pipelines/BasicRenderPipeline.ts`**：WebGPU 渲染管线。BindGroup 管理、Uniform 更新、深度缓冲配置。

- **`src/gpu/WebGPURenderer.ts`**：WebGPU 渲染器。Canvas 管理、轨迹球相机、网格上传、渲染循环。

- **`src/gpu/annotation/GPUSliceOverlayRenderer.ts`**：切面 overlay 的 GPU 渲染器。包含笔刷 mask 写入、GPU morphology（dilate+erode）与轮廓/填充合成。

- **`src/gpu/shaders/*.wgsl`**：WGSL 着色器。`basic_render.wgsl`（顶点+片段）、`structs.wgsl`（数据结构）、`vertexq_utils.wgsl`（工具函数）。

### 路径别名

`@/*` 映射到 `src/*`（在 `tsconfig.json` 与 `vite.config.ts` 中均有配置）。

## 关键依赖

- **@kitware/vtk.js**：MPR 视图渲染引擎（基于 WebGL）
- **dcmjs**：DICOM 文件解析
- **nifti-reader-js**：NIfTI 格式支持
- **@webgpu/types**：WebGPU TypeScript 类型定义（devDependency）

## 测试数据

匿名化 CT DICOM 数据集位于 `public/dcmtest/Anonymized0706/`（143 张切片，512×512×143）。应用启动时会自动加载。

## 开发状态

**当前分支**: `feature/webgpu-annotation`

**里程碑 1** ✅ 已完成（Phase 0-5）：WebGPU 基础渲染管线
- WebGPU 初始化 + 能力检测
- VertexQ 量化数据模型
- 基础渲染管线（WGSL shader + 测试立方体）
- 详见：`doc/archive/webgpu-phase0-5-completion.md`

**里程碑 2** ✅ 已完成（Phase 6-8）：GPU 勾画核心
- SDF Bricks 存储
- GPU Marching Cubes
- 交互编辑管线
- 详见：`doc/archive/webgpu-phase6-8-completion.md`

**里程碑 3** ✅ 已完成（Phase 9-10）：MPR 切面 + 同步
- MPR 切面管线
- 三视图同步与事件总线联动
- 详见：`doc/archive/webgpu-phase9-10-completion.md`

**里程碑 4** ✅ 已完成（Phase 11-13）：完善与优化
- Phase 11 撤销/重做已完成（操作历史 + 关键帧）
- Phase 12 性能目标已实机达标（P95: move 1.0ms / flip 0.6ms / sync 21.0ms）
- Phase 13 集成测试与端到端实机验证已完成（Chrome 144 + RTX 4000 Ada）
- 详见：`doc/archive/webgpu-phase11-13-completion.md`
- 补充：`doc/archive/webgpu-phase11-13-followup-2026-02-11.md`（右键交互/union 跟进）
- 补充：`doc/archive/webgpu-cpu overlaytogpu overlay.md`（CPU overlay -> GPU overlay 迁移归档）

完整任务清单见 `doc/task.md`。

## 架构文档

- **`doc/仿 RayStation 勾画架构文档 2.4.md`**：WebGPU 架构设计文档（413 行）。定义了 Fail-Fast 初始化、VertexQ 量化、SDF Bricks、Subgroup 主路径、性能目标与 Overlay CPU->GPU 迁移补充。

## 归档文档

- **`doc/archive/vtk-task.md`**：旧 VTK.js 架构的任务清单（阶段 1-7）
- **`doc/archive/vtk-phase6-implementation_plan.md`**：旧 VTK.js 阶段 6 性能优化计划
- **`doc/archive/vtk-phase5-walkthrough.md`**：旧 VTK.js 阶段 5 完成说明
- **`doc/archive/webgpu-phase0-5-completion.md`**：WebGPU 里程碑 1 完成归档
- **`doc/archive/webgpu-phase6-8-completion.md`**：WebGPU 里程碑 2 完成归档
- **`doc/archive/webgpu-phase9-10-completion.md`**：WebGPU 里程碑 3 完成归档
- **`doc/archive/webgpu-phase11-13-completion.md`**：WebGPU 里程碑 4 完成归档
- **`doc/archive/webgpu-phase11-13-followup-2026-02-11.md`**：WebGPU 里程碑 4 补充归档（交互与 union 跟进）
- **`doc/archive/webgpu-cpu overlaytogpu overlay.md`**：CPU overlay 到 GPU overlay 迁移归档（GPU-only，无 fallback）


## 备注

- UI 标签为中文
- MPR 视图需要 WebGL 2.0 支持
- WebGPU 勾画系统需要 Chrome 136+ 并支持 `subgroups` 和 `shader-f16`
- 已启用 TypeScript 严格模式；不允许未使用的局部变量/参数
- 当前 2D ROI 勾画 overlay 已接入并运行在 GPU 管线；3D 体渲染侧仍保留测试立方体基线
