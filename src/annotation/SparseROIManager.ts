/**
 * 稀疏分块 ROI 管理器
 * 支持 3000×3000 扩展空间，100 个 ROI 同时可见
 */

import type { Vec3, BlockCoord, SparseBlock, RGBAColor, ROIMetadata } from '@/core/types';
import { BLOCK_SIZE, MAX_ROI_COUNT } from '@/core/types';

/**
 * 生成块的唯一键
 */
function blockKey(coord: BlockCoord): string {
    return `${coord.bx},${coord.by},${coord.bz}`;
}

/**
 * 稀疏分块 ROI 管理器
 */
export class SparseROIManager {
    // 虚拟空间尺寸
    private virtualDimensions: Vec3 = [3000, 3000, 300];

    // CT 在虚拟空间中的偏移
    private ctOffset: Vec3 = [0, 0, 0];

    // CT 的 spacing（每个体素的物理尺寸，单位 mm）
    private ctSpacing: Vec3 = [1, 1, 1];

    // 稀疏块存储
    private blocks: Map<string, SparseBlock> = new Map();

    // ROI 元数据
    private roiMetadata: Map<number, ROIMetadata> = new Map();

    // GPU 纹理缓存 (LRU) - 保留以便后续实现
    // @ts-expect-error Reserved for GPU texture caching
    private _gpuBlockCache: Map<string, WebGLTexture> = new Map();
    // @ts-expect-error Reserved for LRU tracking
    private _gpuBlockLRU: string[] = [];

    // WebGL 上下文 - 保留以便后续 GPU 操作
    // @ts-expect-error Reserved for WebGL context
    private _gl: WebGL2RenderingContext | null = null;

    /**
     * 初始化
     */
    initialize(_gl: WebGL2RenderingContext, ctDimensions: Vec3, spacing: Vec3): void {
        this._gl = _gl;

        // 保存 spacing
        this.ctSpacing = spacing;

        // 计算虚拟空间和 CT 偏移
        // CT 居中放置在 3000×3000 空间
        this.ctOffset = [
            Math.floor((this.virtualDimensions[0] - ctDimensions[0]) / 2),
            Math.floor((this.virtualDimensions[1] - ctDimensions[1]) / 2),
            0,
        ];

        // 初始化默认 ROI 颜色
        this.initializeDefaultROIs();
    }

    /**
     * 获取 CT spacing
     */
    getSpacing(): Vec3 {
        return this.ctSpacing;
    }

    /**
     * 初始化默认 ROI
     */
    private initializeDefaultROIs(): void {
        const defaultColors: RGBAColor[] = [
            [255, 0, 0, 180],     // Red
            [0, 255, 0, 180],     // Green
            [0, 0, 255, 180],     // Blue
            [255, 255, 0, 180],   // Yellow
            [255, 0, 255, 180],   // Magenta
            [0, 255, 255, 180],   // Cyan
            [255, 128, 0, 180],   // Orange
            [128, 0, 255, 180],   // Purple
        ];

        for (let i = 1; i <= MAX_ROI_COUNT; i++) {
            this.roiMetadata.set(i, {
                id: i,
                name: `ROI ${i}`,
                color: defaultColors[(i - 1) % defaultColors.length],
                visible: true,
                locked: false,
            });
        }
    }

    /**
     * 获取块坐标
     */
    private getBlockCoord(x: number, y: number, z: number): BlockCoord {
        return {
            bx: Math.floor(x / BLOCK_SIZE),
            by: Math.floor(y / BLOCK_SIZE),
            bz: Math.floor(z / BLOCK_SIZE),
        };
    }

    /**
     * 获取块内局部坐标
     */
    private getLocalCoord(x: number, y: number, z: number): Vec3 {
        return [
            x % BLOCK_SIZE,
            y % BLOCK_SIZE,
            z % BLOCK_SIZE,
        ];
    }

    /**
     * 创建空块
     */
    private createEmptyBlock(coord: BlockCoord): SparseBlock {
        const voxelCount = BLOCK_SIZE * BLOCK_SIZE * BLOCK_SIZE;
        return {
            coord,
            bitmaskLayers: [
                new Uint32Array(voxelCount), // ROI 1-32
                new Uint32Array(voxelCount), // ROI 33-64
                new Uint32Array(voxelCount), // ROI 65-96
                new Uint32Array(voxelCount), // ROI 97-128
            ],
            dirty: false,
        };
    }

