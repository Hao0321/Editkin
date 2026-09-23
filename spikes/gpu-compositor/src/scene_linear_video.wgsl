struct VideoVisualStyle {
    translate_x: f32, translate_y: f32, scale: f32, rotation: f32,
    opacity: f32, source_width: f32, source_height: f32, effect_kind: u32,
    brightness: f32, contrast: f32, saturation: f32, hue: f32,
    exposure: f32, temperature: f32, tint: f32, pivot: f32,
    shadows: f32, highlights: f32, blacks: f32, whites: f32,
    white_balance_red: f32, white_balance_green: f32, white_balance_blue: f32, white_balance_pad: f32,
    transform_pivot_x: f32, transform_pivot_y: f32, transform_pad_x: f32, transform_pad_y: f32,
    projective_h0: f32, projective_h1: f32, projective_h2: f32, projective_h3: f32,
    projective_h4: f32, projective_h5: f32, projective_h6: f32, projective_h7: f32,
    projective_enabled: f32, shade_r: f32, shade_g: f32, shade_b: f32,
    blend_mode: u32, composite_opacity: f32, source_alpha_mode: u32, source_color_contract: f32,
    matte_mode: u32, scene_depth_a: f32, scene_depth_b: f32, scene_depth_c: f32,
    shader_op_count: u32, scene_depth_enabled: u32, shader_pad_y: u32, shader_pad_z: u32,
    shader_ops: array<vec4<f32>, 16>,
    motion_sample_count: u32, motion_contract_code: u32, motion_shutter_angle: f32, motion_pad_z: f32,
    motion_samples: array<vec4<f32>, 8>,
    motion_sample_frames: array<vec4<f32>, 2>,
};

@group(0) @binding(0) var source_texture: texture_2d<f32>;
@group(0) @binding(1) var source_sampler: sampler;
@group(0) @binding(2) var<uniform> style: VideoVisualStyle;
@group(0) @binding(3) var backdrop_texture: texture_2d<f32>;
@group(0) @binding(4) var matte_texture: texture_2d<f32>;
@group(0) @binding(5) var<uniform> matte_style: VideoVisualStyle;
@group(0) @binding(6) var source_texture_1: texture_2d<f32>;
@group(0) @binding(7) var source_texture_2: texture_2d<f32>;
@group(0) @binding(8) var source_texture_3: texture_2d<f32>;
@group(0) @binding(9) var source_texture_4: texture_2d<f32>;
@group(0) @binding(10) var source_texture_5: texture_2d<f32>;
@group(0) @binding(11) var source_texture_6: texture_2d<f32>;
@group(0) @binding(12) var source_texture_7: texture_2d<f32>;

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

fn srgb_to_linear_channel(value: f32) -> f32 {
    let bounded = clamp(value, 0.0, 1.0);
    return select(pow((bounded + 0.055) / 1.055, 2.4), bounded / 12.92, bounded <= 0.04045);
}

fn source_to_linear(input: vec3<f32>) -> vec3<f32> {
    if style.source_color_contract < 0.5 { return input; }
    if style.source_color_contract > 1.5 { return wb_decode_709(input); }
    return vec3<f32>(
        srgb_to_linear_channel(input.r),
        srgb_to_linear_channel(input.g),
        srgb_to_linear_channel(input.b)
    );
}

fn primary_tone(value: f32) -> f32 {
    var y0 = clamp(style.blacks * 0.08, 0.0, 0.18);
    var y1 = clamp(0.18 + style.shadows * 0.13, 0.02, 0.42);
    var y2 = clamp(0.5 + (0.5 - style.pivot) * 0.26, 0.24, 0.76);
    var y3 = clamp(0.82 + style.highlights * 0.13, 0.58, 0.98);
    var y4 = clamp(1.0 + style.whites * 0.08, 0.82, 1.0);
    y1 = max(y1, y0 + 0.002); y2 = max(y2, y1 + 0.002);
    y3 = max(y3, y2 + 0.002); y4 = max(y4, y3 + 0.002);
    y3 = min(y3, y4 - 0.002); y2 = min(y2, y3 - 0.002);
    y1 = min(y1, y2 - 0.002); y0 = min(y0, y1 - 0.002);
    let bounded = clamp(value, 0.0, 1.0);
    if bounded <= 0.18 { return mix(y0, y1, bounded / 0.18); }
    if bounded <= 0.5 { return mix(y1, y2, (bounded - 0.18) / 0.32); }
    if bounded <= 0.82 { return mix(y2, y3, (bounded - 0.5) / 0.32); }
    return mix(y3, y4, (bounded - 0.82) / 0.18);
}

