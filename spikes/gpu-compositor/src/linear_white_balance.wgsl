// Explicit inverse/forward Rec709 OETF, including its negative linear extension.
// This is not sRGB or BT1886. Alpha is deliberately not an argument.
fn wb_decode_709_channel(value: f32) -> f32 {
    if value < 0.081 { return value / 4.5; }
    return pow((value + 0.099) / 1.099, 1.0 / 0.45);
}
fn wb_encode_709_channel(value: f32) -> f32 {
    if value < 0.018 { return 4.5 * value; }
    return 1.099 * pow(value, 0.45) - 0.099;
}
fn wb_decode_709(value: vec3<f32>) -> vec3<f32> {
    return vec3<f32>(wb_decode_709_channel(value.r), wb_decode_709_channel(value.g), wb_decode_709_channel(value.b));
}
fn wb_linear(value: vec3<f32>, stops: vec3<f32>) -> vec3<f32> {
    if all(stops == vec3<f32>(0.0)) { return value; }
    return value * exp2(stops);
}
fn wb_encoded_709(value: vec3<f32>, stops: vec3<f32>) -> vec3<f32> {
    if all(stops == vec3<f32>(0.0)) { return value; }
    let linear = wb_linear(wb_decode_709(value), stops);
    return vec3<f32>(wb_encode_709_channel(linear.r), wb_encode_709_channel(linear.g), wb_encode_709_channel(linear.b));
}