    /**
     * 设置体素的 ROI
     */
    setVoxelROI(x: number, y: number, z: number, roiId: number, value: boolean): void {
        if (roiId < 1 || roiId > MAX_ROI_COUNT) return;

        const coord = this.getBlockCoord(x, y, z);
        const key = blockKey(coord);

        // 按需创建块
        if (!this.blocks.has(key) && value) {
            this.blocks.set(key, this.createEmptyBlock(coord));
        }

        const block = this.blocks.get(key);
        if (!block) return;

        const [lx, ly, lz] = this.getLocalCoord(x, y, z);
        const voxelIdx = lz * BLOCK_SIZE * BLOCK_SIZE + ly * BLOCK_SIZE + lx;
        const layerIdx = Math.floor((roiId - 1) / 32);
        const bitPos = (roiId - 1) % 32;

        if (value) {
            block.bitmaskLayers[layerIdx][voxelIdx] |= (1 << bitPos);
        } else {
            block.bitmaskLayers[layerIdx][voxelIdx] &= ~(1 << bitPos);
        }

        block.dirty = true;
    }

    /**
     * 获取体素的所有 ROI
     */
    getVoxelROIs(x: number, y: number, z: number): number[] {
        const coord = this.getBlockCoord(x, y, z);
        const key = blockKey(coord);
        const block = this.blocks.get(key);

        if (!block) return [];

        const [lx, ly, lz] = this.getLocalCoord(x, y, z);
        const voxelIdx = lz * BLOCK_SIZE * BLOCK_SIZE + ly * BLOCK_SIZE + lx;
        const rois: number[] = [];

        for (let layer = 0; layer < 4; layer++) {
            const bits = block.bitmaskLayers[layer][voxelIdx];
            if (bits === 0) continue;

            for (let b = 0; b < 32 && (layer * 32 + b) < MAX_ROI_COUNT; b++) {
                if (bits & (1 << b)) {
                    rois.push(layer * 32 + b + 1);
                }
            }
        }

        return rois;
    }

    /**
     * 批量绘制（笔刷操作）
     */
    paintSphere(
        centerX: number,
        centerY: number,
        centerZ: number,
        radius: number,
        roiId: number,
        erase: boolean = false
    ): Vec3[] {
        const affectedVoxels: Vec3[] = [];
        const r2 = radius * radius;

        for (let dz = -radius; dz <= radius; dz++) {
            for (let dy = -radius; dy <= radius; dy++) {
                for (let dx = -radius; dx <= radius; dx++) {
                    if (dx * dx + dy * dy + dz * dz <= r2) {
                        const x = centerX + dx;
                        const y = centerY + dy;
                        const z = centerZ + dz;

                        // 边界检查
                        if (
                            x >= 0 && x < this.virtualDimensions[0] &&
                            y >= 0 && y < this.virtualDimensions[1] &&
                            z >= 0 && z < this.virtualDimensions[2]
                        ) {
                            this.setVoxelROI(x, y, z, roiId, !erase);
                            affectedVoxels.push([x, y, z]);
                        }
                    }
                }
            }
        }

        return affectedVoxels;
    }