fn apply_primary_grade(input: vec3<f32>) -> vec3<f32> {
    let exposure = exp2(clamp(style.exposure, -3.0, 3.0));
    let balanced = wb_linear(input, vec3<f32>(style.white_balance_red, style.white_balance_green, style.white_balance_blue));
    var channels = vec3<f32>(
        primary_tone(balanced.r), primary_tone(balanced.g), primary_tone(balanced.b)
    );
    channels = clamp(
        ((channels - vec3<f32>(style.pivot)) * style.contrast + vec3<f32>(style.pivot))
            * exposure + vec3<f32>(style.brightness),
        vec3<f32>(0.0), vec3<f32>(1.0)
    );
    channels.r = clamp(channels.r + style.temperature * 0.055, 0.0, 1.0);
    channels.g = clamp(channels.g + style.tint * 0.045, 0.0, 1.0);
    channels.b = clamp(channels.b - style.temperature * 0.055, 0.0, 1.0);
    let luma = dot(channels, vec3<f32>(0.2126, 0.7152, 0.0722));
    return clamp(vec3<f32>(luma) + (channels - vec3<f32>(luma)) * style.saturation, vec3<f32>(0.0), vec3<f32>(1.0));
}

fn apply_shader_operation(input_color: vec3<f32>, uv: vec2<f32>, operation: vec4<f32>) -> vec3<f32> {
    let opcode = u32(round(operation.x)); let args = operation.yzw; var color = input_color;
    if (opcode == 1u) { color *= args.x; }
    else if (opcode == 2u) { color = mix(color, vec3<f32>(1.0) - color, args.x); }
    else if (opcode == 3u) { let luma = dot(color, vec3<f32>(0.2126, 0.7152, 0.0722)); color = mix(color, vec3<f32>(luma), args.x); }
    else if (opcode == 4u) { let luma = dot(color, vec3<f32>(0.2126, 0.7152, 0.0722)); color = vec3<f32>(luma) + (color - vec3<f32>(luma)) * args.x; }
    else if (opcode == 5u) { color = (color - vec3<f32>(args.y)) * args.x + vec3<f32>(args.y); }
    else if (opcode == 6u) { color *= args; }
    else if (opcode == 7u) { let levels = max(2.0, round(args.x)); color = round(color * (levels - 1.0)) / (levels - 1.0); }
    else if (opcode == 8u) { let distance_from_center = distance(uv, vec2<f32>(0.5)); let falloff = smoothstep(args.y, args.y + args.z, distance_from_center); color *= 1.0 - falloff * args.x; }
    else if (opcode == 9u) {
        let c = cos(args.x); let s = sin(args.x);
        color = vec3<f32>(
            dot(color, vec3<f32>(0.299 + 0.701 * c + 0.168 * s, 0.587 - 0.587 * c + 0.330 * s, 0.114 - 0.114 * c - 0.497 * s)),
            dot(color, vec3<f32>(0.299 - 0.299 * c - 0.328 * s, 0.587 + 0.413 * c + 0.035 * s, 0.114 - 0.114 * c + 0.292 * s)),
            dot(color, vec3<f32>(0.299 - 0.300 * c + 1.250 * s, 0.587 - 0.588 * c - 1.050 * s, 0.114 + 0.886 * c - 0.203 * s)));
    }
    else if (opcode == 10u) { color = pow(max(color + vec3<f32>(args.x), vec3<f32>(0.0)), vec3<f32>(1.0 / max(args.y, 0.1))) * args.z; }
    else if (opcode == 11u) {
        let toe = pow(max(color, vec3<f32>(0.0)), vec3<f32>(1.0 + args.y * 1.5));
        let shaped = vec3<f32>(1.0) - pow(max(vec3<f32>(1.0) - toe, vec3<f32>(0.0)), vec3<f32>(1.0 + args.z * 1.5));
        color = mix(color, shaped, args.x);
    }
    else if (opcode == 12u) { color += vec3<f32>(args.x * 0.06, args.y * 0.045, -args.x * 0.06); }
    return clamp(color, vec3<f32>(0.0), vec3<f32>(1.0));
}

