//! Preview-only admission. Reserve synchronously, wait/run only in spawn_blocking.
//! This is not a global service/render worker pool.
use serde_json::{json, Value};
use std::{
    collections::VecDeque,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Condvar, Mutex,
    },
    time::{Duration, Instant},
};

pub const PREVIEW_COMMAND: &str = "resolve_creative_preview";
const ACTIVE_LIMIT: usize = 2;
const QUEUED_LIMIT: usize = 2;
const QUEUE_TIMEOUT: Duration = Duration::from_secs(5);

pub fn preview_payload(asset_id: &str, mode: Option<&str>) -> Result<Value, String> {
    let mode = mode.unwrap_or("media");
    if asset_id.trim().is_empty() || !matches!(mode, "poster" | "media") {
        return Err("素材預覽請指定素材及 poster／media 模式".into());
    }
    Ok(json!({ "assetId": asset_id, "mode": mode }))
}

pub fn personal_visual_pack_root(
    base: &Path,
    debug: bool,
    override_path: Option<PathBuf>,
) -> PathBuf {
    if debug {
        override_path.unwrap_or_else(|| base.join(".personal-packs/hao-visual-library"))
    } else {
        base.join("personal-packs/hao-visual-library")
    }
}

/// The imported creative URI is the full-source identity, never a derivative.
/// Copy only producer metadata; missing claims remain missing (not inferred).
pub fn append_creative_metadata(asset: &mut Value, metadata: &Value) {
    for field in [
        "role",
        "bpm",
        "license",
        "provenance",
        "redistributable",
        "rightsBasis",
        "distributionScope",
    ] {
        if let Some(value) = metadata.get(field) {
            asset[field] = value.clone();
        }
    }
}

#[derive(Default)]
struct AdmissionState {
    active: usize,
    queued: VecDeque<u64>,
    next_ticket: u64,
}

pub struct PreviewLimiter {
    state: Mutex<AdmissionState>,
    changed: Condvar,
    queue_timeout: Duration,
    canceled: Arc<AtomicBool>,
    cleanup_failed: AtomicBool,
}

impl Default for PreviewLimiter {
    fn default() -> Self {
        Self {
            state: Mutex::new(AdmissionState::default()),
            changed: Condvar::new(),
            queue_timeout: QUEUE_TIMEOUT,
            canceled: Arc::new(AtomicBool::new(false)),
            cleanup_failed: AtomicBool::new(false),
        }
    }
}

pub struct PreviewReservation {
    limiter: Arc<PreviewLimiter>,
    queued_ticket: Option<u64>,
    active: bool,
    reserved_at: Instant,
}

impl PreviewLimiter {
    pub fn cancel_token(&self) -> Arc<AtomicBool> {
        self.canceled.clone()
    }

    pub fn is_shutdown(&self) -> bool {
        self.canceled.load(Ordering::Acquire)
    }

    pub fn shutdown(&self) {
        // Hold the queue mutex while notifying to avoid a lost wake between a
        // waiting worker's cancellation check and Condvar::wait_timeout.
        let _guard = self.state.lock().unwrap_or_else(|error| error.into_inner());
        self.canceled.store(true, Ordering::Release);
        self.changed.notify_all();
    }

    /// Only for the final native Exit event, not ordinary UI commands. Tauri's
    /// run loop exits the process directly, so Drop alone cannot cancel/reap
    /// Unix workers. Keep shutdown bounded and expose incomplete cleanup.
    pub fn shutdown_and_wait(&self, timeout: Duration) -> bool {
        self.shutdown();
        let deadline = Instant::now() + timeout;
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        loop {
            if state.active == 0 && state.queued.is_empty() {
                return !self.cleanup_failed.load(Ordering::Acquire);
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return false;
            }
            state = self
                .changed
                .wait_timeout(state, remaining)
                .unwrap_or_else(|error| error.into_inner())
                .0;
        }
    }

    pub fn poison_cleanup(&self) {
        self.cleanup_failed.store(true, Ordering::Release);
        self.shutdown();
    }

    fn check_running(&self) -> Result<(), String> {
        if self.cleanup_failed.load(Ordering::Acquire) {
            Err("素材預覽工作未能完整清理，已停止新預覽，請重新開啟程式".into())
        } else if self.is_shutdown() {
            Err("素材預覽已取消，程式正在關閉".into())
        } else {
            Ok(())
        }
    }

