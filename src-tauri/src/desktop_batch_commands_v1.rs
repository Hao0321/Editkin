//! Batch picker/session commands. AppState stores the one mutex; this leaf owns its batch DTOs and mutations.
//! Receipt, volatile capability and cancellation semantics are copied from sealed CP06 without body changes.
use rfd::FileDialog;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::PathBuf;
use tauri::{AppHandle, Manager, State};
use crate::{
    AppState, application_data_root, call_service, collect_runtime_paths_async,
    collect_product_auto_roto_preview_paths, engine_tasks_v1, native_dialog_labels,
    read_json, render_jobs, unix_time_ms, write_json_atomic,
};
use crate::native_dialog_labels::DialogText;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct BatchJob {
    id: String,
    source_path: String,
    source_name: String,
    status: String,
    // A live native capability only. Persisted progress can never restore an owner.
    #[serde(skip)]
    operation_id: Option<String>,
    project_path: Option<String>,
    output_path: Option<String>,
    receipt_path: Option<String>,
    warnings: Vec<String>,
    error: Option<String>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BatchSession {
    schema_version: u8,
    id: String,
    #[serde(default = "default_editorial_profile")]
    editorial_profile: String,
    output_root: String,
    created_at: String,
    updated_at: String,
    jobs: Vec<BatchJob>,
}

fn default_editorial_profile() -> String {
    "auto".into()
}

fn valid_editorial_profile(value: &str) -> bool {
    matches!(
        value,
        "auto" | "gaming" | "food" | "travel" | "podcast_on_camera" | "podcast_no_face"
    )
}



fn batch_session_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(application_data_root(app)?.join("batch/current-session.json"))
}

fn persist_batch_session(app: &AppHandle, session: &BatchSession) -> Result<(), String> {
    let value = serde_json::to_value(session).map_err(|error| error.to_string())?;
    write_json_atomic(&batch_session_path(app)?, &value)
}

fn load_batch_session(app: &AppHandle) -> Result<Option<BatchSession>, String> {
    let Some(value) = read_json(&batch_session_path(app)?)? else {
        return Ok(None);
    };
    let mut session: BatchSession =
        serde_json::from_value(value).map_err(|error| format!("批次工作紀錄損壞：{error}"))?;
    if session.schema_version != 1 || session.id.is_empty() || session.jobs.is_empty() {
        return Err("批次工作紀錄格式不合法".into());
    }
    if !valid_editorial_profile(&session.editorial_profile) {
        session.editorial_profile = default_editorial_profile();
    }
    let mut recovered = false;
    for job in &mut session.jobs {
        // Derived paths are re-established by the canonical Node inspection, never disk progress.
        job.project_path = None; job.output_path = None; job.receipt_path = None;
        job.operation_id = None;
        if job.status == "running" {
            job.status = "queued".into();
            job.error = Some("上次執行中斷，已排回佇列等待重試".into());
            recovered = true;
        }
    }
    if recovered {
        session.updated_at = unix_time_ms().to_string();
        persist_batch_session(app, &session)?;
    }
    Ok(Some(session))
}


