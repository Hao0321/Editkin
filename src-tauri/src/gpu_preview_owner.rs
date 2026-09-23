//! FIFO preview ownership, not an authorization token or permissions sandbox.
//! The same native command worker serializes begin/check/work/end. A command
//! already running completes before ownership transfer; no stale queued work
//! may execute after the successor is activated.
use serde_json::{json, Value};

#[derive(Clone, Debug, PartialEq)]
pub struct PreviewOwner {
    pub token: String,
    pub image: String,
    pub video: String,
    pub engine_video: String,
}
impl PreviewOwner {
    pub fn receipt(&self) -> Value {
        json!({"schema":"editkin.gpu-preview-owner/v1","token":self.token,
            "sessions":{"image":self.image,"video":self.video,"engineVideo":self.engine_video}})
    }
}
#[derive(Clone, Copy)]
pub enum PreviewResource {
    Image,
    Video,
    EngineVideo,
}

#[derive(Default)]
pub struct PreviewOwners {
    next: u64,
    current: Option<PreviewOwner>,
    cleanup_failure: Option<String>,
}
impl PreviewOwners {
    pub fn begin(
        &mut self,
        cleanup: impl FnOnce(&PreviewOwner) -> Result<(), String>,
    ) -> Result<PreviewOwner, String> {
        let next = self
            .next
            .checked_add(1)
            .ok_or("GPU preview generation exhausted")?;
        if let Some(owner) = self.current.as_ref() {
            if let Err(error) = cleanup(owner) {
                self.cleanup_failure = Some(error.clone());
                return Err(error);
            }
        }
        // Session output files share the application cache. Separate concurrent
        // desktop processes as well as successive owners within this process.
        let token = format!("gpu-owner-{}-{next}", std::process::id());
        let owner = PreviewOwner {
            image: format!("{token}-image"),
            video: format!("{token}-video"),
            engine_video: format!("{token}-engine-video"),
            token,
        };
        self.next = next;
        self.current = Some(owner.clone());
        self.cleanup_failure = None;
        Ok(owner)
    }
    pub fn check(
        &self,
        token: Option<&str>,
        resource: Option<(&str, PreviewResource)>,
    ) -> Result<(), String> {
        if self.cleanup_failure.is_some() {
            return Err("GPU preview cleanup unconfirmed; owner inactive".into());
        }
        match (&self.current, token) {
            (None, None) => Ok(()), // Explicit unowned callers remain usable only while no preview owns the device.
            (Some(owner), Some(token)) if token == owner.token => {
                if let Some((session, kind)) = resource {
                    let expected = match kind {
                        PreviewResource::Image => &owner.image,
                        PreviewResource::Video => &owner.video,
                        PreviewResource::EngineVideo => &owner.engine_video,
                    };
                    if session != expected {
                        return Err(
                            "GPU preview session does not belong to owner/resource kind".into()
                        );
                    }
                }
                Ok(())
            }
            _ => Err("GPU preview owner expired or missing; command not executed".into()),
        }
    }
    pub fn end(
        &mut self,
        token: &str,
        cleanup: impl FnOnce(&PreviewOwner) -> Result<(), String>,
    ) -> Result<bool, String> {
        let Some(owner) = self.current.as_ref().filter(|owner| owner.token == token) else {
            return Ok(false);
        };
        if let Err(error) = cleanup(owner) {
            self.cleanup_failure = Some(error.clone());
            return Err(error);
        }
        self.current = None;
        self.cleanup_failure = None;
        Ok(true)
    }
}

