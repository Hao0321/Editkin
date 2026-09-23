use super::*;
fn native(kind: &str, request: u64, generation: u64) -> Value {
    json!({"schema":EVENT_SCHEMA,"event":kind,"requestId":request,"generation":generation,"data":{
        "schema":"editkin.native-audio-session-event/v1","event":kind,"streamGeneration":generation,
        "sampleMasterRate":48000,"sampleMasterFrame":0,"presentedFrame":0,"timelineStartFrame":0,"timelineFrame":0,
        "deviceGeneration":1,"clockQpc100ns":0,"callbackCount":0,"state":"idle","decoderIdentityChecks":1}})
}
fn accept(shared: &Shared, value: Value) -> Result<(), String> {
    shared.accept(&serde_json::to_vec(&value).unwrap())
}
#[test]
fn admission_is_transactional_and_rejects_unknown_or_inconsistent_events() {
    let shared = Shared::default();
    let mut broken = native("ready", 0, 0);
    broken["data"]["sampleMasterRate"] = 44100.into();
    assert!(accept(&shared, broken).is_err());
    assert!(!shared.state.lock().unwrap().ready);
    accept(&shared, native("ready", 0, 0)).unwrap();
    for value in [
        native("ready", 0, 0),
        native("execute", 0, 0),
        native("paused", 99, 9),
    ] {
        assert!(accept(&shared, value).is_err());
    }
    assert_eq!(shared.state.lock().unwrap().history.len(), 1);
    let mut unknown = native("snapshot", 1, 0);
    unknown["command"] = "shell".into();
    assert!(accept(&shared, unknown).is_err());
}
#[test]
fn command_and_generation_correlation_is_not_just_matching_json() {
    let shared = Shared::default();
    accept(&shared, native("ready", 0, 0)).unwrap();
    {
        let mut s = shared.state.lock().unwrap();
        s.pending.insert(
            1,
            Pending {
                op: "replace",
                generation: Some(9),
            },
        );
        s.generations.insert(9);
    }
    assert!(accept(&shared, native("loading", 1, 8)).is_err());
    assert_eq!(shared.state.lock().unwrap().active, 0);
    accept(&shared, native("loading", 1, 9)).unwrap();
    {
        shared.state.lock().unwrap().pending.insert(
            2,
            Pending {
                op: "pause",
                generation: Some(9),
            },
        );
    }
    assert!(accept(&shared, native("resumed", 2, 9)).is_err());
    assert!(accept(&shared, native("paused", 2, 10)).is_err());
    let mut malformed = native("paused", 2, 9);
    malformed["data"]["presentedFrame"] = 10.into();
    assert!(accept(&shared, malformed).is_err());
    accept(&shared, native("paused", 2, 9)).unwrap();
    assert!(accept(&shared, native("paused", 2, 9)).is_err());
    assert_eq!(shared.state.lock().unwrap().active, 9);
}
#[test]
fn diagnostic_history_is_bounded_and_bad_closure_keeps_state() {
    let shared = Shared::default();
    accept(&shared, native("ready", 0, 0)).unwrap();
    for id in 1..=180 {
        shared.state.lock().unwrap().pending.insert(
            id,
            Pending {
                op: "snapshot",
                generation: None,
            },
        );
        accept(&shared, native("snapshot", id, 0)).unwrap();
    }
    assert_eq!(shared.state.lock().unwrap().history.len(), HISTORY);
    assert!(shared.state.lock().unwrap().pending.is_empty());
    {
        let mut s = shared.state.lock().unwrap();
        s.generations.insert(9);
        s.pending.insert(
            200,
            Pending {
                op: "replace",
                generation: Some(9),
            },
        );
    }
    let closure = json!({"schema":EVENT_SCHEMA,"event":"decoder-closed","requestId":0,"generation":9,
        "data":{"decoders":[{"treeClosed":true,"pipeThreadsClosed":false,"cleanupError":null}]}});
    assert!(accept(&shared, closure.clone()).is_err());
    assert!(shared.state.lock().unwrap().generations.contains(&9));
    let mut valid = closure;
    valid["data"]["decoders"][0]["pipeThreadsClosed"] = true.into();
    accept(&shared, valid).unwrap();
    assert!(!shared.state.lock().unwrap().pending.contains_key(&200));
}

