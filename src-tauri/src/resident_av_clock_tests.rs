//! Explicit opt-in device/GPU integration. Not an installed WebView test.
use crate::{
    audio_session_desktop::{DesktopAudio, Runtime},
    gpu_command_worker::{CommandResult, GpuCommandWorker},
    gpu_resident_process::GpuResidentProcess,
    native_preview_playback::{self as video, GraphBinding, PlaybackRegistry},
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    future::Future,
    path::PathBuf,
    pin::Pin,
    sync::{Arc, Mutex},
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
fn wait(mut result: CommandResult) -> Value {
    let waker = Waker::from(Arc::new(WakeThread(thread::current())));
    let mut cx = Context::from_waker(&waker);
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        if let Poll::Ready(v) = Pin::new(&mut result).poll(&mut cx) {
            return v.unwrap();
        }
        assert!(Instant::now() < deadline);
        thread::park_timeout(Duration::from_millis(2));
    }
}
fn stage_plan(input: &Value, generation: u64, start: u64, project: &Value) -> Value {
    let mut plan: Value =
        serde_json::from_slice(&fs::read(input["planFixture"].as_str().unwrap()).unwrap()).unwrap();
    let end = plan["startFrame"].as_u64().unwrap() + plan["frameCount"].as_u64().unwrap();
    plan["generation"] = generation.into();
    plan["startFrame"] = start.into();
    plan["frameCount"] = (end - start).into();
    let root = PathBuf::from(input["plans"].as_str().unwrap()).join(format!(
        "00000000-0000-0000-{:04x}-{:012x}",
        std::process::id() % 65536,
        generation
    ));
    fs::create_dir(&root).unwrap();
    let path = root.join("project-audio.json");
    let bytes = serde_json::to_vec(&plan).unwrap();
    fs::write(&path, &bytes).unwrap();
    json!({"schema":"editkin.native-audio-project-stage/v1","status":"PREPARED","projectId":project["id"],"projectRevision":project["revision"],"projectUpdatedAt":project["updatedAt"],
      "generation":generation,"planPath":path,"sessionRoot":root,"managedPaths":[path],"planBytes":bytes.len(),"planSha256":format!("{:x}",Sha256::digest(&bytes)),
      "startFrame":start,"frameCount":end-start,"sourceCount":41,"peakActiveSources":2,"pcmStagingFiles":0,"audioFingerprintSha256":"b".repeat(64)})
}
fn stage(audio: &DesktopAudio, owner: u64, input: &Value, project: &Value, start: u64) -> Value {
    let i = input.clone();
    let p = project.clone();
    wait(
        audio
            .replace(owner, p.clone(), move |g| Ok(stage_plan(&i, g, start, &p)))
            .unwrap(),
    )
}
fn await_state(events: &Arc<Mutex<Vec<Value>>>, generation: u64, phase: &str) {
    let deadline = Instant::now() + Duration::from_secs(8);
    loop {
        let list = events.lock().unwrap();
        assert!(!list.iter().any(|v| v["failed"] == true), "{list:?}");
        if list
            .iter()
            .rev()
            .any(|v| v["generation"] == generation && v["playback"]["state"] == phase)
        {
            return;
        }
        assert!(Instant::now() < deadline, "no {phase}: {list:?}");
        drop(list);
        thread::sleep(Duration::from_millis(5));
    }
}
fn start_video(
    worker: &GpuCommandWorker,
    registry: &Arc<PlaybackRegistry>,
    gpu: &Arc<Mutex<GpuResidentProcess>>,
    clock: Arc<crate::audio_session_host::clock::ResidentClock>,
    start: u64,
) -> u64 {
    let r = registry.clone();
    let g = gpu.clone();
    let started=wait(worker.schedule(move||{
        let audio=video::sample_clock(move||{let (seconds,ended,age)=clock.sample()?;Ok(crate::audio_preview_events::ClockSample{seconds,ended,age})});
        let lease=r.start("av-owner","av-session",start,1095,Some(audio),None)?;let result=lease.start_receipt();
        Ok((result,Box::new(move||lease.tick(|frame,tolerance|g.lock().unwrap().request("engine_video_present_frame",
            json!({"sessionId":"av-session","timelineFrame":frame,"toleranceSeconds":tolerance}),Duration::from_secs(5))))))
    }).unwrap());
    started["generation"].as_u64().unwrap()
}
fn progress(registry: &PlaybackRegistry, generation: u64, after: u64) -> Value {
    let deadline = Instant::now() + Duration::from_secs(6);
    loop {
        let s = registry.snapshot("av-owner", generation, true).unwrap();
        assert_eq!(s["state"], "playing", "{s}");
        if s["timelineFrame"].as_u64().unwrap() > after
            && s["presentedFrames"].as_u64().unwrap() > 3
        {
            return s;
        }
        assert!(Instant::now() < deadline, "{s}");
        thread::sleep(Duration::from_millis(5));
    }
}
#[test]
#[ignore = "requires pinned resident core, actual GPU and WASAPI fixture"]
fn actual_resident_audio_drives_gpu_pause_resume_and_long_range_seek() {
    let input: Value = serde_json::from_slice(
        &fs::read(std::env::var("EDITKIN_RESIDENT_AV_RUNTIME").unwrap()).unwrap(),
    )
    .unwrap();
    let graph: Value =
        serde_json::from_slice(&fs::read(input["graph"].as_str().unwrap()).unwrap()).unwrap();
    let mut process = GpuResidentProcess::launch(
        &PathBuf::from(input["gpu"].as_str().unwrap()),
        &["serve".into()],
        &std::env::vars_os().collect::<Vec<_>>(),
        Default::default(),
    )
    .unwrap();
    process.ensure_ready(Duration::from_secs(15)).unwrap();
    let loaded=process.request("engine_video_load",json!({"sessionId":"av-session","graphPath":input["graph"],"bindingsPath":input["bindings"],"timelineFrame":0}),Duration::from_secs(15)).unwrap();
    process
        .request(
            "surface_bind",
            json!({"parentHwnd":"0","x":-8000,"y":-8000,"width":96,"height":54}),
            Duration::from_secs(10),
        )
        .unwrap();
    let gpu = Arc::new(Mutex::new(process));
    let registry = Arc::new(PlaybackRegistry::default());
    registry
        .bind(GraphBinding::from_load("av-session", &graph, &loaded).unwrap())
        .unwrap();
    let worker = GpuCommandWorker::default();
    let audio = DesktopAudio::default();
    let events = Arc::new(Mutex::new(Vec::new()));
    let sink = events.clone();
    let opened = wait(
        audio
            .open(
                Runtime {
                    core: PathBuf::from(input["core"].as_str().unwrap()),
                    decoder: PathBuf::from(input["decoder"].as_str().unwrap()),
                    plans: PathBuf::from(input["plans"].as_str().unwrap()),
                },
                Box::new(move |v| {
                    let mut list = sink.lock().unwrap();
                    assert!(list.len() < 256);
                    list.push(v);
                    Ok(())
                }),
                || Ok(()),
            )
            .unwrap(),
    );
    let owner = opened["ownerId"].as_u64().unwrap();
    let project =
        json!({"id":"resident-av-fixture","revision":1,"updatedAt":"2026-09-08T00:00:00Z"});
    let first = stage(&audio, owner, &input, &project, 0);
    assert_eq!(first["generation"], 1);
    await_state(&events, 1, "paused");
    let clock = audio.clock(owner, 1).unwrap();
    let a = start_video(&worker, &registry, &gpu, clock.clone(), 0);
    wait(audio.control(owner, 1, true).unwrap());
    let before_pause = progress(&registry, a, 15);
    wait(audio.control(owner, 1, false).unwrap());
    await_state(&events, 1, "paused");
    // Wait through the final native capture, then verify the live scheduler
    // remains frozen without any UI stop/present/telemetry acknowledgement.
    thread::sleep(Duration::from_millis(120));
    let frozen_a = registry.snapshot("av-owner", a, false).unwrap();
    thread::sleep(Duration::from_millis(160));
    let frozen_b = registry.snapshot("av-owner", a, false).unwrap();
    assert_eq!(frozen_a["state"], "playing");
    assert_eq!(frozen_a["timelineFrame"], frozen_b["timelineFrame"]);
    wait(audio.control(owner, 1, true).unwrap());
    let resumed = progress(
        &registry,
        a,
        frozen_b["timelineFrame"].as_u64().unwrap() + 15,
    );
    registry.stop("av-owner", Some(a));
    let second = stage(&audio, owner, &input, &project, 1_536_000);
    await_state(&events, 2, "paused");
    assert!(clock.sample().is_err());
    assert!(audio.clock(owner, 1).is_err());
    let second_clock = audio.clock(owner, 2).unwrap();
    let b = start_video(&worker, &registry, &gpu, second_clock.clone(), 960);
    wait(audio.control(owner, 2, true).unwrap());
    let sought = progress(&registry, b, 978);
    let audio_seconds = second_clock.sample().unwrap().0;
    let video_seconds = sought["timelineSeconds"].as_f64().unwrap();
    let skew = (audio_seconds - video_seconds).abs();
    assert!(skew < 0.1, "scheduler/device sample skew {skew}");
    registry.stop("av-owner", Some(b));
    assert!(worker.shutdown_and_wait(Duration::from_secs(2)));
    let closed = wait(audio.close(owner).unwrap());
    assert_eq!(closed["released"], true);
    assert_eq!(closed["retainedStageFiles"], 0);
    assert!(second_clock.sample().is_err());
    assert!(audio.shutdown());
    gpu.lock().unwrap().stop().unwrap();
    assert!(gpu.lock().unwrap().cleanup_confirmed());
    assert_eq!(
        fs::read_dir(input["plans"].as_str().unwrap())
            .unwrap()
            .count(),
        0
    );
    println!(
        "RESIDENT_NATIVE_AV {}",
        json!({"opened":opened,"first":first,"beforePause":before_pause,"frozenA":frozen_a,"frozenB":frozen_b,
        "resumed":resumed,"second":second,"sought":sought,"audioSecondsAtInspection":audio_seconds,"schedulerSkewSeconds":skew,"closed":closed,
        "gpuCleanupConfirmed":true,"audioWorkerJoined":true,"gpuWorkerJoined":true,"oldClockRetired":true,"finalClockRetired":true,
        "boundary":"Actual offscreen GPU surface/device scheduling; no installed WebView or optical/display-latency measurement"})
    );
}
