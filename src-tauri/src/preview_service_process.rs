//! Preview-only execution supervisor. Never use these short budgets for renders.
//! Completion means owned tree exit AND complete, bounded I/O; a timed-out
//! future is not process cancellation. The caller closes admission if cleanup
//! cannot be confirmed, so detached blocked workers cannot accumulate.
use crate::preview_process_platform;
use serde_json::Value;
use std::{
    ffi::OsString,
    io::{self, Read, Write},
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

#[derive(Clone, Copy)]
pub struct Limits {
    pub execution: Duration,
    pub cleanup: Duration,
    pub max_input: usize,
    pub max_stdout: usize,
    pub max_stderr: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            execution: Duration::from_secs(15),
            cleanup: Duration::from_secs(2),
            max_input: 65_536,
            max_stdout: 1_048_576,
            max_stderr: 65_536,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FailureKind {
    InvalidLimits,
    InputLimit,
    Spawn,
    ThreadStart,
    Timeout,
    Canceled,
    StdoutLimit,
    StderrLimit,
    InputIo,
    OutputIo,
    Wait,
    Exit,
    CleanupIncomplete,
}

#[derive(Debug)]
pub struct Failure {
    pub kind: FailureKind,
    pub detail: String,
    pub cleanup_confirmed: bool,
    pub pid: Option<u32>,
}

impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "素材預覽失敗（{:?}）：{}", self.kind, self.detail)?;
        if !self.cleanup_confirmed {
            write!(f, "；無法確認工作已清理，已停止接受新預覽，請重新開啟程式")?;
        }
        Ok(())
    }
}

#[derive(Debug)]
pub struct Output {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub pid: u32,
    pub exit_code: i32,
}

type IoResult = Result<Vec<u8>, (FailureKind, String)>;
enum Event {
    Input(Result<(), String>),
    Stdout(IoResult),
    Stderr(IoResult),
}

#[derive(Default)]
struct Observed {
    input_done: bool,
    stdout: Option<Vec<u8>>,
    stderr: Option<Vec<u8>>,
    failure: Option<(FailureKind, String)>,
}

impl Observed {
    fn fail(&mut self, kind: FailureKind, detail: String) {
        if self.failure.is_none() {
            self.failure = Some((kind, detail));
        }
    }

    fn collect(&mut self, receiver: &mpsc::Receiver<Event>) {
        // At most three events exist: one per I/O worker, not one per chunk.
        while let Ok(event) = receiver.try_recv() {
            match event {
                Event::Input(Ok(())) => self.input_done = true,
                Event::Input(Err(error)) => self.fail(FailureKind::InputIo, error),
                Event::Stdout(Ok(bytes)) => self.stdout = Some(bytes),
                Event::Stderr(Ok(bytes)) => self.stderr = Some(bytes),
                Event::Stdout(Err((kind, error))) | Event::Stderr(Err((kind, error))) => {
                    self.fail(kind, error)
                }
            }
        }
    }
}

fn read_bounded(mut pipe: Box<dyn Read + Send>, limit: usize, overflow: FailureKind) -> IoResult {
    let mut bytes = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        match pipe.read(&mut chunk) {
            Ok(0) => return Ok(bytes),
            Ok(count) => {
                if count > limit.saturating_sub(bytes.len()) {
                    return Err((
                        overflow,
                        format!("預覽回應超過 {limit} bytes；不接受截斷回應"),
                    ));
                }
                bytes.extend_from_slice(&chunk[..count]);
            }
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            // Anonymous Windows pipes report ERROR_BROKEN_PIPE when all writers
            // close. This is EOF, not permission to accept incomplete JSON.
            Err(error) if error.kind() == io::ErrorKind::BrokenPipe => return Ok(bytes),
            Err(error) => return Err((FailureKind::OutputIo, error.to_string())),
        }
    }
}

fn start_worker(
    name: &str,
    work: impl FnOnce() + Send + 'static,
    workers: &mut Vec<JoinHandle<()>>,
    observed: &mut Observed,
) {
    match thread::Builder::new().name(name.into()).spawn(work) {
        Ok(worker) => workers.push(worker),
        Err(error) => observed.fail(FailureKind::ThreadStart, error.to_string()),
    }
}

fn bounded_diagnostic(text: &str) -> String {
    const MAX_BYTES: usize = 4096;
    if text.len() <= MAX_BYTES {
        return text.into();
    }
    let mut end = MAX_BYTES;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…（診斷已截短）", &text[..end])
}

