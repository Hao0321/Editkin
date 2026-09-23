//! One lazy FIFO owner for blocking GPU desktop work. Admission never waits for
//! a device/decoder; the command future is woken only when its own job completes.
use serde_json::Value;
use std::{
    future::Future,
    panic::{catch_unwind, AssertUnwindSafe},
    pin::Pin,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, SyncSender},
        Arc, Mutex,
    },
    task::{Context, Poll, Waker},
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

const QUEUE_CAPACITY: usize = 8;
const QUEUE_DEADLINE: Duration = Duration::from_secs(5);
type Outcome = Result<Value, String>;
/// Return the delay to the next tick, or None to retire. Each callback executes
/// on the same thread as commands, never concurrently with graph/device work.
pub type PeriodicOperation = Box<dyn FnMut() -> Option<Duration> + Send + 'static>;
struct Periodic {
    work: PeriodicOperation,
    due: Instant,
    start_reply: Option<Arc<Mutex<Reply>>>,
}
type Operation = Box<dyn FnOnce(&mut Option<Periodic>) -> Outcome + Send + 'static>;
#[derive(Default)]
struct Reply {
    result: Option<Outcome>,
    waker: Option<Waker>,
    abandoned: bool,
    delivered: bool,
}

pub struct CommandResult {
    reply: Arc<Mutex<Reply>>,
}
impl Future for CommandResult {
    type Output = Outcome;
    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Outcome> {
        let mut reply = self.reply.lock().unwrap_or_else(|error| error.into_inner());
        if let Some(result) = reply.result.take() {
            reply.delivered = true;
            Poll::Ready(result)
        } else {
            reply.waker = Some(cx.waker().clone());
            Poll::Pending
        }
    }
}
impl Drop for CommandResult {
    fn drop(&mut self) {
        let mut reply = self.reply.lock().unwrap_or_else(|error| error.into_inner());
        reply.abandoned = !reply.delivered;
        reply.result = None;
        reply.waker = None;
    }
}
struct Job {
    work: Operation,
    reply: Arc<Mutex<Reply>>,
    admitted: Instant,
    starts_periodic: bool,
}
fn complete(reply: &Arc<Mutex<Reply>>, result: Outcome) {
    let wake = {
        let mut reply = reply.lock().unwrap_or_else(|error| error.into_inner());
        if reply.abandoned {
            return;
        }
        reply.result = Some(result);
        reply.waker.take()
    };
    if let Some(waker) = wake {
        waker.wake();
    }
}

