use std::collections::BTreeSet;
use std::ffi::c_char;
use std::fs::{self, File};
use std::io::{BufReader, Read};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::slice;
use std::time::Instant;

use anyhow::{Context, Result, anyhow, bail};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const ABI_VERSION: u32 = 1;
const MANIFEST_NAME: &str = "EDITKIN_FFMPEG_RUNTIME.json";
const EXPECTED_MANIFEST: &str =
    include_str!("../fixtures/software-video/ffmpeg-lgpl-runtime-rd.json");
const MAX_INPUT_BYTES: u64 = 64 * 1024 * 1024 * 1024;
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
const EXPECTED_AVUTIL_VERSION: u32 = (60 << 16) | (26 << 8) | 102;
const EXPECTED_AVCODEC_VERSION: u32 = (62 << 16) | (28 << 8) | 102;
const EXPECTED_AVFORMAT_VERSION: u32 = (62 << 16) | (12 << 8) | 102;
const PACKAGING_BLOCKER: &str = "The R&D runtime is hash-pinned and LGPL-labelled, but the product does not yet bundle a reproducible minimal build plus corresponding source/notices for every statically included third-party dependency.";

#[repr(C)]
struct RawRuntimeProbe {
    abi_version: u32,
    avutil_version: u32,
    avcodec_version: u32,
    avformat_version: u32,
    license: [c_char; 96],
    configuration: [c_char; 4096],
    error_code: [c_char; 64],
    error_message: [c_char; 512],
}

#[repr(C)]
struct RawSoftwareFrame {
    abi_version: u32,
    width: u32,
    height: u32,
    frame_rate_numerator: u32,
    frame_rate_denominator: u32,
    codec_id: i32,
    pixel_format: i32,
    color_range: i32,
    color_space: i32,
    color_primaries: i32,
    color_transfer: i32,
    interlaced: i32,
    key_frame: i32,
    pts_100ns: i64,
    duration_100ns: i64,
    target_100ns: i64,
    tolerance_100ns: i64,
    packets_read: u64,
    frames_decoded: u64,
    data_size: u64,
    y_offset: u64,
    u_offset: u64,
    v_offset: u64,
    y_stride_bytes: u32,
    u_stride_bytes: u32,
    v_stride_bytes: u32,
    data: *mut u8,
    codec_name: [c_char; 16],
    pixel_format_name: [c_char; 32],
    error_code: [c_char; 64],
    error_message: [c_char; 512],
}

unsafe extern "C" {
    fn editkin_software_runtime_probe(
        runtime_root: *const u16,
        timeout_milliseconds: u32,
        out_probe: *mut RawRuntimeProbe,
    ) -> i32;

    fn editkin_software_decode_frame(
        runtime_root: *const u16,
        input_path: *const u16,
        target_100ns: i64,
        tolerance_100ns: i64,
        timeout_milliseconds: u32,
        out_frame: *mut RawSoftwareFrame,
    ) -> i32;

    fn editkin_software_frame_free(frame: *mut RawSoftwareFrame);
}

struct OwnedRawFrame(RawSoftwareFrame);

