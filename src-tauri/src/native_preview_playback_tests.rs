use super::*;
use crate::gpu_command_worker::{CommandResult, GpuCommandWorker};
use crate::gpu_resident_process::GpuResidentProcess;
use std::{
    fs,
    future::Future,
    path::PathBuf,
    pin::Pin,
    task::{Context, Poll, Wake, Waker},
    thread,
};

fn graph() -> Value {
    json!({"timebase":{"numerator":1,"denominator":30},"nodes":[{"id":"source"},{"id":"output"}]})
}
fn loaded(session: &str) -> Value {
    json!({"sessionId":session,"generation":1,"engineGraph":{"directExecution":true,"blockedNodeIds":[],"ignoredNodeIds":[],"executedNodeIds":["source","output"]}})
}
fn frame(session: &str, index: u64) -> Value {
    let mut value = loaded(session);
    value["timelineFrame"] = json!(index);
    value["active"] = json!(true);
    value["frame"] = json!({"nativeSurfacePresented":true,"decodePathCpuPixelCopies":0,"stagingCpuPixelReadbacks":0,"nativeSurfaceCpuPixelReadbacks":0});
    value
}
fn registry() -> PlaybackRegistry {
    let registry = PlaybackRegistry::default();
    registry
        .bind(GraphBinding::from_load("video", &graph(), &loaded("video")).unwrap())
        .unwrap();
    registry
}

#[test]
fn graph_clock_and_frame_oracles_reject_wrong_generation_node_and_frame() {
    let binding = GraphBinding::from_load("video", &graph(), &loaded("video")).unwrap();
    binding.validate_frame(4, &frame("video", 4)).unwrap();
    for value in [
        frame("other", 4),
        frame("video", 5),
        {
            let mut v = frame("video", 4);
            v["generation"] = json!(2);
            v
        },
        {
            let mut v = frame("video", 4);
            v["engineGraph"]["ignoredNodeIds"] = json!(["source"]);
            v
        },
        {
            let mut v = frame("video", 4);
            v["frame"]["nativeSurfacePresented"] = json!(false);
            v
        },
    ] {
        assert!(binding.validate_frame(4, &value).is_err());
    }
    let mut invalid = graph();
    invalid["timebase"]["numerator"] = json!(0);
    assert!(GraphBinding::from_load("video", &invalid, &loaded("video")).is_err());
    let registry = registry();
    assert!(registry
        .start("owner", "unknown", 0, 30, None, None)
        .is_err());
    assert!(registry
        .start("owner", "video", 30, 30, None, None)
        .is_err());
    assert!(registry
        .start("owner", "video", 0, 30 * 86_401, None, None)
        .is_err());
}

#[test]
fn device_clock_selects_latest_frame_without_catch_up_or_replaying_stale_work() {
    let registry = registry();
    let audio = Arc::new(EventMailbox::default());
    audio
        .publish(json!({"event":"started","timelineSeconds":0.0}))
        .unwrap();
    let lease = registry
        .start("owner", "video", 0, 90, Some(audio.clone()), None)
        .unwrap();
    let generation = lease.start_receipt()["generation"].as_u64().unwrap();
    let mut calls = Vec::new();
    assert!(lease
        .tick(|i, _| {
            calls.push(i);
            Ok(frame("video", i))
        })
        .is_some());
    audio
        .publish(json!({"event":"progress","timelineSeconds":0.51}))
        .unwrap();
    assert!(lease
        .tick(|i, _| {
            calls.push(i);
            Ok(frame("video", i))
        })
        .is_some());
    assert_eq!(calls, vec![0, 15]);
    let status = registry.snapshot("owner", generation, false).unwrap();
    assert_eq!(status["droppedFrames"], 14);
    assert!(lease
        .tick(|_, _| panic!("same frame must not render twice"))
        .is_some());
    assert!(registry.stop("owner", Some(generation)));
    assert!(lease.tick(|_, _| panic!("stopped work")).is_none());
}

#[test]
fn failed_expired_or_ended_audio_clock_stops_without_wall_clock_fallback() {
    for failure in ["expired", "ended", "failed"] {
        let registry = registry();
        let audio = Arc::new(EventMailbox::default());
        audio
            .publish(json!({"event":"started","timelineSeconds":0.0}))
            .unwrap();
        let lease = registry
            .start("owner", "video", 0, 90, Some(audio.clone()), None)
            .unwrap();
        if failure == "expired" {
            thread::sleep(AUDIO_MAX_AGE + Duration::from_millis(10));
        } else if failure == "ended" {
            audio
                .publish(json!({"event":"ended","timelineSeconds":0.01}))
                .unwrap();
        } else {
            audio.fail("device failure".into());
        }
        assert!(lease
            .tick(|_, _| panic!("invalid audio must not drive GPU"))
            .is_none());
        assert_eq!(
            lease.start_receipt()["state"],
            if failure == "ended" {
                "ended"
            } else {
                "failed"
            }
        );
    }
}

