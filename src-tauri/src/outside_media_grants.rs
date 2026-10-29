//! Outside-workspace media read grants (security finding 2026-10-23).
//!
//! The Editkin MCP server reads project media outside `EDITKIN_WORKSPACE` only when the creator
//! brought that very file into Editkin here, in the desktop app; a saved project file is never an
//! authority (anyone can hand over a crafted `.editkin.json`). This trusted host process is the only
//! writer of the grant store. The MCP server (`src/mcp/outsideMediaGrants.ts`) only reads it; no MCP
//! tool writes here, and a project file cannot create or extend a grant.
//!
//! Grants are recorded by the media chooser (`pick_media`), drag-and-drop (`import_media_paths`),
//! the batch chooser (`pick_batch_media`, as an import), relink (`pick_relink_media`) and by the
//! creator's 允許 for a project (`grant_project_outside_media`). Opening a batch project grants nothing.
//! Each grant names the canonical path, its size, modification time (whole milliseconds since 1970)
//! and the SHA-256 of its first 64 KiB; the MCP side refuses the file once any of them differs.
//!
//! Opening a project grants nothing (security finding 2026-10-23, confused deputy): the project JSON
//! is untrusted, so a crafted or shared project opened in the GUI must not hand an AI agent the local
//! media it points at. Instead the GUI asks (`inspect_project_outside_media` lists the project's media
//! files that are not granted yet, by file name) and only the creator's 允許 on this computer grants
//! them. That command re-reads the project from disk here and grants only files that very project
//! references; the webview's list can only choose among them. Projects saved before grants existed
//! migrate the same way: opening each one asks once. Grants an earlier build recorded automatically on
//! project open (`source: "project_open"`) are not honoured and are dropped on the next write.
//! UNC, `\\?\`, `\\.\`, `\??\`, `//`, device names, relative paths, non-media extensions, missing
//! files and anything that canonicalises to a network path are never granted, and the network forms
//! are rejected from their text before any filesystem call.
//!
//! Store: `<app data>/media-access/outside-media-grants.json`, schema `editkin.outside-media-grants/v1`
//! (`schemaVersion` 1), written whole to a temporary file and renamed over the previous store.

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    time::{Duration, UNIX_EPOCH},
};
use tauri::AppHandle;

pub const SCHEMA: &str = "editkin.outside-media-grants/v1";
pub const SCHEMA_VERSION: u64 = 1;
pub const STORE_DIRECTORY: &str = "media-access";
pub const STORE_FILE: &str = "outside-media-grants.json";
pub const HEAD_BYTES: u64 = 64 * 1024;
pub const MAX_GRANTS: usize = 20_000;
/// One import, relink or project 允許 grants at most this many files.
pub const MAX_PATHS_PER_RECORD: usize = 4_096;
const MAX_STORE_BYTES: u64 = 16 * 1024 * 1024;
const MAX_PATH_CHARS: usize = 4_096;
/// JavaScript reads sizes and times as numbers; larger values are not granted.
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
/// Desktop-importable media (`supported_media_path` without the OpenEXR sequence `.json`).
const MEDIA_EXTENSIONS: &[&str] = &[
    "mp4", "mov", "mkv", "webm", "m4v", "mp3", "wav", "m4a", "aac", "flac", "png", "jpg", "jpeg",
    "webp", "exr",
];

static STORE_LOCK: Mutex<()> = Mutex::new(());
static TEMPORARY_COUNTER: AtomicU64 = AtomicU64::new(0);

/// How the creator brought a file in, on this computer. Opening a project is deliberately not one.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GrantSource {
    Import,
    Relink,
    /// 允許 in the open project's prompt (`grant_project_outside_media`).
    ProjectConsent,
}

/// Sources a stored grant may name. `project_open` (automatic grants on project open, before the
/// 2026-10-23 consent fix) is not among them, so such grants are ignored and dropped on the next write.
const GRANT_SOURCES: &[&str] = &["import", "relink", "project_consent"];

