//! Desktop video exports with visible progress and a cancel that really stops the work.
//!
//! The host owns one folder per export under the app cache. The Node renderer writes `progress.json` there (the
//! stage, and a fraction only where FFmpeg reports output time) and watches for `cancel.request`. A cancel first
//! asks the renderer to stop, so FFmpeg exits and the renderer removes its own temporary output and work files. If
//! the renderer has not answered after HARD_CANCEL_GRACE, the export worker's process tree is stopped and the
//! partial output the renderer left next to the chosen file is removed (only names the renderer itself writes).
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, MutexGuard,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager};

pub const PROGRESS_FILE: &str = "progress.json";
pub const CANCEL_FILE: &str = "cancel.request";
pub const PROGRESS_SCHEMA: &str = "editkin.render-progress/v1";
pub const HARD_CANCEL_GRACE: Duration = Duration::from_secs(20);
/// Outer bound of one export request. It is not a product limit: the renderer's own deadline grows with the
/// video's length and its watchdog stops an encoder that makes no progress; the creator can cancel at any time.
pub const EXPORT_REQUEST_BOUND: Duration = Duration::from_secs(7 * 24 * 60 * 60);
const MAX_PROGRESS_BYTES: u64 = 64 * 1024;
const MAX_JOBS: usize = 8;

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poison| poison.into_inner())
}

