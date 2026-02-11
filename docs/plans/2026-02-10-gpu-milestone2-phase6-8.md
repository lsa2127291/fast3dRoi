# GPU Milestone 2 (Phase 6-8) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 完成里程碑 2（Phase 6-8）最小可运行实现：SDF Bricks、GPU Marching Cubes、交互编辑管线。

**Architecture:** 在 `src/gpu/annotation` 下新增 GPU 勾画核心模块，采用“CPU 调度 + WGSL compute”模式。SDF 与 MC 通过独立 pipeline 组合，交互层负责鼠标事件、坐标转换、两阶段提交与脏砖调度。

**Tech Stack:** TypeScript、WebGPU（WGSL）、Vitest、Vite。

---

### Task 1: Phase 6 SDF Bricks 存储与管理

**Files:**
- Create: `src/gpu/annotation/SDFBrickPool.ts`
- Create: `src/gpu/shaders/sdf_generate.wgsl`
- Create: `src/gpu/annotation/types.ts`
- Test: `src/gpu/annotation/AnnotationEngine.test.ts`

**Step 1: Write the failing test**
- 在 `AnnotationEngine.test.ts` 里验证 `previewStroke()` 会触发 SDF 生成并记录脏砖。

**Step 2: Run test to verify it fails**
- Run: `npm run test -- src/gpu/annotation/AnnotationEngine.test.ts --run`
- Expected: FAIL（模块未实现）。

**Step 3: Write minimal implementation**
- 实现 `SDFBrickPool`：
- 双纹理 ping-pong（`r16float`）
- 砖块分配/释放/索引映射
- 纹理读写角色交换
- 实现 `sdf_generate.wgsl` 最小 SDF 写入核。

**Step 4: Run test to verify it passes**
- Run: `npm run test -- src/gpu/annotation/AnnotationEngine.test.ts --run`
- Expected: PASS。

**Step 5: Commit**
- 留给用户决定。

### Task 2: Phase 7 GPU Marching Cubes

**Files:**
- Create: `src/gpu/annotation/MarchingCubesPipeline.ts`
- Create: `src/gpu/shaders/weighted_mc.wgsl`
- Modify: `src/gpu/shaders/structs.wgsl`
- Test: `src/gpu/annotation/AnnotationEngine.test.ts`

**Step 1: Write the failing test**
- 增加测试：`commitStroke()` 在 overflow 时触发重跑，quantOverflow 触发重定位后重跑。

**Step 2: Run test to verify it fails**
- Run: `npm run test -- src/gpu/annotation/AnnotationEngine.test.ts --run`
- Expected: FAIL。

**Step 3: Write minimal implementation**
- 实现 `weighted_mc.wgsl`（含 subgroup ballot 压缩写入骨架）。
- `MarchingCubesPipeline.dispatchWithRetry()` 实现 overflow/quantOverflow 检测与重跑。

**Step 4: Run test to verify it passes**
- Run: `npm run test -- src/gpu/annotation/AnnotationEngine.test.ts --run`
- Expected: PASS。

**Step 5: Commit**
- 留给用户决定。

### Task 3: Phase 8 交互编辑管线

**Files:**
- Create: `src/gpu/annotation/ROIWriteToken.ts`
- Create: `src/gpu/annotation/DirtyBrickScheduler.ts`
- Create: `src/gpu/annotation/AnnotationEngine.ts`
- Create: `src/gpu/annotation/AnnotationInteractionController.ts`
- Create: `src/gpu/annotation/index.ts`
- Test: `src/gpu/annotation/ROIWriteToken.test.ts`
- Test: `src/gpu/annotation/DirtyBrickScheduler.test.ts`
- Test: `src/gpu/annotation/AnnotationEngine.test.ts`

**Step 1: Write the failing test**
- 并发控制、脏砖分批、move 预览 + mouseup 提交行为测试。

**Step 2: Run test to verify it fails**
- Run: `npm run test -- src/gpu/annotation --run`
- Expected: FAIL。

**Step 3: Write minimal implementation**
- `ROIWriteToken`: 单 ROI 串行写锁。
- `DirtyBrickScheduler`: `dirty_limit=24` 分批。
- `AnnotationEngine`: 两阶段流程、坐标转换、调用 SDF/MC pipeline。
- `AnnotationInteractionController`: 鼠标事件捕获与画布坐标到世界坐标映射。

**Step 4: Run test to verify it passes**
- Run: `npm run test -- src/gpu/annotation --run`
- Expected: PASS。

**Step 5: Commit**
- 留给用户决定。

### Task 4: 系统接入与导出

**Files:**
- Modify: `src/gpu/index.ts`
- Modify: `src/main.ts`
- Modify: `src/gpu/WebGPURenderer.ts`

**Step 1: Write the failing test**
- 增加 renderer 生命周期测试覆盖交互控制器清理。

**Step 2: Run test to verify it fails**
- Run: `npm run test -- src/gpu/WebGPURenderer.test.ts --run`
- Expected: FAIL。

**Step 3: Write minimal implementation**
- 接入 annotation engine/controller，连接 UI 控件（ROI、笔刷、擦除模式）。

**Step 4: Run test to verify it passes**
- Run: `npm run test -- src/gpu/WebGPURenderer.test.ts --run`
- Expected: PASS。

**Step 5: Commit**
- 留给用户决定。

### Task 5: 验证与浏览器检查

**Files:**
- Modify: `doc/task.md`

**Step 1: Run project tests**
- Run: `npm run test -- --run`
- Expected: 全部通过。

**Step 2: Run build**
- Run: `npm run build`
- Expected: 构建成功。

**Step 3: Browser verification**
- 启动 `npm run dev`，打开页面验证：
- WebGPU 视图正常加载
- 鼠标 move 有预览路径
- mouseup 触发提交日志
- 脏砖分批和写锁状态可观测

**Step 4: Update task list**
- 在 `doc/task.md` 勾选已完成的里程碑 2 子项。