#[tauri::command]
pub(crate) async fn pick_batch_media(
    app: AppHandle,
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
    editorial_profile: String,
    ui_locale: Option<String>,
) -> Result<Value, String> {
    engine_tasks_v1::main_window(window.label())?;
    {
        let current = state.batch_session.lock().map_err(|_| "batch session lock poisoned")?;
        if current.as_ref().is_some_and(|session| session.jobs.iter().any(|job| job.status == "running")) { return Err("批次仍在執行，請先停止或等待完成".into()); }
    }
    if !valid_editorial_profile(&editorial_profile) {
        return Err("未知的剪輯類型".into());
    }
    let selected = FileDialog::new()
        .set_title(native_dialog_labels::text(ui_locale.as_deref(), DialogText::BatchTitle))
        .add_filter(native_dialog_labels::text(ui_locale.as_deref(), DialogText::VideoFilter), &["mp4", "mov", "mkv", "webm", "m4v"])
        .pick_files()
        .unwrap_or_default();
    if selected.is_empty() {
        return Ok(json!({ "canceled": true }));
    }
    let Some(output_root) = FileDialog::new()
        .set_title(native_dialog_labels::text(ui_locale.as_deref(), DialogText::BatchFolder))
        .pick_folder()
    else {
        return Ok(json!({ "canceled": true }));
    };
    let source_paths: Vec<String> = selected
        .iter()
        .map(|path| path.to_string_lossy().to_string())
        .collect();
    let probes = call_service(
        &app,
        "inspect_media_batch",
        json!({ "paths": source_paths }),
    )
    .await?;
    let probes = probes
        .as_array()
        .ok_or("inspect_media_batch 回應不是陣列")?;
    if probes.len() != selected.len() {
        return Err("inspect_media_batch 長度不符".into());
    }
    for (index, probe) in probes.iter().enumerate() {
        if probe.get("hasVideo").and_then(Value::as_bool) != Some(true)
            || probe.get("duration").and_then(Value::as_f64).unwrap_or(0.0) <= 0.0
        {
            return Err(format!(
                "{} 不是可解碼的影片，批次尚未開始",
                selected[index].to_string_lossy()
            ));
        }
    }
    let session_id = format!("batch-{}", unix_time_ms());
    let now = unix_time_ms().to_string();
    let jobs = selected
        .iter()
        .enumerate()
        .map(|(index, path)| BatchJob {
            id: format!("job-{:03}", index + 1),
            source_path: path.to_string_lossy().to_string(),
            source_name: path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("新影片")
                .to_string(),
            status: "queued".into(),
            operation_id: None,
            project_path: None,
            output_path: None,
            receipt_path: None,
            warnings: Vec::new(),
            error: None,
        })
        .collect();
    let session = BatchSession {
        schema_version: 1,
        id: session_id,
        editorial_profile,
        output_root: output_root.to_string_lossy().to_string(),
        created_at: now.clone(),
        updated_at: now,
        jobs,
    };
    let mut current = state.batch_session.lock().map_err(|_| "batch session lock poisoned")?;
    if current.as_ref().is_some_and(|session| session.jobs.iter().any(|job| job.status == "running")) { return Err("批次仍在執行，請先停止或等待完成".into()); }
    persist_batch_session(&app, &session)?;
    *current = Some(session.clone());
    Ok(json!({ "canceled": false, "session": session }))
}

/// Canonical Node inspection projects persisted progress; only this process can add a live owner.
pub(crate) async fn verified_batch_session_v1(app: &AppHandle, snapshot_value: Value) -> Result<Value, String> {
    let snapshot: BatchSession = serde_json::from_value(snapshot_value.get("session").cloned().ok_or("BATCH_SESSION_REQUIRED")?).map_err(|e| e.to_string())?;
    let mut result = call_service(app, "batch_auto_edit_session_status", json!({ "session": snapshot })).await?;
    let verified: BatchSession = serde_json::from_value(result.get("session").cloned().ok_or("BATCH_STATUS_SESSION_REQUIRED")?).map_err(|e| e.to_string())?;
    if verified.id != snapshot.id || verified.schema_version != snapshot.schema_version || verified.output_root != snapshot.output_root
        || verified.editorial_profile != snapshot.editorial_profile || verified.jobs.len() != snapshot.jobs.len()
        || verified.jobs.iter().any(|job| !snapshot.jobs.iter().any(|before| before.id == job.id && before.source_path == job.source_path)) {
        return Err("BATCH_STATUS_REPLY_BINDING_CHANGED".into());
    }
    let state = app.state::<AppState>();
    let current = state.batch_session.lock().map_err(|_| "batch session lock poisoned")?;
    let current = current.as_ref().ok_or("批次工作在查詢期間遺失")?;
    if current.id != snapshot.id { return Err("批次工作已替換，請重新查詢".into()); }
    for (index, job) in verified.jobs.iter().enumerate() {
        if let Some(live) = current.jobs.iter().find(|live| live.id == job.id && live.source_path == job.source_path && live.status == "running") {
            result["session"]["jobs"][index] = serde_json::to_value(live).map_err(|e| e.to_string())?;
            if let Some(operation_id) = live.operation_id.as_ref() { result["session"]["jobs"][index]["operationId"] = json!(operation_id); }
        }
    }
    Ok(result)
}

#[tauri::command]
pub(crate) async fn get_batch_session(app: AppHandle, state: State<'_, AppState>, window: tauri::WebviewWindow) -> Result<Value, String> {
    engine_tasks_v1::main_window(window.label())?;
    let snapshot = {
        let mut current = state.batch_session.lock().map_err(|_| "batch session lock poisoned")?;
        if current.is_none() { *current = load_batch_session(&app)?; }
        current.clone()
    };
    let Some(session) = snapshot else { return Ok(json!({ "session": null })); };
    verified_batch_session_v1(&app, json!({ "session": session })).await
}

