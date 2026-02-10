# AGENTS.md

本文件为 Codex 在本仓库中工作时提供指导。

## 项目概览

医学影像查看器（fast3dRoi），用于高精度 CT 可视化与 ROI 标注。支持 Axial/Sagittal/Coronal 三视图下的 MPR（多平面重建）、基于 2D 画笔的 ROI 绘制，以及通过 Marching Cubes 实现的实时 3D 表面渲染。项目基于 TypeScript、VTK.js 和 Vite。

## 命令

```bash
npm run dev          # 启动开发服务器（http://localhost:3000，自动打开）
npm run build        # 生产构建
npm run preview      # 预览生产构建
npm run test         # 运行测试（Vitest + jsdom）
npm run test:perf    # 性能测试（详细输出）
```

## 架构

### 数据流

```
DICOM 文件（public/dcmtest/） -> dcmjs 解析器 -> VolumeData
  -> VTK ImageData -> 3 个 MPR 视图（Axial/Sagittal/Coronal）
  -> 用户绘制 ROI（Ctrl + 左键点击）-> BrushTool -> SparseROIManager
  -> EventBus 'roi:update' -> MarchingCubesMeshGenerator -> VolumeView3D（VTK.js）
```

### 关键模块

- **`src/main.ts`**（约 1,098 行）：主入口文件。包含 `VTKMPRView` 类，负责管理 3 个 MPR 视图、DICOM 加载、鼠标交互（Ctrl+点击=绘制，滚轮=切片，右键=窗宽窗位），并通过 `initializeApp()` 完成应用初始化。

- **`src/annotation/SparseROIManager.ts`**：核心 ROI 存储模块，使用稀疏 64×64×64 块与 4 层位掩码编码（`Uint32Array`）。在 3000×3000×300 的虚拟空间中最多支持 100 个并行 ROI。CT 数据采用居中并保留边距。关键方法：`paintSphere()`、`paintCircle()`、`getSliceMasks()`。

- **`src/mesh/MarchingCubesMeshGenerator.ts`**：基于 Marching Cubes 算法与查找表（`MarchingCubesLUT.ts`）从稀疏 ROI 数据生成 3D 三角网格。处理跨块边界体素访问。

- **`src/views/VolumeView3D.ts`**：VTK.js 的 3D 渲染管线（RenderWindow -> Renderer -> OpenGL）。管理每个 ROI 对应的 Actor 与 PolyData mapper。支持 Trackball 相机交互。

- **`src/core/EventBus.ts`**：用于视图间通信的单例事件系统。关键事件：`slice:change`、`window:change`、`roi:paint`、`roi:update`、`volume:loaded`。

- **`src/core/types.ts`**：中心类型定义。关键类型：`VolumeData`、`VolumeMetadata`、`ROIMetadata`、`SparseBlock`、`Vec3`。常量：`BLOCK_SIZE=64`、`MAX_ROI_COUNT=100`、`MAX_GPU_BLOCKS=256`。

- **`src/annotation/BrushTool.ts`**：2D 画笔工具，半径范围 1-50，支持擦除模式与笔画插值以实现平滑绘制。

- **`src/views/ROICanvasOverlay.ts`**：用于在 2D MPR 视图上渲染 ROI 轮廓的 Canvas 覆盖层。使用 `ContourExtractor` 进行轮廓提取。

- **`src/loaders/`**：DICOM（基于 dcmjs）与 NIfTI 加载器，并统一抽象为 `VolumeData`。

### 路径别名

`@/*` 映射到 `src/*`（在 `tsconfig.json` 与 `vite.config.ts` 中均有配置）。

## 关键依赖

- **@kitware/vtk.js**：3D/2D 渲染引擎（基于 OpenGL）
- **dcmjs**：DICOM 文件解析
- **nifti-reader-js**：NIfTI 格式支持

## 测试数据

匿名化 CT DICOM 数据集位于 `public/dcmtest/Anonymized0706/`（143 张切片，512×512×143）。应用启动时会自动加载。

## 开发状态

第 1-5 阶段已完成（MPR 视图、加载器、ROI 标注、3D 网格）。第 6 阶段（性能优化：增量网格更新、内存管理、LOD）进行中。第 7 阶段（集成测试、基准测试）待开展。完整清单见 `doc/task.md`，第 6 阶段详情见 `doc/implementation_plan.md`。

## 备注

- UI 标签为中文
- 需要 WebGL 2.0 支持（建议 Chrome 136+）
- 已启用 TypeScript 严格模式；不允许未使用的局部变量/参数
- `doc/从 RayStation 勾画架构文档 2.4.md` 描述了未来的 WebGPU 架构路径（尚未实现）