/// The UI creates the ID before the save dialog opens, so it can ask for progress as soon as the export starts.
pub fn valid_job_id(id: &str) -> bool {
    (8..=64).contains(&id.len())
        && id
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

pub struct RenderJob {
    directory: PathBuf,
    output_path: PathBuf,
    engine_kind: Option<&'static str>,
    hard_stop: Arc<AtomicBool>,
    cancel_requested: AtomicBool,
    started: Instant,
}

impl RenderJob {
    /// Batch apply/commit is cooperative only. Never use the export hard-stop grace for it.
    pub fn request_soft_cancel(&self) -> Result<(), String> {
        fs::write(self.cancel_path(), b"cancel\n").map_err(|e| e.to_string())?;
        self.cancel_requested.store(true, Ordering::Release); Ok(())
    }
    pub fn hard_stop_token(&self) -> Arc<AtomicBool> { self.hard_stop.clone() }
    pub fn progress_path(&self) -> PathBuf {
        self.directory.join(PROGRESS_FILE)
    }
    pub fn cancel_path(&self) -> PathBuf {
        self.directory.join(CANCEL_FILE)
    }
    pub fn cancel_requested(&self) -> bool {
        self.cancel_requested.load(Ordering::Acquire)
    }
    pub fn hard_stopped(&self) -> bool {
        self.hard_stop.load(Ordering::Acquire)
    }
}

#[derive(Default)]
pub struct RenderJobs {
    jobs: Mutex<HashMap<String, Arc<RenderJob>>>,
}

impl RenderJobs {
    pub fn register(&self, root: &Path, id: &str, output_path: &Path) -> Result<Arc<RenderJob>, String> {
        if !valid_job_id(id) {
            return Err("輸出工作編號不合法".into());
        }
        let mut jobs = lock(&self.jobs);
        if jobs.contains_key(id) {
            return Err("這個輸出工作已經在進行".into());
        }
        if jobs.len() >= MAX_JOBS {
            return Err("同時輸出的影片太多了，請等其中一支完成".into());
        }
        let directory = root.join(id);
        // A folder left by an earlier run with this ID only ever holds this module's own job files.
        let _ = fs::remove_dir_all(&directory);
        fs::create_dir_all(&directory).map_err(|error| format!("無法建立輸出工作資料夾：{error}"))?;
        let job = Arc::new(RenderJob {
            directory,
            output_path: output_path.to_path_buf(),
            engine_kind: None,
            hard_stop: Arc::new(AtomicBool::new(false)),
            cancel_requested: AtomicBool::new(false),
            started: Instant::now(),
        });
        jobs.insert(id.to_string(), job.clone());
        Ok(job)
    }

    /// Engine tasks allocate a fresh directory; an existing ID on disk is never reclaimed here.
    pub fn register_engine(&self, root: &Path, id: &str, kind: &'static str) -> Result<Arc<RenderJob>, String> {
        if !valid_job_id(id) || !matches!(kind, "auto_reframe_v1" | "desktop_batch_item_v1") { return Err("ENGINE_TASK_JOB_ID_INVALID".into()); }
        let mut jobs = lock(&self.jobs);
        if jobs.contains_key(id) || jobs.len() >= MAX_JOBS { return Err("ENGINE_TASK_BUSY".into()); }
        let existing = root.ancestors().find(|p| p.exists()).ok_or("ENGINE_TASK_CACHE_ROOT_INVALID")?;
        crate::engine_tasks_v1::plain_local(existing)?;
        fs::create_dir_all(root).map_err(|e| e.to_string())?;
        crate::engine_tasks_v1::plain_local(root)?;
        let directory = root.join(id);
        fs::create_dir(&directory).map_err(|e| format!("ENGINE_TASK_JOB_NOT_FRESH: {e}"))?;
        let job = Arc::new(RenderJob { directory, output_path: PathBuf::new(), engine_kind: Some(kind),
            hard_stop: Arc::new(AtomicBool::new(false)), cancel_requested: AtomicBool::new(false), started: Instant::now() });
        jobs.insert(id.into(), job.clone()); Ok(job)
    }

    pub fn finish(&self, id: &str) {
        if let Some(job) = lock(&self.jobs).remove(id) {
            if job.engine_kind.is_none() { let _ = fs::remove_dir_all(&job.directory); return; }
            // Only known regular files are owned. Preserve unfamiliar files and reparse paths.
            if crate::engine_tasks_v1::plain_local(&job.directory).is_err() { return; }
            for file in [job.progress_path(), job.cancel_path()] {
                if crate::engine_tasks_v1::plain_local(&file).is_ok() && fs::symlink_metadata(&file).map(|m| m.is_file()).unwrap_or(false) { let _ = fs::remove_file(file); }
            }
            let _ = fs::remove_dir(&job.directory);
        }
    }

    /// Asks the renderer to stop, then stops the worker itself if the renderer does not answer in `grace`.
    pub fn request_cancel(&self, id: &str, grace: Duration) -> Value { self.request_cancel_for(id, grace, false) }
    pub fn request_cancel_engine(&self, id: &str, grace: Duration) -> Value { self.request_cancel_for(id, grace, true) }
    fn request_cancel_for(&self, id: &str, grace: Duration, engine: bool) -> Value {
        let job = lock(&self.jobs).get(id).filter(|job| job.engine_kind.is_some() == engine).cloned();
        let Some(job) = job else {
            return json!({ "jobId": id, "known": false, "cancelRequested": false });
        };
        if job.engine_kind == Some("desktop_batch_item_v1") {
            return match job.request_soft_cancel() {
                Ok(()) => json!({"jobId":id,"known":true,"cancelRequested":true}),
                Err(error) => json!({"jobId":id,"known":true,"cancelRequested":false,"error":error}),
            };
        }
        if !job.cancel_requested.swap(true, Ordering::AcqRel) {
            if fs::write(job.cancel_path(), b"cancel\n").is_err() {
                // The renderer cannot be told; stop the worker now rather than letting the export run on.
                job.hard_stop.store(true, Ordering::Release);
            } else {
                let watched = Arc::downgrade(&job);
                let _ = thread::Builder::new()
                    .name("render-cancel-grace".into())
                    .spawn(move || {
                        thread::sleep(grace);
                        if let Some(job) = watched.upgrade() {
                            job.hard_stop.store(true, Ordering::Release);
                        }
                    });
            }
        }
        json!({ "jobId": id, "known": true, "cancelRequested": true })
    }

    pub fn progress(&self, id: &str) -> Value {
        let job = lock(&self.jobs).get(id).filter(|job| job.engine_kind.is_none()).cloned();
        let Some(job) = job else {
            return json!({ "jobId": id, "known": false });
        };
        json!({
            "jobId": id,
            "known": true,
            "outputPath": job.output_path.to_string_lossy(),
            "cancelRequested": job.cancel_requested(),
            "elapsedMs": u64::try_from(job.started.elapsed().as_millis()).unwrap_or(u64::MAX),
            "progress": read_progress(&job.progress_path()),
        })
    }
}

/// The renderer's latest snapshot, or null while it has not written one (or wrote something else).
pub fn read_progress(path: &Path) -> Value {
    let Ok(metadata) = fs::metadata(path) else {
        return Value::Null;
    };
    if !metadata.is_file() || metadata.len() > MAX_PROGRESS_BYTES {
        return Value::Null;
    }
    fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .filter(|value| value.get("schema").and_then(Value::as_str) == Some(PROGRESS_SCHEMA))
        .unwrap_or(Value::Null)
}

/// Partial outputs the renderer writes beside the chosen file before it renames the finished one into place
/// (`.<name>.<pid>.rendering.mp4` and its ACES/alpha variants). Nothing else matches.
pub fn is_partial_output_name(output: &Path, candidate: &str) -> bool {
    let Some(name) = output.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    let Some(rest) = candidate.strip_prefix('.').and_then(|rest| rest.strip_prefix(name)) else {
        return false;
    };
    let Some(rest) = rest.strip_prefix('.') else {
        return false;
    };
    let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
    if digits == 0 {
        return false;
    }
    matches!(
        &rest[digits..],
        ".rendering.mp4" | ".rendering.mov" | ".aces2-rendering.mp4" | ".resident-aces2-rendering.mp4"
    )
}

pub fn remove_partial_outputs(output: &Path) -> usize {
    let Some(folder) = output.parent() else {
        return 0;
    };
    let Ok(entries) = fs::read_dir(folder) else {
        return 0;
    };
    let mut removed = 0;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        let is_file = entry.file_type().map(|kind| kind.is_file()).unwrap_or(false);
        if is_file && is_partial_output_name(output, name) && fs::remove_file(entry.path()).is_ok() {
            removed += 1;
        }
    }
    removed
}

