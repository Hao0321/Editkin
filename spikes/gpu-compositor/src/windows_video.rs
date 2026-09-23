//! Windows P0 evidence gate: Media Foundation/D3D11 decode surfaces are copied once on-GPU
//! into an app-owned shared BGRA8 resource, imported by the compositor's D3D12 device, wrapped
//! as a real wgpu texture, and consumed through a wgpu texture copy. The readback exists only to
//! make the gate falsifiable; production playback does not need it.

use std::collections::BTreeMap;
use std::ffi::c_void;
use std::fs;
use std::num::NonZeroIsize;
use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, anyhow, bail};
use serde::Serialize;
use wgpu::util::DeviceExt;
use windows::Win32::Foundation::{
    CloseHandle, GENERIC_ALL, HANDLE, HINSTANCE, HMODULE, HWND, LPARAM, LRESULT, POINT, S_OK,
    WPARAM,
};
use windows::Win32::Graphics::Direct3D::{
    D3D_DRIVER_TYPE_UNKNOWN, D3D_FEATURE_LEVEL, D3D_FEATURE_LEVEL_11_0, D3D_FEATURE_LEVEL_11_1,
};
use windows::Win32::Graphics::Direct3D10::ID3D10Multithread;
use windows::Win32::Graphics::Direct3D11::{
    D3D11_ASYNC_GETDATA_FLAG, D3D11_BIND_RENDER_TARGET, D3D11_BIND_SHADER_RESOURCE,
    D3D11_CPU_ACCESS_READ, D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_CREATE_DEVICE_FLAG,
    D3D11_CREATE_DEVICE_VIDEO_SUPPORT, D3D11_FENCE_FLAG_SHARED, D3D11_MAP_READ,
    D3D11_MAPPED_SUBRESOURCE, D3D11_QUERY_DESC, D3D11_QUERY_EVENT, D3D11_SDK_VERSION,
    D3D11_TEX2D_VPIV, D3D11_TEX2D_VPOV, D3D11_TEXTURE2D_DESC, D3D11_USAGE_DEFAULT,
    D3D11_USAGE_STAGING, D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE, D3D11_VIDEO_PROCESSOR_CONTENT_DESC,
    D3D11_VIDEO_PROCESSOR_FORMAT_SUPPORT_INPUT, D3D11_VIDEO_PROCESSOR_FORMAT_SUPPORT_OUTPUT,
    D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC, D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC_0,
    D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC, D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC_0,
    D3D11_VIDEO_PROCESSOR_STREAM, D3D11_VIDEO_USAGE_OPTIMAL_SPEED, D3D11_VPIV_DIMENSION_TEXTURE2D,
    D3D11_VPOV_DIMENSION_TEXTURE2D, D3D11CreateDevice, ID3D11Device, ID3D11Device1, ID3D11Device5,
    ID3D11DeviceContext, ID3D11DeviceContext4, ID3D11Fence, ID3D11Query, ID3D11Texture2D,
    ID3D11VideoContext, ID3D11VideoDevice,
};
use windows::Win32::Graphics::Direct3D12::{
    D3D12_HEAP_FLAG_SHARED, D3D12_HEAP_PROPERTIES, D3D12_HEAP_TYPE_DEFAULT, D3D12_RESOURCE_DESC,
    D3D12_RESOURCE_DIMENSION_TEXTURE2D, D3D12_RESOURCE_FLAG_ALLOW_RENDER_TARGET,
    D3D12_RESOURCE_FLAG_ALLOW_SIMULTANEOUS_ACCESS, D3D12_RESOURCE_STATE_COMMON,
    D3D12_TEXTURE_LAYOUT_UNKNOWN, ID3D12Fence, ID3D12Resource,
};
use windows::Win32::Graphics::Dxgi::Common::{
    DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_FORMAT_NV12, DXGI_RATIONAL,
};
use windows::Win32::Graphics::Dxgi::IDXGIAdapter3;
use windows::Win32::Graphics::Gdi::ClientToScreen;
use windows::Win32::Media::MediaFoundation::{
    IMFAttributes, IMFDXGIBuffer, IMFMediaType, IMFSample, IMFSourceReader, MF_LOW_LATENCY,
    MF_MT_FRAME_RATE, MF_MT_FRAME_SIZE, MF_MT_MAJOR_TYPE, MF_MT_SUBTYPE,
    MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, MF_SOURCE_READER_ALL_STREAMS,
    MF_SOURCE_READER_D3D_MANAGER, MF_SOURCE_READER_FIRST_VIDEO_STREAM,
    MF_SOURCE_READERF_ENDOFSTREAM, MF_VERSION, MFCreateAttributes, MFCreateDXGIDeviceManager,
    MFCreateMediaType, MFCreateSourceReaderFromURL, MFMediaType_Video, MFSTARTUP_FULL, MFShutdown,
    MFStartup, MFVideoFormat_NV12,
};
use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;
use windows::Win32::System::Com::{COINIT_MULTITHREADED, CoInitializeEx, CoUninitialize};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Threading::{
    AVRT_PRIORITY_HIGH, AvRevertMmThreadCharacteristics, AvSetMmThreadCharacteristicsW,
    AvSetMmThreadPriority,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CS_OWNDC, CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, HTTRANSPARENT,
    HWND_TOP, MSG, PM_REMOVE, PeekMessageW, RegisterClassW, SW_HIDE, SW_SHOWNA, SWP_NOACTIVATE,
    SWP_SHOWWINDOW, SetWindowPos, ShowWindow, TranslateMessage, WM_ERASEBKGND, WM_NCHITTEST,
    WNDCLASSW, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TRANSPARENT, WS_POPUP,
};
use windows::core::{GUID, Interface, PCWSTR};

use super::GpuCompositor;

mod scene_depth;
mod scene_depth_of_field;

const REPORT_SCHEMA: &str = "hao.video-decode-interop-gate/v1";
// Media Foundation timestamps, GOP seek placement and rational project clocks meet on a 100 ns
// integer grid. Keep half-frame searches stable across timestamp quantisation without redefining
// the final clock gate. One millisecond only affects candidate selection; receipts are still
// rejected when the selected frame drifts by more than one project frame.
const CLOCK_ROUNDING_EPSILON_100NS: i64 = 10_000;
// A 30 fps boundary cannot be represented exactly on Media Foundation's 100 ns grid. Permit one
// timestamp tick in the final receipt so 333,334 ticks is not rejected against a rounded 333,333
// tick tolerance. This is 0.0001 ms, not the 1 ms candidate-search window above.
const CLOCK_RECEIPT_EPSILON_100NS: i64 = 1;

struct ComGuard;

struct VideoMmcssGuard(Option<HANDLE>);

impl VideoMmcssGuard {
    fn start() -> Self {
        let mut task_index = 0_u32;
        let handle = unsafe {
            AvSetMmThreadCharacteristicsW(windows::core::w!("Playback"), &mut task_index)
        }
        .ok();
        if let Some(handle) = handle {
            let _ = unsafe { AvSetMmThreadPriority(handle, AVRT_PRIORITY_HIGH) };
        }
        Self(handle)
    }
}

impl Drop for VideoMmcssGuard {
    fn drop(&mut self) {
        if let Some(handle) = self.0.take() {
            let _ = unsafe { AvRevertMmThreadCharacteristics(handle) };
        }
    }
}

thread_local! {
    static VIDEO_MMCSS: VideoMmcssGuard = VideoMmcssGuard::start();
}

fn ensure_video_mmcss() {
    VIDEO_MMCSS.with(|_| {});
}

impl ComGuard {
    fn start() -> Result<Self> {
        unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }
            .ok()
            .context("initialize COM for Media Foundation")?;
        Ok(Self)
    }
}

impl Drop for ComGuard {
    fn drop(&mut self) {
        unsafe { CoUninitialize() };
    }
}

struct MediaFoundationGuard;

impl MediaFoundationGuard {
    fn start() -> Result<Self> {
        unsafe { MFStartup(MF_VERSION, MFSTARTUP_FULL) }.context("start Media Foundation")?;
        Ok(Self)
    }
}

impl Drop for MediaFoundationGuard {
    fn drop(&mut self) {
        let _ = unsafe { MFShutdown() };
    }
}

struct SharedHandle(Option<HANDLE>);

impl SharedHandle {
    fn get(&self) -> Result<HANDLE> {
        self.0.context("shared handle already closed")
    }
}

impl Drop for SharedHandle {
    fn drop(&mut self) {
        if let Some(handle) = self.0.take() {
            let _ = unsafe { CloseHandle(handle) };
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct InteropReport {
    schema: &'static str,
    decision: &'static str,
    input: String,
    adapter_name: String,
    backend: String,
    adapter_luid: String,
    requested_frames: usize,
    decoded_dxgi_frames: usize,
    shared_texture_frames: usize,
    wgpu_imported_frames: usize,
    wgpu_consumed_frames: usize,
    dropped_after_gpu_idle_frames: usize,
    width: u32,
    height: u32,
    decoder_surface_width: u32,
    decoder_surface_height: u32,
    source_dxgi_format: i32,
    shared_dxgi_format: i32,
    decode_path_cpu_pixel_copies: u32,
    gpu_processing_passes_per_frame: u32,
    verification_readback: bool,
    verification_pixel_hashes: Vec<String>,
    verification_d3d11_pixel_hashes: Vec<String>,
    synchronization: &'static str,
    fallback_contract: &'static str,
    claim_boundary: &'static str,
}

struct DecodeContext {
    device: ID3D11Device,
    context: ID3D11DeviceContext,
    reader: IMFSourceReader,
    adapter_luid: String,
    visible_width: u32,
    visible_height: u32,
    frame_rate_numerator: u32,
    frame_rate_denominator: u32,
}

struct InteropFrame {
    width: u32,
    height: u32,
    decoder_surface_width: u32,
    decoder_surface_height: u32,
    source_dxgi_format: i32,
    timestamp_100ns: i64,
    source_timestamp_100ns: i64,
    producer_hash: String,
    consumer_hash: String,
    rgba: Vec<u8>,
}

struct ResidentFrameSlot {
    shared_texture: ID3D11Texture2D,
    wrapped: wgpu::Texture,
    staged_texture: wgpu::Texture,
    pending_submission: Option<PendingGpuSubmission>,
    _handle: SharedHandle,
    processor_target: ID3D11Texture2D,
}

struct PendingGpuSubmission {
    index: wgpu::SubmissionIndex,
    sequence: u64,
}

/// One timeline fence is opened by both APIs on the same adapter. D3D11 signals after
/// video processing/copy; the raw D3D12 queue used by wgpu waits before consuming the texture.
/// This is GPU-to-GPU synchronization: the CPU does not poll producer completion.
struct CrossApiSharedFence {
    producer: ID3D11Fence,
    consumer: ID3D12Fence,
    _handle: SharedHandle,
}

struct StagedFrame {
    width: u32,
    height: u32,
    decoder_surface_width: u32,
    decoder_surface_height: u32,
    source_dxgi_format: i32,
    timestamp_100ns: i64,
    source_timestamp_100ns: i64,
    submission_sequence: u64,
    retired_submission_sequence: Option<u64>,
    cross_api_fence_value: u64,
    native_surface_presented: bool,
    native_surface_present_count: Option<u64>,
}

struct PreparedClockedStage {
    frame: StagedFrame,
    frame_index: u64,
    slot_index: usize,
    target_seconds: f64,
    tolerance_seconds: f64,
    dropped_for_clock: u64,
    must_seek: bool,
}

/// Closed visual-style contract shared by common-video presentation and the isolated
/// verification readback. Keep this layout in sync with `VideoVisualStyle` in WGSL.
#[repr(C)]
#[derive(Clone, Copy, Debug, Serialize, bytemuck::Pod, bytemuck::Zeroable)]
#[serde(rename_all = "camelCase")]
pub(super) struct VideoVisualStyle {
    pub translate_x: f32,
    pub translate_y: f32,
    pub scale: f32,
    pub rotation: f32,
    pub opacity: f32,
    pub source_width: f32,
    pub source_height: f32,
    pub effect_kind: u32,
    pub brightness: f32,
    pub contrast: f32,
    pub saturation: f32,
    pub hue: f32,
    pub exposure: f32,
    pub temperature: f32,
    pub tint: f32,
    pub pivot: f32,
    pub shadows: f32,
    pub highlights: f32,
    pub blacks: f32,
    pub whites: f32,
    pub white_balance_red: f32,
    pub white_balance_green: f32,
    pub white_balance_blue: f32,
    #[serde(skip)]
    pub white_balance_pad: f32,
    pub transform_pivot_x: f32,
    pub transform_pivot_y: f32,
    #[serde(skip)]
    pub transform_pad_x: f32,
    #[serde(skip)]
    pub transform_pad_y: f32,
    pub projective_h0: f32,
    pub projective_h1: f32,
    pub projective_h2: f32,
    pub projective_h3: f32,
    pub projective_h4: f32,
    pub projective_h5: f32,
    pub projective_h6: f32,
    pub projective_h7: f32,
    pub projective_enabled: f32,
    #[serde(skip)]
    pub shade_r: f32,
    #[serde(skip)]
    pub shade_g: f32,
    #[serde(skip)]
    pub shade_b: f32,
    pub blend_mode: u32,
    pub composite_opacity: f32,
    /// 0 = straight, 1 = opaque, 2 = premultiplied. Shader working buffers are straight-alpha.
    pub source_alpha_mode: u32,
    /// 0 = already scene-linear, 1 = legacy sRGB EOTF, 2 = explicit inverse Rec.709 OETF.
    #[serde(rename = "inputTransfer")]
    pub source_color_contract: f32,
    /// 0 = none, 1 = alpha, 2 = alpha inverted, 3 = Rec.709 luma, 4 = luma inverted.
    pub matte_mode: u32,
    /// D3D/WGPU depth plane: z = a * normalized_screen_x + b * normalized_screen_y + c.
    pub scene_depth_a: f32,
    pub scene_depth_b: f32,
    pub scene_depth_c: f32,
    pub shader_op_count: u32,
    pub scene_depth_enabled: u32,
    #[serde(skip)]
    pub shader_pad_y: u32,
    #[serde(skip)]
    pub shader_pad_z: u32,
    #[serde(skip)]
    pub shader_ops: [[f32; 4]; 16],
    pub motion_sample_count: u32,
    pub motion_contract_code: u32,
    pub motion_shutter_angle: f32,
    #[serde(skip)]
    pub motion_pad_z: f32,
    pub motion_samples: [[f32; 4]; 8],
    pub motion_sample_frames: [[f32; 4]; 2],
}

impl Default for VideoVisualStyle {
    fn default() -> Self {
        Self {
            translate_x: 0.0,
            translate_y: 0.0,
            scale: 1.0,
            rotation: 0.0,
            opacity: 1.0,
            source_width: 1.0,
            source_height: 1.0,
            effect_kind: 0,
            brightness: 0.0,
            contrast: 1.0,
            saturation: 1.0,
            hue: 0.0,
            exposure: 0.0,
            temperature: 0.0,
            tint: 0.0,
            pivot: 0.5,
            shadows: 0.0,
            highlights: 0.0,
            blacks: 0.0,
            whites: 0.0,
            white_balance_red: 0.0,
            white_balance_green: 0.0,
            white_balance_blue: 0.0,
            white_balance_pad: 0.0,
            transform_pivot_x: 0.0,
            transform_pivot_y: 0.0,
            transform_pad_x: 0.0,
            transform_pad_y: 0.0,
            projective_h0: 0.0,
            projective_h1: 0.0,
            projective_h2: 0.0,
            projective_h3: 0.0,
            projective_h4: 0.0,
            projective_h5: 0.0,
            projective_h6: 0.0,
            projective_h7: 0.0,
            projective_enabled: 0.0,
            shade_r: 1.0,
            shade_g: 1.0,
            shade_b: 1.0,
            blend_mode: 0,
            composite_opacity: 1.0,
            source_alpha_mode: 0,
            source_color_contract: 0.0,
            matte_mode: 0,
            scene_depth_a: 0.0,
            scene_depth_b: 0.0,
            scene_depth_c: 1.0,
            shader_op_count: 0,
            scene_depth_enabled: 0,
            shader_pad_y: 0,
            shader_pad_z: 0,
            shader_ops: [[0.0; 4]; 16],
            motion_sample_count: 0,
            motion_contract_code: 0,
            motion_shutter_angle: 0.0,
            motion_pad_z: 0.0,
            motion_samples: [[0.0; 4]; 8],
            motion_sample_frames: [[0.0; 4]; 2],
        }
    }
}

impl VideoVisualStyle {
    pub(super) fn with_source_dimensions(mut self, width: u32, height: u32) -> Self {
        self.source_width = width as f32;
        self.source_height = height as f32;
        self
    }

    pub(super) fn with_composite(
        mut self,
        blend_mode: u32,
        opacity: f32,
        source_alpha_mode: u32,
    ) -> Self {
        self.blend_mode = blend_mode.min(11);
        self.composite_opacity = opacity.clamp(0.0, 1.0);
        self.source_alpha_mode = source_alpha_mode.min(2);
        self
    }
}

#[derive(Clone, Copy)]
pub(super) struct VideoSurfaceMatte<'a> {
    pub source: &'a wgpu::Texture,
    pub style: VideoVisualStyle,
}

#[derive(Clone, Copy)]
pub(super) struct VideoSurfaceLayer<'a> {
    pub source: &'a wgpu::Texture,
    /// Exact decoded source-time textures for `decoded-temporal-shutter-accumulation/v1`.
    /// The fixed array keeps the layer descriptor borrow-only and Copy; motion_sample_count
    /// determines how many entries the shader consumes.
    pub temporal_sources: Option<[&'a wgpu::Texture; 8]>,
    pub source_width: u32,
    pub source_height: u32,
    pub style: VideoVisualStyle,
    pub matte: Option<VideoSurfaceMatte<'a>>,
}

fn scene_linear_input_transform(layers: &[VideoSurfaceLayer<'_>]) -> &'static str {
    if layers.iter().any(|layer| layer.style.source_color_contract > 1.5
        || layer.matte.is_some_and(|matte| matte.style.source_color_contract > 1.5)) {
        "editkin-rec709-to-linear-rec709-primary/v2"
    } else {
        "editkin-srgb-to-linear-rec709-primary/v1"
    }
}

/// Returns a conservative screen-space dirty rectangle for an affine layer whose source and
/// destination share one pixel coordinate system. Projective and aspect-remapped layers fall
/// back to the full-frame path so this optimization can never clip product pixels.
fn visual_dirty_rect(
    style: &VideoVisualStyle,
    source_width: u32,
    source_height: u32,
    destination_width: u32,
    destination_height: u32,
) -> Option<(u32, u32, u32, u32)> {
    let source_aspect = source_width as f64 / source_height as f64;
    let destination_aspect = destination_width as f64 / destination_height as f64;
    if (source_aspect - destination_aspect).abs() > 0.000_001
        || style.projective_enabled > 0.5
        || style.motion_sample_count > 1
        || !style.scale.is_finite()
        || !style.rotation.is_finite()
        || !style.translate_x.is_finite()
        || !style.translate_y.is_finite()
    {
        return None;
    }
    let scale = style.scale.abs().max(0.0001);
    let cosine = style.rotation.cos();
    let sine = style.rotation.sin();
    let half_width = source_width as f32 * 0.5;
    let half_height = source_height as f32 * 0.5;
    let mut minimum_x = f32::INFINITY;
    let mut minimum_y = f32::INFINITY;
    let mut maximum_x = f32::NEG_INFINITY;
    let mut maximum_y = f32::NEG_INFINITY;
    for (local_x, local_y) in [
        (-half_width, -half_height),
        (half_width, -half_height),
        (half_width, half_height),
        (-half_width, half_height),
    ] {
        let pivot_x = local_x - style.transform_pivot_x;
        let pivot_y = local_y - style.transform_pivot_y;
        let source_space_x = style.translate_x
            + style.transform_pivot_x
            + scale * (cosine * pivot_x - sine * pivot_y)
            + source_width as f32 * 0.5;
        let source_space_y = style.translate_y
            + style.transform_pivot_y
            + scale * (sine * pivot_x + cosine * pivot_y)
            + source_height as f32 * 0.5;
        let destination_x = source_space_x * destination_width as f32 / source_width as f32;
        let destination_y = source_space_y * destination_height as f32 / source_height as f32;
        minimum_x = minimum_x.min(destination_x);
        minimum_y = minimum_y.min(destination_y);
        maximum_x = maximum_x.max(destination_x);
        maximum_y = maximum_y.max(destination_y);
    }
    // Two pixels cover bilinear filtering and floating-point edge rounding.
    let x0 = (minimum_x.floor() as i64 - 2).clamp(0, i64::from(destination_width));
    let y0 = (minimum_y.floor() as i64 - 2).clamp(0, i64::from(destination_height));
    let x1 = (maximum_x.ceil() as i64 + 2).clamp(0, i64::from(destination_width));
    let y1 = (maximum_y.ceil() as i64 + 2).clamp(0, i64::from(destination_height));
    if x1 <= x0 || y1 <= y0 {
        return None;
    }
    let width = (x1 - x0) as u32;
    let height = (y1 - y0) as u32;
    let dirty_pixels = u64::from(width) * u64::from(height);
    let destination_pixels = u64::from(destination_width) * u64::from(destination_height);
    (dirty_pixels * 10 < destination_pixels * 9).then_some((x0 as u32, y0 as u32, width, height))
}

pub(super) struct ResidentOverlayTexture {
    texture: wgpu::Texture,
    width: u32,
    height: u32,
}

impl ResidentOverlayTexture {
    pub(super) fn upload(
        compositor: &GpuCompositor,
        width: u32,
        height: u32,
        rgba: &[u8],
    ) -> Result<Self> {
        if width == 0 || height == 0 || rgba.len() != width as usize * height as usize * 4 {
            bail!("resident overlay texture has invalid dimensions or byte length");
        }
        let texture = compositor.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Editkin resident caption overlay"),
            size: wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8UnormSrgb,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            // V2 SDR composites encoded Rec.709/display bytes without implicit texture transfer.
            view_formats: &[wgpu::TextureFormat::Rgba8Unorm],
        });
        compositor.queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            rgba,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(width * 4),
                rows_per_image: Some(height),
            },
            wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
        );
        Ok(Self {
            texture,
            width,
            height,
        })
    }

    pub(super) fn surface_layer(&self) -> VideoSurfaceLayer<'_> {
        self.surface_layer_with_opacity(1.0)
    }

    pub(super) fn surface_layer_with_opacity(&self, opacity: f32) -> VideoSurfaceLayer<'_> {
        self.surface_layer_with_motion(opacity, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0)
    }

    pub(super) fn surface_layer_with_motion(
        &self,
        opacity: f32,
        translate_x: f32,
        translate_y: f32,
        scale: f32,
        rotation_radians: f32,
        pivot_x: f32,
        pivot_y: f32,
    ) -> VideoSurfaceLayer<'_> {
        let mut style = VideoVisualStyle::default().with_source_dimensions(self.width, self.height);
        style.opacity = opacity.clamp(0.0, 1.0);
        style.translate_x = translate_x;
        style.translate_y = translate_y;
        style.scale = scale.clamp(0.01, 8.0);
        style.rotation = rotation_radians;
        style.transform_pivot_x = pivot_x;
        style.transform_pivot_y = pivot_y;
        VideoSurfaceLayer {
            source: &self.texture,
            temporal_sources: None,
            source_width: self.width,
            source_height: self.height,
            style,
            matte: None,
        }
    }

    pub(super) fn surface_layer_with_projective(
        &self,
        opacity: f32,
        homography: [f32; 8],
    ) -> VideoSurfaceLayer<'_> {
        let mut style = VideoVisualStyle::default().with_source_dimensions(self.width, self.height);
        style.opacity = opacity.clamp(0.0, 1.0);
        style.projective_h0 = homography[0];
        style.projective_h1 = homography[1];
        style.projective_h2 = homography[2];
        style.projective_h3 = homography[3];
        style.projective_h4 = homography[4];
        style.projective_h5 = homography[5];
        style.projective_h6 = homography[6];
        style.projective_h7 = homography[7];
        style.projective_enabled = 1.0;
        VideoSurfaceLayer {
            source: &self.texture,
            temporal_sources: None,
            source_width: self.width,
            source_height: self.height,
            style,
            matte: None,
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub(super) struct ResidentParticleSettings {
    pub seed: u32,
    pub rate_per_second: f32,
    pub lifetime_seconds: f32,
    pub max_particles: u32,
    pub emitter_position: [f32; 2],
    pub initial_velocity: [f32; 2],
    pub gravity: [f32; 2],
    pub radius_pixels: f32,
    pub color: [f32; 4],
}

/// Uniform-only update for a resident procedural particle texture. Pixel generation and all
/// compositing stay on the same wgpu device as decoded common-video presentation.
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct ResidentParticleParam {
    width: u32,
    height: u32,
    seed: u32,
    max_particles: u32,
    rate_per_second: f32,
    lifetime_seconds: f32,
    time_seconds: f32,
    radius_pixels: f32,
    emitter_position: [f32; 2],
    initial_velocity: [f32; 2],
    gravity: [f32; 2],
    color_rg: [f32; 2],
    color_ba: [f32; 2],
    padding: [f32; 2],
}

pub(super) struct ResidentParticleTexture {
    texture: wgpu::Texture,
    snapshots: Vec<ResidentParticleSnapshot>,
    active_snapshot_index: Option<usize>,
    width: u32,
    height: u32,
    parameter_buffer: wgpu::Buffer,
    bind_group: wgpu::BindGroup,
    pipeline: wgpu::ComputePipeline,
    gpu_texture_writes: u64,
    snapshot_copies: u64,
    snapshot_hits: u64,
    snapshot_misses: u64,
    snapshot_clock: u64,
}

struct ResidentParticleSnapshot {
    texture: wgpu::Texture,
    local_frame: Option<u64>,
    last_used: u64,
}

impl ResidentParticleTexture {
    pub(super) fn new(compositor: &GpuCompositor, width: u32, height: u32) -> Result<Self> {
        if width == 0 || height == 0 || width > 16_384 || height > 16_384 {
            bail!("resident particle texture dimensions are outside the bounded contract");
        }
        let texture = compositor.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Editkin resident video particle overlay"),
            size: wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::STORAGE_BINDING
                | wgpu::TextureUsages::TEXTURE_BINDING
                | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let snapshots = (0..crate::engine_graph::RESIDENT_PARTICLE_SNAPSHOT_CAPACITY_PER_EMITTER)
            .map(|_| ResidentParticleSnapshot {
                texture: compositor.device.create_texture(&wgpu::TextureDescriptor {
                    label: Some("Editkin resident particle seek snapshot"),
                    size: wgpu::Extent3d {
                        width,
                        height,
                        depth_or_array_layers: 1,
                    },
                    mip_level_count: 1,
                    sample_count: 1,
                    dimension: wgpu::TextureDimension::D2,
                    format: wgpu::TextureFormat::Rgba8Unorm,
                    usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
                    view_formats: &[],
                }),
                local_frame: None,
                last_used: 0,
            })
            .collect();
        let parameter_buffer = compositor.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Editkin resident video particle parameters"),
            size: std::mem::size_of::<ResidentParticleParam>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let layout = compositor
            .device
            .create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("Editkin resident video particle bindings"),
                entries: &[
                    wgpu::BindGroupLayoutEntry {
                        binding: 0,
                        visibility: wgpu::ShaderStages::COMPUTE,
                        ty: wgpu::BindingType::Buffer {
                            ty: wgpu::BufferBindingType::Uniform,
                            has_dynamic_offset: false,
                            min_binding_size: wgpu::BufferSize::new(std::mem::size_of::<
                                ResidentParticleParam,
                            >()
                                as u64),
                        },
                        count: None,
                    },
                    wgpu::BindGroupLayoutEntry {
                        binding: 1,
                        visibility: wgpu::ShaderStages::COMPUTE,
                        ty: wgpu::BindingType::StorageTexture {
                            access: wgpu::StorageTextureAccess::WriteOnly,
                            format: wgpu::TextureFormat::Rgba8Unorm,
                            view_dimension: wgpu::TextureViewDimension::D2,
                        },
                        count: None,
                    },
                ],
            });
        let shader = compositor.device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Editkin resident video particle compute shader"),
            source: wgpu::ShaderSource::Wgsl(r#"
struct ParticleParam {
    width: u32, height: u32, seed: u32, max_particles: u32,
    rate_per_second: f32, lifetime_seconds: f32, time_seconds: f32, radius_pixels: f32,
    emitter_position: vec2<f32>, initial_velocity: vec2<f32>,
    gravity: vec2<f32>, color_rg: vec2<f32>, color_ba: vec2<f32>, padding: vec2<f32>,
};
@group(0) @binding(0) var<uniform> params: ParticleParam;
@group(0) @binding(1) var output_texture: texture_storage_2d<rgba8unorm, write>;
fn particle_hash(seed: u32, index: u32, stream: u32) -> u32 {
    var value = seed ^ (index * 0x9e3779b9u) ^ (stream * 0x85ebca6bu);
    value = value ^ (value >> 16u); value = value * 0x7feb352du;
    value = value ^ (value >> 15u); value = value * 0x846ca68bu;
    return value ^ (value >> 16u);
}
fn particle_random(seed: u32, index: u32, stream: u32) -> f32 {
    return f32(particle_hash(seed, index, stream) & 0xffffu) / 65535.0;
}
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    if (gid.x >= params.width || gid.y >= params.height) { return; }
    if (params.rate_per_second <= 0.0 || params.lifetime_seconds <= 0.0 || params.max_particles == 0u) {
        textureStore(output_texture, vec2<i32>(gid.xy), vec4<f32>(0.0)); return;
    }
    let local = vec2<f32>(f32(gid.x), f32(gid.y));
    let spawned = i32(floor(params.time_seconds * params.rate_per_second));
    let emitter = vec2<f32>(params.emitter_position.x * f32(params.width - 1u), params.emitter_position.y * f32(params.height - 1u));
    var alpha = 0.0;
    for (var slot = 0u; slot < 64u; slot += 1u) {
        if (slot >= params.max_particles) { break; }
        let birth_signed = spawned - i32(slot); if (birth_signed < 0) { continue; }
        let birth = u32(birth_signed);
        let age = params.time_seconds - f32(birth) / params.rate_per_second;
        if (age < 0.0 || age > params.lifetime_seconds) { continue; }
        let velocity = vec2<f32>(params.initial_velocity.x + (particle_random(params.seed, birth, 0u) - 0.5) * 42.0, params.initial_velocity.y + (particle_random(params.seed, birth, 1u) - 0.5) * 18.0);
        let position = emitter + velocity * age + 0.5 * params.gravity * age * age;
        let distance = length(local - position);
        let radius = params.radius_pixels * (0.7 + particle_random(params.seed, birth, 2u) * 0.6);
        let core = clamp((radius - distance) / (radius * 0.35 + 0.5), 0.0, 1.0);
        let glow = clamp((radius * 2.4 - distance) / (radius * 1.8 + 0.5), 0.0, 1.0) * 0.18;
        let fade = clamp(1.0 - age / params.lifetime_seconds, 0.0, 1.0);
        let particle_alpha = clamp((core + glow) * params.color_ba.y * fade, 0.0, 1.0);
        alpha = particle_alpha + alpha * (1.0 - particle_alpha);
    }
    let color = select(vec4<f32>(0.0), vec4<f32>(params.color_rg, params.color_ba.x, alpha), alpha > 0.0);
    textureStore(output_texture, vec2<i32>(gid.xy), color);
}
"#.into()),
        });
        let pipeline_layout =
            compositor
                .device
                .create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                    label: Some("Editkin resident video particle pipeline layout"),
                    bind_group_layouts: &[Some(&layout)],
                    immediate_size: 0,
                });
        let pipeline =
            compositor
                .device
                .create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                    label: Some("Editkin resident video particle pipeline"),
                    layout: Some(&pipeline_layout),
                    module: &shader,
                    entry_point: Some("main"),
                    compilation_options: Default::default(),
                    cache: None,
                });
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        let bind_group = compositor
            .device
            .create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("Editkin resident video particle bind group"),
                layout: &layout,
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: parameter_buffer.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: wgpu::BindingResource::TextureView(&view),
                    },
                ],
            });
        Ok(Self {
            texture,
            snapshots,
            active_snapshot_index: None,
            width,
            height,
            parameter_buffer,
            bind_group,
            pipeline,
            gpu_texture_writes: 0,
            snapshot_copies: 0,
            snapshot_hits: 0,
            snapshot_misses: 0,
            snapshot_clock: 0,
        })
    }

    pub(super) fn update(
        &mut self,
        compositor: &GpuCompositor,
        settings: ResidentParticleSettings,
        time_seconds: f32,
        local_frame: u64,
    ) -> serde_json::Value {
        self.snapshot_clock = self.snapshot_clock.saturating_add(1);
        if let Some(index) = self
            .snapshots
            .iter()
            .position(|snapshot| snapshot.local_frame == Some(local_frame))
        {
            self.snapshots[index].last_used = self.snapshot_clock;
            self.active_snapshot_index = Some(index);
            self.snapshot_hits = self.snapshot_hits.saturating_add(1);
            return self.receipt(time_seconds, true);
        }
        self.snapshot_misses = self.snapshot_misses.saturating_add(1);
        self.active_snapshot_index = None;
        let params = ResidentParticleParam {
            width: self.width,
            height: self.height,
            seed: settings.seed,
            max_particles: settings.max_particles,
            rate_per_second: settings.rate_per_second,
            lifetime_seconds: settings.lifetime_seconds,
            time_seconds,
            radius_pixels: settings.radius_pixels,
            emitter_position: settings.emitter_position,
            initial_velocity: settings.initial_velocity,
            gravity: settings.gravity,
            color_rg: [settings.color[0], settings.color[1]],
            color_ba: [settings.color[2], settings.color[3]],
            padding: [0.0; 2],
        };
        compositor
            .queue
            .write_buffer(&self.parameter_buffer, 0, bytemuck::bytes_of(&params));
        let mut encoder =
            compositor
                .device
                .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                    label: Some("Editkin resident video particle update"),
                });
        {
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("Editkin resident video particle update pass"),
                timestamp_writes: None,
            });
            pass.set_pipeline(&self.pipeline);
            pass.set_bind_group(0, &self.bind_group, &[]);
            pass.dispatch_workgroups(self.width.div_ceil(8), self.height.div_ceil(8), 1);
        }
        let snapshot_index = self
            .snapshots
            .iter()
            .position(|snapshot| snapshot.local_frame.is_none())
            .unwrap_or_else(|| {
                self.snapshots
                    .iter()
                    .enumerate()
                    .min_by_key(|(_, snapshot)| snapshot.last_used)
                    .map(|(index, _)| index)
                    .unwrap_or(0)
            });
        encoder.copy_texture_to_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &self.texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::TexelCopyTextureInfo {
                texture: &self.snapshots[snapshot_index].texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::Extent3d {
                width: self.width,
                height: self.height,
                depth_or_array_layers: 1,
            },
        );
        compositor.queue.submit([encoder.finish()]);
        self.gpu_texture_writes += 1;
        self.snapshot_copies += 1;
        self.snapshots[snapshot_index].local_frame = Some(local_frame);
        self.snapshots[snapshot_index].last_used = self.snapshot_clock;
        self.receipt(time_seconds, false)
    }

    fn receipt(&self, time_seconds: f32, cache_hit: bool) -> serde_json::Value {
        let mut cached_local_frames = self
            .snapshots
            .iter()
            .filter_map(|snapshot| snapshot.local_frame)
            .collect::<Vec<_>>();
        cached_local_frames.sort_unstable();
        serde_json::json!({
            "executor": "wgpu-resident-video-particle-overlay/v1",
            "timeSeconds": time_seconds,
            "gpuTextureWrites": self.gpu_texture_writes,
            "uniformParameterWrites": self.gpu_texture_writes,
            "cpuPixelUploads": 0,
            "cpuPixelReadbacks": 0,
            "queueSubmissionMode": "ordered-same-device/v1",
            "snapshotCache": {
                "schema": "editkin.resident-particle-seek-snapshot/v1",
                "capacity": self.snapshots.len(),
                "hit": cache_hit,
                "cachedLocalFrames": cached_local_frames,
                "computeTextureWrites": self.gpu_texture_writes,
                "snapshotCopies": self.snapshot_copies,
                "hits": self.snapshot_hits,
                "misses": self.snapshot_misses,
                "cpuPixelCopies": 0
            }
        })
    }

    pub(super) fn surface_layer(&self) -> VideoSurfaceLayer<'_> {
        let style = VideoVisualStyle::default()
            .with_source_dimensions(self.width, self.height)
            .with_composite(0, 1.0, 0);
        VideoSurfaceLayer {
            source: self
                .active_snapshot_index
                .map(|index| &self.snapshots[index].texture)
                .unwrap_or(&self.texture),
            temporal_sources: None,
            source_width: self.width,
            source_height: self.height,
            style,
            matte: None,
        }
    }
}