fn apply_shader_graph(input_color: vec3<f32>, uv: vec2<f32>, selected_style: VideoVisualStyle) -> vec3<f32> {
    var color = input_color;
    for (var index = 0u; index < min(selected_style.shader_op_count, 16u); index += 1u) {
        color = apply_shader_operation(color, uv, selected_style.shader_ops[index]);
    }
    return color;
}

fn styled_source(input_color: vec4<f32>, uv: vec2<f32>) -> vec4<f32> {
    let normalized = normalize_alpha(input_color);
    var color = apply_primary_grade(source_to_linear(normalized.rgb));
    let luma = dot(color, vec3<f32>(0.2126, 0.7152, 0.0722));
    if (style.effect_kind == 1u) { color = vec3<f32>(floor(luma * 8.0 + 0.5) / 8.0); }
    else if (style.effect_kind == 2u) { color = vec3<f32>(smoothstep(0.38, 0.62, luma)); }
    let shaded = apply_shader_graph(color, uv, style) * vec3<f32>(style.shade_r, style.shade_g, style.shade_b);
    return vec4<f32>(shaded, normalized.a);
}

fn matte_primary_tone(value: f32) -> f32 {
    var y0 = clamp(matte_style.blacks * 0.08, 0.0, 0.18);
    var y1 = clamp(0.18 + matte_style.shadows * 0.13, 0.02, 0.42);
    var y2 = clamp(0.5 + (0.5 - matte_style.pivot) * 0.26, 0.24, 0.76);
    var y3 = clamp(0.82 + matte_style.highlights * 0.13, 0.58, 0.98);
    var y4 = clamp(1.0 + matte_style.whites * 0.08, 0.82, 1.0);
    y1 = max(y1, y0 + 0.002); y2 = max(y2, y1 + 0.002); y3 = max(y3, y2 + 0.002); y4 = max(y4, y3 + 0.002);
    y3 = min(y3, y4 - 0.002); y2 = min(y2, y3 - 0.002); y1 = min(y1, y2 - 0.002); y0 = min(y0, y1 - 0.002);
    let bounded = clamp(value, 0.0, 1.0);
    if (bounded <= 0.18) { return mix(y0, y1, bounded / 0.18); }
    if (bounded <= 0.5) { return mix(y1, y2, (bounded - 0.18) / 0.32); }
    if (bounded <= 0.82) { return mix(y2, y3, (bounded - 0.5) / 0.32); }
    return mix(y3, y4, (bounded - 0.82) / 0.18);
}

fn matte_source_to_linear(input: vec3<f32>) -> vec3<f32> {
    if matte_style.source_color_contract < 0.5 { return input; }
    if matte_style.source_color_contract > 1.5 { return wb_decode_709(input); }
    return vec3<f32>(srgb_to_linear_channel(input.r), srgb_to_linear_channel(input.g), srgb_to_linear_channel(input.b));
}

