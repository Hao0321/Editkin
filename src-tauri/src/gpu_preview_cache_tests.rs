use super::*;
use crate::{
    gpu_preview_owner::{cleanup_native, PreviewOwners},
    gpu_resident_process::GpuResidentProcess,
};
use serde_json::json;
use std::{collections::BTreeSet, time::Duration};

struct Fixture(PathBuf);

#[test]
fn partial_input_write_failure_retires_only_its_exclusive_request_files() {
    let fixture = Fixture::new();
    let mut cache = PreviewCache::default();
    let mut written = Vec::new();
    let result = cache.prepare_inputs_using(
        &fixture.base(),
        &[b"{}".to_vec(), b"{}".to_vec()],
        |path, bytes| {
            written.push(path.to_path_buf());
            if written.len() == 2 {
                return Err("fixture write failure".into());
            }
            fs::write(path, bytes).map_err(|error| error.to_string())
        },
    );
    assert_eq!(result.unwrap_err(), "fixture write failure");
    assert_eq!(written.len(), 2);
    assert!(written.iter().all(|path| !path.exists()));
    assert!(cache.groups.is_empty());
    let (job, paths) = cache
        .prepare_inputs(&fixture.base(), &[b"{}".to_vec()])
        .unwrap();
    assert!(paths[0].is_file());
    cache.retire_group(job);
    assert!(cache.groups.is_empty());
}