// The same persisted BatchSession remains the only native batch authority.
pub(crate) fn batch_engine_input_v1(app: &AppHandle, session_id: &str, job_id: &str, start: bool, reject_busy: bool, operation_id: Option<&str>) -> Result<Value, String> {
    let state = app.state::<AppState>();
    let mut current = state.batch_session.lock().map_err(|_| "batch session lock poisoned")?;
    if current.is_none() { *current = load_batch_session(app)?; }
    let session = current.as_mut().ok_or("找不到批次工作")?;
    if session.id != session_id { return Err("批次 session 身分不一致".into()); }
    let job = session.jobs.iter().find(|job| job.id == job_id).ok_or("找不到批次項目")?;
    if reject_busy && job.status == "running" { return Err("BATCH_OPERATION_ALREADY_RUNNING".into()); }
    let source_path = job.source_path.clone();
    if start {
        // A rejected persistence write must not invent an in-memory running owner.
        let mut next = session.clone();
        let next_job = next.jobs.iter_mut().find(|job| job.id == job_id).ok_or("找不到批次項目")?;
        next_job.status = "running".into(); next_job.error = None; next_job.operation_id = operation_id.map(str::to_string);
        next.updated_at = unix_time_ms().to_string();
        persist_batch_session(app, &next)?;
        *session = next;
    }
    Ok(json!({ "jobId":job_id, "sessionId":session_id, "sourcePath":source_path, "outputRoot":session.output_root,
        "language":"auto", "targetRatio":0.65, "addMusic":true, "editorialProfile":session.editorial_profile }))
}

pub(crate) fn batch_engine_complete_v1(app: &AppHandle, session_id: &str, job_id: &str, service_result: Result<Value,String>) -> Result<Value,String> {
    let state = app.state::<AppState>();
    let mut current = state
        .batch_session
        .lock()
        .map_err(|_| "batch session lock poisoned")?;
    let session = current.as_mut().ok_or("批次工作在執行期間遺失")?;
    if session.id != session_id {
        return Err("批次 session 在執行期間遭替換".into());
    }
    let job = session
        .jobs
        .iter_mut()
        .find(|job| job.id == job_id)
        .ok_or("批次項目在執行期間遺失")?;
    let service_result = service_result.and_then(|result| {
        if result.get("jobId").and_then(Value::as_str) != Some(job_id)
            || !matches!(result.get("status").and_then(Value::as_str), Some("completed") | Some("failed")) {
            return Err("ENGINE_TASK_BATCH_REPLY_BINDING_CHANGED".into());
        }
        Ok(result)
    });
    job.operation_id = None;
    match service_result {
        Ok(result) => {
            job.status = result
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or("failed")
                .to_string();
            job.project_path = result
                .get("projectPath")
                .and_then(Value::as_str)
                .map(str::to_string);
            job.output_path = result
                .get("outputPath")
                .and_then(Value::as_str)
                .map(str::to_string);
            job.receipt_path = result
                .get("receiptPath")
                .and_then(Value::as_str)
                .map(str::to_string);
            job.warnings = result
                .get("warnings")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default();
            job.error = result
                .get("error")
                .and_then(Value::as_str)
                .map(str::to_string);
        }
        Err(error) => {
            job.status = "failed".into();
            job.error = Some(error);
        }
    }
    session.updated_at = unix_time_ms().to_string();
    persist_batch_session(&app, session)?;
    Ok(json!({ "session": session }))
}


#[tauri::command]
pub(crate) async fn run_batch_auto_edit_item(app: AppHandle, _state: State<'_, AppState>, window: tauri::WebviewWindow, session_id: String, job_id: String) -> Result<Value, String> {
    engine_tasks_v1::main_window(window.label())?;
    let input = batch_engine_input_v1(&app, &session_id, &job_id, true, true, None)?;
    let service_result = call_service(&app, "batch_auto_edit_item", input).await;
    let persisted = batch_engine_complete_v1(&app, &session_id, &job_id, service_result)?;
    verified_batch_session_v1(&app, persisted).await
}

