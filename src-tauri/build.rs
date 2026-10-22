use sha2::{Digest, Sha256};
use std::{env, fs, io::Read, path::PathBuf};

// Deliberately reviewed native attestation, not a value copied from the incoming
// manifest. This scope keeps the owner-authorized visual grant while separating
// the mutable product evidence ledger from executable runtime build identity.
const EDITKIN_PRODUCT_POLICY_SHA256: &str =
    "163608ac9aeb7da11b3db6c8753ac9fe5d7c288f1b72467d28400d2be75f905a";

// Every command registered in `tauri::generate_handler!`. Declaring them in the app manifest makes each
// one require an explicit capability grant (src-tauri/capabilities/main-window-commands.json); test and
// smoke commands are granted only at runtime inside the isolated integration runtime. The four Auto Roto
// research commands exist only in research builds, so their names must not reach the product binary's
// generated ACL manifest (the Auto Roto freshness gate rejects research markers in editkin.exe).
// src/desktop/tauriCommandAllowlist.test.ts keeps these lists, the handler list and the grants in sync.
const PRODUCT_APP_COMMANDS: &[&str] = &[
    "pick_media", "import_media_paths", "pick_batch_media", "get_batch_session",
    "run_batch_auto_edit_item", "open_batch_project", "preview_paths", "list_creative_library",
    "list_installed_plugins", "get_workflow_profile", "save_workflow_profile",
    "open_plugin_folder", "compile_plugin_tool", "import_creative_asset", "preview_creative_asset",
    "read_mesh_3d_font", "read_bundled_font_face", "read_color_asset", "list_color_luts_v1", "pick_color_lut_v1", "import_color_lut_v1", "read_color_lut_v1", "prepare_media", "clip_media_derivative",
    "smart_cut_media", "automatic_caption_media", "detect_scenes", "analyze_motion_track",
    "analyze_auto_roto", "open_project", "save_project", "load_recovery", "save_recovery",
    "clear_recovery", "integration_smoke_enabled", "render_project", "render_alpha_master",
    "render_openexr_sequence", "render_native_effect_preview", "render_project_smoke",
    "render_openexr_sequence_smoke", "batch_auto_edit_smoke", "start_mobile_remote",
    "get_mobile_remote_network_summary", "list_remote_provider_connectors",
    "update_mobile_snapshot", "poll_mobile_commands", "get_mobile_remote_status",
    "revoke_mobile_device", "stop_mobile_remote", "check_update_available", "check_for_updates",
    "get_update_job_result", "install_update", "start_native_audio_preview",
    "native_audio_preview_status", "stop_native_audio_preview", "gpu_compositor_status",
    "gpu_engine_status", "begin_gpu_preview_owner", "end_gpu_preview_owner",
    "start_gpu_preview_playback", "stop_gpu_preview_playback", "acknowledge_gpu_preview_playback",
    "inspect_gpu_preview_playback", "load_gpu_preview_session", "load_gpu_engine_preview_session",
    "update_gpu_engine_preview_frame", "load_gpu_engine_video_preview_session",
    "load_gpu_engine_video_frame_preview_session", "render_gpu_engine_video_preview_frame",
    "present_gpu_engine_video_preview_frame", "release_gpu_engine_video_preview_session",
    "update_gpu_preview_properties", "render_gpu_preview_frame", "release_gpu_preview_session",
    "open_gpu_video_preview_session", "decode_gpu_video_preview_frame",
    "decode_gpu_video_preview_at_time", "stage_gpu_video_preview_at_time",
    "bind_gpu_preview_surface", "present_gpu_video_preview_at_time", "hide_gpu_preview_surface",
    "release_gpu_preview_surface", "seek_gpu_video_preview_session",
    "release_gpu_video_preview_session", "recover_gpu_device", "inject_gpu_device_loss_for_test",
    "render_gpu_composition", "smoke_ready", "release_input_manifest",
    "resident_audio_capabilities", "open_resident_audio", "replace_resident_audio",
    "control_resident_audio", "close_resident_audio", "resident_audio_status", "copy_agent_setup",
    "inspect_agent_connections", "launch_remote_setup_agent", "get_remote_setup_agent_status",
    "cancel_remote_setup_agent", "template_short_prepare", "template_short_confirm_rights",
    "start_template_short_job", "template_short_job_status", "cancel_template_short_job",
    "save_template_short_video", "open_template_short_project", "reveal_in_folder",
    "render_job_progress", "cancel_render_job", "run_engine_task_v1", "cancel_engine_task_v1", "app_build_info", "set_close_guard",
    "acknowledge_close_request", "close_window_confirmed", "inspect_project_file", "open_project_path",
    "check_media_paths", "pick_relink_media", "keep_recovery_aside",
];

const RESEARCH_ONLY_APP_COMMANDS: &[&str] = &[
    "inspect_auto_roto_video_model", "install_auto_roto_video_model",
    "pick_and_install_auto_roto_video_model", "repair_auto_roto_video_model",
];

fn app_commands() -> &'static [&'static str] {
    if env::var_os("CARGO_FEATURE_AUTO_ROTO_RESEARCH").is_none() {
        return PRODUCT_APP_COMMANDS;
    }
    let mut all = PRODUCT_APP_COMMANDS.to_vec();
    all.extend_from_slice(RESEARCH_ONLY_APP_COMMANDS);
    Box::leak(all.into_boxed_slice())
}

