// SPDX-License-Identifier: Apache-2.0
//! Private, trusted Rust process-tree runner. This is an engine-neutral
//! candidate: profile permission, engine selection and PDF publication belong
//! to their separate coordinators. It exposes no Tauri command or wire DTO.
//!
//!
//! Pure tests are host-independent. Native process-tree tests require Windows
//! x64 and use the compiled Rust test executable as their self-contained helper.

use std::{
    error::Error,
    ffi::OsString,
    fmt,
    panic::{catch_unwind, AssertUnwindSafe},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};

const MAX_LOG_BYTES_PER_STREAM: usize = 32 * 1024 * 1024;

/// Callers create a fresh pair for each request. The token cannot be reset or
/// shared through IPC; cancellation is a monotonic, idempotent signal.
#[derive(Clone, Debug)]
pub(crate) struct CancellationHandle(Arc<AtomicBool>);

#[derive(Clone, Debug)]
pub(crate) struct CancellationToken(Arc<AtomicBool>);

pub(crate) fn cancellation_pair() -> (CancellationHandle, CancellationToken) {
    let state = Arc::new(AtomicBool::new(false));
    (
        CancellationHandle(Arc::clone(&state)),
        CancellationToken(state),
    )
}

impl CancellationHandle {
    pub(crate) fn cancel(&self) {
        self.0.store(true, Ordering::Release);
    }
}

impl CancellationToken {
    pub(crate) fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::Acquire)
    }
}

/// Trusted Rust input only. Do not deserialize this type or expose its fields
/// through a renderer command. `arguments` are passed as individual argv
/// elements; they are never parsed or interpolated by a shell.
pub(crate) struct ProcessSpec {
    executable: PathBuf,
    working_directory: PathBuf,
    arguments: Vec<OsString>,
    environment: Vec<(OsString, OsString)>,
    timeout: Duration,
    max_log_bytes_per_stream: usize,
}

impl ProcessSpec {
    pub(crate) fn new(
        executable: PathBuf,
        working_directory: PathBuf,
        arguments: Vec<OsString>,
        timeout: Duration,
        max_log_bytes_per_stream: usize,
    ) -> Self {
        Self {
            executable,
            working_directory,
            arguments,
            environment: Vec::new(),
            timeout,
            max_log_bytes_per_stream,
        }
    }

    pub(crate) fn with_environment(mut self, environment: Vec<(OsString, OsString)>) -> Self {
        self.environment = environment;
        self
    }

    pub(crate) fn new_with_environment(
        executable: PathBuf,
        working_directory: PathBuf,
        arguments: Vec<OsString>,
        environment: Vec<(OsString, OsString)>,
        timeout: Duration,
        max_log_bytes_per_stream: usize,
    ) -> Self {
        Self {
            executable,
            working_directory,
            arguments,
            environment,
            timeout,
            max_log_bytes_per_stream,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ProcessErrorKind {
    #[cfg(not(all(windows, target_arch = "x86_64")))]
    UnsupportedPlatform,
    InvalidExecutable,
    InvalidWorkingDirectory,
    InvalidTimeout,
    InvalidLogLimit,
    InvalidArgument,
    CommandLineTooLong,
    Cancelled,
    DeadlineExceeded,
    OutputLimitExceeded,
    Spawn,
    AssignToJob,
    Resume,
    ReadFailure,
    WaitFailure,
    JobQueryFailure,
    NonZeroExit,
    CleanupFailed,
    CleanupCapacityExceeded,
    CleanupSupervisorUnavailable,
    Internal,
}

impl fmt::Display for ProcessErrorKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let label = match self {
            #[cfg(not(all(windows, target_arch = "x86_64")))]
            Self::UnsupportedPlatform => "unsupported platform",
            Self::InvalidExecutable => "invalid executable",
            Self::InvalidWorkingDirectory => "invalid working directory",
            Self::InvalidTimeout => "invalid timeout",
            Self::InvalidLogLimit => "invalid log limit",
            Self::InvalidArgument => "invalid argument",
            Self::CommandLineTooLong => "command line too long",
            Self::Cancelled => "cancelled",
            Self::DeadlineExceeded => "deadline exceeded",
            Self::OutputLimitExceeded => "output limit exceeded",
            Self::Spawn => "spawn failed",
            Self::AssignToJob => "job assignment failed",
            Self::Resume => "resume failed",
            Self::ReadFailure => "output read failed",
            Self::WaitFailure => "process wait failed",
            Self::JobQueryFailure => "job query failed",
            Self::NonZeroExit => "nonzero exit",
            Self::CleanupFailed => "cleanup failed",
            Self::CleanupCapacityExceeded => "cleanup capacity exceeded",
            Self::CleanupSupervisorUnavailable => "cleanup supervisor unavailable",
            Self::Internal => "internal process-tree error",
        };
        f.write_str(label)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum CleanupProof {
    /// No child process was created.
    NotRequired,
    /// The direct child was reaped, the job reported zero active processes,
    /// all output readers joined, and native guard handles closed cleanly.
    JobDrained,
    /// Cleanup was attempted but full process-tree and reader drain could not
    /// be verified. If resources remain live, `ProcessError::pending_cleanup`
    /// retains ownership of the process, job, and reader threads.
    Failed,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct ProcessLogs {
    pub(crate) stdout: Vec<u8>,
    pub(crate) stderr: Vec<u8>,
    pub(crate) stdout_truncated: bool,
    pub(crate) stderr_truncated: bool,
}

#[derive(Debug)]
pub(crate) struct ProcessOutput {
    pub(crate) pid: u32,
    pub(crate) exit_code: u32,
    pub(crate) logs: ProcessLogs,
    /// Success is only returned after this has been verified as zero.
    pub(crate) active_processes_after_exit: u32,
}

/// Maximum framed input accepted by a trusted interactive process session.
pub(crate) const PROCESS_SESSION_MAX_INPUT_BYTES: usize = 48 * 1024 * 1024;

#[derive(Debug, Default)]
pub(crate) struct SessionReply {
    pub(crate) stdout: Vec<u8>,
    pub(crate) stderr: Vec<u8>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum SessionErrorKind {
    InvalidRequest,
    SessionClosed,
    Cancelled,
    DeadlineExceeded,
    OutputLimitExceeded,
    WriteFailure,
    ReadFailure,
    CleanupUnproven,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct SessionError {
    pub(crate) kind: SessionErrorKind,
    pub(crate) detail: String,
}

impl SessionError {
    fn new(kind: SessionErrorKind, detail: impl Into<String>) -> Self {
        Self {
            kind,
            detail: detail.into(),
        }
    }
}

impl fmt::Display for SessionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.detail)
    }
}

/// A process-tree owner for a trusted interactive child. The child is created
/// by the same suspended, job-assigned native path as [`run`]. Its process,
/// job, stdio handles, reader joins and reserved cleanup slot remain owned
/// until a complete drain is proven.
pub(crate) struct ProcessSession {
    #[cfg(all(windows, target_arch = "x86_64"))]
    inner: Option<Box<windows_impl::OwnedCleanupState>>,
    ready: bool,
}

/// A failed session start may still own a spawned child. Such a child is
/// returned as a non-ready session rather than losing its cleanup capability.
pub(crate) struct ProcessSessionStartError {
    pub(crate) error: ProcessError,
    pub(crate) pending: Option<Box<ProcessSession>>,
}

#[cfg(all(test, windows, target_arch = "x86_64"))]
#[path = "../../tests/unit/process_session.rs"]
mod session_acceptance_tests;

impl ProcessSession {
    pub(crate) fn start(
        spec: &ProcessSpec,
        cancellation: &CancellationToken,
    ) -> Result<Self, ProcessSessionStartError> {
        #[cfg(all(windows, target_arch = "x86_64"))]
        {
            match windows_impl::start_interactive(spec, cancellation) {
                Ok(state) => Ok(Self {
                    inner: Some(Box::new(state)),
                    ready: true,
                }),
                Err(mut error) => {
                    let pending = error.pending_cleanup.take().and_then(|mut ticket| {
                        ticket.inner.take().map(|state| {
                            Box::new(Self {
                                inner: Some(state),
                                ready: false,
                            })
                        })
                    });
                    Err(ProcessSessionStartError { error, pending })
                }
            }
        }
        #[cfg(not(all(windows, target_arch = "x86_64")))]
        {
            let _ = (spec, cancellation);
            Err(ProcessSessionStartError {
                error: ProcessError::simple(
                    ProcessErrorKind::UnsupportedPlatform,
                    "interactive process sessions are implemented only for Windows x64",
                ),
                pending: None,
            })
        }
    }

    pub(crate) fn pid(&self) -> u32 {
        #[cfg(all(windows, target_arch = "x86_64"))]
        {
            self.inner.as_ref().map_or(0, |state| state.pid())
        }
        #[cfg(not(all(windows, target_arch = "x86_64")))]
        {
            0
        }
    }

    pub(crate) fn is_drained(&self) -> bool {
        #[cfg(all(windows, target_arch = "x86_64"))]
        {
            self.inner.is_none()
        }
        #[cfg(not(all(windows, target_arch = "x86_64")))]
        {
            true
        }
    }

    /// Exchanges one bounded request for a response ending in `terminal_marker`.
    /// Output is pumped while a separate owned writer handles pipe backpressure;
    /// cancellation and the deadline are checked throughout the exchange.
    pub(crate) fn exchange(
        &mut self,
        input: &[u8],
        terminal_marker: &[u8],
        cancellation: &CancellationToken,
        timeout: Duration,
    ) -> Result<SessionReply, SessionError> {
        if input.len() > PROCESS_SESSION_MAX_INPUT_BYTES
            || terminal_marker.is_empty()
            || timeout.is_zero()
        {
            return Err(SessionError::new(
                SessionErrorKind::InvalidRequest,
                "interactive request, response marker, or timeout is invalid",
            ));
        }

        #[cfg(all(windows, target_arch = "x86_64"))]
        {
            if !self.ready {
                return Err(SessionError::new(
                    SessionErrorKind::SessionClosed,
                    "interactive process session did not become ready",
                ));
            }
            let Some(state) = self.inner.as_mut() else {
                return Err(SessionError::new(
                    SessionErrorKind::SessionClosed,
                    "interactive process session is drained",
                ));
            };
            let result = windows_impl::exchange_interactive(
                state,
                input,
                terminal_marker,
                cancellation,
                timeout,
            );
            if let Err(original) = result {
                let cleanup = catch_unwind(AssertUnwindSafe(|| {
                    state.try_resolve(None, Duration::from_secs(10))
                }));
                return match cleanup {
                    Ok(Ok(_)) => {
                        self.inner = None;
                        Err(original)
                    }
                    Ok(Err(detail)) => Err(SessionError::new(
                        SessionErrorKind::CleanupUnproven,
                        format!(
                            "{}; process-tree drain remains owned: {detail}",
                            original.detail
                        ),
                    )),
                    Err(_) => Err(SessionError::new(
                        SessionErrorKind::CleanupUnproven,
                        format!(
                            "{}; process-tree cleanup panicked and remains owned",
                            original.detail
                        ),
                    )),
                };
            }
            result
        }
        #[cfg(not(all(windows, target_arch = "x86_64")))]
        {
            let _ = (input, terminal_marker, cancellation, timeout);
            Err(SessionError::new(
                SessionErrorKind::SessionClosed,
                "interactive process sessions are implemented only for Windows x64",
            ))
        }
    }

    /// Closes interactive stdin and verifies process/job drain, output-reader
    /// joins and handle closure. An error retains the complete cleanup owner.
    pub(crate) fn stop(&mut self, timeout: Duration) -> Result<(), String> {
        #[cfg(all(windows, target_arch = "x86_64"))]
        {
            let Some(state) = self.inner.as_mut() else {
                return Ok(());
            };
            let close_error = state.close_session_stdin().err();
            match catch_unwind(AssertUnwindSafe(|| state.try_resolve(None, timeout))) {
                Ok(Ok(_)) => {
                    self.inner = None;
                    self.ready = false;
                    Ok(())
                }
                Ok(Err(error)) => Err(close_error
                    .map(|close| format!("{close}; {error}"))
                    .unwrap_or(error)),
                Err(_) => Err(close_error
                    .map(|close| format!("{close}; process-tree cleanup panicked"))
                    .unwrap_or_else(|| "process-tree cleanup panicked".to_owned())),
            }
        }
        #[cfg(not(all(windows, target_arch = "x86_64")))]
        {
            let _ = timeout;
            Ok(())
        }
    }

    /// Runs `callback` only after the process tree, pipes and all reader workers
    /// have been proven drained. If this owner is transferred to supervision,
    /// the callback follows it.
    pub(crate) fn on_drained<F>(&mut self, callback: F)
    where
        F: FnOnce() + Send + 'static,
    {
        #[cfg(all(windows, target_arch = "x86_64"))]
        {
            if let Some(state) = self.inner.as_mut() {
                state.set_on_drained(Box::new(callback));
            } else {
                let _ = catch_unwind(AssertUnwindSafe(callback));
            }
        }
        #[cfg(not(all(windows, target_arch = "x86_64")))]
        {
            let _ = callback;
        }
    }
}

/// Owned cleanup capability returned when a spawned process tree or its pipe
/// readers could not be proven drained within the initial cleanup window.
///
/// The caller coordinator can hold its input lease while this ticket is alive,
/// retry/cancel/drain explicitly, or drop the ticket to transfer the live
/// handles and reader `JoinHandle`s into bounded host supervision without
/// detaching threads or leaking handles.
/// Coordinator API needed: carry the input lease with a completion receipt or
/// future, and release it only after `JobDrained`, including after this ticket
/// transfers to host supervision on drop.
pub(crate) struct PendingCleanup {
    #[cfg(all(windows, target_arch = "x86_64"))]
    inner: Option<Box<windows_impl::OwnedCleanupState>>,
    #[cfg(not(all(windows, target_arch = "x86_64")))]
    pid: u32,
}

impl fmt::Debug for PendingCleanup {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PendingCleanup")
            .field("pid", &self.pid())
            .field("is_drained", &self.is_drained())
            .finish()
    }
}

impl PendingCleanup {
    pub(crate) fn pid(&self) -> u32 {
        #[cfg(all(windows, target_arch = "x86_64"))]
        {
            self.inner.as_ref().map_or(0, |state| state.pid())
        }
        #[cfg(not(all(windows, target_arch = "x86_64")))]
        {
            self.pid
        }
    }

    pub(crate) fn is_drained(&self) -> bool {
        #[cfg(all(windows, target_arch = "x86_64"))]
        {
            self.inner.is_none()
        }
        #[cfg(not(all(windows, target_arch = "x86_64")))]
        {
            true
        }
    }

    /// Retries termination, process/job drain, reader thread join, and guard
    /// handle closure within `timeout`, respecting `cancellation`.
    ///
    /// On `Ok`, the process tree and readers are fully drained and all native
    /// handles are closed cleanly. On `Err`, ownership of any still-live
    /// process, job, or reader threads remains inside `self`.
    pub(crate) fn drain(
        &mut self,
        cancellation: &CancellationToken,
        timeout: Duration,
    ) -> Result<ProcessLogs, String> {
        #[cfg(all(windows, target_arch = "x86_64"))]
        {
            let Some(state) = self.inner.as_mut() else {
                return Ok(ProcessLogs::default());
            };
            let logs = state.try_resolve(Some(cancellation), timeout)?;
            self.inner = None;
            Ok(logs)
        }
        #[cfg(not(all(windows, target_arch = "x86_64")))]
        {
            let _ = (cancellation, timeout);
            Ok(ProcessLogs::default())
        }
    }

    /// Retries unconditional termination and drain for up to `timeout`.
    pub(crate) fn retry(&mut self, timeout: Duration) -> Result<ProcessLogs, String> {
        #[cfg(all(windows, target_arch = "x86_64"))]
        {
            let Some(state) = self.inner.as_mut() else {
                return Ok(ProcessLogs::default());
            };
            let logs = state.try_resolve(None, timeout)?;
            self.inner = None;
            Ok(logs)
        }
        #[cfg(not(all(windows, target_arch = "x86_64")))]
        {
            let _ = timeout;
            Ok(ProcessLogs::default())
        }
    }
    /// Runs `callback` only after deferred cleanup has been proven complete.
    pub(crate) fn on_drained(&mut self, callback: impl FnOnce() + Send + 'static) {
        #[cfg(all(windows, target_arch = "x86_64"))]
        if let Some(state) = self.inner.as_mut() {
            state.set_completion(Box::new(callback));
            return;
        }
        callback();
    }
}

#[cfg(all(windows, target_arch = "x86_64"))]
impl Drop for PendingCleanup {
    fn drop(&mut self) {
        if let Some(state) = self.inner.take() {
            windows_impl::supervise_dropped_cleanup(*state);
        }
    }
}

#[derive(Debug)]
pub(crate) struct ProcessError {
    pub(crate) kind: ProcessErrorKind,
    pub(crate) cause: Option<ProcessErrorKind>,
    pub(crate) detail: String,
    pub(crate) exit_code: Option<u32>,
    pub(crate) logs: ProcessLogs,
    pub(crate) cleanup: CleanupProof,
    pub(crate) pending_cleanup: Option<PendingCleanup>,
}

impl ProcessError {
    fn simple(kind: ProcessErrorKind, detail: impl Into<String>) -> Self {
        Self {
            kind,
            cause: None,
            detail: detail.into(),
            exit_code: None,
            logs: ProcessLogs::default(),
            cleanup: CleanupProof::NotRequired,
            pending_cleanup: None,
        }
    }

    pub(crate) fn has_pending_cleanup(&self) -> bool {
        self.pending_cleanup
            .as_ref()
            .is_some_and(|ticket| !ticket.is_drained())
    }

    pub(crate) fn take_pending_cleanup(&mut self) -> Option<PendingCleanup> {
        self.pending_cleanup.take()
    }

    /// Retries cleanup on an owned `PendingCleanup` ticket attached to this
    /// error. Only upgrades `self.cleanup` to `CleanupProof::JobDrained` if the
    /// ticket resolves cleanly with all native handles closed.
    pub(crate) fn retry_cleanup(&mut self, timeout: Duration) -> Result<CleanupProof, String> {
        let (_, cancellation) = cancellation_pair();
        self.drain_cleanup(&cancellation, timeout)
    }

    /// Cancellable drain on an owned `PendingCleanup` ticket attached to this
    /// error. Retains the ticket on timeout/cancellation so the caller can keep
    /// its input lease until cleanup is verified.
    pub(crate) fn drain_cleanup(
        &mut self,
        cancellation: &CancellationToken,
        timeout: Duration,
    ) -> Result<CleanupProof, String> {
        let Some(mut ticket) = self.pending_cleanup.take() else {
            return Ok(self.cleanup);
        };
        match catch_unwind(AssertUnwindSafe(|| ticket.drain(cancellation, timeout))) {
            Ok(Ok(logs)) => {
                self.logs = logs;
                self.cleanup = CleanupProof::JobDrained;
                Ok(CleanupProof::JobDrained)
            }
            Ok(Err(error)) => {
                if ticket.is_drained() {
                    self.cleanup = CleanupProof::JobDrained;
                    return Ok(CleanupProof::JobDrained);
                }
                self.pending_cleanup = Some(ticket);
                self.cleanup = CleanupProof::Failed;
                Err(error)
            }
            Err(_) if ticket.is_drained() => {
                self.cleanup = CleanupProof::JobDrained;
                Ok(CleanupProof::JobDrained)
            }
            Err(_) => {
                self.pending_cleanup = Some(ticket);
                self.cleanup = CleanupProof::Failed;
                Err("process cleanup drain panicked; cleanup ownership retained".to_owned())
            }
        }
    }
}

impl fmt::Display for ProcessError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.cause {
            Some(cause) => write!(f, "{} (after {cause}): {}", self.kind, self.detail),
            None => write!(f, "{}: {}", self.kind, self.detail),
        }
    }
}

