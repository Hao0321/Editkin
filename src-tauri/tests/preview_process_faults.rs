//! Invoked by the isolated script harness, never a full Tauri build.
#[path = "../src/creative_preview.rs"]
mod creative_preview;
#[path = "../src/preview_process_platform.rs"]
mod preview_process_platform;
#[path = "../src/preview_service_process.rs"]
mod preview_service_process;

use preview_service_process::{parse_service_response, run, FailureKind, Limits};
use std::{
    ffi::OsString,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

fn limits() -> Limits {
    Limits {
        execution: Duration::from_millis(1500),
        cleanup: Duration::from_secs(1),
        max_input: 8 * 1024 * 1024,
        max_stdout: 256 * 1024,
        max_stderr: 256 * 1024,
    }
}
fn invoke(
    mode: &str,
    input: Vec<u8>,
    l: Limits,
    cancel: Arc<AtomicBool>,
) -> Result<preview_service_process::Output, preview_service_process::Failure> {
    let exe =
        PathBuf::from(std::env::var_os("EDITKIN_PREVIEW_TEST_NODE").expect("owned Node path"));
    let fixture = std::env::var_os("EDITKIN_PREVIEW_TEST_CHILD").expect("owned child fixture path");
    static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let marker = PathBuf::from(
        std::env::var_os("EDITKIN_PREVIEW_TEST_MARKERS").expect("owned marker directory"),
    )
    .join(format!(
        "{}-{}.json",
        mode,
        NEXT.fetch_add(1, Ordering::SeqCst)
    ));
    let result = run(
        &exe,
        &[fixture, OsString::from(mode), marker.as_os_str().to_owned()],
        input,
        l,
        cancel,
    );
    {
        let ready: serde_json::Value = serde_json::from_slice(
            &std::fs::read(&marker).expect("fixture must actually enter its mode"),
        )
        .unwrap();
        assert_eq!(ready["mode"], mode);
        let pid = match &result {
            Ok(o) => Some(o.pid),
            Err(e) => e.pid,
        };
        assert_eq!(ready["pid"].as_u64(), pid.map(u64::from));
    }
    if mode.contains("descendant") {
        eprintln!("descendant supervisor result ({mode}): {result:?}");
        let child: serde_json::Value = serde_json::from_slice(
            &std::fs::read(format!("{}.descendant", marker.display()))
                .expect("real descendant spawn marker"),
        )
        .unwrap();
        assert_process_dead(child["pid"].as_u64().unwrap() as u32);
    }
    result
}
#[cfg(windows)]
fn assert_process_dead(pid: u32) {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, GetLastError, ERROR_INVALID_PARAMETER, WAIT_OBJECT_0},
        System::Threading::{OpenProcess, WaitForSingleObject},
    };
    unsafe {
        let handle = OpenProcess(0x00100000, 0, pid);
        if handle.is_null() {
            assert_eq!(
                GetLastError(),
                ERROR_INVALID_PARAMETER,
                "descendant status not confirmed"
            );
            return;
        }
        let status = WaitForSingleObject(handle, 0);
        CloseHandle(handle);
        assert_eq!(status, WAIT_OBJECT_0, "owned descendant remains live");
    }
}
#[cfg(not(windows))]
fn assert_process_dead(pid: u32) {
    assert_eq!(unsafe { libc::kill(pid as i32, 0) }, -1);
    assert_eq!(
        std::io::Error::last_os_error().raw_os_error(),
        Some(libc::ESRCH)
    );
}
fn fault(mode: &str, input: Vec<u8>, expected: FailureKind) {
    let started = Instant::now();
    let failure = invoke(mode, input, limits(), Arc::new(AtomicBool::new(false))).expect_err(mode);
    assert_eq!(failure.kind, expected, "{mode}: {}", failure.detail);
    assert!(failure.cleanup_confirmed, "{mode}: {}", failure.detail);
    assert!(
        started.elapsed() < Duration::from_secs(4),
        "{mode}: cleanup exceeded bounded slack"
    );
}

#[test]
fn oversized_request_is_rejected_before_spawn() {
    let mut l = limits();
    l.max_input = 3;
    let failure = run(
        std::path::Path::new("nonexistent-not-executed.exe"),
        &[],
        vec![0; 4],
        l,
        Arc::new(AtomicBool::new(false)),
    )
    .unwrap_err();
    assert_eq!(failure.kind, FailureKind::InputLimit);
    assert!(failure.pid.is_none());
    assert!(failure.cleanup_confirmed);
}