#[test]
fn telemetry_retains_one_unacknowledged_event_and_coalesces_terminal_state() {
    let registry = registry();
    let events = Arc::new(Mutex::new(Vec::new()));
    let observed = events.clone();
    let audio = Arc::new(EventMailbox::default());
    audio
        .publish(json!({"event":"started","timelineSeconds":0.0}))
        .unwrap();
    let lease = registry
        .start(
            "owner",
            "video",
            0,
            100,
            Some(audio.clone()),
            Some(Arc::new(move |event| {
                observed.lock().unwrap().push(event);
                true
            })),
        )
        .unwrap();
    let generation = lease.start_receipt()["generation"].as_u64().unwrap();
    for index in 0..10 {
        audio
            .publish(json!({"event":"progress","timelineSeconds":index as f64/30.0+0.00001}))
            .unwrap();
        lease.tick(|i, _| Ok(frame("video", i)));
    }
    assert_eq!(events.lock().unwrap().len(), 1);
    assert!(!registry.acknowledge("owner", generation, 9).unwrap());
    registry.stop("owner", Some(generation));
    assert_eq!(events.lock().unwrap().len(), 1);
    assert!(registry.acknowledge("owner", generation, 1).unwrap());
    assert_eq!(events.lock().unwrap().len(), 2);
    assert_eq!(events.lock().unwrap()[1]["state"], "stopped");
    assert!(registry.acknowledge("owner", generation, 2).unwrap());
    assert_eq!(
        events.lock().unwrap().len(),
        2,
        "terminal acknowledgements must not loop"
    );
    assert!(
        serde_json::to_vec(&events.lock().unwrap()[0])
            .unwrap()
            .len()
            < 4096
    );
}

#[test]
fn stale_stop_ack_and_lease_drop_cannot_stop_successor() {
    let registry = registry();
    let old = registry.start("old", "video", 0, 30, None, None).unwrap();
    let old_generation = old.start_receipt()["generation"].as_u64().unwrap();
    let new = registry.start("new", "video", 0, 30, None, None).unwrap();
    assert!(!registry.stop("old", Some(old_generation)));
    assert!(registry.acknowledge("old", old_generation, 1).is_err());
    drop(old);
    assert_eq!(new.start_receipt()["state"], "playing");
    assert!(new.tick(|i, _| Ok(frame("video", i))).is_some());
}

#[test]
fn sink_failure_or_bad_render_is_a_terminal_failure_not_a_green_clock() {
    let registry = registry();
    let lease = registry
        .start("owner", "video", 0, 30, None, Some(Arc::new(|_| false)))
        .unwrap();
    lease.tick(|i, _| Ok(frame("video", i)));
    assert_eq!(lease.start_receipt()["state"], "failed");
    assert!(lease
        .tick(|_, _| panic!("failed consumer cannot keep producing"))
        .is_none());
    let lease = registry.start("owner", "video", 0, 30, None, None).unwrap();
    assert!(lease.tick(|_, _| Ok(frame("video", 99))).is_none());
    assert_eq!(lease.start_receipt()["state"], "failed");
}

struct WakeThread(thread::Thread);
impl Wake for WakeThread {
    fn wake(self: Arc<Self>) {
        self.0.unpark();
    }
}
fn wait(mut future: CommandResult) -> Result<Value, String> {
    let waker = Waker::from(Arc::new(WakeThread(thread::current())));
    let mut context = Context::from_waker(&waker);
    let until = Instant::now() + Duration::from_secs(10);
    loop {
        if let Poll::Ready(value) = Pin::new(&mut future).poll(&mut context) {
            return value;
        }
        assert!(Instant::now() < until);
        thread::park_timeout(Duration::from_millis(10));
    }
}

#[test]
fn real_engine_video_advances_autonomously_while_frontend_telemetry_is_not_acknowledged() {
    exercise_real_engine_video(false);
}

