//! Local exclusive workspace and bounded disk admission for the opt-in v2 sequence.
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path};

pub const V2_DISK_RESERVE: u64 = 1024 * 1024 * 1024;
pub const V2_MAX_RAW_BYTES: u64 = 256 * 1024 * 1024;
pub const V2_MAX_OUTPUT_BYTES: u64 = 1024 * 1024 * 1024;

pub fn assert_local_path(path: &Path) -> Result<(), String> {
    if !path.is_absolute() || path.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err("roto v2 requires an absolute local path without traversal".into());
    }
    #[cfg(windows)]
    {
        use std::path::Prefix;
        if !matches!(path.components().next(), Some(Component::Prefix(p)) if matches!(p.kind(), Prefix::Disk(_) | Prefix::VerbatimDisk(_)))
        {
            return Err("roto v2 UNC/device paths refused".into());
        }
    }
    let mut cursor = Some(path);
    while let Some(current) = cursor {
        let meta = fs::symlink_metadata(current).map_err(|e| e.to_string())?;
        if meta.file_type().is_symlink() {
            return Err("roto v2 link refused".into());
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if meta.file_attributes() & 0x400 != 0 {
                return Err("roto v2 reparse point refused".into());
            }
        }
        cursor = current.parent();
    }
    Ok(())
}

pub fn sha256_file(path: &Path) -> Result<String, String> {
    assert_local_path(path)?;
    let mut file = File::open(path).map_err(|e| e.to_string())?;
    if !file.metadata().map_err(|e| e.to_string())?.is_file() {
        return Err("roto v2 regular file required".into());
    }
    let mut digest = Sha256::new();
    let mut buffer = vec![0; 1024 * 1024];
    loop {
        let count = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

pub fn new_file(path: &Path) -> Result<File, String> {
    assert_local_path(path.parent().ok_or("roto v2 output parent missing")?)?;
    OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(path)
        .map_err(|e| e.to_string())
}

pub fn write_new(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut file = new_file(path)?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|e| e.to_string())
}

#[cfg(windows)]
fn free_bytes(path: &Path) -> Result<u64, String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    let name: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut available = 0_u64;
    let success = unsafe {
        GetDiskFreeSpaceExW(
            name.as_ptr(),
            &mut available,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    if success == 0 {
        return Err(format!(
            "roto v2 cannot measure free space: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(available)
}

#[cfg(unix)]
fn free_bytes(path: &Path) -> Result<u64, String> {
    use std::os::unix::ffi::OsStrExt;
    let name = std::ffi::CString::new(path.as_os_str().as_bytes()).map_err(|e| e.to_string())?;
    let mut data = std::mem::MaybeUninit::<libc::statvfs>::uninit();
    if unsafe { libc::statvfs(name.as_ptr(), data.as_mut_ptr()) } != 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    let data = unsafe { data.assume_init() };
    Ok((data.f_bavail as u64).saturating_mul(data.f_frsize as u64))
}

#[cfg(not(any(windows, unix)))]
fn free_bytes(_path: &Path) -> Result<u64, String> {
    Err("roto v2 disk guard unavailable".into())
}

pub fn guard_space(path: &Path, pending: u64) -> Result<(), String> {
    assert_local_path(path)?;
    if pending > V2_MAX_OUTPUT_BYTES || free_bytes(path)? < V2_DISK_RESERVE.saturating_add(pending)
    {
        return Err("roto v2 output budget or one-GiB disk reserve unavailable".into());
    }
    Ok(())
}
