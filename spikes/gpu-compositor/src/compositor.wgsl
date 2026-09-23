struct Config {
    width: u32,
    height: u32,
    layer_count: u32,
    pixel_count: u32,
};

struct LayerParam {
    opacity: f32,
    translate_x: f32,
    translate_y: f32,
    scale: f32,
    rotation: f32,
    blend_mode: u32,
    enabled: u32,
    alpha_mode: u32,
    effect_kind: u32,
    effect_contrast: f32,
    effect_brightness: f32,
    _effect_pad: u32,
    projective_h0: f32,
    projective_h1: f32,
    projective_h2: f32,
    projective_h3: f32,
    projective_h4: f32,
    projective_h5: f32,
    projective_h6: f32,
    projective_h7: f32,
    projective_enabled: u32,
    _projective_pad_x: u32,
    _projective_pad_y: u32,
    _projective_pad_z: u32,
    shade_r: f32,
    shade_g: f32,
    shade_b: f32,
    _shade_pad: f32,
    source_kind: u32,
    particle_seed: u32,
    particle_max: u32,
    _particle_pad: u32,
    particle_rate: f32,
    particle_lifetime: f32,
    particle_time: f32,
    particle_radius: f32,
    particle_emitter_x: f32,
    particle_emitter_y: f32,
    particle_velocity_x: f32,
    particle_velocity_y: f32,
    particle_gravity_x: f32,
    particle_gravity_y: f32,
    particle_color_r: f32,
    particle_color_g: f32,
    particle_color_b: f32,
    particle_color_a: f32,
};

@group(0) @binding(0) var<storage, read> layer_pixels: array<u32>;
@group(0) @binding(1) var<storage, read> layer_params: array<LayerParam>;
@group(0) @binding(2) var<storage, read_write> output_pixels: array<vec4<f32>>;
@group(0) @binding(3) var<uniform> config: Config;

fn unpack_rgba(pixel: u32) -> vec4<f32> {
    return vec4<f32>(
        f32(pixel & 255u),
        f32((pixel >> 8u) & 255u),
        f32((pixel >> 16u) & 255u),
        f32((pixel >> 24u) & 255u)
    ) / 255.0;
}

fn normalize_source_alpha(input: vec4<f32>, mode: u32) -> vec4<f32> {
    if (mode == 1u) { return vec4<f32>(input.rgb, 1.0); }
    if (mode == 2u) {
        if (input.a <= 0.000001) { return vec4<f32>(0.0); }
        return vec4<f32>(clamp(input.rgb / input.a, vec3<f32>(0.0), vec3<f32>(1.0)), input.a);
    }
    return input;
}

fn blend_color(backdrop: vec3<f32>, source: vec3<f32>, mode: u32) -> vec3<f32> {
    if (mode == 1u) {
        return min(vec3<f32>(1.0), backdrop + source);
    }
    if (mode == 2u) {
        return vec3<f32>(1.0) - (vec3<f32>(1.0) - backdrop) * (vec3<f32>(1.0) - source);
    }
    if (mode == 3u) {
        return backdrop * source;
    }
    if (mode == 4u) {
        let low = 2.0 * backdrop * source;
        let high = vec3<f32>(1.0) - 2.0 * (vec3<f32>(1.0) - backdrop) * (vec3<f32>(1.0) - source);
        return select(low, high, backdrop > vec3<f32>(0.5));
    }
    if (mode == 5u) {
        return (vec3<f32>(1.0) - 2.0 * source) * backdrop * backdrop + 2.0 * source * backdrop;
    }
    if (mode == 6u) {
        let low = 2.0 * backdrop * source;
        let high = vec3<f32>(1.0) - 2.0 * (vec3<f32>(1.0) - backdrop) * (vec3<f32>(1.0) - source);
        return select(low, high, source > vec3<f32>(0.5));
    }
    if (mode == 7u) { return abs(backdrop - source); }
    if (mode == 8u) { return min(backdrop, source); }
    if (mode == 9u) { return max(backdrop, source); }
    if (mode == 10u) { return min(vec3<f32>(1.0), backdrop / max(vec3<f32>(0.000001), vec3<f32>(1.0) - source)); }
    if (mode == 11u) { return vec3<f32>(1.0) - min(vec3<f32>(1.0), (vec3<f32>(1.0) - backdrop) / max(vec3<f32>(0.000001), source)); }
    return source;
}

fn composite(backdrop: vec4<f32>, source_input: vec4<f32>, opacity: f32, mode: u32) -> vec4<f32> {
    let source = vec4<f32>(source_input.rgb, source_input.a * clamp(opacity, 0.0, 1.0));
    let output_alpha = source.a + backdrop.a * (1.0 - source.a);
    if (output_alpha <= 0.000001) {
        return vec4<f32>(0.0);
    }
    let mixed = blend_color(backdrop.rgb, source.rgb, mode);
    let premultiplied =
        backdrop.rgb * backdrop.a * (1.0 - source.a) +
        source.rgb * source.a * (1.0 - backdrop.a) +
        mixed * backdrop.a * source.a;
    return vec4<f32>(premultiplied / output_alpha, output_alpha);
}

fn particle_hash(seed: u32, index: u32, stream: u32) -> u32 {
    var value = seed ^ (index * 0x9e3779b9u) ^ (stream * 0x85ebca6bu);
    value = value ^ (value >> 16u);
    value = value * 0x7feb352du;
    value = value ^ (value >> 15u);
    value = value * 0x846ca68bu;
    return value ^ (value >> 16u);
}

