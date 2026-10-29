//! Small, bounded file helpers for the desktop shell: noticing that another program (an AI agent) changed the
//! open project file, opening a known project path, finding missing media and checking a relink candidate, keeping
//! a crash-recovery copy aside instead of deleting it, and the version shown in Settings.
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

/// Project files above this size are not parsed just to read their revision.
const MAX_PROJECT_PEEK_BYTES: u64 = 64 * 1024 * 1024;
const MAX_MEDIA_CHECKS: usize = 4096;

/// A plain local absolute path (`crate::local_path_text_problem` has nothing against it), decided from its text.
pub(crate) fn local_absolute(path: &str) -> bool {
    !path.is_empty() && !path.contains('\0') && crate::local_path_text_problem(path).is_none()
}

/// A project path from the webview, decided from its text before anything opens it (`crate::local_path_text_problem`):
/// absolute, and not a network share, device or stream path. `validate_project_path` runs it first; a regular save
/// runs it before writing.
pub fn local_project_path(path: &str) -> Result<(), String> {
    use crate::LocalPathProblem::NetworkOrDevice;
    match crate::local_path_text_problem(path) {
        None if !path.contains('\0') => Ok(()),
        // An absolute network or device path; anything not absolute (even a device form) keeps the first message.
        Some(NetworkOrDevice) if !path.contains('\0') && Path::new(path).is_absolute() => {
            Err("拒絕網路共用或裝置路徑：請先把專案檔複製到這台電腦".into())
        }
        _ => Err("專案檔位置不合法".into()),
    }
}

/// A project path the UI already knows (recent list, the open project, a crash-recovery link): a local, existing
/// `.json` file. Opening still goes through the service's full project parser.
pub fn validate_project_path(path: &str) -> Result<PathBuf, String> {
    local_project_path(path)?;
    if !path.to_ascii_lowercase().ends_with(".json") {
        return Err("這不是 Editkin 的專案檔".into());
    }
    let metadata = fs::metadata(path).map_err(|_| "找不到這個專案檔，可能被移動、改名或刪除了".to_string())?;
    if !metadata.is_file() {
        return Err("這不是 Editkin 的專案檔".into());
    }
    Ok(PathBuf::from(path))
}

fn modified_ms(metadata: &fs::Metadata) -> u64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| u64::try_from(duration.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

/// Size and modification time of the open project file. When the time differs from `known_modified_ms`, the
/// file's own `revision`, `updatedAt` and `id` are read too, so the UI can tell a change by another program from
/// its own save.
pub fn inspect_project_file(path: &str, known_modified_ms: Option<u64>) -> Value {
    if !local_absolute(path) {
        return json!({ "exists": false });
    }
    let Ok(metadata) = fs::metadata(path) else {
        return json!({ "exists": false });
    };
    if !metadata.is_file() {
        return json!({ "exists": false });
    }
    let modified = modified_ms(&metadata);
    let mut result = json!({ "exists": true, "modifiedMs": modified, "bytes": metadata.len() });
    if known_modified_ms == Some(modified) {
        result["unchanged"] = json!(true);
        return result;
    }
    if metadata.len() > MAX_PROJECT_PEEK_BYTES {
        result["readable"] = json!(false);
        return result;
    }
    match fs::read(path).ok().and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok()) {
        Some(project) => {
            result["readable"] = json!(true);
            result["revision"] = project.get("revision").filter(|value| value.is_u64()).cloned().unwrap_or(Value::Null);
            result["updatedAt"] = project.get("updatedAt").filter(|value| value.is_string()).cloned().unwrap_or(Value::Null);
            result["projectId"] = project.get("id").filter(|value| value.is_string()).cloned().unwrap_or(Value::Null);
        }
        // Mid-write by a program that does not write atomically, or not a project: check again later.
        None => result["readable"] = json!(false),
    }
    result
}

/// For each path: false when it is a local absolute path that no longer exists as a file. Paths that are not
/// local files (creative library links, network shares that are never touched) report true: not "missing".
pub fn check_media_paths(paths: &[String]) -> Result<Vec<bool>, String> {
    if paths.len() > MAX_MEDIA_CHECKS {
        return Err("一次要檢查的素材太多".into());
    }
    Ok(paths
        .iter()
        .map(|path| !local_absolute(path) || fs::metadata(path).map(|metadata| metadata.is_file()).unwrap_or(false))
        .collect())
}