impl Error for ProcessError {}

fn validate_limits(spec: &ProcessSpec) -> Result<(), ProcessError> {
    if spec.timeout.is_zero() {
        return Err(ProcessError::simple(
            ProcessErrorKind::InvalidTimeout,
            "timeout must be nonzero",
        ));
    }
    if spec.max_log_bytes_per_stream == 0
        || spec.max_log_bytes_per_stream > MAX_LOG_BYTES_PER_STREAM
    {
        return Err(ProcessError::simple(
            ProcessErrorKind::InvalidLogLimit,
            format!("per-stream log limit must be in 1..={MAX_LOG_BYTES_PER_STREAM}"),
        ));
    }
    Ok(())
}

/// Launches an explicitly verified absolute executable in an explicitly
/// verified absolute working directory. Windows x64 uses a suspended child,
/// assigns it to a kill-on-close job, then resumes it. Other platforms fail
/// closed rather than reporting fake success.
pub(crate) fn run(
    spec: &ProcessSpec,
    cancellation: &CancellationToken,
) -> Result<ProcessOutput, ProcessError> {
    #[cfg(all(windows, target_arch = "x86_64"))]
    {
        windows_impl::run(spec, cancellation)
    }
    #[cfg(not(all(windows, target_arch = "x86_64")))]
    {
        let _ = (spec, cancellation);
        Err(ProcessError::simple(
            ProcessErrorKind::UnsupportedPlatform,
            "the process-tree service is implemented only for Windows x64",
        ))
    }
}

#[cfg(all(windows, target_arch = "x86_64"))]
mod windows_impl {
    use super::*;
    use std::{
        cell::UnsafeCell,
        ffi::{c_void, OsStr},
        fs,
        mem::{self, MaybeUninit},
        os::windows::ffi::OsStrExt,
        path::Path,
        ptr,
        sync::{
            atomic::AtomicU8,
            mpsc::{self, Receiver, RecvTimeoutError, SyncSender, TryRecvError},
            Condvar, Mutex, MutexGuard, OnceLock,
        },
        thread::{self, JoinHandle},
        time::Instant,
    };

    use windows_sys::Win32::Foundation::{
        CloseHandle, HANDLE, INVALID_HANDLE_VALUE, WAIT_OBJECT_0, WAIT_TIMEOUT,
    };
    use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
    use windows_sys::Win32::Storage::FileSystem::{ReadFile, WriteFile};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectBasicAccountingInformation,
        JobObjectExtendedLimitInformation, QueryInformationJobObject, SetInformationJobObject,
        TerminateJobObject, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Pipes::CreatePipe;
    #[cfg(test)]
    use windows_sys::Win32::System::Threading::STARTF_USESHOWWINDOW;
    use windows_sys::Win32::System::Threading::{
        CreateProcessW, DeleteProcThreadAttributeList, GetExitCodeProcess,
        InitializeProcThreadAttributeList, ResumeThread, TerminateProcess,
        UpdateProcThreadAttribute, WaitForSingleObject, CREATE_NO_WINDOW, CREATE_SUSPENDED,
        CREATE_UNICODE_ENVIRONMENT, EXTENDED_STARTUPINFO_PRESENT, PROCESS_INFORMATION,
        STARTF_USESTDHANDLES, STARTUPINFOW,
    };

    const POLL_INTERVAL: Duration = Duration::from_millis(25);
    const CLEANUP_TIMEOUT: Duration = Duration::from_secs(10);
    const SUPERVISOR_SLICE: Duration = Duration::from_millis(50);
    const SUPERVISOR_START_TIMEOUT: Duration = Duration::from_secs(1);
    const MAX_SUPERVISED_CLEANUPS: usize = 16;
    const MAX_COMMAND_LINE_UTF16: usize = 32_767;
    const ERROR_BROKEN_PIPE: i32 = 109;
    const PROC_THREAD_ATTRIBUTE_HANDLE_LIST: usize = 0x0002_0002;
    const SLOT_FREE: u8 = 0;
    const SLOT_RESERVED: u8 = 1;
    const SLOT_READY: u8 = 2;
    const SLOT_PROCESSING: u8 = 3;
    const DUPLICATE_SAME_ACCESS: u32 = 0x0000_0002;
    const MAX_PATH: usize = 260;
    const SESSION_CHANNEL_CAPACITY: usize = 16;
    const SESSION_WRITE_CHUNK_BYTES: usize = 64 * 1024;

    #[link(name = "kernel32")]
    extern "system" {
        fn GetCurrentProcess() -> HANDLE;
        fn DuplicateHandle(
            source_process: HANDLE,
            source_handle: HANDLE,
            target_process: HANDLE,
            target_handle: *mut HANDLE,
            desired_access: u32,
            inherit_handle: i32,
            options: u32,
        ) -> i32;
        fn GetShortPathNameW(
            lpszLongPath: *const u16,
            lpszShortPath: *mut u16,
            cchBuffer: u32,
        ) -> u32;
    }

    #[cfg(test)]
    #[derive(Clone, Copy, Debug, Eq, PartialEq)]
    pub(crate) enum TestFault {
        CleanupCapacity,
        SupervisorStart,
        PostSpawnPanic,
    }

    /// Differential startup modes for native tests. Test-only variants change
    /// only the window flags; stdio, the handle allowlist, suspended creation,
    /// job assignment, resume, and cleanup remain on the production path.
    #[cfg(test)]
    #[derive(Clone, Copy, Debug, Eq, PartialEq)]
    pub(crate) enum StartupVariant {
        Production,
        WithoutCreateNoWindow,
        OldWindowHint,
    }

    #[derive(Debug)]
    struct FailureCause {
        kind: ProcessErrorKind,
        detail: String,
        exit_code: Option<u32>,
    }

    impl FailureCause {
        fn new(kind: ProcessErrorKind, detail: impl Into<String>) -> Self {
            Self {
                kind,
                detail: detail.into(),
                exit_code: None,
            }
        }

        fn with_exit_code(
            kind: ProcessErrorKind,
            detail: impl Into<String>,
            exit_code: Option<u32>,
        ) -> Self {
            Self {
                kind,
                detail: detail.into(),
                exit_code,
            }
        }
    }

    fn last_error(operation: &str) -> String {
        let error = std::io::Error::last_os_error();
        format!("{operation}: {error}")
    }

    fn simple_failure(cause: FailureCause) -> ProcessError {
        ProcessError::simple(cause.kind, cause.detail)
    }

    fn process_error(
        cause: FailureCause,
        logs: ProcessLogs,
        exit_code: Option<u32>,
        cleanup_error: Option<String>,
        cleanup: CleanupProof,
        pending_cleanup: Option<PendingCleanup>,
    ) -> ProcessError {
        let cause_kind = cause.kind;
        let final_kind = if cleanup_error.is_some() || cleanup == CleanupProof::Failed {
            ProcessErrorKind::CleanupFailed
        } else {
            cause.kind
        };
        let detail = match cleanup_error {
            Some(cleanup_detail) => {
                format!(
                    "{}; process-tree cleanup not verified: {cleanup_detail}",
                    cause.detail
                )
            }
            None => cause.detail,
        };
        ProcessError {
            kind: final_kind,
            cause: if final_kind != cause_kind {
                Some(cause_kind)
            } else {
                None
            },
            detail,
            exit_code: exit_code.or(cause.exit_code),
            logs,
            cleanup,
            pending_cleanup,
        }
    }

    fn append_error(target: &mut Option<String>, message: String) {
        match target {
            Some(existing) => {
                existing.push_str("; ");
                existing.push_str(&message);
            }
            None => *target = Some(message),
        }
    }

    /// A uniquely owned Win32 handle. It is Send because ownership is moved to
    /// one owner at a time; no handle value is concurrently accessed.
    struct Handle(HANDLE);

    unsafe impl Send for Handle {}

    impl Handle {
        fn null() -> Self {
            Self(ptr::null_mut())
        }

        fn raw(&self) -> HANDLE {
            self.0
        }

        fn is_open(&self) -> bool {
            !self.0.is_null() && self.0 != INVALID_HANDLE_VALUE
        }

        fn close(&mut self) -> Result<(), String> {
            if !self.is_open() {
                return Ok(());
            }
            if unsafe { CloseHandle(self.0) } == 0 {
                return Err(last_error("CloseHandle"));
            }
            self.0 = ptr::null_mut();
            Ok(())
        }
    }

    impl Drop for Handle {
        fn drop(&mut self) {
            if self.is_open() {
                unsafe {
                    CloseHandle(self.0);
                }
                self.0 = ptr::null_mut();
            }
        }
    }

    fn wide_z(value: &OsStr, label: &str) -> Result<Vec<u16>, FailureCause> {
        let mut output = Vec::new();
        for unit in value.encode_wide() {
            if unit == 0 {
                return Err(FailureCause::new(
                    ProcessErrorKind::InvalidArgument,
                    format!("{label} contains an embedded NUL"),
                ));
            }
            if output.len() >= MAX_COMMAND_LINE_UTF16 - 1 {
                return Err(FailureCause::new(
                    ProcessErrorKind::CommandLineTooLong,
                    format!("{label} exceeds the Win32 UTF-16 length limit"),
                ));
            }
            output.try_reserve(1).map_err(|error| {
                FailureCause::new(
                    ProcessErrorKind::Spawn,
                    format!("allocate {label} UTF-16 storage: {error}"),
                )
            })?;
            output.push(unit);
        }
        output.try_reserve(1).map_err(|error| {
            FailureCause::new(
                ProcessErrorKind::Spawn,
                format!("allocate {label} terminator: {error}"),
            )
        })?;
        output.push(0);
        Ok(output)
    }

    fn command_unit(output: &mut Vec<u16>, unit: u16) -> Result<(), FailureCause> {
        if output.len() >= MAX_COMMAND_LINE_UTF16 - 1 {
            return Err(FailureCause::new(
                ProcessErrorKind::CommandLineTooLong,
                "command line exceeds 32767 UTF-16 units including its terminator",
            ));
        }
        output.try_reserve(1).map_err(|error| {
            FailureCause::new(
                ProcessErrorKind::Spawn,
                format!("allocate command-line storage: {error}"),
            )
        })?;
        output.push(unit);
        Ok(())
    }

    fn argument_units(value: &OsStr) -> Result<Vec<u16>, FailureCause> {
        let mut output = Vec::new();
        for unit in value.encode_wide() {
            if unit == 0 {
                return Err(FailureCause::new(
                    ProcessErrorKind::InvalidArgument,
                    "an argv element contains an embedded NUL",
                ));
            }
            if output.len() >= MAX_COMMAND_LINE_UTF16 - 1 {
                return Err(FailureCause::new(
                    ProcessErrorKind::CommandLineTooLong,
                    "an argv element exceeds the Win32 UTF-16 length limit",
                ));
            }
            output.try_reserve(1).map_err(|error| {
                FailureCause::new(
                    ProcessErrorKind::Spawn,
                    format!("allocate argv UTF-16 storage: {error}"),
                )
            })?;
            output.push(unit);
        }
        Ok(output)
    }

    fn append_backslashes(output: &mut Vec<u16>, count: usize) -> Result<(), FailureCause> {
        for _ in 0..count {
            command_unit(output, b'\\' as u16)?;
        }
        Ok(())
    }