#[test]
fn explicit_shutdown_retires_all_generated_files_and_rejects_new_work() {
    let fixture = Fixture::new();
    let mut cache = PreviewCache::default();
    let path = cache
        .frame_path(&fixture.base(), "active", FrameKind::Image)
        .unwrap();
    fs::write(&path, b"frame").unwrap();
    let (_job, paths) = cache
        .prepare_inputs(&fixture.base(), &[b"{}".to_vec()])
        .unwrap();
    let namespace = cache.root.as_ref().unwrap().clone();
    cache.close();
    assert!(!path.exists());
    assert!(!paths[0].exists());
    assert!(!namespace.exists());
    assert!(cache.groups.is_empty());
    assert!(cache
        .frame_path(&fixture.base(), "after-close", FrameKind::Image)
        .unwrap_err()
        .contains("closed"));
    assert!(cache
        .prepare_inputs(&fixture.base(), &[b"{}".to_vec()])
        .unwrap_err()
        .contains("closed"));
    cache.close();
    assert!(!namespace.exists());
}
impl Fixture {
    fn new() -> Self {
        let parent = PathBuf::from(
            std::env::var_os("EDITKIN_TEST_CACHE_ROOT").expect("isolated fixture root required"),
        );
        checked_directory(&parent, false).unwrap();
        let root = parent.join(format!(
            "test-{}-{}",
            std::process::id(),
            NAMESPACE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        Self(root)
    }
    fn base(&self) -> PathBuf {
        self.0.join("cache")
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        // Exact known empty fixture directories only. Failure artifacts stay
        // for diagnosis; never recursively remove a failed fixture.
        for path in [
            self.base().join("gpu-compositor/preview-owned-v1"),
            self.base().join("gpu-compositor"),
            self.base(),
            self.0.clone(),
        ] {
            let _ = fs::remove_dir(path);
        }
    }
}

#[test]
fn repeated_generations_and_frame_slots_are_bounded_and_do_not_delete_unrelated_media() {
    let fixture = Fixture::new();
    let media = fixture.0.join("original.mov");
    fs::write(&media, b"original-media-sentinel").unwrap();
    let mut cache = PreviewCache::default();
    for generation in 0..100 {
        let image = format!("owner-{generation}-image");
        let video = format!("owner-{generation}-video");
        let mut images = BTreeSet::new();
        let mut videos = BTreeSet::new();
        for frame in 0..9 {
            let path = cache
                .frame_path(&fixture.base(), &image, FrameKind::Image)
                .unwrap();
            fs::write(&path, [frame]).unwrap();
            images.insert(path);
            let path = cache
                .frame_path(&fixture.base(), &video, FrameKind::Video)
                .unwrap();
            fs::write(&path, [frame]).unwrap();
            videos.insert(path);
        }
        assert_eq!(images.len(), 2);
        assert_eq!(videos.len(), 3);
        assert_eq!(cache.groups.len(), 2);
        cache.retire_sessions(&[&image, &video]);
        assert!(images.iter().chain(videos.iter()).all(|p| !p.exists()));
        assert!(cache.groups.is_empty());
    }
    assert_eq!(fs::read(&media).unwrap(), b"original-media-sentinel");
    println!(
        "CACHE_GENERATIONS_RECEIPT {}",
        json!({"generations":100,"imageSlots":2,"videoSlots":3,"remainingGroups":cache.groups.len(),"mediaPreserved":true})
    );
    fs::remove_file(media).unwrap();
}

#[test]
fn exact_retirement_preserves_successor_and_input_paths_never_enter_frame_scope() {
    let fixture = Fixture::new();
    let mut cache = PreviewCache::default();
    let old = cache
        .frame_path(&fixture.base(), "old", FrameKind::Image)
        .unwrap();
    fs::write(&old, b"old").unwrap();
    let new = cache
        .frame_path(&fixture.base(), "new", FrameKind::Image)
        .unwrap();
    fs::write(&new, b"new").unwrap();
    let (job, paths) = cache
        .prepare_inputs(
            &fixture.base(),
            &[b"{}".to_vec(), b"{\"private\":true}".to_vec()],
        )
        .unwrap();
    assert!(new.starts_with(cache.frame_scope().unwrap()));
    assert!(paths
        .iter()
        .all(|p| !p.starts_with(cache.frame_scope().unwrap())));
    cache.retire_sessions(&["old"]);
    cache.retire_sessions(&["old"]);
    assert!(!old.exists());
    assert_eq!(fs::read(&new).unwrap(), b"new");
    assert!(paths.iter().all(|p| p.is_file()));
    cache.retire_group(job);
    assert!(paths.iter().all(|p| !p.exists()));
    cache.retire_sessions(&["new"]);
    assert!(cache.groups.is_empty());
}

#[test]
fn unknown_descendants_and_substituted_file_directories_are_not_deleted() {
    let fixture = Fixture::new();
    let mut cache = PreviewCache::default();
    let path = cache
        .frame_path(&fixture.base(), "substituted", FrameKind::Image)
        .unwrap();
    fs::create_dir(&path).unwrap();
    let sentinel = path.join("user.txt");
    fs::write(&sentinel, b"not ours").unwrap();
    cache.retire_sessions(&["substituted"]);
    assert_eq!(cache.deferred_groups(), 1);
    assert_eq!(fs::read(&sentinel).unwrap(), b"not ours");
    fs::remove_file(sentinel).unwrap();
    fs::remove_dir(&path).unwrap();
    cache.sweep();
    assert!(cache.groups.is_empty());
    let path = cache
        .frame_path(&fixture.base(), "unknown", FrameKind::Video)
        .unwrap();
    let extra = path.parent().unwrap().join("do-not-delete.txt");
    fs::write(&extra, b"unknown").unwrap();
    cache.retire_sessions(&["unknown"]);
    assert_eq!(cache.deferred_groups(), 1);
    assert_eq!(fs::read(&extra).unwrap(), b"unknown");
    fs::remove_file(extra).unwrap();
    cache.sweep();
    assert!(cache.groups.is_empty());
}

#[test]
fn invalid_input_count_size_and_cache_root_are_rejected_without_growth() {
    let fixture = Fixture::new();
    let mut cache = PreviewCache::default();
    assert!(cache.prepare_inputs(&fixture.base(), &[]).is_err());
    assert!(cache
        .prepare_inputs(&fixture.base(), &vec![vec![]; 4])
        .is_err());
    assert!(cache
        .prepare_inputs(&fixture.base(), &[vec![0; MAX_INPUT_BYTES + 1]])
        .is_err());
    assert!(cache
        .frame_path(Path::new("relative-cache"), "x", FrameKind::Image)
        .is_err());
    assert!(cache
        .frame_path(&fixture.0.join("cache/../escape"), "x", FrameKind::Image)
        .is_err());
    assert!(cache.groups.is_empty());
    assert!(cache.root.is_none());
    cache
        .frame_path(&fixture.base(), "x", FrameKind::Image)
        .unwrap();
    assert!(cache
        .frame_path(&fixture.0.join("another-cache"), "x", FrameKind::Image)
        .is_err());
    cache.retire_sessions(&["x"]);
}

#[cfg(windows)]
#[test]
fn real_windows_locked_files_defer_stop_at_quota_and_recover_after_unlock() {
    use std::os::windows::fs::OpenOptionsExt;
    let fixture = Fixture::new();
    let mut cache = PreviewCache::default();
    let mut locks = Vec::new();
    for index in 0..MAX_GROUPS {
        let session = format!("locked-{index}");
        let path = cache
            .frame_path(&fixture.base(), &session, FrameKind::Image)
            .unwrap();
        fs::write(&path, b"locked").unwrap();
        locks.push(
            OpenOptions::new()
                .read(true)
                .share_mode(0)
                .open(&path)
                .unwrap(),
        );
        cache.retire_sessions(&[&session]);
    }
    assert_eq!(cache.deferred_groups(), MAX_GROUPS);
    let error = cache
        .frame_path(&fixture.base(), "must-not-allocate", FrameKind::Video)
        .unwrap_err();
    assert!(error.contains("停止新增"));
    assert_eq!(cache.groups.len(), MAX_GROUPS);
    let issued = cache.next;
    for _ in 0..10 {
        assert!(cache
            .prepare_inputs(&fixture.base(), &[b"{}".to_vec()])
            .is_err());
    }
    assert_eq!(cache.next, issued);
    drop(locks);
    let path = cache
        .frame_path(&fixture.base(), "recovered", FrameKind::Video)
        .unwrap();
    fs::write(&path, b"ok").unwrap();
    assert_eq!(cache.deferred_groups(), 0);
    assert_eq!(cache.groups.len(), 1);
    cache.retire_sessions(&["recovered"]);
    assert!(cache.groups.is_empty());
    println!(
        "CACHE_LOCK_RECEIPT {}",
        json!({"realWindowsExclusiveLocks":MAX_GROUPS,"rejectedExtraRequests":11,"remainingAfterUnlock":cache.groups.len()})
    );
}

#[cfg(windows)]
fn junction(link: &Path, target: &Path) {
    use std::os::windows::process::CommandExt;
    let output=std::process::Command::new(std::env::var_os("EDITKIN_TEST_POWERSHELL").expect("pinned PowerShell required"))
        .args(["-NoProfile","-NonInteractive","-Command","$ErrorActionPreference='Stop'; New-Item -ItemType Junction -Path $env:EDITKIN_TEST_JUNCTION_PATH -Target $env:EDITKIN_TEST_JUNCTION_TARGET | Out-Null"])
        .env("EDITKIN_TEST_JUNCTION_PATH",link).env("EDITKIN_TEST_JUNCTION_TARGET",target).creation_flags(0x08000000).output().unwrap();
    assert!(
        output.status.success(),
        "junction fixture failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[cfg(windows)]
#[test]
fn real_junction_ancestor_and_group_replacement_never_delete_target() {
    let fixture = Fixture::new();
    let outside = fixture.0.join("protected-target");
    fs::create_dir(&outside).unwrap();
    let sentinel = outside.join("frame-0.png");
    fs::write(&sentinel, b"protected").unwrap();
    let link = fixture.0.join("linked-cache");
    junction(&link, &outside);
    let mut cache = PreviewCache::default();
    assert!(cache
        .frame_path(&link, "x", FrameKind::Image)
        .unwrap_err()
        .contains("reparse"));
    assert!(!outside.join("gpu-compositor").exists());
    fs::remove_dir(link).unwrap();
    let frame = cache
        .frame_path(&fixture.base(), "replaced", FrameKind::Image)
        .unwrap();
    let group = frame.parent().unwrap();
    fs::remove_dir(group).unwrap();
    junction(group, &outside);
    cache.retire_sessions(&["replaced"]);
    assert_eq!(cache.deferred_groups(), 1);
    assert_eq!(fs::read(&sentinel).unwrap(), b"protected");
    fs::remove_dir(group).unwrap();
    fs::create_dir(group).unwrap();
    cache.sweep();
    assert!(cache.groups.is_empty());
    fs::remove_file(sentinel).unwrap();
    fs::remove_dir(outside).unwrap();
}

#[test]
fn real_gpu_consumes_inputs_before_retirement_and_rendered_frames_follow_owner() {
    let fixture = Fixture::new();
    let mut cache = PreviewCache::default();
    let executable = PathBuf::from(std::env::var_os("EDITKIN_TEST_GPU").unwrap());
    let mut process = GpuResidentProcess::launch(
        &executable,
        &["serve".into()],
        &std::env::vars_os().collect::<Vec<_>>(),
        Default::default(),
    )
    .unwrap();
    process.ensure_ready(Duration::from_secs(15)).unwrap();
    let mut slot = Some(process);
    let mut owners = PreviewOwners::default();
    let owner = owners.begin(|_| Ok(())).unwrap();
    let graph = fs::read(std::env::var_os("EDITKIN_TEST_GPU_GRAPH").unwrap()).unwrap();
    let (job, paths) = cache.prepare_inputs(&fixture.base(), &[graph]).unwrap();
    slot.as_mut()
        .unwrap()
        .request(
            "load",
            json!({"sessionId":owner.image,"graphPath":paths[0]}),
            Duration::from_secs(10),
        )
        .unwrap();
    cache.retire_group(job);
    assert!(!paths[0].exists());
    let mut frames = BTreeSet::new();
    for _ in 0..5 {
        let path = cache
            .frame_path(&fixture.base(), &owner.image, FrameKind::Image)
            .unwrap();
        let receipt = slot
            .as_mut()
            .unwrap()
            .request(
                "render",
                json!({"sessionId":owner.image,"outputPath":path}),
                Duration::from_secs(10),
            )
            .unwrap();
        let bytes = fs::read(&path).unwrap();
        assert!(bytes.starts_with(b"\x89PNG\r\n\x1a\n"));
        assert_eq!(u32::from_be_bytes(bytes[16..20].try_into().unwrap()), 32);
        assert_eq!(u32::from_be_bytes(bytes[20..24].try_into().unwrap()), 32);
        assert!(receipt["outputHash"].is_string(), "{receipt}");
        frames.insert(path);
    }
    assert_eq!(frames.len(), 2);
    owners
        .end(&owner.token, |old| {
            cleanup_native(&mut slot, old)?;
            cache.retire_sessions(&[&old.image, &old.video, &old.engine_video]);
            Ok(())
        })
        .unwrap();
    assert!(frames.iter().all(|p| !p.exists()));
    assert!(cache.groups.is_empty());
    // Native malformed-graph failure still releases its exact request files.
    let (bad_job, bad_paths) = cache
        .prepare_inputs(&fixture.base(), &[b"not json".to_vec()])
        .unwrap();
    assert!(slot
        .as_mut()
        .unwrap()
        .request(
            "load",
            json!({"sessionId":"bad","graphPath":bad_paths[0]}),
            Duration::from_secs(5)
        )
        .is_err());
    cache.retire_group(bad_job);
    assert!(!bad_paths[0].exists());
    slot.as_mut().unwrap().stop().unwrap();
    assert!(slot.as_ref().unwrap().cleanup_confirmed());
    println!(
        "NATIVE_CACHE_RECEIPT {}",
        json!({"renderedFrames":5,"uniquePngSlots":frames.len(),"inputRetiredBeforeRender":true,"retiredOutputFiles":frames.len(),"malformedGraphInputRetired":true,"remainingGroups":cache.groups.len(),"visiblePresentationTested":false,"ownedCleanupConfirmed":true})
    );
}
