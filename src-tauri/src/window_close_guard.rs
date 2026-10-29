//! Ask before the editor window closes while there is unsaved work or a video is still being exported.
//!
//! The page arms the guard while it has something to lose. A close request then stays open and the page is asked
//! (`editkin:close-requested`); it answers with save-and-close, close without saving, or cancel. A page that never
//! answers (frozen) cannot trap the window: once a request has gone unanswered for UNANSWERED_CLOSE_MS, the next
//! close goes through.
use std::{
    sync::atomic::{AtomicBool, AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{Emitter, Manager};

pub const CLOSE_REQUESTED_EVENT: &str = "editkin:close-requested";
pub const UNANSWERED_CLOSE_MS: u64 = 8_000;

#[derive(Default)]
pub struct CloseGuard {
    armed: AtomicBool,
    approved: AtomicBool,
    asked_at_ms: AtomicU64,
    acknowledged: AtomicBool,
}

#[derive(Debug, PartialEq, Eq)]
pub enum CloseDecision {
    Close,
    AskPage,
}

impl CloseGuard {
    /// Called whenever the page's state changes; it also ends any pending question (the dialog was answered).
    pub fn set_armed(&self, armed: bool) {
        self.armed.store(armed, Ordering::Release);
        self.asked_at_ms.store(0, Ordering::Release);
        self.acknowledged.store(false, Ordering::Release);
    }

    /// The page is showing the question.
    pub fn acknowledge(&self) {
        self.acknowledged.store(true, Ordering::Release);
    }

    /// The creator chose to close; the next close request goes through.
    pub fn approve(&self) {
        self.approved.store(true, Ordering::Release);
    }

    pub fn decide(&self, now_ms: u64) -> CloseDecision {
        if self.approved.load(Ordering::Acquire) || !self.armed.load(Ordering::Acquire) {
            return CloseDecision::Close;
        }
        let asked = self.asked_at_ms.load(Ordering::Acquire);
        let acknowledged = self.acknowledged.load(Ordering::Acquire);
        if asked != 0 && !acknowledged && now_ms.saturating_sub(asked) >= UNANSWERED_CLOSE_MS {
            return CloseDecision::Close;
        }
        if asked == 0 || acknowledged {
            self.asked_at_ms.store(now_ms.max(1), Ordering::Release);
            self.acknowledged.store(false, Ordering::Release);
        }
        CloseDecision::AskPage
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| u64::try_from(duration.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(1)
}

pub fn handle_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    if window.label() != "main" {
        return;
    }
    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
        if window.state::<CloseGuard>().decide(now_ms()) == CloseDecision::AskPage {
            api.prevent_close();
            let _ = window.emit(CLOSE_REQUESTED_EVENT, ());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn closes_directly_when_nothing_would_be_lost() {
        let guard = CloseGuard::default();
        assert_eq!(guard.decide(1_000), CloseDecision::Close);
        guard.set_armed(true);
        guard.set_armed(false);
        assert_eq!(guard.decide(2_000), CloseDecision::Close);
    }

    #[test]
    fn asks_the_page_while_armed_until_it_approves() {
        let guard = CloseGuard::default();
        guard.set_armed(true);
        assert_eq!(guard.decide(1_000), CloseDecision::AskPage);
        guard.acknowledge();
        // The dialog is open: another click asks again (the page brings its dialog forward), however long it waits.
        assert_eq!(guard.decide(60_000), CloseDecision::AskPage);
        guard.acknowledge();
        guard.approve();
        assert_eq!(guard.decide(61_000), CloseDecision::Close);
    }

    #[test]
    fn a_page_that_never_answers_cannot_trap_the_window() {
        let guard = CloseGuard::default();
        guard.set_armed(true);
        assert_eq!(guard.decide(10_000), CloseDecision::AskPage);
        assert_eq!(guard.decide(10_000 + UNANSWERED_CLOSE_MS - 1), CloseDecision::AskPage);
        assert_eq!(guard.decide(10_000 + UNANSWERED_CLOSE_MS), CloseDecision::Close);
    }

    #[test]
    fn answering_cancel_rearms_a_fresh_question() {
        let guard = CloseGuard::default();
        guard.set_armed(true);
        assert_eq!(guard.decide(1_000), CloseDecision::AskPage);
        guard.acknowledge();
        guard.set_armed(true); // the creator chose 「取消」
        assert_eq!(guard.decide(30_000), CloseDecision::AskPage);
        assert_eq!(guard.decide(30_000 + UNANSWERED_CLOSE_MS), CloseDecision::Close);
    }
}
