//! In-app template Shorts (M1 wave 4.1; Hao 2026-10-09: the in-app one-click is an official path).
//!
//! One job is one owned child, `node <mcp.mjs> --editkin-one-shot`, started through the shared owned-process helper
//! (Windows Job object / Unix process group) with a closed environment. The request goes in on stdin, one JSON
//! envelope comes back on stdout and progress arrives in a small file the child rewrites. The resident service pool is
//! never used: each job gets a fresh HMAC secret and receipt map in its own process, cancel kills the whole tree, and a
//! crash cannot take the export lane with it. The MCP bundle hosts the run (not service.mjs) because only it carries the
//! material-colour code identity sidecar that preparing material requires.
//!
//! No hidden ceiling (ROADMAP 1.11): a job is stopped only when neither its progress file nor its run folder changed for
//! the no-progress limit. The render inside the child keeps its own length-scaled deadline.

use serde_json::{json, Map, Value};
use std::{
    collections::{hash_map::DefaultHasher, BTreeSet},
    env,
    ffi::OsString,
    fs,
    hash::{Hash, Hasher},
    io::{self, Read, Write},
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc, Arc, Mutex, MutexGuard,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use crate::preview_process_platform;
use crate::remote_agent_launcher::{read_bounded, BoundedCapture};
use crate::RuntimePaths;

pub(crate) const ONE_SHOT_FLAG: &str = "--editkin-one-shot";
/// Design §9: no advance in the progress file or the run folder for five minutes stops the job (INTERRUPTED).
pub(crate) const NO_PROGRESS_LIMIT: Duration = Duration::from_secs(5 * 60);
const POLL_INTERVAL: Duration = Duration::from_millis(250);
const FINGERPRINT_INTERVAL: Duration = Duration::from_secs(2);
const CLEANUP_DEADLINE: Duration = Duration::from_secs(3);
const STDOUT_LIMIT: usize = 256 * 1024;
const STDERR_LIMIT: usize = 64 * 1024;
const PROGRESS_LIMIT: u64 = 4 * 1024;
const RUN_ROOT: &str = "videos/_AUTOPILOT/editkin-short";
const DEFAULTS_FILE: &str = "template-short-defaults.json";
const IN_APP_RESULT_SCHEMA: &str = "editkin.template-short-in-app/v1";
const PROGRESS_SCHEMA: &str = "editkin.template-short-progress/v1";
const MAX_JOBS_KEPT: usize = 8;
const WALK_ENTRY_BUDGET: usize = 4_096;
const WALK_DEPTH: usize = 6;
/// REFERENCE_MOTION_VIDEO_TYPES keys (the start_template_short genre).
pub(crate) const GENRES: [&str; 9] = [
    "teaching", "podcast", "travel", "food", "unboxing", "game", "product", "brand", "knowledge",
];

/// Editkin keys every in-app child receives: the product MCP launcher's set
/// (scripts/editkin-product-mcp-launcher.mjs) plus the workspace, model and cache roots.
pub(crate) const REQUIRED_ENV_KEYS: [&str; 16] = [
    "EDITKIN_CACHE_ROOT",
    "EDITKIN_COLOR_ROOT",
    "EDITKIN_CREATIVE_PACK_ROOT",
    "EDITKIN_FFMPEG_PATH",
    "EDITKIN_FFPROBE_PATH",
    "EDITKIN_FONT_ROOT",
    "EDITKIN_GPU_COMPOSITOR_PATH",
    "EDITKIN_MODEL_ROOT",
    "EDITKIN_PERSONAL_MUSIC_ROOT",
    "EDITKIN_PERSONAL_VISUAL_ROOT",
    "EDITKIN_PLUGIN_ROOTS",
    "EDITKIN_WHISPER_CLI_PATH",
    "EDITKIN_WORKSPACE",
    "HAO_FFMPEG_PATH",
    "HAO_FFPROBE_PATH",
    "HAO_NATIVE_CORE_PATH",
];
/// Present only when found on this computer (the design bridge's Python, the live Skill, the host workflow profile).
pub(crate) const OPTIONAL_ENV_KEYS: [&str; 3] = [
    "EDITKIN_PYTHON_EXECUTABLE",
    "EDITKIN_VIDEO_AUTOPILOT_SKILL",
    "EDITKIN_WORKFLOW_PROFILE_PATH",
];
/// Host keys Node, FFmpeg and Python need on Windows, copied from this process only when set. The parent environment is
/// never enumerated: no PATH, proxies, NODE_OPTIONS, tokens or keys reach the child.
pub(crate) const HOST_ENV_KEYS: [&str; 8] = [
    "APPDATA",
    "HOME",
    "LOCALAPPDATA",
    "SYSTEMROOT",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "WINDIR",
];

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|error| error.into_inner())
}

pub(crate) struct ChildTools {
    pub python: Option<PathBuf>,
    pub video_autopilot_skill: Option<PathBuf>,
    pub workflow_profile: Option<PathBuf>,
}

/// The closed environment of one in-app child, sorted by key. `host` is asked for HOST_ENV_KEYS only.
pub(crate) fn template_short_child_environment(
    runtime: &RuntimePaths,
    workspace: &Path,
    tools: &ChildTools,
    host: &dyn Fn(&str) -> Option<OsString>,
) -> Result<Vec<(OsString, OsString)>, String> {
    if !workspace.is_absolute() {
        return Err("工作資料夾必須是完整路徑".into());
    }
    let plugin_roots = env::join_paths(runtime.plugin_roots.iter())
        .map_err(|error| format!("無法組合外掛搜尋路徑：{error}"))?;
    let path = |value: &Path| value.as_os_str().to_owned();
    let mut editkin: Vec<(&'static str, OsString)> = vec![
        ("EDITKIN_WORKSPACE", path(workspace)),
        ("HAO_FFMPEG_PATH", path(&runtime.ffmpeg)),
        ("EDITKIN_FFMPEG_PATH", path(&runtime.ffmpeg)),
        ("HAO_FFPROBE_PATH", path(&runtime.ffprobe)),
        ("EDITKIN_FFPROBE_PATH", path(&runtime.ffprobe)),
        ("EDITKIN_WHISPER_CLI_PATH", path(&runtime.whisper_cli)),
        ("HAO_NATIVE_CORE_PATH", path(&runtime.native_core)),
        ("EDITKIN_GPU_COMPOSITOR_PATH", path(&runtime.gpu_compositor)),
        ("EDITKIN_CREATIVE_PACK_ROOT", path(&runtime.creative_pack_root)),
        ("EDITKIN_PERSONAL_MUSIC_ROOT", path(&runtime.personal_music_root)),
        ("EDITKIN_PERSONAL_VISUAL_ROOT", path(&runtime.personal_visual_root)),
        ("EDITKIN_FONT_ROOT", path(&runtime.font_root)),
        ("EDITKIN_COLOR_ROOT", path(&runtime.color_root)),
        ("EDITKIN_PLUGIN_ROOTS", plugin_roots),
        ("EDITKIN_MODEL_ROOT", path(&runtime.model_root)),
        ("EDITKIN_CACHE_ROOT", path(&runtime.cache_root)),
    ];
    for (key, value) in [
        ("EDITKIN_PYTHON_EXECUTABLE", &tools.python),
        ("EDITKIN_VIDEO_AUTOPILOT_SKILL", &tools.video_autopilot_skill),
        ("EDITKIN_WORKFLOW_PROFILE_PATH", &tools.workflow_profile),
    ] {
        if let Some(value) = value {
            editkin.push((key, path(value)));
        }
    }
    let mut seen = BTreeSet::new();
    let mut environment = Vec::new();
    for (key, value) in editkin {
        let text = value.to_string_lossy();
        if text.is_empty() || text.chars().any(char::is_control) {
            return Err(format!("{key} 是空的或含控制字元；沒有啟動子程序"));
        }
        if !seen.insert(key) {
            return Err(format!("{key} 重複"));
        }
        environment.push((OsString::from(key), value));
    }
    for key in HOST_ENV_KEYS {
        let Some(value) = host(key) else { continue };
        let text = value.to_string_lossy();
        if text.is_empty() || text.chars().any(char::is_control) || !seen.insert(key) {
            continue;
        }
        environment.push((OsString::from(key), value));
    }
    environment.sort_by(|left, right| left.0.cmp(&right.0));
    // Closed world: every required key present, nothing outside the three declared sets.
    let allowed = REQUIRED_ENV_KEYS
        .iter()
        .chain(OPTIONAL_ENV_KEYS.iter())
        .chain(HOST_ENV_KEYS.iter())
        .copied()
        .collect::<BTreeSet<_>>();
    if !REQUIRED_ENV_KEYS.iter().all(|key| seen.contains(key)) || !seen.iter().all(|key| allowed.contains(key)) {
        return Err("模板短片子程序的環境變數不符合封閉清單；沒有啟動".into());
    }
    Ok(environment)
}