pub fn cleanup_native(
    slot: &mut Option<crate::gpu_resident_process::GpuResidentProcess>,
    owner: &PreviewOwner,
) -> Result<(), String> {
    let Some(process) = slot.as_mut() else {
        return Ok(());
    };
    if process.is_retired() {
        if process.cleanup_confirmed() {
            *slot = None;
            return Ok(());
        }
        return Err("GPU process cleanup unconfirmed; preview handoff blocked".into());
    }
    let result = (|| {
        process.ensure_ready(std::time::Duration::from_secs(15))?;
        #[cfg(windows)]
        for (command, session) in [
            ("surface_release", None),
            ("engine_video_release", Some(&owner.engine_video)),
            ("video_release", Some(&owner.video)),
        ] {
            let receipt = process.request(
                command,
                json!({"sessionId":session}),
                std::time::Duration::from_secs(if command == "surface_release" { 10 } else { 30 }),
            )?;
            if !receipt["released"].is_boolean()
                || session.is_some_and(|id| {
                    receipt["sessionId"].as_str() != Some(id.as_str())
                        || receipt["fences"]["pendingFenceCount"].as_u64() != Some(0)
                })
            {
                return Err("GPU preview cleanup receipt incomplete".into());
            }
        }
        let receipt = process.request(
            "release",
            json!({"sessionId":owner.image}),
            std::time::Duration::from_secs(60),
        )?;
        if !receipt["released"].is_boolean() || receipt["sessionId"] != owner.image {
            return Err("GPU image cleanup receipt incomplete".into());
        }
        Ok(())
    })();
    if result.is_err() {
        // A failed per-resource teardown is not permission to keep using an
        // uncertain engine. Stop only this owned host; never replay the work.
        let cleanup = process.stop();
        if cleanup.is_ok() {
            *slot = None;
        } else {
            return Err(format!(
                "GPU preview handoff failed; owned process cleanup unconfirmed: {}",
                cleanup.unwrap_err()
            ));
        }
    }
    result
}

#[cfg(test)]
#[path = "gpu_preview_owner_tests.rs"]
mod native_tests;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn successor_is_unique_and_stale_commands_and_release_cannot_touch_it() {
        let mut owners = PreviewOwners::default();
        let first = owners.begin(|_| panic!("no predecessor")).unwrap();
        owners
            .check(
                Some(&first.token),
                Some((&first.image, PreviewResource::Image)),
            )
            .unwrap();
        let second = owners
            .begin(|old| {
                assert_eq!(old, &first);
                Ok(())
            })
            .unwrap();
        assert_ne!(first, second);
        assert!(owners.check(Some(&first.token), None).is_err());
        assert!(owners.check(None, None).is_err());
        assert!(!owners
            .end(&first.token, |_| panic!("stale cleanup"))
            .unwrap());
        owners.check(Some(&second.token), None).unwrap();
        owners.check(Some(&second.token), Some((&second.video, PreviewResource::Video))).unwrap();
        owners.check(Some(&second.token), Some((&second.engine_video, PreviewResource::EngineVideo))).unwrap();
        assert!(owners
            .check(
                Some(&second.token),
                Some((&first.image, PreviewResource::Image))
            )
            .is_err());
        assert!(owners
            .check(
                Some(&second.token),
                Some((&second.video, PreviewResource::Image))
            )
            .is_err());
        assert!(owners.end(&second.token, |_| Ok(())).unwrap());
        assert!(owners.check(Some(&second.token), None).is_err());
        owners.check(None, None).unwrap();
    }
    #[test]
    fn cleanup_failure_prevents_activation_and_old_owner_work_until_real_cleanup_succeeds() {
        let mut owners = PreviewOwners::default();
        let first = owners.begin(|_| Ok(())).unwrap();
        assert!(owners.begin(|_| Err("cleanup fault".into())).is_err());
        assert_eq!(owners.next, 1);
        assert!(owners.check(Some(&first.token), None).is_err());
        assert!(owners
            .end(&first.token, |_| Err("still not cleaned".into()))
            .is_err());
        let second = owners
            .begin(|old| {
                assert_eq!(old, &first);
                Ok(())
            })
            .unwrap();
        assert_eq!(owners.next, 2);
        owners.check(Some(&second.token), None).unwrap();
    }
}
