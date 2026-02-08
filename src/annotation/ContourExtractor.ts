/**
 * ContourExtractor - 高精度实时轮廓提取
 * 使用 Marching Squares 算法从 2D ROI mask 提取轮廓线
 */

export interface Point2D {
    x: number;
    y: number;
}

export interface ContourSegment {
    start: Point2D;
    end: Point2D;
}

export interface Contour {
    roiId: number;
    segments: ContourSegment[];
    // 连接后的闭合路径（用于 Canvas 绘制）
    paths: Point2D[][];
}

// Marching Squares 查找表：16 种情况对应的边交点
// 每个 case 返回 0-2 条线段，线段端点在单元格边上（用 0-3 表示边：上/右/下/左）
const MS_LOOKUP: number[][][] = [
    [],                         // 0: 0000 - 无
    [[3, 2]],                   // 1: 0001 - 左下
    [[2, 1]],                   // 2: 0010 - 右下
    [[3, 1]],                   // 3: 0011 - 下半
    [[0, 1]],                   // 4: 0100 - 右上
    [[3, 0], [2, 1]],           // 5: 0101 - 对角（歧义情况1）
    [[0, 2]],                   // 6: 0110 - 右半
    [[3, 0]],                   // 7: 0111 - 左上角外
    [[0, 3]],                   // 8: 1000 - 左上
    [[0, 2]],                   // 9: 1001 - 左半
    [[0, 3], [2, 1]],           // 10: 1010 - 对角（歧义情况2）
    [[0, 1]],                   // 11: 1011 - 右上角外
    [[1, 3]],                   // 12: 1100 - 上半
    [[1, 2]],                   // 13: 1101 - 右下角外
    [[2, 3]],                   // 14: 1110 - 左下角外
    []                          // 15: 1111 - 全内
];

// 边的中点偏移（相对于单元格左下角）
// 边 0: 上边 (0.5, 1), 边 1: 右边 (1, 0.5), 边 2: 下边 (0.5, 0), 边 3: 左边 (0, 0.5)
const EDGE_OFFSETS: [number, number][] = [
    [0.5, 1],   // 上
    [1, 0.5],   // 右
    [0.5, 0],   // 下
    [0, 0.5]    // 左
];

/**
 * 从 2D mask 提取轮廓线段
 * @param mask 2D 二值数组 (height x width)，1 表示 ROI 内部
 * @param width mask 宽度
 * @param height mask 高度
 * @returns 轮廓线段列表
 */
export function extractContourSegments(
    mask: Uint8Array | number[],
    width: number,
    height: number
): ContourSegment[] {
    const segments: ContourSegment[] = [];

    // 遍历每个 2x2 单元格
    for (let y = 0; y < height - 1; y++) {
        for (let x = 0; x < width - 1; x++) {
            // 计算单元格四个角的值（左下为原点）
            const bl = mask[y * width + x] ? 1 : 0;         // 左下
            const br = mask[y * width + x + 1] ? 1 : 0;     // 右下
            const tr = mask[(y + 1) * width + x + 1] ? 1 : 0; // 右上
            const tl = mask[(y + 1) * width + x] ? 1 : 0;   // 左上

            // 计算 case index (0-15)
            const caseIndex = (tl << 3) | (tr << 2) | (br << 1) | bl;

            // 查表获取线段
            const edges = MS_LOOKUP[caseIndex];
            for (const [e1, e2] of edges) {
                const [ox1, oy1] = EDGE_OFFSETS[e1];
                const [ox2, oy2] = EDGE_OFFSETS[e2];

                segments.push({
                    start: { x: x + ox1, y: y + oy1 },
                    end: { x: x + ox2, y: y + oy2 }
                });
            }
        }
    }

    return segments;
}

/**
 * 将线段连接成闭合路径（用于 Canvas 绘制）
 * @param segments 线段列表
 * @returns 闭合路径数组
 */
export function connectSegments(segments: ContourSegment[]): Point2D[][] {
    if (segments.length === 0) return [];

    const paths: Point2D[][] = [];
    const used = new Set<number>();
    const tolerance = 0.001; // 连接容差

    // 辅助函数：判断两点是否相近
    const isClose = (p1: Point2D, p2: Point2D) =>
        Math.abs(p1.x - p2.x) < tolerance && Math.abs(p1.y - p2.y) < tolerance;

    // 构建邻接索引（加速查找）
    const startIndex = new Map<string, number[]>();
    const endIndex = new Map<string, number[]>();

    const key = (p: Point2D) => `${p.x.toFixed(3)},${p.y.toFixed(3)}`;

    for (let i = 0; i < segments.length; i++) {
        const sk = key(segments[i].start);
        const ek = key(segments[i].end);

        if (!startIndex.has(sk)) startIndex.set(sk, []);
        startIndex.get(sk)!.push(i);

        if (!endIndex.has(ek)) endIndex.set(ek, []);
        endIndex.get(ek)!.push(i);
    }

    // 从每个未使用的线段开始构建路径
    for (let i = 0; i < segments.length; i++) {
        if (used.has(i)) continue;

        const path: Point2D[] = [segments[i].start, segments[i].end];
        used.add(i);

        let changed = true;
        while (changed) {
            changed = false;
            const lastPoint = path[path.length - 1];
            const lastKey = key(lastPoint);

            // 查找可以连接到末尾的线段
            const candidates = startIndex.get(lastKey) || [];
            for (const idx of candidates) {
                if (!used.has(idx) && isClose(segments[idx].start, lastPoint)) {
                    path.push(segments[idx].end);
                    used.add(idx);
                    changed = true;
                    break;
                }
            }

            // 也检查反向连接
            if (!changed) {
                const endCandidates = endIndex.get(lastKey) || [];
                for (const idx of endCandidates) {
                    if (!used.has(idx) && isClose(segments[idx].end, lastPoint)) {
                        path.push(segments[idx].start);
                        used.add(idx);
                        changed = true;
                        break;
                    }
                }
            }
        }

        if (path.length >= 3) {
            paths.push(path);
        }
    }

    return paths;
}

/**
 * 高精度轮廓提取（完整流程）
 */
export function extractContour(
    mask: Uint8Array | number[],
    width: number,
    height: number,
    roiId: number
): Contour {
    const segments = extractContourSegments(mask, width, height);
    const paths = connectSegments(segments);

    return { roiId, segments, paths };
}

/**
 * 批量提取多个 ROI 的轮廓
 */
export function extractMultipleContours(
    masks: Map<number, Uint8Array>,
    width: number,
    height: number
): Contour[] {
    const contours: Contour[] = [];

    for (const [roiId, mask] of masks) {
        const contour = extractContour(mask, width, height, roiId);
        if (contour.paths.length > 0) {
            contours.push(contour);
        }
    }

    return contours;
}