    /// O(1), never waits for capacity. At most four blocking tasks may be spawned.
    pub fn reserve(self: &Arc<Self>) -> Result<PreviewReservation, String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "素材預覽排程狀態失效，請重新開啟程式")?;
        self.check_running()?;
        let immediately_active = state.active < ACTIVE_LIMIT && state.queued.is_empty();
        let queued_ticket = if immediately_active {
            state.active += 1;
            None
        } else {
            if state.queued.len() >= QUEUED_LIMIT {
                return Err("素材預覽忙碌中，請稍候再試（最多兩個預覽及兩個等候請求）".into());
            }
            let ticket = state.next_ticket;
            state.next_ticket = ticket
                .checked_add(1)
                .ok_or("素材預覽排程序號已耗盡，請重新開啟程式")?;
            state.queued.push_back(ticket);
            Some(ticket)
        };
        Ok(PreviewReservation {
            limiter: self.clone(),
            queued_ticket,
            active: immediately_active,
            reserved_at: Instant::now(),
        })
    }
}

impl PreviewReservation {
    /// Caller MUST execute this in a blocking task, never in a UI command body.
    pub fn run<T>(mut self, work: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
        self.wait_for_permit()?;
        work() // Drop releases the active permit on success, error or unwind.
    }

    fn wait_for_permit(&mut self) -> Result<(), String> {
        self.limiter.check_running()?;
        if self.active {
            return Ok(());
        }
        let deadline = self.reserved_at + self.limiter.queue_timeout;
        let mut state = self
            .limiter
            .state
            .lock()
            .map_err(|_| "素材預覽排程狀態失效，請重新開啟程式")?;
        loop {
            self.limiter.check_running()?;
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err("素材預覽等候逾時，請稍候重新預覽".into());
            }
            if state.active < ACTIVE_LIMIT && state.queued.front().copied() == self.queued_ticket {
                state.queued.pop_front();
                state.active += 1;
                self.queued_ticket = None;
                self.active = true;
                self.limiter.changed.notify_all();
                return Ok(());
            }
            state = self
                .limiter
                .changed
                .wait_timeout(state, remaining)
                .map_err(|_| "素材預覽排程狀態失效，請重新開啟程式")?
                .0;
        }
    }
}

impl Drop for PreviewReservation {
    fn drop(&mut self) {
        // No external code runs while this mutex is held. Still release permits
        // on a poisoned lock; subsequent admission itself remains fail-visible.
        let mut state = self
            .limiter
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if self.active {
            state.active = state.active.saturating_sub(1);
            self.active = false;
        } else if let Some(ticket) = self.queued_ticket.take() {
            if let Some(index) = state.queued.iter().position(|queued| *queued == ticket) {
                state.queued.remove(index);
            }
        }
        self.limiter.changed.notify_all();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        sync::{
            atomic::{AtomicUsize, Ordering},
            mpsc,
        },
        thread,
    };

    fn counts(limiter: &PreviewLimiter) -> (usize, usize) {
        let state = limiter.state.lock().unwrap();
        (state.active, state.queued.len())
    }

    #[test]
    fn mode_is_closed_world_and_defaults_to_media() {
        assert_eq!(PREVIEW_COMMAND, "resolve_creative_preview");
        assert_eq!(
            preview_payload("private-visual:abc", None).unwrap(),
            json!({"assetId":"private-visual:abc","mode":"media"})
        );
        assert_eq!(
            preview_payload("private-visual:abc", Some("poster")).unwrap()["mode"],
            "poster"
        );
        for mode in ["", "Media", "source", "../poster", "poster\0"] {
            assert!(preview_payload("asset", Some(mode)).is_err());
        }
        assert!(preview_payload(" ", None).is_err());
    }

    #[test]
    fn visual_roots_respect_debug_only_override_and_unicode() {
        let base = Path::new("D:/Hao 空間/Editkin");
        let override_path = PathBuf::from("E:/Private 視覺/assets");
        assert_eq!(
            personal_visual_pack_root(base, true, None),
            base.join(".personal-packs/hao-visual-library")
        );
        assert_eq!(
            personal_visual_pack_root(base, true, Some(override_path.clone())),
            override_path
        );
        assert_eq!(
            personal_visual_pack_root(base, false, Some(override_path)),
            base.join("personal-packs/hao-visual-library")
        );
    }

