//! Owned, bounded GPU JSON-lines transport. The command worker is its single
//! caller; this module owns device process lifetime, not graph scheduling.
use crate::preview_process_platform::{self, OwnedProcess};
use serde_json::{json, Value};
use std::{
    collections::VecDeque,
    ffi::OsString,
    io::{self, BufRead, BufReader, Read, Write},
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, SyncSender},
        Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};
const POLL: Duration = Duration::from_millis(20);
const CLEANUP: Duration = Duration::from_secs(2);
const MAX_REQUEST: usize = 1024 * 1024;
const MAX_RESPONSE: usize = 8 * 1024 * 1024;
const MAX_STDERR: usize = 64 * 1024;
type Fault = Arc<Mutex<Option<String>>>;
fn fault(target: &Fault, reason: String) {
    let mut current = target.lock().unwrap_or_else(|error| error.into_inner());
    if current.is_none() {
        *current = Some(reason);
    }
}
fn frames(pipe: Box<dyn Read + Send>, sender: SyncSender<Vec<u8>>, failed: Fault) {
    let mut reader = BufReader::new(pipe);
    loop {
        let mut bytes = Vec::new();
        let result = Read::by_ref(&mut reader)
            .take((MAX_RESPONSE + 1) as u64)
            .read_until(b'\n', &mut bytes);
        let reason = match result {
            Ok(0) => "GPU response stream closed".to_string(),
            Ok(count) if count > MAX_RESPONSE => "GPU response exceeds 8 MiB".into(),
            Ok(_) if bytes.last() != Some(&b'\n') => "GPU response ended mid-frame".into(),
            Ok(_) => match sender.try_send(bytes) {
                Ok(()) => continue,
                Err(mpsc::TrySendError::Disconnected(_)) => return,
                Err(mpsc::TrySendError::Full(_)) => {
                    "GPU unsolicited response queue overflow".into()
                }
            },
            Err(error) => format!("GPU response read failed: {error}"),
        };
        fault(&failed, reason);
        return;
    }
}
struct BoundedBytes(Vec<u8>);
impl Write for BoundedBytes {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if self.0.len().saturating_add(bytes.len()) >= MAX_REQUEST {
            return Err(io::Error::other("GPU request exceeds 1 MiB"));
        }
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

pub struct GpuResidentProcess {
    process: OwnedProcess,
    input: Option<SyncSender<Vec<u8>>>,
    output: Receiver<Vec<u8>>,
    failed: Fault,
    stderr: Arc<Mutex<VecDeque<u8>>>,
    threads: Vec<JoinHandle<()>>,
    cancel: Arc<AtomicBool>,
    retired: bool,
    cleanup: Option<Result<(), String>>,
    next_id: u64,
    pub ready: Value,
}
impl GpuResidentProcess {
    /// Store this owned object before ensure_ready. Failed startup cleanup must
    /// not be discarded in a constructor error while a replacement is launched.
    pub fn launch(
        executable: &Path,
        args: &[OsString],
        environment: &[(OsString, OsString)],
        cancel: Arc<AtomicBool>,
    ) -> Result<Self, String> {
        if cancel.load(Ordering::Acquire) {
            return Err("GPU host is closing; not launched".into());
        }
        let spawned =
            preview_process_platform::spawn_with_environment(executable, args, environment)
                .map_err(|error| format!("GPU owned process spawn failed: {error}"))?;
        let (input_tx, input_rx) = mpsc::sync_channel::<Vec<u8>>(1);
        let (output_tx, output_rx) = mpsc::sync_channel(2);
        let failed = Arc::new(Mutex::new(None));
        let stderr = Arc::new(Mutex::new(VecDeque::new()));
        let mut host = Self {
            process: spawned.process,
            input: Some(input_tx),
            output: output_rx,
            failed: failed.clone(),
            stderr: stderr.clone(),
            threads: Vec::new(),
            cancel,
            retired: false,
            cleanup: None,
            next_id: 0,
            ready: Value::Null,
        };
        let writer_fault = failed.clone();
        let mut input = spawned.stdin;
        host.spawn_io("gpu-input", move || {
            while let Ok(bytes) = input_rx.recv() {
                if let Err(error) = input.write_all(&bytes).and_then(|()| input.flush()) {
                    fault(&writer_fault, format!("GPU input write failed: {error}"));
                    break;
                }
            }
        });
        let reader_fault = failed.clone();
        host.spawn_io("gpu-output", move || {
            frames(spawned.stdout, output_tx, reader_fault)
        });
        host.spawn_io("gpu-stderr", move || {
            let mut pipe = spawned.stderr;
            let mut buffer = [0_u8; 4096];
            loop {
                match pipe.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(count) => {
                        let mut tail = stderr.lock().unwrap_or_else(|error| error.into_inner());
                        tail.extend(&buffer[..count]);
                        let excess = tail.len().saturating_sub(MAX_STDERR);
                        tail.drain(..excess);
                    }
                    Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                    Err(error) => {
                        fault(&failed, format!("GPU stderr read failed: {error}"));
                        break;
                    }
                }
            }
        });
        Ok(host)
    }
    fn spawn_io(&mut self, name: &str, work: impl FnOnce() + Send + 'static) {
        match thread::Builder::new().name(name.into()).spawn(work) {
            Ok(handle) => self.threads.push(handle),
            Err(error) => fault(&self.failed, format!("GPU I/O worker failed: {error}")),
        }
    }
    fn check(&self, deadline: Instant) -> Result<(), String> {
        if self.retired {
            return Err("GPU stream retired; request not replayed".into());
        }
        if self.cancel.load(Ordering::Acquire) {
            return Err("GPU request canceled by desktop shutdown".into());
        }
        if let Some(error) = self
            .failed
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .as_ref()
        {
            return Err(error.clone());
        }
        if Instant::now() >= deadline {
            return Err("GPU request deadline exceeded".into());
        }
        Ok(())
    }
    fn receive(&self, deadline: Instant) -> Result<Value, String> {
        loop {
            self.check(deadline)?;
            match self
                .output
                .recv_timeout(deadline.saturating_duration_since(Instant::now()).min(POLL))
            {
                Ok(bytes) => {
                    self.check(deadline)?;
                    let response = serde_json::from_slice(&bytes)
                        .map_err(|error| format!("GPU protocol JSON invalid: {error}"))?;
                    self.check(deadline)?;
                    return Ok(response);
                }
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return Err(self
                        .failed
                        .lock()
                        .unwrap_or_else(|error| error.into_inner())
                        .clone()
                        .unwrap_or_else(|| "GPU response channel disconnected".into()))
                }
            }
        }
    }
    pub fn ensure_ready(&mut self, timeout: Duration) -> Result<(), String> {
        if self.retired {
            return Err("GPU host retired; cleanup must be confirmed before replacement".into());
        }
        if !self.ready.is_null() {
            return Ok(());
        }
        let result = (|| {
            let ready = self.receive(Instant::now() + timeout)?;
            if ready["event"] != "ready"
                || ready["engine"] != "editkin-wgpu-resident-engine/v1"
                || !ready["generation"]
                    .as_u64()
                    .is_some_and(|generation| generation > 0)
            {
                return Err("GPU startup protocol identity mismatch".into());
            }
            self.ready = ready;
            Ok(())
        })();
        result.map_err(|error| self.retire(error))
    }
    pub fn request(
        &mut self,
        command: &str,
        payload: Value,
        timeout: Duration,
    ) -> Result<Value, String> {
        if self.ready.is_null() || self.retired {
            return Err("GPU host is not ready; request not submitted".into());
        }
        let deadline = Instant::now() + timeout;
        self.next_id = self
            .next_id
            .checked_add(1)
            .ok_or("GPU request sequence exhausted")?;
        let id = format!("tauri-{}", self.next_id);
        let mut request = payload.as_object().cloned().unwrap_or_default();
        request.insert("id".into(), json!(id));
        request.insert("command".into(), json!(command));
        let mut bytes = BoundedBytes(Vec::new());
        serde_json::to_writer(&mut bytes, &request)
            .map_err(|error| format!("GPU request rejected before submission: {error}"))?;
        bytes.0.push(b'\n');
        let result = (|| {
            self.check(deadline)?;
            if self.output.try_recv().is_ok() {
                return Err("GPU unsolicited output before request".into());
            }
            self.input
                .as_ref()
                .ok_or("GPU input closed")?
                .try_send(bytes.0)
                .map_err(|error| format!("GPU input queue rejected: {error}"))?;
            let response = self.receive(deadline)?;
            if response["id"].as_str() != Some(&id)
                || !response["ok"].is_boolean()
                || (response["ok"] == true
                    && !response
                        .as_object()
                        .is_some_and(|value| value.contains_key("result")))
                || (response["ok"] == false && !response["error"].is_string())
            {
                return Err("GPU response ID/envelope mismatch".into());
            }
            self.check(deadline)?;
            Ok(response)
        })();
        let response = result.map_err(|error| self.retire(error))?;
        if response["ok"] == false {
            return Err(response["error"].as_str().unwrap().to_string());
        }
        Ok(response["result"].clone())
    }
    fn retire(&mut self, primary: String) -> String {
        let message = match self.stop() {
            Ok(()) => format!("{primary}; request not replayed; owned GPU cleanup confirmed"),
            Err(error) => {
                format!("{primary}; request not replayed; GPU cleanup unconfirmed: {error}")
            }
        };
        // Count-only diagnostics: never forward raw native stderr, which may
        // contain private media paths, to a WebView error or remote receipt.
        let stderr_bytes = self
            .stderr
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .len();
        if stderr_bytes == 0 {
            message
        } else {
            format!("{message}; native stderr captured ({stderr_bytes} bytes, content withheld)")
        }
    }
    pub fn is_retired(&self) -> bool {
        self.retired
    }
    pub fn cleanup_confirmed(&self) -> bool {
        self.cleanup.as_ref().is_some_and(Result::is_ok)
    }
    pub fn stop(&mut self) -> Result<(), String> {
        if let Some(result) = self.cleanup.as_ref() {
            return result.clone();
        }
        self.retired = true;
        self.input.take();
        let deadline = Instant::now() + CLEANUP;
        let result = (|| {
            self.process
                .terminate_tree()
                .map_err(|error| error.to_string())?;
            loop {
                let exited = self
                    .process
                    .try_wait()
                    .map_err(|error| error.to_string())?
                    .is_some();
                let empty = self
                    .process
                    .tree_is_empty()
                    .map_err(|error| error.to_string())?;
                if exited && empty && self.threads.iter().all(JoinHandle::is_finished) {
                    break;
                }
                if Instant::now() >= deadline {
                    return Err(format!(
                        "GPU {} or its I/O did not exit within 2 seconds",
                        self.process.id()
                    ));
                }
                thread::sleep(POLL);
            }
            for thread in self.threads.drain(..) {
                thread.join().map_err(|_| "GPU I/O worker panicked")?;
            }
            Ok(())
        })();
        self.cleanup = Some(result.clone());
        result
    }
}
impl Drop for GpuResidentProcess {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

/// A failed constructor may not discard a still-owned process. Keep a retired
/// owner until cleanup is confirmed, including when readiness itself fails.
pub fn with_ready_gpu<T>(
    slot: &mut Option<GpuResidentProcess>,
    launch: impl FnOnce() -> Result<GpuResidentProcess, String>,
    operation: impl FnOnce(&mut GpuResidentProcess) -> Result<T, String>,
) -> Result<T, String> {
    if slot.is_none() {
        *slot = Some(launch()?);
    }
    let process = slot.as_mut().expect("resident GPU exists");
    let result = process
        .ensure_ready(Duration::from_secs(15))
        .and_then(|()| operation(process));
    if process.is_retired() && process.cleanup_confirmed() {
        *slot = None;
    }
    result
}

#[cfg(test)]
#[path = "gpu_resident_process_tests.rs"]
mod tests;
