# 阶段六：性能优化实施计划

## 目标

优化 ROI 系统的性能，重点解决：
1. **3D 网格增量更新** - 避免每次绘制都全量重建网格
2. **内存管理** - 自动清理空块，控制内存占用
3. **LOD 动态调整** - 根据场景复杂度调整渲染精度

---

## Proposed Changes

### Part 1: 3D 网格增量更新（优先级最高）

#### [MODIFY] [SparseROIManager.ts](file:///f:/workspace/threejs-demo/src/annotation/SparseROIManager.ts)

添加更细粒度的脏块跟踪：

```typescript
// 记录每个 ROI 的脏块
private dirtyBlocksPerROI: Map<number, Set<string>> = new Map();

// 标记块为脏（指定 ROI）
markBlockDirty(blockKey: string, roiId: number): void;

// 获取指定 ROI 的脏块
getDirtyBlocksForROI(roiId: number): SparseBlock[];

// 清除指定 ROI 的脏标记
clearDirtyFlagsForROI(roiId: number): void;
```

---

#### [MODIFY] [MarchingCubesMeshGenerator.ts](file:///f:/workspace/threejs-demo/src/mesh/MarchingCubesMeshGenerator.ts)

添加增量更新方法：

```typescript
/**
 * 增量更新：仅重建脏块区域的网格
 * @param roiId ROI ID
 * @param dirtyBlocks 需要重建的块列表
 * @returns 增量网格（需要与现有网格合并）
 */
generateIncrementalMesh(roiId: number, dirtyBlocks: SparseBlock[]): ROIMesh | null;
```

实现思路：
1. 计算脏块的边界框
2. 仅遍历该范围内的体素
3. 返回增量网格数据

---

#### [MODIFY] [VolumeView3D.ts](file:///f:/workspace/threejs-demo/src/views/VolumeView3D.ts)

支持网格合并/替换：

```typescript
// 完整替换网格（现有逻辑）
updateROIMesh(roiId: number, mesh: ROIMesh): void;

// 增量更新策略：小修改用增量，大修改用全量
updateROIMeshSmart(roiId: number): void;
```

---

### Part 2: 内存管理优化

#### [MODIFY] [SparseROIManager.ts](file:///f:/workspace/threejs-demo/src/annotation/SparseROIManager.ts)

增强空块清理：

```typescript
/**
 * 定期压缩存储：清理空块
 * @returns 清理的块数量
 */
compactBlocks(): number;

/**
 * 获取内存统计
 */
getMemoryStats(): {
    blockCount: number;
    estimatedMemoryMB: number;
    emptyBlockCount: number;
};
```

#### [MODIFY] [main.ts](file:///f:/workspace/threejs-demo/src/main.ts)

添加内存监控 UI（可选）：

```typescript
// 定期执行压缩
setInterval(() => {
    const cleaned = roiManager.compactBlocks();
    if (cleaned > 0) console.log(`[Memory] Cleaned ${cleaned} empty blocks`);
}, 30000); // 每 30 秒检查一次
```

---

### Part 3: LOD 动态调整（可选）

> [!NOTE]
> LOD 属于进阶优化，当前阶段可以暂时跳过，优先完成增量更新和内存管理。

如果需要实现：
- 使用 VTK.js 的 `vtkDecimatePro` 进行网格简化
- 根据相机距离动态切换 LOD 级别

---

## 实施优先级

1. ✅ **高优先级**：3D 网格增量更新（减少卡顿）
2. ✅ **中优先级**：内存管理优化（长时间使用稳定性）
3. ⏳ **低优先级**：LOD 动态调整（可延后）

---

## Verification Plan

### 性能测试

1. **绘制响应时间**
   - 测量单次笔刷绘制到 3D 更新的延迟
   - 目标：< 300ms

2. **大区域绘制**
   - 绘制覆盖 100+ 切片的大 ROI
   - 验证不会出现明显卡顿

3. **内存占用**
   - 长时间绘制后检查内存
   - 验证空块被正确清理

### 功能验证

```bash
npm run dev
# 在浏览器中反复绘制/擦除，观察：
# 1. 3D 视图更新是否流畅
# 2. 控制台是否有内存清理日志
# 3. 性能面板 Memory 曲线是否稳定
```