fn exit_diagnostic(stdout: Option<&[u8]>, stderr: Option<&[u8]>) -> Option<String> {
    // A nonzero process remains a failure even when its JSON claims ok:true.
    // Retain the primary service rejection (rights/path/hash errors) instead of
    // replacing every useful diagnostic with the generic exit code.
    if let Some(envelope) = stdout.and_then(|bytes| serde_json::from_slice::<Value>(bytes).ok()) {
        if envelope.get("ok").and_then(Value::as_bool) == Some(false) {
            if let Some(error) = envelope
                .get("error")
                .and_then(Value::as_str)
                .filter(|text| !text.is_empty())
            {
                return Some(bounded_diagnostic(error));
            }
        }
    }
    stderr.filter(|bytes| !bytes.is_empty()).map(|bytes| {
        bounded_diagnostic(&String::from_utf8_lossy(
            &bytes[bytes.len().saturating_sub(4096)..],
        ))
    })
}

pub fn run(
    executable: &Path,
    args: &[OsString],
    input: Vec<u8>,
    limits: Limits,
    cancel: Arc<AtomicBool>,
) -> Result<Output, Failure> {
    let before_spawn = |kind, detail| Failure {
        kind,
        detail,
        cleanup_confirmed: true,
        pid: None,
    };
    if limits.execution.is_zero()
        || limits.cleanup.is_zero()
        || limits.max_input == 0
        || limits.max_stdout == 0
        || limits.max_stderr == 0
    {
        return Err(before_spawn(
            FailureKind::InvalidLimits,
            "預覽工作限制必須大於零".into(),
        ));
    }
    if input.len() > limits.max_input {
        return Err(before_spawn(
            FailureKind::InputLimit,
            format!(
                "預覽請求 {} bytes 超過 {} bytes，請縮短素材 ID 或路徑",
                input.len(),
                limits.max_input
            ),
        ));
    }
    if cancel.load(Ordering::Acquire) {
        return Err(before_spawn(FailureKind::Canceled, "預覽已取消".into()));
    }
    let started = Instant::now();
    let spawned = preview_process_platform::spawn(executable, args)
        .map_err(|error| before_spawn(FailureKind::Spawn, error.to_string()))?;
    let preview_process_platform::Spawned {
        mut process,
        mut stdin,
        stdout,
        stderr,
    } = spawned;
    let pid = process.id();
    let (sender, receiver) = mpsc::sync_channel(3);
    let mut workers = Vec::with_capacity(3);
    let mut observed = Observed::default();
    let tx = sender.clone();
    start_worker(
        "preview-stdout",
        move || {
            let _ = tx.send(Event::Stdout(read_bounded(
                stdout,
                limits.max_stdout,
                FailureKind::StdoutLimit,
            )));
        },
        &mut workers,
        &mut observed,
    );
    let tx = sender.clone();
    start_worker(
        "preview-stderr",
        move || {
            let _ = tx.send(Event::Stderr(read_bounded(
                stderr,
                limits.max_stderr,
                FailureKind::StderrLimit,
            )));
        },
        &mut workers,
        &mut observed,
    );
    start_worker(
        "preview-stdin",
        move || {
            let result = stdin.write_all(&input).map_err(|error| error.to_string());
            drop(stdin); // The service reads to EOF; flush alone would not finish it.
            let _ = sender.send(Event::Input(result));
        },
        &mut workers,
        &mut observed,
    );

    let mut exit_code = None;
    loop {
        observed.collect(&receiver);
        if cancel.load(Ordering::Acquire) {
            observed.fail(FailureKind::Canceled, "預覽已取消".into());
        }
        if started.elapsed() >= limits.execution {
            observed.fail(FailureKind::Timeout, "預覽執行逾時，請稍候重試".into());
        }
        if observed.failure.is_some() {
            break;
        }
        match process.try_wait() {
            Ok(Some(code)) => {
                // Check again after the observation, not just before it: a
                // result first observed beyond the deadline is still late.
                if started.elapsed() >= limits.execution {
                    observed.fail(FailureKind::Timeout, "預覽完成回應超過執行期限".into());
                    break;
                }
                exit_code = Some(code);
                if code != 0 {
                    observed.fail(FailureKind::Exit, format!("預覽程序退出碼 {code}"));
                }
                break;
            }
            Ok(None) => thread::sleep(Duration::from_millis(5)),
            Err(error) => {
                observed.fail(FailureKind::Wait, error.to_string());
                break;
            }
        }
    }

    // Also clean residual descendants after a normal leader exit. They must not
    // keep inherited pipes open or outlive a finished preview.
    let cleanup_started = Instant::now();
    let termination_error = process.terminate_tree().err();
    let mut cleanup_error = termination_error.map(|error| error.to_string());
    let mut tree_empty = false;
    let mut leader_exited = false;
    loop {
        observed.collect(&receiver);
        match process.try_wait() {
            Ok(Some(_)) => leader_exited = true,
            Ok(None) => {}
            Err(error) => {
                cleanup_error.get_or_insert_with(|| error.to_string());
            }
        }
        match process.tree_is_empty() {
            Ok(empty) => tree_empty = empty,
            Err(error) => {
                cleanup_error.get_or_insert_with(|| error.to_string());
            }
        }
        if leader_exited && tree_empty && workers.iter().all(JoinHandle::is_finished) {
            break;
        }
        if cleanup_started.elapsed() >= limits.cleanup {
            break;
        }
        thread::sleep(Duration::from_millis(5));
    }
    let workers_finished = workers.iter().all(JoinHandle::is_finished);
    let cleanup_confirmed =
        leader_exited && tree_empty && workers_finished && cleanup_error.is_none();
    for worker in workers {
        if worker.is_finished() && worker.join().is_err() {
            observed.fail(FailureKind::OutputIo, "預覽 I/O 工作異常結束".into());
        }
        // A still-blocked worker is detached only on explicit cleanup failure.
        // Caller MUST poison admission; never join indefinitely on the UI path.
    }
    observed.collect(&receiver);
    if !cleanup_confirmed {
        let primary = observed
            .failure
            .as_ref()
            .map(|(kind, detail)| format!("{kind:?}: {detail}; "))
            .unwrap_or_default();
        return Err(Failure { kind: FailureKind::CleanupIncomplete,
            detail: format!("{primary}{}; leader_exited={leader_exited}, tree_empty={tree_empty}, io_complete={workers_finished}",
                cleanup_error.unwrap_or_else(|| "清理期限內未確認全部工作結束".into())),
            cleanup_confirmed: false, pid: Some(pid) });
    }
    // Cancellation can arrive during cleanup; never publish that stale result.
    if cancel.load(Ordering::Acquire) {
        observed.fail(FailureKind::Canceled, "預覽已取消".into());
    }
    if let Some((kind, mut detail)) = observed.failure {
        if kind == FailureKind::Exit {
            if let Some(diagnostic) =
                exit_diagnostic(observed.stdout.as_deref(), observed.stderr.as_deref())
            {
                detail.push_str(": ");
                detail.push_str(&diagnostic);
            }
        }
        return Err(Failure {
            kind,
            detail,
            cleanup_confirmed,
            pid: Some(pid),
        });
    }
    match (
        observed.input_done,
        observed.stdout,
        observed.stderr,
        exit_code,
    ) {
        (true, Some(stdout), Some(stderr), Some(0)) => Ok(Output {
            stdout,
            stderr,
            pid,
            exit_code: 0,
        }),
        _ => Err(Failure {
            kind: FailureKind::OutputIo,
            detail: "預覽回應或 I/O 結束狀態不完整".into(),
            cleanup_confirmed,
            pid: Some(pid),
        }),
    }
}

