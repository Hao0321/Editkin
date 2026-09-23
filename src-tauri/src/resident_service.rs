//! A bounded, owned resident Node service. Only commands cross this boundary;
//! native playback timing must not use this request/response queue.
//!
//! Each host serializes requests. A timeout covers admission, startup and I/O,
//! followed by at most CLEANUP_TIMEOUT to prove that its owned process tree is
//! gone. Once bytes have been queued, a failed request is never replayed: its
//! mutation outcome is unknown. A later caller may start a fresh generation.
use crate::preview_process_platform::{self, OwnedProcess};
use serde_json::{json, Value};
use std::{
    collections::VecDeque,
    ffi::OsString,
    fs,
    io::{self, BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc::{self, Receiver, SyncSender},
        Arc, Condvar, Mutex, MutexGuard,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant, SystemTime},
};

const SCHEMA: &str = "editkin.service-stream/v1";
const MAX_REQUEST: usize = 16 * 1024 * 1024;
const MAX_RESPONSE: usize = 32 * 1024 * 1024;
const MAX_ADMITTED: usize = 32;
const MAX_STDERR: usize = 64 * 1024;
const CLEANUP_TIMEOUT: Duration = Duration::from_secs(2);
const POLL: Duration = Duration::from_millis(20);

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    // No caller-provided code runs while these internal locks are held.
    mutex.lock().unwrap_or_else(|poison| poison.into_inner())
}

#[derive(Default)]
struct Admission {
    count: usize,
    active: bool,
}

/// Use independent hosts for interactive control, media analysis and rendering.
/// `shutdown` is terminal; requests after it fail without starting a process.
pub struct ResidentService {
    admission: Mutex<Admission>,
    available: Condvar,
    closed: AtomicBool,
    generation: AtomicU64,
    worker: Mutex<Option<Arc<Worker>>>,
    cleanup_failure: Mutex<Option<String>>,
    max_request: usize,
    max_response: usize,
}

impl Default for ResidentService {
    fn default() -> Self {
        Self {
            admission: Mutex::new(Admission::default()), available: Condvar::new(),
            closed: AtomicBool::new(false), generation: AtomicU64::new(0),
            worker: Mutex::new(None), cleanup_failure: Mutex::new(None),
            max_request: MAX_REQUEST, max_response: MAX_RESPONSE,
        }
    }
}

fn canceled(cancel: Option<&AtomicBool>) -> bool {
    cancel.is_some_and(|token| token.load(Ordering::Acquire))
}

struct Permit<'a>(&'a ResidentService);
impl Drop for Permit<'_> {
    fn drop(&mut self) {
        let mut state = lock(&self.0.admission);
        state.active = false;
        state.count -= 1;
        self.0.available.notify_all();
    }
}

impl ResidentService {
    pub fn for_preview() -> Self {
        let mut host = Self::default();
        host.max_request = 65_536;
        host.max_response = 1_048_576;
        host
    }