#[derive(Default)]
struct Worker {
    sender: Option<SyncSender<Job>>,
    thread: Option<JoinHandle<()>>,
}
struct AliveGuard(Arc<AtomicBool>);
impl Drop for AliveGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}
pub struct GpuCommandWorker {
    worker: Mutex<Worker>,
    closed: Arc<AtomicBool>,
    alive: Arc<AtomicBool>,
    queue_deadline: Duration,
    thread_name: &'static str,
}
impl Default for GpuCommandWorker {
    fn default() -> Self {
        Self {
            worker: Mutex::new(Worker::default()),
            closed: Arc::new(AtomicBool::new(false)),
            alive: Arc::new(AtomicBool::new(false)),
            queue_deadline: QUEUE_DEADLINE,
            thread_name: "editkin-gpu-dispatch",
        }
    }
}
impl GpuCommandWorker {
    /// An independent bounded dispatcher, not shared GPU/audio admission.
    pub fn named(thread_name: &'static str) -> Self {
        let mut worker = Self::default();
        worker.thread_name = thread_name;
        worker
    }
    /// Shared with blocking transports so desktop exit also interrupts active I/O.
    pub fn cancellation_flag(&self) -> Arc<AtomicBool> {
        self.closed.clone()
    }
    pub fn submit(
        &self,
        work: impl FnOnce() -> Outcome + Send + 'static,
    ) -> Result<CommandResult, String> {
        self.enqueue(Box::new(move |_| work()), false)
    }
    /// Install only after its queued initializer succeeds. Dropped/expired
    /// start requests are rejected by the same admission policy as commands.
    pub fn schedule(
        &self,
        initialize: impl FnOnce() -> Result<(Value, PeriodicOperation), String> + Send + 'static,
    ) -> Result<CommandResult, String> {
        self.enqueue(
            Box::new(move |periodic| {
                let (receipt, work) = initialize()?;
                *periodic = Some(Periodic {
                    work,
                    due: Instant::now(),
                    start_reply: None,
                });
                Ok(receipt)
            }),
            true,
        )
    }
    fn enqueue(&self, work: Operation, starts_periodic: bool) -> Result<CommandResult, String> {
        let mut worker = self.worker.lock().map_err(|_| "GPU 工作派送狀態失效")?;
        if self.closed.load(Ordering::Acquire) {
            return Err("GPU 工作派送已關閉".into());
        }
        if worker.sender.is_none() {
            let (sender, receiver) = mpsc::sync_channel::<Job>(QUEUE_CAPACITY);
            let closed = self.closed.clone();
            let alive = self.alive.clone();
            self.alive.store(true, Ordering::Release);
            let deadline = self.queue_deadline;
            let handle = thread::Builder::new()
                .name(self.thread_name.into())
                .spawn(move || {
                    let _alive = AliveGuard(alive);
                    let mut periodic: Option<Periodic> = None;
                    loop {
                        let next = match periodic.as_ref() {
                            Some(task) => receiver
                                .recv_timeout(task.due.saturating_duration_since(Instant::now())),
                            None => receiver
                                .recv()
                                .map_err(|_| mpsc::RecvTimeoutError::Disconnected),
                        };
                        match next {
                            Ok(job) => {
                                if !job
                                    .reply
                                    .lock()
                                    .unwrap_or_else(|error| error.into_inner())
                                    .abandoned
                                {
                                    let result = if closed.load(Ordering::Acquire) {
                                        Err("GPU 工作派送已關閉".into())
                                    } else if job.admitted.elapsed() >= deadline {
                                        Err("GPU 工作等候逾時；未執行".into())
                                    } else {
                                        catch_unwind(AssertUnwindSafe(|| (job.work)(&mut periodic)))
                                            .unwrap_or_else(|_| {
                                                Err("GPU 工作發生 panic；未重播".into())
                                            })
                                    };
                                    if job.starts_periodic && result.is_ok() {
                                        if let Some(task) = periodic.as_mut() {
                                            task.start_reply = Some(job.reply.clone());
                                        }
                                    }
                                    complete(&job.reply, result);
                                }
                            }
                            Err(mpsc::RecvTimeoutError::Timeout) => {}
                            Err(mpsc::RecvTimeoutError::Disconnected) => break,
                        }
                        if closed.load(Ordering::Acquire)
                            || periodic
                                .as_ref()
                                .and_then(|task| task.start_reply.as_ref())
                                .is_some_and(|reply| {
                                    reply
                                        .lock()
                                        .unwrap_or_else(|error| error.into_inner())
                                        .abandoned
                                })
                        {
                            periodic = None;
                        } else if periodic
                            .as_ref()
                            .is_some_and(|task| Instant::now() >= task.due)
                        {
                            let task = periodic.as_mut().unwrap();
                            let delay = catch_unwind(AssertUnwindSafe(&mut task.work))
                                .ok()
                                .flatten();
                            match delay {
                                Some(delay) => {
                                    task.due = Instant::now()
                                        + delay
                                            .clamp(Duration::from_millis(1), Duration::from_secs(1))
                                }
                                None => periodic = None,
                            }
                        }
                    }
                })
                .map_err(|error| {
                    self.alive.store(false, Ordering::Release);
                    format!("無法建立 GPU 工作執行緒：{error}")
                })?;
            worker.sender = Some(sender);
            worker.thread = Some(handle);
        }
        let reply = Arc::new(Mutex::new(Reply::default()));
        let job = Job {
            work,
            reply: reply.clone(),
            admitted: Instant::now(),
            starts_periodic,
        };
        worker
            .sender
            .as_ref()
            .unwrap()
            .try_send(job)
            .map_err(|error| match error {
                mpsc::TrySendError::Full(_) => "GPU 工作等候佇列已滿；請稍後再試".to_string(),
                mpsc::TrySendError::Disconnected(_) => "GPU 工作執行緒已中斷；未重播".to_string(),
            })?;
        Ok(CommandResult { reply })
    }
    pub fn shutdown_and_wait(&self, timeout: Duration) -> bool {
        self.closed.store(true, Ordering::Release);
        let handle = {
            let mut worker = self
                .worker
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            worker.sender.take();
            worker.thread.take()
        };
        let Some(handle) = handle else {
            return !self.alive.load(Ordering::Acquire);
        };
        let started = Instant::now();
        while !handle.is_finished() {
            if started.elapsed() >= timeout {
                self.worker
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .thread = Some(handle);
                return false;
            }
            thread::sleep(Duration::from_millis(2));
        }
        handle.join().is_ok()
    }
}
impl Drop for GpuCommandWorker {
    fn drop(&mut self) {
        self.closed.store(true, Ordering::Release);
        self.worker
            .get_mut()
            .unwrap_or_else(|error| error.into_inner())
            .sender
            .take();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::{sync::atomic::AtomicUsize, task::Wake};
    struct WakeThread(thread::Thread);
    impl Wake for WakeThread {
        fn wake(self: Arc<Self>) {
            self.0.unpark();
        }
    }
    fn wait(mut future: CommandResult) -> Outcome {
        let waker = Waker::from(Arc::new(WakeThread(thread::current())));
        let mut cx = Context::from_waker(&waker);
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            if let Poll::Ready(result) = Pin::new(&mut future).poll(&mut cx) {
                return result;
            }
            assert!(Instant::now() < deadline, "completion future did not wake");
            thread::park_timeout(Duration::from_millis(20));
        }
    }
    fn blocked(worker: &GpuCommandWorker) -> (CommandResult, SyncSender<()>) {
        let (ready, entered) = mpsc::sync_channel(1);
        let (release, hold) = mpsc::sync_channel(1);
        let ticket = worker
            .submit(move || {
                ready.send(()).unwrap();
                hold.recv_timeout(Duration::from_secs(2)).unwrap();
                Ok(json!("released"))
            })
            .unwrap();
        entered.recv_timeout(Duration::from_secs(1)).unwrap();
        (ticket, release)
    }
    #[test]
    fn blocked_device_does_not_block_caller_and_fifo_has_a_hard_queue_ceiling() {
        let worker = GpuCommandWorker::default();
        let (first, release) = blocked(&worker);
        let order = Arc::new(Mutex::new(Vec::new()));
        let mut tickets = Vec::new();
        for index in 0..QUEUE_CAPACITY {
            let order = order.clone();
            tickets.push(
                worker
                    .submit(move || {
                        order.lock().unwrap().push(index);
                        Ok(json!(index))
                    })
                    .unwrap(),
            );
        }
        assert!(worker
            .submit(|| panic!("overflow must not execute"))
            .is_err());
        // The caller reached this marker while the device work is still blocked.
        assert!(order.lock().unwrap().is_empty());
        release.send(()).unwrap();
        wait(first).unwrap();
        for (index, ticket) in tickets.into_iter().enumerate() {
            assert_eq!(wait(ticket).unwrap(), json!(index));
        }
        assert_eq!(
            *order.lock().unwrap(),
            (0..QUEUE_CAPACITY).collect::<Vec<_>>()
        );
        assert!(worker.shutdown_and_wait(Duration::from_secs(1)));
    }
    #[test]
    fn abandoned_queued_work_never_mutates() {
        let worker = GpuCommandWorker::default();
        let (first, release) = blocked(&worker);
        let mutations = Arc::new(AtomicUsize::new(0));
        let count = mutations.clone();
        let cancelled = worker
            .submit(move || {
                count.fetch_add(1, Ordering::SeqCst);
                Ok(Value::Null)
            })
            .unwrap();
        drop(cancelled);
        let sentinel = worker.submit(|| Ok(json!(true))).unwrap();
        release.send(()).unwrap();
        wait(first).unwrap();
        wait(sentinel).unwrap();
        assert_eq!(mutations.load(Ordering::SeqCst), 0);
        assert!(worker.shutdown_and_wait(Duration::from_secs(1)));
    }
    #[test]
    fn registered_future_is_woken_on_worker_completion() {
        struct Notify(SyncSender<()>);
        impl Wake for Notify {
            fn wake(self: Arc<Self>) {
                let _ = self.0.try_send(());
            }
        }
        let worker = GpuCommandWorker::default();
        let (mut ticket, release) = blocked(&worker);
        let (notify, notified) = mpsc::sync_channel(1);
        let waker = Waker::from(Arc::new(Notify(notify)));
        let mut cx = Context::from_waker(&waker);
        assert!(matches!(Pin::new(&mut ticket).poll(&mut cx), Poll::Pending));
        release.send(()).unwrap();
        notified
            .recv_timeout(Duration::from_secs(1))
            .expect("worker must wake the command executor");
        assert!(matches!(
            Pin::new(&mut ticket).poll(&mut cx),
            Poll::Ready(Ok(_))
        ));
        assert!(worker.shutdown_and_wait(Duration::from_secs(1)));
    }
    #[test]
    fn expired_work_rejects_before_side_effects() {
        let mut worker = GpuCommandWorker::default();
        worker.queue_deadline = Duration::from_millis(10);
        let (first, release) = blocked(&worker);
        let ticket = worker
            .submit(|| panic!("expired operation must not run"))
            .unwrap();
        thread::sleep(Duration::from_millis(25));
        release.send(()).unwrap();
        wait(first).unwrap();
        assert!(wait(ticket).unwrap_err().contains("等候逾時"));
        assert!(worker.shutdown_and_wait(Duration::from_secs(1)));
    }
    #[test]
    fn panic_is_reported_once_and_worker_keeps_valid_results() {
        let worker = GpuCommandWorker::default();
        let attempts = Arc::new(AtomicUsize::new(0));
        let count = attempts.clone();
        let failed = worker
            .submit(move || {
                count.fetch_add(1, Ordering::SeqCst);
                panic!("fixture panic")
            })
            .unwrap();
        assert!(wait(failed).unwrap_err().contains("未重播"));
        assert_eq!(
            wait(worker.submit(|| Ok(json!(7))).unwrap()).unwrap(),
            json!(7)
        );
        assert_eq!(attempts.load(Ordering::SeqCst), 1);
        assert!(worker.shutdown_and_wait(Duration::from_secs(1)));
    }
    #[test]
    fn shutdown_rejects_queued_work_and_does_not_claim_a_running_job_exited() {
        let worker = GpuCommandWorker::default();
        let (first, release) = blocked(&worker);
        let queued = worker
            .submit(|| panic!("closing operation must not run"))
            .unwrap();
        assert!(!worker.shutdown_and_wait(Duration::from_millis(5)));
        assert!(worker.submit(|| Ok(Value::Null)).is_err());
        release.send(()).unwrap();
        wait(first).unwrap();
        assert!(wait(queued).unwrap_err().contains("關閉"));
        assert!(worker.shutdown_and_wait(Duration::from_secs(1)));
    }