struct OwnedPreviewWindow(HWND);

impl Drop for OwnedPreviewWindow {
    fn drop(&mut self) {
        let _ = unsafe { DestroyWindow(self.0) };
    }
}

/// DX12 swap-chain surface used for direct presentation over the editor's preview rectangle.
/// The surface is declared before the window so it is released before `DestroyWindow`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum NativePreviewColorSpace {
    SdrAuto,
    /// Internal versioned Rec.709 byte transport; selected by a v2 engine graph, not guessed from metadata.
    SdrRec709V2,
    Bt2100Pq,
    ExtendedSrgbLinear,
}

impl NativePreviewColorSpace {
    pub(super) fn parse(value: Option<&str>) -> Result<Self> {
        match value.map(str::trim).filter(|value| !value.is_empty()) {
            None | Some("srgb") | Some("sdr") | Some("auto") => Ok(Self::SdrAuto),
            Some("bt2100_pq") | Some("rec2100_pq_1000") => Ok(Self::Bt2100Pq),
            Some("extended_srgb_linear") | Some("scrgb") => Ok(Self::ExtendedSrgbLinear),
            Some("bt2100_hlg") | Some("rec2100_hlg_1000") => bail!(
                "DX12 has no RGB HLG swap-chain color space; use a calibrated scene-linear scRGB presentation path"
            ),
            Some(value) => bail!(
                "unsupported native preview surface color space: {value}; expected srgb, bt2100_pq or extended_srgb_linear"
            ),
        }
    }

    fn requested_name(self) -> &'static str {
        match self {
            Self::SdrAuto | Self::SdrRec709V2 => "srgb",
            Self::Bt2100Pq => "bt2100_pq",
            Self::ExtendedSrgbLinear => "extended_srgb_linear",
        }
    }

    fn pixel_contract(self) -> &'static str {
        match self {
            Self::SdrAuto => "legacy-sdr-video/v1",
            Self::SdrRec709V2 => "rec709-encoded-sdr-video/v2",
            Self::Bt2100Pq => "rec2020-pq-encoded-rgb/v1",
            Self::ExtendedSrgbLinear => "rec709-linear-scrgb/v1",
        }
    }

    fn legacy_video_allowed(self) -> bool {
        matches!(self, Self::SdrAuto | Self::SdrRec709V2)
    }
}

pub(super) struct NativePreviewSurface {
    surface: wgpu::Surface<'static>,
    configuration: wgpu::SurfaceConfiguration,
    color_space_contract: NativePreviewColorSpace,
    display_hdr_info: wgpu::DisplayHdrInfo,
    bind_group_layout: wgpu::BindGroupLayout,
    pipeline: wgpu::RenderPipeline,
    fused_bind_group_layout: wgpu::BindGroupLayout,
    fused_pipeline: wgpu::RenderPipeline,
    scene_linear_pipeline: wgpu::RenderPipeline,
    scene_depth_pipeline: wgpu::RenderPipeline,
    scene_depth_of_field_layout: wgpu::BindGroupLayout,
    scene_depth_of_field_pipeline: wgpu::RenderPipeline,
    scene_linear_display_layout: wgpu::BindGroupLayout,
    scene_linear_display_pipeline: wgpu::RenderPipeline,
    scene_linear_hdr_display_pipeline: wgpu::RenderPipeline,
    sampler: wgpu::Sampler,
    style_buffer: wgpu::Buffer,
    black_texture: wgpu::Texture,
    composite_intermediate: [wgpu::Texture; 2],
    adjustment_intermediate: [wgpu::Texture; 2],
    scene_linear_composite_intermediate: [wgpu::Texture; 2],
    scene_linear_adjustment_intermediate: [wgpu::Texture; 2],
    scene_linear_black_texture: wgpu::Texture,
    scene_depth_texture: wgpu::Texture,
    composite_style_buffers: Vec<wgpu::Buffer>,
    composite_matte_style_buffers: Vec<wgpu::Buffer>,
    post_adjustment_style_buffers: Vec<wgpu::Buffer>,
    post_adjustment_matte_style_buffers: Vec<wgpu::Buffer>,
    adjustment_style_buffers: Vec<wgpu::Buffer>,
    fused_count_buffers: Vec<wgpu::Buffer>,
    composite_present_buffer: wgpu::Buffer,
    window: OwnedPreviewWindow,
    owner: Option<HWND>,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    present_count: u64,
    visible: bool,
}

fn opaque_black_texel(format: wgpu::TextureFormat) -> &'static [u8] {
    match format {
        wgpu::TextureFormat::Rgba16Float => &[0, 0, 0, 0, 0, 0, 0, 0x3c],
        wgpu::TextureFormat::Rgb10a2Unorm => &[0, 0, 0, 0xc0],
        _ => &[0, 0, 0, 255],
    }
}

fn finite_json(value: Option<f32>) -> serde_json::Value {
    value
        .filter(|value| value.is_finite())
        .map_or(serde_json::Value::Null, serde_json::Value::from)
}

fn display_hdr_info_json(info: &wgpu::DisplayHdrInfo) -> serde_json::Value {
    let luminance = info.luminance;
    let headroom = info.headroom;
    let chromaticity = info.chromaticity;
    let coarse = info.coarse;
    serde_json::json!({
        "luminance": luminance.map(|value| serde_json::json!({
            "maxNits": finite_json(value.max_nits),
            "maxFullFrameNits": finite_json(value.max_full_frame_nits),
            "minNits": finite_json(value.min_nits),
            "sdrWhiteNits": finite_json(value.sdr_white_nits),
        })),
        "headroom": headroom.map(|value| serde_json::json!({
            "current": finite_json(value.current),
            "potential": finite_json(value.potential),
            "reference": finite_json(value.reference),
        })),
        "chromaticity": chromaticity.map(|value| serde_json::json!({
            "red": value.red,
            "green": value.green,
            "blue": value.blue,
            "white": value.white,
        })),
        "coarse": coarse.map(|value| serde_json::json!({
            "highDynamicRange": value.high_dynamic_range,
            "gamut": value.gamut.map(|gamut| format!("{gamut:?}")),
        })),
        "bitsPerColor": info.bits_per_color,
        "toneMapHeadroom": finite_json(info.tone_map_headroom()),
        "advisoryOnly": true,
    })
}

static PREVIEW_WINDOW_CLASS: OnceLock<u16> = OnceLock::new();

fn create_composite_intermediate(
    device: &wgpu::Device,
    width: u32,
    height: u32,
    format: wgpu::TextureFormat,
) -> [wgpu::Texture; 2] {
    ["ping", "pong"].map(|label| {
        device.create_texture(&wgpu::TextureDescriptor {
            label: Some(if label == "ping" {
                "Editkin common-video blend ping"
            } else {
                "Editkin common-video blend pong"
            }),
            size: wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT
                | wgpu::TextureUsages::TEXTURE_BINDING
                | wgpu::TextureUsages::COPY_SRC
                | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        })
    })
}

fn create_visual_style_buffer(device: &wgpu::Device, label: &'static str) -> wgpu::Buffer {
    device.create_buffer(&wgpu::BufferDescriptor {
        label: Some(label),
        size: std::mem::size_of::<VideoVisualStyle>() as u64,
        usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    })
}

const FUSED_LAYER_WIDTH: usize = 4;

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct FusedLayerCount {
    layer_count: u32,
    padding: [u32; 3],
}

fn create_fused_layer_count_buffer(device: &wgpu::Device) -> wgpu::Buffer {
    device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("Editkin fused common-video layer count"),
        size: std::mem::size_of::<FusedLayerCount>() as u64,
        usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    })
}

fn create_scene_linear_video_pipelines(
    device: &wgpu::Device,
    composite_layout: &wgpu::BindGroupLayout,
    surface_format: wgpu::TextureFormat,
) -> (
    wgpu::RenderPipeline,
    wgpu::RenderPipeline,
    wgpu::BindGroupLayout,
    wgpu::RenderPipeline,
    wgpu::RenderPipeline,
) {
    let composite_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("Editkin resident scene-linear video compositor shader"),
        source: wgpu::ShaderSource::Wgsl([include_str!("linear_white_balance.wgsl"), include_str!("scene_linear_video.wgsl")].concat().into()),
    });
    let composite_pipeline_layout =
        device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("Editkin resident scene-linear video compositor layout"),
            bind_group_layouts: &[Some(composite_layout)],
            immediate_size: 0,
        });
    let composite_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("Editkin resident scene-linear video compositor"),
        layout: Some(&composite_pipeline_layout),
        vertex: wgpu::VertexState {
            module: &composite_shader,
            entry_point: Some("vertex_main"),
            buffers: &[],
            compilation_options: Default::default(),
        },
        fragment: Some(wgpu::FragmentState {
            module: &composite_shader,
            entry_point: Some("fragment_main"),
            targets: &[Some(wgpu::ColorTargetState {
                format: wgpu::TextureFormat::Rgba16Float,
                blend: None,
                write_mask: wgpu::ColorWrites::ALL,
            })],
            compilation_options: Default::default(),
        }),
        primitive: Default::default(),
        depth_stencil: None,
        multisample: Default::default(),
        multiview_mask: None,
        cache: None,
    });
    let depth_pipeline = scene_depth::create_pipeline(device, composite_layout, &composite_shader);
    let display_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("Editkin resident scene-linear ACES2 display bindings"),
        entries: &[
            wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Texture {
                    sample_type: wgpu::TextureSampleType::Float { filterable: true },
                    view_dimension: wgpu::TextureViewDimension::D2,
                    multisampled: false,
                },
                count: None,
            },
            wgpu::BindGroupLayoutEntry {
                binding: 1,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                count: None,
            },
            wgpu::BindGroupLayoutEntry {
                binding: 2,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Storage { read_only: true },
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            },
        ],
    });
    let display_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("Editkin resident scene-linear ACES2 display shader"),
        source: wgpu::ShaderSource::Wgsl(include_str!("scene_linear_aces2_display.wgsl").into()),
    });
    let display_pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: Some("Editkin resident scene-linear ACES2 display layout"),
        bind_group_layouts: &[Some(&display_layout)],
        immediate_size: 0,
    });
    let display_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("Editkin resident scene-linear ACES2 Rec.709 SDR display"),
        layout: Some(&display_pipeline_layout),
        vertex: wgpu::VertexState {
            module: &display_shader,
            entry_point: Some("vertex_main"),
            buffers: &[],
            compilation_options: Default::default(),
        },
        fragment: Some(wgpu::FragmentState {
            module: &display_shader,
            entry_point: Some("fragment_main"),
            targets: &[Some(wgpu::ColorTargetState {
                format: surface_format,
                blend: None,
                write_mask: wgpu::ColorWrites::ALL,
            })],
            compilation_options: Default::default(),
        }),
        primitive: Default::default(),
        depth_stencil: None,
        multisample: Default::default(),
        multiview_mask: None,
        cache: None,
    });
    let hdr_display_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("Editkin resident scene-linear ACES2 Rec.2100 HDR display shader"),
        source: wgpu::ShaderSource::Wgsl(
            include_str!("scene_linear_aces2_hdr_display.wgsl").into(),
        ),
    });
    let hdr_display_pipeline =
        device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("Editkin resident scene-linear ACES2 Rec.2100 PQ display"),
            layout: Some(&display_pipeline_layout),
            vertex: wgpu::VertexState {
                module: &hdr_display_shader,
                entry_point: Some("vertex_main"),
                buffers: &[],
                compilation_options: Default::default(),
            },
            fragment: Some(wgpu::FragmentState {
                module: &hdr_display_shader,
                entry_point: Some("fragment_main"),
                targets: &[Some(wgpu::ColorTargetState {
                    format: surface_format,
                    blend: None,
                    write_mask: wgpu::ColorWrites::ALL,
                })],
                compilation_options: Default::default(),
            }),
            primitive: Default::default(),
            depth_stencil: None,
            multisample: Default::default(),
            multiview_mask: None,
            cache: None,
        });
    (
        composite_pipeline,
        depth_pipeline,
        display_layout,
        display_pipeline,
        hdr_display_pipeline,
    )
}

fn create_fused_composite_pipeline(
    device: &wgpu::Device,
    format: wgpu::TextureFormat,
) -> (wgpu::BindGroupLayout, wgpu::RenderPipeline) {
    let output_contract = format!("const TARGET_IS_SRGB: bool = {};\n", format.is_srgb());
    let texture_entry = |binding| wgpu::BindGroupLayoutEntry {
        binding,
        visibility: wgpu::ShaderStages::FRAGMENT,
        ty: wgpu::BindingType::Texture {
            sample_type: wgpu::TextureSampleType::Float { filterable: true },
            view_dimension: wgpu::TextureViewDimension::D2,
            multisampled: false,
        },
        count: None,
    };
    let style_entry = |binding| wgpu::BindGroupLayoutEntry {
        binding,
        visibility: wgpu::ShaderStages::FRAGMENT,
        ty: wgpu::BindingType::Buffer {
            ty: wgpu::BufferBindingType::Uniform,
            has_dynamic_offset: false,
            min_binding_size: wgpu::BufferSize::new(std::mem::size_of::<VideoVisualStyle>() as u64),
        },
        count: None,
    };
    let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("Editkin fused four-layer common-video bindings"),
        entries: &[
            texture_entry(0),
            wgpu::BindGroupLayoutEntry {
                binding: 1,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                count: None,
            },
            texture_entry(2),
            style_entry(3),
            texture_entry(4),
            style_entry(5),
            texture_entry(6),
            style_entry(7),
            texture_entry(8),
            style_entry(9),
            wgpu::BindGroupLayoutEntry {
                binding: 10,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: false,
                    min_binding_size: wgpu::BufferSize::new(
                        std::mem::size_of::<FusedLayerCount>() as u64
                    ),
                },
                count: None,
            },
        ],
    });
    let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("Editkin fused four-layer common-video shader"),
        source: wgpu::ShaderSource::Wgsl(
            [output_contract.as_str(), include_str!("linear_white_balance.wgsl"), r#"
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
    blend_mode: u32, composite_opacity: f32, source_alpha_mode: u32, composite_pad_y: f32,
    matte_mode: u32, matte_pad_x: f32, matte_pad_y: f32, matte_pad_z: f32,
    shader_op_count: u32, shader_pad_x: u32, shader_pad_y: u32, shader_pad_z: u32,
    shader_ops: array<vec4<f32>, 16>,
    motion_sample_count: u32, motion_contract_code: u32, motion_shutter_angle: f32, motion_pad_z: f32,
    motion_samples: array<vec4<f32>, 8>,
    motion_sample_frames: array<vec4<f32>, 2>,
};
struct FusedLayerCount { layer_count: u32, padding_0: u32, padding_1: u32, padding_2: u32 };
@group(0) @binding(0) var backdrop_texture: texture_2d<f32>;
@group(0) @binding(1) var source_sampler: sampler;
@group(0) @binding(2) var source_texture_0: texture_2d<f32>;
@group(0) @binding(3) var<uniform> style_0: VideoVisualStyle;
@group(0) @binding(4) var source_texture_1: texture_2d<f32>;
@group(0) @binding(5) var<uniform> style_1: VideoVisualStyle;
@group(0) @binding(6) var source_texture_2: texture_2d<f32>;
@group(0) @binding(7) var<uniform> style_2: VideoVisualStyle;
@group(0) @binding(8) var source_texture_3: texture_2d<f32>;
@group(0) @binding(9) var<uniform> style_3: VideoVisualStyle;
@group(0) @binding(10) var<uniform> fused: FusedLayerCount;

struct VertexOutput { @builtin(position) position: vec4<f32>, @location(0) uv: vec2<f32> };
@vertex fn vertex_main(@builtin(vertex_index) index: u32) -> VertexOutput {
    var positions = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
    var uvs = array<vec2<f32>, 3>(vec2<f32>(0.0, 1.0), vec2<f32>(2.0, 1.0), vec2<f32>(0.0, -1.0));
    var output: VertexOutput; output.position = vec4<f32>(positions[index], 0.0, 1.0); output.uv = uvs[index]; return output;
}
fn primary_tone(value: f32, style: VideoVisualStyle) -> f32 {
    var y0 = clamp(style.blacks * 0.08, 0.0, 0.18);
    var y1 = clamp(0.18 + style.shadows * 0.13, 0.02, 0.42);
    var y2 = clamp(0.5 + (0.5 - style.pivot) * 0.26, 0.24, 0.76);
    var y3 = clamp(0.82 + style.highlights * 0.13, 0.58, 0.98);
    var y4 = clamp(1.0 + style.whites * 0.08, 0.82, 1.0);
    y1 = max(y1, y0 + 0.002); y2 = max(y2, y1 + 0.002); y3 = max(y3, y2 + 0.002); y4 = max(y4, y3 + 0.002);
    y3 = min(y3, y4 - 0.002); y2 = min(y2, y3 - 0.002); y1 = min(y1, y2 - 0.002); y0 = min(y0, y1 - 0.002);
    y0 = clamp(y0, 0.0, 1.0); y1 = clamp(y1, 0.0, 1.0); y2 = clamp(y2, 0.0, 1.0); y3 = clamp(y3, 0.0, 1.0); y4 = clamp(y4, 0.0, 1.0);
    let bounded = clamp(value, 0.0, 1.0);
    if (bounded <= 0.18) { return mix(y0, y1, bounded / 0.18); }
    if (bounded <= 0.5) { return mix(y1, y2, (bounded - 0.18) / 0.32); }
    if (bounded <= 0.82) { return mix(y2, y3, (bounded - 0.5) / 0.32); }
    return mix(y3, y4, (bounded - 0.82) / 0.18);
}
fn apply_primary_grade(input_color: vec3<f32>, style: VideoVisualStyle) -> vec3<f32> {
    let exposure = exp2(clamp(style.exposure, -3.0, 3.0));
    let balanced = wb_encoded_709(input_color, vec3<f32>(style.white_balance_red, style.white_balance_green, style.white_balance_blue));
    var channels = vec3<f32>(primary_tone(balanced.r, style), primary_tone(balanced.g, style), primary_tone(balanced.b, style));
    channels = clamp(((channels - vec3<f32>(style.pivot)) * style.contrast + vec3<f32>(style.pivot)) * exposure + vec3<f32>(style.brightness), vec3<f32>(0.0), vec3<f32>(1.0));
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
fn apply_shader_graph(input_color: vec3<f32>, uv: vec2<f32>, style: VideoVisualStyle) -> vec3<f32> {
    var color = input_color;
    for (var index = 0u; index < min(style.shader_op_count, 16u); index += 1u) {
        color = apply_shader_operation(color, uv, style.shader_ops[index]);
    }
    return color;
}
fn blend_color(backdrop: vec3<f32>, source: vec3<f32>, mode: u32) -> vec3<f32> {
    if (mode == 1u) { return min(vec3<f32>(1.0), backdrop + source); }
    if (mode == 2u) { return vec3<f32>(1.0) - (vec3<f32>(1.0) - backdrop) * (vec3<f32>(1.0) - source); }
    if (mode == 3u) { return backdrop * source; }
    if (mode == 4u) { return select(2.0 * backdrop * source, vec3<f32>(1.0) - 2.0 * (vec3<f32>(1.0) - backdrop) * (vec3<f32>(1.0) - source), backdrop > vec3<f32>(0.5)); }
    if (mode == 5u) { return (vec3<f32>(1.0) - 2.0 * source) * backdrop * backdrop + 2.0 * source * backdrop; }
    if (mode == 6u) { return select(2.0 * backdrop * source, vec3<f32>(1.0) - 2.0 * (vec3<f32>(1.0) - backdrop) * (vec3<f32>(1.0) - source), source > vec3<f32>(0.5)); }
    if (mode == 7u) { return abs(backdrop - source); } if (mode == 8u) { return min(backdrop, source); } if (mode == 9u) { return max(backdrop, source); }
    if (mode == 10u) { return min(vec3<f32>(1.0), backdrop / max(vec3<f32>(0.000001), vec3<f32>(1.0) - source)); }
    if (mode == 11u) { return vec3<f32>(1.0) - min(vec3<f32>(1.0), (vec3<f32>(1.0) - backdrop) / max(vec3<f32>(0.000001), source)); }
    return source;
}
fn transformed_uv(input_uv: vec2<f32>, style: VideoVisualStyle) -> vec3<f32> {
    let dimensions = vec2<f32>(style.source_width, style.source_height); let destination = (input_uv - vec2<f32>(0.5)) * dimensions; var local: vec2<f32>;
    if (style.projective_enabled > 0.5) {
        let denominator = style.projective_h6 * destination.x + style.projective_h7 * destination.y + 1.0;
        if (abs(denominator) < 0.000001) { return vec3<f32>(0.0); }
        local = vec2<f32>((style.projective_h0 * destination.x + style.projective_h1 * destination.y + style.projective_h2) / denominator, (style.projective_h3 * destination.x + style.projective_h4 * destination.y + style.projective_h5) / denominator);
    } else {
        let pivot = vec2<f32>(style.transform_pivot_x, style.transform_pivot_y); let translated = destination - vec2<f32>(style.translate_x, style.translate_y) - pivot;
        let cosine = cos(style.rotation); let sine = sin(style.rotation);
        local = vec2<f32>(cosine * translated.x + sine * translated.y, -sine * translated.x + cosine * translated.y) / max(style.scale, 0.0001) + pivot;
    }
    let uv = local / dimensions + vec2<f32>(0.5); let valid = select(0.0, 1.0, uv.x >= 0.0 && uv.y >= 0.0 && uv.x <= 1.0 && uv.y <= 1.0); return vec3<f32>(uv, valid);
}
fn motion_transformed_uv(input_uv: vec2<f32>, style: VideoVisualStyle, sample_index: u32) -> vec3<f32> {
    if (style.projective_enabled > 0.5 || style.motion_sample_count < 2u) { return transformed_uv(input_uv, style); }
    let transform = style.motion_samples[min(sample_index, 7u)];
    let dimensions = vec2<f32>(style.source_width, style.source_height); let destination = (input_uv - vec2<f32>(0.5)) * dimensions;
    let pivot = vec2<f32>(style.transform_pivot_x, style.transform_pivot_y); let translated = destination - transform.xy - pivot;
    let cosine = cos(transform.w); let sine = sin(transform.w);
    let local = vec2<f32>(cosine * translated.x + sine * translated.y, -sine * translated.x + cosine * translated.y) / max(transform.z, 0.0001) + pivot;
    let uv = local / dimensions + vec2<f32>(0.5); let valid = select(0.0, 1.0, uv.x >= 0.0 && uv.y >= 0.0 && uv.x <= 1.0 && uv.y <= 1.0); return vec3<f32>(uv, valid);
}
fn composite(backdrop: vec4<f32>, source_input: vec4<f32>, style: VideoVisualStyle) -> vec4<f32> {
    let source_alpha = clamp(source_input.a * style.opacity * style.composite_opacity, 0.0, 1.0); let output_alpha = source_alpha + backdrop.a * (1.0 - source_alpha);
    if (output_alpha <= 0.000001) { return vec4<f32>(0.0); }
    let mixed = blend_color(backdrop.rgb, source_input.rgb, style.blend_mode);
    let premultiplied = backdrop.rgb * backdrop.a * (1.0 - source_alpha) + source_input.rgb * source_alpha * (1.0 - backdrop.a) + mixed * backdrop.a * source_alpha;
    return vec4<f32>(premultiplied / output_alpha, output_alpha);
}
fn normalize_source_alpha(input: vec4<f32>, style: VideoVisualStyle) -> vec4<f32> {
    if (style.source_alpha_mode == 1u) { return vec4<f32>(input.rgb, 1.0); }
    if (style.source_alpha_mode == 2u) {
        if (input.a <= 0.000001) { return vec4<f32>(0.0); }
        return vec4<f32>(clamp(input.rgb / input.a, vec3<f32>(0.0), vec3<f32>(1.0)), input.a);
    }
    return input;
}
fn styled_source(color_input: vec4<f32>, uv: vec2<f32>, style: VideoVisualStyle) -> vec4<f32> {
    let normalized = normalize_source_alpha(color_input, style);
    var color = vec4<f32>(apply_primary_grade(normalized.rgb, style), normalized.a); let luminance = dot(color.rgb, vec3<f32>(0.2126, 0.7152, 0.0722));
    if (style.effect_kind == 1u) { let stepped = floor(luminance * 8.0 + 0.5) / 8.0; color = vec4<f32>(vec3<f32>(stepped), color.a); }
    else if (style.effect_kind == 2u) { let xerox = smoothstep(0.38, 0.62, luminance); color = vec4<f32>(vec3<f32>(xerox), color.a); }
    color = vec4<f32>(apply_shader_graph(color.rgb, uv, style) * vec3<f32>(style.shade_r, style.shade_g, style.shade_b), color.a);
    return color;
}
fn shutter_source(source: texture_2d<f32>, input_uv: vec2<f32>, style: VideoVisualStyle) -> vec4<f32> {
    let count = select(1u, min(style.motion_sample_count, 8u), style.motion_sample_count >= 2u);
    var premultiplied = vec3<f32>(0.0); var alpha_sum = 0.0;
    for (var index = 0u; index < count; index += 1u) {
        let uv = motion_transformed_uv(input_uv, style, index);
        if (uv.z > 0.5) { let sample = styled_source(textureSample(source, source_sampler, uv.xy), uv.xy, style); premultiplied += sample.rgb * sample.a; alpha_sum += sample.a; }
    }
    let alpha = alpha_sum / f32(count);
    if (alpha_sum <= 0.000001) { return vec4<f32>(0.0); }
    return vec4<f32>(premultiplied / alpha_sum, alpha);
}
fn linear_to_srgb(value: f32) -> f32 {
    let bounded = clamp(value, 0.0, 1.0);
    return select(1.055 * pow(bounded, 1.0 / 2.4) - 0.055, 12.92 * bounded, bounded <= 0.0031308);
}
fn srgb_to_linear(value: f32) -> f32 {
    let bounded = clamp(value, 0.0, 1.0);
    return select(pow((bounded + 0.055) / 1.055, 2.4), bounded / 12.92, bounded <= 0.04045);
}
fn srgb8_intermediate_roundtrip(color: vec4<f32>) -> vec4<f32> {
    if !TARGET_IS_SRGB { return round(clamp(color, vec4<f32>(0.0), vec4<f32>(1.0)) * 255.0) / 255.0; }
    let encoded = vec3<f32>(linear_to_srgb(color.r), linear_to_srgb(color.g), linear_to_srgb(color.b));
    let quantized = round(encoded * 255.0) / 255.0;
    return vec4<f32>(
        srgb_to_linear(quantized.r),
        srgb_to_linear(quantized.g),
        srgb_to_linear(quantized.b),
        round(clamp(color.a, 0.0, 1.0) * 255.0) / 255.0
    );
}
@fragment fn fragment_main(input: VertexOutput) -> @location(0) vec4<f32> {
    var result = textureSample(backdrop_texture, source_sampler, input.uv);
    if (fused.layer_count > 0u) { result = composite(result, shutter_source(source_texture_0, input.uv, style_0), style_0); if (fused.layer_count > 1u) { result = srgb8_intermediate_roundtrip(result); } }
    if (fused.layer_count > 1u) { result = composite(result, shutter_source(source_texture_1, input.uv, style_1), style_1); if (fused.layer_count > 2u) { result = srgb8_intermediate_roundtrip(result); } }
    if (fused.layer_count > 2u) { result = composite(result, shutter_source(source_texture_2, input.uv, style_2), style_2); if (fused.layer_count > 3u) { result = srgb8_intermediate_roundtrip(result); } }
    if (fused.layer_count > 3u) { result = composite(result, shutter_source(source_texture_3, input.uv, style_3), style_3); }
    return result;
}
"#].concat().into(),
        ),
    });
    let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: Some("Editkin fused four-layer common-video pipeline layout"),
        bind_group_layouts: &[Some(&layout)],
        immediate_size: 0,
    });
    let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("Editkin fused four-layer common-video pipeline"),
        layout: Some(&pipeline_layout),
        vertex: wgpu::VertexState {
            module: &shader,
            entry_point: Some("vertex_main"),
            buffers: &[],
            compilation_options: Default::default(),
        },
        fragment: Some(wgpu::FragmentState {
            module: &shader,
            entry_point: Some("fragment_main"),
            targets: &[Some(wgpu::ColorTargetState {
                format,
                blend: None,
                write_mask: wgpu::ColorWrites::ALL,
            })],
            compilation_options: Default::default(),
        }),
        primitive: Default::default(),
        depth_stencil: None,
        multisample: Default::default(),
        multiview_mask: None,
        cache: None,
    });
    (layout, pipeline)
}

