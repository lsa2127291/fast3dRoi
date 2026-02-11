# GPU Milestone 3 (Phase 9-10) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 完成里程碑 3（Phase 9-10）最小可运行实现：MPR 切面管线与三视图同步，并接入事件总线。

**Architecture:** 在 `src/gpu/annotation` 新增 `MPRSlicePipeline` 与 `ViewSyncCoordinator`，由 `AnnotationEngine.commitStroke()` 在提交完成后触发切面提取与三视图同步。主应用通过 `eventBus` 接收同步事件并驱动当前 `main.ts` 下的 VTK 视图实例更新。

**Tech Stack:** TypeScript、WebGPU（可选 compute 路径）、Vitest、VTK.js、EventBus。

---

### Task 1: Phase 9 切面管线（预算 + 压缩写入抽象）

**Files:**
- Create: `src/gpu/annotation/MPRSlicePipeline.ts`
- Create: `src/gpu/annotation/MPRSlicePipeline.test.ts`
- Modify: `src/gpu/annotation/types.ts`

**Step 1: Write the failing test**
- 新增测试覆盖：
- 预算命中时的分批/延后行为
- 每视图切面输出计数
- 预算内一次完成行为

**Step 2: Run test to verify it fails**
- Run: `npm run test -- src/gpu/annotation/MPRSlicePipeline.test.ts --run`
- Expected: FAIL（模块或类型尚未实现）。

**Step 3: Write minimal implementation**
- 实现 `MPRSlicePipeline.extractSlices()`：
- 输入 `dirtyBrickKeys + view slice targets + lineBudget`
- 输出每视图 `lineCount/deferredCount` 与总预算统计
- 预留 `dispatchKernel` 接口，支持后续 GPU compute 替换

**Step 4: Run test to verify it passes**
- Run: `npm run test -- src/gpu/annotation/MPRSlicePipeline.test.ts --run`
- Expected: PASS。

**Step 5: Commit**
- 留给用户决定。

### Task 2: Phase 10 三视图同步协调器

**Files:**
- Create: `src/gpu/annotation/ViewSyncCoordinator.ts`
- Create: `src/gpu/annotation/ViewSyncCoordinator.test.ts`
- Modify: `src/gpu/annotation/index.ts`
- Modify: `src/gpu/annotation/types.ts`

**Step 1: Write the failing test**
- 新增测试覆盖：
- commit 后三视图均收到同步目标
- 预算受限时延后队列可观测
- 同步回调触发顺序稳定

**Step 2: Run test to verify it fails**
- Run: `npm run test -- src/gpu/annotation/ViewSyncCoordinator.test.ts --run`
- Expected: FAIL。

**Step 3: Write minimal implementation**
- 实现 `ViewSyncCoordinator.syncAfterCommit()`：
- 调用 `MPRSlicePipeline`
- 生成三视图目标切片
- 通过回调与事件触发上层刷新

**Step 4: Run test to verify it passes**
- Run: `npm run test -- src/gpu/annotation/ViewSyncCoordinator.test.ts --run`
- Expected: PASS。

**Step 5: Commit**
- 留给用户决定。

### Task 3: 引擎与主应用接入（EventBus + 视图联动）

**Files:**
- Modify: `src/gpu/annotation/AnnotationEngine.ts`
- Modify: `src/gpu/annotation/createAnnotationRuntime.ts`
- Modify: `src/main.ts`
- Modify: `doc/task.md`

**Step 1: Write the failing test**
- 在 `AnnotationEngine.test.ts` 增加 commit 后调用切面同步路径的断言。

**Step 2: Run test to verify it fails**
- Run: `npm run test -- src/gpu/annotation/AnnotationEngine.test.ts --run`
- Expected: FAIL。

**Step 3: Write minimal implementation**
- `AnnotationEngine` 注入 `slicePipeline/viewSync` 并在 commit 后触发。
- `main.ts` 中将 `eventBus` 与视图 `setSlice`/`getSlice` 联动。
- 在 `stats-info` 补充同步状态行。
- 完成 `doc/task.md` 里程碑 3 勾选。

**Step 4: Run test to verify it passes**
- Run: `npm run test -- src/gpu/annotation/AnnotationEngine.test.ts --run`
- Expected: PASS。

**Step 5: Commit**
- 留给用户决定。

### Task 4: 全量验证 + 浏览器验证 + 归档

**Files:**
- Create: `doc/archive/webgpu-phase9-10-completion.md`

**Step 1: Run full tests**
- Run: `npm run test -- --run`
- Expected: 全部通过。

**Step 2: Run build**
- Run: `npm run build`
- Expected: 构建成功。

**Step 3: Browser verification**
- Run: `npm run dev -- --host 127.0.0.1 --port 3000`
- 在页面执行 `Ctrl + 左键拖动`，确认：
- 勾画状态可更新
- 三视图切片状态可更新
- 控制台无新增错误

**Step 4: Archive**
- 新增 `doc/archive/webgpu-phase9-10-completion.md`
- 写入自动化验证与浏览器验证结果、已知问题、文件清单