/// The design bridge runs Python. EDITKIN_PYTHON_EXECUTABLE wins when it names a real file; otherwise the first plain
/// python on PATH, skipping the Microsoft Store app-execution aliases.
pub(crate) fn discover_python(
    override_value: Option<OsString>,
    path_value: Option<OsString>,
) -> Option<PathBuf> {
    if let Some(candidate) = override_value.filter(|value| !value.is_empty()).map(PathBuf::from) {
        if candidate.is_absolute() && plain_executable(&candidate) {
            return Some(plain_canonical(candidate));
        }
    }
    let names: &[&str] = if cfg!(windows) {
        &["python.exe"]
    } else {
        &["python3", "python"]
    };
    for directory in env::split_paths(&path_value?) {
        if !directory.is_absolute()
            || (cfg!(windows)
                && directory
                    .to_string_lossy()
                    .to_ascii_lowercase()
                    .contains("\\microsoft\\windowsapps"))
        {
            continue;
        }
        for name in names {
            let candidate = directory.join(name);
            if plain_executable(&candidate) {
                return Some(plain_canonical(candidate));
            }
        }
    }
    None
}

fn plain_executable(path: &Path) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
        fs::symlink_metadata(path).is_ok_and(|metadata| {
            metadata.is_file()
                && metadata.len() > 0
                && metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT == 0
        })
    }
    #[cfg(not(windows))]
    {
        fs::metadata(path).is_ok_and(|metadata| metadata.is_file() && metadata.len() > 0)
    }
}

fn plain_canonical(path: PathBuf) -> PathBuf {
    crate::process_compatible_path(fs::canonicalize(&path).unwrap_or(path))
}

// ---- Workspace and the one-time rights confirmation ------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct WorkspaceSource {
    pub workspace: PathBuf,
    /// Workspace-relative and `/`-separated: the form the Node side resolves and matches rights scopes against.
    pub relative: String,
    /// The first segment under the workspace: the folder the rights confirmation names (or the file itself).
    pub scope: String,
    pub scope_is_file: bool,
}

fn real_directory(path: &Path) -> bool {
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return false;
    };
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return false;
        }
    }
    metadata.is_dir() && !metadata.file_type().is_symlink()
}

/// The workspace is the nearest folder above the (canonical) video that holds a real `.autopilot` folder, the same
/// folder the creator review policy and the defaults file live in.
pub(crate) fn find_workspace_source(canonical_source: &Path) -> Option<WorkspaceSource> {
    let mut current = canonical_source.parent();
    while let Some(directory) = current {
        if real_directory(&directory.join(".autopilot")) {
            let parts = canonical_source
                .strip_prefix(directory)
                .ok()?
                .components()
                .map(|component| match component {
                    Component::Normal(part) => part.to_str().map(str::to_string),
                    _ => None,
                })
                .collect::<Option<Vec<_>>>()?;
            let scope = parts.first()?.clone();
            return Some(WorkspaceSource {
                workspace: directory.to_path_buf(),
                relative: parts.join("/"),
                scope_is_file: parts.len() == 1,
                scope,
            });
        }
        current = directory.parent();
    }
    None
}

pub(crate) fn resolve_workspace_source(source: &str) -> Result<Option<WorkspaceSource>, String> {
    let path = Path::new(source);
    if source.trim().is_empty() || source.chars().any(char::is_control) || !path.is_absolute() {
        return Err("影片的位置不合法".into());
    }
    let canonical = crate::process_compatible_path(
        fs::canonicalize(path).map_err(|_| "找不到這支影片".to_string())?,
    );
    if !canonical.is_file() {
        return Err("這不是一個影片檔".into());
    }
    Ok(find_workspace_source(&canonical))
}

pub(crate) fn defaults_present(workspace: &Path) -> bool {
    // Anything at that path counts as present; the run reads and validates it (a broken file is an honest BLOCK_START).
    fs::symlink_metadata(workspace.join(".autopilot").join(DEFAULTS_FILE)).is_ok()
}

pub(crate) fn prepare_status(source: &str) -> Result<Value, String> {
    Ok(match resolve_workspace_source(source)? {
        None => json!({ "workspaceFound": false }),
        Some(found) => json!({
            "workspaceFound": true,
            "defaults": if defaults_present(&found.workspace) { "present" } else { "missing" },
            "scope": { "name": found.scope, "kind": if found.scope_is_file { "file" } else { "folder" } },
            "source": found.relative,
        }),
    })
}

/// Optional, empty by default. A conservative subset of the characters the bundled glyph rule accepts, so the file the
/// creator confirms always parses (`brandMark` ≤ 16 characters). The rights screen checks the same set
/// (`firstUnsupportedBrandCharacter` in src/ui/easy/easyFlowModel.ts); change both together.
pub(crate) fn validate_brand_mark(value: Option<String>) -> Result<Option<String>, String> {
    let Some(raw) = value else {
        return Ok(None);
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    if trimmed.chars().count() > 16 || trimmed.encode_utf16().count() > 32 {
        return Err("名字或品牌最多 16 個字".into());
    }
    let allowed = |character: char| {
        matches!(character as u32,
            0x20..=0x7e | 0x3400..=0x4dbf | 0x4e00..=0x9fff | 0xff01..=0xff5e | 0x3001 | 0x3002 | 0x3008..=0x3011)
    };
    if !trimmed.chars().all(allowed) {
        return Err("名字或品牌裡有電腦放不上畫面的字，請換掉或不寫".into());
    }
    Ok(Some(trimmed.to_string()))
}

/// Bounds the creator's copy before it reaches the child; the brief schema there checks it exactly.
pub(crate) fn validate_copy(copy: &Value) -> Result<Value, String> {
    let object = copy.as_object().ok_or("文字的格式不合法")?;
    if object
        .keys()
        .any(|key| !matches!(key.as_str(), "payoff" | "hook" | "points"))
    {
        return Err("文字欄位不合法".into());
    }
    let text = |value: &Value, max: usize| {
        value
            .as_str()
            .filter(|text| {
                !text.trim().is_empty()
                    && text.encode_utf16().count() <= max
                    && !text.chars().any(char::is_control)
            })
            .map(|text| Value::String(text.to_string()))
    };
    let mut shaped = Map::new();
    shaped.insert(
        "payoff".into(),
        object
            .get("payoff")
            .and_then(|value| text(value, 32))
            .ok_or("大標題要寫，最多 32 個字")?,
    );
    if let Some(hook) = object.get("hook") {
        shaped.insert("hook".into(), text(hook, 24).ok_or("「大家原本以為」最多 24 個字")?);
    }
    if let Some(points) = object.get("points") {
        let items = points
            .as_array()
            .filter(|items| (2..=4).contains(&items.len()))
            .ok_or("重點要寫 2 到 4 個")?;
        let items = items
            .iter()
            .map(|item| text(item, 24))
            .collect::<Option<Vec<_>>>()
            .ok_or("每個重點最多 24 個字")?;
        shaped.insert("points".into(), Value::Array(items));
    }
    if shaped.contains_key("hook") == shaped.contains_key("points") {
        return Err("要寫「大家原本以為」，或 2 到 4 個重點（二選一）".into());
    }
    Ok(Value::Object(shaped))
}

// ---- Progress and the no-progress watchdog ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ProgressReport {
    pub step: u8,
    pub fraction: f64,
    pub short_id: Option<String>,
    pub run_dir: Option<String>,
}

