struct Config {
    width: u32,
    height: u32,
    layer_count: u32,
    pixel_count: u32,
};

@group(0) @binding(0) var<storage, read> float_pixels: array<vec4<f32>>;
@group(0) @binding(1) var<storage, read_write> packed_pixels: array<u32>;
@group(0) @binding(2) var<uniform> config: Config;

fn pack_rgba(color: vec4<f32>) -> u32 {
    let value = vec4<u32>(round(clamp(color, vec4<f32>(0.0), vec4<f32>(1.0)) * 255.0));
    return value.r | (value.g << 8u) | (value.b << 16u) | (value.a << 24u);
}

@compute @workgroup_size(256, 1, 1)
fn main(@builtin(global_invocation_id) invocation: vec3<u32>) {
    let index = invocation.x;
    if (index >= config.pixel_count) {
        return;
    }
    packed_pixels[index] = pack_rgba(float_pixels[index]);
}
