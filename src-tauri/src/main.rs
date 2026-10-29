#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(feature = "auto-roto-research")]
compile_error!("Editkin product route retired: feature auto-roto-research is research history only and cannot be compiled.");

mod agent_connect;
mod agent_runtime_probe;
mod agent_setup;
mod audio_preview_events;
mod audio_session_host;
mod audio_session_registry;
mod audio_session_desktop;
mod creative_preview;
mod desktop_files;
mod desktop_color_luts_v1;
mod gpu_command_worker;
mod gpu_preview_cache;
mod gpu_offscreen_preview;
mod gpu_preview_owner;
mod gpu_resident_process;
mod media_probe_fields;
mod native_dialog_labels;
mod native_preview_playback;
mod outside_media_grants;
#[cfg(test)]
mod media_source_path_tests;
mod preview_process_platform;
mod preview_service_process;
mod remote_agent_launcher;
mod remote_provider_connector;
mod render_jobs;
mod engine_tasks_v1;
mod desktop_batch_commands_v1;
use desktop_batch_commands_v1::{
    batch_engine_complete_v1, batch_engine_input_v1, verified_batch_session_v1, BatchSession,
};
mod resident_service;
#[cfg(test)]
mod resident_av_clock_tests;
mod service_pool;
mod template_short;
mod window_close_guard;

use native_dialog_labels::DialogText;
use agent_setup::{
    activate_product_agent_generation, rollback_product_agent_generation, selected_agent_workspace,
    ProductAgentGenerationPaths,
};
#[cfg(test)]
use agent_connect::{claude_mcp_text_inspection, codex_mcp_json_is_exact};
use arboard::Clipboard;
use media_probe_fields::{append_media_dimensions, imported_media_defaults_batch};
use remote_agent_launcher::{
    login_probe_is_ready, read_bounded, remote_agent_task_prompt, remote_verification_matches,
    BoundedCapture, CodexClosedMcp, RemoteAgentTarget, RemoteVerificationContext,
    REMOTE_AGENT_OUTPUT_LIMIT_BYTES, REMOTE_AGENT_TIMEOUT_SECONDS, REMOTE_AGENT_TRUTH_LABEL,
};
use remote_provider_connector::ConnectorBinding;
use rfd::{FileDialog, MessageButtons, MessageDialog, MessageDialogResult, MessageLevel};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    env,
    ffi::OsString,
    fs,
    io::{BufReader, Read, Write},
    net::{IpAddr, Ipv4Addr, TcpListener, TcpStream, UdpSocket},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager, State};

const RELEASE_INPUT_MANIFEST: &str =
    include_str!(concat!(env!("OUT_DIR"), "/release-input-identity.json"));
const REMOTE_RELAY_CONFIG: &str = include_str!("../remote-relay.json");
const EDITKIN_AGENT_SETUP_CONTRACT: &str = include_str!("../../src/shared/agentSetupContract.json");
/// Publisher identity this build trusts for updates; shared with the Node service so both agree.
const UPDATE_PUBLISHER_PIN: &str = include_str!("../../src/shared/updatePublisherPin.json");
const BUNDLED_FONT_FACE_INDEX: &str = include_str!("../../src/generated/fontFaceIndex.json");
const BUNDLED_FONT_EM_METRICS: &str = include_str!("../../src/generated/fontEmMetrics.json");
const MAX_BUNDLED_FONT_FACE_BYTES: u64 = 16 * 1024 * 1024;
const MAX_BUNDLED_FONT_MANIFEST_BYTES: u64 = 1024 * 1024;

fn editkin_agent_setup_contract() -> Result<Value, String> {
    serde_json::from_str(EDITKIN_AGENT_SETUP_CONTRACT)
        .map_err(|error| format!("Embedded agent setup contract is invalid: {error}"))
}

fn editkin_agent_starter_prompt(contract: &Value) -> Result<String, String> {
    contract
        .get("starterPrompt")
        .and_then(Value::as_str)
        .filter(|prompt| !prompt.trim().is_empty())
        .map(str::to_string)
        .ok_or_else(|| "Embedded agent setup contract has no starterPrompt".to_string())
}

fn editkin_agent_launcher_contract(
    contract: &Value,
) -> Result<&serde_json::Map<String, Value>, String> {
    let object = contract
        .as_object()
        .ok_or("Embedded agent setup contract is not an object")?;
    let expected_top_level = [
        "contractVersion",
        "envKeys",
        "launcher",
        "schemaVersion",
        "serverId",
        "starterPrompt",
    ]
    .into_iter()
    .collect::<BTreeSet<_>>();
    if object.keys().map(String::as_str).collect::<BTreeSet<_>>() != expected_top_level
        || contract.get("schemaVersion").and_then(Value::as_u64) != Some(2)
        || contract.get("contractVersion").and_then(Value::as_str) != Some("editkin.agent-setup/v2")
        || contract.get("serverId").and_then(Value::as_str) != Some("editkin")
    {
        return Err("Embedded agent setup contract v2 closed-world header is invalid".into());
    }
    let launcher = contract
        .get("launcher")
        .and_then(Value::as_object)
        .ok_or("Embedded agent setup contract has no launcher")?;
    let expected_launcher_keys = [
        "args",
        "embeddedContractRelativePath",
        "entrypointMode",
        "resourceRelativePath",
        "schemaVersion",
        "stateDirectoryName",
        "stateEnvKey",
    ]
    .into_iter()
    .collect::<BTreeSet<_>>();
    let valid = launcher.keys().map(String::as_str).collect::<BTreeSet<_>>()
        == expected_launcher_keys
        && launcher.get("schemaVersion").and_then(Value::as_u64) == Some(3)
        && launcher.get("entrypointMode").and_then(Value::as_str)
            == Some("stable_generation_launcher")
        && launcher.get("resourceRelativePath").and_then(Value::as_str)
            == Some("agent-runtime-v3/launcher.mjs")
        && launcher
            .get("embeddedContractRelativePath")
            .and_then(Value::as_str)
            == Some("agent-runtime-v3/agent-setup-contract.json")
        && launcher.get("stateEnvKey").and_then(Value::as_str) == Some("EDITKIN_AGENT_STATE_ROOT")
        && launcher.get("stateDirectoryName").and_then(Value::as_str) == Some("agent-runtime-v3")
        && launcher
            .get("args")
            .and_then(Value::as_array)
            .is_some_and(Vec::is_empty);
    if !valid {
        return Err("Embedded Agent generation launcher contract is invalid".into());
    }
    Ok(launcher)
}

#[derive(Default)]
struct AppState {
    services: Arc<service_pool::ServicePool>,
    pending_update: Mutex<Option<Value>>,
    update_job_result: Mutex<Option<Value>>,
    update_job_running: AtomicBool,
    update_health_pending: AtomicBool,
    mobile_remote: Mutex<Option<MobileRemote>>,
    batch_session: Mutex<Option<BatchSession>>,
    gpu_engine: Mutex<Option<ResidentGpuProcess>>,
    gpu_commands: gpu_command_worker::GpuCommandWorker,
    gpu_preview_owners: Mutex<gpu_preview_owner::PreviewOwners>,
    gpu_preview_cache: Mutex<gpu_preview_cache::PreviewCache>,
    gpu_playback: Arc<native_preview_playback::PlaybackRegistry>,
    audio_preview: Mutex<Option<NativeAudioPreviewProcess>>,
    resident_audio: audio_session_desktop::DesktopAudio,
    audio_preview_generation: std::sync::atomic::AtomicU64,
    creative_previews: Arc<creative_preview::PreviewLimiter>,
    remote_agent_controller: Mutex<Option<RemoteAgentController>>,
    template_short: template_short::TemplateShortJobs,
}

struct RemoteAgentController {
    job_id: String,
    target: RemoteAgentTarget,
    consent_revision: String,
    started_at_ms: u128,
    cancel_requested: Arc<AtomicBool>,
}

type ResidentGpuProcess = gpu_resident_process::GpuResidentProcess;

struct NativeAudioPreviewProcess {
    child: Child,
    events: Arc<audio_preview_events::EventMailbox>,
    generation: u64,
    stage: Value,
    last_event: Value,
    managed_paths: Vec<PathBuf>,
    session_root: PathBuf,
}

impl Drop for NativeAudioPreviewProcess {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        for path in self.managed_paths.iter().rev() {
            let _ = fs::remove_file(path);
        }
        let _ = fs::remove_dir(&self.session_root);
    }
}

struct MobileRemote {
    child: Child,
    url: String,
    token: String,
    transport: String,
    warning: Option<String>,
    queue_path: PathBuf,
    snapshot_path: PathBuf,
    devices_path: PathBuf,
    trusted_devices_path: PathBuf,
    pairing_expires_at_ms: u128,
    runtime_receipt_path: PathBuf,
    runtime_instance_id: String,
    probe_id: String,
    started_at_ms: u128,
}

fn terminate_and_wait(child: &mut Child) {
    if child.try_wait().ok().flatten().is_none() {
        let _ = child.kill();
    }
    let _ = child.wait();
}

fn remove_owned_remote_runtime_receipt(path: &Path, runtime_instance_id: &str) {
    let belongs_to_instance = read_remote_json(path)
        .ok()
        .flatten()
        .and_then(|value| {
            value
                .get("runtimeInstanceId")
                .and_then(Value::as_str)
                .map(|value| value == runtime_instance_id)
        })
        .unwrap_or(false);
    if belongs_to_instance {
        let _ = fs::remove_file(path);
    }
}

impl Drop for MobileRemote {
    fn drop(&mut self) {
        terminate_and_wait(&mut self.child);
        remove_owned_remote_runtime_receipt(&self.runtime_receipt_path, &self.runtime_instance_id);
    }
}

struct PendingMobileRemote {
    child: Option<Child>,
    runtime_receipt_path: PathBuf,
    runtime_instance_id: String,
}

impl PendingMobileRemote {
    fn child_mut(&mut self) -> &mut Child {
        self.child.as_mut().expect("pending Remote child exists")
    }

    fn commit(mut self) -> Child {
        self.child.take().expect("pending Remote child exists")
    }
}

impl Drop for PendingMobileRemote {
    fn drop(&mut self) {
        if let Some(child) = self.child.as_mut() {
            terminate_and_wait(child);
            remove_owned_remote_runtime_receipt(
                &self.runtime_receipt_path,
                &self.runtime_instance_id,
            );
        }
    }
}

impl Drop for AppState {
    fn drop(&mut self) {
        self.services.shutdown();
        if let Ok(controller) = self.remote_agent_controller.get_mut() {
            if let Some(controller) = controller.as_ref() {
                controller.cancel_requested.store(true, Ordering::SeqCst);
            }
        }
        self.creative_previews.shutdown();
        if let Ok(remote) = self.mobile_remote.get_mut() {
            *remote = None;
        }
        if let Ok(gpu) = self.gpu_engine.get_mut() {
            *gpu = None;
        }
        if let Ok(audio) = self.audio_preview.get_mut() {
            *audio = None;
        }
    }
}

#[derive(Clone)]
struct RuntimePaths {
    resource_root: PathBuf,
    node: PathBuf,
    node_manifest: PathBuf,
    service: PathBuf,
    mcp: PathBuf,
    mcp_identity: PathBuf,
    agent_launcher: PathBuf,
    agent_contract: PathBuf,
    remote: PathBuf,
    ffmpeg: PathBuf,
    ffprobe: PathBuf,
    whisper_cli: PathBuf,
    native_core: PathBuf,
    gpu_compositor: PathBuf,
    asset_base: PathBuf,
    cache_root: PathBuf,
    model_root: PathBuf,
    #[cfg(feature = "auto-roto-research")]
    auto_roto_model_root: Option<PathBuf>,
    #[cfg(feature = "auto-roto-research")]
    auto_roto_model_manifest: Option<PathBuf>,
    #[cfg(feature = "auto-roto-research")]
    auto_roto_video_model_root: Option<PathBuf>,
    #[cfg(feature = "auto-roto-research")]
    auto_roto_video_model_manifest: Option<PathBuf>,
    #[cfg(feature = "auto-roto-research")]
    auto_roto_video_host: Option<PathBuf>,
    #[cfg(feature = "auto-roto-research")]
    auto_roto_distribution_mode: &'static str,
    #[cfg(feature = "auto-roto-research")]
    auto_roto_external_research_enabled: bool,
    #[cfg(feature = "auto-roto-research")]
    auto_roto_allow_research_candidate: bool,
    creative_pack_root: PathBuf,
    personal_music_root: PathBuf,
    personal_visual_root: PathBuf,
    personal_color_lut_root: Option<PathBuf>,
    font_root: PathBuf,
    color_root: PathBuf,
    plugin_roots: Vec<PathBuf>,
    user_plugin_root: PathBuf,
}

#[cfg(feature = "auto-roto-research")]
fn external_auto_roto_research_allowed(debug_build: bool, explicit_opt_in: Option<&str>) -> bool {
    debug_build && explicit_opt_in == Some("1")
}

#[cfg(feature = "auto-roto-research")]
fn external_auto_roto_research_enabled() -> bool {
    cfg!(feature = "auto-roto-research")
        && external_auto_roto_research_allowed(
            cfg!(debug_assertions),
            env::var("EDITKIN_AUTO_ROTO_ENABLE_EXTERNAL_RESEARCH_PACKS")
                .ok()
                .as_deref(),
        )
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PickedMedia {
    asset: Value,
    preview_path: String,
}

/// Development checkout root (debug builds run from the repository).
#[cfg(debug_assertions)]
fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("src-tauri must live under the repository root")
        .to_path_buf()
}

/// Release builds read packaged resources only. `env!("CARGO_MANIFEST_DIR")` would embed the build machine's checkout
/// path in the shipped binary (--remap-path-prefix does not rewrite env! values), so release has no repository root.
#[cfg(not(debug_assertions))]
fn repo_root() -> PathBuf {
    PathBuf::new()
}

fn process_compatible_path(path: PathBuf) -> PathBuf {
    let value = path.to_string_lossy();
    if let Some(local) = value.strip_prefix(r"\\?\") {
        if let Some(unc) = local.strip_prefix(r"UNC\") {
            return PathBuf::from(format!(r"\\{unc}"));
        }
        return PathBuf::from(local);
    }
    path
}

fn platform_executable(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    }
}

fn existing_or_command(path: PathBuf, command: &str) -> PathBuf {
    if path.exists() {
        path
    } else {
        PathBuf::from(command)
    }
}

fn runtime_override(
    debug_build: bool,
    override_path: Option<PathBuf>,
    fallback: PathBuf,
) -> PathBuf {
    if debug_build {
        override_path.unwrap_or(fallback)
    } else {
        fallback
    }
}

fn unsigned_update_override_allowed(
    debug_build: bool,
    editkin: Option<&str>,
    legacy: Option<&str>,
) -> bool {
    debug_build && (editkin == Some("1") || legacy == Some("1"))
}

fn runtime_paths(app: &AppHandle) -> Result<RuntimePaths, String> {
    let (
        resource_root,
        runtime,
        asset_base,
        creative_pack_root,
        personal_music_root,
        personal_visual_root,
        font_root,
        color_root,
        plugin_root,
    ) = if cfg!(debug_assertions) {
        (
            repo_root(),
            repo_root(),
            repo_root().join("public"),
            repo_root().join(".creative-packs/hao-creator-library"),
            repo_root().join(".personal-packs/hao-music-library"),
            creative_preview::personal_visual_pack_root(
                &repo_root(),
                true,
                env::var_os("EDITKIN_PERSONAL_VISUAL_ROOT").map(PathBuf::from),
            ),
            repo_root().join("public/fonts"),
            repo_root().join("public/color/aces2"),
            repo_root().join("plugins"),
        )
    } else {
        let resource = process_compatible_path(
            app.path()
                .resource_dir()
                .map_err(|error| error.to_string())?,
        );
        (
            resource.clone(),
            resource.join("runtime"),
            resource.join("runtime"),
            resource.join("creative-packs/hao-creator-library"),
            resource.join("personal-packs/hao-music-library"),
            application_data_root(app)?.join("personal-packs/hao-visual-library"),
            resource.join("font-packs/editkin-open-fonts"),
            resource.join("color/aces2"),
            resource.join("plugins"),
        )
    };
    let from_env = |key: &str, fallback: PathBuf| {
        runtime_override(
            cfg!(debug_assertions),
            env::var_os(key).map(PathBuf::from),
            fallback,
        )
    };
    fs::create_dir_all(&personal_visual_root)
        .map_err(|error| format!("無法建立使用者個人視覺素材資料夾：{error}"))?;
    let node_name = platform_executable("node");
    let ffmpeg_name = platform_executable("ffmpeg");
    let ffprobe_name = platform_executable("ffprobe");
    let whisper_cli_name = platform_executable("whisper-cli");
    let core_name = platform_executable("hao-core");
    let gpu_compositor_name = platform_executable("editkin-gpu-compositor");
    let development_runtime = repo_root().join(".platform-runtime");
    let bundled_plugin_root = from_env("EDITKIN_PLUGIN_ROOT", plugin_root);
    let user_plugin_root = application_data_root(app)?.join("plugins");
    fs::create_dir_all(&user_plugin_root)
        .map_err(|error| format!("無法建立使用者外掛資料夾：{error}"))?;
    let model_root = application_data_root(app)?.join("models");
    #[cfg(feature = "auto-roto-research")]
    let auto_roto_external_research_enabled = external_auto_roto_research_enabled();
    #[cfg(feature = "auto-roto-research")]
    let default_auto_roto_root = model_root.join("auto-roto/active");
    #[cfg(feature = "auto-roto-research")]
    let default_auto_roto_manifest = default_auto_roto_root.join("manifest.json");
    #[cfg(feature = "auto-roto-research")]
    let configured_auto_roto_root = auto_roto_external_research_enabled
        .then(|| env::var_os("EDITKIN_AUTO_ROTO_MODEL_ROOT"))
        .flatten()
        .map(PathBuf::from)
        .unwrap_or(default_auto_roto_root);
    #[cfg(feature = "auto-roto-research")]
    let configured_auto_roto_manifest = auto_roto_external_research_enabled
        .then(|| env::var_os("EDITKIN_AUTO_ROTO_MODEL_MANIFEST"))
        .flatten()
        .map(PathBuf::from)
        .unwrap_or(default_auto_roto_manifest);
    #[cfg(feature = "auto-roto-research")]
    let auto_roto_configured =
        auto_roto_external_research_enabled && configured_auto_roto_manifest.is_file();
    #[cfg(feature = "auto-roto-research")]
    let installed_auto_roto_video_root = auto_roto_external_research_enabled
        .then(|| {
            resolve_active_auto_roto_video_root(&model_root)
                .ok()
                .flatten()
        })
        .flatten();
    #[cfg(feature = "auto-roto-research")]
    let default_auto_roto_video_root = installed_auto_roto_video_root
        .unwrap_or_else(|| model_root.join("auto-roto-video/unavailable"));
    #[cfg(feature = "auto-roto-research")]
    let configured_auto_roto_video_root = auto_roto_external_research_enabled
        .then(|| env::var_os("EDITKIN_AUTO_ROTO_VIDEO_MODEL_ROOT"))
        .flatten()
        .map(PathBuf::from)
        .unwrap_or(default_auto_roto_video_root);
    #[cfg(feature = "auto-roto-research")]
    let configured_auto_roto_video_manifest = auto_roto_external_research_enabled
        .then(|| env::var_os("EDITKIN_AUTO_ROTO_VIDEO_MODEL_MANIFEST"))
        .flatten()
        .map(PathBuf::from)
        .unwrap_or_else(|| configured_auto_roto_video_root.join("manifest.json"));
    #[cfg(feature = "auto-roto-research")]
    let configured_auto_roto_video_host = auto_roto_external_research_enabled
        .then(|| env::var_os("EDITKIN_AUTO_ROTO_VIDEO_HOST"))
        .flatten()
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            if auto_roto_external_research_enabled {
                runtime.join("scripts/auto-roto-sam21-video-host.py")
            } else {
                configured_auto_roto_video_root.join("host/auto-roto-sam21-video-host.py")
            }
        });
    #[cfg(feature = "auto-roto-research")]
    let auto_roto_video_configured = auto_roto_external_research_enabled
        && configured_auto_roto_video_manifest.is_file()
        && configured_auto_roto_video_host.is_file();
    #[cfg(feature = "auto-roto-research")]
    let auto_roto_allow_research_candidate = auto_roto_external_research_enabled
        && env::var("EDITKIN_AUTO_ROTO_ALLOW_RESEARCH_CANDIDATE").as_deref() == Ok("1");
    Ok(RuntimePaths {
        resource_root: resource_root.clone(),
        node: from_env(
            "EDITKIN_NODE_PATH",
            if cfg!(debug_assertions) {
                if cfg!(windows) {
                    runtime.join("vendor/node/win32-x64/node.exe")
                } else {
                    existing_or_command(development_runtime.join(&node_name), "node")
                }
            } else {
                runtime.join(&node_name)
            },
        ),
        node_manifest: if cfg!(windows) {
            if cfg!(debug_assertions) {
                runtime.join("vendor/node/win32-x64/manifest.json")
            } else {
                runtime.join("NODE-MANIFEST.json")
            }
        } else if cfg!(debug_assertions) {
            runtime.join(".platform-runtime/manifest.json")
        } else {
            runtime.join("PLATFORM-MANIFEST.json")
        },
        service: from_env(
            "EDITKIN_SERVICE_PATH",
            if cfg!(debug_assertions) {
                runtime.join("desktop-dist/service.mjs")
            } else {
                runtime.join("service.mjs")
            },
        ),
        mcp: from_env(
            "EDITKIN_MCP_PATH",
            if cfg!(debug_assertions) {
                runtime.join("desktop-dist/mcp.mjs")
            } else {
                runtime.join("mcp.mjs")
            },
        ),
        mcp_identity: if cfg!(debug_assertions) {
            runtime.join("desktop-dist/mcp.mjs.material-color-identity.json")
        } else {
            runtime.join("mcp.mjs.material-color-identity.json")
        },
        agent_launcher: if cfg!(debug_assertions) {
            runtime.join("scripts/editkin-product-mcp-launcher.mjs")
        } else {
            resource_root.join("agent-runtime-v3/launcher.mjs")
        },
        agent_contract: if cfg!(debug_assertions) {
            runtime.join("src/shared/agentSetupContract.json")
        } else {
            resource_root.join("agent-runtime-v3/agent-setup-contract.json")
        },
        remote: from_env(
            "EDITKIN_REMOTE_PATH",
            if cfg!(debug_assertions) {
                runtime.join("desktop-dist/remote.mjs")
            } else {
                runtime.join("remote.mjs")
            },
        ),
        ffmpeg: from_env(
            "HAO_FFMPEG_PATH",
            if cfg!(debug_assertions) {
                if cfg!(windows) {
                    runtime.join("vendor/ffmpeg/win32-x64/ffmpeg.exe")
                } else {
                    existing_or_command(development_runtime.join(&ffmpeg_name), "ffmpeg")
                }
            } else {
                runtime.join(&ffmpeg_name)
            },
        ),
        ffprobe: from_env(
            "HAO_FFPROBE_PATH",
            if cfg!(debug_assertions) {
                if cfg!(windows) {
                    runtime.join("vendor/ffmpeg/win32-x64/ffprobe.exe")
                } else {
                    existing_or_command(development_runtime.join(&ffprobe_name), "ffprobe")
                }
            } else {
                runtime.join(&ffprobe_name)
            },
        ),
        whisper_cli: from_env(
            "EDITKIN_WHISPER_CLI_PATH",
            if cfg!(debug_assertions) {
                if cfg!(windows) {
                    runtime.join("vendor/whisper/win32-x64/whisper-cli.exe")
                } else {
                    existing_or_command(development_runtime.join(&whisper_cli_name), "whisper-cli")
                }
            } else {
                runtime.join(&whisper_cli_name)
            },
        ),
        native_core: from_env(
            "HAO_NATIVE_CORE_PATH",
            if cfg!(debug_assertions) {
                if cfg!(windows) {
                    runtime.join("native/bin/win32-x64/hao-core.exe")
                } else {
                    existing_or_command(development_runtime.join(&core_name), "hao-core")
                }
            } else {
                runtime.join(&core_name)
            },
        ),
        gpu_compositor: from_env(
            "EDITKIN_GPU_COMPOSITOR_PATH",
            if cfg!(debug_assertions) {
                if cfg!(windows) {
                    runtime.join("native/bin/win32-x64/editkin-gpu-compositor.exe")
                } else {
                    existing_or_command(
                        development_runtime.join(&gpu_compositor_name),
                        "editkin-gpu-compositor",
                    )
                }
            } else {
                runtime.join(&gpu_compositor_name)
            },
        ),
        asset_base,
        cache_root: application_cache_root(app)?.join("media-cache"),
        model_root,
        #[cfg(feature = "auto-roto-research")]
        auto_roto_model_root: auto_roto_configured.then_some(configured_auto_roto_root),
        #[cfg(feature = "auto-roto-research")]
        auto_roto_model_manifest: auto_roto_configured.then_some(configured_auto_roto_manifest),
        #[cfg(feature = "auto-roto-research")]
        auto_roto_video_model_root: auto_roto_video_configured
            .then_some(configured_auto_roto_video_root),
        #[cfg(feature = "auto-roto-research")]
        auto_roto_video_model_manifest: auto_roto_video_configured
            .then_some(configured_auto_roto_video_manifest),
        #[cfg(feature = "auto-roto-research")]
        auto_roto_video_host: auto_roto_video_configured.then_some(configured_auto_roto_video_host),
        #[cfg(feature = "auto-roto-research")]
        auto_roto_distribution_mode: if auto_roto_external_research_enabled {
            "debug-research"
        } else {
            "product"
        },
        #[cfg(feature = "auto-roto-research")]
        auto_roto_external_research_enabled,
        #[cfg(feature = "auto-roto-research")]
        auto_roto_allow_research_candidate,
        creative_pack_root: from_env("EDITKIN_CREATIVE_PACK_ROOT", creative_pack_root),
        personal_music_root: from_env("EDITKIN_PERSONAL_MUSIC_ROOT", personal_music_root),
        personal_color_lut_root: desktop_color_luts_v1::root_for_visual(&personal_visual_root).ok(),
        personal_visual_root,
        font_root: from_env("EDITKIN_FONT_ROOT", font_root),
        color_root: from_env("EDITKIN_COLOR_ROOT", color_root),
        plugin_roots: vec![bundled_plugin_root, user_plugin_root.clone()],
        user_plugin_root,
    })
}

fn bounded_color_asset_relative_path(relative_path: &str) -> Result<PathBuf, String> {
    if relative_path.is_empty()
        || relative_path.len() > 128
        || relative_path.contains('\\')
        || !relative_path.is_ascii()
    {
        return Err("色彩資產路徑不合法".into());
    }
    let (directory, file_name) = relative_path
        .split_once('/')
        .ok_or("色彩資產不在允許清單")?;
    if file_name.is_empty()
        || file_name.contains('/')
        || !file_name.bytes().all(|value| {
            value.is_ascii_lowercase() || value.is_ascii_digit() || b"_- .".contains(&value)
        })
    {
        return Err("色彩資產檔名不合法".into());
    }
    let valid = match directory {
        "gpu" => file_name.ends_with(".json"),
        "luts" => file_name.ends_with(".cube"),
        _ => false,
    };
    if !valid || file_name.contains(' ') || file_name.starts_with('.') || file_name.contains("..") {
        return Err("色彩資產不在允許清單".into());
    }
    Ok(PathBuf::from(directory).join(file_name))
}

#[tauri::command(async)]
fn read_mesh_3d_font(app: AppHandle, weight: u16) -> Result<tauri::ipc::Response, String> {
    const MAX_BYTES: u64 = 16 * 1024 * 1024;
    if weight != 700 && weight != 900 {
        return Err("3D 字型只接受內建 Noto Sans TC 700／900".into());
    }
    let runtime = runtime_paths(&app)?;
    let root = fs::canonicalize(&runtime.font_root).map_err(|error| error.to_string())?;
    let relative = format!("render/EditkinFace-noto-sans-tc-{weight}.ttf");
    let target = runtime.font_root.join(&relative);
    let canonical = fs::canonicalize(&target).map_err(|error| error.to_string())?;
    if !canonical.starts_with(&root) {
        return Err("3D 字型不可指向字型目錄之外".into());
    }
    let manifest_path = runtime.font_root.join("editkin-open-fonts.json");
    let (mut manifest_file, manifest_before) = open_remote_file_no_follow(&manifest_path)?;
    if manifest_before.len > 1024 * 1024 {
        return Err("3D 字型 manifest 超出安全大小".into());
    }
    let mut manifest_bytes = Vec::new();
    Read::by_ref(&mut manifest_file)
        .take(1024 * 1024 + 1)
        .read_to_end(&mut manifest_bytes)
        .map_err(|error| error.to_string())?;
    if manifest_bytes.len() as u64 != manifest_before.len
        || remote_file_identity(&manifest_file)? != manifest_before
        || remote_file_identity_at_path(&manifest_path)? != Some(manifest_before)
    {
        return Err("3D 字型 manifest 在讀取時改變".into());
    }
    let manifest: Value =
        serde_json::from_slice(&manifest_bytes).map_err(|error| error.to_string())?;
    let face = manifest
        .get("fonts")
        .and_then(Value::as_array)
        .and_then(|fonts| {
            fonts
                .iter()
                .find(|font| font.get("family").and_then(Value::as_str) == Some("Noto Sans TC"))
        })
        .and_then(|font| font.get("faces"))
        .and_then(Value::as_array)
        .and_then(|faces| {
            faces
                .iter()
                .find(|face| face.get("weight").and_then(Value::as_u64) == Some(weight as u64))
        })
        .ok_or_else(|| "3D 物理字型 manifest 不合法".to_string())?;
    let expected_sha = face
        .get("sha256")
        .and_then(Value::as_str)
        .filter(|value| valid_sha256(value))
        .ok_or_else(|| "3D 物理字型 SHA 不合法".to_string())?;
    if manifest.get("schemaVersion").and_then(Value::as_u64) != Some(2)
        || face.get("file").and_then(Value::as_str) != Some(relative.as_str())
    {
        return Err("3D 物理字型 manifest 不合法".into());
    }
    let (mut file, before) = open_remote_file_no_follow(&target)?;
    if before.len == 0
        || before.len > MAX_BYTES
        || face.get("bytes").and_then(Value::as_u64) != Some(before.len)
    {
        return Err("3D 物理字型超出安全大小".into());
    }
    let mut bytes = Vec::with_capacity(before.len as usize);
    Read::by_ref(&mut file)
        .take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() as u64 != before.len
        || remote_file_identity(&file)? != before
        || remote_file_identity_at_path(&target)? != Some(before)
        || format!("{:x}", Sha256::digest(&bytes)) != expected_sha
    {
        return Err("3D 物理字型在讀取時改變或 SHA 不符".into());
    }
    Ok(tauri::ipc::Response::new(bytes))
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct BundledFontFaceSpec {
    face_id: String,
    font_family: String,
    font_weight: u16,
    font_file: String,
    sha256: String,
    manifest_sha256: String,
    logical_family: String,
}

// Both inputs are compiled generated assets, never paths or digests from an IPC request.
fn bundled_font_face_catalog_from(
    index_json: &str,
    metrics_json: &str,
) -> Result<Vec<BundledFontFaceSpec>, String> {
    let index: Vec<(String, String, Vec<u16>)> =
        serde_json::from_str(index_json).map_err(|error| format!("內建字型索引不合法：{error}"))?;
    let metrics: Value = serde_json::from_str(metrics_json)
        .map_err(|error| format!("內建字型度量索引不合法：{error}"))?;
    let manifest_sha256 = metrics.get("manifestSha256").and_then(Value::as_str)
        .filter(|value| valid_sha256(value))
        .ok_or("內建字型 manifest SHA 不合法")?;
    let metric_faces = metrics.get("faces").and_then(Value::as_array)
        .ok_or("內建字型度量索引缺少 faces")?;
    if index.len() != 6 || metric_faces.len() != 44
        || metrics.get("schema").and_then(Value::as_str) != Some("editkin.font-em-metrics/v1")
    {
        return Err("內建字型索引必須包含精確 44 個物理字型".into());
    }
    let mut metric_shas = std::collections::BTreeMap::new();
    for face in metric_faces {
        let id = face.get("id").and_then(Value::as_str).ok_or("內建字型缺少 id")?;
        let sha = face.get("sha256").and_then(Value::as_str)
            .filter(|value| valid_sha256(value)).ok_or("內建字型 SHA 不合法")?;
        if metric_shas.insert(id, sha).is_some() {
            return Err("內建字型度量索引有重複 id".into());
        }
    }
    let mut family_ids = BTreeSet::new();
    let mut family_names = BTreeSet::new();
    let mut face_ids = BTreeSet::new();
    let mut specs = Vec::with_capacity(44);
    for (logical_family, logical_id, weights) in index {
        if logical_family.trim().is_empty() || logical_id.is_empty()
            || !logical_id.bytes().all(|byte| byte.is_ascii_lowercase() || byte == b'-')
            || logical_id.starts_with('-') || logical_id.ends_with('-')
            || !family_ids.insert(logical_id.clone())
            || !family_names.insert(logical_family.clone()) || weights.is_empty()
        {
            return Err("內建字型邏輯索引不合法".into());
        }
        for font_weight in weights {
            let face_id = format!("EditkinFace-{logical_id}-{font_weight}");
            if !(100..=900).contains(&font_weight) || !face_ids.insert(face_id.clone()) {
                return Err("內建字型索引字重或 id 不合法".into());
            }
            let sha256 = metric_shas.get(face_id.as_str()).ok_or("內建字型索引與度量 id 不符")?;
            specs.push(BundledFontFaceSpec {
                font_family: format!("EditkinFace {logical_id} {font_weight}"),
                font_file: format!("render/{face_id}.ttf"),
                face_id,
                font_weight,
                sha256: (*sha256).to_string(),
                manifest_sha256: manifest_sha256.to_string(),
                logical_family: logical_family.clone(),
            });
        }
    }
    if specs.len() != 44 || face_ids.iter().map(String::as_str).collect::<BTreeSet<_>>()
        != metric_shas.keys().copied().collect::<BTreeSet<_>>()
    {
        return Err("內建字型索引與度量必須是相同的精確 44 個 id".into());
    }
    Ok(specs)
}

fn bundled_font_face_spec(face_id: &str) -> Result<BundledFontFaceSpec, String> {
    bundled_font_face_catalog_from(BUNDLED_FONT_FACE_INDEX, BUNDLED_FONT_EM_METRICS)?
        .into_iter().find(|spec| spec.face_id == face_id)
        .ok_or_else(|| "物理字型只接受內建 44 個精確 faceId".to_string())
}

struct BundledFontDirectory {
    path: PathBuf,
    canonical: PathBuf,
    file: fs::File,
    identity: RemoteFileIdentity,
}

fn open_bundled_font_directory(path: &Path) -> Result<BundledFontDirectory, String> {
    let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if !metadata.is_dir() || remote_agent_directory_is_link(&metadata) {
        return Err("物理字型資料夾必須是一般資料夾；link/reparse 已拒絕".into());
    }
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
        };
        options.custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW);
    }
    let file = options.open(path).map_err(|error| error.to_string())?;
    let identity = remote_file_identity(&file)?;
    if identity.reparse || !file.metadata().map_err(|error| error.to_string())?.is_dir() {
        return Err("物理字型資料夾 handle 不是一般資料夾".into());
    }
    let canonical = fs::canonicalize(path).map_err(|error| error.to_string())?;
    Ok(BundledFontDirectory { path: path.to_path_buf(), canonical, file, identity })
}

fn verify_bundled_font_directory(directory: &BundledFontDirectory) -> Result<(), String> {
    let current = open_bundled_font_directory(&directory.path)?;
    let same_directory = |identity: RemoteFileIdentity| {
        identity.storage_id == directory.identity.storage_id
            && identity.file_id == directory.identity.file_id
            && identity.reparse == directory.identity.reparse && !identity.reparse
    };
    if !directory.file.metadata().map_err(|error| error.to_string())?.is_dir()
        || !same_directory(remote_file_identity(&directory.file)?)
        || !same_directory(current.identity) || current.canonical != directory.canonical
    {
        return Err("物理字型資料夾在讀取期間被替換或修改".into());
    }
    Ok(())
}

fn open_bundled_font_directory_chain(root: &Path) -> Result<Vec<BundledFontDirectory>, String> {
    let mut path = PathBuf::new();
    let mut directories = Vec::new();
    for component in root.components() {
        match component {
            std::path::Component::Prefix(prefix) => {
                #[cfg(windows)]
                if !matches!(prefix.kind(), std::path::Prefix::Disk(_) | std::path::Prefix::VerbatimDisk(_)) {
                    return Err("物理字型 root 必須位於本機磁碟".into());
                }
                path.push(prefix.as_os_str());
            }
            std::path::Component::RootDir | std::path::Component::Normal(_) => {
                path.push(component.as_os_str());
                directories.push(open_bundled_font_directory(&path)?);
            }
            _ => return Err("物理字型 root 不可包含相對或父層路徑".into()),
        }
    }
    if directories.last().is_none_or(|directory| directory.path != root) {
        return Err("物理字型 root ancestor 契約不合法".into());
    }
    Ok(directories)
}

fn verify_bundled_font_directory_chain(directories: &[BundledFontDirectory]) -> Result<(), String> {
    for directory in directories { verify_bundled_font_directory(directory)?; }
    Ok(())
}

struct BundledFontRead {
    path: PathBuf,
    canonical: PathBuf,
    file: fs::File,
    identity: RemoteFileIdentity,
    bytes: Vec<u8>,
}

fn open_bundled_font_file_no_follow(path: &Path) -> Result<(fs::File, RemoteFileIdentity), String> {
    let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if !metadata.is_file() || remote_agent_directory_is_link(&metadata) {
        return Err("物理字型檔案必須是一般檔案；link/reparse 或特殊檔案已拒絕".into());
    }
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT;
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options.open(path).map_err(|error| error.to_string())?;
    let identity = remote_file_identity(&file)?;
    if identity.reparse || !identity.regular || !file.metadata().map_err(|error| error.to_string())?.is_file() {
        return Err("物理字型檔案 handle 必須是一般檔案；link/reparse 或特殊檔案已拒絕".into());
    }
    Ok((file, identity))
}

fn verify_bundled_font_read(read: &BundledFontRead) -> Result<(), String> {
    if !read.file.metadata().map_err(|error| error.to_string())?.is_file()
        || remote_file_identity(&read.file)? != read.identity
        || open_bundled_font_file_no_follow(&read.path)?.1 != read.identity
        || fs::canonicalize(&read.path).map_err(|error| error.to_string())? != read.canonical
    {
        return Err("物理字型檔案在 bounded handle 讀取期間被替換或修改".into());
    }
    Ok(())
}

fn read_bundled_font_file(
    path: &Path,
    directory: &BundledFontDirectory,
    max_bytes: u64,
) -> Result<BundledFontRead, String> {
    let canonical = fs::canonicalize(path).map_err(|error| error.to_string())?;
    if canonical.parent() != Some(directory.canonical.as_path()) {
        return Err("物理字型檔案不可指向字型目錄之外".into());
    }
    let (mut file, before) = open_bundled_font_file_no_follow(path)?;
    if !file.metadata().map_err(|error| error.to_string())?.is_file()
        || before.len == 0 || before.len > max_bytes
    {
        return Err("物理字型檔案不是一般檔案或超出安全大小".into());
    }
    let mut bytes = Vec::with_capacity(before.len as usize);
    Read::by_ref(&mut file).take(max_bytes + 1).read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() as u64 != before.len || bytes.len() as u64 > max_bytes {
        return Err("物理字型檔案在 bounded handle 讀取期間被替換或修改".into());
    }
    let read = BundledFontRead {
        path: path.to_path_buf(), canonical, file, identity: before, bytes,
    };
    verify_bundled_font_read(&read)?;
    verify_bundled_font_directory(directory)?;
    Ok(read)
}

fn bundled_font_manifest_face_size(
    manifest_bytes: &[u8],
    spec: &BundledFontFaceSpec,
) -> Result<u64, String> {
    if format!("{:x}", Sha256::digest(manifest_bytes)) != spec.manifest_sha256 {
        return Err("物理字型 manifest 原始 SHA 與編譯索引不符".into());
    }
    let manifest: Value = serde_json::from_slice(manifest_bytes)
        .map_err(|error| format!("物理字型 manifest 不合法：{error}"))?;
    let fonts = manifest.get("fonts").and_then(Value::as_array)
        .ok_or("物理字型 manifest 缺少 fonts")?;
    if manifest.get("schemaVersion").and_then(Value::as_u64) != Some(2)
        || manifest.get("id").and_then(Value::as_str) != Some("studio.hao.editkin-open-fonts")
        || fonts.len() != 6
    {
        return Err("物理字型 manifest header 不合法".into());
    }
    let face = fonts.iter()
        .find(|font| font.get("family").and_then(Value::as_str) == Some(spec.logical_family.as_str()))
        .and_then(|font| font.get("faces")).and_then(Value::as_array)
        .and_then(|faces| faces.iter().find(|face| face.get("id").and_then(Value::as_str)
            == Some(spec.face_id.as_str())))
        .ok_or("物理字型 manifest 缺少指定 face")?;
    let bytes = face.get("bytes").and_then(Value::as_u64).ok_or("物理字型 manifest 缺少大小")?;
    if bytes == 0 || bytes > MAX_BUNDLED_FONT_FACE_BYTES
        || face.get("weight").and_then(Value::as_u64) != Some(u64::from(spec.font_weight))
        || face.get("file").and_then(Value::as_str) != Some(spec.font_file.as_str())
        || face.get("family").and_then(Value::as_str) != Some(spec.font_family.as_str())
        || face.get("sha256").and_then(Value::as_str) != Some(spec.sha256.as_str())
    {
        return Err("物理字型 manifest 與編譯 face 契約不符".into());
    }
    Ok(bytes)
}

fn read_bundled_font_face_bytes(
    font_root: &Path,
    spec: &BundledFontFaceSpec,
) -> Result<Vec<u8>, String> {
    if !font_root.is_absolute() {
        return Err("物理字型 root 必須是絕對路徑".into());
    }
    let ancestors = open_bundled_font_directory_chain(font_root)?;
    let root = ancestors.last().ok_or("物理字型 root 缺少 ancestor")?;
    let render = open_bundled_font_directory(&font_root.join("render"))?;
    if render.canonical.parent() != Some(root.canonical.as_path()) {
        return Err("物理字型 render 資料夾不可指向字型目錄之外".into());
    }
    verify_bundled_font_directory_chain(&ancestors)?;
    verify_bundled_font_directory(&render)?;
    let manifest = read_bundled_font_file(
        &font_root.join("editkin-open-fonts.json"), root, MAX_BUNDLED_FONT_MANIFEST_BYTES,
    )?;
    let expected_size = bundled_font_manifest_face_size(&manifest.bytes, spec)?;
    let face = read_bundled_font_file(
        &font_root.join(&spec.font_file), &render, MAX_BUNDLED_FONT_FACE_BYTES,
    )?;
    if face.bytes.len() as u64 != expected_size || format!("{:x}", Sha256::digest(&face.bytes)) != spec.sha256 {
        return Err("物理字型實際大小或 SHA 與編譯 face 契約不符".into());
    }
    // Retain both original handles through the whole transaction. Equal-byte replacement is still drift.
    verify_bundled_font_read(&manifest)?;
    verify_bundled_font_read(&face)?;
    verify_bundled_font_directory(&render)?;
    verify_bundled_font_directory_chain(&ancestors)?;
    Ok(face.bytes)
}

#[tauri::command(async)]
fn read_bundled_font_face(app: AppHandle, face_id: String) -> Result<tauri::ipc::Response, String> {
    // Reject unknown IDs before resolving runtime resources or opening any file.
    let spec = bundled_font_face_spec(&face_id)?;
    let runtime = runtime_paths(&app)?;
    read_bundled_font_face_bytes(&runtime.font_root, &spec).map(tauri::ipc::Response::new)
}

#[tauri::command]
async fn list_color_luts_v1(app: AppHandle, window: tauri::WebviewWindow, offset: Option<u64>, limit: Option<u64>) -> Result<Value, String> {
    desktop_color_luts_v1::list_color_luts_v1(app, window, offset, limit).await
}
#[tauri::command]
async fn pick_color_lut_v1(app: AppHandle, window: tauri::WebviewWindow, ui_locale: Option<String>) -> Result<Value, String> {
    desktop_color_luts_v1::pick_color_lut_v1(app, window, ui_locale).await
}
#[tauri::command]
async fn import_color_lut_v1(app: AppHandle, window: tauri::WebviewWindow, request: desktop_color_luts_v1::ImportRequestV1) -> Result<Value, String> {
    desktop_color_luts_v1::import_color_lut_v1(app, window, request).await
}
#[tauri::command]
async fn read_color_lut_v1(app: AppHandle, window: tauri::WebviewWindow, id: String, sha256: String, input_space: String) -> Result<tauri::ipc::Response, String> {
    desktop_color_luts_v1::read_color_lut_v1(app, window, id, sha256, input_space).await
}

#[tauri::command]
fn read_color_asset(app: AppHandle, relative_path: String) -> Result<String, String> {
    const MAX_COLOR_ASSET_BYTES: u64 = 64 * 1024 * 1024;
    let relative = bounded_color_asset_relative_path(&relative_path)?;
    let runtime = runtime_paths(&app)?;
    let target = runtime.color_root.join(relative);
    let metadata = fs::metadata(&target).map_err(|error| format!("找不到內建色彩資產：{error}"))?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_COLOR_ASSET_BYTES {
        return Err("色彩資產超出安全大小".into());
    }
    fs::read_to_string(target).map_err(|error| format!("無法讀取內建色彩資產：{error}"))
}

fn integration_state_root() -> Option<PathBuf> {
    (env::var("EDITKIN_INTEGRATION_SMOKE").as_deref() == Ok("1"))
        .then(|| env::var_os("EDITKIN_INTEGRATION_STATE_ROOT"))
        .flatten()
        .filter(|root| !root.is_empty())
        .map(PathBuf::from)
        .map(process_compatible_path)
}

fn application_data_root(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(root) = integration_state_root() {
        return Ok(root.join("data"));
    }
    app.path()
        .app_data_dir()
        .map(process_compatible_path)
        .map_err(|error| error.to_string())
}

fn workflow_profile_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(application_data_root(app)?
        .join("workflow")
        .join("workflow-profile.json"))
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

#[cfg(feature = "auto-roto-research")]
fn auto_roto_video_model_base(model_root: &Path) -> PathBuf {
    model_root.join("auto-roto-video")
}

#[cfg(feature = "auto-roto-research")]
fn resolve_active_auto_roto_video_root(model_root: &Path) -> Result<Option<PathBuf>, String> {
    let base = auto_roto_video_model_base(model_root);
    let pointer_path = base.join("active.json");
    let Some(pointer) = read_json(&pointer_path)? else {
        return Ok(None);
    };
    if pointer.get("schema").and_then(Value::as_str) != Some("editkin.auto-roto-active-pack/v1") {
        return Err("Auto Roto active pointer schema 不合法".into());
    }
    let manifest_sha = pointer
        .get("manifestSha256")
        .and_then(Value::as_str)
        .filter(|value| valid_sha256(value))
        .ok_or("Auto Roto active pointer manifest SHA-256 不合法")?;
    let expected = format!("versions/{manifest_sha}");
    if pointer.get("rootRelative").and_then(Value::as_str) != Some(expected.as_str()) {
        return Err("Auto Roto active pointer root 不合法".into());
    }
    let root = base.join("versions").join(manifest_sha);
    if !root.join("manifest.json").is_file()
        || !root.join("host/auto-roto-sam21-video-host.py").is_file()
    {
        return Err("Auto Roto active pack 不完整".into());
    }
    Ok(Some(root))
}

fn application_cache_root(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(root) = integration_state_root() {
        return Ok(root.join("cache"));
    }
    app.path()
        .app_cache_dir()
        .map(process_compatible_path)
        .map_err(|error| error.to_string())
}

fn joined_plugin_roots(runtime: &RuntimePaths) -> Result<PathBuf, String> {
    env::join_paths(runtime.plugin_roots.iter())
        .map(PathBuf::from)
        .map_err(|error| format!("無法組合外掛搜尋路徑：{error}"))
}

fn service_request_value(runtime: &RuntimePaths, command: &str, payload: Value) -> Value {
    #[allow(unused_mut)]
    let mut runtime_payload = json!({
        "ffmpeg": runtime.ffmpeg,
        "ffprobe": runtime.ffprobe,
        "whisperCli": runtime.whisper_cli,
        "nativeCore": runtime.native_core,
        "gpuCompositor": runtime.gpu_compositor,
        "assetBase": runtime.asset_base,
        "cacheRoot": runtime.cache_root,
        "modelRoot": runtime.model_root,
        "creativePackRoot": runtime.creative_pack_root,
        "personalMusicRoot": runtime.personal_music_root,
        "personalVisualRoot": runtime.personal_visual_root,
        "personalColorLutRoot": runtime.personal_color_lut_root,
        "fontRoot": runtime.font_root,
        "colorRoot": runtime.color_root,
        "pluginRoots": runtime.plugin_roots
    });
    #[cfg(feature = "auto-roto-research")]
    {
        let runtime_object = runtime_payload
            .as_object_mut()
            .expect("runtime payload is an object");
        runtime_object.insert(
            "autoRotoModelRoot".into(),
            json!(runtime.auto_roto_model_root),
        );
        runtime_object.insert(
            "autoRotoModelManifest".into(),
            json!(runtime.auto_roto_model_manifest),
        );
        runtime_object.insert(
            "autoRotoVideoModelRoot".into(),
            json!(runtime.auto_roto_video_model_root),
        );
        runtime_object.insert(
            "autoRotoVideoModelManifest".into(),
            json!(runtime.auto_roto_video_model_manifest),
        );
        runtime_object.insert(
            "autoRotoVideoHost".into(),
            json!(runtime.auto_roto_video_host),
        );
        runtime_object.insert(
            "autoRotoDistributionMode".into(),
            json!(runtime.auto_roto_distribution_mode),
        );
        runtime_object.insert(
            "autoRotoExternalResearchEnabled".into(),
            json!(runtime.auto_roto_external_research_enabled),
        );
        runtime_object.insert(
            "autoRotoAllowResearchCandidate".into(),
            json!(runtime.auto_roto_allow_research_candidate),
        );
    }
    json!({ "command": command, "payload": payload, "runtime": runtime_payload })
}

fn service_request(
    services: &service_pool::ServicePool,
    runtime: &RuntimePaths,
    command: &str,
    payload: Value,
) -> Result<Value, String> {
    let request = service_request_value(runtime, command, payload);
    let envelope = services.request(&runtime.node, &runtime.service, command, request)?;
    if envelope.get("ok").and_then(Value::as_bool) == Some(true) {
        Ok(envelope.get("result").cloned().unwrap_or(Value::Null))
    } else {
        Err(envelope
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("Editkin service 失敗")
            .to_string())
    }
}

#[cfg(windows)]
trait HiddenProcess {
    fn creation_flags(&mut self, flags: u32) -> &mut Self;
}

#[cfg(windows)]
impl HiddenProcess for Command {
    fn creation_flags(&mut self, flags: u32) -> &mut Self {
        use std::os::windows::process::CommandExt;
        CommandExt::creation_flags(self, flags)
    }
}

#[cfg(not(windows))]
trait HiddenProcess {
    fn creation_flags(&mut self, _flags: u32) -> &mut Self;
}

#[cfg(not(windows))]
impl HiddenProcess for Command {
    fn creation_flags(&mut self, _flags: u32) -> &mut Self {
        self
    }
}

async fn call_service(
    app: &AppHandle,
    command: &'static str,
    payload: Value,
) -> Result<Value, String> {
    let runtime = runtime_paths(app)?;
    let services = app.state::<AppState>().services.clone();
    tauri::async_runtime::spawn_blocking(move || service_request(&services, &runtime, command, payload))
        .await
        .map_err(|error| error.to_string())?
}

fn update_transaction_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(application_data_root(app)?.join("updates/transaction.json"))
}

fn recovery_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(application_data_root(app)?.join("recovery/session.json"))
}


fn read_json(path: &Path) -> Result<Option<Value>, String> {
    if !path.exists() {
        return Ok(None);
    }
    serde_json::from_slice(&fs::read(path).map_err(|error| error.to_string())?)
        .map(Some)
        .map_err(|error| error.to_string())
}

fn write_json_atomic(path: &Path, value: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let temporary = PathBuf::from(format!(
        "{}.{}.tmp",
        path.to_string_lossy(),
        std::process::id()
    ));
    fs::write(
        &temporary,
        format!(
            "{}\n",
            serde_json::to_string_pretty(value).map_err(|error| error.to_string())?
        ),
    )
    .map_err(|error| error.to_string())?;
    if path.exists() {
        fs::remove_file(path).map_err(|error| error.to_string())?;
    }
    fs::rename(&temporary, path).map_err(|error| error.to_string())
}

/// Owner-only permissions (`0700` directories, `0600` files) on unix, so another
/// local account cannot read a stored secret; Windows relies on the per-user
/// profile ACL.
#[cfg(unix)]
fn restrict_to_owner(path: &Path, mode: u32) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(mode)).map_err(|error| error.to_string())
}

#[cfg(not(unix))]
fn restrict_to_owner(_path: &Path, _mode: u32) -> Result<(), String> {
    Ok(())
}

/// On Unix, use an owner-only parent and a `0600` temporary file. Windows relies
/// on the application-data directory's existing ACLs; those are not changed here.
fn write_private_json_atomic(path: &Path, value: &Value) -> Result<(), String> {
    let parent = path.parent().ok_or("private JSON path has no directory")?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    restrict_to_owner(parent, 0o700)?;
    let temporary = PathBuf::from(format!(
        "{}.{}.tmp",
        path.to_string_lossy(),
        std::process::id()
    ));
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let _ = fs::remove_file(&temporary);
    let written = options.open(&temporary).and_then(|mut file| {
        file.write_all(
            format!(
                "{}\n",
                serde_json::to_string_pretty(value).map_err(std::io::Error::other)?
            )
            .as_bytes(),
        )?;
        file.sync_all()
    });
    if let Err(error) = written {
        let _ = fs::remove_file(&temporary);
        return Err(error.to_string());
    }
    #[cfg(windows)]
    if path.exists() {
        fs::remove_file(path).map_err(|error| error.to_string())?;
    }
    fs::rename(&temporary, path).map_err(|error| error.to_string())
}

fn validate_update_transaction(value: &Value) -> Result<(), String> {
    let object = value.as_object().ok_or("更新 transaction 不是物件")?;
    let status = object.get("status").and_then(Value::as_str).unwrap_or("");
    let string_fields_valid = ["fromVersion", "toVersion", "stagedArtifact", "createdAt"]
        .iter()
        .all(|key| {
            object
                .get(*key)
                .and_then(Value::as_str)
                .is_some_and(|text| !text.is_empty())
        });
    let previous_valid = object
        .get("previousInstaller")
        .is_none_or(|item| item.as_str().is_some_and(|text| !text.is_empty()));
    if object.get("schemaVersion").and_then(Value::as_u64) != Some(1)
        || !["staged", "applying", "healthy", "rollback_required"].contains(&status)
        || !string_fields_valid
        || !previous_valid
        || object
            .get("launchAttempts")
            .and_then(Value::as_u64)
            .is_none()
    {
        return Err("更新 transaction 格式不合法".into());
    }
    Ok(())
}

fn read_update_transaction(path: &Path) -> Result<Option<Value>, String> {
    let backup = PathBuf::from(format!("{}.previous", path.to_string_lossy()));
    match read_json(path).and_then(|value| {
        if let Some(item) = value.as_ref() {
            validate_update_transaction(item)?;
        }
        Ok(value)
    }) {
        Ok(value) => Ok(value),
        Err(primary) => match read_json(&backup).and_then(|value| {
            if let Some(item) = value.as_ref() {
                validate_update_transaction(item)?;
            }
            Ok(value)
        }) {
            Ok(Some(value)) => Ok(Some(value)),
            _ => Err(primary),
        },
    }
}

fn write_update_transaction(path: &Path, value: &Value) -> Result<(), String> {
    validate_update_transaction(value)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let nonce = unix_time_ms();
    let temporary = PathBuf::from(format!(
        "{}.{}.{}.tmp",
        path.to_string_lossy(),
        std::process::id(),
        nonce
    ));
    let backup = PathBuf::from(format!("{}.previous", path.to_string_lossy()));
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|error| error.to_string())?;
    file.write_all(
        format!(
            "{}\n",
            serde_json::to_string_pretty(value).map_err(|error| error.to_string())?
        )
        .as_bytes(),
    )
    .and_then(|_| file.sync_all())
    .map_err(|error| error.to_string())?;
    drop(file);
    let mut moved_current = false;
    let result = (|| {
        if path.exists() {
            let current_valid = read_json(path)
                .ok()
                .flatten()
                .is_some_and(|item| validate_update_transaction(&item).is_ok());
            if current_valid {
                let _ = fs::remove_file(&backup);
                fs::rename(path, &backup).map_err(|error| error.to_string())?;
                moved_current = true;
            } else {
                fs::remove_file(path).map_err(|error| error.to_string())?;
            }
        }
        fs::rename(&temporary, path).map_err(|error| error.to_string())
    })();
    if result.is_err() && moved_current && !path.exists() && backup.exists() {
        let _ = fs::rename(&backup, path);
    }
    let _ = fs::remove_file(&temporary);
    result
}

fn spawn_installer(path: &Path) -> Result<(), String> {
    Command::new(path)
        .arg("/S")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(0x08000008)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("無法啟動更新 installer：{error}"))
}

fn begin_update_launch(app: &AppHandle) -> Result<bool, String> {
    if !cfg!(windows) {
        return Ok(false);
    }
    let path = update_transaction_path(app)?;
    let Some(mut transaction) = read_update_transaction(&path)? else {
        return Ok(false);
    };
    if transaction.get("toVersion").and_then(Value::as_str) != Some(env!("CARGO_PKG_VERSION")) {
        return Ok(false);
    }
    let status = transaction
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("");
    if status == "healthy" {
        return Ok(false);
    }
    if status == "rollback_required" {
        if let Some(previous) = transaction
            .get("previousInstaller")
            .and_then(Value::as_str)
            .map(Path::new)
            .filter(|path| path.exists())
        {
            if launch_verified_rollback_installer(previous) {
                app.exit(0);
            }
        }
        return Ok(false);
    }
    if status != "staged" && status != "applying" {
        return Ok(false);
    }
    let attempts = transaction
        .get("launchAttempts")
        .and_then(Value::as_u64)
        .unwrap_or(0)
        + 1;
    transaction["launchAttempts"] = json!(attempts);
    transaction["status"] = json!(if attempts >= 2 {
        "rollback_required"
    } else {
        "applying"
    });
    write_update_transaction(&path, &transaction)?;
    if attempts >= 2 {
        if let Some(previous) = transaction
            .get("previousInstaller")
            .and_then(Value::as_str)
            .map(Path::new)
            .filter(|path| path.exists())
        {
            if launch_verified_rollback_installer(previous) {
                app.exit(0);
            }
        }
        return Ok(false);
    }
    Ok(true)
}

fn signer_identity_matches(
    actual_subject: &str,
    actual_sha256: &str,
    expected_subject: &str,
    expected_sha256: &str,
) -> bool {
    actual_subject
        .trim()
        .eq_ignore_ascii_case(expected_subject.trim())
        && actual_sha256.len() == 64
        && actual_sha256
            .chars()
            .all(|character| character.is_ascii_hexdigit())
        && actual_sha256.eq_ignore_ascii_case(expected_sha256)
}

fn verify_authenticode(
    path: &str,
    expected_subject: &str,
    expected_sha256: &str,
) -> Result<(), String> {
    if !cfg!(windows) {
        return Err("Authenticode 驗證目前只支援 Windows".into());
    }
    let script = "$s=Get-AuthenticodeSignature -LiteralPath $env:EDITKIN_SIGNATURE_TARGET; $c=$s.SignerCertificate; $sha=if($c){[BitConverter]::ToString($c.GetCertHash([Security.Cryptography.HashAlgorithmName]::SHA256)).Replace('-','').ToLowerInvariant()}else{''}; [pscustomobject]@{Status=[string]$s.Status;Subject=[string]$c.Subject;CertificateSha256=$sha} | ConvertTo-Json -Compress";
    let output = Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .env("EDITKIN_SIGNATURE_TARGET", path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(0x08000000)
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(format!(
            "Authenticode 驗證失敗：{}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    let signature: Value = serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("Authenticode 回應無法解析：{error}"))?;
    let status = signature
        .get("Status")
        .and_then(Value::as_str)
        .unwrap_or("");
    let subject = signature
        .get("Subject")
        .and_then(Value::as_str)
        .unwrap_or("");
    let sha256 = signature
        .get("CertificateSha256")
        .and_then(Value::as_str)
        .unwrap_or("");
    if status == "Valid"
        && signer_identity_matches(subject, sha256, expected_subject, expected_sha256)
    {
        Ok(())
    } else {
        Err(format!(
            "Authenticode 身分不符合：{status} / {subject} / {sha256}"
        ))
    }
}

/// Publisher identity compiled into this build. The update manifest is never trusted to state it.
struct UpdatePublisherPin {
    manifest_url: String,
    signature_subject: String,
    signature_sha256: String,
}

/// Returns the pinned publisher, or None when this build ships no update channel (every field null).
fn parse_update_publisher_pin(document: &str) -> Result<Option<UpdatePublisherPin>, String> {
    let value: Value = serde_json::from_str(document)
        .map_err(|error| format!("更新發布者釘選無法解析：{error}"))?;
    let object = value.as_object().ok_or("更新發布者釘選不是物件")?;
    let mut keys = object.keys().map(String::as_str).collect::<Vec<_>>();
    keys.sort_unstable();
    if keys != ["manifestUrl", "schema", "signatureSha256", "signatureSubject"] {
        return Err("更新發布者釘選欄位不是封閉集合".into());
    }
    if object["schema"].as_str() != Some("editkin.update-publisher-pin/v1") {
        return Err("更新發布者釘選 schema 不支援".into());
    }
    let (manifest_url, subject, sha256) = (
        &object["manifestUrl"],
        &object["signatureSubject"],
        &object["signatureSha256"],
    );
    if manifest_url.is_null() && subject.is_null() && sha256.is_null() {
        return Ok(None);
    }
    let (Some(manifest_url), Some(subject), Some(sha256)) =
        (manifest_url.as_str(), subject.as_str(), sha256.as_str())
    else {
        return Err("更新發布者釘選必須同時設定 manifestUrl、signatureSubject 與 signatureSha256，或全部為 null".into());
    };
    let subject = subject.trim();
    if subject.is_empty() || subject.len() > 1024 || subject.chars().any(char::is_control) {
        return Err("更新發布者釘選 signatureSubject 不合法".into());
    }
    if !lower_sha256(Some(sha256)) {
        return Err("更新發布者釘選 signatureSha256 必須是小寫 SHA-256".into());
    }
    if !manifest_url.starts_with("https://")
        || manifest_url
            .chars()
            .any(|character| character.is_control() || character.is_whitespace() || character == '#')
    {
        return Err("更新發布者釘選 manifestUrl 必須是無 fragment 的 HTTPS URL".into());
    }
    Ok(Some(UpdatePublisherPin {
        manifest_url: manifest_url.into(),
        signature_subject: subject.into(),
        signature_sha256: sha256.into(),
    }))
}

/// Only development builds may redirect the update channel; a release build follows its pinned manifest URL.
fn select_update_manifest_url(
    debug_build: bool,
    environment: Option<String>,
    pin: Option<&UpdatePublisherPin>,
) -> Option<String> {
    environment
        .filter(|_| debug_build)
        .or_else(|| pin.map(|pin| pin.manifest_url.clone()))
}

fn same_update_path(left: &Path, right: &Path) -> bool {
    if cfg!(windows) {
        PathBuf::from(left.to_string_lossy().to_lowercase())
            == PathBuf::from(right.to_string_lossy().to_lowercase())
    } else {
        left == right
    }
}

/// Rechecks the exact staged bytes right before they are executed: canonical cache path, no
/// symlink or junction, a regular file, and the size and SHA-256 recorded when it was staged.
fn verify_staged_installer(
    update_root: &Path,
    artifact: &str,
    size: u64,
    sha256: &str,
) -> Result<(), String> {
    if size == 0 || !lower_sha256(Some(sha256)) {
        return Err("已暫存更新的身分不合法".into());
    }
    let directory = update_root.join(format!("sha256-{sha256}"));
    let installer = directory.join("installer.exe");
    if !same_update_path(Path::new(artifact), &installer) {
        return Err("更新檔路徑不符合已驗證的快取身分".into());
    }
    for component in [update_root, directory.as_path(), installer.as_path()] {
        let metadata = fs::symlink_metadata(component)
            .map_err(|error| format!("更新快取無法檢查：{error}"))?;
        if metadata.file_type().is_symlink() {
            return Err("更新快取拒絕 symlink／junction".into());
        }
    }
    let (actual, total, _) = bounded_file_sha256(&installer, size)
        .map_err(|error| format!("已暫存的更新檔無法驗證：{error}"))?;
    if total != size || actual != sha256 {
        return Err("已暫存的更新檔大小或 SHA-256 不符，拒絕啟動".into());
    }
    Ok(())
}

/// Runs the previous installer only if it carries the pinned publisher signature; returns whether
/// it started. A refusal is logged and never blocks the app from starting.
fn launch_verified_rollback_installer(previous: &Path) -> bool {
    let launched = parse_update_publisher_pin(UPDATE_PUBLISHER_PIN).and_then(|pin| {
        let pin = pin.ok_or_else(|| {
            String::from("此版本沒有內建釘選的發布者 Authenticode 身分，拒絕執行 rollback installer")
        })?;
        verify_authenticode(
            &previous.to_string_lossy(),
            &pin.signature_subject,
            &pin.signature_sha256,
        )?;
        spawn_installer(previous)
    });
    if let Err(error) = &launched {
        eprintln!("Rollback installer refused: {error}");
    }
    launched.is_ok()
}

fn string_field<'a>(value: &'a Value, field: &str) -> Result<&'a str, String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("缺少欄位：{field}"))
}

/// UNC (`\\host\share`), `\\?\UNC\` and device (`\\.\`, `\\?\Volume{..}`) paths
/// are absolute on Windows, but touching one opens an SMB connection (and may
/// send NTLM credentials) to a host named by an untrusted project file. Only a
/// verbatim drive path (`\\?\C:\`) stays local. `\??\` hands the rest of the
/// path to the NT object manager unparsed (`\??\UNC\host\share`), so no path
/// with that prefix is local media. Mirrors `src/shared/localMediaPath.ts`.
fn is_windows_network_path(path: &str) -> bool {
    let normalized = path.replace('/', "\\");
    let bytes = normalized.as_bytes();
    let verbatim_drive = normalized.starts_with("\\\\?\\")
        && bytes.len() >= 6
        && bytes[4].is_ascii_alphabetic()
        && bytes[5] == b':'
        && bytes.get(6).is_none_or(|byte| *byte == b'\\');
    (normalized.starts_with("\\\\") && !verbatim_drive)
        || normalized.starts_with("\\??\\")
        || normalized
            .split(['\\', ':'])
            .any(is_windows_reserved_device_name)
}

/// Win32 opens a DOS device instead of a file for these names in any letter
/// case, also with trailing spaces (`NUL `) and, before Windows 11, with an
/// extension (`nul.txt`, `NUL .txt`); `:` also ends a name (`C:NUL`). Classic
/// Win32 only maps the final component to a device; every component is checked
/// anyway, a conservative choice that also covers a folder later opened on its
/// own. COM0 and LPT0 are not on Microsoft's current list but are rejected too.
fn is_windows_reserved_device_name(name: &str) -> bool {
    let base = name
        .split('.')
        .next()
        .unwrap_or_default()
        .trim_end_matches(' ')
        .to_uppercase();
    match base.as_str() {
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$" => true,
        _ => base
            .strip_prefix("COM")
            .or_else(|| base.strip_prefix("LPT"))
            .is_some_and(|port| {
                let mut chars = port.chars();
                matches!(chars.next(), Some('0'..='9' | '¹' | '²' | '³')) && chars.next().is_none()
            }),
    }
}

/// What keeps a path string from being a plain local absolute path, decided from its text alone (no file-system
/// call), or None when it is one. This is the one shared rule for every path Editkin takes from the webview, a
/// chooser or a project: each caller maps the verdict to its own message and adds its own extra rules on top.
/// A network or device form is reported as `NetworkOrDevice` even when it is also not absolute (`\??\…`, `C:NUL`),
/// so a caller that refuses only network paths can never let one through. Network, device and stream forms are
/// Windows rules; elsewhere `//x`, `NUL` and `a:b` are ordinary paths. Mirrors `localPathTextProblem` in
/// `src/shared/localMediaPath.ts`; both are checked against `src/shared/localPathVerdicts.json`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum LocalPathProblem {
    NotAbsolute,
    NetworkOrDevice,
    AlternateStream,
}

pub(crate) fn local_path_text_problem(path: &str) -> Option<LocalPathProblem> {
    if cfg!(windows) && is_windows_network_path(path) {
        return Some(LocalPathProblem::NetworkOrDevice);
    }
    if !Path::new(path).is_absolute() {
        return Some(LocalPathProblem::NotAbsolute);
    }
    if cfg!(windows) && windows_alternate_stream_path(path) {
        return Some(LocalPathProblem::AlternateStream);
    }
    None
}

/// The single-import check for a media source path, decided from its text before anything opens it: an
/// absolute path that is not a network share, a device or an NTFS alternate data stream. `allow_path` runs it
/// on every import; the media chooser, drag-and-drop, the batch chooser and relink run it on their paths before
/// any probe or file-system call, and preview/export bindings before asking whether the file exists.
fn media_source_path_check(path: &str) -> Result<(), String> {
    match local_path_text_problem(path) {
        None => Ok(()),
        Some(LocalPathProblem::NetworkOrDevice) if Path::new(path).is_absolute() => Err(format!(
            "拒絕網路共用或裝置路徑作為媒體來源，請先以一般檔名複製到本機磁碟：{path}"
        )),
        Some(LocalPathProblem::AlternateStream) => Err(format!(
            "拒絕檔名裡帶冒號的路徑作為媒體來源（這是檔案的隱藏資料串流，不是檔案本身），請改用一般檔名：{path}"
        )),
        // Not absolute, including a device form that is not even absolute (`\??\…`, `C:NUL`): the not-absolute
        // message, as before.
        Some(LocalPathProblem::NotAbsolute | LocalPathProblem::NetworkOrDevice) => {
            Err(format!("媒體路徑不是 absolute path：{path}"))
        }
    }
}

/// `C:\clip.mp4:stream` names an NTFS alternate data stream of `clip.mp4`, not a file. Any `:` after the drive
/// prefix (`C:` or the verbatim `\\?\C:`) is one, or an invalid name; no ordinary Windows file name has one.
fn windows_alternate_stream_path(path: &str) -> bool {
    let normalized = path.replace('/', "\\");
    let rest = normalized.strip_prefix("\\\\?\\").unwrap_or(&normalized);
    let bytes = rest.as_bytes();
    let after_drive = if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' { &rest[2..] } else { rest };
    after_drive.contains(':')
}

/// A media path a preview or export binding names: it must pass the single-import check, and only then is it asked
/// whether it is a regular file (the one file-system call).
fn local_media_binding(path: &str) -> bool {
    local_media_binding_with(path, Path::is_file)
}

/// `local_media_binding` with the file-system question injected (tests count its calls).
fn local_media_binding_with(path: &str, is_file: impl FnOnce(&Path) -> bool) -> bool {
    media_source_path_check(path).is_ok() && is_file(Path::new(path))
}

/// Image layers of a GPU render graph name files the GPU worker opens: each passes the single-import check before
/// the graph is written or the worker sees it. Solid layers name no file.
fn gpu_render_layers_local(layers: &[Value]) -> Result<(), String> {
    for layer in layers {
        if let Some(path) = layer.pointer("/source/path") {
            media_source_path_check(path.as_str().ok_or("GPU render graph 圖層的 path 必須是文字")?)?;
        }
    }
    Ok(())
}

fn allow_path(app: &AppHandle, path: &str) -> Result<(), String> {
    let candidate = Path::new(path);
    media_source_path_check(path)?;
    app.asset_protocol_scope()
        .allow_file(candidate)
        .map_err(|error| error.to_string())
}

/// Records outside-workspace media read grants for files the creator brought into Editkin in this
/// desktop app (chooser, drag-and-drop, relink); the MCP server only reads them. Opening a project
/// grants nothing: the creator is asked first (outside_media_grants::grant_project_outside_media).
/// See outside_media_grants.rs. Best effort: a failure never blocks the import.
async fn record_outside_media_grants(
    app: &AppHandle,
    paths: Vec<String>,
    source: outside_media_grants::GrantSource,
) {
    if paths.is_empty() {
        return;
    }
    let root = match application_data_root(app) {
        Ok(root) => root,
        Err(error) => {
            eprintln!("Outside media grants not recorded: {error}");
            return;
        }
    };
    let now_ms = u64::try_from(unix_time_ms()).unwrap_or(0);
    match tauri::async_runtime::spawn_blocking(move || {
        outside_media_grants::record(&root, &paths, source, now_ms)
    })
    .await
    {
        Ok(Ok(_)) => {}
        Ok(Err(error)) => eprintln!("Outside media grants not recorded: {error}"),
        Err(error) => eprintln!("Outside media grants not recorded: {error}"),
    }
}

const PRODUCT_AUTO_ROTO_ENGINE: &str = "editkin-native-color-temporal-roto/v1";
const PRODUCT_AUTO_ROTO_ROUTE_SCHEMA: &str = "editkin.auto-roto-product-route-receipt/v2";
const PRODUCT_AUTO_ROTO_ROUTE_POLICY: &str = "editkin.auto-roto-product-artifact-policy/2";
const PRODUCT_AUTO_ROTO_ROUTE_SHA256: &str =
    "c1b7d0969045d47ea722c35f5a3aa3db3b9ab1d63ef2308631f819d0e9088ab1";
const PRODUCT_AUTO_ROTO_MAX_FRAMES: usize = 1_440;
const PRODUCT_AUTO_ROTO_MAX_ALPHA_BYTES: u64 = 96 * 1024 * 1024;
const PRODUCT_AUTO_ROTO_MAX_MANIFEST_BYTES: u64 = 8 * 1024 * 1024;
const PRODUCT_AUTO_ROTO_MAX_PREVIEW_BYTES: u64 = 8 * 1024 * 1024;
const PRODUCT_AUTO_ROTO_MAX_PREVIEW_TOTAL_BYTES: u64 = 512 * 1024 * 1024;

fn lower_sha256(value: Option<&str>) -> bool {
    value.is_some_and(|value| {
        value.len() == 64
            && value
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    })
}

fn exact_json_object_keys(value: &serde_json::Map<String, Value>, expected: &[&str]) -> bool {
    let observed = value.keys().map(String::as_str).collect::<BTreeSet<_>>();
    let contract = expected.iter().copied().collect::<BTreeSet<_>>();
    observed == contract
}

fn json_object_keys_allowed(value: &serde_json::Map<String, Value>, allowed: &[&str]) -> bool {
    let contract = allowed.iter().copied().collect::<BTreeSet<_>>();
    value.keys().all(|key| contract.contains(key.as_str()))
}

fn verify_product_auto_roto_identity(value: &Value) -> Result<(), String> {
    if value.get("engine").and_then(Value::as_str) != Some(PRODUCT_AUTO_ROTO_ENGINE)
        || value.get("qualityState").and_then(Value::as_str) != Some("diagnostic")
        || value.get("frozen").and_then(Value::as_bool) != Some(true)
        || !lower_sha256(value.get("sequenceSha256").and_then(Value::as_str))
        || value
            .get("sequenceBytes")
            .and_then(Value::as_u64)
            .unwrap_or(0)
            == 0
        || value
            .get("sequenceBytes")
            .and_then(Value::as_u64)
            .unwrap_or(u64::MAX)
            > PRODUCT_AUTO_ROTO_MAX_ALPHA_BYTES
    {
        return Err("Auto Roto product identity 不合法".into());
    }
    let route = value
        .get("routeReceipt")
        .and_then(Value::as_object)
        .ok_or("Auto Roto 缺少 v2 product route receipt")?;
    let boundary = route
        .get("boundary")
        .and_then(Value::as_object)
        .ok_or("Auto Roto product boundary receipt 不完整")?;
    let provenance = route
        .get("provenance")
        .and_then(Value::as_object)
        .ok_or("Auto Roto product provenance receipt 不完整")?;
    let execution = route
        .get("execution")
        .and_then(Value::as_object)
        .ok_or("Auto Roto product execution receipt 不完整")?;
    let quality = route
        .get("quality")
        .and_then(Value::as_object)
        .ok_or("Auto Roto product quality receipt 不完整")?;
    let candidates = route
        .get("candidates")
        .and_then(Value::as_array)
        .ok_or("Auto Roto product candidate receipt 不完整")?;
    let candidate = candidates
        .first()
        .and_then(Value::as_object)
        .filter(|_| candidates.len() == 1)
        .ok_or("Auto Roto product candidate receipt 不合法")?;
    if !exact_json_object_keys(
        route,
        &[
            "schema",
            "policyVersion",
            "mode",
            "requestedEngine",
            "selectedEngine",
            "status",
            "reasonCode",
            "boundary",
            "provenance",
            "execution",
            "quality",
            "candidates",
            "receiptSha256",
        ],
    ) || !exact_json_object_keys(
        boundary,
        &[
            "serviceArtifactKind",
            "externalResearchRuntime",
            "externalModelWeights",
            "modelInjection",
        ],
    ) || !exact_json_object_keys(
        provenance,
        &["origin", "implementation", "modelAndAlgorithmRights"],
    ) || !exact_json_object_keys(execution, &["regionMemoryPolicy"])
        || !exact_json_object_keys(quality, &["state", "claim", "humanReviewRequired"])
        || !exact_json_object_keys(
            candidate,
            &[
                "engine",
                "configured",
                "origin",
                "rightsClass",
                "qualityTier",
                "decision",
                "reasonCode",
            ],
        )
        || route.get("schema").and_then(Value::as_str) != Some(PRODUCT_AUTO_ROTO_ROUTE_SCHEMA)
        || route.get("policyVersion").and_then(Value::as_str)
            != Some(PRODUCT_AUTO_ROTO_ROUTE_POLICY)
        || route.get("mode").and_then(Value::as_str) != Some("product")
        || route.get("requestedEngine").and_then(Value::as_str) != Some(PRODUCT_AUTO_ROTO_ENGINE)
        || route.get("selectedEngine").and_then(Value::as_str) != Some(PRODUCT_AUTO_ROTO_ENGINE)
        || route.get("status").and_then(Value::as_str) != Some("selected")
        || route.get("reasonCode").and_then(Value::as_str)
            != Some("selected-self-authored-product-artifact")
        || route.get("receiptSha256").and_then(Value::as_str)
            != Some(PRODUCT_AUTO_ROTO_ROUTE_SHA256)
        || boundary.get("serviceArtifactKind").and_then(Value::as_str) != Some("product")
        || boundary
            .get("externalResearchRuntime")
            .and_then(Value::as_str)
            != Some("disabled")
        || boundary
            .get("externalModelWeights")
            .and_then(Value::as_bool)
            != Some(false)
        || boundary.get("modelInjection").and_then(Value::as_str) != Some("forbidden")
        || provenance.get("origin").and_then(Value::as_str) != Some("editkin-self-authored")
        || provenance.get("implementation").and_then(Value::as_str) != Some("native-compiled")
        || provenance
            .get("modelAndAlgorithmRights")
            .and_then(Value::as_str)
            != Some("editkin-owned")
        || execution.get("regionMemoryPolicy").and_then(Value::as_str) != Some("fixed_baseline")
        || quality.get("state").and_then(Value::as_str) != Some("diagnostic")
        || quality.get("claim").and_then(Value::as_str) != Some("unmeasured")
        || quality.get("humanReviewRequired").and_then(Value::as_bool) != Some(true)
        || candidate.get("engine").and_then(Value::as_str) != Some(PRODUCT_AUTO_ROTO_ENGINE)
        || candidate.get("configured").and_then(Value::as_bool) != Some(true)
        || candidate.get("origin").and_then(Value::as_str) != Some("editkin-self-authored")
        || candidate.get("rightsClass").and_then(Value::as_str) != Some("editkin-owned")
        || candidate.get("qualityTier").and_then(Value::as_str) != Some("self-authored-unmeasured")
        || candidate.get("decision").and_then(Value::as_str) != Some("selected")
        || candidate.get("reasonCode").and_then(Value::as_str)
            != Some("compiled-into-product-artifact")
    {
        return Err("Auto Roto v2 product route receipt 漂移".into());
    }
    let routing = value
        .get("regionMemoryRouting")
        .and_then(Value::as_object)
        .ok_or("Auto Roto 缺少 fixed-baseline routing receipt")?;
    if !exact_json_object_keys(
        routing,
        &[
            "schema",
            "requested",
            "executed",
            "candidateAttempted",
            "deterministicFallback",
        ],
    ) || routing.get("schema").and_then(Value::as_str)
        != Some("editkin.region-memory-routing/v1")
        || routing.get("requested").and_then(Value::as_str) != Some("fixed_baseline")
        || routing.get("executed").and_then(Value::as_str) != Some("fixed_baseline")
        || routing.get("candidateAttempted").and_then(Value::as_bool) != Some(false)
        || routing
            .get("deterministicFallback")
            .and_then(Value::as_bool)
            != Some(false)
    {
        return Err("Auto Roto routing receipt 漂移".into());
    }
    let alpha = value
        .get("alphaRefinement")
        .and_then(Value::as_object)
        .ok_or("Auto Roto 缺少 optical alpha receipt")?;
    if !exact_json_object_keys(
        alpha,
        &[
            "schema",
            "engine",
            "appliedFrames",
            "radius",
            "backgroundThreshold",
            "foregroundThreshold",
            "coarseWeight",
            "temporalStability",
            "temporalGate",
            "changedPixels",
            "fractionalPixels",
            "solvedPixels",
            "meanSolveConfidence",
        ],
    ) || alpha.get("schema").and_then(Value::as_str)
        != Some("editkin.optical-alpha-refinement-aggregate/v1")
        || alpha.get("engine").and_then(Value::as_str)
            != Some("editkin-self-authored-optical-alpha-refiner/v1")
    {
        return Err("Auto Roto optical alpha receipt 漂移".into());
    }
    Ok(())
}

fn sha256_hex(hasher: Sha256) -> String {
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn bounded_file_sha256(path: &Path, max_bytes: u64) -> Result<(String, u64, [u8; 8]), String> {
    let before = fs::metadata(path).map_err(|error| error.to_string())?;
    if !before.is_file() || before.len() == 0 || before.len() > max_bytes {
        return Err("Auto Roto artifact 檔案大小超出安全 envelope".into());
    }
    let mut file = fs::File::open(path).map_err(|error| error.to_string())?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 1024 * 1024];
    let mut prefix = [0_u8; 8];
    let mut total = 0_u64;
    loop {
        let read = file.read(&mut buffer).map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        if total == 0 && read >= prefix.len() {
            prefix.copy_from_slice(&buffer[..8]);
        }
        total = total
            .checked_add(read as u64)
            .ok_or("Auto Roto artifact byte count overflow")?;
        if total > max_bytes {
            return Err("Auto Roto artifact 檔案大小超出安全 envelope".into());
        }
        hasher.update(&buffer[..read]);
    }
    let after = fs::metadata(path).map_err(|error| error.to_string())?;
    if total != before.len()
        || after.len() != before.len()
        || after.modified().ok() != before.modified().ok()
    {
        return Err("Auto Roto artifact 在驗證期間發生變更".into());
    }
    Ok((sha256_hex(hasher), total, prefix))
}

fn verify_product_auto_roto_payload_hashes(
    receipt: &Value,
    manifest_path: &Path,
    sequence_path: &Path,
    frame_paths: &[String],
) -> Result<(), String> {
    let manifest_info = fs::metadata(manifest_path).map_err(|error| error.to_string())?;
    if !manifest_info.is_file()
        || manifest_info.len() == 0
        || manifest_info.len() > PRODUCT_AUTO_ROTO_MAX_MANIFEST_BYTES
    {
        return Err("Auto Roto product manifest 超出安全 envelope".into());
    }
    let manifest_bytes = fs::read(manifest_path).map_err(|error| error.to_string())?;
    let manifest: Value = serde_json::from_slice(&manifest_bytes)
        .map_err(|error| format!("Auto Roto product manifest 不是合法 JSON：{error}"))?;
    let object = manifest
        .as_object()
        .ok_or("Auto Roto product manifest 不是物件")?;
    if !exact_json_object_keys(
        object,
        &[
            "schema",
            "engine",
            "width",
            "height",
            "analysisFps",
            "initialFrame",
            "sequencePath",
            "frames",
            "sequenceSha256",
            "sequenceBytes",
            "meanBoundaryChatter",
            "correctionStrokesApplied",
            "correctedFrames",
            "regionMemoryRouting",
            "alphaRefinement",
            "frozen",
            "qualityState",
            "routeReceipt",
        ],
    ) {
        return Err("Auto Roto product manifest 欄位不符合封閉式 v2 contract".into());
    }
    verify_product_auto_roto_identity(&manifest)?;
    for field in [
        "schema",
        "engine",
        "width",
        "height",
        "analysisFps",
        "sequenceSha256",
        "sequenceBytes",
        "meanBoundaryChatter",
        "correctionStrokesApplied",
        "correctedFrames",
        "regionMemoryRouting",
        "alphaRefinement",
        "frozen",
        "qualityState",
        "routeReceipt",
    ] {
        if manifest.get(field) != receipt.get(field) {
            return Err(format!(
                "Auto Roto product manifest 與產品 receipt 欄位不一致：{field}"
            ));
        }
    }
    if manifest.get("sequencePath").and_then(Value::as_str) != sequence_path.to_str() {
        return Err("Auto Roto product manifest sequencePath 漂移".into());
    }
    let frames = manifest
        .get("frames")
        .and_then(Value::as_array)
        .ok_or("Auto Roto product manifest 缺少 frames")?;
    if frames.len() != frame_paths.len() {
        return Err("Auto Roto product manifest frame inventory 不完整".into());
    }
    let width = manifest
        .get("width")
        .and_then(Value::as_u64)
        .ok_or("Auto Roto width 不合法")?;
    let height = manifest
        .get("height")
        .and_then(Value::as_u64)
        .ok_or("Auto Roto height 不合法")?;
    let frame_bytes = width
        .checked_mul(height)
        .ok_or("Auto Roto frame byte count overflow")?;
    let expected_sequence_bytes = frame_bytes
        .checked_mul(frames.len() as u64)
        .ok_or("Auto Roto sequence byte count overflow")?;
    if width < 16
        || height < 16
        || width > 32_768
        || height > 32_768
        || expected_sequence_bytes == 0
        || expected_sequence_bytes > PRODUCT_AUTO_ROTO_MAX_ALPHA_BYTES
        || manifest.get("sequenceBytes").and_then(Value::as_u64) != Some(expected_sequence_bytes)
        || fs::metadata(sequence_path)
            .map_err(|error| error.to_string())?
            .len()
            != expected_sequence_bytes
    {
        return Err("Auto Roto sequence dimensions 或 byte inventory 不合法".into());
    }
    let mut sequence_file = fs::File::open(sequence_path).map_err(|error| error.to_string())?;
    let mut sequence_hasher = Sha256::new();
    let mut buffer = vec![0_u8; 1024 * 1024];
    for (index, frame) in frames.iter().enumerate() {
        let frame_object = frame
            .as_object()
            .ok_or("Auto Roto frame receipt 不是物件")?;
        if !exact_json_object_keys(
            frame_object,
            &[
                "frame",
                "time",
                "alphaPath",
                "confidence",
                "foregroundRatio",
                "boundaryChatter",
                "previewSha256",
                "alphaFrameSha256",
            ],
        ) || frame.get("frame").and_then(Value::as_u64) != Some(index as u64)
            || frame.get("alphaPath").and_then(Value::as_str) != Some(frame_paths[index].as_str())
            || !lower_sha256(frame.get("previewSha256").and_then(Value::as_str))
            || !lower_sha256(frame.get("alphaFrameSha256").and_then(Value::as_str))
        {
            return Err(format!("Auto Roto frame {index} receipt 不合法"));
        }
        let mut remaining = frame_bytes;
        let mut frame_hasher = Sha256::new();
        while remaining > 0 {
            let chunk = usize::try_from(remaining.min(buffer.len() as u64))
                .map_err(|_| "Auto Roto frame chunk overflow")?;
            sequence_file
                .read_exact(&mut buffer[..chunk])
                .map_err(|_| "Auto Roto matte sequence 提前結束")?;
            frame_hasher.update(&buffer[..chunk]);
            sequence_hasher.update(&buffer[..chunk]);
            remaining -= chunk as u64;
        }
        if frame.get("alphaFrameSha256").and_then(Value::as_str)
            != Some(sha256_hex(frame_hasher).as_str())
        {
            return Err(format!("Auto Roto frame {index} alpha receipt 驗證失敗"));
        }
    }
    let mut trailing = [0_u8; 1];
    if sequence_file
        .read(&mut trailing)
        .map_err(|error| error.to_string())?
        != 0
        || manifest.get("sequenceSha256").and_then(Value::as_str)
            != Some(sha256_hex(sequence_hasher).as_str())
    {
        return Err("Auto Roto matte sequence SHA-256 驗證失敗".into());
    }
    let mut preview_total = 0_u64;
    for (index, path) in frame_paths.iter().enumerate() {
        let (digest, bytes, prefix) =
            bounded_file_sha256(Path::new(path), PRODUCT_AUTO_ROTO_MAX_PREVIEW_BYTES)?;
        preview_total = preview_total
            .checked_add(bytes)
            .ok_or("Auto Roto preview byte count overflow")?;
        if preview_total > PRODUCT_AUTO_ROTO_MAX_PREVIEW_TOTAL_BYTES
            || prefix != [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]
            || frames[index].get("previewSha256").and_then(Value::as_str) != Some(digest.as_str())
        {
            return Err(format!("Auto Roto frame {index} preview receipt 驗證失敗"));
        }
    }
    Ok(())
}

fn verify_product_auto_roto_preview_inventory(
    app: &AppHandle,
    receipt: &Value,
    manifest_path: &str,
    sequence_path: &str,
    frame_paths: &[String],
    expected_frame_count: usize,
) -> Result<Vec<String>, String> {
    if expected_frame_count == 0
        || expected_frame_count > PRODUCT_AUTO_ROTO_MAX_FRAMES
        || frame_paths.len() != expected_frame_count
    {
        return Err("Auto Roto preview inventory 數量不合法".into());
    }
    let cache_root = application_cache_root(app)?.join("media-cache");
    let product_root = cache_root.join("auto-roto-product");
    let manifest = PathBuf::from(manifest_path);
    let sequence = PathBuf::from(sequence_path);
    let artifact_root = manifest
        .parent()
        .ok_or("Auto Roto manifest 缺少 artifact root")?;
    let generation = artifact_root
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("Auto Roto artifact generation 不合法")?;
    if !lower_sha256(Some(generation))
        || manifest != artifact_root.join("matte-manifest.json")
        || sequence != artifact_root.join("matte-sequence.alpha8")
    {
        return Err("Auto Roto preview 路徑不符合內容定址 layout".into());
    }
    for (index, path) in frame_paths.iter().enumerate() {
        if PathBuf::from(path) != artifact_root.join(format!("frame-{index:06}.png")) {
            return Err("Auto Roto preview frame 離開封閉 inventory".into());
        }
    }
    let lexical_paths = std::iter::once(cache_root.as_path())
        .chain(std::iter::once(product_root.as_path()))
        .chain(std::iter::once(artifact_root))
        .chain(std::iter::once(manifest.as_path()))
        .chain(std::iter::once(sequence.as_path()))
        .chain(frame_paths.iter().map(Path::new));
    for path in lexical_paths {
        let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
        if metadata.file_type().is_symlink() {
            return Err("Auto Roto preview inventory 含 symbolic link/junction".into());
        }
    }
    let canonical_product_root =
        fs::canonicalize(&product_root).map_err(|error| error.to_string())?;
    let canonical_artifact_root =
        fs::canonicalize(artifact_root).map_err(|error| error.to_string())?;
    if canonical_artifact_root.parent() != Some(canonical_product_root.as_path()) {
        return Err("Auto Roto preview realpath 離開 product cache boundary".into());
    }
    for path in std::iter::once(manifest.as_path())
        .chain(std::iter::once(sequence.as_path()))
        .chain(frame_paths.iter().map(Path::new))
    {
        let canonical = fs::canonicalize(path).map_err(|error| error.to_string())?;
        if canonical.parent() != Some(canonical_artifact_root.as_path())
            || !fs::metadata(&canonical)
                .map_err(|error| error.to_string())?
                .is_file()
        {
            return Err("Auto Roto preview payload realpath 不合法".into());
        }
    }
    let expected: BTreeSet<String> = std::iter::once("matte-manifest.json".to_string())
        .chain(std::iter::once("matte-sequence.alpha8".to_string()))
        .chain((0..frame_paths.len()).map(|index| format!("frame-{index:06}.png")))
        .collect();
    let observed: BTreeSet<String> = fs::read_dir(&canonical_artifact_root)
        .map_err(|error| error.to_string())?
        .map(|entry| {
            let entry = entry.map_err(|error| error.to_string())?;
            if entry
                .file_type()
                .map_err(|error| error.to_string())?
                .is_symlink()
                || !entry
                    .metadata()
                    .map_err(|error| error.to_string())?
                    .is_file()
            {
                return Err("Auto Roto artifact root 含不支援的檔案型態".into());
            }
            entry
                .file_name()
                .into_string()
                .map_err(|_| "Auto Roto artifact filename 不是 UTF-8".to_string())
        })
        .collect::<Result<_, String>>()?;
    if observed != expected {
        return Err("Auto Roto artifact root 含未證明的額外檔案".into());
    }
    verify_product_auto_roto_payload_hashes(receipt, &manifest, &sequence, frame_paths)?;
    Ok(frame_paths.to_vec())
}

fn product_auto_roto_result_preview_paths(
    app: &AppHandle,
    result: &Value,
) -> Result<Vec<String>, String> {
    let result_object = result.as_object().ok_or("Auto Roto result 不是物件")?;
    if !exact_json_object_keys(
        result_object,
        &[
            "schema",
            "engine",
            "width",
            "height",
            "analysisFps",
            "initialFrame",
            "sequencePath",
            "frames",
            "sequenceSha256",
            "sequenceBytes",
            "meanBoundaryChatter",
            "correctionStrokesApplied",
            "correctedFrames",
            "regionMemoryRouting",
            "alphaRefinement",
            "frozen",
            "qualityState",
            "routeReceipt",
            "manifestPath",
            "analyzedSeconds",
            "elapsedMs",
            "cacheHit",
        ],
    ) {
        return Err("Auto Roto result 欄位不符合封閉式產品 contract".into());
    }
    verify_product_auto_roto_identity(result)?;
    let manifest = string_field(result, "manifestPath")?;
    let sequence = string_field(result, "sequencePath")?;
    let frames = result
        .get("frames")
        .and_then(Value::as_array)
        .ok_or("Auto Roto result 缺少 frames")?;
    let paths = frames
        .iter()
        .map(|frame| string_field(frame, "alphaPath").map(str::to_string))
        .collect::<Result<Vec<_>, _>>()?;
    let verified = verify_product_auto_roto_preview_inventory(
        app,
        result,
        manifest,
        sequence,
        &paths,
        frames.len(),
    )?;
    for path in &verified {
        allow_path(app, path)?;
    }
    Ok(verified)
}

// Editable timing metadata is not an artifact receipt and cannot make an old
// sequence current. It must survive Save/Open without granting preview access.
fn product_auto_roto_time_invalidated(sequence: &Value) -> Result<bool, String> {
    match sequence.get("staleReason") {
        None => Ok(false),
        Some(reason)
            if reason.as_str() == Some("clip-time-range-changed")
                && sequence.get("stale").and_then(Value::as_bool) == Some(true) =>
        {
            Ok(true)
        }
        Some(_) => Err("Auto Roto 時域失效原因不合法，或缺少 stale=true".into()),
    }
}

fn collect_product_auto_roto_preview_paths(
    app: &AppHandle,
    project: &Value,
) -> Result<Vec<String>, String> {
    let mut verified = BTreeSet::new();
    let mut track_sets = Vec::new();
    if let Some(tracks) = project.get("tracks").and_then(Value::as_array) {
        track_sets.push(tracks);
    }
    if let Some(compositions) = project.get("compositions").and_then(Value::as_array) {
        for composition in compositions {
            if let Some(tracks) = composition.get("tracks").and_then(Value::as_array) {
                track_sets.push(tracks);
            }
        }
    }
    for tracks in track_sets {
        for track in tracks {
            let Some(clips) = track.get("clips").and_then(Value::as_array) else {
                continue;
            };
            for clip in clips {
                let Some(masks) = clip.get("masks").and_then(Value::as_array) else {
                    continue;
                };
                for mask in masks {
                    let Some(sequence) = mask.get("matteSequence") else {
                        continue;
                    };
                    let sequence_object = sequence
                        .as_object()
                        .ok_or("Auto Roto EditGraph matteSequence 不是物件")?;
                    if !json_object_keys_allowed(
                        sequence_object,
                        &[
                            "schema",
                            "engine",
                            "width",
                            "height",
                            "analysisFps",
                            "frameCount",
                            "sequenceUri",
                            "sequenceSha256",
                            "sequenceBytes",
                            "manifestUri",
                            "frameArtifactUris",
                            "meanBoundaryChatter",
                            "correctionStrokesApplied",
                            "correctedFrames",
                            "alphaRefinement",
                            "regionMemoryRouting",
                            "routeReceipt",
                            "stale",
                            "staleReason",
                            "frozen",
                            "qualityState",
                        ],
                    ) {
                        return Err("Auto Roto EditGraph matteSequence 含未允許的產品欄位".into());
                    }
                    let time_invalidated = product_auto_roto_time_invalidated(sequence)?;
                    verify_product_auto_roto_identity(sequence)?;
                    let manifest = string_field(sequence, "manifestUri")?;
                    let sequence_path = string_field(sequence, "sequenceUri")?;
                    let expected_frame_count = sequence
                        .get("frameCount")
                        .and_then(Value::as_u64)
                        .and_then(|value| usize::try_from(value).ok())
                        .ok_or("Auto Roto EditGraph frameCount 不合法")?;
                    let frame_paths = sequence
                        .get("frameArtifactUris")
                        .and_then(Value::as_array)
                        .ok_or("Auto Roto EditGraph 缺少 frameArtifactUris")?;
                    let frame_paths = frame_paths
                        .iter()
                        .map(Value::as_str)
                        .collect::<Option<Vec<_>>>()
                        .map(|paths| paths.into_iter().map(str::to_string).collect::<Vec<_>>());
                    let frame_paths =
                        frame_paths.ok_or("Auto Roto EditGraph frameArtifactUris 含非字串路徑")?;
                    let paths = verify_product_auto_roto_preview_inventory(
                        app,
                        sequence,
                        manifest,
                        sequence_path,
                        &frame_paths,
                        expected_frame_count,
                    )?;
                    if time_invalidated {
                        continue;
                    }
                    for path in paths {
                        allow_path(app, &path)?;
                        verified.insert(path);
                    }
                }
            }
        }
    }
    Ok(verified.into_iter().collect())
}

fn collect_runtime_paths(
    app: &AppHandle,
    assets: &[Value],
) -> Result<serde_json::Map<String, Value>, String> {
    let mut paths = serde_json::Map::new();
    for asset in assets {
        let id = string_field(asset, "id")?;
        let source = string_field(asset, "uri")?;
        if Path::new(source).is_absolute() {
            allow_path(app, source)?;
            paths.insert(format!("{id}:source"), Value::String(source.to_string()));
        }
        let derivatives = asset.get("derivatives");
        let proxy = derivatives
            .and_then(|item| item.get("proxyUri"))
            .and_then(Value::as_str)
            .filter(|path| Path::new(path).is_absolute());
        let overlay_proxy = derivatives
            .and_then(|item| item.get("overlayProxyUri"))
            .and_then(Value::as_str);
        let sequence_preview = asset
            .get("imageSequence")
            .and_then(|item| item.get("previewUri"))
            .and_then(Value::as_str);
        let preview = proxy.or(sequence_preview).unwrap_or(source);
        if Path::new(preview).is_absolute() {
            allow_path(app, preview)?;
            paths.insert(id.to_string(), Value::String(preview.to_string()));
        }
        if let Some(path) = proxy {
            allow_path(app, path)?;
            paths.insert(format!("{id}:proxy"), Value::String(path.to_string()));
        }
        if let Some(path) = overlay_proxy.filter(|path| Path::new(path).is_absolute()) {
            allow_path(app, path)?;
            paths.insert(
                format!("{id}:overlay-proxy"),
                Value::String(path.to_string()),
            );
        }
        for (field, suffix) in [("thumbnailUri", "thumbnail"), ("waveformUri", "waveform")] {
            if let Some(path) = derivatives
                .and_then(|item| item.get(field))
                .and_then(Value::as_str)
            {
                if Path::new(path).is_absolute() {
                    allow_path(app, path)?;
                    paths.insert(format!("{id}:{suffix}"), Value::String(path.to_string()));
                }
            }
        }
    }
    Ok(paths)
}

const CREATIVE_URI_PREFIX: &str = "creative://studio.hao.creator-library/";

fn percent_decode(value: &str) -> Result<String, String> {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            if index + 2 >= bytes.len() {
                return Err("Creative Pack URI percent encoding 不完整".into());
            }
            let hex = std::str::from_utf8(&bytes[index + 1..index + 3])
                .map_err(|error| error.to_string())?;
            decoded.push(
                u8::from_str_radix(hex, 16)
                    .map_err(|_| "Creative Pack URI percent encoding 不合法")?,
            );
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(decoded).map_err(|error| error.to_string())
}

fn percent_encode(value: &str) -> String {
    value
        .as_bytes()
        .iter()
        .map(|byte| {
            if byte.is_ascii_alphanumeric() || [b'-', b'_', b'.', b'~'].contains(byte) {
                (*byte as char).to_string()
            } else {
                format!("%{byte:02X}")
            }
        })
        .collect()
}

fn creative_asset_id(uri: &str) -> Result<Option<String>, String> {
    let Some(encoded) = uri.strip_prefix(CREATIVE_URI_PREFIX) else {
        return Ok(None);
    };
    let id = percent_decode(encoded)?;
    if id.is_empty() || id.contains('/') || id.contains('\\') {
        return Err("Creative Pack URI 不合法".into());
    }
    Ok(Some(id))
}

async fn collect_runtime_paths_async(
    app: &AppHandle,
    assets: &[Value],
) -> Result<serde_json::Map<String, Value>, String> {
    let mut paths = collect_runtime_paths(app, assets)?;
    for asset in assets {
        let id = string_field(asset, "id")?;
        let uri = string_field(asset, "uri")?;
        let Some(creative_id) = creative_asset_id(uri)? else {
            continue;
        };
        let resolved = call_service(
            app,
            "resolve_creative_asset",
            json!({ "assetId": creative_id }),
        )
        .await?;
        let source = string_field(&resolved, "absolutePath")?;
        allow_path(app, source)?;
        insert_original_runtime_path(&mut paths, id, source);
    }
    Ok(paths)
}

// Called only after allow_path verifies the resolved creative original. A derived
// main preview must not be replaced by an original the browser cannot decode.
fn insert_original_runtime_path(
    paths: &mut serde_json::Map<String, Value>,
    id: &str,
    source: &str,
) {
    paths
        .entry(id.to_string())
        .or_insert_with(|| Value::String(source.to_string()));
    paths.insert(format!("{id}:source"), Value::String(source.to_string()));
}

#[cfg(test)]
mod runtime_original_projection_tests {
    use super::*;
    #[test]
    fn creative_original_preserves_main_proxy_and_overlay() {
        let mut paths = serde_json::Map::new();
        paths.insert("a".into(), json!("proxy.mp4"));
        paths.insert("a:proxy".into(), json!("proxy.mp4"));
        paths.insert("a:overlay-proxy".into(), json!("overlay.mp4"));
        insert_original_runtime_path(&mut paths, "a", "original.mov");
        assert_eq!(paths.get("a"), Some(&json!("proxy.mp4")));
        assert_eq!(paths.get("a:proxy"), Some(&json!("proxy.mp4")));
        assert_eq!(paths.get("a:overlay-proxy"), Some(&json!("overlay.mp4")));
        assert_eq!(paths.get("a:source"), Some(&json!("original.mov")));
    }
    #[test]
    fn original_fills_main_only_when_absent() {
        let mut paths = serde_json::Map::new();
        insert_original_runtime_path(&mut paths, "a", "original.mov");
        assert_eq!(paths.get("a"), paths.get("a:source"));
        assert!(!paths.contains_key("a:proxy"));
    }
}

#[tauri::command]
async fn pick_media(app: AppHandle, ui_locale: Option<String>, image_only: Option<bool>) -> Result<Vec<PickedMedia>, String> {
    // imageOnly: the 「模板片段」 picture slot chooser (one still picture); otherwise the media chooser (several files).
    let image_only = image_only.unwrap_or(false);
    let dialog = FileDialog::new()
        .set_title(native_dialog_labels::text(ui_locale.as_deref(), DialogText::MediaTitle))
        .add_filter(
            native_dialog_labels::text(ui_locale.as_deref(), DialogText::MediaFilter),
            media_picker_extensions(image_only),
        );
    let selected = if image_only { dialog.pick_file().into_iter().collect() } else { dialog.pick_files().unwrap_or_default() };
    import_media_path_bufs(&app, selected).await
}

/// File types the media chooser offers; the template picture chooser offers still pictures only.
fn media_picker_extensions(image_only: bool) -> &'static [&'static str] {
    if image_only {
        return &["png", "jpg", "jpeg", "webp"];
    }
    &[
        "mp4", "mov", "mkv", "webm", "m4v", "mp3", "wav", "m4a", "aac", "flac", "png",
        "jpg", "jpeg", "webp", "exr", "json",
    ]
}

#[cfg(test)]
mod media_picker_extension_tests {
    use super::*;
    #[test]
    fn style_template_picture_chooser_offers_still_pictures_only() {
        let pictures = media_picker_extensions(true);
        assert_eq!(pictures, &["png", "jpg", "jpeg", "webp"]);
        for extension in pictures {
            assert!(media_picker_extensions(false).contains(extension));
            assert!(supported_media_path(Path::new(&format!("picture.{extension}"))));
        }
        for extension in ["mp4", "mov", "wav", "exr", "json"] {
            assert!(!pictures.contains(&extension));
            assert!(media_picker_extensions(false).contains(&extension));
        }
    }
}

fn supported_media_path(path: &Path) -> bool {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    [
        "mp4", "mov", "mkv", "webm", "m4v", "mp3", "wav", "m4a", "aac", "flac", "png", "jpg",
        "jpeg", "webp", "exr", "json",
    ]
    .contains(&extension.as_str())
}

#[tauri::command]
async fn import_media_paths(
    app: AppHandle,
    paths: Vec<String>,
) -> Result<Vec<PickedMedia>, String> {
    let selected = checked_drop_paths(paths, Path::is_file)?;
    import_media_path_bufs(&app, selected).await
}

/// Drag-and-drop paths, checked before anything touches them. A relative path keeps the drag-drop message; a network
/// share, device or stream path is refused by the single-import check; only then is `is_file` (the one file-system
/// call, injected for tests) asked.
fn checked_drop_paths(paths: Vec<String>, is_file: impl Fn(&Path) -> bool) -> Result<Vec<PathBuf>, String> {
    if paths.len() > 256 {
        return Err("一次最多拖入 256 份素材".into());
    }
    let mut selected = Vec::with_capacity(paths.len());
    for raw in paths {
        let path = PathBuf::from(raw);
        // The single-import check before anything touches the path.
        if path.is_absolute() {
            media_source_path_check(&path.to_string_lossy())?;
        }
        if !path.is_absolute() || !is_file(path.as_path()) {
            return Err("拖入項目不是可讀取的媒體檔案".into());
        }
        if !supported_media_path(&path) {
            return Err(format!("不支援的媒體格式：{}", path.display()));
        }
        selected.push(path);
    }
    Ok(selected)
}

/// The single-import check on every chooser pick, then the media probe of the checked paths (in the app,
/// `inspect_media_batch`): a network share, device or stream path is refused before the probe runs.
async fn probe_import_picks<F, Fut>(selected: &[PathBuf], inspect: F) -> Result<(Vec<String>, Value), String>
where
    F: FnOnce(Vec<String>) -> Fut,
    Fut: std::future::Future<Output = Result<Value, String>>,
{
    let path_strings: Vec<String> = selected
        .iter()
        .map(|path| path.to_string_lossy().to_string())
        .collect();
    for path in &path_strings {
        media_source_path_check(path)?;
    }
    let probes = inspect(path_strings.clone()).await?;
    Ok((path_strings, probes))
}

async fn import_media_path_bufs(
    app: &AppHandle,
    selected: Vec<PathBuf>,
) -> Result<Vec<PickedMedia>, String> {
    if selected.is_empty() {
        return Ok(Vec::new());
    }
    // The single-import check on every pick before the probe (or anything else) reads it.
    let (path_strings, probes) =
        probe_import_picks(&selected, |paths| call_service(app, "inspect_media_batch", json!({ "paths": paths }))).await?;
    let probes = probes
        .as_array()
        .ok_or("inspect_media_batch 回應不是陣列")?;
    let defaults = imported_media_defaults_batch(&selected, probes)?;
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_millis();
    let mut result = Vec::new();
    for (index, path) in selected.iter().enumerate() {
        let path_string = path.to_string_lossy().to_string();
        allow_path(app, &path_string)?;
        let (kind, interpretation, alpha_mode) = defaults[index];
        let probe = probes.get(index).ok_or("inspect_media_batch 長度不符")?;
        let image_sequence = probe.get("imageSequence").filter(|value| !value.is_null());
        let duration = if image_sequence.is_some() {
            probe.get("duration").and_then(Value::as_f64).unwrap_or(0.0)
        } else if kind == "image" {
            5.0
        } else {
            probe.get("duration").and_then(Value::as_f64).unwrap_or(0.0)
        };
        let mut color = json!({ "interpretation": interpretation });
        for (target, source) in [
            ("primaries", "colorPrimaries"),
            ("transfer", "colorTransfer"),
            ("matrix", "colorMatrix"),
            ("range", "colorRange"),
        ] {
            if let Some(value) = probe.get(source).filter(|value| !value.is_null()) {
                color[target] = value.clone();
            }
        }
        let preview_path = probe
            .get("previewPath")
            .and_then(Value::as_str)
            .unwrap_or(&path_string)
            .to_string();
        allow_path(app, &preview_path)?;
        let mut asset = json!({
            "id": format!("asset-{timestamp}-{index}"),
            "name": path.file_name().and_then(|name| name.to_str()).unwrap_or(&path_string),
            "kind": kind,
            "uri": path_string,
            "duration": duration,
            "alphaMode": alpha_mode,
            "color": color,
            "imageSequence": image_sequence
        });
        append_media_dimensions(&mut asset, probe);
        if image_sequence.is_none() {
            asset
                .as_object_mut()
                .expect("imported media asset is always an object")
                .remove("imageSequence");
        }
        result.push(PickedMedia {
            asset,
            preview_path,
        });
    }
    record_outside_media_grants(app, path_strings, outside_media_grants::GrantSource::Import).await;
    Ok(result)
}


#[tauri::command]
async fn preview_paths(app: AppHandle, assets: Vec<Value>) -> Result<Value, String> {
    Ok(Value::Object(
        collect_runtime_paths_async(&app, &assets).await?,
    ))
}

#[tauri::command]
async fn list_creative_library(app: AppHandle, include_original_sfx_candidates: Option<bool>) -> Result<Value, String> {
    call_service(&app, "list_creative_library", if include_original_sfx_candidates == Some(true) { json!({ "includeOriginalSfxCandidates": true }) } else { json!({}) }).await
}

#[tauri::command]
async fn list_installed_plugins(app: AppHandle) -> Result<Value, String> {
    call_service(&app, "list_installed_plugins", json!({})).await
}

#[tauri::command]
async fn get_workflow_profile(app: AppHandle) -> Result<Value, String> {
    let path = workflow_profile_path(&app)?;
    call_service(&app, "read_workflow_profile", json!({ "path": path })).await
}

#[tauri::command]
async fn save_workflow_profile(app: AppHandle, profile: Value) -> Result<Value, String> {
    let path = workflow_profile_path(&app)?;
    call_service(
        &app,
        "write_workflow_profile",
        json!({ "path": path, "profile": profile }),
    )
    .await
}

#[tauri::command]
fn open_plugin_folder(app: AppHandle) -> Result<Value, String> {
    let runtime = runtime_paths(&app)?;
    fs::create_dir_all(&runtime.user_plugin_root)
        .map_err(|error| format!("無法建立使用者外掛資料夾：{error}"))?;
    if integration_state_root().is_some() {
        return Ok(json!({ "path": runtime.user_plugin_root, "opened": false }));
    }
    let program = if cfg!(target_os = "windows") {
        "explorer.exe"
    } else if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    };
    Command::new(program)
        .arg(&runtime.user_plugin_root)
        .spawn()
        .map_err(|error| format!("無法開啟使用者外掛資料夾：{error}"))?;
    Ok(json!({ "path": runtime.user_plugin_root, "opened": true }))
}

#[tauri::command]
async fn compile_plugin_tool(
    app: AppHandle,
    plugin_id: String,
    capability_id: String,
    target_clip_id: String,
    parameters: Value,
) -> Result<Value, String> {
    call_service(
        &app,
        "compile_plugin_tool",
        json!({
            "pluginId": plugin_id,
            "capabilityId": capability_id,
            "targetClipId": target_clip_id,
            "parameters": parameters,
        }),
    )
    .await
}

#[tauri::command]
async fn import_creative_asset(app: AppHandle, asset_id: String) -> Result<PickedMedia, String> {
    let resolved = call_service(
        &app,
        "resolve_creative_asset",
        json!({ "assetId": asset_id }),
    )
    .await?;
    let metadata = resolved
        .get("asset")
        .ok_or("resolve_creative_asset 缺少 asset")?;
    let absolute = string_field(&resolved, "absolutePath")?;
    allow_path(&app, absolute)?;
    let kind = string_field(metadata, "mediaKind")?;
    let probe = call_service(&app, "inspect_media", json!({ "path": absolute })).await?;
    let duration = if kind == "image" {
        5.0
    } else {
        probe.get("duration").and_then(Value::as_f64).unwrap_or(0.0)
    };
    if duration <= 0.0 {
        return Err("Creative Pack 素材 duration 不合法".into());
    }
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_millis();
    let mut color = json!({ "interpretation": "auto" });
    for (target, source) in [
        ("primaries", "colorPrimaries"),
        ("transfer", "colorTransfer"),
        ("matrix", "colorMatrix"),
        ("range", "colorRange"),
    ] {
        if let Some(value) = probe.get(source).filter(|value| !value.is_null()) {
            color[target] = value.clone();
        }
    }
    let mut asset = json!({
        "id": format!("asset-creator-{timestamp}"),
        "name": string_field(metadata, "name")?,
        "kind": kind,
        "uri": format!("{CREATIVE_URI_PREFIX}{}", percent_encode(&asset_id)),
        "duration": duration,
        "color": color
    });
    append_media_dimensions(&mut asset, &probe);
    creative_preview::append_creative_metadata(&mut asset, metadata);
    Ok(PickedMedia {
        asset,
        preview_path: absolute.to_string(),
    })
}

#[tauri::command]
async fn preview_creative_asset(
    app: AppHandle,
    asset_id: String,
    mode: Option<String>,
) -> Result<String, String> {
    let payload = creative_preview::preview_payload(&asset_id, mode.as_deref())?;
    // Reserve before spawn_blocking: neither waiting tasks nor active Node
    // preview processes may grow without bounds. Other services are unaffected.
    let previews = app.state::<AppState>().creative_previews.clone();
    let services = app.state::<AppState>().services.clone();
    let reservation = previews.reserve()?;
    let runtime = runtime_paths(&app)?;
    let resolved = tauri::async_runtime::spawn_blocking(move || {
        reservation.run(|| {
            let request =
                service_request_value(&runtime, creative_preview::PREVIEW_COMMAND, payload);
            let cancel = previews.cancel_token();
            let envelope = services.request_preview(&runtime.node, &runtime.service, request, &cancel)?;
            if previews.is_shutdown() {
                return Err("素材預覽已取消，程式正在關閉".into());
            }
            if envelope.get("ok").and_then(Value::as_bool) != Some(true) {
                return Err(envelope.get("error").and_then(Value::as_str)
                    .unwrap_or("素材預覽 service 失敗").chars().take(4096).collect::<String>());
            }
            envelope.get("result").filter(|value| value.is_object()).cloned()
                .ok_or_else(|| "素材預覽 service 缺少有效 result".into())
        })
    })
    .await
    .map_err(|error| error.to_string())??;
    let absolute = string_field(&resolved, "absolutePath")?;
    allow_path(&app, absolute)?;
    Ok(absolute.to_string())
}

#[tauri::command]
async fn prepare_media(app: AppHandle, asset: Value) -> Result<Value, String> {
    let uri = string_field(&asset, "uri")?.to_string();
    let source = if let Some(asset_id) = creative_asset_id(&uri)? {
        let resolved = call_service(
            &app,
            "resolve_creative_asset",
            json!({ "assetId": asset_id }),
        )
        .await?;
        string_field(&resolved, "absolutePath")?.to_string()
    } else {
        uri.clone()
    };
    let probe = call_service(&app, "inspect_media", json!({ "path": source })).await?;
    let prepared = call_service(
        &app,
        "prepare_media",
        json!({
            "sourcePath": source,
            "kind": string_field(&asset, "kind")?,
            "duration": asset.get("duration").and_then(Value::as_f64).unwrap_or(0.0),
            "hasAudio": probe.get("hasAudio").and_then(Value::as_bool).unwrap_or(false),
            "sourceHeight": probe.get("height").and_then(Value::as_u64)
        }),
    )
    .await?;
    let derivatives = prepared
        .get("derivatives")
        .cloned()
        .ok_or("prepare_media 缺少 derivatives")?;
    let with_derivatives = json!({
        "id": string_field(&asset, "id")?, "uri": string_field(&asset, "uri")?, "derivatives": derivatives
    });
    let paths = collect_runtime_paths_async(&app, &[with_derivatives]).await?;
    Ok(json!({
        "assetId": string_field(&asset, "id")?,
        "derivatives": derivatives,
        "runtimePaths": paths,
        "cacheHit": prepared.get("cacheHit").and_then(Value::as_bool).unwrap_or(false)
    }))
}

#[tauri::command]
async fn clip_media_derivative(app: AppHandle, mut request: Value) -> Result<Value, String> {
    if let Some(uri) = request.get("sourcePath").and_then(Value::as_str).map(str::to_string) {
        if let Some(asset_id) = creative_asset_id(&uri)? {
            let resolved = call_service(&app, "resolve_creative_asset", json!({ "assetId": asset_id })).await?;
            request["sourcePath"] = json!(string_field(&resolved, "absolutePath")?);
        }
    }
    let result = call_service(&app, "clip_media_derivative", request).await?;
    let asset = result.get("asset").ok_or("clip_media_derivative missing asset")?;
    allow_path(&app, string_field(asset, "uri")?)?;
    Ok(result)
}

#[tauri::command]
async fn smart_cut_media(app: AppHandle, request: Value) -> Result<Value, String> {
    call_service(&app, "analyze_smart_cut", request).await
}

#[tauri::command]
async fn automatic_caption_media(app: AppHandle, mut request: Value) -> Result<Value, String> {
    if let Some(uri) = request.get("sourcePath").and_then(Value::as_str) {
        if let Some(asset_id) = creative_asset_id(uri)? {
            let resolved = call_service(
                &app,
                "resolve_creative_asset",
                json!({ "assetId": asset_id }),
            )
            .await?;
            request["sourcePath"] = json!(string_field(&resolved, "absolutePath")?);
        }
    }
    call_service(&app, "transcribe_media", request).await
}

#[tauri::command]
async fn detect_scenes(app: AppHandle, mut request: Value) -> Result<Value, String> {
    if let Some(uri) = request
        .get("sourcePath")
        .and_then(Value::as_str)
        .map(str::to_string)
    {
        if let Some(asset_id) = creative_asset_id(&uri)? {
            let resolved = call_service(
                &app,
                "resolve_creative_asset",
                json!({ "assetId": asset_id }),
            )
            .await?;
            request["sourcePath"] = json!(string_field(&resolved, "absolutePath")?);
        }
    }
    call_service(&app, "detect_scenes", request).await
}

#[tauri::command]
async fn analyze_motion_track(app: AppHandle, mut request: Value) -> Result<Value, String> {
    if let Some(uri) = request
        .get("sourcePath")
        .and_then(Value::as_str)
        .map(str::to_string)
    {
        if let Some(asset_id) = creative_asset_id(&uri)? {
            let resolved = call_service(
                &app,
                "resolve_creative_asset",
                json!({ "assetId": asset_id }),
            )
            .await?;
            request["sourcePath"] = json!(string_field(&resolved, "absolutePath")?);
        }
    }
    call_service(&app, "analyze_motion_track", request).await
}

#[cfg(feature = "auto-roto-research")]
#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct PackCopyStats {
    files: u64,
    bytes: u64,
}

#[cfg(feature = "auto-roto-research")]
fn copy_auto_roto_pack_tree(
    source: &Path,
    target: &Path,
    stats: &mut PackCopyStats,
) -> Result<(), String> {
    fs::create_dir_all(target).map_err(|error| format!("無法建立 Auto Roto staging：{error}"))?;
    for entry in
        fs::read_dir(source).map_err(|error| format!("無法讀取 Auto Roto pack：{error}"))?
    {
        let entry = entry.map_err(|error| error.to_string())?;
        let metadata = fs::symlink_metadata(entry.path()).map_err(|error| error.to_string())?;
        if metadata.file_type().is_symlink() {
            return Err("Auto Roto pack 不接受 symbolic link／junction".into());
        }
        let destination = target.join(entry.file_name());
        if metadata.is_dir() {
            copy_auto_roto_pack_tree(&entry.path(), &destination, stats)?;
        } else if metadata.is_file() {
            stats.files = stats.files.saturating_add(1);
            stats.bytes = stats.bytes.saturating_add(metadata.len());
            if stats.files > 20_000 || stats.bytes > 16 * 1024 * 1024 * 1024 {
                return Err("Auto Roto pack 超過安全安裝上限".into());
            }
            fs::copy(entry.path(), destination)
                .map_err(|error| format!("複製 Auto Roto pack 失敗：{error}"))?;
        } else {
            return Err("Auto Roto pack 含不支援的檔案類型".into());
        }
    }
    Ok(())
}

#[cfg(feature = "auto-roto-research")]
async fn inspect_auto_roto_pack_at(app: &AppHandle, root: &Path) -> Result<Value, String> {
    call_service(
        app,
        "inspect_auto_roto_video_pack",
        json!({
            "trustedRoot": root,
            "manifestPath": root.join("manifest.json"),
            "hostScriptPath": root.join("host/auto-roto-sam21-video-host.py"),
            "allowResearchCandidate": false
        }),
    )
    .await
}

#[cfg(feature = "auto-roto-research")]
async fn install_auto_roto_video_model_internal(
    app: AppHandle,
    source_root: PathBuf,
) -> Result<Value, String> {
    if !external_auto_roto_research_enabled() {
        return Err(
            "Editkin 正式產品只允許自研 Auto Roto；外部模型包僅能在明確啟用的 debug 研究環境使用"
                .into(),
        );
    }
    let source = fs::canonicalize(&source_root)
        .map(process_compatible_path)
        .map_err(|error| format!("Auto Roto pack 資料夾不存在：{error}"))?;
    if !source.is_dir() {
        return Err("Auto Roto pack 來源不是資料夾".into());
    }
    let model_root = application_data_root(&app)?.join("models");
    let base = auto_roto_video_model_base(&model_root);
    fs::create_dir_all(base.join("versions")).map_err(|error| error.to_string())?;
    if let (Ok(source_canonical), Ok(base_canonical)) =
        (fs::canonicalize(&source), fs::canonicalize(&base))
    {
        if source_canonical.starts_with(&base_canonical) {
            return Err("Auto Roto pack 來源不可位於受管模型資料夾內".into());
        }
    }
    let source_receipt = inspect_auto_roto_pack_at(&app, &source).await?;
    let manifest_sha = source_receipt
        .pointer("/identity/manifestSha256")
        .and_then(Value::as_str)
        .filter(|value| valid_sha256(value))
        .ok_or("Auto Roto pack 缺少已驗證 manifest SHA-256")?
        .to_string();
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_millis();
    let versions = base.join("versions");
    let staging = versions.join(format!(
        ".install-{manifest_sha}-{}-{stamp}",
        std::process::id()
    ));
    let generation = versions.join(&manifest_sha);
    let source_for_copy = source.clone();
    let staging_for_copy = staging.clone();
    let copied = tauri::async_runtime::spawn_blocking(move || {
        let mut stats = PackCopyStats::default();
        if staging_for_copy.exists() {
            fs::remove_dir_all(&staging_for_copy).map_err(|error| error.to_string())?;
        }
        if let Err(error) =
            copy_auto_roto_pack_tree(&source_for_copy, &staging_for_copy, &mut stats)
        {
            let _ = fs::remove_dir_all(&staging_for_copy);
            return Err(error);
        }
        Ok(stats)
    })
    .await
    .map_err(|error| error.to_string())??;
    let staged_receipt = match inspect_auto_roto_pack_at(&app, &staging).await {
        Ok(value) => value,
        Err(error) => {
            let _ = fs::remove_dir_all(&staging);
            return Err(format!("Auto Roto pack 複製後驗證失敗：{error}"));
        }
    };
    if staged_receipt
        .pointer("/identity/manifestSha256")
        .and_then(Value::as_str)
        != Some(manifest_sha.as_str())
    {
        let _ = fs::remove_dir_all(&staging);
        return Err("Auto Roto pack 安裝前後身分漂移".into());
    }
    if generation.exists() {
        match inspect_auto_roto_pack_at(&app, &generation).await {
            Ok(existing)
                if existing
                    .pointer("/identity/manifestSha256")
                    .and_then(Value::as_str)
                    == Some(manifest_sha.as_str()) =>
            {
                fs::remove_dir_all(&staging).map_err(|error| error.to_string())?;
            }
            _ => {
                fs::remove_dir_all(&generation)
                    .map_err(|error| format!("無法移除損壞的 Auto Roto generation：{error}"))?;
                fs::rename(&staging, &generation)
                    .map_err(|error| format!("無法啟用 Auto Roto generation：{error}"))?;
            }
        }
    } else {
        fs::rename(&staging, &generation)
            .map_err(|error| format!("無法啟用 Auto Roto generation：{error}"))?;
    }
    write_json_atomic(
        &base.join("active.json"),
        &json!({
            "schema": "editkin.auto-roto-active-pack/v1",
            "rootRelative": format!("versions/{manifest_sha}"),
            "manifestSha256": manifest_sha,
            "installedAtUnixMs": stamp
        }),
    )?;
    let active = inspect_auto_roto_pack_at(&app, &generation).await?;
    Ok(json!({ "status": "installed", "active": active, "copied": copied, "root": generation }))
}

#[cfg(feature = "auto-roto-research")]
#[tauri::command]
async fn inspect_auto_roto_video_model(app: AppHandle) -> Result<Value, String> {
    if !external_auto_roto_research_enabled() {
        return Ok(json!({
            "status": "disabled-product-self-authored-only",
            "nativeFallback": true,
            "externalModelPackEligible": false
        }));
    }
    let model_root = application_data_root(&app)?.join("models");
    match resolve_active_auto_roto_video_root(&model_root) {
        Ok(Some(root)) => match inspect_auto_roto_pack_at(&app, &root).await {
            Ok(pack) => Ok(
                json!({ "status": "verified", "pack": pack, "root": root, "nativeFallback": true }),
            ),
            Err(error) => {
                Ok(json!({ "status": "corrupt", "error": error, "nativeFallback": true }))
            }
        },
        Ok(None) => Ok(json!({ "status": "missing", "nativeFallback": true })),
        Err(error) => Ok(json!({ "status": "corrupt", "error": error, "nativeFallback": true })),
    }
}

#[cfg(feature = "auto-roto-research")]
#[tauri::command]
async fn install_auto_roto_video_model(
    app: AppHandle,
    source_root: String,
) -> Result<Value, String> {
    install_auto_roto_video_model_internal(app, PathBuf::from(source_root)).await
}

#[cfg(feature = "auto-roto-research")]
#[tauri::command]
async fn pick_and_install_auto_roto_video_model(app: AppHandle) -> Result<Value, String> {
    let Some(source) = FileDialog::new()
        .set_title("選擇 Editkin Auto Roto 模型包")
        .pick_folder()
    else {
        return Ok(json!({ "status": "canceled" }));
    };
    install_auto_roto_video_model_internal(app, source).await
}

#[cfg(feature = "auto-roto-research")]
#[tauri::command]
async fn repair_auto_roto_video_model(
    app: AppHandle,
    source_root: String,
) -> Result<Value, String> {
    install_auto_roto_video_model_internal(app, PathBuf::from(source_root)).await
}

#[tauri::command]
async fn analyze_auto_roto(app: AppHandle, mut request: Value) -> Result<Value, String> {
    if let Some(uri) = request
        .get("sourcePath")
        .and_then(Value::as_str)
        .map(str::to_string)
    {
        if let Some(asset_id) = creative_asset_id(&uri)? {
            let resolved = call_service(
                &app,
                "resolve_creative_asset",
                json!({ "assetId": asset_id }),
            )
            .await?;
            request["sourcePath"] = json!(string_field(&resolved, "absolutePath")?);
        }
    }
    let result = call_service(&app, "analyze_auto_roto", request).await?;
    product_auto_roto_result_preview_paths(&app, &result)?;
    Ok(result)
}

#[tauri::command]
async fn open_project(app: AppHandle, ui_locale: Option<String>) -> Result<Value, String> {
    let Some(path) = FileDialog::new()
        .set_title(native_dialog_labels::text(ui_locale.as_deref(), DialogText::OpenProject))
        .add_filter(native_dialog_labels::text(ui_locale.as_deref(), DialogText::ProjectFilter), &["json"])
        .pick_file()
    else {
        return Ok(json!({ "canceled": true }));
    };
    let opened = call_service(&app, "read_project", json!({ "path": path, "captureFileIdentity": true })).await?;
    let project = opened.get("project").cloned().ok_or("read receipt missing project")?;
    let project_file_identity = opened.get("fileIdentity").cloned().ok_or("read receipt missing byte identity")?;
    let assets = project
        .get("assets")
        .and_then(Value::as_array)
        .ok_or("專案缺少 assets")?;
    let runtime_paths = collect_runtime_paths_async(&app, assets).await?;
    let matte_preview_paths = collect_product_auto_roto_preview_paths(&app, &project)?;
    Ok(
        json!({ "canceled": false, "path": path, "project": project, "fileIdentity": project_file_identity, "runtimePaths": runtime_paths, "mattePreviewPaths": matte_preview_paths }),
    )
}

fn safe_project_name(project: &Value) -> String {
    let name = project
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("Untitled");
    name.chars()
        .map(|character| {
            if "\\/:*?\"<>|".contains(character) {
                '-'
            } else {
                character
            }
        })
        .collect()
}

#[tauri::command]
async fn save_project(
    app: AppHandle,
    project: Value,
    current_path: Option<String>,
    save_as: Option<bool>,
    expected_file_identity: Option<Value>,
    ui_locale: Option<String>,
) -> Result<Value, String> {
    let regular_save = !save_as.unwrap_or(false) && current_path.is_some();
    // A regular save writes to the path the webview holds: a network share or device path is refused before the write.
    if regular_save {
        if let Some(current) = current_path.as_deref() {
            desktop_files::local_project_path(current)?;
        }
    }
    let target = if regular_save {
        current_path.map(PathBuf::from)
    } else {
        None
    };
    let path = match target {
        Some(path) => path,
        None => {
            let Some(path) = FileDialog::new()
                .set_title(native_dialog_labels::text(ui_locale.as_deref(), DialogText::SaveProject))
                .set_file_name(format!("{}.editkin.json", safe_project_name(&project)))
                .add_filter(native_dialog_labels::text(ui_locale.as_deref(), DialogText::ProjectFilter), &["editkin.json", "haoedit.json"])
                .save_file()
            else {
                return Ok(json!({ "canceled": true }));
            };
            if path
                .to_string_lossy()
                .to_ascii_lowercase()
                .ends_with(".editkin.json")
                || path
                    .to_string_lossy()
                    .to_ascii_lowercase()
                    .ends_with(".haoedit.json")
            {
                path
            } else {
                PathBuf::from(format!("{}.editkin.json", path.to_string_lossy()))
            }
        }
    };
    let expected_revision = if regular_save {
        project.get("revision").cloned().unwrap_or(Value::Null)
    } else {
        Value::Null
    };
    let saved_reply = call_service(
        &app,
        "write_project",
        json!({
            "path": path,
            "project": project,
            "expectedRevision": expected_revision,
            "captureFileIdentity": true,
            "captureRetainedProjectV1": true,
            "expectedFileIdentity": if regular_save { expected_file_identity } else { None }
        }),
    )
    .await?;
    if saved_reply.get("saveFailed").and_then(Value::as_bool) == Some(true) {
        return Ok(json!({ "canceled": false, "saveFailed": true, "path": path,
            "message": saved_reply.get("message"), "retainedProject": saved_reply.get("retainedProject") }));
    }
    let saved = saved_reply.get("project").cloned().ok_or("save receipt missing project")?;
    let project_file_identity = saved_reply.get("fileIdentity").cloned().ok_or("save receipt missing byte identity")?;
    let matte_preview_paths = collect_product_auto_roto_preview_paths(&app, &saved)?;
    Ok(
        json!({ "canceled": false, "path": path, "project": saved, "fileIdentity": project_file_identity, "mattePreviewPaths": matte_preview_paths }),
    )
}

#[tauri::command]
async fn load_recovery(app: AppHandle) -> Result<Value, String> {
    let result = call_service(
        &app,
        "read_recovery",
        json!({ "path": recovery_path(&app)? }),
    )
    .await?;
    let matte_preview_paths = match result.pointer("/snapshot/project") {
        Some(project) => collect_product_auto_roto_preview_paths(&app, project)?,
        None => Vec::new(),
    };
    let mut response = result
        .as_object()
        .cloned()
        .ok_or("recovery service 回應不是物件")?;
    response.insert("mattePreviewPaths".into(), json!(matte_preview_paths));
    Ok(Value::Object(response))
}

#[tauri::command]
async fn save_recovery(
    app: AppHandle,
    project: Value,
    project_path: Option<String>,
    clean_updated_at: String,
    base_file_identity: Option<Value>,
) -> Result<(), String> {
    call_service(
        &app,
        "write_recovery",
        json!({
            "path": recovery_path(&app)?,
            "project": project,
            "projectPath": project_path,
            "cleanUpdatedAt": clean_updated_at,
            "baseFileIdentity": base_file_identity
        }),
    )
    .await?;
    Ok(())
}

#[tauri::command]
async fn clear_recovery(app: AppHandle) -> Result<(), String> {
    call_service(
        &app,
        "clear_recovery",
        json!({ "path": recovery_path(&app)? }),
    )
    .await?;
    Ok(())
}

fn integration_smoke_flag(value: Option<&str>) -> bool {
    value == Some("1")
}

#[tauri::command]
fn integration_smoke_enabled() -> bool {
    integration_smoke_flag(env::var("EDITKIN_INTEGRATION_SMOKE").ok().as_deref())
}

#[tauri::command]
async fn render_project(app: AppHandle, project: Value, ui_locale: Option<String>, job_id: Option<String>) -> Result<Value, String> {
    let Some(path) = FileDialog::new()
        .set_title(native_dialog_labels::text(ui_locale.as_deref(), DialogText::ExportVideo))
        .set_file_name(format!("{}.mp4", safe_project_name(&project)))
        .add_filter(native_dialog_labels::text(ui_locale.as_deref(), DialogText::Mp4Filter), &["mp4"])
        .save_file()
    else {
        return Ok(json!({ "canceled": true }));
    };
    let output_path = if path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("mp4"))
    {
        path
    } else {
        path.with_extension("mp4")
    };
    let render_jobs::ExportOutcome::Completed(rendered) = render_jobs::run_export(
        &app,
        job_id.as_deref(),
        &output_path,
        json!({ "project": project, "outputPath": output_path }),
    )
    .await?
    else {
        return Ok(json!({ "canceled": true, "stoppedByUser": true }));
    };
    // 「播放」 plays the finished file inside Editkin; a path the asset scope refuses only disables that button.
    let _ = allow_path(&app, &output_path.to_string_lossy());
    let mut result = rendered
        .as_object()
        .cloned()
        .ok_or("render_project 回應不是物件")?;
    result.insert("canceled".into(), Value::Bool(false));
    Ok(Value::Object(result))
}

#[tauri::command]
async fn render_alpha_master(app: AppHandle, project: Value, ui_locale: Option<String>, job_id: Option<String>) -> Result<Value, String> {
    let Some(path) = FileDialog::new()
        .set_title(native_dialog_labels::text(ui_locale.as_deref(), DialogText::ExportAlpha))
        .set_file_name(format!("{}-Alpha.mov", safe_project_name(&project)))
        .add_filter("ProRes 4444 Alpha", &["mov"])
        .save_file()
    else {
        return Ok(json!({ "canceled": true }));
    };
    let output_path = if path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("mov"))
    {
        path
    } else {
        path.with_extension("mov")
    };
    let render_jobs::ExportOutcome::Completed(rendered) = render_jobs::run_export(
        &app,
        job_id.as_deref(),
        &output_path,
        json!({
            "project": project,
            "outputPath": output_path,
            "deliveryProfile": "prores4444_alpha_10bit"
        }),
    )
    .await?
    else {
        return Ok(json!({ "canceled": true, "stoppedByUser": true }));
    };
    let mut result = rendered
        .as_object()
        .cloned()
        .ok_or("render_alpha_master 回應不是物件")?;
    result.insert("canceled".into(), Value::Bool(false));
    Ok(Value::Object(result))
}

fn validate_openexr_sequence_request(
    graph: &Value,
    asset_bindings: &Value,
    start_frame: u64,
    frame_count: u64,
) -> Result<(), String> {
    if graph.get("schema").and_then(Value::as_str) != Some("editkin.engine-graph/v1")
        || graph.get("workingFormat").and_then(Value::as_str) != Some("rgba32_float")
        || !graph.get("audio").is_none_or(Value::is_null)
    {
        return Err("OpenEXR 序列需要無音訊的 rgba32_float Common Engine Graph".into());
    }
    let nodes = graph
        .get("nodes")
        .and_then(Value::as_array)
        .ok_or("OpenEXR 序列 graph 缺少 nodes")?;
    if nodes.is_empty() || nodes.len() > 256 {
        return Err("OpenEXR 序列 graph node 數必須是 1..=256".into());
    }
    let bindings = asset_bindings
        .as_object()
        .ok_or("OpenEXR 序列 assetBindings 必須是 object")?;
    if bindings.is_empty()
        || bindings.len() > 64
        || bindings.values().any(|value| {
            value.as_str().is_none_or(|path| {
                path.is_empty()
                    || path.len() > 32_768
                    || !Path::new(path).is_absolute()
                    || !local_media_binding(path)
            })
        })
    {
        return Err("OpenEXR 序列 assetBindings 含無效本機來源".into());
    }
    if frame_count == 0 || frame_count > 1_000_000 || start_frame.checked_add(frame_count).is_none()
    {
        return Err("OpenEXR 序列影格範圍必須是 1..=1,000,000 且不可溢位".into());
    }
    Ok(())
}

async fn execute_openexr_sequence(
    app: &AppHandle,
    graph: Value,
    asset_bindings: Value,
    start_frame: u64,
    frame_count: u64,
    output_directory: PathBuf,
) -> Result<Value, String> {
    validate_openexr_sequence_request(&graph, &asset_bindings, start_frame, frame_count)?;
    let runtime = runtime_paths(app)?;
    let job_root = application_cache_root(app)?
        .join("gpu-compositor")
        .join("openexr-sequence")
        .join(format!("{}-{}", std::process::id(), unix_time_ms()));
    fs::create_dir_all(&job_root).map_err(|error| error.to_string())?;
    let graph_path = job_root.join("graph.json");
    let bindings_path = job_root.join("bindings.json");
    fs::write(
        &graph_path,
        serde_json::to_vec_pretty(&graph).map_err(|error| error.to_string())?,
    )
    .and_then(|_| {
        fs::write(
            &bindings_path,
            serde_json::to_vec_pretty(&asset_bindings).map_err(std::io::Error::other)?,
        )
    })
    .map_err(|error| error.to_string())?;
    let start = PathBuf::from(start_frame.to_string());
    let count = PathBuf::from(frame_count.to_string());
    let runtime_for_job = runtime.clone();
    let graph_for_job = graph_path.clone();
    let bindings_for_job = bindings_path.clone();
    let output_for_job = output_directory.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        run_gpu_compositor(
            &runtime_for_job,
            &[
                Path::new("engine-render-sequence"),
                &graph_for_job,
                &bindings_for_job,
                &start,
                &count,
                &output_for_job,
                Path::new("gpu"),
            ],
        )
    })
    .await
    .map_err(|error| format!("OpenEXR 序列工作執行失敗：{error}"))?;
    let _ = fs::remove_dir_all(&job_root);
    result
}

#[tauri::command]
async fn render_openexr_sequence(
    app: AppHandle,
    project_name: String,
    graph: Value,
    asset_bindings: Value,
    start_frame: u64,
    frame_count: u64,
    ui_locale: Option<String>,
) -> Result<Value, String> {
    if project_name.trim().is_empty() || project_name.len() > 200 {
        return Err("OpenEXR 序列專案名稱不合法".into());
    }
    let Some(parent) = FileDialog::new()
        .set_title(native_dialog_labels::text(ui_locale.as_deref(), DialogText::ExrFolder))
        .pick_folder()
    else {
        return Ok(json!({ "canceled": true }));
    };
    let output_directory = parent.join(format!(
        "{}-OpenEXR",
        safe_project_name(&json!({ "name": project_name }))
    ));
    let mut rendered = execute_openexr_sequence(
        &app,
        graph,
        asset_bindings,
        start_frame,
        frame_count,
        output_directory,
    )
    .await?
    .as_object()
    .cloned()
    .ok_or("OpenEXR 序列回應不是物件")?;
    rendered.insert("canceled".into(), Value::Bool(false));
    Ok(Value::Object(rendered))
}

#[tauri::command]
async fn render_openexr_sequence_smoke(
    app: AppHandle,
    graph: Value,
    asset_bindings: Value,
    start_frame: u64,
    frame_count: u64,
    output_directory: String,
) -> Result<Value, String> {
    if env::var("EDITKIN_INTEGRATION_SMOKE").as_deref() != Ok("1") {
        return Err("render_openexr_sequence_smoke 只允許在 integration smoke 環境執行".into());
    }
    let output = PathBuf::from(output_directory);
    if !output.is_absolute() {
        return Err("OpenEXR smoke 輸出必須是 absolute path".into());
    }
    execute_openexr_sequence(
        &app,
        graph,
        asset_bindings,
        start_frame,
        frame_count,
        output,
    )
    .await
}

#[tauri::command]
async fn render_native_effect_preview(
    app: AppHandle,
    project: Value,
    clip_id: String,
) -> Result<Value, String> {
    let rendered = call_service(
        &app,
        "render_native_effect_preview",
        json!({ "project": project, "clipId": clip_id }),
    )
    .await?;
    let path = rendered
        .get("path")
        .and_then(Value::as_str)
        .ok_or("render_native_effect_preview 回應缺少 path")?;
    allow_path(&app, path)?;
    Ok(rendered)
}

#[tauri::command]
async fn render_project_smoke(
    app: AppHandle,
    project: Value,
    output_path: String,
) -> Result<Value, String> {
    if env::var("EDITKIN_INTEGRATION_SMOKE").as_deref() != Ok("1") {
        return Err("render_project_smoke 只允許在 integration smoke 環境執行".into());
    }
    call_service(
        &app,
        "render_project",
        json!({ "project": project, "outputPath": output_path }),
    )
    .await
}

#[tauri::command]
async fn batch_auto_edit_smoke(
    app: AppHandle,
    source_path: String,
    output_root: String,
) -> Result<Value, String> {
    if env::var("EDITKIN_INTEGRATION_SMOKE").as_deref() != Ok("1") {
        return Err("batch_auto_edit_smoke 只允許在 integration smoke 環境執行".into());
    }
    call_service(
        &app,
        "batch_auto_edit_item",
        json!({
            "jobId": "smoke-job",
            "sourcePath": source_path,
            "outputRoot": output_root,
            "language": "auto",
            "targetRatio": 0.8,
            "addMusic": false,
            "analysisMode": "smart_cut"
        }),
    )
    .await
}

fn lan_ipv4() -> String {
    UdpSocket::bind("0.0.0.0:0")
        .and_then(|socket| {
            socket.connect("192.0.2.1:80")?;
            socket.local_addr().map(|address| address.ip().to_string())
        })
        .unwrap_or_else(|_| "127.0.0.1".into())
}

/// Host names (no port) the Remote server may see besides IP literals and
/// `localhost`: the public HTTPS tunnel the user configured, if any.
fn remote_allowed_hosts(public_tunnel_origin: Option<&str>) -> String {
    public_tunnel_origin
        .and_then(|origin| origin.split_once("://").map(|(_, rest)| rest))
        .and_then(|rest| rest.split(['/', '?', '#']).next())
        .map(|authority| authority.rsplit('@').next().unwrap_or(authority))
        .map(|authority| authority.split(':').next().unwrap_or(authority))
        .map(str::to_ascii_lowercase)
        .filter(|host| !host.is_empty())
        .unwrap_or_default()
}

fn pairing_token() -> Result<String, String> {
    let mut bytes = [0_u8; 16];
    getrandom::fill(&mut bytes).map_err(|error| error.to_string())?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn unix_time_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn mobile_trusted_devices_path(app: &AppHandle) -> Result<PathBuf, String> {
    let root = application_data_root(app)?.join("mobile-remote");
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    Ok(root.join("trusted-devices.json"))
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct MobileRelayIdentity {
    schema_version: u8,
    room: String,
    secret: String,
    created_at_ms: u128,
}

fn mobile_relay_identity_path(app: &AppHandle) -> Result<PathBuf, String> {
    let root = application_data_root(app)?.join("mobile-remote");
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    restrict_to_owner(&root, 0o700)?;
    Ok(root.join("relay-identity.json"))
}

fn mobile_relay_identity(app: &AppHandle) -> Result<MobileRelayIdentity, String> {
    let path = mobile_relay_identity_path(app)?;
    if let Some(value) = read_json(&path)? {
        if let Ok(identity) = serde_json::from_value::<MobileRelayIdentity>(value) {
            if identity.schema_version == 1
                && identity.room.len() == 32
                && identity.room.chars().all(|value| value.is_ascii_hexdigit())
                && identity.secret.len() >= 48
            {
                // Identities written before owner-only permissions existed.
                restrict_to_owner(&path, 0o600)?;
                return Ok(identity);
            }
        }
    }
    let identity = MobileRelayIdentity {
        schema_version: 1,
        room: pairing_token()?,
        secret: format!("{}{}", pairing_token()?, pairing_token()?),
        created_at_ms: unix_time_ms(),
    };
    write_private_json_atomic(
        &path,
        &serde_json::to_value(&identity).map_err(|error| error.to_string())?,
    )?;
    Ok(identity)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RemoteNetworkPolicy {
    schema_version: u8,
    mode: String,
    default_transport: String,
    relay_origin: String,
    public_tunnel_origin: String,
    auto_deploy: bool,
    provider_required: bool,
    cost_responsibility: String,
    deployment_status: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UserRemoteNetworkConfig {
    schema: String,
    schema_version: u8,
    mode: String,
    transport: String,
    origin: String,
    provider_id: String,
    cost_responsibility: String,
    user_confirmed_costs_and_permissions: bool,
    configured_at: String,
    configuration_id: String,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PendingUserRemoteNetworkConfig {
    schema: String,
    candidate_revision: String,
    expected_configuration_id: Option<String>,
    prepared_at_ms: u128,
    expires_at_ms: u128,
    configuration: UserRemoteNetworkConfig,
}

fn remote_network_policy() -> Result<RemoteNetworkPolicy, String> {
    let policy = serde_json::from_str::<RemoteNetworkPolicy>(REMOTE_RELAY_CONFIG)
        .map_err(|error| format!("Editkin Remote 內建政策格式不合法：{error}"))?;
    if policy.schema_version != 2
        || policy.mode != "user-owned-byo"
        || policy.default_transport != "lan"
        || !policy.relay_origin.trim().is_empty()
        || !policy.public_tunnel_origin.trim().is_empty()
        || policy.auto_deploy
        || policy.provider_required
        || policy.cost_responsibility != "end-user"
        || policy.deployment_status != "optional-user-configuration-required-for-cross-network"
    {
        return Err("Editkin Remote 只允許預設 LAN 與使用者自備的跨網路連線；內建中央服務或自動部署已被拒絕".into());
    }
    Ok(policy)
}

fn looks_like_legacy_numeric_ipv4(host: &str) -> bool {
    let labels = host.split('.').collect::<Vec<_>>();
    !labels.is_empty()
        && labels.len() <= 4
        && labels.iter().all(|label| {
            !label.is_empty()
                && (label.bytes().all(|byte| byte.is_ascii_digit())
                    || label.strip_prefix("0x").is_some_and(|digits| {
                        !digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_hexdigit())
                    }))
        })
}

fn validate_user_https_origin(environment_key: &str, value: &str) -> Result<String, String> {
    if value != value.trim() || value.ends_with('/') {
        return Err(format!(
            "{environment_key} 必須是正規化且沒有結尾斜線的 HTTPS origin"
        ));
    }
    let url = value;
    let https = url.strip_prefix("https://").unwrap_or_default();
    let mut pieces = https.splitn(2, '/');
    let authority = pieces.next().unwrap_or_default();
    let path = pieces.next().unwrap_or_default();
    if authority.is_empty()
        || authority.contains('@')
        || !path.is_empty()
        || url.contains('?')
        || url.contains('#')
        || url.contains('\\')
        || url.chars().any(char::is_whitespace)
    {
        return Err(format!(
            "{environment_key} 必須是沒有帳密、query／fragment 的使用者自備 HTTPS URL"
        ));
    }
    let host = if authority.starts_with('[') {
        let close = authority
            .find(']')
            .ok_or_else(|| format!("{environment_key} 的 IPv6 host 不合法"))?;
        let suffix = &authority[close + 1..];
        if !suffix.is_empty()
            && (!suffix.starts_with(':')
                || suffix[1..]
                    .parse::<u16>()
                    .ok()
                    .filter(|port| *port > 0)
                    .is_none())
        {
            return Err(format!("{environment_key} 的 port 不合法"));
        }
        &authority[1..close]
    } else {
        let (host, port) = authority.rsplit_once(':').unwrap_or((authority, ""));
        if authority.matches(':').count() > 1
            || (!port.is_empty()
                && port
                    .parse::<u16>()
                    .ok()
                    .filter(|value| *value > 0)
                    .is_none())
        {
            return Err(format!("{environment_key} 的 host/port 不合法"));
        }
        host
    };
    let host_lower = host.to_ascii_lowercase();
    if host.is_empty()
        || !host.is_ascii()
        || host != host_lower
        || host_lower == "localhost"
        || host_lower.ends_with(".localhost")
        || host_lower.ends_with(".local")
        || host_lower == "metadata.google.internal"
    {
        return Err(format!(
            "{environment_key} 不可指向本機、區域網路或 metadata host"
        ));
    }
    if let Ok(ip) = host.parse::<IpAddr>() {
        if !remote_ip_is_public(ip) {
            return Err(format!("{environment_key} 不可指向本機或私人 IP"));
        }
    } else if looks_like_legacy_numeric_ipv4(&host_lower) {
        return Err(format!(
            "{environment_key} 不可使用 legacy／混淆 numeric IPv4 host"
        ));
    } else if !host_lower.split('.').all(|label| {
        !label.is_empty()
            && label.len() <= 63
            && label
                .bytes()
                .next()
                .is_some_and(|byte| byte.is_ascii_alphanumeric())
            && label
                .bytes()
                .last()
                .is_some_and(|byte| byte.is_ascii_alphanumeric())
            && label
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    }) {
        return Err(format!("{environment_key} 的公開 hostname 不合法"));
    }
    Ok(url.to_string())
}

fn remote_ipv4_is_public(ip: Ipv4Addr) -> bool {
    let [a, b, _, _] = ip.octets();
    !(a == 0
        || a == 10
        || a == 127
        || a >= 224
        || (a == 100 && (64..=127).contains(&b))
        || (a == 169 && b == 254)
        || (a == 172 && (16..=31).contains(&b))
        || (a == 192 && b == 168)
        || (a == 198 && (b == 18 || b == 19)))
}

fn remote_ip_is_public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ipv4) => remote_ipv4_is_public(ipv4),
        IpAddr::V6(ipv6) => {
            let octets = ipv6.octets();
            if octets[..10].iter().all(|byte| *byte == 0)
                && octets[10] == 0xff
                && octets[11] == 0xff
            {
                return remote_ipv4_is_public(Ipv4Addr::new(
                    octets[12], octets[13], octets[14], octets[15],
                ));
            }
            !(ipv6.is_unspecified()
                || ipv6.is_loopback()
                || ipv6.is_multicast()
                || (octets[0] & 0xfe) == 0xfc
                || (octets[0] == 0xfe && (octets[1] & 0xc0) == 0x80))
        }
    }
}

fn user_remote_network_config_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(application_data_root(app)?
        .join("mobile-remote")
        .join("network-config.json"))
}

fn user_remote_network_candidate_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(application_data_root(app)?
        .join("mobile-remote")
        .join("network-config-candidate.json"))
}

fn user_remote_verification_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(application_data_root(app)?
        .join("mobile-remote")
        .join("network-verification.json"))
}

fn user_remote_runtime_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(application_data_root(app)?
        .join("mobile-remote")
        .join("network-runtime.json"))
}

fn validate_user_remote_network_config(config: &UserRemoteNetworkConfig) -> Result<(), String> {
    if config.schema != "editkin.remote-user-config/v1"
        || config.schema_version != 1
        || config.mode != "user-owned-byo"
        || !["https-tunnel", "cloud-relay"].contains(&config.transport.as_str())
        || config.cost_responsibility != "end-user"
        || !config.user_confirmed_costs_and_permissions
        || config.provider_id.len() < 2
        || config.provider_id.len() > 63
        || !config
            .provider_id
            .bytes()
            .next()
            .is_some_and(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        || !config.provider_id.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"._-".contains(&byte)
        })
        || config.configuration_id.len() != 64
        || !config
            .configuration_id
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        || config.configured_at.trim().is_empty()
        || validate_user_https_origin("Editkin Remote 設定", &config.origin)? != config.origin
        || remote_network_configuration_id(&config) != config.configuration_id
    {
        return Err("使用者 Remote 設定沒有通過 user-owned／non-secret closed-world 驗證".into());
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct RemoteFileIdentity {
    storage_id: u64,
    file_id: u64,
    len: u64,
    revision: u128,
    reparse: bool,
    regular: bool,
}

#[cfg(windows)]
fn remote_file_identity(file: &fs::File) -> Result<RemoteFileIdentity, String> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_REPARSE_POINT,
    };
    let mut information = unsafe { std::mem::zeroed::<BY_HANDLE_FILE_INFORMATION>() };
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut information) } == 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    Ok(RemoteFileIdentity {
        storage_id: u64::from(information.dwVolumeSerialNumber),
        file_id: (u64::from(information.nFileIndexHigh) << 32)
            | u64::from(information.nFileIndexLow),
        len: (u64::from(information.nFileSizeHigh) << 32) | u64::from(information.nFileSizeLow),
        revision: (u128::from(information.ftLastWriteTime.dwHighDateTime) << 32)
            | u128::from(information.ftLastWriteTime.dwLowDateTime),
        reparse: information.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0,
        regular: true,
    })
}

#[cfg(unix)]
fn remote_file_identity(file: &fs::File) -> Result<RemoteFileIdentity, String> {
    use std::os::unix::fs::MetadataExt;
    let metadata = file.metadata().map_err(|error| error.to_string())?;
    Ok(RemoteFileIdentity {
        storage_id: metadata.dev(),
        file_id: metadata.ino(),
        len: metadata.len(),
        revision: ((metadata.mtime() as u128) << 32) | metadata.mtime_nsec() as u128,
        reparse: metadata.file_type().is_symlink(),
        regular: metadata.is_file(),
    })
}

#[cfg(windows)]
fn open_remote_file_no_follow(path: &Path) -> Result<(fs::File, RemoteFileIdentity), String> {
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT;
    let file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
        .map_err(|error| error.to_string())?;
    let identity = remote_file_identity(&file)?;
    if identity.reparse || !identity.regular {
        return Err("Remote 設定必須是本機一般檔案；symlink/reparse 路徑已拒絕".into());
    }
    Ok((file, identity))
}

#[cfg(unix)]
fn open_remote_file_no_follow(path: &Path) -> Result<(fs::File, RemoteFileIdentity), String> {
    use std::os::unix::fs::OpenOptionsExt;
    let file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .map_err(|error| error.to_string())?;
    let identity = remote_file_identity(&file)?;
    if identity.reparse || !identity.regular {
        return Err("Remote 設定必須是本機一般檔案；symlink/reparse 路徑已拒絕".into());
    }
    Ok((file, identity))
}

fn remote_file_identity_at_path(path: &Path) -> Result<Option<RemoteFileIdentity>, String> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
            Err("Remote 設定目的地不可是 symlink/reparse 路徑".into())
        }
        Ok(_) => open_remote_file_no_follow(path).map(|(_, identity)| Some(identity)),
    }
}

fn ensure_remote_destination_revision(
    path: &Path,
    expected: Option<RemoteFileIdentity>,
) -> Result<(), String> {
    if remote_file_identity_at_path(path)? != expected {
        return Err("Remote 設定目的地 revision 在提交前改變；已拒絕覆蓋".into());
    }
    Ok(())
}

fn read_remote_json_with_identity(
    path: &Path,
) -> Result<Option<(Value, RemoteFileIdentity)>, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() > 64 * 1024 {
        return Err("Remote 設定必須是小型本機一般檔案；symlink/reparse 路徑已拒絕".into());
    }
    let (mut file, before) = open_remote_file_no_follow(path)?;
    if before.len > 64 * 1024 {
        return Err("Remote 設定超過 64 KiB 上限".into());
    }
    let mut bytes = Vec::with_capacity(before.len as usize);
    Read::by_ref(&mut file)
        .take(64 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    let after = remote_file_identity(&file)?;
    let current = remote_file_identity_at_path(path)?;
    if bytes.len() > 64 * 1024
        || before != after
        || before.len != bytes.len() as u64
        || current != Some(after)
    {
        return Err("Remote 設定檔在 bounded handle 讀取期間被替換或修改；已 fail closed".into());
    }
    serde_json::from_slice(&bytes)
        .map(|value| Some((value, after)))
        .map_err(|error| error.to_string())
}

fn read_remote_json(path: &Path) -> Result<Option<Value>, String> {
    read_remote_json_with_identity(path).map(|record| record.map(|(value, _)| value))
}

#[cfg(windows)]
fn replace_remote_file(temporary: &Path, destination: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };
    let from = temporary
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let to = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    if unsafe {
        MoveFileExW(
            from.as_ptr(),
            to.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    } == 0
    {
        return Err(std::io::Error::last_os_error().to_string());
    }
    Ok(())
}

#[cfg(not(windows))]
fn replace_remote_file(temporary: &Path, destination: &Path) -> Result<(), String> {
    fs::rename(temporary, destination).map_err(|error| error.to_string())
}

fn write_remote_json_atomic(path: &Path, value: &Value) -> Result<(), String> {
    let parent = path.parent().ok_or("Remote 設定缺少父目錄")?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let parent_metadata = fs::symlink_metadata(parent).map_err(|error| error.to_string())?;
    if parent_metadata.file_type().is_symlink() || !parent_metadata.is_dir() {
        return Err("Remote 設定目錄不可是 symlink/reparse 路徑".into());
    }
    let expected_destination = remote_file_identity_at_path(path)?;
    let temporary = PathBuf::from(format!(
        "{}.{}.{}.tmp",
        path.to_string_lossy(),
        std::process::id(),
        pairing_token()?
    ));
    let result = (|| {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| error.to_string())?;
        file.write_all(
            format!(
                "{}\n",
                serde_json::to_string_pretty(value).map_err(|error| error.to_string())?
            )
            .as_bytes(),
        )
        .map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
        drop(file);
        ensure_remote_destination_revision(path, expected_destination)?;
        replace_remote_file(&temporary, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn write_remote_json_create_new(path: &Path, value: &Value) -> Result<(), String> {
    let parent = path.parent().ok_or("Remote 設定缺少父目錄")?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let parent_metadata = fs::symlink_metadata(parent).map_err(|error| error.to_string())?;
    if !parent_metadata.is_dir() || remote_agent_directory_is_link(&parent_metadata) {
        return Err("Remote 設定目錄不可是 symlink/reparse 路徑".into());
    }
    if remote_file_identity_at_path(path)?.is_some() {
        return Err("Remote immutable record 已存在；拒絕覆寫或重播".into());
    }
    let temporary = PathBuf::from(format!(
        "{}.{}.{}.create-new.tmp",
        path.to_string_lossy(),
        std::process::id(),
        pairing_token()?
    ));
    let mut temporary_identity = None;
    let result = (|| {
        let bytes = format!(
            "{}\n",
            serde_json::to_string_pretty(value).map_err(|error| error.to_string())?
        )
        .into_bytes();
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| error.to_string())?;
        file.write_all(&bytes).map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
        temporary_identity = Some(remote_file_identity(&file)?);
        drop(file);
        fs::hard_link(&temporary, path).map_err(|error| {
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                "Remote immutable record CAS 失敗；相同 identity 已被保留".to_string()
            } else {
                format!("Remote immutable record 無法原子發佈：{error}")
            }
        })?;
        let (_, published) = open_remote_file_no_follow(path)?;
        if Some(published) != temporary_identity || published.len != bytes.len() as u64 {
            return Err(
                "Remote immutable record 發佈後 identity／長度不一致；已 fail closed".into(),
            );
        }
        Ok(())
    })();
    let _ = fs::remove_file(&temporary);
    if result.is_err() && remote_file_identity_at_path(path).ok().flatten() == temporary_identity {
        let _ = fs::remove_file(path);
    }
    result
}

fn user_remote_network_config(app: &AppHandle) -> Result<Option<UserRemoteNetworkConfig>, String> {
    let Some(value) = read_remote_json(&user_remote_network_config_path(app)?)? else {
        return Ok(None);
    };
    let config = serde_json::from_value::<UserRemoteNetworkConfig>(value)
        .map_err(|error| format!("使用者 Remote 設定格式不合法：{error}"))?;
    validate_user_remote_network_config(&config)?;
    Ok(Some(config))
}

fn valid_candidate_revision(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| {
            if [8, 13, 18, 23].contains(&index) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        })
        && value.as_bytes().get(14) == Some(&b'4')
        && value
            .as_bytes()
            .get(19)
            .is_some_and(|byte| b"89abAB".contains(byte))
}

fn user_remote_network_candidate(
    app: &AppHandle,
) -> Result<Option<PendingUserRemoteNetworkConfig>, String> {
    let Some(value) = read_remote_json(&user_remote_network_candidate_path(app)?)? else {
        return Ok(None);
    };
    parse_user_remote_network_candidate(value).map(Some)
}

fn parse_user_remote_network_candidate(
    value: Value,
) -> Result<PendingUserRemoteNetworkConfig, String> {
    let candidate = serde_json::from_value::<PendingUserRemoteNetworkConfig>(value)
        .map_err(|error| format!("Remote 桌面核准候選格式不合法：{error}"))?;
    let now = unix_time_ms();
    if candidate.schema != "editkin.remote-config-candidate/v1"
        || !valid_candidate_revision(&candidate.candidate_revision)
        || candidate
            .expected_configuration_id
            .as_ref()
            .is_some_and(|value| {
                value.len() != 64
                    || !value
                        .bytes()
                        .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
            })
        || candidate.prepared_at_ms > now.saturating_add(60_000)
        || candidate.expires_at_ms <= now
        || candidate
            .expires_at_ms
            .saturating_sub(candidate.prepared_at_ms)
            != 30 * 60 * 1_000
    {
        return Err("Remote 桌面核准候選已失效；請讓 AI 重新準備並再次說明費用與權限".into());
    }
    validate_user_remote_network_config(&candidate.configuration)?;
    Ok(candidate)
}

fn ensure_remote_candidate_matches_approval(
    candidate: &PendingUserRemoteNetworkConfig,
    expected_candidate_revision: &str,
    expected_configuration_id: &str,
) -> Result<(), String> {
    if candidate.candidate_revision != expected_candidate_revision
        || candidate.configuration.configuration_id != expected_configuration_id
    {
        return Err(
            "Remote 核准畫面已過期或候選設定已變更；已拒絕寫入，請重新核對供應商與 host".into(),
        );
    }
    Ok(())
}

fn promote_user_remote_network_candidate(
    app: &AppHandle,
    expected_candidate_revision: &str,
    expected_configuration_id: &str,
) -> Result<UserRemoteNetworkConfig, String> {
    let candidate_path = user_remote_network_candidate_path(app)?;
    let claimed_path = candidate_path.with_extension(format!("approving-{}", std::process::id()));
    if fs::symlink_metadata(&claimed_path).is_ok() {
        return Err(
            "上一次 Remote 核准交易尚未清理；為避免覆蓋較新 revision，已 fail closed".into(),
        );
    }
    fs::rename(&candidate_path, &claimed_path)
        .map_err(|_| "找不到待核准的 Remote 設定；請先讓 AI 完成 prepare/configure".to_string())?;
    let result = (|| {
        let value = read_remote_json(&claimed_path)?.ok_or("Remote 核准候選在交易中消失")?;
        let candidate = serde_json::from_value::<PendingUserRemoteNetworkConfig>(value)
            .map_err(|error| format!("Remote 桌面核准候選格式不合法：{error}"))?;
        let now = unix_time_ms();
        if candidate.schema != "editkin.remote-config-candidate/v1"
            || !valid_candidate_revision(&candidate.candidate_revision)
            || candidate
                .expected_configuration_id
                .as_ref()
                .is_some_and(|value| {
                    value.len() != 64
                        || !value
                            .bytes()
                            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
                })
            || candidate.prepared_at_ms > now.saturating_add(60_000)
            || candidate.expires_at_ms <= now
            || candidate
                .expires_at_ms
                .saturating_sub(candidate.prepared_at_ms)
                != 30 * 60 * 1_000
        {
            return Err("Remote 桌面核准候選已失效".into());
        }
        validate_user_remote_network_config(&candidate.configuration)?;
        ensure_remote_candidate_matches_approval(
            &candidate,
            expected_candidate_revision,
            expected_configuration_id,
        )?;
        let current_configuration_id =
            user_remote_network_config(app)?.map(|configuration| configuration.configuration_id);
        if current_configuration_id != candidate.expected_configuration_id {
            return Err("Remote 正式設定 revision 已改變；已拒絕用過期候選覆蓋".into());
        }
        write_remote_json_atomic(
            &user_remote_network_config_path(app)?,
            &serde_json::to_value(&candidate.configuration).map_err(|error| error.to_string())?,
        )?;
        let _ = fs::remove_file(user_remote_verification_path(app)?);
        Ok(candidate.configuration)
    })();
    let _ = fs::remove_file(&claimed_path);
    result
}

fn remote_network_configuration_id(config: &UserRemoteNetworkConfig) -> String {
    let fields = [
        config.schema.as_str(),
        "1",
        config.mode.as_str(),
        config.transport.as_str(),
        config.origin.as_str(),
        config.provider_id.as_str(),
        config.cost_responsibility.as_str(),
        if config.user_confirmed_costs_and_permissions {
            "true"
        } else {
            "false"
        },
        config.configured_at.as_str(),
    ];
    let mut hasher = Sha256::new();
    hasher.update(fields.join("\0").as_bytes());
    format!("{:x}", hasher.finalize())
}

fn environment_remote_origins() -> Result<(Option<String>, Option<String>), String> {
    remote_network_policy()?;
    let relay = env::var("EDITKIN_REMOTE_RELAY_URL")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(|value| validate_user_https_origin("EDITKIN_REMOTE_RELAY_URL", &value))
        .transpose()?;
    let tunnel = env::var("EDITKIN_REMOTE_PUBLIC_URL")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(|value| validate_user_https_origin("EDITKIN_REMOTE_PUBLIC_URL", &value))
        .transpose()?;
    if relay.is_some() && tunnel.is_some() {
        return Err("EDITKIN_REMOTE_RELAY_URL 與 EDITKIN_REMOTE_PUBLIC_URL 只能擇一設定".into());
    }
    Ok((relay, tunnel))
}

fn configured_remote_origins(app: &AppHandle) -> Result<(Option<String>, Option<String>), String> {
    let (relay, tunnel) = environment_remote_origins()?;
    let configured = user_remote_network_config(app)?;
    if configured.is_some() && (relay.is_some() || tunnel.is_some()) {
        return Err("Remote 環境變數與 AI 寫回設定不可同時存在；請只保留一個明確來源".into());
    }
    if let Some(config) = configured {
        return Ok(if config.transport == "cloud-relay" {
            (Some(config.origin), None)
        } else {
            (None, Some(config.origin))
        });
    }
    Ok((relay, tunnel))
}

fn remote_environment_configuration_id(transport: &str, origin: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(
        [
            "editkin.remote-environment-config/v1",
            "1",
            transport,
            origin,
        ]
        .join("\0")
        .as_bytes(),
    );
    format!("{:x}", hasher.finalize())
}

fn remote_renewing_artifact_present(path: &Path) -> Result<bool, String> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!("無法檢查 Remote renewal crash artifact：{error}")),
    }
}

#[derive(Clone, Copy)]
struct RemoteNetworkSummaryDisposition<'a> {
    setup_phase: &'static str,
    truth_label: &'static str,
    proposed_transport: Option<&'a str>,
    proposal: Option<&'a RemoteProviderProposal>,
    resume_available: bool,
}

fn remote_network_state_conflict(
    configured_id: Option<&str>,
    candidate: Option<&PendingUserRemoteNetworkConfig>,
    pending_present: bool,
    environment_configured: bool,
) -> bool {
    let candidate_lineage_conflict = candidate
        .is_some_and(|candidate| candidate.expected_configuration_id.as_deref() != configured_id);
    candidate_lineage_conflict
        || (pending_present
            && (candidate.is_some() || configured_id.is_some() || environment_configured))
        || (environment_configured && (candidate.is_some() || configured_id.is_some()))
}

fn remote_network_summary_disposition<'a>(
    pending: Option<&'a PendingRemoteSetupRecord>,
    renewing_present: bool,
    state_conflict: bool,
    candidate_present: bool,
    environment_configured: bool,
    transport: &'a str,
    verification_present: bool,
    now_ms: u64,
) -> RemoteNetworkSummaryDisposition<'a> {
    if renewing_present {
        return RemoteNetworkSummaryDisposition {
            setup_phase: "RENEWAL_RECONCILIATION_REQUIRED",
            truth_label: "RENEWAL_RECOVERY_REQUIRED_NO_AUTOMATIC_REPLAY",
            proposed_transport: None,
            proposal: None,
            resume_available: false,
        };
    }
    if state_conflict {
        return RemoteNetworkSummaryDisposition {
            setup_phase: "STATE_RECONCILIATION_REQUIRED",
            truth_label: "STATE_CONFLICT_REQUIRES_MANUAL_RECONCILIATION",
            proposed_transport: None,
            proposal: None,
            resume_available: false,
        };
    }
    if let Some(pending) = pending {
        return match pending {
            PendingRemoteSetupRecord::ProviderProposal(proposal) => {
                let expired = proposal.expires_at_ms <= now_ms;
                RemoteNetworkSummaryDisposition {
                    setup_phase: if expired {
                        "EXPIRED"
                    } else {
                        "EXACT_PROVIDER_PROPOSAL"
                    },
                    truth_label: if expired {
                        "PROPOSAL_EXPIRED_NOT_APPROVED"
                    } else {
                        "PROPOSAL_READY_NOT_APPROVED"
                    },
                    proposed_transport: Some(proposal.transport.as_str()),
                    proposal: Some(proposal),
                    resume_available: !expired,
                }
            }
            PendingRemoteSetupRecord::Legacy(_)
            | PendingRemoteSetupRecord::LegacyProviderProposal => RemoteNetworkSummaryDisposition {
                setup_phase: "LEGACY_PENDING_BLOCKED",
                truth_label: "LEGACY_PENDING_REQUIRES_MIGRATION_OR_DISCARD",
                proposed_transport: None,
                proposal: None,
                resume_available: false,
            },
        };
    }
    if candidate_present {
        return RemoteNetworkSummaryDisposition {
            setup_phase: "AWAITING_DESKTOP_APPROVAL",
            truth_label: "DESKTOP_APPROVAL_REQUIRED_NOT_CONNECTED",
            proposed_transport: None,
            proposal: None,
            resume_available: true,
        };
    }
    if environment_configured {
        return RemoteNetworkSummaryDisposition {
            setup_phase: "ENV_CONFIGURED_READ_ONLY",
            truth_label: "ENV_CONFIGURED_OUTSIDE_EDITKIN",
            proposed_transport: None,
            proposal: None,
            resume_available: false,
        };
    }
    if transport != "lan" {
        return RemoteNetworkSummaryDisposition {
            setup_phase: if verification_present {
                "ROUTE_PARTIAL_VERIFIED"
            } else {
                "CONFIGURED_UNVERIFIED"
            },
            truth_label: if verification_present {
                "ROUTE_PARTIAL_NOT_REAL_PHONE_RECONNECT_VERIFIED"
            } else {
                "CONFIGURED_NOT_VERIFIED"
            },
            proposed_transport: None,
            proposal: None,
            resume_available: true,
        };
    }
    RemoteNetworkSummaryDisposition {
        setup_phase: "RESEARCH_READY",
        truth_label: "READY_TO_RESEARCH",
        proposed_transport: None,
        proposal: None,
        resume_available: true,
    }
}

#[tauri::command]
fn get_mobile_remote_network_summary(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let (relay, tunnel) = environment_remote_origins()?;
    let environment_configured = relay.is_some() || tunnel.is_some();
    let renewing_present =
        remote_renewing_artifact_present(&user_remote_setup_renewing_path(&app)?)?;
    let configured = if renewing_present {
        None
    } else {
        user_remote_network_config(&app)?
    };
    let candidate = if renewing_present {
        None
    } else {
        user_remote_network_candidate(&app)?
    };
    let pending = if renewing_present {
        None
    } else {
        read_remote_json(&user_remote_setup_pending_path(&app)?)?
            .map(parse_pending_remote_setup_record)
            .transpose()?
    };
    let configured_id = configured
        .as_ref()
        .map(|configuration| configuration.configuration_id.as_str());
    let state_conflict = remote_network_state_conflict(
        configured_id,
        candidate.as_ref(),
        pending.is_some(),
        environment_configured,
    );
    let transport = if let Some(candidate) = candidate.as_ref() {
        candidate.configuration.transport.as_str()
    } else if let Some(configured) = configured.as_ref() {
        configured.transport.as_str()
    } else if relay.is_some() {
        "cloud-relay"
    } else if tunnel.is_some() {
        "https-tunnel"
    } else {
        "lan"
    };
    let mut remote_state = state
        .mobile_remote
        .lock()
        .map_err(|_| "mobile remote lock poisoned")?;
    let mut discard_remote = false;
    let active_runtime_identity = if let Some(remote) = remote_state.as_mut() {
        match remote.child.try_wait() {
            Ok(None) => Some((
                remote.probe_id.clone(),
                remote.runtime_instance_id.clone(),
                remote.child.id(),
                remote.started_at_ms,
            )),
            Ok(Some(_)) | Err(_) => {
                discard_remote = true;
                None
            }
        }
    } else {
        None
    };
    if discard_remote {
        remote_state.take();
    }
    drop(remote_state);
    let verification = if renewing_present
        || state_conflict
        || candidate.is_some()
        || pending.is_some()
        || environment_configured
    {
        None
    } else {
        configured.as_ref().and_then(|config| {
            read_remote_json(&user_remote_verification_path(&app).ok()?)
                .ok()
                .flatten()
                .filter(|value| {
                    let expected_keys = [
                        "configurationId",
                        "endpointKind",
                        "jitterMs",
                        "latencyMs",
                        "latencyP50Ms",
                        "processId",
                        "probeId",
                        "reconnectVerified",
                        "requiresActiveMobileProof",
                        "routeEvidence",
                        "runtimeInstanceId",
                        "schema",
                        "startedAtMs",
                        "status",
                        "successfulTlsConnections",
                        "verified",
                        "verifiedAt",
                        "verifiedAtMs",
                    ]
                    .into_iter()
                    .collect::<BTreeSet<_>>();
                    let actual_keys = value
                        .as_object()
                        .map(|object| object.keys().map(String::as_str).collect::<BTreeSet<_>>())
                        .unwrap_or_default();
                    let verified_at = value
                        .get("verifiedAtMs")
                        .and_then(Value::as_u64)
                        .unwrap_or(0) as u128;
                    let now = unix_time_ms();
                    let runtime_matches = active_runtime_identity.as_ref().is_some_and(
                        |(probe_id, runtime_instance_id, process_id, started_at_ms)| {
                            value.get("probeId").and_then(Value::as_str) == Some(probe_id.as_str())
                                && value.get("runtimeInstanceId").and_then(Value::as_str)
                                    == Some(runtime_instance_id.as_str())
                                && value.get("processId").and_then(Value::as_u64)
                                    == Some(u64::from(*process_id))
                                && value.get("startedAtMs").and_then(Value::as_u64)
                                    == u64::try_from(*started_at_ms).ok()
                                && verified_at > *started_at_ms
                        },
                    );
                    runtime_matches
                        && actual_keys == expected_keys
                        && verified_at <= now.saturating_add(60_000)
                        && now.saturating_sub(verified_at) <= 15 * 60 * 1_000
                        && value.get("schema").and_then(Value::as_str)
                            == Some("editkin.remote-route-verification/v3")
                        && value.get("configurationId").and_then(Value::as_str)
                            == Some(config.configuration_id.as_str())
                        && value.get("status").and_then(Value::as_str) == Some("PARTIAL")
                        && value.get("verified").and_then(Value::as_bool) == Some(false)
                        && value
                            .get("successfulTlsConnections")
                            .and_then(Value::as_u64)
                            == Some(2)
                        && value.get("routeEvidence").and_then(Value::as_str)
                            == Some("two-pinned-independent-tls-connections-succeeded")
                        && value.get("reconnectVerified").and_then(Value::as_bool) == Some(false)
                        && value
                            .get("requiresActiveMobileProof")
                            .and_then(Value::as_bool)
                            == Some(true)
                        && value
                            .get("latencyP50Ms")
                            .and_then(Value::as_f64)
                            .is_some_and(|latency| latency.is_finite() && latency >= 0.0)
                        && value
                            .get("jitterMs")
                            .and_then(Value::as_f64)
                            .is_some_and(|jitter| jitter.is_finite() && jitter >= 0.0)
                })
        })
    };
    let quality = verification
        .as_ref()
        .map(|value| {
            json!({
                "status": "partial",
                "latencyP50Ms": value.get("latencyP50Ms").and_then(Value::as_f64),
                "jitterMs": value.get("jitterMs").and_then(Value::as_f64),
                "reconnectVerified": false,
                "observedAt": value.get("verifiedAt").and_then(Value::as_str)
            })
        })
        .unwrap_or_else(|| {
            json!({
                "status": if transport == "lan" { "local" } else { "unverified" },
                "reconnectVerified": false
            })
        });
    let disposition = remote_network_summary_disposition(
        pending.as_ref(),
        renewing_present,
        state_conflict,
        candidate.is_some(),
        environment_configured,
        transport,
        verification.is_some(),
        u64::try_from(unix_time_ms()).unwrap_or(u64::MAX),
    );
    let setup_phase = disposition.setup_phase;
    let truth_label = disposition.truth_label;
    let proposed_transport = disposition.proposed_transport;
    let proposal = disposition.proposal;
    let resume_available = disposition.resume_available;
    let provider_id = match pending.as_ref() {
        Some(PendingRemoteSetupRecord::ProviderProposal(proposal)) => proposal.provider.id.as_str(),
        Some(PendingRemoteSetupRecord::Legacy(legacy)) => legacy.provider_id.as_str(),
        Some(PendingRemoteSetupRecord::LegacyProviderProposal) => "legacy-proposal-v1",
        None => candidate
            .as_ref()
            .map(|value| value.configuration.provider_id.as_str())
            .or_else(|| configured.as_ref().map(|value| value.provider_id.as_str()))
            .unwrap_or(if transport == "lan" {
                "none"
            } else {
                "environment-configured"
            }),
    };
    let origin_host = candidate
        .as_ref()
        .map(|value| value.configuration.origin.as_str())
        .or_else(|| configured.as_ref().map(|value| value.origin.as_str()))
        .or(relay.as_deref())
        .or(tunnel.as_deref())
        .and_then(|origin| origin.strip_prefix("https://"))
        .unwrap_or("");
    let environment_configuration_id = relay
        .as_deref()
        .map(|origin| remote_environment_configuration_id("cloud-relay", origin))
        .or_else(|| {
            tunnel
                .as_deref()
                .map(|origin| remote_environment_configuration_id("https-tunnel", origin))
        });
    let normal_configuration_id = match setup_phase {
        "AWAITING_DESKTOP_APPROVAL" => candidate
            .as_ref()
            .map(|value| value.configuration.configuration_id.as_str()),
        "CONFIGURED_UNVERIFIED" | "ROUTE_PARTIAL_VERIFIED" => configured_id,
        "ENV_CONFIGURED_READ_ONLY" => environment_configuration_id.as_deref(),
        _ => None,
    };
    let configured_for_summary = matches!(
        setup_phase,
        "CONFIGURED_UNVERIFIED" | "ROUTE_PARTIAL_VERIFIED" | "ENV_CONFIGURED_READ_ONLY"
    );
    let pending_desktop_approval = setup_phase == "AWAITING_DESKTOP_APPROVAL";
    let mut summary = json!({
        "schema": "editkin.remote-network-summary/v2",
        "setupPhase": setup_phase,
        "truthLabel": truth_label,
        "transport": transport,
        "configured": configured_for_summary,
        "pendingDesktopApproval": pending_desktop_approval,
        "candidateRevision": if pending_desktop_approval { candidate.as_ref().map(|value| value.candidate_revision.as_str()) } else { None },
        "configurationId": normal_configuration_id,
        "providerId": provider_id,
        "originHost": origin_host,
        "costResponsibility": if setup_phase == "RESEARCH_READY" { "none" } else { "end-user" },
        "requiresExternalTrafficConsent": transport != "lan",
        "previewSupport": if transport == "cloud-relay" { "commands-and-status-only" } else { "preview-available" },
        "quality": quality,
        "resumeAvailable": resume_available
    });
    if let Some(proposed_transport) = proposed_transport {
        summary["proposedTransport"] = Value::from(proposed_transport);
    }
    if let Some(proposal) = proposal {
        summary["proposal"] = serde_json::to_value(proposal).map_err(|error| error.to_string())?;
    }
    Ok(summary)
}

#[tauri::command]
fn list_remote_provider_connectors() -> Result<Value, String> {
    remote_provider_connector::list_connector_status()
}

fn parse_remote_port(value: &str) -> Result<u16, String> {
    let port = value
        .parse::<u16>()
        .map_err(|_| "EDITKIN_REMOTE_PORT 必須是 1-65535 的整數".to_string())?;
    if port == 0 {
        return Err("EDITKIN_REMOTE_PORT 必須是 1-65535 的整數".into());
    }
    Ok(port)
}

fn ensure_mobile_remote_start_authority(
    candidate: Option<&PendingUserRemoteNetworkConfig>,
    active_configuration_id: Option<&str>,
    environment_configured: bool,
    external_traffic_confirmed: Option<bool>,
    expected_candidate_revision: Option<&str>,
    expected_configuration_id: Option<&str>,
) -> Result<(), String> {
    if let Some(candidate) = candidate {
        if environment_configured {
            return Err(
                "Remote 環境變數設定與 AI candidate 同時存在；已拒絕建立 split-brain 設定".into(),
            );
        }
        if external_traffic_confirmed != Some(true) {
            return Err("AI 只準備了待核准設定；必須由你在 Editkin 親自確認供應商、費用與 host，才會寫入正式設定".into());
        }
        let expected_candidate_revision = expected_candidate_revision
            .ok_or("Remote 核准缺少畫面 candidate revision；已拒絕寫入，請重新開啟核准畫面")?;
        let expected_configuration_id = expected_configuration_id
            .ok_or("Remote 核准缺少畫面 configuration identity；已拒絕寫入，請重新開啟核准畫面")?;
        ensure_remote_candidate_matches_approval(
            candidate,
            expected_candidate_revision,
            expected_configuration_id,
        )?;
        if candidate.expected_configuration_id.as_deref() != active_configuration_id {
            return Err("Remote 正式設定 revision 已改變；已拒絕用過期候選啟動".into());
        }
        return Ok(());
    }

    if expected_candidate_revision.is_some() {
        return Err("Remote 核准候選已消失或已被替換；已拒絕啟動，請重新核對畫面".into());
    }
    if let Some(active_configuration_id) = active_configuration_id {
        if external_traffic_confirmed != Some(true) {
            return Err("跨網路 Remote 會使用你自己的供應商帳戶並可能產生流量費；必須先在 Editkin 明確確認才能啟動".into());
        }
        if expected_configuration_id != Some(active_configuration_id) {
            return Err(
                "Remote 正式設定 identity 已改變或畫面缺少 exact configurationId；已拒絕啟動"
                    .into(),
            );
        }
        return Ok(());
    }
    if expected_configuration_id.is_some() {
        return Err("Remote 畫面帶有已失效的 configuration identity；已拒絕啟動".into());
    }
    Ok(())
}

#[tauri::command]
fn start_mobile_remote(
    app: AppHandle,
    state: State<'_, AppState>,
    snapshot: Value,
    external_traffic_confirmed: Option<bool>,
    expected_candidate_revision: Option<String>,
    expected_configuration_id: Option<String>,
) -> Result<Value, String> {
    let candidate = user_remote_network_candidate(&app)?;
    let configured = user_remote_network_config(&app)?;
    let (environment_relay, environment_tunnel) = environment_remote_origins()?;
    let environment_configured = environment_relay.is_some() || environment_tunnel.is_some();
    if environment_configured && configured.is_some() {
        return Err("Remote 環境變數與 AI 寫回設定不可同時存在；請先人工 reconciliation".into());
    }
    let environment_configuration_id = environment_relay
        .as_deref()
        .map(|origin| remote_environment_configuration_id("cloud-relay", origin))
        .or_else(|| {
            environment_tunnel
                .as_deref()
                .map(|origin| remote_environment_configuration_id("https-tunnel", origin))
        });
    let active_configuration_id = configured
        .as_ref()
        .map(|configuration| configuration.configuration_id.as_str())
        .or(environment_configuration_id.as_deref());
    if (active_configuration_id.is_some() || candidate.is_some())
        && (remote_file_identity_at_path(&user_remote_setup_pending_path(&app)?)?.is_some()
            || remote_renewing_artifact_present(&user_remote_setup_renewing_path(&app)?)?)
    {
        return Err(
            "Remote 正式設定與 proposal／renewal artifact 同時存在；請先人工 reconciliation".into(),
        );
    }
    ensure_mobile_remote_start_authority(
        candidate.as_ref(),
        active_configuration_id,
        environment_configured,
        external_traffic_confirmed,
        expected_candidate_revision.as_deref(),
        expected_configuration_id.as_deref(),
    )?;
    if candidate.is_some() {
        promote_user_remote_network_candidate(
            &app,
            expected_candidate_revision
                .as_deref()
                .expect("authority check requires candidate revision"),
            expected_configuration_id
                .as_deref()
                .expect("authority check requires configuration identity"),
        )?;
    }
    let mut remote_state = state
        .mobile_remote
        .lock()
        .map_err(|_| "mobile remote lock poisoned")?;
    if remote_state.is_some() {
        let discard_remote;
        let mut reuse_result = None;
        {
            let remote = remote_state.as_mut().expect("Remote state exists");
            match remote.child.try_wait() {
                Ok(None) => {
                    let device_status = fs::read_to_string(&remote.devices_path)
                        .ok()
                        .and_then(|content| serde_json::from_str::<Value>(&content).ok());
                    let connected = device_status
                        .as_ref()
                        .and_then(|value| value.get("connectedCount").and_then(Value::as_u64))
                        .unwrap_or(0)
                        > 0;
                    // The pairing token is single use: once a device consumed it, the
                    // link is dead, so a new pairing needs a fresh server and token.
                    let pairing_consumed = device_status
                        .as_ref()
                        .and_then(|value| value.get("pairingConsumed").and_then(Value::as_bool))
                        .unwrap_or(false);
                    if connected
                        || (unix_time_ms() < remote.pairing_expires_at_ms && !pairing_consumed)
                    {
                        reuse_result = Some((|| {
                            write_json_atomic(&remote.snapshot_path, &snapshot)?;
                            Clipboard::new()
                                .and_then(|mut clipboard| clipboard.set_text(remote.url.clone()))
                                .map_err(|error| error.to_string())?;
                            Ok(
                                json!({ "active": true, "url": remote.url, "token": remote.token, "copied": true, "transport": remote.transport, "warning": remote.warning }),
                            )
                        })());
                        discard_remote = reuse_result.as_ref().is_some_and(Result::is_err);
                    } else {
                        discard_remote = true;
                    }
                }
                Ok(Some(_)) => discard_remote = true,
                Err(error) => {
                    discard_remote = true;
                    reuse_result = Some(Err(format!(
                        "無法查詢既有手機遙控服務；已停止該 process：{error}"
                    )));
                }
            }
        }
        if discard_remote {
            remote_state.take();
        }
        if let Some(result) = reuse_result {
            return result;
        }
    }
    let runtime = runtime_paths(&app)?;
    let root = application_cache_root(&app)?.join("mobile-remote");
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    let queue_path = root.join("commands");
    let snapshot_path = root.join("snapshot.json");
    let devices_path = root.join("devices.json");
    let trusted_devices_path = mobile_trusted_devices_path(&app)?;
    let _ = fs::remove_dir_all(&queue_path);
    fs::create_dir_all(&queue_path).map_err(|error| error.to_string())?;
    write_json_atomic(&snapshot_path, &snapshot)?;
    write_json_atomic(
        &devices_path,
        &json!({ "connectedCount": 0, "devices": [] }),
    )?;
    let (relay_origin, public_tunnel_origin) = configured_remote_origins(&app)?;
    let persisted_remote_config = user_remote_network_config(&app)?;
    let runtime_configuration_id = persisted_remote_config
        .as_ref()
        .map(|config| config.configuration_id.clone())
        .or_else(|| {
            relay_origin
                .as_deref()
                .map(|origin| remote_environment_configuration_id("cloud-relay", origin))
        })
        .or_else(|| {
            public_tunnel_origin
                .as_deref()
                .map(|origin| remote_environment_configuration_id("https-tunnel", origin))
        });
    if (relay_origin.is_some() || public_tunnel_origin.is_some())
        && external_traffic_confirmed != Some(true)
    {
        return Err("跨網路 Remote 會使用你自己的供應商帳戶並可能產生流量費；必須先在 Editkin 明確確認才能啟動".into());
    }
    let relay = relay_origin
        .map(|origin| {
            mobile_relay_identity(&app).map(|identity| {
                let websocket_origin = origin.replacen("https://", "wss://", 1);
                let public_url = format!("{origin}/r/{}", identity.room);
                let websocket_url = format!("{websocket_origin}/ws/{}", identity.room);
                (identity, public_url, websocket_url)
            })
        })
        .transpose()?;
    let configured_port = env::var("EDITKIN_REMOTE_PORT")
        .ok()
        .map(|value| parse_remote_port(&value))
        .transpose()?;
    let preferred_port = configured_port.unwrap_or(12690);
    let (listener, stable_port_warning) = match TcpListener::bind(("0.0.0.0", preferred_port)) {
        Ok(listener) => (listener, None),
        Err(error) if configured_port.is_none() && public_tunnel_origin.is_none() => (
            TcpListener::bind(("0.0.0.0", 0))
                .map_err(|fallback| format!("手機遙控連接埠無法使用：{error}; fallback: {fallback}"))?,
            Some("固定連接埠 12690 正在使用；本次已改用臨時連接埠，裝置仍保持永久授權，但可能需要打開新的 Remote 連結。".to_string()),
        ),
        Err(error) if public_tunnel_origin.is_some() => {
            return Err(format!(
                "使用者自備的 HTTPS tunnel 必須指向固定連接埠 {preferred_port}，但該連接埠無法使用：{error}"
            ))
        }
        Err(error) => return Err(format!("手機遙控連接埠無法使用：{error}")),
    };
    let port = listener
        .local_addr()
        .map_err(|error| error.to_string())?
        .port();
    drop(listener);
    let runtime_receipt_path = user_remote_runtime_path(&app)?;
    if let Err(error) = fs::remove_file(&runtime_receipt_path) {
        if error.kind() != std::io::ErrorKind::NotFound {
            return Err(format!("無法清除過期 Remote runtime receipt：{error}"));
        }
    }
    let token = pairing_token()?;
    let health_probe_id = pairing_token()?;
    let runtime_instance_id = pairing_token()?;
    let pairing_expires_at_ms = unix_time_ms() + 10 * 60 * 1_000;
    let mut remote_command = Command::new(&runtime.node);
    remote_command
        .arg(&runtime.remote)
        .env("EDITKIN_REMOTE_TOKEN", &token)
        .env("EDITKIN_REMOTE_PORT", port.to_string())
        .env("EDITKIN_REMOTE_PARENT_PID", std::process::id().to_string())
        .env("EDITKIN_REMOTE_QUEUE", &queue_path)
        .env("EDITKIN_REMOTE_SNAPSHOT", &snapshot_path)
        .env("EDITKIN_REMOTE_DEVICES", &devices_path)
        .env("EDITKIN_REMOTE_TRUSTED_DEVICES", &trusted_devices_path)
        .env("EDITKIN_REMOTE_HEALTH_PROBE_ID", &health_probe_id)
        .env(
            "EDITKIN_REMOTE_ALLOWED_HOSTS",
            remote_allowed_hosts(public_tunnel_origin.as_deref()),
        )
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(0x08000000);
    if let Some((identity, _, websocket_url)) = relay.as_ref() {
        remote_command
            .env("EDITKIN_REMOTE_RELAY_WS_URL", websocket_url)
            .env("EDITKIN_REMOTE_RELAY_ROOM", &identity.room)
            .env("EDITKIN_REMOTE_RELAY_SECRET", &identity.secret);
    }
    let child = remote_command
        .spawn()
        .map_err(|error| format!("無法啟動手機遙控服務：{error}"))?;
    let started_at_ms = unix_time_ms();
    let mut pending_remote = PendingMobileRemote {
        child: Some(child),
        runtime_receipt_path: runtime_receipt_path.clone(),
        runtime_instance_id: runtime_instance_id.clone(),
    };
    let mut ready = false;
    for _ in 0..40 {
        if pending_remote
            .child_mut()
            .try_wait()
            .map_err(|error| error.to_string())?
            .is_some()
        {
            break;
        }
        if TcpStream::connect(("127.0.0.1", port)).is_ok() {
            ready = true;
            break;
        }
        thread::sleep(Duration::from_millis(50));
    }
    if !ready {
        return Err("手機遙控服務未能在 2 秒內啟動".into());
    }
    let lan_url = format!("http://{}:{port}/#token={token}", lan_ipv4());
    let mut transport = "lan".to_string();
    let warning = stable_port_warning;
    let url = if let Some((_, public, _)) = relay {
        transport = "cloud-relay".into();
        format!("{public}/#token={token}")
    } else if let Some(public) = public_tunnel_origin {
        transport = "https-tunnel".into();
        format!("{public}/#token={token}")
    } else {
        lan_url.clone()
    };
    let process_id = pending_remote.child_mut().id();
    write_remote_json_atomic(
        &runtime_receipt_path,
        &json!({
            "schema": "editkin.remote-runtime/v3",
            "transport": transport.as_str(),
            "configurationId": runtime_configuration_id.as_deref(),
            "probeId": health_probe_id.as_str(),
            "runtimeInstanceId": runtime_instance_id.as_str(),
            "processId": process_id,
            "startedAtMs": started_at_ms
        }),
    )?;
    Clipboard::new()
        .and_then(|mut clipboard| clipboard.set_text(url.clone()))
        .map_err(|error| error.to_string())?;
    let child = pending_remote.commit();
    *remote_state = Some(MobileRemote {
        child,
        url: url.clone(),
        token: token.clone(),
        transport: transport.clone(),
        warning: warning.clone(),
        queue_path,
        snapshot_path,
        devices_path,
        trusted_devices_path,
        pairing_expires_at_ms,
        runtime_receipt_path,
        runtime_instance_id,
        probe_id: health_probe_id,
        started_at_ms,
    });
    Ok(
        json!({ "active": true, "url": url, "token": token, "copied": true, "transport": transport, "warning": warning }),
    )
}

#[tauri::command]
fn update_mobile_snapshot(state: State<'_, AppState>, snapshot: Value) -> Result<(), String> {
    let remote = state
        .mobile_remote
        .lock()
        .map_err(|_| "mobile remote lock poisoned")?;
    if let Some(remote) = remote.as_ref() {
        write_json_atomic(&remote.snapshot_path, &snapshot)?;
    }
    Ok(())
}

fn drain_remote_commands(queue_path: &Path) -> Result<Vec<Value>, String> {
    if !queue_path.exists() {
        return Ok(Vec::new());
    }
    let mut entries = fs::read_dir(queue_path)
        .map_err(|error| error.to_string())?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|value| value.to_str()) == Some("json"))
        .collect::<Vec<_>>();
    entries.sort();
    let mut commands = Vec::with_capacity(entries.len());
    for (index, path) in entries.into_iter().enumerate() {
        let drain = path.with_extension(format!("drain-{}-{index}", std::process::id()));
        if fs::rename(&path, &drain).is_err() {
            continue;
        }
        let content = fs::read_to_string(&drain).map_err(|error| error.to_string())?;
        let command = serde_json::from_str(content.trim()).map_err(|error| error.to_string())?;
        fs::remove_file(&drain).map_err(|error| error.to_string())?;
        commands.push(command);
    }
    Ok(commands)
}

#[tauri::command]
fn poll_mobile_commands(state: State<'_, AppState>) -> Result<Vec<Value>, String> {
    let remote = state
        .mobile_remote
        .lock()
        .map_err(|_| "mobile remote lock poisoned")?;
    let Some(remote) = remote.as_ref() else {
        return Ok(Vec::new());
    };
    drain_remote_commands(&remote.queue_path)
}

#[tauri::command]
fn get_mobile_remote_status(state: State<'_, AppState>) -> Result<Value, String> {
    let mut remote = state
        .mobile_remote
        .lock()
        .map_err(|_| "mobile remote lock poisoned")?;
    if remote.is_none() {
        return Ok(json!({ "active": false, "connectedCount": 0, "devices": [] }));
    }
    let child_status = remote
        .as_mut()
        .expect("Remote state exists")
        .child
        .try_wait();
    match child_status {
        Ok(None) => {}
        Ok(Some(_)) => {
            remote.take();
            return Ok(json!({ "active": false, "connectedCount": 0, "devices": [] }));
        }
        Err(error) => {
            remote.take();
            return Err(format!(
                "無法查詢手機遙控服務；已停止該 process 並清除 runtime receipt：{error}"
            ));
        }
    }
    let active = remote.as_mut().expect("live Remote state exists");
    let mut status: Value = fs::read_to_string(&active.devices_path)
        .ok()
        .and_then(|content| serde_json::from_str(&content).ok())
        .unwrap_or_else(|| json!({ "connectedCount": 0, "devices": [] }));
    if let Some(object) = status.as_object_mut() {
        object.insert("active".into(), Value::Bool(true));
        object.insert("url".into(), Value::String(active.url.clone()));
        object.insert("transport".into(), Value::String(active.transport.clone()));
        if let Some(warning) = active.warning.as_ref() {
            object.insert("warning".into(), Value::String(warning.clone()));
        }
    }
    Ok(status)
}

/// Credential hashes of revoked devices, written only by the desktop. The Remote
/// server (`src/remote/server.ts`) also rewrites the trusted-device file, and a
/// write it based on a read taken just before a revoke can land just after it
/// and list the device again; the server refuses every credential listed here.
fn mobile_revoked_devices_path(trusted_devices_path: &Path) -> PathBuf {
    trusted_devices_path.with_file_name("revoked-devices.json")
}

const MOBILE_REVOKED_CREDENTIAL_LIMIT: usize = 256;

fn revoke_trusted_device(trusted_path: &Path, device_id: &str) -> Result<bool, String> {
    let mut store = fs::read_to_string(trusted_path)
        .ok()
        .and_then(|content| serde_json::from_str::<Value>(&content).ok())
        .unwrap_or_else(|| json!({ "schemaVersion": 1, "devices": [] }));
    let devices = store
        .get_mut("devices")
        .and_then(Value::as_array_mut)
        .ok_or("永久綁定裝置資料格式不正確")?;
    let before = devices.len();
    let mut credential_hashes = Vec::new();
    devices.retain(|device| {
        if device.get("id").and_then(Value::as_str) != Some(device_id) {
            return true;
        }
        if let Some(hash) = device
            .get("credentialHash")
            .and_then(Value::as_str)
            .filter(|hash| {
                hash.len() == 64
                    && hash
                        .bytes()
                        .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
            })
        {
            credential_hashes.push(hash.to_owned());
        }
        false
    });
    let revoked = devices.len() != before;
    if !credential_hashes.is_empty() {
        let revoked_path = mobile_revoked_devices_path(trusted_path);
        // An unreadable list is replaced so that this revoke still takes effect.
        let mut listed: Vec<String> = read_remote_json(&revoked_path)
            .ok()
            .flatten()
            .and_then(|value| {
                value
                    .get("credentialHashes")
                    .and_then(Value::as_array)
                    .map(|hashes| {
                        hashes
                            .iter()
                            .filter_map(Value::as_str)
                            .map(str::to_owned)
                            .collect()
                    })
            })
            .unwrap_or_default();
        listed.retain(|hash| !credential_hashes.contains(hash));
        listed.extend(credential_hashes);
        let excess = listed.len().saturating_sub(MOBILE_REVOKED_CREDENTIAL_LIMIT);
        listed.drain(..excess);
        // Listed before the trusted file changes, so the device is refused from here on.
        write_remote_json_atomic(
            &revoked_path,
            &json!({ "schemaVersion": 1, "credentialHashes": listed }),
        )?;
    }
    write_json_atomic(trusted_path, &store)?;
    Ok(revoked)
}

#[tauri::command]
fn revoke_mobile_device(
    app: AppHandle,
    state: State<'_, AppState>,
    device_id: String,
) -> Result<Value, String> {
    let device_id = device_id.trim();
    if device_id.is_empty() || device_id.len() > 100 {
        return Err("裝置識別碼不合法".into());
    }
    // Held until the revoke is written, so two revokes cannot drop each other's
    // entry from the revocation list.
    let remote_state = state
        .mobile_remote
        .lock()
        .map_err(|_| "mobile remote lock poisoned")?;
    let trusted_path = remote_state
        .as_ref()
        .map(|remote| remote.trusted_devices_path.clone())
        .unwrap_or(mobile_trusted_devices_path(&app)?);
    let revoked = revoke_trusted_device(&trusted_path, device_id)?;
    Ok(json!({ "revoked": revoked, "deviceId": device_id }))
}

#[tauri::command]
fn stop_mobile_remote(app: AppHandle, state: State<'_, AppState>) -> Result<Value, String> {
    let mut remote = state
        .mobile_remote
        .lock()
        .map_err(|_| "mobile remote lock poisoned")?;
    if remote.take().is_some() {
        let _ = fs::remove_file(user_remote_runtime_path(&app)?);
        return Ok(json!({ "active": false, "stopped": true }));
    }
    Ok(json!({ "active": false, "stopped": false }))
}

fn start_update_job(
    app: &AppHandle,
    state: &AppState,
    should_download: bool,
) -> Result<Value, String> {
    if !cfg!(windows) {
        return Ok(json!({
            "status": "unconfigured",
            "message": "macOS 自動更新會在 Developer ID 簽署與 Apple 公證頻道啟用後開放；目前不會執行 Windows installer。"
        }));
    }
    let environment_manifest_url = env::var("EDITKIN_UPDATE_MANIFEST_URL")
        .or_else(|_| env::var("HAO_EDITOR_UPDATE_MANIFEST_URL"))
        .ok();
    let pin = parse_update_publisher_pin(UPDATE_PUBLISHER_PIN)?;
    let Some(manifest_url) =
        select_update_manifest_url(cfg!(debug_assertions), environment_manifest_url, pin.as_ref())
    else {
        return Ok(
            json!({ "status": "unconfigured", "message": "更新頻道尚未設定；HTTPS／SHA-256／rollback 引擎已啟用。" }),
        );
    };
    let update_root = application_cache_root(app)?.join("updates");
    let runtime = runtime_paths(app)?;
    if state.update_job_running.swap(true, Ordering::AcqRel) {
        return Ok(json!({
            "status": if should_download { "downloading" } else { "checking" },
            "message": "更新作業已在背景執行。"
        }));
    }
    *state
        .update_job_result
        .lock()
        .map_err(|_| "update result lock poisoned")? = None;
    let app_for_job = app.clone();
    let services = state.services.clone();
    thread::spawn(move || {
        let service_result = service_request(
            &services,
            &runtime,
            if should_download {
                "stage_update"
            } else {
                "check_update"
            },
            json!({
                "manifestUrl": manifest_url,
                "currentVersion": env!("CARGO_PKG_VERSION"),
                "cacheRoot": update_root
            }),
        );
        let app_state = app_for_job.state::<AppState>();
        let result = match service_result {
            Ok(value) if value.is_null() => {
                if should_download {
                    if let Ok(mut pending) = app_state.pending_update.lock() {
                        *pending = None;
                    }
                }
                json!({ "status": "current", "message": "目前已是最新版。" })
            }
            Ok(value) => match string_field(&value, "version").map(str::to_string) {
                Ok(version) if should_download => {
                    let cache_hit = value
                        .get("cacheHit")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    if let Ok(mut pending) = app_state.pending_update.lock() {
                        *pending = Some(value);
                    }
                    json!({
                        "status": "ready",
                        "version": version,
                        "cacheHit": cache_hit,
                        "message": format!("版本 {version} 已下載並通過 SHA-256。")
                    })
                }
                Ok(version) => json!({
                    "status": "available",
                    "version": version,
                    "message": format!("有新版本 {version}；尚未下載。")
                }),
                Err(error) => json!({ "status": "error", "message": error }),
            },
            Err(error) => json!({ "status": "error", "message": error }),
        };
        if let Ok(mut slot) = app_state.update_job_result.lock() {
            *slot = Some(result);
        }
        app_state.update_job_running.store(false, Ordering::Release);
    });
    Ok(json!({
        "status": if should_download { "downloading" } else { "checking" },
        "message": if should_download { "正在背景下載並驗證更新。" } else { "正在背景查詢更新。" }
    }))
}

#[tauri::command]
fn check_update_available(app: AppHandle, state: State<'_, AppState>) -> Result<Value, String> {
    start_update_job(&app, &state, false)
}

#[tauri::command]
fn check_for_updates(
    app: AppHandle,
    state: State<'_, AppState>,
    download: Option<bool>,
) -> Result<Value, String> {
    start_update_job(&app, &state, download.unwrap_or(true))
}

#[tauri::command]
fn get_update_job_result(state: State<'_, AppState>) -> Result<Value, String> {
    if let Some(result) = state
        .update_job_result
        .lock()
        .map_err(|_| "update result lock poisoned")?
        .clone()
    {
        return Ok(result);
    }
    Ok(json!({ "status": "checking", "message": "更新作業仍在背景執行。" }))
}

#[tauri::command]
fn install_update(app: AppHandle, state: State<'_, AppState>, ui_locale: Option<String>) -> Result<Value, String> {
    if !cfg!(windows) {
        return Ok(json!({ "started": false, "message": "macOS 更新尚未接上已公證的發行頻道。" }));
    }
    let pending = state
        .pending_update
        .lock()
        .map_err(|_| "update state lock poisoned")?
        .clone();
    let Some(pending) = pending else {
        return Ok(json!({ "started": false, "message": "沒有已驗證、待安裝的更新。" }));
    };
    let artifact = string_field(&pending, "artifactPath")?;
    let sha256 = string_field(&pending, "sha256")?;
    let size = pending
        .get("size")
        .and_then(Value::as_u64)
        .ok_or("缺少欄位：size")?;
    let publisher = parse_update_publisher_pin(UPDATE_PUBLISHER_PIN)?;
    let editkin_override = env::var("EDITKIN_ALLOW_UNSIGNED_UPDATES").ok();
    let legacy_override = env::var("HAO_EDITOR_ALLOW_UNSIGNED_UPDATES").ok();
    if publisher.is_none()
        && !unsigned_update_override_allowed(
            cfg!(debug_assertions),
            editkin_override.as_deref(),
            legacy_override.as_deref(),
        )
    {
        return Ok(
            json!({ "started": false, "message": "此版本沒有內建釘選的發布者 Authenticode 身分，release 模式拒絕執行 installer。" }),
        );
    }
    let update_root = application_cache_root(&app)?.join("updates");
    verify_staged_installer(&update_root, artifact, size, sha256)?;
    // The expected signer is the compiled-in publisher, never the values the manifest advertised.
    if let Some(publisher) = &publisher {
        verify_authenticode(
            artifact,
            &publisher.signature_subject,
            &publisher.signature_sha256,
        )?;
    }
    let confirmed = MessageDialog::new()
        .set_level(MessageLevel::Info)
        .set_title(native_dialog_labels::text(ui_locale.as_deref(), DialogText::UpdateTitle))
        .set_description(native_dialog_labels::update_confirmation(ui_locale.as_deref(), string_field(&pending, "version")?))
        .set_buttons(MessageButtons::YesNo)
        .show();
    if confirmed != MessageDialogResult::Yes {
        return Ok(json!({ "started": false, "message": "已取消更新。" }));
    }
    let transaction_path = update_transaction_path(&app)?;
    let previous_transaction = read_update_transaction(&transaction_path)?;
    let previous_installer = previous_transaction
        .as_ref()
        .filter(|transaction| {
            transaction.get("status").and_then(Value::as_str) == Some("healthy")
                && transaction.get("toVersion").and_then(Value::as_str)
                    == Some(env!("CARGO_PKG_VERSION"))
        })
        .and_then(|transaction| transaction.get("stagedArtifact").and_then(Value::as_str));
    let mut transaction = json!({
        "schemaVersion": 1,
        "status": "staged",
        "fromVersion": env!("CARGO_PKG_VERSION"),
        "toVersion": string_field(&pending, "version")?,
        "stagedArtifact": artifact,
        "createdAt": SystemTime::now().duration_since(UNIX_EPOCH).map_err(|error| error.to_string())?.as_secs().to_string(),
        "launchAttempts": 0
    });
    // Only development builds may name a previous installer through the environment.
    let previous_override = env::var("EDITKIN_PREVIOUS_INSTALLER")
        .ok()
        .filter(|_| cfg!(debug_assertions));
    if let Some(previous) = previous_override.as_deref().or(previous_installer) {
        transaction["previousInstaller"] = json!(previous);
    }
    write_update_transaction(&transaction_path, &transaction)?;
    // Recheck the same staged bytes after the confirmation and the transaction write,
    // immediately before executing that exact installer path.
    verify_staged_installer(&update_root, artifact, size, sha256)?;
    spawn_installer(Path::new(artifact))?;
    let exit_handle = app.clone();
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(250));
        exit_handle.exit(0);
    });
    Ok(json!({ "started": true, "message": "更新 installer 已啟動。" }))
}

#[tauri::command]
fn smoke_ready(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    if state.update_health_pending.swap(false, Ordering::SeqCst) {
        let path = update_transaction_path(&app)?;
        if let Some(mut transaction) = read_update_transaction(&path)? {
            if transaction.get("toVersion").and_then(Value::as_str)
                == Some(env!("CARGO_PKG_VERSION"))
                && transaction.get("status").and_then(Value::as_str) == Some("applying")
            {
                transaction["status"] = json!("healthy");
                write_update_transaction(&path, &transaction)?;
            }
        }
    }
    if env::var("EDITKIN_SMOKE").as_deref() == Ok("1") {
        app.exit(0);
    }
    Ok(())
}

fn run_gpu_compositor(runtime: &RuntimePaths, args: &[&Path]) -> Result<Value, String> {
    if !runtime.gpu_compositor.is_file() {
        return Err(format!(
            "找不到原生 GPU compositor：{}",
            runtime.gpu_compositor.display()
        ));
    }
    let mut command = Command::new(&runtime.gpu_compositor);
    for argument in args {
        command.arg(argument);
    }
    let output = command
        .creation_flags(0x08000000)
        .output()
        .map_err(|error| format!("無法啟動原生 GPU compositor：{error}"))?;
    if !output.status.success() {
        return Err(format!(
            "原生 GPU compositor 失敗：{}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("GPU compositor receipt 無效：{error}"))
}

struct ValidatedNativeAudioStage {
    manifest_path: PathBuf,
    manifest_sha256: String,
    timeline_start: f64,
    managed_paths: Vec<PathBuf>,
    session_root: PathBuf,
}

fn validate_native_audio_stage(
    runtime: &RuntimePaths,
    stage: &Value,
) -> Result<ValidatedNativeAudioStage, String> {
    if stage.get("schema").and_then(Value::as_str) != Some("editkin.native-audio-preview-stage/v2")
        || stage.get("status").and_then(Value::as_str) != Some("GREEN")
        || stage.get("sampleRate").and_then(Value::as_u64) != Some(48_000)
        || stage.get("channels").and_then(Value::as_u64) != Some(2)
        || stage.get("decoderExecutor").and_then(Value::as_str) != Some("ffmpeg-source-decode/v1")
        || stage.get("decodeMode").and_then(Value::as_str) != Some("independent-source-pcm")
        || stage.get("mixExecutor").and_then(Value::as_str) != Some("hao-core-native-dag/v1")
        || stage.get("nativeGraphExecution").and_then(Value::as_bool) != Some(true)
    {
        return Err("原生音訊預覽 stage receipt 不完整".into());
    }
    let preview_root = fs::canonicalize(runtime.cache_root.join("audio-preview"))
        .map(process_compatible_path)
        .map_err(|error| format!("無法解析原生音訊預覽 cache：{error}"))?;
    let raw_session_root = stage
        .get("sessionRoot")
        .and_then(Value::as_str)
        .ok_or("原生音訊預覽 stage 缺少 sessionRoot")?;
    let session_root = fs::canonicalize(raw_session_root)
        .map(process_compatible_path)
        .map_err(|error| format!("無法解析原生音訊預覽 session：{error}"))?;
    if session_root.parent() != Some(preview_root.as_path()) || !session_root.is_dir() {
        return Err("原生音訊預覽 session 不是受管理 cache 的直接子目錄".into());
    }
    let raw_manifest = stage
        .get("manifestPath")
        .and_then(Value::as_str)
        .ok_or("原生音訊預覽 stage 缺少 manifestPath")?;
    let manifest_path = fs::canonicalize(raw_manifest)
        .map(process_compatible_path)
        .map_err(|error| format!("無法解析原生音訊預覽 manifest：{error}"))?;
    if manifest_path.parent() != Some(session_root.as_path()) || !manifest_path.is_file() {
        return Err("原生音訊預覽 manifest 不在受管理 session 內".into());
    }
    let manifest_bytes = stage
        .get("manifestBytes")
        .and_then(Value::as_u64)
        .ok_or("原生音訊預覽 stage 缺少 manifestBytes")?;
    if manifest_bytes == 0
        || manifest_bytes > 1_048_576
        || fs::metadata(&manifest_path)
            .map_err(|error| error.to_string())?
            .len()
            != manifest_bytes
    {
        return Err("原生音訊預覽 manifest bytes 與 receipt 不一致".into());
    }
    let manifest_sha256 = stage
        .get("manifestSha256")
        .and_then(Value::as_str)
        .filter(|value| value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .ok_or("原生音訊預覽 manifest SHA-256 不合法")?
        .to_ascii_lowercase();
    let managed_values = stage
        .get("managedPaths")
        .and_then(Value::as_array)
        .ok_or("原生音訊預覽 stage 缺少 managedPaths")?;
    if managed_values.len() < 2 || managed_values.len() > 9 {
        return Err("原生音訊預覽 managed path 數量超出界線".into());
    }
    let mut managed_set = BTreeSet::new();
    let mut managed_paths = Vec::with_capacity(managed_values.len());
    for value in managed_values {
        let raw_path = value.as_str().ok_or("原生音訊預覽 managed path 不是字串")?;
        let path = fs::canonicalize(raw_path)
            .map(process_compatible_path)
            .map_err(|error| format!("無法解析原生音訊 managed file：{error}"))?;
        if path.parent() != Some(session_root.as_path())
            || !path.is_file()
            || !managed_set.insert(path.clone())
        {
            return Err("原生音訊 managed file 越界、重複或不是檔案".into());
        }
        managed_paths.push(path);
    }
    if !managed_set.contains(&manifest_path) {
        return Err("原生音訊 manifest 未列入 managedPaths".into());
    }
    let source_pcm = stage
        .get("sourcePcm")
        .and_then(Value::as_array)
        .ok_or("原生音訊 stage 缺少 sourcePcm")?;
    if source_pcm.is_empty() || source_pcm.len() + 1 != managed_paths.len() {
        return Err("原生音訊 sourcePcm 與 managedPaths 數量不一致".into());
    }
    let mut source_paths = BTreeSet::new();
    for source in source_pcm {
        let raw_path = source
            .get("path")
            .and_then(Value::as_str)
            .ok_or("原生音訊 sourcePcm 缺少 path")?;
        let path = fs::canonicalize(raw_path)
            .map(process_compatible_path)
            .map_err(|error| format!("無法解析原生音訊 source PCM：{error}"))?;
        let bytes = source
            .get("bytes")
            .and_then(Value::as_u64)
            .ok_or("原生音訊 sourcePcm 缺少 bytes")?;
        let hash_valid = source
            .get("sha256")
            .and_then(Value::as_str)
            .is_some_and(|value| {
                value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
            });
        if !managed_set.contains(&path)
            || path == manifest_path
            || !source_paths.insert(path.clone())
            || bytes == 0
            || bytes > 48_000_u64 * 2 * 4 * 30
            || bytes % 8 != 0
            || fs::metadata(&path)
                .map_err(|error| error.to_string())?
                .len()
                != bytes
            || !hash_valid
        {
            return Err("原生音訊 sourcePcm identity 或 bytes 不一致".into());
        }
    }
    let directory_entries = fs::read_dir(&session_root)
        .map_err(|error| format!("無法盤點原生音訊 session：{error}"))?
        .map(|entry| {
            entry
                .map_err(|error| error.to_string())
                .and_then(|entry| fs::canonicalize(entry.path()).map_err(|error| error.to_string()))
                .map(process_compatible_path)
        })
        .collect::<Result<BTreeSet<_>, _>>()?;
    if directory_entries != managed_set {
        return Err("原生音訊 session 含未申報或缺少的檔案".into());
    }
    let timeline_start = stage
        .get("timelineStartSeconds")
        .and_then(Value::as_f64)
        .ok_or("原生音訊預覽 stage 缺少 timelineStartSeconds")?;
    if !timeline_start.is_finite() || timeline_start < 0.0 {
        return Err("原生音訊預覽 timeline start 不合法".into());
    }
    Ok(ValidatedNativeAudioStage {
        manifest_path,
        manifest_sha256,
        timeline_start,
        managed_paths,
        session_root,
    })
}

fn remove_native_audio_stage(runtime: &RuntimePaths, stage: &Value) {
    if let Ok(validated) = validate_native_audio_stage(runtime, stage) {
        for path in validated.managed_paths.iter().rev() {
            let _ = fs::remove_file(path);
        }
        let _ = fs::remove_dir(validated.session_root);
    }
}

fn public_native_audio_stage(stage: &Value) -> Value {
    let mut public = stage.clone();
    if let Some(object) = public.as_object_mut() {
        object.remove("manifestPath");
        object.remove("sessionRoot");
        object.remove("managedPaths");
        if let Some(sources) = object.get_mut("sourcePcm").and_then(Value::as_array_mut) {
            for source in sources {
                if let Some(source) = source.as_object_mut() {
                    source.remove("path");
                }
            }
        }
    }
    public
}

fn validate_native_mix_event(event: &Value, manifest_sha256: &str) -> Result<(), String> {
    let mix = event
        .get("nativeMix")
        .ok_or("hao-core 原生音訊事件缺少 nativeMix receipt")?;
    if mix.get("schema").and_then(Value::as_str)
        != Some("editkin.native-audio-preview-mix-receipt/v1")
        || mix.get("status").and_then(Value::as_str) != Some("GREEN")
        || mix.get("decoderExecutor").and_then(Value::as_str) != Some("ffmpeg-source-decode/v1")
        || mix.get("mixExecutor").and_then(Value::as_str) != Some("hao-core-native-dag/v1")
        || mix.get("nativeGraphExecution").and_then(Value::as_bool) != Some(true)
        || mix.get("manifestSha256").and_then(Value::as_str) != Some(manifest_sha256)
    {
        return Err("hao-core native mix receipt 與 staged manifest 不一致".into());
    }
    Ok(())
}

fn validate_native_audio_event_schema(event: &Value) -> Result<(), String> {
    let schema = event.get("schema").and_then(Value::as_str);
    let kind = event.get("event").and_then(Value::as_str);
    if matches!(
        (schema, kind),
        (
            Some("editkin.native-audio-preview-event/v1"),
            Some("progress" | "recovering" | "recovered")
        ) | (
            Some("editkin.native-audio-preview-receipt/v1"),
            Some("ended")
        )
    ) {
        Ok(())
    } else {
        Err("原生音訊預覽事件 schema 不受支援".into())
    }
}

fn start_native_audio_preview_process(
    runtime: &RuntimePaths,
    stage: Value,
    generation: u64,
    on_event: Option<tauri::ipc::Channel<Value>>,
) -> Result<NativeAudioPreviewProcess, String> {
    if !runtime.native_core.is_file() {
        return Err(format!(
            "找不到原生音訊 runtime：{}",
            runtime.native_core.display()
        ));
    }
    let validated = validate_native_audio_stage(runtime, &stage)?;
    let events = Arc::new(audio_preview_events::EventMailbox::with_timeline_window(
        validated.timeline_start,
        stage["durationSeconds"].as_f64().ok_or("原生音訊 stage 缺少時長")?,
    )?);
    let mut child = Command::new(&runtime.native_core)
        .arg("audio-preview-mix-play")
        .arg(&validated.manifest_path)
        .arg(format!("{:.9}", validated.timeline_start))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(0x08000000)
        .spawn()
        .map_err(|error| format!("無法啟動原生音訊預覽：{error}"))?;
    let Some(stdout) = child.stdout.take() else {
        let _ = child.kill();
        let _ = child.wait();
        return Err("原生音訊預覽沒有 stdout".into());
    };
    let Some(stderr) = child.stderr.take() else {
        let _ = child.kill();
        let _ = child.wait();
        return Err("原生音訊預覽沒有 stderr".into());
    };
    let stderr_text = Arc::new(Mutex::new(String::new()));
    let stderr_target = Arc::clone(&stderr_text);
    thread::spawn(move || {
        let mut reader = BufReader::new(stderr);
        let mut bytes = [0_u8; 4096];
        while let Ok(count) = reader.read(&mut bytes) {
            if count == 0 { break; }
            if let Ok(mut slot) = stderr_target.lock() {
                slot.push_str(&String::from_utf8_lossy(&bytes[..count]));
                let mut start = slot.len().saturating_sub(8192);
                while !slot.is_char_boundary(start) { start += 1; }
                if start > 0 { slot.drain(..start); }
            }
        }
    });
    let latest = events.clone();
    let manifest = validated.manifest_sha256.clone();
    let origin = validated.timeline_start;
    let (sender, responses) = mpsc::sync_channel(1);
    thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut first_sender = Some(sender);
        loop {
            let result = (|| -> Result<Option<Value>, String> {
                let Some(event) = audio_preview_events::read_event(&mut reader)? else {
                    if latest.snapshot()?.as_ref().is_some_and(|value| value["event"] == "ended") { return Ok(None); }
                    let detail = stderr_text.lock().ok().map(|value| value.clone()).unwrap_or_default();
                    return Err(if detail.trim().is_empty() { "原生音訊預覽事件流已關閉".into() } else { detail });
                };
                if first_sender.is_some() {
                    if event["schema"] != "editkin.native-audio-preview-event/v1" || event["event"] != "started"
                        || !event["timelineStartSeconds"].as_f64().is_some_and(|value| (value-origin).abs() <= 1e-6) {
                        return Err("原生音訊預覽沒有回傳一致的 started receipt".into());
                    }
                } else {
                    validate_native_audio_event_schema(&event)?;
                }
                validate_native_mix_event(&event, &manifest)?;
                latest.publish(event.clone())?;
                Ok(Some(event))
            })();
            match result {
                Ok(Some(event)) => {
                    if let Some(sender) = first_sender.take() { let _ = sender.send(Ok(event.clone())); }
                    if let Some(channel) = on_event.as_ref() {
                        let _ = channel.send(audio_preview_events::status_event(generation, &event));
                    }
                }
                Ok(None) => break,
                Err(error) => {
                    latest.fail(error.clone());
                    if let Some(sender) = first_sender.take() { let _ = sender.send(Err(error.clone())); }
                    if let Some(channel) = on_event.as_ref() {
                        let _ = channel.send(json!({"generation":generation,"active":false,"failed":true,"error":error}));
                    }
                    break;
                }
            }
        }
    });
    let first_event = match responses.recv_timeout(Duration::from_secs(10)) {
        Ok(Ok(event)) => event,
        Ok(Err(error)) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
        Err(mpsc::RecvTimeoutError::Timeout) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err("原生音訊預覽啟動逾時".into());
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err("原生音訊預覽啟動通道中斷".into());
        }
    };
    let first_result = (|| -> Result<Value, String> {
        let first = first_event;
        let started_timeline = first
            .get("timelineStartSeconds")
            .and_then(Value::as_f64)
            .ok_or("hao-core 原生音訊預覽 started receipt 缺少 timelineStartSeconds")?;
        if first.get("schema").and_then(Value::as_str)
            != Some("editkin.native-audio-preview-event/v1")
            || first.get("event").and_then(Value::as_str) != Some("started")
            || (started_timeline - validated.timeline_start).abs() > 1e-6
        {
            return Err("原生音訊預覽沒有回傳一致的 started receipt".into());
        }
        validate_native_mix_event(&first, &validated.manifest_sha256)?;
        Ok(first)
    })();
    let first = match first_result {
        Ok(first) => first,
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
    };
    Ok(NativeAudioPreviewProcess {
        child,
        events,
        generation,
        stage,
        last_event: first,
        managed_paths: validated.managed_paths,
        session_root: validated.session_root,
    })
}

fn refresh_native_audio_preview(process: &mut NativeAudioPreviewProcess) -> Result<(), String> {
    if let Some(event) = process.events.snapshot()? { process.last_event = event; }
    Ok(())
}

#[tauri::command]
async fn start_native_audio_preview(
    app: AppHandle,
    state: State<'_, AppState>,
    webview: tauri::Webview,
    project: Value,
    timeline_start_seconds: f64,
    on_event: Option<tauri::ipc::JavaScriptChannelId>,
) -> Result<Value, String> {
    if !timeline_start_seconds.is_finite() || timeline_start_seconds < 0.0 {
        return Err("原生音訊預覽起點不合法".into());
    }
    if state.resident_audio.is_active() {return Err("常駐音訊尚未關閉；拒絕重疊播放".into());}
    // Optional channels use the deserializable ID and the invoking WebView;
    // Option<Channel<_>> does not implement Tauri's CommandArg contract.
    let on_event = on_event.map(|id| id.channel_on(webview));
    let runtime = runtime_paths(&app)?;
    let (generation, previous) = {
        let mut slot = state.audio_preview.lock().map_err(|_| "原生音訊預覽 lock poisoned".to_string())?;
        (state.audio_preview_generation.fetch_add(1, Ordering::AcqRel) + 1, slot.take())
    };
    tauri::async_runtime::spawn_blocking(move || drop(previous)).await.map_err(|error| error.to_string())?;
    let stage = call_service(
        &app,
        "stage_native_audio_preview",
        json!({
            "project": project,
            "timelineStartSeconds": timeline_start_seconds,
            "maxDurationSeconds": 30,
        }),
    )
    .await?;
    if state.audio_preview_generation.load(Ordering::Acquire) != generation || state.resident_audio.is_active() {
        remove_native_audio_stage(&runtime, &stage);
        return Err("原生音訊預覽已被較新的播放要求取代".into());
    }
    let cleanup_runtime = runtime.clone();
    let cleanup_stage = stage.clone();
    let process_result = tauri::async_runtime::spawn_blocking(move || {
        start_native_audio_preview_process(&runtime, stage, generation, on_event)
    })
    .await
    .map_err(|error| error.to_string())?;
    let process = match process_result {
        Ok(process) => process,
        Err(error) => {
            remove_native_audio_stage(&cleanup_runtime, &cleanup_stage);
            return Err(error);
        }
    };
    let mut slot = state.audio_preview.lock().map_err(|_| "原生音訊預覽 lock poisoned".to_string())?;
    if state.audio_preview_generation.load(Ordering::Acquire) != generation || state.resident_audio.is_active() {
        drop(slot);
        tauri::async_runtime::spawn_blocking(move || drop(process));
        return Err("原生音訊預覽已被較新的播放要求取代".into());
    }
    let result = json!({
        "native": true,
        "generation": generation,
        "stage": public_native_audio_stage(&process.stage),
        "playback": process.last_event,
    });
    *slot = Some(process);
    Ok(result)
}

#[tauri::command]
async fn resident_audio_capabilities(app: AppHandle) -> Result<Value,String> {
    let core=runtime_paths(&app)?.native_core;
    app.state::<AppState>().resident_audio.capabilities(core)?.await
}
#[tauri::command]
async fn open_resident_audio(app: AppHandle, webview: tauri::Webview, on_event: tauri::ipc::JavaScriptChannelId) -> Result<Value,String> {
    let runtime=runtime_paths(&app)?;
    let channel=on_event.channel_on(webview);
    let retirement_app=app.clone();
    let ticket=app.state::<AppState>().resident_audio.open(audio_session_desktop::Runtime{
        core:runtime.native_core,decoder:runtime.ffmpeg,plans:runtime.cache_root.join("audio-sessions")},
        Box::new(move|value|channel.send(value).map_err(|e|e.to_string())),move||{
            // Admission is already reserved, so an in-flight legacy start
            // cannot install a process between retirement and resident launch.
            let state=retirement_app.state::<AppState>();
            let previous={let mut slot=state.audio_preview.lock().map_err(|_|"Legacy audio lock poisoned")?;
                state.audio_preview_generation.fetch_add(1,Ordering::AcqRel);slot.take()};
            drop(previous);Ok(())
        })?;
    ticket.await
}
#[tauri::command]
async fn replace_resident_audio(app: AppHandle, owner_id:u64, project:Value, timeline_start_seconds:f64) -> Result<Value,String> {
    if !timeline_start_seconds.is_finite() || !(0.0..86400.0).contains(&timeline_start_seconds){return Err("音訊跳轉位置不合法".into());}
    let runtime=runtime_paths(&app)?;let services=app.state::<AppState>().services.clone();
    let submitted=project.clone();
    let ticket=app.state::<AppState>().resident_audio.replace(owner_id,project,move|generation|{
        service_request(&services,&runtime,"stage_native_audio_project",json!({"project":submitted,
            "timelineStartSeconds":timeline_start_seconds,"generation":generation}))
    })?;
    ticket.await
}
#[tauri::command]
async fn control_resident_audio(app: AppHandle, owner_id:u64, generation:u64, playing:bool) -> Result<Value,String> {
    app.state::<AppState>().resident_audio.control(owner_id,generation,playing)?.await
}
#[tauri::command]
async fn close_resident_audio(app: AppHandle, owner_id:u64) -> Result<Value,String> {
    app.state::<AppState>().resident_audio.close(owner_id)?.await
}

#[tauri::command]
async fn resident_audio_status(app: AppHandle, owner_id:u64) -> Result<Value,String> {
    app.state::<AppState>().resident_audio.status(owner_id)?.await
}

#[tauri::command]
fn native_audio_preview_status(state: State<'_, AppState>) -> Result<Value, String> {
    let mut slot = state
        .audio_preview
        .lock()
        .map_err(|_| "原生音訊預覽 lock poisoned".to_string())?;
    let Some(process) = slot.as_mut() else {
        return Ok(json!({ "active": false }));
    };
    if let Err(error) = refresh_native_audio_preview(process) {
        let stage = public_native_audio_stage(&process.stage);
        let playback = process.last_event.clone();
        *slot = None;
        return Ok(
            json!({ "active": false, "failed": true, "error": error, "stage": stage, "playback": playback }),
        );
    }
    let exited = process
        .child
        .try_wait()
        .map_err(|error| format!("無法查詢原生音訊預覽 process：{error}"))?
        .is_some();
    let ended = process.last_event.get("event").and_then(Value::as_str) == Some("ended");
    let result = json!({
        "generation": process.generation,
        "active": !exited && !ended,
        "stage": public_native_audio_stage(&process.stage),
        "playback": process.last_event,
    });
    if exited || ended {
        *slot = None;
    }
    Ok(result)
}

#[tauri::command]
async fn stop_native_audio_preview(app: AppHandle, expected_generation: Option<u64>) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
    let state = app.state::<AppState>();
    let mut slot = state
        .audio_preview
        .lock()
        .map_err(|_| "原生音訊預覽 lock poisoned".to_string())?;
    if expected_generation.is_some_and(|expected| state.audio_preview_generation.load(Ordering::Acquire) != expected) {
        return Ok(json!({"active":slot.is_some(),"stopped":false,"superseded":true}));
    }
    state.audio_preview_generation.fetch_add(1, Ordering::AcqRel);
    let snapshot = slot.as_ref().map(|process| {
        json!({ "stage": public_native_audio_stage(&process.stage), "playback": process.last_event })
    });
    let process = slot.take();
    drop(slot);
    drop(process);
    Ok(json!({ "active": false, "stopped": true, "previous": snapshot }))
    }).await.map_err(|error| error.to_string())?
}

fn start_resident_gpu(runtime: &RuntimePaths, cancel: Arc<AtomicBool>) -> Result<ResidentGpuProcess, String> {
    if !runtime.gpu_compositor.is_file() {
        return Err(format!(
            "找不到原生 GPU compositor：{}",
            runtime.gpu_compositor.display()
        ));
    }
    // Preserve inherited runtime settings without logging their values. The
    // platform API takes a full environment, not additions to an implicit one;
    // child_environment makes the inherited Windows block spawnable (#101).
    let environment = gpu_resident_process::child_environment(
        std::env::vars_os(),
        &[("EDITKIN_FONT_ROOT".into(), runtime.font_root.as_os_str().to_owned())],
    );
    ResidentGpuProcess::launch(&runtime.gpu_compositor, &["serve".into()], &environment, cancel)
}

fn resident_gpu_timeout(command: &str) -> Duration {
    match command {
        "surface_bind"
        | "surface_hide"
        | "surface_release"
        | "video_present_at"
        | "engine_video_present_frame" => Duration::from_secs(10),
        "video_open"
        | "video_decode_next"
        | "video_decode_at"
        | "video_stage_at"
        | "video_seek"
        | "video_release"
        | "engine_video_load"
        | "offscreen_bind"
        | "engine_video_verify_frame"
        | "engine_video_stage_frame"
        | "engine_video_release"
        | "recover_device" => Duration::from_secs(30),
        _ => Duration::from_secs(60),
    }
}

fn resident_gpu_request(
    process: &mut ResidentGpuProcess,
    command: &str,
    payload: Value,
) -> Result<Value, String> {
    process.request(command, payload, resident_gpu_timeout(command))
}

fn with_resident_gpu<T>(
    runtime: &RuntimePaths,
    state: &State<'_, AppState>,
    operation: impl FnOnce(&mut ResidentGpuProcess) -> Result<T, String>,
) -> Result<T, String> {
    let mut slot = state
        .gpu_engine
        .lock()
        .map_err(|_| "GPU engine lock poisoned".to_string())?;
    gpu_resident_process::with_ready_gpu(
        &mut slot,
        || start_resident_gpu(runtime, state.gpu_commands.cancellation_flag()),
        operation,
    )
}

// All device waits and graph/media preparation execute on one bounded FIFO
// worker. The WebView command dispatcher only submits and awaits its own reply.
async fn run_gpu_command(
    app: AppHandle,
    operation: impl FnOnce(AppHandle) -> Result<Value, String> + Send + 'static,
) -> Result<Value, String> {
    let worker_app = app.clone();
    let result = app.state::<AppState>().gpu_commands.submit(move || operation(worker_app))?;
    result.await
}

async fn run_gpu_preview_command(
    app: AppHandle,
    preview_owner: Option<String>,
    resource: Option<(String, gpu_preview_owner::PreviewResource)>,
    operation: impl FnOnce(AppHandle) -> Result<Value, String> + Send + 'static,
) -> Result<Value, String> {
    run_gpu_command(app, move |app| {
        app.state::<AppState>().gpu_preview_owners.lock().map_err(|_| "GPU preview owner lock poisoned")?
            .check(preview_owner.as_deref(), resource.as_ref().map(|(id,kind)|(id.as_str(),*kind)))?;
        // Manual graph/surface/frame work supersedes autonomous presentation.
        // This check is after owner validation: stale callers cannot stop a successor.
        if let Some(owner) = preview_owner.as_deref() { app.state::<AppState>().gpu_playback.stop(owner, None); }
        operation(app)
    }).await
}

fn cleanup_gpu_preview_owner(state: &AppState, owner: &gpu_preview_owner::PreviewOwner) -> Result<(), String> {
    state.gpu_playback.stop(&owner.token, None);
    let mut slot=state.gpu_engine.lock().map_err(|_| "GPU engine lock poisoned")?;
    gpu_preview_owner::cleanup_native(&mut slot, owner)?;
    drop(slot);
    let mut cache=state.gpu_preview_cache.lock().map_err(|_| "GPU preview cache lock poisoned")?;
    cache.retire_sessions(&[&owner.image, &owner.video, &owner.engine_video]);
    if cache.deferred_groups() > 0 {
        eprintln!("GPU preview cache: {} retired groups remain locked or changed; bounded retry on next allocation", cache.deferred_groups());
    }
    Ok(())
}

// Request files are consumed synchronously by the GPU loader. The lease also
// retires partially failed requests/unwinds; it never owns the referenced media.
fn with_gpu_preview_inputs(
    app: &AppHandle,
    inputs: &[&Value],
    operation: impl FnOnce(&[PathBuf]) -> Result<Value, String>,
) -> Result<Value, String> {
    struct InputLease<'a> { cache: &'a Mutex<gpu_preview_cache::PreviewCache>, id: u64 }
    impl Drop for InputLease<'_> {
        fn drop(&mut self) {
            if let Ok(mut cache) = self.cache.lock() { cache.retire_group(self.id); }
        }
    }
    let state = app.state::<AppState>();
    let bytes=inputs.iter().map(|value| serde_json::to_vec(value).map_err(|error| error.to_string())).collect::<Result<Vec<_>,_>>()?;
    let (id, paths)=state.gpu_preview_cache.lock().map_err(|_| "GPU preview cache lock poisoned")?
        .prepare_inputs(&application_cache_root(app)?, &bytes)?;
    let _lease=InputLease { cache: &state.gpu_preview_cache, id };
    operation(&paths)
}

fn gpu_preview_frame_path(app: &AppHandle, session: &str, kind: gpu_preview_cache::FrameKind) -> Result<PathBuf, String> {
    let state = app.state::<AppState>();
    let mut cache = state.gpu_preview_cache.lock().map_err(|_| "GPU preview cache lock poisoned")?;
    let path = cache.frame_path(&application_cache_root(app)?, session, kind)?;
    // One process-private, frames-only scope; never expose input graphs, media,
    // or the entire app cache, and never accumulate a grant per generation.
    app.asset_protocol_scope().allow_directory(cache.frame_scope()?, true).map_err(|error| error.to_string())?;
    Ok(path)
}

fn retire_gpu_session_cache(app: &AppHandle, session: &str, receipt: &Value) -> Result<(), String> {
    if receipt["sessionId"].as_str() != Some(session) || !receipt["released"].is_boolean() {
        return Err("GPU cache retirement requires an exact native release receipt".into());
    }
    app.state::<AppState>().gpu_preview_cache.lock().map_err(|_| "GPU preview cache lock poisoned")?
        .retire_sessions(&[session]);
    Ok(())
}

#[tauri::command]
async fn begin_gpu_preview_owner(app: AppHandle) -> Result<Value, String> {
    run_gpu_command(app,move|app| {
        let state=app.state::<AppState>();
        let owner=state.gpu_preview_owners.lock().map_err(|_| "GPU preview owner lock poisoned")?
            .begin(|old|cleanup_gpu_preview_owner(&state,old))?;
        Ok(owner.receipt())
    }).await
}

#[tauri::command]
async fn end_gpu_preview_owner(app: AppHandle, preview_owner: String) -> Result<Value, String> {
    run_gpu_command(app,move|app| {
        let state=app.state::<AppState>();
        let released=state.gpu_preview_owners.lock().map_err(|_| "GPU preview owner lock poisoned")?
            .end(&preview_owner,|old|cleanup_gpu_preview_owner(&state,old))?;
        Ok(json!({"released":released,"superseded":!released}))
    }).await
}

#[tauri::command]
async fn start_gpu_preview_playback(
    app: AppHandle,
    webview: tauri::Webview,
    preview_owner: String,
    session_id: String,
    start_frame: u64,
    end_frame: u64,
    audio_generation: Option<u64>,
    audio_owner_id: Option<u64>,
    on_event: Option<tauri::ipc::JavaScriptChannelId>,
) -> Result<Value, String> {
    let sink: Option<native_preview_playback::EventSink> = on_event.map(|id| {
        let channel=id.channel_on(webview);
        Arc::new(move |event|channel.send(event).is_ok()) as native_preview_playback::EventSink
    });
    let worker_app=app.clone();
    let ticket=app.state::<AppState>().gpu_commands.schedule(move || {
        let app=worker_app;
        let state=app.state::<AppState>();
        state.gpu_preview_owners.lock().map_err(|_|"GPU preview owner lock poisoned")?
            .check(Some(&preview_owner),Some((&session_id,gpu_preview_owner::PreviewResource::EngineVideo)))?;
        let audio:Option<Arc<dyn native_preview_playback::AudioClockSource>>=if let Some(owner)=audio_owner_id {
            let generation=audio_generation.ok_or("Resident audio owner requires a stream generation")?;
            let clock=state.resident_audio.clock(owner,generation)?;
            Some(native_preview_playback::sample_clock(move||{
                let (seconds,ended,age)=clock.sample()?;
                Ok(audio_preview_events::ClockSample{seconds,ended,age})
            }))
        } else if let Some(generation)=audio_generation {
            let slot=state.audio_preview.lock().map_err(|_|"Native audio slot poisoned")?;
            Some(slot.as_ref().filter(|process|process.generation==generation)
                .ok_or("Native audio generation does not match playback")?.events.clone())
        } else {None};
        let runtime=runtime_paths(&app)?;
        let lease=state.gpu_playback.start(&preview_owner,&session_id,start_frame,end_frame,audio,sink)?;
        let receipt=lease.start_receipt();
        drop(state);
        let work: gpu_command_worker::PeriodicOperation=Box::new(move || lease.tick(|frame,tolerance| {
            let state=app.state::<AppState>();
            state.gpu_preview_owners.lock().map_err(|_|"GPU preview owner lock poisoned")?
                .check(Some(&preview_owner),Some((&session_id,gpu_preview_owner::PreviewResource::EngineVideo)))?;
            with_resident_gpu(&runtime,&state,|process|resident_gpu_request(process,"engine_video_present_frame",
                json!({"sessionId":session_id,"timelineFrame":frame,"toleranceSeconds":tolerance})))
        }));
        Ok((receipt,work))
    })?;
    ticket.await
}

#[tauri::command]
fn stop_gpu_preview_playback(state: State<'_,AppState>, preview_owner: String, generation: u64) -> Value {
    json!({"stopped":state.gpu_playback.stop(&preview_owner,Some(generation))})
}

#[tauri::command]
fn acknowledge_gpu_preview_playback(state: State<'_,AppState>, preview_owner: String, generation: u64, sequence: u64) -> Result<Value,String> {
    state.gpu_playback.acknowledge(&preview_owner,generation,sequence).map(|accepted|json!({"acknowledged":accepted}))
}

#[tauri::command]
fn inspect_gpu_preview_playback(state: State<'_,AppState>, preview_owner: String, generation: u64, diagnostic: bool) -> Result<Value,String> {
    state.gpu_playback.snapshot(&preview_owner,generation,diagnostic)
}

#[tauri::command]
async fn gpu_compositor_status(app: AppHandle) -> Result<Value, String> {
    run_gpu_command(app, move |app| {
        let runtime = runtime_paths(&app)?;
        if !runtime.gpu_compositor.is_file() {
            return Ok(
                json!({ "available": false, "engine": "editkin-wgpu-compositor/v1", "path": runtime.gpu_compositor }),
            );
        }
        let receipt = run_gpu_compositor(&runtime, &[Path::new("probe")])?;
        Ok(json!({ "available": true, "path": runtime.gpu_compositor, "receipt": receipt }))
    }).await
}

#[tauri::command]
async fn gpu_engine_status(app: AppHandle) -> Result<Value, String> {
    run_gpu_command(app, move |app| {
        let state = app.state::<AppState>();
        let runtime = runtime_paths(&app)?;
        with_resident_gpu(&runtime, &state, |process| {
            let status = resident_gpu_request(process, "status", json!({}))?;
            Ok(json!({ "available": true, "ready": process.ready, "status": status }))
        })
    }).await
}

fn validate_gpu_session_id(session_id: &str) -> Result<(), String> {
    if session_id.trim().is_empty()
        || session_id.len() > 128
        || !session_id.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | ':' | '.')
        })
    {
        return Err("GPU preview sessionId 不合法".into());
    }
    Ok(())
}

#[tauri::command]
async fn load_gpu_preview_session(
    app: AppHandle,
    session_id: String,
    graph: Value,
    preview_owner: Option<String>,
) -> Result<Value, String> {
    run_gpu_preview_command(app, preview_owner, Some((session_id.clone(), gpu_preview_owner::PreviewResource::Image)), move |app| {
        let state = app.state::<AppState>();
        validate_gpu_session_id(&session_id)?;
        if graph.get("schema").and_then(Value::as_str) != Some("hao.gpu-render-graph/v1") {
            return Err("GPU render graph schema 不合法".into());
        }
        let runtime = runtime_paths(&app)?;
        with_gpu_preview_inputs(&app, &[&graph], |paths| {
            let graph_path = &paths[0];
            with_resident_gpu(&runtime, &state, |process| {
            resident_gpu_request(
                process,
                "load",
                json!({ "sessionId": session_id, "graphPath": graph_path }),
            )
            })
        })
    }).await
}

#[tauri::command]
async fn load_gpu_engine_preview_session(
    app: AppHandle,
    session_id: String,
    graph: Value,
    asset_bindings: Value,
    timeline_frame: u64,
    preview_owner: Option<String>,
) -> Result<Value, String> {
    run_gpu_preview_command(app, preview_owner, Some((session_id.clone(), gpu_preview_owner::PreviewResource::Image)), move |app| {
        let state = app.state::<AppState>();
        validate_gpu_session_id(&session_id)?;
        if graph.get("schema").and_then(Value::as_str) != Some("editkin.engine-graph/v1") {
            return Err("Common engine graph schema 不合法".into());
        }
        let nodes = graph
            .get("nodes")
            .and_then(Value::as_array)
            .ok_or("Common engine graph 缺少 nodes")?;
        if nodes.is_empty() || nodes.len() > 256 {
            return Err("Common engine graph node 數必須是 1..=256".into());
        }
        let bindings = asset_bindings
            .as_object()
            .ok_or("Common engine graph assetBindings 必須是 object")?;
        if bindings.len() > 64
            || bindings.values().any(|value| {
                value.as_str().is_none_or(|path| {
                    path.is_empty() || path.len() > 32_768 || !local_media_binding(path)
                })
            })
        {
            return Err("Common engine graph assetBindings 含無效媒體路徑".into());
        }
        let runtime = runtime_paths(&app)?;
        with_gpu_preview_inputs(&app, &[&graph, &asset_bindings], |paths| {
            let graph_path = &paths[0];
            let bindings_path = &paths[1];
            with_resident_gpu(&runtime, &state, |process| {
            resident_gpu_request(
                process,
                "engine_load",
                json!({
                    "sessionId": session_id,
                    "graphPath": graph_path,
                    "bindingsPath": bindings_path,
                    "timelineFrame": timeline_frame
                }),
            )
            })
        })
    }).await
}

#[tauri::command]
async fn update_gpu_engine_preview_frame(
    app: AppHandle,
    session_id: String,
    timeline_frame: u64,
    preview_owner: Option<String>,
) -> Result<Value, String> {
    run_gpu_preview_command(app, preview_owner, Some((session_id.clone(), gpu_preview_owner::PreviewResource::Image)), move |app| {
        let state = app.state::<AppState>();
        validate_gpu_session_id(&session_id)?;
        let runtime = runtime_paths(&app)?;
        with_resident_gpu(&runtime, &state, |process| {
            resident_gpu_request(
                process,
                "engine_update_frame",
                json!({ "sessionId": session_id, "timelineFrame": timeline_frame }),
            )
        })
    }).await
}

fn engine_video_binding_keys_match(
    nodes: &[Value],
    bindings: &serde_json::Map<String, Value>,
) -> bool {
    let required_assets = nodes
        .iter()
        .filter(|node| node.get("kind").and_then(Value::as_str) == Some("source"))
        .filter(|node| node.get("mediaKind").and_then(Value::as_str) == Some("video"))
        .filter_map(|node| node.get("assetId").and_then(Value::as_str))
        .collect::<BTreeSet<_>>();
    !required_assets.is_empty()
        && bindings.len() == required_assets.len()
        && bindings
            .keys()
            .all(|asset_id| required_assets.contains(asset_id.as_str()))
}

fn load_gpu_engine_video_preview_inner(app: AppHandle, session_id: String, graph: Value,
    asset_bindings: Value, timeline_frame: u64, offscreen: bool) -> Result<Value, String> {
    let state = app.state::<AppState>();
    validate_gpu_session_id(&session_id)?;
    if graph.get("schema").and_then(Value::as_str) != Some("editkin.engine-graph/v1") {
        return Err("Common video engine graph schema 不合法".into());
    }
    let nodes = graph
        .get("nodes")
        .and_then(Value::as_array)
        .ok_or("Common video engine graph 缺少 nodes")?;
    if nodes.is_empty() {
        return Err("Common video engine graph nodes 不得為空".into());
    }
    let bindings = asset_bindings
        .as_object()
        .ok_or("Common video engine graph assetBindings 必須是 object")?;
    if !engine_video_binding_keys_match(nodes, bindings)
        || bindings.values().any(|value| {
            value.as_str().is_none_or(|path| {
                path.is_empty() || path.len() > 32_768 || !local_media_binding(path)
            })
        })
    {
        return Err("Common video engine graph 必須精確綁定所有有效的本機影片檔".into());
    }
    let offscreen_size = if offscreen {
        Some(gpu_offscreen_preview::graph_size(&graph)?)
    } else { None };
    let runtime = runtime_paths(&app)?;
    let effect_bindings = service_request(
        &state.services,
        &runtime,
        "resolve_gpu_effect_bindings",
        json!({ "graph": graph.clone() }),
    )?;
    if effect_bindings.get("schema").and_then(Value::as_str)
        != Some("editkin.gpu-effect-bindings/v1")
        || effect_bindings
            .get("bindings")
            .and_then(Value::as_object)
            .is_none_or(|bindings| bindings.len() > 64)
    {
        return Err("GPU effect binding resolver 回傳不合法".into());
    }
    let receipt = with_gpu_preview_inputs(&app, &[&graph, &asset_bindings, &effect_bindings], |paths| {
        let graph_path = &paths[0];
        let bindings_path = &paths[1];
        let effect_bindings_path = &paths[2];
        with_resident_gpu(&runtime, &state, |process| {
        let bound_identity = if let Some((width, height)) = offscreen_size {
            let (selected_sha, selected_bytes, _) = bounded_file_sha256(&runtime.gpu_compositor, 512 * 1024 * 1024)?;
            gpu_offscreen_preview::validate_ready(&process.ready, &selected_sha, selected_bytes)?;
            let retired = resident_gpu_request(process, "engine_video_release", json!({"sessionId": session_id}))?;
            gpu_offscreen_preview::validate_release(&retired, &session_id)?;
            let released = resident_gpu_request(process, "surface_release", json!({}))?;
            if released.get("released").and_then(Value::as_bool).is_none() { return Err("Offscreen target cleanup receipt invalid".into()); }
            let target = resident_gpu_request(process, "offscreen_bind", json!({"width": width, "height": height}))?;
            gpu_offscreen_preview::validate_target(&target, process.ready.get("generation").and_then(Value::as_u64).ok_or("GPU generation missing")?,
                width, height, &selected_sha, selected_bytes)?;
            Some(target["videoTargetIdentity"].clone())
        } else { None };
        let loaded = resident_gpu_request(
            process,
            "engine_video_load",
            json!({
                "sessionId": session_id,
                "graphPath": graph_path,
                "bindingsPath": bindings_path,
                "effectBindingsPath": effect_bindings_path,
                "timelineFrame": timeline_frame
            }),
        )?;
        if bound_identity.as_ref().is_some_and(|identity| loaded.get("videoTargetIdentity") != Some(identity)) {
            return Err("Offscreen load changed actual target identity".into());
        }
        Ok(loaded)
        })
    })?;
    if !offscreen { state.gpu_playback.bind(native_preview_playback::GraphBinding::from_load(&session_id, &graph, &receipt)?)?; }
    if offscreen {
        let target = receipt.get("videoTargetIdentity").ok_or("Offscreen load target missing")?;
        let (width, height) = offscreen_size.ok_or("Offscreen dimensions missing")?;
        gpu_offscreen_preview::validate_identity(target, receipt.get("generation").and_then(Value::as_u64).ok_or("Offscreen generation missing")?, width, height)?;
    }
    Ok(receipt)
}

#[tauri::command]
async fn load_gpu_engine_video_preview_session(app: AppHandle, session_id: String, graph: Value,
    asset_bindings: Value, timeline_frame: u64, preview_owner: Option<String>) -> Result<Value, String> {
    run_gpu_preview_command(app, preview_owner, Some((session_id.clone(), gpu_preview_owner::PreviewResource::EngineVideo)), move |app| {
        load_gpu_engine_video_preview_inner(app, session_id, graph, asset_bindings, timeline_frame, false)
    }).await
}

#[tauri::command]
async fn load_gpu_engine_video_frame_preview_session(app: AppHandle, session_id: String, graph: Value,
    asset_bindings: Value, timeline_frame: u64, preview_owner: Option<String>) -> Result<Value, String> {
    if preview_owner.is_none() { return Err("Offscreen preview requires an owned generation".into()); }
    run_gpu_preview_command(app, preview_owner, Some((session_id.clone(), gpu_preview_owner::PreviewResource::EngineVideo)), move |app| {
        load_gpu_engine_video_preview_inner(app, session_id, graph, asset_bindings, timeline_frame, true)
    }).await
}

#[tauri::command]
async fn render_gpu_engine_video_preview_frame(app: AppHandle, session_id: String, timeline_frame: u64,
    tolerance_seconds: f64, preview_owner: Option<String>) -> Result<Value, String> {
    if preview_owner.is_none() { return Err("Offscreen preview requires an owned generation".into()); }
    run_gpu_preview_command(app, preview_owner, Some((session_id.clone(), gpu_preview_owner::PreviewResource::EngineVideo)), move |app| {
        validate_gpu_session_id(&session_id)?;
        if !tolerance_seconds.is_finite() || tolerance_seconds <= 0.0 || tolerance_seconds > 0.25 { return Err("Offscreen tolerance outside (0,.25]".into()); }
        let state = app.state::<AppState>();
        let runtime = runtime_paths(&app)?;
        let output_path = gpu_preview_frame_path(&app, &session_id, gpu_preview_cache::FrameKind::Video)?;
        let receipt = with_resident_gpu(&runtime, &state, |process| {
            resident_gpu_request(process, "engine_video_verify_frame", json!({"sessionId": session_id,
                "timelineFrame": timeline_frame, "toleranceSeconds": tolerance_seconds, "outputPath": output_path}))
        })?;
        let (width,height) = gpu_offscreen_preview::validate_frame(&receipt, &session_id, timeline_frame)?;
        // Copy this exact bounded generated PNG while still on the owner FIFO.
        // Mutable disk slots are never used as frontend image identity.
        let (bytes, sha) = gpu_offscreen_preview::read_png(&output_path, width, height)?;
        Ok(json!({"schema": "editkin.engine-video-png-preview/v1", "pngBytes": bytes, "pngSha256": sha, "receipt": receipt}))
    }).await
}

#[tauri::command]
async fn present_gpu_engine_video_preview_frame(
    app: AppHandle,
    session_id: String,
    timeline_frame: u64,
    tolerance_seconds: f64,
    preview_owner: Option<String>,
) -> Result<Value, String> {
    run_gpu_preview_command(app, preview_owner, Some((session_id.clone(), gpu_preview_owner::PreviewResource::EngineVideo)), move |app| {
        let state = app.state::<AppState>();
        validate_gpu_session_id(&session_id)?;
        if !tolerance_seconds.is_finite() || tolerance_seconds <= 0.0 || tolerance_seconds > 0.25 {
            return Err("Common video engine graph 同步容差必須介於 0 到 0.25 秒".into());
        }
        let runtime = runtime_paths(&app)?;
        let receipt = with_resident_gpu(&runtime, &state, |process| {
            resident_gpu_request(
                process,
                "engine_video_present_frame",
                json!({
                    "sessionId": session_id,
                    "timelineFrame": timeline_frame,
                    "toleranceSeconds": tolerance_seconds
                }),
            )
        })?;
        Ok(json!({
            "endOfStream": receipt.get("endOfStream").and_then(Value::as_bool) == Some(true),
            "receipt": receipt
        }))
    }).await
}

#[tauri::command]
async fn release_gpu_engine_video_preview_session(
    app: AppHandle,
    session_id: String,
    preview_owner: Option<String>,
) -> Result<Value, String> {
    run_gpu_preview_command(app, preview_owner, Some((session_id.clone(), gpu_preview_owner::PreviewResource::EngineVideo)), move |app| {
        let state = app.state::<AppState>();
        validate_gpu_session_id(&session_id)?;
        let runtime = runtime_paths(&app)?;
        let receipt = with_resident_gpu(&runtime, &state, |process| {
            resident_gpu_request(
                process,
                "engine_video_release",
                json!({ "sessionId": session_id }),
            )
        })?;
        gpu_offscreen_preview::validate_release(&receipt, &session_id)?;
        retire_gpu_session_cache(&app, &session_id, &receipt)?;
        Ok(receipt)
    }).await
}

#[tauri::command]
async fn update_gpu_preview_properties(
    app: AppHandle,
    session_id: String,
    params: Value,
    preview_owner: Option<String>,
) -> Result<Value, String> {
    run_gpu_preview_command(app, preview_owner, Some((session_id.clone(), gpu_preview_owner::PreviewResource::Image)), move |app| {
        let state = app.state::<AppState>();
        let runtime = runtime_paths(&app)?;
        let params = params
            .as_array()
            .ok_or("GPU property buffer 必須是 array")?;
        if params.is_empty() || params.len() > 64 {
            return Err("GPU property buffer layer 數必須是 1..=64".into());
        }
        with_resident_gpu(&runtime, &state, |process| {
            resident_gpu_request(
                process,
                "update_params",
                json!({ "sessionId": session_id, "params": params }),
            )
        })
    }).await
}

#[tauri::command]
async fn render_gpu_preview_frame(
    app: AppHandle,
    session_id: String,
    preview_owner: Option<String>,
) -> Result<Value, String> {
    run_gpu_preview_command(app, preview_owner, Some((session_id.clone(), gpu_preview_owner::PreviewResource::Image)), move |app| {
        let state = app.state::<AppState>();
        let runtime = runtime_paths(&app)?;
        let output_path = gpu_preview_frame_path(&app, &session_id, gpu_preview_cache::FrameKind::Image)?;
        let receipt = with_resident_gpu(&runtime, &state, |process| {
            resident_gpu_request(
                process,
                "render",
                json!({ "sessionId": session_id, "outputPath": output_path }),
            )
        })?;
        Ok(json!({ "outputPath": output_path, "receipt": receipt }))
    }).await
}

#[tauri::command]
async fn release_gpu_preview_session(
    app: AppHandle,
    session_id: String,
    preview_owner: Option<String>,
) -> Result<Value, String> {
    run_gpu_preview_command(app, preview_owner, Some((session_id.clone(), gpu_preview_owner::PreviewResource::Image)), move |app| {
        let state = app.state::<AppState>();
        let runtime = runtime_paths(&app)?;
        let receipt = with_resident_gpu(&runtime, &state, |process| {
            resident_gpu_request(process, "release", json!({ "sessionId": session_id }))
        })?;
        retire_gpu_session_cache(&app, &session_id, &receipt)?;
        Ok(receipt)
    }).await
}

#[tauri::command]
async fn open_gpu_video_preview_session(
    app: AppHandle,
    session_id: String,
    input_path: String,
    preview_owner: Option<String>,
) -> Result<Value, String> {
    run_gpu_preview_command(app, preview_owner, Some((session_id.clone(), gpu_preview_owner::PreviewResource::Video)), move |app| {
        let state = app.state::<AppState>();
        validate_gpu_session_id(&session_id)?;
        // The single-import check before the path is resolved or opened.
        media_source_path_check(&input_path)?;
        let input_path = fs::canonicalize(&input_path)
            .map_err(|error| format!("影片路徑不存在或無法讀取：{error}"))?;
        if !input_path.is_file() {
            return Err("GPU 影片預覽輸入必須是檔案".into());
        }
        let runtime = runtime_paths(&app)?;
        with_resident_gpu(&runtime, &state, |process| {
            resident_gpu_request(
                process,
                "video_open",
                json!({ "sessionId": session_id, "inputPath": input_path }),
            )
        })
    }).await
}

#[tauri::command]
async fn decode_gpu_video_preview_frame(
    app: AppHandle,
    session_id: String,
    preview_owner: Option<String>,
) -> Result<Value, String> {
    run_gpu_preview_command(app, preview_owner, Some((session_id.clone(), gpu_preview_owner::PreviewResource::Video)), move |app| {
        let state = app.state::<AppState>();
        validate_gpu_session_id(&session_id)?;
        let runtime = runtime_paths(&app)?;
        let output_path = gpu_preview_frame_path(&app, &session_id, gpu_preview_cache::FrameKind::Video)?;
        let receipt = with_resident_gpu(&runtime, &state, |process| {
            resident_gpu_request(
                process,
                "video_decode_next",
                json!({ "sessionId": session_id, "outputPath": output_path }),
            )
        })?;
        if receipt.get("endOfStream").and_then(Value::as_bool) == Some(true) {
            return Ok(json!({ "endOfStream": true, "receipt": receipt }));
        }
        Ok(json!({
            "endOfStream": false,
            "outputPath": output_path,
            "receipt": receipt
        }))
    }).await
}

#[tauri::command]
async fn decode_gpu_video_preview_at_time(
    app: AppHandle,
    session_id: String,
    time_seconds: f64,
    tolerance_seconds: f64,
    preview_owner: Option<String>,
) -> Result<Value, String> {
    run_gpu_preview_command(app, preview_owner, Some((session_id.clone(), gpu_preview_owner::PreviewResource::Video)), move |app| {
        let state = app.state::<AppState>();
        validate_gpu_session_id(&session_id)?;
        if !time_seconds.is_finite() || time_seconds < 0.0 {
            return Err("GPU 影片預覽主時鐘時間必須是有限的非負數".into());
        }
        if !tolerance_seconds.is_finite() || tolerance_seconds <= 0.0 || tolerance_seconds > 0.25 {
            return Err("GPU 影片預覽同步容差必須介於 0 到 0.25 秒".into());
        }
        let runtime = runtime_paths(&app)?;
        let output_path = gpu_preview_frame_path(&app, &session_id, gpu_preview_cache::FrameKind::Video)?;
        let receipt = with_resident_gpu(&runtime, &state, |process| {
            resident_gpu_request(
                process,
                "video_decode_at",
                json!({
                    "sessionId": session_id,
                    "timeSeconds": time_seconds,
                    "toleranceSeconds": tolerance_seconds,
                    "outputPath": output_path,
                }),
            )
        })?;
        if receipt.get("endOfStream").and_then(Value::as_bool) == Some(true) {
            return Ok(json!({ "endOfStream": true, "receipt": receipt }));
        }
        Ok(json!({
            "endOfStream": false,
            "outputPath": output_path,
            "receipt": receipt
        }))
    }).await
}

#[tauri::command]
async fn stage_gpu_video_preview_at_time(
    app: AppHandle,
    session_id: String,
    time_seconds: f64,
    tolerance_seconds: f64,
    preview_owner: Option<String>,
) -> Result<Value, String> {
    run_gpu_preview_command(app, preview_owner, Some((session_id.clone(), gpu_preview_owner::PreviewResource::Video)), move |app| {
        let state = app.state::<AppState>();
        validate_gpu_session_id(&session_id)?;
        if !time_seconds.is_finite() || time_seconds < 0.0 {
            return Err("GPU 影片 staging 主時鐘時間必須是有限的非負數".into());
        }
        if !tolerance_seconds.is_finite() || tolerance_seconds <= 0.0 || tolerance_seconds > 0.25 {
            return Err("GPU 影片 staging 同步容差必須介於 0 到 0.25 秒".into());
        }
        let runtime = runtime_paths(&app)?;
        let receipt = with_resident_gpu(&runtime, &state, |process| {
            resident_gpu_request(
                process,
                "video_stage_at",
                json!({
                    "sessionId": session_id,
                    "timeSeconds": time_seconds,
                    "toleranceSeconds": tolerance_seconds,
                }),
            )
        })?;
        Ok(json!({
            "endOfStream": receipt.get("endOfStream").and_then(Value::as_bool) == Some(true),
            "receipt": receipt
        }))
    }).await
}

fn validate_gpu_surface_bounds(x: f64, y: f64, width: f64, height: f64) -> Result<(), String> {
    if !x.is_finite() || !y.is_finite() || !width.is_finite() || !height.is_finite() {
        return Err("GPU 預覽表面座標必須是有限數字".into());
    }
    if width <= 0.0 || height <= 0.0 || width > 8192.0 || height > 8192.0 {
        return Err("GPU 預覽表面尺寸必須介於 0 到 8192 CSS 像素".into());
    }
    if x.abs() > 8192.0 || y.abs() > 8192.0 {
        return Err("GPU 預覽表面座標超出支援範圍".into());
    }
    Ok(())
}

#[cfg(windows)]
#[tauri::command]
async fn bind_gpu_preview_surface(
    app: AppHandle,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    surface_color_space: Option<String>,
    preview_owner: Option<String>,
) -> Result<Value, String> {
    run_gpu_preview_command(app, preview_owner, None, move |app| {
        let state = app.state::<AppState>();
        validate_gpu_surface_bounds(x, y, width, height)?;
        let surface_color_space = surface_color_space.unwrap_or_else(|| "srgb".into());
        if surface_color_space != "srgb" && surface_color_space != "rec2100_pq_1000" {
            return Err("GPU 預覽表面僅接受 srgb 或 rec2100_pq_1000 色彩傳輸".into());
        }
        let window = app
            .get_webview_window("main")
            .ok_or("找不到 Editkin 主視窗")?;
        let scale = window
            .scale_factor()
            .map_err(|error| format!("無法取得主視窗 DPI：{error}"))?;
        let client_origin = window
            .inner_position()
            .map_err(|error| format!("無法取得主視窗 client-area 位置：{error}"))?;
        // The compositor is a separate hardened process. Making its HWND an owned window of a
        // different process can synchronously wedge CreateWindowEx on Windows, so the host reports
        // the real client-area screen origin and the compositor creates a no-activate companion
        // swap chain at that absolute position. Frontend move/resize observers keep it aligned.
        let physical_x = client_origin.x as f64 + (x * scale).round();
        let physical_y = client_origin.y as f64 + (y * scale).round();
        let physical_width = (width * scale).round().max(1.0);
        let physical_height = (height * scale).round().max(1.0);
        if physical_x < i32::MIN as f64
            || physical_x > i32::MAX as f64
            || physical_y < i32::MIN as f64
            || physical_y > i32::MAX as f64
            || physical_width > u32::MAX as f64
            || physical_height > u32::MAX as f64
        {
            return Err("GPU 預覽表面實體座標溢位".into());
        }
        let runtime = runtime_paths(&app)?;
        let mut receipt = with_resident_gpu(&runtime, &state, |process| {
            resident_gpu_request(
                process,
                "surface_bind",
                json!({
                    "parentHwnd": "0",
                    "x": physical_x as i32,
                    "y": physical_y as i32,
                    "width": physical_width as u32,
                    "height": physical_height as u32,
                    "surfaceColorSpace": surface_color_space,
                }),
            )
        })?;
        if let Some(object) = receipt.as_object_mut() {
            object.insert("scaleFactor".into(), json!(scale));
            object.insert("hostMode".into(), json!("screen-aligned-companion"));
            object.insert(
                "hostClientOrigin".into(),
                json!({ "x": client_origin.x, "y": client_origin.y }),
            );
            object.insert(
                "logicalBounds".into(),
                json!({ "x": x, "y": y, "width": width, "height": height }),
            );
        }
        Ok(receipt)
    }).await
}

#[cfg(not(windows))]
#[tauri::command]
fn bind_gpu_preview_surface(
    _app: AppHandle,
    _state: State<'_, AppState>,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    surface_color_space: Option<String>,
) -> Result<Value, String> {
    validate_gpu_surface_bounds(x, y, width, height)?;
    if !matches!(
        surface_color_space.as_deref(),
        None | Some("srgb") | Some("rec2100_pq_1000")
    ) {
        return Err("GPU 預覽表面僅接受 srgb 或 rec2100_pq_1000 色彩傳輸".into());
    }
    Err("原生 GPU 預覽表面目前僅支援 Windows".into())
}

#[tauri::command]
async fn present_gpu_video_preview_at_time(
    app: AppHandle,
    session_id: String,
    time_seconds: f64,
    tolerance_seconds: f64,
    preview_owner: Option<String>,
) -> Result<Value, String> {
    run_gpu_preview_command(app, preview_owner, Some((session_id.clone(), gpu_preview_owner::PreviewResource::Video)), move |app| {
        let state = app.state::<AppState>();
        validate_gpu_session_id(&session_id)?;
        if !time_seconds.is_finite() || time_seconds < 0.0 {
            return Err("GPU 原生預覽主時鐘時間必須是有限的非負數".into());
        }
        if !tolerance_seconds.is_finite() || tolerance_seconds <= 0.0 || tolerance_seconds > 0.25 {
            return Err("GPU 原生預覽同步容差必須介於 0 到 0.25 秒".into());
        }
        let runtime = runtime_paths(&app)?;
        let receipt = with_resident_gpu(&runtime, &state, |process| {
            resident_gpu_request(
                process,
                "video_present_at",
                json!({
                    "sessionId": session_id,
                    "timeSeconds": time_seconds,
                    "toleranceSeconds": tolerance_seconds,
                }),
            )
        })?;
        Ok(json!({
            "endOfStream": receipt.get("endOfStream").and_then(Value::as_bool) == Some(true),
            "receipt": receipt
        }))
    }).await
}

#[tauri::command]
async fn hide_gpu_preview_surface(app: AppHandle,
    preview_owner: Option<String>,
) -> Result<Value, String> {
    run_gpu_preview_command(app, preview_owner, None, move |app| {
        let state = app.state::<AppState>();
        let runtime = runtime_paths(&app)?;
        with_resident_gpu(&runtime, &state, |process| {
            resident_gpu_request(process, "surface_hide", json!({}))
        })
    }).await
}

#[tauri::command]
async fn release_gpu_preview_surface(
    app: AppHandle,
    preview_owner: Option<String>,
) -> Result<Value, String> {
    run_gpu_preview_command(app, preview_owner, None, move |app| {
        let state = app.state::<AppState>();
        let runtime = runtime_paths(&app)?;
        with_resident_gpu(&runtime, &state, |process| {
            resident_gpu_request(process, "surface_release", json!({}))
        })
    }).await
}

#[tauri::command]
async fn seek_gpu_video_preview_session(
    app: AppHandle,
    session_id: String,
    time_seconds: f64,
    preview_owner: Option<String>,
) -> Result<Value, String> {
    run_gpu_preview_command(app, preview_owner, Some((session_id.clone(), gpu_preview_owner::PreviewResource::Video)), move |app| {
        let state = app.state::<AppState>();
        validate_gpu_session_id(&session_id)?;
        if !time_seconds.is_finite() || time_seconds < 0.0 {
            return Err("GPU 影片預覽定位時間必須是有限的非負數".into());
        }
        let runtime = runtime_paths(&app)?;
        with_resident_gpu(&runtime, &state, |process| {
            resident_gpu_request(
                process,
                "video_seek",
                json!({ "sessionId": session_id, "timeSeconds": time_seconds }),
            )
        })
    }).await
}

#[tauri::command]
async fn release_gpu_video_preview_session(
    app: AppHandle,
    session_id: String,
    preview_owner: Option<String>,
) -> Result<Value, String> {
    run_gpu_preview_command(app, preview_owner, Some((session_id.clone(), gpu_preview_owner::PreviewResource::Video)), move |app| {
        let state = app.state::<AppState>();
        validate_gpu_session_id(&session_id)?;
        let runtime = runtime_paths(&app)?;
        let receipt = with_resident_gpu(&runtime, &state, |process| {
            resident_gpu_request(process, "video_release", json!({ "sessionId": session_id }))
        })?;
        retire_gpu_session_cache(&app, &session_id, &receipt)?;
        Ok(receipt)
    }).await
}

#[tauri::command]
async fn recover_gpu_device(app: AppHandle,
    preview_owner: Option<String>,
) -> Result<Value, String> {
    run_gpu_preview_command(app, preview_owner, None, move |app| {
        let state = app.state::<AppState>();
        let runtime = runtime_paths(&app)?;
        with_resident_gpu(&runtime, &state, |process| {
            resident_gpu_request(process, "recover_device", json!({}))
        })
    }).await
}

#[tauri::command]
async fn inject_gpu_device_loss_for_test(
    app: AppHandle,
) -> Result<Value, String> {
    run_gpu_command(app, move |app| {
        let state = app.state::<AppState>();
        if env::var("EDITKIN_INTEGRATION_SMOKE").as_deref() != Ok("1") {
            return Err(
                "GPU fault injection is available only in the isolated integration runtime".into(),
            );
        }
        let runtime = runtime_paths(&app)?;
        with_resident_gpu(&runtime, &state, |process| {
            resident_gpu_request(process, "inject_device_loss", json!({}))
        })
    }).await
}

#[tauri::command]
async fn render_gpu_composition(
    app: AppHandle,
    graph: Value,
) -> Result<Value, String> {
    run_gpu_command(app, move |app| {
        let state = app.state::<AppState>();
        if graph.get("schema").and_then(Value::as_str) != Some("hao.gpu-render-graph/v1") {
            return Err("GPU render graph schema 必須是 hao.gpu-render-graph/v1".into());
        }
        let width = graph.get("width").and_then(Value::as_u64).unwrap_or(0);
        let height = graph.get("height").and_then(Value::as_u64).unwrap_or(0);
        let layers = graph
            .get("layers")
            .and_then(Value::as_array)
            .ok_or("GPU render graph 缺少 layers")?;
        if !(1..=4096).contains(&width) || !(1..=4096).contains(&height) {
            return Err("GPU render graph 尺寸必須介於 1..=4096".into());
        }
        if layers.is_empty() || layers.len() > 64 {
            return Err("GPU render graph 圖層數必須介於 1..=64".into());
        }
        gpu_render_layers_local(layers)?;
        let runtime = runtime_paths(&app)?;
        let job_root = application_cache_root(&app)?
            .join("gpu-compositor")
            .join(format!("{}-{}", std::process::id(), unix_time_ms()));
        fs::create_dir_all(&job_root).map_err(|error| error.to_string())?;
        let graph_path = job_root.join("graph.json");
        let output_path = job_root.join("frame.png");
        fs::write(
            &graph_path,
            serde_json::to_vec_pretty(&graph).map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string())?;
        let session_id = format!("one-shot-{}-{}", std::process::id(), unix_time_ms());
        let receipt = with_resident_gpu(&runtime, &state, |process| {
            resident_gpu_request(
                process,
                "load",
                json!({ "sessionId": session_id, "graphPath": graph_path }),
            )?;
            let rendered = resident_gpu_request(
                process,
                "render",
                json!({ "sessionId": session_id, "outputPath": output_path }),
            )?;
            let _ = resident_gpu_request(process, "release", json!({ "sessionId": session_id }));
            Ok(rendered)
        })?;
        Ok(json!({ "outputPath": output_path, "receipt": receipt }))
    }).await
}

#[derive(Clone)]
struct AgentCli {
    command: PathBuf,
    command_identity: RemoteFileIdentity,
    prefix_args: Vec<String>,
    prefix_path_identities: Vec<(PathBuf, RemoteFileIdentity)>,
}

fn verify_agent_cli_identity(cli: &AgentCli) -> Result<(), String> {
    if remote_file_identity_at_path(&cli.command)? != Some(cli.command_identity)
        || cli.prefix_path_identities.iter().any(|(path, identity)| {
            remote_file_identity_at_path(path).ok().flatten() != Some(*identity)
        })
    {
        return Err("Agent CLI 執行檔／launcher identity 在檢查後改變；已拒絕啟動".into());
    }
    Ok(())
}

fn remote_agent_proxy_has_credentials(value: &str) -> bool {
    value
        .split_once("://")
        .and_then(|(_, remainder)| remainder.split('/').next())
        .is_some_and(|authority| authority.contains('@'))
}

const REMOTE_AGENT_CLEAN_ENV_KEYS: [&str; 22] = [
    "ALL_PROXY",
    "APPDATA",
    "CLAUDE_CONFIG_DIR",
    "CODEX_HOME",
    "HOME",
    "HOMEDRIVE",
    "HOMEPATH",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "LOCALAPPDATA",
    "NODE_EXTRA_CA_CERTS",
    "NO_PROXY",
    "SSL_CERT_DIR",
    "SSL_CERT_FILE",
    "SYSTEMROOT",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "WINDIR",
];

fn filter_remote_agent_environment<I>(entries: I) -> Result<Vec<(OsString, OsString)>, String>
where
    I: IntoIterator<Item = (OsString, OsString)>,
{
    let allowed = REMOTE_AGENT_CLEAN_ENV_KEYS
        .into_iter()
        .collect::<BTreeSet<_>>();
    let mut seen = BTreeSet::new();
    let mut result = Vec::new();
    for (key, value) in entries {
        let Some(key_text) = key.to_str() else {
            continue;
        };
        let normalized = key_text.to_ascii_uppercase();
        if !allowed.contains(normalized.as_str()) || !seen.insert(normalized.clone()) {
            continue;
        }
        let value_text = value
            .to_str()
            .ok_or_else(|| format!("Remote Agent clean env {normalized} 不是 UTF-8"))?;
        if value_text.is_empty() || value_text.chars().any(char::is_control) {
            return Err(format!(
                "Remote Agent clean env {normalized} 含空白或控制字元"
            ));
        }
        if normalized.ends_with("_PROXY") && remote_agent_proxy_has_credentials(value_text) {
            continue;
        }
        result.push((OsString::from(normalized), value));
    }
    result.sort_by(|left, right| left.0.cmp(&right.0));
    Ok(result)
}

fn remote_agent_clean_environment() -> Result<Vec<(OsString, OsString)>, String> {
    // Never enumerate the parent environment: doing so would transiently copy
    // unrelated tokens before filtering. Read only the closed allowlist.
    let environment = filter_remote_agent_environment(
        REMOTE_AGENT_CLEAN_ENV_KEYS
            .into_iter()
            .filter_map(|key| env::var_os(key).map(|value| (OsString::from(key), value))),
    )?;
    #[cfg(windows)]
    if !environment.iter().any(|(key, _)| key == "SYSTEMROOT") {
        return Err("Remote Agent clean env 缺少 Windows SYSTEMROOT；拒絕繼承完整環境".into());
    }
    Ok(environment)
}

const CLAUDE_REMOTE_AGENT_ENVIRONMENT: [(&str, &str); 7] = [
    ("CLAUDE_CODE_DISABLE_ATTACHMENTS", "1"),
    ("CLAUDE_CODE_DISABLE_AUTO_MEMORY", "1"),
    ("CLAUDE_CODE_DISABLE_BACKGROUND_TASKS", "1"),
    ("CLAUDE_CODE_DISABLE_CLAUDE_MDS", "1"),
    ("CLAUDE_CODE_DISABLE_CRON", "1"),
    ("CLAUDE_CODE_SKIP_PROMPT_HISTORY", "1"),
    ("DISABLE_AUTOUPDATER", "1"),
];

fn remote_agent_process_environment(
    target: RemoteAgentTarget,
) -> Result<Vec<(OsString, OsString)>, String> {
    let mut environment = remote_agent_clean_environment()?;
    if target == RemoteAgentTarget::Claude {
        environment.extend(
            CLAUDE_REMOTE_AGENT_ENVIRONMENT
                .into_iter()
                .map(|(key, value)| (OsString::from(key), OsString::from(value))),
        );
        environment.sort_by(|left, right| left.0.cmp(&right.0));
    }
    Ok(environment)
}

/// Finds the agent CLI where it is installed now, including an install made while Editkin was open
/// (「裝好了，再找一次」): agent_connect::agent_cli_search_directories re-reads the user and machine PATH from the
/// registry and adds the standard install folders.
fn locate_agent_cli(target: &str) -> Option<AgentCli> {
    locate_agent_cli_in(target, &agent_connect::agent_cli_search_directories())
}

fn locate_agent_cli_in(target: &str, path_directories: &[PathBuf]) -> Option<AgentCli> {
    if !matches!(target, "codex" | "claude") {
        return None;
    }
    let path_directories = path_directories.to_vec();
    // A linked file (an installer's bin link) is followed: the identity is pinned on, and the command runs from,
    // the canonical target, which must itself be a regular file and not a reparse point.
    let canonical_regular = |candidate: &Path| {
        let link = fs::symlink_metadata(candidate).ok()?;
        if !link.is_file() && !link.file_type().is_symlink() {
            return None;
        }
        let canonical = fs::canonicalize(candidate).ok()?;
        let metadata = fs::symlink_metadata(&canonical).ok()?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return None;
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
            if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
                return None;
            }
        }
        let identity = remote_file_identity_at_path(&canonical).ok().flatten()?;
        Some((canonical, identity))
    };
    #[cfg(windows)]
    {
        for directory in &path_directories {
            if let Some((command, command_identity)) =
                canonical_regular(&directory.join(format!("{target}.exe")))
            {
                return Some(AgentCli {
                    command,
                    command_identity,
                    prefix_args: Vec::new(),
                    prefix_path_identities: Vec::new(),
                });
            }
            if target == "claude" {
                let packaged = directory
                    .join("node_modules")
                    .join("@anthropic-ai")
                    .join("claude-code")
                    .join("bin")
                    .join("claude.exe");
                if let Some((command, command_identity)) = canonical_regular(&packaged) {
                    return Some(AgentCli {
                        command,
                        command_identity,
                        prefix_args: Vec::new(),
                        prefix_path_identities: Vec::new(),
                    });
                }
            }
        }
        if target == "claude" {
            // Older npm packages ship cli.js, started by node, instead of bin\claude.exe.
            if let Some((node, node_identity)) = path_directories
                .iter()
                .find_map(|directory| canonical_regular(&directory.join("node.exe")))
            {
                for directory in &path_directories {
                    let script = directory
                        .join("node_modules")
                        .join("@anthropic-ai")
                        .join("claude-code")
                        .join("cli.js");
                    if let Some((script, script_identity)) = canonical_regular(&script) {
                        return Some(AgentCli {
                            command: node,
                            command_identity: node_identity,
                            prefix_args: vec![script.to_string_lossy().to_string()],
                            prefix_path_identities: vec![(script, script_identity)],
                        });
                    }
                }
            }
        }
        if target == "codex" {
            let (node, node_identity) = path_directories
                .iter()
                .find_map(|directory| canonical_regular(&directory.join("node.exe")))?;
            for directory in &path_directories {
                let script = directory
                    .join("node_modules")
                    .join("@openai")
                    .join("codex")
                    .join("bin")
                    .join("codex.js");
                if let Some((script, script_identity)) = canonical_regular(&script) {
                    return Some(AgentCli {
                        command: node,
                        command_identity: node_identity,
                        prefix_args: vec![script.to_string_lossy().to_string()],
                        prefix_path_identities: vec![(script, script_identity)],
                    });
                }
            }
        }
        None
    }
    #[cfg(not(windows))]
    {
        locate_posix_agent_cli(target, &path_directories, &canonical_regular)
    }
}

/// macOS: `<folder>/<target>` resolved through its links to the real file (npm and Homebrew install links, Claude's
/// native installer). A native binary runs directly. An npm script (`#!/usr/bin/env node`: codex.js, an older
/// claude cli.js) runs through an absolute `node` found in the same folders, because the clean agent environment has
/// no PATH for `env` to search. Any other script (a shell wrapper) is skipped. Compiled on every system so Windows
/// builds type-check it; only macOS calls it.
#[cfg_attr(windows, allow(dead_code))]
fn locate_posix_agent_cli(
    target: &str,
    directories: &[PathBuf],
    canonical_regular: &dyn Fn(&Path) -> Option<(PathBuf, RemoteFileIdentity)>,
) -> Option<AgentCli> {
    let node = || {
        directories.iter().find_map(|directory| {
            let (path, identity) = canonical_regular(&directory.join("node"))?;
            (agent_connect::cli_file_kind(&path) == agent_connect::CliFileKind::Binary).then_some((path, identity))
        })
    };
    for directory in directories {
        let Some((command, command_identity)) = canonical_regular(&directory.join(target)) else {
            continue;
        };
        match agent_connect::cli_file_kind(&command) {
            agent_connect::CliFileKind::Binary => {
                return Some(AgentCli {
                    command,
                    command_identity,
                    prefix_args: Vec::new(),
                    prefix_path_identities: Vec::new(),
                })
            }
            agent_connect::CliFileKind::NodeScript => {
                if let Some((node, node_identity)) = node() {
                    return Some(AgentCli {
                        command: node,
                        command_identity: node_identity,
                        prefix_args: vec![command.to_string_lossy().to_string()],
                        prefix_path_identities: vec![(command, command_identity)],
                    });
                }
            }
            agent_connect::CliFileKind::OtherScript | agent_connect::CliFileKind::NotExecutable => {}
        }
    }
    None
}

struct AgentCliOutput {
    success: bool,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

fn run_agent_cli_with_timeout(
    cli: &AgentCli,
    args: &[String],
    timeout: Duration,
) -> Result<AgentCliOutput, String> {
    let environment = remote_agent_clean_environment()?;
    run_agent_cli_with_timeout_in_environment(cli, args, timeout, &environment)
}

fn run_agent_cli_with_timeout_for_target(
    cli: &AgentCli,
    args: &[String],
    timeout: Duration,
    target: RemoteAgentTarget,
) -> Result<AgentCliOutput, String> {
    let environment = remote_agent_process_environment(target)?;
    run_agent_cli_with_timeout_in_environment(cli, args, timeout, &environment)
}

fn run_agent_cli_with_timeout_in_environment(
    cli: &AgentCli,
    args: &[String],
    timeout: Duration,
    environment: &[(OsString, OsString)],
) -> Result<AgentCliOutput, String> {
    verify_agent_cli_identity(cli)?;
    let invocation = cli
        .prefix_args
        .iter()
        .chain(args.iter())
        .map(OsString::from)
        .collect::<Vec<_>>();
    let preview_process_platform::Spawned {
        mut process,
        stdin,
        stdout,
        stderr,
    } = preview_process_platform::spawn_with_environment_and_cwd(
        &cli.command,
        &invocation,
        environment,
        cli.command
            .parent()
            .ok_or("Agent CLI 絕對路徑缺少 neutral cwd")?,
    )
    .map_err(|error| format!("無法安全啟動 Agent CLI：{error}"))?;
    drop(stdin);
    let (stdout_sender, stdout_receiver) = mpsc::sync_channel(1);
    let (stderr_sender, stderr_receiver) = mpsc::sync_channel(1);
    thread::spawn(move || {
        let _ = stdout_sender.send(read_bounded(stdout, REMOTE_AGENT_OUTPUT_LIMIT_BYTES));
    });
    thread::spawn(move || {
        let _ = stderr_sender.send(read_bounded(stderr, REMOTE_AGENT_OUTPUT_LIMIT_BYTES));
    });
    let deadline = Instant::now() + timeout;
    let mut exit_code = None;
    let mut wait_error = None;
    let mut timed_out = false;
    loop {
        match process.try_wait() {
            Ok(Some(code)) => {
                exit_code = Some(code);
                break;
            }
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(50)),
            Ok(None) => {
                timed_out = true;
                break;
            }
            Err(error) => {
                wait_error = Some(error.to_string());
                break;
            }
        }
    }
    let termination_error = process
        .terminate_tree()
        .err()
        .map(|error| error.to_string());
    let cleanup_deadline = Instant::now() + Duration::from_secs(3);
    let mut cleanup_confirmed = false;
    while Instant::now() < cleanup_deadline {
        match process.tree_is_empty() {
            Ok(true) => {
                cleanup_confirmed = true;
                break;
            }
            Ok(false) => thread::sleep(Duration::from_millis(25)),
            Err(error) => {
                wait_error.get_or_insert_with(|| error.to_string());
                break;
            }
        }
    }
    let stdout = stdout_receiver
        .recv_timeout(Duration::from_secs(3))
        .map_err(|_| "Agent CLI stdout drain 未在 bounded 期限內完成".to_string())?;
    let stderr = stderr_receiver
        .recv_timeout(Duration::from_secs(3))
        .map_err(|_| "Agent CLI stderr drain 未在 bounded 期限內完成".to_string())?;
    if !cleanup_confirmed || termination_error.is_some() {
        return Err(format!(
            "Agent CLI cleanup_unconfirmed；不宣稱子行程已停止{}",
            termination_error
                .as_deref()
                .map(|error| format!("：{error}"))
                .unwrap_or_default()
        ));
    }
    if timed_out {
        return Err("Agent CLI 在期限內沒有回應；整棵子行程已確認清理，未將此步驟視為成功".into());
    }
    if let Some(error) = wait_error {
        return Err(format!("Agent CLI wait/cleanup 驗證失敗：{error}"));
    }
    if stdout.truncated || stderr.truncated {
        return Err("Agent CLI 輸出超過 128 KiB 上限；整棵子行程已清理並 fail closed".into());
    }
    if stdout.read_error.is_some() || stderr.read_error.is_some() {
        return Err("Agent CLI pipe 讀取失敗；整棵子行程已清理並 fail closed".into());
    }
    Ok(AgentCliOutput {
        success: exit_code == Some(0),
        stdout: stdout.bytes,
        stderr: stderr.bytes,
    })
}

fn agent_login_ready(target: RemoteAgentTarget, cli: &AgentCli) -> bool {
    let args = target.login_probe_args();
    run_agent_cli_with_timeout_for_target(cli, &args, Duration::from_secs(5), target)
        .ok()
        .is_some_and(|output| {
            login_probe_is_ready(target, output.success, &output.stdout, &output.stderr)
        })
}

/// Browser-side twin: agentConnectOutcomeV1.ts AGENT_CONNECT_KIT_URL_V1 (autopilotInvocationIdentity.ts VIDEO_AUTOPILOT_KIT_URL).
const VIDEO_AUTOPILOT_KIT_URL: &str = "https://github.com/Hao0321/video-autopilot-kit";
/// The Kit files a run needs beside SKILL.md (autopilotInvocationIdentity.ts assertVideoAutopilotKitInstalled).
const VIDEO_AUTOPILOT_KIT_FILES: [&str; 2] = ["workflow_contract.json", "editkin_design_bridge.py"];

/// EDITKIN_VIDEO_AUTOPILOT_SKILL when set, else ~/.codex/skills/video-autopilot/SKILL.md.
fn video_autopilot_skill_candidate(configured: Option<OsString>, home: Option<PathBuf>) -> Option<PathBuf> {
    configured.map(PathBuf::from).or_else(|| {
        home.map(|home| home.join(".codex").join("skills").join("video-autopilot").join("SKILL.md"))
    })
}

/// The same three-file check as assertVideoAutopilotKitInstalled: SKILL.md, workflow_contract.json and
/// editkin_design_bridge.py. Ok(the Skill path), or Err(the first missing piece, in the TypeScript wording).
fn video_autopilot_kit_check(skill: Option<PathBuf>, configured: bool) -> Result<PathBuf, String> {
    let missing_skill = if configured {
        "找不到 EDITKIN_VIDEO_AUTOPILOT_SKILL 指向的 video-autopilot SKILL.md。"
    } else {
        "這台電腦還沒有安裝 Video Autopilot Kit（找不到 ~/.codex/skills/video-autopilot/SKILL.md）。"
    };
    let skill = skill.filter(|path| path.is_file()).ok_or(missing_skill)?;
    if !skill
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.eq_ignore_ascii_case("SKILL.md"))
    {
        return Err("EDITKIN_VIDEO_AUTOPILOT_SKILL 必須指向 video-autopilot SKILL.md".into());
    }
    for name in VIDEO_AUTOPILOT_KIT_FILES {
        if !skill.with_file_name(name).is_file() {
            return Err(format!("已安裝的 Video Autopilot Kit 不完整或太舊（缺少 {name}）。"));
        }
    }
    Ok(skill)
}

fn video_autopilot_kit(app: &AppHandle) -> Result<PathBuf, String> {
    let configured = env::var_os("EDITKIN_VIDEO_AUTOPILOT_SKILL");
    let is_configured = configured.is_some();
    video_autopilot_kit_check(
        video_autopilot_skill_candidate(configured, app.path().home_dir().ok()),
        is_configured,
    )
}

/// The Kit as inspect_agent_connections reports it, so the dialog knows before anyone chooses a folder.
fn video_autopilot_kit_status(kit: &Result<PathBuf, String>) -> Value {
    match kit {
        Ok(_) => json!({ "ready": true, "kitUrl": VIDEO_AUTOPILOT_KIT_URL }),
        Err(detail) => json!({ "ready": false, "cause": "kit_missing", "kitUrl": VIDEO_AUTOPILOT_KIT_URL, "detail": detail }),
    }
}

#[cfg(test)]
mod agent_kit_preflight_tests {
    use super::*;

    fn kit_root(name: &str) -> PathBuf {
        let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let root = env::temp_dir().join(format!("editkin-kit-{name}-{}-{nonce}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn kit_check_requires_skill_contract_and_bridge() {
        let root = kit_root("check");
        let skill = root.join("SKILL.md");
        let missing = video_autopilot_kit_check(Some(skill.clone()), false).unwrap_err();
        assert!(missing.contains("~/.codex/skills/video-autopilot/SKILL.md"), "{missing}");
        assert!(video_autopilot_kit_check(Some(skill.clone()), true).unwrap_err().contains("EDITKIN_VIDEO_AUTOPILOT_SKILL"));
        assert!(video_autopilot_kit_check(None, false).is_err());
        fs::write(&skill, "name: video-autopilot\n").unwrap();
        assert!(video_autopilot_kit_check(Some(skill.clone()), false).unwrap_err().contains("workflow_contract.json"));
        fs::write(root.join("workflow_contract.json"), "{}").unwrap();
        assert!(video_autopilot_kit_check(Some(skill.clone()), false).unwrap_err().contains("editkin_design_bridge.py"));
        // A folder with the bridge's name is not the bridge.
        fs::create_dir(root.join("editkin_design_bridge.py")).unwrap();
        assert!(video_autopilot_kit_check(Some(skill.clone()), false).unwrap_err().contains("editkin_design_bridge.py"));
        fs::remove_dir(root.join("editkin_design_bridge.py")).unwrap();
        fs::write(root.join("editkin_design_bridge.py"), "").unwrap();
        assert_eq!(video_autopilot_kit_check(Some(skill.clone()), false).unwrap(), skill);
        // EDITKIN_VIDEO_AUTOPILOT_SKILL must name SKILL.md itself, not another file of the Kit.
        assert!(video_autopilot_kit_check(Some(root.join("workflow_contract.json")), true).unwrap_err().contains("必須指向"));
        assert!(video_autopilot_kit_check(Some(root.clone()), true).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn skill_candidate_prefers_the_configured_path() {
        // Assembled so the source never spells a Windows profile path (the public export refuses one).
        let home = PathBuf::from(concat!("C:", "/", "Users", "/someone"));
        assert_eq!(video_autopilot_skill_candidate(None, Some(home.clone())).unwrap(),
            home.join(".codex").join("skills").join("video-autopilot").join("SKILL.md"));
        assert_eq!(video_autopilot_skill_candidate(Some(OsString::from("D:/kit/SKILL.md")), Some(home)).unwrap(), PathBuf::from("D:/kit/SKILL.md"));
        assert!(video_autopilot_skill_candidate(None, None).is_none());
    }

    #[test]
    fn kit_status_is_reported_but_never_required_to_connect() {
        let missing: Result<PathBuf, String> = Err("已安裝的 Video Autopilot Kit 不完整或太舊（缺少 workflow_contract.json）。".into());
        let ready: Result<PathBuf, String> = Ok(PathBuf::from("C:/kit/SKILL.md"));
        assert_eq!(video_autopilot_kit_status(&ready), json!({ "ready": true, "kitUrl": VIDEO_AUTOPILOT_KIT_URL }));
        assert_eq!(video_autopilot_kit_status(&missing)["cause"], "kit_missing");
        assert_eq!(video_autopilot_kit_status(&missing)["ready"], false);
        // #106: no Skill gate before or after the folder picker; the only pre-picker check is the agent CLI.
        let source = include_str!("main.rs");
        // Split so this test never contains the needle other source checks search for.
        let needle = concat!("\nfn copy_agent", "_setup(");
        let start = source.find(needle).expect("copy_agent_setup");
        let command = &source[start..start + source[start..].find("\n}").expect("end of copy_agent_setup")];
        assert!(!command.contains("video_autopilot_kit") && !command.contains("kit_missing"), "{command}");
        let connect = include_str!("agent_connect.rs");
        let detect = &connect[connect.find("pub fn detect(").unwrap()..connect.find("pub fn discard(self)").unwrap()];
        assert!(!detect.contains("video_autopilot_kit") && !detect.contains("kit_missing"), "{detect}");
    }
}

fn base_agent_environment(
    app: &AppHandle,
    runtime: &RuntimePaths,
    agent_state_root: &Path,
    video_autopilot_skill: &Path,
) -> Result<Vec<(String, String)>, String> {
    let plugin_roots = joined_plugin_roots(runtime)?;
    Ok(vec![
        ("ELECTRON_RUN_AS_NODE".to_string(), "1".to_string()),
        (
            "EDITKIN_AGENT_STATE_ROOT".to_string(),
            agent_state_root.to_string_lossy().to_string(),
        ),
        (
            "EDITKIN_VIDEO_AUTOPILOT_SKILL".to_string(),
            video_autopilot_skill.to_string_lossy().to_string(),
        ),
        (
            "HAO_FFMPEG_PATH".to_string(),
            runtime.ffmpeg.to_string_lossy().to_string(),
        ),
        (
            "HAO_FFPROBE_PATH".to_string(),
            runtime.ffprobe.to_string_lossy().to_string(),
        ),
        (
            "EDITKIN_WHISPER_CLI_PATH".to_string(),
            runtime.whisper_cli.to_string_lossy().to_string(),
        ),
        (
            "HAO_NATIVE_CORE_PATH".to_string(),
            runtime.native_core.to_string_lossy().to_string(),
        ),
        (
            "EDITKIN_CREATIVE_PACK_ROOT".to_string(),
            runtime.creative_pack_root.to_string_lossy().to_string(),
        ),
        (
            "EDITKIN_PERSONAL_MUSIC_ROOT".to_string(),
            runtime.personal_music_root.to_string_lossy().to_string(),
        ),
        (
            "EDITKIN_PERSONAL_VISUAL_ROOT".to_string(),
            runtime.personal_visual_root.to_string_lossy().to_string(),
        ),
        (
            "EDITKIN_PLUGIN_ROOTS".to_string(),
            plugin_roots.to_string_lossy().to_string(),
        ),
        (
            "EDITKIN_WORKFLOW_PROFILE_PATH".to_string(),
            workflow_profile_path(app)?.to_string_lossy().to_string(),
        ),
        (
            "EDITKIN_MODEL_ROOT".to_string(),
            runtime.model_root.to_string_lossy().to_string(),
        ),
        (
            "EDITKIN_CACHE_ROOT".to_string(),
            runtime.cache_root.to_string_lossy().to_string(),
        ),
    ])
}

fn remote_only_agent_environment(
    agent_state_root: &Path,
    workspace: &Path,
    job_id: &str,
    consent_revision: &str,
) -> Result<Vec<(String, String)>, String> {
    let state_root = fs::canonicalize(agent_state_root)
        .map_err(|error| format!("Remote-only Agent state root 無法 canonicalize：{error}"))?;
    let workspace = fs::canonicalize(workspace)
        .map_err(|error| format!("Remote-only workspace 無法 canonicalize：{error}"))?;
    if !state_root.is_absolute()
        || !workspace.is_absolute()
        || !valid_remote_agent_job_id(job_id)
        || consent_revision != REMOTE_AGENT_CONSENT_REVISION
    {
        return Err("Remote-only MCP 路徑／job／consent binding 不合法".into());
    }
    Ok(vec![
        ("ELECTRON_RUN_AS_NODE".into(), "1".into()),
        (
            "EDITKIN_AGENT_STATE_ROOT".into(),
            state_root.to_string_lossy().to_string(),
        ),
        ("EDITKIN_MCP_MODE".into(), "remote-only".into()),
        ("EDITKIN_REMOTE_AGENT_JOB_ID".into(), job_id.into()),
        (
            "EDITKIN_REMOTE_AGENT_CONSENT_REVISION".into(),
            consent_revision.into(),
        ),
        (
            "EDITKIN_WORKSPACE".into(),
            workspace.to_string_lossy().to_string(),
        ),
    ])
}

fn inspect_agent_target_status(target: &str) -> Value {
    let Some(cli) = locate_agent_cli(target) else {
        return json!({
            "target": target, "available": false, "configured": false,
            "exactConfiguration": false, "health": "missing",
            "loginReady": false, "launchReady": false, "directLaunchReady": false,
            "launcherReason": "找不到已安裝的 CLI"
        });
    };
    let parsed = match RemoteAgentTarget::parse(target) {
        Ok(parsed) => parsed,
        Err(_) => {
            return json!({ "target": target, "available": false, "directLaunchReady": false })
        }
    };
    // Codex login/status loads the user's whole config before it can read auth.
    // More importantly, current Codex CLI still loads global AGENTS.md even
    // with --ignore-user-config; do not advertise hidden direct launch until a
    // supported instruction-isolation switch exists.
    let login_ready =
        (parsed == RemoteAgentTarget::Claude).then(|| agent_login_ready(parsed, &cli));
    let direct_launch_ready = if parsed == RemoteAgentTarget::Codex {
        CODEX_DIRECT_LAUNCH_INSTRUCTION_ISOLATION_SUPPORTED
    } else {
        login_ready == Some(true)
    };
    let launcher_reason = if direct_launch_ready {
        "已用 clean settings 驗證登入；可注入 Editkin frozen MCP 啟動"
    } else if parsed == RemoteAgentTarget::Codex {
        "Codex CLI 尚無法關閉全域 AGENTS.md；請使用可見 Codex 工作階段連接 Editkin MCP，內部自動啟動已安全停用"
    } else {
        "Claude clean auth probe 未通過；Editkin 只檢查並立即丟棄 loggedIn 狀態，不要求、讀取或保存 key、token、cookie、密碼"
    };
    let launcher_path = cli
        .prefix_args
        .first()
        .map(String::as_str)
        .unwrap_or_else(|| cli.command.to_str().unwrap_or("non-utf8-path"));
    json!({
        "target": target,
        "available": true,
        "configured": false,
        "exactConfiguration": false,
        "hostConfigurationInspected": false,
        "runtimeVerified": false,
        "sessionConnected": false,
        "health": "missing",
        "loginReady": login_ready,
        "launchReady": direct_launch_ready,
        "directLaunchReady": direct_launch_ready,
        "launcherPath": launcher_path,
        "launcherIdentityPinned": true,
        "launcherReason": launcher_reason
    })
}

fn inspect_agent_connections_blocking(app: AppHandle) -> Result<Value, String> {
    let _ = runtime_paths(&app)?;
    // The same Kit check copy_agent_setup runs before its folder picker.
    let kit = video_autopilot_kit_status(&video_autopilot_kit(&app));
    // Optional (#106): connecting never needs the Skill; the UI offers it as a next step.
    let va_skill = agent_connect::va_skill_status(&app).to_json();
    let codex = inspect_agent_target_status("codex");
    let claude = inspect_agent_target_status("claude");
    let ready =
        |value: &Value| value.get("directLaunchReady").and_then(Value::as_bool) == Some(true);
    let preferred = if ready(&claude) {
        Some("claude")
    } else if ready(&codex) {
        Some("codex")
    } else {
        None
    };
    Ok(json!({
        "codex": codex,
        "claude": claude,
        "kit": kit,
        "vaSkill": va_skill,
        "agentRuntimeRepair": agent_connect::agent_runtime_repair_status(),
        "preferredTarget": preferred,
        "checkedAt": unix_time_ms()
    }))
}

#[tauri::command]
async fn inspect_agent_connections(app: AppHandle) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || inspect_agent_connections_blocking(app))
        .await
        .map_err(|error| format!("Agent 連線背景檢查失敗：{error}"))?
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PendingRemoteAgentSetup {
    schema: String,
    confirmation_id: String,
    transport: String,
    provider_id: String,
    cost_responsibility: String,
    auto_deploy: bool,
    prepared_at: String,
    remote_agent_job_id: Option<String>,
    remote_agent_consent_revision: Option<String>,
}

const REMOTE_PROVIDER_PROPOSAL_SCHEMA: &str = "editkin.remote-provider-proposal/v2";
const LEGACY_REMOTE_PROVIDER_PROPOSAL_SCHEMA: &str = "editkin.remote-provider-proposal/v1";
const REMOTE_PROVIDER_PROPOSAL_TTL_MS: u64 = 30 * 60 * 1_000;
const JAVASCRIPT_MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RemoteProviderProposalProvider {
    id: String,
    display_name: String,
    product_name: String,
    region: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RemoteProviderProposalEndpoint {
    transport: String,
    public_origin_required: bool,
    description: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RemoteProviderProposalPricing {
    kind: String,
    amount_micros: Option<u64>,
    currency: Option<String>,
    billing_unit: String,
    summary: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RemoteProviderProposalSource {
    label: String,
    url: String,
    checked_at_ms: u64,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RemoteProviderProposalConnector {
    connector_id: String,
    connector_revision: String,
    manifest_sha256: String,
    availability: String,
    attested: bool,
    approval_enabled: bool,
    execution_owner: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RemoteProviderProposal {
    schema: String,
    phase: String,
    truth_label: String,
    workflow_id: String,
    job_id: String,
    consent_revision: String,
    proposal_revision: String,
    proposal_digest: String,
    connector: RemoteProviderProposalConnector,
    plan_digest: String,
    transport: String,
    provider: RemoteProviderProposalProvider,
    expected_endpoint: RemoteProviderProposalEndpoint,
    pricing: RemoteProviderProposalPricing,
    free_tier: String,
    quota: String,
    permissions: Vec<String>,
    planned_mutations: Vec<String>,
    cancellation_or_deletion_consequences: String,
    sources: Vec<RemoteProviderProposalSource>,
    uncertainties: Vec<String>,
    unsupported_prerequisites: Vec<String>,
    cost_responsibility: String,
    external_mutation_performed: bool,
    auto_deploy: bool,
    approval_available: bool,
    created_at_ms: u64,
    updated_at_ms: u64,
    expires_at_ms: u64,
}

#[derive(Clone)]
enum PendingRemoteSetupRecord {
    ProviderProposal(RemoteProviderProposal),
    LegacyProviderProposal,
    Legacy(PendingRemoteAgentSetup),
}

fn user_remote_setup_pending_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(application_data_root(app)?
        .join("mobile-remote")
        .join("network-setup-pending.json"))
}

fn user_remote_setup_renewing_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(application_data_root(app)?
        .join("mobile-remote")
        .join("network-setup-pending.json.renewing"))
}

fn ensure_remote_setup_agent_launch_state(
    environment_configured: bool,
    configured: bool,
    candidate: bool,
    renewing_present: bool,
    pending: Option<&PendingRemoteSetupRecord>,
) -> Result<(), String> {
    if renewing_present {
        return Err(
            "Remote proposal renewal crash artifact 需要人工 reconciliation；不可重跑 AI".into(),
        );
    }
    if matches!(
        pending,
        Some(PendingRemoteSetupRecord::Legacy(_))
            | Some(PendingRemoteSetupRecord::LegacyProviderProposal)
    ) {
        return Err("Remote 舊版確認單缺少價格、配額、權限、來源與 digest；請安全遷移或丟棄，不能重跑 AI 覆寫".into());
    }
    if environment_configured {
        return Err("Remote 已由環境變數設定；這是 Editkin 外部唯讀來源，不可再啟動 AI proposal 造成 split-brain".into());
    }
    if configured || candidate {
        return Err(
            "Remote 已有正式設定或桌面核准候選；不可再啟動 AI proposal 覆寫目前狀態".into(),
        );
    }
    Ok(())
}

fn ensure_remote_setup_agent_launchable(app: &AppHandle) -> Result<(), String> {
    let (relay, tunnel) = environment_remote_origins()?;
    let renewing_present =
        remote_renewing_artifact_present(&user_remote_setup_renewing_path(app)?)?;
    if renewing_present {
        return ensure_remote_setup_agent_launch_state(
            relay.is_some() || tunnel.is_some(),
            false,
            false,
            true,
            None,
        );
    }
    let configured = user_remote_network_config(app)?;
    let candidate = user_remote_network_candidate(app)?;
    let pending = read_remote_json(&user_remote_setup_pending_path(app)?)?
        .map(parse_pending_remote_setup_record)
        .transpose()?;
    ensure_remote_setup_agent_launch_state(
        relay.is_some() || tunnel.is_some(),
        configured.is_some(),
        candidate.is_some(),
        renewing_present,
        pending.as_ref(),
    )
}

fn valid_remote_provider_id(value: &str) -> bool {
    (2..=63).contains(&value.len())
        && value
            .bytes()
            .next()
            .is_some_and(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        && value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"._-".contains(&byte)
        })
}

fn proposal_text_contains_secret_material(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    for (offset, _) in lower.match_indices("authorization") {
        let suffix = lower[offset + "authorization".len()..].trim_start();
        if suffix
            .strip_prefix(':')
            .map(str::trim_start)
            .is_some_and(|value| value.starts_with("bearer"))
        {
            return true;
        }
    }
    for needle in [
        "apikey",
        "api key",
        "api_key",
        "api-key",
        "accesstoken",
        "access token",
        "access_token",
        "access-token",
        "refreshtoken",
        "refresh token",
        "refresh_token",
        "refresh-token",
        "password",
        "secret",
    ] {
        for (offset, _) in lower.match_indices(needle) {
            let suffix = &lower[offset + needle.len()..];
            if suffix
                .chars()
                .find(|character| !character.is_whitespace())
                .is_some_and(|character| character == ':' || character == '=')
            {
                return true;
            }
        }
    }
    let upper = value.to_ascii_uppercase();
    let mut remaining = upper.as_str();
    while let Some(begin) = remaining.find("-----BEGIN ") {
        let after_begin = &remaining[begin + "-----BEGIN ".len()..];
        if let Some(end) = after_begin.find("PRIVATE KEY-----") {
            if after_begin[..end]
                .bytes()
                .all(|byte| byte == b' ' || byte.is_ascii_uppercase())
            {
                return true;
            }
        }
        remaining = after_begin;
    }
    false
}

fn valid_remote_proposal_text(value: &str, max_utf16_length: usize) -> bool {
    !value.is_empty()
        && value == value.trim()
        && value.encode_utf16().count() <= max_utf16_length
        && !value.chars().any(|character| {
            matches!(character as u32, 0x0000..=0x001f | 0x007f..=0x009f | 0x202a..=0x202e | 0x2066..=0x2069)
        })
        && !proposal_text_contains_secret_material(value)
}

fn percent_decode_remote_evidence_path(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != b'%' {
            decoded.push(bytes[index]);
            index += 1;
            continue;
        }
        if index + 2 >= bytes.len() {
            return None;
        }
        let hex = |byte: u8| match byte {
            b'0'..=b'9' => Some(byte - b'0'),
            b'a'..=b'f' => Some(byte - b'a' + 10),
            b'A'..=b'F' => Some(byte - b'A' + 10),
            _ => None,
        };
        decoded.push(hex(bytes[index + 1])? * 16 + hex(bytes[index + 2])?);
        index += 3;
    }
    String::from_utf8(decoded).ok()
}

fn remote_evidence_path_contains_secret_hint(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    let boundary = |byte: u8| b"/._-".contains(&byte);
    for needle in [
        "token",
        "secret",
        "password",
        "credential",
        "apikey",
        "api-key",
        "api_key",
        "accesskey",
        "access-key",
        "access_key",
    ] {
        for (offset, _) in lower.match_indices(needle) {
            let before_ok = offset == 0 || boundary(lower.as_bytes()[offset - 1]);
            let after = offset + needle.len();
            let after_ok = after == lower.len() || boundary(lower.as_bytes()[after]);
            if before_ok && after_ok {
                return true;
            }
        }
    }
    false
}

fn remote_proposal_evidence_ip_is_public(ip: IpAddr) -> bool {
    if !remote_ip_is_public(ip) {
        return false;
    }
    match ip {
        IpAddr::V4(ipv4) => {
            let [a, b, c, _] = ipv4.octets();
            !((a == 192 && b == 0 && (c == 0 || c == 2))
                || (a == 192 && b == 88 && c == 99)
                || (a == 198 && b == 51 && c == 100)
                || (a == 203 && b == 0 && c == 113))
        }
        IpAddr::V6(ipv6) => ipv6.octets()[..4] != [0x20, 0x01, 0x0d, 0xb8],
    }
}

fn valid_remote_proposal_source_url(value: &str) -> bool {
    if value.encode_utf16().count() > 2_048
        || value != value.trim()
        || value.contains(['?', '#', '\\'])
        || value.chars().any(char::is_whitespace)
        || value.len() < "https://a".len()
        || !value
            .get(.."https://".len())
            .is_some_and(|prefix| prefix.eq_ignore_ascii_case("https://"))
    {
        return false;
    }
    let remainder = &value["https://".len()..];
    let (authority, path) = remainder
        .split_once('/')
        .map_or((remainder, ""), |(authority, path)| (authority, path));
    if authority.is_empty() || authority.contains('@') {
        return false;
    }
    let host = if authority.starts_with('[') {
        let Some(close) = authority.find(']') else {
            return false;
        };
        let suffix = &authority[close + 1..];
        if !suffix.is_empty()
            && (!suffix.starts_with(':')
                || suffix[1..]
                    .parse::<u16>()
                    .ok()
                    .filter(|port| *port > 0)
                    .is_none())
        {
            return false;
        }
        &authority[1..close]
    } else {
        let (host, port) = authority.rsplit_once(':').unwrap_or((authority, ""));
        if authority.matches(':').count() > 1
            || (!port.is_empty()
                && port
                    .parse::<u16>()
                    .ok()
                    .filter(|value| *value > 0)
                    .is_none())
        {
            return false;
        }
        host
    };
    let host_lower = host.to_ascii_lowercase();
    if host.is_empty()
        || !host.is_ascii()
        || host_lower == "localhost"
        || host_lower.ends_with(".localhost")
        || host_lower.ends_with(".local")
        || host_lower == "metadata.google.internal"
    {
        return false;
    }
    if let Ok(ip) = host_lower.parse::<IpAddr>() {
        if !remote_proposal_evidence_ip_is_public(ip) {
            return false;
        }
    } else if looks_like_legacy_numeric_ipv4(&host_lower)
        || !host_lower.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && label
                    .bytes()
                    .next()
                    .is_some_and(|byte| byte.is_ascii_alphanumeric())
                && label
                    .bytes()
                    .last()
                    .is_some_and(|byte| byte.is_ascii_alphanumeric())
                && label
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        })
    {
        return false;
    }
    percent_decode_remote_evidence_path(path)
        .is_some_and(|decoded| !remote_evidence_path_contains_secret_hint(&decoded))
}

fn valid_remote_proposal_string_list(values: &[String], required: bool) -> bool {
    (!required || !values.is_empty())
        && values.len() <= 16
        && values
            .iter()
            .all(|value| valid_remote_proposal_text(value, 160))
        && values.iter().collect::<BTreeSet<_>>().len() == values.len()
}

fn remote_provider_proposal_digest(proposal: &RemoteProviderProposal) -> Result<String, String> {
    let identity = json!([
        proposal.schema,
        proposal.phase,
        proposal.truth_label,
        proposal.workflow_id,
        proposal.job_id,
        proposal.consent_revision,
        proposal.proposal_revision,
        [
            proposal.connector.connector_id,
            proposal.connector.connector_revision,
            proposal.connector.manifest_sha256,
            proposal.connector.availability,
            proposal.connector.attested,
            proposal.connector.approval_enabled,
            proposal.connector.execution_owner,
        ],
        proposal.plan_digest,
        proposal.transport,
        [
            proposal.provider.id,
            proposal.provider.display_name,
            proposal.provider.product_name,
            proposal.provider.region
        ],
        [
            proposal.expected_endpoint.transport,
            proposal.expected_endpoint.public_origin_required,
            proposal.expected_endpoint.description
        ],
        [
            proposal.pricing.kind,
            proposal.pricing.amount_micros,
            proposal.pricing.currency,
            proposal.pricing.billing_unit,
            proposal.pricing.summary
        ],
        proposal.free_tier,
        proposal.quota,
        proposal.permissions,
        proposal.planned_mutations,
        proposal.cancellation_or_deletion_consequences,
        proposal
            .sources
            .iter()
            .map(|source| json!([source.label, source.url, source.checked_at_ms]))
            .collect::<Vec<_>>(),
        proposal.uncertainties,
        proposal.unsupported_prerequisites,
        proposal.cost_responsibility,
        proposal.external_mutation_performed,
        proposal.auto_deploy,
        proposal.approval_available,
        proposal.created_at_ms,
        proposal.updated_at_ms,
        proposal.expires_at_ms
    ]);
    let bytes = serde_json::to_vec(&identity)
        .map_err(|error| format!("Remote provider proposal digest encode 失敗：{error}"))?;
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    Ok(format!("{:x}", hasher.finalize()))
}

fn remote_provider_action_plan_digest(proposal: &RemoteProviderProposal) -> Result<String, String> {
    let identity = json!([
        remote_provider_connector::ACTION_PLAN_SCHEMA,
        [
            proposal.connector.connector_id,
            proposal.connector.connector_revision,
            proposal.connector.manifest_sha256,
            proposal.connector.availability,
            proposal.connector.attested,
            proposal.connector.approval_enabled,
            proposal.connector.execution_owner,
        ],
        [
            proposal.provider.id,
            proposal.provider.product_name,
            proposal.provider.region,
        ],
        proposal.transport,
        [
            proposal.expected_endpoint.transport,
            proposal.expected_endpoint.public_origin_required,
            proposal.expected_endpoint.description,
        ],
        proposal.permissions,
        proposal.planned_mutations,
        proposal.cancellation_or_deletion_consequences,
    ]);
    let bytes = serde_json::to_vec(&identity)
        .map_err(|error| format!("Remote provider action plan digest encode 失敗：{error}"))?;
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    Ok(format!("{:x}", hasher.finalize()))
}

fn parse_remote_provider_proposal(value: Value) -> Result<RemoteProviderProposal, String> {
    let proposal = serde_json::from_value::<RemoteProviderProposal>(value)
        .map_err(|error| format!("Remote provider proposal 格式不合法：{error}"))?;
    let now = u64::try_from(unix_time_ms()).unwrap_or(u64::MAX);
    let pricing_valid = match proposal.pricing.kind.as_str() {
        "unknown" => {
            proposal.pricing.amount_micros.is_none()
                && proposal.pricing.currency.is_none()
                && proposal.pricing.billing_unit == "unknown"
                && !proposal.uncertainties.is_empty()
        }
        "public-list-price" | "estimate" => {
            proposal
                .pricing
                .amount_micros
                .is_some_and(|amount| amount <= JAVASCRIPT_MAX_SAFE_INTEGER)
                && proposal.pricing.currency.as_ref().is_some_and(|currency| {
                    currency.len() == 3 && currency.bytes().all(|byte| byte.is_ascii_uppercase())
                })
                && ["per-month", "per-gigabyte", "per-hour", "one-time"]
                    .contains(&proposal.pricing.billing_unit.as_str())
        }
        _ => false,
    };
    let sources_valid = (1..=8).contains(&proposal.sources.len())
        && proposal.sources.iter().all(|source| {
            valid_remote_proposal_text(&source.label, 120)
                && valid_remote_proposal_source_url(&source.url)
                && source.checked_at_ms <= JAVASCRIPT_MAX_SAFE_INTEGER
                && source.checked_at_ms == proposal.created_at_ms
        })
        && proposal
            .sources
            .iter()
            .map(|source| source.url.as_str())
            .collect::<BTreeSet<_>>()
            .len()
            == proposal.sources.len();
    let timestamps_valid = proposal.created_at_ms <= JAVASCRIPT_MAX_SAFE_INTEGER
        && proposal.updated_at_ms <= JAVASCRIPT_MAX_SAFE_INTEGER
        && proposal.expires_at_ms <= JAVASCRIPT_MAX_SAFE_INTEGER
        && proposal.updated_at_ms == proposal.created_at_ms
        && proposal
            .expires_at_ms
            .saturating_sub(proposal.created_at_ms)
            == REMOTE_PROVIDER_PROPOSAL_TTL_MS
        && proposal.expires_at_ms >= proposal.created_at_ms
        && proposal.created_at_ms <= now.saturating_add(60_000);
    remote_provider_connector::validate_connector_binding(
        ConnectorBinding {
            connector_id: &proposal.connector.connector_id,
            connector_revision: &proposal.connector.connector_revision,
            manifest_sha256: &proposal.connector.manifest_sha256,
            availability: &proposal.connector.availability,
            attested: proposal.connector.attested,
            approval_enabled: proposal.connector.approval_enabled,
            execution_owner: &proposal.connector.execution_owner,
        },
        &proposal.provider.id,
        &proposal.provider.display_name,
        &proposal.provider.product_name,
        proposal.approval_available,
    )?;
    if proposal.schema != REMOTE_PROVIDER_PROPOSAL_SCHEMA
        || proposal.phase != "EXACT_PROVIDER_PROPOSAL"
        || proposal.truth_label != "PROPOSAL_READY_NOT_APPROVED"
        || !valid_remote_agent_job_id(&proposal.workflow_id)
        || !valid_remote_agent_job_id(&proposal.job_id)
        || proposal.consent_revision != REMOTE_AGENT_CONSENT_REVISION
        || !valid_candidate_revision(&proposal.proposal_revision)
        || proposal.proposal_digest.len() != 64
        || !proposal
            .proposal_digest
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        || proposal.plan_digest.len() != 64
        || !proposal
            .plan_digest
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        || remote_provider_action_plan_digest(&proposal)? != proposal.plan_digest
        || proposal.transport != "https-tunnel"
        || !valid_remote_provider_id(&proposal.provider.id)
        || !valid_remote_proposal_text(&proposal.provider.display_name, 80)
        || !valid_remote_proposal_text(&proposal.provider.product_name, 120)
        || !valid_remote_proposal_text(&proposal.provider.region, 80)
        || proposal.expected_endpoint.transport != "https-tunnel"
        || !proposal.expected_endpoint.public_origin_required
        || !valid_remote_proposal_text(&proposal.expected_endpoint.description, 240)
        || !pricing_valid
        || !valid_remote_proposal_text(&proposal.pricing.summary, 240)
        || !valid_remote_proposal_text(&proposal.free_tier, 240)
        || !valid_remote_proposal_text(&proposal.quota, 240)
        || !valid_remote_proposal_string_list(&proposal.permissions, true)
        || !valid_remote_proposal_string_list(&proposal.planned_mutations, true)
        || !valid_remote_proposal_text(&proposal.cancellation_or_deletion_consequences, 320)
        || !sources_valid
        || !valid_remote_proposal_string_list(&proposal.uncertainties, false)
        || !valid_remote_proposal_string_list(&proposal.unsupported_prerequisites, false)
        || proposal.cost_responsibility != "end-user"
        || proposal.external_mutation_performed
        || proposal.auto_deploy
        || proposal.approval_available
        || !timestamps_valid
        || remote_provider_proposal_digest(&proposal)? != proposal.proposal_digest
    {
        return Err("Remote provider proposal 未通過 closed-world identity／來源／價格／timestamp／digest 驗證".into());
    }
    Ok(proposal)
}

fn parse_pending_remote_setup_record(value: Value) -> Result<PendingRemoteSetupRecord, String> {
    match value.get("schema").and_then(Value::as_str) {
        Some(REMOTE_PROVIDER_PROPOSAL_SCHEMA) => {
            parse_remote_provider_proposal(value).map(PendingRemoteSetupRecord::ProviderProposal)
        }
        Some(LEGACY_REMOTE_PROVIDER_PROPOSAL_SCHEMA) => {
            Ok(PendingRemoteSetupRecord::LegacyProviderProposal)
        }
        Some("editkin.remote-setup-confirmation/v1") => {
            parse_pending_remote_agent_setup(value).map(PendingRemoteSetupRecord::Legacy)
        }
        _ => Err("Remote AI pending state schema 不受支援；已 fail closed".into()),
    }
}

fn parse_pending_remote_agent_setup(value: Value) -> Result<PendingRemoteAgentSetup, String> {
    let pending = serde_json::from_value::<PendingRemoteAgentSetup>(value)
        .map_err(|error| format!("Remote AI 確認單格式不合法：{error}"))?;
    if pending.schema != "editkin.remote-setup-confirmation/v1"
        || !valid_candidate_revision(&pending.confirmation_id)
        || pending.transport != "https-tunnel"
        || !valid_remote_provider_id(&pending.provider_id)
        || pending.cost_responsibility != "end-user"
        || pending.auto_deploy
        || pending.prepared_at.trim().is_empty()
        || pending
            .remote_agent_job_id
            .as_deref()
            .is_some_and(|value| !valid_remote_agent_job_id(value))
        || pending
            .remote_agent_consent_revision
            .as_deref()
            .is_some_and(|value| {
                ![
                    "editkin.remote-agent-consent/v1",
                    REMOTE_AGENT_CONSENT_REVISION,
                ]
                .contains(&value)
            })
    {
        return Err("Remote AI 確認單未通過 closed-world 驗證".into());
    }
    Ok(pending)
}

fn fresh_remote_route_verification_since(
    app: &AppHandle,
    state: &AppState,
    started_at_ms: u128,
) -> Result<bool, String> {
    if user_remote_network_candidate(app)?.is_some() {
        return Ok(false);
    }
    let Some(config) = user_remote_network_config(app)? else {
        return Ok(false);
    };
    let active_runtime_identity = {
        let mut remote_state = state
            .mobile_remote
            .lock()
            .map_err(|_| "mobile remote lock poisoned")?;
        let identity = remote_state.as_mut().and_then(|remote| {
            if remote.child.try_wait().ok().flatten().is_none() {
                Some((
                    remote.probe_id.clone(),
                    remote.runtime_instance_id.clone(),
                    remote.child.id(),
                    remote.started_at_ms,
                ))
            } else {
                None
            }
        });
        identity
    };
    let Some((probe_id, runtime_instance_id, process_id, runtime_started_at_ms)) =
        active_runtime_identity
    else {
        return Ok(false);
    };
    let Some(value) = read_remote_json(&user_remote_verification_path(app)?)? else {
        return Ok(false);
    };
    let now = unix_time_ms();
    Ok(remote_verification_matches(
        &value,
        &RemoteVerificationContext {
            configuration_id: &config.configuration_id,
            probe_id: &probe_id,
            runtime_instance_id: &runtime_instance_id,
            process_id,
            runtime_started_at_ms,
            launch_started_at_ms: started_at_ms,
            now_ms: now,
        },
    ))
}

struct RemoteAgentRunGuard<'a> {
    controller: &'a Mutex<Option<RemoteAgentController>>,
    job_id: String,
    target: RemoteAgentTarget,
    consent_revision: String,
    started_at_ms: u128,
    receipt_path: PathBuf,
    status_path: PathBuf,
    finalized: bool,
}

impl Drop for RemoteAgentRunGuard<'_> {
    fn drop(&mut self) {
        if !self.finalized {
            let ended_at_ms = unix_time_ms();
            let result = json!({
                "schema": "editkin.remote-agent-launch-result/v1",
                "truthLabel": REMOTE_AGENT_TRUTH_LABEL,
                "jobId": self.job_id.as_str(),
                "consentRevision": self.consent_revision.as_str(),
                "target": self.target.id(),
                "status": "failed",
                "message": "Remote AI 在完成 durable receipt 前中止；無法證明任何設定進度，請安全重試。",
                "providerId": null,
                "proposalRevision": null,
                "proposalDigest": null,
                "resumedExistingState": false,
                "stateCreatedThisRun": false,
                "manualFallbackAvailable": true,
                "receiptPath": self.receipt_path.as_path(),
                "outputTruncated": false,
                "realPhoneReconnectVerified": false,
                "macVerified": false
            });
            let receipt = json!({
                "schema": "editkin.remote-agent-launch-receipt/v1",
                "truthLabel": REMOTE_AGENT_TRUTH_LABEL,
                "target": self.target.id(),
                "jobId": self.job_id.as_str(),
                "consentRevision": self.consent_revision.as_str(),
                "status": "failed",
                "startedAtMs": self.started_at_ms,
                "endedAtMs": ended_at_ms,
                "durationMs": ended_at_ms.saturating_sub(self.started_at_ms),
                "preSpawnOrFinalizeFailure": true,
                "cleanupConfirmed": false,
                "postcondition": {
                    "providerConfirmationReceiptCreated": false,
                    "desktopApprovalCandidateCreated": false,
                    "freshVerifyRemoteAccessReceipt": false,
                    "realPhoneReconnectVerified": false
                },
                "result": result
            });
            if remote_file_identity_at_path(&self.receipt_path)
                .ok()
                .flatten()
                .is_none()
            {
                let _ = write_remote_json_create_new(&self.receipt_path, &receipt);
            }
            let _ = write_remote_json_atomic(
                &self.status_path,
                &json!({
                    "schema": "editkin.remote-agent-launch-status/v1",
                    "phase": "terminal",
                    "truthLabel": REMOTE_AGENT_TRUTH_LABEL,
                    "jobId": self.job_id.as_str(),
                    "target": self.target.id(),
                    "consentRevision": self.consent_revision.as_str(),
                    "startedAtMs": self.started_at_ms,
                    "endedAtMs": ended_at_ms,
                    "cancelRequested": false,
                    "result": result
                }),
            );
        }
        if let Ok(mut controller) = self.controller.lock() {
            if controller
                .as_ref()
                .is_some_and(|active| active.job_id == self.job_id)
            {
                *controller = None;
            }
        }
    }
}

const REMOTE_AGENT_CONSENT_REVISION: &str = "editkin.remote-agent-consent/v2";
// Codex CLI 0.128 can ignore config.toml and execpolicy rules, but it has no
// supported switch that disables global CODEX_HOME/AGENTS(.override).md.
// Reusing CODEX_HOME is required for the user's existing authentication, so a
// hidden bounded run cannot currently prove instruction isolation. Keep the
// normal, user-visible Codex MCP connection available, but fail closed here.
const CODEX_DIRECT_LAUNCH_INSTRUCTION_ISOLATION_SUPPORTED: bool = false;

fn valid_remote_agent_job_id(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn remote_agent_controller_matches(
    controller: Option<&RemoteAgentController>,
    job_id: &str,
    target: RemoteAgentTarget,
    consent_revision: &str,
) -> bool {
    controller.is_some_and(|active| {
        active.job_id == job_id
            && active.target == target
            && active.consent_revision == consent_revision
    })
}

fn remote_agent_termination_status(
    canceled: bool,
    timed_out: bool,
    cleanup_confirmed: bool,
    termination_failed: bool,
) -> Option<&'static str> {
    if !cleanup_confirmed || termination_failed {
        Some("cleanup_unconfirmed")
    } else if canceled {
        Some("canceled")
    } else if timed_out {
        Some("timed_out")
    } else {
        None
    }
}

fn remote_agent_directory_is_link(metadata: &fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
        return metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0;
    }
    #[cfg(not(windows))]
    false
}

fn ensure_plain_remote_agent_directory(path: &Path, label: &str) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if !metadata.is_dir() || remote_agent_directory_is_link(&metadata) {
                return Err(format!("{label} 必須是本機一般資料夾；link/reparse 已拒絕"));
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir(path).map_err(|error| format!("無法建立 {label}：{error}"))?;
            let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
            if !metadata.is_dir() || remote_agent_directory_is_link(&metadata) {
                return Err(format!("{label} 建立後不是本機一般資料夾"));
            }
        }
        Err(error) => return Err(format!("無法驗證 {label}：{error}")),
    }
    Ok(())
}

fn dedicated_remote_agent_workspace(
    app: &AppHandle,
) -> Result<agent_setup::AgentWorkspace, String> {
    let app_root = application_data_root(app)?;
    if !app_root.is_absolute() {
        return Err("Remote Agent AppData root 不是絕對路徑".into());
    }
    if !app_root.exists() {
        fs::create_dir_all(&app_root)
            .map_err(|error| format!("無法建立 Remote Agent AppData root：{error}"))?;
    }
    ensure_plain_remote_agent_directory(&app_root, "Remote Agent AppData root")?;
    let remote_root = app_root.join("mobile-remote");
    ensure_plain_remote_agent_directory(&remote_root, "Remote Agent state root")?;
    let workspace_path = remote_root.join("remote-agent-workspace");
    ensure_plain_remote_agent_directory(&workspace_path, "Remote Agent 專用工作資料夾")?;
    let canonical_app_root = fs::canonicalize(&app_root).map_err(|error| error.to_string())?;
    let canonical_workspace =
        fs::canonicalize(&workspace_path).map_err(|error| error.to_string())?;
    if !canonical_workspace.starts_with(&canonical_app_root) {
        return Err("Remote Agent 專用工作資料夾逃出 Editkin AppData；已 fail closed".into());
    }
    if fs::read_dir(&canonical_workspace)
        .map_err(|error| error.to_string())?
        .next()
        .transpose()
        .map_err(|error| error.to_string())?
        .is_some()
    {
        return Err("Remote Agent 專用工作資料夾不是空白；請清空後重試".into());
    }
    selected_agent_workspace(Some(&canonical_workspace))?
        .ok_or_else(|| "Remote Agent 專用工作資料夾無法 canonicalize".to_string())
}

fn launch_remote_setup_agent_blocking(
    app: AppHandle,
    target_text: String,
    job_id: String,
    consent_revision: String,
    scope_confirmed: bool,
) -> Result<Value, String> {
    if !valid_remote_agent_job_id(&job_id) {
        return Err("Remote AI jobId 必須是 32 位 lowercase hex".into());
    }
    if consent_revision != REMOTE_AGENT_CONSENT_REVISION {
        return Err("Remote AI consent revision 已過期；請重新閱讀並勾選授權".into());
    }
    if !scope_confirmed {
        return Err("必須先確認 AI 只能處理 Remote；Editkin 只檢查並立即丟棄 loggedIn 狀態，不要求、讀取或保存 key、token、cookie、密碼，CLI 只沿用自己的既有登入，才能啟動".into());
    }
    if !cfg!(windows) {
        return Err("這個 agent launcher 目前只有 Windows internal candidate；Mac 尚未驗證".into());
    }
    let target = RemoteAgentTarget::parse(&target_text)?;
    if target == RemoteAgentTarget::Codex && !CODEX_DIRECT_LAUNCH_INSTRUCTION_ISOLATION_SUPPORTED {
        return Err("Codex CLI 目前無法停用 CODEX_HOME 全域 AGENTS.md；為避免未授權指令進入 Remote-only 工作，Editkin 已停用 Codex 內部自動啟動。請改用可見 Codex 工作階段連接 Editkin MCP，或使用 Claude Code 安全啟動。".into());
    }
    ensure_remote_setup_agent_launchable(&app)?;
    let state = app.state::<AppState>();
    let cancel_requested = Arc::new(AtomicBool::new(false));
    let controller_started_at_ms = unix_time_ms();
    let remote_root = application_data_root(&app)?.join("mobile-remote");
    let receipt_path = remote_root
        .join("agent-launch-receipts")
        .join(format!("{job_id}.json"));
    let reservation_path = remote_root
        .join("agent-launch-reservations")
        .join(format!("{job_id}.json"));
    let status_path = remote_root.join("agent-launch-status.json");
    if remote_file_identity_at_path(&receipt_path)?.is_some() {
        return Err("Remote AI job receipt 已存在；拒絕重播同一 jobId".into());
    }
    write_remote_json_create_new(
        &reservation_path,
        &json!({
            "schema": "editkin.remote-agent-launch-reservation/v1",
            "truthLabel": REMOTE_AGENT_TRUTH_LABEL,
            "jobId": job_id,
            "target": target.id(),
            "consentRevision": consent_revision,
            "reservedAtMs": controller_started_at_ms
        }),
    )
    .map_err(|error| format!("Remote AI jobId 已使用或無法保留；拒絕重播：{error}"))?;
    {
        let mut controller = state
            .remote_agent_controller
            .lock()
            .map_err(|_| "Remote AI controller lock poisoned".to_string())?;
        if controller.is_some() {
            return Err("已有 Remote AI 任務正在執行；請先等待或取消".into());
        }
        *controller = Some(RemoteAgentController {
            job_id: job_id.clone(),
            target,
            consent_revision: consent_revision.clone(),
            started_at_ms: controller_started_at_ms,
            cancel_requested: Arc::clone(&cancel_requested),
        });
    }
    let mut run_guard = RemoteAgentRunGuard {
        controller: &state.remote_agent_controller,
        job_id: job_id.clone(),
        target,
        consent_revision: consent_revision.clone(),
        started_at_ms: controller_started_at_ms,
        receipt_path: receipt_path.clone(),
        status_path: status_path.clone(),
        finalized: false,
    };
    write_remote_json_atomic(
        &status_path,
        &json!({
            "schema": "editkin.remote-agent-launch-status/v1",
            "phase": "running",
            "truthLabel": REMOTE_AGENT_TRUTH_LABEL,
            "jobId": job_id,
            "target": target.id(),
            "consentRevision": consent_revision,
            "startedAtMs": controller_started_at_ms,
            "endedAtMs": null,
            "cancelRequested": false,
            "result": null
        }),
    )?;

    let cli = locate_agent_cli(target.id())
        .ok_or_else(|| format!("找不到 {} CLI；已保留手動複製任務", target.display_name()))?;
    let process_environment = remote_agent_process_environment(target)?;
    let contract = editkin_agent_setup_contract()?;
    let launcher_contract = editkin_agent_launcher_contract(&contract)?;
    let state_directory = launcher_contract
        .get("stateDirectoryName")
        .and_then(Value::as_str)
        .ok_or("Embedded Agent launcher contract has no state directory")?;
    let runtime = runtime_paths(&app)?;
    let generation_state_root = application_data_root(&app)?.join(state_directory);
    let generation = activate_product_agent_generation(
        &generation_state_root,
        &ProductAgentGenerationPaths {
            resource_root: runtime.resource_root.clone(),
            embedded_contract: runtime.agent_contract.clone(),
            entrypoint: runtime.mcp.clone(),
            entrypoint_identity: runtime.mcp_identity.clone(),
            ffmpeg: runtime.ffmpeg.clone(),
            ffprobe: runtime.ffprobe.clone(),
            gpu_compositor: runtime.gpu_compositor.clone(),
            launcher: runtime.agent_launcher.clone(),
            native_core: runtime.native_core.clone(),
            node: runtime.node.clone(),
            node_manifest: runtime.node_manifest.clone(),
            whisper: runtime.whisper_cli.clone(),
            color: runtime.color_root.clone(),
            creative_pack: runtime.creative_pack_root.clone(),
            fonts: runtime.font_root.clone(),
            personal_music: runtime.personal_music_root.clone(),
            personal_visual: runtime.personal_visual_root.clone(),
            plugins: runtime
                .plugin_roots
                .first()
                .cloned()
                .ok_or("Editkin 沒有可綁定的內建 plugin root")?,
        },
        EDITKIN_AGENT_SETUP_CONTRACT.as_bytes(),
    )?;
    let generation_root = generation.state_root.clone();
    let workspace = match dedicated_remote_agent_workspace(&app) {
        Ok(workspace) => workspace,
        Err(error) => {
            rollback_product_agent_generation(&generation)?;
            return Err(error);
        }
    };
    if target == RemoteAgentTarget::Claude && !agent_login_ready(target, &cli) {
        rollback_product_agent_generation(&generation)?;
        return Err(format!(
            "無法證明 {} CLI 已登入；Editkin 只檢查並立即丟棄 loggedIn 狀態，不要求、讀取或保存 key、token、cookie、密碼，CLI 只沿用自己的既有登入，本次已 fail closed",
            target.display_name()
        ));
    }

    let pre_spawn_receipts = (|| {
        let pending_path = user_remote_setup_pending_path(&app)?;
        let candidate_path = user_remote_network_candidate_path(&app)?;
        let pending_snapshot = read_remote_json_with_identity(&pending_path)?;
        let pending_before = pending_snapshot.as_ref().map(|(_, identity)| *identity);
        let pending_before_record = pending_snapshot
            .map(|(value, _)| parse_pending_remote_setup_record(value))
            .transpose()?;
        let candidate_before = remote_file_identity_at_path(&candidate_path)?;
        Ok::<_, String>((
            pending_path,
            candidate_path,
            pending_before,
            pending_before_record,
            candidate_before,
        ))
    })();
    let (pending_path, candidate_path, pending_before, pending_before_record, candidate_before) =
        match pre_spawn_receipts {
            Ok(receipts) => receipts,
            Err(error) => {
                rollback_product_agent_generation(&generation)?;
                return Err(error);
            }
        };
    let started_at_ms = controller_started_at_ms;
    let launch_environment = match remote_only_agent_environment(
        &generation_root,
        workspace.path(),
        &job_id,
        &consent_revision,
    ) {
        Ok(environment) => environment,
        Err(error) => {
            rollback_product_agent_generation(&generation)?;
            return Err(error);
        }
    };
    let actual_environment_keys = launch_environment
        .iter()
        .map(|(key, _)| key.clone())
        .collect::<BTreeSet<_>>();
    let expected_environment_keys = [
        "EDITKIN_AGENT_STATE_ROOT",
        "EDITKIN_MCP_MODE",
        "EDITKIN_REMOTE_AGENT_CONSENT_REVISION",
        "EDITKIN_REMOTE_AGENT_JOB_ID",
        "EDITKIN_WORKSPACE",
        "ELECTRON_RUN_AS_NODE",
    ]
    .into_iter()
    .map(str::to_string)
    .collect::<BTreeSet<_>>();
    if actual_environment_keys != expected_environment_keys {
        rollback_product_agent_generation(&generation)?;
        return Err("BLOCK_SCOPE_NOT_CLOSED：Remote-only MCP environment contract drifted".into());
    }
    let codex_mcp = CodexClosedMcp {
        command: &runtime.node,
        launcher: &runtime.agent_launcher,
        environment: &launch_environment,
    };
    let mut args = cli
        .prefix_args
        .iter()
        .map(OsString::from)
        .collect::<Vec<_>>();
    let launch_args = match target.launch_args(workspace.path(), Some(&codex_mcp)) {
        Ok(args) => args,
        Err(error) => {
            rollback_product_agent_generation(&generation)?;
            return Err(error);
        }
    };
    args.extend(launch_args);
    if let Err(error) = verify_agent_cli_identity(&cli) {
        rollback_product_agent_generation(&generation)?;
        return Err(error);
    }
    let preview_process_platform::Spawned {
        mut process,
        mut stdin,
        stdout,
        stderr,
    } = match preview_process_platform::spawn_with_environment_and_cwd(
        &cli.command,
        &args,
        &process_environment,
        workspace.path(),
    ) {
        Ok(spawned) => spawned,
        Err(error) => {
            rollback_product_agent_generation(&generation)?;
            return Err(format!("無法安全啟動 {}：{error}", target.display_name()));
        }
    };
    let (stdout_sender, stdout_receiver) = mpsc::sync_channel(1);
    let (stderr_sender, stderr_receiver) = mpsc::sync_channel(1);
    thread::spawn(move || {
        let _ = stdout_sender.send(read_bounded(stdout, REMOTE_AGENT_OUTPUT_LIMIT_BYTES));
    });
    thread::spawn(move || {
        let _ = stderr_sender.send(read_bounded(stderr, REMOTE_AGENT_OUTPUT_LIMIT_BYTES));
    });
    let input_error = stdin
        .write_all(remote_agent_task_prompt().as_bytes())
        .and_then(|_| stdin.write_all(b"\n"))
        .and_then(|_| stdin.flush())
        .err()
        .map(|error| error.to_string());
    drop(stdin);

    let deadline = Instant::now() + Duration::from_secs(REMOTE_AGENT_TIMEOUT_SECONDS);
    let mut exit_code = None;
    let mut canceled = false;
    let mut timed_out = false;
    let mut process_wait_error = None;
    if input_error.is_none() {
        loop {
            if cancel_requested.load(Ordering::SeqCst) {
                canceled = true;
                break;
            }
            if Instant::now() >= deadline {
                timed_out = true;
                break;
            }
            match process.try_wait() {
                Ok(Some(code)) => {
                    exit_code = Some(code);
                    break;
                }
                Ok(None) => thread::sleep(Duration::from_millis(50)),
                Err(error) => {
                    process_wait_error = Some(error.to_string());
                    break;
                }
            }
        }
    }
    let termination_error = process
        .terminate_tree()
        .err()
        .map(|error| error.to_string());
    let cleanup_deadline = Instant::now() + Duration::from_secs(3);
    let mut cleanup_confirmed = false;
    while Instant::now() < cleanup_deadline {
        match process.tree_is_empty() {
            Ok(true) => {
                cleanup_confirmed = true;
                break;
            }
            Ok(false) => thread::sleep(Duration::from_millis(25)),
            Err(_) => break,
        }
    }
    let stdout = stdout_receiver
        .recv_timeout(Duration::from_secs(3))
        .unwrap_or(BoundedCapture {
            bytes: Vec::new(),
            observed_bytes: 0,
            truncated: true,
            read_error: Some("stdout drain timeout".into()),
        });
    let stderr = stderr_receiver
        .recv_timeout(Duration::from_secs(3))
        .unwrap_or(BoundedCapture {
            bytes: Vec::new(),
            observed_bytes: 0,
            truncated: true,
            read_error: Some("stderr drain timeout".into()),
        });
    let ended_at_ms = unix_time_ms();
    let controller_binding_confirmed =
        state
            .remote_agent_controller
            .lock()
            .ok()
            .is_some_and(|controller| {
                remote_agent_controller_matches(
                    controller.as_ref(),
                    &job_id,
                    target,
                    &consent_revision,
                )
            });

    let postcondition = (|| {
        let pending_after = remote_file_identity_at_path(&pending_path)?;
        let candidate_after = remote_file_identity_at_path(&candidate_path)?;
        let pending_changed = pending_after != pending_before;
        if pending_before.is_some() && pending_after.is_none() {
            return Err(
                "Remote-only Agent 移除了既有 proposal／confirmation；已拒絕歸因進度".into(),
            );
        }
        let pending = if pending_after.is_some() {
            let (value, identity) = read_remote_json_with_identity(&pending_path)?
                .ok_or("Remote AI proposal 在 post-state 驗證期間消失")?;
            if Some(identity) != pending_after {
                return Err("Remote AI proposal identity 與 post-state snapshot 不一致".into());
            }
            Some(parse_pending_remote_setup_record(value)?)
        } else {
            None
        };
        if candidate_after != candidate_before {
            return Err(
                "Remote-only Agent 無權建立桌面候選；偵測到外部 mutation，拒絕歸因目前 job".into(),
            );
        }
        let candidate: Option<PendingUserRemoteNetworkConfig> = None;
        if pending_changed {
            match pending.as_ref() {
                Some(PendingRemoteSetupRecord::ProviderProposal(proposal)) => {
                    if proposal.job_id != job_id || proposal.consent_revision != consent_revision {
                        return Err(
                            "Remote provider proposal 未綁定目前 job／consent revision".into()
                        );
                    }
                    if let Some(PendingRemoteSetupRecord::ProviderProposal(previous)) =
                        pending_before_record.as_ref()
                    {
                        if proposal.workflow_id != previous.workflow_id
                            || proposal.proposal_revision == previous.proposal_revision
                            || proposal.created_at_ms < previous.expires_at_ms
                        {
                            return Err("Remote provider proposal renewal 未保留 workflow 或在 expiry 前被覆寫".into());
                        }
                    } else if pending_before_record.is_some() {
                        return Err(
                            "Remote-only Agent 不可把 legacy confirmation 改名成新版 proposal"
                                .into(),
                        );
                    }
                }
                Some(PendingRemoteSetupRecord::Legacy(pending)) => {
                    if pending.remote_agent_job_id.as_deref() != Some(job_id.as_str())
                        || pending.remote_agent_consent_revision.as_deref()
                            != Some(consent_revision.as_str())
                    {
                        return Err(
                            "Remote AI legacy confirmation 未綁定目前 job／consent revision".into(),
                        );
                    }
                }
                Some(PendingRemoteSetupRecord::LegacyProviderProposal) => {
                    return Err("Remote-only Agent 無權新建或覆寫 proposal v1；缺少 connector identity 與 plan digest".into());
                }
                None => {
                    return Err("Remote AI pending identity 改變但沒有可驗證 record".into());
                }
            }
        }
        let fresh_verification =
            fresh_remote_route_verification_since(&app, &state, started_at_ms)?;
        Ok::<_, String>((pending, candidate, fresh_verification, pending_changed))
    })();
    let (pending, candidate, fresh_verification, pending_changed, postcondition_error) =
        match postcondition {
            Ok((pending, candidate, fresh_verification, pending_changed)) => (
                pending,
                candidate,
                fresh_verification,
                pending_changed,
                None,
            ),
            Err(error) => (None, None, false, false, Some(error)),
        };
    let successful_exit = exit_code == Some(0)
        && input_error.is_none()
        && process_wait_error.is_none()
        && stdout.read_error.is_none()
        && stderr.read_error.is_none()
        && !stdout.truncated
        && !stderr.truncated
        && controller_binding_confirmed
        && postcondition_error.is_none()
        && cleanup_confirmed
        && termination_error.is_none();
    let termination_status = remote_agent_termination_status(
        canceled,
        timed_out,
        cleanup_confirmed,
        termination_error.is_some(),
    );
    let resumed_existing_state = pending.is_some() && !pending_changed;
    let proposal_revision = pending.as_ref().and_then(|record| match record {
        PendingRemoteSetupRecord::ProviderProposal(proposal) => {
            Some(proposal.proposal_revision.clone())
        }
        PendingRemoteSetupRecord::Legacy(_) | PendingRemoteSetupRecord::LegacyProviderProposal => {
            None
        }
    });
    let proposal_digest = pending.as_ref().and_then(|record| match record {
        PendingRemoteSetupRecord::ProviderProposal(proposal) => {
            Some(proposal.proposal_digest.clone())
        }
        PendingRemoteSetupRecord::Legacy(_) | PendingRemoteSetupRecord::LegacyProviderProposal => {
            None
        }
    });
    let (status, message, provider_id) = if let Some(status) = termination_status {
        let message = match status {
            "canceled" => {
                "已取消 Remote AI 任務，整棵子行程已確認清理；你仍可複製任務手動繼續。"
            }
            "timed_out" => {
                "Remote AI 超過 5 分鐘上限，整棵子行程已確認清理並保留手動備援。"
            }
            _ => "Remote AI 已結束，但無法證明整棵子行程完成清理；本次不視為成功，也不宣稱已停止所有子行程。",
        };
        (status, message.to_string(), None)
    } else if postcondition_error.is_some() {
        (
            "failed",
            "Remote AI 已清理子行程，但 post-state identity/receipt 驗證失敗；本次不視為進度。"
                .to_string(),
            None,
        )
    } else if input_error.is_some() {
        (
            "failed",
            format!(
                "無法把 bounded 任務送給 {}；整棵子行程已確認清理，已保留手動備援。",
                target.display_name()
            ),
            None,
        )
    } else if !successful_exit {
        (
            "failed",
            format!(
                "{} 沒有成功完成 bounded 任務；已保留手動複製備援。",
                target.display_name()
            ),
            None,
        )
    } else if fresh_verification {
        ("route_partial_verified", "已由既有 verify_remote_access 產生全新、綁定目前 runtime 的兩次 TLS 實測；真手機斷線重連仍待驗證。".to_string(), None)
    } else if let Some(candidate) = candidate.as_ref() {
        (
            "desktop_approval_required",
            format!(
                "AI 已建立 {} 的非機密候選；請在 Editkin 核對供應商與 {} 後親自核准。",
                candidate.configuration.provider_id, candidate.configuration.origin
            ),
            Some(candidate.configuration.provider_id.clone()),
        )
    } else if let Some(pending) = pending.as_ref() {
        match pending {
            PendingRemoteSetupRecord::ProviderProposal(proposal)
                if proposal.expires_at_ms <= u64::try_from(ended_at_ms).unwrap_or(u64::MAX) =>
            {
                (
                    "no_verified_progress",
                    format!(
                        "{} 的 Remote 方案已過期且未獲核准；本次沒有建立可用的新方案、沒有登入，也沒有部署。",
                        proposal.provider.display_name
                    ),
                    Some(proposal.provider.id.clone()),
                )
            }
            PendingRemoteSetupRecord::ProviderProposal(proposal) => (
                "provider_confirmation_required",
                format!(
                    "AI 已保留 {} 的可檢查方案；價格、配額、權限、預計異動與公開來源已結構化保存。尚未登入、尚未部署、尚未連線，請回 Editkin 檢查。",
                    proposal.provider.display_name
                ),
                Some(proposal.provider.id.clone()),
            ),
            PendingRemoteSetupRecord::Legacy(pending) => (
                "provider_confirmation_required",
                format!(
                    "找到 {} 的舊版供應商識別確認單，但它缺少價格、配額、權限與來源，不能當作新版核准或部署依據。",
                    pending.provider_id
                ),
                Some(pending.provider_id.clone()),
            ),
            PendingRemoteSetupRecord::LegacyProviderProposal => (
                "no_verified_progress",
                "找到 proposal v1；它缺少 connector identity 與 plan digest，不能核准、續接或當成已部署。".to_string(),
                Some("legacy-proposal-v1".to_string()),
            ),
        }
    } else {
        (
            "no_verified_progress",
            "AI 行程已正常結束，但沒有新的確認單、桌面候選或 verify receipt；本次不視為完成。"
                .to_string(),
            None,
        )
    };
    let result = json!({
        "schema": "editkin.remote-agent-launch-result/v1",
        "truthLabel": REMOTE_AGENT_TRUTH_LABEL,
        "jobId": job_id,
        "consentRevision": consent_revision,
        "target": target.id(),
        "status": status,
        "message": message,
        "providerId": provider_id,
        "proposalRevision": proposal_revision,
        "proposalDigest": proposal_digest,
        "resumedExistingState": resumed_existing_state,
        "stateCreatedThisRun": pending_changed,
        "manualFallbackAvailable": true,
        "receiptPath": receipt_path,
        "outputTruncated": stdout.truncated || stderr.truncated,
        "realPhoneReconnectVerified": false,
        "macVerified": false
    });
    let receipt = json!({
        "schema": "editkin.remote-agent-launch-receipt/v1",
        "truthLabel": REMOTE_AGENT_TRUTH_LABEL,
        "target": target.id(),
        "jobId": job_id,
        "consentRevision": consent_revision,
        "status": status,
        "startedAtMs": started_at_ms,
        "endedAtMs": ended_at_ms,
        "durationMs": ended_at_ms.saturating_sub(started_at_ms),
        "exitCode": exit_code,
        "canceled": canceled,
        "timedOut": timed_out,
        "cleanupConfirmed": cleanup_confirmed,
        "terminationError": termination_error,
        "stdinWriteFailed": input_error.is_some(),
        "processWaitFailed": process_wait_error.is_some(),
        "controllerBindingConfirmed": controller_binding_confirmed,
        "postconditionReadFailed": postcondition_error.is_some(),
        "stdout": { "observedBytes": stdout.observed_bytes, "keptBytes": stdout.bytes.len(), "truncated": stdout.truncated },
        "stderr": { "observedBytes": stderr.observed_bytes, "keptBytes": stderr.bytes.len(), "truncated": stderr.truncated },
        "pipeReadFailed": stdout.read_error.is_some() || stderr.read_error.is_some(),
        "postcondition": {
            "providerConfirmationReceiptCreated": pending.is_some(),
            "providerProposalPresent": matches!(pending.as_ref(), Some(PendingRemoteSetupRecord::ProviderProposal(_))),
            "stateCreatedThisRun": pending_changed,
            "resumedExistingState": resumed_existing_state,
            "desktopApprovalCandidateCreated": candidate.is_some(),
            "freshVerifyRemoteAccessReceipt": fresh_verification,
            "realPhoneReconnectVerified": false
        },
        "result": result
    });
    write_remote_json_create_new(&receipt_path, &receipt)?;
    write_remote_json_atomic(
        &status_path,
        &json!({
        "schema": "editkin.remote-agent-launch-status/v1",
        "phase": "terminal",
        "truthLabel": REMOTE_AGENT_TRUTH_LABEL,
        "jobId": job_id,
        "target": target.id(),
        "consentRevision": consent_revision,
        "startedAtMs": started_at_ms,
        "endedAtMs": ended_at_ms,
        "cancelRequested": false,
        "result": result
        }),
    )?;
    run_guard.finalized = true;
    Ok(result)
}

#[tauri::command]
async fn launch_remote_setup_agent(
    app: AppHandle,
    target: String,
    job_id: String,
    consent_revision: String,
    scope_confirmed: bool,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        launch_remote_setup_agent_blocking(app, target, job_id, consent_revision, scope_confirmed)
    })
    .await
    .map_err(|error| format!("Remote AI 背景任務失敗：{error}"))?
}

fn valid_remote_agent_launch_result(value: &Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    let expected = [
        "consentRevision",
        "jobId",
        "macVerified",
        "manualFallbackAvailable",
        "message",
        "outputTruncated",
        "providerId",
        "proposalDigest",
        "proposalRevision",
        "realPhoneReconnectVerified",
        "receiptPath",
        "resumedExistingState",
        "schema",
        "stateCreatedThisRun",
        "status",
        "target",
        "truthLabel",
    ]
    .into_iter()
    .collect::<BTreeSet<_>>();
    let actual = object.keys().map(String::as_str).collect::<BTreeSet<_>>();
    let valid_status = matches!(
        value.get("status").and_then(Value::as_str),
        Some(
            "provider_confirmation_required"
                | "desktop_approval_required"
                | "route_partial_verified"
                | "no_verified_progress"
                | "failed"
                | "canceled"
                | "timed_out"
                | "cleanup_unconfirmed"
        )
    );
    actual == expected
        && value.get("schema").and_then(Value::as_str)
            == Some("editkin.remote-agent-launch-result/v1")
        && value.get("truthLabel").and_then(Value::as_str) == Some(REMOTE_AGENT_TRUTH_LABEL)
        && value
            .get("jobId")
            .and_then(Value::as_str)
            .is_some_and(valid_remote_agent_job_id)
        && value.get("consentRevision").and_then(Value::as_str)
            == Some(REMOTE_AGENT_CONSENT_REVISION)
        && matches!(
            value.get("target").and_then(Value::as_str),
            Some("codex" | "claude")
        )
        && valid_status
        && value
            .get("message")
            .and_then(Value::as_str)
            .is_some_and(|message| !message.trim().is_empty() && message.len() <= 4_096)
        && value.get("providerId").is_some_and(|provider| {
            provider.is_null() || provider.as_str().is_some_and(valid_remote_provider_id)
        })
        && value.get("proposalRevision").is_some_and(|revision| {
            revision.is_null() || revision.as_str().is_some_and(valid_candidate_revision)
        })
        && value.get("proposalDigest").is_some_and(|digest| {
            digest.is_null()
                || digest.as_str().is_some_and(|digest| {
                    digest.len() == 64
                        && digest
                            .bytes()
                            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
                })
        })
        && value
            .get("resumedExistingState")
            .and_then(Value::as_bool)
            .is_some()
        && value
            .get("stateCreatedThisRun")
            .and_then(Value::as_bool)
            .is_some()
        && value.get("proposalRevision").is_some_and(Value::is_null)
            == value.get("proposalDigest").is_some_and(Value::is_null)
        && !(value.get("resumedExistingState").and_then(Value::as_bool) == Some(true)
            && value.get("stateCreatedThisRun").and_then(Value::as_bool) == Some(true))
        && value
            .get("manualFallbackAvailable")
            .and_then(Value::as_bool)
            == Some(true)
        && value
            .get("receiptPath")
            .and_then(Value::as_str)
            .is_some_and(|path| !path.trim().is_empty() && path.len() <= 4_096)
        && value
            .get("outputTruncated")
            .and_then(Value::as_bool)
            .is_some()
        && value
            .get("realPhoneReconnectVerified")
            .and_then(Value::as_bool)
            == Some(false)
        && value.get("macVerified").and_then(Value::as_bool) == Some(false)
}

#[tauri::command]
fn get_remote_setup_agent_status(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    if let Some(active) = state
        .remote_agent_controller
        .lock()
        .map_err(|_| "Remote AI controller lock poisoned".to_string())?
        .as_ref()
    {
        return Ok(json!({
            "schema": "editkin.remote-agent-launch-status/v1",
            "phase": "running",
            "truthLabel": REMOTE_AGENT_TRUTH_LABEL,
            "jobId": active.job_id,
            "target": active.target.id(),
            "consentRevision": active.consent_revision,
            "startedAtMs": active.started_at_ms,
            "endedAtMs": null,
            "cancelRequested": active.cancel_requested.load(Ordering::SeqCst),
            "result": null
        }));
    }
    let path = application_data_root(&app)?
        .join("mobile-remote")
        .join("agent-launch-status.json");
    let Some(value) = read_remote_json(&path)? else {
        return Ok(json!({
            "schema": "editkin.remote-agent-launch-status/v1",
            "phase": "idle",
            "truthLabel": REMOTE_AGENT_TRUTH_LABEL,
            "jobId": null,
            "target": null,
            "consentRevision": null,
            "startedAtMs": null,
            "endedAtMs": null,
            "cancelRequested": false,
            "result": null
        }));
    };
    let object = value
        .as_object()
        .ok_or("Remote AI durable status 格式不合法")?;
    let expected = [
        "cancelRequested",
        "consentRevision",
        "endedAtMs",
        "jobId",
        "phase",
        "result",
        "schema",
        "startedAtMs",
        "target",
        "truthLabel",
    ]
    .into_iter()
    .collect::<BTreeSet<_>>();
    let actual = object.keys().map(String::as_str).collect::<BTreeSet<_>>();
    if actual != expected
        || value.get("schema").and_then(Value::as_str)
            != Some("editkin.remote-agent-launch-status/v1")
        || value.get("truthLabel").and_then(Value::as_str) != Some(REMOTE_AGENT_TRUTH_LABEL)
        || !value
            .get("jobId")
            .and_then(Value::as_str)
            .is_some_and(valid_remote_agent_job_id)
        || value.get("consentRevision").and_then(Value::as_str)
            != Some(REMOTE_AGENT_CONSENT_REVISION)
        || !matches!(
            value.get("target").and_then(Value::as_str),
            Some("codex" | "claude")
        )
        || value.get("startedAtMs").and_then(Value::as_u64).is_none()
        || value
            .get("cancelRequested")
            .and_then(Value::as_bool)
            .is_none()
    {
        return Err("Remote AI durable status 未通過 closed-world 驗證".into());
    }
    if value.get("phase").and_then(Value::as_str) == Some("terminal")
        && value
            .get("endedAtMs")
            .and_then(Value::as_u64)
            .zip(value.get("startedAtMs").and_then(Value::as_u64))
            .is_some_and(|(ended, started)| ended >= started)
        && value
            .get("result")
            .is_some_and(valid_remote_agent_launch_result)
        && value.get("result").and_then(|result| result.get("jobId")) == value.get("jobId")
        && value.get("result").and_then(|result| result.get("target")) == value.get("target")
        && value
            .get("result")
            .and_then(|result| result.get("consentRevision"))
            == value.get("consentRevision")
    {
        return Ok(value);
    }
    if value.get("phase").and_then(Value::as_str) == Some("running")
        && value.get("endedAtMs").is_some_and(Value::is_null)
        && value.get("result").is_some_and(Value::is_null)
    {
        let mut interrupted = value;
        interrupted["phase"] = Value::from("interrupted");
        interrupted["cancelRequested"] = Value::from(false);
        return Ok(interrupted);
    }
    Err("Remote AI durable status phase／result 不一致".into())
}

#[tauri::command]
fn cancel_remote_setup_agent(state: State<'_, AppState>, job_id: String) -> Value {
    let valid = valid_remote_agent_job_id(&job_id);
    let controller = state.remote_agent_controller.lock().ok();
    let active = controller
        .as_deref()
        .and_then(Option::as_ref)
        .filter(|active| valid && active.job_id == job_id);
    if let Some(active) = active {
        active.cancel_requested.store(true, Ordering::SeqCst);
    }
    json!({
        "jobId": job_id,
        "running": active.is_some(),
        "cancelRequested": active.is_some(),
        "matchedActiveJob": active.is_some()
    })
}

#[tauri::command(async)]
fn copy_agent_setup(
    app: AppHandle,
    webview: tauri::Webview,
    target: String,
    ui_locale: Option<String>,
    workspace_token: Option<String>,
    on_progress: Option<tauri::ipc::JavaScriptChannelId>,
) -> Result<Value, String> {
    if target != "codex" && target != "claude" {
        return Err("不支援的 Agent 目標".to_string());
    }
    // One attempt, one log under <app data>/logs; every failure is a structured result (agent_connect). The agent
    // CLI is detected before any folder is chosen so a missing CLI is reported, with its fix, first. The Video
    // Autopilot Skill is reported as vaSkill and never required to connect (#106). Runs off the main thread so
    // the progress channel reaches the screen while the setup works.
    let window = webview.label().to_string();
    let mut attempt = agent_connect::AgentConnectAttempt::begin(&app, &target);
    if let Some(id) = on_progress {
        let channel: tauri::ipc::Channel<Value> = id.channel_on(webview);
        attempt.report_progress(Box::new(move |event| {
            let _ = channel.send(event);
        }));
    }
    if let Some(failure) = attempt.detect() {
        return Ok(failure);
    }
    let workspace = match workspace_token {
        // A folder chosen natively a moment ago (suggest_agent_workspace / pick_agent_workspace): the webview only
        // ever holds an opaque single-use token, never a path it could choose itself.
        Some(token) => match attempt.workspace_from_token(&token, &window) {
            Ok(workspace) => workspace,
            Err(failure) => return Ok(failure),
        },
        None => {
            // Selection is the sole workspace authority. Cancel before runtime_paths,
            // probes or CLI work: those steps may create caches or change host config.
            let selected = FileDialog::new()
                .set_title(native_dialog_labels::text(ui_locale.as_deref(), DialogText::AgentFolder))
                .pick_folder();
            match selected_agent_workspace(selected.as_deref()) {
                Ok(Some(workspace)) => match agent_connect::workspace_safety(workspace.path()) {
                    Ok(()) => workspace,
                    Err(message) => return Ok(attempt.workspace_unsafe(&message)),
                },
                Ok(None) => {
                    attempt.discard();
                    return Ok(json!({
                        "canceled": true, "target": target,
                        "message": "已取消選擇工作資料夾；沒有變更 Codex／Claude 設定"
                    }));
                }
                Err(message) => return Ok(attempt.workspace_rejected(&message)),
            }
        }
    };
    Ok(attempt.run(&app, &workspace))
}

#[tauri::command]
fn release_input_manifest() -> Result<Value, String> {
    serde_json::from_str(RELEASE_INPUT_MANIFEST)
        .map_err(|error| format!("Embedded build manifest is invalid: {error}"))
}

/// Test, smoke and research commands stay outside the static main-window capability. They are
/// granted at runtime only inside the isolated integration runtime (or a research build), so the
/// shipped IPC surface never exposes them.
fn grant_isolated_runtime_commands(app: &AppHandle) -> tauri::Result<()> {
    if env::var("EDITKIN_INTEGRATION_SMOKE").as_deref() == Ok("1") {
        app.add_capability(
            tauri::ipc::CapabilityBuilder::new("integration-smoke-commands")
                .window("main")
                .permission("allow-render-project-smoke")
                .permission("allow-render-openexr-sequence-smoke")
                .permission("allow-batch-auto-edit-smoke")
                .permission("allow-inject-gpu-device-loss-for-test"),
        )?;
    }
    #[cfg(feature = "auto-roto-research")]
    app.add_capability(
        tauri::ipc::CapabilityBuilder::new("auto-roto-research-commands")
            .window("main")
            .permission("allow-inspect-auto-roto-video-model")
            .permission("allow-install-auto-roto-video-model")
            .permission("allow-pick-and-install-auto-roto-video-model")
            .permission("allow-repair-auto-roto-video-model"),
    )?;
    Ok(())
}

// ---- In-app template Shorts (M1 wave 4.1): the easy flow's 「直的短影音」 path -----------------------------------
// One owned `node mcp.mjs --editkin-one-shot` child per job with a closed environment, a no-progress watchdog and a
// kill on cancel. The logic and its unit tests live in template_short.rs; these are the IPC entry points.

fn template_short_launch(
    app: &AppHandle,
    workspace: &Path,
) -> Result<(RuntimePaths, Vec<(OsString, OsString)>), String> {
    let runtime = runtime_paths(app)?;
    if !runtime.mcp.is_file() || !runtime.mcp_identity.is_file() {
        return Err("找不到 Editkin 的自動剪輯程式（mcp.mjs 與它的素材色彩身份檔）".into());
    }
    let tools = template_short::ChildTools {
        python: template_short::discover_python(
            env::var_os("EDITKIN_PYTHON_EXECUTABLE"),
            env::var_os("PATH"),
        ),
        video_autopilot_skill: env::var_os("EDITKIN_VIDEO_AUTOPILOT_SKILL")
            .map(PathBuf::from)
            .or_else(|| {
                app.path().home_dir().ok().map(|home| {
                    home.join(".codex")
                        .join("skills")
                        .join("video-autopilot")
                        .join("SKILL.md")
                })
            })
            .filter(|path| path.is_absolute() && path.is_file()),
        workflow_profile: workflow_profile_path(app).ok(),
    };
    let environment = template_short::template_short_child_environment(
        &runtime,
        workspace,
        &tools,
        &|key| env::var_os(key),
    )?;
    if cfg!(windows) && !environment.iter().any(|(key, _)| key == "SYSTEMROOT") {
        return Err("缺少 Windows SYSTEMROOT；不以不完整的環境啟動自動剪輯".into());
    }
    Ok((runtime, environment))
}

fn template_short_workspace_source(
    source_path: &str,
) -> Result<template_short::WorkspaceSource, String> {
    if local_path_text_problem(source_path) == Some(LocalPathProblem::NetworkOrDevice) {
        return Err("請先把影片複製到這台電腦的磁碟".into());
    }
    template_short::resolve_workspace_source(source_path)?
        .ok_or_else(|| "這支影片不在工作資料夾裡".to_string())
}

#[tauri::command(async)]
fn template_short_prepare(source_path: String) -> Result<Value, String> {
    if local_path_text_problem(&source_path) == Some(LocalPathProblem::NetworkOrDevice) {
        return Err("請先把影片複製到這台電腦的磁碟".into());
    }
    template_short::prepare_status(&source_path)
}

/// Writes `.autopilot/template-short-defaults.json` only after the creator's explicit 「是，這是我自己拍的素材」 click
/// (`confirmed`), and only when the file does not exist yet; an existing file is never replaced.
#[tauri::command]
async fn template_short_confirm_rights(
    app: AppHandle,
    source_path: String,
    brand_mark: Option<String>,
    confirmed: bool,
) -> Result<Value, String> {
    if !confirmed {
        return Err("沒有確認是自己拍的素材；沒有寫入任何設定".into());
    }
    let source = template_short_workspace_source(&source_path)?;
    if template_short::defaults_present(&source.workspace) {
        return Ok(json!({ "written": false, "exists": true }));
    }
    let brand_mark = template_short::validate_brand_mark(brand_mark)?;
    let (runtime, environment) = template_short_launch(&app, &source.workspace)?;
    let mut payload = json!({
        "confirmedByCreatorClick": true,
        "scope": source.scope,
        "scopeKind": if source.scope_is_file { "file" } else { "folder" },
    });
    if let Some(mark) = brand_mark {
        payload["brandMark"] = json!(mark);
    }
    let request = json!({ "command": "template_short_write_defaults", "payload": payload });
    tauri::async_runtime::spawn_blocking(move || {
        template_short::run_one_shot(
            &runtime.node,
            &runtime.mcp,
            &environment,
            &source.workspace,
            &request,
            Duration::from_secs(90),
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command(async)]
fn start_template_short_job(
    app: AppHandle,
    state: State<'_, AppState>,
    source_path: String,
    genre: String,
    copy: Value,
) -> Result<Value, String> {
    if !template_short::GENRES.contains(&genre.as_str()) {
        return Err("影片類型不合法".into());
    }
    let copy = template_short::validate_copy(&copy)?;
    let source = template_short_workspace_source(&source_path)?;
    if !template_short::defaults_present(&source.workspace) {
        return Err("還沒有確認這些影片是你自己拍的".into());
    }
    let (runtime, environment) = template_short_launch(&app, &source.workspace)?;
    let job_root = application_data_root(&app)?.join("template-short-jobs");
    let job_id = state.template_short.start(template_short::JobLaunch {
        node: runtime.node,
        script: runtime.mcp,
        environment,
        workspace: source.workspace,
        request: json!({ "command": "template_short_run", "payload": {
            "sourcePath": source.relative, "genre": genre, "copy": copy,
        } }),
        job_root,
        no_progress_limit: template_short::NO_PROGRESS_LIMIT,
    })?;
    Ok(json!({ "jobId": job_id }))
}

#[tauri::command]
fn template_short_job_status(
    app: AppHandle,
    state: State<'_, AppState>,
    job_id: String,
) -> Result<Value, String> {
    let (status, output) = state
        .template_short
        .status(&job_id)
        .ok_or("找不到這個自動剪輯工作")?;
    if let Some(output) = output {
        allow_path(&app, &output.to_string_lossy())?;
    }
    Ok(status)
}

#[tauri::command]
fn cancel_template_short_job(state: State<'_, AppState>, job_id: String) -> Value {
    json!({ "jobId": job_id, "canceled": state.template_short.cancel(&job_id) })
}

/// Copies the delivered mp4 into the system Videos folder under the creator's title; never replaces a file.
#[tauri::command(async)]
fn save_template_short_video(
    app: AppHandle,
    state: State<'_, AppState>,
    job_id: String,
    file_name: String,
) -> Result<Value, String> {
    let output = state
        .template_short
        .delivered_output(&job_id)
        .ok_or("這支短影音還沒有做好")?;
    let videos = app
        .path()
        .video_dir()
        .map(process_compatible_path)
        .map_err(|error| format!("找不到「影片」資料夾：{error}"))?;
    let saved = template_short::save_video_copy(&output, &videos, &file_name, "Editkin Short")?;
    Ok(json!({
        "path": saved.to_string_lossy(),
        "fileName": saved.file_name().map(|name| name.to_string_lossy().to_string()),
        "folderName": videos.file_name().map(|name| name.to_string_lossy().to_string()),
    }))
}

/// 「我想自己細調」: the new Short project (never the creator's open project), with its preview paths.
#[tauri::command]
async fn open_template_short_project(app: AppHandle, job_id: String) -> Result<Value, String> {
    let project_path = app
        .state::<AppState>()
        .template_short
        .delivered_project(&job_id)
        .ok_or("這支短影音的專案還沒有做好")?;
    let path = project_path.to_string_lossy().to_string();
    let opened = call_service(&app, "read_project", json!({ "path": path, "captureFileIdentity": true })).await?;
    let project = opened.get("project").cloned().ok_or("read receipt missing project")?;
    let project_file_identity = opened.get("fileIdentity").cloned().ok_or("read receipt missing byte identity")?;
    let assets = project
        .get("assets")
        .and_then(Value::as_array)
        .ok_or("專案缺少 assets")?;
    let runtime_paths = collect_runtime_paths_async(&app, assets).await?;
    let matte_preview_paths = collect_product_auto_roto_preview_paths(&app, &project)?;
    Ok(json!({
        "canceled": false,
        "path": path,
        "project": project,
        "fileIdentity": project_file_identity,
        "runtimePaths": runtime_paths,
        "mattePreviewPaths": matte_preview_paths
    }))
}

/// 「打開資料夾」: the folder with the saved file selected (Windows Explorer /select). Only an existing regular file.
#[tauri::command(async)]
fn reveal_in_folder(path: String) -> Result<(), String> {
    if local_path_text_problem(&path) == Some(LocalPathProblem::NetworkOrDevice) {
        return Err("不能打開網路上的位置".into());
    }
    template_short::reveal_in_folder(Path::new(&path))
}

// ---- Desktop safety (usable-v1 ROADMAP 2.9-2.11, 1.15): export progress and cancel, closing with unsaved work,
// crash-recovery choices, missing media, project changes by other programs, and the version shown in Settings.
// The logic and its unit tests live in render_jobs.rs, window_close_guard.rs and desktop_files.rs.

#[tauri::command]
async fn run_engine_task_v1(app: AppHandle, window: tauri::WebviewWindow, request: engine_tasks_v1::EngineRequestV1, on_event: tauri::ipc::Channel<Value>) -> Result<Value, String> {
    engine_tasks_v1::run(app, window, request, on_event).await
}


#[tauri::command]
fn render_job_progress(jobs: State<'_, render_jobs::RenderJobs>, job_id: String) -> Value {
    jobs.progress(&job_id)
}

/// 「停止輸出」: the renderer is asked to stop first (FFmpeg exits, its temporary files are removed); a renderer
/// that does not answer in time has its worker stopped.
#[tauri::command]
fn cancel_render_job(jobs: State<'_, render_jobs::RenderJobs>, job_id: String) -> Value {
    jobs.request_cancel(&job_id, render_jobs::HARD_CANCEL_GRACE)
}

#[tauri::command]
fn app_build_info(app: AppHandle) -> Value {
    desktop_files::build_info(RELEASE_INPUT_MANIFEST, &app.package_info().version.to_string())
}

#[tauri::command]
fn set_close_guard(guard: State<'_, window_close_guard::CloseGuard>, armed: bool) {
    guard.set_armed(armed);
}

#[tauri::command]
fn acknowledge_close_request(guard: State<'_, window_close_guard::CloseGuard>) {
    guard.acknowledge();
}

/// The creator chose to close (after saving, or without saving); the guard lets this close through.
#[tauri::command(async)]
fn close_window_confirmed(app: AppHandle, guard: State<'_, window_close_guard::CloseGuard>) -> Result<(), String> {
    guard.approve();
    match app.get_webview_window("main") {
        Some(window) => window.close().map_err(|error| error.to_string()),
        None => Ok(()),
    }
}

#[tauri::command]
async fn inspect_project_file(app: AppHandle, path: String, known_modified_ms: Option<u64>) -> Result<Value, String> {
    let _ = known_modified_ms; // mtime is not content identity.
    if !desktop_files::local_absolute(&path) { return Ok(json!({ "exists": false })); }
    call_service(&app, "inspect_project_file", json!({ "path": path })).await
}

/// Opens a project the UI already knows (recent list, the open file after another program changed it, the last
/// saved file at crash recovery) without a file dialog; the same reader and preview paths as `open_project`.
#[tauri::command]
async fn open_project_path(app: AppHandle, path: String) -> Result<Value, String> {
    let path = desktop_files::validate_project_path(&path)?;
    let opened = call_service(&app, "read_project", json!({ "path": path, "captureFileIdentity": true })).await?;
    let project = opened.get("project").cloned().ok_or("read receipt missing project")?;
    let project_file_identity = opened.get("fileIdentity").cloned().ok_or("read receipt missing byte identity")?;
    let assets = project
        .get("assets")
        .and_then(Value::as_array)
        .ok_or("專案缺少 assets")?;
    let runtime_paths = collect_runtime_paths_async(&app, assets).await?;
    let matte_preview_paths = collect_product_auto_roto_preview_paths(&app, &project)?;
    Ok(
        json!({ "canceled": false, "path": path, "project": project, "fileIdentity": project_file_identity, "runtimePaths": runtime_paths, "mattePreviewPaths": matte_preview_paths }),
    )
}

#[tauri::command(async)]
fn check_media_paths(paths: Vec<String>) -> Result<Vec<bool>, String> {
    desktop_files::check_media_paths(&paths)
}

/// 「重新找檔案」: the creator picks the moved file; its SHA-256 lets the edit graph's relink prove it is the very
/// same file before anything in the project changes.
#[tauri::command]
async fn pick_relink_media(app: AppHandle, ui_locale: Option<String>) -> Result<Value, String> {
    let Some(path) = FileDialog::new()
        .set_title(native_dialog_labels::text(ui_locale.as_deref(), DialogText::RelinkMedia))
        .add_filter(
            native_dialog_labels::text(ui_locale.as_deref(), DialogText::MediaFilter),
            &["mp4", "mov", "mkv", "webm", "m4v", "mp3", "wav", "m4a", "aac", "flac"],
        )
        .pick_file()
    else {
        return Ok(json!({ "canceled": true }));
    };
    let text = path.to_string_lossy().to_string();
    // The single-import check (network share, device, stream) before the file is hashed.
    media_source_path_check(&text)?;
    let hashed = path.clone();
    let (sha256, bytes) = tauri::async_runtime::spawn_blocking(move || desktop_files::sha256_file(&hashed))
        .await
        .map_err(|error| error.to_string())??;
    allow_path(&app, &text)?;
    record_outside_media_grants(&app, vec![text.clone()], outside_media_grants::GrantSource::Relink).await;
    Ok(json!({ "canceled": false, "path": text, "sha256": sha256, "bytes": bytes }))
}

/// Keeps the crash-recovery copy in `recovery/kept/` instead of deleting it.
#[tauri::command]
fn keep_recovery_aside(app: AppHandle) -> Result<Value, String> {
    let kept = desktop_files::keep_recovery_aside(&recovery_path(&app)?, unix_time_ms())?;
    Ok(json!({ "kept": kept.is_some(), "path": kept.map(|path| path.to_string_lossy().to_string()) }))
}

fn main() {
    tauri::Builder::default()
        .manage(AppState::default())
        .manage(desktop_color_luts_v1::ColorLutSelectionsV1::default())
        .manage(render_jobs::RenderJobs::default())
        .manage(window_close_guard::CloseGuard::default())
        .on_window_event(window_close_guard::handle_window_event)
        .on_page_load(|webview, payload| {
            if webview.label() == "main"
                && matches!(payload.event(), tauri::webview::PageLoadEvent::Started)
            {
                match webview.state::<AppState>().resident_audio.retire_document() {
                    Ok(ticket) => { tauri::async_runtime::spawn(async move {
                        if let Err(error) = ticket.await {
                            eprintln!("Audio document retirement remains unconfirmed: {error}");
                        }
                    }); }
                    Err(error) => eprintln!("Audio document retirement could not be queued: {error}"),
                }
            }
        })
        .setup(|app| {
            grant_isolated_runtime_commands(app.handle())?;
            let pending = begin_update_launch(&app.handle()).map_err(std::io::Error::other)?;
            app.state::<AppState>()
                .update_health_pending
                .store(pending, Ordering::SeqCst);
            // After an update the saved agent generation still records the previous release's files and the
            // launcher would refuse it; re-activate it from the installed files in the background (silent on
            // success, reported by inspect_agent_connections otherwise). Agent configs are not touched.
            agent_connect::repair_agent_generation_in_background(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pick_media,
            import_media_paths,
            desktop_batch_commands_v1::pick_batch_media,
            desktop_batch_commands_v1::get_batch_session,
            desktop_batch_commands_v1::run_batch_auto_edit_item,
            desktop_batch_commands_v1::open_batch_project,
            preview_paths,
            list_creative_library,
            list_installed_plugins,
            get_workflow_profile,
            save_workflow_profile,
            open_plugin_folder,
            compile_plugin_tool,
            import_creative_asset,
            preview_creative_asset,
            read_mesh_3d_font,
            read_bundled_font_face,
            read_color_asset,
            list_color_luts_v1,
            pick_color_lut_v1,
            import_color_lut_v1,
            read_color_lut_v1,
            prepare_media,
            clip_media_derivative,
            smart_cut_media,
            automatic_caption_media,
            detect_scenes,
            analyze_motion_track,
            #[cfg(feature = "auto-roto-research")]
            inspect_auto_roto_video_model,
            #[cfg(feature = "auto-roto-research")]
            install_auto_roto_video_model,
            #[cfg(feature = "auto-roto-research")]
            pick_and_install_auto_roto_video_model,
            #[cfg(feature = "auto-roto-research")]
            repair_auto_roto_video_model,
            analyze_auto_roto,
            open_project,
            save_project,
            load_recovery,
            save_recovery,
            clear_recovery,
            integration_smoke_enabled,
            render_project,
            render_alpha_master,
            render_openexr_sequence,
            render_native_effect_preview,
            render_project_smoke,
            render_openexr_sequence_smoke,
            batch_auto_edit_smoke,
            start_mobile_remote,
            get_mobile_remote_network_summary,
            list_remote_provider_connectors,
            update_mobile_snapshot,
            poll_mobile_commands,
            get_mobile_remote_status,
            revoke_mobile_device,
            stop_mobile_remote,
            check_update_available,
            check_for_updates,
            get_update_job_result,
            install_update,
            start_native_audio_preview,
            native_audio_preview_status,
            stop_native_audio_preview,
            gpu_compositor_status,
            gpu_engine_status,
            begin_gpu_preview_owner,
            end_gpu_preview_owner,
            start_gpu_preview_playback,
            stop_gpu_preview_playback,
            acknowledge_gpu_preview_playback,
            inspect_gpu_preview_playback,
            load_gpu_preview_session,
            load_gpu_engine_preview_session,
            update_gpu_engine_preview_frame,
            load_gpu_engine_video_preview_session,
            load_gpu_engine_video_frame_preview_session,
            render_gpu_engine_video_preview_frame,
            present_gpu_engine_video_preview_frame,
            release_gpu_engine_video_preview_session,
            update_gpu_preview_properties,
            render_gpu_preview_frame,
            release_gpu_preview_session,
            open_gpu_video_preview_session,
            decode_gpu_video_preview_frame,
            decode_gpu_video_preview_at_time,
            stage_gpu_video_preview_at_time,
            bind_gpu_preview_surface,
            present_gpu_video_preview_at_time,
            hide_gpu_preview_surface,
            release_gpu_preview_surface,
            seek_gpu_video_preview_session,
            release_gpu_video_preview_session,
            recover_gpu_device,
            inject_gpu_device_loss_for_test,
            render_gpu_composition,
            smoke_ready,
            release_input_manifest,
            resident_audio_capabilities,
            open_resident_audio,
            replace_resident_audio,
            control_resident_audio,
            close_resident_audio,
            resident_audio_status,
            copy_agent_setup,
            inspect_agent_connections,
            agent_connect::open_external_url,
            agent_connect::suggest_agent_workspace,
            agent_connect::pick_agent_workspace,
            launch_remote_setup_agent,
            get_remote_setup_agent_status,
            cancel_remote_setup_agent,
            template_short_prepare,
            template_short_confirm_rights,
            start_template_short_job,
            template_short_job_status,
            cancel_template_short_job,
            save_template_short_video,
            open_template_short_project,
            reveal_in_folder,
            render_job_progress,
            cancel_render_job,
            run_engine_task_v1,
            desktop_batch_commands_v1::cancel_engine_task_v1,
            app_build_info,
            set_close_guard,
            acknowledge_close_request,
            close_window_confirmed,
            inspect_project_file,
            open_project_path,
            check_media_paths,
            pick_relink_media,
            outside_media_grants::inspect_project_outside_media,
            outside_media_grants::grant_project_outside_media,
            keep_recovery_aside
        ])
        .build(tauri::generate_context!())
        .expect("Editkin Tauri runtime failed")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                if !app.state::<AppState>().resident_audio.shutdown() {
                    eprintln!("Editkin audio shutdown: owned worker cleanup remains unconfirmed");
                }
                if !app.state::<AppState>().gpu_commands.shutdown_and_wait(Duration::from_secs(3)) {
                    eprintln!("Editkin GPU shutdown: active work has not exited before cleanup deadline");
                } else {
                    // The owner worker joined, so no request still holds this
                    // mutex. Also terminate an idle resident process on exit.
                    let state = app.state::<AppState>();
                    let mut slot = state.gpu_engine.lock().unwrap_or_else(|error| error.into_inner());
                    if let Some(process) = slot.as_mut() {
                        if let Err(error) = process.stop() {
                            eprintln!("Editkin GPU shutdown: cleanup unconfirmed: {error}");
                        }
                    }
                    let stopped = slot.as_ref().is_none_or(|process| process.cleanup_confirmed());
                    drop(slot);
                    if stopped {
                        let mut cache=state.gpu_preview_cache.lock().unwrap_or_else(|error| error.into_inner());
                        cache.close();
                        if cache.deferred_groups() > 0 {
                            eprintln!("Editkin GPU cache shutdown: {} locked or changed groups retained",cache.deferred_groups());
                        }
                    }
                }
                app.state::<AppState>().services.shutdown();
                if !app
                    .state::<AppState>()
                    .creative_previews
                    .shutdown_and_wait(Duration::from_secs(3))
                {
                    eprintln!(
                        "Editkin preview shutdown: cleanup not confirmed before exit deadline"
                    );
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    const BUNDLED_FONT_TEST_FACE: &str = "EditkinFace-bebas-neue-400";

    struct BundledFontFixture {
        root: PathBuf,
        parent: PathBuf,
        spec: BundledFontFaceSpec,
        expected: Vec<u8>,
    }

    impl BundledFontFixture {
        fn new() -> Self {
            static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
            let parent = fs::canonicalize(env::temp_dir()).unwrap();
            let root = parent.join(format!(
                "editkin-bundled-font-test-{}-{}-{}",
                std::process::id(),
                SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos(),
                NEXT.fetch_add(1, Ordering::Relaxed),
            ));
            fs::create_dir(&root).unwrap();
            fs::create_dir(root.join("render")).unwrap();
            let spec = bundled_font_face_spec(BUNDLED_FONT_TEST_FACE).unwrap();
            let source = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../public/fonts");
            let expected = fs::read(source.join(&spec.font_file)).unwrap();
            assert!(expected.len() < 128 * 1024, "fixture must remain a small physical face");
            fs::write(root.join(&spec.font_file), &expected).unwrap();
            fs::copy(source.join("editkin-open-fonts.json"), root.join("editkin-open-fonts.json")).unwrap();
            Self { root, parent, spec, expected }
        }
    }

    impl Drop for BundledFontFixture {
        fn drop(&mut self) {
            // Delete only this exclusively created root; never a computed ancestor or alias.
            let Ok(metadata) = fs::symlink_metadata(&self.root) else { return; };
            if !metadata.is_dir() || remote_agent_directory_is_link(&metadata) { return; }
            let Ok(canonical) = fs::canonicalize(&self.root) else { return; };
            if canonical.parent() == Some(self.parent.as_path())
                && canonical.file_name().and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with("editkin-bundled-font-test-"))
                && canonical == self.root
            {
                let _ = fs::remove_dir_all(&self.root);
            }
        }
    }

    #[test]
    fn bundled_font_catalog_is_exact_and_request_cannot_choose_path_or_sha() {
        let specs = bundled_font_face_catalog_from(BUNDLED_FONT_FACE_INDEX, BUNDLED_FONT_EM_METRICS).unwrap();
        assert_eq!(specs.len(), 44);
        assert_eq!(specs.iter().map(|spec| &spec.face_id).collect::<BTreeSet<_>>().len(), 44);
        for spec in &specs {
            assert_eq!(bundled_font_face_spec(&spec.face_id).unwrap(), *spec);
            assert_eq!(spec.font_file, format!("render/{}.ttf", spec.face_id));
            assert!(valid_sha256(&spec.sha256));
            assert_eq!(spec.manifest_sha256, "374de0ff4986d41085a5421980374223af027fc22f6c2abc8c8ece00653ef738");
        }
        for id in [
            "", "EditkinFace-noto-sans-tc-701", "EditkinFace-bebas-neue-400 ",
            " editkinFace-bebas-neue-400", "editkinface-bebas-neue-400",
            "../EditkinFace-bebas-neue-400", "render/EditkinFace-bebas-neue-400.ttf",
            "render\\EditkinFace-bebas-neue-400.ttf", "C:\\secret.ttf",
            "EditkinFace-bebas-neue-400\0", "EditkinFace-bebas-neue-400?sha256=abc",
        ] {
            assert!(bundled_font_face_spec(id).is_err(), "{id:?}");
        }
    }

    #[test]
    fn bundled_font_catalog_rejects_conflicting_generated_contracts() {
        let metrics: Value = serde_json::from_str(BUNDLED_FONT_EM_METRICS).unwrap();
        let index: Value = serde_json::from_str(BUNDLED_FONT_FACE_INDEX).unwrap();
        let mut duplicate = metrics.clone();
        duplicate["faces"][1] = duplicate["faces"][0].clone();
        let mut missing = metrics.clone();
        missing["faces"].as_array_mut().unwrap().pop();
        let mut foreign = metrics.clone();
        foreign["faces"][0]["id"] = json!("EditkinFace-unknown-100");
        let mut bad_sha = metrics.clone();
        bad_sha["faces"][0]["sha256"] = json!("A".repeat(64));
        let mut bad_manifest_sha = metrics.clone();
        bad_manifest_sha["manifestSha256"] = json!("0".repeat(63));
        for changed in [duplicate, missing, foreign, bad_sha, bad_manifest_sha] {
            assert!(bundled_font_face_catalog_from(BUNDLED_FONT_FACE_INDEX, &changed.to_string()).is_err());
        }
        let mut duplicate_weight = index.clone();
        duplicate_weight[0][2][1] = duplicate_weight[0][2][0].clone();
        let mut unsafe_id = index.clone();
        unsafe_id[0][1] = json!("../noto-sans-tc");
        for changed in [duplicate_weight, unsafe_id] {
            assert!(bundled_font_face_catalog_from(&changed.to_string(), BUNDLED_FONT_EM_METRICS).is_err());
        }
    }

    #[test]
    fn bundled_font_reader_returns_exact_selected_physical_bytes() {
        let fixture = BundledFontFixture::new();
        assert_eq!(read_bundled_font_face_bytes(&fixture.root, &fixture.spec).unwrap(), fixture.expected);
        assert!(read_bundled_font_face_bytes(Path::new("relative-font-root"), &fixture.spec).is_err());
    }

    #[test]
    fn bundled_font_reader_rejects_raw_manifest_drift_and_overgrowth() {
        let fixture = BundledFontFixture::new();
        let manifest_path = fixture.root.join("editkin-open-fonts.json");
        let original = fs::read(&manifest_path).unwrap();
        let mut normalized_equivalent = original.clone();
        normalized_equivalent.push(b'\n');
        fs::write(&manifest_path, normalized_equivalent).unwrap();
        assert!(read_bundled_font_face_bytes(&fixture.root, &fixture.spec).unwrap_err().contains("原始 SHA"));
        let oversized = fs::File::create(&manifest_path).unwrap();
        oversized.set_len(MAX_BUNDLED_FONT_MANIFEST_BYTES + 1).unwrap();
        drop(oversized);
        assert!(read_bundled_font_face_bytes(&fixture.root, &fixture.spec).unwrap_err().contains("安全大小"));
    }

    #[test]
    fn bundled_font_reader_rejects_same_size_corruption_truncation_empty_and_overgrowth() {
        let fixture = BundledFontFixture::new();
        let face_path = fixture.root.join(&fixture.spec.font_file);
        let mut corrupted = fixture.expected.clone();
        corrupted[0] ^= 1;
        fs::write(&face_path, corrupted).unwrap();
        assert!(read_bundled_font_face_bytes(&fixture.root, &fixture.spec).unwrap_err().contains("SHA"));
        fs::write(&face_path, &fixture.expected[..fixture.expected.len() - 1]).unwrap();
        assert!(read_bundled_font_face_bytes(&fixture.root, &fixture.spec).unwrap_err().contains("大小或 SHA"));
        fs::write(&face_path, b"").unwrap();
        assert!(read_bundled_font_face_bytes(&fixture.root, &fixture.spec).unwrap_err().contains("安全大小"));
        let oversized = fs::File::create(&face_path).unwrap();
        oversized.set_len(MAX_BUNDLED_FONT_FACE_BYTES + 1).unwrap();
        drop(oversized);
        assert!(read_bundled_font_face_bytes(&fixture.root, &fixture.spec).unwrap_err().contains("安全大小"));
    }

    #[test]
    fn bundled_font_reader_rejects_non_directory_render_and_directory_swap() {
        let fixture = BundledFontFixture::new();
        let render_path = fixture.root.join("render");
        let render = open_bundled_font_directory(&render_path).unwrap();
        fs::rename(&render_path, fixture.root.join("render-original")).unwrap();
        fs::create_dir(&render_path).unwrap();
        assert!(verify_bundled_font_directory(&render).unwrap_err().contains("被替換"));
        drop(render);
        fs::remove_dir(&render_path).unwrap();
        fs::write(&render_path, b"not a directory").unwrap();
        assert!(read_bundled_font_face_bytes(&fixture.root, &fixture.spec).unwrap_err().contains("一般資料夾"));
    }

    #[test]
    fn bundled_font_reader_retains_manifest_handle_and_rejects_identical_byte_replacement() {
        let fixture = BundledFontFixture::new();
        let root = open_bundled_font_directory(&fixture.root).unwrap();
        let path = fixture.root.join("editkin-open-fonts.json");
        let read = read_bundled_font_file(&path, &root, MAX_BUNDLED_FONT_MANIFEST_BYTES).unwrap();
        fs::rename(&path, fixture.root.join("manifest-original.json")).unwrap();
        fs::write(&path, &read.bytes).unwrap();
        assert_eq!(format!("{:x}", Sha256::digest(fs::read(&path).unwrap())), fixture.spec.manifest_sha256);
        assert!(verify_bundled_font_read(&read).unwrap_err().contains("被替換"));
    }

    #[test]
    fn bundled_font_directory_identity_allows_unrelated_new_siblings() {
        let fixture = BundledFontFixture::new();
        let ancestors = open_bundled_font_directory_chain(&fixture.root).unwrap();
        let render = open_bundled_font_directory(&fixture.root.join("render")).unwrap();
        fs::write(fixture.root.join("unrelated-root-sibling"), b"unrelated").unwrap();
        fs::write(fixture.root.join("render/unrelated-render-sibling"), b"unrelated").unwrap();
        verify_bundled_font_directory_chain(&ancestors).unwrap();
        verify_bundled_font_directory(&render).unwrap();
        assert_eq!(read_bundled_font_face_bytes(&fixture.root, &fixture.spec).unwrap(), fixture.expected);
    }

    #[cfg(windows)]
    #[test]
    fn bundled_font_reader_rejects_windows_parent_junction_in_owned_fixture() {
        use std::os::windows::{fs::OpenOptionsExt, io::AsRawHandle};
        use windows_sys::Win32::Storage::FileSystem::{FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT};
        // Creating this owned NTFS mount-point fixture needs no shell or symlink privilege.
        #[link(name = "kernel32")]
        extern "system" {
            fn DeviceIoControl(
                handle: *mut std::ffi::c_void, code: u32,
                input: *const std::ffi::c_void, input_bytes: u32,
                output: *mut std::ffi::c_void, output_bytes: u32,
                returned_bytes: *mut u32, overlapped: *mut std::ffi::c_void,
            ) -> i32;
        }
        let fixture = BundledFontFixture::new();
        let parent = fixture.root.join("real-parent");
        let pack = parent.join("pack");
        fs::create_dir(&parent).unwrap();
        fs::create_dir(&pack).unwrap();
        fs::create_dir(pack.join("render")).unwrap();
        fs::copy(fixture.root.join("editkin-open-fonts.json"), pack.join("editkin-open-fonts.json")).unwrap();
        fs::copy(fixture.root.join(&fixture.spec.font_file), pack.join(&fixture.spec.font_file)).unwrap();
        assert_eq!(read_bundled_font_face_bytes(&pack, &fixture.spec).unwrap(), fixture.expected);
        let alias = fixture.root.join("parent-junction");
        fs::create_dir(&alias).unwrap();
        let owned_root = fs::canonicalize(&fixture.root).unwrap();
        let target = fs::canonicalize(&parent).unwrap();
        assert!(target.starts_with(&owned_root));
        assert_eq!(fs::canonicalize(&alias).unwrap().parent(), Some(owned_root.as_path()));
        let target_string = target.to_str().unwrap();
        let print = target_string.strip_prefix("\\\\?\\").unwrap_or(target_string);
        let substitute: Vec<u16> = format!("\\??\\{print}").encode_utf16().collect();
        let print: Vec<u16> = print.encode_utf16().collect();
        let data_bytes = 8 + (substitute.len() + print.len() + 2) * 2;
        assert!(data_bytes < 16 * 1024 && data_bytes <= u16::MAX as usize);
        let mut buffer = Vec::with_capacity(8 + data_bytes);
        buffer.extend_from_slice(&0xA0000003_u32.to_le_bytes()); // IO_REPARSE_TAG_MOUNT_POINT
        buffer.extend_from_slice(&(data_bytes as u16).to_le_bytes());
        buffer.extend_from_slice(&0_u16.to_le_bytes());
        buffer.extend_from_slice(&0_u16.to_le_bytes()); // SubstituteNameOffset
        buffer.extend_from_slice(&((substitute.len() * 2) as u16).to_le_bytes());
        buffer.extend_from_slice(&(((substitute.len() + 1) * 2) as u16).to_le_bytes());
        buffer.extend_from_slice(&((print.len() * 2) as u16).to_le_bytes());
        for unit in substitute.iter().chain([0_u16].iter()).chain(print.iter()).chain([0_u16].iter()) {
            buffer.extend_from_slice(&unit.to_le_bytes());
        }
        let handle = fs::OpenOptions::new().write(true)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT).open(&alias).unwrap();
        let mut returned = 0_u32;
        let result = unsafe { DeviceIoControl(
            handle.as_raw_handle(), 0x000900A4, buffer.as_ptr().cast(), buffer.len() as u32,
            std::ptr::null_mut(), 0, &mut returned, std::ptr::null_mut(),
        ) };
        assert_ne!(result, 0, "owned junction fixture creation failed: {}", std::io::Error::last_os_error());
        drop(handle);
        assert!(remote_agent_directory_is_link(&fs::symlink_metadata(&alias).unwrap()));
        assert!(read_bundled_font_face_bytes(&alias.join("pack"), &fixture.spec)
            .unwrap_err().contains("link/reparse"));
        fs::remove_dir(&alias).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn bundled_font_reader_rejects_unix_fifo_without_opening_a_blocking_reader() {
        use std::os::unix::ffi::OsStrExt;
        let fixture = BundledFontFixture::new();
        let path = fixture.root.join(&fixture.spec.font_file);
        fs::remove_file(&path).unwrap();
        let name = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
        assert!(read_bundled_font_face_bytes(&fixture.root, &fixture.spec)
            .unwrap_err().contains("特殊檔案"));
    }

    #[cfg(unix)]
    #[test]
    fn bundled_font_reader_rejects_file_root_and_render_symlinks() {
        use std::os::unix::fs::symlink;
        let fixture = BundledFontFixture::new();
        let face_path = fixture.root.join(&fixture.spec.font_file);
        fs::rename(&face_path, fixture.root.join("real-face.ttf")).unwrap();
        symlink(fixture.root.join("real-face.ttf"), &face_path).unwrap();
        assert!(read_bundled_font_face_bytes(&fixture.root, &fixture.spec).is_err());
        fs::remove_file(&face_path).unwrap();
        fs::rename(fixture.root.join("real-face.ttf"), &face_path).unwrap();
        fs::rename(fixture.root.join("render"), fixture.root.join("render-original")).unwrap();
        symlink(fixture.root.join("render-original"), fixture.root.join("render")).unwrap();
        assert!(read_bundled_font_face_bytes(&fixture.root, &fixture.spec).is_err());
        let root_alias = fixture.root.join("root-alias");
        symlink(&fixture.root, &root_alias).unwrap();
        assert!(read_bundled_font_face_bytes(&root_alias, &fixture.spec).is_err());
    }

    #[test]
    fn color_asset_route_is_closed_to_known_data_files() {
        for path in [
            "gpu/input-rec709.json",
            "gpu/grade-primary-tone.json",
            "luts/input-rec709-to-acescct.cube",
        ] {
            assert_eq!(
                bounded_color_asset_relative_path(path).unwrap(),
                PathBuf::from(path.replace('/', std::path::MAIN_SEPARATOR_STR))
            );
        }
        for path in [
            "",
            "../secret.json",
            "gpu/../secret.json",
            "gpu\\input-rec709.json",
            "gpu/input-rec709.cube",
            "luts/input-rec709.json",
            "other/input-rec709.json",
            "gpu/.hidden.json",
            "gpu/input rec709.json",
            "gpu/input/rec709.json",
        ] {
            assert!(bounded_color_asset_relative_path(path).is_err(), "{path}");
        }
    }

    #[test]
    fn product_auto_roto_time_metadata_preserves_invalidated_editable_state_only() {
        assert!(!product_auto_roto_time_invalidated(&json!({})).unwrap());
        assert!(!product_auto_roto_time_invalidated(&json!({ "stale": true })).unwrap());
        assert!(product_auto_roto_time_invalidated(&json!({
            "stale": true, "staleReason": "clip-time-range-changed"
        }))
        .unwrap());
        for invalid in [
            json!({ "staleReason": "clip-time-range-changed" }),
            json!({ "stale": false, "staleReason": "clip-time-range-changed" }),
            json!({ "stale": "true", "staleReason": "clip-time-range-changed" }),
            json!({ "stale": true, "staleReason": "pretend-verified" }),
            json!({ "stale": true, "staleReason": null }),
        ] {
            assert!(product_auto_roto_time_invalidated(&invalid).is_err());
        }
    }

    #[test]
    fn shared_agent_setup_contract_is_current_and_closed_world() {
        let contract = editkin_agent_setup_contract().unwrap();
        let prompt = editkin_agent_starter_prompt(&contract).unwrap();
        assert!(prompt.contains("requiredPlanSource"));
        assert!(prompt.contains("accepted audit receipt"));
        let keys = contract["envKeys"]
            .as_array()
            .unwrap()
            .iter()
            .map(|value| value.as_str().unwrap())
            .collect::<BTreeSet<_>>();
        assert_eq!(keys.len(), 15);
        assert!(keys.contains("EDITKIN_AGENT_STATE_ROOT"));
        assert!(keys.contains("EDITKIN_VIDEO_AUTOPILOT_SKILL"));
        assert!(keys.contains("EDITKIN_WORKFLOW_PROFILE_PATH"));
        assert!(keys.contains("EDITKIN_PERSONAL_VISUAL_ROOT"));
        let launcher = contract["launcher"].as_object().unwrap();
        assert_eq!(launcher["schemaVersion"], 3);
        assert_eq!(launcher["entrypointMode"], "stable_generation_launcher");
        assert_eq!(
            launcher["resourceRelativePath"],
            "agent-runtime-v3/launcher.mjs"
        );
        assert_eq!(launcher["stateEnvKey"], "EDITKIN_AGENT_STATE_ROOT");
        assert!(launcher["args"].as_array().unwrap().is_empty());
    }

    #[test]
    #[cfg(feature = "auto-roto-research")]
    fn auto_roto_active_pointer_is_hash_bound_and_closed_to_versions() {
        let root = env::temp_dir().join(format!(
            "editkin-roto-pointer-{}-{}",
            std::process::id(),
            unix_time_ms()
        ));
        let model_root = root.join("models");
        let digest = "a".repeat(64);
        let generation = model_root.join("auto-roto-video/versions").join(&digest);
        fs::create_dir_all(generation.join("host")).unwrap();
        fs::write(generation.join("manifest.json"), "{}").unwrap();
        fs::write(
            generation.join("host/auto-roto-sam21-video-host.py"),
            "pass\n",
        )
        .unwrap();
        write_json_atomic(&model_root.join("auto-roto-video/active.json"), &json!({
            "schema": "editkin.auto-roto-active-pack/v1", "rootRelative": format!("versions/{digest}"), "manifestSha256": digest
        })).unwrap();
        assert_eq!(
            resolve_active_auto_roto_video_root(&model_root).unwrap(),
            Some(generation)
        );
        let escaped = "b".repeat(64);
        write_json_atomic(&model_root.join("auto-roto-video/active.json"), &json!({
            "schema": "editkin.auto-roto-active-pack/v1", "rootRelative": "../outside", "manifestSha256": escaped
        })).unwrap();
        assert!(resolve_active_auto_roto_video_root(&model_root).is_err());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    #[cfg(feature = "auto-roto-research")]
    fn auto_roto_pack_copy_is_bounded_and_preserves_files() {
        let root = env::temp_dir().join(format!(
            "editkin-roto-copy-{}-{}",
            std::process::id(),
            unix_time_ms()
        ));
        let source = root.join("source");
        let target = root.join("target");
        fs::create_dir_all(source.join("runtime")).unwrap();
        fs::write(source.join("manifest.json"), "manifest").unwrap();
        fs::write(source.join("runtime/python.exe"), b"python").unwrap();
        let mut stats = PackCopyStats::default();
        copy_auto_roto_pack_tree(&source, &target, &mut stats).unwrap();
        assert_eq!(stats.files, 2);
        assert_eq!(stats.bytes, 14);
        assert_eq!(
            fs::read(target.join("runtime/python.exe")).unwrap(),
            b"python"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn native_audio_public_receipt_removes_every_managed_path() {
        let stage = json!({
            "manifestPath": "C:\\private\\mix.json",
            "sessionRoot": "C:\\private",
            "managedPaths": ["C:\\private\\mix.json", "C:\\private\\source.f32le"],
            "sourcePcm": [{ "id": "source-0", "path": "C:\\private\\source.f32le", "sha256": "a".repeat(64) }],
            "manifestSha256": "b".repeat(64)
        });
        let public = public_native_audio_stage(&stage);
        assert!(public.get("manifestPath").is_none());
        assert!(public.get("sessionRoot").is_none());
        assert!(public.get("managedPaths").is_none());
        assert!(public["sourcePcm"][0].get("path").is_none());
        assert_eq!(public["manifestSha256"], "b".repeat(64));
    }

    #[test]
    fn native_mix_event_requires_executor_and_manifest_binding() {
        let manifest = "a".repeat(64);
        let event = json!({
            "nativeMix": {
                "schema": "editkin.native-audio-preview-mix-receipt/v1",
                "status": "GREEN",
                "decoderExecutor": "ffmpeg-source-decode/v1",
                "mixExecutor": "hao-core-native-dag/v1",
                "nativeGraphExecution": true,
                "manifestSha256": manifest
            }
        });
        assert!(validate_native_mix_event(&event, &"a".repeat(64)).is_ok());
        assert!(validate_native_mix_event(&event, &"b".repeat(64)).is_err());
        let mut forged = event;
        forged["nativeMix"]["nativeGraphExecution"] = json!(false);
        assert!(validate_native_mix_event(&forged, &"a".repeat(64)).is_err());
    }

    #[test]
    fn native_audio_event_schema_accepts_recovery_lifecycle_only() {
        for kind in ["progress", "recovering", "recovered"] {
            assert!(validate_native_audio_event_schema(&json!({
                "schema": "editkin.native-audio-preview-event/v1",
                "event": kind,
            }))
            .is_ok());
        }
        assert!(validate_native_audio_event_schema(&json!({
            "schema": "editkin.native-audio-preview-receipt/v1",
            "event": "ended",
        }))
        .is_ok());
        assert!(validate_native_audio_event_schema(&json!({
            "schema": "editkin.native-audio-preview-event/v1",
            "event": "ended",
        }))
        .is_err());
        assert!(validate_native_audio_event_schema(&json!({
            "schema": "editkin.native-audio-preview-event/v1",
            "event": "restarting-without-receipt",
        }))
        .is_err());
    }

    #[test]
    fn resident_gpu_surface_commands_have_bounded_timeouts() {
        assert_eq!(
            resident_gpu_timeout("surface_bind"),
            Duration::from_secs(10)
        );
        assert_eq!(
            resident_gpu_timeout("video_present_at"),
            Duration::from_secs(10)
        );
        assert_eq!(
            resident_gpu_timeout("video_stage_at"),
            Duration::from_secs(30)
        );
        assert_eq!(
            resident_gpu_timeout("engine_video_present_frame"),
            Duration::from_secs(10)
        );
        assert_eq!(
            resident_gpu_timeout("engine_video_load"),
            Duration::from_secs(30)
        );
        assert_eq!(resident_gpu_timeout("load"), Duration::from_secs(60));
    }

    #[test]
    fn openexr_import_is_an_explicit_scene_linear_straight_alpha_image() {
        assert_eq!(
            media_probe_fields::imported_media_defaults(Path::new("C:\\plates\\beauty.EXR"), &json!({ "hasVideo": true, "hasAudio": false })).unwrap(),
            ("image", "linear_rec709", "straight")
        );
        assert_eq!(
            media_probe_fields::imported_media_defaults(Path::new("C:\\stills\\cover.png"), &json!({ "hasVideo": true, "hasAudio": false })).unwrap(),
            ("image", "auto", "auto")
        );
        assert_eq!(
            media_probe_fields::imported_media_defaults(Path::new("C:\\plates\\editkin-openexr-sequence.json"), &json!({ "hasVideo": true, "hasAudio": false })).unwrap(),
            ("image", "linear_rec709", "straight")
        );
        assert_eq!(
            media_probe_fields::imported_media_defaults(Path::new("C:\\video\\shot.mov"), &json!({ "hasVideo": true, "hasAudio": false })).unwrap(),
            ("video", "auto", "auto")
        );
    }

    #[test]
    fn openexr_sequence_request_requires_float_visual_graph_and_absolute_files() {
        let root = env::temp_dir().join(format!(
            "editkin-openexr-request-{}-{}",
            std::process::id(),
            unix_time_ms()
        ));
        fs::create_dir_all(&root).unwrap();
        let source = root.join("plate.exr");
        fs::write(&source, b"fixture").unwrap();
        let graph = json!({
            "schema": "editkin.engine-graph/v1", "workingFormat": "rgba32_float",
            "nodes": [{ "id": "source", "kind": "source" }]
        });
        let bindings = json!({ "plate": source });
        assert!(validate_openexr_sequence_request(&graph, &bindings, 0, 3).is_ok());
        let mut encoded = graph.clone();
        encoded["workingFormat"] = json!("rgba16_float");
        assert!(validate_openexr_sequence_request(&encoded, &bindings, 0, 3).is_err());
        assert!(validate_openexr_sequence_request(&graph, &bindings, 0, 0).is_err());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn common_video_bindings_exactly_match_every_unique_asset_without_a_fixed_layer_cap() {
        let source = |id: &str, asset_id: &str| json!({ "id": id, "kind": "source", "mediaKind": "video", "assetId": asset_id });
        let single_nodes = vec![source("source:a", "asset-a")];
        let adjustment_nodes = vec![
            source("source:a", "asset-a"),
            json!({ "id": "adjustment", "kind": "adjustment", "inputs": ["source:a"], "affectedInputs": ["source:a"], "timeline": { "timelineStartFrame": 0, "sourceStartFrame": 0, "durationFrames": 30 } }),
        ];
        let two_nodes = vec![source("source:a", "asset-a"), source("source:b", "asset-b")];
        let reused_nodes = vec![source("source:a", "asset-a"), source("source:b", "asset-a")];
        let six_nodes = (0..6)
            .map(|index| source(&format!("source:{index}"), &format!("asset-{index}")))
            .collect::<Vec<_>>();
        let twelve_nodes = (0..12)
            .map(|index| source(&format!("source:{index}"), &format!("asset-{index}")))
            .collect::<Vec<_>>();
        let single = json!({ "asset-a": "C:\\fixture\\a.mp4" });
        let two = json!({ "asset-a": "C:\\fixture\\a.mp4", "asset-b": "C:\\fixture\\b.mp4" });
        let extra = json!({ "asset-a": "C:\\fixture\\a.mp4", "unused": "C:\\fixture\\unused.mp4" });
        let six = (0..6)
            .map(|index| {
                (
                    format!("asset-{index}"),
                    json!(format!("C:\\fixture\\{index}.mp4")),
                )
            })
            .collect::<serde_json::Map<_, _>>();
        let twelve = (0..12)
            .map(|index| {
                (
                    format!("asset-{index}"),
                    json!(format!("C:\\fixture\\{index}.mp4")),
                )
            })
            .collect::<serde_json::Map<_, _>>();
        assert!(engine_video_binding_keys_match(
            &single_nodes,
            single.as_object().unwrap()
        ));
        assert!(engine_video_binding_keys_match(
            &adjustment_nodes,
            single.as_object().unwrap()
        ));
        assert!(engine_video_binding_keys_match(
            &two_nodes,
            two.as_object().unwrap()
        ));
        assert!(engine_video_binding_keys_match(
            &reused_nodes,
            single.as_object().unwrap()
        ));
        assert!(engine_video_binding_keys_match(&six_nodes, &six));
        assert!(engine_video_binding_keys_match(&twelve_nodes, &twelve));
        assert!(!engine_video_binding_keys_match(
            &two_nodes,
            single.as_object().unwrap()
        ));
        assert!(!engine_video_binding_keys_match(
            &single_nodes,
            extra.as_object().unwrap()
        ));
    }

    fn transaction(status: &str, attempts: u64) -> Value {
        json!({
            "schemaVersion": 1,
            "status": status,
            "fromVersion": "0.2.0",
            "toVersion": "0.3.0",
            "stagedArtifact": "C:\\fixture\\next.exe",
            "createdAt": "2026-08-21T00:00:00Z",
            "launchAttempts": attempts
        })
    }

    #[test]
    fn durable_update_transaction_recovers_previous_valid_state() {
        let root = env::temp_dir().join(format!(
            "editkin-update-test-{}-{}",
            std::process::id(),
            unix_time_ms()
        ));
        let path = root.join("transaction.json");
        write_update_transaction(&path, &transaction("staged", 0)).expect("initial transaction");
        write_update_transaction(&path, &transaction("applying", 1)).expect("rotated transaction");
        fs::write(&path, "{partial").expect("corrupt primary fixture");
        let recovered = read_update_transaction(&path)
            .expect("fallback read")
            .expect("fallback state");
        assert_eq!(
            recovered.get("status").and_then(Value::as_str),
            Some("staged")
        );
        write_update_transaction(&path, &transaction("healthy", 1)).expect("repair transaction");
        assert_eq!(
            read_update_transaction(&path)
                .unwrap()
                .unwrap()
                .get("status")
                .and_then(Value::as_str),
            Some("healthy")
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn invalid_update_transaction_fails_closed() {
        assert!(
            validate_update_transaction(&json!({ "schemaVersion": 1, "status": "healthy" }))
                .is_err()
        );
        assert!(validate_update_transaction(&transaction("unknown", 0)).is_err());
    }

    #[test]
    fn signer_identity_requires_exact_subject_and_certificate_sha256() {
        let expected_sha = "a".repeat(64);
        assert!(signer_identity_matches(
            " cn=Editkin Studio ",
            &expected_sha.to_uppercase(),
            "CN=Editkin Studio",
            &expected_sha
        ));
        assert!(!signer_identity_matches(
            "CN=Editkin Studio Evil",
            &expected_sha,
            "CN=Editkin Studio",
            &expected_sha
        ));
        assert!(!signer_identity_matches(
            "CN=Editkin Studio",
            &"b".repeat(64),
            "CN=Editkin Studio",
            &expected_sha
        ));
    }

    #[test]
    fn windows_network_and_device_paths_are_not_local_media() {
        for path in [
            r"\\host\share\clip.mp4",
            "//host/share/clip.mp4",
            r"\\?\UNC\host\share\clip.mp4",
            "//?/UNC/host/share/clip.mp4",
            r"\\.\pipe\name",
            r"\\?\Volume{01234567-89ab-cdef-0123-456789abcdef}\clip.mp4",
            r"\\?\GLOBALROOT\Device\HarddiskVolume1\clip.mp4",
            r"\\?\",
            r"\??\UNC\host\share\clip.mp4",
            r"\??\C:\media\clip.mp4",
            "/??/UNC/host/share/clip.mp4",
            r"C:\media\NUL",
            r"C:\media\nul.txt",
            r"C:\x\CON",
            r"C:\media\aux.mp4",
            r"C:\media\PRN",
            r"C:\media\COM1",
            r"C:\media\com9.mp4",
            r"C:\media\LPT1",
            r"C:\media\lpt9.wav",
            r"C:\media\COM¹",
            r"C:\media\com².mp4",
            r"C:\media\COM³",
            r"C:\media\LPT¹.mp4",
            r"C:\media\lpt²",
            r"C:\media\LPT³",
            r"C:\media\CONIN$",
            r"C:\media\conout$.mp4",
            r"C:\media\nul.",
            r"C:\media\NUL .txt",
            r"C:\media\NUL ",
            r"C:\media\Nul.tar.gz",
            "C:/media/nul.mp4",
            "C:NUL",
            r"C:\media\NUL:stream",
            "nul.mp4",
            // Conservative choices: a non-final component, a verbatim path, COM0 and LPT0.
            r"C:\media\NUL\clip.mp4",
            r"\\?\C:\media\NUL",
            r"C:\media\COM0.mp4",
            r"C:\media\LPT0.mp4",
        ] {
            assert!(is_windows_network_path(path), "{path}");
        }
        for path in [
            r"C:\media\clip.mp4",
            "C:/media/clip.mp4",
            r"\\?\C:\media\clip.mp4",
            r"\\?\c:",
            "/Users/someone/clip.mp4",
            "media/clip.mp4",
            r"C:\media\null.mp4",
            r"C:\media\console.mp4",
            r"C:\media\COM10.mp4",
            r"C:\media\LPT10.mp4",
            r"C:\media\clip.nul.mp4",
            r"C:\media\auxiliary\clip.mp4",
            r"C:\media\nul-cut\clip.mp4",
        ] {
            assert!(!is_windows_network_path(path), "{path}");
        }
    }

    #[test]
    fn remote_allowed_hosts_names_only_the_configured_tunnel_host() {
        assert_eq!(remote_allowed_hosts(None), "");
        assert_eq!(
            remote_allowed_hosts(Some("https://Editkin.Example.com/path?x=1")),
            "editkin.example.com"
        );
        assert_eq!(
            remote_allowed_hosts(Some("https://user@tunnel.example:8443")),
            "tunnel.example"
        );
        assert_eq!(remote_allowed_hosts(Some("not a url")), "");
    }

    #[cfg(unix)]
    #[test]
    fn private_json_is_owner_only_even_when_replacing_a_readable_file() {
        use std::os::unix::fs::PermissionsExt;
        let root = env::temp_dir().join(format!("editkin-private-json-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let path = root.join("mobile-remote").join("relay-identity.json");
        write_private_json_atomic(&path, &json!({ "secret": "one" })).unwrap();
        let mode = |target: &Path| fs::metadata(target).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&path), 0o600);
        assert_eq!(mode(path.parent().unwrap()), 0o700);

        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        write_private_json_atomic(&path, &json!({ "secret": "two" })).unwrap();
        assert_eq!(mode(&path), 0o600);
        assert!(fs::read_to_string(&path).unwrap().contains("two"));

        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        restrict_to_owner(&path, 0o600).unwrap();
        assert_eq!(mode(&path), 0o600);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn revoking_a_mobile_device_lists_its_credential_before_dropping_it() {
        let root = env::temp_dir().join(format!("editkin-mobile-revoke-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let trusted = root.join("mobile-remote").join("trusted-devices.json");
        let revoked = mobile_revoked_devices_path(&trusted);
        let hash = |index: usize| format!("{index:064x}");
        let device = |id: &str, credential: usize| {
            json!({
                "id": id,
                "name": id,
                "credentialHash": hash(credential),
                "pairedAt": "2026-01-01T00:00:00.000Z",
                "lastSeen": "2026-01-01T00:00:00.000Z"
            })
        };
        let listed = || read_remote_json(&revoked).unwrap().unwrap()["credentialHashes"].clone();
        let trusted_ids = || {
            let store: Value =
                serde_json::from_str(&fs::read_to_string(&trusted).unwrap()).unwrap();
            store["devices"]
                .as_array()
                .unwrap()
                .iter()
                .map(|item| item["id"].as_str().unwrap().to_owned())
                .collect::<Vec<_>>()
        };
        write_json_atomic(
            &trusted,
            &json!({ "schemaVersion": 1, "devices": [device("phone", 1), device("tablet", 2)] }),
        )
        .unwrap();

        assert_eq!(
            revoked,
            root.join("mobile-remote").join("revoked-devices.json")
        );
        assert!(revoke_trusted_device(&trusted, "phone").unwrap());
        assert_eq!(listed(), json!([hash(1)]));
        assert_eq!(trusted_ids(), ["tablet"]);
        assert!(!revoke_trusted_device(&trusted, "phone").unwrap());
        assert_eq!(listed(), json!([hash(1)]));

        // An unreadable list is replaced instead of blocking the revoke.
        fs::write(&revoked, "not json").unwrap();
        assert!(revoke_trusted_device(&trusted, "tablet").unwrap());
        assert_eq!(listed(), json!([hash(2)]));
        assert!(trusted_ids().is_empty());

        // A full list keeps the most recent revocations.
        let full = (100..100 + MOBILE_REVOKED_CREDENTIAL_LIMIT)
            .map(hash)
            .collect::<Vec<_>>();
        write_remote_json_atomic(
            &revoked,
            &json!({ "schemaVersion": 1, "credentialHashes": full }),
        )
        .unwrap();
        write_json_atomic(
            &trusted,
            &json!({ "schemaVersion": 1, "devices": [device("watch", 3)] }),
        )
        .unwrap();
        assert!(revoke_trusted_device(&trusted, "watch").unwrap());
        let hashes = listed();
        let hashes = hashes.as_array().unwrap();
        assert_eq!(hashes.len(), MOBILE_REVOKED_CREDENTIAL_LIMIT);
        assert_eq!(hashes.first(), Some(&json!(hash(101))));
        assert_eq!(hashes.last(), Some(&json!(hash(3))));
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn release_ignores_runtime_path_and_unsigned_update_environment_overrides() {
        let fallback = PathBuf::from("bundled/runtime/node.exe");
        let attacker = PathBuf::from("attacker/node.exe");
        assert_eq!(
            runtime_override(false, Some(attacker.clone()), fallback.clone()),
            fallback
        );
        assert_eq!(
            runtime_override(true, Some(attacker.clone()), PathBuf::from("fallback")),
            attacker
        );
        assert!(!unsigned_update_override_allowed(
            false,
            Some("1"),
            Some("1")
        ));
        assert!(unsigned_update_override_allowed(true, Some("1"), None));
    }

    fn update_pin_document(manifest_url: Value, subject: Value, sha256: Value) -> String {
        json!({
            "schema": "editkin.update-publisher-pin/v1",
            "manifestUrl": manifest_url,
            "signatureSubject": subject,
            "signatureSha256": sha256,
        })
        .to_string()
    }

    #[test]
    fn update_publisher_pin_is_all_or_nothing_and_canonical() {
        let url = json!("https://updates.example/stable.json");
        let subject = json!("CN=Editkin Studio");
        let sha = json!("a".repeat(64));
        assert!(
            parse_update_publisher_pin(&update_pin_document(Value::Null, Value::Null, Value::Null))
                .unwrap()
                .is_none()
        );
        let pin = parse_update_publisher_pin(&update_pin_document(
            url.clone(),
            json!(" CN=Editkin Studio "),
            sha.clone(),
        ))
        .unwrap()
        .unwrap();
        assert_eq!(pin.signature_subject, "CN=Editkin Studio");
        assert_eq!(pin.manifest_url, "https://updates.example/stable.json");
        for document in [
            update_pin_document(Value::Null, subject.clone(), sha.clone()),
            update_pin_document(url.clone(), Value::Null, sha.clone()),
            update_pin_document(url.clone(), subject.clone(), Value::Null),
            update_pin_document(json!("http://updates.example/stable.json"), subject.clone(), sha.clone()),
            update_pin_document(json!("https://updates.example/stable.json#x"), subject.clone(), sha.clone()),
            update_pin_document(url.clone(), json!("  "), sha.clone()),
            update_pin_document(url.clone(), subject.clone(), json!("A".repeat(64))),
        ] {
            assert!(parse_update_publisher_pin(&document).is_err(), "{document}");
        }
        let mut extra: Value =
            serde_json::from_str(&update_pin_document(url.clone(), subject.clone(), sha.clone())).unwrap();
        extra["extra"] = json!(true);
        assert!(parse_update_publisher_pin(&extra.to_string()).is_err());
        extra.as_object_mut().unwrap().remove("extra");
        extra["schema"] = json!("editkin.update-publisher-pin/v2");
        assert!(parse_update_publisher_pin(&extra.to_string()).is_err());
        assert!(parse_update_publisher_pin(UPDATE_PUBLISHER_PIN).is_ok());
    }

    #[test]
    fn release_builds_ignore_manifest_url_environment_and_follow_the_pin() {
        let pin = UpdatePublisherPin {
            manifest_url: "https://updates.example/stable.json".into(),
            signature_subject: "CN=Editkin Studio".into(),
            signature_sha256: "a".repeat(64),
        };
        let attacker = Some("https://attacker.example/stable.json".to_string());
        assert_eq!(
            select_update_manifest_url(false, attacker.clone(), Some(&pin)).as_deref(),
            Some("https://updates.example/stable.json")
        );
        assert_eq!(select_update_manifest_url(false, attacker.clone(), None), None);
        assert_eq!(select_update_manifest_url(true, attacker.clone(), Some(&pin)), attacker);
        assert_eq!(
            select_update_manifest_url(true, None, Some(&pin)).as_deref(),
            Some("https://updates.example/stable.json")
        );
    }

    fn staged_installer_fixture(label: &str, bytes: &[u8]) -> (PathBuf, PathBuf, String) {
        let root = env::temp_dir().join(format!(
            "editkin-staged-update-{label}-{}-{}",
            std::process::id(),
            unix_time_ms()
        ));
        let mut hasher = Sha256::new();
        hasher.update(bytes);
        let sha256 = sha256_hex(hasher);
        let directory = root.join(format!("sha256-{sha256}"));
        fs::create_dir_all(&directory).unwrap();
        let installer = directory.join("installer.exe");
        fs::write(&installer, bytes).unwrap();
        (root, installer, sha256)
    }

    #[test]
    fn staged_installer_must_match_the_recorded_bytes_and_cache_path() {
        let bytes = b"signed installer fixture";
        let size = bytes.len() as u64;
        let (root, installer, sha256) = staged_installer_fixture("verify", bytes);
        let artifact = installer.to_str().unwrap();
        assert!(verify_staged_installer(&root, artifact, size, &sha256).is_ok());
        // Same size, different bytes: swapped after staging (for example during the confirmation dialog).
        fs::write(&installer, b"signed installer fixturX").unwrap();
        assert!(verify_staged_installer(&root, artifact, size, &sha256).is_err());
        fs::write(&installer, b"short").unwrap();
        assert!(verify_staged_installer(&root, artifact, size, &sha256).is_err());
        fs::write(&installer, bytes).unwrap();
        assert!(verify_staged_installer(&root, artifact, size, &sha256).is_ok());
        let elsewhere = root.join("elsewhere.exe");
        fs::copy(&installer, &elsewhere).unwrap();
        assert!(verify_staged_installer(&root, elsewhere.to_str().unwrap(), size, &sha256).is_err());
        assert!(verify_staged_installer(&root, artifact, size, &"b".repeat(64)).is_err());
        fs::remove_dir_all(&root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn staged_installer_rejects_a_symlinked_cache_entry() {
        let bytes = b"signed installer fixture";
        let (root, installer, sha256) = staged_installer_fixture("symlink", bytes);
        let real = root.join("real.exe");
        fs::rename(&installer, &real).unwrap();
        std::os::unix::fs::symlink(&real, &installer).unwrap();
        assert!(verify_staged_installer(&root, installer.to_str().unwrap(), bytes.len() as u64, &sha256).is_err());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    #[cfg(feature = "auto-roto-research")]
    fn external_auto_roto_requires_debug_build_and_exact_research_opt_in() {
        assert!(!external_auto_roto_research_allowed(false, Some("1")));
        assert!(!external_auto_roto_research_allowed(true, None));
        assert!(!external_auto_roto_research_allowed(true, Some("true")));
        assert!(!external_auto_roto_research_allowed(true, Some("0")));
        assert!(external_auto_roto_research_allowed(true, Some("1")));
    }

    #[test]
    fn integration_smoke_flag_is_exact_and_fails_closed() {
        assert!(integration_smoke_flag(Some("1")));
        assert!(!integration_smoke_flag(Some("true")));
        assert!(!integration_smoke_flag(Some("0")));
        assert!(!integration_smoke_flag(None));
    }

    fn remote_provider_proposal_fixture() -> RemoteProviderProposal {
        let mut proposal = RemoteProviderProposal {
            schema: REMOTE_PROVIDER_PROPOSAL_SCHEMA.into(),
            phase: "EXACT_PROVIDER_PROPOSAL".into(),
            truth_label: "PROPOSAL_READY_NOT_APPROVED".into(),
            workflow_id: "a".repeat(32),
            job_id: "b".repeat(32),
            consent_revision: REMOTE_AGENT_CONSENT_REVISION.into(),
            proposal_revision: "123e4567-e89b-42d3-a456-426614174000".into(),
            proposal_digest: String::new(),
            connector: RemoteProviderProposalConnector {
                connector_id: "tailscale-funnel".into(),
                connector_revision: "research-2026-09-05".into(),
                manifest_sha256: "9a1bb69d46389cf660bcc8c2e0b0e8f1da3f9f19a8098c23cefd41f2c6853600"
                    .into(),
                availability: "research-only-disabled".into(),
                attested: false,
                approval_enabled: false,
                execution_owner: "native-typed-connector".into(),
            },
            plan_digest: String::new(),
            transport: "https-tunnel".into(),
            provider: RemoteProviderProposalProvider {
                id: "tailscale".into(),
                display_name: "Tailscale".into(),
                product_name: "Funnel".into(),
                region: "Asia Pacific".into(),
            },
            expected_endpoint: RemoteProviderProposalEndpoint {
                transport: "https-tunnel".into(),
                public_origin_required: true,
                description: "Public HTTPS tunnel to the local Editkin port".into(),
            },
            pricing: RemoteProviderProposalPricing {
                kind: "public-list-price".into(),
                amount_micros: Some(0),
                currency: Some("USD".into()),
                billing_unit: "per-month".into(),
                summary: "Free plan public list price".into(),
            },
            free_tier: "Free tier available".into(),
            quota: "Subject to provider fair-use limits".into(),
            permissions: vec!["Create tunnel".into()],
            planned_mutations: vec!["Create one user-owned tunnel".into()],
            cancellation_or_deletion_consequences: "Deleting the tunnel removes remote access"
                .into(),
            sources: vec![RemoteProviderProposalSource {
                label: "Tailscale Funnel docs".into(),
                url: "https://tailscale.com/kb/1223/funnel".into(),
                checked_at_ms: 1_700_000_000_000,
            }],
            uncertainties: Vec::new(),
            unsupported_prerequisites: Vec::new(),
            cost_responsibility: "end-user".into(),
            external_mutation_performed: false,
            auto_deploy: false,
            approval_available: false,
            created_at_ms: 1_700_000_000_000,
            updated_at_ms: 1_700_000_000_000,
            expires_at_ms: 1_700_001_800_000,
        };
        proposal.plan_digest =
            remote_provider_action_plan_digest(&proposal).expect("provider action plan digest");
        proposal.proposal_digest =
            remote_provider_proposal_digest(&proposal).expect("proposal digest");
        proposal
    }

    #[test]
    fn remote_provider_proposal_matches_node_digest_and_rejects_tampering() {
        let proposal = remote_provider_proposal_fixture();
        assert_eq!(
            proposal.plan_digest,
            "44c6e57a5782f8c69f50bcddc8e77563be7e3f6495003512acd6ec6349860bc1"
        );
        assert_eq!(
            proposal.proposal_digest,
            "e8b7b68d756c4b3c7485cbd60dc4ae008a421c60e61a9daaf384d2f28efdbd6b"
        );
        let parsed = parse_remote_provider_proposal(
            serde_json::to_value(&proposal).expect("serialize provider proposal"),
        )
        .expect("parse exact provider proposal");
        assert_eq!(parsed.provider.id, "tailscale");

        let mut private_source = proposal.clone();
        private_source.sources[0].url = "https://127.0.0.1/docs".into();
        private_source.proposal_digest =
            remote_provider_proposal_digest(&private_source).expect("private source digest");
        assert!(parse_remote_provider_proposal(
            serde_json::to_value(private_source).expect("serialize private source")
        )
        .is_err());

        let mut secret_path = proposal.clone();
        secret_path.sources[0].url = "https://example.com/docs/api-key/reference".into();
        secret_path.proposal_digest =
            remote_provider_proposal_digest(&secret_path).expect("secret source digest");
        assert!(parse_remote_provider_proposal(
            serde_json::to_value(secret_path).expect("serialize secret source")
        )
        .is_err());

        let mut secret_text = proposal.clone();
        secret_text.quota = "Authorization: Bearer credential must be provided".into();
        secret_text.proposal_digest =
            remote_provider_proposal_digest(&secret_text).expect("secret text digest");
        assert!(parse_remote_provider_proposal(
            serde_json::to_value(secret_text).expect("serialize secret text")
        )
        .is_err());

        let mut stale_checked_at = proposal.clone();
        stale_checked_at.sources[0].checked_at_ms -= 1;
        stale_checked_at.proposal_digest = remote_provider_proposal_digest(&stale_checked_at)
            .expect("stale source timestamp digest");
        assert!(parse_remote_provider_proposal(
            serde_json::to_value(stale_checked_at).expect("serialize stale source timestamp")
        )
        .is_err());

        let mut extra = serde_json::to_value(proposal).expect("serialize extra-field proposal");
        extra["apiKey"] = Value::from("forbidden");
        assert!(parse_remote_provider_proposal(extra).is_err());
    }

    #[test]
    fn remote_agent_result_never_claims_cancel_or_timeout_before_cleanup_is_confirmed() {
        assert_eq!(
            remote_agent_termination_status(true, false, false, false),
            Some("cleanup_unconfirmed")
        );
        assert_eq!(
            remote_agent_termination_status(false, true, false, false),
            Some("cleanup_unconfirmed")
        );
        assert_eq!(
            remote_agent_termination_status(true, false, true, true),
            Some("cleanup_unconfirmed")
        );
        assert_eq!(
            remote_agent_termination_status(false, true, true, true),
            Some("cleanup_unconfirmed")
        );
        assert_eq!(
            remote_agent_termination_status(true, false, true, false),
            Some("canceled")
        );
        assert_eq!(
            remote_agent_termination_status(false, true, true, false),
            Some("timed_out")
        );
        assert_eq!(
            remote_agent_termination_status(false, false, true, false),
            None
        );
    }

    #[test]
    fn remote_agent_job_and_consent_binding_rejects_stale_or_mismatched_controller() {
        let job_id = "a".repeat(32);
        assert!(valid_remote_agent_job_id(&job_id));
        assert!(!valid_remote_agent_job_id(&"A".repeat(32)));
        assert!(!valid_remote_agent_job_id(&"a".repeat(31)));
        assert!(!valid_remote_agent_job_id(&format!("{}g", "a".repeat(31))));
        let cancel = Arc::new(AtomicBool::new(false));
        let controller = RemoteAgentController {
            job_id: job_id.clone(),
            target: RemoteAgentTarget::Codex,
            consent_revision: REMOTE_AGENT_CONSENT_REVISION.into(),
            started_at_ms: 1,
            cancel_requested: cancel,
        };
        assert!(remote_agent_controller_matches(
            Some(&controller),
            &job_id,
            RemoteAgentTarget::Codex,
            REMOTE_AGENT_CONSENT_REVISION,
        ));
        assert!(!remote_agent_controller_matches(
            Some(&controller),
            &"b".repeat(32),
            RemoteAgentTarget::Codex,
            REMOTE_AGENT_CONSENT_REVISION,
        ));
        assert!(!remote_agent_controller_matches(
            Some(&controller),
            &job_id,
            RemoteAgentTarget::Claude,
            REMOTE_AGENT_CONSENT_REVISION,
        ));
        assert!(!remote_agent_controller_matches(
            Some(&controller),
            &job_id,
            RemoteAgentTarget::Codex,
            "editkin.remote-agent-consent/stale",
        ));

        let controllers = Mutex::new(Some(controller));
        {
            let _stale_guard = RemoteAgentRunGuard {
                controller: &controllers,
                job_id: "b".repeat(32),
                target: RemoteAgentTarget::Codex,
                consent_revision: REMOTE_AGENT_CONSENT_REVISION.into(),
                started_at_ms: 1,
                receipt_path: PathBuf::from("unused-stale-receipt.json"),
                status_path: PathBuf::from("unused-stale-status.json"),
                finalized: true,
            };
        }
        assert!(controllers.lock().expect("controller lock").is_some());
        {
            let _matching_guard = RemoteAgentRunGuard {
                controller: &controllers,
                job_id,
                target: RemoteAgentTarget::Codex,
                consent_revision: REMOTE_AGENT_CONSENT_REVISION.into(),
                started_at_ms: 1,
                receipt_path: PathBuf::from("unused-receipt.json"),
                status_path: PathBuf::from("unused-status.json"),
                finalized: true,
            };
        }
        assert!(controllers.lock().expect("controller lock").is_none());
    }

    #[test]
    fn remote_agent_clean_environment_excludes_secrets_injection_and_proxy_credentials() {
        let filtered = filter_remote_agent_environment([
            (OsString::from("SYSTEMROOT"), OsString::from(r"C:\Windows")),
            (OsString::from("GH_TOKEN"), OsString::from("secret")),
            (
                OsString::from("ANTHROPIC_API_KEY"),
                OsString::from("secret"),
            ),
            (
                OsString::from("NODE_OPTIONS"),
                OsString::from("--require attacker.js"),
            ),
            (
                OsString::from("HTTPS_PROXY"),
                OsString::from("https://user:password@example.test"),
            ),
            (OsString::from("NO_PROXY"), OsString::from("localhost")),
        ])
        .expect("filter clean environment");
        let keys = filtered
            .iter()
            .map(|(key, _)| key.to_string_lossy().to_string())
            .collect::<BTreeSet<_>>();
        assert_eq!(
            keys,
            ["NO_PROXY", "SYSTEMROOT"]
                .into_iter()
                .map(str::to_string)
                .collect()
        );
    }

    #[test]
    fn remote_only_environment_is_exact_minimal_and_claude_controls_are_closed() {
        assert!(
            !CODEX_DIRECT_LAUNCH_INSTRUCTION_ISOLATION_SUPPORTED,
            "hidden Codex launch must remain fail-closed until upstream exposes a supported global-instruction disable"
        );
        let root = env::temp_dir().join(format!(
            "editkin-remote-only-env-{}-{}",
            std::process::id(),
            unix_time_ms()
        ));
        let state = root.join("agent-runtime-v3");
        let workspace = root.join("remote-agent-workspace");
        fs::create_dir_all(&state).expect("create state root");
        fs::create_dir_all(&workspace).expect("create workspace");
        let job_id = "a".repeat(32);
        let environment = remote_only_agent_environment(
            &state,
            &workspace,
            &job_id,
            REMOTE_AGENT_CONSENT_REVISION,
        )
        .expect("build remote-only environment");
        assert_eq!(
            environment
                .iter()
                .map(|(key, _)| key.as_str())
                .collect::<BTreeSet<_>>(),
            [
                "EDITKIN_AGENT_STATE_ROOT",
                "EDITKIN_MCP_MODE",
                "EDITKIN_REMOTE_AGENT_CONSENT_REVISION",
                "EDITKIN_REMOTE_AGENT_JOB_ID",
                "EDITKIN_WORKSPACE",
                "ELECTRON_RUN_AS_NODE",
            ]
            .into_iter()
            .collect()
        );
        assert!(environment
            .iter()
            .any(|(key, value)| key == "EDITKIN_MCP_MODE" && value == "remote-only"));
        assert!(environment
            .iter()
            .any(|(key, value)| key == "EDITKIN_REMOTE_AGENT_JOB_ID" && value == &job_id));
        assert!(!environment.iter().any(|(key, _)| {
            key.contains("PLUGIN")
                || key.contains("MODEL")
                || key.contains("ASSET")
                || key.contains("FFMPEG")
                || key.contains("AUTOPILOT")
        }));
        assert_eq!(
            CLAUDE_REMOTE_AGENT_ENVIRONMENT
                .into_iter()
                .map(|(key, value)| (key, value))
                .collect::<BTreeSet<_>>(),
            [
                ("CLAUDE_CODE_DISABLE_ATTACHMENTS", "1"),
                ("CLAUDE_CODE_DISABLE_AUTO_MEMORY", "1"),
                ("CLAUDE_CODE_DISABLE_BACKGROUND_TASKS", "1"),
                ("CLAUDE_CODE_DISABLE_CLAUDE_MDS", "1"),
                ("CLAUDE_CODE_DISABLE_CRON", "1"),
                ("CLAUDE_CODE_SKIP_PROMPT_HISTORY", "1"),
                ("DISABLE_AUTOUPDATER", "1"),
            ]
            .into_iter()
            .collect()
        );
        let claude_probe_environment = remote_agent_process_environment(RemoteAgentTarget::Claude)
            .expect("build Claude readiness-probe environment");
        let claude_probe_controls = claude_probe_environment
            .iter()
            .filter_map(|(key, value)| {
                let key = key.to_str()?;
                CLAUDE_REMOTE_AGENT_ENVIRONMENT
                    .iter()
                    .any(|(expected, _)| *expected == key)
                    .then(|| (key.to_string(), value.to_string_lossy().to_string()))
            })
            .collect::<BTreeSet<_>>();
        assert_eq!(
            claude_probe_controls,
            CLAUDE_REMOTE_AGENT_ENVIRONMENT
                .into_iter()
                .map(|(key, value)| (key.to_string(), value.to_string()))
                .collect()
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn codex_mcp_readback_requires_exact_current_json_schema() {
        let root = env::temp_dir().join(format!(
            "editkin-codex-mcp-inspection-{}-{}",
            std::process::id(),
            unix_time_ms()
        ));
        let state = root.join("state");
        fs::create_dir_all(&state).expect("create state fixture");
        let executable = root.join(if cfg!(windows) { "node.exe" } else { "node" });
        let launcher = root.join("launcher.mjs");
        fs::write(&executable, b"fixture").expect("write executable fixture");
        fs::write(&launcher, b"fixture").expect("write launcher fixture");
        let expected_keys = ["EDITKIN_AGENT_STATE_ROOT", "EDITKIN_WORKSPACE"]
            .into_iter()
            .map(str::to_string)
            .collect::<BTreeSet<_>>();
        let fixture = json!({
            "name": "editkin",
            "enabled": true,
            "disabled_reason": null,
            "transport": {
                "type": "stdio",
                "command": executable,
                "args": [launcher],
                "env": {
                    "EDITKIN_AGENT_STATE_ROOT": state,
                    "EDITKIN_WORKSPACE": root,
                },
                "env_vars": [],
                "cwd": null,
            },
            "enabled_tools": null,
            "disabled_tools": null,
            "startup_timeout_sec": null,
            "tool_timeout_sec": null,
        });
        assert!(codex_mcp_json_is_exact(
            &fixture,
            &executable,
            &launcher,
            &state,
            &expected_keys,
        ));
        for mutated in [
            {
                let mut value = fixture.clone();
                value["forged"] = Value::Bool(true);
                value
            },
            {
                let mut value = fixture.clone();
                value["transport"]["forged"] = Value::Bool(true);
                value
            },
            {
                let mut value = fixture.clone();
                value["enabled"] = Value::Bool(false);
                value
            },
            {
                let mut value = fixture.clone();
                value["transport"]["env_vars"] = json!(["GH_TOKEN"]);
                value
            },
            {
                let mut value = fixture.clone();
                value["enabled_tools"] = json!(["spoof"]);
                value
            },
        ] {
            assert!(!codex_mcp_json_is_exact(
                &mutated,
                &executable,
                &launcher,
                &state,
                &expected_keys,
            ));
        }
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn claude_mcp_readback_requires_exact_structured_fields_and_environment() {
        let root = std::env::temp_dir().join(format!(
            "editkin-claude-mcp-inspection-{}-{}",
            std::process::id(),
            unix_time_ms()
        ));
        fs::create_dir_all(root.join("state")).expect("create state fixture");
        let executable = root.join(if cfg!(windows) { "node.exe" } else { "node" });
        let launcher = root.join("launcher.mjs");
        fs::write(&executable, b"fixture").expect("write executable fixture");
        fs::write(&launcher, b"fixture").expect("write launcher fixture");
        let expected_keys = ["EDITKIN_AGENT_STATE_ROOT", "EDITKIN_WORKSPACE"]
            .into_iter()
            .map(str::to_string)
            .collect::<BTreeSet<_>>();
        let fixture = format!(
            "editkin:\n  Scope: User config (available in all your projects)\n  Status: ✓ Connected\n  Type: stdio\n  Command: {}\n  Args: {}\n  Environment:\n    EDITKIN_AGENT_STATE_ROOT={}\n    EDITKIN_WORKSPACE={}\n\nTo remove this server, run: claude mcp remove \"editkin\" -s user\n",
            executable.display(),
            launcher.display(),
            root.join("state").display(),
            root.display(),
        );
        assert_eq!(
            claude_mcp_text_inspection(
                fixture.as_bytes(),
                &executable,
                &launcher,
                &root.join("state"),
                &expected_keys,
            ),
            Some((true, true))
        );
        for spoofed in [
            fixture.replace("  Command:", "  Note: Command:"),
            fixture.replace("  Args:", "  Command: duplicate\n  Args:"),
            fixture.replace(
                "    EDITKIN_WORKSPACE=",
                "    EXTRA=value\n    EDITKIN_WORKSPACE=",
            ),
            fixture.replace("    EDITKIN_WORKSPACE=", "    MISSING_WORKSPACE="),
            fixture.replace("✓ Connected", "not connected but ✓ Connected later"),
        ] {
            assert_ne!(
                claude_mcp_text_inspection(
                    spoofed.as_bytes(),
                    &executable,
                    &launcher,
                    &root.join("state"),
                    &expected_keys,
                ),
                Some((true, true))
            );
        }
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn claude_mcp_readback_accepts_the_claude_code_2_1_311_report() {
        // #104: Claude Code 2.1.311 prints the remove hint unquoted; the health check then failed a server that
        // `claude mcp list` showed as ✓ Connected.
        let root = std::env::temp_dir().join(format!(
            "editkin-claude-mcp-2-1-311-{}-{}",
            std::process::id(),
            unix_time_ms()
        ));
        fs::create_dir_all(root.join("state")).expect("create state fixture");
        let executable = root.join(if cfg!(windows) { "node.exe" } else { "node" });
        let launcher = root.join("launcher.mjs");
        fs::write(&executable, b"fixture").expect("write executable fixture");
        fs::write(&launcher, b"fixture").expect("write launcher fixture");
        let expected_keys = ["EDITKIN_AGENT_STATE_ROOT", "EDITKIN_WORKSPACE"]
            .into_iter()
            .map(str::to_string)
            .collect::<BTreeSet<_>>();
        let report = format!(
            "editkin:\n  Scope: User config (available in all your projects)\n  Status: ✓ Connected\n  Type: stdio\n  Command: {}\n  Args: {}\n  Environment:\n    EDITKIN_AGENT_STATE_ROOT={}\n    EDITKIN_WORKSPACE={}\n\nTo remove this server, run: claude mcp remove editkin -s user\n",
            executable.display(),
            launcher.display(),
            root.join("state").display(),
            root.display(),
        );
        for text in [
            report.clone(),
            report.replace("-s user", "--scope user"),
            report.replace('\n', "\r\n"),
        ] {
            assert_eq!(
                claude_mcp_text_inspection(
                    text.as_bytes(),
                    &executable,
                    &launcher,
                    &root.join("state"),
                    &expected_keys,
                ),
                Some((true, true)),
                "{text}"
            );
        }
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn embedded_remote_network_policy_is_user_owned_and_lan_first() {
        let policy = remote_network_policy().expect("embedded remote network policy");
        assert_eq!(policy.schema_version, 2);
        assert_eq!(policy.mode, "user-owned-byo");
        assert_eq!(policy.default_transport, "lan");
        assert!(policy.relay_origin.is_empty());
        assert!(policy.public_tunnel_origin.is_empty());
        assert!(!policy.auto_deploy);
        assert!(!policy.provider_required);
        assert_eq!(policy.cost_responsibility, "end-user");
    }

    #[test]
    fn remote_json_reader_is_handle_bounded_and_cas_detects_replacement() {
        let root = env::temp_dir().join(format!(
            "editkin-remote-json-{}-{}",
            std::process::id(),
            unix_time_ms()
        ));
        fs::create_dir_all(&root).expect("create Remote JSON test root");
        let path = root.join("receipt.json");
        fs::write(&path, br#"{"revision":"first"}"#).expect("write first receipt");
        assert_eq!(
            read_remote_json(&path)
                .expect("read bounded receipt")
                .and_then(|value| value
                    .get("revision")
                    .and_then(Value::as_str)
                    .map(str::to_string))
                .as_deref(),
            Some("first")
        );
        let expected = remote_file_identity_at_path(&path).expect("capture destination revision");
        let replacement = root.join("replacement.json");
        fs::write(&replacement, br#"{"revision":"other"}"#).expect("write replacement receipt");
        replace_remote_file(&replacement, &path).expect("replace destination");
        assert!(ensure_remote_destination_revision(&path, expected).is_err());
        fs::write(&path, vec![b'x'; 64 * 1024 + 1]).expect("write oversized receipt");
        assert!(read_remote_json(&path).is_err());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn pending_remote_child_drop_reaps_and_removes_its_runtime_receipt() {
        let root = env::temp_dir().join(format!(
            "editkin-remote-child-{}-{}",
            std::process::id(),
            unix_time_ms()
        ));
        fs::create_dir_all(&root).expect("create Remote child test root");
        let receipt_path = root.join("network-runtime.json");
        let runtime_instance_id = "a".repeat(32);
        write_remote_json_atomic(
            &receipt_path,
            &json!({
                "schema": "editkin.remote-runtime/v3",
                "runtimeInstanceId": runtime_instance_id
            }),
        )
        .expect("write owned runtime receipt");
        #[cfg(windows)]
        let child = Command::new("cmd.exe")
            .args(["/D", "/C", "ping -n 30 127.0.0.1 >NUL"])
            .spawn()
            .expect("spawn Remote guard child");
        #[cfg(unix)]
        let child = Command::new("sh")
            .args(["-c", "sleep 30"])
            .spawn()
            .expect("spawn Remote guard child");
        drop(PendingMobileRemote {
            child: Some(child),
            runtime_receipt_path: receipt_path.clone(),
            runtime_instance_id,
        });
        assert!(!receipt_path.exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn user_owned_remote_origin_validation_fails_closed() {
        assert_eq!(
            validate_user_https_origin("EDITKIN_REMOTE_PUBLIC_URL", "https://remote.example.test")
                .as_deref(),
            Ok("https://remote.example.test")
        );
        for value in [
            "http://remote.example.test",
            "https://user:password@remote.example.test",
            "https://remote.example.test/editkin",
            "https://remote.example.test?owner=hao",
            "https://remote.example.test/#token=secret",
            "https://remote.example.test\\hidden",
            "https://remote example.test",
            "https://127.0.0.1",
            "https://192.168.1.8",
            "https://[::1]",
            "https://[::ffff:7f00:1]",
            "https://2130706433",
            "https://127.1",
            "https://0x7f000001",
            "https://017700000001",
            "https://0177.0.0.1",
            " https://remote.example.test ",
            "https://remote.example.test/",
            "https://",
        ] {
            assert!(
                validate_user_https_origin("EDITKIN_REMOTE_PUBLIC_URL", value).is_err(),
                "unsafe origin should be rejected: {value}"
            );
        }
    }

    #[test]
    fn remote_candidate_approval_is_bound_to_displayed_revision_and_configuration() {
        let configuration = UserRemoteNetworkConfig {
            schema: "editkin.remote-user-config/v1".into(),
            schema_version: 1,
            mode: "user-owned-byo".into(),
            transport: "https-tunnel".into(),
            origin: "https://remote.example.test".into(),
            provider_id: "custom-provider".into(),
            cost_responsibility: "end-user".into(),
            user_confirmed_costs_and_permissions: true,
            configured_at: "2026-09-04T00:00:00.000Z".into(),
            configuration_id: "a".repeat(64),
        };
        let candidate = PendingUserRemoteNetworkConfig {
            schema: "editkin.remote-config-candidate/v1".into(),
            candidate_revision: "11111111-1111-4111-8111-111111111111".into(),
            expected_configuration_id: None,
            prepared_at_ms: 1,
            expires_at_ms: 30 * 60 * 1_000 + 1,
            configuration,
        };
        assert!(ensure_remote_candidate_matches_approval(
            &candidate,
            "11111111-1111-4111-8111-111111111111",
            &"a".repeat(64),
        )
        .is_ok());
        assert!(ensure_remote_candidate_matches_approval(
            &candidate,
            "22222222-2222-4222-8222-222222222222",
            &"a".repeat(64),
        )
        .is_err());
        assert!(ensure_remote_candidate_matches_approval(
            &candidate,
            "11111111-1111-4111-8111-111111111111",
            &"b".repeat(64),
        )
        .is_err());
    }

    #[test]
    fn mobile_remote_start_authority_requires_exact_candidate_or_active_configuration_identity() {
        let configuration_id = "a".repeat(64);
        let configuration = UserRemoteNetworkConfig {
            schema: "editkin.remote-user-config/v1".into(),
            schema_version: 1,
            mode: "user-owned-byo".into(),
            transport: "https-tunnel".into(),
            origin: "https://remote.example.test".into(),
            provider_id: "custom-provider".into(),
            cost_responsibility: "end-user".into(),
            user_confirmed_costs_and_permissions: true,
            configured_at: "2026-09-04T00:00:00.000Z".into(),
            configuration_id: configuration_id.clone(),
        };
        let candidate_revision = "11111111-1111-4111-8111-111111111111";
        let candidate = PendingUserRemoteNetworkConfig {
            schema: "editkin.remote-config-candidate/v1".into(),
            candidate_revision: candidate_revision.into(),
            expected_configuration_id: None,
            prepared_at_ms: 1,
            expires_at_ms: 30 * 60 * 1_000 + 1,
            configuration,
        };

        assert!(ensure_mobile_remote_start_authority(
            Some(&candidate),
            None,
            false,
            Some(true),
            Some(candidate_revision),
            Some(&configuration_id),
        )
        .is_ok());
        for result in [
            ensure_mobile_remote_start_authority(
                Some(&candidate),
                None,
                false,
                None,
                Some(candidate_revision),
                Some(&configuration_id),
            ),
            ensure_mobile_remote_start_authority(
                Some(&candidate),
                None,
                false,
                Some(true),
                None,
                Some(&configuration_id),
            ),
            ensure_mobile_remote_start_authority(
                Some(&candidate),
                None,
                false,
                Some(true),
                Some("22222222-2222-4222-8222-222222222222"),
                Some(&configuration_id),
            ),
            ensure_mobile_remote_start_authority(
                Some(&candidate),
                None,
                false,
                Some(true),
                Some(candidate_revision),
                Some(&"b".repeat(64)),
            ),
            ensure_mobile_remote_start_authority(
                Some(&candidate),
                Some(&configuration_id),
                false,
                Some(true),
                Some(candidate_revision),
                Some(&configuration_id),
            ),
            ensure_mobile_remote_start_authority(
                Some(&candidate),
                None,
                true,
                Some(true),
                Some(candidate_revision),
                Some(&configuration_id),
            ),
        ] {
            assert!(result.is_err());
        }

        assert!(ensure_mobile_remote_start_authority(
            None,
            Some(&configuration_id),
            false,
            Some(true),
            None,
            Some(&configuration_id),
        )
        .is_ok());
        assert!(ensure_mobile_remote_start_authority(
            None,
            Some(&configuration_id),
            true,
            Some(true),
            None,
            Some(&configuration_id),
        )
        .is_ok());
        for result in [
            ensure_mobile_remote_start_authority(
                None,
                Some(&configuration_id),
                false,
                None,
                None,
                Some(&configuration_id),
            ),
            ensure_mobile_remote_start_authority(
                None,
                Some(&configuration_id),
                false,
                Some(true),
                None,
                None,
            ),
            ensure_mobile_remote_start_authority(
                None,
                Some(&configuration_id),
                false,
                Some(true),
                None,
                Some(&"b".repeat(64)),
            ),
            ensure_mobile_remote_start_authority(
                None,
                Some(&configuration_id),
                false,
                Some(true),
                Some(candidate_revision),
                Some(&configuration_id),
            ),
            ensure_mobile_remote_start_authority(
                None,
                None,
                false,
                None,
                None,
                Some(&configuration_id),
            ),
        ] {
            assert!(result.is_err());
        }
        assert!(ensure_mobile_remote_start_authority(None, None, false, None, None, None).is_ok());
    }

    #[test]
    fn remote_network_summary_blocks_renewal_legacy_conflict_and_marks_env_read_only() {
        let legacy = PendingRemoteSetupRecord::Legacy(PendingRemoteAgentSetup {
            schema: "editkin.remote-setup-confirmation/v1".into(),
            confirmation_id: "11111111-1111-4111-8111-111111111111".into(),
            transport: "https-tunnel".into(),
            provider_id: "legacy-provider".into(),
            cost_responsibility: "end-user".into(),
            auto_deploy: false,
            prepared_at: "2026-09-04T00:00:00.000Z".into(),
            remote_agent_job_id: None,
            remote_agent_consent_revision: None,
        });
        let renewal =
            remote_network_summary_disposition(None, true, false, false, false, "lan", false, 1);
        assert_eq!(renewal.setup_phase, "RENEWAL_RECONCILIATION_REQUIRED");
        assert_eq!(
            renewal.truth_label,
            "RENEWAL_RECOVERY_REQUIRED_NO_AUTOMATIC_REPLAY"
        );
        assert!(!renewal.resume_available);

        let legacy_block = remote_network_summary_disposition(
            Some(&legacy),
            false,
            false,
            false,
            false,
            "lan",
            false,
            1,
        );
        assert_eq!(legacy_block.setup_phase, "LEGACY_PENDING_BLOCKED");
        assert_eq!(
            legacy_block.truth_label,
            "LEGACY_PENDING_REQUIRES_MIGRATION_OR_DISCARD"
        );
        assert!(!legacy_block.resume_available);

        let conflict = remote_network_summary_disposition(
            None,
            false,
            true,
            false,
            true,
            "https-tunnel",
            false,
            1,
        );
        assert_eq!(conflict.setup_phase, "STATE_RECONCILIATION_REQUIRED");
        assert_eq!(
            conflict.truth_label,
            "STATE_CONFLICT_REQUIRES_MANUAL_RECONCILIATION"
        );
        assert!(!conflict.resume_available);

        let environment = remote_network_summary_disposition(
            None,
            false,
            false,
            false,
            true,
            "https-tunnel",
            false,
            1,
        );
        assert_eq!(environment.setup_phase, "ENV_CONFIGURED_READ_ONLY");
        assert_eq!(environment.truth_label, "ENV_CONFIGURED_OUTSIDE_EDITKIN");
        assert!(!environment.resume_available);
    }

    #[test]
    fn remote_state_conflict_and_agent_launch_preflight_fail_closed() {
        let configuration_id = "a".repeat(64);
        let configuration = UserRemoteNetworkConfig {
            schema: "editkin.remote-user-config/v1".into(),
            schema_version: 1,
            mode: "user-owned-byo".into(),
            transport: "https-tunnel".into(),
            origin: "https://remote.example.test".into(),
            provider_id: "custom-provider".into(),
            cost_responsibility: "end-user".into(),
            user_confirmed_costs_and_permissions: true,
            configured_at: "2026-09-04T00:00:00.000Z".into(),
            configuration_id: "b".repeat(64),
        };
        let matching_candidate = PendingUserRemoteNetworkConfig {
            schema: "editkin.remote-config-candidate/v1".into(),
            candidate_revision: "11111111-1111-4111-8111-111111111111".into(),
            expected_configuration_id: Some(configuration_id.clone()),
            prepared_at_ms: 1,
            expires_at_ms: 30 * 60 * 1_000 + 1,
            configuration,
        };
        assert!(!remote_network_state_conflict(
            Some(&configuration_id),
            Some(&matching_candidate),
            false,
            false,
        ));
        assert!(remote_network_state_conflict(
            Some(&"c".repeat(64)),
            Some(&matching_candidate),
            false,
            false,
        ));
        assert!(remote_network_state_conflict(None, None, true, true,));

        let legacy = PendingRemoteSetupRecord::Legacy(PendingRemoteAgentSetup {
            schema: "editkin.remote-setup-confirmation/v1".into(),
            confirmation_id: "11111111-1111-4111-8111-111111111111".into(),
            transport: "https-tunnel".into(),
            provider_id: "legacy-provider".into(),
            cost_responsibility: "end-user".into(),
            auto_deploy: false,
            prepared_at: "2026-09-04T00:00:00.000Z".into(),
            remote_agent_job_id: None,
            remote_agent_consent_revision: None,
        });
        assert!(ensure_remote_setup_agent_launch_state(false, false, false, true, None).is_err());
        assert!(
            ensure_remote_setup_agent_launch_state(false, false, false, false, Some(&legacy),)
                .is_err()
        );
        assert!(ensure_remote_setup_agent_launch_state(true, false, false, false, None).is_err());
        assert!(ensure_remote_setup_agent_launch_state(false, true, false, false, None).is_err());
        assert!(ensure_remote_setup_agent_launch_state(false, false, true, false, None).is_err());
        let provider =
            PendingRemoteSetupRecord::ProviderProposal(remote_provider_proposal_fixture());
        assert!(ensure_remote_setup_agent_launch_state(
            false,
            false,
            false,
            false,
            Some(&provider),
        )
        .is_ok());
    }

    #[test]
    fn renewal_artifact_detection_and_environment_identity_are_deterministic() {
        let root = env::temp_dir().join(format!(
            "editkin-remote-renewing-presence-{}-{}",
            std::process::id(),
            unix_time_ms()
        ));
        fs::create_dir_all(&root).expect("create renewal fixture root");
        let renewing = root.join("network-setup-pending.json.renewing");
        assert!(!remote_renewing_artifact_present(&renewing).expect("absent artifact"));
        fs::write(&renewing, b"{partial").expect("write crash artifact");
        assert!(remote_renewing_artifact_present(&renewing).expect("present artifact"));
        let tunnel_id =
            remote_environment_configuration_id("https-tunnel", "https://remote.example.test");
        assert_eq!(tunnel_id.len(), 64);
        assert_eq!(
            tunnel_id,
            remote_environment_configuration_id("https-tunnel", "https://remote.example.test",)
        );
        assert_ne!(
            tunnel_id,
            remote_environment_configuration_id("cloud-relay", "https://remote.example.test",)
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn user_owned_remote_port_rejects_ephemeral_or_invalid_values() {
        assert_eq!(parse_remote_port("1"), Ok(1));
        assert_eq!(parse_remote_port("65535"), Ok(65535));
        for value in ["0", "65536", "not-a-port"] {
            assert!(parse_remote_port(value).is_err(), "invalid port: {value}");
        }
    }

    #[test]
    fn remote_command_spool_drains_complete_files_once_in_order() {
        let root = env::temp_dir().join(format!(
            "editkin-remote-spool-{}-{}",
            std::process::id(),
            unix_time_ms()
        ));
        fs::create_dir_all(&root).expect("create spool");
        fs::write(
            root.join("0000000000002-b.json"),
            r#"{"id":"second","instruction":"重做"}"#,
        )
        .expect("second command");
        fs::write(
            root.join("0000000000001-a.json"),
            r#"{"id":"first","instruction":"復原"}"#,
        )
        .expect("first command");
        fs::write(root.join("0000000000003-c.tmp"), "{partial").expect("incomplete command");
        let commands = drain_remote_commands(&root).expect("drain commands");
        assert_eq!(commands.len(), 2);
        assert_eq!(commands[0].get("id").and_then(Value::as_str), Some("first"));
        assert_eq!(
            commands[1].get("id").and_then(Value::as_str),
            Some("second")
        );
        assert!(drain_remote_commands(&root)
            .expect("second drain")
            .is_empty());
        assert!(root.join("0000000000003-c.tmp").exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn embedded_release_input_manifest_matches_crate_version() {
        let manifest = release_input_manifest().expect("embedded build manifest");
        assert_eq!(
            manifest.get("schemaVersion").and_then(Value::as_u64),
            Some(2)
        );
        assert_eq!(
            manifest.get("productVersion").and_then(Value::as_str),
            Some(env!("CARGO_PKG_VERSION"))
        );
        assert_eq!(
            manifest.get("product").and_then(Value::as_str),
            Some("Editkin")
        );
        assert_eq!(
            manifest
                .pointer("/scope/productMode")
                .and_then(Value::as_str),
            Some("native-only-auto-roto")
        );
        assert_eq!(
            manifest
                .pointer("/scope/researchBoundary")
                .and_then(Value::as_str),
            Some("repository-retained-artifact-excluded")
        );
    }
}