unsafe extern "system" fn preview_window_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match message {
        WM_NCHITTEST => LRESULT(HTTRANSPARENT as isize),
        WM_ERASEBKGND => LRESULT(1),
        _ => unsafe { DefWindowProcW(hwnd, message, wparam, lparam) },
    }
}

fn register_preview_window_class() -> Result<HINSTANCE> {
    let module = unsafe { GetModuleHandleW(None) }.context("get compositor module handle")?;
    let instance = HINSTANCE(module.0);
    if PREVIEW_WINDOW_CLASS.get().is_none() {
        let descriptor = WNDCLASSW {
            style: CS_OWNDC,
            lpfnWndProc: Some(preview_window_proc),
            hInstance: instance,
            lpszClassName: windows::core::w!("EditkinNativePreviewSurface"),
            ..Default::default()
        };
        let atom = unsafe { RegisterClassW(&descriptor) };
        if atom == 0 {
            bail!("register native preview surface window class failed");
        }
        PREVIEW_WINDOW_CLASS
            .set(atom)
            .map_err(|_| anyhow!("native preview surface window class raced registration"))?;
    }
    Ok(instance)
}

fn pump_preview_window_messages() {
    let mut message = MSG::default();
    while unsafe { PeekMessageW(&mut message, None, 0, 0, PM_REMOVE) }.as_bool() {
        unsafe {
            let _ = TranslateMessage(&message);
            DispatchMessageW(&message);
        }
    }
}

impl NativePreviewSurface {
    /// Select an explicitly versioned transport once per loaded graph/profile change.
    /// The legacy zero-gain graph keeps its historical sRGB attachment bytes.
    pub(super) fn select_rec709_output_contract(&mut self, compositor: &GpuCompositor, version_two: bool) -> Result<()> {
        if !self.color_space_contract.legacy_video_allowed() {
            if version_two { bail!("Rec.709 v2 byte transport cannot target an HDR surface"); }
            return Ok(());
        }
        let desired = if version_two { NativePreviewColorSpace::SdrRec709V2 } else { NativePreviewColorSpace::SdrAuto };
        if self.color_space_contract != desired {
            let count = self.present_count;
            let replacement = Self::bind(compositor, self.owner.map_or(0, |owner| owner.0 as usize), self.x, self.y, self.width, self.height, desired)?;
            *self = replacement;
            self.present_count = count;
        }
        Ok(())
    }

    pub(super) fn output_pixel_contract(&self) -> &'static str { self.color_space_contract.pixel_contract() }

    fn source_view(&self, texture: &wgpu::Texture) -> wgpu::TextureView {
        let format = if self.color_space_contract == NativePreviewColorSpace::SdrRec709V2 && texture.format().is_srgb() {
            Some(texture.format().remove_srgb_suffix())
        } else { None };
        texture.create_view(&wgpu::TextureViewDescriptor { format, ..Default::default() })
    }

