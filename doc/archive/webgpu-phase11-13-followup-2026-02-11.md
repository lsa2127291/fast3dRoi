# WebGPU 里程碑4补充归档（2026-02-11）

**分支**: `feature/webgpu-annotation`  
**归档范围**: 右键勾画交互修正、连续勾画修正、union/erase 累计链路补强、实机验证现状记录  
**关联主归档**: `doc/archive/webgpu-phase11-13-completion.md`

---

## 背景

在里程碑4主归档后，实机交互中继续发现以下问题：

1. `Ctrl + 左键` 与旋转手势冲突。  
2. 右键勾画仅在按下时生效，`move` 过程中未持续勾画。  
3. 多笔勾画的视觉结果未达到期望的连续合并轮廓（用户参考效果为单一连续外边界）。

---

## 本轮改动归档

### 1) 交互触发改为右键

- 调整勾画触发键位为鼠标右键，避免与旋转操作冲突。
- 对右键勾画路径增加上下文菜单抑制与事件拦截策略，减少与宿主交互系统抢占。

涉及文件：

- `src/gpu/annotation/AnnotationInteractionController.ts`
- `index.html`
- `src/main.ts`

### 2) 修复 move 过程中持续勾画

- 调整 pointer/mouse move 阶段逻辑，按住触发键移动时持续追加笔触采样，而非仅 pointer down 单次生效。
- 增加对应单元测试覆盖连续拖动场景。

涉及文件：

- `src/gpu/annotation/AnnotationInteractionController.ts`
- `src/gpu/annotation/AnnotationInteractionController.test.ts`

### 3) union/erase 几何累计链路补强

- 在注释引擎中明确区分：
  - 绘制：`union`
  - 擦除：`erase`
- 操作结果进入 ROI 累计状态，不再只依赖单笔 stroke 的临时显示。
- 同步链路改为可消费累计后的 dirty 区域，减少“有提交但显示仍像单笔”的不一致。

涉及文件：

- `src/gpu/annotation/AnnotationEngine.ts`
- `src/gpu/annotation/AnnotationEngine.test.ts`
- `src/gpu/annotation/types.ts`
- `src/gpu/annotation/createAnnotationRuntime.ts`

### 4) 切片叠加层累积与目标元素解析

- 新增切片叠加累积器，支持同切片多次操作的 mask 级累积显示。
- 新增交互目标解析逻辑，优先将事件绑定到正确的 MPR 视图目标元素，降低“输入正确但未命中预期画布”的概率。

涉及文件：

- `src/gpu/annotation/SliceOverlayAccumulator.ts`
- `src/gpu/annotation/SliceOverlayAccumulator.test.ts`
- `src/gpu/annotation/resolveAnnotationInteractionTarget.ts`
- `src/gpu/annotation/resolveAnnotationInteractionTarget.test.ts`

---

## 自动化验证记录

- `npm run test -- src/gpu/annotation/AnnotationInteractionController.test.ts src/gpu/annotation/AnnotationEngine.test.ts src/gpu/annotation/SliceOverlayAccumulator.test.ts src/gpu/annotation/SliceOverlayProjector.test.ts src/gpu/annotation/resolveAnnotationInteractionTarget.test.ts --run`（23 tests 通过）
- `npm run test -- src/gpu/annotation --run`（40 tests 通过）
- `npm run test:perf`（5 tests 通过）
- `npm run test -- --run`（42 tests 通过）
- `npm run -s build`（构建成功，存在 bundle size warning，不阻塞）

---

## 实机验证现状（本轮结论）

已完成浏览器实机多轮验证，当前状态如下：

1. 右键触发已生效。  
2. move 持续勾画已生效。  
3. union/erase 内部累计链路已接入。

## 未完成项续完结果（2026-02-11）

1. [x] **brush 50mm 非圆问题已修复**  
   - 叠加层半径改为按视口短边统一缩放，`rx/ry` 保持一致，避免非方形视图下椭圆化。  
   - 涉及：`src/gpu/annotation/SliceOverlayProjector.ts`、`src/main.ts`、`src/gpu/annotation/SliceOverlayProjector.test.ts`

