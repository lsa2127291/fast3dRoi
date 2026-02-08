/**
 * 2D 笔刷工具
 * 在 MPR 视图上进行 ROI 勾画
 */

import type { Vec3, ViewType } from '@/core/types';
import { eventBus } from '@/core/EventBus';
import { roiManager } from './SparseROIManager';

export interface BrushConfig {
    /** 笔刷半径（像素） */
    radius: number;
    /** 当前 ROI ID */
    roiId: number;
    /** 是否为擦除模式 */
    eraseMode: boolean;
    /** 笔刷形状 */
    shape: 'circle' | 'square';
}

/**
 * 2D 笔刷工具
 */
export class BrushTool {
    private config: BrushConfig = {
        radius: 5,
        roiId: 1,
        eraseMode: false,
        shape: 'circle',
    };

    private isDrawing = false;
    private lastPoint: Vec3 | null = null;

    /**
     * 设置笔刷配置
     */
    setConfig(config: Partial<BrushConfig>): void {
        Object.assign(this.config, config);
    }

    /**
     * 获取当前配置
     */
    getConfig(): BrushConfig {
        return { ...this.config };
    }

    /**
     * 设置当前 ROI ID
     */
    setROI(roiId: number): void {
        this.config.roiId = roiId;
    }

    /**
     * 设置笔刷半径
     */
    setRadius(radius: number): void {
        this.config.radius = radius;
    }

    /**
     * 设置擦除模式
     */
    setEraseMode(eraseMode: boolean): void {
        this.config.eraseMode = eraseMode;
    }

    /**
     * 开始绘制
     */
    beginStroke(): void {
        this.isDrawing = true;
        this.lastPoint = null;
    }

    /**
     * 结束绘制
     */
    endStroke(): void {
        this.isDrawing = false;
        this.lastPoint = null;
    }

    /**
     * 绘制点（在 MPR 视图坐标系下）
     * @param viewType 视图类型
     * @param sliceIndex 当前切片索引
     * @param x 视图 X 坐标（像素）
     * @param y 视图 Y 坐标（像素）
     * @param ctDimensions CT 原始尺寸
     */
    paint(
        viewType: ViewType,
        sliceIndex: number,
        x: number,
        y: number,
        _ctDimensions: Vec3
    ): Vec3[] {
        if (!this.isDrawing) return [];

        // 将 2D 视图坐标转换为 3D 体素坐标
        const voxelCoord = this.viewToVoxel(viewType, sliceIndex, x, y);
        if (!voxelCoord) return [];

        // 转换为虚拟空间坐标
        const [vx, vy, vz] = roiManager.ctToVirtual(
            voxelCoord[0],
            voxelCoord[1],
            voxelCoord[2]
        );

        // 绘制
        let affectedVoxels: Vec3[];
        if (this.config.shape === 'circle') {
            affectedVoxels = roiManager.paintSphere(
                Math.round(vx),
                Math.round(vy),
                Math.round(vz),
                this.config.radius,
                this.config.roiId,
                this.config.eraseMode
            );
        } else {
            affectedVoxels = this.paintSquare(
                Math.round(vx),
                Math.round(vy),
                Math.round(vz)
            );
        }

        // 插值：填充上次点到当前点之间的间隙
        if (this.lastPoint) {
            const interpolated = this.interpolateStroke(this.lastPoint, [vx, vy, vz]);
            for (const pt of interpolated) {
                const more = roiManager.paintSphere(
                    Math.round(pt[0]),
                    Math.round(pt[1]),
                    Math.round(pt[2]),
                    this.config.radius,
                    this.config.roiId,
                    this.config.eraseMode
                );
                affectedVoxels.push(...more);
            }
        }

        this.lastPoint = [vx, vy, vz];

        // 发送事件
        if (affectedVoxels.length > 0) {
            eventBus.emit('roi:paint', {
                roiId: this.config.roiId,
                voxels: affectedVoxels,
            });
        }

        return affectedVoxels;
    }

    /**
     * 将视图坐标转换为体素坐标
     */
    private viewToVoxel(
        viewType: ViewType,
        sliceIndex: number,
        x: number,
        y: number
    ): Vec3 | null {
        // 根据视图类型映射坐标
        switch (viewType) {
            case 'axial':
                // XY 平面，Z 为切片
                return [x, y, sliceIndex];
            case 'sagittal':
                // YZ 平面，X 为切片
                return [sliceIndex, y, x];
            case 'coronal':
                // XZ 平面，Y 为切片
                return [x, sliceIndex, y];
            default:
                return null;
        }
    }

    /**
     * 方形笔刷绘制
     */
    private paintSquare(cx: number, cy: number, cz: number): Vec3[] {
        const affectedVoxels: Vec3[] = [];
        const r = this.config.radius;
        const info = roiManager.getVirtualSpaceInfo();

        for (let dy = -r; dy <= r; dy++) {
            for (let dx = -r; dx <= r; dx++) {
                const x = cx + dx;
                const y = cy + dy;
                const z = cz;

                if (
                    x >= 0 && x < info.dimensions[0] &&
                    y >= 0 && y < info.dimensions[1] &&
                    z >= 0 && z < info.dimensions[2]
                ) {
                    roiManager.setVoxelROI(x, y, z, this.config.roiId, !this.config.eraseMode);
                    affectedVoxels.push([x, y, z]);
                }
            }
        }

        return affectedVoxels;
    }

    /**
     * 插值笔画（Bresenham 3D）
     */
    private interpolateStroke(from: Vec3, to: Vec3): Vec3[] {
        const points: Vec3[] = [];
        const dx = Math.abs(to[0] - from[0]);
        const dy = Math.abs(to[1] - from[1]);
        const dz = Math.abs(to[2] - from[2]);
        const maxDist = Math.max(dx, dy, dz);

        if (maxDist <= 1) return points;

        const stepX = (to[0] - from[0]) / maxDist;
        const stepY = (to[1] - from[1]) / maxDist;
        const stepZ = (to[2] - from[2]) / maxDist;

        // 跳过起点和终点，只插值中间点
        for (let i = 1; i < maxDist; i++) {
            points.push([
                from[0] + stepX * i,
                from[1] + stepY * i,
                from[2] + stepZ * i,
            ]);
        }

        return points;
    }
}

// 单例导出
export const brushTool = new BrushTool();