    #[test]
    fn periodic_ticks_and_interactive_commands_share_one_thread_without_overlap() {
        let worker = GpuCommandWorker::default();
        let count = Arc::new(AtomicUsize::new(0));
        let ticks = count.clone();
        let (send, receive) = mpsc::sync_channel(1);
        wait(
            worker
                .schedule(move || {
                    Ok((
                        json!(true),
                        Box::new(move || {
                            let n = ticks.fetch_add(1, Ordering::SeqCst);
                            if n == 4 {
                                send.send(thread::current().id()).unwrap();
                            }
                            Some(Duration::from_millis(2))
                        }),
                    ))
                })
                .unwrap(),
        )
        .unwrap();
        let native_thread = receive.recv_timeout(Duration::from_secs(1)).unwrap();
        for _ in 0..12 {
            wait(
                worker
                    .submit(move || {
                        assert_eq!(thread::current().id(), native_thread);
                        Ok(Value::Null)
                    })
                    .unwrap(),
            )
            .unwrap();
        }
        assert!(count.load(Ordering::SeqCst) >= 5);
        assert!(worker.shutdown_and_wait(Duration::from_secs(1)));
        let stopped = count.load(Ordering::SeqCst);
        thread::sleep(Duration::from_millis(10));
        assert_eq!(count.load(Ordering::SeqCst), stopped);
    }
    #[test]
    fn abandoned_start_during_initialization_never_leaves_a_periodic_producer() {
        let worker = GpuCommandWorker::default();
        let ticks = Arc::new(AtomicUsize::new(0));
        let calls = ticks.clone();
        let (entered, receive) = mpsc::sync_channel(1);
        let (release, hold) = mpsc::sync_channel(1);
        let ticket = worker
            .schedule(move || {
                entered.send(()).unwrap();
                hold.recv_timeout(Duration::from_secs(1)).unwrap();
                Ok((
                    Value::Null,
                    Box::new(move || {
                        calls.fetch_add(1, Ordering::SeqCst);
                        Some(Duration::from_millis(1))
                    }),
                ))
            })
            .unwrap();
        receive.recv_timeout(Duration::from_secs(1)).unwrap();
        drop(ticket);
        release.send(()).unwrap();
        wait(worker.submit(|| Ok(Value::Null)).unwrap()).unwrap();
        assert_eq!(ticks.load(Ordering::SeqCst), 0);
        assert!(worker.shutdown_and_wait(Duration::from_secs(1)));
    }
    #[test]
    fn periodic_panic_retires_producer_without_killing_command_worker() {
        let worker = GpuCommandWorker::default();
        let (send, receive) = mpsc::sync_channel(1);
        wait(
            worker
                .schedule(move || {
                    Ok((
                        Value::Null,
                        Box::new(move || {
                            send.send(()).unwrap();
                            panic!("periodic fixture panic")
                        }),
                    ))
                })
                .unwrap(),
        )
        .unwrap();
        receive.recv_timeout(Duration::from_secs(1)).unwrap();
        assert_eq!(wait(worker.submit(|| Ok(json!(7))).unwrap()).unwrap(), 7);
        assert!(worker.shutdown_and_wait(Duration::from_secs(1)));
    }
}