fn apply_matte_primary_grade(input: vec3<f32>) -> vec3<f32> {
    let exposure = exp2(clamp(matte_style.exposure, -3.0, 3.0));
    let balanced = wb_linear(input, vec3<f32>(matte_style.white_balance_red, matte_style.white_balance_green, matte_style.white_balance_blue));
    var channels = vec3<f32>(matte_primary_tone(balanced.r), matte_primary_tone(balanced.g), matte_primary_tone(balanced.b));
    channels = clamp(((channels - vec3<f32>(matte_style.pivot)) * matte_style.contrast + vec3<f32>(matte_style.pivot)) * exposure + vec3<f32>(matte_style.brightness), vec3<f32>(0.0), vec3<f32>(1.0));
    channels.r = clamp(channels.r + matte_style.temperature * 0.055, 0.0, 1.0);
    channels.g = clamp(channels.g + matte_style.tint * 0.045, 0.0, 1.0);
    channels.b = clamp(channels.b - matte_style.temperature * 0.055, 0.0, 1.0);
    let luma = dot(channels, vec3<f32>(0.2126, 0.7152, 0.0722));
    return clamp(vec3<f32>(luma) + (channels - vec3<f32>(luma)) * matte_style.saturation, vec3<f32>(0.0), vec3<f32>(1.0));
}

fn matte_transformed_uv(input_uv: vec2<f32>) -> vec3<f32> {
    let dimensions = vec2<f32>(matte_style.source_width, matte_style.source_height);
    let destination = (input_uv - vec2<f32>(0.5)) * dimensions;
    var local: vec2<f32>;
    if (matte_style.projective_enabled > 0.5) {
        let denominator = matte_style.projective_h6 * destination.x + matte_style.projective_h7 * destination.y + 1.0;
        if (abs(denominator) < 0.000001) { return vec3<f32>(0.0); }
        local = vec2<f32>((matte_style.projective_h0 * destination.x + matte_style.projective_h1 * destination.y + matte_style.projective_h2) / denominator, (matte_style.projective_h3 * destination.x + matte_style.projective_h4 * destination.y + matte_style.projective_h5) / denominator);
    } else {
        let pivot = vec2<f32>(matte_style.transform_pivot_x, matte_style.transform_pivot_y);
        let translated = destination - vec2<f32>(matte_style.translate_x, matte_style.translate_y) - pivot;
        let cosine = cos(matte_style.rotation); let sine = sin(matte_style.rotation);
        local = vec2<f32>(cosine * translated.x + sine * translated.y, -sine * translated.x + cosine * translated.y) / max(matte_style.scale, 0.0001) + pivot;
    }
    let uv = local / dimensions + vec2<f32>(0.5);
    let valid = select(0.0, 1.0, uv.x >= 0.0 && uv.y >= 0.0 && uv.x <= 1.0 && uv.y <= 1.0);
    return vec3<f32>(uv, valid);
}

fn styled_matte(input_color: vec4<f32>, uv: vec2<f32>) -> vec4<f32> {
    var normalized = input_color;
    if (matte_style.source_alpha_mode == 1u) { normalized = vec4<f32>(input_color.rgb, 1.0); }
    else if (matte_style.source_alpha_mode == 2u) {
        normalized = select(vec4<f32>(0.0), vec4<f32>(input_color.rgb / max(input_color.a, 0.000001), input_color.a), input_color.a > 0.000001);
    }
    var color = apply_matte_primary_grade(matte_source_to_linear(normalized.rgb));
    let luma = dot(color, vec3<f32>(0.2126, 0.7152, 0.0722));
    if (matte_style.effect_kind == 1u) { color = vec3<f32>(floor(luma * 8.0 + 0.5) / 8.0); }
    else if (matte_style.effect_kind == 2u) { color = vec3<f32>(smoothstep(0.38, 0.62, luma)); }
    return vec4<f32>(apply_shader_graph(color, uv, matte_style), normalized.a);
}

fn sample_matte_factor(input_uv: vec2<f32>) -> f32 {
    if (style.matte_mode == 0u) { return 1.0; }
    let mapped = matte_transformed_uv(input_uv);
    var factor = 0.0;
    if (mapped.z > 0.5) {
        let matte = styled_matte(textureSample(matte_texture, source_sampler, mapped.xy), mapped.xy);
        let matte_opacity = clamp(matte.a * matte_style.opacity * matte_style.composite_opacity, 0.0, 1.0);
        factor = select(matte_opacity, dot(matte.rgb, vec3<f32>(0.2126, 0.7152, 0.0722)) * matte_opacity, style.matte_mode >= 3u);
    }
    return select(clamp(factor, 0.0, 1.0), 1.0 - clamp(factor, 0.0, 1.0), style.matte_mode == 2u || style.matte_mode == 4u);
}

