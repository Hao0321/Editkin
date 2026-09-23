//! Exclusively generated, process-local preview artifacts. All calls run on the
//! GPU FIFO worker. No directory enumeration, recursive deletion, source-media
//! deletion, or crash-orphan discovery is performed here.
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Component, Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

pub const MAX_GROUPS: usize = 24;
pub const MAX_INPUT_BYTES: usize = 16 * 1024 * 1024;
static NAMESPACE: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Copy, PartialEq)]
pub enum FrameKind {
    Image,
    Video,
}
impl FrameKind {
    fn slots(self) -> usize {
        if self == Self::Image {
            2
        } else {
            3
        }
    }
}
struct Group {
    id: u64,
    directory: PathBuf,
    files: Vec<PathBuf>,
    frame: Option<(String, FrameKind)>,
    next_slot: usize,
    retired: bool,
}

#[derive(Default)]
pub struct PreviewCache {
    base: Option<PathBuf>,
    root: Option<PathBuf>,
    next: u64,
    groups: Vec<Group>,
    closed: bool,
}

fn redirected(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0 // FILE_ATTRIBUTE_REPARSE_POINT
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}

// Check every existing ancestor, rather than canonicalizing through a junction.
// This is not an adversarial same-user TOCTOU/permissions sandbox.
fn checked_directory(path: &Path, create: bool) -> Result<(), String> {
    if !path.is_absolute()
        || path
            .components()
            .any(|c| matches!(c, Component::ParentDir | Component::CurDir))
    {
        return Err("GPU preview cache requires an absolute, non-traversing directory".into());
    }
    let mut current = PathBuf::new();
    for component in path.components() {
        current.push(component.as_os_str());
        if matches!(component, Component::Prefix(_)) {
            continue;
        }
        let metadata = match fs::symlink_metadata(&current) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound && create => {
                match fs::create_dir(&current) {
                    Ok(()) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                    Err(error) => return Err(format!("GPU preview cache create: {error}")),
                }
                fs::symlink_metadata(&current).map_err(|error| error.to_string())?
            }
            Err(error) => return Err(format!("GPU preview cache directory: {error}")),
        };
        if redirected(&metadata) || !metadata.is_dir() {
            return Err(
                "GPU preview cache refuses a reparse point or non-directory ancestor".into(),
            );
        }
    }
    Ok(())
}

fn remove_generated_file(path: &Path) -> Result<(), String> {
    checked_directory(path.parent().ok_or("Cache file has no parent")?, false)?;
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
        Ok(metadata) if redirected(&metadata) || !metadata.is_file() => {
            Err("GPU preview cache refuses a redirected or substituted generated file".into())
        }
        Ok(_) => fs::remove_file(path).map_err(|error| error.to_string()),
    }
}

