struct LensUniform {
    focus_distance: f32,
    aperture: f32,
    max_blur_radius: f32,
    near: f32,
    far: f32,
    width: f32,
    height: f32,
    padding: f32,
};

@group(0) @binding(0) var source_texture: texture_2d<f32>;
@group(0) @binding(1) var source_sampler: sampler;
@group(0) @binding(2) var scene_depth: texture_depth_2d;
@group(0) @binding(3) var<uniform> lens: LensUniform;

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

@vertex
fn vertex_main(@builtin(vertex_index) index: u32) -> VertexOutput {
    var positions = array<vec2<f32>, 3>(
        vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0)
    );
    var uvs = array<vec2<f32>, 3>(
        vec2<f32>(0.0, 1.0), vec2<f32>(2.0, 1.0), vec2<f32>(0.0, -1.0)
    );
    var output: VertexOutput;
    output.position = vec4<f32>(positions[index], 0.0, 1.0);
    output.uv = uvs[index];
    return output;
}

fn depth_at(uv: vec2<f32>) -> f32 {
    let bounded = clamp(uv, vec2<f32>(0.0), vec2<f32>(0.999999));
    let pixel = vec2<i32>(bounded * vec2<f32>(lens.width, lens.height));
    return textureLoad(scene_depth, pixel, 0);
}

fn camera_distance(depth: f32) -> f32 {
    return lens.near * lens.far / max(lens.far - depth * (lens.far - lens.near), 0.000001);
}

fn circle_of_confusion(distance_value: f32) -> f32 {
    let relative_error = abs(distance_value - lens.focus_distance) / max(lens.focus_distance, 0.0001);
    return clamp(relative_error * lens.aperture, 0.0, 1.0);
}

@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4<f32> {
    let center_depth = camera_distance(depth_at(input.uv));
    let radius = circle_of_confusion(center_depth) * lens.max_blur_radius;
    if (radius < 0.35) {
        return textureSample(source_texture, source_sampler, input.uv);
    }
    let offsets = array<vec2<f32>, 17>(
        vec2<f32>(0.0, 0.0),
        vec2<f32>(1.0, 0.0), vec2<f32>(-1.0, 0.0), vec2<f32>(0.0, 1.0), vec2<f32>(0.0, -1.0),
        vec2<f32>(0.7071, 0.7071), vec2<f32>(-0.7071, 0.7071), vec2<f32>(0.7071, -0.7071), vec2<f32>(-0.7071, -0.7071),
        vec2<f32>(0.5, 0.0), vec2<f32>(-0.5, 0.0), vec2<f32>(0.0, 0.5), vec2<f32>(0.0, -0.5),
        vec2<f32>(0.3536, 0.3536), vec2<f32>(-0.3536, 0.3536), vec2<f32>(0.3536, -0.3536), vec2<f32>(-0.3536, -0.3536)
    );
    let texel = vec2<f32>(1.0 / lens.width, 1.0 / lens.height);
    var color_sum = vec4<f32>(0.0);
    var weight_sum = 0.0;
    for (var index = 0u; index < 17u; index += 1u) {
        let sample_uv = clamp(input.uv + offsets[index] * radius * texel, vec2<f32>(0.0), vec2<f32>(1.0));
        let sample_distance = camera_distance(depth_at(sample_uv));
        let closer_occluder = sample_distance + 0.025 < center_depth;
        let guard = select(1.0, 0.05, closer_occluder && center_depth > lens.focus_distance);
        let radial_weight = select(1.0, 0.72, index > 8u);
        let weight = guard * radial_weight;
        color_sum += textureSample(source_texture, source_sampler, sample_uv) * weight;
        weight_sum += weight;
    }
    return color_sum / max(weight_sum, 0.0001);
}