fn transformed_uv(input_uv: vec2<f32>) -> vec3<f32> {
    let dimensions = vec2<f32>(style.source_width, style.source_height);
    let destination = (input_uv - vec2<f32>(0.5)) * dimensions;
    var local: vec2<f32>;
    if style.projective_enabled > 0.5 {
        let denominator = style.projective_h6 * destination.x + style.projective_h7 * destination.y + 1.0;
        if abs(denominator) < 0.000001 { return vec3<f32>(0.0); }
        local = vec2<f32>(
            (style.projective_h0 * destination.x + style.projective_h1 * destination.y + style.projective_h2) / denominator,
            (style.projective_h3 * destination.x + style.projective_h4 * destination.y + style.projective_h5) / denominator
        );
    } else {
        let pivot = vec2<f32>(style.transform_pivot_x, style.transform_pivot_y);
        let translated = destination - vec2<f32>(style.translate_x, style.translate_y) - pivot;
        let cosine = cos(style.rotation); let sine = sin(style.rotation);
        local = vec2<f32>(
            cosine * translated.x + sine * translated.y,
            -sine * translated.x + cosine * translated.y
        ) / max(style.scale, 0.0001) + pivot;
    }
    let uv = local / dimensions + vec2<f32>(0.5);
    let valid = select(0.0, 1.0, uv.x >= 0.0 && uv.y >= 0.0 && uv.x <= 1.0 && uv.y <= 1.0);
    return vec3<f32>(uv, valid);
}

fn motion_transformed_uv(input_uv: vec2<f32>, sample_index: u32) -> vec3<f32> {
    if (style.projective_enabled > 0.5 || style.motion_sample_count < 2u) { return transformed_uv(input_uv); }
    let transform = style.motion_samples[min(sample_index, 7u)];
    let dimensions = vec2<f32>(style.source_width, style.source_height);
    let destination = (input_uv - vec2<f32>(0.5)) * dimensions;
    let pivot = vec2<f32>(style.transform_pivot_x, style.transform_pivot_y);
    let translated = destination - transform.xy - pivot;
    let cosine = cos(transform.w); let sine = sin(transform.w);
    let local = vec2<f32>(
        cosine * translated.x + sine * translated.y,
        -sine * translated.x + cosine * translated.y
    ) / max(transform.z, 0.0001) + pivot;
    let uv = local / dimensions + vec2<f32>(0.5);
    let valid = select(0.0, 1.0, uv.x >= 0.0 && uv.y >= 0.0 && uv.x <= 1.0 && uv.y <= 1.0);
    return vec3<f32>(uv, valid);
}

fn normalize_alpha(input: vec4<f32>) -> vec4<f32> {
    if style.source_alpha_mode == 1u { return vec4<f32>(input.rgb, 1.0); }
    if style.source_alpha_mode == 2u {
        if input.a <= 0.000001 { return vec4<f32>(0.0); }
        return vec4<f32>(input.rgb / input.a, input.a);
    }
    return input;
}

fn sampled_source_texture(sample_index: u32, uv: vec2<f32>) -> vec4<f32> {
    if (style.motion_contract_code != 2u || sample_index == 0u) { return textureSample(source_texture, source_sampler, uv); }
    if (sample_index == 1u) { return textureSample(source_texture_1, source_sampler, uv); }
    if (sample_index == 2u) { return textureSample(source_texture_2, source_sampler, uv); }
    if (sample_index == 3u) { return textureSample(source_texture_3, source_sampler, uv); }
    if (sample_index == 4u) { return textureSample(source_texture_4, source_sampler, uv); }
    if (sample_index == 5u) { return textureSample(source_texture_5, source_sampler, uv); }
    if (sample_index == 6u) { return textureSample(source_texture_6, source_sampler, uv); }
    return textureSample(source_texture_7, source_sampler, uv);
}

