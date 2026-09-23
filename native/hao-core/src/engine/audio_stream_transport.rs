//! The sole PCM producer owns IO, DSP and conversion; the device consumer sees
//! only an atomic committed-frame frontier and the existing SPSC sample ring.
use super::{
    audio::RealtimeAudioTransport,
    audio_stream_pull::{AudioBlockReader, DevicePcmPull},
};
use serde_json::Value;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, AtomicU8, AtomicU64, Ordering},
};
use std::thread::JoinHandle;
use std::time::Duration;

pub const PRODUCER_RUNNING: u8 = 0;
pub const PRODUCER_FINISHED: u8 = 1;
pub const PRODUCER_FAILED: u8 = 2;
pub const PRODUCER_CANCELLED: u8 = 3;

pub struct StreamProducer {
    pub transport: Arc<RealtimeAudioTransport>,
    pub committed: Arc<AtomicU64>,
    pub state: Arc<AtomicU8>,
    cancel: Arc<AtomicBool>,
    result: Arc<Mutex<Option<Result<Value, String>>>>,
    worker: Option<JoinHandle<()>>,
    pub content_frames: u64,
    pub capacity_frames: usize,
}
impl StreamProducer {
    pub fn start<R: AudioBlockReader + 'static>(
        mut pull: DevicePcmPull<R>,
        rate: u32,
        channels: u16,
        padding_frames: usize,
        cancel: Arc<AtomicBool>,
    ) -> Result<Self, String> {
        if !(8_000..=192_000).contains(&rate)
            || !(1..=2).contains(&channels)
            || padding_frames > rate as usize
            || pull.sample_rate() != rate
            || pull.channels() != channels
        {
            return Err("stream producer format/padding invalid or differs from converter".into());
        }
        let content_frames = pull.output_frames();
        let capacity_frames = rate as usize;
        let transport = Arc::new(RealtimeAudioTransport::new(
            rate,
            channels,
            capacity_frames,
        )?);
        let committed = Arc::new(AtomicU64::new(0));
        let state = Arc::new(AtomicU8::new(PRODUCER_RUNNING));
        let result = Arc::new(Mutex::new(None));
        let (t, c, s, x, r) = (
            transport.clone(),
            committed.clone(),
            state.clone(),
            cancel.clone(),
            result.clone(),
        );
        let worker=std::thread::Builder::new().name("editkin-stream-dsp".into()).spawn(move|| {
            let outcome=std::panic::catch_unwind(std::panic::AssertUnwindSafe(||->Result<Value,String>{
                let mut buffer=vec![0.0;1024*channels as usize];
                let mut pending_frames=0;let mut offset=0;let mut sent=0_u64;let mut read_done=false;
                let mut pad=padding_frames;let mut chunks=0_u64;
                loop {
                    if x.load(Ordering::Acquire){return Err("stream producer cancelled".into());}
                    if offset==pending_frames {
                        if !read_done {pending_frames=pull.read(&mut buffer)?;read_done=pending_frames==0;chunks+=u64::from(!read_done);}
                        if read_done {
                            if pad==0 {break;}
                            pending_frames=pad.min(1024);buffer.fill(0.0);pad-=pending_frames;
                        }
                        offset=0;
                    }
                    let consumed=t.master_frame();
                    if consumed>sent {return Err("stream consumer advanced beyond committed PCM".into());}
                    let queued=sent-consumed;
                    if queued>capacity_frames as u64 {return Err("stream ring accounting overflow".into());}
                    let count=(pending_frames-offset).min(capacity_frames-queued as usize);
                    if count==0 {std::thread::sleep(Duration::from_millis(1));continue;}
                    let a=offset*channels as usize;let b=(offset+count)*channels as usize;
                    if t.queue_interleaved(&buffer[a..b])?!=b-a {return Err("stream ring lost a frame-aligned write".into());}
                    sent+=count as u64;offset+=count;
                    // Publication occurs only after *all channels* of these
                    // frames are visible; the consumer cannot read half a frame.
                    c.store(sent,Ordering::Release);
                }
                Ok(serde_json::json!({"schema":"editkin.stream-producer/v1","contentFrames":content_frames,
                    "committedFrames":sent,"paddingFrames":padding_frames,"chunks":chunks,
                    "ringCapacityFrames":capacity_frames,"ringSampleBytes":(capacity_frames*channels as usize+1)*4,
                    "pendingSampleBytes":buffer.len()*4,"pull":pull.receipt()}))
            })).unwrap_or_else(|_|Err("stream producer panicked".into()));
            let outcome = match (outcome, pull.shutdown()) {
                (Ok(value), Ok(())) => Ok(value),
                (Err(primary), Ok(())) => Err(primary),
                (Ok(_), Err(cleanup)) => Err(format!("stream reader cleanup failed: {cleanup}")),
                (Err(primary), Err(cleanup)) => Err(format!("{primary}; reader cleanup failed: {cleanup}")),
            };
            let terminal=if x.load(Ordering::Acquire){PRODUCER_CANCELLED}else if outcome.is_ok(){PRODUCER_FINISHED}else{PRODUCER_FAILED};
            if let Ok(mut slot)=r.lock(){*slot=Some(outcome);}else{s.store(PRODUCER_FAILED,Ordering::Release);return;}
            s.store(terminal,Ordering::Release);
        }).map_err(|e|format!("start stream producer: {e}"))?;
        Ok(Self {
            transport,
            committed,
            state,
            cancel,
            result,
            worker: Some(worker),
            content_frames,
            capacity_frames,
        })
    }
    pub fn available_frames(&self) -> u64 {
        // Single consumer reads this before calling callback_fill. The worker
        // can only add committed frames; callback_fill alone advances master.
        self.committed
            .load(Ordering::Acquire)
            .saturating_sub(self.transport.master_frame())
    }
    pub fn state(&self) -> u8 {
        self.state.load(Ordering::Acquire)
    }
    pub fn cancel_and_finish(&mut self) -> Result<Value, String> {
        self.cancel.store(true, Ordering::Release);
        match self.finish() {
            Ok(value) => Ok(value),
            Err(error)
                if matches!(
                    error.as_str(),
                    "stream producer cancelled"
                        | "codec stream cancelled"
                        | "codec decode cancelled"
                ) =>
            {
                Ok(serde_json::json!({"cancelled":true,"producerJoined":true}))
            }
            Err(error) => Err(error),
        }
    }
    /// Join only after consumption/drain, cancellation or a terminal producer
    /// state; callers must not wait on a full ring they stopped consuming.
    pub fn finish(&mut self) -> Result<Value, String> {
        if let Some(worker) = self.worker.take() {
            worker.join().map_err(|_| "stream producer join failed")?;
        }
        self.result
            .lock()
            .map_err(|_| "stream producer result poisoned")?
            .take()
            .ok_or_else(|| "stream producer has no terminal receipt".to_string())?
    }
}
impl Drop for StreamProducer {
    fn drop(&mut self) {
        self.cancel.store(true, Ordering::Release);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

#[cfg(test)]
#[path = "audio_stream_transport_tests.rs"]
mod tests;