/// Lower-case SHA-256 and size of a regular file, streamed.
pub fn sha256_file(path: &Path) -> Result<(String, u64), String> {
    let mut file = fs::File::open(path).map_err(|error| format!("無法讀取這個檔案：{error}"))?;
    let mut digest = Sha256::new();
    let mut buffer = vec![0_u8; 1024 * 1024];
    let mut bytes = 0_u64;
    loop {
        let read = file.read(&mut buffer).map_err(|error| format!("讀取檔案時中斷：{error}"))?;
        if read == 0 {
            break;
        }
        bytes += read as u64;
        digest.update(&buffer[..read]);
    }
    Ok((format!("{:x}", digest.finalize()), bytes))
}

/// Moves the crash-recovery snapshot (and its previous copy) into `recovery/kept/` instead of deleting it. Returns
/// the kept primary file, or None when there was nothing to keep.
pub fn keep_recovery_aside(recovery: &Path, now_ms: u128) -> Result<Option<PathBuf>, String> {
    let previous = PathBuf::from(format!("{}.previous", recovery.to_string_lossy()));
    let primary_exists = recovery.is_file();
    let previous_exists = previous.is_file();
    if !primary_exists && !previous_exists {
        return Ok(None);
    }
    let kept = recovery.parent().ok_or("復原資料夾不合法")?.join("kept");
    fs::create_dir_all(&kept).map_err(|error| format!("無法保留找回的版本：{error}"))?;
    let mut stem = format!("session-{now_ms}");
    let mut suffix = 1;
    while kept.join(format!("{stem}.json")).exists() || kept.join(format!("{stem}.previous.json")).exists() {
        suffix += 1;
        stem = format!("session-{now_ms}-{suffix}");
    }
    let primary_target = kept.join(format!("{stem}.json"));
    let previous_target = kept.join(format!("{stem}.previous.json"));
    if primary_exists {
        fs::rename(recovery, &primary_target).map_err(|error| format!("無法保留找回的版本：{error}"))?;
    }
    if previous_exists {
        fs::rename(&previous, &previous_target).map_err(|error| format!("無法保留找回的版本：{error}"))?;
    }
    Ok(Some(if primary_exists { primary_target } else { previous_target }))
}

