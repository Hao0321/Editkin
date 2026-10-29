//! One main-window task bridge; existing job lifetime and analysis worker remain the owners.
use serde::Deserialize;
use serde_json::{json, Value};
use std::{fs, path::{Path, PathBuf}, sync::{Arc, atomic::{AtomicBool, Ordering}}, thread, time::Duration};
use tauri::{ipc::Channel, AppHandle, Manager, WebviewWindow};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EngineRequestV1 { schema: String, kind: String, #[serde(default)] project: Option<Value>, input: Value }

pub fn main_window(label: &str) -> Result<(), String> {
    if label != "main" { return Err("ENGINE_TASK_MAIN_WINDOW_REQUIRED".into()); } Ok(())
}
const MOTION_INPUT_INVALID: &str = "ENGINE_TASK_MOTION_LIBRARY_INPUT_INVALID";
const MOTION_ASSETS_REQUIRED: &str = "ENGINE_TASK_MOTION_LIBRARY_ASSETS_REQUIRED";
const MOTION_OUTPUT_NOT_ADMITTED: &str = "ENGINE_TASK_MOTION_LIBRARY_OUTPUT_NOT_ADMITTED";
/// Motion Library render-before-dispatch: the renderer names an item, its params and the project frame; never a path or a project.
fn motion_library_input(request: &EngineRequestV1) -> Result<(), String> {
    let fields = request.input.as_object().ok_or(MOTION_INPUT_INVALID)?;
    if request.project.is_some() || fields.len() != 6
        || fields.keys().any(|k| !matches!(k.as_str(), "operationId" | "itemId" | "params" | "width" | "height" | "fps")) {
        return Err(MOTION_INPUT_INVALID.into());
    }
    let item = fields.get("itemId").and_then(Value::as_str).ok_or(MOTION_INPUT_INVALID)?;
    let number: u32 = item.get(1..).filter(|s| s.len() == 2 && s.bytes().all(|b| b.is_ascii_digit())).and_then(|s| s.parse().ok()).unwrap_or(0);
    if item.len() != 3 || !matches!(item.as_bytes()[0], b'T' | b'X' | b'B') || !(1..=80).contains(&number) { return Err(MOTION_INPUT_INVALID.into()); }
    let params = fields.get("params").filter(|p| p.is_object()).ok_or(MOTION_INPUT_INVALID)?;
    if serde_json::to_vec(params).map_err(|e| e.to_string())?.len() > 64 * 1024 { return Err(MOTION_INPUT_INVALID.into()); }
    for name in ["width", "height"] {
        fields.get(name).and_then(Value::as_u64).filter(|v| (16..=7680).contains(v)).ok_or(MOTION_INPUT_INVALID)?;
    }
    fields.get("fps").and_then(Value::as_f64).filter(|v| v.is_finite() && *v > 0.0 && *v <= 240.0).ok_or(MOTION_INPUT_INVALID)?;
    Ok(())
}
const STYLE_INPUT_INVALID: &str = "ENGINE_TASK_STYLE_TEMPLATE_INPUT_INVALID";
const STYLE_OUTPUT_REQUIRED: &str = "ENGINE_TASK_STYLE_TEMPLATE_OUTPUT_REQUIRED";
const STYLE_OUTPUT_NOT_ADMITTED: &str = "ENGINE_TASK_STYLE_TEMPLATE_OUTPUT_NOT_ADMITTED";
/// Folders the service writes under the cache root: clip renders, picture derivatives, still renders and frame work folders.
const STYLE_OUTPUT_FOLDERS: [&str; 4] = ["styletpl-clip", "styletpl-img", "styletpl", ".styletpl-work"];
/// The picture record the renderer may send (engineTaskContractV1.ts styleTemplateAssetRecordV1); nothing else of a project asset.
const STYLE_ASSET_FIELDS: [&str; 11] = ["id", "name", "kind", "uri", "duration", "width", "height", "license", "redistributable", "rightsBasis", "distributionScope"];
/// `^[SH][0-9]+_[a-z0-9_]+$`, at most 64 bytes: a template id, and so a single safe folder name under styletpl-clip.
fn style_template_id(id: &str) -> bool {
    let b = id.as_bytes();
    let digits = b.iter().skip(1).take_while(|c| c.is_ascii_digit()).count();
    b.len() <= 64 && matches!(b.first(), Some(b'S' | b'H')) && digits > 0 && b.get(1 + digits) == Some(&b'_') && b.len() > 2 + digits
        && b[2 + digits..].iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'_')
}
/// Style template render-before-dispatch: a template, its slots, the project frame and length, and the pictures the slots
/// name. Never a project, an output path or a resolved file: the host admits each picture uri itself (run below).
fn style_template_input(request: &EngineRequestV1) -> Result<(), String> {
    let fields = request.input.as_object().ok_or(STYLE_INPUT_INVALID)?;
    if request.project.is_some() || fields.len() != 8 || fields.keys().any(|k| !matches!(k.as_str(),
        "operationId" | "templateId" | "slots" | "width" | "height" | "fps" | "durationSeconds" | "assets")) {
        return Err(STYLE_INPUT_INVALID.into());
    }
    if serde_json::to_vec(&request.input).map_err(|e| e.to_string())?.len() > 256 * 1024 { return Err(STYLE_INPUT_INVALID.into()); }
    fields.get("templateId").and_then(Value::as_str).filter(|id| style_template_id(id)).ok_or(STYLE_INPUT_INVALID)?;
    let slots = fields.get("slots").and_then(Value::as_object).ok_or(STYLE_INPUT_INVALID)?;
    if slots.len() != 3 || ["text", "color", "image"].iter().any(|k| !slots.get(*k).is_some_and(Value::is_object)) { return Err(STYLE_INPUT_INVALID.into()); }
    for name in ["width", "height"] {
        fields.get(name).and_then(Value::as_u64).filter(|v| (16..=7680).contains(v)).ok_or(STYLE_INPUT_INVALID)?;
    }
    fields.get("fps").and_then(Value::as_f64).filter(|v| v.is_finite() && (1.0..=240.0).contains(v)).ok_or(STYLE_INPUT_INVALID)?;
    fields.get("durationSeconds").and_then(Value::as_f64).filter(|v| v.is_finite() && (0.5..=120.0).contains(v)).ok_or(STYLE_INPUT_INVALID)?;
    let assets = fields.get("assets").and_then(Value::as_array).filter(|a| a.len() <= 6).ok_or(STYLE_INPUT_INVALID)?;
    let mut ids = std::collections::HashSet::new();
    for asset in assets {
        let record = asset.as_object().ok_or(STYLE_INPUT_INVALID)?;
        if record.keys().any(|k| !STYLE_ASSET_FIELDS.contains(&k.as_str())) { return Err(STYLE_INPUT_INVALID.into()); }
        let id = record.get("id").and_then(Value::as_str).filter(|s| !s.is_empty() && s.len() <= 640).ok_or(STYLE_INPUT_INVALID)?;
        if !ids.insert(id) { return Err(STYLE_INPUT_INVALID.into()); }
        record.get("name").and_then(Value::as_str).ok_or(STYLE_INPUT_INVALID)?;
        if !matches!(record.get("kind").and_then(Value::as_str), Some("image" | "video")) { return Err(STYLE_INPUT_INVALID.into()); }
        record.get("uri").and_then(Value::as_str).filter(|s| !s.is_empty() && s.len() <= 4 * 32768 && !s.chars().any(char::is_control)).ok_or(STYLE_INPUT_INVALID)?;
        record.get("duration").and_then(Value::as_f64).filter(|v| v.is_finite() && *v >= 0.0).ok_or(STYLE_INPUT_INVALID)?;
        for name in ["width", "height"] {
            if let Some(v) = record.get(name) { v.as_f64().filter(|v| v.is_finite() && *v > 0.0).ok_or(STYLE_INPUT_INVALID)?; }
        }
        for name in ["license", "rightsBasis", "distributionScope"] {
            if let Some(v) = record.get(name) { v.as_str().ok_or(STYLE_INPUT_INVALID)?; }
        }
        if let Some(v) = record.get("redistributable") { v.as_bool().ok_or(STYLE_INPUT_INVALID)?; }
    }
    Ok(())
}
fn header(request: &EngineRequestV1) -> Result<&str, String> {
    if request.schema != "editkin.engine-task/v1"
        || !matches!(request.kind.as_str(), "auto_reframe_v1" | "desktop_batch_item_v1" | "motion_library_render_v1" | "style_template_render_v1") {
        return Err("ENGINE_TASK_KIND_UNSUPPORTED".into());
    }
    if request.kind == "motion_library_render_v1" { motion_library_input(request)?; }
    if request.kind == "style_template_render_v1" { style_template_input(request)?; }
    if request.kind == "desktop_batch_item_v1" {
        let fields = request.input.as_object().ok_or("ENGINE_TASK_BATCH_INPUT_INVALID")?;
        if request.project.is_some() || fields.len() != 3 || fields.keys().any(|k| !matches!(k.as_str(), "operationId" | "sessionId" | "jobId")) {
            return Err("ENGINE_TASK_BATCH_INPUT_INVALID".into());
        }
        for name in ["sessionId", "jobId"] {
            let value = fields.get(name).and_then(Value::as_str).ok_or("ENGINE_TASK_BATCH_INPUT_INVALID")?;
            if value.is_empty() || value.len() > 80 || !value.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') {
                return Err("ENGINE_TASK_BATCH_INPUT_INVALID".into());
            }
        }
    }
    request.input.get("operationId").and_then(Value::as_str).filter(|id| crate::render_jobs::valid_job_id(id))
        .ok_or_else(|| "ENGINE_TASK_JOB_ID_INVALID".into())
}
pub fn plain_local(path: &Path) -> Result<(), String> {
    if crate::local_path_text_problem(&path.to_string_lossy()).is_some() || path.to_string_lossy().chars().any(char::is_control) {
        return Err("ENGINE_TASK_LOCAL_PATH_REQUIRED".into());
    }
    for ancestor in path.ancestors() {
        let info = fs::symlink_metadata(ancestor).map_err(|e| e.to_string())?;
        #[cfg(windows)] {
            use std::os::windows::fs::MetadataExt;
            if info.file_attributes() & 0x400 != 0 { return Err("ENGINE_TASK_LINK_REFUSED".into()); }
        }
        if info.file_type().is_symlink() { return Err("ENGINE_TASK_LINK_REFUSED".into()); }
    }
    Ok(())
}
fn original_uri(request: &EngineRequestV1) -> Result<&str, String> {
    let project = request.project.as_ref().ok_or("ENGINE_TASK_PROJECT_REQUIRED")?;
    let clip_id = request.input.get("clipId").and_then(Value::as_str).ok_or("ENGINE_TASK_CLIP_REQUIRED")?;
    let tracks = project.get("tracks").and_then(Value::as_array).ok_or("ENGINE_TASK_PROJECT_REQUIRED")?;
    let mut selected = tracks.iter().flat_map(|t| t.get("clips").and_then(Value::as_array).into_iter().flatten())
        .filter(|c| c.get("id").and_then(Value::as_str) == Some(clip_id));
    let clip = selected.next().ok_or("ENGINE_TASK_CLIP_REQUIRED")?;
    if selected.next().is_some() { return Err("ENGINE_TASK_CLIP_AMBIGUOUS".into()); }
    let asset_id = clip.get("assetId").and_then(Value::as_str).ok_or("ENGINE_TASK_ASSET_REQUIRED")?;
    let mut assets = project.get("assets").and_then(Value::as_array).ok_or("ENGINE_TASK_ASSET_REQUIRED")?
        .iter().filter(|a| a.get("id").and_then(Value::as_str) == Some(asset_id));
    let asset = assets.next().ok_or("ENGINE_TASK_ASSET_REQUIRED")?;
    if assets.next().is_some() || asset.get("kind").and_then(Value::as_str) != Some("video") { return Err("ENGINE_TASK_VIDEO_REQUIRED".into()); }
    asset.get("uri").and_then(Value::as_str).filter(|s| !s.is_empty()).ok_or_else(|| "ENGINE_TASK_SOURCE_REQUIRED".into())
}
fn source_path(uri: &str, asset_base: &Path) -> Result<PathBuf, String> {
    if uri.starts_with("file:") {
        return tauri::Url::parse(uri).map_err(|e| e.to_string())?.to_file_path().map_err(|_| "ENGINE_TASK_FILE_URI_INVALID".into());
    }
    if uri.contains("://") || uri.starts_with("creative:") { return Err("ENGINE_TASK_SOURCE_UNRESOLVED".into()); }
    let raw = PathBuf::from(uri);
    Ok(if raw.is_absolute() { raw } else { asset_base.join(uri.trim_start_matches(['/', '\\'])) })
}
/// Project media only: a local regular file the webview's asset scope already admits (picked or opened media), or a
/// bundled file under the asset base. Returns the canonical local path.
fn allowed_source(app: &AppHandle, uri: &str, base: &Path) -> Result<PathBuf, String> {
    let raw = source_path(uri, base)?;
    if crate::local_path_text_problem(&raw.to_string_lossy()).is_some() { return Err("ENGINE_TASK_LOCAL_PATH_REQUIRED".into()); }
    // Check every original ancestor before canonicalization; do not hide a junction by resolving it first.
    plain_local(&raw)?;
    let path = crate::process_compatible_path(fs::canonicalize(&raw).map_err(|e| e.to_string())?);
    let bundled = !Path::new(uri).is_absolute() && !uri.starts_with("file:")
        && path.starts_with(crate::process_compatible_path(fs::canonicalize(base).map_err(|e| e.to_string())?));
    if !fs::metadata(&path).map_err(|e| e.to_string())?.is_file() || !(bundled || app.asset_protocol_scope().is_allowed(&path)) {
        return Err("ENGINE_TASK_SOURCE_NOT_ADMITTED".into());
    }
    Ok(path)
}
pub fn read_progress(path: &Path, id: &str, kind: &str) -> Option<Value> {
    let meta = fs::symlink_metadata(path).ok()?;
    if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > 64 * 1024 { return None; }
    #[cfg(windows)] { use std::os::windows::fs::MetadataExt; if meta.file_attributes() & 0x400 != 0 { return None; } }
    let v: Value = serde_json::from_slice(&fs::read(path).ok()?).ok()?;
    if v.get("schema")?.as_str()? != "editkin.engine-task-progress/v1" || v.get("kind")?.as_str()? != kind || v.get("operationId")?.as_str()? != id { return None; }
    let p = v.get("progress")?;
    let stage = p.get("stage")?.as_str()?;
    if if kind == "desktop_batch_item_v1" { !matches!(stage,"queued" | "executing" | "prepare" | "analyze" | "apply" | "render" | "completed" | "failed") }
        else if kind == "motion_library_render_v1" { !matches!(stage, "cache" | "generate" | "encode" | "verify" | "done") }
        else if kind == "style_template_render_v1" { !matches!(stage, "images" | "cache" | "generate" | "encode" | "verify" | "done")
            || !p.get("fraction").and_then(Value::as_f64).is_some_and(|f| (0.0..=1.0).contains(&f)) }
        else { !matches!(stage,"verify" | "matte" | "source" | "finalize") } { return None; }
    let n = p.get("completed")?.as_u64()?; let total = p.get("total")?.as_u64()?;
    if total == 0 || total > 9_007_199_254_740_991 || n > total { return None; }
    Some(v)
}
/// The service writes `<cache>/motionlib/<itemId>/<cacheKey>{.mov|.matte.mov|.overlay.mov}`; only those regular files may enter the asset scope.
fn motion_library_outputs(reply: &Value, cache_root: &Path, item_id: &str) -> Result<Vec<String>, String> {
    let assets = reply.pointer("/result/assets").and_then(Value::as_object).ok_or(MOTION_ASSETS_REQUIRED)?;
    let mut roles: Vec<&str> = assets.keys().map(String::as_str).collect();
    roles.sort_unstable();
    if !matches!(roles.as_slice(), ["clip"] | ["matte"] | ["matte", "overlay"]) { return Err(MOTION_ASSETS_REQUIRED.into()); }
    // A junction anywhere on the item folder would let a file outside the cache pass the parent comparison below.
    let item_root = cache_root.join("motionlib").join(item_id);
    plain_local(&item_root)?;
    let allowed = crate::process_compatible_path(fs::canonicalize(&item_root).map_err(|e| e.to_string())?);
    let mut uris = Vec::with_capacity(roles.len());
    for asset in assets.values() {
        let uri = asset.get("uri").and_then(Value::as_str).ok_or(MOTION_ASSETS_REQUIRED)?;
        let raw = Path::new(uri);
        // Check every original ancestor before canonicalization; do not hide a junction by resolving it first.
        plain_local(raw)?;
        let path = crate::process_compatible_path(fs::canonicalize(raw).map_err(|e| e.to_string())?);
        if path.parent() != Some(allowed.as_path()) || path.extension().and_then(|e| e.to_str()) != Some("mov")
            || !fs::metadata(&path).map_err(|e| e.to_string())?.is_file() {
            return Err(MOTION_OUTPUT_NOT_ADMITTED.into());
        }
        uris.push(uri.to_owned());
    }
    Ok(uris)
}
fn link_like(info: &fs::Metadata) -> bool {
    #[cfg(windows)] {
        use std::os::windows::fs::MetadataExt;
        if info.file_attributes() & 0x400 != 0 { return true; }
    }
    info.file_type().is_symlink()
}
/// The folders the service writes under the cache root (and this template's clip folder) must be plain local folders with
/// no link among their entries: a junction on, above or inside one of them would send a render or a picture derivative
/// outside the cache. Absent folders are fine; the service creates them under the checked root.
fn style_template_output_folders(cache_root: &Path, template_id: &str) -> Result<(), String> {
    plain_local(cache_root)?;
    let clip_folder = cache_root.join("styletpl-clip").join(template_id);
    for folder in STYLE_OUTPUT_FOLDERS.iter().map(|name| cache_root.join(name)).chain([clip_folder]) {
        let info = match fs::symlink_metadata(&folder) {
            Ok(info) => info,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(e.to_string()),
        };
        plain_local(&folder)?;
        if !info.is_dir() { return Err(STYLE_OUTPUT_NOT_ADMITTED.into()); }
        for entry in fs::read_dir(&folder).map_err(|e| e.to_string())? {
            let path = entry.map_err(|e| e.to_string())?.path();
            if link_like(&fs::symlink_metadata(&path).map_err(|e| e.to_string())?) { return Err("ENGINE_TASK_LINK_REFUSED".into()); }
        }
    }
    Ok(())
}
/// The service writes `<cache>/styletpl-clip/<templateId>/<key>.mov` (+ `<key>.json`). Only that regular file, named by the
/// reply's own key for the requested template, enters the asset scope; derivatives and still renders stay out (nothing plays them).
fn style_template_output(reply: &Value, cache_root: &Path, template_id: &str) -> Result<String, String> {
    let result = reply.get("result").ok_or(STYLE_OUTPUT_REQUIRED)?;
    if result.pointer("/field/template/id").and_then(Value::as_str) != Some(template_id) { return Err(STYLE_OUTPUT_REQUIRED.into()); }
    let key = result.pointer("/field/key").and_then(Value::as_str)
        .filter(|k| k.len() == 64 && k.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))).ok_or(STYLE_OUTPUT_REQUIRED)?;
    let uri = result.pointer("/asset/uri").and_then(Value::as_str).ok_or(STYLE_OUTPUT_REQUIRED)?;
    style_template_output_folders(cache_root, template_id)?;
    let clip_root = cache_root.join("styletpl-clip").join(template_id);
    plain_local(&clip_root)?;
    let allowed = crate::process_compatible_path(fs::canonicalize(&clip_root).map_err(|e| e.to_string())?);
    let raw = Path::new(uri);
    // Check every original ancestor before canonicalization; do not hide a junction by resolving it first.
    plain_local(raw)?;
    let path = crate::process_compatible_path(fs::canonicalize(raw).map_err(|e| e.to_string())?);
    if path.parent() != Some(allowed.as_path()) || path.file_name().and_then(|n| n.to_str()) != Some(format!("{key}.mov").as_str())
        || !fs::metadata(&path).map_err(|e| e.to_string())?.is_file() {
        return Err(STYLE_OUTPUT_NOT_ADMITTED.into());
    }
    Ok(uri.to_owned())
}
/// Each picture the slots name, admitted as project media (allowed_source), as `{uri: localPath}` for the service.
fn style_template_asset_paths(app: &AppHandle, input: &Value, base: &Path) -> Result<Value, String> {
    let mut paths = serde_json::Map::new();
    for asset in input.get("assets").and_then(Value::as_array).ok_or(STYLE_INPUT_INVALID)? {
        let uri = asset.get("uri").and_then(Value::as_str).ok_or(STYLE_INPUT_INVALID)?;
        let path = allowed_source(app, uri, base)?;
        paths.insert(uri.to_owned(), Value::String(path.to_str().ok_or("ENGINE_TASK_LOCAL_PATH_REQUIRED")?.to_owned()));
    }
    Ok(Value::Object(paths))
}
pub async fn run(app: AppHandle, window: WebviewWindow, request: EngineRequestV1, on_event: Channel<Value>) -> Result<Value, String> {
    main_window(window.label())?;
    let id = header(&request)?.to_owned();
    let kind: &'static str = match request.kind.as_str() {
        "desktop_batch_item_v1" => "desktop_batch_item_v1",
        "motion_library_render_v1" => "motion_library_render_v1",
        "style_template_render_v1" => "style_template_render_v1",
        _ => "auto_reframe_v1" };
    let batch = kind == "desktop_batch_item_v1";
    let motion = kind == "motion_library_render_v1";
    let style = kind == "style_template_render_v1";
    let input = request.input.clone();
    let session_id = input.get("sessionId").and_then(Value::as_str).unwrap_or("").to_owned();
    let item_id = input.get("jobId").and_then(Value::as_str).unwrap_or("").to_owned();
    if serde_json::to_vec(&request.project).map_err(|e| e.to_string())?.len() > 15 * 1024 * 1024 { return Err("ENGINE_TASK_REQUEST_BUDGET".into()); }
    let runtime = crate::runtime_paths(&app)?;
    let host_input = if batch {
        let value = crate::batch_engine_input_v1(&app, &session_id, &item_id, false, true, None)?;
        let source = value.get("sourcePath").and_then(Value::as_str).ok_or("ENGINE_TASK_BATCH_SOURCE_REQUIRED")?;
        plain_local(Path::new(source))?;
        plain_local(Path::new(value.get("outputRoot").and_then(Value::as_str).ok_or("ENGINE_TASK_BATCH_OUTPUT_REQUIRED")?))?;
        // Only the native persisted picker session grants this source. Renderer fields cannot supply it.
        crate::allow_path(&app, source)?;
        allowed_source(&app, source, &runtime.asset_base)?;
        Some(value)
    } else if motion { None } // No source media: the item is generated, not read.
    else if style { None } // Pictures are admitted one by one just below.
    else { allowed_source(&app, original_uri(&request)?, &runtime.asset_base)?; None };
    // The renderer names project pictures by uri; only the host resolves and admits them (project media only).
    let style_assets = if style { Some(style_template_asset_paths(&app, &input, &runtime.asset_base)?) } else { None };
    let template_id = input.get("templateId").and_then(Value::as_str).unwrap_or_default().to_owned();
    // Host-chosen output root; renderer fields can never supply it. `runtime` moves into the service call below.
    let output_root = runtime.cache_root.clone();
    let root = runtime.cache_root.join("engine-jobs-v1");
    let job = app.state::<crate::render_jobs::RenderJobs>().register_engine(&root, &id, kind)?;
    let owns_batch = AtomicBool::new(false);
    let fail = |message: String| {
        if batch && owns_batch.load(Ordering::Acquire) { let _ = crate::batch_engine_complete_v1(&app, &session_id, &item_id, Err(message.clone())); }
        app.state::<crate::render_jobs::RenderJobs>().finish(&id); message
    };
    if batch {
        let started = crate::batch_engine_input_v1(&app, &session_id, &item_id, true, true, Some(&id)).map_err(&fail)?;
        owns_batch.store(true, Ordering::Release);
        if Some(&started) != host_input.as_ref() { return Err(fail("ENGINE_TASK_BATCH_SESSION_CHANGED".into())); }
    }
    // A link on, above or in an output folder would redirect the render: checked before the service writes and again on reply.
    if style { style_template_output_folders(&output_root, &template_id).map_err(&fail)?; }
    if let Err(e) = on_event.send(json!({"schema":"editkin.engine-task-host/v1","kind":kind,"operationId":id,"stage":"registered"})) { return Err(fail(e.to_string())); }
    let mut payload = json!({"schema":request.schema,"kind":kind,"input":input,
        "job":{"progressPath":job.progress_path(),"cancelPath":job.cancel_path()}});
    if batch { payload["hostInput"] = host_input.unwrap(); }
    else if motion {
        let cache_root = output_root.to_str().ok_or_else(|| fail("ENGINE_TASK_HOST_RUNTIME_REQUIRED".into()))?;
        payload["hostInput"] = json!({ "cacheRoot": cache_root });
    }
    else if style {
        let cache_root = output_root.to_str().ok_or_else(|| fail("ENGINE_TASK_HOST_RUNTIME_REQUIRED".into()))?;
        payload["hostInput"] = json!({ "cacheRoot": cache_root, "assetPaths": style_assets.unwrap_or_else(|| json!({})) });
    }
    else { payload["project"] = request.project.unwrap(); }
    let service_request = crate::service_request_value(&runtime, "engine_task_v1", payload);
    let services = app.state::<crate::AppState>().services.clone();
    let stop = job.hard_stop_token(); let done = Arc::new(AtomicBool::new(false));
    let progress_done = done.clone(); let progress_job = job.clone(); let progress_id = id.clone();
    let watcher = thread::Builder::new().name("engine-task-progress".into()).spawn(move || {
        let mut last = Value::Null;
        while !progress_done.load(Ordering::Acquire) {
            if let Some(v) = read_progress(&progress_job.progress_path(), &progress_id, kind) {
                if v != last {
                    last = v.clone();
                    if on_event.send(v).is_err() {
                        if batch { let _ = progress_job.request_soft_cancel(); }
                        else { progress_job.hard_stop_token().store(true, Ordering::Release); }
                        break;
                    }
                }
            }
            thread::sleep(Duration::from_millis(100));
        }
    }).map_err(|e| fail(e.to_string()))?;
    let response = tauri::async_runtime::spawn_blocking(move || services.request_engine_task_job(&runtime.node, &runtime.service, service_request, &stop))
        .await.map_err(|e| e.to_string()).and_then(|v| v);
    done.store(true, Ordering::Release); let _ = watcher.join();
    if !batch && (job.cancel_requested() || job.hard_stopped()) { return Err(fail("ENGINE_TASK_CANCELLED".into())); }
    let envelope = response.map_err(&fail)?;
    if envelope.get("ok").and_then(Value::as_bool) != Some(true) {
        return Err(fail(envelope.get("error").and_then(Value::as_str).unwrap_or("ENGINE_TASK_FAILED").into()));
    }
    let mut reply = envelope.get("result").cloned().ok_or_else(|| fail("ENGINE_TASK_REPLY_MISSING".into()))?;
    if reply.get("schema").and_then(Value::as_str) != Some("editkin.engine-task-reply/v1")
        || reply.get("operationId").and_then(Value::as_str) != Some(&id) || reply.get("kind").and_then(Value::as_str) != Some(kind)
        || reply.pointer("/result/request") != Some(&input) { return Err(fail("ENGINE_TASK_REPLY_BINDING_CHANGED".into())); }
    if motion {
        // Admit only the rendered cache files into the asset protocol scope, as pick_media does for picked media.
        let item = input.get("itemId").and_then(Value::as_str).unwrap_or_default();
        for uri in motion_library_outputs(&reply, &output_root, item).map_err(&fail)? { crate::allow_path(&app, &uri).map_err(&fail)?; }
    }
    if style {
        // Admit only the rendered template clip into the asset protocol scope (the inspector previews and the timeline plays it).
        let uri = style_template_output(&reply, &output_root, &template_id).map_err(&fail)?;
        crate::allow_path(&app, &uri).map_err(&fail)?;
    }
    if batch {
        let result = reply.pointer("/result/result").cloned().ok_or_else(|| fail("ENGINE_TASK_BATCH_RESULT_REQUIRED".into()))?;
        // Completion is persisted even if a cancellation arrived too late to stop the transaction.
        let persisted = crate::batch_engine_complete_v1(&app, &session_id, &item_id, Ok(result)).map_err(&fail)?;
        owns_batch.store(false, Ordering::Release);
        let verified = crate::verified_batch_session_v1(&app, persisted).await.map_err(&fail)?;
        reply["result"]["session"] = verified.get("session").cloned().ok_or_else(|| fail("ENGINE_TASK_BATCH_SESSION_REQUIRED".into()))?;
    }
    app.state::<crate::render_jobs::RenderJobs>().finish(&id);
    Ok(reply)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn only_main_window() { assert!(main_window("main").is_ok()); for s in ["preview","remote",""] { assert!(main_window(s).is_err()); } }
    #[test] fn strict_top_level_and_kind() {
        let v = json!({"schema":"editkin.engine-task/v1","kind":"auto_reframe_v1","project":{},"input":{"operationId":"task-1234"}});
        assert_eq!(header(&serde_json::from_value(v.clone()).unwrap()).unwrap(), "task-1234");
        for key in ["job","runtime","sourcePath","ffmpeg"] { let mut bad=v.clone(); bad[key]=json!({}); assert!(serde_json::from_value::<EngineRequestV1>(bad).is_err()); }
        let mut bad=v; bad["kind"]=json!("execute_shell"); assert!(header(&serde_json::from_value(bad).unwrap()).is_err());
        let motion=json!({"schema":"editkin.engine-task/v1","kind":"motion_library_render_v1",
            "input":{"operationId":"motion-library-0001","itemId":"T05","params":{"seed":3},"width":1920,"height":1080,"fps":30}});
        let check=|v: &Value| header(&serde_json::from_value(v.clone()).unwrap()).map(str::to_owned);
        assert_eq!(check(&motion).unwrap(),"motion-library-0001");
        for (item,fps) in [("X80",json!(29.97)),("B01",json!(240)),("T10",json!(23.976))] {
            let mut ok=motion.clone(); ok["input"]["itemId"]=json!(item); ok["input"]["fps"]=fps; assert!(check(&ok).is_ok(),"{ok}");
        }
        let mut refused=vec![];
        let mut with_project=motion.clone(); with_project["project"]=json!({}); refused.push(with_project);
        for key in ["cacheRoot","outputPath"] { let mut bad=motion.clone(); bad["input"][key]=json!("C:/elsewhere"); refused.push(bad); }
        for item in ["Z99","T81","T1","T00","T080","t05",""] { let mut bad=motion.clone(); bad["input"]["itemId"]=json!(item); refused.push(bad); }
        for (key,value) in [("width",json!(8000)),("height",json!(8)),("width",json!(1920.5)),("fps",json!(0)),("fps",json!(240.5)),("fps",json!(-30)),
            ("params",json!([1])),("params",json!({"text":"x".repeat(64*1024)}))] { let mut bad=motion.clone(); bad["input"][key]=value; refused.push(bad); }
        let mut missing=motion.clone(); missing["input"].as_object_mut().unwrap().remove("fps"); refused.push(missing);
        for bad in refused { assert_eq!(check(&bad).unwrap_err(),MOTION_INPUT_INVALID,"{bad}"); }
        let mut bad_id=motion; bad_id["input"]["operationId"]=json!("Motion_1"); assert_eq!(check(&bad_id).unwrap_err(),"ENGINE_TASK_JOB_ID_INVALID");
    }
    #[test] fn original_not_proxy() {
        let r:EngineRequestV1=serde_json::from_value(json!({"schema":"editkin.engine-task/v1","kind":"auto_reframe_v1","project":{"tracks":[{"clips":[{"id":"c","assetId":"a"}]}],"assets":[{"id":"a","kind":"video","uri":"original.mp4","derivatives":{"proxyPath":"poison.mp4"}}]},"input":{"clipId":"c"}})).unwrap();
        assert_eq!(original_uri(&r).unwrap(),"original.mp4");
        assert_eq!(source_path("demo-source.mp4",Path::new("D:/assets")).unwrap(),Path::new("D:/assets/demo-source.mp4"));
        assert!(source_path("https://remote/a.mp4",Path::new("D:/assets")).is_err());
    }
    fn owned_root(name: &str) -> PathBuf {
        let nonce=std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let path=std::env::temp_dir().join(format!("editkin-engine-test-{name}-{}-{nonce}",std::process::id()));
        fs::create_dir(&path).unwrap(); path
    }
    #[test] fn engine_task_job_shares_limit_but_not_export_cancellation() {
        let root=owned_root("cancel"); let jobs=crate::render_jobs::RenderJobs::default();
        let engine=jobs.register_engine(&root,"engine-test-0001","auto_reframe_v1").unwrap();
        let export=jobs.register(&root,"export-test-0001",&root.join("out.mp4")).unwrap();
        assert_eq!(jobs.request_cancel("engine-test-0001",Duration::from_secs(1))["known"],json!(false));
        assert_eq!(jobs.request_cancel_engine("export-test-0001",Duration::from_secs(1))["known"],json!(false));
        assert!(!engine.cancel_requested()); assert!(!export.cancel_requested());
        assert_eq!(jobs.progress("engine-test-0001")["known"],json!(false));
        assert_eq!(jobs.request_cancel_engine("engine-test-0001",Duration::from_secs(1))["known"],json!(true));
        assert!(engine.cancel_requested()); assert!(!export.cancel_requested());
        jobs.finish("engine-test-0001"); jobs.finish("export-test-0001"); fs::remove_dir(root).unwrap();
    }
    #[test] fn engine_task_never_reclaims_existing_or_unfamiliar_files() {
        let root=owned_root("retain"); let jobs=crate::render_jobs::RenderJobs::default();
        let engine=jobs.register_engine(&root,"engine-test-0002","auto_reframe_v1").unwrap();
        let author=root.join("engine-test-0002/keep.txt"); fs::write(&author,b"keep").unwrap();
        assert!(jobs.register_engine(&root,"engine-test-0002","auto_reframe_v1").is_err());
        jobs.finish("engine-test-0002"); assert_eq!(fs::read(&author).unwrap(),b"keep");
        assert!(jobs.register_engine(&root,"engine-test-0002","auto_reframe_v1").is_err());
        fs::remove_file(&author).unwrap(); fs::remove_dir(author.parent().unwrap()).unwrap(); fs::remove_dir(root).unwrap(); drop(engine);
    }
    #[test] fn engine_task_progress_is_bound_to_kind_id_and_valid_counts() {
        let root=owned_root("progress"); let file=root.join("progress.json");
        let valid=json!({"schema":"editkin.engine-task-progress/v1","operationId":"engine-test-0003","kind":"auto_reframe_v1","progress":{"stage":"source","completed":2,"total":3}});
        fs::write(&file,serde_json::to_vec(&valid).unwrap()).unwrap();
        assert_eq!(read_progress(&file,"engine-test-0003","auto_reframe_v1"),Some(valid.clone()));
        assert!(read_progress(&file,"other-task","auto_reframe_v1").is_none());
        for (key,value) in [("stage",json!("arbitrary")),("total",json!(0)),("completed",json!(4)),("completed",json!(-1)),("completed",json!(1.5))] {
            let mut bad=valid.clone(); bad["progress"][key]=value; fs::write(&file,serde_json::to_vec(&bad).unwrap()).unwrap();
            assert!(read_progress(&file,"engine-test-0003","auto_reframe_v1").is_none());
        }
        fs::remove_file(file).unwrap(); fs::remove_dir(root).unwrap();
    }
    #[test] fn motion_library_progress_stages_are_kind_bound() {
        let root=owned_root("motion-progress"); let file=root.join("progress.json");
        let event=|kind: &str, stage: &str| json!({"schema":"editkin.engine-task-progress/v1","operationId":"motion-library-0002","kind":kind,"progress":{"stage":stage,"completed":1,"total":2}});
        for (stage,ok) in [("cache",true),("generate",true),("encode",true),("verify",true),("done",true),("source",false),("render",false),("finalize",false)] {
            fs::write(&file,serde_json::to_vec(&event("motion_library_render_v1",stage)).unwrap()).unwrap();
            assert_eq!(read_progress(&file,"motion-library-0002","motion_library_render_v1").is_some(),ok,"{stage}");
        }
        fs::write(&file,serde_json::to_vec(&event("auto_reframe_v1","encode")).unwrap()).unwrap();
        assert!(read_progress(&file,"motion-library-0002","auto_reframe_v1").is_none());
        assert!(read_progress(&file,"motion-library-0002","motion_library_render_v1").is_none());
        fs::remove_file(file).unwrap(); fs::remove_dir(root).unwrap();
    }
    #[test] fn motion_library_outputs_admit_only_item_cache_movs() {
        let root=owned_root("motion-out"); let item=root.join("motionlib").join("T05"); fs::create_dir_all(&item).unwrap();
        let (clip,matte,overlay)=(item.join("abc.mov"),item.join("abc.matte.mov"),item.join("abc.overlay.mov"));
        for file in [&clip,&matte,&overlay] { fs::write(file,b"mov").unwrap(); }
        let s=|p: &Path| p.to_str().unwrap().to_owned();
        let reply=|assets: Value| json!({"schema":"editkin.motion-library-render-reply/v1","result":{"assets":assets}});
        assert_eq!(motion_library_outputs(&reply(json!({"clip":{"uri":s(&clip)}})),&root,"T05").unwrap(),vec![s(&clip)]);
        assert_eq!(motion_library_outputs(&reply(json!({"matte":{"uri":s(&matte)}})),&root,"T05").unwrap(),vec![s(&matte)]);
        assert_eq!(motion_library_outputs(&reply(json!({"matte":{"uri":s(&matte)},"overlay":{"uri":s(&overlay)}})),&root,"T05").unwrap().len(),2);
        for assets in [json!({}),json!({"clip":{"uri":s(&clip)},"matte":{"uri":s(&matte)}}),json!({"overlay":{"uri":s(&overlay)}}),json!({"clip":{}}),
            json!({"source":{"uri":s(&clip)}}),json!({"matte":{"uri":s(&matte)},"overlay":{"uri":s(&overlay)},"clip":{"uri":s(&clip)}})] {
            assert_eq!(motion_library_outputs(&reply(assets.clone()),&root,"T05").unwrap_err(),MOTION_ASSETS_REQUIRED,"{assets}");
        }
        assert_eq!(motion_library_outputs(&json!({"result":{}}),&root,"T05").unwrap_err(),MOTION_ASSETS_REQUIRED);
        let outside=root.join("elsewhere.mov"); fs::write(&outside,b"mov").unwrap();
        let mp4=item.join("abc.mp4"); fs::write(&mp4,b"mp4").unwrap();
        let folder=item.join("folder.mov"); fs::create_dir(&folder).unwrap();
        let other_item=root.join("motionlib").join("T06"); fs::create_dir(&other_item).unwrap();
        let other=other_item.join("abc.mov"); fs::write(&other,b"mov").unwrap();
        let nested=item.join("deeper"); fs::create_dir(&nested).unwrap(); fs::write(nested.join("abc.mov"),b"mov").unwrap();
        for uri in [s(&outside),s(&mp4),s(&folder),s(&other),s(&item.join("..").join("T06").join("abc.mov")),s(&nested.join("abc.mov"))] {
            assert_eq!(motion_library_outputs(&reply(json!({"clip":{"uri":uri}})),&root,"T05").unwrap_err(),MOTION_OUTPUT_NOT_ADMITTED,"{uri}");
        }
        assert_eq!(motion_library_outputs(&reply(json!({"clip":{"uri":"motionlib/T05/abc.mov"}})),&root,"T05").unwrap_err(),"ENGINE_TASK_LOCAL_PATH_REQUIRED");
        assert!(motion_library_outputs(&reply(json!({"clip":{"uri":s(&item.join("missing.mov"))}})),&root,"T05").is_err());
        #[cfg(windows)] {
            // An item folder that is a junction to a folder outside the cache is refused, even for the junction target's own path.
            let target=root.join("outside-target"); fs::create_dir(&target).unwrap(); let planted=target.join("abc.mov"); fs::write(&planted,b"mov").unwrap();
            let link=root.join("motionlib").join("T07");
            let made=std::process::Command::new("cmd").args(["/C","mklink","/J"]).arg(&link).arg(&target).output().unwrap();
            assert!(made.status.success(),"{}",String::from_utf8_lossy(&made.stderr));
            for uri in [s(&planted),s(&link.join("abc.mov"))] {
                assert_eq!(motion_library_outputs(&reply(json!({"clip":{"uri":uri}})),&root,"T07").unwrap_err(),"ENGINE_TASK_LINK_REFUSED","{uri}");
            }
            assert_eq!(motion_library_outputs(&reply(json!({"clip":{"uri":s(&link.join("abc.mov"))}})),&root,"T05").unwrap_err(),"ENGINE_TASK_LINK_REFUSED");
            fs::remove_dir(&link).unwrap(); assert!(planted.is_file());
        }
        fs::remove_dir_all(root).unwrap();
    }
    fn style_request() -> Value {
        json!({"schema":"editkin.engine-task/v1","kind":"style_template_render_v1",
            "input":{"operationId":"style-template-0001","templateId":"S1_explainer_ui",
                "slots":{"text":{"keyword":"角色立繪"},"color":{"accent":"#FF5500"},"image":{"card":{"source":{"kind":"asset","assetId":"split"},"fit":"cover"}}},
                "width":1080,"height":1920,"fps":30,"durationSeconds":2.2,
                "assets":[{"id":"split","name":"split","kind":"image","uri":"D:/media/split.png","duration":5,"width":1600,"height":900,"license":"own","redistributable":true}]}})
    }
    #[test] fn style_template_input_is_strict() {
        let style=style_request();
        let check=|v: &Value| header(&serde_json::from_value(v.clone()).unwrap()).map(str::to_owned);
        assert_eq!(check(&style).unwrap(),"style-template-0001");
        for (key,value) in [("fps",json!(29.97)),("fps",json!(240)),("fps",json!(1)),("durationSeconds",json!(0.5)),("durationSeconds",json!(120)),
            ("templateId",json!("H12_title_card_2")),("assets",json!([])),("width",json!(16)),("height",json!(7680))] {
            let mut ok=style.clone(); ok["input"][key]=value; assert!(check(&ok).is_ok(),"{ok}");
        }
        let mut still=style.clone(); still["input"]["assets"][0]["kind"]=json!("video"); assert!(check(&still).is_ok());
        let mut minimal=style.clone();
        for key in ["width","height","license","redistributable"] { minimal["input"]["assets"][0].as_object_mut().unwrap().remove(key); }
        minimal["input"]["assets"][0]["rightsBasis"]=json!("owner"); minimal["input"]["assets"][0]["distributionScope"]=json!("public"); assert!(check(&minimal).is_ok());
        let mut refused=vec![];
        let mut with_project=style.clone(); with_project["project"]=json!({}); refused.push(with_project);
        for key in ["cacheRoot","outputPath","assetPaths"] { let mut bad=style.clone(); bad["input"][key]=json!("C:/elsewhere"); refused.push(bad); }
        let mut missing=style.clone(); missing["input"].as_object_mut().unwrap().remove("durationSeconds"); refused.push(missing);
        let long=format!("S1_{}","a".repeat(62));
        for id in ["s1_explainer_ui","S_explainer","S1-explainer","S1_","S1_Explainer","S1_../x","X1_card","S1_a/b","S1_a\\b","",long.as_str()] {
            let mut bad=style.clone(); bad["input"]["templateId"]=json!(id); refused.push(bad);
        }
        for slots in [json!([]),json!({"text":{},"color":{}}),json!({"text":{},"color":{},"image":{},"extra":{}}),json!({"text":[],"color":{},"image":{}})] {
            let mut bad=style.clone(); bad["input"]["slots"]=slots; refused.push(bad);
        }
        for (key,value) in [("width",json!(8000)),("height",json!(8)),("width",json!(1920.5)),("fps",json!(0.5)),("fps",json!(240.5)),("fps",json!("30")),
            ("durationSeconds",json!(0.4)),("durationSeconds",json!(121)),("assets",json!({})),
            ("slots",json!({"text":{"keyword":"x".repeat(300*1024)},"color":{},"image":{}}))] {
            let mut bad=style.clone(); bad["input"][key]=value; refused.push(bad);
        }
        let asset=style["input"]["assets"][0].clone();
        let mut seven=style.clone();
        seven["input"]["assets"]=json!((0..7).map(|i| { let mut a=asset.clone(); a["id"]=json!(format!("a{i}")); a }).collect::<Vec<_>>()); refused.push(seven);
        let mut twice=style.clone(); twice["input"]["assets"]=json!([asset.clone(),asset.clone()]); refused.push(twice);
        for (key,value) in [("derivatives",json!({"proxyPath":"poison.mp4"})),("provenance",json!("x")),("compositionId",json!("c")),("kind",json!("audio")),
            ("uri",json!("")),("uri",json!("D:/a\u{0}.png")),("uri",json!(3)),("duration",json!(-1)),("width",json!(0)),("license",json!(3)),
            ("redistributable",json!("yes")),("id",json!("")),("name",json!(null))] {
            let mut bad=style.clone(); bad["input"]["assets"][0][key]=value; refused.push(bad);
        }
        for key in ["id","name","kind","uri","duration"] { let mut bad=style.clone(); bad["input"]["assets"][0].as_object_mut().unwrap().remove(key); refused.push(bad); }
        let mut not_object=style.clone(); not_object["input"]["assets"]=json!(["D:/media/split.png"]); refused.push(not_object);
        for bad in refused { assert_eq!(check(&bad).unwrap_err(),STYLE_INPUT_INVALID,"{bad}"); }
        let mut bad_id=style; bad_id["input"]["operationId"]=json!("Style_1"); assert_eq!(check(&bad_id).unwrap_err(),"ENGINE_TASK_JOB_ID_INVALID");
    }
    #[test] fn style_template_progress_stages_and_fraction_are_kind_bound() {
        let root=owned_root("style-progress"); let file=root.join("progress.json");
        let event=|kind: &str, stage: &str, fraction: Value| json!({"schema":"editkin.engine-task-progress/v1","operationId":"style-template-0002","kind":kind,
            "progress":{"stage":stage,"completed":1,"total":2,"fraction":fraction}});
        for (stage,ok) in [("images",true),("cache",true),("generate",true),("encode",true),("verify",true),("done",true),("source",false),("render",false),("start",false)] {
            fs::write(&file,serde_json::to_vec(&event("style_template_render_v1",stage,json!(0.5))).unwrap()).unwrap();
            assert_eq!(read_progress(&file,"style-template-0002","style_template_render_v1").is_some(),ok,"{stage}");
        }
        for fraction in [json!(0),json!(1)] {
            fs::write(&file,serde_json::to_vec(&event("style_template_render_v1","encode",fraction.clone())).unwrap()).unwrap();
            assert!(read_progress(&file,"style-template-0002","style_template_render_v1").is_some(),"{fraction}");
        }
        for fraction in [json!(-0.1),json!(1.5),json!("0.5"),Value::Null] {
            fs::write(&file,serde_json::to_vec(&event("style_template_render_v1","encode",fraction.clone())).unwrap()).unwrap();
            assert!(read_progress(&file,"style-template-0002","style_template_render_v1").is_none(),"{fraction}");
        }
        let mut missing=event("style_template_render_v1","encode",json!(0.5)); missing["progress"].as_object_mut().unwrap().remove("fraction");
        fs::write(&file,serde_json::to_vec(&missing).unwrap()).unwrap();
        assert!(read_progress(&file,"style-template-0002","style_template_render_v1").is_none());
        // A Motion Library event is not a style template event, and the other way round.
        fs::write(&file,serde_json::to_vec(&event("motion_library_render_v1","images",json!(0.5))).unwrap()).unwrap();
        assert!(read_progress(&file,"style-template-0002","style_template_render_v1").is_none());
        assert!(read_progress(&file,"style-template-0002","motion_library_render_v1").is_none());
        fs::remove_file(file).unwrap(); fs::remove_dir(root).unwrap();
    }
    #[test] fn style_template_output_admits_only_the_keyed_template_clip() {
        let root=owned_root("style-out"); let key="ab".repeat(32); let other_key="cd".repeat(32); let upper=key.to_uppercase();
        let clips=root.join("styletpl-clip").join("S1_explainer_ui"); fs::create_dir_all(&clips).unwrap();
        for name in ["styletpl-img","styletpl",".styletpl-work"] { fs::create_dir_all(root.join(name)).unwrap(); }
        let img=root.join("styletpl-img").join("d.jpg"); fs::write(&img,b"jpg").unwrap(); fs::create_dir(root.join("styletpl").join("uiCardScene")).unwrap();
        let clip=clips.join(format!("{key}.mov")); fs::write(&clip,b"mov").unwrap();
        let manifest=clips.join(format!("{key}.json")); fs::write(&manifest,b"{}").unwrap();
        let s=|p: &Path| p.to_str().unwrap().to_owned();
        let reply=|template: &str, key: &str, uri: String| json!({"schema":"editkin.engine-task-reply/v1","result":{"schema":"editkin.style-template-render-reply/v1",
            "field":{"template":{"id":template},"key":key},"asset":{"id":"styletpl-x","uri":uri}}});
        assert!(style_template_output_folders(&root,"S1_explainer_ui").is_ok());
        assert_eq!(style_template_output(&reply("S1_explainer_ui",&key,s(&clip)),&root,"S1_explainer_ui").unwrap(),s(&clip));
        // The reply names the requested template and a lowercase 64-hex key, with an asset uri.
        for (template,k) in [("S4_motion_promo_3d",key.as_str()),("S1_explainer_ui","ab"),("S1_explainer_ui",upper.as_str())] {
            assert_eq!(style_template_output(&reply(template,k,s(&clip)),&root,"S1_explainer_ui").unwrap_err(),STYLE_OUTPUT_REQUIRED,"{template} {k}");
        }
        assert_eq!(style_template_output(&json!({"result":{"field":{"template":{"id":"S1_explainer_ui"},"key":key}}}),&root,"S1_explainer_ui").unwrap_err(),STYLE_OUTPUT_REQUIRED);
        assert_eq!(style_template_output(&json!({}),&root,"S1_explainer_ui").unwrap_err(),STYLE_OUTPUT_REQUIRED);
        // Only `<key>.mov`, a regular file directly in this template's clip folder.
        let other=clips.join(format!("{other_key}.mov")); fs::write(&other,b"mov").unwrap();
        let outside=root.join(format!("{key}.mov")); fs::write(&outside,b"mov").unwrap();
        let other_template=root.join("styletpl-clip").join("S5_vox_collage"); fs::create_dir(&other_template).unwrap();
        let elsewhere=other_template.join(format!("{key}.mov")); fs::write(&elsewhere,b"mov").unwrap();
        let nested=clips.join("deeper"); fs::create_dir(&nested).unwrap(); let deep=nested.join(format!("{key}.mov")); fs::write(&deep,b"mov").unwrap();
        for uri in [s(&other),s(&manifest),s(&outside),s(&img),s(&elsewhere),s(&deep),s(&clips.join("..").join("S5_vox_collage").join(format!("{key}.mov")))] {
            assert_eq!(style_template_output(&reply("S1_explainer_ui",&key,uri.clone()),&root,"S1_explainer_ui").unwrap_err(),STYLE_OUTPUT_NOT_ADMITTED,"{uri}");
        }
        let folder_key="ef".repeat(32); let folder=clips.join(format!("{folder_key}.mov")); fs::create_dir(&folder).unwrap();
        assert_eq!(style_template_output(&reply("S1_explainer_ui",&folder_key,s(&folder)),&root,"S1_explainer_ui").unwrap_err(),STYLE_OUTPUT_NOT_ADMITTED);
        assert_eq!(style_template_output(&reply("S1_explainer_ui",&key,format!("styletpl-clip/S1_explainer_ui/{key}.mov")),&root,"S1_explainer_ui").unwrap_err(),
            "ENGINE_TASK_LOCAL_PATH_REQUIRED");
        let absent="0".repeat(64);
        assert!(style_template_output(&reply("S1_explainer_ui",&absent,s(&clips.join(format!("{absent}.mov")))),&root,"S1_explainer_ui").is_err());
        // An output folder that is a file is not an output folder.
        let flat=owned_root("style-out-flat"); fs::write(flat.join("styletpl-img"),b"not a folder").unwrap();
        assert_eq!(style_template_output_folders(&flat,"S1_explainer_ui").unwrap_err(),STYLE_OUTPUT_NOT_ADMITTED);
        fs::remove_dir_all(flat).unwrap();
        #[cfg(windows)] {
            let junction=|link: &Path, target: &Path| {
                let made=std::process::Command::new("cmd").args(["/C","mklink","/J"]).arg(link).arg(target).output().unwrap();
                assert!(made.status.success(),"{}",String::from_utf8_lossy(&made.stderr));
            };
            let target=root.join("outside-target"); fs::create_dir(&target).unwrap();
            let planted=target.join(format!("{key}.mov")); fs::write(&planted,b"mov").unwrap();
            // A template clip folder that is a junction to a folder outside the cache is refused, for both spellings of the file;
            // being among styletpl-clip's entries, it refuses every template until it is gone.
            let linked=root.join("styletpl-clip").join("S7_kinetic_lyric_3d"); junction(&linked,&target);
            for uri in [s(&planted),s(&linked.join(format!("{key}.mov")))] {
                assert_eq!(style_template_output(&reply("S7_kinetic_lyric_3d",&key,uri.clone()),&root,"S7_kinetic_lyric_3d").unwrap_err(),"ENGINE_TASK_LINK_REFUSED","{uri}");
            }
            assert_eq!(style_template_output_folders(&root,"S1_explainer_ui").unwrap_err(),"ENGINE_TASK_LINK_REFUSED");
            fs::remove_dir(&linked).unwrap();
            assert!(style_template_output_folders(&root,"S1_explainer_ui").is_ok());
            // A junction among the picture derivatives is refused before and after a render.
            let planted_dir=root.join("styletpl-img").join("planted"); junction(&planted_dir,&target);
            assert_eq!(style_template_output_folders(&root,"S1_explainer_ui").unwrap_err(),"ENGINE_TASK_LINK_REFUSED");
            assert_eq!(style_template_output(&reply("S1_explainer_ui",&key,s(&clip)),&root,"S1_explainer_ui").unwrap_err(),"ENGINE_TASK_LINK_REFUSED");
            fs::remove_dir(&planted_dir).unwrap();
            // An output folder that is itself a junction (the frame work folder here) is refused.
            let work=root.join(".styletpl-work"); fs::remove_dir(&work).unwrap(); junction(&work,&target);
            assert_eq!(style_template_output_folders(&root,"S1_explainer_ui").unwrap_err(),"ENGINE_TASK_LINK_REFUSED");
            fs::remove_dir(&work).unwrap();
            // A cache root under a junction is refused outright.
            let via=root.join("via"); junction(&via,&root.join("styletpl-clip"));
            assert_eq!(style_template_output_folders(&via,"S1_explainer_ui").unwrap_err(),"ENGINE_TASK_LINK_REFUSED");
            fs::remove_dir(&via).unwrap();
            assert!(planted.is_file()); assert!(style_template_output_folders(&root,"S1_explainer_ui").is_ok());
        }
        fs::remove_dir_all(root).unwrap();
    }
}