impl GrantSource {
    fn as_str(self) -> &'static str {
        match self {
            GrantSource::Import => "import",
            GrantSource::Relink => "relink",
            GrantSource::ProjectConsent => "project_consent",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Grant {
    pub path: String,
    pub size: u64,
    pub mtime_ms: u64,
    pub head_sha256: String,
    pub head_bytes: u64,
    pub granted_at_ms: u64,
    pub source: String,
}

impl Grant {
    fn to_json(&self) -> Value {
        json!({
            "path": self.path,
            "size": self.size,
            "mtimeMs": self.mtime_ms,
            "headSha256": self.head_sha256,
            "headBytes": self.head_bytes,
            "grantedAtMs": self.granted_at_ms,
            "source": self.source,
        })
    }

    fn from_json(value: &Value) -> Option<Grant> {
        let text = |key: &str| value.get(key).and_then(Value::as_str).map(str::to_string);
        let number = |key: &str| value.get(key).and_then(Value::as_u64).filter(|n| *n <= MAX_SAFE_INTEGER);
        let grant = Grant {
            path: text("path")?,
            size: number("size")?,
            mtime_ms: number("mtimeMs")?,
            head_sha256: text("headSha256")?,
            head_bytes: number("headBytes")?,
            granted_at_ms: number("grantedAtMs")?,
            source: text("source")?,
        };
        let valid = plain_local_media_path(&grant.path).is_some()
            && grant.head_bytes == grant.size.min(HEAD_BYTES)
            && grant.head_sha256.len() == 64
            && grant
                .head_sha256
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            && GRANT_SOURCES.contains(&grant.source.as_str());
        valid.then_some(grant)
    }
}

pub fn store_path(app_data_root: &Path) -> PathBuf {
    app_data_root.join(STORE_DIRECTORY).join(STORE_FILE)
}

/// A plain local absolute media path, decided from the text alone: this never touches the filesystem,
/// so a network or device reference cannot open an SMB connection (and leak NTLM credentials).
pub fn plain_local_media_path(path: &str) -> Option<PathBuf> {
    if path.is_empty() || path.chars().count() > MAX_PATH_CHARS || path.contains('\0') {
        return None;
    }
    let candidate = if cfg!(windows) {
        let normalized = path.replace('/', "\\");
        let bytes = normalized.as_bytes();
        let drive = bytes.len() >= 3
            && bytes[0].is_ascii_alphabetic()
            && bytes[1] == b':'
            && bytes[2] == b'\\';
        // The shared text rule (`crate::local_path_text_problem`: network, device, stream, not absolute), plus the
        // grant-only rule of a plain drive-letter path (no `\\?\` form is stored).
        if !drive || crate::local_path_text_problem(&normalized).is_some() {
            return None;
        }
        PathBuf::from(normalized)
    } else {
        if path.starts_with("//") || !path.starts_with('/') {
            return None;
        }
        PathBuf::from(path)
    };
    has_media_extension(&candidate).then_some(candidate)
}

fn has_media_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
        .is_some_and(|extension| MEDIA_EXTENSIONS.contains(&extension.as_str()))
}

/// `fs::canonicalize` returns `\\?\C:\…` on Windows. Only a verbatim drive path stays local;
/// `\\?\UNC\…` (a mapped network drive, for example) is not granted.
fn local_canonical_text(canonical: &Path) -> Option<String> {
    let text = canonical.to_str()?;
    let local = if cfg!(windows) { text.strip_prefix("\\\\?\\")? } else { text };
    plain_local_media_path(local).map(|_| local.to_string())
}

fn comparable(path: &str) -> String {
    if cfg!(windows) {
        path.to_lowercase()
    } else {
        path.to_string()
    }
}

struct Observed {
    path: String,
    size: u64,
    mtime_ms: u64,
}

/// The canonical local media file `path` names, with its size and modification time.
fn observe(path: &str) -> Option<Observed> {
    let plain = plain_local_media_path(path)?;
    let canonical = fs::canonicalize(&plain).ok()?;
    let canonical = local_canonical_text(&canonical)?;
    let metadata = fs::metadata(&canonical).ok()?;
    if !metadata.is_file() || metadata.len() > MAX_SAFE_INTEGER {
        return None;
    }
    let mtime_ms = u64::try_from(
        metadata
            .modified()
            .ok()?
            .duration_since(UNIX_EPOCH)
            .ok()?
            .as_millis(),
    )
    .ok()
    .filter(|value| *value <= MAX_SAFE_INTEGER)?;
    Some(Observed {
        path: canonical,
        size: metadata.len(),
        mtime_ms,
    })
}

fn head_sha256(path: &Path, bytes: u64) -> Option<String> {
    let mut buffer = Vec::with_capacity(usize::try_from(bytes).ok()?);
    fs::File::open(path)
        .ok()?
        .take(bytes)
        .read_to_end(&mut buffer)
        .ok()?;
    if buffer.len() as u64 != bytes {
        return None;
    }
    Some(
        Sha256::digest(&buffer)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect(),
    )
}

/// Grants in the store. A missing, unusable or malformed store holds none (it is replaced on the next
/// write); a store from a newer Editkin (`schemaVersion` above 1) is left untouched.
pub fn load(store: &Path) -> Result<Vec<Grant>, String> {
    let metadata = match fs::symlink_metadata(store) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("無法讀取素材授權紀錄：{error}")),
    };
    if !metadata.is_file() || metadata.len() > MAX_STORE_BYTES {
        return Ok(Vec::new());
    }
    let bytes = fs::read(store).map_err(|error| format!("無法讀取素材授權紀錄：{error}"))?;
    let Ok(value) = serde_json::from_slice::<Value>(&bytes) else {
        return Ok(Vec::new());
    };
    if value
        .get("schemaVersion")
        .and_then(Value::as_u64)
        .is_some_and(|version| version > SCHEMA_VERSION)
    {
        return Err("素材授權紀錄來自較新的 Editkin，這一版不覆寫它".into());
    }
    if value.get("schema").and_then(Value::as_str) != Some(SCHEMA)
        || value.get("schemaVersion").and_then(Value::as_u64) != Some(SCHEMA_VERSION)
    {
        return Ok(Vec::new());
    }
    Ok(value
        .get("grants")
        .and_then(Value::as_array)
        .map(|grants| {
            grants
                .iter()
                .take(MAX_GRANTS)
                .filter_map(Grant::from_json)
                .collect()
        })
        .unwrap_or_default())
}

fn write(store: &Path, grants: &[Grant], now_ms: u64) -> Result<(), String> {
    let parent = store.parent().ok_or("素材授權紀錄沒有資料夾")?;
    fs::create_dir_all(parent).map_err(|error| format!("無法建立素材授權資料夾：{error}"))?;
    let document = json!({
        "schema": SCHEMA,
        "schemaVersion": SCHEMA_VERSION,
        "writer": "editkin-desktop",
        "updatedAtMs": now_ms,
        "grants": grants.iter().map(Grant::to_json).collect::<Vec<_>>(),
    });
    let text = serde_json::to_string_pretty(&document).map_err(|error| error.to_string())?;
    let temporary = parent.join(format!(
        "{STORE_FILE}.{}.{}.tmp",
        std::process::id(),
        TEMPORARY_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    let written = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .and_then(|mut file| {
            file.write_all(text.as_bytes())?;
            file.write_all(b"\n")?;
            file.sync_all()
        });
    if let Err(error) = written {
        let _ = fs::remove_file(&temporary);
        return Err(format!("無法寫入素材授權紀錄：{error}"));
    }
    // Replaces the previous store in one step. A reader holding it open briefly may refuse the
    // replacement on Windows; retry a few times instead of ever exposing a partial store.
    let mut attempt = 0;
    loop {
        match fs::rename(&temporary, store) {
            Ok(()) => return Ok(()),
            Err(_) if attempt < 4 => {
                attempt += 1;
                std::thread::sleep(Duration::from_millis(25 * attempt));
            }
            Err(error) => {
                let _ = fs::remove_file(&temporary);
                return Err(format!("無法更新素材授權紀錄：{error}"));
            }
        }
    }
}

/// Records grants for the local media files among `paths`; returns how many grants were added or
/// refreshed. Paths that are not plain local media files are skipped without touching the filesystem
/// when their text already rules them out. Every source is an explicit act of the creator here, so
/// the file is always re-measured.
pub fn record(
    app_data_root: &Path,
    paths: &[String],
    source: GrantSource,
    now_ms: u64,
) -> Result<usize, String> {
    let observed: Vec<Observed> = paths
        .iter()
        .take(MAX_PATHS_PER_RECORD)
        .filter_map(|path| observe(path))
        .collect();
    if observed.is_empty() {
        return Ok(0);
    }
    let _guard = STORE_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    let store = store_path(app_data_root);
    let mut grants = load(&store)?;
    let mut index: BTreeMap<String, usize> = grants
        .iter()
        .enumerate()
        .map(|(position, grant)| (comparable(&grant.path), position))
        .collect();
    let mut changed = 0;
    for item in observed {
        let key = comparable(&item.path);
        let existing = index.get(&key).copied();
        let head_bytes = item.size.min(HEAD_BYTES);
        let Some(head) = head_sha256(Path::new(&item.path), head_bytes) else {
            continue;
        };
        let grant = Grant {
            path: item.path,
            size: item.size,
            mtime_ms: item.mtime_ms,
            head_sha256: head,
            head_bytes,
            granted_at_ms: now_ms,
            source: source.as_str().to_string(),
        };
        match existing {
            Some(position) => grants[position] = grant,
            None => {
                index.insert(key, grants.len());
                grants.push(grant);
            }
        }
        changed += 1;
    }
    if changed == 0 {
        return Ok(0);
    }
    if grants.len() > MAX_GRANTS {
        grants.sort_by(|left, right| right.granted_at_ms.cmp(&left.granted_at_ms));
        grants.truncate(MAX_GRANTS);
    }
    write(&store, &grants, now_ms)?;
    Ok(changed)
}

/// The plain file references of a project's assets (`creative://`, composition and other URIs are
/// not files on this computer; `file:` URLs are not written by the desktop app).
pub fn project_media_paths(project: &Value) -> Vec<String> {
    project
        .get("assets")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|asset| asset.get("uri").and_then(Value::as_str))
        .filter(|uri| !uri.contains("://") && !uri.to_ascii_lowercase().starts_with("file:"))
        .take(MAX_PATHS_PER_RECORD)
        .map(str::to_string)
        .collect()
}

/// One local media file a project references that the MCP server may not read yet.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UngrantedMedia {
    /// The reference exactly as the project names it; 允許 sends it back to choose this file.
    pub reference: String,
    /// The file name only: the prompt never shows a whole path.
    pub name: String,
}

