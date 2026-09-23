//! Separate lazy workers keep long analysis/export away from project/library I/O.
//! All project mutations share the control lane; unknown commands fail before launch.
use crate::resident_service::ResidentService;
use serde_json::Value;
use std::{path::Path, sync::{atomic::AtomicBool, Mutex}, time::Duration};

#[derive(Debug, PartialEq, Eq)]
enum Lane { Control, Preparation, Analysis, Export }

fn policy(command: &str) -> Result<(Lane, Duration), String> {
    let (lane, seconds) = match command {
        "parse_project" | "read_project" | "write_project" | "read_recovery"
        | "write_recovery" | "clear_recovery" | "list_creative_library"
        | "resolve_creative_asset" | "list_installed_plugins"
        | "compile_plugin_tool" | "resolve_gpu_effect_bindings" | "read_workflow_profile"
        | "write_workflow_profile" => (Lane::Control, 60),
        "inspect_media" | "inspect_media_batch" => (Lane::Preparation, 120),
        "prepare_media" => (Lane::Preparation, 10 * 60),
        "stage_native_audio_preview" | "stage_native_audio_project" => (Lane::Preparation, 120),
        "analyze_smart_cut" | "transcribe_media" | "detect_scenes"
        | "analyze_motion_track" | "analyze_auto_roto" => (Lane::Analysis, 60 * 60),
        "render_project" | "render_native_effect_preview" | "batch_auto_edit_item" => (Lane::Export, 2 * 60 * 60),
        "check_update" => (Lane::Export, 60),
        "stage_update" => (Lane::Export, 30 * 60),
        _ => return Err(format!("Unknown service command; not submitted: {command}")),
    };
    Ok((lane, Duration::from_secs(seconds)))
}

#[derive(Default)]
pub struct ServicePool {
    control: ResidentService,
    preparation: ResidentService,
    analysis: ResidentService,
    export: ResidentService,
    previews: PreviewWorkers,
}

struct PreviewWorkers {
    hosts: [ResidentService; 2],
    busy: Mutex<[bool; 2]>,
}

impl Default for PreviewWorkers {
    fn default() -> Self {
        Self { hosts: std::array::from_fn(|_| ResidentService::for_preview()), busy: Mutex::new([false; 2]) }
    }
}

struct PreviewLease<'a> { workers: &'a PreviewWorkers, index: usize }
impl Drop for PreviewLease<'_> {
    fn drop(&mut self) {
        self.workers.busy.lock().unwrap_or_else(|error| error.into_inner())[self.index] = false;
    }
}

impl PreviewWorkers {
    // The UI's PreviewLimiter owns the two-active/two-queued FIFO. This layer
    // never introduces a second queue or admits more than two Node workers.
    fn acquire(&self) -> Result<PreviewLease<'_>, String> {
        let mut busy = self.busy.lock().map_err(|_| "Preview worker state invalid; request not submitted")?;
        let index = busy.iter().position(|value| !value)
            .ok_or("Preview workers busy; request not submitted")?;
        busy[index] = true;
        Ok(PreviewLease { workers: self, index })
    }
}

fn verify_product_response(host: &ResidentService, response: Value) -> Result<Value, String> {
    let artifact = response.get("serviceArtifact");
    if artifact.and_then(|value| value.get("schema")).and_then(Value::as_str) != Some("editkin.auto-roto-service-artifact/v1")
        || artifact.and_then(|value| value.get("kind")).and_then(Value::as_str) != Some("product")
        || artifact.and_then(|value| value.get("externalResearchRuntime")).and_then(Value::as_str) != Some("disabled") {
        host.shutdown();
        return Err("Resident service product artifact mismatch; admission closed".into());
    }
    Ok(response)
}

impl ServicePool {
    pub fn request(&self, node: &Path, service: &Path, command: &str, request: Value) -> Result<Value, String> {
        let (lane, timeout) = policy(command)?;
        if request.get("command").and_then(Value::as_str) != Some(command) {
            return Err("Service lane and payload command differ; not submitted".into());
        }
        let host = match lane {
            Lane::Control => &self.control,
            Lane::Preparation => &self.preparation,
            Lane::Analysis => &self.analysis,
            Lane::Export => &self.export,
        };
        let response = host.request(node, service, request, timeout)?;
        verify_product_response(host, response)
    }

    pub fn request_preview(&self, node: &Path, service: &Path, request: Value, cancel: &AtomicBool) -> Result<Value, String> {
        if request.get("command").and_then(Value::as_str) != Some("resolve_creative_preview") {
            return Err("Preview worker only accepts resolve_creative_preview; not submitted".into());
        }
        let lease = self.previews.acquire()?;
        let host = &self.previews.hosts[lease.index];
        let response = host.request_with_cancel(node, service, request, Duration::from_secs(15), Some(cancel))?;
        verify_product_response(host, response)
    }

    pub fn shutdown(&self) {
        // Shutdown is terminal and only acts on workers created by this pool.
        // Parallel cleanup keeps application exit bounded by one worker deadline.
        std::thread::scope(|scope| {
            for host in [&self.control, &self.preparation, &self.analysis, &self.export,
                &self.previews.hosts[0], &self.previews.hosts[1]] {
                scope.spawn(move || host.shutdown());
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn expensive_jobs_do_not_share_project_lane() {
        assert_eq!(policy("write_project").unwrap().0, Lane::Control);
        assert_eq!(policy("list_creative_library").unwrap().0, Lane::Control);
        assert_eq!(policy("prepare_media").unwrap().0, Lane::Preparation);
        assert_eq!(policy("analyze_auto_roto").unwrap().0, Lane::Analysis);
        assert_eq!(policy("render_project").unwrap().0, Lane::Export);
        assert!(policy("execute_shell").is_err());
        assert!(policy("resolve_creative_preview").is_err(), "preview must use its bounded dedicated workers");
    }
    #[test]
    fn resident_audio_catalog_is_admitted_on_preparation_lane() {
        for command in ["stage_native_audio_preview", "stage_native_audio_project"] {
            assert_eq!(policy(command).unwrap(), (Lane::Preparation, Duration::from_secs(120)));
        }
    }
    #[test]
    fn resident_audio_catalog_mismatched_payload_is_rejected_before_launch() {
        let pool = ServicePool::default();
        let result = pool.request(Path::new("absent"), Path::new("absent"),
            "stage_native_audio_project", serde_json::json!({"command":"render_project"}));
        assert!(result.unwrap_err().contains("differ"));
    }
    #[test]
    fn mismatched_dispatch_is_rejected_before_runtime_resolution() {
        let pool = ServicePool::default();
        let result = pool.request(Path::new("absent"), Path::new("absent"), "read_project", serde_json::json!({"command":"write_project"}));
        assert!(result.unwrap_err().contains("differ"));
    }

    #[test]
    fn preview_leases_are_bounded_and_reuse_the_free_host() {
        let workers = PreviewWorkers::default();
        let first = workers.acquire().unwrap();
        let second = workers.acquire().unwrap();
        assert_ne!(first.index, second.index);
        assert!(workers.acquire().is_err());
        let index = first.index;
        drop(first);
        assert_eq!(workers.acquire().unwrap().index, index);
        drop(second);
        assert_eq!(*workers.busy.lock().unwrap(), [false; 2]);
    }
}