pub fn parse_service_response(output: Output) -> Result<Value, String> {
    if output.exit_code != 0 {
        return Err(format!("素材預覽程序退出碼 {}", output.exit_code));
    }
    let envelope: Value = serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("素材預覽回應無法解析：{error}"))?;
    if envelope.get("ok").and_then(Value::as_bool) != Some(true) {
        return Err(bounded_diagnostic(
            envelope
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("素材預覽 service 失敗"),
        ));
    }
    envelope
        .get("result")
        .filter(|value| value.is_object())
        .cloned()
        .ok_or_else(|| "素材預覽 service 缺少有效 result".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failed_service_diagnostic_survives_but_fake_success_does_not() {
        assert_eq!(
            exit_diagnostic(
                Some(br#"{"ok":false,"error":"rights denied"}"#),
                Some(b"secondary")
            ),
            Some("rights denied".into())
        );
        assert_eq!(
            exit_diagnostic(Some(br#"{"ok":true,"result":{}}"#), None),
            None
        );
        assert!(parse_service_response(Output {
            stdout: br#"{"ok":true,"result":{}}"#.to_vec(),
            stderr: vec![],
            pid: 1,
            exit_code: 7
        })
        .is_err());
    }

    #[test]
    fn diagnostic_budget_does_not_split_utf8() {
        let long = "素材錯誤".repeat(2000);
        let shortened = bounded_diagnostic(&long);
        assert!(shortened.len() < 4200);
        assert!(shortened.ends_with("（診斷已截短）"));
    }
}
