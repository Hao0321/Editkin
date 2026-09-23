use super::{validate_cwd, validate_environment, validate_executable, Spawned};
use std::{
    ffi::OsString,
    fs::File,
    io,
    mem::{size_of, size_of_val},
    os::windows::{
        ffi::OsStrExt,
        io::{AsRawHandle, FromRawHandle, OwnedHandle},
    },
    path::Path,
    ptr::{null, null_mut},
};
use windows_sys::Win32::{
    Foundation::{
        SetHandleInformation, ERROR_INVALID_PARAMETER, HANDLE, HANDLE_FLAG_INHERIT, WAIT_FAILED,
        WAIT_OBJECT_0, WAIT_TIMEOUT,
    },
    Security::SECURITY_ATTRIBUTES,
    System::{
        JobObjects::{
            CreateJobObjectW, IsProcessInJob, JobObjectBasicAccountingInformation,
            JobObjectBasicProcessIdList, JobObjectExtendedLimitInformation,
            QueryInformationJobObject, SetInformationJobObject, TerminateJobObject,
            JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, JOBOBJECT_BASIC_PROCESS_ID_LIST,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        },
        Pipes::CreatePipe,
        Threading::{
            CreateProcessW, DeleteProcThreadAttributeList, GetExitCodeProcess,
            InitializeProcThreadAttributeList, OpenProcess, UpdateProcThreadAttribute,
            WaitForSingleObject, CREATE_NO_WINDOW, CREATE_UNICODE_ENVIRONMENT,
            EXTENDED_STARTUPINFO_PRESENT, LPPROC_THREAD_ATTRIBUTE_LIST, PROCESS_INFORMATION,
            PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
            PROC_THREAD_ATTRIBUTE_HANDLE_LIST, PROC_THREAD_ATTRIBUTE_JOB_LIST,
            STARTF_USESTDHANDLES, STARTUPINFOEXW,
        },
    },
};

pub struct OwnedProcess {
    // OwnedHandle is Send/Sync; raw handles are never used as long-lived identity.
    job: OwnedHandle,
    process: OwnedHandle,
    pid: u32,
    exit: Option<i32>,
    cleanup_snapshot: Option<MemberSnapshot>,
    capture_attempted: bool,
    capture_error: Option<String>,
}

const MAX_CAPTURED_MEMBERS: usize = 256;
const MAX_SNAPSHOT_ATTEMPTS: usize = 3;

struct MemberSnapshot {
    total_processes: u32,
    handles: Vec<OwnedHandle>,
}

fn stable_count(before: u32, after: u32) -> io::Result<()> {
    if before != after {
        return Err(io::Error::new(
            io::ErrorKind::WouldBlock,
            "Preview job membership changed across cleanup snapshot/termination",
        ));
    }
    Ok(())
}

fn complete_snapshot(assigned: usize, returned: usize) -> io::Result<()> {
    if assigned > MAX_CAPTURED_MEMBERS || returned > MAX_CAPTURED_MEMBERS {
        return Err(io::Error::other(format!(
            "Preview job member snapshot exceeds 256 processes ({assigned}/{returned})"
        )));
    }
    if assigned != returned {
        return Err(io::Error::new(
            io::ErrorKind::WouldBlock,
            format!("Preview job member snapshot is incomplete ({assigned}/{returned})"),
        ));
    }
    Ok(())
}

impl OwnedProcess {
    pub fn id(&self) -> u32 {
        self.pid
    }

    /// Nonblocking, with the complete Windows exit DWORD retained as i32 bits.
    /// Only zero means success; an actual exit code 259 is not mistaken for live.
    pub fn try_wait(&mut self) -> io::Result<Option<i32>> {
        if self.exit.is_some() {
            return Ok(self.exit);
        }
        match unsafe { WaitForSingleObject(self.process.as_raw_handle(), 0) } {
            WAIT_TIMEOUT => Ok(None),
            WAIT_OBJECT_0 => {
                let mut code = 0;
                if unsafe { GetExitCodeProcess(self.process.as_raw_handle(), &mut code) } == 0 {
                    return Err(io::Error::last_os_error());
                }
                self.exit = Some(code as i32);
                Ok(self.exit)
            }
            WAIT_FAILED => Err(io::Error::last_os_error()),
            _ => Err(io::Error::other("Unexpected preview process wait state")),
        }
    }

