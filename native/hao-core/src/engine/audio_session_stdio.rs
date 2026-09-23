//! Owned Windows pipe threads. Direct Win32 IO avoids stdio buffering retrying
//! a cancelled write during global flush. Only our own thread handles are used.
use super::audio_session_protocol::{Lines, MAX_EVENT_BYTES, PIPE_QUEUE, WireCommand};
use serde_json::Value;
use std::{
    os::windows::io::AsRawHandle,
    ptr,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, SyncSender, TrySendError},
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};
use windows_sys::Win32::{
    Foundation::{
        ERROR_BROKEN_PIPE, ERROR_OPERATION_ABORTED, GetLastError, HANDLE, INVALID_HANDLE_VALUE,
    },
    Storage::FileSystem::{FILE_TYPE_PIPE, GetFileType, ReadFile, WriteFile},
    System::{
        Console::{GetStdHandle, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE},
        IO::CancelSynchronousIo,
    },
};
pub enum Input {
    Command(WireCommand),
    Eof,
}
pub fn cancel_thread<T>(handle: &JoinHandle<T>) {
    unsafe {
        CancelSynchronousIo(handle.as_raw_handle() as HANDLE);
    }
}
pub struct Worker {
    handle: Option<JoinHandle<Result<(), String>>>,
    stop: Arc<AtomicBool>,
}
impl Worker {
    fn spawn(
        name: &str,
        run: impl FnOnce(Arc<AtomicBool>) -> Result<(), String> + Send + 'static,
    ) -> Result<Self, String> {
        let stop = Arc::new(AtomicBool::new(false));
        let token = stop.clone();
        let handle = thread::Builder::new()
            .name(name.into())
            .spawn(move || run(token))
            .map_err(|e| e.to_string())?;
        Ok(Self {
            handle: Some(handle),
            stop,
        })
    }
    pub fn finished(&self) -> bool {
        self.handle.as_ref().is_none_or(|h| h.is_finished())
    }
    pub fn close(&mut self, drain: bool) -> Result<(), String> {
        let Some(handle) = self.handle.as_ref() else {
            return Ok(());
        };
        let begun = Instant::now();
        let mut interrupted = false;
        while !handle.is_finished() {
            if !drain || begun.elapsed() >= Duration::from_millis(1000) {
                interrupted = true;
                self.stop.store(true, Ordering::Release);
                // Cancellation is a request, not proof. Join below is the proof.
                unsafe {
                    CancelSynchronousIo(handle.as_raw_handle() as HANDLE);
                };
            }
            if begun.elapsed() >= Duration::from_millis(2500) {
                return Err("owned pipe thread failed to join".into());
            }
            thread::sleep(Duration::from_millis(2));
        }
        let result = self
            .handle
            .take()
            .unwrap()
            .join()
            .map_err(|_| "owned pipe worker panicked")?;
        if drain && interrupted {
            return Err("output pipe did not drain; write cancelled".into());
        }
        result
    }
}
impl Drop for Worker {
    fn drop(&mut self) {
        let _ = self.close(false);
    }
}
fn pipe(which: u32) -> Result<isize, String> {
    let h = unsafe { GetStdHandle(which) };
    if h.is_null() || h == INVALID_HANDLE_VALUE || unsafe { GetFileType(h) } != FILE_TYPE_PIPE {
        return Err("resident IPC requires inherited stdin/stdout pipes".into());
    }
    Ok(h as isize)
}
pub fn input() -> Result<(Receiver<Input>, Worker), String> {
    let h = pipe(STD_INPUT_HANDLE)?;
    let (tx, rx) = mpsc::sync_channel(PIPE_QUEUE);
    let worker = Worker::spawn("editkin-session-input", move |stop| {
        let mut lines = Lines::default();
        let mut bytes = [0u8; 4096];
        loop {
            if stop.load(Ordering::Acquire) {
                return Ok(());
            }
            let mut n = 0;
            let ok = unsafe {
                ReadFile(
                    h as HANDLE,
                    bytes.as_mut_ptr(),
                    bytes.len() as u32,
                    &mut n,
                    ptr::null_mut(),
                )
            };
            if ok == 0 {
                let error = unsafe { GetLastError() };
                if error == ERROR_OPERATION_ABORTED && stop.load(Ordering::Acquire) {
                    return Ok(());
                }
                if error != ERROR_BROKEN_PIPE {
                    return Err(format!("input pipe read failed: {error}"));
                }
                n = 0;
            }
            if n == 0 {
                lines.finish()?;
                tx.try_send(Input::Eof)
                    .map_err(|_| "input EOF could not be queued")?;
                return Ok(());
            }
            lines.push(&bytes[..n as usize], |command| {
                tx.try_send(Input::Command(command))
                    .map_err(|_| "input command queue overflow/disconnected".into())
            })?;
        }
    })?;
    Ok((rx, worker))
}
pub struct Output {
    tx: Option<SyncSender<Vec<u8>>>,
    pub worker: Worker,
    pub dropped_progress: u64,
}
impl Output {
    pub fn start() -> Result<Self, String> {
        let h = pipe(STD_OUTPUT_HANDLE)?;
        let (tx, rx) = mpsc::sync_channel::<Vec<u8>>(PIPE_QUEUE);
        let worker = Worker::spawn("editkin-session-output", move |stop| {
            loop {
                if stop.load(Ordering::Acquire) {
                    return Ok(());
                }
                let bytes = match rx.recv_timeout(Duration::from_millis(10)) {
                    Ok(bytes) => bytes,
                    Err(mpsc::RecvTimeoutError::Timeout) => continue,
                    Err(mpsc::RecvTimeoutError::Disconnected) => return Ok(()),
                };
                let mut at = 0;
                while at < bytes.len() {
                    if stop.load(Ordering::Acquire) {
                        return Ok(());
                    }
                    let mut n = 0;
                    let ok = unsafe {
                        WriteFile(
                            h as HANDLE,
                            bytes[at..].as_ptr(),
                            (bytes.len() - at) as u32,
                            &mut n,
                            ptr::null_mut(),
                        )
                    };
                    if ok == 0 {
                        let error = unsafe { GetLastError() };
                        if error == ERROR_OPERATION_ABORTED && stop.load(Ordering::Acquire) {
                            return Ok(());
                        }
                        return Err(format!("output pipe write failed: {error}"));
                    }
                    if n == 0 {
                        return Err("output pipe made no progress".into());
                    }
                    at += n as usize;
                }
            }
        })?;
        Ok(Self {
            tx: Some(tx),
            worker,
            dropped_progress: 0,
        })
    }
    pub fn send(&mut self, value: &Value) -> Result<(), String> {
        let mut bytes = serde_json::to_vec(value).map_err(|e| e.to_string())?;
        if bytes.len() > MAX_EVENT_BYTES {
            return Err("IPC event exceeds 128 KiB".into());
        }
        bytes.push(b'\n');
        match self
            .tx
            .as_ref()
            .ok_or("output pipe closed")?
            .try_send(bytes)
        {
            Ok(()) => Ok(()),
            Err(TrySendError::Full(_)) if value["event"] == "progress" => {
                self.dropped_progress += 1;
                Ok(())
            }
            Err(TrySendError::Full(_)) => Err("critical IPC output queue full".into()),
            Err(TrySendError::Disconnected(_)) => Err("IPC output worker disconnected".into()),
        }
    }
    pub fn close(&mut self) -> Result<(), String> {
        self.tx.take();
        self.worker.close(true)
    }
}
