/**
 * Marching Cubes 网格生成器
 * 从稀疏 ROI 数据生成三角网格
 * 
 * 修复：处理块边界裂缝问题 - 使用全局体素访问方法
 */

import { EDGE_TABLE, TRI_TABLE, VERTEX_OFFSETS, EDGE_VERTICES } from './MarchingCubesLUT';
import { roiManager } from '@/annotation/SparseROIManager';
import type { Vec3 } from '@/core/types';
import { BLOCK_SIZE } from '@/core/types';

/**
 * ROI 网格数据
 */
export interface ROIMesh {
    roiId: number;
    vertices: Float32Array;   // [x1,y1,z1, x2,y2,z2, ...]
    normals: Float32Array;    // [nx1,ny1,nz1, ...]
    indices: Uint32Array;     // 三角形索引
    vertexCount: number;
    triangleCount: number;
}

/**
 * Marching Cubes 网格生成器
 */
export class MarchingCubesMeshGenerator {
    private spacing: Vec3 = [1, 1, 1];

    /**
     * 设置体素间距（用于物理坐标转换）
     */
    setSpacing(spacing: Vec3): void {
        this.spacing = spacing;
    }

    /**
     * 生成指定 ROI 的完整网格
     */
    generateMesh(roiId: number): ROIMesh | null {
        const vertices: number[] = [];
        const normals: number[] = [];
        const indices: number[] = [];

        const blocks = roiManager.getAllBlocks();
        if (blocks.length === 0) return null;

        const virtualInfo = roiManager.getVirtualSpaceInfo();

        // 计算所有块的边界框
        let minBx = Infinity, minBy = Infinity, minBz = Infinity;
        let maxBx = -Infinity, maxBy = -Infinity, maxBz = -Infinity;

        for (const block of blocks) {
            const { bx, by, bz } = block.coord;
            minBx = Math.min(minBx, bx);
            minBy = Math.min(minBy, by);
            minBz = Math.min(minBz, bz);
            maxBx = Math.max(maxBx, bx);
            maxBy = Math.max(maxBy, by);
            maxBz = Math.max(maxBz, bz);
        }

        // 计算全局体素范围
        const startX = minBx * BLOCK_SIZE;
        const startY = minBy * BLOCK_SIZE;
        const startZ = minBz * BLOCK_SIZE;
        const endX = (maxBx + 1) * BLOCK_SIZE;
        const endY = (maxBy + 1) * BLOCK_SIZE;
        const endZ = (maxBz + 1) * BLOCK_SIZE;

        // 遍历全局体素范围内的所有体素立方体
        for (let gz = startZ; gz < endZ; gz++) {
            for (let gy = startY; gy < endY; gy++) {
                for (let gx = startX; gx < endX; gx++) {
                    // 获取立方体 8 个顶点的值（跨块访问）
                    const cubeIndex = this.getCubeIndexGlobal(gx, gy, gz, roiId);

                    if (cubeIndex === 0 || cubeIndex === 255) continue;

                    const edgeMask = EDGE_TABLE[cubeIndex];
                    if (edgeMask === 0) continue;

                    // 转换为 CT 坐标
                    const ctX = gx - virtualInfo.ctOffset[0];
                    const ctY = gy - virtualInfo.ctOffset[1];
                    const ctZ = gz - virtualInfo.ctOffset[2];

                    // 计算边上的交点
                    const edgeVertices: [number, number, number][] = new Array(12);
                    for (let e = 0; e < 12; e++) {
                        if (edgeMask & (1 << e)) {
                            edgeVertices[e] = this.interpolateEdge(e, ctX, ctY, ctZ);
                        }
                    }

                    // 生成三角形
                    const triList = TRI_TABLE[cubeIndex];
                    for (let t = 0; triList[t] !== -1; t += 3) {
                        const baseVertexIndex = vertices.length / 3;

                        for (let v = 0; v < 3; v++) {
                            const edgeIdx = triList[t + v];
                            const vertex = edgeVertices[edgeIdx];
                            if (vertex) {
                                // 转换为物理坐标
                                vertices.push(
                                    vertex[0] * this.spacing[0],
                                    vertex[1] * this.spacing[1],
                                    vertex[2] * this.spacing[2]
                                );
                            }
                        }

                        indices.push(
                            baseVertexIndex,
                            baseVertexIndex + 1,
                            baseVertexIndex + 2
                        );
                    }
                }
            }
        }

        if (vertices.length === 0) return null;

        // 计算法线
        this.computeNormals(vertices, indices, normals);

        return {
            roiId,
            vertices: new Float32Array(vertices),
            normals: new Float32Array(normals),
            indices: new Uint32Array(indices),
            vertexCount: vertices.length / 3,
            triangleCount: indices.length / 3,
        };
    }