#[test]
fn real_echo_and_large_simultaneous_pipes() {
    for mode in ["echo", "dual-pipe"] {
        let mut l = limits();
        l.execution = Duration::from_secs(3);
        let output = invoke(
            mode,
            vec![b'x'; 131072],
            l,
            Arc::new(AtomicBool::new(false)),
        )
        .expect(mode);
        assert_eq!(output.exit_code, 0);
        if mode == "dual-pipe" {
            assert!(output.stderr.len() > 131072);
        }
        let value = parse_service_response(output).unwrap();
        assert_eq!(value["receivedBytes"], 131072);
    }
}
#[test]
fn real_hang_is_bounded() {
    fault("hang", vec![], FailureKind::Timeout);
}
#[test]
fn blocked_stdin_is_bounded() {
    fault("no-read", vec![b'x'; 4 * 1024 * 1024], FailureKind::Timeout);
}
#[test]
fn stdout_ceiling_is_independent() {
    fault("stdout-limit", vec![], FailureKind::StdoutLimit);
}
#[test]
fn stderr_ceiling_is_independent() {
    fault("stderr-limit", vec![], FailureKind::StderrLimit);
}
#[test]
fn valid_json_nonzero_exit_is_not_success() {
    fault("ok-nonzero", vec![], FailureKind::Exit);
}
#[test]
fn late_valid_result_is_not_success() {
    fault("delayed", vec![], FailureKind::Timeout);
}
#[test]
fn live_parent_and_descendant_are_reaped_on_timeout() {
    fault("hang-with-descendant", vec![], FailureKind::Timeout);
}
#[test]
fn exited_parent_with_descendant_held_pipes_finishes_after_tree_cleanup() {
    let mut l = limits();
    l.execution = Duration::from_secs(3);
    let output = invoke(
        "descendant-holds-pipes",
        vec![],
        l,
        Arc::new(AtomicBool::new(false)),
    )
    .unwrap();
    assert!(
        parse_service_response(output).unwrap()["descendantPid"]
            .as_u64()
            .unwrap()
            > 0
    );
}
#[test]
fn malformed_and_truncated_responses_rejected() {
    for mode in ["invalid-json", "truncated-json", "missing-result"] {
        let mut l = limits();
        l.execution = Duration::from_secs(3);
        let output = invoke(mode, vec![], l, Arc::new(AtomicBool::new(false))).unwrap();
        assert!(parse_service_response(output).is_err(), "{mode}");
    }
}
#[test]
fn cancellation_during_live_child_is_confirmed() {
    let token = Arc::new(AtomicBool::new(false));
    let signal = token.clone();
    let thread = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(750));
        signal.store(true, Ordering::SeqCst);
    });
    let mut l = limits();
    l.execution = Duration::from_secs(3);
    let result = invoke("hang", vec![], l, token).unwrap_err();
    thread.join().unwrap();
    assert_eq!(result.kind, FailureKind::Canceled);
    assert!(result.cleanup_confirmed);
}
#[test]
fn two_timeouts_release_real_limiter_capacity_then_echo() {
    let limiter = Arc::new(creative_preview::PreviewLimiter::default());
    let mut jobs = Vec::new();
    for _ in 0..2 {
        let permit = limiter.reserve().unwrap();
        let token = limiter.cancel_token();
        jobs.push(std::thread::spawn(move || {
            permit.run(|| {
                let failure = invoke("hang", vec![], limits(), token).unwrap_err();
                assert_eq!(failure.kind, FailureKind::Timeout);
                assert!(failure.cleanup_confirmed);
                Err::<(), String>("expected preview timeout".into())
            })
        }));
    }
    for job in jobs {
        assert!(job.join().unwrap().is_err());
    }
    let permit = limiter.reserve().unwrap();
    permit
        .run(|| {
            let mut l = limits();
            l.execution = Duration::from_secs(3);
            invoke("echo", vec![], l, limiter.cancel_token())
                .map(|_| ())
                .map_err(|e| e.detail)
        })
        .unwrap();
}
#[test]
fn queued_shutdown_and_cleanup_poison_are_fail_closed_state_controls() {
    // Real limiter state, not a claim to have induced OS TerminateJobObject failure.
    let limiter = Arc::new(creative_preview::PreviewLimiter::default());
    let a = limiter.reserve().unwrap();
    let b = limiter.reserve().unwrap();
    let queued = limiter.reserve().unwrap();
    limiter.shutdown();
    assert!(limiter.is_shutdown());
    assert!(limiter.cancel_token().load(Ordering::SeqCst));
    assert!(queued.run(|| Ok(())).is_err());
    assert!(limiter.reserve().is_err());
    drop((a, b));
    let poisoned = Arc::new(creative_preview::PreviewLimiter::default());
    poisoned.poison_cleanup();
    assert!(poisoned.reserve().is_err());
}

