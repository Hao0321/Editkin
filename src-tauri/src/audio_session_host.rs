//! Desktop owner of the resident native audio process. Admission does no file
//! I/O and never waits for source preparation. A supervisor owns tree teardown;
//! pipe readers continue draining even when the UI makes no requests.
use crate::preview_process_platform::{self, Spawned};
#[path = "audio_session_clock.rs"]
pub mod clock;
#[path = "../../native/hao-core/src/engine/audio_session_protocol.rs"]
mod protocol;
use protocol::{
    COMMAND_SCHEMA, EVENT_SCHEMA, MAX_COMMAND_BYTES, MAX_EVENT_BYTES, MAX_SAFE_ID, PIPE_QUEUE,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    ffi::OsString,
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, SyncSender},
        Arc, Condvar, Mutex,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};
const HISTORY: usize = 64;
const GRACE: Duration = Duration::from_millis(3000);
const CLEANUP: Duration = Duration::from_millis(2500);
const TAIL: usize = 65536;

#[derive(Clone)]
pub struct PlanBinding {
    path: PathBuf,
    sha256: String,
    generation: u64,
    clock: Option<Arc<clock::ResidentClock>>,
}
impl PlanBinding {
    pub fn with_clock(mut self, start: u64, count: u64) -> Result<Self, String> {
        self.clock = Some(Arc::new(clock::ResidentClock::new(
            self.generation,
            start,
            count,
        )?));
        Ok(self)
    }
    pub fn clock(&self) -> Option<Arc<clock::ResidentClock>> {
        self.clock.clone()
    }
}
pub enum Action {
    Replace { plan: PlanBinding, autoplay: bool },
    Pause(u64),
    Resume(u64),
    Snapshot,
    Close,
}
#[derive(Clone, Copy)]
struct Pending {
    op: &'static str,
    generation: Option<u64>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Envelope {
    schema: String,
    event: String,
    request_id: u64,
    generation: u64,
    data: Value,
}

#[derive(Default)]
struct State {
    next: u64,
    sequence: u64,
    ready: bool,
    closing: Option<Instant>,
    native_closed: bool,
    active: u64,
    max_generation: u64,
    pending: BTreeMap<u64, Pending>,
    generations: BTreeSet<u64>,
    latest: Option<Value>,
    history: VecDeque<(u64, Value)>,
    failure: Option<String>,
    cleanup: Option<Value>,
    clock: Option<Arc<clock::ResidentClock>>,
}
#[derive(Default)]
struct Shared {
    state: Mutex<State>,
    changed: Condvar,
    stop: AtomicBool,
    io_stop: AtomicBool,
}
impl Shared {
    fn fail(&self, reason: impl Into<String>) {
        let mut s = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if s.failure.is_none() {
            s.failure = Some(reason.into());
        }
        if let Some(clock) = &s.clock {
            clock.retire();
        }
        self.changed.notify_all();
    }
    fn accept(&self, bytes: &[u8]) -> Result<(), String> {
        let e: Envelope =
            serde_json::from_slice(bytes).map_err(|_| "Invalid native audio event envelope")?;
        if e.schema != EVENT_SCHEMA || e.request_id > MAX_SAFE_ID || e.generation > MAX_SAFE_ID {
            return Err("Native audio event schema/identity invalid".into());
        }
        let mut s = self
            .state
            .lock()
            .map_err(|_| "Audio broker state poisoned")?;
        // Validate transactionally without cloning the bounded diagnostic history.
        let mut admitted = State {
            next: s.next,
            sequence: s.sequence,
            ready: s.ready,
            closing: s.closing,
            native_closed: s.native_closed,
            active: s.active,
            max_generation: s.max_generation,
            pending: s.pending.clone(),
            generations: s.generations.clone(),
            latest: s.latest.clone(),
            failure: s.failure.clone(),
            cleanup: s.cleanup.clone(),
            clock: s.clock.clone(),
            history: VecDeque::new(),
        };
        admit(&mut admitted, &e)?;
        if let Some(clock) = &admitted.clock {
            if !clock.is_retired()
                && e.generation == clock.generation
                && matches!(
                    e.event.as_str(),
                    "loading"
                        | "prepared"
                        | "started"
                        | "progress"
                        | "paused"
                        | "resumed"
                        | "snapshot"
                        | "ended"
                )
            {
                clock.admit(&e.data)?;
            }
            if matches!(
                e.event.as_str(),
                "failed" | "closed" | "session-failed" | "session-closed"
            ) {
                clock.retire();
            }
        }
        let value = serde_json::to_value(e).map_err(|e| e.to_string())?;
        admitted.history = std::mem::take(&mut s.history);
        *s = admitted;
        s.sequence += 1;
        let seq = s.sequence;
        s.history.push_back((seq, value));
        while s.history.len() > HISTORY {
            s.history.pop_front();
        }
        self.changed.notify_all();
        Ok(())
    }
}
fn admit(s: &mut State, e: &Envelope) -> Result<(), String> {
    let kind = e.event.as_str();
    let playback = matches!(
        kind,
        "ready"
            | "loading"
            | "prepared"
            | "started"
            | "progress"
            | "paused"
            | "resumed"
            | "snapshot"
            | "ended"
            | "failed"
            | "closed"
    );
    if !playback
        && !matches!(
            kind,
            "preparing"
                | "queued"
                | "superseded"
                | "prepare-failed"
                | "pause-pending"
                | "resume-pending"
                | "rejected"
                | "decoder-closed"
                | "session-closed"
                | "session-failed"
        )
    {
        return Err("Unknown native audio event kind".into());
    }
    if s.native_closed {
        return Err("Native audio event after terminal close".into());
    }
    if kind == "ready" {
        if s.ready || e.request_id != 0 || e.generation != 0 || e.data["decoderIdentityChecks"] != 1
        {
            return Err("Native audio ready identity invalid".into());
        }
        s.ready = true;
    } else if !s.ready {
        return Err("Native audio event before ready".into());
    }
    let pending = if e.request_id == 0 {
        if !matches!(kind, "ready" | "decoder-closed" | "session-failed") {
            return Err("Uncorrelated native audio event".into());
        }
        None
    } else {
        Some(
            *s.pending
                .get(&e.request_id)
                .ok_or("Unknown/retired audio request ID")?,
        )
    };
    if let Some(p) = pending {
        let allowed = match p.op {
            "replace" => matches!(
                kind,
                "preparing"
                    | "queued"
                    | "superseded"
                    | "prepare-failed"
                    | "loading"
                    | "prepared"
                    | "started"
                    | "progress"
                    | "ended"
                    | "failed"
                    | "rejected"
            ),
            "pause" => matches!(kind, "paused" | "pause-pending" | "rejected"),
            "resume" => matches!(kind, "resumed" | "resume-pending" | "rejected"),
            "snapshot" => kind == "snapshot",
            "close" => matches!(kind, "closed" | "session-closed"),
            _ => false,
        };
        if !allowed || (kind != "rejected" && p.generation.is_some_and(|g| g != e.generation)) {
            return Err("Native audio command/generation correlation mismatch".into());
        }
    }
    if playback {
        if e.data["schema"] != "editkin.native-audio-session-event/v1"
            || e.data["event"] != kind
            || e.data["streamGeneration"].as_u64() != Some(e.generation)
            || e.data["sampleMasterRate"] != 48000
        {
            return Err("Native audio playback identity invalid".into());
        }
        let number = |key: &str| {
            e.data[key]
                .as_u64()
                .filter(|v| *v <= MAX_SAFE_ID)
                .ok_or("Native audio numeric clock invalid")
        };
        let presented = number("presentedFrame")?;
        let submitted = number("sampleMasterFrame")?;
        if presented > submitted
            || number("timelineStartFrame")?.checked_add(presented)
                != Some(number("timelineFrame")?)
            || number("deviceGeneration")? == 0
            || !matches!(
                e.data["state"].as_str(),
                Some("idle" | "preparing" | "playing" | "paused" | "ended")
            )
        {
            return Err("Native audio clock/state fields inconsistent".into());
        }
        number("clockQpc100ns")?;
        number("callbackCount")?;
        if kind == "loading" {
            if e.generation <= s.active {
                return Err("Native audio loading generation regressed".into());
            }
            s.active = e.generation;
        } else if !matches!(kind, "ready" | "closed" | "failed") && e.generation != s.active {
            return Err("Native audio active generation mismatch".into());
        }
        if !matches!(kind, "ready" | "closed" | "failed") {
            s.latest = Some(e.data.clone());
        }
    }
    if kind == "decoder-closed" {
        if !s.generations.remove(&e.generation) {
            return Err("Unowned decoder closure generation".into());
        }
        let rows = e.data["decoders"]
            .as_array()
            .ok_or("Native decoder closure missing")?;
        if rows.iter().any(|d| {
            d["treeClosed"] != true
                || d["pipeThreadsClosed"] != true
                || !d["cleanupError"].is_null()
        }) {
            return Err("Native decoder closure incomplete".into());
        }
        s.pending
            .retain(|_, p| p.op != "replace" || p.generation != Some(e.generation));
    }
    if matches!(kind, "superseded" | "prepare-failed") {
        s.generations.remove(&e.generation);
    }
    if let Some(p) = pending {
        if (p.op == "replace"
            && matches!(
                kind,
                "superseded" | "prepare-failed" | "ended" | "failed" | "rejected"
            ))
            || (p.op == "close" && kind == "session-closed")
            || (!matches!(p.op, "replace" | "close"))
        {
            s.pending.remove(&e.request_id);
        }
    }
    if kind == "session-closed" {
        if s.closing.is_none() || e.generation != 0 {
            return Err("Unrequested native audio close".into());
        }
        s.native_closed = true;
    }
    if matches!(kind, "failed" | "session-failed") {
        s.failure = Some(
            "Native audio session reported failure; private diagnostics retained locally".into(),
        );
    }
    Ok(())
}

pub struct AudioSessionHost {
    plan_root: PathBuf,
    input: SyncSender<Vec<u8>>,
    shared: Arc<Shared>,
    worker: Option<JoinHandle<()>>,
    pid: u32,
}
impl AudioSessionHost {
    /// Call from a desktop background worker. The caller must retain this owner
    /// through startup failure until cleanup_confirmed(), not launch a sibling.
    pub fn launch(
        core: &Path,
        decoder: &Path,
        decoder_sha: &str,
        plan_root: &Path,
    ) -> Result<Self, String> {
        if !protocol::local_absolute(plan_root)
            || !protocol::local_absolute(decoder)
            || !protocol::valid_sha(decoder_sha)
        {
            return Err("Invalid resident audio runtime binding".into());
        }
        let plan_root = std::fs::canonicalize(plan_root).map_err(|e| e.to_string())?;
        if !plan_root.is_dir() {
            return Err("Audio plan root is not a directory".into());
        }
        let args = vec![
            OsString::from("audio-session-server"),
            plan_root.as_os_str().to_owned(),
            decoder.as_os_str().to_owned(),
            decoder_sha.into(),
        ];
        let spawned = preview_process_platform::spawn(core, &args)
            .map_err(|e| format!("Owned audio launch failed: {e}"))?;
        let pid = spawned.process.id();
        let shared = Arc::new(Shared::default());
        let (input, commands) = mpsc::sync_channel(PIPE_QUEUE);
        let target = shared.clone();
        // If thread creation fails, Spawned drops the job guard and all pipes.
        let worker = thread::Builder::new()
            .name("editkin-audio-owner".into())
            .spawn(move || supervise(spawned, commands, target))
            .map_err(|e| e.to_string())?;
        Ok(Self {
            plan_root,
            input,
            shared,
            worker: Some(worker),
            pid,
        })
    }
    /// File-system work is explicit and separate from command admission. A
    /// binding from another session cannot be submitted to this owner.
    pub fn bind_plan(
        &self,
        path: &Path,
        sha256: &str,
        generation: u64,
    ) -> Result<PlanBinding, String> {
        if !protocol::local_absolute(path)
            || !protocol::valid_sha(sha256)
            || generation == 0
            || generation > MAX_SAFE_ID
        {
            return Err("Invalid audio plan binding".into());
        }
        let path = std::fs::canonicalize(path).map_err(|e| e.to_string())?;
        if !path.starts_with(&self.plan_root) || path == self.plan_root || !path.is_file() {
            return Err("Audio plan escaped owner directory".into());
        }
        Ok(PlanBinding {
            path,
            sha256: sha256.into(),
            generation,
            clock: None,
        })
    }
    pub fn submit(&self, action: Action) -> Result<u64, String> {
        let next_clock = match &action {
            Action::Replace { plan, .. } => Some(plan.clock.clone()),
            _ => None,
        };
        let mut s = self
            .shared
            .state
            .lock()
            .map_err(|_| "Audio broker state poisoned")?;
        if !s.ready || s.failure.is_some() || s.cleanup.is_some() || s.closing.is_some() {
            return Err("Audio owner not accepting commands".into());
        }
        if s.pending.len() >= 128 {
            return Err("Audio command correlation capacity exceeded".into());
        }
        let id = s
            .next
            .checked_add(1)
            .filter(|n| *n <= MAX_SAFE_ID)
            .ok_or("Audio sequence exhausted")?;
        let mut value = json!({"schema":COMMAND_SCHEMA,"requestId":id});
        let pending = match action {
            Action::Replace { plan, autoplay } => {
                if !plan.path.starts_with(&self.plan_root) {
                    return Err("Audio plan belongs to another owner".into());
                }
                if plan.generation <= s.max_generation {
                    return Err("Audio plan generation is stale; not queued".into());
                }
                value["op"] = "replace".into();
                value["generation"] = plan.generation.into();
                value["planPath"] = json!(plan.path);
                value["planSha256"] = plan.sha256.into();
                value["autoplay"] = autoplay.into();
                Pending {
                    op: "replace",
                    generation: Some(plan.generation),
                }
            }
            Action::Pause(g) | Action::Resume(g) => {
                let op = if matches!(action, Action::Pause(_)) {
                    "pause"
                } else {
                    "resume"
                };
                value["op"] = op.into();
                value["generation"] = g.into();
                Pending {
                    op,
                    generation: Some(g),
                }
            }
            Action::Snapshot => {
                value["op"] = "snapshot".into();
                Pending {
                    op: "snapshot",
                    generation: None,
                }
            }
            Action::Close => {
                value["op"] = "close".into();
                Pending {
                    op: "close",
                    generation: None,
                }
            }
        };
        let mut bytes = serde_json::to_vec(&value).map_err(|e| e.to_string())?;
        if bytes.len() > MAX_COMMAND_BYTES {
            return Err("Audio command exceeds wire budget".into());
        }
        bytes.push(b'\n');
        protocol::Lines::default().push(&bytes, |_| Ok(()))?;
        // Hold state through queue admission so a fast reply cannot overtake its
        // correlation registration. There is no pipe write under this lock.
        self.input
            .try_send(bytes)
            .map_err(|_| "Audio command queue full/disconnected")?;
        s.next = id;
        s.pending.insert(id, pending);
        if let Some(next) = next_clock {
            if let Some(old) = s.clock.take() {
                old.retire();
            }
            s.clock = next;
        }
        if pending.op == "replace" {
            s.max_generation = pending.generation.unwrap();
            s.generations.insert(pending.generation.unwrap());
        }
        if pending.op == "close" {
            s.closing = Some(Instant::now());
        }
        Ok(id)
    }
    pub fn wait_ready(&self, timeout: Duration) -> Result<(), String> {
        if timeout > Duration::from_secs(5) {
            return Err("Audio readiness deadline exceeds 5 seconds".into());
        }
        let deadline = Instant::now() + timeout;
        let mut s = self
            .shared
            .state
            .lock()
            .map_err(|_| "Audio state poisoned")?;
        loop {
            if let Some(e) = &s.failure {
                return Err(e.clone());
            }
            if s.ready {
                return Ok(());
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                drop(s);
                self.shared.fail("Audio native readiness timed out");
                return Err("Audio native readiness timed out".into());
            }
            s = self
                .shared
                .changed
                .wait_timeout(s, remaining)
                .map_err(|_| "Audio readiness wait poisoned")?
                .0;
        }
    }
    pub fn snapshot(&self) -> Result<Value, String> {
        let s = self
            .shared
            .state
            .lock()
            .map_err(|_| "Audio state poisoned")?;
        Ok(
            json!({"schema":"editkin.desktop-audio-owner/v1","pid":self.pid,"ready":s.ready,"closing":s.closing.is_some(),"sequence":s.sequence,
            "generation":s.active,"playback":s.latest,"failed":s.failure.is_some(),"error":s.failure,"cleanup":s.cleanup}),
        )
    }
    pub fn cleanup_confirmed(&self) -> bool {
        self.shared
            .state
            .lock()
            .ok()
            .and_then(|s| s.cleanup.clone())
            .is_some_and(|v| v["treeEmpty"] == true && v["ioJoined"] == true)
            && self.worker.as_ref().is_none_or(JoinHandle::is_finished)
    }
    pub fn close(&mut self) -> Result<Value, String> {
        {
            let s = self
                .shared
                .state
                .lock()
                .map_err(|_| "Audio state poisoned")?;
            if let Some(clock) = &s.clock {
                clock.retire();
            }
            if s.ready && s.closing.is_none() && s.failure.is_none() && s.cleanup.is_none() {
                drop(s);
                if self.submit(Action::Close).is_err() {
                    self.shared.stop.store(true, Ordering::Release);
                }
            }
        }
        if !self
            .shared
            .state
            .lock()
            .map_err(|_| "Audio state poisoned")?
            .ready
        {
            self.shared.stop.store(true, Ordering::Release);
        }
        let deadline = Instant::now() + GRACE + CLEANUP + Duration::from_millis(500);
        while self.worker.as_ref().is_some_and(|h| !h.is_finished()) {
            if Instant::now() >= deadline {
                self.shared.stop.store(true, Ordering::Release);
                return Err("Audio supervisor join unconfirmed; replacement blocked".into());
            }
            thread::sleep(Duration::from_millis(2));
        }
        if let Some(h) = self.worker.take() {
            h.join().map_err(|_| "Audio supervisor panicked")?;
        }
        let mut receipt = self.snapshot()?;
        receipt["supervisorJoined"] = true.into();
        if !self.cleanup_confirmed() {
            return Err("Audio tree/pipe cleanup unconfirmed; replacement blocked".into());
        }
        Ok(receipt)
    }
    #[cfg(test)]
    fn events(&self) -> Vec<Value> {
        self.shared
            .state
            .lock()
            .unwrap()
            .history
            .iter()
            .map(|(_, v)| v.clone())
            .collect()
    }
}
impl Drop for AudioSessionHost {
    fn drop(&mut self) {
        self.shared.stop.store(true, Ordering::Release);
        let _ = self.close();
    }
}
fn supervise(spawned: Spawned, commands: mpsc::Receiver<Vec<u8>>, shared: Arc<Shared>) {
    let Spawned {
        mut process,
        mut stdin,
        stdout,
        mut stderr,
    } = spawned;
    let mut workers = Vec::new();
    let tail = Arc::new(Mutex::new(VecDeque::<u8>::new()));
    let input_shared = shared.clone();
    let input = thread::Builder::new()
        .name("editkin-audio-input".into())
        .spawn(move || {
            while !input_shared.io_stop.load(Ordering::Acquire) {
                match commands.recv_timeout(Duration::from_millis(10)) {
                    Ok(bytes) => {
                        if stdin.write_all(&bytes).and_then(|_| stdin.flush()).is_err() {
                            input_shared.fail("Native audio command pipe failed");
                            break;
                        }
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                }
            }
        });
    match input {
        Ok(h) => workers.push(h),
        Err(_) => shared.fail("Audio input worker creation failed"),
    };
    let output_shared = shared.clone();
    let output = thread::Builder::new()
        .name("editkin-audio-output".into())
        .spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                let mut bytes = Vec::new();
                let n = Read::by_ref(&mut reader)
                    .take((MAX_EVENT_BYTES + 2) as u64)
                    .read_until(b'\n', &mut bytes);
                let result = match n {
                    Ok(0) => {
                        let s = output_shared
                            .state
                            .lock()
                            .unwrap_or_else(|e| e.into_inner());
                        if !s.native_closed && !output_shared.io_stop.load(Ordering::Acquire) {
                            drop(s);
                            output_shared.fail("Native audio event pipe ended before close");
                        }
                        break;
                    }
                    Ok(n) if n > MAX_EVENT_BYTES + 1 || bytes.last() != Some(&b'\n') => {
                        Err("Native audio event exceeds budget or is truncated".into())
                    }
                    Ok(_) => output_shared.accept(&bytes),
                    Err(_) => Err("Native audio event pipe read failed".into()),
                };
                if let Err(e) = result {
                    output_shared.fail(e);
                    break;
                }
            }
        });
    match output {
        Ok(h) => workers.push(h),
        Err(_) => shared.fail("Audio output worker creation failed"),
    };
    let stderr_shared = shared.clone();
    let stderr_tail = tail.clone();
    let errors = thread::Builder::new()
        .name("editkin-audio-stderr".into())
        .spawn(move || {
            let mut bytes = [0; 4096];
            loop {
                match stderr.read(&mut bytes) {
                    Ok(0) => break,
                    Ok(n) => {
                        let mut t = stderr_tail.lock().unwrap_or_else(|e| e.into_inner());
                        t.extend(&bytes[..n]);
                        let excess = t.len().saturating_sub(TAIL);
                        t.drain(..excess);
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
                    Err(_) => {
                        stderr_shared.fail("Native audio diagnostic pipe failed");
                        break;
                    }
                }
            }
        });
    match errors {
        Ok(h) => workers.push(h),
        Err(_) => shared.fail("Audio stderr worker creation failed"),
    };
    let mut code = None;
    let mut forced = false;
    loop {
        match process.try_wait() {
            Ok(Some(c)) => {
                code = Some(c);
                break;
            }
            Ok(None) => {}
            Err(_) => {
                shared.fail("Audio owned process wait failed");
                break;
            }
        }
        let s = shared.state.lock().unwrap_or_else(|e| e.into_inner());
        let stop = shared.stop.load(Ordering::Acquire) || s.failure.is_some();
        let expired = s.closing.is_some_and(|t| t.elapsed() >= GRACE);
        drop(s);
        if stop || expired {
            forced = true;
            if expired {
                shared.fail("Native audio close deadline exceeded");
            }
            break;
        }
        thread::sleep(Duration::from_millis(2));
    }
    shared.io_stop.store(true, Ordering::Release);
    if process.terminate_tree().is_err() {
        shared.fail("Audio owned tree termination failed");
    }
    let deadline = Instant::now() + CLEANUP;
    let mut tree_empty = false;
    loop {
        if let Ok(Some(c)) = process.try_wait() {
            code = Some(c);
        }
        if let Ok(empty) = process.tree_is_empty() {
            tree_empty = empty;
        }
        if code.is_some() && tree_empty && workers.iter().all(JoinHandle::is_finished) {
            break;
        }
        if Instant::now() >= deadline {
            break;
        }
        thread::sleep(Duration::from_millis(2));
    }
    let mut io_joined = workers.len() == 3 && workers.iter().all(JoinHandle::is_finished);
    for h in workers {
        if h.is_finished() {
            if h.join().is_err() {
                io_joined = false;
            }
        }
    }
    let bytes = tail
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .iter()
        .copied()
        .collect::<Vec<_>>();
    let native_cleanup = String::from_utf8_lossy(&bytes)
        .lines()
        .filter_map(|l| l.strip_prefix("AUDIO_SESSION_IPC_CLEANUP "))
        .filter_map(|v| serde_json::from_str::<Value>(v).ok())
        .last();
    let native_success = native_cleanup.as_ref().is_some_and(|c| {
        c["success"] == true
            && [
                "inputWorkerJoined",
                "prepareWorkerJoined",
                "deviceWorkerJoined",
                "outputWorkerJoined",
            ]
            .iter()
            .all(|k| c[*k] == true)
    });
    let mut s = shared.state.lock().unwrap_or_else(|e| e.into_inner());
    let graceful = !forced
        && code == Some(0)
        && s.native_closed
        && native_success
        && tree_empty
        && io_joined
        && s.failure.is_none();
    if !graceful && s.failure.is_none() {
        s.failure = Some("Audio owner closed without a successful native closure receipt".into());
    }
    s.cleanup = Some(
        json!({"exitCode":code,"forced":forced,"treeEmpty":tree_empty,"ioJoined":io_joined,"nativeClosureVerified":native_success,"graceful":graceful,"stderrBytes":bytes.len()}),
    );
    if let Some(clock) = &s.clock {
        clock.retire();
    }
    shared.changed.notify_all();
}

#[cfg(test)]
#[path = "audio_session_host_tests.rs"]
mod tests;
