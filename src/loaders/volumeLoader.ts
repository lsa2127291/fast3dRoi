/**
 * 统一体数据加载器
 * 自动识别 DICOM/NIfTI 格式并加载
 */

import type { VolumeData, VolumeMetadata, TypedArray } from '@/core/types';
import { loadDicom } from './dicomLoader';
import { loadNifti } from './niftiLoader';

export type LoadProgress = {
    loaded: number;
    total: number;
    stage: 'fetch' | 'parse' | 'process';
};

export type ProgressCallback = (progress: LoadProgress) => void;

/**
 * 检测文件类型
 */
function detectFileType(files: File[]): 'dicom' | 'nifti' | 'unknown' {
    if (files.length === 0) return 'unknown';

    const firstFile = files[0];
    const name = firstFile.name.toLowerCase();

    // NIfTI 检测
    if (name.endsWith('.nii') || name.endsWith('.nii.gz')) {
        return 'nifti';
    }

    // DICOM 检测（多文件或 .dcm 扩展名）
    if (name.endsWith('.dcm') || files.length > 1) {
        return 'dicom';
    }

    // 默认尝试 DICOM
    return 'dicom';
}

/**
 * 加载体数据
 * @param files 文件列表（DICOM 序列或单个 NIfTI 文件）
 * @param onProgress 进度回调
 */
export async function loadVolume(
    files: File[],
    onProgress?: ProgressCallback
): Promise<VolumeData> {
    const fileType = detectFileType(files);

    switch (fileType) {
        case 'nifti':
            return loadNifti(files[0], onProgress);
        case 'dicom':
            return loadDicom(files, onProgress);
        default:
            throw new Error('无法识别的文件格式');
    }
}

/**
 * 从 URL 加载体数据
 */
export async function loadVolumeFromUrl(
    url: string,
    onProgress?: ProgressCallback
): Promise<VolumeData> {
    onProgress?.({ loaded: 0, total: 1, stage: 'fetch' });

    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`加载失败: ${response.status}`);
    }

    const blob = await response.blob();
    const fileName = url.split('/').pop() || 'data';
    const file = new File([blob], fileName);

    return loadVolume([file], onProgress);
}

/**
 * 创建空白体数据（用于初始化）
 */
export function createEmptyVolume(metadata: VolumeMetadata): VolumeData {
    const [w, h, d] = metadata.dimensions;
    const totalVoxels = w * h * d;

    let pixelData: TypedArray;
    switch (metadata.dataType) {
        case 'int8':
            pixelData = new Int8Array(totalVoxels);
            break;
        case 'uint8':
            pixelData = new Uint8Array(totalVoxels);
            break;
        case 'int16':
            pixelData = new Int16Array(totalVoxels);
            break;
        case 'uint16':
            pixelData = new Uint16Array(totalVoxels);
            break;
        case 'float32':
            pixelData = new Float32Array(totalVoxels);
            break;
        default:
            pixelData = new Int16Array(totalVoxels);
    }

    return { metadata, pixelData };
}
