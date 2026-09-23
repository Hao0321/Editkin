use super::*;
use crate::engine::{
    audio_codec_pipe::DecoderAudit, audio_codec_stream::CodecAudioStream,
    audio_device::physical_output_run_session, audio_stream::StreamBlock,
};
use std::path::Path;
use std::time::Instant;

fn fixture(index: usize) -> (PreparedPlayback, DecoderAudit) {
    let plans = std::env::var("EDITKIN_TEST_SESSION_PLANS").expect("explicit generated test plans");
    let plans: Vec<String> = serde_json::from_str(&plans).unwrap();
    let decoder = std::env::var("EDITKIN_TEST_FFMPEG").expect("explicit local codec");
    let sha = std::env::var("EDITKIN_TEST_FFMPEG_SHA256").expect("frozen codec SHA");
    let reader = CodecAudioStream::open(
        Path::new(&plans[index]),
        Path::new(&decoder),
        &sha,
        Arc::new(AtomicBool::new(false)),
    )
    .unwrap();
    let audit = reader.audit.clone();
    (reader.into_prepared_playback().unwrap(), audit)
}
fn joined(worker: std::thread::JoinHandle<Result<Value, String>>) -> Result<Value, String> {
    let start = Instant::now();
    while !worker.is_finished() && start.elapsed() < Duration::from_millis(2500) {
        std::thread::sleep(Duration::from_millis(2));
    }
    assert!(
        worker.is_finished(),
        "resident device/producer failed to close within 2500 ms"
    );
    worker.join().expect("resident worker panicked")
}
fn assert_closed(audit: &DecoderAudit) {
    let records = audit.lock().unwrap();
    assert!(!records.is_empty(), "no real codec decoder was launched");
    for row in records.iter() {
        assert_eq!(row["treeClosed"], true);
        assert_eq!(row["pipeThreadsClosed"], true);
        assert!(row["cleanupError"].is_null(), "{row}");
    }
}
struct NeverRead;
impl AudioBlockReader for NeverRead {
    fn next_block(&mut self) -> Result<Option<StreamBlock>, String> {
        panic!("stale reader must never execute")
    }
    fn receipt(&self) -> Value {
        serde_json::json!({"negative":"stale-reader"})
    }
}

