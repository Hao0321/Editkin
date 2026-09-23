use super::*;
use crate::engine::{audio::AudioBuffer, audio_stream::StreamBlock};
use std::time::Instant;
struct Reader {
    at: u64,
    end: u64,
    fail: bool,
}
impl AudioBlockReader for Reader {
    fn next_block(&mut self) -> Result<Option<StreamBlock>, String> {
        if self.fail {
            return Err("injected producer read failure".into());
        }
        if self.at == self.end {
            return Ok(None);
        }
        let at = self.at;
        let n = (self.end - at).min(257) as usize;
        self.at += n as u64;
        Ok(Some(StreamBlock {
            generation: 1,
            start_frame: at,
            buffer: AudioBuffer {
                sample_rate: 48000,
                channels: 2,
                samples: (at..self.at)
                    .flat_map(|i| [(i % 1000) as f32 / 1000.0, -((i % 1000) as f32) / 1000.0])
                    .collect(),
            },
        }))
    }
    fn receipt(&self) -> Value {
        serde_json::json!({"at":self.at})
    }
}
fn producer(frames: u64, fail: bool, cancel: Arc<AtomicBool>) -> StreamProducer {
    let pull = DevicePcmPull::new(
        Reader {
            at: 0,
            end: frames,
            fail,
        },
        1,
        0,
        frames,
        48000,
        2,
    )
    .unwrap();
    StreamProducer::start(pull, 48000, 2, 0, cancel).unwrap()
}
#[test]
fn producer_backpressure_is_bounded_and_sample_exact_across_threads() {
    let mut p = producer(120000, false, Arc::new(AtomicBool::new(false)));
    let deadline = Instant::now() + Duration::from_secs(4);
    while p.available_frames() != 48000 && Instant::now() < deadline {
        std::thread::yield_now();
    }
    assert_eq!(p.available_frames(), 48000);
    assert_eq!(p.state(), PRODUCER_RUNNING);
    let mut position = 0;
    let mut block = vec![0.0; 254 * 2];
    while position < 120000 {
        assert!(
            Instant::now() < deadline,
            "producer failed to make progress"
        );
        let n = 254.min(120000 - position);
        if p.available_frames() < n as u64 {
            std::thread::yield_now();
            continue;
        }
        p.transport.callback_fill(&mut block[..n * 2]).unwrap();
        for (i, pair) in block[..n * 2].chunks(2).enumerate() {
            let value = ((position + i) % 1000) as f32 / 1000.0;
            assert_eq!(pair, [value, -value]);
        }
        position += n;
    }
    assert_eq!(p.transport.underrun_samples(), 0);
    assert_eq!(p.finish().unwrap()["pull"]["finished"], true);
    assert_eq!(p.state(), PRODUCER_FINISHED);
}
#[test]
fn producer_failure_and_full_ring_cancel_have_distinct_terminal_states() {
    let pull = DevicePcmPull::new(
        Reader {
            at: 0,
            end: 10,
            fail: false,
        },
        1,
        0,
        10,
        48000,
        2,
    )
    .unwrap();
    assert!(StreamProducer::start(pull, 44100, 2, 0, Arc::new(AtomicBool::new(false))).is_err());
    let mut p = producer(1000, true, Arc::new(AtomicBool::new(false)));
    assert!(p.finish().unwrap_err().contains("injected"));
    assert_eq!(p.state(), PRODUCER_FAILED);
    let cancel = Arc::new(AtomicBool::new(false));
    let mut p = producer(480000, false, cancel.clone());
    let deadline = Instant::now() + Duration::from_secs(2);
    while p.available_frames() < 48000 && Instant::now() < deadline {
        std::thread::yield_now();
    }
    assert_eq!(p.available_frames(), 48000);
    let start = Instant::now();
    cancel.store(true, Ordering::Release);
    assert!(p.finish().unwrap_err().contains("cancelled"));
    assert_eq!(p.state(), PRODUCER_CANCELLED);
    assert!(start.elapsed() < Duration::from_millis(500));
}

#[test]
fn reader_cleanup_failure_cannot_be_relabelled_as_successful_cancellation() {
    struct BadClose(Reader);
    impl AudioBlockReader for BadClose {
        fn next_block(&mut self) -> Result<Option<StreamBlock>, String> {
            self.0.next_block()
        }
        fn receipt(&self) -> Value {
            self.0.receipt()
        }
        fn shutdown(&mut self) -> Result<(), String> {
            Err("injected unclosed decoder".into())
        }
    }
    let pull = DevicePcmPull::new(
        BadClose(Reader {
            at: 0,
            end: 480000,
            fail: false,
        }),
        1,
        0,
        480000,
        48000,
        2,
    )
    .unwrap();
    let mut producer =
        StreamProducer::start(pull, 48000, 2, 0, Arc::new(AtomicBool::new(false))).unwrap();
    let error = producer.cancel_and_finish().unwrap_err();
    assert!(error.contains("injected unclosed decoder"), "{error}");
    assert!(error.contains("cleanup failed"), "{error}");
}
