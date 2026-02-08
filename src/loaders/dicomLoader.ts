/**
 * DICOM 文件加载器
 * 基于 dcmjs 实现
 */

import type { VolumeData, VolumeMetadata, Vec3 } from '@/core/types';
import type { ProgressCallback } from './volumeLoader';

// dcmjs 类型声明（简化）
declare const dcmjs: {
    data: {
        DicomMessage: {
            readFile: (arrayBuffer: ArrayBuffer) => {
                dict: Record<string, { Value: unknown[] }>;
            };
        };
    };
};

interface DicomImage {
    pixelData: ArrayBuffer;
    rows: number;
    columns: number;
    sliceLocation: number;
    sliceThickness: number;
    pixelSpacing: [number, number];
    rescaleSlope: number;
    rescaleIntercept: number;
    windowCenter?: number;
    windowWidth?: number;
    bitsAllocated: number;
    pixelRepresentation: number;
}

/**
 * 解析单个 DICOM 文件
 */
async function parseDicomFile(file: File): Promise<DicomImage> {
    const arrayBuffer = await file.arrayBuffer();
    const dicomData = dcmjs.data.DicomMessage.readFile(arrayBuffer);

    const getValue = (tag: string, defaultValue: unknown = null): unknown => {
        const entry = dicomData.dict[tag];
        return entry?.Value?.[0] ?? defaultValue;
    };

    const pixelDataTag = 'x7fe00010';
    const pixelDataEntry = dicomData.dict[pixelDataTag];
    const pixelData = pixelDataEntry?.Value?.[0] as ArrayBuffer;

    if (!pixelData) {
        throw new Error('DICOM 文件缺少像素数据');
    }

    const pixelSpacingRaw = getValue('x00280030', [1, 1]) as number[];

    return {
        pixelData,
        rows: getValue('x00280010', 512) as number,
        columns: getValue('x00280011', 512) as number,
        sliceLocation: getValue('x00201041', 0) as number,
        sliceThickness: getValue('x00180050', 1) as number,
        pixelSpacing: [pixelSpacingRaw[0], pixelSpacingRaw[1]],
        rescaleSlope: getValue('x00281053', 1) as number,
        rescaleIntercept: getValue('x00281052', 0) as number,
        windowCenter: getValue('x00281050') as number | undefined,
        windowWidth: getValue('x00281051') as number | undefined,
        bitsAllocated: getValue('x00280100', 16) as number,
        pixelRepresentation: getValue('x00280103', 0) as number,
    };
}

/**
 * 加载 DICOM 序列
 */
export async function loadDicom(
    files: File[],
    onProgress?: ProgressCallback
): Promise<VolumeData> {
    if (files.length === 0) {
        throw new Error('未提供 DICOM 文件');
    }

    // 解析所有文件
    const images: DicomImage[] = [];
    for (let i = 0; i < files.length; i++) {
        onProgress?.({
            loaded: i,
            total: files.length,
            stage: 'parse',
        });
        const image = await parseDicomFile(files[i]);
        images.push(image);
    }

    // 按切片位置排序
    images.sort((a, b) => a.sliceLocation - b.sliceLocation);

    // 计算层间距
    let sliceSpacing = images[0].sliceThickness;
    if (images.length > 1) {
        sliceSpacing = Math.abs(images[1].sliceLocation - images[0].sliceLocation);
    }

    const firstImage = images[0];
    const dimensions: Vec3 = [
        firstImage.columns,
        firstImage.rows,
        images.length,
    ];
    const spacing: Vec3 = [
        firstImage.pixelSpacing[0],
        firstImage.pixelSpacing[1],
        sliceSpacing,
    ];

    // 确定数据类型
    const isSigned = firstImage.pixelRepresentation === 1;
    const dataType = firstImage.bitsAllocated === 16
        ? (isSigned ? 'int16' : 'uint16')
        : 'uint8';

    // 合并像素数据
    const totalVoxels = dimensions[0] * dimensions[1] * dimensions[2];
    const pixelData = dataType === 'int16'
        ? new Int16Array(totalVoxels)
        : dataType === 'uint16'
            ? new Uint16Array(totalVoxels)
            : new Uint8Array(totalVoxels);

    const sliceSize = dimensions[0] * dimensions[1];
    for (let z = 0; z < images.length; z++) {
        onProgress?.({
            loaded: z,
            total: images.length,
            stage: 'process',
        });

        const img = images[z];
        const srcView = dataType === 'int16'
            ? new Int16Array(img.pixelData)
            : dataType === 'uint16'
                ? new Uint16Array(img.pixelData)
                : new Uint8Array(img.pixelData);

        // 应用 Rescale 变换
        const slope = img.rescaleSlope;
        const intercept = img.rescaleIntercept;
        const offset = z * sliceSize;

        for (let i = 0; i < sliceSize; i++) {
            pixelData[offset + i] = srcView[i] * slope + intercept;
        }
    }

    const metadata: VolumeMetadata = {
        dimensions,
        spacing,
        origin: [0, 0, 0],
        direction: new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]),
        dataType,
        windowWidth: firstImage.windowWidth,
        windowCenter: firstImage.windowCenter,
        modality: 'CT',
    };

    return { metadata, pixelData };
}
