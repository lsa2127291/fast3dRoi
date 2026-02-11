# GPU Milestone 4 (Phase 11-13) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 完成里程碑 4 的最小可运行实现：撤销/重做、性能目标验证链路、集成测试与端到端可观测性。  
**Architecture:** 以 `AnnotationEngine` 为中心增加历史栈与关键帧；新增 `AnnotationPerformanceTracker` 统一记录 `preview/page-flip/sync` 三类时延并计算 P95；在 `main.ts` 注入性能事件与 UI 状态行；通过 Vitest 集成测试验证多模块联动。  
**Tech Stack:** TypeScript、Vitest、WebGPU 注解模块、EventBus、Vite。

---

### Task 1: Phase 11 撤销/重做（操作日志 + 关键帧）

**Files:**
- Modify: `src/gpu/annotation/types.ts`
- Modify: `src/gpu/annotation/AnnotationEngine.ts`
- Modify: `src/gpu/annotation/AnnotationEngine.test.ts`

**Step 1: Write the failing test**
- 在 `AnnotationEngine.test.ts` 新增用例：
- `undoLast()` 会回放反向操作并减少 undo 深度、增加 redo 深度。
- `redoLast()` 会重放原操作并恢复 undo 深度。
- 历史记录会按固定间隔生成关键帧。

**Step 2: Run test to verify it fails**
- Run: `npm run test -- src/gpu/annotation/AnnotationEngine.test.ts --run`
- Expected: FAIL（新 API 或行为尚未实现）。

**Step 3: Write minimal implementation**
- `AnnotationEngine` 新增历史栈与 redo 栈。
- 新增 `undoLast()/redoLast()/canUndo()/canRedo()/getHistorySnapshot()`。
- commit 路径按间隔记录关键帧信息（ROI、笔刷、影响砖块、版本号）。

**Step 4: Run test to verify it passes**
- Run: `npm run test -- src/gpu/annotation/AnnotationEngine.test.ts --run`
- Expected: PASS。

---

### Task 2: Phase 12 性能目标验证（P95 + 阈值）

**Files:**
- Create: `src/gpu/annotation/AnnotationPerformanceTracker.ts`
- Create: `src/gpu/annotation/AnnotationPerformanceTracker.test.ts`
- Modify: `src/gpu/annotation/types.ts`
- Modify: `src/gpu/annotation/AnnotationEngine.ts`
- Modify: `src/gpu/annotation/createAnnotationRuntime.ts`
- Modify: `src/core/types.ts`
- Modify: `src/main.ts`

**Step 1: Write the failing test**
- 新增 `AnnotationPerformanceTracker.test.ts`：
- 记录样本后可得正确 P95。
- 三项阈值（30/60/300ms）可被判定为达标/未达标。
- 可生成 UI 需要的摘要结果。

**Step 2: Run test to verify it fails**
- Run: `npm run test -- src/gpu/annotation/AnnotationPerformanceTracker.test.ts --run`
- Expected: FAIL（模块不存在）。

**Step 3: Write minimal implementation**
- 新建 `AnnotationPerformanceTracker`：支持 `record()/getReport()/reset()`。
- `AnnotationEngine.previewStroke()` 与 `commitStroke()`（view sync 段）增加耗时采样回调。
- `VTKMPRView` 翻页路径发出 `perf:page-flip` 事件。
- `main.ts` 汇总样本并在侧栏展示 P95 与阈值比对状态。

**Step 4: Run test to verify it passes**
- Run: `npm run test -- src/gpu/annotation/AnnotationPerformanceTracker.test.ts --run`
- Expected: PASS。

---

### Task 3: Phase 13 集成测试 + 端到端验证链路

**Files:**
- Create: `src/gpu/annotation/Milestone4.integration.test.ts`
- Modify: `src/gpu/annotation/index.ts`
- Modify: `doc/task.md`

**Step 1: Write the failing test**
- 新增集成用例组合 `AnnotationEngine + ViewSyncCoordinator + AnnotationPerformanceTracker`：
- commit 后产生 view sync 结果与 sync 采样。
- undo/redo 改变历史深度并可重复提交。
- 性能报告输出三项指标结构完整。

**Step 2: Run test to verify it fails**
- Run: `npm run test -- src/gpu/annotation/Milestone4.integration.test.ts --run`
- Expected: FAIL（联动能力未齐全）。

**Step 3: Write minimal implementation**
- 补齐导出与调用链，确保集成测试通过。
- 在 `doc/task.md` 更新里程碑4阶段状态。

**Step 4: Run test to verify it passes**
- Run: `npm run test -- src/gpu/annotation/Milestone4.integration.test.ts --run`
- Expected: PASS。

---

### Task 4: 全量验证

**Files:**
- Modify: `doc/task.md`

**Step 1: Run focused tests**
- Run: `npm run test -- src/gpu/annotation --run`
- Expected: PASS。

**Step 2: Run full tests**
- Run: `npm run test -- --run`
- Expected: PASS。

**Step 3: Run build**
- Run: `npm run build`
- Expected: PASS。

**Step 4: Update task list**
- 根据真实验证结果更新 `doc/task.md` 中里程碑4状态（避免超范围勾选）。