fn shutter_source(input_uv: vec2<f32>) -> vec4<f32> {
    let count = select(1u, min(style.motion_sample_count, 8u), style.motion_sample_count >= 2u);
    var premultiplied = vec3<f32>(0.0); var alpha_sum = 0.0;
    for (var index = 0u; index < count; index += 1u) {
        let mapped = motion_transformed_uv(input_uv, index);
        if (mapped.z > 0.5) {
            let sample = styled_source(sampled_source_texture(index, mapped.xy), mapped.xy);
            premultiplied += sample.rgb * sample.a;
            alpha_sum += sample.a;
        }
    }
    let alpha = alpha_sum / f32(count);
    if (alpha_sum <= 0.000001) { return vec4<f32>(0.0); }
    return vec4<f32>(premultiplied / alpha_sum, alpha);
}

fn blend_color(backdrop: vec3<f32>, source: vec3<f32>, mode: u32) -> vec3<f32> {
    if mode == 1u { return backdrop + source; }
    if mode == 2u { return vec3<f32>(1.0) - (vec3<f32>(1.0) - backdrop) * (vec3<f32>(1.0) - source); }
    if mode == 3u { return backdrop * source; }
    if mode == 4u { return select(2.0 * backdrop * source, vec3<f32>(1.0) - 2.0 * (vec3<f32>(1.0) - backdrop) * (vec3<f32>(1.0) - source), backdrop > vec3<f32>(0.5)); }
    if mode == 5u { return (vec3<f32>(1.0) - 2.0 * source) * backdrop * backdrop + 2.0 * source * backdrop; }
    if mode == 6u { return select(2.0 * backdrop * source, vec3<f32>(1.0) - 2.0 * (vec3<f32>(1.0) - backdrop) * (vec3<f32>(1.0) - source), source > vec3<f32>(0.5)); }
    if mode == 7u { return abs(backdrop - source); }
    if mode == 8u { return min(backdrop, source); }
    if mode == 9u { return max(backdrop, source); }
    if mode == 10u { return backdrop / max(vec3<f32>(0.000001), vec3<f32>(1.0) - source); }
    if mode == 11u { return vec3<f32>(1.0) - (vec3<f32>(1.0) - backdrop) / max(vec3<f32>(0.000001), source); }
    return source;
}

fn composite(backdrop: vec4<f32>, source_input: vec4<f32>, matte_factor: f32) -> vec4<f32> {
    let source_alpha = clamp(source_input.a * style.opacity * style.composite_opacity * matte_factor, 0.0, 1.0);
    let output_alpha = source_alpha + backdrop.a * (1.0 - source_alpha);
    if output_alpha <= 0.000001 { return vec4<f32>(0.0); }
    let mixed = blend_color(backdrop.rgb, source_input.rgb, style.blend_mode);
    let premultiplied = backdrop.rgb * backdrop.a * (1.0 - source_alpha)
        + source_input.rgb * source_alpha * (1.0 - backdrop.a)
        + mixed * backdrop.a * source_alpha;
    return vec4<f32>(premultiplied / output_alpha, output_alpha);
}

@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4<f32> {
    let backdrop = textureSample(backdrop_texture, source_sampler, input.uv);
    return composite(backdrop, shutter_source(input.uv), sample_matte_factor(input.uv));
}

struct SceneDepthOutput {
    @location(0) color: vec4<f32>,
    @builtin(frag_depth) depth: f32,
};

@fragment
fn fragment_depth_main(input: VertexOutput) -> SceneDepthOutput {
    if style.scene_depth_enabled != 1u || style.projective_enabled <= 0.5 { discard; }
    let mapped = transformed_uv(input.uv);
    if mapped.z <= 0.5 { discard; }
    let source = styled_source(textureSample(source_texture, source_sampler, mapped.xy), mapped.xy);
    var output: SceneDepthOutput;
    output.color = vec4<f32>(source.rgb, 1.0);
    output.depth = clamp(
        style.scene_depth_a * input.uv.x + style.scene_depth_b * input.uv.y + style.scene_depth_c,
        0.0,
        1.0
    );
    return output;
}