    /// MSVCRT-compatible argument quoting. `lpApplicationName` is separately
    /// supplied as the verified absolute path, so this string is never used for
    /// executable lookup or shell parsing.
    fn append_quoted_argument(value: &OsStr, output: &mut Vec<u16>) -> Result<(), FailureCause> {
        let units = argument_units(value)?;
        let needs_quotes = units.is_empty()
            || units
                .iter()
                .any(|unit| matches!(*unit, 0x20 | 0x09 | 0x0a | 0x0d | 0x0b | 0x22));
        if !needs_quotes {
            for unit in units {
                command_unit(output, unit)?;
            }
            return Ok(());
        }

        command_unit(output, b'"' as u16)?;
        let mut backslashes = 0usize;
        for unit in units {
            if unit == b'\\' as u16 {
                backslashes += 1;
            } else if unit == b'"' as u16 {
                let escaped = backslashes
                    .checked_mul(2)
                    .and_then(|count| count.checked_add(1))
                    .ok_or_else(|| {
                        FailureCause::new(
                            ProcessErrorKind::CommandLineTooLong,
                            "argument quoting length overflow",
                        )
                    })?;
                append_backslashes(output, escaped)?;
                command_unit(output, b'"' as u16)?;
                backslashes = 0;
            } else {
                append_backslashes(output, backslashes)?;
                backslashes = 0;
                command_unit(output, unit)?;
            }
        }
        let trailing = backslashes.checked_mul(2).ok_or_else(|| {
            FailureCause::new(
                ProcessErrorKind::CommandLineTooLong,
                "argument quoting length overflow",
            )
        })?;
        append_backslashes(output, trailing)?;
        command_unit(output, b'"' as u16)
    }

    fn command_line(executable: &Path, arguments: &[OsString]) -> Result<Vec<u16>, FailureCause> {
        let mut output = Vec::new();
        append_quoted_argument(executable.as_os_str(), &mut output)?;
        for argument in arguments {
            command_unit(&mut output, b' ' as u16)?;
            append_quoted_argument(argument, &mut output)?;
        }
        output.try_reserve(1).map_err(|error| {
            FailureCause::new(
                ProcessErrorKind::Spawn,
                format!("allocate command-line terminator: {error}"),
            )
        })?;
        output.push(0);
        Ok(output)
    }

    fn compare_env_key_ordinal_ignore_case(a: &[u16], b: &[u16]) -> std::cmp::Ordering {
        extern "system" {
            fn CompareStringOrdinal(
                lpString1: *const u16,
                cchCount1: i32,
                lpString2: *const u16,
                cchCount2: i32,
                bIgnoreCase: i32,
            ) -> i32;
        }
        let len_a = a.len().min(i32::MAX as usize) as i32;
        let len_b = b.len().min(i32::MAX as usize) as i32;
        let res = unsafe { CompareStringOrdinal(a.as_ptr(), len_a, b.as_ptr(), len_b, 1) };
        match res {
            1 => std::cmp::Ordering::Less,
            2 => std::cmp::Ordering::Equal,
            3 => std::cmp::Ordering::Greater,
            _ => {
                let iter_a = a.iter().map(|&u| {
                    if (b'a' as u16..=b'z' as u16).contains(&u) {
                        u - 32
                    } else {
                        u
                    }
                });
                let iter_b = b.iter().map(|&u| {
                    if (b'a' as u16..=b'z' as u16).contains(&u) {
                        u - 32
                    } else {
                        u
                    }
                });
                iter_a.cmp(iter_b)
            }
        }
    }

    struct EnvVarEntry {
        key_wide: Vec<u16>,
        val_wide: Vec<u16>,
    }

    fn environment_block(explicit: &[(OsString, OsString)]) -> Result<Vec<u16>, FailureCause> {
        let mut env_vars: Vec<EnvVarEntry> = Vec::new();
        for (k, v) in std::env::vars_os() {
            let k_wide: Vec<u16> = k.encode_wide().collect();
            let v_wide: Vec<u16> = v.encode_wide().collect();
            if k_wide.is_empty() || k_wide.contains(&0) || v_wide.contains(&0) {
                continue;
            }
            if k_wide[0] == b'=' as u16 {
                if k_wide.len() < 2 || k_wide[1..].contains(&(b'=' as u16)) {
                    continue;
                }
            } else if k_wide.contains(&(b'=' as u16)) {
                continue;
            }
            env_vars.push(EnvVarEntry {
                key_wide: k_wide,
                val_wide: v_wide,
            });
        }

        for (key, val) in explicit {
            let k_wide: Vec<u16> = key.encode_wide().collect();
            if k_wide.is_empty() {
                return Err(FailureCause::new(
                    ProcessErrorKind::InvalidArgument,
                    "environment variable name cannot be empty",
                ));
            }
            if k_wide.contains(&0) {
                return Err(FailureCause::new(
                    ProcessErrorKind::InvalidArgument,
                    "environment variable key contains embedded NUL",
                ));
            }
            if k_wide[0] == b'=' as u16 {
                if k_wide.len() < 2 || k_wide[1..].contains(&(b'=' as u16)) {
                    return Err(FailureCause::new(
                        ProcessErrorKind::InvalidArgument,
                        "invalid per-drive environment variable key",
                    ));
                }
            } else if k_wide.contains(&(b'=' as u16)) {
                return Err(FailureCause::new(
                    ProcessErrorKind::InvalidArgument,
                    "environment variable key contains embedded '='",
                ));
            }

            let v_wide: Vec<u16> = val.encode_wide().collect();
            if v_wide.contains(&0) {
                return Err(FailureCause::new(
                    ProcessErrorKind::InvalidArgument,
                    "environment variable value contains embedded NUL",
                ));
            }

            if let Some(pos) = env_vars.iter().position(|entry| {
                compare_env_key_ordinal_ignore_case(&entry.key_wide, &k_wide)
                    == std::cmp::Ordering::Equal
            }) {
                env_vars[pos] = EnvVarEntry {
                    key_wide: k_wide,
                    val_wide: v_wide,
                };
            } else {
                env_vars.push(EnvVarEntry {
                    key_wide: k_wide,
                    val_wide: v_wide,
                });
            }
        }

        env_vars.sort_by(|a, b| {
            let ord = compare_env_key_ordinal_ignore_case(&a.key_wide, &b.key_wide);
            if ord == std::cmp::Ordering::Equal {
                a.key_wide.cmp(&b.key_wide)
            } else {
                ord
            }
        });

        let mut block = Vec::new();
        if env_vars.is_empty() {
            block.push(0);
            block.push(0);
            return Ok(block);
        }
        for var in env_vars {
            block.extend_from_slice(&var.key_wide);
            block.push(b'=' as u16);
            block.extend_from_slice(&var.val_wide);
            block.push(0);
        }
        block.push(0);
        Ok(block)
    }

    struct VerifiedPaths {
        executable: PathBuf,
        application: Vec<u16>,
        working_directory: Vec<u16>,
    }

    fn canonical_absolute(
        path: &Path,
        label: &str,
        directory: bool,
    ) -> Result<PathBuf, FailureCause> {
        let invalid_kind = if directory {
            ProcessErrorKind::InvalidWorkingDirectory
        } else {
            ProcessErrorKind::InvalidExecutable
        };
        if !path.is_absolute() {
            return Err(FailureCause::new(
                invalid_kind,
                format!("{label} must be supplied as an absolute path"),
            ));
        }
        let canonical = fs::canonicalize(path).map_err(|error| {
            FailureCause::new(
                invalid_kind,
                format!("verify {label} {}: {error}", path.display()),
            )
        })?;
        if !canonical.is_absolute() {
            return Err(FailureCause::new(
                invalid_kind,
                format!("verified {label} is not absolute: {}", canonical.display()),
            ));
        }
        let metadata = fs::metadata(&canonical).map_err(|error| {
            FailureCause::new(
                invalid_kind,
                format!("inspect verified {label} {}: {error}", canonical.display()),
            )
        })?;
        let type_matches = if directory {
            metadata.is_dir()
        } else {
            metadata.is_file()
        };
        if !type_matches {
            let expected = if directory { "directory" } else { "file" };
            return Err(FailureCause::new(
                invalid_kind,
                format!(
                    "verified {label} is not a {expected}: {}",
                    canonical.display()
                ),
            ));
        }
        Ok(canonical)
    }

    fn starts_with_ascii_ignore_case(value: &[u16], prefix: &[u8]) -> bool {
        value.len() >= prefix.len()
            && prefix.iter().enumerate().all(|(index, expected)| {
                let expected = *expected;
                value[index] == u16::from(expected.to_ascii_lowercase())
                    || value[index] == u16::from(expected.to_ascii_uppercase())
            })
    }

    fn is_drive_absolute_path(path: &[u16]) -> bool {
        path.len() >= 3
            && ((u16::from(b'A')..=u16::from(b'Z')).contains(&path[0])
                || (u16::from(b'a')..=u16::from(b'z')).contains(&path[0]))
            && path[1] == u16::from(b':')
            && path[2] == u16::from(b'\\')
    }

    fn is_standard_unc_path(path: &[u16]) -> bool {
        let separator = u16::from(b'\\');
        if path.len() < 5
            || path[0] != separator
            || path[1] != separator
            || starts_with_ascii_ignore_case(path, b"\\\\?\\")
            || starts_with_ascii_ignore_case(path, b"\\\\.\\")
        {
            return false;
        }

        let rest = &path[2..];
        let Some(server_end) = rest.iter().position(|unit| *unit == separator) else {
            return false;
        };
        if server_end == 0 {
            return false;
        }
        let share = &rest[server_end + 1..];
        share.iter().take_while(|unit| **unit != separator).count() > 0
    }

    fn normalize_working_directory_syntax(raw: &[u16]) -> Result<Vec<u16>, FailureCause> {
        let invalid = || {
            FailureCause::new(
                ProcessErrorKind::InvalidWorkingDirectory,
                "working directory is not a supported absolute DOS drive or UNC path",
            )
        };
        if raw.contains(&0) {
            return Err(invalid());
        }

        if starts_with_ascii_ignore_case(raw, b"\\\\?\\UNC\\") {
            let tail = &raw[8..];
            let mut unc = Vec::new();
            unc.try_reserve(tail.len().saturating_add(2))
                .map_err(|error| {
                    FailureCause::new(
                        ProcessErrorKind::Spawn,
                        format!("allocate UNC working-directory storage: {error}"),
                    )
                })?;
            unc.extend_from_slice(&[u16::from(b'\\'), u16::from(b'\\')]);
            unc.extend_from_slice(tail);
            if !is_standard_unc_path(&unc) {
                return Err(invalid());
            }
            Ok(unc)
        } else if starts_with_ascii_ignore_case(raw, b"\\\\?\\") {
            let drive_path = &raw[4..];
            if !is_drive_absolute_path(drive_path) {
                return Err(invalid());
            }
            Ok(drive_path.to_vec())
        } else if is_drive_absolute_path(raw) || is_standard_unc_path(raw) {
            Ok(raw.to_vec())
        } else {
            Err(invalid())
        }
    }

    fn try_identity_matched_short_path(path: &Path) -> Option<Vec<u16>> {
        let path_wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        let mut buffer = vec![0u16; MAX_PATH + 16];
        let len = unsafe {
            GetShortPathNameW(path_wide.as_ptr(), buffer.as_mut_ptr(), buffer.len() as u32)
        };
        if len == 0 || len as usize >= buffer.len() {
            return None;
        }
        buffer.truncate(len as usize);
        let normalized_short = normalize_working_directory_syntax(&buffer).ok()?;
        if normalized_short.len() > MAX_PATH - 1 {
            return None;
        }
        use std::os::windows::ffi::OsStringExt;
        let short_os = OsString::from_wide(&normalized_short);
        let target_canonical = fs::canonicalize(path).ok()?;
        let short_canonical = fs::canonicalize(&short_os).ok()?;
        if target_canonical != short_canonical {
            return None;
        }
        Some(normalized_short)
    }

    /// Keep the canonical path for verification, but pass CreateProcessW a DOS
    /// drive or UNC spelling for `lpCurrentDirectory`. In particular, translate
    /// extended UNC paths as `\\server\share`, not by dropping their first four
    /// characters; reject device namespaces that have no safe DOS spelling.
    ///
    /// When the path exceeds MAX_PATH, Win32 CreateProcessW rejects ordinary
    /// DOS drive/UNC paths with error 267 unless longPathAware is in the host
    /// manifest. If a verified 8.3 short-name representation exists on the
    /// underlying volume and matches the target directory identity, use it to
    /// safely bridge CreateProcessW; otherwise preserve the faithful DOS path
    /// so that OS limits are not hidden with an invalid fallback.
    fn working_directory_for_create_process(path: &Path) -> Result<Vec<u16>, FailureCause> {
        let raw = path.as_os_str().encode_wide().collect::<Vec<_>>();
        let normalized = normalize_working_directory_syntax(&raw)?;
        let chosen = if normalized.len() > MAX_PATH - 1 {
            try_identity_matched_short_path(path).unwrap_or(normalized)
        } else {
            normalized
        };

        // Preserve the runner's existing Win32 UTF-16 path bound, including the
        // terminating NUL passed to CreateProcessW.
        if chosen.len() > MAX_COMMAND_LINE_UTF16 - 1 {
            return Err(FailureCause::new(
                ProcessErrorKind::CommandLineTooLong,
                "working directory exceeds the Win32 UTF-16 length limit",
            ));
        }
        let mut terminated = chosen;
        terminated.try_reserve(1).map_err(|error| {
            FailureCause::new(
                ProcessErrorKind::Spawn,
                format!("allocate working-directory terminator: {error}"),
            )
        })?;
        terminated.push(0);
        Ok(terminated)
    }

    fn verify_paths(spec: &ProcessSpec) -> Result<VerifiedPaths, FailureCause> {
        let executable = canonical_absolute(&spec.executable, "executable", false)?;
        let working_directory =
            canonical_absolute(&spec.working_directory, "working directory", true)?;
        let application = wide_z(executable.as_os_str(), "executable path")?;
        let working_directory_wide = working_directory_for_create_process(&working_directory)?;
        Ok(VerifiedPaths {
            executable,
            application,
            working_directory: working_directory_wide,
        })
    }

    fn create_pipe() -> Result<(Handle, Handle), FailureCause> {
        let mut attributes: SECURITY_ATTRIBUTES = unsafe { mem::zeroed() };
        attributes.nLength = mem::size_of::<SECURITY_ATTRIBUTES>() as u32;
        attributes.lpSecurityDescriptor = ptr::null_mut();
        // Keep both backing endpoints non-inheritable. Only dedicated duplicates
        // for this child are made inheritable immediately before CreateProcessW;
        // otherwise an unrelated concurrent process creation can retain a pipe
        // writer and prevent the reader from observing EOF.
        attributes.bInheritHandle = 0;

        let mut read = ptr::null_mut();
        let mut write = ptr::null_mut();
        let created = unsafe { CreatePipe(&mut read, &mut write, &attributes, 0) };
        let read = Handle(read);
        let write = Handle(write);
        if created == 0 {
            return Err(FailureCause::new(
                ProcessErrorKind::Spawn,
                last_error("CreatePipe"),
            ));
        }
        if !read.is_open() || !write.is_open() {
            return Err(FailureCause::new(
                ProcessErrorKind::Spawn,
                "CreatePipe returned an invalid endpoint",
            ));
        }
        Ok((read, write))
    }

    struct Pipes {
        stdin_for_child: Handle,
        stdin_for_parent: Handle,
        stdout_for_parent: Handle,
        stdout_for_child: Handle,
        stderr_for_parent: Handle,
        stderr_for_child: Handle,
        launch_handles: Option<InheritablePipeHandles>,
    }

    struct InheritablePipeHandles {
        stdin: Handle,
        stdout: Handle,
        stderr: Handle,
    }

    impl InheritablePipeHandles {
        fn duplicate(source: &Handle, label: &str) -> Result<Handle, FailureCause> {
            let process = unsafe { GetCurrentProcess() };
            let mut duplicate = ptr::null_mut();
            if unsafe {
                DuplicateHandle(
                    process,
                    source.raw(),
                    process,
                    &mut duplicate,
                    0,
                    1,
                    DUPLICATE_SAME_ACCESS,
                )
            } == 0
            {
                return Err(FailureCause::new(
                    ProcessErrorKind::Spawn,
                    format!(
                        "duplicate inheritable {label}: {}",
                        last_error("DuplicateHandle")
                    ),
                ));
            }
            if duplicate.is_null() || duplicate == INVALID_HANDLE_VALUE {
                return Err(FailureCause::new(
                    ProcessErrorKind::Spawn,
                    format!("DuplicateHandle returned an invalid {label}"),
                ));
            }
            Ok(Handle(duplicate))
        }