pub(crate) fn valid_short_id(value: &str) -> bool {
    let Some(rest) = value.strip_prefix("ts-") else {
        return false;
    };
    let parts = rest.split('-').collect::<Vec<_>>();
    value.len() <= 64
        && parts.len() >= 3
        && parts[0].len() == 8
        && parts[0].bytes().all(|byte| byte.is_ascii_digit())
        && parts[parts.len() - 1].len() == 6
        && parts[parts.len() - 1]
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        && parts[1..parts.len() - 1].iter().all(|part| {
            !part.is_empty()
                && part
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        })
}

/// `videos/_AUTOPILOT/editkin-short/<shortId without "ts-">`, exactly what startTemplateShort creates.
pub(crate) fn run_dir_of(short_id: &str) -> Option<String> {
    valid_short_id(short_id).then(|| format!("{RUN_ROOT}/{}", &short_id[3..]))
}

pub(crate) fn read_progress(path: &Path) -> Option<ProgressReport> {
    let mut bytes = Vec::new();
    fs::File::open(path)
        .ok()?
        .take(PROGRESS_LIMIT + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() as u64 > PROGRESS_LIMIT {
        return None;
    }
    let value: Value = serde_json::from_slice(&bytes).ok()?;
    if value.get("schema").and_then(Value::as_str) != Some(PROGRESS_SCHEMA) {
        return None;
    }
    let step = value.get("step").and_then(Value::as_u64).filter(|step| *step <= 3)? as u8;
    let fraction = value
        .get("fraction")
        .and_then(Value::as_f64)
        .filter(|fraction| fraction.is_finite())?
        .clamp(0.0, 1.0);
    let short_id = value
        .get("shortId")
        .and_then(Value::as_str)
        .filter(|id| valid_short_id(id))
        .map(str::to_string);
    let run_dir = value
        .get("runDir")
        .and_then(Value::as_str)
        .filter(|dir| short_id.as_deref().and_then(run_dir_of).as_deref() == Some(*dir))
        .map(str::to_string);
    Some(ProgressReport { step, fraction, short_id, run_dir })
}

/// What changes while a job really advances: the progress file and the run folder (journal, plan, the growing
/// candidate mp4 and render work files). Bounded walk, links are not followed.
pub(crate) fn progress_fingerprint(progress_path: &Path, run_dir: Option<&Path>) -> u64 {
    let mut hasher = DefaultHasher::new();
    if let Ok(file) = fs::File::open(progress_path) {
        let mut bytes = Vec::new();
        if file.take(PROGRESS_LIMIT).read_to_end(&mut bytes).is_ok() {
            bytes.hash(&mut hasher);
        }
    }
    if let Some(directory) = run_dir {
        let mut budget = WALK_ENTRY_BUDGET;
        walk(directory, 0, &mut budget, &mut hasher);
    }
    hasher.finish()
}

fn walk(directory: &Path, depth: usize, budget: &mut usize, hasher: &mut DefaultHasher) {
    if depth > WALK_DEPTH || *budget == 0 {
        return;
    }
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    let mut entries = entries.filter_map(Result::ok).collect::<Vec<_>>();
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        if *budget == 0 {
            return;
        }
        *budget -= 1;
        // A handle-based query: the size of a file still being written is current (directory listings can lag).
        let Ok(metadata) = fs::symlink_metadata(entry.path()) else {
            continue;
        };
        entry.file_name().hash(hasher);
        metadata.len().hash(hasher);
        if let Some(modified) = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        {
            modified.as_nanos().hash(hasher);
        }
        if metadata.is_dir() && !metadata.file_type().is_symlink() {
            walk(&entry.path(), depth + 1, budget, hasher);
        }
    }
}

pub(crate) struct NoProgressWatchdog {
    fingerprint: Option<u64>,
    changed_at: Instant,
    limit: Duration,
}

impl NoProgressWatchdog {
    pub fn new(now: Instant, limit: Duration) -> Self {
        Self { fingerprint: None, changed_at: now, limit }
    }

    pub fn observe(&mut self, fingerprint: u64, now: Instant) {
        if self.fingerprint != Some(fingerprint) {
            self.fingerprint = Some(fingerprint);
            self.changed_at = now;
        }
    }

    pub fn stalled(&self, now: Instant) -> bool {
        now.saturating_duration_since(self.changed_at) >= self.limit
    }
}

// ---- The child -------------------------------------------------------------------------------------------------------

fn spawn_child(
    node: &Path,
    script: &Path,
    environment: &[(OsString, OsString)],
    cwd: &Path,
) -> Result<preview_process_platform::Spawned, String> {
    if !script.is_file() {
        return Err("找不到 Editkin 的自動剪輯程式（mcp.mjs）".into());
    }
    let args = [script.as_os_str().to_owned(), OsString::from(ONE_SHOT_FLAG)];
    preview_process_platform::spawn_with_environment_and_cwd(node, &args, environment, cwd)
        .map_err(|error| format!("無法啟動自動剪輯子程序：{error}"))
}

fn drain(reader: Box<dyn Read + Send>, limit: usize) -> mpsc::Receiver<BoundedCapture> {
    let (sender, receiver) = mpsc::sync_channel(1);
    thread::spawn(move || {
        let _ = sender.send(read_bounded(reader, limit));
    });
    receiver
}

/// Always terminate the owned tree (also after a normal leader exit) and confirm it is empty within a bounded wait.
fn end_child(process: &mut preview_process_platform::OwnedProcess) -> bool {
    let terminated = process.terminate_tree().is_ok();
    let deadline = Instant::now() + CLEANUP_DEADLINE;
    while Instant::now() < deadline {
        match process.tree_is_empty() {
            Ok(true) => return terminated,
            Ok(false) => thread::sleep(Duration::from_millis(25)),
            Err(_) => return false,
        }
    }
    false
}

fn stderr_tail(capture: Option<&BoundedCapture>) -> String {
    let text = capture
        .map(|capture| String::from_utf8_lossy(&capture.bytes).trim().to_string())
        .unwrap_or_default();
    let tail = text.chars().rev().take(400).collect::<String>();
    tail.chars().rev().collect()
}

/// `{"ok":true,"result":…}` → result; `{"ok":false,"error":…}` → the error. Tolerates diagnostic lines before the
/// envelope by falling back to the last line.
pub(crate) fn parse_envelope(stdout: &[u8]) -> Result<Value, String> {
    let text = String::from_utf8_lossy(stdout);
    let envelope = serde_json::from_str::<Value>(text.trim())
        .ok()
        .or_else(|| {
            text.lines()
                .rev()
                .find(|line| line.trim_start().starts_with('{'))
                .and_then(|line| serde_json::from_str::<Value>(line.trim()).ok())
        })
        .ok_or("自動剪輯子程序沒有回傳結果")?;
    match envelope.get("ok").and_then(Value::as_bool) {
        Some(true) => envelope
            .get("result")
            .cloned()
            .filter(Value::is_object)
            .ok_or_else(|| "自動剪輯子程序的結果格式不合法".into()),
        Some(false) => Err(envelope
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("自動剪輯子程序失敗")
            .chars()
            .take(800)
            .collect()),
        None => Err("自動剪輯子程序的結果格式不合法".into()),
    }
}