#[test]
fn shutdown_wait_drains_real_jobs_and_queued_waiter() {
    let limiter = Arc::new(creative_preview::PreviewLimiter::default());
    let mut jobs = Vec::new();
    let markers = PathBuf::from(std::env::var_os("EDITKIN_PREVIEW_TEST_MARKERS").unwrap());
    let ready_count = || {
        std::fs::read_dir(&markers)
            .unwrap()
            .filter(|entry| {
                entry
                    .as_ref()
                    .unwrap()
                    .path()
                    .extension()
                    .is_some_and(|ext| ext == "json")
            })
            .count()
    };
    let before = ready_count();
    for _ in 0..2 {
        let permit = limiter.reserve().unwrap();
        let token = limiter.cancel_token();
        jobs.push(std::thread::spawn(move || {
            permit.run(|| {
                let mut l = limits();
                l.execution = Duration::from_secs(5);
                let failure = invoke("hang", vec![], l, token).unwrap_err();
                assert_eq!(failure.kind, FailureKind::Canceled);
                assert!(failure.cleanup_confirmed);
                Err::<(), String>("expected close cancellation".into())
            })
        }));
    }
    let queued = limiter.reserve().unwrap();
    let queued_job = std::thread::spawn(move || {
        queued.run(|| panic!("queued work must not start during close"))
    });
    let started = Instant::now();
    while ready_count() < before + 2 {
        assert!(
            started.elapsed() < Duration::from_secs(3),
            "both actual children must reach fixture"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(limiter.shutdown_and_wait(Duration::from_secs(3)));
    for job in jobs {
        assert!(job.join().unwrap().is_err());
    }
    let result: Result<(), String> = queued_job.join().unwrap();
    assert!(result.is_err());
    assert!(limiter.reserve().is_err());
}

#[test]
fn shutdown_wait_timeout_and_cleanup_poison_are_state_only_failures() {
    let limiter = Arc::new(creative_preview::PreviewLimiter::default());
    let held = limiter.reserve().unwrap();
    assert!(!limiter.shutdown_and_wait(Duration::from_millis(10)));
    drop(held);
    assert!(limiter.shutdown_and_wait(Duration::from_millis(10)));
    let poisoned = Arc::new(creative_preview::PreviewLimiter::default());
    poisoned.poison_cleanup();
    assert!(!poisoned.shutdown_and_wait(Duration::from_millis(10)));
}

#[test]
#[ignore = "explicit retained packaged-service integration, not fault fixture"]
fn packaged_5125_poster_and_media_use_actual_supervisor() {
    let directory = PathBuf::from(std::env::var_os("EDITKIN_PREVIEW_SERVICE_RECEIPTS").unwrap());
    let output_directory = PathBuf::from(std::env::var_os("EDITKIN_PREVIEW_TEST_MARKERS").unwrap());
    for number in [4, 5] {
        let receipt: serde_json::Value = serde_json::from_slice(
            &std::fs::read(
                directory.join(format!("{number:03}-service-resolve_creative_preview.json")),
            )
            .unwrap(),
        )
        .unwrap();
        let request = &receipt["request"];
        assert_eq!(request["command"], "resolve_creative_preview");
        assert_eq!(
            request["payload"]["mode"],
            if number == 4 { "poster" } else { "media" }
        );
        let executable = PathBuf::from(receipt["executable"]["path"].as_str().unwrap());
        let args: Vec<OsString> = receipt["argv"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| OsString::from(v.as_str().unwrap()))
            .collect();
        let started = Instant::now();
        let output = run(
            &executable,
            &args,
            serde_json::to_vec(request).unwrap(),
            Limits::default(),
            Arc::new(AtomicBool::new(false)),
        )
        .unwrap();
        let pid = output.pid;
        let result = parse_service_response(output).unwrap();
        let old: serde_json::Value =
            serde_json::from_str(receipt["stdout"].as_str().unwrap()).unwrap();
        assert_eq!(
            result, old["result"],
            "packaged preview result identity changed"
        );
        std::fs::write(output_directory.join(format!("service-{number}.json")),serde_json::to_vec_pretty(&serde_json::json!({"pid":pid,"elapsedMs":started.elapsed().as_millis(),"result":result})).unwrap()).unwrap();
    }
}

#[test]
fn nonzero_service_failure_preserves_primary_diagnostic() {
    let mut l = limits();
    l.execution = Duration::from_secs(3);
    let failure = invoke("error-nonzero", vec![], l, Arc::new(AtomicBool::new(false))).unwrap_err();
    assert_eq!(failure.kind, FailureKind::Exit);
    assert!(failure.cleanup_confirmed);
    assert!(
        failure.detail.contains("素材完整性驗證失敗"),
        "{}",
        failure.detail
    );
}