        fn raw_handles(&self) -> [HANDLE; 3] {
            [self.stdin.raw(), self.stdout.raw(), self.stderr.raw()]
        }

        fn close_all_handles(&mut self) -> Result<(), String> {
            let mut errors = Vec::new();
            for (label, handle) in [
                ("launch stdin", &mut self.stdin),
                ("launch stdout", &mut self.stdout),
                ("launch stderr", &mut self.stderr),
            ] {
                if let Err(error) = handle.close() {
                    errors.push(format!("{label}: {error}"));
                }
            }
            if errors.is_empty() {
                Ok(())
            } else {
                Err(errors.join("; "))
            }
        }

        fn all_handles_closed(&self) -> bool {
            !self.stdin.is_open() && !self.stdout.is_open() && !self.stderr.is_open()
        }
    }

    impl Pipes {
        fn new() -> Result<Self, FailureCause> {
            let (stdin_for_child, stdin_for_parent) = create_pipe()?;
            let (stdout_for_parent, stdout_for_child) = create_pipe()?;
            let (stderr_for_parent, stderr_for_child) = create_pipe()?;

            Ok(Self {
                stdin_for_child,
                stdin_for_parent,
                stdout_for_parent,
                stdout_for_child,
                stderr_for_parent,
                stderr_for_child,
                launch_handles: None,
            })
        }

        fn prepare_child_handles(&mut self) -> Result<[HANDLE; 3], FailureCause> {
            if self.launch_handles.is_some() {
                return Err(FailureCause::new(
                    ProcessErrorKind::Internal,
                    "child pipe handles were prepared more than once",
                ));
            }
            let handles = InheritablePipeHandles {
                stdin: InheritablePipeHandles::duplicate(&self.stdin_for_child, "child stdin")?,
                stdout: InheritablePipeHandles::duplicate(&self.stdout_for_child, "child stdout")?,
                stderr: InheritablePipeHandles::duplicate(&self.stderr_for_child, "child stderr")?,
            };
            let raw = handles.raw_handles();
            self.launch_handles = Some(handles);
            Ok(raw)
        }

        fn close_parent_copies(&mut self) -> Result<(), String> {
            let mut errors = Vec::new();
            if let Some(handles) = self.launch_handles.as_mut() {
                if let Err(error) = handles.close_all_handles() {
                    errors.push(format!("temporary inheritable child handles: {error}"));
                }
            }
            for (label, handle) in [
                ("parent stdin writer", &mut self.stdin_for_parent),
                ("parent copy of child stdin", &mut self.stdin_for_child),
                ("parent copy of child stdout", &mut self.stdout_for_child),
                ("parent copy of child stderr", &mut self.stderr_for_child),
            ] {
                if let Err(error) = handle.close() {
                    errors.push(format!("{label}: {error}"));
                }
            }
            if errors.is_empty() {
                Ok(())
            } else {
                Err(errors.join("; "))
            }
        }

        fn close_parent_copies_for_session(&mut self) -> Result<(), String> {
            let mut errors = Vec::new();
            if let Some(handles) = self.launch_handles.as_mut() {
                if let Err(error) = handles.close_all_handles() {
                    errors.push(format!("temporary inheritable child handles: {error}"));
                }
            }
            for (label, handle) in [
                ("parent copy of child stdin", &mut self.stdin_for_child),
                ("parent copy of child stdout", &mut self.stdout_for_child),
                ("parent copy of child stderr", &mut self.stderr_for_child),
            ] {
                if let Err(error) = handle.close() {
                    errors.push(format!("{label}: {error}"));
                }
            }
            if errors.is_empty() {
                Ok(())
            } else {
                Err(errors.join("; "))
            }
        }

        fn duplicate_session_stdin(&self) -> Result<Handle, String> {
            if !self.stdin_for_parent.is_open() {
                return Err("interactive stdin is closed".to_owned());
            }
            let process = unsafe { GetCurrentProcess() };
            let mut duplicate = ptr::null_mut();
            if unsafe {
                DuplicateHandle(
                    process,
                    self.stdin_for_parent.raw(),
                    process,
                    &mut duplicate,
                    0,
                    0,
                    DUPLICATE_SAME_ACCESS,
                )
            } == 0
            {
                return Err(last_error("DuplicateHandle(interactive stdin)"));
            }
            if duplicate.is_null() || duplicate == INVALID_HANDLE_VALUE {
                return Err("DuplicateHandle returned an invalid interactive stdin".to_owned());
            }
            Ok(Handle(duplicate))
        }

        fn close_session_stdin(&mut self) -> Result<(), String> {
            self.stdin_for_parent
                .close()
                .map_err(|error| format!("close interactive stdin: {error}"))
        }

        fn close_all_handles(&mut self) -> Result<(), String> {
            let mut errors = Vec::new();
            for (label, handle) in [
                ("child stdin", &mut self.stdin_for_child),
                ("parent stdin writer", &mut self.stdin_for_parent),
                ("parent stdout reader", &mut self.stdout_for_parent),
                ("child stdout copy", &mut self.stdout_for_child),
                ("parent stderr reader", &mut self.stderr_for_parent),
                ("child stderr copy", &mut self.stderr_for_child),
            ] {
                if let Err(error) = handle.close() {
                    errors.push(format!("{label}: {error}"));
                }
            }
            if let Some(handles) = self.launch_handles.as_mut() {
                if let Err(error) = handles.close_all_handles() {
                    errors.push(format!("temporary inheritable child handles: {error}"));
                }
            }
            if errors.is_empty() {
                Ok(())
            } else {
                Err(errors.join("; "))
            }
        }

        fn all_handles_closed(&self) -> bool {
            !self.stdin_for_child.is_open()
                && !self.stdin_for_parent.is_open()
                && !self.stdout_for_parent.is_open()
                && !self.stdout_for_child.is_open()
                && !self.stderr_for_parent.is_open()
                && !self.stderr_for_child.is_open()
                && self
                    .launch_handles
                    .as_ref()
                    .is_none_or(InheritablePipeHandles::all_handles_closed)
        }

        fn take_output_readers(&mut self) -> (Handle, Handle) {
            let stdout = mem::replace(&mut self.stdout_for_parent, Handle::null());
            let stderr = mem::replace(&mut self.stderr_for_parent, Handle::null());
            (stdout, stderr)
        }
    }