    pub(super) fn bind(
        compositor: &GpuCompositor,
        owner_handle: usize,
        x: i32,
        y: i32,
        width: u32,
        height: u32,
        color_space_contract: NativePreviewColorSpace,
    ) -> Result<Self> {
        if width == 0 || height == 0 || width > 8192 || height > 8192 {
            bail!("native preview surface dimensions must be within 1..=8192");
        }
        let instance = register_preview_window_class()?;
        let owner = NonZeroIsize::new(owner_handle as isize).map(|value| HWND(value.get() as _));
        let (screen_x, screen_y) = screen_position(owner, x, y)?;
        let hwnd = unsafe {
            CreateWindowExW(
                WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW | WS_EX_TRANSPARENT,
                windows::core::w!("EditkinNativePreviewSurface"),
                windows::core::w!("Editkin native GPU preview"),
                WS_POPUP,
                screen_x,
                screen_y,
                width as i32,
                height as i32,
                owner,
                None,
                Some(instance),
                None,
            )
        }
        .context("create native preview surface window")?;
        let raw_window = wgpu::rwh::Win32WindowHandle::new(
            NonZeroIsize::new(hwnd.0 as isize).context("native preview HWND is null")?,
        );
        let surface: wgpu::Surface<'static> = unsafe {
            compositor
                .instance
                .create_surface_unsafe(wgpu::SurfaceTargetUnsafe::RawHandle {
                    raw_display_handle: Some(wgpu::rwh::WindowsDisplayHandle::new().into()),
                    raw_window_handle: raw_window.into(),
                })
        }
        .context("create DX12 native preview swap-chain surface")?;
        let mut configuration = surface
            .get_default_config(&compositor.adapter, width, height)
            .context("DX12 adapter cannot configure the native preview surface")?;
        let capabilities = surface.get_capabilities(&compositor.adapter);
        match color_space_contract {
            NativePreviewColorSpace::SdrAuto => {
                if capabilities
                    .formats
                    .contains(&wgpu::TextureFormat::Bgra8UnormSrgb)
                {
                    configuration.format = wgpu::TextureFormat::Bgra8UnormSrgb;
                }
            }
            NativePreviewColorSpace::SdrRec709V2 => {
                if !capabilities.formats.contains(&wgpu::TextureFormat::Bgra8Unorm) {
                    bail!("v2 Rec.709 transport requires a non-sRGB BGRA8 surface; refusing implicit transfer conversion");
                }
                configuration.format = wgpu::TextureFormat::Bgra8Unorm;
            }
            NativePreviewColorSpace::Bt2100Pq => {
                let format = wgpu::TextureFormat::Rgb10a2Unorm;
                if !capabilities
                    .color_spaces(format)
                    .contains(wgpu::SurfaceColorSpaces::BT2100_PQ)
                {
                    bail!("DX12 adapter does not expose RGB10A2 BT.2100 PQ surface transport");
                }
                configuration.format = format;
                configuration.color_space = wgpu::SurfaceColorSpace::Bt2100Pq;
            }
            NativePreviewColorSpace::ExtendedSrgbLinear => {
                let format = wgpu::TextureFormat::Rgba16Float;
                if !capabilities
                    .color_spaces(format)
                    .contains(wgpu::SurfaceColorSpaces::EXTENDED_SRGB_LINEAR)
                {
                    bail!(
                        "DX12 adapter does not expose RGBA16F extended-linear-sRGB surface transport"
                    );
                }
                configuration.format = format;
                configuration.color_space = wgpu::SurfaceColorSpace::ExtendedSrgbLinear;
            }
        }
        let present_modes = capabilities.present_modes;
        configuration.present_mode = if present_modes.contains(&wgpu::PresentMode::Mailbox) {
            wgpu::PresentMode::Mailbox
        } else if present_modes.contains(&wgpu::PresentMode::Immediate) {
            wgpu::PresentMode::Immediate
        } else {
            wgpu::PresentMode::AutoVsync
        };
        configuration.desired_maximum_frame_latency = 2;
        surface.configure(&compositor.device, &configuration);
        let bind_group_layout =
            compositor
                .device
                .create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                    label: Some("Editkin direct preview surface bindings"),
                    entries: &[
                        wgpu::BindGroupLayoutEntry {
                            binding: 0,
                            visibility: wgpu::ShaderStages::FRAGMENT,
                            ty: wgpu::BindingType::Texture {
                                sample_type: wgpu::TextureSampleType::Float { filterable: true },
                                view_dimension: wgpu::TextureViewDimension::D2,
                                multisampled: false,
                            },
                            count: None,
                        },
                        wgpu::BindGroupLayoutEntry {
                            binding: 3,
                            visibility: wgpu::ShaderStages::FRAGMENT,
                            ty: wgpu::BindingType::Texture {
                                sample_type: wgpu::TextureSampleType::Float { filterable: true },
                                view_dimension: wgpu::TextureViewDimension::D2,
                                multisampled: false,
                            },
                            count: None,
                        },
                        wgpu::BindGroupLayoutEntry {
                            binding: 4,
                            visibility: wgpu::ShaderStages::FRAGMENT,
                            ty: wgpu::BindingType::Texture {
                                sample_type: wgpu::TextureSampleType::Float { filterable: true },
                                view_dimension: wgpu::TextureViewDimension::D2,
                                multisampled: false,
                            },
                            count: None,
                        },
                        wgpu::BindGroupLayoutEntry {
                            binding: 1,
                            visibility: wgpu::ShaderStages::FRAGMENT,
                            ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                            count: None,
                        },
                        wgpu::BindGroupLayoutEntry {
                            binding: 2,
                            visibility: wgpu::ShaderStages::FRAGMENT,
                            ty: wgpu::BindingType::Buffer {
                                ty: wgpu::BufferBindingType::Uniform,
                                has_dynamic_offset: false,
                                min_binding_size: wgpu::BufferSize::new(std::mem::size_of::<
                                    VideoVisualStyle,
                                >(
                                )
                                    as u64),
                            },
                            count: None,
                        },
                        wgpu::BindGroupLayoutEntry {
                            binding: 5,
                            visibility: wgpu::ShaderStages::FRAGMENT,
                            ty: wgpu::BindingType::Buffer {
                                ty: wgpu::BufferBindingType::Uniform,
                                has_dynamic_offset: false,
                                min_binding_size: wgpu::BufferSize::new(std::mem::size_of::<
                                    VideoVisualStyle,
                                >(
                                )
                                    as u64),
                            },
                            count: None,
                        },
                        wgpu::BindGroupLayoutEntry {
                            binding: 6,
                            visibility: wgpu::ShaderStages::FRAGMENT,
                            ty: wgpu::BindingType::Texture {
                                sample_type: wgpu::TextureSampleType::Float { filterable: true },
                                view_dimension: wgpu::TextureViewDimension::D2,
                                multisampled: false,
                            },
                            count: None,
                        },
                        wgpu::BindGroupLayoutEntry {
                            binding: 7,
                            visibility: wgpu::ShaderStages::FRAGMENT,
                            ty: wgpu::BindingType::Texture {
                                sample_type: wgpu::TextureSampleType::Float { filterable: true },
                                view_dimension: wgpu::TextureViewDimension::D2,
                                multisampled: false,
                            },
                            count: None,
                        },
                        wgpu::BindGroupLayoutEntry {
                            binding: 8,
                            visibility: wgpu::ShaderStages::FRAGMENT,
                            ty: wgpu::BindingType::Texture {
                                sample_type: wgpu::TextureSampleType::Float { filterable: true },
                                view_dimension: wgpu::TextureViewDimension::D2,
                                multisampled: false,
                            },
                            count: None,
                        },
                        wgpu::BindGroupLayoutEntry {
                            binding: 9,
                            visibility: wgpu::ShaderStages::FRAGMENT,
                            ty: wgpu::BindingType::Texture {
                                sample_type: wgpu::TextureSampleType::Float { filterable: true },
                                view_dimension: wgpu::TextureViewDimension::D2,
                                multisampled: false,
                            },
                            count: None,
                        },
                        wgpu::BindGroupLayoutEntry {
                            binding: 10,
                            visibility: wgpu::ShaderStages::FRAGMENT,
                            ty: wgpu::BindingType::Texture {
                                sample_type: wgpu::TextureSampleType::Float { filterable: true },
                                view_dimension: wgpu::TextureViewDimension::D2,
                                multisampled: false,
                            },
                            count: None,
                        },
                        wgpu::BindGroupLayoutEntry {
                            binding: 11,
                            visibility: wgpu::ShaderStages::FRAGMENT,
                            ty: wgpu::BindingType::Texture {
                                sample_type: wgpu::TextureSampleType::Float { filterable: true },
                                view_dimension: wgpu::TextureViewDimension::D2,
                                multisampled: false,
                            },
                            count: None,
                        },
                        wgpu::BindGroupLayoutEntry {
                            binding: 12,
                            visibility: wgpu::ShaderStages::FRAGMENT,
                            ty: wgpu::BindingType::Texture {
                                sample_type: wgpu::TextureSampleType::Float { filterable: true },
                                view_dimension: wgpu::TextureViewDimension::D2,
                                multisampled: false,
                            },
                            count: None,
                        },
                    ],
                });
        let shader = compositor
            .device
            .create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some("Editkin direct preview surface shader"),
                source: wgpu::ShaderSource::Wgsl(
                    [include_str!("linear_white_balance.wgsl"), r#"
@group(0) @binding(0) var source_texture_0: texture_2d<f32>;
@group(0) @binding(1) var source_sampler: sampler;
@group(0) @binding(6) var source_texture_1: texture_2d<f32>;
@group(0) @binding(7) var source_texture_2: texture_2d<f32>;
@group(0) @binding(8) var source_texture_3: texture_2d<f32>;
@group(0) @binding(9) var source_texture_4: texture_2d<f32>;
@group(0) @binding(10) var source_texture_5: texture_2d<f32>;
@group(0) @binding(11) var source_texture_6: texture_2d<f32>;
@group(0) @binding(12) var source_texture_7: texture_2d<f32>;

struct VideoVisualStyle {
    translate_x: f32,
    translate_y: f32,
    scale: f32,
    rotation: f32,
    opacity: f32,
    source_width: f32,
    source_height: f32,
    effect_kind: u32,
    brightness: f32,
    contrast: f32,
    saturation: f32,
    hue: f32,
    exposure: f32,
    temperature: f32,
    tint: f32,
    pivot: f32,
    shadows: f32,
    highlights: f32,
    blacks: f32,
    whites: f32,
    white_balance_red: f32,
    white_balance_green: f32,
    white_balance_blue: f32,
    white_balance_pad: f32,
    transform_pivot_x: f32,
    transform_pivot_y: f32,
    transform_pad_x: f32,
    transform_pad_y: f32,
    projective_h0: f32,
    projective_h1: f32,
    projective_h2: f32,
    projective_h3: f32,
    projective_h4: f32,
    projective_h5: f32,
    projective_h6: f32,
    projective_h7: f32,
    projective_enabled: f32,
    shade_r: f32,
    shade_g: f32,
    shade_b: f32,
    blend_mode: u32,
    composite_opacity: f32,
    source_alpha_mode: u32,
    composite_pad_y: f32,
    matte_mode: u32,
    matte_pad_x: f32,
    matte_pad_y: f32,
    matte_pad_z: f32,
    shader_op_count: u32,
    shader_pad_x: u32,
    shader_pad_y: u32,
    shader_pad_z: u32,
    shader_ops: array<vec4<f32>, 16>,
    motion_sample_count: u32,
    motion_contract_code: u32,
    motion_shutter_angle: f32,
    motion_pad_z: f32,
    motion_samples: array<vec4<f32>, 8>,
    motion_sample_frames: array<vec4<f32>, 2>,
};

@group(0) @binding(2) var<uniform> style: VideoVisualStyle;
@group(0) @binding(3) var backdrop_texture: texture_2d<f32>;
@group(0) @binding(4) var matte_texture: texture_2d<f32>;
@group(0) @binding(5) var<uniform> matte_style: VideoVisualStyle;

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

@vertex
fn vertex_main(@builtin(vertex_index) vertex_index: u32) -> VertexOutput {
    var positions = array<vec2<f32>, 3>(
        vec2<f32>(-1.0, -1.0),
        vec2<f32>( 3.0, -1.0),
        vec2<f32>(-1.0,  3.0)
    );
    var uvs = array<vec2<f32>, 3>(
        vec2<f32>(0.0, 1.0),
        vec2<f32>(2.0, 1.0),
        vec2<f32>(0.0, -1.0)
    );
    var output: VertexOutput;
    output.position = vec4<f32>(positions[vertex_index], 0.0, 1.0);
    output.uv = uvs[vertex_index];
    return output;
}

fn primary_tone(value: f32) -> f32 {
    var y0 = clamp(style.blacks * 0.08, 0.0, 0.18);
    var y1 = clamp(0.18 + style.shadows * 0.13, 0.02, 0.42);
    var y2 = clamp(0.5 + (0.5 - style.pivot) * 0.26, 0.24, 0.76);
    var y3 = clamp(0.82 + style.highlights * 0.13, 0.58, 0.98);
    var y4 = clamp(1.0 + style.whites * 0.08, 0.82, 1.0);
    y1 = max(y1, y0 + 0.002);
    y2 = max(y2, y1 + 0.002);
    y3 = max(y3, y2 + 0.002);
    y4 = max(y4, y3 + 0.002);
    y3 = min(y3, y4 - 0.002);
    y2 = min(y2, y3 - 0.002);
    y1 = min(y1, y2 - 0.002);
    y0 = min(y0, y1 - 0.002);
    y0 = clamp(y0, 0.0, 1.0);
    y1 = clamp(y1, 0.0, 1.0);
    y2 = clamp(y2, 0.0, 1.0);
    y3 = clamp(y3, 0.0, 1.0);
    y4 = clamp(y4, 0.0, 1.0);
    let bounded = clamp(value, 0.0, 1.0);
    if (bounded <= 0.18) {
        return mix(y0, y1, bounded / 0.18);
    }
    if (bounded <= 0.5) {
        return mix(y1, y2, (bounded - 0.18) / 0.32);
    }
    if (bounded <= 0.82) {
        return mix(y2, y3, (bounded - 0.5) / 0.32);
    }
    return mix(y3, y4, (bounded - 0.82) / 0.18);
}

fn apply_primary_grade(input_color: vec3<f32>) -> vec3<f32> {
    let exposure = exp2(clamp(style.exposure, -3.0, 3.0));
    let balanced = wb_encoded_709(input_color, vec3<f32>(style.white_balance_red, style.white_balance_green, style.white_balance_blue));
    var channels = vec3<f32>(
        primary_tone(balanced.r),
        primary_tone(balanced.g),
        primary_tone(balanced.b)
    );
    channels = clamp(((channels - vec3<f32>(style.pivot)) * style.contrast + vec3<f32>(style.pivot)) * exposure + vec3<f32>(style.brightness), vec3<f32>(0.0), vec3<f32>(1.0));
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

fn matte_primary_tone(value: f32) -> f32 {
    var y0 = clamp(matte_style.blacks * 0.08, 0.0, 0.18);
    var y1 = clamp(0.18 + matte_style.shadows * 0.13, 0.02, 0.42);
    var y2 = clamp(0.5 + (0.5 - matte_style.pivot) * 0.26, 0.24, 0.76);
    var y3 = clamp(0.82 + matte_style.highlights * 0.13, 0.58, 0.98);
    var y4 = clamp(1.0 + matte_style.whites * 0.08, 0.82, 1.0);
    y1 = max(y1, y0 + 0.002); y2 = max(y2, y1 + 0.002); y3 = max(y3, y2 + 0.002); y4 = max(y4, y3 + 0.002);
    y3 = min(y3, y4 - 0.002); y2 = min(y2, y3 - 0.002); y1 = min(y1, y2 - 0.002); y0 = min(y0, y1 - 0.002);
    let bounded = clamp(value, 0.0, 1.0);
    if (bounded <= 0.18) { return mix(clamp(y0, 0.0, 1.0), clamp(y1, 0.0, 1.0), bounded / 0.18); }
    if (bounded <= 0.5) { return mix(clamp(y1, 0.0, 1.0), clamp(y2, 0.0, 1.0), (bounded - 0.18) / 0.32); }
    if (bounded <= 0.82) { return mix(clamp(y2, 0.0, 1.0), clamp(y3, 0.0, 1.0), (bounded - 0.5) / 0.32); }
    return mix(clamp(y3, 0.0, 1.0), clamp(y4, 0.0, 1.0), (bounded - 0.82) / 0.18);
}

fn styled_matte(input_color: vec4<f32>, uv: vec2<f32>) -> vec4<f32> {
    let normalized = normalize_source_alpha(input_color, matte_style);
    let exposure = exp2(clamp(matte_style.exposure, -3.0, 3.0));
    let balanced = wb_encoded_709(normalized.rgb, vec3<f32>(matte_style.white_balance_red, matte_style.white_balance_green, matte_style.white_balance_blue));
    var channels = vec3<f32>(matte_primary_tone(balanced.r), matte_primary_tone(balanced.g), matte_primary_tone(balanced.b));
    channels = clamp(((channels - vec3<f32>(matte_style.pivot)) * matte_style.contrast + vec3<f32>(matte_style.pivot)) * exposure + vec3<f32>(matte_style.brightness), vec3<f32>(0.0), vec3<f32>(1.0));
    channels.r = clamp(channels.r + matte_style.temperature * 0.055, 0.0, 1.0);
    channels.g = clamp(channels.g + matte_style.tint * 0.045, 0.0, 1.0);
    channels.b = clamp(channels.b - matte_style.temperature * 0.055, 0.0, 1.0);
    let primary_luma = dot(channels, vec3<f32>(0.2126, 0.7152, 0.0722));
    channels = clamp(vec3<f32>(primary_luma) + (channels - vec3<f32>(primary_luma)) * matte_style.saturation, vec3<f32>(0.0), vec3<f32>(1.0));
    var result = vec4<f32>(channels, normalized.a);
    let effect_luma = dot(result.rgb, vec3<f32>(0.2126, 0.7152, 0.0722));
    if (matte_style.effect_kind == 1u) { result = vec4<f32>(vec3<f32>(floor(effect_luma * 8.0 + 0.5) / 8.0), result.a); }
    else if (matte_style.effect_kind == 2u) { result = vec4<f32>(vec3<f32>(smoothstep(0.38, 0.62, effect_luma)), result.a); }
    result = vec4<f32>(apply_shader_graph(result.rgb, uv, matte_style) * vec3<f32>(matte_style.shade_r, matte_style.shade_g, matte_style.shade_b), result.a);
    return result;
}

fn sample_matte_factor(input_uv: vec2<f32>) -> f32 {
    if (style.matte_mode == 0u) { return 1.0; }
    let dimensions = vec2<f32>(matte_style.source_width, matte_style.source_height);
    let destination = (input_uv - vec2<f32>(0.5)) * dimensions;
    var local: vec2<f32>;
    if (matte_style.projective_enabled > 0.5) {
        let denominator = matte_style.projective_h6 * destination.x + matte_style.projective_h7 * destination.y + 1.0;
        if (abs(denominator) < 0.000001) { return select(0.0, 1.0, style.matte_mode == 2u || style.matte_mode == 4u); }
        local = vec2<f32>((matte_style.projective_h0 * destination.x + matte_style.projective_h1 * destination.y + matte_style.projective_h2) / denominator, (matte_style.projective_h3 * destination.x + matte_style.projective_h4 * destination.y + matte_style.projective_h5) / denominator);
    } else {
        let pivot = vec2<f32>(matte_style.transform_pivot_x, matte_style.transform_pivot_y);
        let translated = destination - vec2<f32>(matte_style.translate_x, matte_style.translate_y) - pivot;
        let cosine = cos(matte_style.rotation); let sine = sin(matte_style.rotation);
        local = vec2<f32>(cosine * translated.x + sine * translated.y, -sine * translated.x + cosine * translated.y) / max(matte_style.scale, 0.0001) + pivot;
    }
    let uv = local / dimensions + vec2<f32>(0.5);
    var factor = 0.0;
    if (uv.x >= 0.0 && uv.y >= 0.0 && uv.x <= 1.0 && uv.y <= 1.0) {
        let matte = styled_matte(textureSample(matte_texture, source_sampler, uv), uv);
        let matte_opacity = clamp(matte.a * matte_style.opacity * matte_style.composite_opacity, 0.0, 1.0);
        factor = select(matte_opacity, dot(matte.rgb, vec3<f32>(0.2126, 0.7152, 0.0722)) * matte_opacity, style.matte_mode >= 3u);
    }
    return select(clamp(factor, 0.0, 1.0), 1.0 - clamp(factor, 0.0, 1.0), style.matte_mode == 2u || style.matte_mode == 4u);
}

fn composite(backdrop: vec4<f32>, source_input: vec4<f32>, matte_factor: f32) -> vec4<f32> {
    let source_alpha = clamp(source_input.a * style.opacity * style.composite_opacity * matte_factor, 0.0, 1.0);
    let output_alpha = source_alpha + backdrop.a * (1.0 - source_alpha);
    if (output_alpha <= 0.000001) {
        return vec4<f32>(0.0);
    }
    let mixed = blend_color(backdrop.rgb, source_input.rgb, style.blend_mode);
    let premultiplied =
        backdrop.rgb * backdrop.a * (1.0 - source_alpha) +
        source_input.rgb * source_alpha * (1.0 - backdrop.a) +
        mixed * backdrop.a * source_alpha;
    return vec4<f32>(premultiplied / output_alpha, output_alpha);
}

fn normalize_source_alpha(input: vec4<f32>, selected_style: VideoVisualStyle) -> vec4<f32> {
    if (selected_style.source_alpha_mode == 1u) { return vec4<f32>(input.rgb, 1.0); }
    if (selected_style.source_alpha_mode == 2u) {
        if (input.a <= 0.000001) { return vec4<f32>(0.0); }
        return vec4<f32>(clamp(input.rgb / input.a, vec3<f32>(0.0), vec3<f32>(1.0)), input.a);
    }
    return input;
}

fn transformed_source_uv(input_uv: vec2<f32>, sample_index: u32) -> vec3<f32> {
    let dimensions = vec2<f32>(style.source_width, style.source_height);
    let destination = (input_uv - vec2<f32>(0.5)) * dimensions;
    var local: vec2<f32>;
    if (style.projective_enabled > 0.5) {
        let denominator = style.projective_h6 * destination.x + style.projective_h7 * destination.y + 1.0;
        if (abs(denominator) < 0.000001) { return vec3<f32>(0.0); }
        local = vec2<f32>((style.projective_h0 * destination.x + style.projective_h1 * destination.y + style.projective_h2) / denominator, (style.projective_h3 * destination.x + style.projective_h4 * destination.y + style.projective_h5) / denominator);
    } else {
        var transform = vec4<f32>(style.translate_x, style.translate_y, style.scale, style.rotation);
        if (style.motion_sample_count >= 2u) { transform = style.motion_samples[min(sample_index, 7u)]; }
        let pivot = vec2<f32>(style.transform_pivot_x, style.transform_pivot_y);
        let translated = destination - transform.xy - pivot;
        let cosine = cos(transform.w); let sine = sin(transform.w);
        local = vec2<f32>(cosine * translated.x + sine * translated.y, -sine * translated.x + cosine * translated.y) / max(transform.z, 0.0001) + pivot;
    }
    let uv = local / dimensions + vec2<f32>(0.5);
    let valid = select(0.0, 1.0, uv.x >= 0.0 && uv.y >= 0.0 && uv.x <= 1.0 && uv.y <= 1.0);
    return vec3<f32>(uv, valid);
}

fn styled_source(input_color: vec4<f32>, uv: vec2<f32>) -> vec4<f32> {
    var color = normalize_source_alpha(input_color, style);
    color = vec4<f32>(apply_primary_grade(color.rgb), color.a);
    let luminance = dot(color.rgb, vec3<f32>(0.2126, 0.7152, 0.0722));
    if (style.effect_kind == 1u) { color = vec4<f32>(vec3<f32>(floor(luminance * 8.0 + 0.5) / 8.0), color.a); }
    else if (style.effect_kind == 2u) { color = vec4<f32>(vec3<f32>(smoothstep(0.38, 0.62, luminance)), color.a); }
    return vec4<f32>(apply_shader_graph(color.rgb, uv, style) * vec3<f32>(style.shade_r, style.shade_g, style.shade_b), color.a);
}

fn sampled_source_texture(sample_index: u32, uv: vec2<f32>) -> vec4<f32> {
    if (style.motion_contract_code != 2u || sample_index == 0u) { return textureSample(source_texture_0, source_sampler, uv); }
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
        let uv = transformed_source_uv(input_uv, index);
        if (uv.z > 0.5) { let sample = styled_source(sampled_source_texture(index, uv.xy), uv.xy); premultiplied += sample.rgb * sample.a; alpha_sum += sample.a; }
    }
    let alpha = alpha_sum / f32(count);
    if (alpha_sum <= 0.000001) { return vec4<f32>(0.0); }
    return vec4<f32>(premultiplied / alpha_sum, alpha);
}

@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4<f32> {
    let backdrop = textureSample(backdrop_texture, source_sampler, input.uv);
    return composite(backdrop, shutter_source(input.uv), sample_matte_factor(input.uv));
}
"#].concat().into(),
                ),
            });
        let pipeline_layout =
            compositor
                .device
                .create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                    label: Some("Editkin direct preview surface pipeline layout"),
                    bind_group_layouts: &[Some(&bind_group_layout)],
                    immediate_size: 0,
                });
        let pipeline = compositor
            .device
            .create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some("Editkin direct preview surface pipeline"),
                layout: Some(&pipeline_layout),
                vertex: wgpu::VertexState {
                    module: &shader,
                    entry_point: Some("vertex_main"),
                    buffers: &[],
                    compilation_options: Default::default(),
                },
                fragment: Some(wgpu::FragmentState {
                    module: &shader,
                    entry_point: Some("fragment_main"),
                    targets: &[Some(wgpu::ColorTargetState {
                        format: configuration.format,
                        blend: None,
                        write_mask: wgpu::ColorWrites::ALL,
                    })],
                    compilation_options: Default::default(),
                }),
                primitive: Default::default(),
                depth_stencil: None,
                multisample: Default::default(),
                multiview_mask: None,
                cache: None,
            });
        let (fused_bind_group_layout, fused_pipeline) =
            create_fused_composite_pipeline(&compositor.device, configuration.format);
        let (
            scene_linear_pipeline,
            scene_depth_pipeline,
            scene_linear_display_layout,
            scene_linear_display_pipeline,
            scene_linear_hdr_display_pipeline,
        ) = create_scene_linear_video_pipelines(
            &compositor.device,
            &bind_group_layout,
            configuration.format,
        );
        let (scene_depth_of_field_layout, scene_depth_of_field_pipeline) =
            scene_depth_of_field::create_pipeline(&compositor.device);
        let sampler = compositor.device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("Editkin direct preview surface sampler"),
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });
        let style_buffer = create_visual_style_buffer(
            &compositor.device,
            "Editkin common-video visual style uniform",
        );
        let black_texture = compositor.device.create_texture_with_data(
            &compositor.queue,
            &wgpu::TextureDescriptor {
                label: Some("Editkin opaque black composite backdrop"),
                size: wgpu::Extent3d {
                    width: 1,
                    height: 1,
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: configuration.format,
                usage: wgpu::TextureUsages::TEXTURE_BINDING,
                view_formats: &[],
            },
            wgpu::util::TextureDataOrder::LayerMajor,
            opaque_black_texel(configuration.format),
        );
        let composite_intermediate =
            create_composite_intermediate(&compositor.device, width, height, configuration.format);
        let adjustment_intermediate =
            create_composite_intermediate(&compositor.device, width, height, configuration.format);
        let scene_linear_composite_intermediate = create_composite_intermediate(
            &compositor.device,
            width,
            height,
            wgpu::TextureFormat::Rgba16Float,
        );
        let scene_linear_adjustment_intermediate = create_composite_intermediate(
            &compositor.device,
            width,
            height,
            wgpu::TextureFormat::Rgba16Float,
        );
        let scene_linear_black_texture = compositor.device.create_texture_with_data(
            &compositor.queue,
            &wgpu::TextureDescriptor {
                label: Some("Editkin scene-linear black composite backdrop"),
                size: wgpu::Extent3d {
                    width: 1,
                    height: 1,
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Rgba16Float,
                usage: wgpu::TextureUsages::TEXTURE_BINDING,
                view_formats: &[],
            },
            wgpu::util::TextureDataOrder::LayerMajor,
            opaque_black_texel(wgpu::TextureFormat::Rgba16Float),
        );
        let scene_depth_texture = scene_depth::create_texture(
            &compositor.device,
            width,
            height,
            "Editkin resident 2.5D preview Depth32Float",
        );
        let composite_present_buffer = create_visual_style_buffer(
            &compositor.device,
            "Editkin common-video composite present uniform",
        );
        Ok(Self {
            display_hdr_info: surface.display_hdr_info(&compositor.adapter),
            surface,
            configuration,
            color_space_contract,
            bind_group_layout,
            pipeline,
            fused_bind_group_layout,
            fused_pipeline,
            scene_linear_pipeline,
            scene_depth_pipeline,
            scene_depth_of_field_layout,
            scene_depth_of_field_pipeline,
            scene_linear_display_layout,
            scene_linear_display_pipeline,
            scene_linear_hdr_display_pipeline,
            sampler,
            style_buffer,
            black_texture,
            composite_intermediate,
            adjustment_intermediate,
            scene_linear_composite_intermediate,
            scene_linear_adjustment_intermediate,
            scene_linear_black_texture,
            scene_depth_texture,
            composite_style_buffers: Vec::new(),
            composite_matte_style_buffers: Vec::new(),
            post_adjustment_style_buffers: Vec::new(),
            post_adjustment_matte_style_buffers: Vec::new(),
            adjustment_style_buffers: Vec::new(),
            fused_count_buffers: Vec::new(),
            composite_present_buffer,
            window: OwnedPreviewWindow(hwnd),
            owner,
            x,
            y,
            width,
            height,
            present_count: 0,
            visible: false,
        })
    }

    pub(super) fn reposition(
        &mut self,
        compositor: &GpuCompositor,
        owner_handle: usize,
        x: i32,
        y: i32,
        width: u32,
        height: u32,
        color_space_contract: NativePreviewColorSpace,
    ) -> Result<serde_json::Value> {
        if width == 0 || height == 0 || width > 8192 || height > 8192 {
            bail!("native preview surface dimensions must be within 1..=8192");
        }
        let owner = NonZeroIsize::new(owner_handle as isize).map(|value| HWND(value.get() as _));
        if owner != self.owner {
            bail!("native preview surface owner cannot change without release");
        }
        if color_space_contract != self.color_space_contract
            && !(color_space_contract == NativePreviewColorSpace::SdrAuto && self.color_space_contract == NativePreviewColorSpace::SdrRec709V2) {
            bail!("native preview surface color space cannot change without release");
        }
        let (screen_x, screen_y) = screen_position(owner, x, y)?;
        unsafe {
            SetWindowPos(
                self.window.0,
                Some(HWND_TOP),
                screen_x,
                screen_y,
                width as i32,
                height as i32,
                SWP_NOACTIVATE,
            )
        }
        .context("reposition native preview surface")?;
        if self.width != width || self.height != height {
            self.configuration.width = width;
            self.configuration.height = height;
            self.surface
                .configure(&compositor.device, &self.configuration);
            self.composite_intermediate = create_composite_intermediate(
                &compositor.device,
                width,
                height,
                self.configuration.format,
            );
            self.adjustment_intermediate = create_composite_intermediate(
                &compositor.device,
                width,
                height,
                self.configuration.format,
            );
            self.scene_linear_composite_intermediate = create_composite_intermediate(
                &compositor.device,
                width,
                height,
                wgpu::TextureFormat::Rgba16Float,
            );
            self.scene_linear_adjustment_intermediate = create_composite_intermediate(
                &compositor.device,
                width,
                height,
                wgpu::TextureFormat::Rgba16Float,
            );
            self.scene_depth_texture = scene_depth::create_texture(
                &compositor.device,
                width,
                height,
                "Editkin resident 2.5D preview Depth32Float",
            );
        }
        self.x = x;
        self.y = y;
        self.width = width;
        self.height = height;
        self.display_hdr_info = self.surface.display_hdr_info(&compositor.adapter);
        pump_preview_window_messages();
        Ok(self.description())
    }

    fn ensure_legacy_video_surface(&self) -> Result<()> {
        if !self.color_space_contract.legacy_video_allowed() {
            bail!(
                "legacy decoded-video preview is SDR-only; HDR surfaces require an encoded display-transform pixel path"
            );
        }
        Ok(())
    }

    pub(super) fn hide(&mut self) -> serde_json::Value {
        unsafe {
            let _ = ShowWindow(self.window.0, SW_HIDE);
        }
        self.visible = false;
        pump_preview_window_messages();
        serde_json::json!({ "hidden": true, "presentCount": self.present_count })
    }

    pub(super) fn clear_black(&mut self, compositor: &GpuCompositor) -> Result<serde_json::Value> {
        pump_preview_window_messages();
        let frame = match self.surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(frame)
            | wgpu::CurrentSurfaceTexture::Suboptimal(frame) => frame,
            wgpu::CurrentSurfaceTexture::Outdated => {
                self.surface
                    .configure(&compositor.device, &self.configuration);
                match self.surface.get_current_texture() {
                    wgpu::CurrentSurfaceTexture::Success(frame)
                    | wgpu::CurrentSurfaceTexture::Suboptimal(frame) => frame,
                    status => {
                        bail!("reacquire native preview surface for clear failed: {status:?}")
                    }
                }
            }
            status => bail!("acquire native preview surface for clear failed: {status:?}"),
        };
        let view = frame
            .texture
            .create_view(&wgpu::TextureViewDescriptor::default());
        let mut encoder =
            compositor
                .device
                .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                    label: Some("Editkin inactive common-video surface clear"),
                });
        {
            let _pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("Editkin inactive common-video black frame"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &view,
                    resolve_target: None,
                    depth_slice: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });
        }
        compositor.queue.submit(Some(encoder.finish()));
        compositor.queue.present(frame);
        self.presented();
        Ok(self.description())
    }

    pub(super) fn clear_scene_linear_aces2_black(
        &mut self,
        compositor: &GpuCompositor,
        display_transform: crate::engine_graph::EngineDisplayTransform,
    ) -> Result<serde_json::Value> {
        self.ensure_scene_linear_aces2_surface(display_transform)?;
        let surface = self.clear_black(compositor)?;
        Ok(serde_json::json!({
            "sceneLinearExecution": true,
            "workingColorSpace": "linear_rec709",
            "workingFormat": "rgba16_float",
            "displayTransform": display_transform.processor(),
            "outputSpace": display_transform.output_space(),
            "lutSha256": super::display_lut_sha256(display_transform),
            "lutPayloadSha256": super::display_lut_payload_sha256(display_transform),
            "ocioVersion": "2.5.2",
            "acesVersion": "2.0",
            "configSha256": "eda5b0008a43b72b98ad540e32eb0eb83b340dde54e35bddba64ccbafac1029a",
            "inputTransform": "editkin-srgb-to-linear-rec709-primary/v1",
            "productPathCpuPixelCopies": 0,
            "compositeExecutionMode": "scene-linear-rgba16f-ping-pong/v1",
            "compositeLayerCount": 0,
            "compositeFullFramePassCount": 0,
            "compositeMaximumLayersPerPass": 1,
            "depthExecutionMode": "none",
            "depthFormat": "none",
            "depthTestedLayerCount": 0,
            "depthPassCount": 0,
            "depthOfFieldExecutionMode": "none",
            "depthOfFieldDepthSource": "none",
            "depthOfFieldPassCount": 0,
            "depthOfField": serde_json::Value::Null,
            "effectExecutionMode": "none",
            "shaderOperationCount": 0,
            "builtInEffectCount": 0,
            "temporalExecutionMode": "none",
            "temporalLayerCount": 0,
            "temporalSampleTextureCount": 0,
            "matteExecutionMode": "none",
            "mattePassCount": 0,
            "adjustmentExecutionMode": "none",
            "adjustmentBaseLayerCount": 0,
            "adjustmentPassCount": 0,
            "surface": surface,
        }))
    }

    fn encode_present(
        &mut self,
        compositor: &GpuCompositor,
        source: &wgpu::Texture,
        source_width: u32,
        source_height: u32,
        style: VideoVisualStyle,
        temporal_sources: Option<&[&wgpu::Texture]>,
        encoder: &mut wgpu::CommandEncoder,
    ) -> Result<wgpu::SurfaceTexture> {
        self.ensure_legacy_video_surface()?;
        pump_preview_window_messages();
        let frame = match self.surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(frame)
            | wgpu::CurrentSurfaceTexture::Suboptimal(frame) => frame,
            wgpu::CurrentSurfaceTexture::Outdated => {
                self.surface
                    .configure(&compositor.device, &self.configuration);
                match self.surface.get_current_texture() {
                    wgpu::CurrentSurfaceTexture::Success(frame)
                    | wgpu::CurrentSurfaceTexture::Suboptimal(frame) => frame,
                    status => {
                        bail!("reacquire native preview surface texture failed: {status:?}")
                    }
                }
            }
            status => bail!("acquire native preview surface texture failed: {status:?}"),
        };
        let destination_view = frame
            .texture
            .create_view(&wgpu::TextureViewDescriptor::default());
        self.encode_visual_pass(
            compositor,
            source,
            source_width,
            source_height,
            style,
            temporal_sources,
            &destination_view,
            self.width,
            self.height,
            encoder,
        );
        Ok(frame)
    }

    fn ensure_scene_linear_aces2_surface(
        &self,
        display_transform: crate::engine_graph::EngineDisplayTransform,
    ) -> Result<()> {
        let (expected_color_space, expected_format, label) = match display_transform {
            crate::engine_graph::EngineDisplayTransform::Aces2Rec709Sdr => (
                NativePreviewColorSpace::SdrAuto,
                wgpu::TextureFormat::Bgra8UnormSrgb,
                "Rec.709 SDR",
            ),
            crate::engine_graph::EngineDisplayTransform::Aces2Rec2100Pq1000 => (
                NativePreviewColorSpace::Bt2100Pq,
                wgpu::TextureFormat::Rgb10a2Unorm,
                "Rec.2100 PQ 1000-nit",
            ),
            crate::engine_graph::EngineDisplayTransform::Aces2Rec2100Hlg1000 => bail!(
                "resident ACES2 HLG preview has no direct RGB DX12 swap-chain color space"
            ),
            crate::engine_graph::EngineDisplayTransform::SceneLinearPreview => bail!(
                "scene-linear ACES2 presentation requires an explicit ACES2 display transform"
            ),
        };
        if self.color_space_contract != expected_color_space
            || self.configuration.format != expected_format
        {
            bail!(
                "resident scene-linear ACES2 {label} requires {expected_format:?}/{expected_color_space:?}, got {:?}/{:?}",
                self.configuration.format,
                self.color_space_contract,
            );
        }
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    fn encode_scene_linear_layer(
        &self,
        compositor: &GpuCompositor,
        source: &wgpu::Texture,
        temporal_sources: Option<[&wgpu::Texture; 8]>,
        style_buffer: &wgpu::Buffer,
        matte: Option<VideoSurfaceMatte<'_>>,
        matte_style_buffer: &wgpu::Buffer,
        backdrop: &wgpu::Texture,
        destination: &wgpu::TextureView,
        destination_width: u32,
        destination_height: u32,
        encoder: &mut wgpu::CommandEncoder,
    ) {
        let sources = temporal_sources.unwrap_or([source; 8]);
        let source_views = sources
            .iter()
            .map(|texture| texture.create_view(&wgpu::TextureViewDescriptor::default()))
            .collect::<Vec<_>>();
        let backdrop_view = backdrop.create_view(&wgpu::TextureViewDescriptor::default());
        let matte_view = matte.map_or_else(
            || {
                self.scene_linear_black_texture
                    .create_view(&wgpu::TextureViewDescriptor::default())
            },
            |value| {
                value
                    .source
                    .create_view(&wgpu::TextureViewDescriptor::default())
            },
        );
        let bind_group = compositor
            .device
            .create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("Editkin resident scene-linear layer bindings"),
                layout: &self.bind_group_layout,
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: wgpu::BindingResource::TextureView(&source_views[0]),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: wgpu::BindingResource::Sampler(&self.sampler),
                    },
                    wgpu::BindGroupEntry {
                        binding: 2,
                        resource: style_buffer.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 3,
                        resource: wgpu::BindingResource::TextureView(&backdrop_view),
                    },
                    wgpu::BindGroupEntry {
                        binding: 4,
                        resource: wgpu::BindingResource::TextureView(&matte_view),
                    },
                    wgpu::BindGroupEntry {
                        binding: 5,
                        resource: matte_style_buffer.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 6,
                        resource: wgpu::BindingResource::TextureView(&source_views[1]),
                    },
                    wgpu::BindGroupEntry {
                        binding: 7,
                        resource: wgpu::BindingResource::TextureView(&source_views[2]),
                    },
                    wgpu::BindGroupEntry {
                        binding: 8,
                        resource: wgpu::BindingResource::TextureView(&source_views[3]),
                    },
                    wgpu::BindGroupEntry {
                        binding: 9,
                        resource: wgpu::BindingResource::TextureView(&source_views[4]),
                    },
                    wgpu::BindGroupEntry {
                        binding: 10,
                        resource: wgpu::BindingResource::TextureView(&source_views[5]),
                    },
                    wgpu::BindGroupEntry {
                        binding: 11,
                        resource: wgpu::BindingResource::TextureView(&source_views[6]),
                    },
                    wgpu::BindGroupEntry {
                        binding: 12,
                        resource: wgpu::BindingResource::TextureView(&source_views[7]),
                    },
                ],
            });
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("Editkin resident scene-linear layer pass"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: destination,
                resolve_target: None,
                depth_slice: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                    store: wgpu::StoreOp::Store,
                },
            })],
            depth_stencil_attachment: None,
            timestamp_writes: None,
            occlusion_query_set: None,
            multiview_mask: None,
        });
        pass.set_pipeline(&self.scene_linear_pipeline);
        pass.set_bind_group(0, &bind_group, &[]);
        pass.set_viewport(
            0.0,
            0.0,
            destination_width as f32,
            destination_height as f32,
            0.0,
            1.0,
        );
        pass.draw(0..3, 0..1);
    }

    fn encode_scene_linear_aces2_display(
        &self,
        compositor: &GpuCompositor,
        display_transform: crate::engine_graph::EngineDisplayTransform,
        source: &wgpu::Texture,
        destination: &wgpu::TextureView,
        width: u32,
        height: u32,
        encoder: &mut wgpu::CommandEncoder,
    ) -> Result<()> {
        let (pipeline, lut_buffer) = match display_transform {
            crate::engine_graph::EngineDisplayTransform::Aces2Rec709Sdr => (
                &self.scene_linear_display_pipeline,
                &compositor.aces2_rec709_sdr_lut_buffer,
            ),
            crate::engine_graph::EngineDisplayTransform::Aces2Rec2100Pq1000 => (
                &self.scene_linear_hdr_display_pipeline,
                compositor
                    .aces2_rec2100_pq_1000_lut_buffer
                    .as_ref()
                    .context("resident video compositor is missing the ACES2 Rec.2100 PQ LUT")?,
            ),
            crate::engine_graph::EngineDisplayTransform::Aces2Rec2100Hlg1000 => bail!(
                "resident ACES2 HLG preview has no direct RGB DX12 swap-chain color space"
            ),
            crate::engine_graph::EngineDisplayTransform::SceneLinearPreview => bail!(
                "scene-linear ACES2 display pass requires an ACES2 display transform"
            ),
        };
        let source_view = source.create_view(&wgpu::TextureViewDescriptor::default());
        let bind_group = compositor
            .device
            .create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("Editkin resident scene-linear ACES2 display bindings"),
                layout: &self.scene_linear_display_layout,
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: wgpu::BindingResource::TextureView(&source_view),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: wgpu::BindingResource::Sampler(&self.sampler),
                    },
                    wgpu::BindGroupEntry {
                        binding: 2,
                        resource: lut_buffer.as_entire_binding(),
                    },
                ],
            });
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("Editkin resident scene-linear ACES2 display pass"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: destination,
                resolve_target: None,
                depth_slice: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
                    store: wgpu::StoreOp::Store,
                },
            })],
            depth_stencil_attachment: None,
            timestamp_writes: None,
            occlusion_query_set: None,
            multiview_mask: None,
        });
        pass.set_pipeline(pipeline);
        pass.set_bind_group(0, &bind_group, &[]);
        pass.set_viewport(0.0, 0.0, width as f32, height as f32, 0.0, 1.0);
        pass.draw(0..3, 0..1);
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    fn encode_scene_linear_aces2_graph(
        &self,
        compositor: &GpuCompositor,
        display_transform: crate::engine_graph::EngineDisplayTransform,
        layers: &[VideoSurfaceLayer<'_>],
        adjustments: &[VideoVisualStyle],
        adjustment_base_layer_count: Option<usize>,
        depth_of_field: Option<&crate::engine_graph::EngineVideoDepthOfFieldPlan>,
        composite_intermediate: &[wgpu::Texture; 2],
        adjustment_intermediate: &[wgpu::Texture; 2],
        depth_texture: &wgpu::Texture,
        destination: &wgpu::TextureView,
        width: u32,
        height: u32,
        encoder: &mut wgpu::CommandEncoder,
    ) -> Result<(bool, bool)> {
        if layers.is_empty() {
            bail!("resident scene-linear ACES2 graph requires at least one layer");
        }
        if layers.iter().any(|layer| {
            let decoded_temporal = layer.temporal_sources.is_some();
            decoded_temporal != (layer.style.motion_contract_code == 2)
                || (decoded_temporal && !(2..=8).contains(&layer.style.motion_sample_count))
        }) {
            bail!(
                "resident scene-linear ACES2 decoded-temporal bindings do not match the motion contract"
            );
        }
        let base_layer_count = adjustment_base_layer_count.unwrap_or(layers.len());
        if base_layer_count == 0 || base_layer_count > layers.len() {
            bail!("resident scene-linear ACES2 graph has an invalid adjustment split");
        }
        let layer_buffers = layers
            .iter()
            .map(|layer| {
                compositor
                    .device
                    .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                        label: Some("Editkin resident scene-linear layer uniform"),
                        contents: bytemuck::bytes_of(&layer.style),
                        usage: wgpu::BufferUsages::UNIFORM,
                    })
            })
            .collect::<Vec<_>>();
        let adjustment_buffers = adjustments
            .iter()
            .map(|style| {
                let style = style.with_source_dimensions(width, height);
                compositor
                    .device
                    .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                        label: Some("Editkin resident scene-linear adjustment uniform"),
                        contents: bytemuck::bytes_of(&style),
                        usage: wgpu::BufferUsages::UNIFORM,
                    })
            })
            .collect::<Vec<_>>();
        let matte_buffers = layers
            .iter()
            .map(|layer| {
                let style = layer.matte.map(|matte| matte.style).unwrap_or_default();
                compositor
                    .device
                    .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                        label: Some("Editkin resident scene-linear matte uniform"),
                        contents: bytemuck::bytes_of(&style),
                        usage: wgpu::BufferUsages::UNIFORM,
                    })
            })
            .collect::<Vec<_>>();
        if scene_depth::validate_contract(layers, adjustments, adjustment_base_layer_count)? {
            let linear_destination =
                composite_intermediate[0].create_view(&wgpu::TextureViewDescriptor::default());
            scene_depth::encode(
                compositor,
                &self.scene_depth_pipeline,
                &self.bind_group_layout,
                &self.sampler,
                &self.scene_linear_black_texture,
                layers,
                &layer_buffers,
                &linear_destination,
                depth_texture,
                width,
                height,
                encoder,
            );
            let display_source = if let Some(plan) = depth_of_field {
                if plan.execution_mode != scene_depth_of_field::EXECUTION_MODE
                    || plan.depth_source != "depth32_float"
                    || plan.executor != "wgpu-depth-aware-gather/v1"
                    || plan.pass_count != 1
                {
                    bail!(
                        "resident depth-of-field execution receipt does not match its native lens plan"
                    );
                }
                let lens_destination =
                    composite_intermediate[1].create_view(&wgpu::TextureViewDescriptor::default());
                scene_depth_of_field::encode(
                    compositor,
                    &self.scene_depth_of_field_layout,
                    &self.scene_depth_of_field_pipeline,
                    &self.sampler,
                    &composite_intermediate[0],
                    depth_texture,
                    &lens_destination,
                    plan,
                    width,
                    height,
                    encoder,
                );
                &composite_intermediate[1]
            } else {
                &composite_intermediate[0]
            };
            self.encode_scene_linear_aces2_display(
                compositor,
                display_transform,
                display_source,
                destination,
                width,
                height,
                encoder,
            )?;
            return Ok((true, depth_of_field.is_some()));
        }
        if depth_of_field.is_some() {
            bail!(
                "resident depth-of-field cannot execute without the exact Depth32Float plane contract"
            );
        }
        for index in 0..base_layer_count {
            let backdrop = if index == 0 {
                &self.scene_linear_black_texture
            } else {
                &composite_intermediate[(index - 1) % 2]
            };
            let destination_view = composite_intermediate[index % 2]
                .create_view(&wgpu::TextureViewDescriptor::default());
            self.encode_scene_linear_layer(
                compositor,
                layers[index].source,
                layers[index].temporal_sources,
                &layer_buffers[index],
                layers[index].matte,
                &matte_buffers[index],
                backdrop,
                &destination_view,
                width,
                height,
                encoder,
            );
        }
        let base = &composite_intermediate[(base_layer_count - 1) % 2];
        for (index, buffer) in adjustment_buffers.iter().enumerate() {
            let source = if index == 0 {
                base
            } else {
                &adjustment_intermediate[(index - 1) % 2]
            };
            let destination_view = adjustment_intermediate[index % 2]
                .create_view(&wgpu::TextureViewDescriptor::default());
            self.encode_scene_linear_layer(
                compositor,
                source,
                None,
                buffer,
                None,
                buffer,
                &self.scene_linear_black_texture,
                &destination_view,
                width,
                height,
                encoder,
            );
        }
        let adjusted = if adjustments.is_empty() {
            base
        } else {
            &adjustment_intermediate[(adjustments.len() - 1) % 2]
        };
        let final_linear = if base_layer_count < layers.len() {
            for (post_index, layer_index) in (base_layer_count..layers.len()).enumerate() {
                let backdrop = if post_index == 0 {
                    adjusted
                } else {
                    &composite_intermediate[(post_index - 1) % 2]
                };
                let destination_view = composite_intermediate[post_index % 2]
                    .create_view(&wgpu::TextureViewDescriptor::default());
                self.encode_scene_linear_layer(
                    compositor,
                    layers[layer_index].source,
                    layers[layer_index].temporal_sources,
                    &layer_buffers[layer_index],
                    layers[layer_index].matte,
                    &matte_buffers[layer_index],
                    backdrop,
                    &destination_view,
                    width,
                    height,
                    encoder,
                );
            }
            &composite_intermediate[(layers.len() - base_layer_count - 1) % 2]
        } else {
            adjusted
        };
        self.encode_scene_linear_aces2_display(
            compositor,
            display_transform,
            final_linear,
            destination,
            width,
            height,
            encoder,
        )?;
        Ok((false, false))
    }

    pub(super) fn present_scene_linear_aces2_layers(
        &mut self,
        compositor: &GpuCompositor,
        display_transform: crate::engine_graph::EngineDisplayTransform,
        layers: &[VideoSurfaceLayer<'_>],
        adjustments: &[VideoVisualStyle],
        adjustment_base_layer_count: Option<usize>,
        depth_of_field: Option<&crate::engine_graph::EngineVideoDepthOfFieldPlan>,
    ) -> Result<serde_json::Value> {
        self.ensure_scene_linear_aces2_surface(display_transform)?;
        pump_preview_window_messages();
        let frame = match self.surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(frame)
            | wgpu::CurrentSurfaceTexture::Suboptimal(frame) => frame,
            wgpu::CurrentSurfaceTexture::Outdated => {
                self.surface
                    .configure(&compositor.device, &self.configuration);
                match self.surface.get_current_texture() {
                    wgpu::CurrentSurfaceTexture::Success(frame)
                    | wgpu::CurrentSurfaceTexture::Suboptimal(frame) => frame,
                    status => {
                        bail!("reacquire scene-linear ACES2 preview surface failed: {status:?}")
                    }
                }
            }
            status => bail!("acquire scene-linear ACES2 preview surface failed: {status:?}"),
        };
        let destination = frame
            .texture
            .create_view(&wgpu::TextureViewDescriptor::default());
        let mut encoder =
            compositor
                .device
                .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                    label: Some("Editkin resident scene-linear ACES2 present"),
                });
        let (depth_executed, depth_of_field_executed) = self.encode_scene_linear_aces2_graph(
            compositor,
            display_transform,
            layers,
            adjustments,
            adjustment_base_layer_count,
            depth_of_field,
            &self.scene_linear_composite_intermediate,
            &self.scene_linear_adjustment_intermediate,
            &self.scene_depth_texture,
            &destination,
            self.width,
            self.height,
            &mut encoder,
        )?;
        compositor.queue.submit([encoder.finish()]);
        compositor.queue.present(frame);
        self.presented();
        let matte_count = layers.iter().filter(|layer| layer.matte.is_some()).count();
        let shader_operation_count = layers
            .iter()
            .map(|layer| layer.style.shader_op_count as usize)
            .sum::<usize>()
            + adjustments
                .iter()
                .map(|style| style.shader_op_count as usize)
                .sum::<usize>();
        let built_in_effect_count = layers
            .iter()
            .filter(|layer| layer.style.effect_kind != 0)
            .count()
            + adjustments
                .iter()
                .filter(|style| style.effect_kind != 0)
                .count();
        let temporal_layer_count = layers
            .iter()
            .filter(|layer| layer.temporal_sources.is_some())
            .count();
        let temporal_sample_texture_count = layers
            .iter()
            .filter(|layer| layer.temporal_sources.is_some())
            .map(|layer| layer.style.motion_sample_count as usize)
            .sum::<usize>();
        Ok(serde_json::json!({
            "sceneLinearExecution": true,
            "workingColorSpace": "linear_rec709",
            "workingFormat": "rgba16_float",
            "displayTransform": display_transform.processor(),
            "outputSpace": display_transform.output_space(),
            "lutSha256": super::display_lut_sha256(display_transform),
            "lutPayloadSha256": super::display_lut_payload_sha256(display_transform),
            "ocioVersion": "2.5.2",
            "acesVersion": "2.0",
            "configSha256": "eda5b0008a43b72b98ad540e32eb0eb83b340dde54e35bddba64ccbafac1029a",
            "inputTransform": scene_linear_input_transform(layers),
            "productPathCpuPixelCopies": 0,
            "compositeExecutionMode": if depth_of_field_executed { scene_depth_of_field::EXECUTION_MODE } else if depth_executed { scene_depth::EXECUTION_MODE } else { "scene-linear-rgba16f-ping-pong/v1" },
            "compositeLayerCount": layers.len(),
            "compositeFullFramePassCount": if depth_executed { 2 + usize::from(depth_of_field_executed) } else { layers.len() + adjustments.len() + 1 },
            "compositeMaximumLayersPerPass": if depth_executed { layers.len() } else { 1 },
            "depthExecutionMode": if depth_executed { scene_depth::EXECUTION_MODE } else { "none" },
            "depthFormat": if depth_executed { "depth32_float" } else { "none" },
            "depthTestedLayerCount": if depth_executed { layers.len() } else { 0 },
            "depthPassCount": usize::from(depth_executed),
            "depthOfFieldExecutionMode": if depth_of_field_executed { scene_depth_of_field::EXECUTION_MODE } else { "none" },
            "depthOfFieldDepthSource": if depth_of_field_executed { "depth32_float" } else { "none" },
            "depthOfFieldPassCount": usize::from(depth_of_field_executed),
            "depthOfField": if depth_of_field_executed { serde_json::to_value(depth_of_field)? } else { serde_json::Value::Null },
            "effectExecutionMode": if shader_operation_count + built_in_effect_count == 0 { "none" } else { "scene-linear-bounded-effect-stack/v1" },
            "shaderOperationCount": shader_operation_count,
            "builtInEffectCount": built_in_effect_count,
            "temporalExecutionMode": if temporal_layer_count == 0 { "none" } else { "decoded-temporal-shutter-scene-linear/v1" },
            "temporalLayerCount": temporal_layer_count,
            "temporalSampleTextureCount": temporal_sample_texture_count,
            "matteExecutionMode": if matte_count == 0 { "none" } else { "sampled-track-matte-scene-linear/v1" },
            "mattePassCount": matte_count,
            "adjustmentExecutionMode": if adjustments.is_empty() { "none" } else if adjustment_base_layer_count.is_some() { "pre-typography-scene-linear/v1" } else { "trailing-scene-linear/v1" },
            "adjustmentBaseLayerCount": adjustment_base_layer_count.unwrap_or(layers.len()),
            "adjustmentPassCount": adjustments.len(),
            "surface": self.description(),
        }))
    }

    pub(super) fn verify_scene_linear_aces2_layers(
        &self,
        compositor: &GpuCompositor,
        display_transform: crate::engine_graph::EngineDisplayTransform,
        layers: &[VideoSurfaceLayer<'_>],
        adjustments: &[VideoVisualStyle],
        adjustment_base_layer_count: Option<usize>,
        depth_of_field: Option<&crate::engine_graph::EngineVideoDepthOfFieldPlan>,
        width: u32,
        height: u32,
        output_path: &Path,
    ) -> Result<serde_json::Value> {
        self.ensure_scene_linear_aces2_surface(display_transform)?;
        let target = compositor.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Editkin isolated scene-linear ACES2 verification target"),
            size: wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: self.configuration.format,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let destination = target.create_view(&wgpu::TextureViewDescriptor::default());
        let composite_intermediate = create_composite_intermediate(
            &compositor.device,
            width,
            height,
            wgpu::TextureFormat::Rgba16Float,
        );
        let adjustment_intermediate = create_composite_intermediate(
            &compositor.device,
            width,
            height,
            wgpu::TextureFormat::Rgba16Float,
        );
        let depth_texture = scene_depth::create_texture(
            &compositor.device,
            width,
            height,
            "Editkin isolated 2.5D verification Depth32Float",
        );
        let mut encoder =
            compositor
                .device
                .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                    label: Some("Editkin isolated scene-linear ACES2 verification"),
                });
        let (depth_executed, depth_of_field_executed) = self.encode_scene_linear_aces2_graph(
            compositor,
            display_transform,
            layers,
            adjustments,
            adjustment_base_layer_count,
            depth_of_field,
            &composite_intermediate,
            &adjustment_intermediate,
            &depth_texture,
            &destination,
            width,
            height,
            &mut encoder,
        )?;
        compositor.queue.submit([encoder.finish()]);
        let (output_hash, rgba) = consume_surface_with_wgpu(
            compositor,
            &target,
            self.configuration.format,
            width,
            height,
        )?;
        super::save_rgba(output_path, rgba, width, height)?;
        let matte_count = layers.iter().filter(|layer| layer.matte.is_some()).count();
        let shader_operation_count = layers
            .iter()
            .map(|layer| layer.style.shader_op_count as usize)
            .sum::<usize>()
            + adjustments
                .iter()
                .map(|style| style.shader_op_count as usize)
                .sum::<usize>();
        let built_in_effect_count = layers
            .iter()
            .filter(|layer| layer.style.effect_kind != 0)
            .count()
            + adjustments
                .iter()
                .filter(|style| style.effect_kind != 0)
                .count();
        let temporal_layer_count = layers
            .iter()
            .filter(|layer| layer.temporal_sources.is_some())
            .count();
        let temporal_sample_texture_count = layers
            .iter()
            .filter(|layer| layer.temporal_sources.is_some())
            .map(|layer| layer.style.motion_sample_count as usize)
            .sum::<usize>();
        Ok(serde_json::json!({
            "verificationReadback": true,
            "productPathCpuPixelCopies": 0,
            "outputWritten": true,
            "outputHash": output_hash,
            "sceneLinearExecution": true,
            "workingColorSpace": "linear_rec709",
            "workingFormat": "rgba16_float",
            "displayTransform": display_transform.processor(),
            "outputSpace": display_transform.output_space(),
            "lutSha256": super::display_lut_sha256(display_transform),
            "lutPayloadSha256": super::display_lut_payload_sha256(display_transform),
            "ocioVersion": "2.5.2",
            "acesVersion": "2.0",
            "configSha256": "eda5b0008a43b72b98ad540e32eb0eb83b340dde54e35bddba64ccbafac1029a",
            "inputTransform": scene_linear_input_transform(layers),
            "compositeExecutionMode": if depth_of_field_executed { scene_depth_of_field::EXECUTION_MODE } else if depth_executed { scene_depth::EXECUTION_MODE } else { "scene-linear-rgba16f-ping-pong/v1" },
            "compositeLayerCount": layers.len(),
            "compositeFullFramePassCount": if depth_executed { 2 + usize::from(depth_of_field_executed) } else { layers.len() + adjustments.len() + 1 },
            "compositeMaximumLayersPerPass": if depth_executed { layers.len() } else { 1 },
            "depthExecutionMode": if depth_executed { scene_depth::EXECUTION_MODE } else { "none" },
            "depthFormat": if depth_executed { "depth32_float" } else { "none" },
            "depthTestedLayerCount": if depth_executed { layers.len() } else { 0 },
            "depthPassCount": usize::from(depth_executed),
            "depthOfFieldExecutionMode": if depth_of_field_executed { scene_depth_of_field::EXECUTION_MODE } else { "none" },
            "depthOfFieldDepthSource": if depth_of_field_executed { "depth32_float" } else { "none" },
            "depthOfFieldPassCount": usize::from(depth_of_field_executed),
            "depthOfField": if depth_of_field_executed { serde_json::to_value(depth_of_field)? } else { serde_json::Value::Null },
            "adjustmentExecutionMode": if adjustments.is_empty() { "none" } else if adjustment_base_layer_count.is_some() { "pre-typography-scene-linear/v1" } else { "trailing-scene-linear/v1" },
            "adjustmentBaseLayerCount": adjustment_base_layer_count.unwrap_or(layers.len()),
            "adjustmentPassCount": adjustments.len(),
            "effectExecutionMode": if shader_operation_count + built_in_effect_count == 0 { "none" } else { "scene-linear-bounded-effect-stack/v1" },
            "shaderOperationCount": shader_operation_count,
            "builtInEffectCount": built_in_effect_count,
            "temporalExecutionMode": if temporal_layer_count == 0 { "none" } else { "decoded-temporal-shutter-scene-linear/v1" },
            "temporalLayerCount": temporal_layer_count,
            "temporalSampleTextureCount": temporal_sample_texture_count,
            "matteExecutionMode": if matte_count == 0 { "none" } else { "sampled-track-matte-scene-linear/v1" },
            "mattePassCount": matte_count,
            "visualLayers": layers.iter().map(|layer| layer.style).collect::<Vec<_>>(),
        }))
    }

    pub(super) fn present_layers_with_adjustments(
        &mut self,
        compositor: &GpuCompositor,
        layers: &[VideoSurfaceLayer<'_>],
        adjustments: &[VideoVisualStyle],
        adjustment_base_layer_count: Option<usize>,
    ) -> Result<serde_json::Value> {
        self.ensure_legacy_video_surface()?;
        if layers.is_empty() {
            bail!("native common-video composite requires at least one staged video/overlay layer");
        }
        if let Some(base_layer_count) = adjustment_base_layer_count {
            if !(1..=2).contains(&adjustments.len())
                || base_layer_count == 0
                || base_layer_count > layers.len()
            {
                bail!(
                    "pre-typography adjustment requires one or two active adjustments and a valid base-layer split"
                );
            }
        }
        self.ensure_composite_style_buffers(compositor, layers.len());
        self.ensure_composite_matte_style_buffers(compositor, layers.len());
        self.ensure_adjustment_style_buffers(compositor, adjustments.len());
        let post_layer_count = adjustment_base_layer_count
            .map(|base_layer_count| 1 + layers.len() - base_layer_count)
            .unwrap_or(0);
        self.ensure_post_adjustment_style_buffers(compositor, post_layer_count);
        self.ensure_post_adjustment_matte_style_buffers(compositor, post_layer_count);
        let fused = adjustment_base_layer_count.is_none()
            && Self::can_fuse_layers(layers, self.width, self.height);
        let matte_count = layers.iter().filter(|layer| layer.matte.is_some()).count();
        let fused_pass_count = layers.len().div_ceil(FUSED_LAYER_WIDTH);
        if fused {
            self.ensure_fused_count_buffers(compositor, fused_pass_count);
        }
        for (layer, buffer) in layers.iter().zip(&self.composite_style_buffers) {
            compositor
                .queue
                .write_buffer(buffer, 0, bytemuck::bytes_of(&layer.style));
        }
        for (layer, buffer) in layers.iter().zip(&self.composite_matte_style_buffers) {
            let style = layer.matte.map(|matte| matte.style).unwrap_or_default();
            compositor
                .queue
                .write_buffer(buffer, 0, bytemuck::bytes_of(&style));
        }
        for (style, buffer) in adjustments.iter().zip(&self.adjustment_style_buffers) {
            let style = style.with_source_dimensions(self.width, self.height);
            compositor
                .queue
                .write_buffer(buffer, 0, bytemuck::bytes_of(&style));
        }
        if let Some(base_layer_count) = adjustment_base_layer_count {
            let adjusted_base_style =
                VideoVisualStyle::default().with_source_dimensions(self.width, self.height);
            compositor.queue.write_buffer(
                &self.post_adjustment_style_buffers[0],
                0,
                bytemuck::bytes_of(&adjusted_base_style),
            );
            compositor.queue.write_buffer(
                &self.post_adjustment_matte_style_buffers[0],
                0,
                bytemuck::bytes_of(&VideoVisualStyle::default()),
            );
            for (post_index, layer) in layers[base_layer_count..].iter().enumerate() {
                compositor.queue.write_buffer(
                    &self.post_adjustment_style_buffers[post_index + 1],
                    0,
                    bytemuck::bytes_of(&layer.style),
                );
                let matte_style = layer.matte.map(|matte| matte.style).unwrap_or_default();
                compositor.queue.write_buffer(
                    &self.post_adjustment_matte_style_buffers[post_index + 1],
                    0,
                    bytemuck::bytes_of(&matte_style),
                );
            }
        }
        if fused {
            for (chunk_index, chunk) in layers.chunks(FUSED_LAYER_WIDTH).enumerate() {
                compositor.queue.write_buffer(
                    &self.fused_count_buffers[chunk_index],
                    0,
                    bytemuck::bytes_of(&FusedLayerCount {
                        layer_count: chunk.len() as u32,
                        padding: [0; 3],
                    }),
                );
            }
        }
        let present_style =
            VideoVisualStyle::default().with_source_dimensions(self.width, self.height);
        compositor.queue.write_buffer(
            &self.composite_present_buffer,
            0,
            bytemuck::bytes_of(&present_style),
        );
        pump_preview_window_messages();
        let frame = match self.surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(frame)
            | wgpu::CurrentSurfaceTexture::Suboptimal(frame) => frame,
            wgpu::CurrentSurfaceTexture::Outdated => {
                self.surface
                    .configure(&compositor.device, &self.configuration);
                match self.surface.get_current_texture() {
                    wgpu::CurrentSurfaceTexture::Success(frame)
                    | wgpu::CurrentSurfaceTexture::Suboptimal(frame) => frame,
                    status => bail!(
                        "reacquire native preview surface texture for composite failed: {status:?}"
                    ),
                }
            }
            status => {
                bail!("acquire native preview surface texture for composite failed: {status:?}")
            }
        };
        let destination_view = frame
            .texture
            .create_view(&wgpu::TextureViewDescriptor::default());
        let mut encoder =
            compositor
                .device
                .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                    label: Some("Editkin common-video composite present"),
                });
        let mut dirty_rect_layer_count = 0_usize;
        if let Some(base_layer_count) = adjustment_base_layer_count {
            let base_destination = self.adjustment_intermediate[0]
                .create_view(&wgpu::TextureViewDescriptor::default());
            dirty_rect_layer_count += self.encode_visual_layers_with_resources(
                compositor,
                &layers[..base_layer_count],
                &self.composite_style_buffers[..base_layer_count],
                &self.composite_matte_style_buffers[..base_layer_count],
                &self.composite_intermediate,
                &self.composite_present_buffer,
                &base_destination,
                self.width,
                self.height,
                &mut encoder,
            );
            if base_layer_count < layers.len() {
                let adjusted_texture_index = adjustments.len() % 2;
                let adjusted_destination = self.adjustment_intermediate[adjusted_texture_index]
                    .create_view(&wgpu::TextureViewDescriptor::default());
                self.encode_adjustment_passes_with_resources(
                    compositor,
                    adjustments,
                    &self.adjustment_style_buffers,
                    &self.adjustment_intermediate,
                    &adjusted_destination,
                    self.width,
                    self.height,
                    &mut encoder,
                );
                let adjusted_base = VideoSurfaceLayer {
                    source: &self.adjustment_intermediate[adjusted_texture_index],
                    temporal_sources: None,
                    source_width: self.width,
                    source_height: self.height,
                    style: VideoVisualStyle::default()
                        .with_source_dimensions(self.width, self.height),
                    matte: None,
                };
                let post_layers = std::iter::once(adjusted_base)
                    .chain(layers[base_layer_count..].iter().copied())
                    .collect::<Vec<_>>();
                dirty_rect_layer_count += self.encode_visual_layers_with_resources(
                    compositor,
                    &post_layers,
                    &self.post_adjustment_style_buffers[..post_layers.len()],
                    &self.post_adjustment_matte_style_buffers[..post_layers.len()],
                    &self.composite_intermediate,
                    &self.composite_present_buffer,
                    &destination_view,
                    self.width,
                    self.height,
                    &mut encoder,
                );
            } else {
                self.encode_adjustment_passes_with_resources(
                    compositor,
                    adjustments,
                    &self.adjustment_style_buffers,
                    &self.adjustment_intermediate,
                    &destination_view,
                    self.width,
                    self.height,
                    &mut encoder,
                );
            }
        } else {
            let adjustment_content_view = (!adjustments.is_empty()).then(|| {
                self.adjustment_intermediate[0].create_view(&wgpu::TextureViewDescriptor::default())
            });
            let content_destination = adjustment_content_view
                .as_ref()
                .unwrap_or(&destination_view);
            dirty_rect_layer_count = if fused {
                self.encode_fused_layers_with_resources(
                    compositor,
                    layers,
                    &self.composite_style_buffers,
                    &self.fused_count_buffers,
                    &self.composite_intermediate,
                    content_destination,
                    self.width,
                    self.height,
                    &mut encoder,
                );
                0
            } else {
                self.encode_visual_layers_with_resources(
                    compositor,
                    layers,
                    &self.composite_style_buffers,
                    &self.composite_matte_style_buffers,
                    &self.composite_intermediate,
                    &self.composite_present_buffer,
                    content_destination,
                    self.width,
                    self.height,
                    &mut encoder,
                )
            };
            if !adjustments.is_empty() {
                self.encode_adjustment_passes_with_resources(
                    compositor,
                    adjustments,
                    &self.adjustment_style_buffers,
                    &self.adjustment_intermediate,
                    &destination_view,
                    self.width,
                    self.height,
                    &mut encoder,
                );
            }
        }
        compositor.queue.submit([encoder.finish()]);
        compositor.queue.present(frame);
        self.presented();
        let mut description = self.description();
        let object = description
            .as_object_mut()
            .context("native preview surface description must be an object")?;
        object.insert(
            "compositeExecutionMode".into(),
            serde_json::json!(if fused {
                "fused-four-layer/v1"
            } else {
                "dirty-rect-ping-pong/v1"
            }),
        );
        object.insert(
            "compositeLayerCount".into(),
            serde_json::json!(layers.len()),
        );
        object.insert(
            "compositeDirtyRectLayerCount".into(),
            serde_json::json!(dirty_rect_layer_count),
        );
        object.insert(
            "compositeTextureCopyCount".into(),
            serde_json::json!(dirty_rect_layer_count),
        );
        object.insert(
            "compositeFullFramePassCount".into(),
            serde_json::json!(if fused {
                fused_pass_count
            } else {
                layers.len() - dirty_rect_layer_count + 1
            }),
        );
        object.insert(
            "compositeMaximumLayersPerPass".into(),
            serde_json::json!(if fused { FUSED_LAYER_WIDTH } else { 1 }),
        );
        object.insert(
            "adjustmentExecutionMode".into(),
            serde_json::json!(if adjustments.is_empty() {
                "none"
            } else if adjustment_base_layer_count.is_some() {
                "pre-typography-full-frame/v1"
            } else {
                "trailing-full-frame/v1"
            }),
        );
        object.insert(
            "adjustmentBaseLayerCount".into(),
            serde_json::json!(adjustment_base_layer_count.unwrap_or(layers.len())),
        );
        object.insert(
            "adjustmentPassCount".into(),
            serde_json::json!(adjustments.len()),
        );
        object.insert(
            "matteExecutionMode".into(),
            serde_json::json!(if matte_count == 0 {
                "none"
            } else {
                "sampled-track-matte/v1"
            }),
        );
        object.insert("mattePassCount".into(), serde_json::json!(matte_count));
        Ok(description)
    }

    fn ensure_composite_style_buffers(&mut self, compositor: &GpuCompositor, count: usize) {
        while self.composite_style_buffers.len() < count {
            self.composite_style_buffers
                .push(create_visual_style_buffer(
                    &compositor.device,
                    "Editkin common-video resident layer uniform",
                ));
        }
    }

    fn ensure_adjustment_style_buffers(&mut self, compositor: &GpuCompositor, count: usize) {
        while self.adjustment_style_buffers.len() < count {
            self.adjustment_style_buffers
                .push(create_visual_style_buffer(
                    &compositor.device,
                    "Editkin common-video adjustment uniform",
                ));
        }
    }

    fn ensure_post_adjustment_style_buffers(&mut self, compositor: &GpuCompositor, count: usize) {
        while self.post_adjustment_style_buffers.len() < count {
            self.post_adjustment_style_buffers
                .push(create_visual_style_buffer(
                    &compositor.device,
                    "Editkin post-adjustment typography layer uniform",
                ));
        }
    }

    fn ensure_post_adjustment_matte_style_buffers(
        &mut self,
        compositor: &GpuCompositor,
        count: usize,
    ) {
        while self.post_adjustment_matte_style_buffers.len() < count {
            self.post_adjustment_matte_style_buffers
                .push(create_visual_style_buffer(
                    &compositor.device,
                    "Editkin post-adjustment typography matte uniform",
                ));
        }
    }

    fn ensure_composite_matte_style_buffers(&mut self, compositor: &GpuCompositor, count: usize) {
        while self.composite_matte_style_buffers.len() < count {
            self.composite_matte_style_buffers
                .push(create_visual_style_buffer(
                    &compositor.device,
                    "Editkin common-video resident matte uniform",
                ));
        }
    }

    fn ensure_fused_count_buffers(&mut self, compositor: &GpuCompositor, count: usize) {
        while self.fused_count_buffers.len() < count {
            self.fused_count_buffers
                .push(create_fused_layer_count_buffer(&compositor.device));
        }
    }

    fn can_fuse_layers(
        layers: &[VideoSurfaceLayer<'_>],
        destination_width: u32,
        destination_height: u32,
    ) -> bool {
        if layers.len() < FUSED_LAYER_WIDTH {
            return false;
        }
        let destination_aspect = destination_width as f64 / destination_height as f64;
        layers.iter().all(|layer| {
            if layer.temporal_sources.is_some()
                || layer.matte.is_some()
                || layer.style.matte_mode != 0
            {
                return false;
            }
            let source_aspect = layer.source_width as f64 / layer.source_height as f64;
            (source_aspect - destination_aspect).abs() <= 0.000_001
        })
    }

    #[allow(clippy::too_many_arguments)]
    fn encode_fused_layers_with_resources(
        &self,
        compositor: &GpuCompositor,
        layers: &[VideoSurfaceLayer<'_>],
        buffers: &[wgpu::Buffer],
        count_buffers: &[wgpu::Buffer],
        intermediate: &[wgpu::Texture; 2],
        destination_view: &wgpu::TextureView,
        destination_width: u32,
        destination_height: u32,
        encoder: &mut wgpu::CommandEncoder,
    ) -> usize {
        debug_assert_eq!(layers.len(), buffers.len());
        let chunk_count = layers.len().div_ceil(FUSED_LAYER_WIDTH);
        debug_assert!(count_buffers.len() >= chunk_count);
        let intermediate_views = [
            intermediate[0].create_view(&wgpu::TextureViewDescriptor::default()),
            intermediate[1].create_view(&wgpu::TextureViewDescriptor::default()),
        ];
        let black_view = self
            .black_texture
            .create_view(&wgpu::TextureViewDescriptor::default());
        for (chunk_index, chunk) in layers.chunks(FUSED_LAYER_WIDTH).enumerate() {
            let first = chunk_index * FUSED_LAYER_WIDTH;
            let backdrop_view = if chunk_index == 0 {
                &black_view
            } else {
                &intermediate_views[(chunk_index - 1) % 2]
            };
            let is_last = chunk_index + 1 == chunk_count;
            let layer_destination = if is_last {
                destination_view
            } else {
                &intermediate_views[chunk_index % 2]
            };
            let source_views = (0..FUSED_LAYER_WIDTH)
                .map(|offset| {
                    chunk
                        .get(offset)
                        .map(|layer| {
                            self.source_view(layer.source)
                        })
                        .unwrap_or_else(|| {
                            self.black_texture
                                .create_view(&wgpu::TextureViewDescriptor::default())
                        })
                })
                .collect::<Vec<_>>();
            let style_buffer = |offset: usize| {
                buffers
                    .get(first + offset)
                    .unwrap_or(&self.composite_present_buffer)
            };
            let bind_group = compositor
                .device
                .create_bind_group(&wgpu::BindGroupDescriptor {
                    label: Some("Editkin fused common-video pass bindings"),
                    layout: &self.fused_bind_group_layout,
                    entries: &[
                        wgpu::BindGroupEntry {
                            binding: 0,
                            resource: wgpu::BindingResource::TextureView(backdrop_view),
                        },
                        wgpu::BindGroupEntry {
                            binding: 1,
                            resource: wgpu::BindingResource::Sampler(&self.sampler),
                        },
                        wgpu::BindGroupEntry {
                            binding: 2,
                            resource: wgpu::BindingResource::TextureView(&source_views[0]),
                        },
                        wgpu::BindGroupEntry {
                            binding: 3,
                            resource: style_buffer(0).as_entire_binding(),
                        },
                        wgpu::BindGroupEntry {
                            binding: 4,
                            resource: wgpu::BindingResource::TextureView(&source_views[1]),
                        },
                        wgpu::BindGroupEntry {
                            binding: 5,
                            resource: style_buffer(1).as_entire_binding(),
                        },
                        wgpu::BindGroupEntry {
                            binding: 6,
                            resource: wgpu::BindingResource::TextureView(&source_views[2]),
                        },
                        wgpu::BindGroupEntry {
                            binding: 7,
                            resource: style_buffer(2).as_entire_binding(),
                        },
                        wgpu::BindGroupEntry {
                            binding: 8,
                            resource: wgpu::BindingResource::TextureView(&source_views[3]),
                        },
                        wgpu::BindGroupEntry {
                            binding: 9,
                            resource: style_buffer(3).as_entire_binding(),
                        },
                        wgpu::BindGroupEntry {
                            binding: 10,
                            resource: count_buffers[chunk_index].as_entire_binding(),
                        },
                    ],
                });
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("Editkin fused common-video composite pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: layer_destination,
                    resolve_target: None,
                    depth_slice: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });
            pass.set_pipeline(&self.fused_pipeline);
            pass.set_bind_group(0, &bind_group, &[]);
            pass.set_viewport(
                0.0,
                0.0,
                destination_width as f32,
                destination_height as f32,
                0.0,
                1.0,
            );
            pass.draw(0..3, 0..1);
        }
        chunk_count
    }

    #[allow(clippy::too_many_arguments)]
    fn encode_adjustment_passes_with_resources(
        &self,
        compositor: &GpuCompositor,
        adjustments: &[VideoVisualStyle],
        buffers: &[wgpu::Buffer],
        intermediate: &[wgpu::Texture; 2],
        destination_view: &wgpu::TextureView,
        destination_width: u32,
        destination_height: u32,
        encoder: &mut wgpu::CommandEncoder,
    ) {
        debug_assert!(!adjustments.is_empty());
        debug_assert!(buffers.len() >= adjustments.len());
        let intermediate_views = [
            intermediate[0].create_view(&wgpu::TextureViewDescriptor::default()),
            intermediate[1].create_view(&wgpu::TextureViewDescriptor::default()),
        ];
        let black_view = self
            .black_texture
            .create_view(&wgpu::TextureViewDescriptor::default());
        for (index, _) in adjustments.iter().enumerate() {
            let source_index = index % 2;
            let is_last = index + 1 == adjustments.len();
            let layer_destination = if is_last {
                destination_view
            } else {
                &intermediate_views[(index + 1) % 2]
            };
            self.encode_visual_layer(
                compositor,
                &intermediate[source_index],
                None,
                destination_width,
                destination_height,
                &buffers[index],
                None,
                &buffers[index],
                &black_view,
                layer_destination,
                destination_width,
                destination_height,
                true,
                None,
                encoder,
            );
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn encode_visual_pass(
        &self,
        compositor: &GpuCompositor,
        source: &wgpu::Texture,
        source_width: u32,
        source_height: u32,
        style: VideoVisualStyle,
        temporal_sources: Option<&[&wgpu::Texture]>,
        destination_view: &wgpu::TextureView,
        destination_width: u32,
        destination_height: u32,
        encoder: &mut wgpu::CommandEncoder,
    ) {
        let style = style.with_source_dimensions(source_width, source_height);
        compositor
            .queue
            .write_buffer(&self.style_buffer, 0, bytemuck::bytes_of(&style));
        self.encode_visual_layer(
            compositor,
            source,
            temporal_sources,
            source_width,
            source_height,
            &self.style_buffer,
            None,
            &self.style_buffer,
            &self
                .black_texture
                .create_view(&wgpu::TextureViewDescriptor::default()),
            destination_view,
            destination_width,
            destination_height,
            true,
            None,
            encoder,
        );
    }

    fn encode_visual_layers(
        &self,
        compositor: &GpuCompositor,
        layers: &[VideoSurfaceLayer<'_>],
        destination_view: &wgpu::TextureView,
        destination_width: u32,
        destination_height: u32,
        encoder: &mut wgpu::CommandEncoder,
    ) {
        let styles = layers.iter().map(|layer| layer.style).collect::<Vec<_>>();
        let buffers = styles
            .iter()
            .map(|style| {
                compositor
                    .device
                    .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                        label: Some("Editkin common-video composite layer uniform"),
                        contents: bytemuck::bytes_of(style),
                        usage: wgpu::BufferUsages::UNIFORM,
                    })
            })
            .collect::<Vec<_>>();
        let matte_buffers = layers
            .iter()
            .map(|layer| {
                let style = layer.matte.map(|matte| matte.style).unwrap_or_default();
                compositor
                    .device
                    .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                        label: Some("Editkin common-video verification matte uniform"),
                        contents: bytemuck::bytes_of(&style),
                        usage: wgpu::BufferUsages::UNIFORM,
                    })
            })
            .collect::<Vec<_>>();
        let intermediate = create_composite_intermediate(
            &compositor.device,
            destination_width,
            destination_height,
            self.configuration.format,
        );
        if Self::can_fuse_layers(layers, destination_width, destination_height) {
            let count_buffers = layers
                .chunks(FUSED_LAYER_WIDTH)
                .map(|chunk| {
                    compositor
                        .device
                        .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                            label: Some("Editkin fused verification layer count"),
                            contents: bytemuck::bytes_of(&FusedLayerCount {
                                layer_count: chunk.len() as u32,
                                padding: [0; 3],
                            }),
                            usage: wgpu::BufferUsages::UNIFORM,
                        })
                })
                .collect::<Vec<_>>();
            self.encode_fused_layers_with_resources(
                compositor,
                layers,
                &buffers,
                &count_buffers,
                &intermediate,
                destination_view,
                destination_width,
                destination_height,
                encoder,
            );
            return;
        }
        let present_style = VideoVisualStyle::default()
            .with_source_dimensions(destination_width, destination_height);
        let present_buffer =
            compositor
                .device
                .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some("Editkin common-video verification present uniform"),
                    contents: bytemuck::bytes_of(&present_style),
                    usage: wgpu::BufferUsages::UNIFORM,
                });
        let _ = self.encode_visual_layers_with_resources(
            compositor,
            layers,
            &buffers,
            &matte_buffers,
            &intermediate,
            &present_buffer,
            destination_view,
            destination_width,
            destination_height,
            encoder,
        );
    }

    #[allow(clippy::too_many_arguments)]
    fn encode_visual_layers_with_resources(
        &self,
        compositor: &GpuCompositor,
        layers: &[VideoSurfaceLayer<'_>],
        buffers: &[wgpu::Buffer],
        matte_buffers: &[wgpu::Buffer],
        intermediate: &[wgpu::Texture; 2],
        present_buffer: &wgpu::Buffer,
        destination_view: &wgpu::TextureView,
        destination_width: u32,
        destination_height: u32,
        encoder: &mut wgpu::CommandEncoder,
    ) -> usize {
        debug_assert_eq!(layers.len(), buffers.len());
        debug_assert_eq!(layers.len(), matte_buffers.len());
        let intermediate_views = [
            intermediate[0].create_view(&wgpu::TextureViewDescriptor::default()),
            intermediate[1].create_view(&wgpu::TextureViewDescriptor::default()),
        ];
        let black_view = self
            .black_texture
            .create_view(&wgpu::TextureViewDescriptor::default());
        let mut dirty_rect_layer_count = 0_usize;
        for (index, layer) in layers.iter().enumerate() {
            let backdrop_view = if index == 0 {
                &black_view
            } else {
                &intermediate_views[(index - 1) % 2]
            };
            let layer_destination = &intermediate_views[index % 2];
            let scissor = (index > 0 && layer.matte.is_none() && layer.style.matte_mode == 0)
                .then(|| {
                    visual_dirty_rect(
                        &layer.style,
                        layer.source_width,
                        layer.source_height,
                        destination_width,
                        destination_height,
                    )
                })
                .flatten();
            if scissor.is_some() {
                encoder.copy_texture_to_texture(
                    wgpu::TexelCopyTextureInfo {
                        texture: &intermediate[(index - 1) % 2],
                        mip_level: 0,
                        origin: wgpu::Origin3d::ZERO,
                        aspect: wgpu::TextureAspect::All,
                    },
                    wgpu::TexelCopyTextureInfo {
                        texture: &intermediate[index % 2],
                        mip_level: 0,
                        origin: wgpu::Origin3d::ZERO,
                        aspect: wgpu::TextureAspect::All,
                    },
                    wgpu::Extent3d {
                        width: destination_width,
                        height: destination_height,
                        depth_or_array_layers: 1,
                    },
                );
                dirty_rect_layer_count += 1;
            }
            self.encode_visual_layer(
                compositor,
                layer.source,
                layer
                    .temporal_sources
                    .as_ref()
                    .map(|sources| sources.as_slice()),
                layer.source_width,
                layer.source_height,
                &buffers[index],
                layer.matte,
                &matte_buffers[index],
                backdrop_view,
                layer_destination,
                destination_width,
                destination_height,
                scissor.is_none(),
                scissor,
                encoder,
            );
        }
        self.encode_visual_layer(
            compositor,
            &intermediate[layers.len().saturating_sub(1) % 2],
            None,
            destination_width,
            destination_height,
            present_buffer,
            None,
            present_buffer,
            &black_view,
            destination_view,
            destination_width,
            destination_height,
            true,
            None,
            encoder,
        );
        dirty_rect_layer_count
    }

    #[allow(clippy::too_many_arguments)]
    fn encode_visual_layer(
        &self,
        compositor: &GpuCompositor,
        source: &wgpu::Texture,
        temporal_sources: Option<&[&wgpu::Texture]>,
        source_width: u32,
        source_height: u32,
        style_buffer: &wgpu::Buffer,
        matte: Option<VideoSurfaceMatte<'_>>,
        matte_style_buffer: &wgpu::Buffer,
        backdrop_view: &wgpu::TextureView,
        destination_view: &wgpu::TextureView,
        destination_width: u32,
        destination_height: u32,
        clear: bool,
        scissor: Option<(u32, u32, u32, u32)>,
        encoder: &mut wgpu::CommandEncoder,
    ) {
        let source_textures = (0..8)
            .map(|index| {
                temporal_sources
                    .and_then(|sources| sources.get(index).copied())
                    .unwrap_or(source)
            })
            .collect::<Vec<_>>();
        let source_views = source_textures
            .iter()
            .map(|texture| self.source_view(texture))
            .collect::<Vec<_>>();
        let matte_view = matte
            .map(|matte| {
                self.source_view(matte.source)
            })
            .unwrap_or_else(|| {
                self.black_texture
                    .create_view(&wgpu::TextureViewDescriptor::default())
            });
        let bind_group = compositor
            .device
            .create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("Editkin direct preview surface frame bindings"),
                layout: &self.bind_group_layout,
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: wgpu::BindingResource::TextureView(&source_views[0]),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: wgpu::BindingResource::Sampler(&self.sampler),
                    },
                    wgpu::BindGroupEntry {
                        binding: 2,
                        resource: style_buffer.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 3,
                        resource: wgpu::BindingResource::TextureView(backdrop_view),
                    },
                    wgpu::BindGroupEntry {
                        binding: 4,
                        resource: wgpu::BindingResource::TextureView(&matte_view),
                    },
                    wgpu::BindGroupEntry {
                        binding: 5,
                        resource: matte_style_buffer.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 6,
                        resource: wgpu::BindingResource::TextureView(&source_views[1]),
                    },
                    wgpu::BindGroupEntry {
                        binding: 7,
                        resource: wgpu::BindingResource::TextureView(&source_views[2]),
                    },
                    wgpu::BindGroupEntry {
                        binding: 8,
                        resource: wgpu::BindingResource::TextureView(&source_views[3]),
                    },
                    wgpu::BindGroupEntry {
                        binding: 9,
                        resource: wgpu::BindingResource::TextureView(&source_views[4]),
                    },
                    wgpu::BindGroupEntry {
                        binding: 10,
                        resource: wgpu::BindingResource::TextureView(&source_views[5]),
                    },
                    wgpu::BindGroupEntry {
                        binding: 11,
                        resource: wgpu::BindingResource::TextureView(&source_views[6]),
                    },
                    wgpu::BindGroupEntry {
                        binding: 12,
                        resource: wgpu::BindingResource::TextureView(&source_views[7]),
                    },
                ],
            });
        let destination_aspect = destination_width as f32 / destination_height as f32;
        let source_aspect = source_width as f32 / source_height as f32;
        let (viewport_x, viewport_y, viewport_width, viewport_height) =
            if destination_aspect > source_aspect {
                let viewport_width = destination_height as f32 * source_aspect;
                (
                    (destination_width as f32 - viewport_width) * 0.5,
                    0.0,
                    viewport_width,
                    destination_height as f32,
                )
            } else {
                let viewport_height = destination_width as f32 / source_aspect;
                (
                    0.0,
                    (destination_height as f32 - viewport_height) * 0.5,
                    destination_width as f32,
                    viewport_height,
                )
            };
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("Editkin direct native preview present"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &destination_view,
                    resolve_target: None,
                    depth_slice: None,
                    ops: wgpu::Operations {
                        load: if clear {
                            wgpu::LoadOp::Clear(wgpu::Color::BLACK)
                        } else {
                            wgpu::LoadOp::Load
                        },
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });
            pass.set_pipeline(&self.pipeline);
            pass.set_bind_group(0, &bind_group, &[]);
            pass.set_viewport(
                viewport_x,
                viewport_y,
                viewport_width,
                viewport_height,
                0.0,
                1.0,
            );
            if let Some((x, y, width, height)) = scissor {
                pass.set_scissor_rect(x, y, width, height);
            }
            pass.draw(0..3, 0..1);
        }
    }

    pub(super) fn verify_texture(
        &self,
        compositor: &GpuCompositor,
        source: &wgpu::Texture,
        source_width: u32,
        source_height: u32,
        style: VideoVisualStyle,
        temporal_sources: Option<&[&wgpu::Texture]>,
        output_path: &Path,
    ) -> Result<serde_json::Value> {
        self.ensure_legacy_video_surface()?;
        let target = compositor.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Editkin isolated common-video visual verification target"),
            size: wgpu::Extent3d {
                width: source_width,
                height: source_height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: self.configuration.format,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let destination_view = target.create_view(&wgpu::TextureViewDescriptor::default());
        let mut encoder =
            compositor
                .device
                .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                    label: Some("Editkin isolated common-video visual verification render"),
                });
        self.encode_visual_pass(
            compositor,
            source,
            source_width,
            source_height,
            style,
            temporal_sources,
            &destination_view,
            source_width,
            source_height,
            &mut encoder,
        );
        compositor.queue.submit([encoder.finish()]);
        let (output_hash, rgba) =
            consume_bgra_with_wgpu(compositor, &target, source_width, source_height)?;
        super::save_rgba(output_path, rgba, source_width, source_height)?;
        Ok(serde_json::json!({
            "verificationReadback": true,
            "productPathCpuPixelCopies": 0,
            "outputWritten": true,
            "outputHash": output_hash,
            "visualGraph": style,
            "sdrOutputContract": self.output_pixel_contract(),
        }))
    }

    pub(super) fn verify_layers_with_adjustments(
        &self,
        compositor: &GpuCompositor,
        layers: &[VideoSurfaceLayer<'_>],
        adjustments: &[VideoVisualStyle],
        adjustment_base_layer_count: Option<usize>,
        width: u32,
        height: u32,
        output_path: &Path,
    ) -> Result<serde_json::Value> {
        self.ensure_legacy_video_surface()?;
        if layers.is_empty() {
            bail!("common-video composite verification requires at least one video/overlay layer");
        }
        if let Some(base_layer_count) = adjustment_base_layer_count {
            if !(1..=2).contains(&adjustments.len())
                || base_layer_count == 0
                || base_layer_count > layers.len()
            {
                bail!(
                    "pre-typography adjustment verification requires one or two active adjustments and a valid base-layer split"
                );
            }
        }
        let fused =
            adjustment_base_layer_count.is_none() && Self::can_fuse_layers(layers, width, height);
        let matte_count = layers.iter().filter(|layer| layer.matte.is_some()).count();
        let target = compositor.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Editkin isolated common-video composite verification target"),
            size: wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: self.configuration.format,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let destination_view = target.create_view(&wgpu::TextureViewDescriptor::default());
        let mut encoder =
            compositor
                .device
                .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                    label: Some("Editkin isolated common-video composite verification render"),
                });
        if let Some(base_layer_count) = adjustment_base_layer_count {
            let adjustment_intermediate = create_composite_intermediate(
                &compositor.device,
                width,
                height,
                self.configuration.format,
            );
            let base_view =
                adjustment_intermediate[0].create_view(&wgpu::TextureViewDescriptor::default());
            self.encode_visual_layers(
                compositor,
                &layers[..base_layer_count],
                &base_view,
                width,
                height,
                &mut encoder,
            );
            let adjustment_buffers = adjustments
                .iter()
                .map(|style| {
                    let style = style.with_source_dimensions(width, height);
                    compositor
                        .device
                        .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                            label: Some("Editkin pre-typography verification adjustment uniform"),
                            contents: bytemuck::bytes_of(&style),
                            usage: wgpu::BufferUsages::UNIFORM,
                        })
                })
                .collect::<Vec<_>>();
            if base_layer_count < layers.len() {
                let adjusted_texture_index = adjustments.len() % 2;
                let adjusted_view = adjustment_intermediate[adjusted_texture_index]
                    .create_view(&wgpu::TextureViewDescriptor::default());
                self.encode_adjustment_passes_with_resources(
                    compositor,
                    adjustments,
                    &adjustment_buffers,
                    &adjustment_intermediate,
                    &adjusted_view,
                    width,
                    height,
                    &mut encoder,
                );
                let adjusted_base = VideoSurfaceLayer {
                    source: &adjustment_intermediate[adjusted_texture_index],
                    temporal_sources: None,
                    source_width: width,
                    source_height: height,
                    style: VideoVisualStyle::default().with_source_dimensions(width, height),
                    matte: None,
                };
                let post_layers = std::iter::once(adjusted_base)
                    .chain(layers[base_layer_count..].iter().copied())
                    .collect::<Vec<_>>();
                self.encode_visual_layers(
                    compositor,
                    &post_layers,
                    &destination_view,
                    width,
                    height,
                    &mut encoder,
                );
            } else {
                self.encode_adjustment_passes_with_resources(
                    compositor,
                    adjustments,
                    &adjustment_buffers,
                    &adjustment_intermediate,
                    &destination_view,
                    width,
                    height,
                    &mut encoder,
                );
            }
        } else if adjustments.is_empty() {
            self.encode_visual_layers(
                compositor,
                layers,
                &destination_view,
                width,
                height,
                &mut encoder,
            );
        } else {
            let adjustment_intermediate = create_composite_intermediate(
                &compositor.device,
                width,
                height,
                self.configuration.format,
            );
            let content_view =
                adjustment_intermediate[0].create_view(&wgpu::TextureViewDescriptor::default());
            self.encode_visual_layers(
                compositor,
                layers,
                &content_view,
                width,
                height,
                &mut encoder,
            );
            let adjustment_buffers = adjustments
                .iter()
                .map(|style| {
                    let style = style.with_source_dimensions(width, height);
                    compositor
                        .device
                        .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                            label: Some("Editkin verification adjustment uniform"),
                            contents: bytemuck::bytes_of(&style),
                            usage: wgpu::BufferUsages::UNIFORM,
                        })
                })
                .collect::<Vec<_>>();
            self.encode_adjustment_passes_with_resources(
                compositor,
                adjustments,
                &adjustment_buffers,
                &adjustment_intermediate,
                &destination_view,
                width,
                height,
                &mut encoder,
            );
        }
        compositor.queue.submit([encoder.finish()]);
        let (output_hash, rgba) = consume_bgra_with_wgpu(compositor, &target, width, height)?;
        super::save_rgba(output_path, rgba, width, height)?;
        let visual_layers = layers.iter().map(|layer| layer.style).collect::<Vec<_>>();
        Ok(serde_json::json!({
            "verificationReadback": true,
            "productPathCpuPixelCopies": 0,
            "outputWritten": true,
            "outputHash": output_hash,
            "visualLayers": visual_layers,
            "compositeExecutionMode": if fused { "fused-four-layer/v1" } else { "dirty-rect-ping-pong/v1" },
            "compositeLayerCount": layers.len(),
            "compositeFullFramePassCount": if fused { layers.len().div_ceil(FUSED_LAYER_WIDTH) } else { layers.len() + 1 },
            "compositeMaximumLayersPerPass": if fused { FUSED_LAYER_WIDTH } else { 1 },
            "adjustmentExecutionMode": if adjustments.is_empty() { "none" } else if adjustment_base_layer_count.is_some() { "pre-typography-full-frame/v1" } else { "trailing-full-frame/v1" },
            "adjustmentBaseLayerCount": adjustment_base_layer_count.unwrap_or(layers.len()),
            "adjustmentPassCount": adjustments.len(),
            "adjustments": adjustments,
            "sdrOutputContract": self.output_pixel_contract(),
            "matteExecutionMode": if matte_count == 0 { "none" } else { "sampled-track-matte/v1" },
            "mattePassCount": matte_count,
        }))
    }

    fn presented(&mut self) {
        self.present_count += 1;
        if self.visible {
            return;
        }
        let (screen_x, screen_y) =
            screen_position(self.owner, self.x, self.y).unwrap_or((self.x, self.y));
        unsafe {
            let _ = SetWindowPos(
                self.window.0,
                Some(HWND_TOP),
                screen_x,
                screen_y,
                self.width as i32,
                self.height as i32,
                SWP_NOACTIVATE | SWP_SHOWWINDOW,
            );
            let _ = ShowWindow(self.window.0, SW_SHOWNA);
        }
        self.visible = true;
        pump_preview_window_messages();
    }

    pub(super) fn description(&self) -> serde_json::Value {
        let live_headroom = self.display_hdr_info.tone_map_headroom();
        serde_json::json!({
            "bound": true,
            "backend": "Dx12",
            "surfaceFormat": format!("{:?}", self.configuration.format),
            "surfaceColorSpace": format!("{:?}", self.configuration.color_space),
            "requestedColorSpace": self.color_space_contract.requested_name(),
            "pixelContract": self.color_space_contract.pixel_contract(),
            "legacyVideoPresentationAllowed": self.color_space_contract.legacy_video_allowed(),
            "hdrTransportConfigured": !self.color_space_contract.legacy_video_allowed(),
            "dxgiColorSpaceConfiguration": "wgpu-dx12-IDXGISwapChain3-SetColorSpace1/v1",
            "displayHdrInfo": display_hdr_info_json(&self.display_hdr_info),
            "liveDisplayHeadroomMeasured": live_headroom.is_some(),
            "physicalDisplayHdrVisibility": "advisory-unverified",
            "presentMode": format!("{:?}", self.configuration.present_mode),
            "width": self.width,
            "height": self.height,
            "presentCount": self.present_count,
            "visible": self.visible,
            "cpuPixelReadbacks": 0,
            "nativeSwapChain": true,
        })
    }
}