#[test]
fn real_engine_video_follows_live_wasapi_qpc_without_frontend_present_requests() {
    if std::env::var_os("EDITKIN_TEST_AUDIO_CORE").is_none() {
        eprintln!("NATIVE_AV_CLOCK_NOT_MEASURED: no real audio executable");
        return;
    }
    exercise_real_engine_video(true);
}

fn exercise_real_engine_video(with_audio: bool) {
    let executable = PathBuf::from(std::env::var_os("EDITKIN_TEST_GPU").unwrap());
    let source = PathBuf::from(std::env::var_os("EDITKIN_TEST_VIDEO").unwrap());
    let base = PathBuf::from(std::env::var_os("EDITKIN_TEST_CACHE_ROOT").unwrap());
    let cache = Arc::new(Mutex::new(crate::gpu_preview_cache::PreviewCache::default()));
    let graph = json!({"schema":"editkin.engine-graph/v1","graphId":"native-playback-fixture","width":960,"height":540,
        "timebase":{"numerator":1,"denominator":30},"workingFormat":"rgba16_float","cacheBudgetMb":64,"nodes":[
        {"id":"source","inputs":[],"enabled":true,"kind":"source","assetId":"video","mediaKind":"video","inputColorSpace":"rec709","timeline":{"timelineStartFrame":0,"sourceStartFrame":0,"durationFrames":180}},
        {"id":"transform","inputs":["source"],"enabled":true,"kind":"transform2d","x":0,"y":0,"scaleX":1,"scaleY":1,"rotationRadians":0,"opacity":1},
        {"id":"color","inputs":["transform"],"enabled":true,"kind":"color","processor":"editkin-rec709-primary/v1","inputSpace":"rec709","workingSpace":"rec709","outputSpace":"rec709_sdr",
          "grade":{"brightness":0,"contrast":1,"saturation":1,"hue":0,"exposure":0,"temperature":0,"tint":0,"pivot":0.5,"shadows":0,"highlights":0,"blacks":0,"whites":0,"whiteBalanceRed":0,"whiteBalanceGreen":0,"whiteBalanceBlue":0}},
        {"id":"output","inputs":["color"],"enabled":true,"kind":"output","format":"rgba16_float"}],"outputNode":"output"});
    let (job, paths) = cache
        .lock()
        .unwrap()
        .prepare_inputs(
            &base,
            &[
                serde_json::to_vec(&graph).unwrap(),
                serde_json::to_vec(&json!({"video":source})).unwrap(),
            ],
        )
        .unwrap();
    let worker = GpuCommandWorker::default();
    let registry = Arc::new(PlaybackRegistry::default());
    let owners = Arc::new(Mutex::new(
        crate::gpu_preview_owner::PreviewOwners::default(),
    ));
    let owner = owners.lock().unwrap().begin(|_| Ok(())).unwrap();
    let slot = Arc::new(Mutex::new(None::<GpuResidentProcess>));
    let r = registry.clone();
    let s = slot.clone();
    let session = owner.engine_video.clone();
    let diagnostic_graph = graph.clone();
    wait(worker.submit(move||{
        let mut process=GpuResidentProcess::launch(&executable,&["serve".into()],&std::env::vars_os().collect::<Vec<_>>(),Default::default())?;
        process.ensure_ready(Duration::from_secs(15))?;
        let loaded=process.request("engine_video_load",json!({"sessionId":session,"graphPath":paths[0],"bindingsPath":paths[1],"timelineFrame":0}),Duration::from_secs(15))?;
        r.bind(GraphBinding::from_load(&session,&graph,&loaded)?)?;
        process.request("surface_bind",json!({"parentHwnd":"0","x":-8000,"y":-8000,"width":96,"height":54}),Duration::from_secs(10))?;
        *s.lock().unwrap()=Some(process);Ok(json!(true))
    }).unwrap()).unwrap();
    cache.lock().unwrap().retire_group(job);
    let events = Arc::new(Mutex::new(Vec::new()));
    let observed = events.clone();
    let r = registry.clone();
    let o = owners.clone();
    let s = slot.clone();
    let current = owner.clone();
    let audio_device =
        with_audio.then(|| crate::audio_preview_events::device_tests::start_silent_device(1.0));
    let audio_clock = audio_device.as_ref().map(|device| device.mailbox.clone());
    let first_frame = if with_audio { 30 } else { 0 };
    let started=wait(worker.schedule(move||{
        let lease=r.start(&current.token,&current.engine_video,first_frame,150,audio_clock.map(|clock|clock as Arc<dyn AudioClockSource>),Some(Arc::new(move|event|{observed.lock().unwrap().push(event);true})))?;
        let receipt=lease.start_receipt();Ok((receipt,Box::new(move||lease.tick(|frame,tolerance|{
            o.lock().unwrap().check(Some(&current.token),Some((&current.engine_video,crate::gpu_preview_owner::PreviewResource::EngineVideo)))?;
            s.lock().unwrap().as_mut().unwrap().request("engine_video_present_frame",json!({"sessionId":current.engine_video,"timelineFrame":frame,"toleranceSeconds":tolerance}),Duration::from_secs(5))
        }))))
    }).unwrap()).unwrap();
    let generation = started["generation"].as_u64().unwrap();
    let deadline = Instant::now() + Duration::from_secs(4);
    let progressed = loop {
        let value = registry.snapshot(&owner.token, generation, false).unwrap();
        assert_eq!(value["state"], "playing", "{value}");
        if value["presentedFrames"].as_u64().unwrap() >= (if with_audio { 60 } else { 5 })
            && (!with_audio || value["timelineFrame"].as_u64().unwrap() >= 120)
        {
            break value;
        }
        assert!(Instant::now() < deadline, "{value}");
        thread::sleep(Duration::from_millis(10));
    };
    // Sample before stopping/closing the renderer; teardown elapsed time is
    // not A/V scheduling skew and must not be compared to this frozen frame.
    let audio_at_inspection = audio_device
        .as_ref()
        .map(|device| device.mailbox.clock_sample().unwrap().seconds);
    assert_eq!(
        events.lock().unwrap().len(),
        1,
        "slow frontend must not accumulate native events"
    );
    assert!(progressed["timelineFrame"].as_u64().unwrap() >= 4);
    if !with_audio {
        println!(
            "NATIVE_PLAYBACK_DIAGNOSTIC {}",
            json!({"graph":diagnostic_graph,"snapshot":registry.snapshot(&owner.token,generation,true).unwrap()})
        );
    }
    let input_started = Instant::now();
    assert_eq!(
        wait(worker.submit(|| Ok(json!("interactive"))).unwrap()).unwrap(),
        "interactive"
    );
    let input_ms = input_started.elapsed().as_secs_f64() * 1000.0;
    assert!(input_ms < 1000.0);
    registry.stop(&owner.token, Some(generation));
    let s = slot.clone();
    let o = owners.clone();
    let token = owner.token.clone();
    wait(
        worker
            .submit(move || {
                let mut slot = s.lock().unwrap();
                o.lock().unwrap().end(&token, |old| {
                    crate::gpu_preview_owner::cleanup_native(&mut slot, old)
                })?;
                slot.as_mut().unwrap().stop()?;
                Ok(json!(true))
            })
            .unwrap(),
    )
    .unwrap();
    assert!(worker.shutdown_and_wait(Duration::from_secs(1)));
    assert!(slot.lock().unwrap().as_ref().unwrap().cleanup_confirmed());
    cache.lock().unwrap().close();
    for path in [
        base.join("gpu-compositor/preview-owned-v1"),
        base.join("gpu-compositor"),
    ] {
        fs::remove_dir(path).unwrap();
    }
    if let Some(device) = audio_device {
        assert_eq!(progressed["clock"], "native-audio");
        let projected_audio = audio_at_inspection.unwrap();
        let video_time = progressed["timelineSeconds"].as_f64().unwrap();
        // Scheduling identity only: no optical/display latency instrument is
        // present, so this must never be called physical lip-sync acceptance.
        assert!(
            (projected_audio - video_time).abs() < 0.2,
            "audio={projected_audio} video={video_time}"
        );
        let audio_end = device.finish();
        assert_eq!(audio_end["timelineSeconds"], 5.0);
        println!(
            "NATIVE_AV_CLOCK_RECEIPT {}",
            json!({"progress":progressed,"audioFinal":audio_end,"audioAtInspection":projected_audio,"frontendPresentRequests":0,"queuedUiEvents":events.lock().unwrap().len(),"interactiveCommandMs":input_ms,"ownedCleanupConfirmed":true,"physicalLipSyncMeasured":false,"surface":"96x54 offscreen native surface, 960x540 graph"})
        );
    } else {
        println!(
            "NATIVE_PLAYBACK_RECEIPT {}",
            json!({"progress":progressed,"queuedUiEvents":events.lock().unwrap().len(),"interactiveCommandMs":input_ms,"frontendPresentRequests":0,"nativeClock":"monotonic","ownedCleanupConfirmed":true,"visiblePresentationTested":false,"physicalAudioTested":false})
        );
    }
}