    fn create_kill_on_close_job() -> Result<Handle, FailureCause> {
        let raw = unsafe { CreateJobObjectW(ptr::null(), ptr::null()) };
        if raw.is_null() {
            return Err(FailureCause::new(
                ProcessErrorKind::Spawn,
                last_error("CreateJobObjectW"),
            ));
        }
        let job = Handle(raw);
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { mem::zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let configured = unsafe {
            SetInformationJobObject(
                job.raw(),
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const c_void,
                mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if configured == 0 {
            return Err(FailureCause::new(
                ProcessErrorKind::Spawn,
                last_error("SetInformationJobObject(KILL_ON_JOB_CLOSE)"),
            ));
        }
        Ok(job)
    }

    /// The two-call Win32 attribute-list API needs aligned caller-owned storage.
    struct AttributeList {
        storage: Vec<usize>,
        initialized: bool,
    }

    impl AttributeList {
        fn new(handles: &[HANDLE; 3]) -> Result<Self, FailureCause> {
            let mut required = 0usize;
            let sized =
                unsafe { InitializeProcThreadAttributeList(ptr::null_mut(), 1, 0, &mut required) };
            if sized != 0 || required == 0 {
                return Err(FailureCause::new(
                    ProcessErrorKind::Spawn,
                    last_error("InitializeProcThreadAttributeList(size)"),
                ));
            }
            let alignment = mem::size_of::<usize>();
            let rounded = required.checked_add(alignment - 1).ok_or_else(|| {
                FailureCause::new(
                    ProcessErrorKind::Spawn,
                    "process attribute-list size overflow",
                )
            })?;
            let words = rounded / alignment;
            let mut storage = Vec::new();
            storage.try_reserve_exact(words).map_err(|error| {
                FailureCause::new(
                    ProcessErrorKind::Spawn,
                    format!("allocate process attribute list: {error}"),
                )
            })?;
            storage.resize(words, 0);

            let initialized = unsafe {
                InitializeProcThreadAttributeList(
                    storage.as_mut_ptr() as *mut c_void,
                    1,
                    0,
                    &mut required,
                )
            };
            if initialized == 0 {
                return Err(FailureCause::new(
                    ProcessErrorKind::Spawn,
                    last_error("InitializeProcThreadAttributeList"),
                ));
            }
            let mut result = Self {
                storage,
                initialized: true,
            };
            let updated = unsafe {
                UpdateProcThreadAttribute(
                    result.as_mut_ptr(),
                    0,
                    PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
                    handles.as_ptr() as *mut c_void,
                    mem::size_of_val(handles),
                    ptr::null_mut(),
                    ptr::null_mut(),
                )
            };
            if updated == 0 {
                return Err(FailureCause::new(
                    ProcessErrorKind::Spawn,
                    last_error("UpdateProcThreadAttribute(HANDLE_LIST)"),
                ));
            }
            Ok(result)
        }

        fn as_mut_ptr(&mut self) -> *mut c_void {
            self.storage.as_mut_ptr() as *mut c_void
        }
    }

    impl Drop for AttributeList {
        fn drop(&mut self) {
            if self.initialized {
                unsafe {
                    DeleteProcThreadAttributeList(self.storage.as_mut_ptr() as *mut c_void);
                }
                self.initialized = false;
            }
        }
    }

    #[repr(C)]
    struct StartupInfoExW {
        startup_info: STARTUPINFOW,
        attribute_list: *mut c_void,
    }

    /// Owns the resources needed to create and clean up a child. Keeping them
    /// together makes the ownership transfer to `OwnedCleanupState` explicit.
    /// The reservation is last so a failed pre-spawn operation releases its slot
    /// only after dropping the handles and reader state.
    struct OwnedSpawnResources {
        pipes: Pipes,
        readers: ReaderSet,
        job: Handle,
        reservation: CleanupReservation,
    }

    fn create_suspended(
        paths: &VerifiedPaths,
        command_line: &mut [u16],
        environment: Option<&mut [u16]>,
        mut resources: OwnedSpawnResources,
        #[cfg(test)] startup_variant: StartupVariant,
    ) -> Result<OwnedCleanupState, FailureCause> {
        // All other fallible setup and cleanup-slot reservation are complete.
        // Duplicate only the three standard handles for this launch, and retain
        // their owners in Pipes until the post-spawn close is proven.
        let handles = resources.pipes.prepare_child_handles()?;
        let mut attributes = AttributeList::new(&handles)?;
        #[cfg(not(test))]
        let (creation_flags, startup_flags) = (
            CREATE_SUSPENDED | CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT,
            STARTF_USESTDHANDLES,
        );
        #[cfg(test)]
        let (creation_flags, startup_flags) = match startup_variant {
            StartupVariant::Production => (
                CREATE_SUSPENDED | CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT,
                STARTF_USESTDHANDLES,
            ),
            StartupVariant::WithoutCreateNoWindow => (
                CREATE_SUSPENDED | EXTENDED_STARTUPINFO_PRESENT,
                STARTF_USESTDHANDLES,
            ),
            StartupVariant::OldWindowHint => (
                CREATE_SUSPENDED | CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT,
                STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW,
            ),
        };
        let mut startup: StartupInfoExW = unsafe { mem::zeroed() };
        startup.startup_info.cb = mem::size_of::<StartupInfoExW>() as u32;
        startup.startup_info.dwFlags = startup_flags;
        startup.startup_info.wShowWindow = 0;
        startup.startup_info.hStdInput = handles[0];
        startup.startup_info.hStdOutput = handles[1];
        startup.startup_info.hStdError = handles[2];
        startup.attribute_list = attributes.as_mut_ptr();

        let mut info: PROCESS_INFORMATION = unsafe { mem::zeroed() };
        let mut final_creation_flags = creation_flags;
        let env_ptr = match environment {
            Some(block) => {
                final_creation_flags |= CREATE_UNICODE_ENVIRONMENT;
                block.as_mut_ptr() as *mut c_void
            }
            None => ptr::null_mut(),
        };
        let created = unsafe {
            CreateProcessW(
                paths.application.as_ptr(),
                command_line.as_mut_ptr(),
                ptr::null(),
                ptr::null(),
                1,
                final_creation_flags,
                env_ptr,
                paths.working_directory.as_ptr(),
                (&startup as *const StartupInfoExW).cast::<STARTUPINFOW>(),
                &mut info,
            )
        };
        if created == 0 {
            return Err(FailureCause::new(
                ProcessErrorKind::Spawn,
                last_error("CreateProcessW"),
            ));
        }
        Ok(OwnedCleanupState::new(resources, info))
    }

    struct ChildGuard {
        job: Handle,
        process: Handle,
        thread: Handle,
        pid: u32,
        assigned: bool,
        reaped: bool,
        drained: bool,
    }

    impl ChildGuard {
        fn new(job: Handle, info: PROCESS_INFORMATION) -> Self {
            Self {
                job,
                process: Handle(info.hProcess),
                thread: Handle(info.hThread),
                pid: info.dwProcessId,
                assigned: false,
                reaped: false,
                drained: false,
            }
        }

        fn assign_to_job(&mut self) -> Result<(), String> {
            if unsafe { AssignProcessToJobObject(self.job.raw(), self.process.raw()) } == 0 {
                return Err(last_error("AssignProcessToJobObject"));
            }
            self.assigned = true;
            Ok(())
        }

        fn resume(&self) -> Result<(), String> {
            let previous_suspend_count = unsafe { ResumeThread(self.thread.raw()) };
            if previous_suspend_count == u32::MAX {
                return Err(last_error("ResumeThread"));
            }
            if previous_suspend_count != 1 {
                return Err(format!(
					"ResumeThread returned unexpected previous suspend count {previous_suspend_count}"
				));
            }
            Ok(())
        }

        fn close_thread_handle(&mut self) -> Result<(), String> {
            self.thread.close()
        }

        fn exit_code(&self) -> Result<u32, String> {
            let mut code = 0u32;
            if unsafe { GetExitCodeProcess(self.process.raw(), &mut code) } == 0 {
                return Err(last_error("GetExitCodeProcess"));
            }
            Ok(code)
        }

        fn process_signaled(&mut self) -> Result<bool, String> {
            if self.reaped {
                return Ok(true);
            }
            if !self.process.is_open() {
                return Err("child process handle is closed before reap".to_string());
            }
            match unsafe { WaitForSingleObject(self.process.raw(), 0) } {
                WAIT_OBJECT_0 => {
                    self.reaped = true;
                    Ok(true)
                }
                WAIT_TIMEOUT => Ok(false),
                _ => Err(last_error("WaitForSingleObject(process, poll)")),
            }
        }

        fn active_processes(&self) -> Result<u32, String> {
            if !self.job.is_open() {
                return Err("job handle is closed before active-process verification".to_string());
            }
            let mut info: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = unsafe { mem::zeroed() };
            let queried = unsafe {
                QueryInformationJobObject(
                    self.job.raw(),
                    JobObjectBasicAccountingInformation,
                    &mut info as *mut _ as *mut c_void,
                    mem::size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                    ptr::null_mut(),
                )
            };
            if queried == 0 {
                return Err(last_error("QueryInformationJobObject"));
            }
            Ok(info.ActiveProcesses)
        }

        fn wait_for_process_until(
            &mut self,
            cancellation: Option<&CancellationToken>,
            deadline: Instant,
        ) -> Result<(), String> {
            if self.reaped {
                return Ok(());
            }
            loop {
                if cancellation.is_some_and(CancellationToken::is_cancelled) {
                    return Err(format!(
                        "cleanup wait for child {} was cancelled before reap",
                        self.pid
                    ));
                }
                let now = Instant::now();
                if now >= deadline {
                    return Err(format!(
                        "child {} was not reaped before cleanup deadline",
                        self.pid
                    ));
                }
                let wait_ms = wait_slice(deadline);
                match unsafe { WaitForSingleObject(self.process.raw(), wait_ms) } {
                    WAIT_OBJECT_0 => {
                        self.reaped = true;
                        return Ok(());
                    }
                    WAIT_TIMEOUT => {}
                    _ => return Err(last_error("WaitForSingleObject(process, cleanup)")),
                }
            }
        }

        fn wait_for_job_idle_until(
            &self,
            cancellation: Option<&CancellationToken>,
            deadline: Instant,
        ) -> Result<(), String> {
            loop {
                let active = self.active_processes()?;
                if active == 0 {
                    return Ok(());
                }
                if cancellation.is_some_and(CancellationToken::is_cancelled) {
                    return Err(format!(
                        "cleanup wait cancelled with {active} active process(es) remaining in job"
                    ));
                }
                if Instant::now() >= deadline {
                    return Err(format!(
                        "job still has {active} active process(es) after cleanup deadline"
                    ));
                }
                sleep_until_poll(deadline);
            }
        }

        /// Natural completion is accepted only after both the leader is signaled
        /// and the job has drained. On every other path, terminate the job and
        /// leader, reap the direct child, and verify ActiveProcesses == 0.
        ///
        /// Does NOT close the job or process handles on failure so that
        /// `PendingCleanup` retains full query and termination capability.
        fn ensure_drained_until(
            &mut self,
            cancellation: Option<&CancellationToken>,
            deadline: Instant,
        ) -> Result<(), String> {
            if self.drained {
                return Ok(());
            }
            let process_done = self.process_signaled().unwrap_or_default();
            let job_done = !self.assigned || matches!(self.active_processes(), Ok(0));
            if process_done && job_done {
                self.drained = true;
                return Ok(());
            }

            let mut terminate_errors = Vec::new();
            if self.assigned
                && self.job.is_open()
                && unsafe { TerminateJobObject(self.job.raw(), 0x4D58_0001) } == 0
            {
                let err = last_error("TerminateJobObject");
                if !matches!(self.active_processes(), Ok(0)) {
                    terminate_errors.push(err);
                }
            }
            if !process_done
                && self.process.is_open()
                && unsafe { TerminateProcess(self.process.raw(), 0x4D58_0001) } == 0
            {
                let err = last_error("TerminateProcess");
                if !matches!(self.process_signaled(), Ok(true)) {
                    terminate_errors.push(err);
                }
            }

            let process_result = self.wait_for_process_until(cancellation, deadline);
            let job_result = if self.assigned {
                self.wait_for_job_idle_until(cancellation, deadline)
            } else {
                Ok(())
            };
            match (process_result, job_result) {
                (Ok(()), Ok(())) => {
                    self.drained = true;
                    Ok(())
                }
                (process, job) => {
                    let mut errors = terminate_errors;
                    if let Err(error) = process {
                        errors.push(format!("direct-child reap: {error}"));
                    }
                    if let Err(error) = job {
                        errors.push(format!("job drain: {error}"));
                    }
                    Err(errors.join("; "))
                }
            }
        }

        fn close_job_handle(&mut self) -> Result<(), String> {
            self.job.close()
        }

        fn close_non_job_handles(&mut self) -> Result<(), String> {
            let mut errors = Vec::new();
            if let Err(error) = self.thread.close() {
                errors.push(format!("close child thread handle: {error}"));
            }
            if let Err(error) = self.process.close() {
                errors.push(format!("close child process handle: {error}"));
            }
            if errors.is_empty() {
                Ok(())
            } else {
                Err(errors.join("; "))
            }
        }

        fn close_all_handles(&mut self) -> Result<(), String> {
            let mut error = None;
            if let Err(close_err) = self.close_non_job_handles() {
                append_error(&mut error, close_err);
            }
            if let Err(close_err) = self.close_job_handle() {
                append_error(&mut error, close_err);
            }
            match error {
                Some(detail) => Err(detail),
                None => Ok(()),
            }
        }

        fn all_handles_closed(&self) -> bool {
            !self.job.is_open() && !self.process.is_open() && !self.thread.is_open()
        }
    }

    fn wait_slice(deadline: Instant) -> u32 {
        let remaining = deadline.saturating_duration_since(Instant::now());
        let millis = remaining.as_millis().max(1).min(POLL_INTERVAL.as_millis());
        millis as u32
    }

    fn sleep_until_poll(deadline: Instant) {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if !remaining.is_zero() {
            thread::sleep(remaining.min(POLL_INTERVAL));
        }
    }

    #[derive(Clone, Copy, Debug, Eq, PartialEq)]
    enum Stream {
        Stdout,
        Stderr,
    }

    enum SessionChunk {
        Bytes(Stream, Vec<u8>),
        Eof(Stream),
        Error(Stream, String),
    }

    struct ReaderReport {
        stream: Stream,
        bytes: Vec<u8>,
        truncated: bool,
        error: Option<String>,
    }

    fn read_stream(
        stream: Stream,
        pipe: &Handle,
        limit: usize,
        overflow: &AtomicBool,
    ) -> ReaderReport {
        read_stream_with_session(stream, pipe, limit, overflow, None)
    }

    fn read_stream_with_session(
        stream: Stream,
        pipe: &Handle,
        limit: usize,
        overflow: &AtomicBool,
        session_sender: Option<SyncSender<SessionChunk>>,
    ) -> ReaderReport {
        let mut bytes = Vec::new();
        let mut truncated = false;
        let mut error = None;
        let mut buffer = [0u8; 8192];

        loop {
            let mut read = 0u32;
            let succeeded = unsafe {
                ReadFile(
                    pipe.raw(),
                    buffer.as_mut_ptr(),
                    buffer.len() as u32,
                    &mut read,
                    ptr::null_mut(),
                )
            };
            if succeeded == 0 {
                let read_error = std::io::Error::last_os_error();
                if read_error.raw_os_error() == Some(ERROR_BROKEN_PIPE) {
                    break;
                }
                if error.is_none() {
                    error = Some(format!("{} ReadFile: {read_error}", stream_name(stream)));
                }
                break;
            }
            if read == 0 {
                break;
            }
            let count = read as usize;
            if count > buffer.len() {
                if error.is_none() {
                    error = Some(format!(
                        "{} ReadFile returned an invalid byte count",
                        stream_name(stream)
                    ));
                }
                break;
            }

            if let Some(sender) = session_sender.as_ref() {
                // The session coordinator drains this bounded channel while the
                // stdin writer is active and during cleanup.
                if sender
                    .send(SessionChunk::Bytes(stream, buffer[..count].to_vec()))
                    .is_err()
                {
                    // Continue draining the native pipe even if the receiver ended.
                }
            }

            let available = limit.saturating_sub(bytes.len());
            let retain = count.min(available);
            if retain > 0 && error.is_none() {
                match bytes.try_reserve(retain) {
                    Ok(()) => bytes.extend_from_slice(&buffer[..retain]),
                    Err(allocation_error) => {
                        // Latch only the first allocation error so `error` cannot
                        // grow without bound while draining remaining pipe output.
                        error = Some(format!(
                            "{} log allocation failed: {allocation_error}",
                            stream_name(stream)
                        ));
                    }
                }
            }
            if retain < count {
                truncated = true;
                overflow.store(true, Ordering::Release);
            }
            // Continue reading after the retained-log cap. The pipe must still
            // be drained so the child cannot deadlock on a full kernel buffer.
        }

        if let Some(sender) = session_sender {
            if let Some(error) = error.as_ref() {
                let _ = sender.send(SessionChunk::Error(stream, error.clone()));
            }
            let _ = sender.send(SessionChunk::Eof(stream));
        }

        ReaderReport {
            stream,
            bytes,
            truncated,
            error,
        }
    }

    fn write_session_pipe(
        pipe: &Handle,
        bytes: &[u8],
        cancellation: &CancellationToken,
        deadline: Instant,
    ) -> Result<(), String> {
        if bytes.len() > PROCESS_SESSION_MAX_INPUT_BYTES {
            return Err("interactive request exceeds its bounded input limit".to_owned());
        }
        let mut offset = 0usize;
        while offset < bytes.len() {
            if cancellation.is_cancelled() {
                return Err("interactive stdin write was cancelled".to_owned());
            }
            if Instant::now() >= deadline {
                return Err("interactive stdin write deadline expired".to_owned());
            }
            let count = (bytes.len() - offset)
                .min(SESSION_WRITE_CHUNK_BYTES)
                .min(u32::MAX as usize);
            let mut written = 0u32;
            let result = unsafe {
                WriteFile(
                    pipe.raw(),
                    bytes[offset..].as_ptr(),
                    count as u32,
                    &mut written,
                    ptr::null_mut(),
                )
            };
            if result == 0 {
                return Err(last_error("WriteFile(interactive stdin)"));
            }
            if written == 0 || written as usize > count {
                return Err("WriteFile returned an invalid interactive byte count".to_owned());
            }
            offset = offset.saturating_add(written as usize);
        }
        Ok(())
    }

    fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
        if needle.is_empty() || needle.len() > haystack.len() {
            return None;
        }
        haystack
            .windows(needle.len())
            .position(|window| window == needle)
    }

    fn stream_name(stream: Stream) -> &'static str {
        match stream {
            Stream::Stdout => "stdout",
            Stream::Stderr => "stderr",
        }
    }

    struct ReaderFinish {
        logs: ProcessLogs,
        error: Option<String>,
        all_joined: bool,
    }

    struct ReaderSet {
        receiver: Option<Receiver<ReaderReport>>,
        session_receiver: Option<Receiver<SessionChunk>>,
        expected: usize,
        stdout_thread: Option<JoinHandle<()>>,
        stderr_thread: Option<JoinHandle<()>>,
        stdout_pipe: Option<Arc<Mutex<Option<Handle>>>>,
        stderr_pipe: Option<Arc<Mutex<Option<Handle>>>>,
        stdout_report: Option<ReaderReport>,
        stderr_report: Option<ReaderReport>,
        terminal_error: Option<String>,
        stdout_overflow: Arc<AtomicBool>,
        stderr_overflow: Arc<AtomicBool>,
        session_stdout: Vec<u8>,
        session_stderr: Vec<u8>,
        session_limit: usize,
        session_stdout_eof: bool,
        session_disconnected: bool,
        session_overflow: bool,
        session_writer: Option<JoinHandle<()>>,
        session_write_receiver: Option<Receiver<Result<(), String>>>,
        session_write_result: Option<Result<(), String>>,
    }

    impl ReaderSet {
        fn new() -> Self {
            Self {
                receiver: None,
                session_receiver: None,
                expected: 0,
                stdout_thread: None,
                stderr_thread: None,
                stdout_pipe: None,
                stderr_pipe: None,
                stdout_report: None,
                stderr_report: None,
                terminal_error: None,
                stdout_overflow: Arc::new(AtomicBool::new(false)),
                stderr_overflow: Arc::new(AtomicBool::new(false)),
                session_stdout: Vec::new(),
                session_stderr: Vec::new(),
                session_limit: 0,
                session_stdout_eof: false,
                session_disconnected: false,
                session_overflow: false,
                session_writer: None,
                session_write_receiver: None,
                session_write_result: None,
            }
        }

        fn launch(
            &mut self,
            stream: Stream,
            pipe: Handle,
            limit: usize,
            overflow: Arc<AtomicBool>,
            sender: SyncSender<ReaderReport>,
            session_sender: Option<SyncSender<SessionChunk>>,
        ) -> Result<(), FailureCause> {
            let name = match stream {
                Stream::Stdout => "process-stdout-reader",
                Stream::Stderr => "process-stderr-reader",
            };
            let shared_pipe = Arc::new(Mutex::new(Some(pipe)));
            match stream {
                Stream::Stdout => self.stdout_pipe = Some(Arc::clone(&shared_pipe)),
                Stream::Stderr => self.stderr_pipe = Some(Arc::clone(&shared_pipe)),
            }
            let reader_pipe = Arc::clone(&shared_pipe);
            let thread =
                thread::Builder::new()
                    .name(name.to_string())
                    .spawn(move || {
                        let report =
                            {
                                let slot = lock_unpoisoned(&reader_pipe);
                                match slot.as_ref() {
                                    Some(pipe) => std::panic::catch_unwind(
                                        std::panic::AssertUnwindSafe(|| match session_sender {
                                            Some(session_sender) => read_stream_with_session(
                                                stream,
                                                pipe,
                                                limit,
                                                &overflow,
                                                Some(session_sender),
                                            ),
                                            None => read_stream(stream, pipe, limit, &overflow),
                                        }),
                                    )
                                    .unwrap_or_else(|_| ReaderReport {
                                        stream,
                                        bytes: Vec::new(),
                                        truncated: false,
                                        error: Some(format!(
                                            "{} reader thread panicked while reading",
                                            stream_name(stream)
                                        )),
                                    }),
                                    None => ReaderReport {
                                        stream,
                                        bytes: Vec::new(),
                                        truncated: false,
                                        error: Some(format!(
                                            "{} reader pipe handle was unavailable",
                                            stream_name(stream)
                                        )),
                                    },
                                }
                            };
                        let _ = sender.send(report);
                    })
                    .map_err(|error| {
                        FailureCause::new(
                            ProcessErrorKind::ReadFailure,
                            format!("start {name}: {error}"),
                        )
                    })?;
            match stream {
                Stream::Stdout => self.stdout_thread = Some(thread),
                Stream::Stderr => self.stderr_thread = Some(thread),
            }
            self.expected += 1;
            Ok(())
        }

        fn start(
            &mut self,
            stdout: Handle,
            stderr: Handle,
            limit: usize,
        ) -> Result<(), FailureCause> {
            let (sender, receiver) = mpsc::sync_channel(2);
            self.receiver = Some(receiver);
            self.launch(
                Stream::Stdout,
                stdout,
                limit,
                Arc::clone(&self.stdout_overflow),
                sender.clone(),
                None,
            )?;
            self.launch(
                Stream::Stderr,
                stderr,
                limit,
                Arc::clone(&self.stderr_overflow),
                sender.clone(),
                None,
            )?;
            drop(sender);
            Ok(())
        }

        fn start_session(
            &mut self,
            stdout: Handle,
            stderr: Handle,
            limit: usize,
        ) -> Result<(), FailureCause> {
            let (report_sender, report_receiver) = mpsc::sync_channel(2);
            let (session_sender, session_receiver) = mpsc::sync_channel(SESSION_CHANNEL_CAPACITY);
            self.receiver = Some(report_receiver);
            self.session_receiver = Some(session_receiver);
            self.session_limit = limit;
            self.session_stdout.clear();
            self.session_stderr.clear();
            self.session_stdout_eof = false;
            self.session_disconnected = false;
            self.session_overflow = false;
            self.launch(
                Stream::Stdout,
                stdout,
                limit,
                Arc::clone(&self.stdout_overflow),
                report_sender.clone(),
                Some(session_sender.clone()),
            )?;
            self.launch(
                Stream::Stderr,
                stderr,
                limit,
                Arc::clone(&self.stderr_overflow),
                report_sender.clone(),
                Some(session_sender),
            )?;
            drop(report_sender);
            Ok(())
        }

        fn start_session_write(
            &mut self,
            pipe: Option<Handle>,
            input: Vec<u8>,
            cancellation: &CancellationToken,
            deadline: Instant,
        ) -> Result<(), String> {
            if self.session_writer.is_some() || self.session_write_receiver.is_some() {
                return Err("an interactive request writer is already active".to_owned());
            }
            if input.is_empty() {
                self.session_write_result = Some(Ok(()));
                return Ok(());
            }
            let pipe = pipe.ok_or_else(|| "interactive stdin handle is unavailable".to_owned())?;
            let cancellation = cancellation.clone();
            let (sender, receiver) = mpsc::sync_channel(1);
            let worker = thread::Builder::new()
                .name("process-session-stdin-writer".to_owned())
                .spawn(move || {
                    let result = write_session_pipe(&pipe, &input, &cancellation, deadline);
                    let _ = sender.send(result);
                })
                .map_err(|error| format!("start interactive stdin writer: {error}"))?;
            self.session_writer = Some(worker);
            self.session_write_receiver = Some(receiver);
            self.session_write_result = None;
            Ok(())
        }

        fn poll_session_writer(&mut self) -> Result<bool, String> {
            if self.session_write_result.is_none() {
                let received = self.session_write_receiver.as_ref().map(Receiver::try_recv);
                match received {
                    Some(Ok(result)) => self.session_write_result = Some(result),
                    Some(Err(TryRecvError::Disconnected)) => {
                        if self.session_writer.is_none() {
                            return Err(
                                "interactive stdin writer ended without a result".to_owned()
                            );
                        }
                    }
                    Some(Err(TryRecvError::Empty)) | None => {}
                }
            }

            if self
                .session_writer
                .as_ref()
                .is_some_and(JoinHandle::is_finished)
            {
                if let Some(worker) = self.session_writer.take() {
                    if worker.join().is_err() {
                        return Err("interactive stdin writer panicked".to_owned());
                    }
                }
                if self.session_write_result.is_none() {
                    let received = self.session_write_receiver.as_ref().map(Receiver::try_recv);
                    match received {
                        Some(Ok(result)) => self.session_write_result = Some(result),
                        _ => {
                            return Err("interactive stdin writer ended without a result".to_owned())
                        }
                    }
                }
            }

            match self.session_write_result.as_ref() {
                Some(Err(error)) => Err(error.clone()),
                Some(Ok(())) => Ok(self.session_writer.is_none()),
                None if self.session_writer.is_none() => Ok(true),
                None => Ok(false),
            }
        }

        fn clear_session_writer(&mut self) {
            self.session_write_receiver = None;
            self.session_write_result = None;
        }

        fn record_session_chunk(&mut self, chunk: SessionChunk) {
            match chunk {
                SessionChunk::Bytes(Stream::Stdout, bytes) => {
                    let available = self.session_limit.saturating_sub(self.session_stdout.len());
                    let retained = available.min(bytes.len());
                    if retained < bytes.len() {
                        self.session_overflow = true;
                    }
                    if retained > 0 {
                        self.session_stdout.extend_from_slice(&bytes[..retained]);
                    }
                }
                SessionChunk::Bytes(Stream::Stderr, bytes) => {
                    let available = self.session_limit.saturating_sub(self.session_stderr.len());
                    let retained = available.min(bytes.len());
                    if retained < bytes.len() {
                        self.session_overflow = true;
                    }
                    if retained > 0 {
                        self.session_stderr.extend_from_slice(&bytes[..retained]);
                    }
                }
                SessionChunk::Eof(Stream::Stdout) => self.session_stdout_eof = true,
                SessionChunk::Eof(Stream::Stderr) => {}
                SessionChunk::Error(stream, error) => {
                    if self.terminal_error.is_none() {
                        self.terminal_error =
                            Some(format!("{} session reader: {error}", stream_name(stream)));
                    }
                }
            }
        }

        fn collect_session_available(&mut self) {
            loop {
                let received = match self.session_receiver.as_ref() {
                    Some(receiver) => receiver.try_recv(),
                    None => return,
                };
                match received {
                    Ok(chunk) => self.record_session_chunk(chunk),
                    Err(TryRecvError::Empty) => return,
                    Err(TryRecvError::Disconnected) => {
                        self.session_disconnected = true;
                        return;
                    }
                }
            }
        }

        fn read_session_until(
            &mut self,
            marker: &[u8],
            cancellation: &CancellationToken,
            deadline: Instant,
        ) -> Result<SessionReply, SessionError> {
            if marker.is_empty() || self.session_receiver.is_none() {
                return Err(SessionError::new(
                    SessionErrorKind::InvalidRequest,
                    "interactive response marker is empty or unavailable",
                ));
            }
            loop {
                self.collect_session_available();
                if let Err(error) = self.poll() {
                    return Err(SessionError::new(SessionErrorKind::ReadFailure, error));
                }
                if self.session_overflow || self.overflowed() {
                    return Err(SessionError::new(
                        SessionErrorKind::OutputLimitExceeded,
                        "interactive process output exceeded its bounded limit",
                    ));
                }
                let writer_finished = self
                    .poll_session_writer()
                    .map_err(|error| SessionError::new(SessionErrorKind::WriteFailure, error))?;
                if let Some(position) = find_subslice(&self.session_stdout, marker) {
                    if writer_finished {
                        let end = position.saturating_add(marker.len());
                        let stdout = self.session_stdout[..position].to_vec();
                        self.session_stdout.drain(..end);
                        let stderr = std::mem::take(&mut self.session_stderr);
                        self.clear_session_writer();
                        return Ok(SessionReply { stdout, stderr });
                    }
                }
                if cancellation.is_cancelled() {
                    return Err(SessionError::new(
                        SessionErrorKind::Cancelled,
                        "interactive request was cancelled",
                    ));
                }
                if Instant::now() >= deadline {
                    return Err(SessionError::new(
                        SessionErrorKind::DeadlineExceeded,
                        "interactive response deadline expired",
                    ));
                }
                if self.session_stdout_eof || self.session_disconnected {
                    return Err(SessionError::new(
                        SessionErrorKind::ReadFailure,
                        "interactive child ended before its response marker",
                    ));
                }
                let wait = deadline
                    .saturating_duration_since(Instant::now())
                    .min(POLL_INTERVAL);
                let received = self
                    .session_receiver
                    .as_ref()
                    .expect("session receiver checked above")
                    .recv_timeout(wait);
                match received {
                    Ok(chunk) => self.record_session_chunk(chunk),
                    Err(RecvTimeoutError::Timeout) => {}
                    Err(RecvTimeoutError::Disconnected) => {
                        self.session_disconnected = true;
                    }
                }
            }
        }

        fn report_count(&self) -> usize {
            usize::from(self.stdout_report.is_some()) + usize::from(self.stderr_report.is_some())
        }

        fn all_joined(&self) -> bool {
            self.stdout_thread.is_none()
                && self.stderr_thread.is_none()
                && self.session_writer.is_none()
        }

        fn record(&mut self, report: ReaderReport) -> Result<(), String> {
            let slot = match report.stream {
                Stream::Stdout => &mut self.stdout_report,
                Stream::Stderr => &mut self.stderr_report,
            };
            if slot.is_some() {
                return Err(format!(
                    "duplicate {} reader report",
                    stream_name(report.stream)
                ));
            }
            *slot = Some(report);
            Ok(())
        }

        fn collect_available(&mut self) -> Result<(), String> {
            loop {
                let received = match self.receiver.as_ref() {
                    Some(receiver) => receiver.try_recv(),
                    None => return Ok(()),
                };
                match received {
                    Ok(report) => self.record(report)?,
                    Err(TryRecvError::Empty) => return Ok(()),
                    Err(TryRecvError::Disconnected) => {
                        if self.report_count() < self.expected {
                            return Err("output reader ended without a report".to_string());
                        }
                        return Ok(());
                    }
                }
            }
        }

        fn reader_error(&self) -> Option<String> {
            if let Some(report) = &self.stdout_report {
                if let Some(error) = &report.error {
                    return Some(error.clone());
                }
            }
            if let Some(report) = &self.stderr_report {
                if let Some(error) = &report.error {
                    return Some(error.clone());
                }
            }
            self.terminal_error.clone()
        }

        fn close_pipe_handle(
            pipe: &Option<Arc<Mutex<Option<Handle>>>>,
            stream: Stream,
        ) -> Result<(), String> {
            let Some(pipe) = pipe else {
                return Ok(());
            };
            let mut slot = lock_unpoisoned(pipe);
            let Some(handle) = slot.as_mut() else {
                return Ok(());
            };
            handle
                .close()
                .map_err(|error| format!("{} pipe close: {error}", stream_name(stream)))
        }

        fn pipe_handle_closed(pipe: &Option<Arc<Mutex<Option<Handle>>>>) -> bool {
            let Some(pipe) = pipe else {
                return true;
            };
            let slot = lock_unpoisoned(pipe);
            slot.as_ref().is_none_or(|handle| !handle.is_open())
        }

        fn all_pipe_handles_closed(&self) -> bool {
            self.all_joined()
                && Self::pipe_handle_closed(&self.stdout_pipe)
                && Self::pipe_handle_closed(&self.stderr_pipe)
        }

        fn finished_without_report(&self) -> Option<String> {
            if let Some(worker) = &self.stdout_thread {
                if worker.is_finished() && self.stdout_report.is_none() {
                    return Some("stdout reader terminated without a report".to_string());
                }
            }
            if let Some(worker) = &self.stderr_thread {
                if worker.is_finished() && self.stderr_report.is_none() {
                    return Some("stderr reader terminated without a report".to_string());
                }
            }
            None
        }

        fn poll(&mut self) -> Result<(), String> {
            if let Err(error) = self.collect_available() {
                append_error(&mut self.terminal_error, error.clone());
                return Err(error);
            }
            if let Some(error) = self.reader_error() {
                return Err(error);
            }
            if let Some(error) = self.finished_without_report() {
                append_error(&mut self.terminal_error, error.clone());
                return Err(error);
            }
            Ok(())
        }

        fn overflowed(&self) -> bool {
            self.stdout_overflow.load(Ordering::Acquire)
                || self.stderr_overflow.load(Ordering::Acquire)
                || self
                    .stdout_report
                    .as_ref()
                    .map(|report| report.truncated)
                    .unwrap_or(false)
                || self
                    .stderr_report
                    .as_ref()
                    .map(|report| report.truncated)
                    .unwrap_or(false)
        }

        fn snapshot_logs(&self) -> ProcessLogs {
            ProcessLogs {
                stdout: self
                    .stdout_report
                    .as_ref()
                    .map(|report| report.bytes.clone())
                    .unwrap_or_default(),
                stderr: self
                    .stderr_report
                    .as_ref()
                    .map(|report| report.bytes.clone())
                    .unwrap_or_default(),
                stdout_truncated: self.stdout_overflow.load(Ordering::Acquire)
                    || self
                        .stdout_report
                        .as_ref()
                        .map(|report| report.truncated)
                        .unwrap_or(false),
                stderr_truncated: self.stderr_overflow.load(Ordering::Acquire)
                    || self
                        .stderr_report
                        .as_ref()
                        .map(|report| report.truncated)
                        .unwrap_or(false),
            }
        }

        /// Waits up to `deadline` (or `cancellation`) for reader threads to finish
        /// and joins only finished threads. Unfinished `JoinHandle`s remain stored
        /// in `self` so they are never detached on timeout.
        fn finish_until(
            &mut self,
            cancellation: Option<&CancellationToken>,
            deadline: Instant,
        ) -> ReaderFinish {
            let mut error = None;
            loop {
                self.collect_session_available();
                if let Err(writer_error) = self.poll_session_writer() {
                    append_error(&mut error, writer_error);
                }
                if self
                    .stdout_thread
                    .as_ref()
                    .is_some_and(JoinHandle::is_finished)
                {
                    if let Some(worker) = self.stdout_thread.take() {
                        if worker.join().is_err() {
                            let detail = "stdout reader thread panicked".to_string();
                            append_error(&mut self.terminal_error, detail.clone());
                            append_error(&mut error, detail);
                        }
                    }
                }
                if self
                    .stderr_thread
                    .as_ref()
                    .is_some_and(JoinHandle::is_finished)
                {
                    if let Some(worker) = self.stderr_thread.take() {
                        if worker.join().is_err() {
                            let detail = "stderr reader thread panicked".to_string();
                            append_error(&mut self.terminal_error, detail.clone());
                            append_error(&mut error, detail);
                        }
                    }
                }
                if self.all_joined() {
                    break;
                }
                if cancellation.is_some_and(CancellationToken::is_cancelled) {
                    append_error(
                        &mut error,
                        "reader drain wait was cancelled while reader thread(s) remained active"
                            .to_string(),
                    );
                    break;
                }
                if Instant::now() >= deadline {
                    append_error(
                        &mut error,
                        "one or more output reader threads did not finish before cleanup deadline"
                            .to_string(),
                    );
                    break;
                }
                sleep_until_poll(deadline);
            }

            if let Err(collect_error) = self.collect_available() {
                append_error(&mut self.terminal_error, collect_error.clone());
                append_error(&mut error, collect_error);
            }
            self.collect_session_available();
            if let Err(writer_error) = self.poll_session_writer() {
                append_error(&mut error, writer_error);
            }
            let all_joined = self.all_joined();
            if all_joined && self.report_count() < self.expected {
                let detail = "one or more output readers did not return a report".to_string();
                append_error(&mut self.terminal_error, detail.clone());
                append_error(&mut error, detail);
            }
            if let Some(read_error) = self.reader_error() {
                append_error(&mut error, read_error);
            }
            if all_joined {
                if let Err(close_error) = Self::close_pipe_handle(&self.stdout_pipe, Stream::Stdout)
                {
                    append_error(&mut error, close_error);
                }
                if let Err(close_error) = Self::close_pipe_handle(&self.stderr_pipe, Stream::Stderr)
                {
                    append_error(&mut error, close_error);
                }
            }
            let logs = self.snapshot_logs();
            ReaderFinish {
                logs,
                error,
                all_joined,
            }
        }
    }

    /// One slot is reserved before the child is created. It follows this state
    /// until cleanup is verified, so dropping a ticket never has to find queue
    /// capacity or start a thread.
    struct CleanupReservation {
        supervisor: &'static HostCleanupSupervisor,
        slot: usize,
    }

    /// The reservation is last so its slot is not released until all reader,
    /// pipe, and child handles have been verified closed.
    struct OwnedCleanupResources {
        readers: ReaderSet,
        pipes: Pipes,
        child: ChildGuard,
        reservation: CleanupReservation,
    }

    /// A post-spawn owner for every process, pipe, reader, and cleanup slot.
    /// An unresolved state transfers itself to its reserved supervisor slot on
    /// drop; that transfer performs no waits, joins, or lock acquisition.
    pub(crate) struct OwnedCleanupState {
        resources: Option<OwnedCleanupResources>,
        resolved: bool,
        completion: Option<Box<dyn FnOnce() + Send + 'static>>,
    }

    impl OwnedCleanupState {
        fn new(resources: OwnedSpawnResources, info: PROCESS_INFORMATION) -> Self {
            Self {
                resources: Some(OwnedCleanupResources {
                    readers: resources.readers,
                    pipes: resources.pipes,
                    child: ChildGuard::new(resources.job, info),
                    reservation: resources.reservation,
                }),
                resolved: false,
                completion: None,
            }
        }

        fn resources_mut(&mut self) -> &mut OwnedCleanupResources {
            self.resources
                .as_mut()
                .expect("unresolved cleanup state owns its resources")
        }

        pub(super) fn set_completion(&mut self, completion: Box<dyn FnOnce() + Send + 'static>) {
            if self.resolved {
                let _ = catch_unwind(AssertUnwindSafe(completion));
            } else {
                self.completion = Some(completion);
            }
        }

        pub(crate) fn set_on_drained(&mut self, callback: Box<dyn FnOnce() + Send + 'static>) {
            self.set_completion(callback);
        }

        fn mark_resolved(&mut self) {
            self.resolved = true;
            if let Some(completion) = self.completion.take() {
                let _ = catch_unwind(AssertUnwindSafe(completion));
            }
        }

        pub(crate) fn pid(&self) -> u32 {
            self.resources
                .as_ref()
                .map_or(0, |resources| resources.child.pid)
        }

        pub(crate) fn close_session_stdin(&mut self) -> Result<(), String> {
            self.pipes_mut().close_session_stdin()
        }

        fn pipes_mut(&mut self) -> &mut Pipes {
            &mut self.resources_mut().pipes
        }

        fn readers_mut(&mut self) -> &mut ReaderSet {
            &mut self.resources_mut().readers
        }

        fn child_mut(&mut self) -> &mut ChildGuard {
            &mut self.resources_mut().child
        }

        fn supervise(
            &mut self,
            cancellation: &CancellationToken,
            deadline: Instant,
        ) -> Result<u32, FailureCause> {
            let resources = self.resources_mut();
            supervise(
                &mut resources.child,
                &mut resources.readers,
                cancellation,
                deadline,
            )
        }

        fn snapshot_logs(&self) -> ProcessLogs {
            self.resources
                .as_ref()
                .map_or_else(ProcessLogs::default, |resources| {
                    resources.readers.snapshot_logs()
                })
        }

        fn reader_error(&self) -> Option<String> {
            self.resources
                .as_ref()
                .and_then(|resources| resources.readers.reader_error())
        }

        pub(crate) fn try_resolve(
            &mut self,
            cancellation: Option<&CancellationToken>,
            timeout: Duration,
        ) -> Result<ProcessLogs, String> {
            if self.resolved {
                return Ok(self.snapshot_logs());
            }
            let deadline = Instant::now()
                .checked_add(timeout)
                .ok_or_else(|| "cleanup retry timeout overflow".to_string())?;
            let mut error = None;
            let logs = {
                let resources = self.resources_mut();
                if let Err(drain_error) =
                    resources.child.ensure_drained_until(cancellation, deadline)
                {
                    append_error(&mut error, drain_error);
                }
                if let Err(close_error) = resources.pipes.close_all_handles() {
                    append_error(&mut error, close_error);
                }
                let reader_deadline =
                    if resources.child.drained && resources.pipes.all_handles_closed() {
                        deadline
                    } else {
                        Instant::now()
                    };
                let finish = resources
                    .readers
                    .finish_until(cancellation, reader_deadline);
                if let Some(reader_error) = finish.error.clone() {
                    append_error(&mut error, reader_error);
                }
                if !resources.child.drained
                    || !finish.all_joined
                    || !resources.pipes.all_handles_closed()
                    || !resources.readers.all_pipe_handles_closed()
                {
                    return Err(error.unwrap_or_else(|| {
                        "process tree, pipes, or output readers remain active".to_string()
                    }));
                }
                if let Err(close_error) = resources.child.close_all_handles() {
                    append_error(&mut error, close_error);
                }
                if !resources.child.all_handles_closed() {
                    append_error(
                        &mut error,
                        "one or more child guard handles remain open".to_string(),
                    );
                    return Err(
                        error.unwrap_or_else(|| "child guard handles remain open".to_string())
                    );
                }
                finish.logs
            };
            self.mark_resolved();
            Ok(logs)
        }

        fn poll_supervisor_slice(&mut self) -> bool {
            if self.resolved {
                return true;
            }
            let deadline = Instant::now()
                .checked_add(SUPERVISOR_SLICE)
                .unwrap_or_else(Instant::now);
            let resolved = {
                let resources = self.resources_mut();
                let _ = resources.child.ensure_drained_until(None, deadline);
                let _ = resources.pipes.close_all_handles();
                let reader_deadline =
                    if resources.child.drained && resources.pipes.all_handles_closed() {
                        deadline
                    } else {
                        Instant::now()
                    };
                let finish = resources.readers.finish_until(None, reader_deadline);
                if !resources.child.drained
                    || !finish.all_joined
                    || !resources.pipes.all_handles_closed()
                    || !resources.readers.all_pipe_handles_closed()
                {
                    false
                } else {
                    let _ = resources.child.close_all_handles();
                    resources.child.all_handles_closed()
                }
            };
            if resolved {
                self.mark_resolved();
            }
            resolved
        }
    }

    impl Drop for OwnedCleanupState {
        fn drop(&mut self) {
            if self.resolved {
                return;
            }
            if let Some(resources) = self.resources.take() {
                enqueue_reserved_cleanup(Self {
                    resources: Some(resources),
                    resolved: false,
                    completion: self.completion.take(),
                });
            }
        }
    }

    struct CleanupSlot {
        state: AtomicU8,
        payload: UnsafeCell<MaybeUninit<OwnedCleanupState>>,
    }

    impl CleanupSlot {
        fn new() -> Self {
            Self {
                state: AtomicU8::new(SLOT_FREE),
                payload: UnsafeCell::new(MaybeUninit::uninit()),
            }
        }
    }

    // SAFETY: a slot's atomic state grants exclusive payload access. A reserver
    // writes only while RESERVED; the worker claims READY before reading and
    // writes again only while PROCESSING. FREE is published after destruction.
    unsafe impl Sync for CleanupSlot {}

    struct HostCleanupSupervisor {
        slots: [CleanupSlot; MAX_SUPERVISED_CLEANUPS],
        wake_lock: Mutex<()>,
        wake: Condvar,
        worker: Mutex<Option<JoinHandle<()>>>,
        worker_ready: AtomicBool,
    }

    static HOST_SUPERVISOR: OnceLock<HostCleanupSupervisor> = OnceLock::new();

    fn host_supervisor() -> &'static HostCleanupSupervisor {
        HOST_SUPERVISOR.get_or_init(|| HostCleanupSupervisor {
            slots: std::array::from_fn(|_| CleanupSlot::new()),
            wake_lock: Mutex::new(()),
            wake: Condvar::new(),
            worker: Mutex::new(None),
            worker_ready: AtomicBool::new(false),
        })
    }

