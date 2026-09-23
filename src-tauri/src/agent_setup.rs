use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};

const PRODUCT_AGENT_SCHEMA_VERSION: u64 = 3;
const PRODUCT_AGENT_MANIFEST_KIND: &str = "editkin-product-mcp-generation";
const PRODUCT_AGENT_POINTER_KIND: &str = "editkin-product-mcp-pointer";
const PRODUCT_AGENT_STATE_DIRECTORY: &str = "agent-runtime-v3";
const PRODUCT_AGENT_POINTER_NAME: &str = "ACTIVE-GENERATION.json";
const PRODUCT_AGENT_ROLLBACK_NAME: &str = "ROLLBACK-GENERATION.json";
const PRODUCT_AGENT_MANIFEST_NAME: &str = "GENERATION-MANIFEST.json";
const PRODUCT_AGENT_MAX_POINTER_BYTES: u64 = 8 * 1024;
const PRODUCT_AGENT_MAX_MANIFEST_BYTES: u64 = 128 * 1024;
const PRODUCT_AGENT_FILE_ROLES: [&str; 11] = [
    "embeddedContract",
    "entrypoint",
    "entrypointIdentity",
    "ffmpeg",
    "ffprobe",
    "gpuCompositor",
    "launcher",
    "nativeCore",
    "node",
    "nodeManifest",
    "whisper",
];
const PRODUCT_AGENT_DIRECTORY_ROLES: [&str; 7] = [
    "color",
    "creativePack",
    "fonts",
    "personalMusic",
    "personalVisual",
    "plugins",
    "resourceRoot",
];

/// Constructed only from the directory explicitly selected for this setup.
/// No remembered value, process cwd, Videos default or inferred parent is used.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentWorkspace {
    directory: PathBuf,
}

impl AgentWorkspace {
    pub fn path(&self) -> &Path {
        &self.directory
    }
}

fn path_text(path: &Path) -> Result<&str, String> {
    let text = path
        .to_str()
        .ok_or("工作目錄或 runtime 路徑無法表示為 UTF-8；未變更 AI 設定")?;
    if text.trim().is_empty() || text.chars().any(char::is_control) {
        return Err("工作目錄或 runtime 路徑為空白或含控制字元；未變更 AI 設定".into());
    }
    Ok(text)
}

/// Rust's Windows canonicalize uses verbatim paths. Node's path.relative must
/// see the same normal drive/UNC namespace as the media paths, not \\?\D: vs D:.
fn interoperable_canonical_path(path: &Path) -> Result<PathBuf, String> {
    let text = path_text(path)?;
    #[cfg(windows)]
    {
        if let Some(unc) = text.strip_prefix(r"\\?\UNC\") {
            return Ok(PathBuf::from(format!(r"\\{unc}")));
        }
        if let Some(drive) = text.strip_prefix(r"\\?\") {
            if drive.as_bytes().get(1) != Some(&b':') || drive.as_bytes().get(2) != Some(&b'\\') {
                return Err("不支援此工作目錄的 Windows 裝置路徑；未變更 AI 設定".into());
            }
            return Ok(PathBuf::from(drive));
        }
    }
    Ok(PathBuf::from(text))
}

pub fn selected_agent_workspace(selected: Option<&Path>) -> Result<Option<AgentWorkspace>, String> {
    let Some(selected) = selected else {
        return Ok(None);
    };
    path_text(selected)?;
    if !selected.is_absolute() {
        return Err("請選擇已存在的完整工作資料夾路徑；未變更 AI 設定".into());
    }
    let canonical = fs::canonicalize(selected).map_err(|_| {
        "無法確認所選工作資料夾，可能已移動、刪除或無存取權；未變更 AI 設定".to_string()
    })?;
    if !canonical.is_dir() {
        return Err("所選位置不是工作資料夾；未變更 AI 設定".into());
    }
    let directory = interoperable_canonical_path(&canonical)?;
    if !directory.is_absolute() {
        return Err("無法確認工作資料夾的完整路徑；未變更 AI 設定".into());
    }
    Ok(Some(AgentWorkspace { directory }))
}

#[derive(Debug)]
pub struct AgentSetupInvocation {
    pub command: String,
    pub args: Vec<String>,
    pub environment: Vec<(String, String)>,
}

#[derive(Debug, Clone)]
pub struct ProductAgentGenerationPaths {
    pub resource_root: PathBuf,
    pub embedded_contract: PathBuf,
    pub entrypoint: PathBuf,
    pub entrypoint_identity: PathBuf,
    pub ffmpeg: PathBuf,
    pub ffprobe: PathBuf,
    pub gpu_compositor: PathBuf,
    pub launcher: PathBuf,
    pub native_core: PathBuf,
    pub node: PathBuf,
    pub node_manifest: PathBuf,
    pub whisper: PathBuf,
    pub color: PathBuf,
    pub creative_pack: PathBuf,
    pub fonts: PathBuf,
    pub personal_music: PathBuf,
    pub personal_visual: PathBuf,
    pub plugins: PathBuf,
}

