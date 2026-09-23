//! Bounded streaming decoder IO with an explicitly owned process tree.
//! FFmpeg is the existing licensed codec dependency; it never receives Editkin
//! mixing, gain, EQ, compressor, ducker or limiter operations.
use super::owned_process::{self, OwnedProcess};
use serde_json::Value;
use std::{
    ffi::OsString,
    io::Read,
    path::Path,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, RecvTimeoutError},
    },
    thread::JoinHandle,
    time::{Duration, Instant},
};
pub const PIPE_BYTES: usize = 32768;
pub type DecoderAudit = Arc<Mutex<Vec<Value>>>;
enum Packet {
    Bytes(Vec<u8>),
    End,
    Failed(String),
}
pub struct DecoderPipe {
    process: OwnedProcess,
    rx: Option<Receiver<Packet>>,
    reader: Option<JoinHandle<()>>,
    stderr_reader: Option<JoinHandle<()>>,
    stderr: Arc<Mutex<Vec<u8>>>,
    pending: Vec<u8>,
    at: usize,
    bytes: u64,
    expected: u64,
    cancel: Arc<AtomicBool>,
    audit: DecoderAudit,
    source_id: String,
    ended: bool,
    closed: bool,
    started: Instant,
}
impl DecoderPipe {
    pub fn start(
        executable: &Path,
        args: &[OsString],
        expected: u64,
        cancel: Arc<AtomicBool>,
        audit: DecoderAudit,
        source_id: String,
    ) -> Result<Self, String> {
        if expected == 0 || expected > 48_000 * 86_400 * 8 {
            return Err("decoder output byte bound invalid".into());
        }
        if cancel.load(Ordering::Acquire) {
            return Err("codec decode cancelled before spawn".into());
        }
        let owned_process::Spawned {
            process,
            stdin,
            mut stdout,
            mut stderr,
        } = owned_process::spawn(executable, args)
            .map_err(|e| format!("spawn owned audio decoder: {e}"))?;
        drop(stdin);
        let (tx, rx) = mpsc::sync_channel(2);
        let tail = Arc::new(Mutex::new(Vec::new()));
        let mut value = Self {
            process,
            rx: Some(rx),
            reader: None,
            stderr_reader: None,
            stderr: tail.clone(),
            pending: Vec::new(),
            at: 0,
            bytes: 0,
            expected,
            cancel,
            audit,
            source_id,
            ended: false,
            closed: false,
            started: Instant::now(),
        };
        value.reader = Some(
            std::thread::Builder::new()
                .name("editkin-codec-pcm".into())
                .spawn(move || {
                    loop {
                        let mut bytes = vec![0_u8; PIPE_BYTES];
                        let packet = match stdout.read(&mut bytes) {
                            Ok(0) => Packet::End,
                            Ok(n) => {
                                bytes.truncate(n);
                                Packet::Bytes(bytes)
                            }
                            Err(e) => Packet::Failed(e.to_string()),
                        };
                        let terminal = !matches!(packet, Packet::Bytes(_));
                        if tx.send(packet).is_err() || terminal {
                            break;
                        }
                    }
                })
                .map_err(|e| format!("start decoder pipe reader: {e}"))?,
        );
        value.stderr_reader = Some(
            std::thread::Builder::new()
                .name("editkin-codec-errors".into())
                .spawn(move || {
                    let mut bytes = [0_u8; 2048];
                    while let Ok(n) = stderr.read(&mut bytes) {
                        if n == 0 {
                            break;
                        }
                        let Ok(mut out) = tail.lock() else {
                            break;
                        };
                        out.extend_from_slice(&bytes[..n]);
                        let excess = out.len().saturating_sub(8192);
                        if excess > 0 {
                            out.drain(..excess);
                        }
                    }
                })
                .map_err(|e| format!("start decoder stderr reader: {e}"))?,
        );
        Ok(value)
    }
    fn next(&mut self) -> Result<bool, String> {
        if self.ended {
            return Ok(false);
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if self.cancel.load(Ordering::Acquire) {
                return Err("codec decode cancelled".into());
            }
            if Instant::now() >= deadline {
                return Err("codec stdout made no progress for five seconds".into());
            }
            match self
                .rx
                .as_ref()
                .ok_or("codec pipe is closed")?
                .recv_timeout(Duration::from_millis(10))
            {
                Ok(Packet::Bytes(bytes)) => {
                    if bytes.is_empty() || bytes.len() > PIPE_BYTES {
                        return Err("codec stdout block exceeds bound".into());
                    }
                    self.pending = bytes;
                    self.at = 0;
                    return Ok(true);
                }
                Ok(Packet::End) => {
                    self.ended = true;
                    return Ok(false);
                }
                Ok(Packet::Failed(error)) => return Err(format!("codec stdout failed: {error}")),
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => {
                    return Err("codec stdout disconnected without EOF".into());
                }
            }
        }
    }
    pub fn read_exact(&mut self, out: &mut [u8]) -> Result<(), String> {
        if out.len() > PIPE_BYTES || self.bytes + out.len() as u64 > self.expected || self.closed {
            return Err("codec requested read exceeds declared output".into());
        }
        let mut offset = 0;
        while offset < out.len() {
            if self.cancel.load(Ordering::Acquire) {
                return Err("codec decode cancelled".into());
            }
            if self.at == self.pending.len() && !self.next()? {
                return Err(format!(
                    "codec source ended early: {} of {} bytes",
                    self.bytes, self.expected
                ));
            }
            let n = (out.len() - offset).min(self.pending.len() - self.at);
            out[offset..offset + n].copy_from_slice(&self.pending[self.at..self.at + n]);
            self.at += n;
            offset += n;
            self.bytes += n as u64;
        }
        Ok(())
    }
    pub fn finish(&mut self) -> Result<(), String> {
        let result = (|| {
            if self.bytes != self.expected {
                return Err("codec source output count is incomplete".to_string());
            }
            if self.at != self.pending.len() || self.next()? {
                return Err("codec source exceeded declared output".into());
            }
            let deadline = Instant::now() + Duration::from_secs(2);
            loop {
                if self.cancel.load(Ordering::Acquire) {
                    return Err("codec decode cancelled".into());
                }
                if let Some(code) = self.process.try_wait().map_err(|e| e.to_string())? {
                    return if code == 0 {
                        Ok(())
                    } else {
                        Err(format!("codec decoder exited with {code}"))
                    };
                }
                if Instant::now() >= deadline {
                    return Err("codec EOF did not produce a child exit".into());
                }
                std::thread::sleep(Duration::from_millis(2));
            }
        })();
        let cleanup = self.close(if result.is_ok() { "finished" } else { "failed" });
        match (result, cleanup) {
            (Ok(()), Ok(())) => Ok(()),
            (Err(primary), Err(cleanup)) => Err(format!("{primary}; cleanup: {cleanup}")),
            (Err(e), _) | (_, Err(e)) => Err(e),
        }
    }
    pub(crate) fn close(&mut self, reason: &str) -> Result<(), String> {
        if self.closed {
            return Ok(());
        }
        self.closed = true;
        // Dropping the receiver first unblocks a producer waiting on backpressure.
        self.rx.take();
        let before = self.process.try_wait().map_err(|e| e.to_string());
        let termination = self.process.terminate_tree().map_err(|e| e.to_string());
        let deadline = Instant::now() + Duration::from_secs(2);
        let mut empty = false;
        let mut cleanup_error = None;
        loop {
            match self.process.tree_is_empty() {
                Ok(true) => {
                    empty = true;
                    break;
                }
                Ok(false) => {}
                Err(e) => {
                    cleanup_error = Some(e.to_string());
                    break;
                }
            }
            if Instant::now() >= deadline {
                cleanup_error = Some("owned decoder tree cleanup deadline exceeded".into());
                break;
            }
            std::thread::sleep(Duration::from_millis(2));
        }
        for handle in [&mut self.reader, &mut self.stderr_reader] {
            while handle.as_ref().is_some_and(|h| !h.is_finished()) && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(2));
            }
            if handle.as_ref().is_some_and(|h| h.is_finished()) {
                if handle.take().unwrap().join().is_err() {
                    cleanup_error = Some("decoder pipe reader panicked".into());
                }
            } else if handle.is_some() {
                cleanup_error = Some("decoder pipe thread failed to close".into());
            }
        }
        let code = self.process.try_wait().map_err(|e| e.to_string());
        let error = termination
            .err()
            .or(cleanup_error)
            .or_else(|| before.as_ref().err().cloned())
            .or_else(|| code.as_ref().err().cloned());
        let tail = self
            .stderr
            .lock()
            .map(|v| String::from_utf8_lossy(&v).to_string())
            .unwrap_or_else(|_| "stderr state poisoned".into());
        if let Ok(mut audit) = self.audit.lock() {
            audit.push(serde_json::json!({"sourceId":self.source_id,"pid":self.process.id(),"reason":reason,
            "exitBeforeCleanup":before.ok().flatten(),"exitCode":code.ok().flatten(),"treeClosed":empty,"pipeThreadsClosed":self.reader.is_none()&&self.stderr_reader.is_none(),
            "decodedBytes":self.bytes,"expectedBytes":self.expected,"maxQueuedChunks":2,"chunkBytes":PIPE_BYTES,"elapsedMs":self.started.elapsed().as_millis(),"stderr":tail,"cleanupError":error}));
        }
        if let Some(error) = error {
            return Err(error);
        }
        if !empty {
            return Err("owned decoder closure unproven".into());
        }
        Ok(())
    }
}
impl Drop for DecoderPipe {
    fn drop(&mut self) {
        let _ = self.close(if self.cancel.load(Ordering::Acquire) {
            "cancelled"
        } else {
            "aborted"
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn decoder_byte_bounds_reject_before_spawn() {
        let audit = Arc::new(Mutex::new(Vec::new()));
        assert!(
            DecoderPipe::start(
                Path::new("not-executed"),
                &[],
                0,
                Arc::new(AtomicBool::new(false)),
                audit.clone(),
                "bad".into()
            )
            .is_err()
        );
        assert!(audit.lock().unwrap().is_empty());
    }
    #[test]
    #[ignore = "requires the explicitly provided local codec fixture executable"]
    fn active_decoder_cancel_closes_owned_tree_and_blocked_pipe_threads() {
        let executable =
            std::env::var_os("EDITKIN_TEST_FFMPEG").expect("explicit codec executable");
        let args = [
            "-hide_banner",
            "-nostdin",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "anullsrc=r=48000:cl=stereo",
            "-t",
            "120",
            "-c:a",
            "pcm_f32le",
            "-f",
            "f32le",
            "pipe:1",
        ]
        .map(OsString::from);
        let cancel = Arc::new(AtomicBool::new(false));
        let audit = Arc::new(Mutex::new(Vec::new()));
        let mut pipe = DecoderPipe::start(
            Path::new(&executable),
            &args,
            48000 * 120 * 8,
            cancel.clone(),
            audit.clone(),
            "cancel-source".into(),
        )
        .unwrap();
        pipe.read_exact(&mut [0_u8; 512]).unwrap();
        let start = Instant::now();
        cancel.store(true, Ordering::Release);
        assert!(
            pipe.read_exact(&mut [0_u8; 512])
                .unwrap_err()
                .contains("cancelled")
        );
        drop(pipe);
        assert!(start.elapsed() < Duration::from_millis(2500));
        let entries = audit.lock().unwrap();
        assert_eq!(entries.len(), 1);
        let r = &entries[0];
        assert_eq!(r["treeClosed"], true);
        assert_eq!(r["pipeThreadsClosed"], true);
        assert!(r["cleanupError"].is_null());
        assert_eq!(r["reason"], "cancelled");
        println!("CODEC_CANCEL_RECEIPT {r}");
    }
}
