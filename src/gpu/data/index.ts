/**
 * GPU 数据模块桶导出
 */

export {
    quantize,
    isQuantInRange,
    packVertexQ,
    decodeVertexQ,
    getVertexFlags,
    writeVertexQToBuffer,
    writeQuantMetaToBuffer,
    createDefaultQuantMeta,
} from './VertexQ';

export type {
    VertexQEncoded,
    QuantMeta,
    QuantResult,
} from './VertexQ';

export {
    VertexPool,
    IndexPool,
} from './ResourcePools';

export type {
    PageAllocation,
    PoolStats,
} from './ResourcePools';

export {
    ChunkTable,
} from './ChunkTable';

export type {
    AABB,
    ChunkDescriptor,
} from './ChunkTable';