#[derive(Debug, Clone)]
pub struct ProductAgentGenerationActivation {
    pub state_root: PathBuf,
    pub pointer_identity: String,
    previous_pointer: Option<Vec<u8>>,
}

fn ps_quote(text: &str) -> String {
    format!("'{}'", text.replace('\'', "''"))
}

/// Pure formatting: this never reads host config/environment or runs a CLI.
pub fn build_agent_setup_invocation(
    target: &str,
    executable: &Path,
    launcher: &Path,
    workspace: &AgentWorkspace,
    mut environment: Vec<(String, String)>,
    expected_environment_keys: &BTreeSet<String>,
) -> Result<AgentSetupInvocation, String> {
    if target != "codex" && target != "claude" {
        return Err("不支援的 Agent 目標".into());
    }
    let executable = path_text(executable)?;
    let launcher = path_text(launcher)?;
    if launcher
        .rsplit(['\\', '/'])
        .next()
        .is_some_and(|name| name.eq_ignore_ascii_case("mcp.mjs"))
    {
        return Err("Agent 設定不得直接指向 mcp.mjs；未變更 AI 設定".into());
    }
    let mut keys = BTreeSet::new();
    for (key, value) in &environment {
        if key.is_empty()
            || !key
                .bytes()
                .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
            || key == "EDITKIN_WORKSPACE"
            || !keys.insert(key.as_str())
            || value.chars().any(char::is_control)
        {
            return Err("Agent 環境設定不合法或重複；未變更 AI 設定".into());
        }
    }
    environment.push((
        "EDITKIN_WORKSPACE".into(),
        path_text(workspace.path())?.into(),
    ));
    let actual_environment_keys = environment
        .iter()
        .map(|(key, _)| key.clone())
        .collect::<BTreeSet<_>>();
    if &actual_environment_keys != expected_environment_keys {
        return Err("Agent 環境設定不符合 closed-world contract；未變更 AI 設定".into());
    }
    let (command, args) = if target == "codex" {
        let flags = environment
            .iter()
            .map(|(key, value)| format!("--env {}", ps_quote(&format!("{key}={value}"))))
            .collect::<Vec<_>>()
            .join(" ");
        let command = format!(
            "codex mcp add editkin {flags} -- {} {}",
            ps_quote(executable),
            ps_quote(launcher)
        );
        let mut args = ["mcp", "add", "editkin"].map(str::to_string).to_vec();
        for (key, value) in &environment {
            args.extend(["--env".into(), format!("{key}={value}")]);
        }
        args.extend(["--".into(), executable.into(), launcher.into()]);
        (command, args)
    } else {
        let env_json = environment
            .iter()
            .map(|(key, value)| (key.clone(), Value::String(value.clone())))
            .collect::<serde_json::Map<_, _>>();
        let config =
            json!({ "type": "stdio", "command": executable, "args": [launcher], "env": env_json })
                .to_string();
        let command = format!(
            "claude mcp add-json --scope user editkin {}",
            ps_quote(&config)
        );
        let mut args = ["mcp", "add-json", "--scope", "user", "editkin"]
            .map(str::to_string)
            .to_vec();
        args.push(config);
        (command, args)
    };
    Ok(AgentSetupInvocation {
        command,
        args,
        environment,
    })
}