    pub fn terminate_tree(&mut self) -> io::Result<()> {
        if !self.capture_attempted {
            self.capture_attempted = true;
            match self.capture_members() {
                Ok(snapshot) => self.cleanup_snapshot = Some(snapshot),
                Err(error) => self.capture_error = Some(error.to_string()),
            }
        }
        // A handle identifies this job even if the leader PID has been reused.
        // Capture failure MUST NOT skip termination of the owned job.
        let termination_error = if unsafe { TerminateJobObject(self.job.as_raw_handle(), 1) } == 0 {
            Some(io::Error::last_os_error())
        } else {
            None
        };
        if let Some(error) = &self.capture_error {
            return Err(io::Error::other(match termination_error {
                Some(termination) => {
                    format!("{error}; owned-job termination also failed: {termination}")
                }
                None => error.clone(),
            }));
        }
        match termination_error {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }

    fn accounting(&self) -> io::Result<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION> {
        let mut accounting = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
        if unsafe {
            QueryInformationJobObject(
                self.job.as_raw_handle(),
                JobObjectBasicAccountingInformation,
                (&mut accounting as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast(),
                size_of_val(&accounting) as u32,
                null_mut(),
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(accounting)
    }

    fn capture_members(&self) -> io::Result<MemberSnapshot> {
        for attempt in 0..MAX_SNAPSHOT_ATTEMPTS {
            let before = self.accounting()?.TotalProcesses;
            let bytes = std::mem::offset_of!(JOBOBJECT_BASIC_PROCESS_ID_LIST, ProcessIdList)
                + MAX_CAPTURED_MEMBERS * size_of::<usize>();
            let mut buffer = vec![0u128; bytes.div_ceil(size_of::<u128>())];
            let information = buffer
                .as_mut_ptr()
                .cast::<JOBOBJECT_BASIC_PROCESS_ID_LIST>();
            if unsafe {
                QueryInformationJobObject(
                    self.job.as_raw_handle(),
                    JobObjectBasicProcessIdList,
                    information.cast(),
                    bytes as u32,
                    null_mut(),
                )
            } == 0
            {
                return Err(io::Error::last_os_error());
            }
            let assigned = unsafe { (*information).NumberOfAssignedProcesses as usize };
            let returned = unsafe { (*information).NumberOfProcessIdsInList as usize };
            if let Err(error) = complete_snapshot(assigned, returned) {
                // An incomplete snapshot is NEVER accepted. Re-query within the
                // existing attempt bound when counts fit our full buffer. A
                // terminating process can change the list during observation;
                // all post-snapshot total-count/handle/empty-job checks remain.
                if error.kind() == io::ErrorKind::WouldBlock && attempt + 1 < MAX_SNAPSHOT_ATTEMPTS
                {
                    std::thread::sleep(std::time::Duration::from_millis(2));
                    continue;
                }
                return Err(error);
            }
            let ids = unsafe {
                std::slice::from_raw_parts(
                    std::ptr::addr_of!((*information).ProcessIdList).cast::<usize>(),
                    returned,
                )
            };
            let mut handles = Vec::with_capacity(returned);
            for &id in ids {
                let pid = u32::try_from(id)
                    .ok()
                    .filter(|pid| *pid != 0)
                    .ok_or_else(|| io::Error::other("Invalid PID in owned preview job"))?;
                let handle = if pid == self.pid {
                    self.process.try_clone()?
                } else {
                    let raw = unsafe {
                        OpenProcess(
                            PROCESS_SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION,
                            0,
                            pid,
                        )
                    };
                    if raw.is_null() {
                        let error = io::Error::last_os_error();
                        // It exited before OpenProcess. All other failures are
                        // uncertain, not permission to claim successful cleanup.
                        if error.raw_os_error() == Some(ERROR_INVALID_PARAMETER as i32) {
                            continue;
                        }
                        return Err(error);
                    }
                    unsafe { OwnedHandle::from_raw_handle(raw) }
                };
                let mut belongs = 0;
                if unsafe {
                    IsProcessInJob(
                        handle.as_raw_handle(),
                        self.job.as_raw_handle(),
                        &mut belongs,
                    )
                } == 0
                {
                    return Err(io::Error::last_os_error());
                }
                if belongs == 0 {
                    return Err(io::Error::other(
                        "Captured preview PID no longer belongs to the owned job",
                    ));
                }
                handles.push(handle);
            }
            let after = self.accounting()?.TotalProcesses;
            if let Err(error) = stable_count(before, after) {
                if attempt + 1 == MAX_SNAPSHOT_ATTEMPTS {
                    return Err(error);
                }
                continue;
            }
            return Ok(MemberSnapshot {
                total_processes: after,
                handles,
            });
        }
        Err(io::Error::other(
            "Preview job snapshot exhausted its bounded attempts",
        ))
    }

    pub fn tree_is_empty(&mut self) -> io::Result<bool> {
        if let Some(error) = &self.capture_error {
            return Err(io::Error::other(error.clone()));
        }
        if self.cleanup_snapshot.is_none() {
            return Ok(false);
        }
        let leader_exited = self.try_wait()?.is_some();
        let accounting = self.accounting()?;
        let snapshot = self.cleanup_snapshot.as_ref().expect("checked snapshot");
        // A new member after snapshot may already have left ActiveProcesses by
        // the time this is called. TotalProcesses still detects it; do not assert
        // that an uncaptured member's kernel handle has finished finalization.
        stable_count(snapshot.total_processes, accounting.TotalProcesses)?;
        if !leader_exited || accounting.ActiveProcesses != 0 {
            return Ok(false);
        }
        for handle in &snapshot.handles {
            match unsafe { WaitForSingleObject(handle.as_raw_handle(), 0) } {
                WAIT_OBJECT_0 => {}
                WAIT_TIMEOUT => return Ok(false),
                WAIT_FAILED => return Err(io::Error::last_os_error()),
                _ => {
                    return Err(io::Error::other(
                        "Unexpected captured preview process wait state",
                    ))
                }
            }
        }
        Ok(true)
    }
}

impl Drop for OwnedProcess {
    fn drop(&mut self) {
        // No wait/join in Drop. Closing our sole, non-inherited job handle is a
        // second kill-on-close safeguard if explicit termination returned error.
        // Do not enumerate or open member handles in Drop; that is an explicit
        // supervisor cleanup operation. This destructor is only a kill safeguard.
        unsafe {
            TerminateJobObject(self.job.as_raw_handle(), 1);
        }
    }
}

struct AttributeList {
    // HeapAlloc-equivalent alignment, without exposing a Rust Vec allocation to
    // Win32 deallocation. This buffer is stable until Delete... has run.
    buffer: Vec<u128>,
}

impl AttributeList {
    fn new() -> io::Result<Self> {
        let mut bytes = 0usize;
        unsafe {
            InitializeProcThreadAttributeList(null_mut(), 2, 0, &mut bytes);
        }
        if bytes == 0 || bytes > 65_536 {
            return Err(io::Error::other("Invalid preview attribute-list size"));
        }
        let mut value = Self {
            buffer: vec![0; bytes.div_ceil(size_of::<u128>())],
        };
        if unsafe { InitializeProcThreadAttributeList(value.as_ptr(), 2, 0, &mut bytes) } == 0 {
            // Delete... is valid only after successful initialization.
            let error = io::Error::last_os_error();
            value.buffer.clear();
            return Err(error);
        }
        Ok(value)
    }

    fn as_ptr(&mut self) -> LPPROC_THREAD_ATTRIBUTE_LIST {
        self.buffer.as_mut_ptr().cast()
    }

    fn update(&mut self, attribute: u32, handles: &[HANDLE]) -> io::Result<()> {
        if unsafe {
            UpdateProcThreadAttribute(
                self.as_ptr(),
                0,
                attribute as usize,
                handles.as_ptr().cast(),
                size_of_val(handles),
                null_mut(),
                null(),
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
}

impl Drop for AttributeList {
    fn drop(&mut self) {
        if !self.buffer.is_empty() {
            unsafe {
                DeleteProcThreadAttributeList(self.as_ptr());
            }
        }
    }
}

fn pipe(parent_reads: bool) -> io::Result<(OwnedHandle, OwnedHandle)> {
    let attributes = SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: null_mut(),
        bInheritHandle: 1,
    };
    let (mut read, mut write) = (null_mut(), null_mut());
    if unsafe { CreatePipe(&mut read, &mut write, &attributes, 0) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let read = unsafe { OwnedHandle::from_raw_handle(read) };
    let write = unsafe { OwnedHandle::from_raw_handle(write) };
    let (parent, child) = if parent_reads {
        (read, write)
    } else {
        (write, read)
    };
    if unsafe { SetHandleInformation(parent.as_raw_handle(), HANDLE_FLAG_INHERIT, 0) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok((parent, child))
}

/// Windows CRT/CommandLineToArgvW-compatible encoding, not cmd/PowerShell text.
/// Always quote; double runs of backslashes only before quotes and the close.
fn quote_arg(units: &[u16], output: &mut Vec<u16>) {
    output.push(34);
    let mut slashes = 0usize;
    for &unit in units {
        if unit == 92 {
            slashes += 1;
            continue;
        }
        output.extend(std::iter::repeat_n(
            92,
            if unit == 34 { 2 * slashes + 1 } else { slashes },
        ));
        output.push(unit);
        slashes = 0;
    }
    output.extend(std::iter::repeat_n(92, 2 * slashes));
    output.push(34);
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
    let mut application: Vec<u16> = executable.as_os_str().encode_wide().collect();
    let mut command_line = Vec::new();
    quote_arg(&application, &mut command_line);
    application.push(0);
    for arg in args {
        command_line.push(32);
        quote_arg(&arg.encode_wide().collect::<Vec<_>>(), &mut command_line);
    }
    command_line.push(0);
    if command_line.len() > 32_767 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Preview command line exceeds Windows limit",
        ));
    }
    let mut environment_block = environment.map(|entries| {
        let mut entries = entries.to_vec();
        entries.sort_by_key(|(key, _)| key.to_string_lossy().to_ascii_uppercase());
        let mut block = Vec::<u16>::new();
        for (key, value) in entries {
            block.extend(key.encode_wide());
            block.push('=' as u16);
            block.extend(value.encode_wide());
            block.push(0);
        }
        block.push(0);
        block
    });
    let environment_pointer = environment_block
        .as_mut()
        .map_or(null_mut(), |block| block.as_mut_ptr().cast());
    let mut cwd_units = cwd.map(|cwd| {
        cwd.as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect::<Vec<_>>()
    });
    let cwd_pointer = cwd_units.as_mut().map_or(null(), |units| units.as_ptr());
    let raw_job = unsafe { CreateJobObjectW(null(), null()) };
    if raw_job.is_null() {
        return Err(io::Error::last_os_error());
    }
    let job = unsafe { OwnedHandle::from_raw_handle(raw_job) };
    let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if unsafe {
        SetInformationJobObject(
            job.as_raw_handle(),
            JobObjectExtendedLimitInformation,
            (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
            size_of_val(&limits) as u32,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    let (stdin, child_stdin) = pipe(false)?;
    let (stdout, child_stdout) = pipe(true)?;
    let (stderr, child_stderr) = pipe(true)?;
    // Values must outlive the attribute list, including its destructor.
    let job_handles = [job.as_raw_handle()];
    let inherited_handles = [
        child_stdin.as_raw_handle(),
        child_stdout.as_raw_handle(),
        child_stderr.as_raw_handle(),
    ];
    let mut attributes = AttributeList::new()?;
    attributes.update(PROC_THREAD_ATTRIBUTE_JOB_LIST, &job_handles)?;
    attributes.update(PROC_THREAD_ATTRIBUTE_HANDLE_LIST, &inherited_handles)?;
    let mut startup = STARTUPINFOEXW::default();
    startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = child_stdin.as_raw_handle();
    startup.StartupInfo.hStdOutput = child_stdout.as_raw_handle();
    startup.StartupInfo.hStdError = child_stderr.as_raw_handle();
    startup.lpAttributeList = attributes.as_ptr();
    let mut information = PROCESS_INFORMATION::default();
    if unsafe {
        CreateProcessW(
            application.as_ptr(),
            command_line.as_mut_ptr(),
            null(),
            null(),
            1,
            CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT,
            environment_pointer,
            cwd_pointer,
            &startup.StartupInfo,
            &mut information,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    let process = OwnedProcess {
        job,
        process: unsafe { OwnedHandle::from_raw_handle(information.hProcess) },
        pid: information.dwProcessId,
        exit: None,
        cleanup_snapshot: None,
        capture_attempted: false,
        capture_error: None,
    };
    // Process starts already assigned to the job. There is no suspended orphan,
    // attach-after-spawn interval, shell, inherited job handle, or breakaway flag.
    drop(unsafe { OwnedHandle::from_raw_handle(information.hThread) });
    drop(attributes);
    drop((child_stdin, child_stdout, child_stderr));
    Ok(Spawned {
        process,
        stdin: Box::new(File::from(stdin)),
        stdout: Box::new(File::from(stdout)),
        stderr: Box::new(File::from(stderr)),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_line_quotes_empty_quotes_slashes_and_metacharacters() {
        for (input, expected) in [
            ("", "\"\""),
            ("a b", "\"a b\""),
            ("a\"b", "\"a\\\"b\""),
            ("a\\", "\"a\\\\\""),
            ("& $ ' 中文", "\"& $ ' 中文\""),
        ] {
            let mut result = Vec::new();
            quote_arg(&input.encode_utf16().collect::<Vec<_>>(), &mut result);
            assert_eq!(String::from_utf16(&result).unwrap(), expected);
        }
    }

    #[test]
    fn cleanup_snapshot_rejects_unseen_new_members_and_truncation() {
        assert!(stable_count(2, 2).is_ok());
        assert!(stable_count(2, 3).is_err());
        assert!(stable_count(3, 2).is_err());
        assert!(complete_snapshot(0, 0).is_ok());
        assert!(complete_snapshot(256, 256).is_ok());
        assert!(complete_snapshot(257, 256).is_err());
        assert!(complete_snapshot(257, 257).is_err());
        assert!(complete_snapshot(3, 2).is_err());
        assert_eq!(
            complete_snapshot(1, 0).unwrap_err().kind(),
            io::ErrorKind::WouldBlock
        );
        assert_eq!(
            complete_snapshot(257, 256).unwrap_err().kind(),
            io::ErrorKind::Other
        );
    }
}