fn lower_hex_64(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// The version and build identity shown in Settings. The build ID is the release input identity the build
/// embedded (its first 12 hex digits); a build without one (community) uses the digest of its embedded identity.
pub fn build_info(embedded_identity: &str, package_version: &str) -> Value {
    let identity: Value = serde_json::from_str(embedded_identity).unwrap_or(Value::Null);
    let input = identity
        .pointer("/inputIdentity/sha256")
        .and_then(Value::as_str)
        .filter(|value| lower_hex_64(value))
        .map(str::to_string);
    let official = input.is_some() && identity.pointer("/scope/officialRelease").and_then(Value::as_bool) != Some(false);
    let full = input.unwrap_or_else(|| format!("{:x}", Sha256::digest(embedded_identity.as_bytes())));
    json!({
        "version": package_version,
        "productVersion": identity.get("productVersion").and_then(Value::as_str).unwrap_or(package_version),
        "buildId": &full[..12],
        "buildIdFull": full,
        "edition": if official { "official" } else { "community" },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("editkin-desktop-files-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn project_inspection_reads_revision_only_after_a_change() {
        let root = temp_root("inspect");
        let path = root.join("trip.editkin.json");
        fs::write(&path, br#"{"id":"p1","revision":4,"updatedAt":"2026-10-10T01:00:00.000Z"}"#).unwrap();
        let text = path.to_string_lossy().to_string();
        let first = inspect_project_file(&text, None);
        assert_eq!(first["exists"], json!(true));
        assert_eq!(first["revision"], json!(4));
        assert_eq!(first["projectId"], json!("p1"));
        let known = first["modifiedMs"].as_u64();
        let again = inspect_project_file(&text, known);
        assert_eq!(again["unchanged"], json!(true));
        assert!(again.get("revision").is_none());
        fs::write(&path, b"{ half written").unwrap();
        assert_eq!(inspect_project_file(&text, Some(0))["readable"], json!(false));
        assert_eq!(inspect_project_file(&root.join("gone.json").to_string_lossy(), None)["exists"], json!(false));
        assert_eq!(inspect_project_file("relative.json", None)["exists"], json!(false));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn project_paths_must_be_local_existing_json_files() {
        let root = temp_root("validate");
        let path = root.join("a.editkin.json");
        fs::write(&path, b"{}").unwrap();
        assert!(validate_project_path(&path.to_string_lossy()).is_ok());
        assert!(validate_project_path(&root.join("missing.json").to_string_lossy()).unwrap_err().contains("找不到"));
        let movie = root.join("a.mp4");
        fs::write(&movie, b"x").unwrap();
        assert!(validate_project_path(&movie.to_string_lossy()).is_err());
        assert!(validate_project_path("relative.json").is_err());
        if cfg!(windows) {
            assert!(validate_project_path(r"\\server\share\a.json").unwrap_err().contains("網路"));
        }
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn media_checks_flag_only_missing_local_files() {
        let root = temp_root("media");
        let present = root.join("clip.mp4");
        fs::write(&present, b"x").unwrap();
        let missing = root.join("moved.mp4");
        let checks = check_media_paths(&[
            present.to_string_lossy().to_string(),
            missing.to_string_lossy().to_string(),
            "creative://studio.hao.creator-library/a".into(),
        ])
        .unwrap();
        assert_eq!(checks, vec![true, false, true]);
        assert!(check_media_paths(&vec![String::new(); MAX_MEDIA_CHECKS + 1]).is_err());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn recovery_is_kept_aside_never_deleted() {
        let root = temp_root("recovery");
        let recovery = root.join("session.json");
        fs::write(&recovery, b"primary").unwrap();
        fs::write(root.join("session.json.previous"), b"previous").unwrap();
        let kept = keep_recovery_aside(&recovery, 42).unwrap().unwrap();
        assert_eq!(fs::read(&kept).unwrap(), b"primary");
        assert_eq!(fs::read(root.join("kept").join("session-42.previous.json")).unwrap(), b"previous");
        assert!(!recovery.exists());
        assert!(keep_recovery_aside(&recovery, 43).unwrap().is_none());
        fs::write(&recovery, b"second").unwrap();
        let second = keep_recovery_aside(&recovery, 42).unwrap().unwrap();
        assert_ne!(second, kept, "an earlier kept copy is never replaced");
        assert_eq!(fs::read(&kept).unwrap(), b"primary");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn hashing_matches_a_known_digest() {
        let root = temp_root("hash");
        let file = root.join("abc.bin");
        fs::write(&file, b"abc").unwrap();
        let (sha, bytes) = sha256_file(&file).unwrap();
        assert_eq!(sha, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        assert_eq!(bytes, 3);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn build_info_reads_the_embedded_release_identity() {
        let official = r#"{"schemaVersion":2,"product":"Editkin","productVersion":"0.15.0","inputIdentity":{"sha256":"0018856a6db95f40e285cd1377adcc9279a402c4d6f5a4790544e0aac31a3bdb"},"scope":{"id":"editkin.formal-product-build-scope/v1"}}"#;
        let info = build_info(official, "0.15.0");
        assert_eq!(info["version"], json!("0.15.0"));
        assert_eq!(info["buildId"], json!("0018856a6db9"));
        assert_eq!(info["edition"], json!("official"));
        let community = r#"{"schemaVersion":1,"productVersion":"0.15.0","scope":{"id":"editkin.community-desktop-build/v1","officialRelease":false},"files":{}}"#;
        let info = build_info(community, "0.15.0");
        assert_eq!(info["edition"], json!("community"));
        assert_eq!(info["buildId"].as_str().unwrap().len(), 12);
        assert_eq!(build_info(community, "0.15.0")["buildId"], info["buildId"], "the same build always shows the same ID");
    }
}
