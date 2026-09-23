struct Config {
    width: u32,
    height: u32,
    layer_count: u32,
    pixel_count: u32,
};

@group(0) @binding(0) var<storage, read> float_pixels: array<vec4<f32>>;
@group(0) @binding(1) var<storage, read_write> packed_pixels: array<u32>;
@group(0) @binding(2) var<uniform> config: Config;
@group(0) @binding(3) var<storage, read> output_lut: array<vec4<f32>>;

const LUT_SIZE: u32 = 129u;
const LUT_MAX: f32 = 128.0;

fn linear_rec709_to_acescct(rgb: vec3<f32>) -> vec3<f32> {
    let aces_ap1 = mat3x3<f32>(
        vec3<f32>(0.61309740240118826, 0.070193722469581596, 0.020615592882227002),
        vec3<f32>(0.33952314618410551, 0.91635387905734134, 0.10956977293813569),
        vec3<f32>(0.047379451414707258, 0.013452398473073862, 0.86981463417963978)
    ) * rgb;
    let linear_segment = aces_ap1 * 10.5402374 + vec3<f32>(0.0729055703);
    let logarithmic_segment = vec3<f32>(0.0823456049)
        * log(max(aces_ap1, vec3<f32>(1.17549435e-38)))
        + vec3<f32>(0.5547945205479452);
    return select(linear_segment, logarithmic_segment, aces_ap1 > vec3<f32>(0.0078125));
}

fn lut_value(r: u32, g: u32, b: u32) -> vec3<f32> {
    return output_lut[r + g * LUT_SIZE + b * LUT_SIZE * LUT_SIZE].rgb;
}

fn sample_tetrahedral(rgb: vec3<f32>) -> vec3<f32> {
    let scaled = clamp(rgb, vec3<f32>(0.0), vec3<f32>(1.0)) * LUT_MAX;
    let low = min(vec3<u32>(127u), vec3<u32>(floor(scaled)));
    let fraction = scaled - vec3<f32>(low);
    let c000 = lut_value(low.r, low.g, low.b);
    let c100 = lut_value(low.r + 1u, low.g, low.b);
    let c010 = lut_value(low.r, low.g + 1u, low.b);
    let c001 = lut_value(low.r, low.g, low.b + 1u);
    let c110 = lut_value(low.r + 1u, low.g + 1u, low.b);
    let c101 = lut_value(low.r + 1u, low.g, low.b + 1u);
    let c011 = lut_value(low.r, low.g + 1u, low.b + 1u);
    let c111 = lut_value(low.r + 1u, low.g + 1u, low.b + 1u);
    if fraction.r >= fraction.g {
        if fraction.g >= fraction.b {
            return c000 + fraction.r * (c100 - c000) + fraction.g * (c110 - c100) + fraction.b * (c111 - c110);
        }
        if fraction.r >= fraction.b {
            return c000 + fraction.r * (c100 - c000) + fraction.b * (c101 - c100) + fraction.g * (c111 - c101);
        }
        return c000 + fraction.b * (c001 - c000) + fraction.r * (c101 - c001) + fraction.g * (c111 - c101);
    }
    if fraction.b >= fraction.g {
        return c000 + fraction.b * (c001 - c000) + fraction.g * (c011 - c001) + fraction.r * (c111 - c011);
    }
    if fraction.b >= fraction.r {
        return c000 + fraction.g * (c010 - c000) + fraction.b * (c011 - c010) + fraction.r * (c111 - c011);
    }
    return c000 + fraction.g * (c010 - c000) + fraction.r * (c110 - c010) + fraction.b * (c111 - c110);
}

fn pack_rgba16(color: vec4<f32>, index: u32) {
    let value = vec4<u32>(floor(clamp(color, vec4<f32>(0.0), vec4<f32>(1.0)) * 65535.0 + 0.5));
    packed_pixels[index * 2u] = value.r | (value.g << 16u);
    packed_pixels[index * 2u + 1u] = value.b | (value.a << 16u);
}

@compute @workgroup_size(256, 1, 1)
fn main(@builtin(global_invocation_id) invocation: vec3<u32>) {
    let index = invocation.x;
    if index >= config.pixel_count { return; }
    let source = float_pixels[index];
    let acescct = linear_rec709_to_acescct(source.rgb);
    pack_rgba16(vec4<f32>(sample_tetrahedral(acescct), source.a), index);
}
