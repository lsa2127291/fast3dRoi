/**
 * NIfTI 文件加载器
 * 基于 nifti-reader-js 实现
 */

import type { VolumeData, VolumeMetadata, Vec3, TypedArray } from '@/core/types';
import type { ProgressCallback } from './volumeLoader';
import * as nifti from 'nifti-reader-js';

/**
 * 加载 NIfTI 文件
 */
export async function loadNifti(
    file: File,
    onProgress?: ProgressCallback
): Promise<VolumeData> {
    onProgress?.({ loaded: 0, total: 1, stage: 'fetch' });

    let data = await file.arrayBuffer();

    // 检查是否为 gzip 压缩
    if (nifti.isCompressed(data)) {
        onProgress?.({ loaded: 0.3, total: 1, stage: 'parse' });
        data = nifti.decompress(data) as ArrayBuffer;
    }

    // 检查是否为有效 NIfTI 文件
    if (!nifti.isNIFTI(data)) {
        throw new Error('不是有效的 NIfTI 文件');
    }

    onProgress?.({ loaded: 0.5, total: 1, stage: 'parse' });

    // 解析头部
    const header = nifti.readHeader(data);
    if (!header) {
        throw new Error('无法解析 NIfTI 头部');
    }

    // 读取图像数据
    const imageData = nifti.readImage(header, data);

    onProgress?.({ loaded: 0.8, total: 1, stage: 'process' });

    // 构建维度信息
    const dimensions: Vec3 = [
        header.dims[1],
        header.dims[2],
        header.dims[3],
    ];

    const spacing: Vec3 = [
        Math.abs(header.pixDims[1]),
        Math.abs(header.pixDims[2]),
        Math.abs(header.pixDims[3]),
    ];

    // 确定数据类型并转换
    let pixelData: TypedArray;
    let dataType: VolumeMetadata['dataType'];

    switch (header.datatypeCode) {
        case nifti.NIFTI1.TYPE_UINT8:
            pixelData = new Uint8Array(imageData);
            dataType = 'uint8';
            break;
        case nifti.NIFTI1.TYPE_INT16:
            pixelData = new Int16Array(imageData);
            dataType = 'int16';
            break;
        case nifti.NIFTI1.TYPE_INT32:
            pixelData = new Int32Array(imageData);
            dataType = 'int32';
            break;
        case nifti.NIFTI1.TYPE_FLOAT32:
            pixelData = new Float32Array(imageData);
            dataType = 'float32';
            break;
        case nifti.NIFTI1.TYPE_FLOAT64:
            pixelData = new Float64Array(imageData);
            dataType = 'float64';
            break;
        case nifti.NIFTI1.TYPE_UINT16:
            pixelData = new Uint16Array(imageData);
            dataType = 'uint16';
            break;
        default:
            // 默认转为 Int16
            pixelData = new Int16Array(imageData);
            dataType = 'int16';
    }

    // 应用缩放系数（如果有）
    if (header.scl_slope !== 0 && header.scl_slope !== 1) {
        const slope = header.scl_slope;
        const intercept = header.scl_inter;
        for (let i = 0; i < pixelData.length; i++) {
            pixelData[i] = pixelData[i] * slope + intercept;
        }
    }

    // 构建方向矩阵
    const direction = new Float64Array(9);
    if (header.qform_code > 0) {
        // 使用四元数方向
        const { quatern_b, quatern_c, quatern_d } = header;
        const a = Math.sqrt(1 - quatern_b * quatern_b - quatern_c * quatern_c - quatern_d * quatern_d);

        direction[0] = 1 - 2 * (quatern_c * quatern_c + quatern_d * quatern_d);
        direction[1] = 2 * (quatern_b * quatern_c - quatern_d * a);
        direction[2] = 2 * (quatern_b * quatern_d + quatern_c * a);
        direction[3] = 2 * (quatern_b * quatern_c + quatern_d * a);
        direction[4] = 1 - 2 * (quatern_b * quatern_b + quatern_d * quatern_d);
        direction[5] = 2 * (quatern_c * quatern_d - quatern_b * a);
        direction[6] = 2 * (quatern_b * quatern_d - quatern_c * a);
        direction[7] = 2 * (quatern_c * quatern_d + quatern_b * a);
        direction[8] = 1 - 2 * (quatern_b * quatern_b + quatern_c * quatern_c);
    } else {
        // 默认单位矩阵
        direction[0] = 1; direction[4] = 1; direction[8] = 1;
    }

    const origin: Vec3 = [
        header.qoffset_x || 0,
        header.qoffset_y || 0,
        header.qoffset_z || 0,
    ];

    onProgress?.({ loaded: 1, total: 1, stage: 'process' });

    const metadata: VolumeMetadata = {
        dimensions,
        spacing,
        origin,
        direction,
        dataType,
        modality: 'MR', // NIfTI 通常用于 MRI
    };

    return { metadata, pixelData };
}