fn screen_position(owner: Option<HWND>, x: i32, y: i32) -> Result<(i32, i32)> {
    let Some(owner) = owner else {
        return Ok((x, y));
    };
    let mut point = POINT { x, y };
    if !unsafe { ClientToScreen(owner, &mut point) }.as_bool() {
        bail!("convert preview client coordinates to screen coordinates failed");
    }
    Ok((point.x, point.y))
}

/// A Media Foundation decoder that remains alive across resident-engine requests.
/// Field order is intentional: decoder COM objects are released before Media Foundation and COM.
pub(super) struct VideoInteropSession {
    frame_ring: Vec<ResidentFrameSlot>,
    cross_api_fence: CrossApiSharedFence,
    decode: DecodeContext,
    _media_foundation: MediaFoundationGuard,
    _com: ComGuard,
    next_frame_index: u64,
    ended: bool,
    minimum_timestamp_100ns: Option<i64>,
    last_timestamp_100ns: Option<i64>,
    total_clock_dropped_frames: u64,
    next_submission_sequence: u64,
    source_timestamp_origin_100ns: i64,
    temporal_source_cache: BTreeMap<i64, (usize, serde_json::Value)>,
}

impl VideoInteropSession {
    pub(super) fn open(compositor: &GpuCompositor, input: &Path) -> Result<Self> {
        Self::open_with_ring_size(compositor, input, 3)
    }