impl Drop for OwnedRawFrame {
    fn drop(&mut self) {
        // The bridge owns the allocation and accepts a zero/null frame.
        unsafe { editkin_software_frame_free(&mut self.0) };
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RuntimeManifest {
    schema: String,
    distribution_scope: String,
    shipping_eligible: bool,
    provider: String,
    release_tag: String,
    build_repository_commit: String,
    ffmpeg_commit: String,
    asset_name: String,
    asset_bytes: u64,
    asset_sha256: String,
    license_expression: String,
    license_file: RuntimeFile,
    libraries: Vec<RuntimeFile>,
    corresponding_source: CorrespondingSource,
    packaging_blocker: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RuntimeFile {
    path: String,
    bytes: u64,
    sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CorrespondingSource {
    ffmpeg: String,
    build_scripts: String,
    bundled: bool,
    third_party_dependency_source_closure: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeIdentityReceipt {
    provider: String,
    release_tag: String,
    build_repository_commit: String,
    ffmpeg_commit: String,
    asset_name: String,
    asset_bytes: u64,
    asset_sha256: String,
    license_expression: String,
    license: String,
    configuration_sha256: String,
    avutil_version: String,
    avcodec_version: String,
    avformat_version: String,
    manifest_exact_match: bool,
    file_hashes_verified: bool,
    closed_world_library_set: bool,
    reparse_points_rejected: bool,
    admission_milliseconds: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SoftwareRuntimeProbeReceipt {
    schema: &'static str,
    status: &'static str,
    route: &'static str,
    distribution_scope: &'static str,
    shipping_eligible: bool,
    corresponding_source_bundled: bool,
    third_party_dependency_source_closure: bool,
    runtime: RuntimeIdentityReceipt,
    packaging_blocker: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SoftwareDecodeReceipt {
    pub schema: &'static str,
    pub status: &'static str,
    pub route: &'static str,
    pub shipping_eligible: bool,
    pub packaged_latency_measured: bool,
    pub scope: SoftwareDecodeScope,
    pub runtime: RuntimeIdentityReceipt,
    pub input: SoftwareInputReceipt,
    pub request: SoftwareDecodeRequestReceipt,
    pub frame: SoftwareFrameReceipt,
    pub planes: SoftwarePlanesReceipt,
    pub copy_accounting: SoftwareCopyAccountingReceipt,
    pub timings: SoftwareDecodeTimingsReceipt,
    pub packaging_blocker: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SoftwareDecodeScope {
    codecs: [&'static str; 2],
    pixel_format: &'static str,
    color: &'static str,
    scan: &'static str,
    execution: &'static str,
    integration: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SoftwareInputReceipt {
    path: String,
    bytes: u64,
    sha256: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SoftwareDecodeRequestReceipt {
    target_100ns: i64,
    target_seconds: f64,
    tolerance_100ns: i64,
    tolerance_seconds: f64,
    timeout_milliseconds: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SoftwareFrameReceipt {
    width: u32,
    height: u32,
    codec: String,
    codec_id: i32,
    pixel_format: String,
    pixel_format_id: i32,
    color_range: &'static str,
    color_space: &'static str,
    color_primaries: &'static str,
    color_transfer: &'static str,
    scan: &'static str,
    pts_100ns: i64,
    pts_seconds: f64,
    duration_100ns: i64,
    duration_seconds: f64,
    absolute_drift_100ns: u64,
    clock_within_tolerance: bool,
    frame_rate_numerator: u32,
    frame_rate_denominator: u32,
    packets_read: u64,
    frames_decoded: u64,
    key_frame: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SoftwarePlaneReceipt {
    offset: u64,
    stride_bytes: u32,
    bytes: u64,
    sha256: String,
    minimum_sample: u16,
    maximum_sample: u16,
    samples_outside_ten_bit: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SoftwarePlanesReceipt {
    layout: &'static str,
    total_bytes: u64,
    combined_sha256: String,
    y: SoftwarePlaneReceipt,
    u: SoftwarePlaneReceipt,
    v: SoftwarePlaneReceipt,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SoftwareCopyAccountingReceipt {
    decoder_output_memory: &'static str,
    decoder_output_frames: u64,
    bridge_tight_plane_cpu_copy_count: u32,
    bridge_tight_plane_cpu_copy_bytes: u64,
    rust_pixel_buffer_copy_count: u32,
    gpu_upload_count: u32,
    gpu_copy_count: u32,
    zero_copy: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SoftwareDecodeTimingsReceipt {
    decode_milliseconds: f64,
    measurement_boundary: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SoftwareDecodeBenchmarkReceipt {
    schema: &'static str,
    status: &'static str,
    route: &'static str,
    shipping_eligible: bool,
    packaged_latency_measured: bool,
    runtime: RuntimeIdentityReceipt,
    input: SoftwareInputReceipt,
    warmup_iterations: usize,
    measured_iterations: usize,
    target_sequence_seconds: Vec<f64>,
    samples_milliseconds: Vec<f64>,
    decoded_pts_seconds: Vec<f64>,
    p50_milliseconds: f64,
    p95_milliseconds: f64,
    maximum_milliseconds: f64,
    reference_frame_budget_milliseconds: f64,
    within_reference_frame_budget: bool,
    measurement_boundary: &'static str,
    packaging_blocker: &'static str,
}

#[derive(Clone)]
struct InputIdentity {
    receipt: SoftwareInputReceipt,
    path: PathBuf,
    wide_path: Vec<u16>,
}

struct AdmittedRuntime {
    identity: RuntimeIdentityReceipt,
    wide_root: Vec<u16>,
}

fn zeroed_probe() -> RawRuntimeProbe {
    // All fields are integers or byte arrays and the C ABI explicitly accepts a zeroed output buffer.
    unsafe { std::mem::zeroed() }
}

fn zeroed_frame() -> RawSoftwareFrame {
    // All fields are integers, byte arrays, or a nullable pointer; the bridge initializes the buffer.
    unsafe { std::mem::zeroed() }
}

fn wide_nul(path: &Path) -> Result<Vec<u16>> {
    let mut encoded = path.as_os_str().encode_wide().collect::<Vec<_>>();
    if encoded.contains(&0) {
        bail!("SOFTWARE_DECODE_PATH_NUL: path contains an interior NUL");
    }
    encoded.push(0);
    Ok(encoded)
}

fn c_text<const N: usize>(buffer: &[c_char; N]) -> Result<String> {
    let length = buffer.iter().position(|value| *value == 0).unwrap_or(N);
    let bytes = unsafe { slice::from_raw_parts(buffer.as_ptr().cast::<u8>(), length) };
    Ok(std::str::from_utf8(bytes)
        .context("FFmpeg runtime returned non-UTF-8 text")?
        .to_owned())
}

fn sha256_bytes(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn sha256_file(path: &Path, maximum_bytes: u64) -> Result<(u64, String)> {
    let file = File::open(path).with_context(|| format!("open {}", path.display()))?;
    let metadata = file
        .metadata()
        .with_context(|| format!("stat {}", path.display()))?;
    if !metadata.is_file() || metadata.len() > maximum_bytes {
        bail!(
            "SOFTWARE_DECODE_FILE_BOUND: invalid or oversized file {}",
            path.display()
        );
    }
    let mut reader = BufReader::with_capacity(1024 * 1024, file);
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1024 * 1024];
    let mut total = 0u64;
    loop {
        let read = reader
            .read(&mut buffer)
            .with_context(|| format!("hash {}", path.display()))?;
        if read == 0 {
            break;
        }
        total = total
            .checked_add(read as u64)
            .context("file length overflow")?;
        if total > maximum_bytes {
            bail!("SOFTWARE_DECODE_FILE_BOUND: file exceeds byte ceiling");
        }
        hasher.update(&buffer[..read]);
    }
    if total != metadata.len() {
        bail!("SOFTWARE_DECODE_FILE_CHANGED: file changed while hashing");
    }
    Ok((total, format!("{:x}", hasher.finalize())))
}

fn reject_reparse(path: &Path, expected_directory: bool) -> Result<()> {
    let metadata =
        fs::symlink_metadata(path).with_context(|| format!("inspect {}", path.display()))?;
    if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        bail!("SOFTWARE_DECODE_REPARSE_POINT: {}", path.display());
    }
    if expected_directory != metadata.is_dir() {
        bail!("SOFTWARE_DECODE_FILE_TYPE: {}", path.display());
    }
    Ok(())
}

fn parse_expected_manifest() -> Result<RuntimeManifest> {
    serde_json::from_str(EXPECTED_MANIFEST).context("parse embedded FFmpeg R&D manifest")
}

fn validate_runtime_files(root: &Path, manifest: &RuntimeManifest) -> Result<()> {
    reject_reparse(root, true)?;
    let canonical_root = fs::canonicalize(root).context("canonicalize runtime root")?;
    let bin = root.join("bin");
    reject_reparse(&bin, true)?;

    let expected_names = manifest
        .libraries
        .iter()
        .map(|file| {
            Path::new(&file.path)
                .file_name()
                .and_then(|value| value.to_str())
                .map(str::to_owned)
                .ok_or_else(|| anyhow!("invalid runtime library path: {}", file.path))
        })
        .collect::<Result<BTreeSet<_>>>()?;
    let actual_names = fs::read_dir(&bin)
        .context("read runtime bin directory")?
        .map(|entry| {
            let entry = entry.context("read runtime bin entry")?;
            reject_reparse(&entry.path(), false)?;
            entry
                .file_name()
                .into_string()
                .map_err(|_| anyhow!("runtime bin contains a non-Unicode entry"))
        })
        .collect::<Result<BTreeSet<_>>>()?;
    if actual_names != expected_names {
        bail!(
            "SOFTWARE_DECODE_RUNTIME_CLOSED_WORLD: expected {:?}, found {:?}",
            expected_names,
            actual_names
        );
    }

    for admitted in std::iter::once(&manifest.license_file).chain(manifest.libraries.iter()) {
        let relative = Path::new(&admitted.path);
        if relative.is_absolute()
            || relative
                .components()
                .any(|component| !matches!(component, std::path::Component::Normal(_)))
        {
            bail!(
                "SOFTWARE_DECODE_RUNTIME_PATH: non-local path {}",
                admitted.path
            );
        }
        let path = root.join(relative);
        reject_reparse(&path, false)?;
        let canonical =
            fs::canonicalize(&path).with_context(|| format!("canonicalize {}", path.display()))?;
        if !canonical.starts_with(&canonical_root) {
            bail!("SOFTWARE_DECODE_RUNTIME_ESCAPE: {}", path.display());
        }
        let (bytes, sha256) = sha256_file(&path, admitted.bytes)?;
        if bytes != admitted.bytes || sha256 != admitted.sha256 {
            bail!(
                "SOFTWARE_DECODE_RUNTIME_HASH: {} expected {} bytes/{} got {} bytes/{}",
                admitted.path,
                admitted.bytes,
                admitted.sha256,
                bytes,
                sha256
            );
        }
    }
    Ok(())
}

fn version_string(version: u32) -> String {
    format!(
        "{}.{}.{}",
        version >> 16,
        (version >> 8) & 0xff,
        version & 0xff
    )
}

impl AdmittedRuntime {
    fn admit(root: &Path, timeout_milliseconds: u32) -> Result<Self> {
        validate_timeout(timeout_milliseconds)?;
        let started = Instant::now();
        let expected = parse_expected_manifest()?;
        if expected.schema != "editkin.ffmpeg-lgpl-runtime/v1"
            || expected.distribution_scope != "rd-only-not-for-package"
            || expected.shipping_eligible
            || expected.corresponding_source.bundled
            || expected
                .corresponding_source
                .third_party_dependency_source_closure
            || expected.packaging_blocker != PACKAGING_BLOCKER
        {
            bail!("SOFTWARE_DECODE_EMBEDDED_MANIFEST: unsafe embedded runtime policy");
        }

        let manifest_path = root.join(MANIFEST_NAME);
        reject_reparse(&manifest_path, false)?;
        let manifest_text = fs::read_to_string(&manifest_path)
            .with_context(|| format!("read {}", manifest_path.display()))?;
        let actual: RuntimeManifest = serde_json::from_str(&manifest_text)
            .context("parse external FFmpeg R&D runtime manifest")?;
        if actual != expected {
            bail!("SOFTWARE_DECODE_RUNTIME_MANIFEST: runtime manifest is not the pinned receipt");
        }
        validate_runtime_files(root, &actual)?;

        let wide_root = wide_nul(root)?;
        let mut raw = zeroed_probe();
        let result = unsafe {
            editkin_software_runtime_probe(wide_root.as_ptr(), timeout_milliseconds, &mut raw)
        };
        if result != 0 {
            let code = c_text(&raw.error_code)?;
            let message = c_text(&raw.error_message)?;
            bail!("{}: {}", code, message);
        }
        if raw.abi_version != ABI_VERSION
            || raw.avutil_version != EXPECTED_AVUTIL_VERSION
            || raw.avcodec_version != EXPECTED_AVCODEC_VERSION
            || raw.avformat_version != EXPECTED_AVFORMAT_VERSION
        {
            bail!(
                "SOFTWARE_DECODE_RUNTIME_ABI: expected ABI {} / {} / {} / {}, got {} / {} / {} / {}",
                ABI_VERSION,
                version_string(EXPECTED_AVUTIL_VERSION),
                version_string(EXPECTED_AVCODEC_VERSION),
                version_string(EXPECTED_AVFORMAT_VERSION),
                raw.abi_version,
                version_string(raw.avutil_version),
                version_string(raw.avcodec_version),
                version_string(raw.avformat_version)
            );
        }
        let license = c_text(&raw.license)?;
        let configuration = c_text(&raw.configuration)?;
        if !license.contains("LGPL")
            || !configuration.contains("--enable-shared")
            || !configuration.contains("--disable-static")
            || !configuration.contains("--disable-libx264")
            || !configuration.contains("--disable-libx265")
            || configuration.contains("--enable-gpl")
            || configuration.contains("--enable-nonfree")
        {
            bail!(
                "SOFTWARE_DECODE_RUNTIME_LICENSE: runtime flags are outside the admitted closure"
            );
        }

        Ok(Self {
            identity: RuntimeIdentityReceipt {
                provider: actual.provider,
                release_tag: actual.release_tag,
                build_repository_commit: actual.build_repository_commit,
                ffmpeg_commit: actual.ffmpeg_commit,
                asset_name: actual.asset_name,
                asset_bytes: actual.asset_bytes,
                asset_sha256: actual.asset_sha256,
                license_expression: actual.license_expression,
                license,
                configuration_sha256: sha256_bytes(configuration.as_bytes()),
                avutil_version: version_string(raw.avutil_version),
                avcodec_version: version_string(raw.avcodec_version),
                avformat_version: version_string(raw.avformat_version),
                manifest_exact_match: true,
                file_hashes_verified: true,
                closed_world_library_set: true,
                reparse_points_rejected: true,
                admission_milliseconds: started.elapsed().as_secs_f64() * 1000.0,
            },
            wide_root,
        })
    }
}

fn validate_timeout(timeout_milliseconds: u32) -> Result<()> {
    if !(100..=60_000).contains(&timeout_milliseconds) {
        bail!("SOFTWARE_DECODE_INVALID_TIMEOUT: timeout must be 100..60000 milliseconds");
    }
    Ok(())
}

fn seconds_to_100ns(label: &str, seconds: f64, maximum_seconds: f64) -> Result<i64> {
    if !seconds.is_finite() || seconds < 0.0 || seconds > maximum_seconds {
        bail!("SOFTWARE_DECODE_INVALID_REQUEST: {label} is outside 0..={maximum_seconds}");
    }
    let ticks = seconds * 10_000_000.0;
    if ticks > i64::MAX as f64 {
        bail!("SOFTWARE_DECODE_INVALID_REQUEST: {label} overflows 100ns clock");
    }
    Ok(ticks.round() as i64)
}

fn validate_input(path: &Path) -> Result<InputIdentity> {
    reject_reparse(path, false)?;
    let canonical =
        fs::canonicalize(path).with_context(|| format!("canonicalize input {}", path.display()))?;
    let (bytes, sha256) = sha256_file(&canonical, MAX_INPUT_BYTES)?;
    if bytes == 0 {
        bail!("SOFTWARE_DECODE_EMPTY_INPUT: input is empty");
    }
    Ok(InputIdentity {
        receipt: SoftwareInputReceipt {
            path: canonical.to_string_lossy().into_owned(),
            bytes,
            sha256,
        },
        wide_path: wide_nul(&canonical)?,
        path: canonical,
    })
}

fn sample_stats(bytes: &[u8]) -> Result<(u16, u16, u64)> {
    if bytes.is_empty() || bytes.len() % 2 != 0 {
        bail!("SOFTWARE_DECODE_INVALID_PLANE: 10-bit plane has an invalid byte length");
    }
    let mut minimum = u16::MAX;
    let mut maximum = u16::MIN;
    let mut outside = 0u64;
    for sample in bytes.chunks_exact(2) {
        let value = u16::from_le_bytes([sample[0], sample[1]]);
        minimum = minimum.min(value);
        maximum = maximum.max(value);
        if value > 1023 {
            outside += 1;
        }
    }
    Ok((minimum, maximum, outside))
}

fn plane_receipt(
    all: &[u8],
    offset: u64,
    bytes: u64,
    stride_bytes: u32,
) -> Result<SoftwarePlaneReceipt> {
    let start = usize::try_from(offset).context("plane offset exceeds usize")?;
    let length = usize::try_from(bytes).context("plane length exceeds usize")?;
    let end = start.checked_add(length).context("plane range overflow")?;
    let plane = all
        .get(start..end)
        .ok_or_else(|| anyhow!("SOFTWARE_DECODE_INVALID_PLANE: plane is out of bounds"))?;
    let (minimum_sample, maximum_sample, samples_outside_ten_bit) = sample_stats(plane)?;
    Ok(SoftwarePlaneReceipt {
        offset,
        stride_bytes,
        bytes,
        sha256: sha256_bytes(plane),
        minimum_sample,
        maximum_sample,
        samples_outside_ten_bit,
    })
}

fn decode_admitted(
    runtime: &AdmittedRuntime,
    input: &InputIdentity,
    target_seconds: f64,
    tolerance_seconds: f64,
    timeout_milliseconds: u32,
) -> Result<SoftwareDecodeReceipt> {
    validate_timeout(timeout_milliseconds)?;
    let target_100ns = seconds_to_100ns("targetSeconds", target_seconds, 86_400.0)?;
    let tolerance_100ns = seconds_to_100ns("toleranceSeconds", tolerance_seconds, 5.0)?;
    let mut raw = OwnedRawFrame(zeroed_frame());
    let started = Instant::now();
    let result = unsafe {
        editkin_software_decode_frame(
            runtime.wide_root.as_ptr(),
            input.wide_path.as_ptr(),
            target_100ns,
            tolerance_100ns,
            timeout_milliseconds,
            &mut raw.0,
        )
    };
    let decode_milliseconds = started.elapsed().as_secs_f64() * 1000.0;
    if result != 0 {
        let code = c_text(&raw.0.error_code)?;
        let message = c_text(&raw.0.error_message)?;
        bail!("{}: {} [{}]", code, message, input.path.display());
    }
    let frame = &raw.0;
    if frame.abi_version != ABI_VERSION || frame.data.is_null() {
        bail!("SOFTWARE_DECODE_FRAME_ABI: bridge returned an invalid frame");
    }
    let codec = c_text(&frame.codec_name)?;
    let pixel_format = c_text(&frame.pixel_format_name)?;
    if !matches!(codec.as_str(), "h264" | "hevc")
        || pixel_format != "yuv422p10le"
        || frame.color_range != 1
        || frame.color_space != 1
        || frame.color_primaries != 1
        || frame.color_transfer != 1
        || frame.interlaced != 0
    {
        bail!("SOFTWARE_DECODE_FRAME_CONTRACT: bridge returned data outside the admitted scope");
    }
    let pixels = u64::from(frame.width)
        .checked_mul(u64::from(frame.height))
        .context("frame dimensions overflow")?;
    let y_bytes = pixels.checked_mul(2).context("Y plane length overflow")?;
    let chroma_bytes = pixels;
    let expected_total = pixels.checked_mul(4).context("frame length overflow")?;
    if frame.data_size != expected_total
        || frame.y_offset != 0
        || frame.u_offset != y_bytes
        || frame.v_offset != y_bytes + chroma_bytes
        || u64::from(frame.y_stride_bytes) != u64::from(frame.width) * 2
        || u64::from(frame.u_stride_bytes) != u64::from(frame.width)
        || u64::from(frame.v_stride_bytes) != u64::from(frame.width)
    {
        bail!("SOFTWARE_DECODE_FRAME_LAYOUT: bridge returned an invalid tight-plane layout");
    }
    let data_len = usize::try_from(frame.data_size).context("frame length exceeds usize")?;
    let data = unsafe { slice::from_raw_parts(frame.data.cast_const(), data_len) };
    let y = plane_receipt(data, frame.y_offset, y_bytes, frame.y_stride_bytes)?;
    let u = plane_receipt(data, frame.u_offset, chroma_bytes, frame.u_stride_bytes)?;
    let v = plane_receipt(data, frame.v_offset, chroma_bytes, frame.v_stride_bytes)?;
    if y.samples_outside_ten_bit != 0
        || u.samples_outside_ten_bit != 0
        || v.samples_outside_ten_bit != 0
    {
        bail!("SOFTWARE_DECODE_SAMPLE_DEPTH: decoded samples exceed 10-bit range");
    }
    let absolute_drift_100ns = frame.pts_100ns.abs_diff(target_100ns);
    let clock_within_tolerance = absolute_drift_100ns <= tolerance_100ns as u64;
    if !clock_within_tolerance
        || frame.target_100ns != target_100ns
        || frame.tolerance_100ns != tolerance_100ns
    {
        bail!("SOFTWARE_DECODE_PTS_CONTRACT: selected frame is outside tolerance");
    }

    Ok(SoftwareDecodeReceipt {
        schema: "editkin.software-video-decode/v1",
        status: "GREEN_RD_CELL",
        route: "ffmpeg-libav-software/v1",
        shipping_eligible: false,
        packaged_latency_measured: false,
        scope: SoftwareDecodeScope {
            codecs: ["h264", "hevc"],
            pixel_format: "yuv422p10le",
            color: "rec709-limited",
            scan: "progressive",
            execution: "cpu-software",
            integration: "standalone-rd-cli-only",
        },
        runtime: runtime.identity.clone(),
        input: input.receipt.clone(),
        request: SoftwareDecodeRequestReceipt {
            target_100ns,
            target_seconds,
            tolerance_100ns,
            tolerance_seconds,
            timeout_milliseconds,
        },
        frame: SoftwareFrameReceipt {
            width: frame.width,
            height: frame.height,
            codec,
            codec_id: frame.codec_id,
            pixel_format,
            pixel_format_id: frame.pixel_format,
            color_range: "limited",
            color_space: "bt709",
            color_primaries: "bt709",
            color_transfer: "bt709",
            scan: "progressive",
            pts_100ns: frame.pts_100ns,
            pts_seconds: frame.pts_100ns as f64 / 10_000_000.0,
            duration_100ns: frame.duration_100ns,
            duration_seconds: frame.duration_100ns as f64 / 10_000_000.0,
            absolute_drift_100ns,
            clock_within_tolerance,
            frame_rate_numerator: frame.frame_rate_numerator,
            frame_rate_denominator: frame.frame_rate_denominator,
            packets_read: frame.packets_read,
            frames_decoded: frame.frames_decoded,
            key_frame: frame.key_frame != 0,
        },
        planes: SoftwarePlanesReceipt {
            layout: "yuv422p10le-tight-planar/v1",
            total_bytes: frame.data_size,
            combined_sha256: sha256_bytes(data),
            y,
            u,
            v,
        },
        copy_accounting: SoftwareCopyAccountingReceipt {
            decoder_output_memory: "libav-cpu-frame",
            decoder_output_frames: frame.frames_decoded,
            bridge_tight_plane_cpu_copy_count: 1,
            bridge_tight_plane_cpu_copy_bytes: frame.data_size,
            rust_pixel_buffer_copy_count: 0,
            gpu_upload_count: 0,
            gpu_copy_count: 0,
            zero_copy: false,
        },
        timings: SoftwareDecodeTimingsReceipt {
            decode_milliseconds,
            measurement_boundary: "same-process bridge call: dynamic DLL load, demux open, seek, software decode, and one tight-plane CPU copy; excludes runtime/input hashing, GPU upload, composition, UI, and packaging",
        },
        packaging_blocker: PACKAGING_BLOCKER,
    })
}

pub fn runtime_probe_receipt(
    runtime_root: &Path,
    timeout_milliseconds: u32,
) -> Result<SoftwareRuntimeProbeReceipt> {
    let runtime = AdmittedRuntime::admit(runtime_root, timeout_milliseconds)?;
    Ok(SoftwareRuntimeProbeReceipt {
        schema: "editkin.software-video-runtime-probe/v1",
        status: "GREEN_RD_CELL",
        route: "ffmpeg-libav-software/v1",
        distribution_scope: "rd-only-not-for-package",
        shipping_eligible: false,
        corresponding_source_bundled: false,
        third_party_dependency_source_closure: false,
        runtime: runtime.identity,
        packaging_blocker: PACKAGING_BLOCKER,
    })
}

pub fn decode_to_receipt(
    runtime_root: &Path,
    input_path: &Path,
    target_seconds: f64,
    tolerance_seconds: f64,
    timeout_milliseconds: u32,
) -> Result<SoftwareDecodeReceipt> {
    let runtime = AdmittedRuntime::admit(runtime_root, timeout_milliseconds)?;
    let input = validate_input(input_path)?;
    decode_admitted(
        &runtime,
        &input,
        target_seconds,
        tolerance_seconds,
        timeout_milliseconds,
    )
}

fn percentile_nearest_rank(sorted: &[f64], percentile: f64) -> Result<f64> {
    if sorted.is_empty() || !(0.0..=1.0).contains(&percentile) {
        bail!("invalid percentile input");
    }
    let rank = ((sorted.len() as f64 * percentile).ceil() as usize)
        .max(1)
        .min(sorted.len());
    Ok(sorted[rank - 1])
}

pub fn benchmark_to_receipt(
    runtime_root: &Path,
    input_path: &Path,
    measured_iterations: usize,
) -> Result<SoftwareDecodeBenchmarkReceipt> {
    if measured_iterations != 20 {
        bail!("software benchmark is frozen at exactly 20 measured iterations");
    }
    let runtime = AdmittedRuntime::admit(runtime_root, 5_000)?;
    let input = validate_input(input_path)?;
    let _warmup = decode_admitted(&runtime, &input, 0.2, 0.001, 5_000)?;
    let target_sequence = [0.2, 0.4, 0.6, 0.8, 1.0, 1.2, 1.4, 1.6];
    let mut samples = Vec::with_capacity(measured_iterations);
    let mut decoded_pts = Vec::with_capacity(measured_iterations);
    let mut targets = Vec::with_capacity(measured_iterations);
    for index in 0..measured_iterations {
        let target = target_sequence[index % target_sequence.len()];
        let receipt = decode_admitted(&runtime, &input, target, 0.001, 5_000)?;
        targets.push(target);
        samples.push(receipt.timings.decode_milliseconds);
        decoded_pts.push(receipt.frame.pts_seconds);
    }
    let mut sorted = samples.clone();
    sorted.sort_by(f64::total_cmp);
    let p50_milliseconds = percentile_nearest_rank(&sorted, 0.50)?;
    let p95_milliseconds = percentile_nearest_rank(&sorted, 0.95)?;
    let maximum_milliseconds = *sorted.last().context("benchmark produced no samples")?;
    let reference_frame_budget_milliseconds = 33.334;
    Ok(SoftwareDecodeBenchmarkReceipt {
        schema: "editkin.software-video-decode-benchmark/v1",
        status: "MEASURED_RD_ONLY",
        route: "ffmpeg-libav-software/v1",
        shipping_eligible: false,
        packaged_latency_measured: false,
        runtime: runtime.identity,
        input: input.receipt,
        warmup_iterations: 1,
        measured_iterations,
        target_sequence_seconds: targets,
        samples_milliseconds: samples,
        decoded_pts_seconds: decoded_pts,
        p50_milliseconds,
        p95_milliseconds,
        maximum_milliseconds,
        reference_frame_budget_milliseconds,
        within_reference_frame_budget: p95_milliseconds <= reference_frame_budget_milliseconds,
        measurement_boundary: "single host/process; each sample reloads the pinned DLLs, opens the container, seeks, software-decodes one selected CPU frame, and copies tight planes; excludes hashing/admission, persistent scheduler/cache, GPU upload, composition, packaged app, and UI",
        packaging_blocker: PACKAGING_BLOCKER,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_manifest_is_fail_closed_and_not_shippable() {
        let manifest = parse_expected_manifest().unwrap();
        assert_eq!(manifest.schema, "editkin.ffmpeg-lgpl-runtime/v1");
        assert_eq!(manifest.libraries.len(), 4);
        assert!(!manifest.shipping_eligible);
        assert!(!manifest.corresponding_source.bundled);
        assert!(
            !manifest
                .corresponding_source
                .third_party_dependency_source_closure
        );
        assert_eq!(manifest.packaging_blocker, PACKAGING_BLOCKER);
    }

    #[test]
    fn time_request_bounds_are_closed() {
        assert_eq!(
            seconds_to_100ns("target", 0.5, 86_400.0).unwrap(),
            5_000_000
        );
        assert!(seconds_to_100ns("target", -0.1, 86_400.0).is_err());
        assert!(seconds_to_100ns("target", f64::NAN, 86_400.0).is_err());
        assert!(seconds_to_100ns("tolerance", 5.001, 5.0).is_err());
        assert!(validate_timeout(99).is_err());
        assert!(validate_timeout(60_001).is_err());
    }

    #[test]
    fn percentile_uses_nearest_rank() {
        let values = [1.0, 2.0, 3.0, 4.0, 5.0];
        assert_eq!(percentile_nearest_rank(&values, 0.50).unwrap(), 3.0);
        assert_eq!(percentile_nearest_rank(&values, 0.95).unwrap(), 5.0);
    }
}