    #[test]
    fn private_rights_survive_without_replacing_original_uri() {
        let mut asset = json!({"uri":"creative://private-visual%3Aabc","color":{"interpretation":"auto"},"width":1920});
        let metadata = json!({"uri":"poster.jpg","preview":{"media":"small.mp4"},"role":"transition","license":"PRIVATE-OWNER-ONLY","rightsBasis":"private-owner-only","distributionScope":"private-owner-only","redistributable":false,"provenance":"owner supplied private animation"});
        append_creative_metadata(&mut asset, &metadata);
        assert_eq!(asset["uri"], "creative://private-visual%3Aabc");
        for field in [
            "license",
            "rightsBasis",
            "distributionScope",
            "redistributable",
            "provenance",
        ] {
            assert_eq!(asset[field], metadata[field]);
        }
        assert!(asset.get("preview").is_none());
        let mut no_claim = json!({"uri":"creative://legacy"});
        append_creative_metadata(&mut no_claim, &json!({"role":"broll"}));
        assert!(no_claim.get("rightsBasis").is_none());
        assert!(no_claim.get("redistributable").is_none());
    }

    #[test]
    fn admission_rejects_fifth_before_any_worker_spawn_and_drops_drain() {
        let limiter = Arc::new(PreviewLimiter::default());
        let reservations: Vec<_> = (0..4).map(|_| limiter.reserve().unwrap()).collect();
        assert_eq!(counts(&limiter), (2, 2));
        assert!(limiter.reserve().err().unwrap().contains("忙碌"));
        drop(reservations);
        assert_eq!(counts(&limiter), (0, 0));
        assert!(limiter.reserve().is_ok());
    }

    #[test]
    fn actual_thread_work_never_exceeds_two_and_queue_drains_in_order() {
        let limiter = Arc::new(PreviewLimiter::default());
        let reservations: Vec<_> = (0..4).map(|_| limiter.reserve().unwrap()).collect();
        let active = Arc::new(AtomicUsize::new(0));
        let maximum = Arc::new(AtomicUsize::new(0));
        let (started_tx, started_rx) = mpsc::channel();
        let mut releases = Vec::new();
        let mut handles = Vec::new();
        for (index, reservation) in reservations.into_iter().enumerate() {
            let (release_tx, release_rx) = mpsc::channel();
            releases.push(release_tx);
            let active = active.clone();
            let maximum = maximum.clone();
            let started_tx = started_tx.clone();
            handles.push(thread::spawn(move || {
                reservation.run(|| {
                    let now = active.fetch_add(1, Ordering::SeqCst) + 1;
                    maximum.fetch_max(now, Ordering::SeqCst);
                    started_tx.send(index).unwrap();
                    release_rx.recv_timeout(Duration::from_secs(2)).unwrap();
                    active.fetch_sub(1, Ordering::SeqCst);
                    Ok(())
                })
            }));
        }
        let first = started_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        let second = started_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(first + second, 1);
        assert!(started_rx.try_recv().is_err());
        releases[first].send(()).unwrap();
        assert_eq!(started_rx.recv_timeout(Duration::from_secs(2)).unwrap(), 2);
        releases[second].send(()).unwrap();
        assert_eq!(started_rx.recv_timeout(Duration::from_secs(2)).unwrap(), 3);
        releases[2].send(()).unwrap();
        releases[3].send(()).unwrap();
        for handle in handles {
            assert!(handle.join().unwrap().is_ok());
        }
        assert_eq!(maximum.load(Ordering::SeqCst), 2);
        assert_eq!(counts(&limiter), (0, 0));
    }

    #[test]
    fn queued_timeout_does_not_run_work_or_leak_reservation() {
        let limiter = Arc::new(PreviewLimiter {
            queue_timeout: Duration::from_millis(10),
            ..Default::default()
        });
        let first = limiter.reserve().unwrap();
        let second = limiter.reserve().unwrap();
        let queued = limiter.reserve().unwrap();
        let entered = AtomicUsize::new(0);
        assert!(queued
            .run(|| {
                entered.fetch_add(1, Ordering::SeqCst);
                Ok(())
            })
            .unwrap_err()
            .contains("逾時"));
        assert_eq!(entered.load(Ordering::SeqCst), 0);
        assert_eq!(counts(&limiter), (2, 0));
        drop(first);
        drop(second);
        assert_eq!(counts(&limiter), (0, 0));
    }

    #[test]
    fn failed_service_and_canceled_queue_release_capacity() {
        let limiter = Arc::new(PreviewLimiter::default());
        assert_eq!(
            limiter
                .reserve()
                .unwrap()
                .run::<()>(|| Err("source verification failed".into()))
                .unwrap_err(),
            "source verification failed"
        );
        assert_eq!(counts(&limiter), (0, 0));
        let first = limiter.reserve().unwrap();
        let second = limiter.reserve().unwrap();
        let canceled = limiter.reserve().unwrap();
        let last = limiter.reserve().unwrap();
        drop(canceled);
        drop(first);
        assert_eq!(last.run(|| Ok(7)).unwrap(), 7);
        drop(second);
        assert_eq!(counts(&limiter), (0, 0));
    }
}
