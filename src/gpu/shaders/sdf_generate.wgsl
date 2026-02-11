struct BrushParams {
    center_radius: vec4<f32>,      // xyz: center(texel), w: radius(texel)
    erase_count_size: vec4<f32>,   // x: erase flag, y: brick count, z: brick_size, w: groups_per_axis
};

@group(0) @binding(0) var sdf_write: texture_storage_3d<r16float, write>;
@group(0) @binding(1) var<storage, read> brick_origins: array<vec4<u32>>;
@group(0) @binding(2) var<uniform> params: BrushParams;

@compute @workgroup_size(8, 8, 8)
fn main(
    @builtin(workgroup_id) workgroup_id: vec3<u32>,
    @builtin(local_invocation_id) local_id: vec3<u32>
) {
    let groups_per_axis = u32(params.erase_count_size.w);
    let brick_size = u32(params.erase_count_size.z);
    let brick_count = u32(params.erase_count_size.y);

    let brick_index = workgroup_id.z / groups_per_axis;
    if (brick_index >= brick_count) {
        return;
    }

    let local_group_z = workgroup_id.z - brick_index * groups_per_axis;
    let local_voxel = vec3<u32>(
        workgroup_id.x * 8u + local_id.x,
        workgroup_id.y * 8u + local_id.y,
        local_group_z * 8u + local_id.z
    );

    if (local_voxel.x >= brick_size || local_voxel.y >= brick_size || local_voxel.z >= brick_size) {
        return;
    }

    let origin = brick_origins[brick_index].xyz;
    let texel = origin + local_voxel;
    let texel_i = vec3<i32>(texel);
    let p = vec3<f32>(f32(texel.x), f32(texel.y), f32(texel.z));
    let dist = distance(p, params.center_radius.xyz) - params.center_radius.w;
    let erase_mode = params.erase_count_size.x > 0.5;
    let next = select(dist, -dist, erase_mode);

    textureStore(sdf_write, texel_i, vec4<f32>(next, 0.0, 0.0, 0.0));
}