// tauri-build writes permissions/autogenerated/<command>.toml for each declared command and never deletes
// old files, so a file left by an earlier manifest (for example a research command) would re-enter this
// build's ACL. Keep that generated folder exactly in step with the commands declared for this build.
fn build_with_app_manifest(manifest_dir: &std::path::Path) {
    let commands = app_commands();
    let generated = manifest_dir.join("permissions").join("autogenerated");
    if let Ok(entries) = fs::read_dir(&generated) {
        for entry in entries {
            let path = entry.expect("read autogenerated permission entry").path();
            let stem = path.file_stem().and_then(|stem| stem.to_str()).unwrap_or_default();
            if path.extension().and_then(|ext| ext.to_str()) == Some("toml") && !commands.contains(&stem) {
                fs::remove_file(&path).expect("remove stale autogenerated permission");
            }
        }
    }
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(commands)),
    )
    .expect("tauri build with the Editkin app command manifest");
}

fn main() {
    let manifest_dir =
        PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    // Community verification cannot attest the owner-only delivered product.
    // Keep its identity distinct so it cannot satisfy the official release gate.
    if cfg!(feature = "community-desktop") {
        let mut files = serde_json::Map::new();
        let root = manifest_dir.parent().expect("community source root");
        for relative in [
            "package-lock.json",
            "desktop-dist/service.mjs",
            "src-tauri/Cargo.toml",
            "src-tauri/Cargo.lock",
            "src-tauri/build.rs",
            "src-tauri/tauri.conf.json",
            "src-tauri/remote-relay.json",
            "native/hao-core/src/engine/audio_session_protocol.rs",
        ] {
            hash_community_inputs(root, &root.join(relative), &mut files);
        }
        for relative in ["src-tauri/src", "src-tauri/capabilities", "src/shared", "native/shared", "dist"] {
            hash_community_inputs(root, &root.join(relative), &mut files);
        }
        files.sort_keys();
        let identity = serde_json::json!({
            "schemaVersion": 1,
            "product": "Editkin",
            "productVersion": env::var("CARGO_PKG_VERSION").expect("package version"),
            "target": env::var("TARGET").expect("build target"),
            "scope": {
                "id": "editkin.community-desktop-build/v1",
                "officialRelease": false
            },
            "files": files
        });
        fs::write(
            PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR")).join("release-input-identity.json"),
            serde_json::to_vec(&identity).expect("serialize community identity"),
        ).expect("write community identity");
        build_with_app_manifest(&manifest_dir);
        return;
    }
    let release_manifest_path = manifest_dir.join("../.release-input-manifest.json");
    println!("cargo:rerun-if-changed={}", release_manifest_path.display());
    let bytes = fs::read(&release_manifest_path).expect("read Editkin release input manifest");
    let manifest: serde_json::Value =
        serde_json::from_slice(&bytes).expect("parse Editkin release input manifest");
    for required in [
        "schemaVersion",
        "product",
        "productVersion",
        "inputIdentity",
        "outputIdentity",
        "scope",
    ] {
        assert!(
            !manifest[required].is_null(),
            "release input manifest is missing {required}"
        );
    }
    assert_eq!(
        manifest["schemaVersion"], 2,
        "release input manifest must use product-scoped schema v2"
    );
    assert_eq!(
        manifest["scope"]["id"], "editkin.formal-product-build-scope/v1",
        "release input manifest scope is not the formal product scope"
    );
    assert_eq!(
        manifest["scope"]["productMode"], "native-only-auto-roto",
        "release input manifest may not enable a research Auto Roto product engine"
    );
    assert_eq!(
        manifest["scope"]["researchBoundary"], "repository-retained-artifact-excluded",
        "release input manifest must keep research provenance outside the product artifact"
    );
    assert_eq!(
        manifest["scope"]["policySha256"], EDITKIN_PRODUCT_POLICY_SHA256,
        "release input manifest does not attest the pinned formal product input policy"
    );
    let embedded_identity = serde_json::json!({
        "schemaVersion": manifest["schemaVersion"],
        "product": manifest["product"],
        "productVersion": manifest["productVersion"],
        "inputIdentity": manifest["inputIdentity"],
        "outputIdentity": manifest["outputIdentity"],
        "scope": manifest["scope"],
        "manifestSha256": format!("{:x}", Sha256::digest(&bytes)),
        "detailLocation": "runtime/BUILD-MANIFEST.json"
    });
    let output =
        PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR")).join("release-input-identity.json");
    fs::write(
        output,
        serde_json::to_vec(&embedded_identity).expect("serialize release identity"),
    )
    .expect("write embedded release identity");
    build_with_app_manifest(&manifest_dir);
}

fn hash_community_inputs(root: &std::path::Path, path: &std::path::Path, files: &mut serde_json::Map<String, serde_json::Value>) {
    println!("cargo:rerun-if-changed={}", path.display());
    let metadata = fs::symlink_metadata(path).expect("inspect community build input");
    assert!(!metadata.file_type().is_symlink(), "community build inputs must not be symlinks");
    if metadata.is_dir() {
        for entry in fs::read_dir(path).expect("read community build directory") {
            hash_community_inputs(root, &entry.expect("read community build entry").path(), files);
        }
    } else {
        assert!(metadata.is_file(), "community build input must be a regular file");
        let relative = path.strip_prefix(root).expect("community input within source root")
            .to_str().expect("UTF-8 community input path").replace('\\', "/");
        let mut file = fs::File::open(path).expect("open community build input");
        let mut hash = Sha256::new();
        let mut buffer = [0_u8; 16 * 1024];
        loop {
            let count = file.read(&mut buffer).expect("read community build input");
            if count == 0 {
                break;
            }
            hash.update(&buffer[..count]);
        }
        files.insert(relative, format!("{hash:x}", hash = hash.finalize()).into());
    }
}