#[test]
#[ignore = "requires explicitly frozen local codec fixtures and the real Windows render endpoint"]
fn real_resident_pause_resume_replace_and_end_reuse_one_endpoint() {
    let (first, audit1) = fixture(0);
    let (second, audit2) = fixture(1);
    let (third, audit3) = fixture(2);
    let mut second = Some(second);
    let mut third = Some(third);
    let (client, io) = channel();
    let worker = std::thread::spawn(move || physical_output_run_session(io));
    let ready = client.receive(Duration::from_secs(5)).unwrap();
    assert_eq!(ready["event"], "ready");
    let begun = Instant::now();
    client
        .submit(SessionCommand::Replace {
            request: 1,
            playback: first,
            autoplay: true,
        })
        .unwrap();
    let mut events = vec![ready];
    let mut step = 0;
    let mut sent = Instant::now();
    let mut paused = Value::Null;
    let mut ack_ms = Vec::new();
    let mut last_generation = 0;
    let mut last_presented = 0;
    loop {
        assert!(
            begun.elapsed() < Duration::from_secs(15),
            "resident test exceeded bounded deadline"
        );
        let e = client.receive(Duration::from_secs(2)).unwrap();
        assert_ne!(e["event"], "failed", "{e}");
        let g = e["streamGeneration"].as_u64().unwrap();
        if g != 0 {
            assert!(g >= last_generation);
            if g == last_generation {
                assert!(e["presentedFrame"].as_u64().unwrap() >= last_presented);
            }
            last_generation = g;
            last_presented = e["presentedFrame"].as_u64().unwrap();
            assert!(
                e["presentedFrame"].as_u64().unwrap() <= e["sampleMasterFrame"].as_u64().unwrap()
            );
        }
        let kind = e["event"].as_str().unwrap();
        match (step, kind, g) {
            (0, "progress", 9) if e["presentedFrame"].as_u64().unwrap() > 12000 => {
                sent = Instant::now();
                client
                    .submit(SessionCommand::Pause {
                        request: 2,
                        generation: 9,
                    })
                    .unwrap();
                step = 1;
            }
            (1, "paused", 9) => {
                ack_ms.push(sent.elapsed().as_secs_f64() * 1000.0);
                paused = e.clone();
                std::thread::sleep(Duration::from_millis(220));
                client
                    .submit(SessionCommand::Snapshot { request: 3 })
                    .unwrap();
                step = 2;
            }
            (2, "snapshot", 9) => {
                // Read the hardware clock again after a hold, not a cached UI field.
                assert_eq!(e["presentedFrame"], paused["presentedFrame"]);
                assert_eq!(e["sampleMasterFrame"], paused["sampleMasterFrame"]);
                assert_eq!(e["counts"]["deviceStarts"], 1);
                assert_eq!(e["counts"]["deviceResets"], 0);
                sent = Instant::now();
                client
                    .submit(SessionCommand::Resume {
                        request: 4,
                        generation: 9,
                    })
                    .unwrap();
                step = 3;
            }
            (3, "resumed", 9) => {
                ack_ms.push(sent.elapsed().as_secs_f64() * 1000.0);
                assert_eq!(e["presentedFrame"], paused["presentedFrame"]);
                assert_eq!(e["counts"]["producerStarts"], 1);
                assert_eq!(e["counts"]["deviceStarts"], 2);
                step = 4;
            }
            (4, "progress", 9)
                if e["presentedFrame"].as_u64().unwrap()
                    > paused["presentedFrame"].as_u64().unwrap() + 8000 =>
            {
                sent = Instant::now();
                client
                    .submit(SessionCommand::Replace {
                        request: 5,
                        playback: second.take().unwrap(),
                        autoplay: true,
                    })
                    .unwrap();
                step = 5;
            }
            (5, "started", 10) => {
                ack_ms.push(sent.elapsed().as_secs_f64() * 1000.0);
                assert_eq!(e["presentedFrame"], 0);
                assert_eq!(e["timelineStartFrame"], 31 * 48000 + 123);
                assert_eq!(e["counts"]["deviceOpens"], 1);
                assert_eq!(e["counts"]["deviceResets"], 1);
                assert_closed(&audit1);
                client
                    .submit(SessionCommand::Pause {
                        request: 6,
                        generation: 9,
                    })
                    .unwrap();
                client
                    .submit(SessionCommand::Replace {
                        request: 7,
                        playback: PreparedPlayback::new(
                            NeverRead,
                            9,
                            0,
                            480,
                            Arc::new(AtomicBool::new(false)),
                        )
                        .unwrap(),
                        autoplay: true,
                    })
                    .unwrap();
                client
                    .submit(SessionCommand::Snapshot { request: 7 })
                    .unwrap();
                step = 6;
            }
            (6, "ended", 10) => {
                assert_eq!(e["counts"]["commandsRejected"], 3);
                assert_eq!(e["presentedFrame"], 48000);
                assert_eq!(e["transport"]["underrunSamples"], 0);
                assert_eq!(e["counts"]["deviceOpens"], 1);
                client
                    .submit(SessionCommand::Replace {
                        request: 8,
                        playback: third.take().unwrap(),
                        autoplay: true,
                    })
                    .unwrap();
                step = 7;
            }
            (7, "ended", 11) => {
                assert_eq!(e["presentedFrame"], 480);
                assert_eq!(e["transport"]["underrunSamples"], 0);
                client.submit(SessionCommand::Close { request: 9 }).unwrap();
                step = 8;
            }
            (8, "closed", 0) => {
                assert_eq!(e["counts"]["deviceOpens"], 1);
                assert_eq!(e["counts"]["deviceStarts"], 4);
                assert_eq!(e["counts"]["producerStarts"], 3);
                assert_eq!(e["counts"]["producerJoins"], 3);
                events.push(e);
                break;
            }
            _ => {}
        }
        events.push(e);
    }
    let result = joined(worker).unwrap();
    assert_eq!(result["event"], "closed");
    assert!(
        ack_ms.len() == 3 && ack_ms.iter().all(|ms| *ms <= 1500.0),
        "{ack_ms:?}"
    );
    for a in [&audit1, &audit2, &audit3] {
        assert_closed(a);
    }
    println!(
        "RESIDENT_SESSION_RECEIPT {}",
        serde_json::json!({"events":events,"commandAckMs":ack_ms,
        "elapsedMs":begun.elapsed().as_millis(),"decoders":[audit1.lock().unwrap().clone(),audit2.lock().unwrap().clone(),audit3.lock().unwrap().clone()],
        "workerJoined":true,"boundary":"real native codec/device control, not installed UI, seek DSP parity or acoustic loopback"})
    );
}

#[test]
#[ignore = "requires explicitly frozen local codec fixtures and the real Windows render endpoint"]
fn real_resident_disconnected_controller_closes_decoder_and_endpoint() {
    let (first, audit) = fixture(0);
    let (client, io) = channel();
    let worker = std::thread::spawn(move || physical_output_run_session(io));
    assert_eq!(
        client.receive(Duration::from_secs(5)).unwrap()["event"],
        "ready"
    );
    client
        .submit(SessionCommand::Replace {
            request: 1,
            playback: first,
            autoplay: true,
        })
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(6);
    let mut events = Vec::new();
    loop {
        assert!(Instant::now() < deadline);
        let e = client.receive(Duration::from_secs(2)).unwrap();
        assert_ne!(e["event"], "failed", "{e}");
        let started = e["event"] == "progress" && e["presentedFrame"].as_u64().unwrap() > 0;
        events.push(e);
        if started {
            break;
        }
    }
    let closing = Instant::now();
    drop(client);
    let error = joined(worker).unwrap_err();
    assert!(error.contains("controller disconnected"), "{error}");
    assert_closed(&audit);
    println!(
        "RESIDENT_DISCONNECT_RECEIPT {}",
        serde_json::json!({"error":error,"closureMs":closing.elapsed().as_secs_f64()*1000.0,
        "events":events,"decoders":audit.lock().unwrap().clone(),"workerJoined":true})
    );
}
