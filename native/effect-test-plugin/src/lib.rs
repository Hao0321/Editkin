#[repr(C)]
pub struct EffectProcessV1 {
    pub abi_version: u32,
    pub width: u32,
    pub height: u32,
    pub input_rgba32f: *const f32,
    pub output_rgba32f: *mut f32,
    pub pixel_count: usize,
    pub parameter_count: usize,
    pub parameters: *const f64,
}

#[repr(C)]
pub struct EffectProcessV2 {
    pub struct_size: u32,
    pub abi_version: u32,
    pub width: u32,
    pub height: u32,
    pub input_rgba32f: *const f32,
    pub output_rgba32f: *mut f32,
    pub pixel_count: usize,
    pub parameter_count: usize,
    pub parameters: *const f64,
    pub frame_index: i64,
    pub time_numerator: i64,
    pub time_denominator: i64,
    pub flags: u32,
    pub reserved: u32,
}

/// Diagnostic gain/invert plugin used by the ABI gate. It deliberately has no
/// dependency on hao-core, proving the boundary is a stable C layout.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn editkin_effect_plugin_v1(request: *const EffectProcessV1) -> i32 {
    if request.is_null() {
        return -1;
    }
    let request = unsafe { &*request };
    if request.abi_version != 1
        || request.width == 0
        || request.height == 0
        || request.input_rgba32f.is_null()
        || request.output_rgba32f.is_null()
        || request.pixel_count != request.width as usize * request.height as usize
        || request.parameter_count != 2
        || request.parameters.is_null()
    {
        return -2;
    }
    let input =
        unsafe { std::slice::from_raw_parts(request.input_rgba32f, request.pixel_count * 4) };
    let output =
        unsafe { std::slice::from_raw_parts_mut(request.output_rgba32f, request.pixel_count * 4) };
    let parameters =
        unsafe { std::slice::from_raw_parts(request.parameters, request.parameter_count) };
    let gain = parameters[0] as f32;
    let invert = parameters[1].clamp(0.0, 1.0) as f32;
    if !gain.is_finite() || !invert.is_finite() {
        return -3;
    }
    for pixel in 0..request.pixel_count {
        let alpha = input[pixel * 4 + 3].clamp(0.0, 1.0);
        for channel in 0..3 {
            let base = input[pixel * 4 + channel].clamp(0.0, alpha);
            let inverted = (alpha - base).clamp(0.0, alpha);
            output[pixel * 4 + channel] = (base + (inverted - base) * invert) * gain;
        }
        output[pixel * 4 + 3] = alpha;
    }
    0
}

/// ABI v2 diagnostic plugin. Parameter 2 is a gate-only fault mode:
/// 1 = hang, 2 = abort, 3 = invalid output. Real plugins leave it at zero.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn editkin_effect_plugin_v2(request: *const EffectProcessV2) -> i32 {
    if request.is_null() {
        return -1;
    }
    let request = unsafe { &*request };
    if request.struct_size < std::mem::size_of::<EffectProcessV2>() as u32
        || request.abi_version != 2
        || request.width == 0
        || request.height == 0
        || request.input_rgba32f.is_null()
        || request.output_rgba32f.is_null()
        || request.pixel_count != request.width as usize * request.height as usize
        || request.parameter_count != 3
        || request.parameters.is_null()
        || request.time_denominator <= 0
    {
        return -2;
    }
    let parameters =
        unsafe { std::slice::from_raw_parts(request.parameters, request.parameter_count) };
    match parameters[2].round() as i32 {
        1 => std::thread::sleep(std::time::Duration::from_secs(2)),
        2 => std::process::abort(),
        3 => {
            let output = unsafe {
                std::slice::from_raw_parts_mut(request.output_rgba32f, request.pixel_count * 4)
            };
            output.fill(f32::NAN);
            return 0;
        }
        _ => {}
    }
    let input =
        unsafe { std::slice::from_raw_parts(request.input_rgba32f, request.pixel_count * 4) };
    let output =
        unsafe { std::slice::from_raw_parts_mut(request.output_rgba32f, request.pixel_count * 4) };
    let gain = parameters[0] as f32;
    let invert = parameters[1].clamp(0.0, 1.0) as f32;
    if !gain.is_finite() || !invert.is_finite() {
        return -3;
    }
    let time = request.time_numerator as f32 / request.time_denominator as f32;
    let animated_gain = gain * (1.0 + (time * 0.0));
    for pixel in 0..request.pixel_count {
        let alpha = input[pixel * 4 + 3].clamp(0.0, 1.0);
        for channel in 0..3 {
            let base = input[pixel * 4 + channel].clamp(0.0, alpha);
            let inverted = (alpha - base).clamp(0.0, alpha);
            output[pixel * 4 + channel] = (base + (inverted - base) * invert) * animated_gain;
        }
        output[pixel * 4 + 3] = alpha;
    }
    0
}
