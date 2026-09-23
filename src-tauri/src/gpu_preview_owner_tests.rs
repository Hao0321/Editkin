use super::*;
use crate::{
    gpu_command_worker::{CommandResult, GpuCommandWorker},
    gpu_resident_process::GpuResidentProcess,
};
use std::{
    ffi::OsString,
    future::Future,
    path::PathBuf,
    pin::Pin,
    sync::{mpsc, Arc, Mutex},
    task::{Context, Poll, Wake, Waker},
    thread,
    time::{Duration, Instant},
};
struct WakeThread(thread::Thread);
impl Wake for WakeThread {
    fn wake(self: Arc<Self>) {
        self.0.unpark();
    }
}
fn wait(mut future: CommandResult) -> Result<Value, String> {
    let waker = Waker::from(Arc::new(WakeThread(thread::current())));
    let mut cx = Context::from_waker(&waker);
    let until = Instant::now() + Duration::from_secs(5);
    loop {
        if let Poll::Ready(result) = Pin::new(&mut future).poll(&mut cx) {
            return result;
        }
        assert!(Instant::now() < until);
        thread::park_timeout(Duration::from_millis(10));
    }
}
fn runtime(name: &str) -> PathBuf {
    PathBuf::from(std::env::var_os(name).expect("explicit fixture runtime required"))
}
fn launch(executable: PathBuf, args: Vec<OsString>) -> GpuResidentProcess {
    let mut process = GpuResidentProcess::launch(
        &executable,
        &args,
        &std::env::vars_os().collect::<Vec<_>>(),
        Default::default(),
    )
    .unwrap();
    process.ensure_ready(Duration::from_secs(15)).unwrap();
    process
}
#[test]
fn fifo_transfer_waits_for_running_work_and_rejects_late_old_work_before_side_effects() {
    let worker = GpuCommandWorker::default();
    let owners = Arc::new(Mutex::new(PreviewOwners::default()));
    let first = owners.lock().unwrap().begin(|_| Ok(())).unwrap();
    let events = Arc::new(Mutex::new(Vec::new()));
    let (entered, ready) = mpsc::sync_channel(1);
    let (release, blocked) = mpsc::sync_channel(1);
    let registry = owners.clone();
    let log = events.clone();
    let old_token = first.token.clone();
    let active = worker
        .submit(move || {
            registry.lock().unwrap().check(Some(&old_token), None)?;
            log.lock().unwrap().push("old-start");
            entered.send(()).unwrap();
            blocked.recv_timeout(Duration::from_secs(3)).unwrap();
            log.lock().unwrap().push("old-finish");
            Ok(json!(true))
        })
        .unwrap();
    ready.recv_timeout(Duration::from_secs(1)).unwrap();
    let registry = owners.clone();
    let log = events.clone();
    let successor = worker
        .submit(move || {
            let owner = registry.lock().unwrap().begin(|_| {
                log.lock().unwrap().push("cleanup-old");
                Ok(())
            })?;
            log.lock().unwrap().push("new-owner");
            Ok(owner.receipt())
        })
        .unwrap();
    let registry = owners.clone();
    let log = events.clone();
    let old_token = first.token.clone();
    let stale = worker
        .submit(move || {
            registry.lock().unwrap().check(Some(&old_token), None)?;
            log.lock().unwrap().push("BAD-stale-mutation");
            Ok(Value::Null)
        })
        .unwrap();
    release.send(()).unwrap();
    wait(active).unwrap();
    let next = wait(successor).unwrap();
    assert!(wait(stale).unwrap_err().contains("expired"));
    assert_eq!(
        *events.lock().unwrap(),
        vec!["old-start", "old-finish", "cleanup-old", "new-owner"]
    );
    owners
        .lock()
        .unwrap()
        .check(next["token"].as_str(), None)
        .unwrap();
    assert!(worker.shutdown_and_wait(Duration::from_secs(1)));
}
#[test]
fn real_native_owner_transfer_releases_predecessor_and_stale_end_keeps_successor() {
    let mut slot = Some(launch(runtime("EDITKIN_TEST_GPU"), vec!["serve".into()]));
    let mut owners = PreviewOwners::default();
    let graph = runtime("EDITKIN_TEST_GPU_GRAPH");
    let first = owners.begin(|_| Ok(())).unwrap();
    let load = |slot: &mut Option<GpuResidentProcess>, owner: &PreviewOwner| {
        slot.as_mut()
            .unwrap()
            .request(
                "load",
                json!({"sessionId":owner.image,"graphPath":graph}),
                Duration::from_secs(10),
            )
            .unwrap();
    };
    let count = |slot: &mut Option<GpuResidentProcess>| {
        slot.as_mut()
            .unwrap()
            .request("status", json!({}), Duration::from_secs(5))
            .unwrap()["residentSessions"]
            .as_u64()
            .unwrap()
    };
    load(&mut slot, &first);
    assert_eq!(count(&mut slot), 1);
    let second = owners.begin(|old| cleanup_native(&mut slot, old)).unwrap();
    assert_eq!(count(&mut slot), 0);
    load(&mut slot, &second);
    assert_eq!(count(&mut slot), 1);
    assert!(!owners
        .end(&first.token, |_| panic!(
            "old owner must not issue native release"
        ))
        .unwrap());
    assert_eq!(count(&mut slot), 1);
    owners
        .end(&second.token, |owner| cleanup_native(&mut slot, owner))
        .unwrap();
    assert_eq!(count(&mut slot), 0);
    let process = slot.as_mut().unwrap();
    let ready = process.ready.clone();
    process.stop().unwrap();
    assert!(process.cleanup_confirmed());
    println!(
        "NATIVE_OWNER_RECEIPT {}",
        json!({"ready":ready,"firstLoaded":1,"afterHandoff":0,"afterStaleEnd":1,"afterCurrentEnd":0,"ownedCleanupConfirmed":true,"visiblePresentationTested":false})
    );
}
#[test]
#[cfg(windows)]
fn incomplete_native_release_receipt_blocks_handoff_and_stops_owned_host() {
    let script = r#"console.log(JSON.stringify({event:'ready',engine:'editkin-wgpu-resident-engine/v1',generation:1}));require('readline').createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);console.log(JSON.stringify({id:r.id,ok:true,result:{sessionId:r.sessionId,released:true}}));});"#;
    let mut slot = Some(launch(
        runtime("EDITKIN_TEST_NODE"),
        vec!["-e".into(), script.into()],
    ));
    let mut owners = PreviewOwners::default();
    let first = owners.begin(|_| Ok(())).unwrap();
    let error = owners
        .begin(|old| cleanup_native(&mut slot, old))
        .unwrap_err();
    assert!(error.contains("incomplete"), "{error}");
    assert!(slot.is_none());
    assert!(owners.check(Some(&first.token), None).is_err());
    let second = owners.begin(|old| cleanup_native(&mut slot, old)).unwrap();
    assert_ne!(first, second);
}
