// SPDX-License-Identifier: Apache-2.0
//! Production ConPTY terminal session runtime service.
//!
//! Preserves the DesktopPort terminal capability contract (`availability`,
//! `spawn`, `input`, `resize`, `kill`, and owner-bound `data`/`exit` events)
//! while enforcing host-trusted shell executables and working directories,
//! fixed bounded input/output queues, UTF-8 codepoint boundary preservation,
//! explicit output backpressure/resync failure, and finite non-blocking
//! cleanup of child processes, writers, masters, and reader threads. A
//! pre-admitted bounded reaper retains resources when synchronous cleanup
//! cannot prove they are drained.
//!
//! `JobPtySystem` assigns each process atomically to a kill-on-close Windows
//! Job Object. Child completion and teardown account for every process in it.
//!

use std::{
    collections::{HashMap, VecDeque},
    error::Error,
    ffi::{OsStr, OsString},
    fmt, fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc, Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::schemas::protocol::{OwnerId, ProtocolError, WorkspaceId};

#[cfg(all(windows, target_arch = "x86_64"))]
use crate::platform::win_conpty;

/// Maximum UTF-16 length for a validated path or shell argument on Windows.
pub const MAX_PATH_UTF16: usize = 32_767;
/// Minimum terminal dimension in columns or rows.
pub const MIN_TERMINAL_DIMENSION: u16 = 1;
/// Maximum terminal dimension in columns or rows.
pub const MAX_TERMINAL_DIMENSION: u16 = 500;
/// Default bounded input queue chunk capacity per session.
pub const DEFAULT_MAX_INPUT_CHUNKS: usize = 64;
/// Default maximum bytes allowed in a single input write call.
pub const DEFAULT_MAX_INPUT_CHUNK_BYTES: usize = 16 * 1024;
/// Default maximum total queued input bytes per session.
pub const DEFAULT_MAX_INPUT_QUEUE_BYTES: usize = 256 * 1024;
/// Default bounded output queue chunk capacity per session.
pub const DEFAULT_MAX_OUTPUT_CHUNKS: usize = 128;
/// Default maximum queued output bytes before explicit backpressure/resync failure.
pub const DEFAULT_MAX_OUTPUT_QUEUE_BYTES: usize = 1024 * 1024;
/// Hard upper ceiling for configurable output queue bytes (8 MiB).
pub const MAX_OUTPUT_QUEUE_BYTES_LIMIT: usize = 8 * 1024 * 1024;

const ERROR_ACCESS_DENIED_WIN32: i32 = 5;

/// Monotonic, idempotent cancellation handle paired with a [`CancellationToken`].
#[derive(Clone, Debug)]
pub struct CancellationHandle(Arc<AtomicBool>);

/// Read-only cancellation token observed by a running terminal session.
#[derive(Clone, Debug)]
pub struct CancellationToken(Arc<AtomicBool>);

/// Creates a fresh monotonic cancellation pair.
pub fn cancellation_pair() -> (CancellationHandle, CancellationToken) {
    let flag = Arc::new(AtomicBool::new(false));
    (
        CancellationHandle(Arc::clone(&flag)),
        CancellationToken(flag),
    )
}

impl CancellationHandle {
    pub fn cancel(&self) {
        self.0.store(true, Ordering::Release);
    }
}

impl CancellationToken {
    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::Acquire)
    }
}

/// Validated terminal session identifier (canonical lowercase UUID v4).
#[derive(Clone, Debug, Eq, PartialEq, Hash, Serialize)]
#[serde(transparent)]
pub struct TerminalSessionId(String);

impl TerminalSessionId {
    pub fn generate() -> Self {
        Self(Uuid::new_v4().to_string())
    }

    pub fn parse(value: &str) -> Result<Self, ProtocolError> {
        let parsed = Uuid::parse_str(value)
            .map_err(|_| ProtocolError::new("sessionId", "invalid session identifier"))?;
        if parsed.get_version_num() != 4 || value != parsed.to_string() {
            return Err(ProtocolError::new(
                "sessionId",
                "invalid session identifier",
            ));
        }
        Ok(Self(value.to_owned()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl<'de> Deserialize<'de> for TerminalSessionId {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = String::deserialize(deserializer)?;
        Self::parse(&value).map_err(serde::de::Error::custom)
    }
}

impl fmt::Display for TerminalSessionId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// Validated terminal grid dimensions in columns and rows.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TerminalSize {
    pub cols: u16,
    pub rows: u16,
}

impl TerminalSize {
    pub fn new(cols: u16, rows: u16) -> Result<Self, TerminalError> {
        if !(MIN_TERMINAL_DIMENSION..=MAX_TERMINAL_DIMENSION).contains(&cols)
            || !(MIN_TERMINAL_DIMENSION..=MAX_TERMINAL_DIMENSION).contains(&rows)
        {
            return Err(TerminalError::simple(
                TerminalErrorKind::InvalidDimensions,
                format!(
                    "terminal dimensions {cols}x{rows} must be within {MIN_TERMINAL_DIMENSION}..={MAX_TERMINAL_DIMENSION}"
                ),
            ));
        }
        Ok(Self { cols, rows })
    }
}

/// Bounded queue limits for a terminal session.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TerminalQueueLimits {
    pub max_input_chunks: usize,
    pub max_input_chunk_bytes: usize,
    pub max_input_queue_bytes: usize,
    pub max_output_chunks: usize,
    pub max_output_queue_bytes: usize,
}

impl Default for TerminalQueueLimits {
    fn default() -> Self {
        Self {
            max_input_chunks: DEFAULT_MAX_INPUT_CHUNKS,
            max_input_chunk_bytes: DEFAULT_MAX_INPUT_CHUNK_BYTES,
            max_input_queue_bytes: DEFAULT_MAX_INPUT_QUEUE_BYTES,
            max_output_chunks: DEFAULT_MAX_OUTPUT_CHUNKS,
            max_output_queue_bytes: DEFAULT_MAX_OUTPUT_QUEUE_BYTES,
        }
    }
}

impl TerminalQueueLimits {
    pub fn validate(&self) -> Result<(), TerminalError> {
        if self.max_input_chunks == 0
            || self.max_input_chunk_bytes == 0
            || self.max_input_queue_bytes == 0
            || self.max_input_chunk_bytes > self.max_input_queue_bytes
            || self.max_output_chunks == 0
            || self.max_output_queue_bytes == 0
            || self.max_output_queue_bytes > MAX_OUTPUT_QUEUE_BYTES_LIMIT
        {
            return Err(TerminalError::simple(
                TerminalErrorKind::InvalidQueueLimits,
                "terminal input/output queue limits must be nonzero and within bounds",
            ));
        }
        Ok(())
    }
}

/// Trusted host-constructed shell configuration. Never deserialize this type
/// from renderer IPC payloads.
#[derive(Clone, Debug)]
pub struct TrustedShellConfig {
    executable: PathBuf,
    arguments: Vec<OsString>,
}

impl TrustedShellConfig {
    pub fn new(executable: PathBuf, arguments: Vec<OsString>) -> Self {
        Self {
            executable,
            arguments,
        }
    }

    /// Resolves the default trusted Windows command processor (`%SystemRoot%\System32\cmd.exe`
    /// with `/D /Q` to disable Autorun and echo).
    pub fn default_windows_shell() -> Self {
        let system_root =
            std::env::var_os("SystemRoot").unwrap_or_else(|| OsString::from(r"C:\Windows"));
        let executable = PathBuf::from(system_root).join("System32").join("cmd.exe");
        Self {
            executable,
            arguments: vec![OsString::from("/D"), OsString::from("/Q")],
        }
    }

    pub fn executable(&self) -> &Path {
        &self.executable
    }

    pub fn arguments(&self) -> &[OsString] {
        &self.arguments
    }
}

/// Trusted host-constructed spawn specification. Renderer callers may only request
/// a session for their bound workspace and initial grid size; the host supplies
/// the verified workspace root path and trusted shell executable.
#[derive(Clone, Debug)]
pub struct TerminalSpawnSpec {
    pub owner: OwnerId,
    pub workspace_id: WorkspaceId,
    pub working_directory: PathBuf,
    pub shell: TrustedShellConfig,
    pub initial_size: TerminalSize,
    pub limits: TerminalQueueLimits,
}

impl TerminalSpawnSpec {
    pub fn new(
        owner: OwnerId,
        workspace_id: WorkspaceId,
        working_directory: PathBuf,
        shell: TrustedShellConfig,
        initial_size: TerminalSize,
    ) -> Self {
        Self {
            owner,
            workspace_id,
            working_directory,
            shell,
            initial_size,
            limits: TerminalQueueLimits::default(),
        }
    }

    pub fn with_limits(mut self, limits: TerminalQueueLimits) -> Self {
        self.limits = limits;
        self
    }
}

/// Error categories returned by the terminal service.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum TerminalErrorKind {
    UnsupportedPlatform,
    InvalidShellExecutable,
    InvalidWorkingDirectory,
    InvalidShellArgument,
    InvalidDimensions,
    InvalidQueueLimits,
    InvalidInputPayload,
    OwnerRevoked,
    OwnerMismatch,
    SessionNotFound,
    SessionClosed,
    Cancelled,
    InputBackpressure,
    OutputBackpressure,
    SpawnFailed,
    WriteFailed,
    ResizeFailed,
    CleanupFailed,
    Internal,
}

impl fmt::Display for TerminalErrorKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let text = match self {
            Self::UnsupportedPlatform => "unsupported platform",
            Self::InvalidShellExecutable => "invalid shell executable",
            Self::InvalidWorkingDirectory => "invalid working directory",
            Self::InvalidShellArgument => "invalid shell argument",
            Self::InvalidDimensions => "invalid terminal dimensions",
            Self::InvalidQueueLimits => "invalid terminal queue limits",
            Self::InvalidInputPayload => "invalid terminal input payload",
            Self::OwnerRevoked => "owner access has been revoked",
            Self::OwnerMismatch => "session belongs to a different owner",
            Self::SessionNotFound => "terminal session not found",
            Self::SessionClosed => "terminal session is already closed",
            Self::Cancelled => "terminal session was cancelled",
            Self::InputBackpressure => "terminal input queue is full",
            Self::OutputBackpressure => "terminal output exceeded bounded queue (resync required)",
            Self::SpawnFailed => "failed to spawn ConPTY session",
            Self::WriteFailed => "failed to write to ConPTY session",
            Self::ResizeFailed => "failed to resize ConPTY session",
            Self::CleanupFailed => "failed to verify finite ConPTY cleanup",
            Self::Internal => "internal terminal service error",
        };
        f.write_str(text)
    }
}

/// Proof of finite terminal session resource cleanup.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum TerminalCleanupProof {
    NotRequired,
    SessionDrained,
    Deferred,
    Failed,
}

/// Detailed teardown report for a closed or killed terminal session.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalTeardownReport {
    pub session_id: TerminalSessionId,
    pub child_reaped: bool,
    pub exit_code: Option<u32>,
    pub graceful_exit: bool,
    pub forced_kill: bool,
    pub writer_closed: bool,
    pub master_dropped: bool,
    pub reader_joined: bool,
    pub supervisor_joined: bool,
    pub cancel_io_used: bool,
    pub channel_drained: bool,
    pub cleanup: TerminalCleanupProof,
}

/// Structured error returned by terminal operations.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TerminalError {
    pub kind: TerminalErrorKind,
    pub detail: String,
    pub cleanup: TerminalCleanupProof,
}

