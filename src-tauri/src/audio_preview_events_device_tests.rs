use super::*;
use std::{
    fs,
    io::BufReader,
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread,
};

struct Fixture {
    child: Option<Child>,
    pcm: PathBuf,
    root: PathBuf,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        if let Some(child) = self.child.as_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
        let _ = fs::remove_file(&self.pcm);
        let _ = fs::remove_dir(&self.root);
    }
}

pub(crate) struct RunningDevice {
    fixture: Fixture,
    pub mailbox: Arc<EventMailbox>,
    finished: Arc<AtomicBool>,
    reader: thread::JoinHandle<Result<Vec<Value>, String>>,
    stderr: thread::JoinHandle<String>,
}
impl RunningDevice {
    pub fn finish(mut self) -> Value {
        let until = Instant::now() + Duration::from_secs(8);
        while !self.finished.load(Ordering::Acquire) && Instant::now() < until {
            thread::sleep(Duration::from_millis(4));
        }
        if !self.finished.load(Ordering::Acquire) {
            let _ = self.fixture.child.as_mut().unwrap().kill();
        }
        let exit = self.fixture.child.as_mut().unwrap().wait().unwrap();
        let events = self.reader.join().unwrap();
        let stderr = self.stderr.join().unwrap();
        assert!(exit.success(), "audio child failed: {exit}; {stderr}");
        let events = events.unwrap();
        let ended = events.last().unwrap();
        assert_eq!(ended["event"], "ended");
        assert_eq!(ended["transport"]["unexpectedUnderrunSamples"], 0);
        assert_eq!(ended["lifecycle"]["segmentsStarted"], 1);
        assert_eq!(ended["lifecycle"]["segmentsStopped"], 1);
        ended.clone()
    }
}

pub(crate) fn start_silent_device(origin: f64) -> RunningDevice {
    let core = std::env::var_os("EDITKIN_TEST_AUDIO_CORE").expect("real audio executable required");
    let parent =
        PathBuf::from(std::env::var_os("EDITKIN_TEST_CACHE_ROOT").expect("owned fixture root"));
    let root = parent.join(format!("audio-qpc-{}", std::process::id()));
    fs::create_dir(&root).unwrap();
    let pcm = root.join("silent-four-seconds.f32le");
    let mut fixture = Fixture {
        child: None,
        pcm,
        root,
    };
    fs::write(&fixture.pcm, vec![0_u8; 4 * 48_000 * 2 * 4]).unwrap();
    let mut command = Command::new(core);
    command
        .args(["audio-preview-play"])
        .arg(&fixture.pcm)
        .arg(origin.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command.spawn().unwrap();
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    fixture.child = Some(child);
    let stderr_task = thread::spawn(move || {
        let mut bytes = String::new();
        BufReader::new(stderr)
            .take(8192)
            .read_to_string(&mut bytes)
            .unwrap();
        bytes
    });
    let mailbox = Arc::new(EventMailbox::with_timeline_window(origin, 4.0).unwrap());
    let writer = mailbox.clone();
    let finished = Arc::new(AtomicBool::new(false));
    let completion = finished.clone();
    let reader = thread::spawn(move || -> Result<Vec<Value>, String> {
        let result: Result<Vec<Value>, String> = (|| {
            let mut reader = BufReader::new(stdout);
            let mut events = Vec::new();
            while let Some(event) = read_event(&mut reader)? {
                writer.publish(event.clone())?;
                events.push(event);
                if events.len() > 1000 {
                    return Err("Unbounded device event fixture".into());
                }
            }
            Ok(events)
        })();
        if let Err(error) = &result {
            writer.fail(error.clone());
        }
        completion.store(true, Ordering::Release);
        result
    });
    let running = RunningDevice {
        fixture,
        mailbox,
        finished,
        reader,
        stderr: stderr_task,
    };
    let until = Instant::now() + Duration::from_secs(8);
    loop {
        if running.mailbox.snapshot().unwrap().is_some() {
            break;
        }
        assert!(Instant::now() < until, "native started event timed out");
        thread::sleep(Duration::from_millis(4));
    }
    running
}

#[test]
fn real_wasapi_clock_advances_between_events_without_restarting_device() {
    if std::env::var_os("EDITKIN_TEST_AUDIO_CORE").is_none() {
        eprintln!("REAL_AUDIO_QPC_NOT_MEASURED: EDITKIN_TEST_AUDIO_CORE absent");
        return;
    }
    let running = start_silent_device(10.0);
    let mailbox = running.mailbox.clone();
    let start = Instant::now();
    let mut samples = 0_u64;
    let mut raw_advances = 0_u64;
    let mut correlated_advances = 0_u64;
    let mut max_lead = 0.0_f64;
    let mut last_raw = 0.0;
    let mut last_seconds = 0.0;
    let mut failure = None;
    while !running.finished.load(Ordering::Acquire) && start.elapsed() < Duration::from_secs(12) {
        match mailbox.snapshot() {
            Ok(Some(event)) => match mailbox.clock_sample() {
                Ok(sample) => {
                    let raw = event["timelineSeconds"].as_f64().unwrap();
                    if sample.seconds < last_seconds || sample.seconds > 14.0 + 1e-9 {
                        failure = Some(format!(
                            "correlated timeline regressed/out of window: {} -> {}",
                            last_seconds, sample.seconds
                        ));
                        break;
                    }
                    samples += 1;
                    raw_advances += u64::from(raw > last_raw + 1e-6);
                    correlated_advances += u64::from(sample.seconds > last_seconds + 1e-6);
                    max_lead = max_lead.max(sample.seconds - raw);
                    last_raw = raw;
                    last_seconds = sample.seconds;
                }
                Err(error) => {
                    failure = Some(error);
                    break;
                }
            },
            Ok(None) => {}
            Err(error) => {
                failure = Some(error);
                break;
            }
        }
        thread::sleep(Duration::from_millis(4));
    }
    let ended = running.finish();
    assert!(failure.is_none(), "native clock error: {failure:?}");
    assert_eq!(ended["timelineSeconds"], 14.0);
    assert_eq!(ended["transport"]["unexpectedUnderrunSamples"], 0);
    assert_eq!(ended["lifecycle"]["segmentsStarted"], 1);
    assert_eq!(ended["lifecycle"]["segmentsStopped"], 1);
    assert!(
        samples >= 150,
        "insufficient independent clock samples: {samples}"
    );
    assert!(
        raw_advances >= 60,
        "insufficient native events: {raw_advances}"
    );
    assert!(
        correlated_advances > raw_advances * 2,
        "raw={raw_advances} projected={correlated_advances}"
    );
    assert!(max_lead >= 0.002, "no measured advancement between events");
    assert_eq!(mailbox.clock_sample().unwrap().seconds, 14.0);
    println!(
        "NATIVE_AUDIO_QPC_RECEIPT {}",
        json!({"scope":"real WASAPI clock correlation; not physical A/V lip-sync", "samples":samples,"rawAdvances":raw_advances,"correlatedAdvances":correlated_advances,"maximumObservedLeadMs":max_lead*1000.0,"elapsedMs":start.elapsed().as_millis(),"childExit":0,"nativeFinal":ended})
    );
}