    /**
     * 绘制实心圆（2D 平面）- 使用物理单位
     * 用于连续的笔刷线条绘制
     * @param center1 在绘制平面上的第一个轴中心坐标（虚拟空间体素）
     * @param center2 在绘制平面上的第二个轴中心坐标（虚拟空间体素）
     * @param fixedAxisValue 固定轴的值（切片位置，虚拟空间体素）
     * @param radiusMm 圆半径（物理单位 mm）
     * @param roiId ROI ID
     * @param erase 是否为擦除模式
     * @param plane 绘制平面: 'xy'(Axial), 'yz'(Sagittal), 'xz'(Coronal)
     */
    paintCircle(
        center1: number,
        center2: number,
        fixedAxisValue: number,
        radiusMm: number,
        roiId: number,
        erase: boolean = false,
        plane: 'xy' | 'yz' | 'xz' = 'xy'
    ): Vec3[] {
        const affectedVoxels: Vec3[] = [];

        // 根据平面类型获取两个轴的 spacing
        let spacing1: number, spacing2: number;
        switch (plane) {
            case 'xy':
                // Axial: X=spacing[0], Y=spacing[1]
                spacing1 = this.ctSpacing[0];
                spacing2 = this.ctSpacing[1];
                break;
            case 'yz':
                // Sagittal: Y=spacing[1], Z=spacing[2]
                spacing1 = this.ctSpacing[1];
                spacing2 = this.ctSpacing[2];
                break;
            case 'xz':
                // Coronal: X=spacing[0], Z=spacing[2]
                spacing1 = this.ctSpacing[0];
                spacing2 = this.ctSpacing[2];
                break;
        }

        // 将物理半径转换为各轴的体素半径
        const radius1 = Math.ceil(radiusMm / spacing1);
        const radius2 = Math.ceil(radiusMm / spacing2);

        // 只在当前切片上绘制 2D 椭圆（物理空间中的正圆）
        for (let d2 = -radius2; d2 <= radius2; d2++) {
            for (let d1 = -radius1; d1 <= radius1; d1++) {
                // 使用椭圆方程判断：(d1*spacing1/radiusMm)^2 + (d2*spacing2/radiusMm)^2 <= 1
                const physicalDist1 = d1 * spacing1;
                const physicalDist2 = d2 * spacing2;
                const normalizedDist = (physicalDist1 * physicalDist1 + physicalDist2 * physicalDist2) / (radiusMm * radiusMm);

                if (normalizedDist <= 1) {
                    let x: number, y: number, z: number;

                    // 根据平面类型分配坐标
                    switch (plane) {
                        case 'xy':
                            // Axial: XY 平面，Z 固定
                            x = center1 + d1;
                            y = center2 + d2;
                            z = fixedAxisValue;
                            break;
                        case 'yz':
                            // Sagittal: YZ 平面，X 固定
                            x = fixedAxisValue;
                            y = center1 + d1;
                            z = center2 + d2;
                            break;
                        case 'xz':
                            // Coronal: XZ 平面，Y 固定
                            x = center1 + d1;
                            y = fixedAxisValue;
                            z = center2 + d2;
                            break;
                    }

                    // 边界检查
                    if (
                        x >= 0 && x < this.virtualDimensions[0] &&
                        y >= 0 && y < this.virtualDimensions[1] &&
                        z >= 0 && z < this.virtualDimensions[2]
                    ) {
                        this.setVoxelROI(x, y, z, roiId, !erase);
                        affectedVoxels.push([x, y, z]);
                    }
                }
            }
        }

        return affectedVoxels;
    }

    /**
     * 绘制圆形轮廓（只绘制边缘，不填充）
     * 在 2D 平面上绘制圆形边缘
     */
    paintCircleOutline(
        centerX: number,
        centerY: number,
        sliceZ: number,
        radius: number,
        roiId: number,
        erase: boolean = false,
        thickness: number = 1
    ): Vec3[] {
        const affectedVoxels: Vec3[] = [];
        const innerR2 = Math.max(0, (radius - thickness)) * Math.max(0, (radius - thickness));
        const outerR2 = radius * radius;

        // 只在当前切片上绘制 2D 圆形轮廓
        for (let dy = -radius; dy <= radius; dy++) {
            for (let dx = -radius; dx <= radius; dx++) {
                const dist2 = dx * dx + dy * dy;

                // 只绘制在轮廓区域内的点 (innerR2 < dist2 <= outerR2)
                if (dist2 > innerR2 && dist2 <= outerR2) {
                    const x = centerX + dx;
                    const y = centerY + dy;
                    const z = sliceZ;

                    // 边界检查
                    if (
                        x >= 0 && x < this.virtualDimensions[0] &&
                        y >= 0 && y < this.virtualDimensions[1] &&
                        z >= 0 && z < this.virtualDimensions[2]
                    ) {
                        this.setVoxelROI(x, y, z, roiId, !erase);
                        affectedVoxels.push([x, y, z]);
                    }
                }
            }
        }

        return affectedVoxels;
    }