impl PreviewCache {
    fn ensure_root(&mut self, base: &Path) -> Result<PathBuf, String> {
        if self.closed {
            return Err("GPU preview cache is closed".into());
        }
        if let Some(previous) = &self.base {
            if previous != base {
                return Err("GPU preview cache root changed during this process".into());
            }
        }
        if let Some(root) = &self.root {
            checked_directory(root, false)?;
            return Ok(root.clone());
        }
        let parent = base.join("gpu-compositor").join("preview-owned-v1");
        checked_directory(&parent, true)?;
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|error| error.to_string())?
            .as_nanos();
        let root = parent.join(format!(
            "{}-{nonce}-{}",
            std::process::id(),
            NAMESPACE.fetch_add(1, Ordering::Relaxed)
        ));
        // Never adopt an earlier process's namespace, even after PID reuse.
        fs::create_dir(&root)
            .map_err(|error| format!("GPU preview cache exclusive namespace: {error}"))?;
        checked_directory(&root, false)?;
        self.base = Some(base.to_path_buf());
        self.root = Some(root.clone());
        Ok(root)
    }

    fn create_group(
        &mut self,
        base: &Path,
        names: &[&str],
        frame: Option<(String, FrameKind)>,
    ) -> Result<u64, String> {
        self.sweep();
        if self.groups.len() >= MAX_GROUPS {
            return Err("預覽快取仍被占用，已停止新增暫存檔。請關閉占用檔案的程式後重試。".into());
        }
        let root = self.ensure_root(base)?;
        let id = self
            .next
            .checked_add(1)
            .ok_or("GPU cache group exhausted")?;
        // Only the frames subtree may be exposed through Tauri's asset protocol;
        // graph JSON/bindings (which contain private paths) stay outside it.
        let parent = root.join(if frame.is_some() { "frames" } else { "inputs" });
        checked_directory(&parent, true)?;
        let directory = parent.join(format!("group-{id}"));
        fs::create_dir(&directory).map_err(|error| error.to_string())?;
        self.next = id;
        self.groups.push(Group {
            id,
            files: names.iter().map(|name| directory.join(name)).collect(),
            directory,
            frame,
            next_slot: 0,
            retired: false,
        });
        Ok(id)
    }

    pub fn frame_path(
        &mut self,
        base: &Path,
        session: &str,
        kind: FrameKind,
    ) -> Result<PathBuf, String> {
        // Session identifiers never become paths, but still bound registry keys.
        if session.is_empty() || session.len() > 128 {
            return Err("Invalid preview cache session".into());
        }
        self.ensure_root(base)?;
        let id = match self.groups.iter().find(|g| {
            !g.retired
                && g.frame
                    .as_ref()
                    .is_some_and(|(s, k)| s == session && *k == kind)
        }) {
            Some(group) => group.id,
            None => self.create_group(
                base,
                &["frame-0.png", "frame-1.png", "frame-2.png"][..kind.slots()],
                Some((session.to_owned(), kind)),
            )?,
        };
        let group = self
            .groups
            .iter_mut()
            .find(|g| g.id == id)
            .ok_or("GPU frame group missing")?;
        let path = group.files[group.next_slot].clone();
        // Unlink only our exact old slot. Never truncate a substituted hard link.
        // A locked slot returns an error instead of allocating unlimited replacements.
        remove_generated_file(&path)?;
        group.next_slot = (group.next_slot + 1) % group.files.len();
        Ok(path)
    }

    pub fn prepare_inputs(
        &mut self,
        base: &Path,
        inputs: &[Vec<u8>],
    ) -> Result<(u64, Vec<PathBuf>), String> {
        self.prepare_inputs_using(base, inputs, |path, bytes| {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(path)
                .map_err(|error| error.to_string())?;
            file.write_all(bytes).map_err(|error| error.to_string())
        })
    }

    fn prepare_inputs_using(
        &mut self,
        base: &Path,
        inputs: &[Vec<u8>],
        mut writer: impl FnMut(&Path, &[u8]) -> Result<(), String>,
    ) -> Result<(u64, Vec<PathBuf>), String> {
        if inputs.is_empty()
            || inputs.len() > 3
            || inputs.iter().any(|bytes| bytes.len() > MAX_INPUT_BYTES)
        {
            return Err("GPU preview inputs exceed the bounded request contract".into());
        }
        let id = self.create_group(
            base,
            &["graph.json", "bindings.json", "effect-bindings.json"][..inputs.len()],
            None,
        )?;
        let paths = self
            .groups
            .iter()
            .find(|g| g.id == id)
            .ok_or("GPU input group missing")?
            .files
            .clone();
        let result = (|| {
            for (path, bytes) in paths.iter().zip(inputs) {
                checked_directory(path.parent().ok_or("GPU input parent missing")?, false)?;
                writer(path, bytes)?;
            }
            Ok(())
        })();
        if let Err(error) = result {
            self.retire_group(id);
            return Err(error);
        }
        Ok((id, paths))
    }

    pub fn retire_group(&mut self, id: u64) {
        if let Some(group) = self.groups.iter_mut().find(|g| g.id == id) {
            group.retired = true;
        }
        self.sweep();
    }

    pub fn retire_sessions(&mut self, sessions: &[&str]) {
        for group in &mut self.groups {
            if group
                .frame
                .as_ref()
                .is_some_and(|(session, _)| sessions.contains(&session.as_str()))
            {
                group.retired = true;
            }
        }
        self.sweep();
    }

    pub fn deferred_groups(&self) -> usize {
        self.groups.iter().filter(|g| g.retired).count()
    }

    pub fn frame_scope(&self) -> Result<PathBuf, String> {
        let path = self
            .root
            .as_ref()
            .ok_or("GPU frame cache not initialized")?
            .join("frames");
        checked_directory(&path, false)?;
        Ok(path)
    }

    fn sweep(&mut self) {
        self.groups.retain(|group| {
            if !group.retired {
                return true;
            }
            // Never enumerate or remove unknown descendants. A substituted or
            // locked file/directory remains tracked and consumes the hard quota.
            if checked_directory(&group.directory, false).is_err() {
                return true;
            }
            let mut complete = true;
            for path in &group.files {
                if remove_generated_file(path).is_err() {
                    complete = false;
                }
            }
            !complete || fs::remove_dir(&group.directory).is_err()
        });
    }

    pub fn close(&mut self) {
        self.closed = true;
        for group in &mut self.groups {
            group.retired = true;
        }
        self.sweep();
        if self.groups.is_empty() {
            if let Some(root) = &self.root {
                if checked_directory(root, false).is_ok() {
                    for name in ["frames", "inputs"] {
                        let path = root.join(name);
                        if checked_directory(&path, false).is_ok() {
                            let _ = fs::remove_dir(path);
                        }
                    }
                    let _ = fs::remove_dir(root);
                }
            }
        }
    }
}

impl Drop for PreviewCache {
    fn drop(&mut self) {
        self.close();
    }
}

#[cfg(test)]
#[path = "gpu_preview_cache_tests.rs"]
mod tests;