/// A short one-shot request (the defaults write): bounded by a plain timeout, the whole tree is always cleaned up.
pub(crate) fn run_one_shot(
    node: &Path,
    script: &Path,
    environment: &[(OsString, OsString)],
    cwd: &Path,
    request: &Value,
    timeout: Duration,
) -> Result<Value, String> {
    let preview_process_platform::Spawned { mut process, mut stdin, stdout, stderr } =
        spawn_child(node, script, environment, cwd)?;
    let stdout = drain(stdout, STDOUT_LIMIT);
    let stderr = drain(stderr, STDERR_LIMIT);
    let input = serde_json::to_vec(request).map_err(|error| error.to_string())?;
    let input_error = stdin.write_all(&input).and_then(|()| stdin.flush()).err();
    drop(stdin);
    let deadline = Instant::now() + timeout;
    let mut outcome: Result<(), String> = input_error
        .map(|error| Err(format!("無法把工作交給子程序：{error}")))
        .unwrap_or(Ok(()));
    while outcome.is_ok() {
        match process.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(50)),
            Ok(None) => outcome = Err("子程序在期限內沒有完成；已停止".into()),
            Err(error) => outcome = Err(format!("無法確認子程序狀態：{error}")),
        }
    }
    let cleaned = end_child(&mut process);
    let stdout = stdout.recv_timeout(Duration::from_secs(3)).ok();
    let stderr = stderr.recv_timeout(Duration::from_secs(3)).ok();
    outcome?;
    if !cleaned {
        return Err("子程序的清理沒有被確認；不宣稱完成".into());
    }
    let stdout = stdout.ok_or("子程序的輸出沒有在期限內讀完")?;
    if stdout.truncated {
        return Err("子程序的輸出超過上限".into());
    }
    parse_envelope(&stdout.bytes).map_err(|error| {
        let tail = stderr_tail(stderr.as_ref());
        if tail.is_empty() { error } else { format!("{error}：{tail}") }
    })
}

// ---- Jobs ------------------------------------------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum JobPhase {
    Running,
    Finished,
    Failed,
    Canceled,
    Interrupted,
}

impl JobPhase {
    fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Finished => "finished",
            Self::Failed => "failed",
            Self::Canceled => "canceled",
            Self::Interrupted => "interrupted",
        }
    }
}

struct JobState {
    phase: JobPhase,
    step: u8,
    fraction: f64,
    short_id: Option<String>,
    run_dir: Option<String>,
    result: Option<Value>,
    error: Option<String>,
    output: Option<PathBuf>,
    project: Option<PathBuf>,
}

pub(crate) struct TemplateShortJob {
    id: String,
    workspace: PathBuf,
    cancel: AtomicBool,
    state: Mutex<JobState>,
}

enum Ending {
    Exited,
    Failed(String),
    Canceled,
    Stalled,
}

fn join_relative(workspace: &Path, relative: &str) -> PathBuf {
    relative
        .split('/')
        .fold(workspace.to_path_buf(), |path, part| path.join(part))
}

impl TemplateShortJob {
    fn phase(&self) -> JobPhase {
        lock(&self.state).phase
    }

    fn apply_progress(&self, report: &ProgressReport) {
        let mut state = lock(&self.state);
        if report.step > state.step || (report.step == state.step && report.fraction >= state.fraction) {
            state.step = report.step;
            state.fraction = report.fraction;
        }
        if state.short_id.is_none() && report.short_id.is_some() {
            state.short_id = report.short_id.clone();
            state.run_dir = report.run_dir.clone();
        }
    }

    fn run_dir(&self) -> Option<PathBuf> {
        lock(&self.state)
            .run_dir
            .as_deref()
            .map(|dir| join_relative(&self.workspace, dir))
    }

    /// The output and project paths come from the child, but only exactly `<runDir>/output.mp4` and
    /// `<runDir>/short.editkin.json` inside this job's workspace are accepted.
    fn finish(&self, ending: Ending, stdout: Option<BoundedCapture>, stderr: Option<BoundedCapture>, cleaned: bool, limit: Duration) {
        let mut state = lock(&self.state);
        match ending {
            Ending::Canceled => {
                state.phase = JobPhase::Canceled;
                state.error = Some("已經停下來了".into());
            }
            Ending::Stalled => {
                state.phase = JobPhase::Interrupted;
                state.error = Some(format!(
                    "超過 {} 分鐘沒有任何進展，已經停下這個工作",
                    limit.as_secs().div_ceil(60)
                ));
            }
            Ending::Failed(message) => {
                state.phase = JobPhase::Failed;
                state.error = Some(message);
            }
            Ending::Exited => {
                let parsed = match stdout.as_ref() {
                    Some(capture) if capture.truncated => Err("自動剪輯子程序的輸出超過上限".to_string()),
                    Some(capture) => parse_envelope(&capture.bytes),
                    None => Err("自動剪輯子程序的輸出沒有在期限內讀完".to_string()),
                };
                match parsed {
                    Ok(result)
                        if result.get("schema").and_then(Value::as_str) == Some(IN_APP_RESULT_SCHEMA) =>
                    {
                        let run_dir = result
                            .get("shortId")
                            .and_then(Value::as_str)
                            .and_then(run_dir_of)
                            .filter(|dir| result.get("runDir").and_then(Value::as_str) == Some(dir.as_str()));
                        if let Some(dir) = &run_dir {
                            let exact = |field: &str, name: &str| {
                                result
                                    .get(field)
                                    .and_then(Value::as_str)
                                    .filter(|value| *value == format!("{dir}/{name}"))
                                    .map(|value| join_relative(&self.workspace, value))
                                    .filter(|path| path.is_file())
                            };
                            if result.get("delivered") == Some(&Value::Bool(true)) {
                                state.output = exact("outputPath", "output.mp4");
                            }
                            state.project = exact("projectPath", "short.editkin.json");
                            state.short_id = result.get("shortId").and_then(Value::as_str).map(str::to_string);
                            state.run_dir = run_dir.clone();
                        }
                        if result.get("delivered") == Some(&Value::Bool(true)) && state.output.is_none() {
                            state.phase = JobPhase::Failed;
                            state.error = Some("成片不在這支短影音自己的資料夾裡；不交付".into());
                        } else {
                            state.phase = JobPhase::Finished;
                            state.step = 3;
                            state.fraction = 1.0;
                        }
                        state.result = Some(result);
                    }
                    Ok(_) => {
                        state.phase = JobPhase::Failed;
                        state.error = Some("自動剪輯子程序的結果格式不合法".into());
                    }
                    Err(message) => {
                        let tail = stderr_tail(stderr.as_ref());
                        state.phase = JobPhase::Failed;
                        state.error = Some(if tail.is_empty() { message } else { format!("{message}：{tail}") });
                    }
                }
            }
        }
        if !cleaned && state.phase != JobPhase::Finished {
            let note = "（子程序清理沒有被確認）";
            state.error = Some(format!("{}{note}", state.error.clone().unwrap_or_default()));
        }
    }

    fn status(&self) -> (Value, Option<PathBuf>) {
        let state = lock(&self.state);
        let mut value = json!({
            "jobId": self.id,
            "phase": state.phase.as_str(),
            "step": state.step,
            "fraction": state.fraction,
        });
        if let Some(short_id) = &state.short_id {
            value["shortId"] = json!(short_id);
        }
        if let Some(result) = &state.result {
            value["result"] = result.clone();
        }
        if let Some(output) = &state.output {
            value["outputPath"] = json!(output.to_string_lossy());
        }
        if let Some(error) = &state.error {
            value["error"] = json!(error);
        }
        (value, state.output.clone())
    }
}

pub(crate) struct JobLaunch {
    pub node: PathBuf,
    pub script: PathBuf,
    pub environment: Vec<(OsString, OsString)>,
    pub workspace: PathBuf,
    /// `{command, payload}`; the job adds `payload.progressPath`.
    pub request: Value,
    /// Per-user app data folder; each job uses `<job_root>/<jobId>/` for its progress file and removes it at the end.
    pub job_root: PathBuf,
    pub no_progress_limit: Duration,
}

#[derive(Default)]
pub(crate) struct TemplateShortJobs {
    jobs: Mutex<Vec<Arc<TemplateShortJob>>>,
}

static JOB_COUNTER: AtomicU64 = AtomicU64::new(0);

impl TemplateShortJobs {
    fn find(&self, id: &str) -> Option<Arc<TemplateShortJob>> {
        lock(&self.jobs).iter().find(|job| job.id == id).cloned()
    }