impl TerminalError {
    pub fn simple(kind: TerminalErrorKind, detail: impl Into<String>) -> Self {
        Self {
            kind,
            detail: detail.into(),
            cleanup: TerminalCleanupProof::NotRequired,
        }
    }

    pub fn with_cleanup(
        kind: TerminalErrorKind,
        detail: impl Into<String>,
        cleanup: TerminalCleanupProof,
    ) -> Self {
        Self {
            kind,
            detail: detail.into(),
            cleanup,
        }
    }
}

impl fmt::Display for TerminalError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.kind, self.detail)
    }
}

impl Error for TerminalError {}

/// Availability response for the terminal capability.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalAvailability {
    pub available: bool,
    pub reason: Option<TerminalErrorKind>,
    pub detail: Option<String>,
}

/// Snapshot metadata returned when a terminal session is spawned.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSessionInfo {
    pub session_id: TerminalSessionId,
    pub workspace_id: WorkspaceId,
    pub generation: u64,
    pub pid: u32,
    pub size: TerminalSize,
}

/// Reason a terminal session exited or was terminated.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum TerminalExitReason {
    GracefulExit,
    KilledByOwner,
    OwnerRevoked,
    WorkspaceClosed,
    Cancelled,
    OutputBackpressure,
    ReaderFailure,
}

/// Event payload variants emitted by a terminal session.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum TerminalEventPayload {
    Data {
        /// UTF-8 codepoint boundary-aligned bytes (or final flushed tail at EOF).
        bytes: Vec<u8>,
        /// Decoded UTF-8 text preserving split multi-byte sequences across reads.
        text: String,
    },
    Exit {
        #[serde(rename = "exitCode")]
        exit_code: Option<u32>,
        reason: TerminalExitReason,
    },
}

/// Owner-bound terminal event with generation and monotonic per-session sequence.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TerminalEvent {
    pub owner: OwnerId,
    pub workspace_id: WorkspaceId,
    pub session_id: TerminalSessionId,
    pub generation: u64,
    pub sequence: u64,
    pub payload: TerminalEventPayload,
}

/// Failure reported by a [`TerminalEventSink`] when an event cannot be queued.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TerminalSinkError {
    Backpressure,
    Disconnected,
}

/// Host adapter seam for routing owner-bound terminal events to the target window.
pub trait TerminalEventSink: Send + Sync + 'static {
    fn emit(&self, event: TerminalEvent) -> Result<(), TerminalSinkError>;
}

/// Real bounded in-memory event sink that enforces per-owner byte and event caps
/// and supports host polling or test inspection without unbounded growth.
pub struct BoundedEventSink {
    max_events: usize,
    max_data_bytes: usize,
    state: Mutex<BoundedSinkState>,
}

struct BoundedSinkState {
    events: VecDeque<TerminalEvent>,
    queued_data_bytes: usize,
    closed: bool,
}

impl BoundedEventSink {
    pub fn new(max_events: usize, max_data_bytes: usize) -> Self {
        Self {
            max_events: max_events.max(1),
            max_data_bytes: max_data_bytes.max(1),
            state: Mutex::new(BoundedSinkState {
                events: VecDeque::new(),
                queued_data_bytes: 0,
                closed: false,
            }),
        }
    }

    pub fn drain_for_owner(&self, owner: &OwnerId) -> Vec<TerminalEvent> {
        let Ok(mut guard) = self.state.lock() else {
            return Vec::new();
        };
        let mut matched = Vec::new();
        let mut retained = VecDeque::with_capacity(guard.events.len());
        while let Some(event) = guard.events.pop_front() {
            if &event.owner == owner {
                if let TerminalEventPayload::Data { bytes, .. } = &event.payload {
                    guard.queued_data_bytes = guard.queued_data_bytes.saturating_sub(bytes.len());
                }
                matched.push(event);
            } else {
                retained.push_back(event);
            }
        }
        guard.events = retained;
        matched
    }

    pub fn drop_for_owner(&self, owner: &OwnerId) {
        let _ = self.drain_for_owner(owner);
    }
}

impl TerminalEventSink for BoundedEventSink {
    fn emit(&self, event: TerminalEvent) -> Result<(), TerminalSinkError> {
        let Ok(mut guard) = self.state.lock() else {
            return Err(TerminalSinkError::Disconnected);
        };
        if guard.closed {
            return Err(TerminalSinkError::Disconnected);
        }
        let added_bytes = match &event.payload {
            TerminalEventPayload::Data { bytes, .. } => bytes.len(),
            TerminalEventPayload::Exit { .. } => 0,
        };
        // Always allow a terminal Exit event through if only byte budget is full,
        // but reject Data events when either event count or byte cap would overflow.
        if matches!(event.payload, TerminalEventPayload::Data { .. })
            && (guard.events.len() >= self.max_events
                || guard.queued_data_bytes.saturating_add(added_bytes) > self.max_data_bytes)
        {
            return Err(TerminalSinkError::Backpressure);
        }
        guard.queued_data_bytes = guard.queued_data_bytes.saturating_add(added_bytes);
        guard.events.push_back(event);
        Ok(())
    }
}

/// Fixed-capacity FIFO byte queue enforcing both chunk-count and total-byte bounds.
#[derive(Debug)]
pub struct BoundedByteQueue {
    chunks: VecDeque<Vec<u8>>,
    queued_bytes: usize,
    max_chunks: usize,
    max_chunk_bytes: usize,
    max_total_bytes: usize,
    closed: bool,
}

impl BoundedByteQueue {
    pub fn new(max_chunks: usize, max_chunk_bytes: usize, max_total_bytes: usize) -> Self {
        Self {
            chunks: VecDeque::new(),
            queued_bytes: 0,
            max_chunks,
            max_chunk_bytes,
            max_total_bytes,
            closed: false,
        }
    }

    pub fn push(&mut self, chunk: Vec<u8>) -> Result<(), TerminalErrorKind> {
        if self.closed {
            return Err(TerminalErrorKind::SessionClosed);
        }
        if chunk.is_empty() || chunk.len() > self.max_chunk_bytes {
            return Err(TerminalErrorKind::InvalidInputPayload);
        }
        if self.chunks.len() >= self.max_chunks
            || self.queued_bytes.saturating_add(chunk.len()) > self.max_total_bytes
        {
            return Err(TerminalErrorKind::InputBackpressure);
        }
        self.queued_bytes += chunk.len();
        self.chunks.push_back(chunk);
        Ok(())
    }

    pub fn pop(&mut self) -> Option<Vec<u8>> {
        let chunk = self.chunks.pop_front()?;
        self.queued_bytes = self.queued_bytes.saturating_sub(chunk.len());
        Some(chunk)
    }

    pub fn close_and_clear(&mut self) {
        self.closed = true;
        self.chunks.clear();
        self.queued_bytes = 0;
    }

    pub fn queued_bytes(&self) -> usize {
        self.queued_bytes
    }

    pub fn len(&self) -> usize {
        self.chunks.len()
    }

    pub fn is_empty(&self) -> bool {
        self.chunks.is_empty()
    }
}

/// Stateful UTF-8 byte stream splitter that buffers trailing incomplete multi-byte
/// UTF-8 sequences (1..=3 bytes) across arbitrary read boundaries so neither
/// `String` consumers nor frontend streaming decoders observe split codepoints.
#[derive(Debug, Default)]
pub struct Utf8StreamSplitter {
    pending: Vec<u8>,
}

impl Utf8StreamSplitter {
    pub fn new() -> Self {
        Self {
            pending: Vec::with_capacity(4),
        }
    }

    /// Feeds a raw byte slice and returns `(aligned_bytes, decoded_text)` if at
    /// least one complete codepoint or invalid sequence replacement is ready.
    pub fn push(&mut self, incoming: &[u8]) -> Option<(Vec<u8>, String)> {
        if incoming.is_empty() {
            return None;
        }
        let mut combined = Vec::with_capacity(self.pending.len() + incoming.len());
        combined.extend_from_slice(&self.pending);
        combined.extend_from_slice(incoming);
        self.pending.clear();

        let split_at = complete_utf8_prefix_len(&combined);
        if split_at < combined.len() {
            self.pending.extend_from_slice(&combined[split_at..]);
            combined.truncate(split_at);
        }
        if combined.is_empty() {
            return None;
        }
        let text = String::from_utf8_lossy(&combined).into_owned();
        Some((combined, text))
    }

    /// Flushes any remaining trailing incomplete bytes at stream EOF.
    pub fn finish(&mut self) -> Option<(Vec<u8>, String)> {
        if self.pending.is_empty() {
            return None;
        }
        let tail = std::mem::take(&mut self.pending);
        let text = String::from_utf8_lossy(&tail).into_owned();
        Some((tail, text))
    }
}

fn complete_utf8_prefix_len(bytes: &[u8]) -> usize {
    match std::str::from_utf8(bytes) {
        Ok(_) => bytes.len(),
        Err(err) => {
            if err.error_len().is_none() {
                // Incomplete multi-byte sequence at the very end of `bytes`.
                err.valid_up_to()
            } else {
                // Contains an invalid byte sequence mid-stream; inspect only the last
                // up-to-3 bytes to see if the tail is an incomplete valid prefix.
                let len = bytes.len();
                let start = len.saturating_sub(3);
                for idx in start..len {
                    if let Err(tail_err) = std::str::from_utf8(&bytes[idx..]) {
                        if tail_err.error_len().is_none() && tail_err.valid_up_to() == 0 {
                            return idx;
                        }
                    }
                }
                len
            }
        }
    }
}

/// Outcome of a Win32 `TerminateProcess` syscall classification.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum NativeTerminateOutcome {
    Terminated,
    MissingOrNullHandle,
    OsFailure {
        raw_os_error: Option<i32>,
        message: String,
    },
}

/// Classifies a `TerminateProcess` return value without reading `GetLastError`
/// when the BOOL return is nonzero (preventing stale error 6 false positives).
pub fn classify_terminate_syscall<F>(
    has_valid_handle: bool,
    terminate_return_value: i32,
    last_error_on_zero: F,
) -> NativeTerminateOutcome
where
    F: FnOnce() -> (Option<i32>, String),
{
    if !has_valid_handle {
        return NativeTerminateOutcome::MissingOrNullHandle;
    }
    if terminate_return_value != 0 {
        return NativeTerminateOutcome::Terminated;
    }
    let (raw_os_error, message) = last_error_on_zero();
    NativeTerminateOutcome::OsFailure {
        raw_os_error,
        message,
    }
}

/// Resolves whether a `NativeTerminateOutcome` represents a real kill failure.
/// `ERROR_ACCESS_DENIED (5)` on a zero return is benign only when the child has
/// an observed exit code proving it already terminated.
pub fn resolve_kill_error(
    outcome: &NativeTerminateOutcome,
    observed_exit_code: Option<u32>,
) -> Option<String> {
    match outcome {
        NativeTerminateOutcome::Terminated => None,
        NativeTerminateOutcome::MissingOrNullHandle => {
            Some("child process raw handle unavailable for native termination".to_string())
        }
        NativeTerminateOutcome::OsFailure {
            raw_os_error: Some(ERROR_ACCESS_DENIED_WIN32),
            ..
        } if observed_exit_code.is_some() => None,
        NativeTerminateOutcome::OsFailure {
            raw_os_error,
            message,
        } => match raw_os_error {
            Some(code) => Some(format!(
                "TerminateProcess failed (os error {code}): {message}"
            )),
            None => Some(format!("TerminateProcess failed: {message}")),
        },
    }
}

