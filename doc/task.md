# 医疗图像可视化系统 - 任务清单

## 阶段一：项目基础架构
- [x] 项目初始化与依赖配置
- [x] 目录结构设计
- [x] VTK.js 核心环境搭建

## 阶段二：数据加载层
- [x] DICOM 文件解析模块
- [x] NIfTI 文件解析模块
- [x] 体数据统一抽象层

## 阶段三：MPR 三视图
- [x] 渲染引擎核心架构
- [x] Axial（轴位）视图
- [x] Sagittal（矢状位）视图
- [x] Coronal（冠状位）视图
- [x] 三视图交互联动

## 阶段四：ROI 勾画系统
- [x] 3D 分割数据结构设计（支持100个ROI）
- [x] 显存优化策略实现
- [x] Phase 4: 2D Brush Tool & ROI Real-time Sync
    - [x] Implement [BrushTool](file:///f:/workspace/threejs-demo/src/annotation/BrushTool.ts#24-243) class (circle/square shapes, radius)
    - [x] Implement [SparseROIManager](file:///f:/workspace/threejs-demo/src/annotation/SparseROIManager.ts#19-676) for voxel storage
    - [x] Integrate brush drawing with VTK.js `onModified` events
    - [x] **Refinement**: Implement continuous solid stroke drawing
    - [x] **Refinement**: Rebind VTK keys (Left=Pan, Right=WL)
    - [x] **Fix**: Canvas 坐标系修复（Sagittal/Coronal 圆形绘制）

## 阶段五：ROI 3D 可视化 ✅ 已完成
- [x] **5.1 Marching Cubes 表面重建**
- [x] **5.2 VTK.js 3D 渲染集成**
- [x] **5.3 3D 场景交互**
- [x] **5.4 笔刷实时更新 3D 视图**
- [x] **5.5 修复块边界裂缝问题**

## 阶段六：性能优化（当前阶段）
- [ ] **6.1 3D 网格增量更新**
    - [ ] 跟踪脏块（dirty blocks）
    - [ ] 仅重建受影响区域的网格
    - [ ] 合并增量网格到全局 PolyData
- [ ] **6.2 内存管理优化**
    - [ ] 空块自动清理
    - [ ] 大数据集分页加载
    - [ ] 纹理内存监控
- [ ] **6.3 LOD 动态调整**
    - [ ] 基于相机距离的网格简化
    - [ ] 渲染性能自适应

## 阶段七：集成与测试
- [ ] 端到端功能测试
- [ ] 性能基准测试
