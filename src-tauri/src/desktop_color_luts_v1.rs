//! Personal LUT IO. Picker authority remains in the main native window; file paths never come from import payloads.
use rfd::FileDialog;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Read,
    path::{Component, Path, PathBuf},
    sync::Mutex,
};
use tauri::{AppHandle, Manager, WebviewWindow};

const MAX_CUBE: u64 = 64 * 1024 * 1024;
#[derive(Default)]
struct Pending {
    epoch: u64,
    chosen: Option<(String, PathBuf)>,
    busy: bool,
}
#[derive(Default)]
pub struct ColorLutSelectionsV1(Mutex<Pending>);

pub fn root_for_visual(visual: &Path) -> Result<PathBuf, String> {
    if let Some(explicit) = std::env::var_os("EDITKIN_COLOR_LUT_ROOT") {
        let root = PathBuf::from(explicit);
        if !root.is_absolute() || crate::is_windows_network_path(&root.to_string_lossy()) {
            return Err("LUT 素材庫請使用本機絕對路徑。".into());
        }
        return Ok(root);
    }
    visual
        .parent()
        .map(|p| p.join("hao-color-luts"))
        .ok_or_else(|| "LUT 素材庫未設定。".into())
}
fn main_window(window: &WebviewWindow) -> Result<(), String> {
    if window.label() != "main" {
        return Err("LUT 操作只允許主編輯視窗。".into());
    }
    Ok(())
}
fn plain_local(path: &Path) -> Result<(), String> {
    let text = path.to_string_lossy();
    if !path.is_absolute()
        || crate::is_windows_network_path(&text)
        || text.chars().any(char::is_control)
        || path.components().any(|c| matches!(c, Component::ParentDir))
    {
        return Err("LUT 素材庫路徑或檔案不合法。".into());
    }
    for ancestor in path.ancestors() {
        let info = fs::symlink_metadata(ancestor).map_err(|e| e.to_string())?;
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if info.file_attributes() & 0x400 != 0 {
                return Err("LUT 素材庫不可經過連結路徑。".into());
            }
        }
        if info.file_type().is_symlink() {
            return Err("LUT 素材庫不可經過連結路徑。".into());
        }
    }
    Ok(())
}
fn dialog_labels(locale: Option<&str>) -> (&'static str, &'static str) {
    match locale {
        Some("en") => ("Choose a LUT to import", "LUT (.cube)"),
        Some("es") => ("Seleccionar LUT para importar", "LUT (.cube)"),
        Some("ja") => ("読み込む LUT を選択", "LUT (.cube)"),
        Some("ko") => ("가져올 LUT 선택", "LUT (.cube)"),
        _ => ("選擇要匯入的 LUT", "LUT (.cube)"),
    }
}
pub async fn list_color_luts_v1(
    app: AppHandle,
    window: WebviewWindow,
    offset: Option<u64>,
    limit: Option<u64>,
) -> Result<Value, String> {
    main_window(&window)?;
    crate::call_service(
        &app,
        "color_lut_library_v1",
        json!({"operation":"list","offset":offset.unwrap_or(0),"limit":limit.unwrap_or(100)}),
    )
    .await
}
pub async fn pick_color_lut_v1(
    app: AppHandle,
    window: WebviewWindow,
    ui_locale: Option<String>,
) -> Result<Value, String> {
    main_window(&window)?;
    let state = app.state::<ColorLutSelectionsV1>();
    let epoch = {
        let mut p = state.0.lock().map_err(|e| e.to_string())?;
        p.epoch = p.epoch.checked_add(1).ok_or("LUT 選取序號已用盡。")?;
        p.chosen = None;
        p.busy = false;
        p.epoch
    };
    let chosen = tauri::async_runtime::spawn_blocking(move || {
        let (title, filter) = dialog_labels(ui_locale.as_deref());
        FileDialog::new()
            .set_title(title)
            .add_filter(filter, &["cube"])
            .pick_file()
    })
    .await
    .map_err(|e| e.to_string())?;
    let mut pending = state.0.lock().map_err(|e| e.to_string())?;
    if pending.epoch != epoch {
        return Err("LUT 選取已更新，這次結果未套用。".into());
    }
    let Some(path) = chosen else {
        return Ok(Value::Null);
    };
    plain_local(&path)?;
    if path
        .extension()
        .and_then(|v| v.to_str())
        .map_or(true, |v| !v.eq_ignore_ascii_case("cube"))
    {
        return Err("LUT 匯入只接受 .cube 檔。".into());
    }
    let mut nonce = [0u8; 16];
    getrandom::fill(&mut nonce).map_err(|e| e.to_string())?;
    let token = nonce
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<Vec<_>>()
        .join("");
    let name = path
        .file_stem()
        .map(|v| v.to_string_lossy().into_owned())
        .unwrap_or_else(|| "LUT".into());
    pending.chosen = Some((token.clone(), path));
    Ok(json!({"selectionId":token,"suggestedName":name}))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportRequestV1 {
    selection_id: String,
    name: String,
    license: String,
    provenance: String,
    rights_basis: String,
    input_space: String,
}
pub async fn import_color_lut_v1(
    app: AppHandle,
    window: WebviewWindow,
    request: ImportRequestV1,
) -> Result<Value, String> {
    main_window(&window)?;
    let state = app.state::<ColorLutSelectionsV1>();
    let path = {
        let mut p = state.0.lock().map_err(|e| e.to_string())?;
        if p.busy {
            return Err("LUT 正在匯入，請等候完成。".into());
        }
        let path = p
            .chosen
            .as_ref()
            .filter(|(id, _)| id == &request.selection_id)
            .map(|(_, path)| path.clone())
            .ok_or("請重新選擇 LUT 檔案。")?;
        p.busy = true;
        path
    };
    let result=crate::call_service(&app,"color_lut_library_v1",json!({"operation":"import","sourcePath":path,"name":request.name,"license":request.license,"provenance":request.provenance,"rightsBasis":request.rights_basis,"inputSpace":request.input_space})).await;
    if let Ok(mut p) = state.0.lock() {
        if p.chosen
            .as_ref()
            .is_some_and(|(id, _)| id == &request.selection_id)
        {
            p.busy = false;
            if result.is_ok() {
                p.chosen = None;
            }
        }
    }
    result
}
fn read_verified(root: &Path, result: &Value, expected_sha: &str) -> Result<Vec<u8>, String> {
    let entry = result.get("entry").ok_or("LUT 素材庫 metadata 不合法。")?;
    let path = PathBuf::from(
        result
            .get("absolutePath")
            .and_then(Value::as_str)
            .ok_or("LUT 素材庫路徑或檔案不合法。")?,
    );
    let expected = root.join("luts").join(format!("{expected_sha}.cube"));
    plain_local(root)?;
    plain_local(&path)?;
    plain_local(&expected)?;
    if fs::canonicalize(&path).map_err(|e| e.to_string())?
        != fs::canonicalize(&expected).map_err(|e| e.to_string())?
    {
        return Err("LUT 素材庫路徑或檔案不合法。".into());
    }
    let size = entry
        .get("bytes")
        .and_then(Value::as_u64)
        .filter(|n| *n > 0 && *n <= MAX_CUBE)
        .ok_or("LUT 內容超過 64 MiB 上限。")?;
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x0020_0000);
    }
    let file = options.open(&path).map_err(|e| e.to_string())?;
    let before = file.metadata().map_err(|e| e.to_string())?;
    if !before.is_file() || before.len() != size {
        return Err("LUT 內容或色彩空間與調色引用不符。".into());
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if before.file_attributes() & 0x400 != 0 {
            return Err("LUT 素材庫不可經過連結路徑。".into());
        }
    }
    let mut bytes = Vec::with_capacity(size as usize);
    let mut bounded = (&file).take(size + 1);
    bounded.read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    let after = file.metadata().map_err(|e| e.to_string())?;
    if bytes.len() as u64 != size
        || after.len() != size
        || before.modified().ok() != after.modified().ok()
        || format!("{:x}", Sha256::digest(&bytes)) != expected_sha
    {
        return Err("LUT 內容或色彩空間與調色引用不符。".into());
    }
    Ok(bytes)
}
pub async fn read_color_lut_v1(
    app: AppHandle,
    window: WebviewWindow,
    id: String,
    sha256: String,
    input_space: String,
) -> Result<tauri::ipc::Response, String> {
    main_window(&window)?;
    let root = crate::runtime_paths(&app)?
        .personal_color_lut_root
        .ok_or("LUT 素材庫未設定。")?;
    let result = crate::call_service(
        &app,
        "color_lut_library_v1",
        json!({"operation":"resolve","id":id,"sha256":sha256,"inputSpace":input_space}),
    )
    .await?;
    let bytes =
        tauri::async_runtime::spawn_blocking(move || read_verified(&root, &result, &sha256))
            .await
            .map_err(|e| e.to_string())??;
    Ok(tauri::ipc::Response::new(bytes))
}