/// `folder` as comparable text that ends in a separator, for prefix tests.
fn folder_prefix(folder: &str) -> String {
    let separator = if cfg!(windows) { '\\' } else { '/' };
    let mut text = if cfg!(windows) { folder.replace('/', "\\") } else { folder.to_string() };
    if !text.ends_with(separator) {
        text.push(separator);
    }
    comparable(&text)
}

fn starts_under(prefix: &str, path: &str) -> bool {
    let text = if cfg!(windows) { path.replace('/', "\\") } else { path.to_string() };
    comparable(&text).starts_with(prefix)
}

/// The project's referenced local media files that exist, pass every grant filter and have no current
/// grant (same canonical path, size and modification time). Reads the store; never writes it. A file
/// inside the project file's own folder (both as written and canonically) is not listed: the MCP server
/// can only open a project inside its EDITKIN_WORKSPACE, so such a file is inside that workspace too
/// (the desktop app does not know the agent's workspace, so other files inside it may still be listed;
/// allowing them is harmless).
pub fn ungranted_project_media(
    app_data_root: &Path,
    project_file: &Path,
    project: &Value,
) -> Result<Vec<UngrantedMedia>, String> {
    let folder = project_file.parent();
    let lexical_folder = folder.and_then(Path::to_str).map(folder_prefix);
    let canonical_folder = folder
        .and_then(|folder| fs::canonicalize(folder).ok())
        .and_then(|canonical| {
            let text = canonical.to_str()?;
            let local = if cfg!(windows) { text.strip_prefix("\\\\?\\")? } else { text };
            Some(folder_prefix(local))
        });
    let grants = load(&store_path(app_data_root))?;
    let granted: BTreeMap<String, &Grant> = grants.iter().map(|grant| (comparable(&grant.path), grant)).collect();
    let mut seen = BTreeSet::new();
    let mut ungranted = Vec::new();
    for reference in project_media_paths(project) {
        // Text first: a network or device reference is never touched.
        let Some(plain) = plain_local_media_path(&reference) else {
            continue;
        };
        let Some(observed) = observe(&reference) else {
            continue;
        };
        let key = comparable(&observed.path);
        if !seen.insert(key.clone()) {
            continue;
        }
        let inside_project_folder = matches!((&lexical_folder, &canonical_folder), (Some(lexical), Some(canonical))
            if plain.to_str().is_some_and(|text| starts_under(lexical, text)) && starts_under(canonical, &observed.path));
        if inside_project_folder {
            continue;
        }
        if granted
            .get(&key)
            .is_some_and(|grant| grant.size == observed.size && grant.mtime_ms == observed.mtime_ms)
        {
            continue;
        }
        let name = plain
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_default();
        ungranted.push(UngrantedMedia { reference, name });
    }
    Ok(ungranted)
}

/// 允許 for a project: grants that project's own media references among `selected`. `project` is the
/// project as this host loaded it from disk; `selected` (from the webview) only chooses among its
/// references, by exact text, so a path the project does not name is never granted whatever is sent.
/// Every grant filter of `record` still applies. Returns how many grants were added or refreshed.
pub fn grant_project_consent(
    app_data_root: &Path,
    project: &Value,
    selected: &[String],
    now_ms: u64,
) -> Result<usize, String> {
    let wanted: BTreeSet<&str> = selected.iter().take(MAX_PATHS_PER_RECORD).map(String::as_str).collect();
    let mut taken = BTreeSet::new();
    let chosen: Vec<String> = project_media_paths(project)
        .into_iter()
        .filter(|reference| wanted.contains(reference.as_str()) && taken.insert(reference.clone()))
        .collect();
    record(app_data_root, &chosen, GrantSource::ProjectConsent, now_ms)
}

/// The project at `project_path`, read from disk with the reader that opens projects in the GUI. The
/// webview's copy of the project is never consulted.
async fn host_loaded_project(app: &AppHandle, project_path: &str) -> Result<(PathBuf, Value), String> {
    let path = crate::desktop_files::validate_project_path(project_path)?;
    let opened = crate::call_service(app, "read_project", json!({ "path": path, "captureFileIdentity": true })).await?;
    let project = opened.get("project").cloned().ok_or("read receipt missing project")?;
    Ok((path, project))
}