    pub(super) fn open_with_ring_size(
        compositor: &GpuCompositor,
        input: &Path,
        ring_size: usize,
    ) -> Result<Self> {
        ensure_video_mmcss();
        if !input.is_file() {
            bail!("video input does not exist: {}", input.display());
        }
        if !(3..=192).contains(&ring_size) {
            bail!("resident video frame ring size must be within 3..=192");
        }
        let com = ComGuard::start()?;
        let media_foundation = MediaFoundationGuard::start()?;
        let decode = unsafe { create_decode_context(compositor, input) }?;
        let mut frame_ring = Vec::with_capacity(ring_size);
        for _ in 0..ring_size {
            frame_ring.push(create_resident_frame_slot(compositor, &decode)?);
        }
        let cross_api_fence = create_cross_api_shared_fence(compositor, &decode.device)?;
        let mut session = Self {
            frame_ring,
            cross_api_fence,
            decode,
            _media_foundation: media_foundation,
            _com: com,
            next_frame_index: 0,
            ended: false,
            minimum_timestamp_100ns: None,
            last_timestamp_100ns: None,
            total_clock_dropped_frames: 0,
            next_submission_sequence: 1,
            source_timestamp_origin_100ns: 0,
            temporal_source_cache: BTreeMap::new(),
        };
        session.calibrate_source_clock()?;
        Ok(session)
    }

    pub(super) fn description(&self) -> serde_json::Value {
        serde_json::json!({
            "resident": true,
            "adapterLuid": self.decode.adapter_luid,
            "width": self.decode.visible_width,
            "height": self.decode.visible_height,
            "decodePathCpuPixelCopies": 0,
            "gpuProcessingPassesPerFrame": 2,
            "verificationReadback": true,
            "gpuResidentStaging": true,
            "stagingCpuPixelReadback": false,
            "stagingFenceRing": true,
            "crossApiSharedFence": true,
            "crossApiProducerCpuWaits": 0,
            "crossApiSynchronization": "ID3D11Fence shared handle -> ID3D12CommandQueue::Wait",
            "residentFrameRingSize": self.frame_ring.len(),
            "frameRate": [self.decode.frame_rate_numerator, self.decode.frame_rate_denominator],
            "sourceTimestampOriginSeconds": self.source_timestamp_origin_100ns as f64 / 10_000_000.0,
        })
    }

    pub(super) fn dimensions(&self) -> (u32, u32) {
        (self.decode.visible_width, self.decode.visible_height)
    }

    pub(super) fn frame_rate(&self) -> (u32, u32) {
        (
            self.decode.frame_rate_numerator,
            self.decode.frame_rate_denominator,
        )
    }

    pub(super) fn staged_surface_layer(
        &self,
        slot_index: usize,
        style: VideoVisualStyle,
    ) -> Result<VideoSurfaceLayer<'_>> {
        let slot = self
            .frame_ring
            .get(slot_index)
            .context("staged common-video frame ring slot is out of bounds")?;
        Ok(VideoSurfaceLayer {
            source: &slot.staged_texture,
            temporal_sources: None,
            source_width: self.decode.visible_width,
            source_height: self.decode.visible_height,
            style,
            matte: None,
        })
    }

    pub(super) fn decode_next(
        &mut self,
        compositor: &GpuCompositor,
        output_path: Option<&Path>,
    ) -> Result<Option<serde_json::Value>> {
        let Some((frame, frame_index, slot_index)) = self.decode_one(compositor)? else {
            return Ok(None);
        };
        self.frame_receipt(frame, frame_index, slot_index, output_path)
            .map(Some)
    }

    fn decode_one(
        &mut self,
        compositor: &GpuCompositor,
    ) -> Result<Option<(InteropFrame, u64, usize)>> {
        if self.ended {
            return Ok(None);
        }
        let minimum_timestamp = self.minimum_timestamp_100ns.take();
        let slot_index = self.next_frame_index as usize % self.frame_ring.len();
        let slot = &mut self.frame_ring[slot_index];
        let _ = retire_pending_submission(compositor, slot)?;
        let Some(mut frame) =
            process_next_frame_resident(compositor, &self.decode, minimum_timestamp, slot)?
        else {
            self.ended = true;
            return Ok(None);
        };
        frame.source_timestamp_100ns = frame.timestamp_100ns;
        frame.timestamp_100ns = self.next_clock_timestamp(frame.source_timestamp_100ns);
        let frame_index = self.next_frame_index;
        self.next_frame_index += 1;
        self.last_timestamp_100ns = Some(frame.timestamp_100ns);
        Ok(Some((frame, frame_index, slot_index)))
    }

    fn prepare_stage_one(
        &mut self,
        compositor: &GpuCompositor,
    ) -> Result<Option<(StagedFrame, u64, usize)>> {
        if self.ended {
            return Ok(None);
        }
        let minimum_timestamp = self.minimum_timestamp_100ns.take();
        let slot_index = self.next_frame_index as usize % self.frame_ring.len();
        let submission_sequence = self.next_submission_sequence;
        self.next_submission_sequence += 1;
        let Some(mut frame) = prepare_next_frame_resident_staged(
            compositor,
            &self.decode,
            minimum_timestamp,
            &mut self.frame_ring[slot_index],
            &self.cross_api_fence,
            submission_sequence,
        )?
        else {
            self.ended = true;
            return Ok(None);
        };
        frame.source_timestamp_100ns = frame.timestamp_100ns;
        frame.timestamp_100ns = self.next_clock_timestamp(frame.source_timestamp_100ns);
        let frame_index = self.next_frame_index;
        self.next_frame_index += 1;
        self.last_timestamp_100ns = Some(frame.timestamp_100ns);
        Ok(Some((frame, frame_index, slot_index)))
    }

    fn encode_prepared_copy(
        &self,
        slot_index: usize,
        encoder: &mut wgpu::CommandEncoder,
    ) -> Result<()> {
        let slot = self
            .frame_ring
            .get(slot_index)
            .context("prepared common-video frame ring slot is out of bounds")?;
        encoder.copy_texture_to_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &slot.wrapped,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::TexelCopyTextureInfo {
                texture: &slot.staged_texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::Extent3d {
                width: self.decode.visible_width,
                height: self.decode.visible_height,
                depth_or_array_layers: 1,
            },
        );
        Ok(())
    }

    fn complete_prepared_submission(
        &mut self,
        slot_index: usize,
        index: wgpu::SubmissionIndex,
        sequence: u64,
    ) -> Result<()> {
        let slot = self
            .frame_ring
            .get_mut(slot_index)
            .context("completed common-video frame ring slot is out of bounds")?;
        slot.pending_submission = Some(PendingGpuSubmission { index, sequence });
        Ok(())
    }

    fn next_clock_timestamp(&mut self, source_timestamp_100ns: i64) -> i64 {
        let normalized = source_timestamp_100ns.saturating_sub(self.source_timestamp_origin_100ns);
        if let Some(previous) = self.last_timestamp_100ns {
            if normalized <= previous
                && self.decode.frame_rate_numerator > 0
                && self.decode.frame_rate_denominator > 0
            {
                let scaled = 10_000_000_u128 * self.decode.frame_rate_denominator as u128;
                let duration = ((scaled + self.decode.frame_rate_numerator as u128 / 2)
                    / self.decode.frame_rate_numerator as u128)
                    as i64;
                return previous.saturating_add(duration.max(1));
            }
        }
        normalized.max(0)
    }

    fn calibrate_source_clock(&mut self) -> Result<()> {
        let Some((_source, _subresource, timestamp_100ns)) =
            (unsafe { read_dxgi_frame(&self.decode.reader, None) })?
        else {
            bail!("video source produced no frame while calibrating its clock origin");
        };
        let source_timestamp_origin_100ns = timestamp_100ns;
        self.source_timestamp_origin_100ns = 0;
        self.seek(0.0)?;
        self.source_timestamp_origin_100ns = source_timestamp_origin_100ns;
        Ok(())
    }

    fn frame_receipt(
        &self,
        frame: InteropFrame,
        frame_index: u64,
        slot_index: usize,
        output_path: Option<&Path>,
    ) -> Result<serde_json::Value> {
        let timestamp_seconds = frame.timestamp_100ns as f64 / 10_000_000.0;
        let source_timestamp_seconds = frame.source_timestamp_100ns as f64 / 10_000_000.0;
        let width = frame.width;
        let height = frame.height;
        let decoder_surface_width = frame.decoder_surface_width;
        let decoder_surface_height = frame.decoder_surface_height;
        let source_dxgi_format = frame.source_dxgi_format;
        let producer_hash = frame.producer_hash;
        let consumer_hash = frame.consumer_hash;
        let output_written = if let Some(path) = output_path {
            super::save_rgba(path, frame.rgba, width, height)?;
            true
        } else {
            false
        };
        Ok(serde_json::json!({
            "frameIndex": frame_index,
            "frameRingSlot": slot_index,
            "residentFrameRingSize": self.frame_ring.len(),
            "width": width,
            "height": height,
            "decoderSurfaceWidth": decoder_surface_width,
            "decoderSurfaceHeight": decoder_surface_height,
            "sourceDxgiFormat": source_dxgi_format,
            "timestampSeconds": timestamp_seconds,
            "sourceTimestampSeconds": source_timestamp_seconds,
            "sharedDxgiFormat": DXGI_FORMAT_B8G8R8A8_UNORM.0,
            "producerHash": producer_hash,
            "outputHash": consumer_hash,
            "producerConsumerParity": true,
            "decodePathCpuPixelCopies": 0,
            "gpuProcessingPasses": 2,
            "verificationReadback": true,
            "outputWritten": output_written,
            "endOfStream": false,
        }))
    }

    pub(super) fn decode_at(
        &mut self,
        compositor: &GpuCompositor,
        target_seconds: f64,
        tolerance_seconds: f64,
        output_path: Option<&Path>,
    ) -> Result<Option<serde_json::Value>> {
        if !target_seconds.is_finite() || target_seconds < 0.0 {
            bail!("video clock targetSeconds must be a finite non-negative number");
        }
        if !tolerance_seconds.is_finite() || tolerance_seconds <= 0.0 || tolerance_seconds > 0.25 {
            bail!("video clock toleranceSeconds must be finite and within (0, 0.25]");
        }
        let target_100ns = (target_seconds * 10_000_000.0).round() as i64;
        let tolerance_100ns = (tolerance_seconds * 10_000_000.0).round() as i64;
        let seek_threshold_100ns = 2_500_000_i64;
        let must_seek = match self.last_timestamp_100ns {
            Some(last) => {
                last > target_100ns + tolerance_100ns
                    || target_100ns.saturating_sub(last) > seek_threshold_100ns
            }
            None => target_100ns > seek_threshold_100ns,
        };
        if must_seek {
            // SourceReader seeks can land a fraction after an exact frame boundary. Start one
            // accepted tolerance window earlier so the selector can retain the nearest legal
            // frame instead of systematically presenting the following frame one cadence late.
            self.seek((target_seconds - tolerance_seconds).max(0.0))?;
        }

        let mut dropped_for_clock = 0_u64;
        for _ in 0..600 {
            let Some((frame, frame_index, slot_index)) = self.decode_one(compositor)? else {
                return Ok(None);
            };
            let timestamp_100ns = frame.timestamp_100ns;
            if timestamp_100ns
                .saturating_add(tolerance_100ns)
                .saturating_add(CLOCK_ROUNDING_EPSILON_100NS)
                < target_100ns
            {
                dropped_for_clock += 1;
                continue;
            }
            self.total_clock_dropped_frames += dropped_for_clock;
            let drift_ms = (timestamp_100ns - target_100ns) as f64 / 10_000.0;
            let mut receipt = self.frame_receipt(frame, frame_index, slot_index, output_path)?;
            let object = receipt
                .as_object_mut()
                .context("clocked frame receipt must be a JSON object")?;
            object.insert(
                "clockTargetSeconds".into(),
                serde_json::json!(target_seconds),
            );
            object.insert(
                "clockToleranceSeconds".into(),
                serde_json::json!(tolerance_seconds),
            );
            object.insert("clockDriftMilliseconds".into(), serde_json::json!(drift_ms));
            object.insert(
                "clockDroppedFrames".into(),
                serde_json::json!(dropped_for_clock),
            );
            object.insert(
                "totalClockDroppedFrames".into(),
                serde_json::json!(self.total_clock_dropped_frames),
            );
            object.insert("clockSeeked".into(), serde_json::json!(must_seek));
            object.insert(
                "clockWithinTolerance".into(),
                serde_json::json!(
                    (timestamp_100ns - target_100ns).abs()
                        <= tolerance_100ns + CLOCK_RECEIPT_EPSILON_100NS
                ),
            );
            return Ok(Some(receipt));
        }
        bail!("video clock selection exceeded 600 decoded frames without reaching target")
    }

    pub(super) fn stage_at(
        &mut self,
        compositor: &GpuCompositor,
        target_seconds: f64,
        tolerance_seconds: f64,
    ) -> Result<Option<serde_json::Value>> {
        self.stage_at_internal(
            compositor,
            target_seconds,
            tolerance_seconds,
            None,
            VideoVisualStyle::default(),
        )
    }

    fn stage_temporal_window(
        &mut self,
        compositor: &GpuCompositor,
        target_seconds: &[f64],
        requested_tolerance_seconds: f64,
    ) -> Result<Option<(Vec<serde_json::Value>, Vec<usize>, f64)>> {
        if !(2..=8).contains(&target_seconds.len())
            || target_seconds
                .iter()
                .any(|target| !target.is_finite() || *target < 0.0)
            || target_seconds.windows(2).any(|pair| pair[1] < pair[0])
        {
            bail!(
                "decoded temporal shutter targets must contain 2..=8 finite ordered source clocks"
            );
        }
        if self.frame_ring.len() < target_seconds.len() {
            bail!("decoded temporal resident frame ring is smaller than the shutter sample count");
        }
        let decoded_frame_seconds = if self.decode.frame_rate_numerator > 0 {
            self.decode.frame_rate_denominator as f64 / self.decode.frame_rate_numerator as f64
        } else {
            requested_tolerance_seconds * 2.0
        };
        let effective_tolerance_seconds = requested_tolerance_seconds
            .min(decoded_frame_seconds * 0.25)
            .max(0.000_001);
        let mut receipts = Vec::<serde_json::Value>::with_capacity(target_seconds.len());
        let mut slot_indices = Vec::<usize>::with_capacity(target_seconds.len());
        for target in target_seconds {
            // A decoded video frame is a sample-and-hold signal until the next timestamp. Map
            // authored sub-frame shutter clocks to that held source frame, then cache by the
            // exact 100 ns decode target. This avoids both interpolation claims and redundant
            // decode/copy work when several shutter samples resolve to one source frame.
            let decode_target_seconds =
                ((*target / decoded_frame_seconds) + 0.000_001).floor() * decoded_frame_seconds;
            let decode_key = (decode_target_seconds * 10_000_000.0).round() as i64;
            let (mut receipt, slot_index, cache_hit) =
                if let Some((slot_index, receipt)) = self.temporal_source_cache.get(&decode_key) {
                    (receipt.clone(), *slot_index, true)
                } else {
                    let next_slot = self.next_frame_index as usize % self.frame_ring.len();
                    self.temporal_source_cache
                        .retain(|_, (slot_index, _)| *slot_index != next_slot);
                    let Some(receipt) = self.stage_at(
                        compositor,
                        decode_target_seconds,
                        effective_tolerance_seconds,
                    )?
                    else {
                        return Ok(None);
                    };
                    let slot_index = receipt["frameRingSlot"]
                        .as_u64()
                        .context("decoded temporal staged frame has no resident ring slot")?
                        as usize;
                    self.temporal_source_cache
                        .insert(decode_key, (slot_index, receipt.clone()));
                    (receipt, slot_index, false)
                };
            let object = receipt
                .as_object_mut()
                .context("decoded temporal frame receipt must be an object")?;
            object.insert("temporalTargetSeconds".into(), serde_json::json!(target));
            object.insert(
                "temporalDecodeTargetSeconds".into(),
                serde_json::json!(decode_target_seconds),
            );
            object.insert(
                "temporalSourceCacheHit".into(),
                serde_json::json!(cache_hit),
            );
            object.insert(
                "temporalEffectiveToleranceSeconds".into(),
                serde_json::json!(effective_tolerance_seconds),
            );
            receipts.push(receipt);
            slot_indices.push(slot_index);
        }
        Ok(Some((receipts, slot_indices, effective_tolerance_seconds)))
    }

    fn temporal_sampling_receipt(
        &self,
        receipts: &[serde_json::Value],
        slot_indices: &[usize],
        target_seconds: &[f64],
        requested_tolerance_seconds: f64,
        effective_tolerance_seconds: f64,
    ) -> serde_json::Value {
        let distinct_timestamps = receipts
            .iter()
            .filter_map(|receipt| receipt["timestampSeconds"].as_f64())
            .map(|seconds| (seconds * 10_000_000.0).round() as i64)
            .collect::<std::collections::BTreeSet<_>>();
        let cache_hit_count = receipts
            .iter()
            .filter(|receipt| receipt["temporalSourceCacheHit"].as_bool() == Some(true))
            .count();
        let sample_receipts = receipts
            .iter()
            .zip(slot_indices)
            .zip(target_seconds)
            .map(|((receipt, slot_index), target)| {
                serde_json::json!({
                    "targetSeconds": target,
                    "decodeTargetSeconds": receipt["temporalDecodeTargetSeconds"],
                    "decodedTimestampSeconds": receipt["timestampSeconds"],
                    "sourceTimestampSeconds": receipt["sourceTimestampSeconds"],
                    "slotIndex": slot_index,
                    "cacheHit": receipt["temporalSourceCacheHit"],
                    "clockWithinTolerance": receipt["clockWithinTolerance"],
                    "gpuSubmissionSequence": receipt["gpuSubmissionSequence"]
                })
            })
            .collect::<Vec<_>>();
        let resident_bytes = self.frame_ring.len() as u64
            * u64::from(self.decode.visible_width)
            * u64::from(self.decode.visible_height)
            * 3
            * 4;
        serde_json::json!({
            "schema": "editkin.decoded-temporal-shutter-window/v1",
            "contract": "decoded-temporal-shutter-accumulation/v1",
            "sourceSampling": "decoded_temporal",
            "sampleCount": receipts.len(),
            "sampleReceipts": sample_receipts,
            "distinctDecodedTimestampCount": distinct_timestamps.len(),
            "residentFrameRingSize": self.frame_ring.len(),
            "residentBytes": resident_bytes,
            "gpuCopyCount": receipts.len() - cache_hit_count,
            "cacheHitCount": cache_hit_count,
            "requestedToleranceSeconds": requested_tolerance_seconds,
            "effectiveToleranceSeconds": effective_tolerance_seconds,
            "decodePathCpuPixelCopies": 0,
            "stagingCpuPixelReadbacks": 0,
            "productPathCpuPixelCopies": 0
        })
    }

    pub(super) fn stage_temporal_at(
        &mut self,
        compositor: &GpuCompositor,
        target_seconds: &[f64],
        tolerance_seconds: f64,
    ) -> Result<Option<(serde_json::Value, Vec<usize>)>> {
        let Some((receipts, slot_indices, effective_tolerance_seconds)) =
            self.stage_temporal_window(compositor, target_seconds, tolerance_seconds)?
        else {
            return Ok(None);
        };
        let mut primary = receipts[receipts.len() / 2].clone();
        let temporal = self.temporal_sampling_receipt(
            &receipts,
            &slot_indices,
            target_seconds,
            tolerance_seconds,
            effective_tolerance_seconds,
        );
        primary
            .as_object_mut()
            .context("decoded temporal staged receipt must be an object")?
            .insert("temporalSampling".into(), temporal);
        Ok(Some((primary, slot_indices)))
    }

    pub(super) fn staged_temporal_surface_layer(
        &self,
        slot_indices: &[usize],
        style: VideoVisualStyle,
    ) -> Result<VideoSurfaceLayer<'_>> {
        if !(2..=8).contains(&slot_indices.len()) {
            bail!("decoded temporal surface layer requires 2..=8 resident slots");
        }
        let first = self
            .frame_ring
            .get(slot_indices[0])
            .context("decoded temporal surface first slot is out of bounds")?;
        let mut sources = [&first.staged_texture; 8];
        for (index, slot_index) in slot_indices.iter().enumerate() {
            sources[index] = &self
                .frame_ring
                .get(*slot_index)
                .context("decoded temporal surface slot is out of bounds")?
                .staged_texture;
        }
        Ok(VideoSurfaceLayer {
            source: sources[0],
            temporal_sources: Some(sources),
            source_width: self.decode.visible_width,
            source_height: self.decode.visible_height,
            style,
            matte: None,
        })
    }

    pub(super) fn present_temporal_at_styled(
        &mut self,
        compositor: &GpuCompositor,
        target_seconds: &[f64],
        tolerance_seconds: f64,
        surface: &mut NativePreviewSurface,
        style: VideoVisualStyle,
    ) -> Result<Option<serde_json::Value>> {
        let Some((receipts, slot_indices, effective_tolerance_seconds)) =
            self.stage_temporal_window(compositor, target_seconds, tolerance_seconds)?
        else {
            return Ok(None);
        };
        let sources = slot_indices
            .iter()
            .map(|slot_index| {
                self.frame_ring
                    .get(*slot_index)
                    .map(|slot| &slot.staged_texture)
                    .context("decoded temporal present slot is out of bounds")
            })
            .collect::<Result<Vec<_>>>()?;
        let mut encoder =
            compositor
                .device
                .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                    label: Some("Editkin decoded temporal shutter present"),
                });
        let frame = surface.encode_present(
            compositor,
            sources[0],
            self.decode.visible_width,
            self.decode.visible_height,
            style,
            Some(&sources),
            &mut encoder,
        )?;
        compositor.queue.submit([encoder.finish()]);
        compositor.queue.present(frame);
        surface.presented();
        let mut primary = receipts[receipts.len() / 2].clone();
        let temporal = self.temporal_sampling_receipt(
            &receipts,
            &slot_indices,
            target_seconds,
            tolerance_seconds,
            effective_tolerance_seconds,
        );
        let object = primary
            .as_object_mut()
            .context("decoded temporal primary receipt must be an object")?;
        object.insert("nativeSurfacePresented".into(), serde_json::json!(true));
        object.insert(
            "nativeSurfacePresentCount".into(),
            serde_json::json!(surface.present_count),
        );
        object.insert("temporalSampling".into(), temporal);
        Ok(Some(primary))
    }

    pub(super) fn verify_temporal_at(
        &mut self,
        compositor: &GpuCompositor,
        target_seconds: &[f64],
        tolerance_seconds: f64,
        surface: &NativePreviewSurface,
        style: VideoVisualStyle,
        output_path: &Path,
    ) -> Result<Option<serde_json::Value>> {
        let Some((receipts, slot_indices, effective_tolerance_seconds)) =
            self.stage_temporal_window(compositor, target_seconds, tolerance_seconds)?
        else {
            return Ok(None);
        };
        let sources = slot_indices
            .iter()
            .map(|slot_index| {
                self.frame_ring
                    .get(*slot_index)
                    .map(|slot| &slot.staged_texture)
                    .context("decoded temporal verify slot is out of bounds")
            })
            .collect::<Result<Vec<_>>>()?;
        let verification = surface.verify_texture(
            compositor,
            sources[0],
            self.decode.visible_width,
            self.decode.visible_height,
            style,
            Some(&sources),
            output_path,
        )?;
        let mut primary = receipts[receipts.len() / 2].clone();
        let temporal = self.temporal_sampling_receipt(
            &receipts,
            &slot_indices,
            target_seconds,
            tolerance_seconds,
            effective_tolerance_seconds,
        );
        let object = primary
            .as_object_mut()
            .context("decoded temporal verification receipt must be an object")?;
        object.insert("verification".into(), verification.clone());
        object.insert("temporalSampling".into(), temporal);
        for key in [
            "verificationReadback",
            "productPathCpuPixelCopies",
            "outputWritten",
            "outputHash",
            "visualGraph",
        ] {
            object.insert(key.into(), verification[key].clone());
        }
        Ok(Some(primary))
    }

    pub(super) fn present_at(
        &mut self,
        compositor: &GpuCompositor,
        target_seconds: f64,
        tolerance_seconds: f64,
        surface: &mut NativePreviewSurface,
    ) -> Result<Option<serde_json::Value>> {
        self.present_at_styled(
            compositor,
            target_seconds,
            tolerance_seconds,
            surface,
            VideoVisualStyle::default(),
        )
    }

    pub(super) fn present_at_styled(
        &mut self,
        compositor: &GpuCompositor,
        target_seconds: f64,
        tolerance_seconds: f64,
        surface: &mut NativePreviewSurface,
        style: VideoVisualStyle,
    ) -> Result<Option<serde_json::Value>> {
        self.stage_at_internal(
            compositor,
            target_seconds,
            tolerance_seconds,
            Some(surface),
            style,
        )
    }

    fn prepare_clocked_stage(
        &mut self,
        compositor: &GpuCompositor,
        target_seconds: f64,
        tolerance_seconds: f64,
    ) -> Result<Option<PreparedClockedStage>> {
        if !target_seconds.is_finite() || target_seconds < 0.0 {
            bail!("video staging clock targetSeconds must be a finite non-negative number");
        }
        if !tolerance_seconds.is_finite() || tolerance_seconds <= 0.0 || tolerance_seconds > 0.25 {
            bail!("video staging clock toleranceSeconds must be finite and within (0, 0.25]");
        }
        let target_100ns = (target_seconds * 10_000_000.0).round() as i64;
        let tolerance_100ns = (tolerance_seconds * 10_000_000.0).round() as i64;
        let seek_threshold_100ns = 2_500_000_i64;
        let must_seek = match self.last_timestamp_100ns {
            Some(last) => {
                last > target_100ns + tolerance_100ns
                    || target_100ns.saturating_sub(last) > seek_threshold_100ns
            }
            None => target_100ns > seek_threshold_100ns,
        };
        if must_seek {
            self.seek((target_seconds - tolerance_seconds).max(0.0))?;
        }

        let mut dropped_for_clock = 0_u64;
        for _ in 0..600 {
            let Some((frame, frame_index, slot_index)) = self.prepare_stage_one(compositor)? else {
                return Ok(None);
            };
            if frame
                .timestamp_100ns
                .saturating_add(tolerance_100ns)
                .saturating_add(CLOCK_ROUNDING_EPSILON_100NS)
                < target_100ns
            {
                dropped_for_clock += 1;
                continue;
            }
            self.total_clock_dropped_frames += dropped_for_clock;
            return Ok(Some(PreparedClockedStage {
                frame,
                frame_index,
                slot_index,
                target_seconds,
                tolerance_seconds,
                dropped_for_clock,
                must_seek,
            }));
        }
        bail!("video staging clock selection exceeded 600 decoded frames without reaching target")
    }

    fn prepared_stage_receipt(&self, prepared: &PreparedClockedStage) -> serde_json::Value {
        let frame = &prepared.frame;
        let target_100ns = (prepared.target_seconds * 10_000_000.0).round() as i64;
        let tolerance_100ns = (prepared.tolerance_seconds * 10_000_000.0).round() as i64;
        let drift_100ns = frame.timestamp_100ns - target_100ns;
        let drift_ms = drift_100ns as f64 / 10_000.0;
        serde_json::json!({
            "frameIndex": prepared.frame_index,
            "frameRingSlot": prepared.slot_index,
            "residentFrameRingSize": self.frame_ring.len(),
            "width": frame.width,
            "height": frame.height,
            "decoderSurfaceWidth": frame.decoder_surface_width,
            "decoderSurfaceHeight": frame.decoder_surface_height,
            "sourceDxgiFormat": frame.source_dxgi_format,
            "sharedDxgiFormat": DXGI_FORMAT_B8G8R8A8_UNORM.0,
            "timestampSeconds": frame.timestamp_100ns as f64 / 10_000_000.0,
            "sourceTimestampSeconds": frame.source_timestamp_100ns as f64 / 10_000_000.0,
            "decodePathCpuPixelCopies": 0,
            "stagingCpuPixelReadbacks": 0,
            "verificationReadback": false,
            "outputWritten": false,
            "gpuProcessingPasses": 2,
            "gpuSurfaceResident": true,
            "gpuSubmissionSequence": frame.submission_sequence,
            "retiredSubmissionSequence": frame.retired_submission_sequence,
            "gpuFencePending": true,
            "crossApiSharedFence": true,
            "crossApiFenceValue": frame.cross_api_fence_value,
            "crossApiProducerCpuWaits": 0,
            "nativeSurfacePresented": frame.native_surface_presented,
            "nativeSurfacePresentCount": frame.native_surface_present_count,
            "nativeSurfaceCpuPixelReadbacks": 0,
            "clockTargetSeconds": prepared.target_seconds,
            "clockToleranceSeconds": prepared.tolerance_seconds,
            "clockDriftMilliseconds": drift_ms,
            "clockDroppedFrames": prepared.dropped_for_clock,
            "totalClockDroppedFrames": self.total_clock_dropped_frames,
            "clockSeeked": prepared.must_seek,
            "clockWithinTolerance": drift_100ns.abs() <= tolerance_100ns + CLOCK_RECEIPT_EPSILON_100NS,
            "endOfStream": false,
        })
    }

    fn stage_at_internal(
        &mut self,
        compositor: &GpuCompositor,
        target_seconds: f64,
        tolerance_seconds: f64,
        mut surface: Option<&mut NativePreviewSurface>,
        style: VideoVisualStyle,
    ) -> Result<Option<serde_json::Value>> {
        let Some(mut prepared) =
            self.prepare_clocked_stage(compositor, target_seconds, tolerance_seconds)?
        else {
            return Ok(None);
        };
        let mut encoder =
            compositor
                .device
                .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                    label: Some("Editkin stage decoded frame without CPU readback"),
                });
        self.encode_prepared_copy(prepared.slot_index, &mut encoder)?;
        let presented_frame = if let Some(surface) = surface.as_deref_mut() {
            let slot = self
                .frame_ring
                .get(prepared.slot_index)
                .context("prepared present frame ring slot is out of bounds")?;
            Some(surface.encode_present(
                compositor,
                &slot.staged_texture,
                self.decode.visible_width,
                self.decode.visible_height,
                style,
                None,
                &mut encoder,
            )?)
        } else {
            None
        };
        let submission_index = compositor.queue.submit([encoder.finish()]);
        if let Some(frame) = presented_frame {
            compositor.queue.present(frame);
            let surface = surface
                .as_deref_mut()
                .context("native preview surface disappeared before present")?;
            surface.presented();
            prepared.frame.native_surface_presented = true;
            prepared.frame.native_surface_present_count = Some(surface.present_count);
        }
        self.complete_prepared_submission(
            prepared.slot_index,
            submission_index,
            prepared.frame.submission_sequence,
        )?;
        Ok(Some(self.prepared_stage_receipt(&prepared)))
    }

    pub(super) fn verify_at(
        &mut self,
        compositor: &GpuCompositor,
        target_seconds: f64,
        tolerance_seconds: f64,
        surface: &NativePreviewSurface,
        style: VideoVisualStyle,
        output_path: &Path,
    ) -> Result<Option<serde_json::Value>> {
        let Some(mut receipt) =
            self.stage_at_internal(compositor, target_seconds, tolerance_seconds, None, style)?
        else {
            return Ok(None);
        };
        let slot_index = receipt
            .get("frameRingSlot")
            .and_then(serde_json::Value::as_u64)
            .context("staged verification frame has no ring slot")?
            as usize;
        let slot = self
            .frame_ring
            .get(slot_index)
            .context("staged verification frame ring slot is out of bounds")?;
        let verification = surface.verify_texture(
            compositor,
            &slot.staged_texture,
            self.decode.visible_width,
            self.decode.visible_height,
            style,
            None,
            output_path,
        )?;
        let object = receipt
            .as_object_mut()
            .context("staged verification receipt must be an object")?;
        object.insert("verification".into(), verification.clone());
        for key in [
            "verificationReadback",
            "productPathCpuPixelCopies",
            "outputWritten",
            "outputHash",
            "visualGraph",
        ] {
            object.insert(key.into(), verification[key].clone());
        }
        Ok(Some(receipt))
    }

    pub(super) fn flush_staged_fences(
        &mut self,
        compositor: &GpuCompositor,
    ) -> Result<serde_json::Value> {
        let mut retired = Vec::new();
        for slot in &mut self.frame_ring {
            if let Some(sequence) = retire_pending_submission(compositor, slot)? {
                retired.push(sequence);
            }
        }
        Ok(serde_json::json!({
            "retiredFenceCount": retired.len(),
            "retiredSubmissionSequences": retired,
            "pendingFenceCount": self.frame_ring.iter().filter(|slot| slot.pending_submission.is_some()).count(),
        }))
    }

    pub(super) fn seek(&mut self, time_seconds: f64) -> Result<serde_json::Value> {
        if !time_seconds.is_finite() || time_seconds < 0.0 {
            bail!("video seek timeSeconds must be a finite non-negative number");
        }
        let clock_position_100ns = (time_seconds * 10_000_000.0).round() as i64;
        let source_position_100ns = if clock_position_100ns == 0 {
            0
        } else {
            clock_position_100ns
                .saturating_add(self.source_timestamp_origin_100ns)
                .max(0)
        };
        let position = PROPVARIANT::from(source_position_100ns);
        let default_time_format = GUID::zeroed();
        let video_stream = MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32;
        unsafe { self.decode.reader.Flush(video_stream) }
            .context("flush Media Foundation source reader before seek")?;
        unsafe {
            self.decode
                .reader
                .SetCurrentPosition(&default_time_format, &position)
        }
        .context("seek Media Foundation source reader")?;
        self.ended = false;
        self.minimum_timestamp_100ns = Some(source_position_100ns);
        self.last_timestamp_100ns = None;
        Ok(serde_json::json!({
            "seeked": true,
            "timeSeconds": time_seconds,
            "position100ns": source_position_100ns,
            "clockPosition100ns": clock_position_100ns,
            "sourceTimestampOrigin100ns": self.source_timestamp_origin_100ns,
        }))
    }
}

