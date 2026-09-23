//! Owned process group, not containment against deliberate setsid/setpgid.
//! The leader is peeked with WNOWAIT so its PID cannot be reused before the only
//! group-kill attempt. After reaping, this module never signals that PGID again.
use super::{validate_cwd, validate_environment, validate_executable, Spawned};
use std::{
    ffi::OsString,
    io,
    os::unix::process::CommandExt,
    path::Path,
    process::{Child, Command, Stdio},
};

pub struct OwnedProcess {
    child: Child,
    pid: libc::pid_t,
    exit: Option<i32>,
    signalled: bool,
    reaped: bool,
}

impl OwnedProcess {
    pub fn id(&self) -> u32 {
        self.pid as u32
    }

    pub fn try_wait(&mut self) -> io::Result<Option<i32>> {
        if self.exit.is_some() {
            return Ok(self.exit);
        }
        self.peek_leader()
    }

    fn peek_leader(&mut self) -> io::Result<Option<i32>> {
        let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
        if unsafe {
            libc::waitid(
                libc::P_PID,
                self.pid as libc::id_t,
                &mut info,
                libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
            )
        } != 0
        {
            return Err(io::Error::last_os_error());
        }
        if unsafe { info.si_pid() } == 0 {
            return Ok(None);
        }
        let status = unsafe { info.si_status() };
        self.exit = Some(if info.si_code == libc::CLD_EXITED {
            status
        } else {
            128 + status
        });
        Ok(self.exit)
    }

    pub fn terminate_tree(&mut self) -> io::Result<()> {
        if !self.signalled {
            // ECHILD here means ownership was lost (e.g. an external SIGCHLD
            // handler reaped it). Do not risk signalling a reused process group.
            self.peek_leader()?;
            if unsafe { libc::kill(-self.pid, libc::SIGKILL) } != 0 {
                let error = io::Error::last_os_error();
                if error.raw_os_error() != Some(libc::ESRCH) {
                    return Err(error);
                }
            }
            self.signalled = true;
        }
        self.reap_if_exited()?;
        Ok(())
    }

    fn reap_if_exited(&mut self) -> io::Result<()> {
        if self.reaped {
            return Ok(());
        }
        if let Some(status) = self.child.try_wait()? {
            use std::os::unix::process::ExitStatusExt;
            self.exit = Some(
                status
                    .code()
                    .unwrap_or_else(|| 128 + status.signal().unwrap_or(0)),
            );
            self.reaped = true;
        }
        Ok(())
    }

    pub fn tree_is_empty(&mut self) -> io::Result<bool> {
        // Require an explicit cleanup attempt, including on normal leader exit.
        if !self.signalled {
            return Ok(false);
        }
        self.reap_if_exited()?;
        if !self.reaped {
            return Ok(false);
        }
        if unsafe { libc::kill(-self.pid, 0) } == 0 {
            return Ok(false);
        }
        let error = io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::ESRCH) {
            Ok(true)
        } else {
            Err(error)
        }
    }
}

impl Drop for OwnedProcess {
    fn drop(&mut self) {
        // Nonblocking best effort only. Normal supervisor cleanup must poll/reap
        // explicitly; Drop is not a promise that Unix zombies have been reaped.
        let _ = self.terminate_tree();
    }
}

pub fn spawn(executable: &Path, args: &[OsString]) -> io::Result<Spawned> {
    spawn_inner(executable, args, None, None)
}

pub fn spawn_with_environment(
    executable: &Path,
    args: &[OsString],
    environment: &[(OsString, OsString)],
) -> io::Result<Spawned> {
    validate_environment(environment)?;
    spawn_inner(executable, args, Some(environment), None)
}

pub fn spawn_with_environment_and_cwd(
    executable: &Path,
    args: &[OsString],
    environment: &[(OsString, OsString)],
    cwd: &Path,
) -> io::Result<Spawned> {
    validate_environment(environment)?;
    validate_cwd(cwd)?;
    spawn_inner(executable, args, Some(environment), Some(cwd))
}

fn spawn_inner(
    executable: &Path,
    args: &[OsString],
    environment: Option<&[(OsString, OsString)]>,
    cwd: Option<&Path>,
) -> io::Result<Spawned> {
    validate_executable(executable, args)?;
    let mut command = Command::new(executable);
    command.args(args).process_group(0);
    if let Some(environment) = environment {
        command.env_clear().envs(environment.iter().cloned());
    }
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    let child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let mut process = OwnedProcess {
        pid: child.id() as libc::pid_t,
        child,
        exit: None,
        signalled: false,
        reaped: false,
    };
    let stdin = process
        .child
        .stdin
        .take()
        .ok_or_else(|| io::Error::other("Missing preview stdin"))?;
    let stdout = process
        .child
        .stdout
        .take()
        .ok_or_else(|| io::Error::other("Missing preview stdout"))?;
    let stderr = process
        .child
        .stderr
        .take()
        .ok_or_else(|| io::Error::other("Missing preview stderr"))?;
    Ok(Spawned {
        process,
        stdin: Box::new(stdin),
        stdout: Box::new(stdout),
        stderr: Box::new(stderr),
    })
}