/// 「這個專案用到工作區外的 N 個素材。要允許 AI 助手讀取它們嗎？」: the open project's media files that the
/// MCP server may not read yet, with their file names. Grants nothing.
#[tauri::command]
pub(crate) async fn inspect_project_outside_media(
    app: AppHandle,
    window: tauri::WebviewWindow,
    project_path: String,
) -> Result<Value, String> {
    crate::engine_tasks_v1::main_window(window.label())?;
    let (path, project) = host_loaded_project(&app, &project_path).await?;
    let root = crate::application_data_root(&app)?;
    let items = tauri::async_runtime::spawn_blocking(move || ungranted_project_media(&root, &path, &project))
        .await
        .map_err(|error| error.to_string())??;
    Ok(json!({
        "count": items.len(),
        "items": items.iter().map(|item| json!({ "path": item.reference, "name": item.name })).collect::<Vec<_>>(),
    }))
}

/// 允許 in that prompt, pressed by the creator on this computer: re-reads the project from disk and grants
/// only its own references among `paths` (see `grant_project_consent`).
#[tauri::command]
pub(crate) async fn grant_project_outside_media(
    app: AppHandle,
    window: tauri::WebviewWindow,
    project_path: String,
    paths: Vec<String>,
) -> Result<Value, String> {
    crate::engine_tasks_v1::main_window(window.label())?;
    if paths.len() > MAX_PATHS_PER_RECORD {
        return Err("一次要允許的素材太多".into());
    }
    let (_, project) = host_loaded_project(&app, &project_path).await?;
    let root = crate::application_data_root(&app)?;
    let now_ms = u64::try_from(crate::unix_time_ms()).unwrap_or(0);
    let granted = tauri::async_runtime::spawn_blocking(move || grant_project_consent(&root, &project, &paths, now_ms))
        .await
        .map_err(|error| error.to_string())??;
    Ok(json!({ "granted": granted }))
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TemporaryRoot(PathBuf);

    impl TemporaryRoot {
        fn new(label: &str) -> Self {
            let base = std::env::var_os("EDITKIN_GRANT_TEST_ROOT")
                .map(PathBuf::from)
                .unwrap_or_else(std::env::temp_dir);
            let root = base.join(format!(
                "editkin-outside-grants-{label}-{}-{}",
                std::process::id(),
                TEMPORARY_COUNTER.fetch_add(1, Ordering::Relaxed)
            ));
            let _ = fs::remove_dir_all(&root);
            fs::create_dir_all(&root).unwrap();
            Self(root)
        }
    }

    impl Drop for TemporaryRoot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn text(path: &Path) -> String {
        path.to_str().unwrap().to_string()
    }

    fn canonical_text(path: &Path) -> String {
        local_canonical_text(&fs::canonicalize(path).unwrap()).unwrap()
    }

    fn sha256_hex(bytes: &[u8]) -> String {
        Sha256::digest(bytes).iter().map(|byte| format!("{byte:02x}")).collect()
    }

    #[test]
    fn network_device_and_relative_references_are_rejected_from_text_alone() {
        let rejected: &[&str] = if cfg!(windows) {
            &[
                r"\\attacker\share\clip.mov",
                r"//attacker/share/clip.mov",
                r"\\?\UNC\attacker\share\clip.mov",
                r"\\?\C:\media\clip.mov",
                r"\\.\C:\media\clip.mov",
                r"\\.\pipe\clip.mov",
                r"\??\C:\media\clip.mov",
                r"C:\media\NUL.mov",
                r"C:\media\COM1.mp4",
                r"C:\media\clip.mov:stream",
                r"C:media\clip.mov",
                r"\media\clip.mov",
                r"media\clip.mov",
                r"C:\media\secret.txt",
                r"C:\media\project.json",
                "",
            ]
        } else {
            &["//attacker/share/clip.mov", "media/clip.mov", "/media/secret.txt", ""]
        };
        for path in rejected {
            assert!(plain_local_media_path(path).is_none(), "{path} must be rejected");
        }
        let accepted: &[&str] = if cfg!(windows) {
            &[r"C:\media\clip.MOV", "D:/media/clip.mp4", r"E:\音樂\song.flac"]
        } else {
            &["/media/clip.mov"]
        };
        for path in accepted {
            assert!(plain_local_media_path(path).is_some(), "{path} must be accepted");
        }
    }

    #[test]
    fn import_records_canonical_size_time_and_head_hash_in_a_versioned_store() {
        let root = TemporaryRoot::new("import");
        let media = root.0.join("media");
        fs::create_dir_all(&media).unwrap();
        let clip = media.join("Clip.mov");
        let bytes: Vec<u8> = (0..(HEAD_BYTES as usize + 1000)).map(|n| (n % 251) as u8).collect();
        fs::write(&clip, &bytes).unwrap();
        let app_data = root.0.join("appdata");
        assert_eq!(record(&app_data, &[text(&clip)], GrantSource::Import, 1_700_000_000_000).unwrap(), 1);

        let document: Value = serde_json::from_slice(&fs::read(store_path(&app_data)).unwrap()).unwrap();
        assert_eq!(document["schema"], SCHEMA);
        assert_eq!(document["schemaVersion"], SCHEMA_VERSION);
        let grants = load(&store_path(&app_data)).unwrap();
        assert_eq!(grants.len(), 1);
        let grant = &grants[0];
        assert_eq!(grant.path, canonical_text(&clip));
        assert!(!grant.path.starts_with(r"\\"), "verbatim prefix must be stripped");
        assert_eq!(grant.size, bytes.len() as u64);
        assert_eq!(grant.head_bytes, HEAD_BYTES);
        assert_eq!(grant.head_sha256, sha256_hex(&bytes[..HEAD_BYTES as usize]));
        let modified = fs::metadata(&clip).unwrap().modified().unwrap();
        assert_eq!(grant.mtime_ms as u128, modified.duration_since(UNIX_EPOCH).unwrap().as_millis());
        assert_eq!(grant.source, "import");
        // No temporary file is left beside the store.
        let leftovers = fs::read_dir(store_path(&app_data).parent().unwrap())
            .unwrap()
            .filter(|entry| entry.as_ref().unwrap().file_name() != STORE_FILE)
            .count();
        assert_eq!(leftovers, 0);
    }

    #[test]
    fn reimport_refreshes_a_changed_file_and_dedupes_by_canonical_path() {
        let root = TemporaryRoot::new("refresh");
        let clip = root.0.join("clip.mp4");
        fs::write(&clip, b"first").unwrap();
        let app_data = root.0.join("appdata");
        record(&app_data, &[text(&clip)], GrantSource::Import, 1).unwrap();
        fs::write(&clip, b"second, longer").unwrap();
        let alias = if cfg!(windows) { text(&clip).to_uppercase().replace("CLIP.MP4", "clip.mp4") } else { text(&clip) };
        assert_eq!(record(&app_data, &[alias, text(&clip)], GrantSource::Relink, 2).unwrap(), 2);
        let grants = load(&store_path(&app_data)).unwrap();
        assert_eq!(grants.len(), 1);
        assert_eq!(grants[0].size, 14);
        assert_eq!(grants[0].head_sha256, sha256_hex(b"second, longer"));
        assert_eq!(grants[0].source, "relink");
    }

    fn project_of(uris: Vec<Value>) -> Value {
        json!({ "assets": uris.into_iter().enumerate()
            .map(|(index, uri)| json!({ "id": format!("asset-{index}"), "uri": uri })).collect::<Vec<_>>() })
    }

    fn assert_no_store(app_data: &Path) {
        assert!(!store_path(app_data).exists(), "nothing may be granted");
        assert!(!app_data.join(STORE_DIRECTORY).exists(), "not even the grant folder may be created");
    }

    /// Opening a project (any of the three desktop open commands) records no grant: the only project-level
    /// inspection reads the store and never writes it, and the open commands do not call the grant writer.
    #[test]
    fn opening_a_project_grants_nothing() {
        let root = TemporaryRoot::new("open");
        let outside = root.0.join("elsewhere");
        fs::create_dir_all(&outside).unwrap();
        let clip = outside.join("secret-interview.mov");
        fs::write(&clip, b"bytes").unwrap();
        fs::create_dir_all(root.0.join("project")).unwrap();
        let project_file = root.0.join("project").join("crafted.editkin.json");
        let project = project_of(vec![json!(text(&clip))]);
        let app_data = root.0.join("appdata");

        let listed = ungranted_project_media(&app_data, &project_file, &project).unwrap();
        assert_eq!(listed, vec![UngrantedMedia { reference: text(&clip), name: "secret-interview.mov".into() }]);
        assert_no_store(&app_data);
        // With an existing store, inspection leaves its bytes alone.
        let other = outside.join("imported.mp4");
        fs::write(&other, b"other").unwrap();
        record(&app_data, &[text(&other)], GrantSource::Import, 1).unwrap();
        let before = fs::read(store_path(&app_data)).unwrap();
        assert_eq!(ungranted_project_media(&app_data, &project_file, &project).unwrap().len(), 1);
        assert_eq!(fs::read(store_path(&app_data)).unwrap(), before);
        assert_eq!(load(&store_path(&app_data)).unwrap().len(), 1);

        // The actual desktop open commands: no grant writer in their bodies.
        let main = include_str!("main.rs").replace("\r\n", "\n");
        for signature in [
            "async fn open_project(",
            "async fn open_project_path(",
            "async fn open_template_short_project(",
        ] {
            let start = main.find(signature).unwrap_or_else(|| panic!("{signature} missing"));
            let body = &main[start..start + main[start..].find("\n}\n").expect("function end")];
            assert!(body.contains("\"read_project\""), "{signature} must still read the project");
            assert!(!body.contains("record_outside_media_grants"), "{signature} must not grant");
            assert!(!body.contains("outside_media_grants::"), "{signature} must not touch grants");
        }
        // The consent commands are registered for the GUI.
        for command in ["outside_media_grants::inspect_project_outside_media,", "outside_media_grants::grant_project_outside_media,"] {
            assert!(main.contains(command), "{command} not registered");
        }
    }

    /// Every Rust source file of the desktop host (file name, text with LF line ends).
    fn host_sources() -> Vec<(String, String)> {
        let mut sources = Vec::new();
        let mut pending = vec![Path::new(env!("CARGO_MANIFEST_DIR")).join("src")];
        while let Some(directory) = pending.pop() {
            for entry in fs::read_dir(&directory).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    pending.push(path);
                } else if path.extension().is_some_and(|extension| extension == "rs") {
                    let text = fs::read_to_string(&path).unwrap().replace("\r\n", "\n");
                    sources.push((path.file_name().unwrap().to_string_lossy().to_string(), text));
                }
            }
        }
        sources
    }

    /// The function whose body holds byte `position`: the last `fn` signature line before it.
    fn enclosing_fn(code: &str, position: usize) -> String {
        code[..position]
            .lines()
            .rev()
            .find_map(|line| {
                let mut rest = line.trim_start();
                for prefix in ["pub(crate) ", "pub ", "async "] {
                    rest = rest.strip_prefix(prefix).unwrap_or(rest);
                }
                rest.strip_prefix("fn ")
                    .map(|signature| signature.split(['(', '<']).next().unwrap_or_default().to_string())
            })
            .unwrap_or_default()
    }

    fn function_body<'a>(code: &'a str, signature: &str) -> &'a str {
        let start = code.find(signature).unwrap_or_else(|| panic!("{signature} missing"));
        &code[start..start + code[start..].find("\n}\n").expect("function end")]
    }

    /// The complete list of places that write an outside-media grant: the creator's own picks (single import,
    /// relink, the batch chooser) and 允許. No project open, batch open or MCP path is among them.
    #[test]
    fn every_grant_writer_is_an_explicit_pick_or_consent() {
        let mut writers = Vec::new();
        for (file, text) in host_sources() {
            // This file's test module never runs in the app (and quotes the names below).
            let code = match text.find("#[cfg(test)]\nmod tests") {
                Some(end) if file == "outside_media_grants.rs" => &text[..end],
                _ => text.as_str(),
            };
            let mut found = |needle: &str| {
                for (position, _) in code.match_indices(needle) {
                    // The definition, and quoted names in test assertions, are not calls.
                    if code[..position].ends_with("fn ") || code[..position].ends_with('"') {
                        continue;
                    }
                    let line = &code[position..position + code[position..].find('\n').unwrap_or(code.len() - position)];
                    let source = ["Import", "Relink", "ProjectConsent"]
                        .into_iter()
                        .find(|source| line.contains(&format!("GrantSource::{source}")))
                        .unwrap_or("-");
                    writers.push((file.clone(), enclosing_fn(code, position), source.to_string()));
                }
            };
            found("record_outside_media_grants(");
            found("outside_media_grants::record(");
            if file == "outside_media_grants.rs" {
                found("record(app_data_root");
            }
        }
        writers.sort();
        let expected: Vec<(String, String, String)> = [
            ("desktop_batch_commands_v1.rs", "pick_batch_media", "Import"),
            ("main.rs", "import_media_path_bufs", "Import"),
            ("main.rs", "pick_relink_media", "Relink"),
            ("main.rs", "record_outside_media_grants", "-"),
            ("outside_media_grants.rs", "grant_project_consent", "ProjectConsent"),
        ]
        .into_iter()
        .map(|(file, function, source)| (file.to_string(), function.to_string(), source.to_string()))
        .collect();
        assert_eq!(writers, expected);
    }

    #[test]
    fn batch_chooser_picks_get_the_import_grant_with_every_filter() {
        let batch = include_str!("desktop_batch_commands_v1.rs").replace("\r\n", "\n");
        // The batch chooser's own filter: everything it offers is grantable media.
        let start = batch.find("DialogText::VideoFilter), &[").expect("batch video filter");
        let list = &batch[start..start + batch[start..].find(']').unwrap()];
        let offered: Vec<&str> = list.split('"').skip(1).step_by(2).collect();
        assert_eq!(offered, ["mp4", "mov", "mkv", "webm", "m4v"]);
        assert!(offered.iter().all(|extension| MEDIA_EXTENSIONS.contains(extension)));

        // pick_batch_media grants once, as an import, only after the files decoded and the batch was saved,
        // never for a canceled pick, and after the batch lock is released.
        let body = function_body(&batch, "async fn pick_batch_media(");
        let grant = body
            .find("record_outside_media_grants(&app, source_paths, outside_media_grants::GrantSource::Import).await;")
            .expect("batch picks are granted");
        assert_eq!(body.matches("record_outside_media_grants(").count(), 1);
        for earlier in [
            "return Ok(json!({ \"canceled\": true }));",
            "let sources = checked_batch_sources(&selected)?;",
            // The media probe and its decodable-video check (probe_batch_sources).
            "probe_batch_sources(sources, ",
            "persist_batch_session(&app, &session)?;",
            "*current = Some(session.clone());",
        ] {
            let at = body.rfind(earlier).unwrap_or_else(|| panic!("{earlier} missing"));
            assert!(at < grant, "the grant must come after {earlier}");
        }
        let lock = body.rfind("let mut current = state.batch_session.lock()").unwrap();
        assert!(body[lock..grant].contains("\n    }\n"), "the batch lock is released before the grant");

        // What that grant records from a batch pick: the same filters as a single import.
        let root = TemporaryRoot::new("batch");
        let picks: Vec<PathBuf> = offered.iter().map(|extension| root.0.join(format!("clip.{extension}"))).collect();
        for pick in &picks {
            fs::write(pick, b"video").unwrap();
        }
        let mut selected: Vec<String> = picks.iter().map(|pick| text(pick)).collect();
        if cfg!(windows) {
            selected.extend([r"\\nas\footage\clip.mp4", r"\\?\UNC\nas\footage\clip.mov", r"\\.\C:\clip.mp4", r"C:\clip.mp4:stream"].map(str::to_string));
        } else {
            selected.push("//nas/footage/clip.mp4".to_string());
        }
        selected.push(text(&root.0.join("missing.mp4")));
        let app_data = root.0.join("appdata");
        assert_eq!(record(&app_data, &selected, GrantSource::Import, 9).unwrap(), picks.len());
        let grants = load(&store_path(&app_data)).unwrap();
        let mut granted: Vec<String> = grants.iter().map(|grant| grant.path.clone()).collect();
        granted.sort();
        let mut expected: Vec<String> = picks.iter().map(|pick| canonical_text(pick)).collect();
        expected.sort();
        assert_eq!(granted, expected);
        assert!(grants.iter().all(|grant| grant.source == "import"));
    }

    #[test]
    fn opening_a_batch_project_grants_nothing_and_reaches_the_consent_prompt() {
        let batch = include_str!("desktop_batch_commands_v1.rs").replace("\r\n", "\n");
        let body = function_body(&batch, "async fn open_batch_project(");
        assert!(body.contains("\"batch_auto_edit_status\""), "open_batch_project must still read the checked project");
        assert!(!body.contains("record_outside_media_grants"), "opening a batch project must not grant");
        assert!(!body.contains("outside_media_grants::"), "opening a batch project must not touch grants");

        // A batch project as the batch editor saves it (`<output>/<stem>.editkin.json`): the picked source video
        // plus creative:// music.
        let root = TemporaryRoot::new("batch-open");
        let camera = root.0.join("Camera");
        let output = root.0.join("Batch output");
        fs::create_dir_all(&camera).unwrap();
        fs::create_dir_all(&output).unwrap();
        let source = camera.join("IMG_0420.MOV");
        fs::write(&source, b"video").unwrap();
        let project_file = output.join("IMG_0420.editkin.json");
        let project = project_of(vec![json!(text(&source)), json!("creative://studio.hao.creator-library/music-01")]);
        fs::write(&project_file, serde_json::to_vec(&project).unwrap()).unwrap();
        // The consent commands accept that path (the same validation as open_project_path).
        assert_eq!(crate::desktop_files::validate_project_path(&text(&project_file)).unwrap(), project_file);
        let app_data = root.0.join("appdata");
        // A batch picked before this fix: opening its project asks about the source video, and grants nothing.
        assert_eq!(
            ungranted_project_media(&app_data, &project_file, &project).unwrap(),
            vec![UngrantedMedia { reference: text(&source), name: "IMG_0420.MOV".into() }]
        );
        assert_no_store(&app_data);
        // A batch picked now: the chooser grant already covers the source, so its project opens without a question.
        record(&app_data, &[text(&source)], GrantSource::Import, 1).unwrap();
        assert!(ungranted_project_media(&app_data, &project_file, &project).unwrap().is_empty());
    }

    #[test]
    fn consent_grants_only_host_loaded_references_that_pass_every_filter() {
        let root = TemporaryRoot::new("consent");
        let media = root.0.join("footage");
        fs::create_dir_all(&media).unwrap();
        let video = media.join("phone.mov");
        let picture = media.join("still.png");
        let secret = media.join("notes.txt");
        let manifest = media.join("editkin-openexr-sequence.json");
        for path in [&video, &picture, &secret, &manifest] {
            fs::write(path, b"bytes").unwrap();
        }
        fs::create_dir_all(media.join("folder.mov")).unwrap();
        let mut uris = vec![
            json!(text(&video)),
            json!(text(&picture)),
            json!(text(&secret)),
            json!(text(&manifest)),
            json!(text(&media.join("folder.mov"))),
            json!(text(&media.join("missing.mov"))),
            json!("media/relative.mov"),
            json!("creative://studio.hao.creator-library/clip"),
            json!("editkin-composition://scene-1"),
            json!(format!("file:///{}", text(&video).replace('\\', "/"))),
        ];
        if cfg!(windows) {
            uris.extend([
                json!(r"\\attacker\share\clip.mov"),
                json!(r"\\?\UNC\attacker\share\clip.mov"),
                json!(format!(r"\\?\{}", text(&video))),
                json!(r"\\.\C:\clip.mov"),
                json!("//attacker/share/clip.mov"),
            ]);
        }
        let project = project_of(uris.clone());
        let selected: Vec<String> = uris.iter().map(|uri| uri.as_str().unwrap().to_string()).collect();
        let app_data = root.0.join("appdata");
        assert_eq!(grant_project_consent(&app_data, &project, &selected, 5).unwrap(), 2);
        let grants = load(&store_path(&app_data)).unwrap();
        let mut granted: Vec<String> = grants.iter().map(|grant| grant.path.clone()).collect();
        granted.sort();
        let mut expected = vec![canonical_text(&video), canonical_text(&picture)];
        expected.sort();
        assert_eq!(granted, expected);
        assert!(grants.iter().all(|grant| grant.source == "project_consent"));

        // Only the selected subset: allowing just the picture again refreshes the picture alone.
        assert_eq!(grant_project_consent(&app_data, &project, &[text(&picture)], 6).unwrap(), 1);
        let grants = load(&store_path(&app_data)).unwrap();
        assert_eq!(grants.iter().filter(|grant| grant.granted_at_ms == 6).count(), 1);
    }

    #[test]
    fn a_webview_path_the_project_does_not_name_is_refused() {
        let root = TemporaryRoot::new("webview");
        let media = root.0.join("footage");
        fs::create_dir_all(media.join("sub")).unwrap();
        let referenced = media.join("clip.mov");
        let private = media.join("private.mov");
        fs::write(&referenced, b"referenced").unwrap();
        fs::write(&private, b"private").unwrap();
        let project = project_of(vec![json!(text(&referenced))]);
        let app_data = root.0.join("appdata");
        // A real local media file, a lexical alias of the referenced one, and a list larger than one record.
        let alias = text(&media.join("sub").join("..").join("clip.mov"));
        for selected in [vec![text(&private)], vec![alias], vec![]] {
            assert_eq!(grant_project_consent(&app_data, &project, &selected, 1).unwrap(), 0);
            assert_no_store(&app_data);
        }
        let mut flood: Vec<String> = (0..MAX_PATHS_PER_RECORD).map(|index| format!("{}{index}", text(&private))).collect();
        flood.push(text(&referenced));
        assert_eq!(grant_project_consent(&app_data, &project, &flood, 1).unwrap(), 0, "selection beyond the cap is ignored");
        assert_no_store(&app_data);
        // The same request with the referenced file selected grants that file alone.
        assert_eq!(grant_project_consent(&app_data, &project, &[text(&private), text(&referenced)], 2).unwrap(), 1);
        let grants = load(&store_path(&app_data)).unwrap();
        assert_eq!(grants.len(), 1);
        assert_eq!(grants[0].path, canonical_text(&referenced));
    }

    #[test]
    fn unc_device_and_non_media_references_are_never_granted_even_when_selected() {
        let root = TemporaryRoot::new("filters");
        let secret = root.0.join("passwords.txt");
        let config = root.0.join("settings.json");
        fs::write(&secret, b"secret").unwrap();
        fs::write(&config, b"{}").unwrap();
        let mut references = vec![text(&secret), text(&config), "media/relative.mov".to_string()];
        if cfg!(windows) {
            references.extend([
                r"\\attacker\share\clip.mov",
                r"\\?\UNC\attacker\share\clip.mov",
                r"\\.\pipe\clip.mov",
                r"\??\C:\media\clip.mov",
                "//attacker/share/clip.mov",
                r"C:\media\NUL.mov",
                r"C:\media\clip.mov:stream",
            ].map(str::to_string));
        } else {
            references.push("//attacker/share/clip.mov".to_string());
        }
        let project = project_of(references.iter().map(|reference| json!(reference)).collect());
        let app_data = root.0.join("appdata");
        assert_eq!(grant_project_consent(&app_data, &project, &references, 1).unwrap(), 0);
        assert_no_store(&app_data);
        assert!(ungranted_project_media(&app_data, &root.0.join("p.editkin.json"), &project).unwrap().is_empty());
    }

    #[test]
    fn inspection_lists_outside_folder_media_by_name_until_allowed() {
        let root = TemporaryRoot::new("inspect");
        let project_folder = root.0.join("project");
        let raw = project_folder.join("raw");
        let outside = root.0.join("Camera Roll");
        fs::create_dir_all(&raw).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let beside = raw.join("beside.mov");
        let far = outside.join("IMG_0001.MOV");
        let song = outside.join("song.flac");
        for path in [&beside, &far, &song] {
            fs::write(path, b"bytes").unwrap();
        }
        let escape = text(&project_folder.join("..").join("Camera Roll").join("song.flac"));
        let project_file = project_folder.join("trip.editkin.json");
        let project = project_of(vec![
            json!(text(&beside)),
            json!(text(&far)),
            json!(text(&far)),
            json!(escape),
            json!(text(&outside.join("gone.mov"))),
        ]);
        let app_data = root.0.join("appdata");
        let listed = ungranted_project_media(&app_data, &project_file, &project).unwrap();
        assert_eq!(listed, vec![
            UngrantedMedia { reference: text(&far), name: "IMG_0001.MOV".into() },
            UngrantedMedia { reference: escape.clone(), name: "song.flac".into() },
        ]);
        let selected: Vec<String> = listed.iter().map(|item| item.reference.clone()).collect();
        assert_eq!(grant_project_consent(&app_data, &project, &selected, 1).unwrap(), 2);
        assert!(ungranted_project_media(&app_data, &project_file, &project).unwrap().is_empty());
        // A file changed since 允許 is asked about again.
        fs::write(&far, b"changed, longer").unwrap();
        assert_eq!(ungranted_project_media(&app_data, &project_file, &project).unwrap(),
            vec![UngrantedMedia { reference: text(&far), name: "IMG_0001.MOV".into() }]);
    }

    #[test]
    fn automatic_project_open_grants_of_an_earlier_build_are_not_honoured() {
        let root = TemporaryRoot::new("legacy");
        let clip = root.0.join("clip.mp4");
        fs::write(&clip, b"bytes").unwrap();
        let other = root.0.join("other.mp4");
        fs::write(&other, b"other").unwrap();
        let app_data = root.0.join("appdata");
        record(&app_data, &[text(&clip)], GrantSource::Import, 1).unwrap();
        let store = store_path(&app_data);
        let mut document: Value = serde_json::from_slice(&fs::read(&store).unwrap()).unwrap();
        document["grants"][0]["source"] = json!("project_open");
        fs::write(&store, serde_json::to_vec(&document).unwrap()).unwrap();
        assert!(load(&store).unwrap().is_empty());
        let project = project_of(vec![json!(text(&clip))]);
        assert_eq!(ungranted_project_media(&app_data, &root.0.join("p").join("p.editkin.json"), &project).unwrap().len(), 1);
        // The next write drops it.
        record(&app_data, &[text(&other)], GrantSource::Import, 2).unwrap();
        let written: Value = serde_json::from_slice(&fs::read(&store).unwrap()).unwrap();
        assert_eq!(written["grants"].as_array().unwrap().len(), 1);
        assert_eq!(written["grants"][0]["source"], "import");
    }

    #[test]
    fn project_media_paths_keep_plain_file_references_only() {
        let project = project_of(vec![
            json!(r"C:\media\clip.mov"),
            json!("creative://studio.hao.creator-library/clip"),
            json!("editkin-composition://scene-1"),
            json!("file:///C:/media/clip.mov"),
            json!("FILE:C:/media/clip.mov"),
            json!(7),
        ]);
        assert_eq!(project_media_paths(&project), vec![r"C:\media\clip.mov".to_string()]);
        assert!(project_media_paths(&json!({ "assets": "not a list" })).is_empty());
        let many = project_of((0..MAX_PATHS_PER_RECORD + 5).map(|index| json!(format!("/m/{index}.mov"))).collect());
        assert_eq!(project_media_paths(&many).len(), MAX_PATHS_PER_RECORD);
    }

    #[test]
    fn malformed_store_grants_nothing_and_a_newer_store_is_not_overwritten() {
        let root = TemporaryRoot::new("store");
        let clip = root.0.join("clip.wav");
        fs::write(&clip, b"RIFF").unwrap();
        let app_data = root.0.join("appdata");
        let store = store_path(&app_data);
        fs::create_dir_all(store.parent().unwrap()).unwrap();
        fs::write(&store, b"{ not json").unwrap();
        assert!(load(&store).unwrap().is_empty());
        assert_eq!(record(&app_data, &[text(&clip)], GrantSource::Import, 1).unwrap(), 1);
        assert_eq!(load(&store).unwrap().len(), 1);
        // A forged entry for a non-media or network path is dropped on read.
        let mut document: Value = serde_json::from_slice(&fs::read(&store).unwrap()).unwrap();
        let mut forged = document["grants"][0].clone();
        forged["path"] = json!(if cfg!(windows) { r"\\attacker\share\clip.wav" } else { "//attacker/share/clip.wav" });
        document["grants"].as_array_mut().unwrap().push(forged);
        fs::write(&store, serde_json::to_vec(&document).unwrap()).unwrap();
        assert_eq!(load(&store).unwrap().len(), 1);
        let newer = json!({ "schema": SCHEMA, "schemaVersion": 2, "grants": [] });
        fs::write(&store, serde_json::to_vec(&newer).unwrap()).unwrap();
        assert!(record(&app_data, &[text(&clip)], GrantSource::Import, 2).is_err());
        assert_eq!(serde_json::from_slice::<Value>(&fs::read(&store).unwrap()).unwrap(), newer);
    }

    #[cfg(windows)]
    #[test]
    fn junction_reference_is_granted_as_its_canonical_target() {
        let root = TemporaryRoot::new("junction");
        let real = root.0.join("real");
        fs::create_dir_all(&real).unwrap();
        let clip = real.join("clip.mov");
        fs::write(&clip, b"bytes").unwrap();
        let link = root.0.join("link");
        let created = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&link)
            .arg(&real)
            .output()
            .unwrap();
        assert!(created.status.success(), "{}", String::from_utf8_lossy(&created.stderr));
        let app_data = root.0.join("appdata");
        record(&app_data, &[text(&link.join("clip.mov"))], GrantSource::Import, 1).unwrap();
        let grants = load(&store_path(&app_data)).unwrap();
        assert_eq!(grants.len(), 1);
        assert_eq!(grants[0].path, canonical_text(&clip));
        assert!(!grants[0].path.to_lowercase().contains(r"\link\"));
    }

    /// Cross-language check, run on request: writes a real grant the TypeScript reader must accept.
    /// `EDITKIN_GRANT_INTEROP_DIR=<dir> cargo test --offline --locked outside_media_grants`
    #[test]
    fn interop_fixture_when_requested() {
        let Some(directory) = std::env::var_os("EDITKIN_GRANT_INTEROP_DIR").map(PathBuf::from) else {
            return;
        };
        let media = directory.join("outside-media");
        fs::create_dir_all(&media).unwrap();
        let clip = media.join("interop-clip.mov");
        let bytes: Vec<u8> = (0..(HEAD_BYTES as usize * 2)).map(|n| (n % 241) as u8).collect();
        fs::write(&clip, bytes).unwrap();
        let app_data = directory.join("appdata");
        let _ = fs::remove_file(store_path(&app_data));
        assert_eq!(record(&app_data, &[text(&clip)], GrantSource::Import, 1_761_200_000_000).unwrap(), 1);
    }
}