    /**
     * 重建块的混合颜色纹理
     */
    rebuildBlockBlendedColor(block: SparseBlock): Uint8Array {
        const voxelCount = BLOCK_SIZE * BLOCK_SIZE * BLOCK_SIZE;
        const colorData = new Uint8Array(voxelCount * 4);

        for (let i = 0; i < voxelCount; i++) {
            let r = 0, g = 0, b = 0, a = 0, count = 0;

            // 遍历所有 ROI
            for (let layer = 0; layer < 4; layer++) {
                const bits = block.bitmaskLayers[layer][i];
                if (bits === 0) continue;

                for (let bit = 0; bit < 32 && (layer * 32 + bit) < MAX_ROI_COUNT; bit++) {
                    if (bits & (1 << bit)) {
                        const roiId = layer * 32 + bit + 1;
                        const meta = this.roiMetadata.get(roiId);
                        if (meta && meta.visible) {
                            r += meta.color[0];
                            g += meta.color[1];
                            b += meta.color[2];
                            a += meta.color[3];
                            count++;
                        }
                    }
                }
            }

            if (count > 0) {
                colorData[i * 4 + 0] = Math.round(r / count);
                colorData[i * 4 + 1] = Math.round(g / count);
                colorData[i * 4 + 2] = Math.round(b / count);
                colorData[i * 4 + 3] = Math.round(a / count);
            }
        }

        block.blendedColorData = colorData;
        return colorData;
    }

    /**
     * 获取脏块列表
     */
    getDirtyBlocks(): SparseBlock[] {
        return Array.from(this.blocks.values()).filter(b => b.dirty);
    }

    /**
     * 标记所有块为干净
     */
    clearDirtyFlags(): void {
        for (const block of this.blocks.values()) {
            block.dirty = false;
        }
    }

    /**
     * 获取所有非空块
     */
    getAllBlocks(): SparseBlock[] {
        return Array.from(this.blocks.values());
    }

    /**
     * 获取 ROI 元数据
     */
    getROIMetadata(roiId: number): ROIMetadata | undefined {
        return this.roiMetadata.get(roiId);
    }

    /**
     * 更新 ROI 元数据
     */
    updateROIMetadata(roiId: number, updates: Partial<ROIMetadata>): void {
        const meta = this.roiMetadata.get(roiId);
        if (meta) {
            Object.assign(meta, updates);
            // 如果可见性或颜色变化，需要重建所有块
            if ('visible' in updates || 'color' in updates) {
                for (const block of this.blocks.values()) {
                    block.dirty = true;
                }
            }
        }
    }

    /**
     * 获取虚拟空间信息
     */
    getVirtualSpaceInfo() {
        return {
            dimensions: this.virtualDimensions,
            ctOffset: this.ctOffset,
            blockSize: BLOCK_SIZE,
        };
    }

    /**
     * 将 CT 坐标转换为虚拟空间坐标
     */
    ctToVirtual(ctX: number, ctY: number, ctZ: number): Vec3 {
        return [
            ctX + this.ctOffset[0],
            ctY + this.ctOffset[1],
            ctZ + this.ctOffset[2],
        ];
    }

    /**
     * 将虚拟空间坐标转换为 CT 坐标
     */
    virtualToCT(vx: number, vy: number, vz: number): Vec3 {
        return [
            vx - this.ctOffset[0],
            vy - this.ctOffset[1],
            vz - this.ctOffset[2],
        ];
    }

    /**
     * 检查坐标是否在 CT 范围内
     */
    isInCTBounds(vx: number, vy: number, vz: number, ctDimensions: Vec3): boolean {
        const [cx, cy, cz] = this.virtualToCT(vx, vy, vz);
        return (
            cx >= 0 && cx < ctDimensions[0] &&
            cy >= 0 && cy < ctDimensions[1] &&
            cz >= 0 && cz < ctDimensions[2]
        );
    }

    /**
     * 清理空块（压缩存储）
     */
    compactBlocks(): number {
        let removedCount = 0;
        for (const [key, block] of this.blocks) {
            let isEmpty = true;
            for (const layer of block.bitmaskLayers) {
                for (let i = 0; i < layer.length; i++) {
                    if (layer[i] !== 0) {
                        isEmpty = false;
                        break;
                    }
                }
                if (!isEmpty) break;
            }
            if (isEmpty) {
                this.blocks.delete(key);
                removedCount++;
            }
        }
        return removedCount;
    }

    /**
     * 获取统计信息
     */
    getStats() {
        return {
            blockCount: this.blocks.size,
            estimatedMemoryMB: (this.blocks.size * BLOCK_SIZE ** 3 * 16) / (1024 * 1024),
        };
    }