    /**
     * 全局体素访问方式获取立方体配置索引
     * 使用 roiManager.getVoxelROIs 进行跨块访问
     */
    private getCubeIndexGlobal(gx: number, gy: number, gz: number, roiId: number): number {
        let cubeIndex = 0;

        for (let i = 0; i < 8; i++) {
            const [dx, dy, dz] = VERTEX_OFFSETS[i];
            const vx = gx + dx;
            const vy = gy + dy;
            const vz = gz + dz;

            // 使用 roiManager 的全局访问方法
            const rois = roiManager.getVoxelROIs(vx, vy, vz);
            if (rois.includes(roiId)) {
                cubeIndex |= (1 << i);
            }
        }

        return cubeIndex;
    }

    /**
     * 计算边上的交点位置（简化版：取边中点）
     */
    private interpolateEdge(
        edgeIndex: number,
        baseX: number, baseY: number, baseZ: number
    ): [number, number, number] {
        const [v1Idx, v2Idx] = EDGE_VERTICES[edgeIndex];
        const v1 = VERTEX_OFFSETS[v1Idx];
        const v2 = VERTEX_OFFSETS[v2Idx];

        // 对于二值数据，取边的中点
        return [
            baseX + (v1[0] + v2[0]) / 2,
            baseY + (v1[1] + v2[1]) / 2,
            baseZ + (v1[2] + v2[2]) / 2,
        ];
    }

    /**
     * 计算顶点法线
     */
    private computeNormals(
        vertices: number[],
        indices: number[],
        normals: number[]
    ): void {
        const vertexCount = vertices.length / 3;

        // 初始化法线数组
        for (let i = 0; i < vertexCount * 3; i++) {
            normals.push(0);
        }

        // 累加每个三角形对顶点法线的贡献
        for (let i = 0; i < indices.length; i += 3) {
            const i0 = indices[i] * 3;
            const i1 = indices[i + 1] * 3;
            const i2 = indices[i + 2] * 3;

            // 计算三角形两条边
            const ax = vertices[i1] - vertices[i0];
            const ay = vertices[i1 + 1] - vertices[i0 + 1];
            const az = vertices[i1 + 2] - vertices[i0 + 2];

            const bx = vertices[i2] - vertices[i0];
            const by = vertices[i2 + 1] - vertices[i0 + 1];
            const bz = vertices[i2 + 2] - vertices[i0 + 2];

            // 叉积
            const nx = ay * bz - az * by;
            const ny = az * bx - ax * bz;
            const nz = ax * by - ay * bx;

            // 累加到每个顶点
            normals[i0] += nx; normals[i0 + 1] += ny; normals[i0 + 2] += nz;
            normals[i1] += nx; normals[i1 + 1] += ny; normals[i1 + 2] += nz;
            normals[i2] += nx; normals[i2 + 1] += ny; normals[i2 + 2] += nz;
        }

        // 归一化
        for (let i = 0; i < vertexCount; i++) {
            const idx = i * 3;
            const len = Math.sqrt(
                normals[idx] * normals[idx] +
                normals[idx + 1] * normals[idx + 1] +
                normals[idx + 2] * normals[idx + 2]
            );
            if (len > 0) {
                normals[idx] /= len;
                normals[idx + 1] /= len;
                normals[idx + 2] /= len;
            }
        }
    }
}

// 单例导出
export const meshGenerator = new MarchingCubesMeshGenerator();