    fn admit(&self, deadline: Instant, cancel: Option<&AtomicBool>) -> Result<Permit<'_>, String> {
        let mut state = lock(&self.admission);
        if self.closed.load(Ordering::Acquire) {
            return Err("Resident service is shut down; request was not submitted".into());
        }
        if state.count >= MAX_ADMITTED {
            return Err("Resident service queue is full (32); request was not submitted".into());
        }
        state.count += 1;
        loop {
            let failure = if self.closed.load(Ordering::Acquire) {
                Some("Resident service is shut down; request was not submitted")
            } else if canceled(cancel) {
                Some("Resident service canceled; request was not submitted")
            } else if Instant::now() >= deadline {
                Some("Resident service queue deadline exceeded; request was not submitted")
            } else {
                None
            };
            if let Some(error) = failure {
                state.count -= 1;
                return Err(error.into());
            }
            if !state.active {
                state.active = true;
                return Ok(Permit(self));
            }
            state = self
                .available
                .wait_timeout(state, if cancel.is_some() {
                    deadline.saturating_duration_since(Instant::now()).min(POLL)
                } else { deadline.saturating_duration_since(Instant::now()) })
                .unwrap_or_else(|poison| poison.into_inner())
                .0;
        }
    }

    /// Returns the complete service response envelope, including `ok:false`
    /// command rejections. Err means transport/lifecycle failure, not a command
    /// rejection. The caller remains responsible for checking serviceArtifact.
    pub fn request(
        &self,
        node: &Path,
        service: &Path,
        request: Value,
        timeout: Duration,
    ) -> Result<Value, String> {
        self.request_with_cancel(node, service, request, timeout, None)
    }

    pub fn request_with_cancel(
        &self, node: &Path, service: &Path, request: Value,
        timeout: Duration, cancel: Option<&AtomicBool>,
    ) -> Result<Value, String> {
        let deadline = Instant::now()
            .checked_add(timeout)
            .ok_or("Resident service timeout is outside supported range")?;
        let _permit = self.admit(deadline, cancel)?;
        if let Some(error) = lock(&self.cleanup_failure).as_ref() {
            return Err(format!("Resident service cleanup is unconfirmed; admission closed: {error}"));
        }
        let identity = RuntimeIdentity::read(node, service)?;
        // Serialization is bounded before any worker receives request bytes.
        let sequence = self.generation.fetch_add(1, Ordering::AcqRel) + 1;
        let id = format!("{}:{sequence}", std::process::id());
        let mut frame = LimitedBytes(Vec::new(), self.max_request);
        serde_json::to_writer(&mut frame, &json!({"schema": SCHEMA, "id": id, "request": request}))
            .map_err(|error| format!("Resident request exceeds limit or is invalid; not submitted: {error}"))?;
        frame.0.push(b'\n');

        let existing = lock(&self.worker).clone();
        if let Some(worker) = existing.as_ref() {
            let reuse = worker.identity == identity && worker.is_alive()?;
            if !reuse {
                self.retire(worker)?;
            }
        }
        if self.closed.load(Ordering::Acquire) || canceled(cancel) || Instant::now() >= deadline {
            return Err("Resident service canceled or deadline exceeded; request was not submitted".into());
        }
        let current = lock(&self.worker).clone();
        let worker = match current {
            Some(worker) => worker,
            None => {
                let worker = Worker::spawn(identity, sequence, self.max_response)?;
                // Publish before readiness wait, so shutdown can cancel startup.
                {
                    let mut slot = lock(&self.worker);
                    if self.closed.load(Ordering::Acquire) {
                        drop(slot);
                        self.stop_worker(&worker)?;
                        return Err("Resident service shut down during startup; not submitted".into());
                    }
                    *slot = Some(worker.clone());
                }
                if let Err(error) = worker.ready(deadline, cancel) {
                    let cleanup = self.retire(&worker);
                    return Err(combine(error, cleanup, false));
                }
                worker
            }
        };
        // Recheck between startup and submit. A worker never accepts a request
        // after shutdown or a failed startup belonging to another generation.
        if self.closed.load(Ordering::Acquire) || canceled(cancel) || Instant::now() >= deadline {
            return Err("Resident service canceled or deadline exceeded; request was not submitted".into());
        }
        let exchange = worker.exchange(&id, frame.0, deadline, cancel);
        match exchange {
            Ok(response) => Ok(response),
            Err(error) => {
                let cleanup = self.retire(&worker);
                Err(combine(error, cleanup, true))
            }
        }
    }

    fn stop_worker(&self, worker: &Worker) -> Result<(), String> {
        let result = worker.stop();
        if let Err(error) = &result {
            *lock(&self.cleanup_failure) = Some(error.clone());
        }
        result
    }

    fn retire(&self, worker: &Arc<Worker>) -> Result<(), String> {
        // Never discard ownership or allow a replacement until cleanup passes.
        self.stop_worker(worker)?;
        let mut slot = lock(&self.worker);
        if slot.as_ref().is_some_and(|current| current.generation == worker.generation) {
            *slot = None;
        }
        Ok(())
    }

    pub fn shutdown(&self) {
        self.closed.store(true, Ordering::Release);
        self.available.notify_all();
        let worker = lock(&self.worker).clone();
        if let Some(worker) = worker {
            let _ = self.retire(&worker);
        }
    }
}