fn sha256_bytes(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn sha256_file(path: &Path) -> Result<(u64, String), String> {
    let mut file =
        fs::File::open(path).map_err(|error| format!("無法讀取 Agent generation 檔案：{error}"))?;
    let size = file.metadata().map_err(|error| error.to_string())?.len();
    if size == 0 {
        return Err("Agent generation 不接受空檔案".into());
    }
    let mut hash = Sha256::new();
    let mut buffer = vec![0_u8; 1024 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        hash.update(&buffer[..read]);
    }
    Ok((
        size,
        hash.finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect(),
    ))
}

fn canonical_json_bytes(value: &Value) -> Result<Vec<u8>, String> {
    let mut bytes = serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?;
    bytes.push(b'\n');
    Ok(bytes)
}

fn normalized_compare_text(path: &Path) -> Result<String, String> {
    let text = path_text(path)?.to_string();
    Ok(if cfg!(windows) {
        text.to_ascii_lowercase()
    } else {
        text
    })
}

fn path_inside(root: &Path, path: &Path) -> Result<bool, String> {
    let root = normalized_compare_text(root)?;
    let path = normalized_compare_text(path)?;
    let separator = std::path::MAIN_SEPARATOR;
    Ok(path == root || path.starts_with(&format!("{root}{separator}")))
}

fn canonical_resource_path(
    path: &Path,
    resource_root: Option<&Path>,
    directory: bool,
    label: &str,
) -> Result<PathBuf, String> {
    let lexical = interoperable_canonical_path(path)?;
    if !lexical.is_absolute() {
        return Err(format!("{label} 不是完整路徑"));
    }
    let link =
        fs::symlink_metadata(&lexical).map_err(|error| format!("{label} 不存在：{error}"))?;
    if link.file_type().is_symlink()
        || (directory && !link.is_dir())
        || (!directory && !link.is_file())
    {
        return Err(format!(
            "{label} 不是一般{}",
            if directory { "資料夾" } else { "檔案" }
        ));
    }
    let canonical_raw =
        fs::canonicalize(&lexical).map_err(|error| format!("無法確認 {label}：{error}"))?;
    let canonical = interoperable_canonical_path(&canonical_raw)?;
    if let Some(root) = resource_root {
        if !path_inside(root, &canonical)? {
            return Err(format!("{label} 超出 generation resource root"));
        }
    }
    Ok(canonical)
}

fn generation_id(files: &[Value], directories: &[Value]) -> Result<String, String> {
    let mut hash = Sha256::new();
    hash.update(format!(
        "{PRODUCT_AGENT_MANIFEST_KIND}/v{PRODUCT_AGENT_SCHEMA_VERSION}\n"
    ));
    for directory in directories {
        let role = directory
            .get("role")
            .and_then(Value::as_str)
            .ok_or("Agent directory role missing")?;
        let path = directory
            .get("path")
            .and_then(Value::as_str)
            .ok_or("Agent directory path missing")?;
        hash.update(format!("D\0{role}\0{path}\n"));
    }
    for file in files {
        let role = file
            .get("role")
            .and_then(Value::as_str)
            .ok_or("Agent file role missing")?;
        let path = file
            .get("path")
            .and_then(Value::as_str)
            .ok_or("Agent file path missing")?;
        let bytes = file
            .get("bytes")
            .and_then(Value::as_u64)
            .ok_or("Agent file size missing")?;
        let sha256 = file
            .get("sha256")
            .and_then(Value::as_str)
            .ok_or("Agent file identity missing")?;
        hash.update(format!("F\0{role}\0{path}\0{bytes}\0{sha256}\n"));
    }
    Ok(hash
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

fn random_hex_128() -> Result<String, String> {
    let mut bytes = [0_u8; 16];
    getrandom::fill(&mut bytes).map_err(|error| error.to_string())?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn ensure_generation_state_root(state_root: &Path) -> Result<PathBuf, String> {
    if state_root.file_name().and_then(|value| value.to_str())
        != Some(PRODUCT_AGENT_STATE_DIRECTORY)
    {
        return Err("Agent generation state 必須使用固定的 agent-runtime-v3 目錄".into());
    }
    let parent = state_root
        .parent()
        .ok_or("Agent generation state 缺少父目錄")?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let parent = canonical_resource_path(parent, None, true, "Agent user-data parent")?;
    let state_root = parent.join(PRODUCT_AGENT_STATE_DIRECTORY);
    if !state_root.exists() {
        fs::create_dir(&state_root).map_err(|error| error.to_string())?;
    }
    let state_root =
        canonical_resource_path(&state_root, Some(&parent), true, "Agent generation state")?;
    let generations = state_root.join("generations");
    if !generations.exists() {
        fs::create_dir(&generations).map_err(|error| error.to_string())?;
    }
    canonical_resource_path(
        &generations,
        Some(&state_root),
        true,
        "Agent generations directory",
    )?;
    Ok(state_root)
}

fn read_bounded_file(path: &Path, maximum: u64, label: &str) -> Result<Option<Vec<u8>>, String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink()
                || !metadata.is_file()
                || metadata.len() == 0
                || metadata.len() > maximum
            {
                return Err(format!("{label} 不是 bounded regular file"));
            }
            fs::read(path).map(Some).map_err(|error| error.to_string())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

fn validate_pointer_bytes(bytes: &[u8]) -> Result<Value, String> {
    let value: Value = serde_json::from_slice(bytes).map_err(|error| error.to_string())?;
    let object = value.as_object().ok_or("Agent pointer 不是 JSON object")?;
    let keys = object.keys().map(String::as_str).collect::<BTreeSet<_>>();
    let expected = [
        "generationDirectoryName",
        "generationId",
        "kind",
        "manifestSha256",
        "schemaVersion",
        "selectionRevision",
    ]
    .into_iter()
    .collect::<BTreeSet<_>>();
    if keys != expected
        || object.get("schemaVersion").and_then(Value::as_u64) != Some(PRODUCT_AGENT_SCHEMA_VERSION)
        || object.get("kind").and_then(Value::as_str) != Some(PRODUCT_AGENT_POINTER_KIND)
    {
        return Err("Agent pointer closed-world contract 不合法".into());
    }
    for key in ["generationId", "manifestSha256"] {
        let value = object.get(key).and_then(Value::as_str).unwrap_or("");
        if value.len() != 64
            || !value
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        {
            return Err("Agent pointer SHA-256 不合法".into());
        }
    }
    let selection = object
        .get("selectionRevision")
        .and_then(Value::as_str)
        .unwrap_or("");
    if selection.len() != 32
        || !selection
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err("Agent pointer selection revision 不合法".into());
    }
    let generation = object.get("generationId").and_then(Value::as_str).unwrap();
    let directory = object
        .get("generationDirectoryName")
        .and_then(Value::as_str)
        .unwrap_or("");
    let Some((prefix, nonce)) = directory.split_once("--") else {
        return Err("Agent pointer generation 目錄不合法".into());
    };
    if prefix != generation
        || nonce.len() != 32
        || !nonce
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err("Agent pointer generation 目錄不合法".into());
    }
    if canonical_json_bytes(&value)? != bytes {
        return Err("Agent pointer 不是 canonical JSON".into());
    }
    Ok(value)
}

#[cfg(windows)]
fn atomic_replace(source: &Path, target: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };
    let source = source
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let target = target
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let result = unsafe {
        MoveFileExW(
            source.as_ptr(),
            target.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        Err(std::io::Error::last_os_error().to_string())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn atomic_replace(source: &Path, target: &Path) -> Result<(), String> {
    fs::rename(source, target).map_err(|error| error.to_string())
}

fn write_atomic_bytes(directory: &Path, name: &str, bytes: &[u8]) -> Result<(), String> {
    let target = directory.join(name);
    let temporary = directory.join(format!(
        ".{name}.{}.{}.tmp",
        std::process::id(),
        random_hex_128()?
    ));
    let result = (|| {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| error.to_string())?;
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|error| error.to_string())?;
        drop(file);
        atomic_replace(&temporary, &target)
    })();
    let _ = fs::remove_file(&temporary);
    result
}

fn file_record(role: &str, path: &Path, resource_root: &Path) -> Result<Value, String> {
    let path = canonical_resource_path(path, Some(resource_root), false, &format!("Agent {role}"))?;
    let (bytes, sha256) = sha256_file(&path)?;
    Ok(json!({ "bytes": bytes, "path": path_text(&path)?, "role": role, "sha256": sha256 }))
}

fn directory_record(
    role: &str,
    path: &Path,
    resource_root: Option<&Path>,
) -> Result<Value, String> {
    let path = canonical_resource_path(path, resource_root, true, &format!("Agent {role}"))?;
    Ok(json!({ "path": path_text(&path)?, "role": role }))
}

pub fn activate_product_agent_generation(
    state_root: &Path,
    paths: &ProductAgentGenerationPaths,
    embedded_contract_bytes: &[u8],
) -> Result<ProductAgentGenerationActivation, String> {
    let resource_root =
        canonical_resource_path(&paths.resource_root, None, true, "Agent resource root")?;
    let embedded_contract =
        fs::read(&paths.embedded_contract).map_err(|error| error.to_string())?;
    if embedded_contract != embedded_contract_bytes {
        return Err("打包的 Agent setup contract 與 native embedded contract 不一致".into());
    }
    let file_paths = [
        &paths.embedded_contract,
        &paths.entrypoint,
        &paths.entrypoint_identity,
        &paths.ffmpeg,
        &paths.ffprobe,
        &paths.gpu_compositor,
        &paths.launcher,
        &paths.native_core,
        &paths.node,
        &paths.node_manifest,
        &paths.whisper,
    ];
    let mut files = Vec::with_capacity(PRODUCT_AGENT_FILE_ROLES.len());
    for (role, path) in PRODUCT_AGENT_FILE_ROLES.iter().zip(file_paths) {
        files.push(file_record(role, path, &resource_root)?);
    }
    let directory_paths = [
        &paths.color,
        &paths.creative_pack,
        &paths.fonts,
        &paths.personal_music,
        &paths.personal_visual,
        &paths.plugins,
        &resource_root,
    ];
    let mut directories = Vec::with_capacity(PRODUCT_AGENT_DIRECTORY_ROLES.len());
    for (role, path) in PRODUCT_AGENT_DIRECTORY_ROLES.iter().zip(directory_paths) {
        directories.push(directory_record(
            role,
            path,
            (!matches!(*role, "personalVisual" | "resourceRoot"))
                .then_some(resource_root.as_path()),
        )?);
    }
    let generation_id = generation_id(&files, &directories)?;
    let manifest = json!({
        "directories": directories,
        "files": files,
        "generationId": generation_id,
        "kind": PRODUCT_AGENT_MANIFEST_KIND,
        "schemaVersion": PRODUCT_AGENT_SCHEMA_VERSION,
    });
    let manifest_bytes = canonical_json_bytes(&manifest)?;
    if manifest_bytes.len() as u64 > PRODUCT_AGENT_MAX_MANIFEST_BYTES {
        return Err("Agent generation manifest 超過上限".into());
    }
    let manifest_sha256 = sha256_bytes(&manifest_bytes);
    let state_root = ensure_generation_state_root(state_root)?;
    let personal_visual =
        canonical_resource_path(&paths.personal_visual, None, true, "Agent personalVisual")?;
    if !path_inside(
        state_root
            .parent()
            .ok_or("Agent generation state 缺少 user-data parent")?,
        &personal_visual,
    )? {
        return Err("Agent personalVisual 必須位於同一個 user-data root".into());
    }
    let generations = state_root.join("generations");
    let mut generation_directory_name = None;
    for entry in fs::read_dir(&generations).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let name = entry.file_name().to_string_lossy().to_string();
        let valid_name = name.split_once("--").is_some_and(|(candidate, nonce)| {
            candidate == generation_id
                && nonce.len() == 32
                && nonce
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        });
        if !valid_name
            || !entry
                .file_type()
                .map_err(|error| error.to_string())?
                .is_dir()
        {
            continue;
        }
        let existing = entry.path().join(PRODUCT_AGENT_MANIFEST_NAME);
        if read_bounded_file(
            &existing,
            PRODUCT_AGENT_MAX_MANIFEST_BYTES,
            "Agent generation manifest",
        )?
        .is_some_and(|bytes| bytes == manifest_bytes)
        {
            generation_directory_name = Some(name);
            break;
        }
    }
    let generation_directory_name = match generation_directory_name {
        Some(name) => name,
        None => {
            let name = format!("{generation_id}--{}", random_hex_128()?);
            let root = generations.join(&name);
            fs::create_dir(&root).map_err(|error| error.to_string())?;
            let path = root.join(PRODUCT_AGENT_MANIFEST_NAME);
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)
                .map_err(|error| error.to_string())?;
            file.write_all(&manifest_bytes)
                .and_then(|_| file.sync_all())
                .map_err(|error| error.to_string())?;
            name
        }
    };
    let pointer_path = state_root.join(PRODUCT_AGENT_POINTER_NAME);
    let previous_pointer = read_bounded_file(
        &pointer_path,
        PRODUCT_AGENT_MAX_POINTER_BYTES,
        "Agent active pointer",
    )?;
    if let Some(bytes) = previous_pointer.as_ref() {
        validate_pointer_bytes(bytes)?;
        write_atomic_bytes(&state_root, PRODUCT_AGENT_ROLLBACK_NAME, bytes)?;
    }
    let pointer = json!({
        "generationDirectoryName": generation_directory_name,
        "generationId": generation_id,
        "kind": PRODUCT_AGENT_POINTER_KIND,
        "manifestSha256": manifest_sha256,
        "schemaVersion": PRODUCT_AGENT_SCHEMA_VERSION,
        "selectionRevision": random_hex_128()?,
    });
    let pointer_bytes = canonical_json_bytes(&pointer)?;
    validate_pointer_bytes(&pointer_bytes)?;
    let pointer_identity = sha256_bytes(&pointer_bytes);
    write_atomic_bytes(&state_root, PRODUCT_AGENT_POINTER_NAME, &pointer_bytes)?;
    let readback = read_bounded_file(
        &pointer_path,
        PRODUCT_AGENT_MAX_POINTER_BYTES,
        "Agent active pointer",
    )?
    .ok_or("Agent active pointer 寫入後消失")?;
    if sha256_bytes(&readback) != pointer_identity {
        return Err("Agent active pointer readback 不一致".into());
    }
    Ok(ProductAgentGenerationActivation {
        state_root,
        pointer_identity,
        previous_pointer,
    })
}