#[tauri::command]
pub(crate) async fn open_batch_project(
    app: AppHandle,
    _state: State<'_, AppState>,
    window: tauri::WebviewWindow,
    session_id: String,
    job_id: String,
) -> Result<Value, String> {
    engine_tasks_v1::main_window(window.label())?;
    let input = batch_engine_input_v1(&app, &session_id, &job_id, false, false, None)?;
    let inspected = call_service(&app, "batch_auto_edit_status", input).await?;
    if inspected.get("jobId").and_then(Value::as_str) != Some(&job_id)
        || inspected.get("sessionId").and_then(Value::as_str) != Some(&session_id) { return Err("BATCH_STATUS_REPLY_BINDING_CHANGED".into()); }
    let project_path = inspected.get("projectPath").and_then(Value::as_str).ok_or("批次專案缺可核對的來源收據；請續跑或從檔案開啟人工檢查")?.to_owned();
    // Use the checked snapshot, not a second unverified read after the status response.
    let project = inspected.get("project").cloned().ok_or("批次專案尚未通過來源核對")?;
    let project_file_identity = inspected.get("fileIdentity").cloned().ok_or("batch status missing checked file identity")?;
    let assets = project
        .get("assets")
        .and_then(Value::as_array)
        .ok_or("專案缺少 assets")?;
    let runtime_paths = collect_runtime_paths_async(&app, assets).await?;
    let matte_preview_paths = collect_product_auto_roto_preview_paths(&app, &project)?;
    Ok(json!({
        "canceled": false,
        "path": project_path,
        "project": project,
        "fileIdentity": project_file_identity,
        "runtimePaths": runtime_paths,
        "mattePreviewPaths": matte_preview_paths
    }))
}


#[tauri::command]
pub(crate) fn cancel_engine_task_v1(window: tauri::WebviewWindow, jobs: State<'_, render_jobs::RenderJobs>, state: State<'_, AppState>, operation_id: String, session_id: Option<String>, job_id: Option<String>) -> Result<Value, String> {
    engine_tasks_v1::main_window(window.label())?;
    let owner = {
        let current = state.batch_session.lock().map_err(|_| "batch session lock poisoned")?;
        current.as_ref().and_then(|session| session.jobs.iter().find(|job| job.status == "running" && job.operation_id.as_deref() == Some(operation_id.as_str()))
            .map(|job| (session.id.clone(), job.id.clone())))
    };
    if let Some((expected_session, expected_job)) = owner {
        if session_id.as_deref() != Some(expected_session.as_str()) || job_id.as_deref() != Some(expected_job.as_str()) { return Err("ENGINE_TASK_BATCH_CANCEL_BINDING_CHANGED".into()); }
    } else if session_id.is_some() || job_id.is_some() {
        return Ok(json!({ "jobId": operation_id, "known": false, "cancelRequested": false }));
    }
    Ok(jobs.request_cancel_engine(&operation_id, render_jobs::HARD_CANCEL_GRACE))
}


#[cfg(test)]
mod tests {
    use super::*;

    fn persisted_fixture() -> Value {
        json!({"schemaVersion":1,"id":"batch-serde-07","editorialProfile":"auto",
            "outputRoot":"D:/owned-batch-07","createdAt":"1","updatedAt":"2",
            "jobs":[{"id":"job-001","sourcePath":"D:/owned-batch-07/source.mp4","sourceName":"source.mp4",
                "status":"running","projectPath":null,"outputPath":null,"receiptPath":null,"warnings":[],"error":null}]})
    }

    #[test]
    fn persisted_session_round_trip_keeps_v1_camel_case_shape() {
        let fixture = persisted_fixture();
        let decoded: BatchSession = serde_json::from_value(fixture.clone()).unwrap();
        assert_eq!(serde_json::to_value(decoded).unwrap(), fixture);
    }

    #[test]
    fn forged_persisted_capability_is_ignored_and_live_capability_never_serializes() {
        let mut forged = persisted_fixture();
        forged["jobs"][0]["operationId"] = json!("attacker-persisted-owner");
        let mut decoded: BatchSession = serde_json::from_value(forged).unwrap();
        assert!(decoded.jobs[0].operation_id.is_none());
        decoded.jobs[0].operation_id = Some("genuine-in-memory-owner".into());
        let serialized = serde_json::to_value(decoded).unwrap();
        assert!(serialized["jobs"][0].get("operationId").is_none());
        assert_eq!(serialized, persisted_fixture());
    }

    #[test]
    fn missing_required_picker_identity_fails_but_profile_default_stays_auto() {
        let mut missing = persisted_fixture();
        missing["jobs"][0].as_object_mut().unwrap().remove("sourcePath");
        assert!(serde_json::from_value::<BatchSession>(missing).is_err());
        let mut old = persisted_fixture();
        old.as_object_mut().unwrap().remove("editorialProfile");
        let decoded: BatchSession = serde_json::from_value(old).unwrap();
        assert_eq!(decoded.editorial_profile, "auto");
        for profile in ["auto","gaming","food","travel","podcast_on_camera","podcast_no_face"] {
            assert!(valid_editorial_profile(profile));
        }
        assert!(!valid_editorial_profile("forged-profile"));
    }
}
