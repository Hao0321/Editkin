//! Owned, non-shell preview subprocesses. The supervisor owns deadlines and I/O
//! budgets; this module owns only creation, process identity and termination.
//!
//! Windows: atomic job assignment at CreateProcessW, with no breakaway enabled.
//! Unix: an owned process group, not a sandbox. A descendant that deliberately
//! calls setsid/setpgid can escape; do not describe this as Windows Job parity.
//! Always terminate_tree (also after a normal leader exit), then poll both
//! try_wait and tree_is_empty before considering cleanup successful.
use std::{
    ffi::OsString,
    io::{self, Read, Write},
    path::Path,
};

#[cfg(windows)]
#[path = "owned_process/windows.rs"]
mod platform;
#[cfg(unix)]
#[path = "owned_process/unix.rs"]
mod platform;

#[cfg(any(windows, unix))]
pub use platform::{spawn, spawn_with_environment, spawn_with_environment_and_cwd, OwnedProcess};

pub struct Spawned {
    pub process: OwnedProcess,
    pub stdin: Box<dyn Write + Send>,
    pub stdout: Box<dyn Read + Send>,
    pub stderr: Box<dyn Read + Send>,
}

fn validate_executable(executable: &Path, args: &[OsString]) -> io::Result<()> {
    if !executable.is_absolute() || !executable.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Preview executable must be an existing absolute file; PATH/shell fallback is disabled",
        ));
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        if !executable
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("exe"))
            || executable
                .as_os_str()
                .encode_wide()
                .any(|unit| unit == 0 || unit == 34)
            || args
                .iter()
                .any(|arg| arg.encode_wide().any(|unit| unit == 0))
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Preview requires a direct .exe path and arguments without NUL",
            ));
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        if executable.as_os_str().as_bytes().contains(&0)
            || args.iter().any(|arg| arg.as_bytes().contains(&0))
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "NUL in preview invocation",
            ));
        }
    }
    Ok(())
}

fn validate_environment(environment: &[(OsString, OsString)]) -> io::Result<()> {
    let mut seen = std::collections::BTreeSet::new();
    for (key, value) in environment {
        let key_text = key.to_string_lossy();
        if key_text.is_empty()
            || key_text.contains('=')
            || key_text.chars().any(char::is_control)
            || value
                .to_string_lossy()
                .chars()
                .any(|character| character == '\0')
            || !seen.insert(key_text.to_ascii_uppercase())
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Invalid or duplicate clean environment entry",
            ));
        }
    }
    Ok(())
}

fn validate_cwd(cwd: &Path) -> io::Result<()> {
    if !cwd.is_absolute() || !cwd.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Owned process cwd must be an existing absolute directory",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relative_executable_never_uses_path_lookup() {
        assert!(validate_executable(Path::new("node.exe"), &[]).is_err());
    }

    #[test]
    fn arguments_with_nul_are_rejected_before_spawn() {
        let executable = std::env::current_exe().unwrap();
        assert!(validate_executable(&executable, &[OsString::from("before\0after")]).is_err());
    }

    #[test]
    fn clean_environment_rejects_duplicates_injection_and_nul() {
        assert!(validate_environment(&[
            (OsString::from("SAFE"), OsString::from("one")),
            (OsString::from("OTHER"), OsString::from("two")),
        ])
        .is_ok());
        assert!(validate_environment(&[
            (OsString::from("SAFE"), OsString::from("one")),
            (OsString::from("safe"), OsString::from("two")),
        ])
        .is_err());
        assert!(validate_environment(&[(OsString::from("BAD=KEY"), OsString::from("x"))]).is_err());
        assert!(validate_environment(&[(OsString::from("SAFE"), OsString::from("x\0y"))]).is_err());
    }

    #[test]
    fn explicit_cwd_must_be_existing_absolute_directory() {
        assert!(validate_cwd(Path::new("relative")).is_err());
        assert!(validate_cwd(&std::env::temp_dir()).is_ok());
        assert!(validate_cwd(&std::env::temp_dir().join("editkin-missing-cwd-fixture")).is_err());
    }
}