pub fn rollback_product_agent_generation(
    activation: &ProductAgentGenerationActivation,
) -> Result<(), String> {
    let pointer_path = activation.state_root.join(PRODUCT_AGENT_POINTER_NAME);
    let current = read_bounded_file(
        &pointer_path,
        PRODUCT_AGENT_MAX_POINTER_BYTES,
        "Agent active pointer",
    )?
    .ok_or("Agent active pointer 已消失，拒絕覆蓋可能的新狀態")?;
    if sha256_bytes(&current) != activation.pointer_identity {
        return Err("Agent active pointer 已被其他操作改變，拒絕 stale rollback".into());
    }
    match activation.previous_pointer.as_ref() {
        Some(previous) => {
            validate_pointer_bytes(previous)?;
            write_atomic_bytes(&activation.state_root, PRODUCT_AGENT_POINTER_NAME, previous)
        }
        None => fs::remove_file(pointer_path).map_err(|error| error.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct OwnedDirectory(PathBuf);
    impl OwnedDirectory {
        fn new() -> Self {
            let directory = std::env::temp_dir().join(format!(
                "editkin-agent-workspace-test-{}-{}",
                std::process::id(),
                random_hex_128().expect("test fixture nonce")
            ));
            fs::create_dir(&directory).unwrap();
            Self(directory)
        }
        fn child(&self, name: &str) -> PathBuf {
            let path = self.0.join(name);
            fs::create_dir(&path).unwrap();
            path
        }
    }
    impl Drop for OwnedDirectory {
        fn drop(&mut self) {
            let physical = fs::canonicalize(&self.0).unwrap();
            let temp = fs::canonicalize(std::env::temp_dir()).unwrap();
            assert!(physical.starts_with(&temp) && physical != temp);
            assert!(physical
                .file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("editkin-agent-workspace-test-"));
            fs::remove_dir_all(physical).unwrap();
        }
    }

    #[test]
    fn cancellation_has_no_workspace_and_does_not_create_anything() {
        let root = OwnedDirectory::new();
        assert_eq!(selected_agent_workspace(None).unwrap(), None);
        assert_eq!(fs::read_dir(&root.0).unwrap().count(), 0);
    }

    #[test]
    fn rejects_unknown_relative_file_and_control_character_paths_without_creating_them() {
        let root = OwnedDirectory::new();
        let missing = root.0.join("does not exist");
        let file = root.0.join("not-a-directory.txt");
        fs::write(&file, "fixture").unwrap();
        for path in [
            PathBuf::new(),
            PathBuf::from("relative"),
            missing.clone(),
            file,
            root.0.join("bad\nfolder"),
        ] {
            assert!(selected_agent_workspace(Some(&path))
                .unwrap_err()
                .contains("未變更 AI 設定"));
        }
        assert!(!missing.exists());
    }

    #[test]
    fn selected_directory_is_canonical_not_an_inferred_parent_or_default() {
        let root = OwnedDirectory::new();
        let chosen = root.child("旅行 空格 & $work");
        let selected = selected_agent_workspace(Some(&chosen.join(".")))
            .unwrap()
            .unwrap();
        assert_eq!(
            selected.path(),
            interoperable_canonical_path(&fs::canonicalize(&chosen).unwrap()).unwrap()
        );
        assert_ne!(selected.path(), root.0);
        assert!(!selected.path().to_string_lossy().starts_with(r"\\?\"));
    }

    fn invocation(target: &str, workspace: &AgentWorkspace) -> AgentSetupInvocation {
        let expected = [
            "EDITKIN_PLUGIN_ROOTS",
            "EDITKIN_WORKSPACE",
            "ELECTRON_RUN_AS_NODE",
        ]
        .map(str::to_string)
        .into_iter()
        .collect::<BTreeSet<_>>();
        build_agent_setup_invocation(
            target,
            Path::new(r"C:\Program Files\Editkin\node.exe"),
            Path::new(r"C:\Program Files\Editkin\agent-runtime-v3\launcher.mjs"),
            workspace,
            vec![
                ("ELECTRON_RUN_AS_NODE".into(), "1".into()),
                (
                    "EDITKIN_PLUGIN_ROOTS".into(),
                    r"D:\插件 $tools & 配色\".into(),
                ),
            ],
            &expected,
        )
        .unwrap()
    }

    #[test]
    fn codex_text_and_argument_array_follow_each_explicit_workspace() {
        let root = OwnedDirectory::new();
        for name in ["旅行 空格 & $work", "Hao's 工作區 (二)"] {
            let selected = selected_agent_workspace(Some(&root.child(name)))
                .unwrap()
                .unwrap();
            let result = invocation("codex", &selected);
            let value = format!("EDITKIN_WORKSPACE={}", selected.path().to_str().unwrap());
            assert!(result.args.iter().any(|arg| arg == &value));
            assert!(result
                .command
                .contains(&format!("--env {}", ps_quote(&value))));
            assert_eq!(
                result.args.last().unwrap(),
                r"C:\Program Files\Editkin\agent-runtime-v3\launcher.mjs"
            );
            assert!(result.command.ends_with(
                "-- 'C:\\Program Files\\Editkin\\node.exe' 'C:\\Program Files\\Editkin\\agent-runtime-v3\\launcher.mjs'"
            ));
            assert!(!result.command.contains("OPENAI_API_KEY"));
        }
    }

    #[test]
    fn claude_json_and_powershell_text_preserve_unicode_apostrophe_and_trailing_slash() {
        let root = OwnedDirectory::new();
        let selected = selected_agent_workspace(Some(&root.child("Hao's 工作區 & $tools")))
            .unwrap()
            .unwrap();
        let result = invocation("claude", &selected);
        let raw = result.args.last().unwrap();
        let config: Value = serde_json::from_str(raw).unwrap();
        assert_eq!(
            config["env"]["EDITKIN_WORKSPACE"],
            selected.path().to_str().unwrap()
        );
        assert_eq!(
            config["env"]["EDITKIN_PLUGIN_ROOTS"],
            r"D:\插件 $tools & 配色\"
        );
        assert_eq!(
            config["args"][0],
            r"C:\Program Files\Editkin\agent-runtime-v3\launcher.mjs"
        );
        assert_eq!(
            result.command,
            format!("claude mcp add-json --scope user editkin {}", ps_quote(raw))
        );
        assert!(result.command.contains("Hao''s"));
        assert!(!raw.contains("ANTHROPIC_API_KEY"));
    }

    #[test]
    fn explicit_workspace_cannot_be_overridden_by_stale_environment_or_unsafe_values() {
        let root = OwnedDirectory::new();
        let selected = selected_agent_workspace(Some(&root.0)).unwrap().unwrap();
        for env in [
            vec![("EDITKIN_WORKSPACE".into(), r"C:\old Videos".into())],
            vec![("KEY".into(), "one".into()), ("KEY".into(), "two".into())],
            vec![("KEY\nBAD".into(), "value".into())],
            vec![("KEY".into(), "value\nnext command".into())],
        ] {
            let expected = ["EDITKIN_WORKSPACE"]
                .map(str::to_string)
                .into_iter()
                .collect::<BTreeSet<_>>();
            assert!(build_agent_setup_invocation(
                "codex",
                Path::new("node"),
                Path::new("mcp"),
                &selected,
                env,
                &expected,
            )
            .is_err());
        }
        assert!(build_agent_setup_invocation(
            "unknown",
            Path::new("node"),
            Path::new("mcp"),
            &selected,
            vec![],
            &["EDITKIN_WORKSPACE".to_string()].into_iter().collect(),
        )
        .is_err());

        let expected = ["EDITKIN_WORKSPACE"]
            .map(str::to_string)
            .into_iter()
            .collect::<BTreeSet<_>>();
        let direct_mcp = build_agent_setup_invocation(
            "codex",
            Path::new(r"C:\Program Files\Editkin\runtime\node.exe"),
            Path::new(r"C:\Program Files\Editkin\runtime\mcp.mjs"),
            &selected,
            vec![],
            &expected,
        )
        .unwrap_err();
        assert!(direct_mcp.contains("不得直接指向 mcp.mjs"));
    }

    fn product_generation_fixture(
        root: &OwnedDirectory,
    ) -> (PathBuf, ProductAgentGenerationPaths, Vec<u8>) {
        let resource_root = root.0.join("product-resources");
        let state_root = root.0.join("user-data").join(PRODUCT_AGENT_STATE_DIRECTORY);
        fs::create_dir_all(&resource_root).unwrap();
        fs::create_dir_all(state_root.parent().unwrap()).unwrap();

        let directory = |relative: &str| {
            let path = resource_root.join(relative);
            fs::create_dir_all(&path).unwrap();
            path
        };
        let file = |relative: &str, bytes: &[u8]| {
            let path = resource_root.join(relative);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, bytes).unwrap();
            path
        };
        let personal_visual = state_root
            .parent()
            .unwrap()
            .join("personal-packs/hao-visual-library");
        fs::create_dir_all(&personal_visual).unwrap();
        let contract = br#"{"contractVersion":"editkin.agent-setup/v2"}
"#
        .to_vec();
        let paths = ProductAgentGenerationPaths {
            resource_root: resource_root.clone(),
            embedded_contract: file("agent-runtime-v3/agent-setup-contract.json", &contract),
            entrypoint: file("runtime/mcp.mjs", b"export {};\n"),
            entrypoint_identity: file(
                "runtime/mcp.mjs.material-color-identity.json",
                b"{\"fixture\":true}\n",
            ),
            ffmpeg: file("runtime/ffmpeg", b"ffmpeg\n"),
            ffprobe: file("runtime/ffprobe", b"ffprobe\n"),
            gpu_compositor: file("runtime/editkin-gpu-compositor", b"gpu\n"),
            launcher: file("agent-runtime-v3/launcher.mjs", b"// launcher\n"),
            native_core: file("runtime/hao-core", b"native\n"),
            node: file("runtime/node", b"node\n"),
            node_manifest: file("runtime/NODE-MANIFEST.json", b"{\"fixture\":true}\n"),
            whisper: file("runtime/whisper-cli", b"whisper\n"),
            color: directory("color/aces2"),
            creative_pack: directory("creative-packs/hao-creator-library"),
            fonts: directory("font-packs/editkin-open-fonts"),
            personal_music: directory("personal-packs/hao-music-library"),
            personal_visual,
            plugins: directory("plugins"),
        };
        (state_root, paths, contract)
    }

    #[test]
    fn product_generation_activation_is_immutable_reusable_and_rollback_safe() {
        let root = OwnedDirectory::new();
        let (state_root, paths, contract) = product_generation_fixture(&root);
        let first = activate_product_agent_generation(&state_root, &paths, &contract).unwrap();
        let first_pointer = fs::read(state_root.join(PRODUCT_AGENT_POINTER_NAME)).unwrap();
        assert_eq!(sha256_bytes(&first_pointer), first.pointer_identity);
        assert_eq!(
            fs::read_dir(state_root.join("generations"))
                .unwrap()
                .count(),
            1
        );

        let second = activate_product_agent_generation(&state_root, &paths, &contract).unwrap();
        let second_pointer = fs::read(state_root.join(PRODUCT_AGENT_POINTER_NAME)).unwrap();
        assert_ne!(first.pointer_identity, second.pointer_identity);
        assert_eq!(
            fs::read_dir(state_root.join("generations"))
                .unwrap()
                .count(),
            1,
            "identical product bytes must reuse the immutable generation"
        );
        assert_eq!(
            fs::read(state_root.join(PRODUCT_AGENT_ROLLBACK_NAME)).unwrap(),
            first_pointer
        );

        rollback_product_agent_generation(&second).unwrap();
        assert_eq!(
            fs::read(state_root.join(PRODUCT_AGENT_POINTER_NAME)).unwrap(),
            first_pointer
        );
        assert_ne!(first_pointer, second_pointer);
    }

    #[test]
    fn product_generation_stale_rollback_cannot_clobber_a_new_activation() {
        let root = OwnedDirectory::new();
        let (state_root, paths, contract) = product_generation_fixture(&root);
        let first = activate_product_agent_generation(&state_root, &paths, &contract).unwrap();
        fs::write(&paths.ffmpeg, b"ffmpeg changed\n").unwrap();
        let second = activate_product_agent_generation(&state_root, &paths, &contract).unwrap();
        let second_pointer = fs::read(state_root.join(PRODUCT_AGENT_POINTER_NAME)).unwrap();

        let error = rollback_product_agent_generation(&first).unwrap_err();
        assert!(error.contains("stale rollback"));
        assert_eq!(
            fs::read(state_root.join(PRODUCT_AGENT_POINTER_NAME)).unwrap(),
            second_pointer
        );
        assert_eq!(sha256_bytes(&second_pointer), second.pointer_identity);
    }

    #[test]
    fn product_generation_rejects_wrong_state_scope_and_contract_drift() {
        let root = OwnedDirectory::new();
        let (_state_root, paths, contract) = product_generation_fixture(&root);
        let wrong_state = root.0.join("user-data").join("caller-selected-state");
        assert!(
            activate_product_agent_generation(&wrong_state, &paths, &contract)
                .unwrap_err()
                .contains("固定的 agent-runtime-v3")
        );
        assert!(!wrong_state.exists());
        assert!(activate_product_agent_generation(
            &root.0.join("user-data").join(PRODUCT_AGENT_STATE_DIRECTORY),
            &paths,
            b"{}\n",
        )
        .unwrap_err()
        .contains("contract"));
    }

    #[test]
    #[cfg(windows)]
    fn windows_verbatim_drive_and_unc_normalization_preserve_namespace() {
        assert_eq!(
            interoperable_canonical_path(Path::new(r"\\?\D:\工作 空間")).unwrap(),
            PathBuf::from(r"D:\工作 空間")
        );
        assert_eq!(
            interoperable_canonical_path(Path::new(r"\\?\UNC\server\share\工作 空間")).unwrap(),
            PathBuf::from(r"\\server\share\工作 空間")
        );
        assert!(
            interoperable_canonical_path(Path::new(r"\\?\GLOBALROOT\Device\HarddiskVolume1"))
                .is_err()
        );
        assert!(selected_agent_workspace(Some(Path::new(r"D:relative"))).is_err());
    }
}