    /// One job at a time. The child is spawned before this returns; a supervisor thread owns it from then on.
    pub fn start(&self, launch: JobLaunch) -> Result<String, String> {
        let mut jobs = lock(&self.jobs);
        if jobs.iter().any(|job| job.phase() == JobPhase::Running) {
            return Err("已經有一支直的短影音正在做，做好之後再開始下一支".into());
        }
        let millis = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        let id = format!("tsjob-{millis}-{}", JOB_COUNTER.fetch_add(1, Ordering::SeqCst));
        let job_dir = launch.job_root.join(&id);
        fs::create_dir_all(&job_dir).map_err(|error| format!("無法建立工作資料夾：{error}"))?;
        let progress_path = job_dir.join("progress.json");
        let mut request = launch.request;
        let payload = request
            .get_mut("payload")
            .and_then(Value::as_object_mut)
            .ok_or("工作內容格式不合法")?;
        payload.insert("progressPath".into(), json!(progress_path.to_string_lossy()));
        let input = serde_json::to_vec(&request).map_err(|error| error.to_string())?;
        let spawned = match spawn_child(&launch.node, &launch.script, &launch.environment, &launch.workspace) {
            Ok(spawned) => spawned,
            Err(error) => {
                let _ = fs::remove_dir_all(&job_dir);
                return Err(error);
            }
        };
        let job = Arc::new(TemplateShortJob {
            id: id.clone(),
            workspace: launch.workspace,
            cancel: AtomicBool::new(false),
            state: Mutex::new(JobState {
                phase: JobPhase::Running,
                step: 0,
                fraction: 0.0,
                short_id: None,
                run_dir: None,
                result: None,
                error: None,
                output: None,
                project: None,
            }),
        });
        let supervised = job.clone();
        let limit = launch.no_progress_limit;
        thread::Builder::new()
            .name("template-short-job".into())
            .spawn(move || supervise(supervised, spawned, input, progress_path, job_dir, limit))
            .map_err(|error| format!("無法啟動工作監看：{error}"))?;
        jobs.push(job);
        let finished = jobs.iter().filter(|job| job.phase() != JobPhase::Running).count();
        if finished > MAX_JOBS_KEPT {
            let mut drop = finished - MAX_JOBS_KEPT;
            jobs.retain(|job| {
                if drop > 0 && job.phase() != JobPhase::Running {
                    drop -= 1;
                    false
                } else {
                    true
                }
            });
        }
        Ok(id)
    }

    pub fn status(&self, id: &str) -> Option<(Value, Option<PathBuf>)> {
        self.find(id).map(|job| job.status())
    }

    pub fn cancel(&self, id: &str) -> bool {
        self.find(id).is_some_and(|job| {
            let running = job.phase() == JobPhase::Running;
            if running {
                job.cancel.store(true, Ordering::SeqCst);
            }
            running
        })
    }

    pub fn delivered_output(&self, id: &str) -> Option<PathBuf> {
        let job = self.find(id)?;
        let state = lock(&job.state);
        (state.phase == JobPhase::Finished).then(|| state.output.clone()).flatten()
    }

    pub fn delivered_project(&self, id: &str) -> Option<PathBuf> {
        let job = self.find(id)?;
        let state = lock(&job.state);
        (state.phase == JobPhase::Finished).then(|| state.project.clone()).flatten()
    }
}

fn supervise(
    job: Arc<TemplateShortJob>,
    spawned: preview_process_platform::Spawned,
    input: Vec<u8>,
    progress_path: PathBuf,
    job_dir: PathBuf,
    limit: Duration,
) {
    let preview_process_platform::Spawned { mut process, mut stdin, stdout, stderr } = spawned;
    let stdout = drain(stdout, STDOUT_LIMIT);
    let stderr = drain(stderr, STDERR_LIMIT);
    let input_error = stdin.write_all(&input).and_then(|()| stdin.flush()).err();
    drop(stdin);
    let started = Instant::now();
    let mut watchdog = NoProgressWatchdog::new(started, limit);
    let mut next_fingerprint = started;
    let ending = loop {
        if let Some(error) = &input_error {
            break Ending::Failed(format!("無法把工作交給子程序：{error}"));
        }
        if job.cancel.load(Ordering::SeqCst) {
            break Ending::Canceled;
        }
        match process.try_wait() {
            Ok(Some(_)) => break Ending::Exited,
            Ok(None) => {}
            Err(error) => break Ending::Failed(format!("無法確認子程序狀態：{error}")),
        }
        if let Some(report) = read_progress(&progress_path) {
            job.apply_progress(&report);
        }
        let now = Instant::now();
        if now >= next_fingerprint {
            let run_dir = job.run_dir();
            watchdog.observe(progress_fingerprint(&progress_path, run_dir.as_deref()), now);
            next_fingerprint = now + FINGERPRINT_INTERVAL;
        }
        if watchdog.stalled(now) {
            break Ending::Stalled;
        }
        thread::sleep(POLL_INTERVAL);
    };
    let cleaned = end_child(&mut process);
    let stdout = stdout.recv_timeout(Duration::from_secs(3)).ok();
    let stderr = stderr.recv_timeout(Duration::from_secs(3)).ok();
    if let Some(report) = read_progress(&progress_path) {
        job.apply_progress(&report);
    }
    job.finish(ending, stdout, stderr, cleaned, limit);
    // Only this job's own progress folder; the run folder in the workspace is never touched.
    let _ = fs::remove_dir_all(&job_dir);
}

// ---- Saving and showing the finished video ---------------------------------------------------------------------------

/// A plain Windows file name from the creator's title: reserved characters become spaces, no trailing dots or spaces,
/// no device names, at most 60 characters.
pub(crate) fn sanitize_file_stem(name: &str) -> Option<String> {
    let cleaned = name
        .chars()
        .map(|character| {
            if character.is_control() || matches!(character, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') {
                ' '
            } else {
                character
            }
        })
        .collect::<String>();
    let collapsed = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    let limited = collapsed
        .trim_matches(|character: char| character == '.' || character == ' ')
        .chars()
        .take(60)
        .collect::<String>();
    let stem = limited
        .trim_end_matches(|character: char| character == '.' || character == ' ')
        .to_string();
    (!stem.is_empty() && !crate::is_windows_reserved_device_name(&stem)).then_some(stem)
}

/// Copies the delivered mp4 into `folder` under a new name; an existing file is never replaced.
pub(crate) fn save_video_copy(output: &Path, folder: &Path, preferred: &str, fallback: &str) -> Result<PathBuf, String> {
    let stem = sanitize_file_stem(preferred)
        .or_else(|| sanitize_file_stem(fallback))
        .ok_or("檔名不合法")?;
    fs::create_dir_all(folder).map_err(|error| format!("無法使用影片資料夾：{error}"))?;
    for number in 1..=99 {
        let name = if number == 1 {
            format!("{stem}.mp4")
        } else {
            format!("{stem} ({number}).mp4")
        };
        let target = folder.join(name);
        let mut file = match fs::OpenOptions::new().write(true).create_new(true).open(&target) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("沒有存好：{error}")),
        };
        let copied = fs::File::open(output)
            .and_then(|mut source| io::copy(&mut source, &mut file))
            .and_then(|_| file.sync_all());
        if let Err(error) = copied {
            drop(file);
            let _ = fs::remove_file(&target);
            return Err(format!("沒有存好：{error}"));
        }
        return Ok(target);
    }
    Err("影片資料夾裡同名的檔案太多了".into())
}

