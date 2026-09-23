//! One desktop owner. An old UI callback cannot close a newer audio session,
//! and an unconfirmed teardown keeps the slot occupied instead of accumulating
//! replacement processes. Owner IDs are correlation, not authentication tokens.
use super::audio_session_host::{Action, AudioSessionHost, PlanBinding};
use serde_json::{json, Value};
use std::{path::Path, time::Duration};

struct Entry {
    owner: u64,
    host: AudioSessionHost,
}
#[derive(Default)]
pub struct AudioSessionRegistry {
    next: u64,
    current: Option<Entry>,
}
impl AudioSessionRegistry {
    pub fn occupied(&self) -> bool {
        self.current.is_some()
    }
    /// Desktop callers run launch/readiness on their bounded background worker.
    /// This does not select a runtime from renderer or plugin message contents.
    pub fn begin(
        &mut self,
        core: &Path,
        decoder: &Path,
        decoder_sha: &str,
        plans: &Path,
    ) -> Result<Value, String> {
        if self.current.is_some() {
            return Err("Audio owner must be explicitly closed before replacement".into());
        }
        self.next = self
            .next
            .checked_add(1)
            .filter(|n| *n <= 9_007_199_254_740_991)
            .ok_or("Audio owner sequence exhausted")?;
        let owner = self.next;
        self.current = Some(Entry {
            owner,
            host: AudioSessionHost::launch(core, decoder, decoder_sha, plans)?,
        });
        let entry = self.current.as_mut().unwrap();
        if let Err(error) = entry.host.wait_ready(Duration::from_secs(5)) {
            let closure = entry.host.close();
            let confirmed = closure.is_ok() && entry.host.cleanup_confirmed();
            // A failed begin does not return an owner ID to its caller. Retain
            // only an unconfirmed teardown; otherwise clear the retired slot so
            // the user can retry without needing an ID that was never returned.
            if confirmed {
                self.current.take();
            }
            return Err(format!("{error}; cleanup confirmed: {}", confirmed));
        }
        Ok(json!({"ownerId":owner,"state":entry.host.snapshot()?}))
    }
    fn entry(&self, owner: u64) -> Result<&Entry, String> {
        self.current
            .as_ref()
            .filter(|e| e.owner == owner)
            .ok_or("Stale or missing audio owner".into())
    }
    pub fn bind_plan(
        &self,
        owner: u64,
        path: &Path,
        sha: &str,
        generation: u64,
    ) -> Result<PlanBinding, String> {
        self.entry(owner)?.host.bind_plan(path, sha, generation)
    }
    pub fn submit(&self, owner: u64, action: Action) -> Result<Value, String> {
        let request = self.entry(owner)?.host.submit(action)?;
        Ok(json!({"ownerId":owner,"requestId":request,"accepted":true}))
    }
    pub fn snapshot(&self, owner: u64) -> Result<Value, String> {
        Ok(json!({"ownerId":owner,"state":self.entry(owner)?.host.snapshot()?}))
    }
    pub fn close(&mut self, owner: u64) -> Result<Value, String> {
        let entry = self
            .current
            .as_mut()
            .filter(|e| e.owner == owner)
            .ok_or("Stale or missing audio owner")?;
        let receipt = entry.host.close()?;
        if !entry.host.cleanup_confirmed() {
            return Err("Audio owner teardown unconfirmed; replacement blocked".into());
        }
        self.current.take();
        Ok(json!({"ownerId":owner,"released":true,"closure":receipt}))
    }
}
impl Drop for AudioSessionRegistry {
    fn drop(&mut self) {
        if let Some(e) = self.current.as_mut() {
            let _ = e.host.close();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "requires explicit real-device fixture invocation"]
    fn actual_failed_startup_can_retry_only_after_confirmed_cleanup() {
        let path = std::env::var("EDITKIN_AUDIO_IPC_RECEIPT").unwrap();
        let receipt: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        let core = Path::new(receipt["candidate"]["path"].as_str().unwrap());
        let decoder = Path::new(receipt["decoder"]["path"].as_str().unwrap());
        let plans = Path::new(receipt["cases"][0]["args"][1].as_str().unwrap());
        let mut registry = AudioSessionRegistry::default();
        let rejected = registry
            .begin(core, decoder, &"0".repeat(64), plans)
            .unwrap_err();
        assert!(rejected.contains("cleanup confirmed: true"), "{rejected}");
        assert!(registry.current.is_none());
        let ready = registry
            .begin(
                core,
                decoder,
                receipt["decoder"]["sha256"].as_str().unwrap(),
                plans,
            )
            .unwrap();
        assert_eq!(ready["ownerId"], 2);
        let closed = registry.close(2).unwrap();
        assert_eq!(closed["closure"]["cleanup"]["graceful"], true);
        println!(
            "DESKTOP_AUDIO_STARTUP_RECOVERY {}",
            json!({"rejected":rejected,"ready":ready,"closed":closed})
        );
    }
    #[test]
    #[ignore = "requires explicit real-device fixture invocation"]
    fn actual_registry_never_lets_stale_owner_close_a_new_process() {
        let path = std::env::var("EDITKIN_AUDIO_IPC_RECEIPT").unwrap();
        let receipt: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        let core = Path::new(receipt["candidate"]["path"].as_str().unwrap());
        let decoder = Path::new(receipt["decoder"]["path"].as_str().unwrap());
        let sha = receipt["decoder"]["sha256"].as_str().unwrap();
        let plans = Path::new(receipt["cases"][0]["args"][1].as_str().unwrap());
        let mut registry = AudioSessionRegistry::default();
        let a = registry.begin(core, decoder, sha, plans).unwrap();
        let old = a["ownerId"].as_u64().unwrap();
        assert!(registry.begin(core, decoder, sha, plans).is_err());
        assert_eq!(
            registry.snapshot(old).unwrap()["state"]["pid"],
            a["state"]["pid"]
        );
        assert!(registry.close(old + 1).is_err());
        let closed_a = registry.close(old).unwrap();
        assert_eq!(closed_a["closure"]["cleanup"]["graceful"], true);
        let b = registry.begin(core, decoder, sha, plans).unwrap();
        let new = b["ownerId"].as_u64().unwrap();
        assert!(new > old);
        assert!(registry.close(old).is_err());
        assert!(registry.submit(old, Action::Snapshot).is_err());
        assert_eq!(
            registry.snapshot(new).unwrap()["state"]["pid"],
            b["state"]["pid"]
        );
        let closed_b = registry.close(new).unwrap();
        assert_eq!(closed_b["closure"]["cleanup"]["graceful"], true);
        println!(
            "DESKTOP_AUDIO_OWNERS {}",
            json!({"old":a,"new":b,"closedOld":closed_a,"closedNew":closed_b})
        );
    }
}