fn validate_os_str_units(
    value: &OsStr,
    kind: TerminalErrorKind,
    label: &str,
) -> Result<(), TerminalError> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        let mut count = 0usize;
        for unit in value.encode_wide() {
            if unit == 0 {
                return Err(TerminalError::simple(
                    kind,
                    format!("{label} contains an embedded NUL"),
                ));
            }
            count += 1;
            if count >= MAX_PATH_UTF16 {
                return Err(TerminalError::simple(
                    kind,
                    format!("{label} exceeds Win32 UTF-16 length limit"),
                ));
            }
        }
    }
    #[cfg(not(windows))]
    {
        let text = value.to_string_lossy();
        if text.contains('\0') || text.encode_utf16().count() >= MAX_PATH_UTF16 {
            return Err(TerminalError::simple(
                kind,
                format!("{label} is invalid or exceeds UTF-16 length limit"),
            ));
        }
    }
    Ok(())
}

fn verify_canonical_path(
    path: &Path,
    directory: bool,
    kind: TerminalErrorKind,
    label: &str,
) -> Result<PathBuf, TerminalError> {
    validate_os_str_units(path.as_os_str(), kind, label)?;
    if !path.is_absolute() {
        return Err(TerminalError::simple(
            kind,
            format!("{label} must be an absolute path"),
        ));
    }
    let canonical = fs::canonicalize(path).map_err(|err| {
        TerminalError::simple(kind, format!("verify {label} {}: {err}", path.display()))
    })?;
    let metadata = fs::metadata(&canonical).map_err(|err| {
        TerminalError::simple(
            kind,
            format!("inspect verified {label} {}: {err}", canonical.display()),
        )
    })?;
    if directory != metadata.is_dir() || (!directory && !metadata.is_file()) {
        return Err(TerminalError::simple(
            kind,
            format!(
                "verified {label} has unexpected file type: {}",
                canonical.display()
            ),
        ));
    }
    Ok(canonical)
}

fn verify_trusted_shell_and_cwd(
    shell: &TrustedShellConfig,
    working_directory: &Path,
) -> Result<(PathBuf, PathBuf), TerminalError> {
    let exe = verify_canonical_path(
        &shell.executable,
        false,
        TerminalErrorKind::InvalidShellExecutable,
        "shell executable",
    )?;
    for arg in &shell.arguments {
        validate_os_str_units(
            arg,
            TerminalErrorKind::InvalidShellArgument,
            "shell argument",
        )?;
    }
    let cwd = verify_canonical_path(
        working_directory,
        true,
        TerminalErrorKind::InvalidWorkingDirectory,
        "working directory",
    )?;
    Ok((exe, cwd))
}

/// Checks whether the ConPTY terminal service is available for the given trusted shell.
pub fn check_shell_availability(shell: &TrustedShellConfig) -> TerminalAvailability {
    #[cfg(not(all(windows, target_arch = "x86_64")))]
    {
        let _ = shell;
        TerminalAvailability {
            available: false,
            reason: Some(TerminalErrorKind::UnsupportedPlatform),
            detail: Some("ConPTY terminal service requires Windows x64".to_string()),
        }
    }
    #[cfg(all(windows, target_arch = "x86_64"))]
    {
        for arg in &shell.arguments {
            if let Err(err) = validate_os_str_units(
                arg,
                TerminalErrorKind::InvalidShellArgument,
                "shell argument",
            ) {
                return TerminalAvailability {
                    available: false,
                    reason: Some(err.kind),
                    detail: Some(err.detail),
                };
            }
        }
        match verify_canonical_path(
            &shell.executable,
            false,
            TerminalErrorKind::InvalidShellExecutable,
            "shell executable",
        ) {
            Ok(_) => TerminalAvailability {
                available: true,
                reason: None,
                detail: None,
            },
            Err(err) => TerminalAvailability {
                available: false,
                reason: Some(err.kind),
                detail: Some(err.detail),
            },
        }
    }
}

#[cfg(all(windows, target_arch = "x86_64"))]
mod windows_pty {
    use super::win_conpty::{JobProcessGroup, JobPtySystem, NativeSpawnDescriptor};
    use super::*;
    use portable_pty::{Child, MasterPty, PtySize};
    use std::{
        io::{Read, Write},
        os::windows::io::{AsRawHandle, RawHandle},
        sync::{atomic::AtomicUsize, Condvar, OnceLock, TryLockError, Weak},
    };
    #[link(name = "kernel32")]
    extern "system" {
        fn CancelSynchronousIo(h_thread: RawHandle) -> i32;
    }

    type SharedWriter = Arc<Mutex<Option<Box<dyn Write + Send>>>>;
    type SharedChild = Arc<Mutex<Option<Box<dyn Child + Send + Sync>>>>;
    type SharedMaster = Arc<Mutex<Option<Box<dyn MasterPty + Send>>>>;
    type SharedReaderSource = Arc<Mutex<Option<Box<dyn Read + Send>>>>;
    type SharedJoinHandle = Arc<Mutex<Option<JoinHandle<()>>>>;
    type ReapedStatus = Option<(Option<u32>, bool, bool, Option<String>)>;

    const CLEANUP_REAPER_CAPACITY: usize = 64;

    #[derive(Clone)]
    struct SharedPtyResources {
        child: SharedChild,
        master: SharedMaster,
        writer: SharedWriter,
        reader_source: SharedReaderSource,
        reader_handle: SharedJoinHandle,
        supervisor_handle: SharedJoinHandle,
        job: JobProcessGroup,
    }

