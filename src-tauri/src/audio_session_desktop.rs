//! Desktop admission and small UI projections for the resident audio owner.
//! One independent bounded worker; service staging and filesystem/device waits
//! never run on the WebView thread. Native sample telemetry is not a UI clock.
use crate::{
    audio_session_host::Action,
    audio_session_registry::AudioSessionRegistry,
    gpu_command_worker::{CommandResult, GpuCommandWorker, PeriodicOperation},
    preview_service_process,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::atomic::{AtomicBool, Ordering};
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

pub type EventSink = Box<dyn Fn(Value) -> Result<(), String> + Send>;
#[derive(Clone)]
pub struct Runtime {
    pub core: PathBuf,
    pub decoder: PathBuf,
    pub plans: PathBuf,
}
struct Entry {
    owner: u64,
    generation: u64,
    runtime: Runtime,
    stages: Vec<Stage>,
    clock: Option<Arc<crate::audio_session_host::clock::ResidentClock>>,
}
#[derive(Default)]
struct State {
    registry: AudioSessionRegistry,
    current: Option<Entry>,
}
pub struct DesktopAudio {
    worker: GpuCommandWorker,
    state: Arc<Mutex<State>>,
    active: Arc<AtomicBool>,
}
impl Default for DesktopAudio {
    fn default() -> Self {
        Self {
            worker: GpuCommandWorker::named("editkin-audio-dispatch"),
            state: Arc::default(),
            active: Arc::default(),
        }
    }
}

impl Drop for DesktopAudio {
    fn drop(&mut self) {
        // Also covers initialization failure/unwind, not only Tauri Exit.
        if !self.worker.shutdown_and_wait(Duration::from_secs(8)) {
            eprintln!("Audio desktop owner drop: worker cleanup remains unconfirmed");
        }
    }
}
fn hash_file(path: &Path, limit: u64) -> Result<(String, u64), String> {
    let mut file = fs::File::open(path).map_err(|e| e.to_string())?;
    let size = file.metadata().map_err(|e| e.to_string())?.len();
    if size == 0 || size > limit {
        return Err("Audio file exceeds declared byte bound".into());
    }
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 65536];
    let mut bytes = 0;
    loop {
        let n = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        bytes += n as u64;
        if bytes > limit {
            return Err("Audio file grew beyond bound".into());
        }
        hash.update(&buffer[..n]);
    }
    if bytes != size {
        return Err("Audio file changed during identity check".into());
    }
    Ok((format!("{:x}", hash.finalize()), bytes))
}
pub fn supports_catalog(value: &Value) -> bool {
    let a = &value["residentAudio"];
    value["schema"] == "editkin.engine-capabilities/v1"
        && value["engine"] == "hao-core"
        && a["commandSchema"] == "editkin.audio-session-command/v1"
        && a["eventSchema"] == "editkin.audio-session-event/v1"
        && a["planSchema"] == "editkin.audio-codec-stream-plan/v2"
        && a["sampleRate"] == 48000
        && a["maxCatalogSources"] == 4096
        && a["maxActiveSources"] == 16
        && a["physicalOutput"] == true
}
fn probe(core: &Path, cancel: &Arc<std::sync::atomic::AtomicBool>) -> Result<bool, String> {
    let output = preview_service_process::run(
        core,
        &["engine-capabilities".into()],
        Vec::new(),
        preview_service_process::Limits {
            execution: Duration::from_secs(5),
            cleanup: Duration::from_secs(2),
            max_input: 1,
            max_stdout: 16384,
            max_stderr: 16384,
        },
        cancel.clone(),
    )
    .map_err(|e| e.to_string())?;
    let value: Value = serde_json::from_slice(&output.stdout).map_err(|e| e.to_string())?;
    Ok(supports_catalog(&value))
}
/// Whitelist only. Private source paths, process IDs, stderr and DSP/decoder
/// diagnostics remain native-side even on an ended/error event.
pub fn public_status(raw: &Value) -> Value {
    let s = &raw["state"];
    let p = &s["playback"];
    let mut playback = serde_json::Map::new();
    for key in [
        "schema",
        "event",
        "streamGeneration",
        "state",
        "timelineStartFrame",
        "timelineFrame",
        "presentedFrame",
        "sampleMasterFrame",
        "sampleMasterRate",
        "clockQpc100ns",
        "deviceGeneration",
    ] {
        if let Some(v) = p.get(key) {
            playback.insert(key.into(), v.clone());
        }
    }
    json!({"schema":"editkin.desktop-audio-status/v1","ownerId":raw["ownerId"],"sequence":s["sequence"],
        "generation":s["generation"],"ready":s["ready"],"failed":s["failed"],"closing":s["closing"],
        "error":if s["failed"]==true{json!("原生音訊工作階段失敗；請停止後重試")}else{Value::Null},"playback":playback})
}
fn no_link(path: &Path) -> Result<(), String> {
    let meta = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if meta.file_type().is_symlink() {
        return Err("Audio stage links are forbidden".into());
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & 0x400 != 0 {
            return Err("Audio stage reparse points are forbidden".into());
        }
    }
    Ok(())
}
struct Stage {
    path: PathBuf,
    root: PathBuf,
    sha: String,
    public: Value,
}
impl Stage {
    fn validate(
        plans: &Path,
        value: &Value,
        generation: u64,
        project: &Value,
    ) -> Result<Self, String> {
        if value["schema"] != "editkin.native-audio-project-stage/v1"
            || value["status"] != "PREPARED"
            || value["generation"].as_u64() != Some(generation)
            || value["pcmStagingFiles"] != 0
            || value["projectId"] != project["id"]
            || value["projectRevision"] != project["revision"]
            || value["projectUpdatedAt"] != project["updatedAt"]
        {
            return Err("Audio stage/project identity mismatch".into());
        }
        let root = PathBuf::from(
            value["sessionRoot"]
                .as_str()
                .ok_or("Audio stage root missing")?,
        );
        let path = PathBuf::from(
            value["planPath"]
                .as_str()
                .ok_or("Audio stage path missing")?,
        );
        if !root.is_absolute()
            || root.parent() != Some(plans)
            || path != root.join("project-audio.json")
            || root.file_name().and_then(|v| v.to_str()).is_none_or(|v| {
                v.len() != 36 || !v.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
            })
            || value["managedPaths"] != json!([path])
        {
            return Err("Audio stage outside owned UUID directory".into());
        }
        for p in plans.ancestors() {
            no_link(p)?;
        }
        no_link(&root)?;
        no_link(&path)?;
        let (sha, bytes) = hash_file(&path, 4 * 1024 * 1024)?;
        if value["planSha256"] != sha || value["planBytes"] != bytes {
            return Err("Audio plan bytes/hash mismatch".into());
        }
        let start = value["startFrame"]
            .as_u64()
            .ok_or("Audio stage start missing")?;
        let count = value["frameCount"]
            .as_u64()
            .filter(|v| *v > 0)
            .ok_or("Audio stage range missing")?;
        if start.checked_add(count).is_none_or(|v| v > 4_147_200_000) {
            return Err("Audio stage exceeds 24 hours".into());
        }
        let mut public = serde_json::Map::new();
        for key in [
            "schema",
            "status",
            "projectId",
            "projectRevision",
            "projectUpdatedAt",
            "generation",
            "planSha256",
            "planBytes",
            "startFrame",
            "frameCount",
            "sourceCount",
            "peakActiveSources",
            "audioFingerprintSha256",
            "pcmStagingFiles",
        ] {
            public.insert(key.into(), value[key].clone());
        }
        Ok(Self {
            path,
            root,
            sha,
            public: Value::Object(public),
        })
    }
    fn remove(&self) -> Result<(), String> {
        for p in self.root.ancestors() {
            no_link(p)?;
        }
        no_link(&self.path)?;
        if hash_file(&self.path, 4 * 1024 * 1024)?.0 != self.sha {
            return Err("Changed stage retained".into());
        }
        fs::remove_file(&self.path).map_err(|e| e.to_string())?;
        // Empty generated UUID only. Never recurse through cache/user media.
        fs::remove_dir(&self.root).map_err(|e| e.to_string())
    }
}
fn close_state(state: &mut State, owner: u64) -> Result<Value, String> {
    let result = state.registry.close(owner)?; // ownership/actual tree closure first
    let entry = state
        .current
        .take()
        .ok_or("Audio entry missing after closure")?;
    let retained = entry
        .stages
        .iter()
        .filter(|stage| stage.remove().is_err())
        .count();
    Ok(json!({"ownerId":owner,"released":result["released"],"retainedStageFiles":retained}))
}
struct Lease {
    state: Arc<Mutex<State>>,
    owner: Option<u64>,
    active: Arc<AtomicBool>,
}
impl Drop for Lease {
    fn drop(&mut self) {
        if let Ok(mut s) = self.state.lock() {
            if let Some(owner) = self.owner {
                if s.current.as_ref().is_some_and(|e| e.owner == owner) {
                    let _ = close_state(&mut s, owner);
                }
            }
            if !s.registry.occupied() {
                self.active.store(false, Ordering::Release);
            }
        }
    }
}
impl DesktopAudio {
    pub fn is_active(&self) -> bool {
        self.active.load(Ordering::Acquire)
    }
    /// Read-only, owner-scoped diagnostic of the retained transport. Paused is
    /// not closed: legacy status cannot represent this owner or its clock.
    pub fn status(&self, owner: u64) -> Result<CommandResult, String> {
        let state = self.state.clone();
        self.worker.submit(move || {
            let s = state.lock().map_err(|_| "Audio desktop state poisoned")?;
            if !s.current.as_ref().is_some_and(|entry| entry.owner == owner) {
                return Err("Stale audio owner".into());
            }
            Ok(public_status(&s.registry.snapshot(owner)?))
        })
    }
    pub fn capabilities(&self, core: PathBuf) -> Result<CommandResult, String> {
        let cancel = self.worker.cancellation_flag();
        self.worker.submit(move || {
            Ok(json!({"schema":"editkin.desktop-audio-capabilities/v1",
            "supported":probe(&core,&cancel)?,"gpuClock":true,"clockSchema":crate::audio_session_host::clock::SCHEMA,"sampleRate":48000}))
        })
    }
    pub fn open(
        &self,
        runtime: Runtime,
        sink: EventSink,
        retire_legacy: impl FnOnce() -> Result<(), String> + Send + 'static,
    ) -> Result<CommandResult, String> {
        if self
            .active
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return Err("Audio owner already reserved".into());
        }
        let state = self.state.clone();
        let cancel = self.worker.cancellation_flag();
        let mut lease = Lease {
            state: state.clone(),
            owner: None,
            active: self.active.clone(),
        };
        self.worker.schedule(move || {
            retire_legacy()?;
            let mut s = state.lock().map_err(|_| "Audio desktop state poisoned")?;
            if s.current.is_some() {
                return Err("Close the existing audio owner before opening another".into());
            }
            if !probe(&runtime.core, &cancel)? {
                return Err("Installed core does not support resident audio catalog v2".into());
            }
            fs::create_dir_all(&runtime.plans).map_err(|e| e.to_string())?;
            for p in runtime.plans.ancestors() {
                no_link(p)?;
            }
            let decoder_sha = hash_file(&runtime.decoder, 256 * 1024 * 1024)?.0;
            let raw = s.registry.begin(
                &runtime.core,
                &runtime.decoder,
                &decoder_sha,
                &runtime.plans,
            )?;
            let owner = raw["ownerId"].as_u64().ok_or("Audio owner missing")?;
            s.current = Some(Entry {
                owner,
                generation: 0,
                runtime,
                stages: Vec::new(),
                clock: None,
            });
            drop(s);
            lease.owner = Some(owner);
            let mut last = None;
            let work: PeriodicOperation = Box::new(move || {
                let _keep = &lease;
                let raw = state.lock().ok()?.registry.snapshot(owner).ok()?;
                let sequence = raw["state"]["sequence"].as_u64();
                if sequence != last {
                    last = sequence;
                    if sink(public_status(&raw)).is_err() {
                        return None;
                    }
                }
                if raw["state"]["closing"] == true {
                    return None;
                }
                Some(Duration::from_millis(100))
            });
            Ok((json!({"ownerId":owner,"status":public_status(&raw)}), work))
        })
    }
    pub fn replace(
        &self,
        owner: u64,
        project: Value,
        stage: impl FnOnce(u64) -> Result<Value, String> + Send + 'static,
    ) -> Result<CommandResult, String> {
        let state = self.state.clone();
        self.worker.submit(move || {
            let mut s = state.lock().map_err(|_| "Audio desktop state poisoned")?;
            let e = s
                .current
                .as_mut()
                .filter(|e| e.owner == owner)
                .ok_or("Stale audio owner")?;
            if e.stages.len() >= 32 {
                return Err("Audio plan retention bound reached; close and reopen owner".into());
            }
            let previous = e.generation;
            e.generation += 1;
            let generation = e.generation;
            let root = e.runtime.plans.clone();
            if previous > 0 {
                s.registry.submit(owner, Action::Pause(previous))?;
                let deadline = Instant::now() + Duration::from_secs(2);
                loop {
                    let v = s.registry.snapshot(owner)?;
                    let p = &v["state"]["playback"];
                    if v["state"]["failed"] == true {
                        return Err("Audio pause failed before staging".into());
                    }
                    if matches!(p["state"].as_str(), Some("paused" | "ended")) {
                        break;
                    }
                    if Instant::now() >= deadline {
                        return Err("Audio did not pause before staging".into());
                    }
                    std::thread::sleep(Duration::from_millis(2));
                }
            }
            // Native decoding stays paused throughout service probing/hashing.
            let value = stage(generation)?;
            let owned = Stage::validate(&root, &value, generation, &project)?;
            let plan = s
                .registry
                .bind_plan(owner, &owned.path, &owned.sha, generation)?
                .with_clock(
                    value["startFrame"].as_u64().ok_or("Clock start missing")?,
                    value["frameCount"].as_u64().ok_or("Clock count missing")?,
                )?;
            let public = owned.public.clone();
            s.current.as_mut().unwrap().stages.push(owned);
            let clock = plan.clock();
            s.registry.submit(
                owner,
                Action::Replace {
                    plan,
                    autoplay: false,
                },
            )?;
            s.current.as_mut().unwrap().clock = clock;
            Ok(json!({"ownerId":owner,"generation":generation,"stage":public}))
        })
    }
    pub fn control(
        &self,
        owner: u64,
        generation: u64,
        playing: bool,
    ) -> Result<CommandResult, String> {
        let state = self.state.clone();
        self.worker.submit(move || {
            let s = state.lock().map_err(|_| "Audio desktop state poisoned")?;
            if !s
                .current
                .as_ref()
                .is_some_and(|e| e.owner == owner && e.generation == generation)
            {
                return Err("Stale audio stream".into());
            }
            s.registry.submit(
                owner,
                if playing {
                    Action::Resume(generation)
                } else {
                    Action::Pause(generation)
                },
            )
        })
    }
    pub fn close(&self, owner: u64) -> Result<CommandResult, String> {
        let state = self.state.clone();
        let active = self.active.clone();
        self.worker.submit(move || {
            let result = close_state(
                &mut *state.lock().map_err(|_| "Audio desktop state poisoned")?,
                owner,
            )?;
            active.store(false, Ordering::Release);
            Ok(result)
        })
    }
    /// A paused stream may emit no further events, so a dropped WebView
    /// channel cannot be its only lifetime signal. Navigation retires the old
    /// document's owner on the same worker, before new capability admission.
    pub fn retire_document(&self) -> Result<CommandResult, String> {
        let state = self.state.clone();
        let active = self.active.clone();
        self.worker.submit(move || {
            let mut s = state.lock().map_err(|_| "Audio desktop state poisoned")?;
            let result = if let Some(owner) = s.current.as_ref().map(|e| e.owner) {
                close_state(&mut s, owner)?
            } else {
                json!({"released":true,"retainedStageFiles":0})
            };
            active.store(false, Ordering::Release);
            Ok(result)
        })
    }
    pub fn shutdown(&self) -> bool {
        self.worker.shutdown_and_wait(Duration::from_secs(8))
    }
    /// Nonblocking binding lookup; frame sampling uses only the small clock
    /// mutex, never this filesystem/service/owner lock or a JSON snapshot.
    pub fn clock(
        &self,
        owner: u64,
        generation: u64,
    ) -> Result<Arc<crate::audio_session_host::clock::ResidentClock>, String> {
        let state = self
            .state
            .try_lock()
            .map_err(|_| "Audio clock binding is preparing")?;
        state
            .current
            .as_ref()
            .filter(|e| e.owner == owner && e.generation == generation)
            .and_then(|e| e.clock.clone())
            .ok_or("Stale or missing resident audio clock".into())
    }
}

#[cfg(test)]
#[path = "audio_session_desktop_tests.rs"]
mod tests;