    /**
     * 获取指定切片的 2D ROI mask（用于轮廓提取）
     * @param sliceIndex 切片索引
     * @param viewType 视图类型 ('axial' | 'sagittal' | 'coronal')
     * @param roiId 指定 ROI ID，如果为 -1 则返回所有 ROI 的合并 mask
     * @param width 输出 mask 宽度
     * @param height 输出 mask 高度
     * @returns Uint8Array，1 表示 ROI 内部，0 表示外部
     */
    getSliceMask(
        sliceIndex: number,
        viewType: 'axial' | 'sagittal' | 'coronal',
        roiId: number,
        width: number,
        height: number
    ): Uint8Array {
        const mask = new Uint8Array(width * height);

        for (let j = 0; j < height; j++) {
            for (let i = 0; i < width; i++) {
                let x: number, y: number, z: number;

                // 根据视图类型确定 3D 坐标
                switch (viewType) {
                    case 'axial':
                        // Axial: XY 平面，Z 固定
                        x = i;
                        y = j;
                        z = sliceIndex;
                        break;
                    case 'sagittal':
                        // Sagittal: YZ 平面，X 固定
                        x = sliceIndex;
                        y = i;
                        z = j;
                        break;
                    case 'coronal':
                        // Coronal: XZ 平面，Y 固定
                        x = i;
                        y = sliceIndex;
                        z = j;
                        break;
                }

                // 检查该体素是否属于指定 ROI
                const rois = this.getVoxelROIs(x, y, z);
                if (roiId === -1) {
                    // 任意 ROI 都算
                    mask[j * width + i] = rois.length > 0 ? 1 : 0;
                } else {
                    // 特定 ROI
                    mask[j * width + i] = rois.includes(roiId) ? 1 : 0;
                }
            }
        }

        return mask;
    }

    /**
     * 获取指定切片上所有 ROI 的 mask（按 ROI ID 分组）
     * @param sliceIndex 切片索引
     * @param viewType 视图类型
     * @param width 输出 mask 宽度
     * @param height 输出 mask 高度
     * @returns Map<roiId, Uint8Array>
     */
    getSliceMasks(
        sliceIndex: number,
        viewType: 'axial' | 'sagittal' | 'coronal',
        width: number,
        height: number
    ): Map<number, Uint8Array> {
        const masks = new Map<number, Uint8Array>();

        // Debug: log input params and block stats
        console.log('[getSliceMasks] Input:', { sliceIndex, viewType, width, height });
        console.log('[getSliceMasks] ctOffset:', this.ctOffset);
        console.log('[getSliceMasks] blocks.size:', this.blocks.size);

        // Debug: sample coordinate conversion
        const sampleCtX = Math.floor(width / 2);
        const sampleCtY = Math.floor(height / 2);
        const [sampleVx, sampleVy, sampleVz] = this.ctToVirtual(sampleCtX, sampleCtY, sliceIndex);
        console.log('[getSliceMasks] Sample conversion:', {
            ct: [sampleCtX, sampleCtY, sliceIndex],
            virtual: [sampleVx, sampleVy, sampleVz]
        });

        // Debug: check if there are any blocks at all
        if (this.blocks.size > 0) {
            const firstBlockKey = Array.from(this.blocks.keys())[0];
            console.log('[getSliceMasks] First block key:', firstBlockKey);
        }

        // 先收集所有可能的 ROI ID
        const roiIds = new Set<number>();

        for (let j = 0; j < height; j++) {
            for (let i = 0; i < width; i++) {
                let ctX: number, ctY: number, ctZ: number;

                switch (viewType) {
                    case 'axial':
                        ctX = i; ctY = j; ctZ = sliceIndex;
                        break;
                    case 'sagittal':
                        ctX = sliceIndex; ctY = i; ctZ = j;
                        break;
                    case 'coronal':
                        ctX = i; ctY = sliceIndex; ctZ = j;
                        break;
                }

                // 将 CT 坐标转换为虚拟坐标（ROI 数据存储在虚拟坐标系中）
                const [vx, vy, vz] = this.ctToVirtual(ctX, ctY, ctZ);

                const rois = this.getVoxelROIs(vx, vy, vz);
                for (const id of rois) {
                    roiIds.add(id);

                    if (!masks.has(id)) {
                        masks.set(id, new Uint8Array(width * height));
                    }
                    masks.get(id)![j * width + i] = 1;
                }
            }
        }

        console.log('[getSliceMasks] Result: masks.size=', masks.size, 'roiIds=', Array.from(roiIds));

        return masks;
    }
}

// 单例导出
export const roiManager = new SparseROIManager();