impl Drop for ResidentService {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn combine(error: String, cleanup: Result<(), String>, attempted: bool) -> String {
    let outcome = if attempted {
        "request outcome unknown; request was not replayed"
    } else {
        "request was not submitted"
    };
    match cleanup {
        Ok(()) => format!("{error}; {outcome}; owned worker cleanup confirmed"),
        Err(cleanup) => format!("{error}; {outcome}; cleanup unconfirmed: {cleanup}"),
    }
}

#[derive(PartialEq, Eq)]
struct FileIdentity {
    path: PathBuf,
    size: u64,
    modified: SystemTime,
}

impl FileIdentity {
    fn read(path: &Path) -> Result<Self, String> {
        if !path.is_absolute() {
            return Err("Resident runtime requires absolute executable and service paths".into());
        }
        let path = fs::canonicalize(path).map_err(|error| format!("Resident runtime path: {error}"))?;
        let metadata = fs::metadata(&path).map_err(|error| error.to_string())?;
        if !metadata.is_file() {
            return Err("Resident runtime path is not a file".into());
        }
        Ok(Self {
            path,
            size: metadata.len(),
            modified: metadata.modified().map_err(|error| error.to_string())?,
        })
    }
}

#[derive(PartialEq, Eq)]
struct RuntimeIdentity {
    node: FileIdentity,
    service: FileIdentity,
}

impl RuntimeIdentity {
    fn read(node: &Path, service: &Path) -> Result<Self, String> {
        Ok(Self { node: FileIdentity::read(node)?, service: FileIdentity::read(service)? })
    }
}

fn node_script_argument(path: &Path) -> Result<OsString, String> {
    #[cfg(windows)]
    {
        // Node's ESM entrypoint resolver rejects Rust's verbatim drive prefix.
        // Convert only supported disk/UNC prefixes and recheck file identity.
        use std::path::{Component, Prefix};
        let mut components = path.components();
        let mut ordinary = match components.next() {
            Some(Component::Prefix(prefix)) => match prefix.kind() {
                Prefix::VerbatimDisk(drive) => PathBuf::from(format!("{}:", char::from(drive))),
                Prefix::VerbatimUNC(server, share) => {
                    let mut root = OsString::from(r"\\");
                    root.push(server); root.push(r"\"); root.push(share);
                    PathBuf::from(root)
                }
                _ => return Ok(path.as_os_str().to_owned()),
            },
            _ => return Err("Resident Node script path requires a drive or UNC root".into()),
        };
        for component in components { ordinary.push(component.as_os_str()); }
        if fs::canonicalize(&ordinary).map_err(|error| error.to_string())? != path {
            return Err("Resident Node script path normalization changed identity".into());
        }
        return Ok(ordinary.into_os_string());
    }
    #[cfg(not(windows))]
    Ok(path.as_os_str().to_owned())
}

struct LimitedBytes(Vec<u8>, usize);
impl Write for LimitedBytes {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() > self.1.saturating_sub(self.0.len()) {
            return Err(io::Error::other("Resident frame limit exceeded"));
        }
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> { Ok(()) }
}

type Fault = Arc<Mutex<Option<String>>>;
fn fail(fault: &Fault, message: impl Into<String>) {
    let mut current = lock(fault);
    if current.is_none() { *current = Some(message.into()); }
}

struct Worker {
    generation: u64,
    identity: RuntimeIdentity,
    pid: u32,
    process: Mutex<OwnedProcess>,
    input: Mutex<Option<SyncSender<Vec<u8>>>>,
    output: Mutex<Receiver<Vec<u8>>>,
    fault: Fault,
    _stderr: Arc<Mutex<VecDeque<u8>>>,
    threads: Mutex<Vec<JoinHandle<()>>>,
    stopped: AtomicBool,
    cleanup: Mutex<Option<Result<(), String>>>,
}

impl Worker {
    fn spawn(identity: RuntimeIdentity, generation: u64, max_response: usize) -> Result<Arc<Self>, String> {
        let args = [node_script_argument(&identity.service.path)?, OsString::from("--resident"),
            OsString::from("--parent-pid"), OsString::from(std::process::id().to_string())];
        // This platform helper creates a hidden Windows Job / Unix process
        // group. Ownership never relies on enumerating or killing unrelated PIDs.
        let spawned = preview_process_platform::spawn(&identity.node.path, &args)
            .map_err(|error| format!("Resident worker spawn failed: {error}"))?;
        let (input_tx, input_rx) = mpsc::sync_channel::<Vec<u8>>(1);
        let (output_tx, output_rx) = mpsc::sync_channel(2);
        let fault = Arc::new(Mutex::new(None));
        let stderr = Arc::new(Mutex::new(VecDeque::new()));
        let worker = Arc::new(Self {
            pid: spawned.process.id(), generation, identity,
            process: Mutex::new(spawned.process), input: Mutex::new(Some(input_tx)),
            output: Mutex::new(output_rx), fault: fault.clone(), _stderr: stderr.clone(),
            threads: Mutex::new(Vec::new()), stopped: AtomicBool::new(false),
            cleanup: Mutex::new(None),
        });
        let writer_fault = fault.clone();
        let mut stdin = spawned.stdin;
        worker.start_thread("resident-input", move || {
            while let Ok(bytes) = input_rx.recv() {
                if let Err(error) = stdin.write_all(&bytes).and_then(|()| stdin.flush()) {
                    fail(&writer_fault, format!("Resident input failed: {error}"));
                    break;
                }
            }
        })?;
        let reader_fault = fault.clone();
        worker.start_thread("resident-output", move || {
            read_frames(spawned.stdout, output_tx, reader_fault, max_response);
        })?;
        worker.start_thread("resident-stderr", move || {
            drain_stderr(spawned.stderr, stderr, fault);
        })?;
        Ok(worker)
    }

    fn start_thread(&self, name: &str, work: impl FnOnce() + Send + 'static) -> Result<(), String> {
        match thread::Builder::new().name(name.into()).spawn(work) {
            Ok(handle) => { lock(&self.threads).push(handle); Ok(()) }
            Err(error) => Err(combine(format!("Resident I/O thread failed: {error}"), self.stop(), false)),
        }
    }

    fn is_alive(&self) -> Result<bool, String> {
        if self.stopped.load(Ordering::Acquire) || lock(&self.fault).is_some() { return Ok(false); }
        lock(&self.process).try_wait().map(|exit| exit.is_none()).map_err(|error| error.to_string())
    }

    fn receive(&self, deadline: Instant, cancel: Option<&AtomicBool>) -> Result<Value, String> {
        let receiver = lock(&self.output);
        loop {
            if self.stopped.load(Ordering::Acquire) { return Err("Resident worker stopped".into()); }
            if canceled(cancel) { return Err("Resident request canceled".into()); }
            if let Some(error) = lock(&self.fault).as_ref() { return Err(error.clone()); }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() { return Err("Resident worker deadline exceeded".into()); }
            match receiver.recv_timeout(remaining.min(POLL)) {
                Ok(bytes) => {
                    if Instant::now() >= deadline { return Err("Resident worker response arrived past deadline".into()); }
                    if canceled(cancel) { return Err("Resident request canceled".into()); }
                    return serde_json::from_slice(&bytes)
                        .map_err(|error| format!("Resident protocol contains invalid JSON: {error}"));
                }
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    // The reader records the primary size/I/O fault before
                    // dropping its sender. Keep that cause across this race.
                    return Err(lock(&self.fault).clone().unwrap_or_else(|| "Resident output closed".into()));
                }
            }
        }
    }

    fn ready(&self, deadline: Instant, cancel: Option<&AtomicBool>) -> Result<(), String> {
        let ready = self.receive(deadline, cancel)?;
        if ready.get("schema").and_then(Value::as_str) != Some(SCHEMA)
            || ready.get("kind").and_then(Value::as_str) != Some("ready")
            || ready.get("pid").and_then(Value::as_u64) != Some(u64::from(self.pid))
        { return Err("Resident startup protocol / owned PID mismatch".into()); }
        Ok(())
    }

    fn exchange(&self, id: &str, bytes: Vec<u8>, deadline: Instant, cancel: Option<&AtomicBool>) -> Result<Value, String> {
        // Any idle stdout is a protocol error, never a response for a new ID.
        if lock(&self.output).try_recv().is_ok() { return Err("Resident emitted unsolicited output".into()); }
        if self.stopped.load(Ordering::Acquire) { return Err("Resident worker stopped before submission".into()); }
        lock(&self.input).as_ref().ok_or("Resident input closed")?
            .try_send(bytes).map_err(|error| format!("Resident request enqueue failed: {error}"))?;
        let envelope = self.receive(deadline, cancel)?;
        if envelope.get("schema").and_then(Value::as_str) != Some(SCHEMA)
            || envelope.get("id").and_then(Value::as_str) != Some(id)
        { return Err("Resident response schema / generation request ID mismatch".into()); }
        let response = envelope.get("response").ok_or("Resident response envelope missing")?;
        let ok = response.get("ok").and_then(Value::as_bool)
            .ok_or("Resident response is missing boolean ok")?;
        if !response.is_object() || (!ok && response.get("error").and_then(Value::as_str).is_none()) {
            return Err("Resident response body is invalid".into());
        }
        if canceled(cancel) { return Err("Resident request canceled before result publication".into()); }
        if Instant::now() >= deadline { return Err("Resident response validation exceeded deadline".into()); }
        Ok(response.clone())
    }

    fn stop(&self) -> Result<(), String> {
        let mut cleanup = lock(&self.cleanup);
        if let Some(result) = cleanup.as_ref() { return result.clone(); }
        self.stopped.store(true, Ordering::Release);
        lock(&self.input).take();
        let deadline = Instant::now() + CLEANUP_TIMEOUT;
        let mut process = lock(&self.process);
        let result = (|| {
            process.terminate_tree().map_err(|error| error.to_string())?;
            loop {
                let exited = process.try_wait().map_err(|error| error.to_string())?.is_some();
                let empty = process.tree_is_empty().map_err(|error| error.to_string())?;
                let io_done = lock(&self.threads).iter().all(JoinHandle::is_finished);
                if exited && empty && io_done { break; }
                if Instant::now() >= deadline {
                    return Err(format!("Resident owned worker {} or its I/O did not exit within cleanup budget", self.pid));
                }
                thread::sleep(POLL);
            }
            for handle in lock(&self.threads).drain(..) {
                handle.join().map_err(|_| "Resident I/O worker panicked".to_string())?;
            }
            Ok(())
        })();
        *cleanup = Some(result.clone());
        result
    }
}

impl Drop for Worker {
    fn drop(&mut self) { let _ = self.stop(); }
}

fn read_frames(pipe: Box<dyn Read + Send>, sender: SyncSender<Vec<u8>>, fault: Fault, max_response: usize) {
    let mut reader = BufReader::new(pipe);
    loop {
        let mut frame = Vec::new();
        loop {
            let bytes = match reader.fill_buf() {
                Ok(bytes) if bytes.is_empty() => {
                    fail(&fault, if frame.is_empty() { "Resident output EOF" } else { "Resident output ended mid-frame" });
                    return;
                }
                Ok(bytes) => bytes,
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(error) => { fail(&fault, format!("Resident output read failed: {error}")); return; }
            };
            let newline = bytes.iter().position(|byte| *byte == b'\n');
            let count = newline.unwrap_or(bytes.len());
            if count > max_response.saturating_sub(frame.len()) {
                fail(&fault, format!("Resident response exceeds {max_response} byte frame limit")); return;
            }
            frame.extend_from_slice(&bytes[..count]);
            reader.consume(count + usize::from(newline.is_some()));
            if newline.is_some() { break; }
        }
        if sender.try_send(frame).is_err() {
            fail(&fault, "Resident emitted unsolicited / excessive frames"); return;
        }
    }
}

fn drain_stderr(mut pipe: Box<dyn Read + Send>, tail: Arc<Mutex<VecDeque<u8>>>, fault: Fault) {
    let mut bytes = [0u8; 8192];
    loop {
        match pipe.read(&mut bytes) {
            Ok(0) => return,
            Ok(count) => {
                let mut tail = lock(&tail);
                let discard = (tail.len() + count).saturating_sub(MAX_STDERR);
                tail.drain(..discard);
                tail.extend(&bytes[..count]);
            }
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) if error.kind() == io::ErrorKind::BrokenPipe => return,
            Err(error) => { fail(&fault, format!("Resident stderr read failed: {error}")); return; }
        }
    }
}

#[cfg(test)]
#[path = "resident_service_tests.rs"]
mod tests;