/// Opens the folder with the file selected (Windows: Explorer /select). Only an existing regular file.
pub(crate) fn reveal_in_folder(path: &Path) -> Result<(), String> {
    let text = path.to_str().ok_or("檔案位置無法顯示")?;
    if !path.is_absolute() || text.contains('"') || text.chars().any(char::is_control) {
        return Err("檔案位置不合法".into());
    }
    let metadata = fs::symlink_metadata(path).map_err(|_| "找不到這個檔案".to_string())?;
    if !metadata.is_file() {
        return Err("只能打開檔案所在的資料夾".into());
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let explorer = env::var_os("WINDIR")
            .map(|windows| PathBuf::from(windows).join("explorer.exe"))
            .filter(|explorer| explorer.is_file())
            .ok_or("找不到 Windows 檔案總管")?;
        let plain = crate::process_compatible_path(path.to_path_buf());
        std::process::Command::new(explorer)
            .raw_arg(format!("/select,\"{}\"", plain.display()))
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map(|_| ())
            .map_err(|error| format!("無法打開資料夾：{error}"))
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("/usr/bin/open")
            .arg("-R")
            .arg(path)
            .spawn()
            .map(|_| ())
            .map_err(|error| format!("無法打開資料夾：{error}"))
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(path.parent().ok_or("檔案沒有資料夾")?)
            .spawn()
            .map(|_| ())
            .map_err(|error| format!("無法打開資料夾：{error}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_runtime() -> RuntimePaths {
        let root = env::temp_dir().join("editkin-template-short-runtime");
        let at = |name: &str| root.join(name);
        RuntimePaths {
            resource_root: at("resources"),
            node: at("node.exe"),
            node_manifest: at("NODE-MANIFEST.json"),
            service: at("service.mjs"),
            mcp: at("mcp.mjs"),
            mcp_identity: at("mcp.mjs.material-color-identity.json"),
            agent_launcher: at("launcher.mjs"),
            agent_contract: at("agent-setup-contract.json"),
            remote: at("remote.mjs"),
            ffmpeg: at("ffmpeg.exe"),
            ffprobe: at("ffprobe.exe"),
            whisper_cli: at("whisper-cli.exe"),
            native_core: at("hao-core.exe"),
            gpu_compositor: at("editkin-gpu-compositor.exe"),
            asset_base: at("public"),
            cache_root: at("media-cache"),
            model_root: at("models"),
            creative_pack_root: at("creative-packs"),
            personal_music_root: at("personal-music"),
            personal_visual_root: at("personal-visual"),
            personal_color_lut_root: Some(at("personal-color-luts")),
            font_root: at("fonts"),
            color_root: at("color"),
            plugin_roots: vec![at("plugins"), at("user-plugins")],
            user_plugin_root: at("user-plugins"),
        }
    }

    fn keys(environment: &[(OsString, OsString)]) -> BTreeSet<String> {
        environment.iter().map(|(key, _)| key.to_string_lossy().to_string()).collect()
    }

    fn all_tools() -> ChildTools {
        ChildTools {
            python: Some(env::temp_dir().join("python.exe")),
            video_autopilot_skill: Some(env::temp_dir().join("SKILL.md")),
            workflow_profile: Some(env::temp_dir().join("workflow-profile.json")),
        }
    }

    #[test]
    fn child_environment_is_exactly_the_closed_key_set() {
        let runtime = fixture_runtime();
        let workspace = env::temp_dir().join("workspace");
        let asked = Mutex::new(Vec::new());
        // The host answers every key, secrets included; only the closed set may come back.
        let host = |key: &str| {
            lock(&asked).push(key.to_string());
            Some(OsString::from(format!("host-{key}")))
        };
        let environment = template_short_child_environment(&runtime, &workspace, &all_tools(), &host).unwrap();
        let expected = REQUIRED_ENV_KEYS
            .iter()
            .chain(OPTIONAL_ENV_KEYS.iter())
            .chain(HOST_ENV_KEYS.iter())
            .map(|key| key.to_string())
            .collect::<BTreeSet<_>>();
        assert_eq!(keys(&environment), expected);
        assert_eq!(environment.len(), 16 + 3 + 8);
        for forbidden in ["PATH", "NODE_OPTIONS", "HTTPS_PROXY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "EDITKIN_MCP_MODE", "ELECTRON_RUN_AS_NODE"] {
            assert!(!keys(&environment).contains(forbidden), "{forbidden} leaked");
        }
        let mut queried = lock(&asked).clone();
        queried.sort();
        assert_eq!(queried, HOST_ENV_KEYS.iter().map(|key| key.to_string()).collect::<Vec<_>>());
        let sorted = environment.iter().map(|(key, _)| key.clone()).collect::<Vec<_>>();
        let mut resorted = sorted.clone();
        resorted.sort();
        assert_eq!(sorted, resorted);
        let value = |key: &str| environment.iter().find(|(name, _)| name == key).map(|(_, value)| PathBuf::from(value)).unwrap();
        assert_eq!(value("EDITKIN_WORKSPACE"), workspace);
        assert_eq!(value("HAO_FFMPEG_PATH"), runtime.ffmpeg);
        assert_eq!(value("EDITKIN_FFMPEG_PATH"), runtime.ffmpeg);
        assert_eq!(value("EDITKIN_FFPROBE_PATH"), runtime.ffprobe);
        assert_eq!(value("EDITKIN_GPU_COMPOSITOR_PATH"), runtime.gpu_compositor);
        assert_eq!(
            value("EDITKIN_PLUGIN_ROOTS").as_os_str(),
            env::join_paths(runtime.plugin_roots.iter()).unwrap()
        );
    }

    #[test]
    fn child_environment_without_tools_or_host_keys_is_the_required_set() {
        let none = ChildTools { python: None, video_autopilot_skill: None, workflow_profile: None };
        let environment = template_short_child_environment(
            &fixture_runtime(),
            &env::temp_dir().join("workspace"),
            &none,
            &|_| None,
        )
        .unwrap();
        assert_eq!(keys(&environment), REQUIRED_ENV_KEYS.iter().map(|key| key.to_string()).collect());
    }

    #[test]
    fn child_environment_skips_unusable_host_values_and_rejects_bad_editkin_values() {
        let host = |key: &str| match key {
            "TEMP" => Some(OsString::from("C:\\Temp\r\nINJECTED=1")),
            "TMP" => Some(OsString::new()),
            _ => Some(OsString::from("C:\\ok")),
        };
        let environment =
            template_short_child_environment(&fixture_runtime(), &env::temp_dir().join("workspace"), &all_tools(), &host).unwrap();
        assert!(!keys(&environment).contains("TEMP"));
        assert!(!keys(&environment).contains("TMP"));
        assert!(keys(&environment).contains("SYSTEMROOT"));
        let mut runtime = fixture_runtime();
        runtime.ffmpeg = PathBuf::from("C:\\bad\npath\\ffmpeg.exe");
        assert!(template_short_child_environment(&runtime, &env::temp_dir().join("workspace"), &all_tools(), &|_| None).is_err());
        assert!(template_short_child_environment(&fixture_runtime(), Path::new("relative"), &all_tools(), &|_| None).is_err());
    }

    #[test]
    fn watchdog_stops_only_after_the_limit_without_any_change() {
        let start = Instant::now();
        let mut watchdog = NoProgressWatchdog::new(start, Duration::from_secs(300));
        watchdog.observe(1, start);
        assert!(!watchdog.stalled(start + Duration::from_secs(299)));
        watchdog.observe(2, start + Duration::from_secs(200));
        assert!(!watchdog.stalled(start + Duration::from_secs(499)));
        watchdog.observe(2, start + Duration::from_secs(400));
        assert!(watchdog.stalled(start + Duration::from_secs(500)));
    }

    fn scratch(name: &str) -> PathBuf {
        let path = env::temp_dir().join(format!(
            "editkin-template-short-test-{name}-{}-{}",
            std::process::id(),
            JOB_COUNTER.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn progress_is_bounded_validated_and_ties_the_run_folder_to_the_short_id() {
        let root = scratch("progress");
        let path = root.join("progress.json");
        let write = |value: Value| fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
        write(json!({"schema": PROGRESS_SCHEMA, "step": 2, "fraction": 0.4, "shortId": "ts-20261010-img-4022-3f9a1c",
            "runDir": "videos/_AUTOPILOT/editkin-short/20261010-img-4022-3f9a1c"}));
        assert_eq!(
            read_progress(&path),
            Some(ProgressReport {
                step: 2,
                fraction: 0.4,
                short_id: Some("ts-20261010-img-4022-3f9a1c".into()),
                run_dir: Some("videos/_AUTOPILOT/editkin-short/20261010-img-4022-3f9a1c".into()),
            })
        );
        write(json!({"schema": PROGRESS_SCHEMA, "step": 1, "fraction": 0.5, "shortId": "ts-20261010-img-4022-3f9a1c", "runDir": "../../Windows"}));
        assert_eq!(read_progress(&path).unwrap().run_dir, None);
        write(json!({"schema": PROGRESS_SCHEMA, "step": 4, "fraction": 0.5}));
        assert_eq!(read_progress(&path), None);
        write(json!({"schema": "other", "step": 1, "fraction": 0.5}));
        assert_eq!(read_progress(&path), None);
        fs::write(&path, vec![b' '; 5_000]).unwrap();
        assert_eq!(read_progress(&path), None);
        assert!(valid_short_id("ts-20261010-clip-000000"));
        for bad in ["ts-2026101-img-3f9a1c", "ts-20261010-IMG-3f9a1c", "ts-20261010-img-3f9a1", "20261010-img-3f9a1c", "ts-20261010-3f9a1c", "ts-20261010-a--b-3f9a1c"] {
            assert!(!valid_short_id(bad), "{bad}");
        }
        assert_eq!(run_dir_of("ts-20261010-a-b-0123ab").as_deref(), Some("videos/_AUTOPILOT/editkin-short/20261010-a-b-0123ab"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn fingerprint_moves_when_the_run_folder_or_progress_moves() {
        let root = scratch("fingerprint");
        let progress = root.join("progress.json");
        let run = root.join("run");
        fs::create_dir_all(run.join("attempt-1")).unwrap();
        let first = progress_fingerprint(&progress, Some(&run));
        assert_eq!(first, progress_fingerprint(&progress, Some(&run)));
        fs::write(run.join("attempt-1").join(".editkin-short-candidate.mp4"), b"1234").unwrap();
        let grown = progress_fingerprint(&progress, Some(&run));
        assert_ne!(first, grown);
        fs::OpenOptions::new().append(true).open(run.join("attempt-1").join(".editkin-short-candidate.mp4")).unwrap().write_all(b"5678").unwrap();
        let more = progress_fingerprint(&progress, Some(&run));
        assert_ne!(grown, more);
        fs::write(&progress, b"{\"step\":1}").unwrap();
        assert_ne!(more, progress_fingerprint(&progress, Some(&run)));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn workspace_is_the_nearest_folder_with_a_real_autopilot_folder() {
        let root = scratch("workspace");
        let workspace = root.join("hao");
        fs::create_dir_all(workspace.join(".autopilot")).unwrap();
        fs::create_dir_all(workspace.join("videos").join("_INBOX").join("直式")).unwrap();
        let clip = workspace.join("videos").join("_INBOX").join("直式").join("IMG_4022.MOV");
        fs::write(&clip, b"clip").unwrap();
        let canonical = |path: &Path| crate::process_compatible_path(fs::canonicalize(path).unwrap());
        let found = find_workspace_source(&canonical(&clip)).unwrap();
        assert_eq!(found.workspace, canonical(&workspace));
        assert_eq!(found.relative, "videos/_INBOX/直式/IMG_4022.MOV");
        assert_eq!((found.scope.as_str(), found.scope_is_file), ("videos", false));
        let resolved = resolve_workspace_source(&clip.to_string_lossy()).unwrap().unwrap();
        assert_eq!(resolved, found);
        assert!(!defaults_present(&found.workspace));
        fs::write(workspace.join(".autopilot").join(DEFAULTS_FILE), b"{}").unwrap();
        assert!(defaults_present(&found.workspace));
        let loose = workspace.join("loose.mov");
        fs::write(&loose, b"clip").unwrap();
        let file_scope = find_workspace_source(&canonical(&loose)).unwrap();
        assert_eq!((file_scope.scope.as_str(), file_scope.scope_is_file, file_scope.relative.as_str()), ("loose.mov", true, "loose.mov"));
        // A nearer `.autopilot` wins; a file named `.autopilot` does not count.
        fs::create_dir_all(workspace.join("videos").join(".autopilot")).unwrap();
        assert_eq!(find_workspace_source(&canonical(&clip)).unwrap().workspace, canonical(&workspace.join("videos")));
        let outside = root.join("elsewhere");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join(".autopilot"), b"not a folder").unwrap();
        fs::write(outside.join("clip.mov"), b"clip").unwrap();
        assert!(find_workspace_source(&canonical(&outside.join("clip.mov")))
            .is_none_or(|found| found.workspace != canonical(&outside)));
        assert!(resolve_workspace_source("relative/clip.mov").is_err());
        assert!(resolve_workspace_source(&root.join("missing.mov").to_string_lossy()).is_err());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn copy_and_brand_are_bounded_before_the_child() {
        assert_eq!(validate_copy(&json!({"hook": "來看蝙蝠", "payoff": "其實是來看水簾"})).unwrap(), json!({"hook": "來看蝙蝠", "payoff": "其實是來看水簾"}));
        assert!(validate_copy(&json!({"payoff": "其實是", "points": ["一", "二"]})).is_ok());
        for bad in [
            json!({"payoff": ""}),
            json!({"payoff": "其實是"}),
            json!({"payoff": "其實是", "hook": "原本", "points": ["一", "二"]}),
            json!({"payoff": "其實是", "points": ["一"]}),
            json!({"payoff": "其實是", "points": ["一", "二", "三", "四", "五"]}),
            json!({"payoff": "水".repeat(33), "hook": "原本"}),
            json!({"payoff": "其實是", "hook": "原".repeat(25)}),
            json!({"payoff": "其實是", "hook": "原本\n"}),
            json!({"payoff": "其實是", "hook": "原本", "proof": "多的"}),
        ] {
            assert!(validate_copy(&bad).is_err(), "{bad}");
        }
        assert_eq!(validate_brand_mark(None), Ok(None));
        assert_eq!(validate_brand_mark(Some("   ".into())), Ok(None));
        assert_eq!(validate_brand_mark(Some(" Hao0321 Studio ".into())), Ok(Some("Hao0321 Studio".into())));
        assert_eq!(validate_brand_mark(Some("小明的旅行（台灣）".into())), Ok(Some("小明的旅行（台灣）".into())));
        assert!(validate_brand_mark(Some("a".repeat(17))).is_err());
        assert!(validate_brand_mark(Some("小明🎬".into())).is_err());
        assert!(validate_brand_mark(Some("小・明".into())).is_err());
    }

    #[test]
    fn saved_copies_get_plain_names_and_never_replace_a_file() {
        assert_eq!(sanitize_file_stem("其實是來看水簾的").as_deref(), Some("其實是來看水簾的"));
        assert_eq!(sanitize_file_stem("a/b:c*d?").as_deref(), Some("a b c d"));
        assert_eq!(sanitize_file_stem("  ..名字.. ").as_deref(), Some("名字"));
        assert_eq!(sanitize_file_stem("CON"), None);
        assert_eq!(sanitize_file_stem("\"*?"), None);
        assert_eq!(sanitize_file_stem(&"長".repeat(80)).map(|stem| stem.chars().count()), Some(60));
        let root = scratch("save");
        let output = root.join("output.mp4");
        fs::write(&output, b"mp4 bytes").unwrap();
        let videos = root.join("Videos");
        fs::create_dir_all(&videos).unwrap();
        fs::write(videos.join("標題.mp4"), b"someone else's video").unwrap();
        let saved = save_video_copy(&output, &videos, "標題", "Editkin Short").unwrap();
        assert_eq!(saved.file_name().unwrap().to_string_lossy(), "標題 (2).mp4");
        assert_eq!(fs::read(&saved).unwrap(), b"mp4 bytes");
        assert_eq!(fs::read(videos.join("標題.mp4")).unwrap(), b"someone else's video");
        let fallback = save_video_copy(&output, &videos, "???", "Editkin Short").unwrap();
        assert_eq!(fallback.file_name().unwrap().to_string_lossy(), "Editkin Short.mp4");
        assert!(reveal_in_folder(Path::new("relative.mp4")).is_err());
        assert!(reveal_in_folder(&videos).is_err());
        assert!(reveal_in_folder(&root.join("missing.mp4")).is_err());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn envelopes_parse_strictly() {
        assert_eq!(parse_envelope(br#"{"ok":true,"result":{"a":1}}"#), Ok(json!({"a": 1})));
        assert_eq!(parse_envelope(b"debug line\n{\"ok\":true,\"result\":{\"a\":2}}"), Ok(json!({"a": 2})));
        assert_eq!(parse_envelope(br#"{"ok":false,"error":"BLOCK"}"#), Err("BLOCK".into()));
        assert!(parse_envelope(br#"{"ok":true,"result":[1]}"#).is_err());
        assert!(parse_envelope(b"").is_err());
    }

    /// A real owned child (the vendored Node), so spawn, stdin, stdout, cancel, the watchdog and tree cleanup are the
    /// production code paths. Skipped where the vendored Node is absent.
    fn vendored_node() -> Option<PathBuf> {
        let node = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()?
            .join("vendor/node/win32-x64/node.exe");
        (cfg!(windows) && node.is_file()).then_some(node)
    }

    fn child_job(script: &str, limit: Duration) -> Option<(TemplateShortJobs, String, PathBuf)> {
        let node = vendored_node()?;
        let root = scratch("job");
        let workspace = root.join("workspace");
        fs::create_dir_all(workspace.join("videos/_AUTOPILOT/editkin-short/20261010-clip-0123ab")).unwrap();
        let script_path = root.join("child.mjs");
        fs::write(&script_path, script).unwrap();
        let jobs = TemplateShortJobs::default();
        let environment = vec![
            (OsString::from("SYSTEMROOT"), env::var_os("SYSTEMROOT").unwrap_or_default()),
            (OsString::from("EDITKIN_WORKSPACE"), workspace.clone().into_os_string()),
        ];
        let id = jobs
            .start(JobLaunch {
                node,
                script: script_path,
                environment,
                workspace: workspace.clone(),
                request: json!({"command": "template_short_run", "payload": {"genre": "travel"}}),
                job_root: root.join("jobs"),
                no_progress_limit: limit,
            })
            .unwrap();
        Some((jobs, id, root))
    }

    fn wait_until_done(jobs: &TemplateShortJobs, id: &str) -> Value {
        let deadline = Instant::now() + Duration::from_secs(60);
        loop {
            let (status, _) = jobs.status(id).unwrap();
            if status["phase"] != "running" || Instant::now() > deadline {
                return status;
            }
            thread::sleep(Duration::from_millis(100));
        }
    }

    #[test]
    fn a_child_reports_progress_and_delivers_only_inside_its_run_folder() {
        let script = r#"
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
const request = JSON.parse(readFileSync(0, "utf8"));
if (process.argv[2] !== "--editkin-one-shot" || request.command !== "template_short_run" || process.env.PATH !== undefined) process.exit(3);
const runDir = "videos/_AUTOPILOT/editkin-short/20261010-clip-0123ab";
writeFileSync(request.payload.progressPath, JSON.stringify({ schema: "editkin.template-short-progress/v1", step: 2, fraction: 0.5, shortId: "ts-20261010-clip-0123ab", runDir }));
writeFileSync(`${process.env.EDITKIN_WORKSPACE}/${runDir}/output.mp4`, "mp4");
writeFileSync(`${process.env.EDITKIN_WORKSPACE}/${runDir}/short.editkin.json`, "{}");
setTimeout(() => process.stdout.write(JSON.stringify({ ok: true, result: { schema: "editkin.template-short-in-app/v1", status: "REVIEW_REQUIRED", delivered: true,
  shortId: "ts-20261010-clip-0123ab", runDir, outputPath: `${runDir}/output.mp4`, projectPath: `${runDir}/short.editkin.json`, flags: [] } }), () => process.exit(0)), 300);
"#;
        let Some((jobs, id, root)) = child_job(script, Duration::from_secs(60)) else { return };
        assert!(jobs.start(JobLaunch {
            node: vendored_node().unwrap(), script: root.join("child.mjs"), environment: Vec::new(), workspace: root.join("workspace"),
            request: json!({"command": "template_short_run", "payload": {}}), job_root: root.join("jobs"), no_progress_limit: Duration::from_secs(60),
        }).is_err(), "only one job at a time");
        let status = wait_until_done(&jobs, &id);
        assert_eq!(status["phase"], "finished", "{status}");
        assert_eq!(status["step"], 3);
        assert_eq!(status["shortId"], "ts-20261010-clip-0123ab");
        assert_eq!(status["result"]["status"], "REVIEW_REQUIRED");
        let output = jobs.delivered_output(&id).unwrap();
        assert!(output.ends_with("output.mp4") && output.starts_with(root.join("workspace")));
        assert!(jobs.delivered_project(&id).unwrap().ends_with("short.editkin.json"));
        assert!(!root.join("jobs").join(&id).exists(), "the job's own progress folder is removed");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_result_pointing_outside_its_run_folder_is_not_delivered() {
        let script = r#"
import { readFileSync } from "node:fs";
readFileSync(0, "utf8");
process.stdout.write(JSON.stringify({ ok: true, result: { schema: "editkin.template-short-in-app/v1", status: "READY", delivered: true,
  shortId: "ts-20261010-clip-0123ab", runDir: "videos/_AUTOPILOT/editkin-short/20261010-clip-0123ab", outputPath: "../../secret.mp4", flags: [] } }), () => process.exit(0));
"#;
        let Some((jobs, id, root)) = child_job(script, Duration::from_secs(60)) else { return };
        let status = wait_until_done(&jobs, &id);
        assert_eq!(status["phase"], "failed", "{status}");
        assert!(jobs.delivered_output(&id).is_none());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn cancel_kills_the_child_tree() {
        let script = r#"
import { spawn } from "node:child_process";
spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
setInterval(() => {}, 1000);
"#;
        let Some((jobs, id, root)) = child_job(script, Duration::from_secs(60)) else { return };
        thread::sleep(Duration::from_millis(800));
        assert!(jobs.cancel(&id));
        let status = wait_until_done(&jobs, &id);
        assert_eq!(status["phase"], "canceled", "{status}");
        assert!(!jobs.cancel(&id), "a finished job cannot be cancelled again");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn the_watchdog_stops_a_child_that_makes_no_progress() {
        let script = "setInterval(() => {}, 1000);\n";
        let Some((jobs, id, root)) = child_job(script, Duration::from_secs(3)) else { return };
        let status = wait_until_done(&jobs, &id);
        assert_eq!(status["phase"], "interrupted", "{status}");
        assert!(status["error"].as_str().unwrap().contains("沒有任何進展"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn genre_list_is_the_engine_video_types() {
        // src/motion/referenceMotionTemplates.ts REFERENCE_MOTION_VIDEO_TYPES keys, in order.
        assert_eq!(GENRES, ["teaching", "podcast", "travel", "food", "unboxing", "game", "product", "brand", "knowledge"]);
        let source = fs::read_to_string(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../src/motion/referenceMotionTemplates.ts")).unwrap();
        let start = source.find("export const REFERENCE_MOTION_VIDEO_TYPES = {").unwrap();
        let block = &source[start..start + source[start..].find("} as const").unwrap()];
        let declared = block
            .lines()
            .filter_map(|line| line.trim_start().split_once(": { name:").map(|(key, _)| key.trim().to_string()))
            .collect::<Vec<_>>();
        assert_eq!(declared, GENRES.iter().map(|genre| genre.to_string()).collect::<Vec<_>>());
    }

    #[test]
    fn brand_characters_match_the_rights_screen_check() {
        // The rights screen refuses the same characters inline (firstUnsupportedBrandCharacter), so the click never fails here.
        let source = fs::read_to_string(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../src/ui/easy/easyFlowModel.ts")).unwrap();
        let start = source.find("export function firstUnsupportedBrandCharacter").unwrap();
        let body = &source[start..start + source[start..].find("\n}\n").unwrap()];
        for range in ["(code >= 0x20 && code <= 0x7e)", "(code >= 0x3400 && code <= 0x4dbf)", "(code >= 0x4e00 && code <= 0x9fff)",
            "(code >= 0xff01 && code <= 0xff5e)", "code === 0x3001", "code === 0x3002", "(code >= 0x3008 && code <= 0x3011)"] {
            assert!(body.contains(range), "{range}");
        }
        for fine in ["Hao0321 Studio", "駱君昊", "《阿明》【旅行】", "ＡＢＣ！", "A&B-c_d.e"] {
            assert_eq!(validate_brand_mark(Some(fine.into())), Ok(Some(fine.to_string())), "{fine}");
        }
        for refused in ["Café", "旅行—日記", "小・明", "好吃🍜", "一\t二"] {
            assert!(validate_brand_mark(Some(refused.into())).is_err(), "{refused}");
        }
    }
}