pub enum ExportOutcome {
    Completed(Value),
    Canceled,
}

fn envelope_result(envelope: Value) -> Result<Value, String> {
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

/// Runs one `render_project` service request. Without a job ID it is the former single request; with one, the
/// export reports progress, can be canceled and has no hidden time cap.
pub async fn run_export(
    app: &AppHandle,
    job_id: Option<&str>,
    output_path: &Path,
    mut payload: Value,
) -> Result<ExportOutcome, String> {
    let Some(id) = job_id else {
        return crate::call_service(app, "render_project", payload)
            .await
            .map(ExportOutcome::Completed);
    };
    let root = crate::application_cache_root(app)?.join("render-jobs");
    let job = app.state::<RenderJobs>().register(&root, id, output_path)?;
    payload["progressPath"] = json!(job.progress_path());
    payload["cancelPath"] = json!(job.cancel_path());
    let prepared = crate::runtime_paths(app).map(|runtime| {
        let request = crate::service_request_value(&runtime, "render_project", payload);
        (runtime, request)
    });
    let (runtime, request) = match prepared {
        Ok(value) => value,
        Err(error) => {
            app.state::<RenderJobs>().finish(id);
            return Err(error);
        }
    };
    let services = app.state::<crate::AppState>().services.clone();
    let hard_stop = job.hard_stop.clone();
    let response = tauri::async_runtime::spawn_blocking(move || {
        services.request_export_job(&runtime.node, &runtime.service, request, EXPORT_REQUEST_BOUND, &hard_stop)
    })
    .await
    .map_err(|error| error.to_string())
    .and_then(|result| result)
    .and_then(envelope_result);
    let canceled = job.cancel_requested();
    if job.hard_stopped() {
        remove_partial_outputs(output_path);
    }
    app.state::<RenderJobs>().finish(id);
    match response {
        // A render that finished just before the stop took effect is a finished video.
        Ok(value) => Ok(ExportOutcome::Completed(value)),
        Err(_) if canceled => Ok(ExportOutcome::Canceled),
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("editkin-render-jobs-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn job_ids_are_short_lowercase_tokens() {
        assert!(valid_job_id("render-0123abcd"));
        assert!(!valid_job_id("short"));
        assert!(!valid_job_id("Render-0123ABCD"));
        assert!(!valid_job_id("../../escape-00"));
        assert!(!valid_job_id(&"a".repeat(65)));
    }

    #[test]
    fn progress_is_read_only_from_the_renderer_schema_and_job_folder_is_removed() {
        let root = temp_root("progress");
        let jobs = RenderJobs::default();
        let job = jobs.register(&root, "render-progress-1", &root.join("out.mp4")).unwrap();
        assert_eq!(jobs.progress("render-progress-1")["progress"], Value::Null);
        fs::write(job.progress_path(), br#"{"schema":"other"}"#).unwrap();
        assert_eq!(jobs.progress("render-progress-1")["progress"], Value::Null);
        fs::write(job.progress_path(), br#"{"schema":"editkin.render-progress/v1","stage":"encode","fraction":0.5}"#).unwrap();
        let progress = jobs.progress("render-progress-1");
        assert_eq!(progress["known"], json!(true));
        assert_eq!(progress["progress"]["fraction"], json!(0.5));
        assert!(jobs.register(&root, "render-progress-1", &root.join("out.mp4")).is_err());
        jobs.finish("render-progress-1");
        assert!(!root.join("render-progress-1").exists());
        assert_eq!(jobs.progress("render-progress-1")["known"], json!(false));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn cancel_writes_the_request_then_stops_the_worker_after_the_grace() {
        let root = temp_root("cancel");
        let jobs = RenderJobs::default();
        let job = jobs.register(&root, "render-cancel-1", &root.join("out.mp4")).unwrap();
        let answer = jobs.request_cancel("render-cancel-1", Duration::from_millis(50));
        assert_eq!(answer["cancelRequested"], json!(true));
        assert!(job.cancel_path().is_file());
        assert!(job.cancel_requested());
        assert!(!job.hard_stopped(), "the renderer gets the grace period first");
        thread::sleep(Duration::from_millis(400));
        assert!(job.hard_stopped());
        assert_eq!(jobs.request_cancel("missing-job-1", Duration::from_millis(1))["known"], json!(false));
        jobs.finish("render-cancel-1");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn only_the_renderers_own_partial_outputs_are_recognised() {
        let output = Path::new("C:/Videos/trip.mp4");
        assert!(is_partial_output_name(output, ".trip.mp4.4312.rendering.mp4"));
        assert!(is_partial_output_name(output, ".trip.mp4.77.aces2-rendering.mp4"));
        assert!(is_partial_output_name(output, ".trip.mp4.9.resident-aces2-rendering.mp4"));
        assert!(!is_partial_output_name(output, "trip.mp4"));
        assert!(!is_partial_output_name(output, ".trip.mp4.rendering.mp4"));
        assert!(!is_partial_output_name(output, ".trip.mp4.12.rendering.mp4.bak"));
        assert!(!is_partial_output_name(output, ".other.mp4.12.rendering.mp4"));
        assert!(!is_partial_output_name(output, ".trip.mp4.x12.rendering.mp4"));
    }

    #[test]
    fn removing_partial_outputs_keeps_every_other_file() {
        let root = temp_root("partial");
        let output = root.join("trip.mp4");
        for name in [".trip.mp4.12.rendering.mp4", "trip.mp4", "keep.mp4", ".trip.mp4.previous"] {
            fs::write(root.join(name), b"x").unwrap();
        }
        assert_eq!(remove_partial_outputs(&output), 1);
        assert!(!root.join(".trip.mp4.12.rendering.mp4").exists());
        for name in ["trip.mp4", "keep.mp4", ".trip.mp4.previous"] {
            assert!(root.join(name).exists(), "{name}");
        }
        let _ = fs::remove_dir_all(root);
    }
}