fn particle_random(seed: u32, index: u32, stream: u32) -> f32 {
    return f32(particle_hash(seed, index, stream) & 0xffffu) / 65535.0;
}

fn particle_source(params: LayerParam, local: vec2<f32>) -> vec4<f32> {
    if (params.particle_rate <= 0.0 || params.particle_lifetime <= 0.0 || params.particle_max == 0u) { return vec4<f32>(0.0); }
    let spawned = i32(floor(params.particle_time * params.particle_rate));
    let emitter = vec2<f32>(params.particle_emitter_x * f32(config.width - 1u), params.particle_emitter_y * f32(config.height - 1u));
    var alpha = 0.0;
    for (var slot = 0u; slot < 64u; slot += 1u) {
        if (slot >= params.particle_max) { break; }
        let birth_signed = spawned - i32(slot);
        if (birth_signed < 0) { continue; }
        let birth = u32(birth_signed);
        let age = params.particle_time - f32(birth) / params.particle_rate;
        if (age < 0.0 || age > params.particle_lifetime) { continue; }
        let velocity = vec2<f32>(params.particle_velocity_x + (particle_random(params.particle_seed, birth, 0u) - 0.5) * 42.0, params.particle_velocity_y + (particle_random(params.particle_seed, birth, 1u) - 0.5) * 18.0);
        let position = emitter + velocity * age + 0.5 * vec2<f32>(params.particle_gravity_x, params.particle_gravity_y) * age * age;
        let distance = length(local - position);
        let radius = params.particle_radius * (0.7 + particle_random(params.particle_seed, birth, 2u) * 0.6);
        let core = clamp((radius - distance) / (radius * 0.35 + 0.5), 0.0, 1.0);
        let glow = clamp((radius * 2.4 - distance) / (radius * 1.8 + 0.5), 0.0, 1.0) * 0.18;
        let fade = clamp(1.0 - age / params.particle_lifetime, 0.0, 1.0);
        let particle_alpha = clamp((core + glow) * params.particle_color_a * fade, 0.0, 1.0);
        alpha = particle_alpha + alpha * (1.0 - particle_alpha);
    }
    if (alpha <= 0.0) { return vec4<f32>(0.0); }
    return vec4<f32>(params.particle_color_r, params.particle_color_g, params.particle_color_b, alpha);
}

fn sample_layer(layer_index: u32, output_x: u32, output_y: u32) -> vec4<f32> {
    let params = layer_params[layer_index];
    if (params.enabled == 0u || params.scale <= 0.0001) {
        return vec4<f32>(0.0);
    }
    let center = vec2<f32>(f32(config.width - 1u), f32(config.height - 1u)) * 0.5;
    let output_position = vec2<f32>(f32(output_x), f32(output_y));
    var local: vec2<f32>;
    if (params.projective_enabled != 0u) {
        let destination = output_position - center;
        let denominator = params.projective_h6 * destination.x + params.projective_h7 * destination.y + 1.0;
        if (abs(denominator) <= 0.000001) { return vec4<f32>(0.0); }
        local = vec2<f32>(
            (params.projective_h0 * destination.x + params.projective_h1 * destination.y + params.projective_h2) / denominator,
            (params.projective_h3 * destination.x + params.projective_h4 * destination.y + params.projective_h5) / denominator
        ) + center;
    } else {
        let translated = output_position - center - vec2<f32>(params.translate_x, params.translate_y);
        let sine = sin(-params.rotation);
        let cosine = cos(-params.rotation);
        local = vec2<f32>(
            translated.x * cosine - translated.y * sine,
            translated.x * sine + translated.y * cosine
        ) / params.scale + center;
    }
    if (local.x < 0.0 || local.y < 0.0 || local.x >= f32(config.width) || local.y >= f32(config.height)) {
        return vec4<f32>(0.0);
    }
    if (params.source_kind == 1u) { return particle_source(params, local); }
    let source_x = u32(local.x);
    let source_y = u32(local.y);
    let source_index = layer_index * config.pixel_count + source_y * config.width + source_x;
    let packed = layer_pixels[source_index];
    var color = normalize_source_alpha(unpack_rgba(packed), params.alpha_mode);
    if (params.effect_kind == 1u || params.effect_kind == 2u) {
        let red = packed & 255u;
        let green = (packed >> 8u) & 255u;
        let blue = (packed >> 16u) & 255u;
        let luma = (red * 54u + green * 183u + blue * 19u + 128u) >> 8u;
        let contrast_percent = select(118, 142, params.effect_kind == 2u);
        let brightness_code = select(0, 5, params.effect_kind == 2u);
        let value_code = clamp((i32(luma) - 128) * contrast_percent / 100 + 128 + brightness_code, 0, 255);
        let value = f32(value_code) / 255.0;
        color = vec4<f32>(vec3<f32>(value), color.a);
    }
    color = vec4<f32>(color.rgb * vec3<f32>(params.shade_r, params.shade_g, params.shade_b), color.a);
    return color;
}

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) invocation: vec3<u32>) {
    if (invocation.x >= config.width || invocation.y >= config.height) {
        return;
    }
    var color = vec4<f32>(0.0);
    for (var layer_index = 0u; layer_index < config.layer_count; layer_index += 1u) {
        let params = layer_params[layer_index];
        let source = sample_layer(layer_index, invocation.x, invocation.y);
        color = composite(color, source, params.opacity, params.blend_mode);
    }
    let index = invocation.y * config.width + invocation.x;
    output_pixels[index] = color;
}
