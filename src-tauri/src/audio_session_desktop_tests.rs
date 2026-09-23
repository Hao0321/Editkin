use super::*;
use std::{
    future::Future,
    pin::Pin,
    task::{Context, Poll, Wake, Waker},
    thread,
};
fn caps() -> Value {
    json!({"schema":"editkin.engine-capabilities/v1","engine":"hao-core","residentAudio":{
    "commandSchema":"editkin.audio-session-command/v1","eventSchema":"editkin.audio-session-event/v1",
    "planSchema":"editkin.audio-codec-stream-plan/v2","sampleRate":48000,"maxCatalogSources":4096,"maxActiveSources":16,"physicalOutput":true}})
}
#[test]
fn catalog_capability_requires_all_versioned_boundaries() {
    assert!(supports_catalog(&caps()));
    assert!(!supports_catalog(
        &json!({"schema":"editkin.engine-capabilities/v1","engine":"hao-core"})
    ));
    for (key, bad) in [
        ("planSchema", json!("editkin.audio-codec-stream-plan/v1")),
        ("sampleRate", json!(44100)),
        ("physicalOutput", json!(false)),
        ("maxCatalogSources", json!(4097)),
    ] {
        let mut v = caps();
        v["residentAudio"][key] = bad;
        assert!(!supports_catalog(&v));
    }
}
#[test]
fn public_telemetry_cannot_disclose_source_and_decoder_receipts() {
    let v = public_status(
        &json!({"ownerId":5,"state":{"pid":222,"failed":true,"error":"C:/private/voice.wav","sequence":7,
        "playback":{"schema":"editkin.native-audio-session-event/v1","event":"ended","timelineFrame":99,
            "producer":{"path":"D:/private/secret.wav"},"stderr":"private"}}}),
    );
    assert_eq!(v["ownerId"], 5);
    assert_eq!(v["playback"]["timelineFrame"], 99);
    assert!(!v.to_string().contains("private"));
    assert!(!v.to_string().contains("222"));
}
struct WakeThread(thread::Thread);
impl Wake for WakeThread {
    fn wake(self: Arc<Self>) {
        self.0.unpark();
    }
}
fn wait(mut future: CommandResult) -> Result<Value, String> {
    let waker = Waker::from(Arc::new(WakeThread(thread::current())));
    let mut cx = Context::from_waker(&waker);
    let deadline = Instant::now() + Duration::from_secs(25);
    loop {
        if let Poll::Ready(v) = Pin::new(&mut future).poll(&mut cx) {
            return v;
        }
        assert!(Instant::now() < deadline);
        thread::park_timeout(Duration::from_millis(5));
    }
}
#[test]
fn read_only_status_rejects_unknown_owner_without_reserving_audio() {
    let desktop = DesktopAudio::default();
    assert_eq!(wait(desktop.status(1).unwrap()).unwrap_err(), "Stale audio owner");
    assert!(!desktop.is_active());
    assert!(desktop.shutdown());
}
#[test]
fn idle_document_retirement_is_idempotent_and_does_not_shutdown_dispatch() {
    let desktop = DesktopAudio::default();
    for _ in 0..2 {
        assert_eq!(wait(desktop.retire_document().unwrap()).unwrap()["released"], true);
        assert!(!desktop.is_active());
        assert_eq!(wait(desktop.status(1).unwrap()).unwrap_err(), "Stale audio owner");
    }
    assert!(desktop.shutdown());
}
fn make_stage(root: &Path, source: &Path, generation: u64, start: u64, project: &Value) -> Value {
    let mut plan: Value = serde_json::from_slice(&fs::read(source).unwrap()).unwrap();
    let end = plan["startFrame"].as_u64().unwrap() + plan["frameCount"].as_u64().unwrap();
    plan["generation"] = generation.into();
    plan["startFrame"] = start.into();
    plan["frameCount"] = (end - start).into();
    let uuid = format!(
        "00000000-0000-0000-{:04x}-{:012x}",
        std::process::id() % 65536,
        generation
    );
    let folder = root.join(uuid);
    fs::create_dir(&folder).unwrap();
    let path = folder.join("project-audio.json");
    fs::write(&path, serde_json::to_vec(&plan).unwrap()).unwrap();
    let (sha, bytes) = hash_file(&path, 4 * 1024 * 1024).unwrap();
    json!({"schema":"editkin.native-audio-project-stage/v1","status":"PREPARED","generation":generation,
        "projectId":project["id"],"projectRevision":project["revision"],"projectUpdatedAt":project["updatedAt"],
        "sessionRoot":folder,"planPath":path,"planSha256":sha,"planBytes":bytes,"managedPaths":[path],
        "pcmStagingFiles":0,"startFrame":start,"frameCount":end-start,"sourceCount":41,"peakActiveSources":2,
        "audioFingerprintSha256":"b".repeat(64)})
}
#[test]
#[ignore = "explicit isolated desktop fixture and actual WASAPI output required"]
fn actual_desktop_admission_pause_resume_seek_cleanup_and_legacy_rejection() {
    let input: Value = serde_json::from_slice(
        &fs::read(std::env::var("EDITKIN_DESKTOP_TRANSPORT_RUNTIME").unwrap()).unwrap(),
    )
    .unwrap();
    let core = PathBuf::from(input["core"].as_str().unwrap());
    let decoder = PathBuf::from(input["decoder"].as_str().unwrap());
    let plans = PathBuf::from(input["plans"].as_str().unwrap());
    let source = PathBuf::from(input["fixture"].as_str().unwrap());
    let desktop = DesktopAudio::default();
    let legacy = wait(
        desktop
            .capabilities(PathBuf::from(input["legacyCore"].as_str().unwrap()))
            .unwrap(),
    )
    .unwrap();
    assert_eq!(legacy["supported"], false);
    let rejected = wait(
        desktop
            .open(
                Runtime {
                    core: PathBuf::from(input["legacyCore"].as_str().unwrap()),
                    decoder: decoder.clone(),
                    plans: plans.clone(),
                },
                Box::new(|_| Ok(())),
                || Ok(()),
            )
            .unwrap(),
    )
    .unwrap_err();
    assert!(rejected.contains("does not support"));
    assert!(!desktop.is_active());
    let events = Arc::new(Mutex::new(Vec::<Value>::new()));
    let sink = events.clone();
    let entered = Instant::now();
    let opening = desktop
        .open(
            Runtime {
                core,
                decoder,
                plans: plans.clone(),
            },
            Box::new(move |v| {
                let mut s = sink.lock().unwrap();
                assert!(s.len() < 128);
                s.push(v);
                Ok(())
            }),
            || Ok(()),
        )
        .unwrap();
    let admission_ms = entered.elapsed().as_secs_f64() * 1000.;
    assert!(admission_ms < 100.0);
    assert!(desktop.is_active());
    let opened = wait(opening).unwrap();
    let owner = opened["ownerId"].as_u64().unwrap();
    let project =
        json!({"id":"actual-desktop-command","revision":3,"updatedAt":"2026-09-08T00:00:00.000Z"});
    let p = project.clone();
    let root = plans.clone();
    let fixture = source.clone();
    let first = wait(
        desktop
            .replace(owner, project.clone(), move |g| {
                Ok(make_stage(&root, &fixture, g, 0, &p))
            })
            .unwrap(),
    )
    .unwrap();
    assert_eq!(first["generation"], 1);
    assert!(!first.to_string().contains("planPath"));
    let wait_event = |generation: u64, event: &str, after_frame: Option<u64>| {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let s = events.lock().unwrap();
            if let Some(v) = s.iter().rev().find(|v| {
                v["generation"] == generation
                    && v["playback"]["event"] == event
                    && after_frame.is_none_or(|n| {
                        v["playback"]["timelineFrame"]
                            .as_u64()
                            .is_some_and(|f| f > n)
                    })
            }) {
                return v.clone();
            }
            assert!(!s.iter().any(|v| v["failed"] == true), "{s:?}");
            drop(s);
            assert!(Instant::now() < deadline, "missing {event}");
            thread::sleep(Duration::from_millis(5));
        }
    };
    wait_event(1, "prepared", None);
    wait(desktop.control(owner, 1, true).unwrap()).unwrap();
    let playing = wait_event(1, "progress", None);
    wait(desktop.control(owner, 1, false).unwrap()).unwrap();
    let paused = wait_event(1, "paused", None);
    wait(desktop.control(owner, 1, true).unwrap()).unwrap();
    // A coalesced UI snapshot may skip a transient 'resumed' edge. Require
    // hardware progress beyond the observed paused frame, in the same stream.
    let resumed = wait_event(1, "progress", paused["playback"]["timelineFrame"].as_u64());
    let p = project.clone();
    let root = plans.clone();
    let fixture = source.clone();
    let second = wait(
        desktop
            .replace(owner, project.clone(), move |g| {
                Ok(make_stage(&root, &fixture, g, 1_536_000, &p))
            })
            .unwrap(),
    )
    .unwrap();
    assert_eq!(second["generation"], 2);
    let seek = wait_event(2, "prepared", None);
    assert_eq!(seek["playback"]["state"], "paused");
    assert!(wait(desktop.control(owner, 1, true).unwrap()).is_err());
    wait(desktop.control(owner, 2, true).unwrap()).unwrap();
    wait_event(2, "progress", None);
    // Actual protected object and worker source, no Tauri/WebView substitute claim.
    let before = desktop
        .state
        .lock()
        .unwrap()
        .registry
        .snapshot(owner)
        .unwrap();
    let closed = wait(desktop.close(owner).unwrap()).unwrap();
    assert_eq!(closed["released"], true);
    assert_eq!(closed["retainedStageFiles"], 0);
    assert!(!desktop.is_active());
    assert!(wait(desktop.control(owner, 2, true).unwrap()).is_err());
    assert_eq!(fs::read_dir(&plans).unwrap().count(), 0);
    assert!(desktop.shutdown());
    println!(
        "DESKTOP_AUDIO_TRANSPORT {}",
        json!({"admissionMs":admission_ms,"legacy":legacy,"legacyOpenRejected":rejected,
        "opened":opened,"first":first,"playing":playing,"paused":paused,"resumed":resumed,"second":second,"seek":seek,"nativeBeforeClose":before,"closed":closed,"workerJoined":true})
    );
}