    fn lock_unpoisoned<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
        match mutex.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        }
    }

    fn await_supervisor_ready(supervisor: &'static HostCleanupSupervisor) -> Result<(), String> {
        let deadline = Instant::now() + SUPERVISOR_START_TIMEOUT;
        let mut guard = lock_unpoisoned(&supervisor.wake_lock);
        loop {
            if supervisor.worker_ready.load(Ordering::Acquire) {
                return Ok(());
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(
                    "cleanup supervisor did not become ready before its startup deadline"
                        .to_string(),
                );
            }
            match supervisor.wake.wait_timeout(guard, remaining) {
                Ok((next, timeout)) => {
                    guard = next;
                    if timeout.timed_out() && !supervisor.worker_ready.load(Ordering::Acquire) {
                        return Err(
                            "cleanup supervisor did not become ready before its startup deadline"
                                .to_string(),
                        );
                    }
                }
                Err(poisoned) => {
                    guard = poisoned.into_inner().0;
                }
            }
        }
    }

    /// Reserves one of the bounded cleanup slots and starts the host worker
    /// before any child can be created. Capacity or startup failure is returned
    /// as a typed error; it is never deferred until ticket drop.
    fn reserve_cleanup_slot(
        #[cfg(test)] fault: Option<TestFault>,
    ) -> Result<CleanupReservation, ProcessError> {
        #[cfg(test)]
        if fault == Some(TestFault::CleanupCapacity) {
            return Err(ProcessError::simple(
                ProcessErrorKind::CleanupCapacityExceeded,
                "all bounded process-tree cleanup slots are reserved",
            ));
        }

        let supervisor = host_supervisor();
        let slot = supervisor.slots.iter().position(|slot| {
            slot.state
                .compare_exchange(
                    SLOT_FREE,
                    SLOT_RESERVED,
                    Ordering::AcqRel,
                    Ordering::Acquire,
                )
                .is_ok()
        });
        let Some(slot) = slot else {
            return Err(ProcessError::simple(
                ProcessErrorKind::CleanupCapacityExceeded,
                "all bounded process-tree cleanup slots are reserved",
            ));
        };

        #[cfg(test)]
        let startup = ensure_supervisor_started(supervisor, fault);
        #[cfg(not(test))]
        let startup = ensure_supervisor_started(supervisor);
        if let Err(detail) = startup {
            supervisor.slots[slot]
                .state
                .store(SLOT_FREE, Ordering::Release);
            return Err(ProcessError::simple(
                ProcessErrorKind::CleanupSupervisorUnavailable,
                detail,
            ));
        }

        Ok(CleanupReservation { supervisor, slot })
    }

    fn ensure_supervisor_started(
        supervisor: &'static HostCleanupSupervisor,
        #[cfg(test)] fault: Option<TestFault>,
    ) -> Result<(), String> {
        #[cfg(test)]
        if fault == Some(TestFault::SupervisorStart) {
            return Err("simulated cleanup supervisor startup failure".to_string());
        }

        let mut worker = lock_unpoisoned(&supervisor.worker);
        if worker.as_ref().is_some_and(|handle| !handle.is_finished()) {
            return await_supervisor_ready(supervisor);
        }
        if let Some(finished) = worker.take() {
            supervisor.worker_ready.store(false, Ordering::Release);
            let _ = finished.join();
        }
        supervisor.worker_ready.store(false, Ordering::Release);
        let handle = thread::Builder::new()
            .name("process-tree-cleanup-supervisor".to_string())
            .spawn(move || supervisor_worker_loop(supervisor))
            .map_err(|error| format!("start cleanup supervisor: {error}"))?;
        *worker = Some(handle);
        await_supervisor_ready(supervisor)
    }

    impl Drop for CleanupReservation {
        fn drop(&mut self) {
            let slot = &self.supervisor.slots[self.slot];
            let state = slot.state.load(Ordering::Acquire);
            if state == SLOT_RESERVED || state == SLOT_PROCESSING {
                slot.state.store(SLOT_FREE, Ordering::Release);
                self.supervisor.wake.notify_all();
            }
        }
    }

    fn enqueue_reserved_cleanup(state: OwnedCleanupState) {
        if state.resolved {
            drop(state);
            return;
        }
        let Some(resources) = state.resources.as_ref() else {
            return;
        };
        let index = resources.reservation.slot;
        let supervisor = resources.reservation.supervisor;
        let slot = &supervisor.slots[index];
        // SAFETY: this state owns the slot's reservation. No worker can read the
        // payload until READY is published below.
        unsafe {
            (*slot.payload.get()).write(state);
        }
        slot.state.store(SLOT_READY, Ordering::Release);
        supervisor.wake.notify_one();
    }

    fn take_ready_cleanup(
        supervisor: &'static HostCleanupSupervisor,
        start: usize,
    ) -> Option<(usize, OwnedCleanupState)> {
        for offset in 0..MAX_SUPERVISED_CLEANUPS {
            let index = (start + offset) % MAX_SUPERVISED_CLEANUPS;
            let slot = &supervisor.slots[index];
            if slot
                .state
                .compare_exchange(
                    SLOT_READY,
                    SLOT_PROCESSING,
                    Ordering::AcqRel,
                    Ordering::Acquire,
                )
                .is_ok()
            {
                // SAFETY: the successful READY -> PROCESSING transition grants
                // this worker exclusive access to the initialized payload.
                let state = unsafe { (*slot.payload.get()).assume_init_read() };
                return Some((index, state));
            }
        }
        None
    }

    fn has_ready_cleanup(supervisor: &'static HostCleanupSupervisor) -> bool {
        supervisor
            .slots
            .iter()
            .any(|slot| slot.state.load(Ordering::Acquire) == SLOT_READY)
    }

    fn wait_for_ready_cleanup(supervisor: &'static HostCleanupSupervisor) {
        if has_ready_cleanup(supervisor) {
            return;
        }
        let guard = lock_unpoisoned(&supervisor.wake_lock);
        if has_ready_cleanup(supervisor) {
            drop(guard);
            return;
        }
        match supervisor.wake.wait_timeout(guard, SUPERVISOR_SLICE) {
            Ok((guard, _)) => drop(guard),
            Err(poisoned) => drop(poisoned.into_inner().0),
        }
    }

    fn supervisor_worker_loop(supervisor: &'static HostCleanupSupervisor) {
        supervisor.worker_ready.store(true, Ordering::Release);
        supervisor.wake.notify_all();
        let mut cursor = 0;
        loop {
            let Some((index, mut candidate)) = take_ready_cleanup(supervisor, cursor) else {
                wait_for_ready_cleanup(supervisor);
                continue;
            };
            cursor = (index + 1) % MAX_SUPERVISED_CLEANUPS;
            let poll_started = Instant::now();
            let resolved = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                candidate.poll_supervisor_slice()
            }))
            .unwrap_or(false);
            if resolved {
                drop(candidate);
            } else {
                enqueue_reserved_cleanup(candidate);
                let remaining = SUPERVISOR_SLICE.saturating_sub(poll_started.elapsed());
                if !remaining.is_zero() {
                    thread::sleep(remaining);
                }
            }
        }
    }

    /// Transfers a dropped ticket into its already-reserved slot. This path
    /// performs no capacity wait, cleanup poll, thread creation, or blocking
    /// drain; the worker retains the job, process, and reader handles until
    /// their cleanup proof succeeds.
    pub(crate) fn supervise_dropped_cleanup(state: OwnedCleanupState) {
        enqueue_reserved_cleanup(state);
    }

    fn interrupted(
        cancellation: &CancellationToken,
        deadline: Instant,
        leader_exit: Option<u32>,
    ) -> Option<FailureCause> {
        if cancellation.is_cancelled() {
            return Some(FailureCause::with_exit_code(
                ProcessErrorKind::Cancelled,
                "request cancellation was observed",
                leader_exit,
            ));
        }
        if Instant::now() >= deadline {
            return Some(FailureCause::with_exit_code(
                ProcessErrorKind::DeadlineExceeded,
                "the total process-tree deadline expired",
                leader_exit,
            ));
        }
        None
    }

    fn supervise(
        child: &mut ChildGuard,
        readers: &mut ReaderSet,
        cancellation: &CancellationToken,
        deadline: Instant,
    ) -> Result<u32, FailureCause> {
        let mut leader_exit = None;
        loop {
            if let Some(failure) = interrupted(cancellation, deadline, leader_exit) {
                return Err(failure);
            }
            readers.poll().map_err(|error| {
                FailureCause::with_exit_code(ProcessErrorKind::ReadFailure, error, leader_exit)
            })?;
            if readers.overflowed() {
                return Err(FailureCause::with_exit_code(
                    ProcessErrorKind::OutputLimitExceeded,
                    "stdout or stderr exceeded its retained-log limit",
                    leader_exit,
                ));
            }

            match unsafe { WaitForSingleObject(child.process.raw(), wait_slice(deadline)) } {
                WAIT_OBJECT_0 => {
                    child.reaped = true;
                    if leader_exit.is_none() {
                        leader_exit = Some(child.exit_code().map_err(|error| {
                            FailureCause::new(ProcessErrorKind::WaitFailure, error)
                        })?);
                    }
                }
                WAIT_TIMEOUT => {}
                _ => {
                    return Err(FailureCause::with_exit_code(
                        ProcessErrorKind::WaitFailure,
                        last_error("WaitForSingleObject(process)"),
                        leader_exit,
                    ));
                }
            }

            if let Some(failure) = interrupted(cancellation, deadline, leader_exit) {
                return Err(failure);
            }
            readers.poll().map_err(|error| {
                FailureCause::with_exit_code(ProcessErrorKind::ReadFailure, error, leader_exit)
            })?;
            if readers.overflowed() {
                return Err(FailureCause::with_exit_code(
                    ProcessErrorKind::OutputLimitExceeded,
                    "stdout or stderr exceeded its retained-log limit",
                    leader_exit,
                ));
            }

            let active = child.active_processes().map_err(|error| {
                FailureCause::with_exit_code(ProcessErrorKind::JobQueryFailure, error, leader_exit)
            })?;
            if let Some(exit_code) = leader_exit {
                if active == 0 {
                    if let Some(failure) = interrupted(cancellation, deadline, leader_exit) {
                        return Err(failure);
                    }
                    readers.poll().map_err(|error| {
                        FailureCause::with_exit_code(
                            ProcessErrorKind::ReadFailure,
                            error,
                            leader_exit,
                        )
                    })?;
                    if readers.overflowed() {
                        return Err(FailureCause::with_exit_code(
                            ProcessErrorKind::OutputLimitExceeded,
                            "stdout or stderr exceeded its retained-log limit",
                            leader_exit,
                        ));
                    }
                    child.drained = true;
                    return Ok(exit_code);
                }
                // A signaled leader does not settle the run while descendants
                // remain in the job. Keep cancellation and the total deadline live.
                sleep_until_poll(deadline);
            }
        }
    }

    /// Creates one interactive child through the existing suspended process,
    /// job assignment, explicit stdio allowlist and reserved cleanup-slot path.
    pub(crate) fn start_interactive(
        spec: &ProcessSpec,
        cancellation: &CancellationToken,
    ) -> Result<OwnedCleanupState, ProcessError> {
        #[cfg(test)]
        let _slot_read_guard = test_hooks::test_capacity_read_lock();

        let started = Instant::now();
        if cancellation.is_cancelled() {
            return Err(ProcessError::simple(
                ProcessErrorKind::Cancelled,
                "interactive request was cancelled before spawn",
            ));
        }
        validate_limits(spec)?;
        let deadline = started.checked_add(spec.timeout).ok_or_else(|| {
            ProcessError::simple(
                ProcessErrorKind::InvalidTimeout,
                "interactive deadline cannot be represented by the platform clock",
            )
        })?;
        if Instant::now() >= deadline {
            return Err(ProcessError::simple(
                ProcessErrorKind::DeadlineExceeded,
                "interactive deadline expired before spawn",
            ));
        }

        let setup = catch_unwind(AssertUnwindSafe(|| {
            let paths = verify_paths(spec).map_err(simple_failure)?;
            let mut command_line =
                command_line(&paths.executable, &spec.arguments).map_err(simple_failure)?;
            let mut environment = if spec.environment.is_empty() {
                None
            } else {
                Some(environment_block(&spec.environment).map_err(simple_failure)?)
            };
            let pipes = Pipes::new().map_err(simple_failure)?;
            let job = create_kill_on_close_job().map_err(simple_failure)?;
            if let Some(failure) = interrupted(cancellation, deadline, None) {
                return Err(simple_failure(failure));
            }
            let readers = ReaderSet::new();
            #[cfg(test)]
            let reservation = reserve_cleanup_slot(None)?;
            #[cfg(not(test))]
            let reservation = reserve_cleanup_slot()?;
            create_suspended(
                &paths,
                &mut command_line,
                environment.as_deref_mut(),
                OwnedSpawnResources {
                    pipes,
                    readers,
                    job,
                    reservation,
                },
                #[cfg(test)]
                StartupVariant::Production,
            )
            .map_err(simple_failure)
        }));

        let mut state = match setup {
            Ok(Ok(state)) => state,
            Ok(Err(error)) => return Err(error),
            Err(_) => {
                return Err(ProcessError::simple(
                    ProcessErrorKind::Internal,
                    "interactive setup panicked before child creation",
                ))
            }
        };

        let post_spawn = catch_unwind(AssertUnwindSafe(|| {
            state
                .pipes_mut()
                .close_parent_copies_for_session()
                .map_err(|error| FailureCause::new(ProcessErrorKind::Spawn, error))?;
            state
                .child_mut()
                .assign_to_job()
                .map_err(|error| FailureCause::new(ProcessErrorKind::AssignToJob, error))?;
            let (stdout, stderr) = state.pipes_mut().take_output_readers();
            state
                .readers_mut()
                .start_session(stdout, stderr, spec.max_log_bytes_per_stream)?;
            if let Some(failure) = interrupted(cancellation, deadline, None) {
                return Err(failure);
            }
            state
                .child_mut()
                .resume()
                .map_err(|error| FailureCause::new(ProcessErrorKind::Resume, error))?;
            state
                .child_mut()
                .close_thread_handle()
                .map_err(|error| FailureCause::new(ProcessErrorKind::CleanupFailed, error))?;
            Ok::<(), FailureCause>(())
        }));

        let cause = match post_spawn {
            Ok(Ok(())) => return Ok(state),
            Ok(Err(cause)) => cause,
            Err(_) => FailureCause::new(
                ProcessErrorKind::Internal,
                "interactive setup panicked after child creation",
            ),
        };
        Err(resolve_interactive_start_failure(state, cause))
    }

    fn resolve_interactive_start_failure(
        mut state: OwnedCleanupState,
        cause: FailureCause,
    ) -> ProcessError {
        let logs = state.snapshot_logs();
        match catch_unwind(AssertUnwindSafe(|| {
            state.try_resolve(None, CLEANUP_TIMEOUT)
        })) {
            Ok(Ok(logs)) => process_error(cause, logs, None, None, CleanupProof::JobDrained, None),
            Ok(Err(cleanup_error)) => process_error(
                cause,
                logs,
                None,
                Some(cleanup_error),
                CleanupProof::Failed,
                Some(PendingCleanup {
                    inner: Some(Box::new(state)),
                }),
            ),
            Err(_) => process_error(
                FailureCause::new(
                    ProcessErrorKind::Internal,
                    "interactive cleanup panicked after child creation",
                ),
                logs,
                None,
                Some("interactive cleanup capability retained after panic".to_owned()),
                CleanupProof::Failed,
                Some(PendingCleanup {
                    inner: Some(Box::new(state)),
                }),
            ),
        }
    }

    pub(crate) fn exchange_interactive(
        state: &mut OwnedCleanupState,
        input: &[u8],
        marker: &[u8],
        cancellation: &CancellationToken,
        timeout: Duration,
    ) -> Result<SessionReply, SessionError> {
        if state.resolved {
            return Err(SessionError::new(
                SessionErrorKind::SessionClosed,
                "interactive process session is drained",
            ));
        }
        if input.len() > PROCESS_SESSION_MAX_INPUT_BYTES || marker.is_empty() || timeout.is_zero() {
            return Err(SessionError::new(
                SessionErrorKind::InvalidRequest,
                "interactive input, response marker, or timeout is invalid",
            ));
        }
        if cancellation.is_cancelled() {
            return Err(SessionError::new(
                SessionErrorKind::Cancelled,
                "interactive request was cancelled",
            ));
        }
        let deadline = Instant::now().checked_add(timeout).ok_or_else(|| {
            SessionError::new(
                SessionErrorKind::InvalidRequest,
                "interactive response deadline overflow",
            )
        })?;
        let input_pipe = if input.is_empty() {
            None
        } else {
            Some(
                state
                    .pipes_mut()
                    .duplicate_session_stdin()
                    .map_err(|error| SessionError::new(SessionErrorKind::WriteFailure, error))?,
            )
        };
        state
            .readers_mut()
            .start_session_write(input_pipe, input.to_vec(), cancellation, deadline)
            .map_err(|error| SessionError::new(SessionErrorKind::WriteFailure, error))?;
        state
            .readers_mut()
            .read_session_until(marker, cancellation, deadline)
    }

    #[cfg(test)]
    pub(super) fn run(
        spec: &ProcessSpec,
        cancellation: &CancellationToken,
    ) -> Result<ProcessOutput, ProcessError> {
        run_inner(spec, cancellation, None, StartupVariant::Production)
    }

    #[cfg(not(test))]
    pub(super) fn run(
        spec: &ProcessSpec,
        cancellation: &CancellationToken,
    ) -> Result<ProcessOutput, ProcessError> {
        run_inner(spec, cancellation)
    }

    fn run_inner(
        spec: &ProcessSpec,
        cancellation: &CancellationToken,
        #[cfg(test)] fault: Option<TestFault>,
        #[cfg(test)] startup_variant: StartupVariant,
    ) -> Result<ProcessOutput, ProcessError> {
        #[cfg(test)]
        let _slot_read_guard = test_hooks::test_capacity_read_lock();
        let started = Instant::now();
        if cancellation.is_cancelled() {
            return Err(ProcessError::simple(
                ProcessErrorKind::Cancelled,
                "request was cancelled before spawn",
            ));
        }
        validate_limits(spec)?;
        let deadline = started.checked_add(spec.timeout).ok_or_else(|| {
            ProcessError::simple(
                ProcessErrorKind::InvalidTimeout,
                "timeout cannot be represented by the platform clock",
            )
        })?;
        if Instant::now() >= deadline {
            return Err(ProcessError::simple(
                ProcessErrorKind::DeadlineExceeded,
                "deadline expired before spawn",
            ));
        }

        // All setup before a child is returned is guarded as a no-child
        // operation. Once CreateProcessW succeeds, create_suspended immediately
        // transfers the process and its resources into OwnedCleanupState.
        let spawn_result = catch_unwind(AssertUnwindSafe(|| {
            let paths = verify_paths(spec).map_err(simple_failure)?;
            let mut command_line =
                command_line(&paths.executable, &spec.arguments).map_err(simple_failure)?;
            let mut env_block = if spec.environment.is_empty() {
                None
            } else {
                Some(environment_block(&spec.environment).map_err(simple_failure)?)
            };
            let pipes = Pipes::new().map_err(simple_failure)?;
            let job = create_kill_on_close_job().map_err(simple_failure)?;

            if let Some(failure) = interrupted(cancellation, deadline, None) {
                return Err(simple_failure(failure));
            }

            let readers = ReaderSet::new();
            #[cfg(test)]
            let reservation = reserve_cleanup_slot(fault)?;
            #[cfg(not(test))]
            let reservation = reserve_cleanup_slot()?;
            let state = create_suspended(
                &paths,
                &mut command_line,
                env_block.as_deref_mut(),
                OwnedSpawnResources {
                    pipes,
                    readers,
                    job,
                    reservation,
                },
                #[cfg(test)]
                startup_variant,
            )
            .map_err(simple_failure)?;
            Ok::<OwnedCleanupState, ProcessError>(state)
        }));
        let state = match spawn_result {
            Ok(Ok(state)) => state,
            Ok(Err(error)) => return Err(error),
            Err(_) => {
                return Err(ProcessError::simple(
                    ProcessErrorKind::Internal,
                    "process setup panicked before child creation",
                ))
            }
        };

        // Unwinding now drops a state that already owns the spawned child and
        // transfers it to its reserved cleanup slot.
        #[cfg(test)]
        if fault == Some(TestFault::PostSpawnPanic) {
            panic!("test-only panic after spawned resources are owned");
        }

        let child_pid = state.pid();
        enum PostSpawnOutcome {
            Complete(Result<ProcessOutput, ProcessError>),
            CleanupPending {
                cause: FailureCause,
                logs: ProcessLogs,
                exit_code: Option<u32>,
                cleanup_error: String,
            },
        }

        // Keep the cleanup owner outside the unwind boundary. A panic after
        // CreateProcessW must return an owned PendingCleanup ticket, not transfer
        // the process to the background reaper while the compile lease is lost.
        let mut owned_state = Some(state);
        let mut exit_code = None;
        let outcome = catch_unwind(AssertUnwindSafe(|| {
            let state = owned_state.as_mut().expect("post-spawn cleanup owner");
            let mut failure = None;
            if let Err(error) = state.pipes_mut().close_parent_copies() {
                failure = Some(FailureCause::new(ProcessErrorKind::Spawn, error));
            }
            if failure.is_none() {
                if let Err(error) = state.child_mut().assign_to_job() {
                    failure = Some(FailureCause::new(ProcessErrorKind::AssignToJob, error));
                }
            }
            if failure.is_none() {
                let (stdout, stderr) = state.pipes_mut().take_output_readers();
                if let Err(error) =
                    state
                        .readers_mut()
                        .start(stdout, stderr, spec.max_log_bytes_per_stream)
                {
                    failure = Some(error);
                }
            }
            if failure.is_none() {
                if let Some(interruption) = interrupted(cancellation, deadline, None) {
                    failure = Some(interruption);
                }
            }
            if failure.is_none() {
                if let Err(error) = state.child_mut().resume() {
                    failure = Some(FailureCause::new(ProcessErrorKind::Resume, error));
                }
            }
            if failure.is_none() {
                if let Err(error) = state.child_mut().close_thread_handle() {
                    failure = Some(FailureCause::new(ProcessErrorKind::CleanupFailed, error));
                }
            }

            if failure.is_none() {
                match state.supervise(cancellation, deadline) {
                    Ok(code) => exit_code = Some(code),
                    Err(error) => failure = Some(error),
                }
            }

            let logs = match state.try_resolve(None, CLEANUP_TIMEOUT) {
                Ok(logs) => logs,
                Err(cleanup_error) => {
                    let logs = state.snapshot_logs();
                    let cause = failure.take().unwrap_or_else(|| {
                        FailureCause::with_exit_code(
							ProcessErrorKind::CleanupFailed,
							"process tree, pipes, or output readers did not drain within cleanup window",
							exit_code,
						)
                    });
                    return PostSpawnOutcome::CleanupPending {
                        cause,
                        logs,
                        exit_code,
                        cleanup_error,
                    };
                }
            };
            let reader_error = state.reader_error();

            if failure.is_none() {
                if let Some(error) = reader_error {
                    failure = Some(FailureCause::new(ProcessErrorKind::ReadFailure, error));
                } else if logs.stdout_truncated || logs.stderr_truncated {
                    failure = Some(FailureCause::new(
                        ProcessErrorKind::OutputLimitExceeded,
                        "stdout or stderr exceeded its retained-log limit",
                    ));
                } else if let Some(interruption) = interrupted(cancellation, deadline, exit_code) {
                    failure = Some(interruption);
                } else {
                    match exit_code {
                        Some(0) => {}
                        Some(code) => {
                            failure = Some(FailureCause::with_exit_code(
                                ProcessErrorKind::NonZeroExit,
                                format!("child exited with code {code}"),
                                Some(code),
                            ));
                        }
                        None => {
                            failure = Some(FailureCause::new(
                                ProcessErrorKind::Internal,
                                "process tree settled without a leader exit code",
                            ));
                        }
                    }
                }
            }

            if let Some(cause) = failure {
                PostSpawnOutcome::Complete(Err(process_error(
                    cause,
                    logs,
                    exit_code,
                    None,
                    CleanupProof::JobDrained,
                    None,
                )))
            } else {
                PostSpawnOutcome::Complete(Ok(ProcessOutput {
                    pid: child_pid,
                    exit_code: 0,
                    logs,
                    active_processes_after_exit: 0,
                }))
            }
        }));

        match outcome {
            Ok(PostSpawnOutcome::Complete(result)) => {
                drop(owned_state.take());
                result
            }
            Ok(PostSpawnOutcome::CleanupPending {
                cause,
                logs,
                exit_code,
                cleanup_error,
            }) => {
                let state = owned_state.take().expect("post-spawn cleanup owner");
                let pending = PendingCleanup {
                    inner: Some(Box::new(state)),
                };
                Err(process_error(
                    cause,
                    logs,
                    exit_code,
                    Some(cleanup_error),
                    CleanupProof::Failed,
                    Some(pending),
                ))
            }
            Err(_) => {
                let state = owned_state.take().expect("post-spawn cleanup owner");
                let logs = state.snapshot_logs();
                let pending = PendingCleanup {
                    inner: Some(Box::new(state)),
                };
                Err(process_error(
                    FailureCause::with_exit_code(
                        ProcessErrorKind::Internal,
                        "native process runner panicked after child creation",
                        exit_code,
                    ),
                    logs,
                    exit_code,
                    Some("post-spawn unwind; cleanup capability retained".to_owned()),
                    CleanupProof::Failed,
                    Some(pending),
                ))
            }
        }
    }

    #[cfg(test)]
    pub(crate) mod test_hooks {
        include!("../../tests/unit/process_tree_test_hooks.rs");
    }
}

#[cfg(test)]
#[path = "../../tests/unit/process_tree.rs"]
mod tests;
