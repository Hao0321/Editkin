use super::*;
use std::{path::PathBuf, sync::atomic::AtomicUsize};

// Fault fixture only: production launches the existing native GPU binary.
const FIXTURE: &str = r#"
const mode=process.argv[1], send=x=>process.stdout.write(JSON.stringify(x)+'\n');
setInterval(()=>{},1000);
if(mode==='no-ready') return;
send({event:'ready',engine:mode==='wrong-ready'?'wrong':'editkin-wgpu-resident-engine/v1',generation:1});
if(mode==='blocked-input') return;
require('readline').createInterface({input:process.stdin}).on('line',line=>{
 const r=JSON.parse(line),ok=result=>send({id:r.id,ok:true,result});
 switch(r.command){
 case 'hang': process.stderr.write('HANG_RECEIVED\n'); return;
 case 'error': send({id:r.id,ok:false,error:'command validation rejected'}); return;
 case 'wrong-id': send({id:'other',ok:true,result:null}); return;
 case 'bad-envelope': send({id:r.id,ok:'true',result:null}); return;
 case 'missing-result': send({id:r.id,ok:true}); return;
 case 'malformed': process.stdout.write('{broken\n'); return;
 case 'utf8': process.stdout.write(Buffer.from([0xff,0x0a])); return;
 case 'partial': process.stdout.write('{"id":',()=>process.exit(0)); return;
 case 'oversize': process.stdout.write('x'.repeat(8*1024*1024+1)+'\n'); return;
 case 'flood': process.stdout.write(Array.from({length:20},()=>JSON.stringify({id:'unsolicited',ok:true,result:null})+'\n').join('')); return;
 case 'stderr': process.stderr.write('s'.repeat(200000),()=>ok('drained')); return;
 case 'child': {
  const child=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit',windowsHide:true});
  ok({child:child.pid}); return;
 }
 default: ok({value:r.value??null,pid:process.pid});
 }
});
"#;
fn runtime(name: &str) -> PathBuf {
    PathBuf::from(std::env::var_os(name).expect("test runtime must be explicitly configured"))
}
fn environment() -> Vec<(OsString, OsString)> {
    std::env::vars_os().collect()
}
fn launch(mode: &str, cancel: Arc<AtomicBool>) -> GpuResidentProcess {
    // Node -e is a script context, not a function body; wrap fixture so its early returns are valid.
    GpuResidentProcess::launch(
        &runtime("EDITKIN_TEST_NODE"),
        &[
            "-e".into(),
            format!("(()=>{{{FIXTURE}}})()").into(),
            mode.into(),
        ],
        &environment(),
        cancel,
    )
    .unwrap()
}
fn host(mode: &str) -> GpuResidentProcess {
    let mut process = launch(mode, Arc::new(AtomicBool::new(false)));
    process.ensure_ready(Duration::from_secs(5)).unwrap();
    process
}
fn echo(process: &mut GpuResidentProcess) -> Value {
    process
        .request(
            "echo",
            json!({"value":"same-stream"}),
            Duration::from_secs(2),
        )
        .unwrap()
}
fn stopped(process: &mut GpuResidentProcess) {
    assert!(process.is_retired());
    assert!(process.cleanup_confirmed());
    assert!(process.process.try_wait().unwrap().is_some());
    assert!(process.process.tree_is_empty().unwrap());
    assert!(process.threads.is_empty());
    process.stop().unwrap();
}
#[test]
fn gpu_ready_echo_and_rejection_keep_one_process() {
    let mut process = host("normal");
    let pid = process.process.id();
    assert_eq!(echo(&mut process)["pid"], pid);
    assert_eq!(
        process
            .request("error", json!({}), Duration::from_secs(2))
            .unwrap_err(),
        "command validation rejected"
    );
    assert!(!process.is_retired());
    assert_eq!(echo(&mut process)["pid"], pid);
    process.stop().unwrap();
    stopped(&mut process);
}
#[test]
fn gpu_startup_timeout_and_wrong_identity_are_owned_and_cleaned() {
    for (mode, expected) in [
        ("no-ready", "deadline"),
        ("wrong-ready", "identity mismatch"),
    ] {
        let mut process = launch(mode, Arc::new(AtomicBool::new(false)));
        let start = Instant::now();
        let error = process
            .ensure_ready(if mode == "no-ready" {
                Duration::from_millis(150)
            } else {
                Duration::from_secs(5)
            })
            .unwrap_err();
        assert!(error.contains(expected), "{error}");
        assert!(start.elapsed() < Duration::from_secs(7));
        stopped(&mut process);
    }
}
#[test]
fn gpu_pre_canceled_start_does_not_spawn() {
    let error = GpuResidentProcess::launch(
        Path::new("does-not-exist"),
        &[],
        &[],
        Arc::new(AtomicBool::new(true)),
    )
    .err()
    .unwrap();
    assert!(error.contains("not launched"));
}
#[test]
fn gpu_request_timeout_retires_stream_without_replay() {
    let mut process = host("normal");
    let start = Instant::now();
    let error = process
        .request("hang", json!({}), Duration::from_millis(150))
        .unwrap_err();
    assert!(error.contains("deadline"));
    assert!(error.contains("not replayed"));
    assert!(start.elapsed() < Duration::from_secs(3));
    stopped(&mut process);
    assert!(process
        .request("echo", json!({}), Duration::from_secs(1))
        .unwrap_err()
        .contains("not submitted"));
}
#[test]
fn gpu_blocked_stdin_write_obeys_the_same_request_deadline() {
    let mut process = host("blocked-input");
    let start = Instant::now();
    let error = process
        .request(
            "echo",
            json!({"value":"x".repeat(512*1024)}),
            Duration::from_millis(200),
        )
        .unwrap_err();
    assert!(error.contains("deadline"), "{error}");
    assert!(start.elapsed() < Duration::from_secs(3));
    stopped(&mut process);
}
#[test]
fn gpu_shutdown_signal_cancels_startup() {
    let cancel = Arc::new(AtomicBool::new(false));
    let mut process = launch("no-ready", cancel.clone());
    let signal = thread::spawn(move || {
        thread::sleep(Duration::from_millis(100));
        cancel.store(true, Ordering::Release);
    });
    let start = Instant::now();
    let error = process.ensure_ready(Duration::from_secs(30)).unwrap_err();
    signal.join().unwrap();
    assert!(error.contains("canceled"), "{error}");
    assert!(start.elapsed() < Duration::from_secs(3));
    stopped(&mut process);
}
#[test]
fn gpu_dispatch_shutdown_interrupts_active_io_and_joins_owner() {
    let worker = crate::gpu_command_worker::GpuCommandWorker::default();
    let cancel = worker.cancellation_flag();
    let (ready, entered) = mpsc::sync_channel(1);
    let (finished, result) = mpsc::sync_channel(1);
    let ticket = worker
        .submit(move || {
            let mut process = launch("normal", cancel);
            process.ensure_ready(Duration::from_secs(5))?;
            ready.send(process.stderr.clone()).unwrap();
            let outcome = process.request("hang", json!({}), Duration::from_secs(30));
            let cleaned = process.cleanup_confirmed();
            finished.send((outcome.clone(), cleaned)).unwrap();
            outcome
        })
        .unwrap();
    let stderr = entered.recv_timeout(Duration::from_secs(6)).unwrap();
    let wait_until = Instant::now() + Duration::from_secs(3);
    loop {
        if stderr
            .lock()
            .unwrap()
            .iter()
            .copied()
            .collect::<Vec<_>>()
            .windows(b"HANG_RECEIVED\n".len())
            .any(|bytes| bytes == b"HANG_RECEIVED\n")
        {
            break;
        }
        assert!(
            Instant::now() < wait_until,
            "fixture never received active request"
        );
        thread::sleep(POLL);
    }
    assert!(worker.shutdown_and_wait(Duration::from_secs(3)));
    let (outcome, cleaned) = result.recv_timeout(Duration::from_secs(1)).unwrap();
    assert!(outcome.unwrap_err().contains("canceled"));
    assert!(cleaned);
    drop(ticket);
}
#[test]
fn gpu_invalid_response_frames_all_retire_and_join_io() {
    for (command, expected) in [
        ("wrong-id", "mismatch"),
        ("bad-envelope", "mismatch"),
        ("missing-result", "mismatch"),
        ("malformed", "JSON invalid"),
        ("utf8", "JSON invalid"),
        ("partial", "mid-frame"),
        ("oversize", "exceeds 8 MiB"),
    ] {
        let mut process = host("normal");
        let error = process
            .request(command, json!({}), Duration::from_secs(5))
            .unwrap_err();
        assert!(error.contains(expected), "{command}: {error}");
        stopped(&mut process);
    }
}
#[test]
fn gpu_unsolicited_response_queue_is_bounded() {
    let mut process = host("normal");
    assert!(process
        .request("flood", json!({}), Duration::from_secs(2))
        .is_err());
    stopped(&mut process);
    assert!(process.output.try_iter().count() <= 2);
}
#[test]
fn gpu_request_size_rejection_does_not_poison_healthy_stream() {
    let mut process = host("normal");
    assert!(process
        .request(
            "echo",
            json!({"value":"x".repeat(MAX_REQUEST)}),
            Duration::from_secs(2)
        )
        .unwrap_err()
        .contains("before submission"));
    assert!(!process.is_retired());
    assert_eq!(echo(&mut process)["value"], "same-stream");
    process.stop().unwrap();
    stopped(&mut process);
}
#[test]
fn gpu_stderr_flood_is_drained_with_bounded_retention() {
    let mut process = host("normal");
    assert_eq!(
        process
            .request("stderr", json!({}), Duration::from_secs(5))
            .unwrap(),
        json!("drained")
    );
    assert_eq!(echo(&mut process)["value"], "same-stream");
    process.stop().unwrap();
    let tail = process.stderr.lock().unwrap();
    assert_eq!(tail.len(), MAX_STDERR);
    assert!(tail.iter().all(|byte| *byte == b's'));
    drop(tail);
    stopped(&mut process);
}
#[test]
fn gpu_stop_terminates_owned_descendant_and_inherited_pipes() {
    let mut process = host("normal");
    let child = process
        .request("child", json!({}), Duration::from_secs(2))
        .unwrap()["child"]
        .as_u64()
        .unwrap();
    assert!(child > 0);
    assert_ne!(child, process.process.id() as u64);
    process.stop().unwrap();
    stopped(&mut process);
}
#[test]
fn gpu_slot_only_replaces_after_confirmed_cleanup_never_replays() {
    let launches = AtomicUsize::new(0);
    let operations = AtomicUsize::new(0);
    let mut slot = None;
    let failure = with_ready_gpu(
        &mut slot,
        || {
            launches.fetch_add(1, Ordering::SeqCst);
            Ok(host("normal"))
        },
        |p| {
            operations.fetch_add(1, Ordering::SeqCst);
            p.request("wrong-id", json!({}), Duration::from_secs(2))
        },
    );
    assert!(failure.is_err());
    assert!(slot.is_none());
    assert_eq!(launches.load(Ordering::SeqCst), 1);
    assert_eq!(operations.load(Ordering::SeqCst), 1);
    with_ready_gpu(
        &mut slot,
        || {
            launches.fetch_add(1, Ordering::SeqCst);
            Ok(host("normal"))
        },
        |p| Ok(echo(p)),
    )
    .unwrap();
    assert_eq!(launches.load(Ordering::SeqCst), 2);
    let p = slot.as_mut().unwrap();
    p.stop().unwrap();
    // State-injection negative: do not manufacture a leaked process. The real
    // cleanup succeeded above; only the receipt is changed to unconfirmed.
    p.cleanup = Some(Err("injected unconfirmed cleanup receipt".into()));
    assert!(with_ready_gpu::<()>(
        &mut slot,
        || panic!("must not replace"),
        |_| panic!("must not operate")
    )
    .is_err());
    assert!(slot.is_some());
    slot.as_mut().unwrap().cleanup = Some(Ok(()));
}
#[test]
fn gpu_startup_failure_is_cleaned_before_slot_is_cleared() {
    let mut slot = None;
    let operations = AtomicUsize::new(0);
    assert!(with_ready_gpu(
        &mut slot,
        || Ok(launch("wrong-ready", Arc::new(AtomicBool::new(false)))),
        |_| {
            operations.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
    )
    .is_err());
    assert!(slot.is_none());
    assert_eq!(operations.load(Ordering::SeqCst), 0);
}
#[test]
fn gpu_existing_native_binary_ready_status_and_owned_cleanup() {
    let mut process = GpuResidentProcess::launch(
        &runtime("EDITKIN_TEST_GPU"),
        &["serve".into()],
        &environment(),
        Arc::new(AtomicBool::new(false)),
    )
    .unwrap();
    process.ensure_ready(Duration::from_secs(15)).unwrap();
    let status = process
        .request("status", json!({}), Duration::from_secs(5))
        .unwrap();
    assert!(status.is_object());
    let pid = process.process.id();
    let ready = process.ready.clone();
    process.stop().unwrap();
    stopped(&mut process);
    println!(
        "NATIVE_GPU_RECEIPT {}",
        json!({"pid":pid,"ready":ready,"status":status,"ownedCleanupConfirmed":true,"visiblePresentationTested":false})
    );
}