    fn lock_recover<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
        mutex
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn try_lock_recover<T>(mutex: &Mutex<T>) -> Option<std::sync::MutexGuard<'_, T>> {
        match mutex.try_lock() {
            Ok(guard) => Some(guard),
            Err(TryLockError::Poisoned(poisoned)) => Some(poisoned.into_inner()),
            Err(TryLockError::WouldBlock) => None,
        }
    }

    struct CleanupReaperState {
        reserved: usize,
        pending: VecDeque<CleanupTicket>,
    }

    struct CleanupReaperInner {
        state: Mutex<CleanupReaperState>,
        changed: Condvar,
    }

    struct CleanupReaper {
        inner: Arc<CleanupReaperInner>,
        // Retain the worker's join handle for the lifetime of the host.
        _worker: Mutex<Option<JoinHandle<()>>>,
    }

    fn cleanup_reaper() -> Option<&'static CleanupReaper> {
        static REAPER: OnceLock<Option<CleanupReaper>> = OnceLock::new();
        REAPER
            .get_or_init(|| {
                let inner = Arc::new(CleanupReaperInner {
                    state: Mutex::new(CleanupReaperState {
                        reserved: 0,
                        pending: VecDeque::with_capacity(CLEANUP_REAPER_CAPACITY),
                    }),
                    changed: Condvar::new(),
                });
                let worker_inner = Arc::clone(&inner);
                let worker = thread::Builder::new()
                    .name("conpty-cleanup-reaper".to_string())
                    .spawn(move || cleanup_worker(worker_inner))
                    .ok()?;
                Some(CleanupReaper {
                    inner,
                    _worker: Mutex::new(Some(worker)),
                })
            })
            .as_ref()
    }

    struct CleanupPermit {
        reaper: &'static CleanupReaper,
    }

    impl CleanupPermit {
        fn reserve() -> Result<Self, TerminalError> {
            let Some(reaper) = cleanup_reaper() else {
                return Err(TerminalError::simple(
                    TerminalErrorKind::CleanupFailed,
                    "bounded cleanup reaper unavailable; no child was spawned",
                ));
            };
            let mut state = lock_recover(&reaper.inner.state);
            if state.reserved >= CLEANUP_REAPER_CAPACITY {
                return Err(TerminalError::simple(
                    TerminalErrorKind::CleanupFailed,
                    "bounded cleanup capacity is full; no child was spawned",
                ));
            }
            state.reserved += 1;
            Ok(Self { reaper })
        }
    }

    impl Drop for CleanupPermit {
        fn drop(&mut self) {
            let mut state = lock_recover(&self.reaper.inner.state);
            state.reserved = state.reserved.saturating_sub(1);
            self.reaper.inner.changed.notify_all();
        }
    }

    struct CleanupTicket {
        _permit: CleanupPermit,
        resources: SharedPtyResources,
        gate: Option<Arc<SessionGate>>,
        completion: Option<Arc<AtomicBool>>,
        #[cfg(test)]
        test_probe: Option<Arc<CleanupTestProbe>>,
    }

    impl CleanupTicket {
        fn new(
            permit: CleanupPermit,
            resources: SharedPtyResources,
            gate: Option<Arc<SessionGate>>,
            completion: Option<Arc<AtomicBool>>,
        ) -> Self {
            Self {
                _permit: permit,
                resources,
                gate,
                completion,
                #[cfg(test)]
                test_probe: None,
            }
        }

        /// Makes one non-blocking cleanup attempt. The ticket keeps the shared
        /// native handles until each operation has supplied its own proof.
        fn cleanup_step(&mut self) -> bool {
            #[cfg(test)]
            if self
                .test_probe
                .as_ref()
                .is_some_and(|probe| probe.hold.load(Ordering::Acquire))
            {
                return false;
            }

            if let Some(gate) = &self.gate {
                gate.reader_stop.store(true, Ordering::Release);
                gate.reader_close_requested.store(true, Ordering::Release);
            }

            let child_reaped =
                if let Some(mut child_guard) = try_lock_recover(&self.resources.child) {
                    let observed_exit = child_guard
                        .as_mut()
                        .map(|child| child.try_wait().ok().flatten().is_some())
                        .unwrap_or(true);
                    if observed_exit {
                        child_guard.take();
                        true
                    } else {
                        if let Some(child) = child_guard.as_mut() {
                            let _ = terminate_owned_job(child.as_mut());
                        }
                        false
                    }
                } else {
                    false
                };

            let job_drained = self
                .resources
                .job
                .active_processes()
                .map(|active| active == 0)
                .unwrap_or(false);
            if !job_drained {
                let _ = self.resources.job.terminate_all(1);
            }

            let writer_closed = close_writer_once(&self.resources.writer);
            let master_dropped = close_master_once(&self.resources.master);
            let reader_joined = reap_join_handle(&self.resources.reader_handle, true);
            let reader_source_dropped = if reader_joined {
                drop_reader_source(&self.resources.reader_source)
            } else {
                false
            };
            let supervisor_joined = reap_join_handle(&self.resources.supervisor_handle, false);

            child_reaped
                && job_drained
                && writer_closed
                && master_dropped
                && reader_joined
                && reader_source_dropped
                && supervisor_joined
        }
    }

    impl Drop for CleanupTicket {
        fn drop(&mut self) {
            if let Some(completion) = &self.completion {
                completion.store(true, Ordering::Release);
            }
            #[cfg(test)]
            if let Some(probe) = &self.test_probe {
                probe.completed.store(true, Ordering::Release);
            }
        }
    }

    fn close_writer_once(writer: &SharedWriter) -> bool {
        let Some(mut guard) = try_lock_recover(writer) else {
            return false;
        };
        guard.take();
        true
    }

    fn close_master_once(master: &SharedMaster) -> bool {
        let Some(mut guard) = try_lock_recover(master) else {
            return false;
        };
        guard.take();
        true
    }

    fn drop_reader_source(source: &SharedReaderSource) -> bool {
        let Some(mut guard) = try_lock_recover(source) else {
            return false;
        };
        guard.take();
        true
    }

    fn reap_join_handle(handle_slot: &SharedJoinHandle, cancel_io: bool) -> bool {
        let Some(mut guard) = try_lock_recover(handle_slot) else {
            return false;
        };
        let Some(handle) = guard.as_ref() else {
            return true;
        };
        if !handle.is_finished() {
            if cancel_io {
                unsafe {
                    let _ = CancelSynchronousIo(handle.as_raw_handle());
                }
            }
            return false;
        }
        let Some(handle) = guard.take() else {
            return false;
        };
        drop(guard);
        let _ = handle.join();
        true
    }

    fn enqueue_cleanup_ticket(ticket: CleanupTicket) {
        let reaper = ticket._permit.reaper;
        #[cfg(test)]
        if let Some(probe) = &ticket.test_probe {
            probe.enqueued.store(true, Ordering::Release);
        }
        let mut state = lock_recover(&reaper.inner.state);
        // A permit is reserved before spawn, so this queue cannot be full
        // unless its capacity invariant has been violated.
        state.pending.push_back(ticket);
        drop(state);
        reaper.inner.changed.notify_one();
    }

    fn cleanup_worker(inner: Arc<CleanupReaperInner>) {
        loop {
            let mut ticket = {
                let mut state = lock_recover(&inner.state);
                while state.pending.is_empty() {
                    state = inner
                        .changed
                        .wait(state)
                        .unwrap_or_else(std::sync::PoisonError::into_inner);
                }
                let Some(ticket) = state.pending.pop_front() else {
                    continue;
                };
                ticket
            };

            let complete =
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| ticket.cleanup_step()))
                    .unwrap_or(false);
            if complete {
                drop(ticket);
                continue;
            }

            let mut state = lock_recover(&inner.state);
            state.pending.push_back(ticket);
            let _ = inner
                .changed
                .wait_timeout(state, Duration::from_millis(25))
                .unwrap_or_else(std::sync::PoisonError::into_inner);
        }
    }

    fn finish_cleanup_ticket(mut ticket: CleanupTicket, wait: Duration) -> TerminalCleanupProof {
        let deadline = Instant::now() + wait;
        loop {
            if ticket.cleanup_step() {
                drop(ticket);
                return TerminalCleanupProof::SessionDrained;
            }
            if Instant::now() >= deadline {
                enqueue_cleanup_ticket(ticket);
                return TerminalCleanupProof::Deferred;
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            thread::sleep(Duration::from_millis(25).min(remaining));
        }
    }

    fn cleanup_failed_spawn(
        permit: CleanupPermit,
        resources: SharedPtyResources,
        gate: Option<Arc<SessionGate>>,
    ) -> TerminalCleanupProof {
        finish_cleanup_ticket(
            CleanupTicket::new(permit, resources, gate, None),
            Duration::from_secs(3),
        )
    }

    #[cfg(test)]
    pub(super) struct CleanupTestProbe {
        hold: AtomicBool,
        enqueued: AtomicBool,
        completed: AtomicBool,
        job: Mutex<Option<JobProcessGroup>>,
    }

    #[cfg(test)]
    impl CleanupTestProbe {
        pub(super) fn enqueued(&self) -> bool {
            self.enqueued.load(Ordering::Acquire)
        }

        pub(super) fn completed(&self) -> bool {
            self.completed.load(Ordering::Acquire)
        }

        pub(super) fn release(&self) {
            self.hold.store(false, Ordering::Release);
        }

        pub(super) fn job_process_group(&self) -> Option<JobProcessGroup> {
            lock_recover(&self.job).clone()
        }

        fn record_spawn(&self, job: JobProcessGroup) {
            *lock_recover(&self.job) = Some(job);
        }
    }

    #[cfg(test)]
    static NEXT_AFTER_SPAWN_FAULT: Mutex<Option<HashMap<thread::ThreadId, Arc<CleanupTestProbe>>>> =
        Mutex::new(None);

    #[cfg(test)]
    pub(super) fn inject_after_spawn_failure() -> Arc<CleanupTestProbe> {
        let probe = Arc::new(CleanupTestProbe {
            hold: AtomicBool::new(true),
            enqueued: AtomicBool::new(false),
            completed: AtomicBool::new(false),
            job: Mutex::new(None),
        });
        let mut guard = lock_recover(&NEXT_AFTER_SPAWN_FAULT);
        let map = guard.get_or_insert_with(HashMap::new);
        map.insert(thread::current().id(), Arc::clone(&probe));
        probe
    }

    #[cfg(test)]
    fn take_after_spawn_fault() -> Option<Arc<CleanupTestProbe>> {
        let mut guard = lock_recover(&NEXT_AFTER_SPAWN_FAULT);
        guard
            .as_mut()
            .and_then(|map| map.remove(&thread::current().id()))
    }

    const ERROR_BROKEN_PIPE_WIN32: i32 = 109;
    const ERROR_NO_DATA_WIN32: i32 = 232;
    const ERROR_PIPE_NOT_CONNECTED_WIN32: i32 = 233;

    fn is_closed_pipe_error(error: &std::io::Error) -> bool {
        matches!(
            error.raw_os_error(),
            Some(ERROR_BROKEN_PIPE_WIN32)
                | Some(ERROR_NO_DATA_WIN32)
                | Some(ERROR_PIPE_NOT_CONNECTED_WIN32)
        )
    }

    fn reserve_output_bytes(pending: &AtomicUsize, amount: usize, limit: usize) -> bool {
        let mut current = pending.load(Ordering::Acquire);
        loop {
            let Some(next) = current.checked_add(amount) else {
                return false;
            };
            if next > limit {
                return false;
            }
            match pending.compare_exchange_weak(current, next, Ordering::AcqRel, Ordering::Acquire)
            {
                Ok(_) => return true,
                Err(actual) => current = actual,
            }
        }
    }

    fn release_output_bytes(pending: &AtomicUsize, amount: usize) {
        let _ = pending.fetch_update(Ordering::AcqRel, Ordering::Acquire, |current| {
            Some(current.saturating_sub(amount))
        });
    }

    struct SessionGate {
        #[cfg(test)]
        raw_read_bytes: AtomicUsize,
        #[cfg(test)]
        reader_started: AtomicBool,
        owner: OwnerId,
        workspace_id: WorkspaceId,
        session_id: TerminalSessionId,
        generation: u64,
        sequence: AtomicU64,
        revoked: AtomicBool,
        closing: AtomicBool,
        exit_emitted: AtomicBool,
        backpressure_tripped: AtomicBool,
        reader_stop: AtomicBool,
        reader_close_requested: AtomicBool,
        reader_eof: AtomicBool,
        reader_finished: AtomicBool,
        reader_failed: AtomicBool,
        sink: Arc<dyn TerminalEventSink>,
    }

    impl SessionGate {
        fn emit_data(&self, bytes: Vec<u8>, text: String) -> bool {
            if self.revoked.load(Ordering::Acquire) || self.exit_emitted.load(Ordering::Acquire) {
                return false;
            }
            let seq = self.sequence.fetch_add(1, Ordering::AcqRel) + 1;
            let event = TerminalEvent {
                owner: self.owner.clone(),
                workspace_id: self.workspace_id.clone(),
                session_id: self.session_id.clone(),
                generation: self.generation,
                sequence: seq,
                payload: TerminalEventPayload::Data { bytes, text },
            };
            match self.sink.emit(event) {
                Ok(()) => true,
                Err(TerminalSinkError::Backpressure) => {
                    self.backpressure_tripped.store(true, Ordering::Release);
                    self.reader_stop.store(true, Ordering::Release);
                    false
                }
                Err(TerminalSinkError::Disconnected) => {
                    self.reader_failed.store(true, Ordering::Release);
                    self.reader_stop.store(true, Ordering::Release);
                    false
                }
            }
        }

        fn emit_exit_once(&self, exit_code: Option<u32>, reason: TerminalExitReason) {
            if self.revoked.load(Ordering::Acquire) {
                return;
            }
            if self
                .exit_emitted
                .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                .is_ok()
            {
                let seq = self.sequence.fetch_add(1, Ordering::AcqRel) + 1;
                let _ = self.sink.emit(TerminalEvent {
                    owner: self.owner.clone(),
                    workspace_id: self.workspace_id.clone(),
                    session_id: self.session_id.clone(),
                    generation: self.generation,
                    sequence: seq,
                    payload: TerminalEventPayload::Exit { exit_code, reason },
                });
            }
        }
    }

    fn terminate_owned_job(child: &mut dyn Child) -> NativeTerminateOutcome {
        match child.kill() {
            Ok(()) => NativeTerminateOutcome::Terminated,
            Err(error) => NativeTerminateOutcome::OsFailure {
                raw_os_error: error.raw_os_error(),
                message: error.to_string(),
            },
        }
    }

    pub(super) struct ActivePtySession {
        pub(super) info: TerminalSessionInfo,
        pub(super) owner: OwnerId,
        resources: SharedPtyResources,
        gate: Arc<SessionGate>,
        cancellation: CancellationToken,
        cancellation_handle: CancellationHandle,
        input_queue: Mutex<BoundedByteQueue>,
        reaped_status: Mutex<ReapedStatus>,
        reader_rx: Mutex<mpsc::Receiver<Vec<u8>>>,
        reader_pending_bytes: Arc<AtomicUsize>,
        reader_splitter: Mutex<Utf8StreamSplitter>,
        supervisor_stop: AtomicBool,
        supervisor_started: AtomicBool,
        supervisor_joined: AtomicBool,
        supervisor_join_panicked: AtomicBool,
        cleanup_permit: Mutex<Option<CleanupPermit>>,
        cleanup_completion: Arc<AtomicBool>,
        full_cleanup_after_defer: AtomicBool,
        teardown_started: AtomicBool,
        teardown_finalized: AtomicBool,
        final_report: Mutex<Option<TerminalTeardownReport>>,
        teardown_lock: Mutex<()>,
    }

    #[derive(Clone, Copy, Debug, Eq, PartialEq)]
    enum SupervisorJoinProof {
        Joined,
        Panicked,
        Deferred,
    }

    impl ActivePtySession {
        pub(super) fn spawn(
            spec: &TerminalSpawnSpec,
            descriptor: &NativeSpawnDescriptor<'_>,
            session_id: TerminalSessionId,
            generation: u64,
            sink: Arc<dyn TerminalEventSink>,
            cancellation_handle: CancellationHandle,
            cancellation: CancellationToken,
        ) -> Result<Arc<Self>, TerminalError> {
            if cancellation.is_cancelled() {
                return Err(TerminalError::simple(
                    TerminalErrorKind::Cancelled,
                    "terminal spawn cancelled before opening ConPTY",
                ));
            }

            // Every successful child launch owns a cleanup slot before the
            // process exists. Saturation therefore rejects spawn, never cleanup.
            let cleanup_permit = CleanupPermit::reserve()?;
            let pty_size = PtySize {
                rows: spec.initial_size.rows,
                cols: spec.initial_size.cols,
                pixel_width: 0,
                pixel_height: 0,
            };
            let pty_system = JobPtySystem;
            let mut pair = pty_system.openpty(pty_size).map_err(|err| {
                TerminalError::simple(TerminalErrorKind::SpawnFailed, format!("openpty: {err}"))
            })?;

            let spawned = pair.spawn_trusted(descriptor).map_err(|err| {
                TerminalError::simple(
                    TerminalErrorKind::SpawnFailed,
                    format!("spawn_command: {err}"),
                )
            })?;

            let resources = SharedPtyResources {
                child: Arc::new(Mutex::new(Some(spawned.child))),
                master: Arc::new(Mutex::new(Some(pair.master))),
                writer: Arc::new(Mutex::new(None)),
                reader_source: Arc::new(Mutex::new(None)),
                reader_handle: Arc::new(Mutex::new(None)),
                supervisor_handle: Arc::new(Mutex::new(None)),
                job: spawned.job,
            };

            #[cfg(test)]
            if let Some(probe) = take_after_spawn_fault() {
                probe.record_spawn(resources.job.clone());
                let mut ticket = CleanupTicket::new(cleanup_permit, resources.clone(), None, None);
                ticket.test_probe = Some(probe);
                let cleanup = finish_cleanup_ticket(ticket, Duration::ZERO);
                return Err(TerminalError::with_cleanup(
                    TerminalErrorKind::SpawnFailed,
                    "injected failure after child spawn and before reader startup",
                    cleanup,
                ));
            }

            let pid = match lock_recover(&resources.child)
                .as_ref()
                .and_then(|child| child.process_id())
            {
                Some(id) if id > 0 => id,
                _ => {
                    let cleanup = cleanup_failed_spawn(cleanup_permit, resources.clone(), None);
                    return Err(TerminalError::with_cleanup(
                        TerminalErrorKind::SpawnFailed,
                        "spawned ConPTY child did not report a valid PID",
                        cleanup,
                    ));
                }
            };

            let reader_result = lock_recover(&resources.master)
                .as_ref()
                .map(|master| master.try_clone_reader());
            let reader = match reader_result {
                Some(Ok(reader)) => reader,
                Some(Err(err)) => {
                    let cleanup = cleanup_failed_spawn(cleanup_permit, resources.clone(), None);
                    return Err(TerminalError::with_cleanup(
                        TerminalErrorKind::SpawnFailed,
                        format!("clone PTY reader: {err}"),
                        cleanup,
                    ));
                }
                None => {
                    let cleanup = cleanup_failed_spawn(cleanup_permit, resources.clone(), None);
                    return Err(TerminalError::with_cleanup(
                        TerminalErrorKind::SpawnFailed,
                        "PTY master disappeared before reader startup",
                        cleanup,
                    ));
                }
            };
            *lock_recover(&resources.reader_source) = Some(reader);

            let writer_result = lock_recover(&resources.master)
                .as_ref()
                .map(|master| master.take_writer());
            let raw_writer = match writer_result {
                Some(Ok(writer)) => writer,
                Some(Err(err)) => {
                    let cleanup = cleanup_failed_spawn(cleanup_permit, resources.clone(), None);
                    return Err(TerminalError::with_cleanup(
                        TerminalErrorKind::SpawnFailed,
                        format!("take PTY writer: {err}"),
                        cleanup,
                    ));
                }
                None => {
                    let cleanup = cleanup_failed_spawn(cleanup_permit, resources.clone(), None);
                    return Err(TerminalError::with_cleanup(
                        TerminalErrorKind::SpawnFailed,
                        "PTY master disappeared before writer startup",
                        cleanup,
                    ));
                }
            };

            *lock_recover(&resources.writer) = Some(raw_writer);
            let writer_for_reader = Arc::clone(&resources.writer);
            let gate = Arc::new(SessionGate {
                #[cfg(test)]
                raw_read_bytes: AtomicUsize::new(0),
                #[cfg(test)]
                reader_started: AtomicBool::new(false),
                owner: spec.owner.clone(),
                workspace_id: spec.workspace_id.clone(),
                session_id: session_id.clone(),
                generation,
                sequence: AtomicU64::new(0),
                revoked: AtomicBool::new(false),
                closing: AtomicBool::new(false),
                exit_emitted: AtomicBool::new(false),
                backpressure_tripped: AtomicBool::new(false),
                reader_stop: AtomicBool::new(false),
                reader_close_requested: AtomicBool::new(false),
                reader_eof: AtomicBool::new(false),
                reader_finished: AtomicBool::new(false),
                reader_failed: AtomicBool::new(false),
                sink,
            });

            let (tx, rx) = mpsc::sync_channel::<Vec<u8>>(spec.limits.max_output_chunks);
            let max_output_bytes = spec.limits.max_output_queue_bytes;
            let reader_pending_bytes = Arc::new(AtomicUsize::new(0));
            let pending_for_reader = Arc::clone(&reader_pending_bytes);
            let gate_for_reader = Arc::clone(&gate);
            let reader_source_for_reader = Arc::clone(&resources.reader_source);

            let reader_handle = match thread::Builder::new()
                .name(format!("conpty-reader-{session_id}"))
                .spawn(move || {
                    #[cfg(test)]
                    gate_for_reader
                        .reader_started
                        .store(true, Ordering::Release);
                    let reader = lock_recover(&reader_source_for_reader).take();
                    let Some(mut reader) = reader else {
                        gate_for_reader.reader_failed.store(true, Ordering::Release);
                        gate_for_reader
                            .reader_finished
                            .store(true, Ordering::Release);
                        return;
                    };
                    let mut buf = [0u8; 8192];
                    let mut cpr_tail = Vec::with_capacity(3);
                    let read_capacity = max_output_bytes.min(buf.len());

                    while !gate_for_reader.reader_stop.load(Ordering::Acquire) {
                        match reader.read(&mut buf[..read_capacity]) {
                            Ok(0) => {
                                gate_for_reader.reader_eof.store(true, Ordering::Release);
                                break;
                            }
                            Ok(n) => {
                                #[cfg(test)]
                                gate_for_reader
                                    .raw_read_bytes
                                    .fetch_add(n, Ordering::AcqRel);
                                let chunk = &buf[..n];
                                let mut scan = cpr_tail.clone();
                                scan.extend_from_slice(chunk);
                                if !gate_for_reader.reader_stop.load(Ordering::Acquire)
                                    && scan.windows(4).any(|w| w == b"\x1b[6n")
                                {
                                    if let Ok(mut guard) = writer_for_reader.lock() {
                                        if let Some(w) = guard.as_mut() {
                                            let _ = w.write_all(b"\x1b[1;1R");
                                            let _ = w.flush();
                                        }
                                    }
                                }
                                cpr_tail.clear();
                                if scan.len() >= 3 {
                                    cpr_tail.extend_from_slice(&scan[scan.len() - 3..]);
                                } else {
                                    cpr_tail.extend_from_slice(&scan);
                                }

                                if !reserve_output_bytes(&pending_for_reader, n, max_output_bytes) {
                                    gate_for_reader
                                        .backpressure_tripped
                                        .store(true, Ordering::Release);
                                    gate_for_reader.reader_stop.store(true, Ordering::Release);
                                    break;
                                }

                                if tx.try_send(chunk.to_vec()).is_err() {
                                    release_output_bytes(&pending_for_reader, n);
                                    gate_for_reader
                                        .backpressure_tripped
                                        .store(true, Ordering::Release);
                                    gate_for_reader.reader_stop.store(true, Ordering::Release);
                                    break;
                                }
                            }
                            Err(error) => {
                                if gate_for_reader
                                    .reader_close_requested
                                    .load(Ordering::Acquire)
                                    && is_closed_pipe_error(&error)
                                {
                                    gate_for_reader.reader_eof.store(true, Ordering::Release);
                                } else {
                                    gate_for_reader.reader_failed.store(true, Ordering::Release);
                                }
                                break;
                            }
                        }
                    }
                    gate_for_reader
                        .reader_finished
                        .store(true, Ordering::Release);
                }) {
                Ok(handle) => handle,
                Err(err) => {
                    let cleanup = cleanup_failed_spawn(
                        cleanup_permit,
                        resources.clone(),
                        Some(Arc::clone(&gate)),
                    );
                    return Err(TerminalError::with_cleanup(
                        TerminalErrorKind::SpawnFailed,
                        format!("spawn reader thread: {err}"),
                        cleanup,
                    ));
                }
            };
            *lock_recover(&resources.reader_handle) = Some(reader_handle);

            let info = TerminalSessionInfo {
                session_id,
                workspace_id: spec.workspace_id.clone(),
                generation,
                pid,
                size: spec.initial_size,
            };

            let session = Arc::new(Self {
                info,
                owner: spec.owner.clone(),
                resources: resources.clone(),
                gate,
                cancellation,
                cancellation_handle,
                input_queue: Mutex::new(BoundedByteQueue::new(
                    spec.limits.max_input_chunks,
                    spec.limits.max_input_chunk_bytes,
                    spec.limits.max_input_queue_bytes,
                )),
                reaped_status: Mutex::new(None),
                reader_rx: Mutex::new(rx),
                reader_pending_bytes,
                reader_splitter: Mutex::new(Utf8StreamSplitter::new()),
                supervisor_stop: AtomicBool::new(false),
                supervisor_started: AtomicBool::new(false),
                supervisor_joined: AtomicBool::new(false),
                supervisor_join_panicked: AtomicBool::new(false),
                cleanup_permit: Mutex::new(Some(cleanup_permit)),
                cleanup_completion: Arc::new(AtomicBool::new(false)),
                full_cleanup_after_defer: AtomicBool::new(false),
                teardown_started: AtomicBool::new(false),
                teardown_finalized: AtomicBool::new(false),
                final_report: Mutex::new(None),
                teardown_lock: Mutex::new(()),
            });

            // Install the handle before allowing the watcher to run. This keeps
            // natural-exit cleanup joinable even when the shell exits immediately.
            let weak = Arc::downgrade(&session);
            let (start_tx, start_rx) = mpsc::sync_channel::<()>(0);
            let supervisor = match thread::Builder::new()
                .name(format!("conpty-supervisor-{}", session.info.session_id))
                .spawn(move || {
                    if start_rx.recv().is_ok() {
                        Self::supervise_child(weak);
                    }
                }) {
                Ok(handle) => handle,
                Err(err) => {
                    let report = session.teardown(TerminalExitReason::ReaderFailure, true);
                    return Err(TerminalError::with_cleanup(
                        TerminalErrorKind::SpawnFailed,
                        format!("spawn child supervisor: {err}"),
                        report.cleanup,
                    ));
                }
            };
            *lock_recover(&session.resources.supervisor_handle) = Some(supervisor);
            session.supervisor_started.store(true, Ordering::Release);
            if start_tx.send(()).is_err() {
                let report = session.teardown(TerminalExitReason::ReaderFailure, true);
                return Err(TerminalError::with_cleanup(
                    TerminalErrorKind::SpawnFailed,
                    "child supervisor failed to start",
                    report.cleanup,
                ));
            }
            Ok(session)
        }

        fn supervise_child(session: Weak<Self>) {
            loop {
                let Some(active) = session.upgrade() else {
                    return;
                };
                if active.supervisor_stop.load(Ordering::Acquire) {
                    return;
                }
                if active.cancellation.is_cancelled() {
                    let _ = active.teardown(TerminalExitReason::Cancelled, false);
                    return;
                }
                active.drain_reader_channel();
                if active.gate.backpressure_tripped.load(Ordering::Acquire) {
                    let _ = active.teardown(TerminalExitReason::OutputBackpressure, false);
                    return;
                }
                if active.gate.reader_failed.load(Ordering::Acquire) {
                    let _ = active.teardown(TerminalExitReason::ReaderFailure, false);
                    return;
                }

                let poll = {
                    let mut child = lock_recover(&active.resources.child);
                    match child.as_mut() {
                        Some(child) => child.try_wait().map_err(|_| ()),
                        None => Ok(None),
                    }
                };
                match poll {
                    Ok(Some(status)) => {
                        if let Ok(mut cached) = active.reaped_status.lock() {
                            if cached.is_none() {
                                *cached =
                                    Some((Some(status.exit_code()), status.success(), false, None));
                            }
                        }
                        let _ = active.teardown(TerminalExitReason::GracefulExit, false);
                        return;
                    }
                    Ok(None) => {}
                    Err(()) => {
                        let _ = active.teardown(TerminalExitReason::ReaderFailure, false);
                        return;
                    }
                }

                drop(active);
                thread::sleep(Duration::from_millis(20));
            }
        }

        fn wait_reader_eof(&self, timeout: Duration) -> bool {
            let deadline = Instant::now() + timeout;
            loop {
                self.drain_reader_channel();
                let finished = {
                    let guard = lock_recover(&self.resources.reader_handle);
                    match guard.as_ref() {
                        Some(handle) => handle.is_finished(),
                        None => true,
                    }
                };
                if finished {
                    return self.gate.reader_eof.load(Ordering::Acquire)
                        && !self.gate.reader_failed.load(Ordering::Acquire)
                        && !self.gate.backpressure_tripped.load(Ordering::Acquire)
                        && self.reader_pending_bytes.load(Ordering::Acquire) == 0;
                }
                if Instant::now() >= deadline {
                    return false;
                }
                thread::sleep(Duration::from_millis(10));
            }
        }

        fn join_supervisor_bounded(&self) -> SupervisorJoinProof {
            let current = thread::current().id();
            let deadline = Instant::now() + Duration::from_secs(2);
            loop {
                let mut guard = lock_recover(&self.resources.supervisor_handle);
                let Some(handle) = guard.as_ref() else {
                    if !self.supervisor_started.load(Ordering::Acquire)
                        || self.supervisor_joined.load(Ordering::Acquire)
                    {
                        return if self.supervisor_join_panicked.load(Ordering::Acquire) {
                            SupervisorJoinProof::Panicked
                        } else {
                            SupervisorJoinProof::Joined
                        };
                    }
                    // Another owned cleanup ticket may hold the join handle.
                    return SupervisorJoinProof::Deferred;
                };
                if handle.thread().id() == current {
                    // The caller is the supervisor. Its handle remains in the
                    // shared resource slot for the reserved reaper to join.
                    return SupervisorJoinProof::Deferred;
                }
                if handle.is_finished() {
                    let Some(handle) = guard.take() else {
                        return SupervisorJoinProof::Deferred;
                    };
                    drop(guard);
                    self.supervisor_joined.store(true, Ordering::Release);
                    return match handle.join() {
                        Ok(()) => SupervisorJoinProof::Joined,
                        Err(_) => {
                            self.supervisor_join_panicked.store(true, Ordering::Release);
                            SupervisorJoinProof::Panicked
                        }
                    };
                }
                drop(guard);
                if Instant::now() >= deadline {
                    // Do not report a join that did not happen. The cleanup
                    // ticket retains the shared native join handle.
                    return SupervisorJoinProof::Deferred;
                }
                thread::sleep(Duration::from_millis(10));
            }
        }

        #[cfg(test)]
        pub(super) fn job_process_group(&self) -> JobProcessGroup {
            self.resources.job.clone()
        }

        #[cfg(test)]
        pub(super) fn io_progress(&self) -> String {
            let gate = &self.gate;
            format!("reader_started={} raw_read_bytes={} emitted_sequence={} eof={} failed={} backpressure={} stopped={}",
                gate.reader_started.load(Ordering::Acquire), gate.raw_read_bytes.load(Ordering::Acquire),
                gate.sequence.load(Ordering::Acquire), gate.reader_eof.load(Ordering::Acquire),
                gate.reader_failed.load(Ordering::Acquire), gate.backpressure_tripped.load(Ordering::Acquire),
                gate.reader_stop.load(Ordering::Acquire))
        }

        pub(super) fn drain_reader_channel(&self) {
            if self.gate.revoked.load(Ordering::Acquire) {
                return;
            }
            if let Ok(rx) = self.reader_rx.lock() {
                let Ok(mut splitter) = self.reader_splitter.lock() else {
                    self.gate.reader_failed.store(true, Ordering::Release);
                    return;
                };
                while let Ok(chunk) = rx.try_recv() {
                    if let Some((bytes, text)) = splitter.push(&chunk) {
                        let delivered_bytes = bytes.len();
                        if !self.gate.emit_data(bytes, text) {
                            return;
                        }
                        release_output_bytes(&self.reader_pending_bytes, delivered_bytes);
                    }
                }

                let stream_finished = self.gate.reader_eof.load(Ordering::Acquire)
                    || self.gate.reader_finished.load(Ordering::Acquire);
                if stream_finished
                    && !self.gate.backpressure_tripped.load(Ordering::Acquire)
                    && !self.gate.revoked.load(Ordering::Acquire)
                {
                    if let Some((bytes, text)) = splitter.finish() {
                        let delivered_bytes = bytes.len();
                        if !self.gate.emit_data(bytes, text) {
                            return;
                        }
                        release_output_bytes(&self.reader_pending_bytes, delivered_bytes);
                    }
                }
            } else {
                self.gate.reader_failed.store(true, Ordering::Release);
            }
        }

        fn discard_reader_channel(&self) -> bool {
            let Ok(rx) = self.reader_rx.lock() else {
                return false;
            };
            let Ok(mut splitter) = self.reader_splitter.lock() else {
                return false;
            };
            while rx.try_recv().is_ok() {}
            *splitter = Utf8StreamSplitter::new();
            self.reader_pending_bytes.store(0, Ordering::Release);
            true
        }

        pub(super) fn write_input(&self, data: &[u8]) -> Result<(), TerminalError> {
            self.check_healthy()?;
            self.drain_reader_channel();
            {
                let mut queue = self.input_queue.lock().map_err(|_| {
                    TerminalError::simple(TerminalErrorKind::Internal, "input queue mutex poisoned")
                })?;
                queue.push(data.to_vec()).map_err(|kind| {
                    TerminalError::simple(kind, "input rejected by bounded queue")
                })?;
            }

            let mut writer_guard = self.resources.writer.lock().map_err(|_| {
                TerminalError::simple(TerminalErrorKind::Internal, "PTY writer mutex poisoned")
            })?;
            let Some(writer) = writer_guard.as_mut() else {
                return Err(TerminalError::simple(
                    TerminalErrorKind::SessionClosed,
                    "PTY writer is already closed",
                ));
            };

            loop {
                let next_chunk = {
                    let mut queue = self.input_queue.lock().map_err(|_| {
                        TerminalError::simple(
                            TerminalErrorKind::Internal,
                            "input queue mutex poisoned",
                        )
                    })?;
                    queue.pop()
                };
                let Some(chunk) = next_chunk else {
                    break;
                };
                writer.write_all(&chunk).map_err(|err| {
                    TerminalError::simple(
                        TerminalErrorKind::WriteFailed,
                        format!("write PTY input: {err}"),
                    )
                })?;
                writer.flush().map_err(|err| {
                    TerminalError::simple(
                        TerminalErrorKind::WriteFailed,
                        format!("flush PTY input: {err}"),
                    )
                })?;
            }
            Ok(())
        }

        pub(super) fn resize(&self, size: TerminalSize) -> Result<TerminalSize, TerminalError> {
            self.check_healthy()?;
            self.drain_reader_channel();
            let master_guard = lock_recover(&self.resources.master);
            let Some(master) = master_guard.as_ref() else {
                return Err(TerminalError::simple(
                    TerminalErrorKind::SessionClosed,
                    "PTY master is already closed",
                ));
            };
            master
                .resize(PtySize {
                    rows: size.rows,
                    cols: size.cols,
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .map_err(|err| {
                    TerminalError::simple(
                        TerminalErrorKind::ResizeFailed,
                        format!("resize ConPTY: {err}"),
                    )
                })?;
            let actual = master.get_size().map_err(|err| {
                TerminalError::simple(
                    TerminalErrorKind::ResizeFailed,
                    format!("query ConPTY size: {err}"),
                )
            })?;
            TerminalSize::new(actual.cols, actual.rows)
        }

        pub(super) fn check_healthy(&self) -> Result<(), TerminalError> {
            if self.gate.revoked.load(Ordering::Acquire) {
                return Err(TerminalError::simple(
                    TerminalErrorKind::OwnerRevoked,
                    "session owner has been revoked",
                ));
            }
            if self.gate.closing.load(Ordering::Acquire) {
                return Err(TerminalError::simple(
                    TerminalErrorKind::SessionClosed,
                    "terminal session teardown has started",
                ));
            }
            if self.gate.exit_emitted.load(Ordering::Acquire) {
                return Err(TerminalError::simple(
                    TerminalErrorKind::SessionClosed,
                    "terminal child has exited",
                ));
            }
            if self.cancellation.is_cancelled() {
                let report = self.teardown(TerminalExitReason::Cancelled, false);
                return Err(TerminalError::with_cleanup(
                    TerminalErrorKind::Cancelled,
                    "terminal session cancelled",
                    report.cleanup,
                ));
            }
            if self.gate.backpressure_tripped.load(Ordering::Acquire) {
                let report = self.teardown(TerminalExitReason::OutputBackpressure, false);
                return Err(TerminalError::with_cleanup(
                    TerminalErrorKind::OutputBackpressure,
                    "terminal output overflowed bounded queue; resync required",
                    report.cleanup,
                ));
            }
            Ok(())
        }

        pub(super) fn teardown(
            &self,
            reason: TerminalExitReason,
            suppress_events: bool,
        ) -> TerminalTeardownReport {
            if suppress_events {
                self.gate.revoked.store(true, Ordering::Release);
            }
            self.gate.closing.store(true, Ordering::Release);
            self.supervisor_stop.store(true, Ordering::Release);
            self.cancellation_handle.cancel();

            if self.teardown_finalized.load(Ordering::Acquire) {
                return self.report_after_teardown();
            }
            if self
                .teardown_started
                .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                .is_err()
            {
                return self.report_after_teardown();
            }

            let lifecycle = lock_recover(&self.teardown_lock);
            lock_recover(&self.input_queue).close_and_clear();

            // Step 1: Ensure child is terminated and reaped via bounded try_wait polling.
            let (child_reaped, exit_code, graceful_exit, forced_kill, kill_error) =
                self.reap_or_kill_child(Duration::from_secs(3));
            let drain_required = child_reaped && !self.gate.revoked.load(Ordering::Acquire);
            let output_backpressure = self.gate.backpressure_tripped.load(Ordering::Acquire);
            if !drain_required || output_backpressure {
                self.gate.reader_stop.store(true, Ordering::SeqCst);
            }

            // Step 2: Close the writer without waiting indefinitely for a
            // concurrent write. The reserved ticket retries a busy handle.
            let writer_closed =
                close_writer_bounded(&self.resources.writer, Duration::from_millis(250));

            // Step 3: Close the master before waiting for reader EOF. Closing it
            // unblocks ConPTY's cloned synchronous reader.
            self.gate
                .reader_close_requested
                .store(true, Ordering::Release);
            let master_dropped =
                close_master_bounded(&self.resources.master, Duration::from_millis(250));

            // A reaped child can be drained after the master closes. A failed
            // backpressure drain is reported rather than treated as success.
            let output_drained = if !drain_required {
                true
            } else if output_backpressure {
                false
            } else {
                self.wait_reader_eof(Duration::from_secs(2))
            };
            self.gate.reader_stop.store(true, Ordering::SeqCst);

            // Step 4: Repeatedly CancelSynchronousIo if still blocked, then join
            // only after the reader has finished.
            let (reader_joined, cancel_io_used) = self.stop_and_join_reader_bounded();

            // Step 5: Deliver remaining output, except after owner revocation,
            // where output is intentionally suppressed.
            if suppress_events {
                if reader_joined {
                    let _ = self.discard_reader_channel();
                }
            } else {
                self.drain_reader_channel();
            }

            let effective_reason = if self.gate.backpressure_tripped.load(Ordering::Acquire) {
                TerminalExitReason::OutputBackpressure
            } else if self.gate.reader_failed.load(Ordering::Acquire)
                || (drain_required && (!output_drained || !reader_joined))
            {
                TerminalExitReason::ReaderFailure
            } else if graceful_exit && matches!(reason, TerminalExitReason::KilledByOwner) {
                TerminalExitReason::GracefulExit
            } else {
                reason
            };

            self.gate.emit_exit_once(exit_code, effective_reason);

            let channel_drained = reader_joined
                && self.reader_pending_bytes.load(Ordering::Acquire) == 0
                && !self.gate.backpressure_tripped.load(Ordering::Acquire);
            let full_cleanup_without_supervisor = child_reaped
                && kill_error.is_none()
                && writer_closed
                && master_dropped
                && reader_joined
                && channel_drained
                && output_drained
                && !self.gate.reader_failed.load(Ordering::Acquire);

            let report = TerminalTeardownReport {
                session_id: self.info.session_id.clone(),
                child_reaped,
                exit_code,
                graceful_exit,
                forced_kill,
                writer_closed,
                master_dropped,
                reader_joined,
                supervisor_joined: false,
                cancel_io_used,
                channel_drained,
                cleanup: TerminalCleanupProof::Failed,
            };
            drop(lifecycle);

            // Joining happens after releasing the lifecycle lock: a watcher that
            // observed the exit may itself be waiting to enter teardown. A
            // self-join or bounded timeout is owned by the cleanup ticket.
            let supervisor_proof = self.join_supervisor_bounded();
            self.finish_teardown_report(report, full_cleanup_without_supervisor, supervisor_proof)
        }

        fn finish_teardown_report(
            &self,
            mut report: TerminalTeardownReport,
            full_cleanup_without_supervisor: bool,
            supervisor_proof: SupervisorJoinProof,
        ) -> TerminalTeardownReport {
            report.supervisor_joined = matches!(
                supervisor_proof,
                SupervisorJoinProof::Joined | SupervisorJoinProof::Panicked
            );

            if full_cleanup_without_supervisor && supervisor_proof == SupervisorJoinProof::Joined {
                report.cleanup = TerminalCleanupProof::SessionDrained;
                lock_recover(&self.cleanup_permit).take();
                return self.publish_teardown_report(report);
            }

            let permit = lock_recover(&self.cleanup_permit).take();
            let Some(permit) = permit else {
                report.cleanup = TerminalCleanupProof::Deferred;
                self.full_cleanup_after_defer
                    .store(full_cleanup_without_supervisor, Ordering::Release);
                return self.publish_teardown_report(report);
            };

            let mut ticket = CleanupTicket::new(
                permit,
                self.resources.clone(),
                Some(Arc::clone(&self.gate)),
                Some(Arc::clone(&self.cleanup_completion)),
            );
            if ticket.cleanup_step() {
                drop(ticket);
                if full_cleanup_without_supervisor
                    && supervisor_proof == SupervisorJoinProof::Deferred
                {
                    report.supervisor_joined = true;
                    report.cleanup = TerminalCleanupProof::SessionDrained;
                } else {
                    report.cleanup = TerminalCleanupProof::Failed;
                }
                return self.publish_teardown_report(report);
            }

            report.cleanup = TerminalCleanupProof::Deferred;
            self.full_cleanup_after_defer
                .store(full_cleanup_without_supervisor, Ordering::Release);
            *lock_recover(&self.final_report) = Some(report.clone());
            self.teardown_finalized.store(true, Ordering::Release);
            enqueue_cleanup_ticket(ticket);
            report
        }

        fn publish_teardown_report(
            &self,
            report: TerminalTeardownReport,
        ) -> TerminalTeardownReport {
            *lock_recover(&self.final_report) = Some(report.clone());
            self.teardown_finalized.store(true, Ordering::Release);
            report
        }

        fn report_after_teardown(&self) -> TerminalTeardownReport {
            let mut report = lock_recover(&self.final_report).clone().unwrap_or_else(|| {
                TerminalTeardownReport {
                    session_id: self.info.session_id.clone(),
                    child_reaped: false,
                    exit_code: None,
                    graceful_exit: false,
                    forced_kill: false,
                    writer_closed: false,
                    master_dropped: false,
                    reader_joined: false,
                    supervisor_joined: false,
                    cancel_io_used: false,
                    channel_drained: false,
                    cleanup: TerminalCleanupProof::Deferred,
                }
            });
            if report.cleanup == TerminalCleanupProof::Deferred
                && self.cleanup_completion.load(Ordering::Acquire)
            {
                if self.full_cleanup_after_defer.load(Ordering::Acquire) {
                    report.supervisor_joined = true;
                    report.cleanup = TerminalCleanupProof::SessionDrained;
                } else {
                    report.cleanup = TerminalCleanupProof::Failed;
                }
            }
            report
        }

        fn handoff_from_drop(&self) {
            self.gate.reader_stop.store(true, Ordering::Release);
            self.gate
                .reader_close_requested
                .store(true, Ordering::Release);
            let Some(permit) = lock_recover(&self.cleanup_permit).take() else {
                return;
            };
            let report = TerminalTeardownReport {
                session_id: self.info.session_id.clone(),
                child_reaped: false,
                exit_code: None,
                graceful_exit: false,
                forced_kill: false,
                writer_closed: false,
                master_dropped: false,
                reader_joined: false,
                supervisor_joined: false,
                cancel_io_used: false,
                channel_drained: false,
                cleanup: TerminalCleanupProof::Deferred,
            };
            self.full_cleanup_after_defer
                .store(false, Ordering::Release);
            *lock_recover(&self.final_report) = Some(report);
            self.teardown_finalized.store(true, Ordering::Release);
            enqueue_cleanup_ticket(CleanupTicket::new(
                permit,
                self.resources.clone(),
                Some(Arc::clone(&self.gate)),
                Some(Arc::clone(&self.cleanup_completion)),
            ));
        }

        fn reap_or_kill_child(
            &self,
            timeout: Duration,
        ) -> (bool, Option<u32>, bool, bool, Option<String>) {
            let mut status_guard = lock_recover(&self.reaped_status);
            if let Some((code, graceful, forced, ref err)) = *status_guard {
                lock_recover(&self.resources.child).take();
                return (true, code, graceful, forced, err.clone());
            }
            let mut child_guard = lock_recover(&self.resources.child);
            let Some(child) = child_guard.as_mut() else {
                return (
                    false,
                    None,
                    false,
                    false,
                    Some("child handle unavailable before reap proof".to_string()),
                );
            };

            if let Ok(Some(status)) = child.try_wait() {
                let code = Some(status.exit_code());
                let graceful = status.success();
                child_guard.take();
                *status_guard = Some((code, graceful, false, None));
                return (true, code, graceful, false, None);
            }

            let outcome = terminate_owned_job(child.as_mut());
            let deadline = Instant::now() + timeout;
            while Instant::now() < deadline {
                self.drain_reader_channel();
                if let Ok(Some(status)) = child.try_wait() {
                    let code = Some(status.exit_code());
                    let kill_err = resolve_kill_error(&outcome, code);
                    child_guard.take();
                    *status_guard = Some((code, false, true, kill_err.clone()));
                    return (true, code, false, true, kill_err);
                }
                thread::sleep(Duration::from_millis(25));
            }
            let kill_err = resolve_kill_error(&outcome, None);
            (false, None, false, true, kill_err)
        }

        fn stop_and_join_reader_bounded(&self) -> (bool, bool) {
            let mut cancel_io_used = false;
            let grace_deadline = Instant::now() + Duration::from_millis(250);
            while !self.reader_finished() && Instant::now() < grace_deadline {
                self.drain_reader_channel();
                thread::sleep(Duration::from_millis(20));
            }

            let cancel_deadline = Instant::now() + Duration::from_secs(2);
            while !self.reader_finished() && Instant::now() < cancel_deadline {
                cancel_io_used = true;
                {
                    let guard = lock_recover(&self.resources.reader_handle);
                    if let Some(handle) = guard.as_ref() {
                        unsafe {
                            let _ = CancelSynchronousIo(handle.as_raw_handle());
                        }
                    }
                }
                self.drain_reader_channel();
                thread::sleep(Duration::from_millis(25));
            }

            if self.reader_finished() {
                let handle = lock_recover(&self.resources.reader_handle).take();
                if let Some(handle) = handle {
                    let _ = handle.join();
                }
                return (true, cancel_io_used);
            }
            (false, cancel_io_used)
        }

        fn reader_finished(&self) -> bool {
            lock_recover(&self.resources.reader_handle)
                .as_ref()
                .map(JoinHandle::is_finished)
                .unwrap_or(true)
        }
    }

    impl Drop for ActivePtySession {
        fn drop(&mut self) {
            if !self.teardown_finalized.load(Ordering::Acquire) {
                let _ = self.teardown(TerminalExitReason::Cancelled, true);
                if !self.teardown_finalized.load(Ordering::Acquire) {
                    self.handoff_from_drop();
                }
            }
        }
    }

    fn close_writer_bounded(writer: &SharedWriter, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        loop {
            if close_writer_once(writer) {
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            thread::sleep(Duration::from_millis(10));
        }
    }

    fn close_master_bounded(master: &SharedMaster, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        loop {
            if close_master_once(master) {
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            thread::sleep(Duration::from_millis(10));
        }
    }
}

/// Production ConPTY terminal service managing owner-bound sessions,
/// generations, input/output backpressure, and finite teardown.
pub struct TerminalService {
    sink: Arc<dyn TerminalEventSink>,
    next_generation: AtomicU64,
    state: Mutex<ServiceState>,
}

#[derive(Default)]
struct ServiceState {
    revoked_owners: HashMap<OwnerId, u64>,
    closed_workspaces: HashMap<(OwnerId, WorkspaceId), u64>,
    #[cfg(all(windows, target_arch = "x86_64"))]
    sessions: HashMap<TerminalSessionId, Arc<windows_pty::ActivePtySession>>,
}

impl TerminalService {
    pub fn new(sink: Arc<dyn TerminalEventSink>) -> Self {
        Self {
            sink,
            next_generation: AtomicU64::new(1),
            state: Mutex::new(ServiceState::default()),
        }
    }

    /// Checks terminal availability for an owner and trusted shell configuration.
    pub fn availability(
        &self,
        owner: &OwnerId,
        shell: &TrustedShellConfig,
    ) -> TerminalAvailability {
        if let Ok(guard) = self.state.lock() {
            if guard.revoked_owners.contains_key(owner) {
                return TerminalAvailability {
                    available: false,
                    reason: Some(TerminalErrorKind::OwnerRevoked),
                    detail: Some("window owner has been revoked".to_string()),
                };
            }
        }
        check_shell_availability(shell)
    }

    /// Spawns a new owner-bound ConPTY session using host-verified shell and working directory.
    pub fn spawn(
        &self,
        spec: &TerminalSpawnSpec,
        cancellation_handle: CancellationHandle,
        cancellation: CancellationToken,
    ) -> Result<TerminalSessionInfo, TerminalError> {
        spec.limits.validate()?;
        let _ = TerminalSize::new(spec.initial_size.cols, spec.initial_size.rows)?;
        if cancellation.is_cancelled() {
            return Err(TerminalError::simple(
                TerminalErrorKind::Cancelled,
                "terminal spawn was cancelled before launch",
            ));
        }

        {
            let guard = self.state.lock().map_err(|_| {
                TerminalError::simple(TerminalErrorKind::Internal, "service state mutex poisoned")
            })?;
            if guard.revoked_owners.contains_key(&spec.owner) {
                return Err(TerminalError::simple(
                    TerminalErrorKind::OwnerRevoked,
                    "cannot spawn terminal session for a revoked owner",
                ));
            }
            if guard
                .closed_workspaces
                .contains_key(&(spec.owner.clone(), spec.workspace_id.clone()))
            {
                return Err(TerminalError::simple(
                    TerminalErrorKind::SessionClosed,
                    "workspace is closed for this owner",
                ));
            }
        }

        let (exe, cwd) = verify_trusted_shell_and_cwd(&spec.shell, &spec.working_directory)?;

        #[cfg(not(all(windows, target_arch = "x86_64")))]
        {
            let _ = (exe, cwd, cancellation_handle);
            Err(TerminalError::simple(
                TerminalErrorKind::UnsupportedPlatform,
                "ConPTY terminal service is only supported on Windows x64",
            ))
        }

        #[cfg(all(windows, target_arch = "x86_64"))]
        {
            let session_id = TerminalSessionId::generate();
            let generation = self.next_generation.fetch_add(1, Ordering::AcqRel);
            let descriptor = win_conpty::NativeSpawnDescriptor {
                executable: &exe,
                arguments: &spec.shell.arguments,
                working_directory: &cwd,
            };
            let session = windows_pty::ActivePtySession::spawn(
                spec,
                &descriptor,
                session_id.clone(),
                generation,
                Arc::clone(&self.sink),
                cancellation_handle,
                cancellation,
            )?;
            let info = session.info.clone();

            let mut guard = self.state.lock().map_err(|_| {
                TerminalError::simple(TerminalErrorKind::Internal, "service state mutex poisoned")
            })?;
            if guard.revoked_owners.contains_key(&spec.owner)
                || guard
                    .closed_workspaces
                    .contains_key(&(spec.owner.clone(), spec.workspace_id.clone()))
            {
                drop(guard);
                let report = session.teardown(TerminalExitReason::OwnerRevoked, true);
                return Err(TerminalError::with_cleanup(
                    TerminalErrorKind::OwnerRevoked,
                    "owner or workspace was revoked during spawn",
                    report.cleanup,
                ));
            }
            guard.sessions.insert(session_id, session);
            Ok(info)
        }
    }

    /// Writes UTF-8 or raw bytes to an active owner-bound session.
    pub fn write_input(
        &self,
        owner: &OwnerId,
        session_id: &TerminalSessionId,
        data: &[u8],
    ) -> Result<(), TerminalError> {
        if data.is_empty() {
            return Err(TerminalError::simple(
                TerminalErrorKind::InvalidInputPayload,
                "terminal input must not be empty",
            ));
        }
        #[cfg(not(all(windows, target_arch = "x86_64")))]
        {
            let _ = (owner, session_id);
            Err(TerminalError::simple(
                TerminalErrorKind::UnsupportedPlatform,
                "ConPTY terminal service is only supported on Windows x64",
            ))
        }
        #[cfg(all(windows, target_arch = "x86_64"))]
        {
            let session = self.lookup_owned_session(owner, session_id)?;
            let result = session.write_input(data);
            if let Err(ref err) = result {
                if matches!(
                    err.kind,
                    TerminalErrorKind::Cancelled
                        | TerminalErrorKind::OutputBackpressure
                        | TerminalErrorKind::OwnerRevoked
                ) {
                    self.remove_session(session_id);
                }
            }
            result
        }
    }

    /// Resizes an active owner-bound ConPTY session and verifies the applied size.
    pub fn resize(
        &self,
        owner: &OwnerId,
        session_id: &TerminalSessionId,
        size: TerminalSize,
    ) -> Result<TerminalSize, TerminalError> {
        let validated = TerminalSize::new(size.cols, size.rows)?;
        #[cfg(not(all(windows, target_arch = "x86_64")))]
        {
            let _ = (owner, session_id, validated);
            Err(TerminalError::simple(
                TerminalErrorKind::UnsupportedPlatform,
                "ConPTY terminal service is only supported on Windows x64",
            ))
        }
        #[cfg(all(windows, target_arch = "x86_64"))]
        {
            let session = self.lookup_owned_session(owner, session_id)?;
            session.resize(validated)
        }
    }

    /// Terminates an owner-bound session and verifies finite cleanup.
    pub fn kill(
        &self,
        owner: &OwnerId,
        session_id: &TerminalSessionId,
    ) -> Result<TerminalTeardownReport, TerminalError> {
        #[cfg(not(all(windows, target_arch = "x86_64")))]
        {
            let _ = (owner, session_id);
            Err(TerminalError::simple(
                TerminalErrorKind::UnsupportedPlatform,
                "ConPTY terminal service is only supported on Windows x64",
            ))
        }
        #[cfg(all(windows, target_arch = "x86_64"))]
        {
            let session = self.take_owned_session(owner, session_id)?;
            let report = session.teardown(TerminalExitReason::KilledByOwner, false);
            if report.cleanup != TerminalCleanupProof::SessionDrained {
                return Err(TerminalError::with_cleanup(
                    TerminalErrorKind::CleanupFailed,
                    "ConPTY session teardown did not complete cleanly",
                    report.cleanup,
                ));
            }
            Ok(report)
        }
    }

    /// Immediately revokes an owner (e.g. on window close), suppressing late events
    /// and tearing down all sessions belonging to that owner.
    pub fn revoke_owner(&self, owner: &OwnerId) -> Vec<TerminalTeardownReport> {
        let gen = self.next_generation.fetch_add(1, Ordering::AcqRel);
        #[cfg(all(windows, target_arch = "x86_64"))]
        let mut to_close = Vec::new();

        if let Ok(mut guard) = self.state.lock() {
            guard.revoked_owners.insert(owner.clone(), gen);
            #[cfg(all(windows, target_arch = "x86_64"))]
            {
                let ids: Vec<TerminalSessionId> = guard
                    .sessions
                    .iter()
                    .filter(|(_, s)| &s.owner == owner)
                    .map(|(id, _)| id.clone())
                    .collect();
                for id in ids {
                    if let Some(session) = guard.sessions.remove(&id) {
                        to_close.push(session);
                    }
                }
            }
        }

        #[cfg(all(windows, target_arch = "x86_64"))]
        {
            to_close
                .into_iter()
                .map(|s| s.teardown(TerminalExitReason::OwnerRevoked, true))
                .collect()
        }
        #[cfg(not(all(windows, target_arch = "x86_64")))]
        {
            Vec::new()
        }
    }

    /// Closes all terminal sessions for a specific `(owner, workspace_id)` pair.
    pub fn close_workspace(
        &self,
        owner: &OwnerId,
        workspace_id: &WorkspaceId,
    ) -> Vec<TerminalTeardownReport> {
        let gen = self.next_generation.fetch_add(1, Ordering::AcqRel);
        #[cfg(all(windows, target_arch = "x86_64"))]
        let mut to_close = Vec::new();

        if let Ok(mut guard) = self.state.lock() {
            guard
                .closed_workspaces
                .insert((owner.clone(), workspace_id.clone()), gen);
            #[cfg(all(windows, target_arch = "x86_64"))]
            {
                let ids: Vec<TerminalSessionId> = guard
                    .sessions
                    .iter()
                    .filter(|(_, s)| &s.owner == owner && &s.info.workspace_id == workspace_id)
                    .map(|(id, _)| id.clone())
                    .collect();
                for id in ids {
                    if let Some(session) = guard.sessions.remove(&id) {
                        to_close.push(session);
                    }
                }
            }
        }

        #[cfg(all(windows, target_arch = "x86_64"))]
        {
            to_close
                .into_iter()
                .map(|s| s.teardown(TerminalExitReason::WorkspaceClosed, true))
                .collect()
        }
        #[cfg(not(all(windows, target_arch = "x86_64")))]
        {
            Vec::new()
        }
    }

    #[cfg(all(windows, target_arch = "x86_64"))]
    fn lookup_owned_session(
        &self,
        owner: &OwnerId,
        session_id: &TerminalSessionId,
    ) -> Result<Arc<windows_pty::ActivePtySession>, TerminalError> {
        let guard = self.state.lock().map_err(|_| {
            TerminalError::simple(TerminalErrorKind::Internal, "service state mutex poisoned")
        })?;
        if guard.revoked_owners.contains_key(owner) {
            return Err(TerminalError::simple(
                TerminalErrorKind::OwnerRevoked,
                "owner has been revoked",
            ));
        }
        let Some(session) = guard.sessions.get(session_id) else {
            return Err(TerminalError::simple(
                TerminalErrorKind::SessionNotFound,
                format!("terminal session {session_id} not found"),
            ));
        };
        if &session.owner != owner {
            return Err(TerminalError::simple(
                TerminalErrorKind::OwnerMismatch,
                "terminal session belongs to another owner",
            ));
        }
        Ok(Arc::clone(session))
    }

    #[cfg(all(windows, target_arch = "x86_64"))]
    fn take_owned_session(
        &self,
        owner: &OwnerId,
        session_id: &TerminalSessionId,
    ) -> Result<Arc<windows_pty::ActivePtySession>, TerminalError> {
        let mut guard = self.state.lock().map_err(|_| {
            TerminalError::simple(TerminalErrorKind::Internal, "service state mutex poisoned")
        })?;
        if guard.revoked_owners.contains_key(owner) {
            return Err(TerminalError::simple(
                TerminalErrorKind::OwnerRevoked,
                "owner has been revoked",
            ));
        }
        let Some(existing) = guard.sessions.get(session_id) else {
            return Err(TerminalError::simple(
                TerminalErrorKind::SessionNotFound,
                format!("terminal session {session_id} not found"),
            ));
        };
        if &existing.owner != owner {
            return Err(TerminalError::simple(
                TerminalErrorKind::OwnerMismatch,
                "terminal session belongs to another owner",
            ));
        }
        Ok(guard.sessions.remove(session_id).expect("checked present"))
    }

    #[cfg(all(windows, target_arch = "x86_64"))]
    fn remove_session(&self, session_id: &TerminalSessionId) {
        if let Ok(mut guard) = self.state.lock() {
            let _ = guard.sessions.remove(session_id);
        }
    }

    #[cfg(all(test, windows, target_arch = "x86_64"))]
    pub(crate) fn session_job_process_group(
        &self,
        session_id: &TerminalSessionId,
    ) -> Option<win_conpty::JobProcessGroup> {
        let guard = self.state.lock().ok()?;
        guard
            .sessions
            .get(session_id)
            .map(|s| s.job_process_group())
    }

    #[cfg(all(test, windows, target_arch = "x86_64"))]
    pub(crate) fn session_io_progress(&self, session_id: &TerminalSessionId) -> Option<String> {
        let guard = self.state.lock().ok()?;
        guard
            .sessions
            .get(session_id)
            .map(|session| session.io_progress())
    }
}

#[cfg(test)]
#[path = "../../tests/unit/terminal_service.rs"]
mod tests;