2. [x] **sagittal/coronal 监听已接入并与 axial 一致**  
   - 交互目标解析由单目标升级为三视图目标映射，并为 `axial/sagittal/coronal` 分别挂载控制器。  
   - 涉及：`src/gpu/annotation/resolveAnnotationInteractionTarget.ts`、`src/gpu/annotation/resolveAnnotationInteractionTarget.test.ts`、`src/main.ts`

3. [x] **undo/redo 行为收敛**  
   - `mousemove` 仅做预览，`commit` 仅在 `mouseup` 触发一次。  
   - 历史上限与重做栈上限统一限制为 6。  
   - 涉及：`src/gpu/annotation/AnnotationInteractionController.ts`、`src/gpu/annotation/AnnotationInteractionController.test.ts`、`src/gpu/annotation/AnnotationEngine.ts`、`src/gpu/annotation/AnnotationEngine.test.ts`、`src/gpu/annotation/createAnnotationRuntime.ts`

4. [x] **mousemove 叠加层连通性/平滑性优化已落地**  
   - 新增采样插值策略，长距离拖动会自动补点，降低断裂感。  
   - 新增二值掩膜闭运算（dilate+erode）以改善轮廓连通与平滑。  
   - 性能阈值链路验证通过（`test:perf` 全通过）。  
   - 涉及：`src/gpu/annotation/SliceOverlayAccumulator.ts`、`src/gpu/annotation/SliceOverlayAccumulator.test.ts`、`src/main.ts`

5. [x] **“可视上明确 union 成功”截图闭环已完成**  
   - 证据文件：  
     - `union4-before-second-stroke.png`  
     - `union4-after-second-stroke.png`  
     - `union-after-erase-stroke.png`  
   - 上述截图已展示二次笔触后 union 连续合并，以及后续 erase 结果变化。  
   - 主归档已同步更新为最终验收状态（见 `doc/archive/webgpu-phase11-13-completion.md`）。
---

## 技术债务补充验收（浏览器）

**验收日期**: 2026-02-11  
**验收环境**: Windows 11, Chrome 144, localhost:3000（DICOM 自动加载）  

### 结果

1. WebGPU 初始化成功，测试立方体可见（控制台含 `[WebGPU] 初始化成功`、`[WebGPURenderer] 初始化完成`）。  
2. 医学数据加载成功，三视图切片索引正常更新（Axial/Sagittal/Coronal）。  
3. 信息面板显示技术债性能项：  
   - `P50/P95/P99` 行存在  
   - `timestamp-query: ON | overflow 0 | quantOverflow 0 | deferred 0 | budgetHit 0 | batches 0`  

### 已知非阻塞项

- dcmjs 输出大量 `Invalid vr type ox - using OW`，属于测试数据兼容性日志，当前不阻塞渲染和交互。  
- `favicon.ico` 缺失与 `vtkInteractorStyleImage` 键位重绑 warning 为既有噪声，不影响本轮技术债验收结论。  

### 验收结论

技术债条目（法线计算、VertexQ 编解码测试、device.lost 自动重建、timestamp-query 面板）在浏览器端验证通过，可归档。
**归档日期**: 2026-02-11  
**归档人**: Codex

---

## 2026-02-12 补充归档：勾画同步不触发 CT 翻页

**需求日期**: 2026-02-12  
**需求**: 勾画同步时不允许 Axial/Sagittal/Coronal 视图自动翻页。  

### 改动说明

- 移除 `slice:sync` 监听中对 `view.setSlice(target.sliceIndex, false)` 的调用。
- 保留跨视图 overlay 同步，但兜底点仅写入各视图当前切片，确保同步行为不改变用户当前浏览层。

涉及文件：

- `src/main.ts`
- `AGENTS.md`

### 行为约束（新增）

- `slice:sync` 只同步 overlay 数据，不驱动 CT 视图切片跳转。