#[test]
fn full_command_queue_rejects_without_consuming_a_request_id() {
    let shared = Arc::new(Shared::default());
    shared.state.lock().unwrap().ready = true;
    let (input, commands) = mpsc::sync_channel(PIPE_QUEUE);
    // A pure command-admission fixture: no executable or hardware is launched.
    let host = AudioSessionHost {
        plan_root: PathBuf::new(),
        input,
        shared: shared.clone(),
        worker: None,
        pid: 0,
    };
    for id in 1..=PIPE_QUEUE as u64 {
        assert_eq!(host.submit(Action::Snapshot).unwrap(), id);
    }
    assert!(host.submit(Action::Snapshot).is_err());
    assert_eq!(shared.state.lock().unwrap().next, PIPE_QUEUE as u64);
    let first: Value = serde_json::from_slice(&commands.try_recv().unwrap()).unwrap();
    assert_eq!(first["requestId"], 1);
    assert_eq!(
        host.submit(Action::Snapshot).unwrap(),
        PIPE_QUEUE as u64 + 1
    );
    // This fixture has no process to close, so dispose of only its queue/state.
    shared.state.lock().unwrap().cleanup =
        Some(json!({"treeEmpty":true,"ioJoined":true,"fixtureOnly":true}));
}
fn wait(host: &AudioSessionHost, predicate: impl Fn(&Value) -> bool) -> Value {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Some(e) = host.events().into_iter().find(|v| predicate(v)) {
            return e;
        }
        let status = host.snapshot().unwrap();
        assert_eq!(status["failed"], false, "{status}");
        assert!(
            Instant::now() < deadline,
            "expected broker event missing: {status}"
        );
        thread::sleep(Duration::from_millis(2));
    }
}
fn fixture_host() -> (AudioSessionHost, Value) {
    let path = std::env::var("EDITKIN_AUDIO_IPC_RECEIPT")
        .expect("explicit owned real-device fixture receipt required");
    let receipt: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    assert_eq!(receipt["status"], "PASS_NATIVE_SESSION_IPC_SOURCE_ONLY");
    let plans = PathBuf::from(receipt["cases"][0]["args"][1].as_str().unwrap());
    let host = AudioSessionHost::launch(
        Path::new(receipt["candidate"]["path"].as_str().unwrap()),
        Path::new(receipt["decoder"]["path"].as_str().unwrap()),
        receipt["decoder"]["sha256"].as_str().unwrap(),
        &plans,
    )
    .unwrap();
    host.wait_ready(Duration::from_secs(5)).unwrap();
    (host, receipt)
}
fn plan(host: &AudioSessionHost, receipt: &Value, generation: u64) -> PlanBinding {
    let ending = format!("/{generation}-中文 & plan.json");
    let row = receipt["fixtures"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| {
            v["path"]
                .as_str()
                .unwrap()
                .replace('\\', "/")
                .ends_with(&ending)
        })
        .unwrap();
    host.bind_plan(
        Path::new(row["path"].as_str().unwrap()),
        row["sha256"].as_str().unwrap(),
        generation,
    )
    .unwrap()
}
#[test]
#[ignore = "requires explicit real-device fixture invocation"]
fn actual_desktop_broker_reuses_process_and_joins_all_owned_work() {
    let (mut host, receipt) = fixture_host();
    let pid = host.pid;
    host.submit(Action::Replace {
        plan: plan(&host, &receipt, 9),
        autoplay: true,
    })
    .unwrap();
    wait(&host, |e| {
        e["event"] == "progress" && e["data"]["presentedFrame"].as_u64().unwrap_or(0) > 12000
    });
    let start = Instant::now();
    let pause = host.submit(Action::Pause(9)).unwrap();
    let admission = start.elapsed();
    assert!(admission < Duration::from_millis(50));
    let paused = wait(&host, |e| e["event"] == "paused" && e["requestId"] == pause);
    thread::sleep(Duration::from_millis(180));
    let snapshot = host.submit(Action::Snapshot).unwrap();
    let frozen = wait(&host, |e| {
        e["event"] == "snapshot" && e["requestId"] == snapshot
    });
    assert_eq!(
        paused["data"]["presentedFrame"],
        frozen["data"]["presentedFrame"]
    );
    assert_eq!(
        paused["data"]["sampleMasterFrame"],
        frozen["data"]["sampleMasterFrame"]
    );
    let resume = host.submit(Action::Resume(9)).unwrap();
    wait(&host, |e| {
        e["event"] == "resumed" && e["requestId"] == resume
    });
    assert!(host
        .submit(Action::Replace {
            plan: plan(&host, &receipt, 9),
            autoplay: true
        })
        .is_err());
    let replacement = host
        .submit(Action::Replace {
            plan: plan(&host, &receipt, 10),
            autoplay: true,
        })
        .unwrap();
    let concurrent = host.submit(Action::Snapshot).unwrap();
    wait(&host, |e| {
        e["event"] == "snapshot" && e["requestId"] == concurrent
    });
    let ended = wait(&host, |e| {
        e["event"] == "ended" && e["requestId"] == replacement
    });
    assert_eq!(ended["data"]["counts"]["deviceOpens"], 1);
    assert_eq!(ended["data"]["presentedFrame"], 48000);
    let native_started = host
        .events()
        .iter()
        .any(|e| e["event"] == "started" && e["generation"] == 10);
    assert!(native_started);
    let closed = host.close().unwrap();
    assert_eq!(closed["cleanup"]["graceful"], true, "{closed}");
    assert_eq!(closed["supervisorJoined"], true);
    assert!(host.cleanup_confirmed());
    assert_eq!(closed["pid"], pid);
    assert!(host.submit(Action::Snapshot).is_err());
    println!(
        "DESKTOP_AUDIO_BROKER {}",
        json!({"pid":pid,"commandAdmissionMs":admission.as_secs_f64()*1000.0,"closure":closed})
    );
}
#[test]
#[ignore = "requires explicit real-device fixture invocation"]
fn actual_owner_cancellation_closes_nested_decoder_tree() {
    let (mut host, receipt) = fixture_host();
    host.submit(Action::Replace {
        plan: plan(&host, &receipt, 9),
        autoplay: true,
    })
    .unwrap();
    wait(&host, |e| {
        e["event"] == "progress" && e["data"]["presentedFrame"].as_u64().unwrap_or(0) > 0
    });
    host.shared.fail("test: desktop owner disconnected");
    let start = Instant::now();
    let closed = host.close().unwrap();
    assert!(start.elapsed() < Duration::from_millis(3500));
    assert_eq!(closed["cleanup"]["forced"], true);
    assert_eq!(closed["cleanup"]["graceful"], false);
    assert!(host.cleanup_confirmed());
    assert_eq!(closed["supervisorJoined"], true);
    println!(
        "DESKTOP_AUDIO_CANCEL {}",
        json!({"elapsedMs":start.elapsed().as_secs_f64()*1000.0,"closure":closed})
    );
}