pub(super) fn stage_video_sessions_at(
    compositor: &GpuCompositor,
    sessions: &mut [&mut VideoInteropSession],
    target_seconds: f64,
    tolerance_seconds: f64,
) -> Result<Vec<Option<serde_json::Value>>> {
    if sessions.is_empty() || sessions.len() > 192 {
        bail!("batched resident video staging requires 1..=192 sessions");
    }
    let mut prepared = Vec::with_capacity(sessions.len());
    let mut decode_prepare_milliseconds = Vec::with_capacity(sessions.len());
    for session in sessions.iter_mut() {
        let started_at = Instant::now();
        prepared.push(session.prepare_clocked_stage(
            compositor,
            target_seconds,
            tolerance_seconds,
        )?);
        decode_prepare_milliseconds.push(started_at.elapsed().as_secs_f64() * 1_000.0);
    }
    let copy_count = prepared.iter().filter(|frame| frame.is_some()).count();
    let mut gpu_submit_cpu_milliseconds = 0.0;
    if copy_count > 0 {
        let submit_started_at = Instant::now();
        let mut encoder =
            compositor
                .device
                .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                    label: Some("Editkin batch stage resident video sessions"),
                });
        for (session, frame) in sessions.iter().zip(&prepared) {
            if let Some(frame) = frame {
                session.encode_prepared_copy(frame.slot_index, &mut encoder)?;
            }
        }
        let submission_index = compositor.queue.submit([encoder.finish()]);
        for (session, frame) in sessions.iter_mut().zip(&prepared) {
            if let Some(frame) = frame {
                session.complete_prepared_submission(
                    frame.slot_index,
                    submission_index.clone(),
                    frame.frame.submission_sequence,
                )?;
            }
        }
        gpu_submit_cpu_milliseconds = submit_started_at.elapsed().as_secs_f64() * 1_000.0;
    }
    Ok(sessions
        .iter()
        .zip(prepared)
        .zip(decode_prepare_milliseconds)
        .map(|((session, frame), decode_prepare_milliseconds)| {
            frame.map(|frame| {
                let mut receipt = session.prepared_stage_receipt(&frame);
                if let Some(object) = receipt.as_object_mut() {
                    object.insert(
                        "gpuCopySubmissionMode".into(),
                        serde_json::json!("batched-copy/v1"),
                    );
                    object.insert(
                        "gpuCopySubmissionLayerCount".into(),
                        serde_json::json!(copy_count),
                    );
                    object.insert(
                        "decodePrepareMilliseconds".into(),
                        serde_json::json!(decode_prepare_milliseconds),
                    );
                    object.insert(
                        "batchGpuSubmitCpuMilliseconds".into(),
                        serde_json::json!(gpu_submit_cpu_milliseconds),
                    );
                }
                receipt
            })
        })
        .collect())
}

struct VideoWorkerInitialization {
    description: serde_json::Value,
    width: u32,
    height: u32,
    wrapped_textures: Vec<wgpu::Texture>,
    staged_textures: Vec<wgpu::Texture>,
}

struct VideoWorkerPreparedStage {
    slot_index: usize,
    submission_sequence: u64,
    receipt: serde_json::Value,
    requires_copy: bool,
}

enum VideoWorkerCommand {
    Prepare {
        target_seconds: f64,
        tolerance_seconds: f64,
    },
    Complete {
        index: wgpu::SubmissionIndex,
        sequence: u64,
    },
    Flush,
    Shutdown,
}

enum VideoWorkerResponse {
    Prepared(Result<Option<VideoWorkerPreparedStage>>),
    Completed(Result<()>),
    Flushed(Result<serde_json::Value>),
}

/// One decoder owns one MTA COM apartment for its complete lifetime. Decode/video-processing
/// work can therefore run concurrently without moving `IMFSourceReader`, D3D11 contexts or
/// shared HANDLE owners across threads. Only Send-safe wgpu handles and typed receipts cross the
/// channel boundary; all prepared copies are still submitted together on the product queue.
pub(super) struct VideoInteropWorker {
    command_tx: mpsc::Sender<VideoWorkerCommand>,
    response_rx: mpsc::Receiver<VideoWorkerResponse>,
    thread: Option<JoinHandle<()>>,
    description: serde_json::Value,
    width: u32,
    height: u32,
    wrapped_textures: Vec<wgpu::Texture>,
    staged_textures: Vec<wgpu::Texture>,
    instance_id: u64,
}

static NEXT_VIDEO_WORKER_INSTANCE_ID: AtomicU64 = AtomicU64::new(1);

impl VideoInteropWorker {
    pub(super) fn open(compositor: &GpuCompositor, input: &Path, ring_size: usize) -> Result<Self> {
        let input = PathBuf::from(input);
        let worker_compositor = compositor.clone();
        let (command_tx, command_rx) = mpsc::channel();
        let (response_tx, response_rx) = mpsc::channel();
        let (initialization_tx, initialization_rx) = mpsc::sync_channel(1);
        let thread = thread::Builder::new()
            .name("editkin-video-decoder".into())
            .spawn(move || {
                let mut session = match VideoInteropSession::open_with_ring_size(
                    &worker_compositor,
                    &input,
                    ring_size,
                ) {
                    Ok(session) => session,
                    Err(error) => {
                        let _ = initialization_tx.send(Err(error));
                        return;
                    }
                };
                let (width, height) = session.dimensions();
                let initialization = VideoWorkerInitialization {
                    description: session.description(),
                    width,
                    height,
                    wrapped_textures: session
                        .frame_ring
                        .iter()
                        .map(|slot| slot.wrapped.clone())
                        .collect(),
                    staged_textures: session
                        .frame_ring
                        .iter()
                        .map(|slot| slot.staged_texture.clone())
                        .collect(),
                };
                if initialization_tx.send(Ok(initialization)).is_err() {
                    return;
                }
                let mut pending_prepared: Vec<(i64, PreparedClockedStage)> = Vec::new();
                let mut source_cache: BTreeMap<i64, (usize, serde_json::Value)> = BTreeMap::new();
                while let Ok(command) = command_rx.recv() {
                    match command {
                        VideoWorkerCommand::Prepare { target_seconds, tolerance_seconds } => {
                            let prepare_started_at = Instant::now();
                            let mut result = (|| -> Result<Option<VideoWorkerPreparedStage>> {
                                let target_key = (target_seconds * 10_000_000.0).round() as i64;
                                if let Some((slot_index, cached_receipt)) = source_cache.get(&target_key) {
                                    let mut receipt = cached_receipt.clone();
                                    if let Some(object) = receipt.as_object_mut() {
                                        object.insert("decoderSourceCacheHit".into(), serde_json::json!(true));
                                    }
                                    return Ok(Some(VideoWorkerPreparedStage {
                                        slot_index: *slot_index,
                                        submission_sequence: receipt["gpuSubmissionSequence"]
                                            .as_u64()
                                            .context("cached decoder receipt has no submission sequence")?,
                                        receipt,
                                        requires_copy: false,
                                    }));
                                }
                                let prepared = session.prepare_clocked_stage(
                                    &worker_compositor,
                                    target_seconds,
                                    tolerance_seconds,
                                )?;
                                let Some(prepared) = prepared else { return Ok(None); };
                                source_cache.retain(|_, (slot_index, _)| *slot_index != prepared.slot_index);
                                let mut receipt = session.prepared_stage_receipt(&prepared);
                                if let Some(object) = receipt.as_object_mut() {
                                    object.insert("decoderSourceCacheHit".into(), serde_json::json!(false));
                                }
                                let result = VideoWorkerPreparedStage {
                                    slot_index: prepared.slot_index,
                                    submission_sequence: prepared.frame.submission_sequence,
                                    receipt,
                                    requires_copy: true,
                                };
                                pending_prepared.push((target_key, prepared));
                                Ok(Some(result))
                            })();
                            if let Ok(Some(prepared)) = &mut result {
                                if let Some(object) = prepared.receipt.as_object_mut() {
                                    object.insert(
                                        "decodePrepareMilliseconds".into(),
                                        serde_json::json!(prepare_started_at.elapsed().as_secs_f64() * 1_000.0),
                                    );
                                }
                            }
                            if response_tx.send(VideoWorkerResponse::Prepared(result)).is_err() { break; }
                        }
                        VideoWorkerCommand::Complete { index, sequence } => {
                            let result = (|| -> Result<()> {
                                let position = pending_prepared
                                    .iter()
                                    .position(|(_, prepared)| prepared.frame.submission_sequence == sequence)
                                    .context("decoder worker has no matching prepared GPU copy to complete")?;
                                let (target_key, prepared) = pending_prepared.remove(position);
                                session.complete_prepared_submission(prepared.slot_index, index, sequence)?;
                                source_cache.insert(
                                    target_key,
                                    (prepared.slot_index, session.prepared_stage_receipt(&prepared)),
                                );
                                Ok(())
                            })();
                            if response_tx.send(VideoWorkerResponse::Completed(result)).is_err() { break; }
                        }
                        VideoWorkerCommand::Flush => {
                            let result = session.flush_staged_fences(&worker_compositor);
                            if response_tx.send(VideoWorkerResponse::Flushed(result)).is_err() { break; }
                        }
                        VideoWorkerCommand::Shutdown => break,
                    }
                }
            })
            .context("spawn resident Media Foundation decoder worker")?;
        let initialization = initialization_rx
            .recv()
            .context("decoder worker exited before initialization")??;
        Ok(Self {
            command_tx,
            response_rx,
            thread: Some(thread),
            description: initialization.description,
            width: initialization.width,
            height: initialization.height,
            wrapped_textures: initialization.wrapped_textures,
            staged_textures: initialization.staged_textures,
            instance_id: NEXT_VIDEO_WORKER_INSTANCE_ID.fetch_add(1, Ordering::Relaxed),
        })
    }

    pub(super) fn description(&self) -> serde_json::Value {
        let mut description = self.description.clone();
        if let Some(object) = description.as_object_mut() {
            object.insert(
                "decodeDispatchMode".into(),
                serde_json::json!("parallel-com-apartment/v1"),
            );
            object.insert(
                "decoderInstanceId".into(),
                serde_json::json!(self.instance_id),
            );
            object.insert(
                "sourceCacheSchema".into(),
                serde_json::json!("editkin.shared-source-frame-cache/v1"),
            );
        }
        description
    }

    pub(super) fn dimensions(&self) -> (u32, u32) {
        (self.width, self.height)
    }

    pub(super) fn frame_rate(&self) -> (u32, u32) {
        let values = self.description["frameRate"].as_array();
        (
            values
                .and_then(|items| items.first())
                .and_then(serde_json::Value::as_u64)
                .unwrap_or(0) as u32,
            values
                .and_then(|items| items.get(1))
                .and_then(serde_json::Value::as_u64)
                .unwrap_or(0) as u32,
        )
    }

    fn begin_prepare(&self, target_seconds: f64, tolerance_seconds: f64) -> Result<()> {
        self.command_tx
            .send(VideoWorkerCommand::Prepare {
                target_seconds,
                tolerance_seconds,
            })
            .context("dispatch parallel resident video decode")
    }

    fn finish_prepare(&self) -> Result<Option<VideoWorkerPreparedStage>> {
        match self
            .response_rx
            .recv()
            .context("parallel resident video decoder stopped")?
        {
            VideoWorkerResponse::Prepared(result) => result,
            _ => bail!("parallel resident video decoder returned an unexpected response"),
        }
    }

    fn encode_prepared_copy(
        &self,
        slot_index: usize,
        encoder: &mut wgpu::CommandEncoder,
    ) -> Result<()> {
        let source = self
            .wrapped_textures
            .get(slot_index)
            .context("worker wrapped frame slot is out of bounds")?;
        let destination = self
            .staged_textures
            .get(slot_index)
            .context("worker staged frame slot is out of bounds")?;
        encoder.copy_texture_to_texture(
            wgpu::TexelCopyTextureInfo {
                texture: source,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::TexelCopyTextureInfo {
                texture: destination,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::Extent3d {
                width: self.width,
                height: self.height,
                depth_or_array_layers: 1,
            },
        );
        Ok(())
    }

    fn begin_complete(&self, index: wgpu::SubmissionIndex, sequence: u64) -> Result<()> {
        self.command_tx
            .send(VideoWorkerCommand::Complete { index, sequence })
            .context("complete parallel resident video GPU copy")
    }

    fn finish_complete(&self) -> Result<()> {
        match self
            .response_rx
            .recv()
            .context("parallel resident video decoder stopped during completion")?
        {
            VideoWorkerResponse::Completed(result) => result,
            _ => {
                bail!("parallel resident video decoder returned an unexpected completion response")
            }
        }
    }

    pub(super) fn staged_surface_layer(
        &self,
        slot_index: usize,
        style: VideoVisualStyle,
    ) -> Result<VideoSurfaceLayer<'_>> {
        let source = self
            .staged_textures
            .get(slot_index)
            .context("worker staged surface slot is out of bounds")?;
        Ok(VideoSurfaceLayer {
            source,
            temporal_sources: None,
            source_width: self.width,
            source_height: self.height,
            style,
            matte: None,
        })
    }

    pub(super) fn flush_staged_fences(&self) -> Result<serde_json::Value> {
        self.command_tx
            .send(VideoWorkerCommand::Flush)
            .context("flush decoder worker fences")?;
        match self
            .response_rx
            .recv()
            .context("decoder worker stopped during fence flush")?
        {
            VideoWorkerResponse::Flushed(result) => result,
            _ => bail!("decoder worker returned an unexpected fence response"),
        }
    }
}

impl Drop for VideoInteropWorker {
    fn drop(&mut self) {
        let _ = self.command_tx.send(VideoWorkerCommand::Shutdown);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

pub(super) fn stage_video_workers_at(
    compositor: &GpuCompositor,
    workers: &[&VideoInteropWorker],
    target_seconds: &[f64],
    tolerance_seconds: &[f64],
) -> Result<Vec<Option<serde_json::Value>>> {
    if workers.is_empty()
        || workers.len() != target_seconds.len()
        || workers.len() != tolerance_seconds.len()
    {
        bail!(
            "parallel common-video staging requires matching non-empty workers, clocks and tolerances"
        );
    }
    // This hardware gate deliberately keeps one Media Foundation prepare active at a time: two
    // simultaneous decoder apartments increase tail latency on the supported RTX 2060 baseline,
    // even when the concurrent inputs are half-resolution proxies.
    let dispatch_width = 1_usize;
    let mut prepared = Vec::with_capacity(workers.len());
    for offset in (0..workers.len()).step_by(dispatch_width) {
        let end = (offset + dispatch_width).min(workers.len());
        for ((worker, target), tolerance) in workers[offset..end]
            .iter()
            .zip(&target_seconds[offset..end])
            .zip(&tolerance_seconds[offset..end])
        {
            worker.begin_prepare(*target, *tolerance)?;
        }
        for worker in &workers[offset..end] {
            prepared.push(worker.finish_prepare()?);
        }
    }
    let copy_count = prepared
        .iter()
        .filter(|frame| frame.as_ref().is_some_and(|frame| frame.requires_copy))
        .count();
    if copy_count > 0 {
        let mut encoder =
            compositor
                .device
                .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                    label: Some("Editkin batch stage parallel-decoded common-video layers"),
                });
        for (worker, frame) in workers.iter().zip(&prepared) {
            if let Some(frame) = frame.as_ref().filter(|frame| frame.requires_copy) {
                worker.encode_prepared_copy(frame.slot_index, &mut encoder)?;
            }
        }
        let submission_index = compositor.queue.submit([encoder.finish()]);
        for (worker, frame) in workers.iter().zip(&prepared) {
            if let Some(frame) = frame.as_ref().filter(|frame| frame.requires_copy) {
                worker.begin_complete(submission_index.clone(), frame.submission_sequence)?;
            }
        }
        for (worker, frame) in workers.iter().zip(&prepared) {
            if frame.as_ref().is_some_and(|frame| frame.requires_copy) {
                worker.finish_complete()?;
            }
        }
    }
    Ok(prepared
        .into_iter()
        .map(|frame| {
            frame.map(|frame| {
                let mut receipt = frame.receipt;
                if let Some(object) = receipt.as_object_mut() {
                    object.insert(
                        "gpuCopySubmissionMode".into(),
                        serde_json::json!(if frame.requires_copy {
                            "batched-copy/v1"
                        } else {
                            "source-cache-hit/v1"
                        }),
                    );
                    object.insert(
                        "gpuCopySubmissionLayerCount".into(),
                        serde_json::json!(if frame.requires_copy { copy_count } else { 0 }),
                    );
                    object.insert(
                        "decodeDispatchMode".into(),
                        serde_json::json!("parallel-com-apartment/v1"),
                    );
                    object.insert(
                        "decodeDispatchWidth".into(),
                        serde_json::json!(dispatch_width),
                    );
                }
                receipt
            })
        })
        .collect())
}

fn create_resident_frame_slot(
    compositor: &GpuCompositor,
    decode: &DecodeContext,
) -> Result<ResidentFrameSlot> {
    let (shared_texture, wrapped, handle) = unsafe {
        create_d3d12_owned_shared_bgra(
            compositor,
            &decode.device,
            decode.visible_width,
            decode.visible_height,
        )
    }?;
    let processor_target =
        create_d3d11_bgra_target(&decode.device, decode.visible_width, decode.visible_height)?;
    let staged_texture = compositor.device.create_texture(&wgpu::TextureDescriptor {
        label: Some("Editkin resident decoded frame staging target"),
        size: wgpu::Extent3d {
            width: decode.visible_width,
            height: decode.visible_height,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Bgra8Unorm,
        usage: wgpu::TextureUsages::COPY_DST
            | wgpu::TextureUsages::COPY_SRC
            | wgpu::TextureUsages::TEXTURE_BINDING,
        view_formats: &[],
    });
    Ok(ResidentFrameSlot {
        shared_texture,
        wrapped,
        staged_texture,
        pending_submission: None,
        _handle: handle,
        processor_target,
    })
}

pub(super) fn run(
    compositor: &GpuCompositor,
    input: &Path,
    requested_frames: usize,
    report_path: &Path,
) -> Result<()> {
    if !input.is_file() {
        bail!("decode input does not exist: {}", input.display());
    }

    let _com = ComGuard::start()?;
    let _mf = MediaFoundationGuard::start()?;
    eprintln!("decode-interop: initialize DX12/D3D11/Media Foundation");
    let decode = unsafe { create_decode_context(compositor, input) }?;
    let mut hashes = Vec::with_capacity(requested_frames);
    let mut producer_hashes = Vec::with_capacity(requested_frames);
    let mut decoded = 0usize;
    let mut shared = 0usize;
    let mut imported = 0usize;
    let mut consumed = 0usize;
    let mut dropped = 0usize;
    let mut output_size = None;
    let mut decoder_surface_size = None;
    let mut source_format = None;

    while decoded < requested_frames {
        let Some(frame) = process_next_frame(compositor, &decode, None)? else {
            break;
        };
        decoded += 1;
        eprintln!("decode-interop: decoded DXGI frame {decoded}/{requested_frames}");
        shared += 1;
        eprintln!(
            "decode-interop: copied frame {decoded} into shared GPU texture ({})",
            frame.producer_hash
        );
        producer_hashes.push(frame.producer_hash);

        imported += 1;
        eprintln!("decode-interop: imported frame {decoded} into wgpu");
        hashes.push(frame.consumer_hash);
        consumed += 1;
        eprintln!("decode-interop: consumed frame {decoded} through wgpu");
        dropped += 1;
        output_size.get_or_insert((frame.width, frame.height));
        decoder_surface_size
            .get_or_insert((frame.decoder_surface_width, frame.decoder_surface_height));
        source_format.get_or_insert(frame.source_dxgi_format);
    }

    if decoded != requested_frames
        || shared != requested_frames
        || imported != requested_frames
        || consumed != requested_frames
        || dropped != requested_frames
    {
        bail!(
            "decode interop gate incomplete: requested={requested_frames}, decoded={decoded}, shared={shared}, imported={imported}, consumed={consumed}, dropped={dropped}"
        );
    }
    let (width, height) = output_size.context("decoder produced no DXGI frames")?;
    let (decoder_surface_width, decoder_surface_height) =
        decoder_surface_size.context("decoder produced no surface dimensions")?;
    let report = InteropReport {
        schema: REPORT_SCHEMA,
        decision: "GREEN",
        input: input
            .canonicalize()
            .unwrap_or_else(|_| input.to_path_buf())
            .display()
            .to_string(),
        adapter_name: compositor.adapter_name.clone(),
        backend: compositor.backend.clone(),
        adapter_luid: decode.adapter_luid,
        requested_frames,
        decoded_dxgi_frames: decoded,
        shared_texture_frames: shared,
        wgpu_imported_frames: imported,
        wgpu_consumed_frames: consumed,
        dropped_after_gpu_idle_frames: dropped,
        width,
        height,
        decoder_surface_width,
        decoder_surface_height,
        source_dxgi_format: source_format.unwrap_or_default(),
        shared_dxgi_format: DXGI_FORMAT_B8G8R8A8_UNORM.0,
        decode_path_cpu_pixel_copies: 0,
        gpu_processing_passes_per_frame: 2,
        verification_readback: true,
        verification_pixel_hashes: hashes,
        verification_d3d11_pixel_hashes: producer_hashes,
        synchronization: "D3D11 event query completes video processing and the shared-resource GPU copy before wgpu consumption; wgpu device idle precedes release",
        fallback_contract: "interop failure is fail-closed for this gate; product runtime must fall back to the existing software decode path",
        claim_boundary: "proves same-process GPU-resident decode, GPU NV12-to-BGRA processing, one GPU copy into a D3D12-owned NT shared texture, wgpu consumption, and safe drop; it does not claim a decoder-owned surface can be shared directly or that gate readback belongs in playback",
    };
    if let Some(parent) = report_path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("create report directory {}", parent.display()))?;
    }
    fs::write(report_path, serde_json::to_vec_pretty(&report)?)
        .with_context(|| format!("write {}", report_path.display()))?;
    println!("{}", serde_json::to_string(&report)?);
    Ok(())
}

