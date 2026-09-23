use super::model::PixelFormat;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};

const EFFECT_ABI_V1: u32 = 1;
const EFFECT_ABI_V2: u32 = 2;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectPluginManifest {
    pub schema: String,
    pub id: String,
    pub version: String,
    pub abi_version: u32,
    pub library_sha256: String,
    pub entry_symbol: String,
    pub supported_formats: Vec<PixelFormat>,
    pub max_temporal_radius: u32,
    pub timeout_ms: u32,
    #[serde(default)]
    pub deterministic: bool,
}

pub fn validate_plugin_manifest(manifest: &EffectPluginManifest) -> Result<(), String> {
    if manifest.schema != "editkin.effect-plugin/v1"
        || manifest.id.trim().is_empty()
        || manifest.version.trim().is_empty()
        || !matches!(manifest.abi_version, EFFECT_ABI_V1 | EFFECT_ABI_V2)
        || manifest.library_sha256.len() != 64
        || manifest.entry_symbol
            != if manifest.abi_version == EFFECT_ABI_V1 {
                "editkin_effect_plugin_v1"
            } else {
                "editkin_effect_plugin_v2"
            }
        || manifest.supported_formats.is_empty()
        || manifest.max_temporal_radius > 240
        || !(1..=30_000).contains(&manifest.timeout_ms)
    {
        return Err("invalid or incompatible effect plugin manifest".into());
    }
    Ok(())
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectPluginRunRequest {
    pub schema: String,
    pub manifest_path: PathBuf,
    pub library_path: PathBuf,
    pub input_path: PathBuf,
    pub output_path: PathBuf,
    pub width: u32,
    pub height: u32,
    #[serde(default)]
    pub frame_index: i64,
    #[serde(default)]
    pub time_numerator: i64,
    #[serde(default = "default_time_denominator")]
    pub time_denominator: i64,
    #[serde(default)]
    pub parameters: Vec<f64>,
}

fn default_time_denominator() -> i64 {
    1
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectPluginWorkerReceipt {
    pub schema: &'static str,
    pub status: &'static str,
    pub plugin_id: String,
    pub pixels: usize,
    pub output_path: PathBuf,
    pub cache_identity: String,
    pub frame_index: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectPluginSequenceRequest {
    pub schema: String,
    pub manifest_path: PathBuf,
    pub library_path: PathBuf,
    pub input_path: PathBuf,
    pub output_path: PathBuf,
    pub width: u32,
    pub height: u32,
    pub frame_count: u32,
    pub start_frame_index: i64,
    pub start_time_numerator: i64,
    pub time_denominator: i64,
    pub frame_duration_numerator: i64,
    pub frame_duration_denominator: i64,
    #[serde(default)]
    pub parameters: Vec<f64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectPluginSequenceWorkerReceipt {
    pub schema: &'static str,
    pub status: &'static str,
    pub plugin_id: String,
    pub frame_count: u32,
    pub pixels_per_frame: usize,
    pub library_loads: u32,
    pub first_frame_index: i64,
    pub last_frame_index: i64,
    pub input_bytes: u64,
    pub output_bytes: u64,
    pub output_path: PathBuf,
    pub output_sha256: String,
    pub cache_identity: String,
}

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

type EffectEntryV1 = unsafe extern "C" fn(*const EffectProcessV1) -> i32;

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

type EffectEntryV2 = unsafe extern "C" fn(*const EffectProcessV2) -> i32;

pub fn sha256_file(path: &Path) -> Result<String, String> {
    let bytes = fs::read(path).map_err(|error| format!("read {}: {error}", path.display()))?;
    let digest = Sha256::digest(bytes);
    Ok(digest.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn decode_f32(bytes: &[u8]) -> Result<Vec<f32>, String> {
    if bytes.len() % 4 != 0 {
        return Err("effect input is not aligned RGBA32F".into());
    }
    Ok(bytes
        .chunks_exact(4)
        .map(|chunk| f32::from_le_bytes(chunk.try_into().expect("four-byte chunk")))
        .collect())
}

fn cache_identity(
    manifest: &EffectPluginManifest,
    request: &EffectPluginRunRequest,
    input_bytes: &[u8],
) -> String {
    let mut digest = Sha256::new();
    digest.update(b"editkin.effect-cache/v2\0");
    digest.update(manifest.id.as_bytes());
    digest.update([0]);
    digest.update(manifest.version.as_bytes());
    digest.update([0]);
    digest.update(manifest.library_sha256.as_bytes());
    digest.update(request.width.to_le_bytes());
    digest.update(request.height.to_le_bytes());
    digest.update(request.frame_index.to_le_bytes());
    digest.update(request.time_numerator.to_le_bytes());
    digest.update(request.time_denominator.to_le_bytes());
    for parameter in &request.parameters {
        digest.update(parameter.to_le_bytes());
    }
    digest.update(input_bytes);
    let output = digest.finalize();
    output.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Called only in the short-lived worker process. A malformed native plugin can
/// terminate this process, but never the editor/Tauri host.
pub fn run_plugin_worker(
    request: EffectPluginRunRequest,
) -> Result<EffectPluginWorkerReceipt, String> {
    if request.schema != "editkin.effect-plugin-run/v1"
        || request.width == 0
        || request.height == 0
        || request.time_denominator <= 0
        || request.parameters.len() > 4096
        || request.parameters.iter().any(|value| !value.is_finite())
    {
        return Err("invalid effect plugin run request".into());
    }
    let manifest: EffectPluginManifest = serde_json::from_str(
        &fs::read_to_string(&request.manifest_path)
            .map_err(|error| format!("read {}: {error}", request.manifest_path.display()))?,
    )
    .map_err(|error| format!("plugin manifest: {error}"))?;
    validate_plugin_manifest(&manifest)?;
    if !manifest
        .supported_formats
        .contains(&PixelFormat::Rgba32Float)
    {
        return Err("plugin does not support RGBA32F host boundary".into());
    }
    let actual_hash = sha256_file(&request.library_path)?;
    if !manifest.library_sha256.eq_ignore_ascii_case(&actual_hash) {
        return Err("effect plugin library hash mismatch".into());
    }
    let pixel_count = request
        .width
        .checked_mul(request.height)
        .ok_or("effect dimensions overflow")? as usize;
    let input_bytes = fs::read(&request.input_path)
        .map_err(|error| format!("read {}: {error}", request.input_path.display()))?;
    let input = decode_f32(&input_bytes)?;
    if input.len() != pixel_count * 4 || input.iter().any(|value| !value.is_finite()) {
        return Err("effect input pixel count or values are invalid".into());
    }
    let mut output = vec![0.0_f32; input.len()];
    let identity = cache_identity(&manifest, &request, &input_bytes);
    // SAFETY: the library hash and ABI manifest are checked before loading; all
    // buffers remain alive and correctly sized for the duration of the call.
    let result = unsafe {
        let library = libloading::Library::new(&request.library_path)
            .map_err(|error| format!("load effect plugin: {error}"))?;
        if manifest.abi_version == EFFECT_ABI_V1 {
            let call = EffectProcessV1 {
                abi_version: EFFECT_ABI_V1,
                width: request.width,
                height: request.height,
                input_rgba32f: input.as_ptr(),
                output_rgba32f: output.as_mut_ptr(),
                pixel_count,
                parameter_count: request.parameters.len(),
                parameters: request.parameters.as_ptr(),
            };
            let entry: libloading::Symbol<EffectEntryV1> = library
                .get(manifest.entry_symbol.as_bytes())
                .map_err(|error| format!("load effect entry: {error}"))?;
            entry(&call)
        } else {
            let call = EffectProcessV2 {
                struct_size: std::mem::size_of::<EffectProcessV2>() as u32,
                abi_version: EFFECT_ABI_V2,
                width: request.width,
                height: request.height,
                input_rgba32f: input.as_ptr(),
                output_rgba32f: output.as_mut_ptr(),
                pixel_count,
                parameter_count: request.parameters.len(),
                parameters: request.parameters.as_ptr(),
                frame_index: request.frame_index,
                time_numerator: request.time_numerator,
                time_denominator: request.time_denominator,
                flags: 0,
                reserved: 0,
            };
            let entry: libloading::Symbol<EffectEntryV2> = library
                .get(manifest.entry_symbol.as_bytes())
                .map_err(|error| format!("load effect entry: {error}"))?;
            entry(&call)
        }
    };
    if result != 0 {
        return Err(format!("effect plugin returned {result}"));
    }
    if output.iter().any(|value| !value.is_finite())
        || output.chunks_exact(4).any(|pixel| {
            pixel[3] < 0.0 || pixel[3] > 1.0 || pixel[0] < 0.0 || pixel[1] < 0.0 || pixel[2] < 0.0
        })
    {
        return Err("effect plugin produced invalid RGBA32F".into());
    }
    let mut bytes = Vec::with_capacity(output.len() * 4);
    for value in output {
        bytes.extend(value.to_le_bytes());
    }
    if let Some(parent) = request.output_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("create {}: {error}", parent.display()))?;
    }
    fs::write(&request.output_path, bytes)
        .map_err(|error| format!("write {}: {error}", request.output_path.display()))?;
    Ok(EffectPluginWorkerReceipt {
        schema: "editkin.effect-plugin-worker-receipt/v1",
        status: "GREEN",
        plugin_id: manifest.id,
        pixels: pixel_count,
        output_path: request.output_path,
        cache_identity: identity,
        frame_index: request.frame_index,
    })
}

fn digest_hex(digest: impl AsRef<[u8]>) -> String {
    digest
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn sequence_frame_time(
    request: &EffectPluginSequenceRequest,
    offset: u32,
) -> Result<(i64, i64), String> {
    let start = request.start_time_numerator as i128 * request.frame_duration_denominator as i128;
    let elapsed = offset as i128
        * request.frame_duration_numerator as i128
        * request.time_denominator as i128;
    let mut numerator = start
        .checked_add(elapsed)
        .ok_or("effect sequence time overflow")?;
    let mut denominator = (request.time_denominator as i128)
        .checked_mul(request.frame_duration_denominator as i128)
        .ok_or("effect sequence time overflow")?;
    let mut left = numerator.unsigned_abs();
    let mut right = denominator as u128;
    while right != 0 {
        let remainder = left % right;
        left = right;
        right = remainder;
    }
    let divisor = left.max(1) as i128;
    numerator /= divisor;
    denominator /= divisor;
    Ok((
        i64::try_from(numerator).map_err(|_| "effect sequence time overflow")?,
        i64::try_from(denominator).map_err(|_| "effect sequence time overflow")?,
    ))
}

pub fn sequence_temp_output_path(output_path: &Path, process_id: u32) -> PathBuf {
    let mut temporary = output_path.as_os_str().to_os_string();
    temporary.push(format!(".{process_id}.tmp"));
    PathBuf::from(temporary)
}

fn run_plugin_sequence_inner(
    request: &EffectPluginSequenceRequest,
    manifest: &EffectPluginManifest,
    temporary_output: &Path,
) -> Result<EffectPluginSequenceWorkerReceipt, String> {
    let pixel_count = request
        .width
        .checked_mul(request.height)
        .ok_or("effect sequence dimensions overflow")? as usize;
    let values_per_frame = pixel_count
        .checked_mul(4)
        .ok_or("effect sequence frame size overflow")?;
    let frame_bytes = values_per_frame
        .checked_mul(std::mem::size_of::<f32>())
        .ok_or("effect sequence frame size overflow")?;
    let expected_bytes = (frame_bytes as u64)
        .checked_mul(request.frame_count as u64)
        .ok_or("effect sequence byte length overflow")?;
    let actual_bytes = fs::metadata(&request.input_path)
        .map_err(|error| format!("read {}: {error}", request.input_path.display()))?
        .len();
    if actual_bytes != expected_bytes {
        return Err(format!(
            "effect sequence input byte length {actual_bytes} != {expected_bytes}"
        ));
    }
    if let Some(parent) = temporary_output.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("create {}: {error}", parent.display()))?;
    }
    let input_file = fs::File::open(&request.input_path)
        .map_err(|error| format!("read {}: {error}", request.input_path.display()))?;
    let output_file = fs::File::create(temporary_output)
        .map_err(|error| format!("create {}: {error}", temporary_output.display()))?;
    let mut reader = BufReader::new(input_file);
    let mut writer = BufWriter::new(output_file);
    let mut input_bytes = Vec::new();
    input_bytes
        .try_reserve_exact(frame_bytes)
        .map_err(|_| "effect sequence input frame allocation failed")?;
    input_bytes.resize(frame_bytes, 0);
    let mut input = Vec::new();
    input
        .try_reserve_exact(values_per_frame)
        .map_err(|_| "effect sequence input pixel allocation failed")?;
    input.resize(values_per_frame, 0.0_f32);
    let mut output = Vec::new();
    output
        .try_reserve_exact(values_per_frame)
        .map_err(|_| "effect sequence output pixel allocation failed")?;
    output.resize(values_per_frame, 0.0_f32);
    let mut output_bytes = Vec::new();
    output_bytes
        .try_reserve_exact(frame_bytes)
        .map_err(|_| "effect sequence output frame allocation failed")?;
    output_bytes.resize(frame_bytes, 0);

    let mut cache_digest = Sha256::new();
    cache_digest.update(b"editkin.effect-sequence-cache/v1\0");
    cache_digest.update(manifest.id.as_bytes());
    cache_digest.update([0]);
    cache_digest.update(manifest.version.as_bytes());
    cache_digest.update([0]);
    cache_digest.update(manifest.library_sha256.as_bytes());
    cache_digest.update(request.width.to_le_bytes());
    cache_digest.update(request.height.to_le_bytes());
    cache_digest.update(request.frame_count.to_le_bytes());
    cache_digest.update(request.start_frame_index.to_le_bytes());
    cache_digest.update(request.start_time_numerator.to_le_bytes());
    cache_digest.update(request.time_denominator.to_le_bytes());
    cache_digest.update(request.frame_duration_numerator.to_le_bytes());
    cache_digest.update(request.frame_duration_denominator.to_le_bytes());
    for parameter in &request.parameters {
        cache_digest.update(parameter.to_le_bytes());
    }
    let mut output_digest = Sha256::new();

    // SAFETY: the worker owns the validated, hash-pinned library for the entire
    // sequence. Function pointers are copied only while that library is alive;
    // frame buffers remain fixed-size and live for each call.
    unsafe {
        let library = libloading::Library::new(&request.library_path)
            .map_err(|error| format!("load effect plugin: {error}"))?;
        #[derive(Clone, Copy)]
        enum Entry {
            V1(EffectEntryV1),
            V2(EffectEntryV2),
        }
        let entry = if manifest.abi_version == EFFECT_ABI_V1 {
            Entry::V1(
                *library
                    .get::<EffectEntryV1>(manifest.entry_symbol.as_bytes())
                    .map_err(|error| format!("load effect entry: {error}"))?,
            )
        } else {
            Entry::V2(
                *library
                    .get::<EffectEntryV2>(manifest.entry_symbol.as_bytes())
                    .map_err(|error| format!("load effect entry: {error}"))?,
            )
        };
        for offset in 0..request.frame_count {
            reader
                .read_exact(&mut input_bytes)
                .map_err(|error| format!("read effect sequence frame {offset}: {error}"))?;
            cache_digest.update(&input_bytes);
            for (value, bytes) in input.iter_mut().zip(input_bytes.chunks_exact(4)) {
                *value = f32::from_le_bytes(bytes.try_into().expect("four-byte chunk"));
            }
            if input.iter().any(|value| !value.is_finite()) {
                return Err(format!(
                    "effect sequence input frame {offset} contains invalid RGBA32F"
                ));
            }
            output.fill(0.0);
            let frame_index = request
                .start_frame_index
                .checked_add(offset as i64)
                .ok_or("effect sequence frame index overflow")?;
            let (time_numerator, time_denominator) = sequence_frame_time(request, offset)?;
            let result = match entry {
                Entry::V1(call) => call(&EffectProcessV1 {
                    abi_version: EFFECT_ABI_V1,
                    width: request.width,
                    height: request.height,
                    input_rgba32f: input.as_ptr(),
                    output_rgba32f: output.as_mut_ptr(),
                    pixel_count,
                    parameter_count: request.parameters.len(),
                    parameters: request.parameters.as_ptr(),
                }),
                Entry::V2(call) => call(&EffectProcessV2 {
                    struct_size: std::mem::size_of::<EffectProcessV2>() as u32,
                    abi_version: EFFECT_ABI_V2,
                    width: request.width,
                    height: request.height,
                    input_rgba32f: input.as_ptr(),
                    output_rgba32f: output.as_mut_ptr(),
                    pixel_count,
                    parameter_count: request.parameters.len(),
                    parameters: request.parameters.as_ptr(),
                    frame_index,
                    time_numerator,
                    time_denominator,
                    flags: 0,
                    reserved: 0,
                }),
            };
            if result != 0 {
                return Err(format!(
                    "effect plugin returned {result} on frame {frame_index}"
                ));
            }
            if output.iter().any(|value| !value.is_finite())
                || output.chunks_exact(4).any(|pixel| {
                    pixel[3] < 0.0
                        || pixel[3] > 1.0
                        || pixel[0] < 0.0
                        || pixel[1] < 0.0
                        || pixel[2] < 0.0
                })
            {
                return Err(format!(
                    "effect plugin produced invalid RGBA32F on frame {frame_index}"
                ));
            }
            for (bytes, value) in output_bytes.chunks_exact_mut(4).zip(&output) {
                bytes.copy_from_slice(&value.to_le_bytes());
            }
            writer
                .write_all(&output_bytes)
                .map_err(|error| format!("write effect sequence frame {offset}: {error}"))?;
            output_digest.update(&output_bytes);
        }
        drop(library);
    }
    writer
        .flush()
        .map_err(|error| format!("flush {}: {error}", temporary_output.display()))?;
    writer
        .get_ref()
        .sync_all()
        .map_err(|error| format!("sync {}: {error}", temporary_output.display()))?;
    drop(writer);
    if request.output_path.exists() {
        fs::remove_file(&request.output_path)
            .map_err(|error| format!("replace {}: {error}", request.output_path.display()))?;
    }
    fs::rename(temporary_output, &request.output_path).map_err(|error| {
        format!(
            "commit {} to {}: {error}",
            temporary_output.display(),
            request.output_path.display()
        )
    })?;
    let first_frame_index = request.start_frame_index;
    let last_frame_index = request
        .start_frame_index
        .checked_add(request.frame_count as i64 - 1)
        .ok_or("effect sequence frame index overflow")?;
    Ok(EffectPluginSequenceWorkerReceipt {
        schema: "editkin.effect-plugin-sequence-worker-receipt/v1",
        status: "GREEN",
        plugin_id: manifest.id.clone(),
        frame_count: request.frame_count,
        pixels_per_frame: pixel_count,
        library_loads: 1,
        first_frame_index,
        last_frame_index,
        input_bytes: expected_bytes,
        output_bytes: expected_bytes,
        output_path: request.output_path.clone(),
        output_sha256: digest_hex(output_digest.finalize()),
        cache_identity: digest_hex(cache_digest.finalize()),
    })
}

/// Runs a bounded frame sequence inside one isolated worker process. The DLL
/// is loaded once, while the input/output are streamed one frame at a time.
pub fn run_plugin_sequence_worker(
    request: EffectPluginSequenceRequest,
) -> Result<EffectPluginSequenceWorkerReceipt, String> {
    if request.schema != "editkin.effect-plugin-sequence/v1"
        || request.width == 0
        || request.height == 0
        || request.frame_count == 0
        || request.frame_count > 18_000
        || request.time_denominator <= 0
        || request.frame_duration_numerator <= 0
        || request.frame_duration_denominator <= 0
        || request.parameters.len() > 4096
        || request.parameters.iter().any(|value| !value.is_finite())
    {
        return Err("invalid effect plugin sequence request".into());
    }
    request
        .start_frame_index
        .checked_add(request.frame_count as i64 - 1)
        .ok_or("invalid effect plugin sequence request")?;
    sequence_frame_time(&request, request.frame_count - 1)
        .map_err(|_| "invalid effect plugin sequence request")?;
    let manifest: EffectPluginManifest = serde_json::from_str(
        &fs::read_to_string(&request.manifest_path)
            .map_err(|error| format!("read {}: {error}", request.manifest_path.display()))?,
    )
    .map_err(|error| format!("plugin manifest: {error}"))?;
    validate_plugin_manifest(&manifest)?;
    if !manifest
        .supported_formats
        .contains(&PixelFormat::Rgba32Float)
    {
        return Err("plugin does not support RGBA32F host boundary".into());
    }
    let actual_hash = sha256_file(&request.library_path)?;
    if !manifest.library_sha256.eq_ignore_ascii_case(&actual_hash) {
        return Err("effect plugin library hash mismatch".into());
    }
    let temporary_output = sequence_temp_output_path(&request.output_path, std::process::id());
    let result = run_plugin_sequence_inner(&request, &manifest, &temporary_output);
    if result.is_err() {
        let _ = fs::remove_file(&temporary_output);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> EffectPluginSequenceRequest {
        EffectPluginSequenceRequest {
            schema: "editkin.effect-plugin-sequence/v1".into(),
            manifest_path: "manifest.json".into(),
            library_path: "plugin.dll".into(),
            input_path: "input.rgba32f".into(),
            output_path: "output.rgba32f".into(),
            width: 4,
            height: 2,
            frame_count: 120,
            start_frame_index: 90,
            start_time_numerator: 3,
            time_denominator: 30,
            frame_duration_numerator: 1,
            frame_duration_denominator: 30,
            parameters: vec![0.8, 0.25, 0.0],
        }
    }

    #[test]
    fn sequence_time_is_exact_and_reduced() {
        let request = request();
        assert_eq!(sequence_frame_time(&request, 0).unwrap(), (1, 10));
        assert_eq!(sequence_frame_time(&request, 3).unwrap(), (1, 5));
    }

    #[test]
    fn sequence_temp_output_is_process_scoped() {
        assert_eq!(
            sequence_temp_output_path(Path::new("render.rgba32f"), 42),
            PathBuf::from("render.rgba32f.42.tmp")
        );
    }
}
