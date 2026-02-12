# webgpu-cpu overlaytogpu overlay

**归档日期**: 2026-02-12  
**分支**: `feature/webgpu-annotation`  
**范围**: 将切面 overlay 从 CPU 栅格链路迁移为 WebGPU 链路（无 fallback）

---

## 1. 背景问题

原 CPU overlay 链路存在以下问题：

1. `mousemove` 连续勾画时，CPU 热路径包含 `getImageData/putImageData`，在大笔刷和多笔时延迟高。
2. 多笔连续操作时，容易出现“第二笔等待时间长/串线”体验问题。
3. 轮廓与填充效果在不同阶段存在可见不一致，维护复杂。

---

## 2. 迁移目标

1. 将 morphology（dilate + erode）迁移到 GPU。
2. 移除 CPU overlay 热路径（包括 `getImageData/putImageData`）。
3. 运行时改为 GPU-only，不保留 fallback。
4. 视觉效果尽量对齐旧 CPU 版本（轮廓与填充风格）。

---

## 3. 实施内容

### 3.1 新增 GPU Overlay 渲染器

新增文件：`src/gpu/annotation/GPUSliceOverlayRenderer.ts`

三阶段管线：

1. `apply mask pass`：按圆刷操作（union/erase）写入 mask（支持增量批处理）。
2. `morphology close pass`：full 模式执行 dilate + erode。
3. `composite pass`：生成填充与描边并输出到 overlay canvas。

### 3.2 主流程改造为 GPU-only

改造文件：`src/main.ts`

1. 移除 CPU overlay/mask/edge/offscreen canvas 逻辑。
2. 仅保留 `overlayGPUCanvas` + `GPUSliceOverlayRenderer`。
3. 保留 `fast/full` 两档质量：
   - `fast`: move 实时反馈
   - `full`: 提交后精化

### 3.3 交互稳定性修复

改造文件：`src/gpu/annotation/AnnotationInteractionController.ts`

1. `mouseup` 以“最后有效采样点”提交，避免末端跳点。
2. 拖拽时超出视图边界的 `mousemove` 采样直接忽略，避免长线拉飞。

### 3.4 视觉对齐修正（CPU 风格）

改造文件：`src/gpu/annotation/GPUSliceOverlayRenderer.ts`

1. 描边由 4 邻域改为 8 邻域。
2. 邻域越界视为 `on`（与 CPU 边界处理一致）。
3. 采用预乘 alpha 输出，匹配 `alphaMode: premultiplied` 下的填充亮度。

---

## 4. 验证结果

1. `npm run build`：通过。
2. `npm run test -- --run`：通过（全量）。
3. 浏览器实测：
   - 连续勾画可实时显示；
   - `mouseup` 后再次 `mousedown` 不再串接上一笔；
   - 视图外释放鼠标不再出现异常长线；
   - 描边与填充观感相较迁移初版已明显接近旧 CPU 版本。

---

## 5. 影响文件

1. `src/gpu/annotation/GPUSliceOverlayRenderer.ts`
2. `src/main.ts`
3. `src/gpu/annotation/AnnotationInteractionController.ts`
4. `src/gpu/annotation/AnnotationInteractionController.test.ts`
5. `src/gpu/annotation/SliceOverlayAccumulator.ts`（配合连续勾画链路）

---

## 6. 结论

本次 CPU->GPU overlay 迁移已完成并落地为 GPU-only 运行模式。  
在保持交互稳定性的前提下，消除了 CPU 图像回读/回写热路径，并完成了轮廓/填充风格的 CPU 向 GPU 对齐。