fn process_next_frame(
    compositor: &GpuCompositor,
    decode: &DecodeContext,
    minimum_timestamp_100ns: Option<i64>,
) -> Result<Option<InteropFrame>> {
    let Some((source, source_subresource, timestamp_100ns)) =
        (unsafe { read_dxgi_frame(&decode.reader, minimum_timestamp_100ns) })?
    else {
        return Ok(None);
    };
    let mut desc = D3D11_TEXTURE2D_DESC::default();
    unsafe { source.GetDesc(&mut desc) };
    if desc.Format != DXGI_FORMAT_NV12 {
        bail!(
            "Media Foundation returned format {} instead of NV12 decoder output",
            desc.Format.0
        );
    }
    if decode.visible_width > desc.Width || decode.visible_height > desc.Height {
        bail!(
            "visible frame {}x{} exceeds decoder surface {}x{}",
            decode.visible_width,
            decode.visible_height,
            desc.Width,
            desc.Height
        );
    }
    let (shared_texture, wrapped, handle, producer_hash) = unsafe {
        convert_to_shared_bgra(
            compositor,
            &decode.device,
            &decode.context,
            &source,
            source_subresource,
            decode.visible_width,
            decode.visible_height,
        )
    }?;
    let (consumer_hash, rgba) = consume_bgra_with_wgpu(
        compositor,
        &wrapped,
        decode.visible_width,
        decode.visible_height,
    )?;
    if consumer_hash != producer_hash {
        bail!(
            "D3D11/wgpu shared-texture parity mismatch: producer={producer_hash}, consumer={consumer_hash}"
        );
    }
    drop(wrapped);
    compositor
        .device
        .poll(wgpu::PollType::wait_indefinitely())
        .context("wait before dropping imported shared texture")?;
    drop(handle);
    drop(shared_texture);
    Ok(Some(InteropFrame {
        width: decode.visible_width,
        height: decode.visible_height,
        decoder_surface_width: desc.Width,
        decoder_surface_height: desc.Height,
        source_dxgi_format: desc.Format.0,
        timestamp_100ns,
        source_timestamp_100ns: timestamp_100ns,
        producer_hash,
        consumer_hash,
        rgba,
    }))
}

fn process_next_frame_resident(
    compositor: &GpuCompositor,
    decode: &DecodeContext,
    minimum_timestamp_100ns: Option<i64>,
    slot: &ResidentFrameSlot,
) -> Result<Option<InteropFrame>> {
    let Some((source, source_subresource, timestamp_100ns)) =
        (unsafe { read_dxgi_frame(&decode.reader, minimum_timestamp_100ns) })?
    else {
        return Ok(None);
    };
    let mut desc = D3D11_TEXTURE2D_DESC::default();
    unsafe { source.GetDesc(&mut desc) };
    if desc.Format != DXGI_FORMAT_NV12 {
        bail!(
            "Media Foundation returned format {} instead of NV12 decoder output",
            desc.Format.0
        );
    }
    if decode.visible_width > desc.Width || decode.visible_height > desc.Height {
        bail!(
            "visible frame {}x{} exceeds decoder surface {}x{}",
            decode.visible_width,
            decode.visible_height,
            desc.Width,
            desc.Height
        );
    }
    unsafe {
        video_process_nv12_to_bgra(
            &decode.device,
            &decode.context,
            &source,
            source_subresource,
            &slot.processor_target,
            decode.visible_width,
            decode.visible_height,
        )?;
        decode
            .context
            .CopyResource(&slot.shared_texture, &slot.processor_target);
    }
    wait_for_d3d11(&decode.context, &decode.device)?;
    let producer_hash = verify_d3d11_bgra(
        &decode.device,
        &decode.context,
        &slot.shared_texture,
        decode.visible_width,
        decode.visible_height,
    )?;
    let (consumer_hash, rgba) = consume_bgra_with_wgpu(
        compositor,
        &slot.wrapped,
        decode.visible_width,
        decode.visible_height,
    )?;
    if consumer_hash != producer_hash {
        bail!(
            "resident frame-ring parity mismatch: producer={producer_hash}, consumer={consumer_hash}"
        );
    }
    Ok(Some(InteropFrame {
        width: decode.visible_width,
        height: decode.visible_height,
        decoder_surface_width: desc.Width,
        decoder_surface_height: desc.Height,
        source_dxgi_format: desc.Format.0,
        timestamp_100ns,
        source_timestamp_100ns: timestamp_100ns,
        producer_hash,
        consumer_hash,
        rgba,
    }))
}

fn retire_pending_submission(
    compositor: &GpuCompositor,
    slot: &mut ResidentFrameSlot,
) -> Result<Option<u64>> {
    let Some(pending) = slot.pending_submission.take() else {
        return Ok(None);
    };
    compositor
        .device
        .poll(wgpu::PollType::Wait {
            submission_index: Some(pending.index),
            timeout: Some(Duration::from_secs(5)),
        })
        .context("wait for resident decoded-frame staging fence")?;
    Ok(Some(pending.sequence))
}

fn prepare_next_frame_resident_staged(
    compositor: &GpuCompositor,
    decode: &DecodeContext,
    minimum_timestamp_100ns: Option<i64>,
    slot: &mut ResidentFrameSlot,
    cross_api_fence: &CrossApiSharedFence,
    submission_sequence: u64,
) -> Result<Option<StagedFrame>> {
    let retired_submission_sequence = retire_pending_submission(compositor, slot)?;
    let Some((source, source_subresource, timestamp_100ns)) =
        (unsafe { read_dxgi_frame(&decode.reader, minimum_timestamp_100ns) })?
    else {
        return Ok(None);
    };
    let mut desc = D3D11_TEXTURE2D_DESC::default();
    unsafe { source.GetDesc(&mut desc) };
    if desc.Format != DXGI_FORMAT_NV12 {
        bail!(
            "Media Foundation returned format {} instead of NV12 decoder output",
            desc.Format.0
        );
    }
    if decode.visible_width > desc.Width || decode.visible_height > desc.Height {
        bail!(
            "visible frame {}x{} exceeds decoder surface {}x{}",
            decode.visible_width,
            decode.visible_height,
            desc.Width,
            desc.Height
        );
    }
    unsafe {
        video_process_nv12_to_bgra(
            &decode.device,
            &decode.context,
            &source,
            source_subresource,
            &slot.processor_target,
            decode.visible_width,
            decode.visible_height,
        )?;
        decode
            .context
            .CopyResource(&slot.shared_texture, &slot.processor_target);
    }
    // Establish the D3D11 producer -> D3D12/wgpu consumer dependency entirely on the GPU.
    // The D3D11 signal and D3D12 queue wait share this frame's monotonic submission value.
    enqueue_cross_api_fence_wait(
        compositor,
        &decode.context,
        cross_api_fence,
        submission_sequence,
    )?;
    Ok(Some(StagedFrame {
        width: decode.visible_width,
        height: decode.visible_height,
        decoder_surface_width: desc.Width,
        decoder_surface_height: desc.Height,
        source_dxgi_format: desc.Format.0,
        timestamp_100ns,
        source_timestamp_100ns: timestamp_100ns,
        submission_sequence,
        retired_submission_sequence,
        cross_api_fence_value: submission_sequence,
        native_surface_presented: false,
        native_surface_present_count: None,
    }))
}

fn create_cross_api_shared_fence(
    compositor: &GpuCompositor,
    d3d11_device: &ID3D11Device,
) -> Result<CrossApiSharedFence> {
    let device5: ID3D11Device5 = d3d11_device
        .cast()
        .context("D3D11 device does not expose ID3D11Device5 shared fences")?;
    let mut producer = None;
    unsafe { device5.CreateFence(0, D3D11_FENCE_FLAG_SHARED, &mut producer) }
        .context("create D3D11 shared producer fence")?;
    let producer: ID3D11Fence = producer.context("D3D11 returned no shared producer fence")?;
    let handle = unsafe { producer.CreateSharedHandle(None, GENERIC_ALL.0, PCWSTR::null()) }
        .context("create shared handle for D3D11 producer fence")?;
    let handle = SharedHandle(Some(handle));
    let consumer: ID3D12Fence = {
        let hal_device = unsafe { compositor.device.as_hal::<wgpu::hal::api::Dx12>() }
            .context("wgpu device is not DX12 while opening shared fence")?;
        let mut consumer = None;
        unsafe {
            hal_device
                .raw_device()
                .OpenSharedHandle(handle.get()?, &mut consumer)
        }
        .context("open D3D11 shared fence on D3D12 device")?;
        consumer.context("D3D12 returned no consumer fence")?
    };
    Ok(CrossApiSharedFence {
        producer,
        consumer,
        _handle: handle,
    })
}

fn enqueue_cross_api_fence_wait(
    compositor: &GpuCompositor,
    d3d11_context: &ID3D11DeviceContext,
    fence: &CrossApiSharedFence,
    value: u64,
) -> Result<()> {
    let context4: ID3D11DeviceContext4 = d3d11_context
        .cast()
        .context("D3D11 context does not expose ID3D11DeviceContext4 shared fences")?;
    unsafe {
        context4
            .Signal(&fence.producer, value)
            .context("signal D3D11 producer fence")?;
        d3d11_context.Flush();
    }
    {
        let hal_queue = unsafe { compositor.queue.as_hal::<wgpu::hal::api::Dx12>() }
            .context("wgpu queue is not DX12 while waiting on shared fence")?;
        unsafe {
            hal_queue
                .as_raw()
                .Wait(&fence.consumer, value)
                .context("enqueue D3D12 consumer wait for D3D11 producer fence")?;
        }
    }
    Ok(())
}

unsafe fn create_decode_context(compositor: &GpuCompositor, input: &Path) -> Result<DecodeContext> {
    let dxgi_adapter: IDXGIAdapter3 = {
        let hal_adapter = unsafe { compositor.adapter.as_hal::<wgpu::hal::api::Dx12>() }
            .context("wgpu adapter is not DX12")?;
        hal_adapter.as_raw().clone()
    };
    let adapter_desc = unsafe { dxgi_adapter.GetDesc2() }.context("read DXGI adapter")?;
    let adapter_luid = format!(
        "{:08x}:{:08x}",
        adapter_desc.AdapterLuid.HighPart as u32, adapter_desc.AdapterLuid.LowPart
    );

    let mut device = None;
    let mut context = None;
    let mut selected_level = D3D_FEATURE_LEVEL::default();
    let levels = [D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0];
    let flags = D3D11_CREATE_DEVICE_FLAG(
        D3D11_CREATE_DEVICE_BGRA_SUPPORT.0 | D3D11_CREATE_DEVICE_VIDEO_SUPPORT.0,
    );
    unsafe {
        D3D11CreateDevice(
            &dxgi_adapter,
            D3D_DRIVER_TYPE_UNKNOWN,
            HMODULE::default(),
            flags,
            Some(&levels),
            D3D11_SDK_VERSION,
            Some(&mut device),
            Some(&mut selected_level),
            Some(&mut context),
        )
    }
    .context("create D3D11 video device on wgpu adapter")?;
    let device = device.context("D3D11CreateDevice returned no device")?;
    let context = context.context("D3D11CreateDevice returned no context")?;
    let multithread: ID3D10Multithread = device
        .cast()
        .context("D3D11 device does not expose ID3D10Multithread")?;
    // The return value is the previous protection state, not a success flag.
    let _previous_multithread_state = unsafe { multithread.SetMultithreadProtected(true) };

    let mut manager = None;
    let mut reset_token = 0u32;
    unsafe { MFCreateDXGIDeviceManager(&mut reset_token, &mut manager) }
        .context("create Media Foundation DXGI manager")?;
    let manager = manager.context("Media Foundation returned no DXGI manager")?;
    unsafe { manager.ResetDevice(&device, reset_token) }
        .context("bind D3D11 device to DXGI manager")?;

    let mut attributes: Option<IMFAttributes> = None;
    unsafe { MFCreateAttributes(&mut attributes, 3) }.context("create source-reader attributes")?;
    let attributes = attributes.context("Media Foundation returned no attributes")?;
    unsafe {
        attributes.SetUnknown(&MF_SOURCE_READER_D3D_MANAGER, &manager)?;
        attributes.SetUINT32(&MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, 1)?;
        attributes.SetUINT32(&MF_LOW_LATENCY, 1)?;
    }

    let canonical_input = input.canonicalize().unwrap_or_else(|_| input.to_path_buf());
    // Media Foundation rejects Rust's Win32 verbatim `\\?\` path prefix even though the
    // underlying file exists. Keep canonicalization for traversal safety, then normalize only
    // at this Win32 API boundary.
    let mf_input = canonical_input
        .to_string_lossy()
        .strip_prefix(r"\\?\")
        .map(std::borrow::ToOwned::to_owned)
        .unwrap_or_else(|| canonical_input.to_string_lossy().into_owned());
    let wide_path: Vec<u16> = std::ffi::OsStr::new(&mf_input)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let reader = unsafe { MFCreateSourceReaderFromURL(PCWSTR(wide_path.as_ptr()), &attributes) }
        .with_context(|| format!("open source reader for {}", input.display()))?;
    let all_streams = MF_SOURCE_READER_ALL_STREAMS.0 as u32;
    let video_stream = MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32;
    unsafe {
        reader.SetStreamSelection(all_streams, false)?;
        reader.SetStreamSelection(video_stream, true)?;
    }

    let media_type: IMFMediaType =
        unsafe { MFCreateMediaType() }.context("create NV12 media type")?;
    unsafe {
        media_type.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
        media_type.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_NV12)?;
        reader.SetCurrentMediaType(video_stream, None, &media_type)?;
    }
    let current_type = unsafe { reader.GetCurrentMediaType(video_stream) }
        .context("read negotiated NV12 media type")?;
    let packed_frame_size = unsafe { current_type.GetUINT64(&MF_MT_FRAME_SIZE) }
        .context("read negotiated visible frame size")?;
    let visible_width = (packed_frame_size >> 32) as u32;
    let visible_height = packed_frame_size as u32;
    if visible_width == 0 || visible_height == 0 {
        bail!("Media Foundation negotiated an invalid visible frame size");
    }
    let packed_frame_rate = unsafe { current_type.GetUINT64(&MF_MT_FRAME_RATE) }.unwrap_or(0);
    let frame_rate_numerator = (packed_frame_rate >> 32) as u32;
    let frame_rate_denominator = packed_frame_rate as u32;

    Ok(DecodeContext {
        device,
        context,
        reader,
        adapter_luid,
        visible_width,
        visible_height,
        frame_rate_numerator,
        frame_rate_denominator,
    })
}

unsafe fn read_dxgi_frame(
    reader: &IMFSourceReader,
    minimum_timestamp_100ns: Option<i64>,
) -> Result<Option<(ID3D11Texture2D, u32, i64)>> {
    let video_stream = MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32;
    loop {
        let mut flags = 0u32;
        let mut timestamp = 0i64;
        let mut sample: Option<IMFSample> = None;
        unsafe {
            reader.ReadSample(
                video_stream,
                0,
                None,
                Some(&mut flags),
                Some(&mut timestamp),
                Some(&mut sample),
            )
        }
        .context("read Media Foundation video sample")?;
        if flags & MF_SOURCE_READERF_ENDOFSTREAM.0 as u32 != 0 {
            return Ok(None);
        }
        let Some(sample) = sample else {
            continue;
        };
        if minimum_timestamp_100ns.is_some_and(|minimum| timestamp < minimum) {
            continue;
        }
        let buffer = unsafe { sample.GetBufferByIndex(0) }.context("get sample buffer")?;
        let dxgi: IMFDXGIBuffer = buffer
            .cast()
            .context("sample buffer is not GPU-resident IMFDXGIBuffer")?;
        let mut raw = std::ptr::null_mut::<c_void>();
        unsafe { dxgi.GetResource(&ID3D11Texture2D::IID, &mut raw) }
            .context("get D3D11 texture from DXGI sample")?;
        if raw.is_null() {
            bail!("IMFDXGIBuffer returned a null D3D11 texture");
        }
        let texture = unsafe { ID3D11Texture2D::from_raw(raw) };
        let subresource =
            unsafe { dxgi.GetSubresourceIndex() }.context("get decoder subresource")?;
        return Ok(Some((texture, subresource, timestamp)));
    }
}

unsafe fn convert_to_shared_bgra(
    compositor: &GpuCompositor,
    device: &ID3D11Device,
    context: &ID3D11DeviceContext,
    source: &ID3D11Texture2D,
    source_subresource: u32,
    width: u32,
    height: u32,
) -> Result<(ID3D11Texture2D, wgpu::Texture, SharedHandle, String)> {
    let (shared, wrapped, handle) =
        unsafe { create_d3d12_owned_shared_bgra(compositor, device, width, height) }?;
    eprintln!("decode-interop: created D3D12-owned shared BGRA target");
    let processor_target = create_d3d11_bgra_target(device, width, height)?;
    let conversion_result = unsafe {
        video_process_nv12_to_bgra(
            device,
            context,
            source,
            source_subresource,
            &processor_target,
            width,
            height,
        )
    };
    let copy_result = conversion_result.and_then(|_| {
        unsafe { context.CopyResource(&shared, &processor_target) };
        wait_for_d3d11(context, device)
    });
    let d3d11_hash =
        copy_result.and_then(|_| verify_d3d11_bgra(device, context, &shared, width, height));
    let d3d11_hash = d3d11_hash?;

    Ok((shared, wrapped, handle, d3d11_hash))
}

fn create_d3d11_bgra_target(
    device: &ID3D11Device,
    width: u32,
    height: u32,
) -> Result<ID3D11Texture2D> {
    let desc = D3D11_TEXTURE2D_DESC {
        Width: width,
        Height: height,
        MipLevels: 1,
        ArraySize: 1,
        Format: DXGI_FORMAT_B8G8R8A8_UNORM,
        SampleDesc: windows::Win32::Graphics::Dxgi::Common::DXGI_SAMPLE_DESC {
            Count: 1,
            Quality: 0,
        },
        Usage: D3D11_USAGE_DEFAULT,
        BindFlags: (D3D11_BIND_SHADER_RESOURCE.0 | D3D11_BIND_RENDER_TARGET.0) as u32,
        CPUAccessFlags: 0,
        MiscFlags: 0,
    };
    let mut texture = None;
    unsafe { device.CreateTexture2D(&desc, None, Some(&mut texture)) }
        .context("create D3D11 video-processor BGRA target")?;
    texture.context("D3D11 returned no video-processor target")
}

unsafe fn create_d3d12_owned_shared_bgra(
    compositor: &GpuCompositor,
    d3d11_device: &ID3D11Device,
    width: u32,
    height: u32,
) -> Result<(ID3D11Texture2D, wgpu::Texture, SharedHandle)> {
    let (resource, handle) = {
        let hal_device = unsafe { compositor.device.as_hal::<wgpu::hal::api::Dx12>() }
            .context("wgpu device is not DX12")?;
        let heap = D3D12_HEAP_PROPERTIES {
            Type: D3D12_HEAP_TYPE_DEFAULT,
            CreationNodeMask: 1,
            VisibleNodeMask: 1,
            ..Default::default()
        };
        let desc = D3D12_RESOURCE_DESC {
            Dimension: D3D12_RESOURCE_DIMENSION_TEXTURE2D,
            Alignment: 0,
            Width: width as u64,
            Height: height,
            DepthOrArraySize: 1,
            MipLevels: 1,
            Format: DXGI_FORMAT_B8G8R8A8_UNORM,
            SampleDesc: windows::Win32::Graphics::Dxgi::Common::DXGI_SAMPLE_DESC {
                Count: 1,
                Quality: 0,
            },
            Layout: D3D12_TEXTURE_LAYOUT_UNKNOWN,
            Flags: D3D12_RESOURCE_FLAG_ALLOW_RENDER_TARGET
                | D3D12_RESOURCE_FLAG_ALLOW_SIMULTANEOUS_ACCESS,
        };
        let mut resource: Option<ID3D12Resource> = None;
        unsafe {
            hal_device.raw_device().CreateCommittedResource(
                &heap,
                D3D12_HEAP_FLAG_SHARED,
                &desc,
                D3D12_RESOURCE_STATE_COMMON,
                None,
                &mut resource,
            )
        }
        .context("create D3D12-owned shared BGRA resource")?;
        let resource = resource.context("D3D12 returned no shared BGRA resource")?;
        let handle = unsafe {
            hal_device.raw_device().CreateSharedHandle(
                &resource,
                None,
                GENERIC_ALL.0,
                PCWSTR::null(),
            )
        }
        .context("create NT handle for D3D12 BGRA resource")?;
        (resource, SharedHandle(Some(handle)))
    };
    let device1: ID3D11Device1 = d3d11_device.cast().context("get ID3D11Device1")?;
    let d3d11_texture: ID3D11Texture2D = unsafe { device1.OpenSharedResource1(handle.get()?) }
        .context("open D3D12 shared BGRA resource in D3D11")?;
    let wrapped = unsafe { wrap_d3d12_bgra(compositor, resource, width, height) };
    Ok((d3d11_texture, wrapped, handle))
}

unsafe fn video_process_nv12_to_bgra(
    device: &ID3D11Device,
    context: &ID3D11DeviceContext,
    source: &ID3D11Texture2D,
    source_subresource: u32,
    destination: &ID3D11Texture2D,
    width: u32,
    height: u32,
) -> Result<()> {
    let video_device: ID3D11VideoDevice = device.cast().context("get ID3D11VideoDevice")?;
    let video_context: ID3D11VideoContext = context.cast().context("get ID3D11VideoContext")?;
    let content = D3D11_VIDEO_PROCESSOR_CONTENT_DESC {
        InputFrameFormat: D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
        InputFrameRate: DXGI_RATIONAL {
            Numerator: 30,
            Denominator: 1,
        },
        InputWidth: width,
        InputHeight: height,
        OutputFrameRate: DXGI_RATIONAL {
            Numerator: 30,
            Denominator: 1,
        },
        OutputWidth: width,
        OutputHeight: height,
        Usage: D3D11_VIDEO_USAGE_OPTIMAL_SPEED,
    };
    let enumerator = unsafe { video_device.CreateVideoProcessorEnumerator(&content) }
        .context("create D3D11 video processor enumerator")?;
    eprintln!("decode-interop: created video processor enumerator");
    let nv12_support = unsafe { enumerator.CheckVideoProcessorFormat(DXGI_FORMAT_NV12) }
        .context("query NV12 video-processor support")?;
    let bgra_support = unsafe { enumerator.CheckVideoProcessorFormat(DXGI_FORMAT_B8G8R8A8_UNORM) }
        .context("query BGRA video-processor support")?;
    if nv12_support & D3D11_VIDEO_PROCESSOR_FORMAT_SUPPORT_INPUT.0 as u32 == 0
        || bgra_support & D3D11_VIDEO_PROCESSOR_FORMAT_SUPPORT_OUTPUT.0 as u32 == 0
    {
        bail!(
            "D3D11 video processor does not support NV12->BGRA (input={nv12_support:#x}, output={bgra_support:#x})"
        );
    }
    let processor = unsafe { video_device.CreateVideoProcessor(&enumerator, 0) }
        .context("create D3D11 video processor")?;
    eprintln!("decode-interop: created video processor");
    let input_desc = D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC {
        FourCC: 0,
        ViewDimension: D3D11_VPIV_DIMENSION_TEXTURE2D,
        Anonymous: D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC_0 {
            Texture2D: D3D11_TEX2D_VPIV {
                MipSlice: 0,
                ArraySlice: source_subresource,
            },
        },
    };
    let mut input_view = None;
    unsafe {
        video_device.CreateVideoProcessorInputView(
            source,
            &enumerator,
            &input_desc,
            Some(&mut input_view),
        )
    }
    .context("create NV12 video processor input view")?;
    let input_view = input_view.context("D3D11 returned no video processor input view")?;
    eprintln!("decode-interop: created NV12 input view");
    let output_desc = D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC {
        ViewDimension: D3D11_VPOV_DIMENSION_TEXTURE2D,
        Anonymous: D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC_0 {
            Texture2D: D3D11_TEX2D_VPOV { MipSlice: 0 },
        },
    };
    let mut output_view = None;
    unsafe {
        video_device.CreateVideoProcessorOutputView(
            destination,
            &enumerator,
            &output_desc,
            Some(&mut output_view),
        )
    }
    .context("create BGRA video processor output view")?;
    let output_view = output_view.context("D3D11 returned no video processor output view")?;
    eprintln!("decode-interop: created BGRA output view");
    let rect = windows::Win32::Foundation::RECT {
        left: 0,
        top: 0,
        right: width as i32,
        bottom: height as i32,
    };
    unsafe {
        video_context.VideoProcessorSetOutputTargetRect(&processor, true, Some(&rect));
        video_context.VideoProcessorSetStreamSourceRect(&processor, 0, true, Some(&rect));
        video_context.VideoProcessorSetStreamDestRect(&processor, 0, true, Some(&rect));
        video_context.VideoProcessorSetStreamFrameFormat(
            &processor,
            0,
            D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
        );
    }
    let mut stream = D3D11_VIDEO_PROCESSOR_STREAM {
        Enable: true.into(),
        pInputSurface: std::mem::ManuallyDrop::new(Some(input_view.clone())),
        ..Default::default()
    };
    let result = unsafe {
        video_context.VideoProcessorBlt(&processor, &output_view, 0, std::slice::from_ref(&stream))
    }
    .context("run NV12-to-BGRA GPU video processor");
    eprintln!("decode-interop: submitted video processor blit");
    unsafe { std::mem::ManuallyDrop::drop(&mut stream.pInputSurface) };
    result
}

fn verify_d3d11_bgra(
    device: &ID3D11Device,
    context: &ID3D11DeviceContext,
    source: &ID3D11Texture2D,
    width: u32,
    height: u32,
) -> Result<String> {
    let desc = D3D11_TEXTURE2D_DESC {
        Width: width,
        Height: height,
        MipLevels: 1,
        ArraySize: 1,
        Format: DXGI_FORMAT_B8G8R8A8_UNORM,
        SampleDesc: windows::Win32::Graphics::Dxgi::Common::DXGI_SAMPLE_DESC {
            Count: 1,
            Quality: 0,
        },
        Usage: D3D11_USAGE_STAGING,
        BindFlags: 0,
        CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
        MiscFlags: 0,
    };
    let mut staging = None;
    unsafe { device.CreateTexture2D(&desc, None, Some(&mut staging)) }
        .context("create D3D11 staging texture for gate verification")?;
    let staging = staging.context("D3D11 returned no staging texture")?;
    unsafe { context.CopyResource(&staging, source) };
    wait_for_d3d11(context, device)?;
    let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
    unsafe { context.Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped)) }
        .context("map D3D11 verification texture")?;
    if mapped.pData.is_null() || mapped.RowPitch < width * 4 {
        unsafe { context.Unmap(&staging, 0) };
        bail!("D3D11 mapped verification texture is invalid");
    }
    let mut hash = 0xcbf29ce484222325u64;
    let mut non_zero = false;
    for y in 0..height as usize {
        let row = unsafe {
            std::slice::from_raw_parts(
                (mapped.pData as *const u8).add(y * mapped.RowPitch as usize),
                width as usize * 4,
            )
        };
        for &value in row {
            non_zero |= value != 0;
            hash ^= value as u64;
            hash = hash.wrapping_mul(0x100000001b3);
        }
    }
    unsafe { context.Unmap(&staging, 0) };
    if !non_zero {
        bail!("D3D11 shared texture verification produced all-zero BGRA pixels");
    }
    Ok(format!("fnv1a64:{hash:016x}"))
}

fn wait_for_d3d11(context: &ID3D11DeviceContext, device: &ID3D11Device) -> Result<()> {
    let query_desc = D3D11_QUERY_DESC {
        Query: D3D11_QUERY_EVENT,
        MiscFlags: 0,
    };
    let mut query: Option<ID3D11Query> = None;
    unsafe { device.CreateQuery(&query_desc, Some(&mut query)) }
        .context("create D3D11 event query")?;
    let query = query.context("D3D11 returned no event query")?;
    unsafe {
        context.End(&query);
        context.Flush();
    }
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let hr = unsafe {
            (Interface::vtable(context).GetData)(
                context.as_raw(),
                query.as_raw(),
                std::ptr::null_mut(),
                0,
                D3D11_ASYNC_GETDATA_FLAG(0).0 as u32,
            )
        };
        if hr == S_OK {
            return Ok(());
        }
        if hr.is_err() {
            return Err(anyhow!("D3D11 GPU synchronization failed: {hr:?}"));
        }
        if Instant::now() >= deadline {
            bail!("timed out waiting for D3D11 GPU copy");
        }
        std::thread::yield_now();
    }
}

unsafe fn wrap_d3d12_bgra(
    compositor: &GpuCompositor,
    d3d12_resource: ID3D12Resource,
    width: u32,
    height: u32,
) -> wgpu::Texture {
    let size = wgpu::Extent3d {
        width,
        height,
        depth_or_array_layers: 1,
    };
    let hal_texture = unsafe {
        wgpu::hal::dx12::Device::texture_from_raw(
            d3d12_resource,
            wgpu::TextureFormat::Bgra8Unorm,
            wgpu::TextureDimension::D2,
            size,
            1,
            1,
        )
    };
    let descriptor = wgpu::TextureDescriptor {
        label: Some("Editkin imported decoded BGRA frame"),
        size,
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Bgra8Unorm,
        usage: wgpu::TextureUsages::COPY_SRC | wgpu::TextureUsages::TEXTURE_BINDING,
        view_formats: &[],
    };
    unsafe {
        compositor
            .device
            .create_texture_from_hal::<wgpu::hal::api::Dx12>(
                hal_texture,
                &descriptor,
                wgpu::TextureUses::PRESENT,
            )
    }
}

fn consume_surface_with_wgpu(
    compositor: &GpuCompositor,
    texture: &wgpu::Texture,
    format: wgpu::TextureFormat,
    width: u32,
    height: u32,
) -> Result<(String, Vec<u8>)> {
    if !matches!(
        format,
        wgpu::TextureFormat::Bgra8Unorm
            | wgpu::TextureFormat::Bgra8UnormSrgb
            | wgpu::TextureFormat::Rgb10a2Unorm
    ) {
        bail!("unsupported native preview verification format: {format:?}");
    }
    let row_bytes = width * 4;
    let padded_width = row_bytes.next_multiple_of(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT);
    let buffer_size = padded_width as u64 * height as u64;
    let buffer = compositor.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("Editkin decode interop verification readback"),
        size: buffer_size,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let mut encoder = compositor
        .device
        .create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("Editkin consume imported BGRA texture"),
        });
    encoder.copy_texture_to_buffer(
        wgpu::TexelCopyTextureInfo {
            texture,
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::All,
        },
        wgpu::TexelCopyBufferInfo {
            buffer: &buffer,
            layout: wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(padded_width),
                rows_per_image: Some(height),
            },
        },
        wgpu::Extent3d {
            width,
            height,
            depth_or_array_layers: 1,
        },
    );
    compositor.queue.submit([encoder.finish()]);
    let slice = buffer.slice(..);
    let (sender, receiver) = mpsc::channel();
    slice.map_async(wgpu::MapMode::Read, move |result| {
        let _ = sender.send(result);
    });
    compositor
        .device
        .poll(wgpu::PollType::wait_indefinitely())
        .context("poll imported BGRA verification copy")?;
    receiver.recv().context("receive BGRA map callback")??;
    let mapped = slice
        .get_mapped_range()
        .context("map imported BGRA pixels")?;
    let mut hash = 0xcbf29ce484222325u64;
    let mut non_zero = false;
    let mut rgba = Vec::with_capacity(row_bytes as usize * height as usize);
    for row in mapped
        .chunks_exact(padded_width as usize)
        .take(height as usize)
    {
        let visible_row = &row[..row_bytes as usize];
        for &value in visible_row {
            non_zero |= value != 0;
            hash ^= value as u64;
            hash = hash.wrapping_mul(0x100000001b3);
        }
        for pixel in visible_row.chunks_exact(4) {
            match format {
                wgpu::TextureFormat::Bgra8Unorm | wgpu::TextureFormat::Bgra8UnormSrgb => {
                    rgba.extend_from_slice(&[pixel[2], pixel[1], pixel[0], pixel[3]]);
                }
                wgpu::TextureFormat::Rgb10a2Unorm => {
                    let packed = u32::from_le_bytes(pixel.try_into().expect("four-byte pixel"));
                    let convert10 = |value: u32| ((value * 255 + 511) / 1023) as u8;
                    rgba.extend_from_slice(&[
                        convert10(packed & 0x3ff),
                        convert10((packed >> 10) & 0x3ff),
                        convert10((packed >> 20) & 0x3ff),
                        (((packed >> 30) & 0x3) * 85) as u8,
                    ]);
                }
                _ => unreachable!("format validated before readback"),
            }
        }
    }
    drop(mapped);
    buffer.unmap();
    if !non_zero {
        bail!("wgpu consumed an all-zero decoded BGRA texture");
    }
    Ok((format!("fnv1a64:{hash:016x}"), rgba))
}

fn consume_bgra_with_wgpu(
    compositor: &GpuCompositor,
    texture: &wgpu::Texture,
    width: u32,
    height: u32,
) -> Result<(String, Vec<u8>)> {
    consume_surface_with_wgpu(
        compositor,
        texture,
        wgpu::TextureFormat::Bgra8Unorm,
        width,
        height,
    )
}

#[cfg(test)]
#[path = "windows_video_white_balance_tests.rs"]
mod white_balance_tests;
