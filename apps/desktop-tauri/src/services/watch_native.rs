// SPDX-License-Identifier: Apache-2.0
//! Windows native directory watcher substrate (`ReadDirectoryChangesW`) for G2.
//!
//! # Security & Ownership Guarantees
//! - Never opens or reopens untrusted string paths from the renderer; requires a
//!   [`VerifiedDirectoryHandle`] supplied by the trusted filesystem coordinator.
//! - Requires a [`TrustedDirectoryRoot`] capability from the trusted filesystem
//!   coordinator. Handle attributes alone cannot prove that an arbitrary handle
//!   was not opened through a junction or symlink.
//! - Safely duplicates (`DuplicateHandle`) ownership of the kernel handle into
//!   the watch worker and closes all handles on normal stop, cancel, error, or
//!   thread-spawn failure.
//! - Uses `NULL` for `ReadDirectoryChangesW`'s byte-count argument when issuing
//!   overlapped I/O, and keeps both the notification buffer and `OVERLAPPED`
//!   alive until completion has been drained.
//! - Parses `FILE_NOTIFY_INFORMATION` records with strict bounds, alignment,
//!   action, UTF-16, and [`RelativePath`] lexical validation, rejecting traversal,
//!   alternate data streams (`:`), control characters, and reserved device names,
//!   then delegates handle-relative containment/reparse checks to the explicit
//!   [`WatchValidatorSeam`].
//! - Pairs `FILE_ACTION_RENAMED_OLD_NAME` / `FILE_ACTION_RENAMED_NEW_NAME` and
//!   coalesces rapid bursts deterministically while preserving rename lineage.
//! - Never drops events silently: kernel buffer overflow (`bytes_returned == 0`
//!   or `ERROR_NOTIFY_ENUM_DIR`), corrupt notification buffers, or bounded queue
//!   saturation latch an explicit [`WatchSignal::ResyncRequired`] or
//!   [`WatchSignal::Failure`].
//! - Binds every subscription and drained signal to
//!   `(OwnerId, WorkspaceId, WatchGeneration)`.
//! - Registry reservations make subscription replacement, workspace
//!   unsubscription, and owner revocation linearizable. Revocation cancels and
//!   joins active workers and waits for any in-flight start to finish or cancel.
//!   `stop()` and owner/workspace revocation idempotently block subsequent
//!   emissions, cancel pending `ReadDirectoryChangesW` via `CancelIoEx`, drain
//!   overlapped I/O completion safely before buffer drop, and join the thread.

use std::collections::{HashMap, HashSet, VecDeque};
use std::error::Error;
use std::fmt;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, OnceLock};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

#[cfg(windows)]
use crate::state::recent::{ByHandleFileInformation, GetFileInformationByHandle};
#[cfg(windows)]
use std::os::windows::io::{AsRawHandle, BorrowedHandle, FromRawHandle, OwnedHandle, RawHandle};

use crate::schemas::protocol::{FileEvent, FileEventKind, FileWatchFailure, OwnerId, WorkspaceId};
use crate::shared::relative_path::{PathError, RelativePath};

/// Fixed byte size for the aligned `ReadDirectoryChangesW` buffer (64 KiB).
pub const NOTIFY_BUFFER_BYTES: usize = 64 * 1024;

/// Default maximum number of coalesced items buffered in a subscription queue
/// before latching [`ResyncReason::EventQueueOverflow`].
pub const DEFAULT_MAX_QUEUED_EVENTS: usize = 1024;

/// Upper bound on records parsed from a single notification buffer to prevent
/// cyclic offset loops or pathological exhaustion.
pub const MAX_RECORDS_PER_BUFFER: usize = 8192;

/// Default maximum relative path segment depth before reporting
/// [`FileWatchFailure::TreeTooDeep`].
pub const DEFAULT_MAX_TREE_DEPTH: usize = 64;

/// Watch-level root identity verification cadence (5 seconds).
pub const IDENTITY_CHECK_INTERVAL: Duration = Duration::from_secs(5);

/// Watch-level full workspace reconcile cadence (60 seconds).
pub const RECONCILE_INTERVAL: Duration = Duration::from_secs(60);

/// Raw Windows `FILE_ACTION_*` constants.
pub const FILE_ACTION_ADDED: u32 = 0x0000_0001;
pub const FILE_ACTION_REMOVED: u32 = 0x0000_0002;
pub const FILE_ACTION_MODIFIED: u32 = 0x0000_0003;
pub const FILE_ACTION_RENAMED_OLD_NAME: u32 = 0x0000_0004;
pub const FILE_ACTION_RENAMED_NEW_NAME: u32 = 0x0000_0005;

/// Default `ReadDirectoryChangesW` notification filter covering file/directory
/// name, attribute, size, last-write, and creation changes.
pub const DEFAULT_NOTIFY_FILTER: u32 = 0x0000_0001 // FILE_NOTIFY_CHANGE_FILE_NAME
    | 0x0000_0002 // FILE_NOTIFY_CHANGE_DIR_NAME
    | 0x0000_0004 // FILE_NOTIFY_CHANGE_ATTRIBUTES
    | 0x0000_0008 // FILE_NOTIFY_CHANGE_SIZE
    | 0x0000_0010 // FILE_NOTIFY_CHANGE_LAST_WRITE
    | 0x0000_0040; // FILE_NOTIFY_CHANGE_CREATION

const MIN_WATCH_INTERVAL: Duration = Duration::from_millis(1);
const MAX_WATCH_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);

/// Monotonic non-zero generation token bound to a watch subscription.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd, Hash)]
pub struct WatchGeneration(u64);

impl WatchGeneration {
    pub const fn new(value: u64) -> Option<Self> {
        if value == 0 {
            None
        } else {
            Some(Self(value))
        }
    }

    pub const fn get(self) -> u64 {
        self.0
    }
}

impl fmt::Display for WatchGeneration {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

/// Composite subscription identity binding window owner, workspace, and generation.
#[derive(Clone, Debug, Eq, PartialEq, Hash)]
pub struct WatchSubscriptionKey {
    pub owner: OwnerId,
    pub workspace_id: WorkspaceId,
    pub generation: WatchGeneration,
}

/// Pinned volume + file-ID identity of a verified Windows directory handle.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash)]
pub struct DirectoryIdentity {
    pub volume_serial_number: u32,
    pub file_index: u64,
}

/// Validated Windows `FILE_ACTION_*` discriminant.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RawNotifyAction {
    Added,
    Removed,
    Modified,
    RenamedOldName,
    RenamedNewName,
}

impl RawNotifyAction {
    pub fn from_raw(action: u32) -> Result<Self, NotifyParseError> {
        match action {
            FILE_ACTION_ADDED => Ok(Self::Added),
            FILE_ACTION_REMOVED => Ok(Self::Removed),
            FILE_ACTION_MODIFIED => Ok(Self::Modified),
            FILE_ACTION_RENAMED_OLD_NAME => Ok(Self::RenamedOldName),
            FILE_ACTION_RENAMED_NEW_NAME => Ok(Self::RenamedNewName),
            other => Err(NotifyParseError::UnknownAction(other)),
        }
    }
}

/// A single validated record extracted from a `FILE_NOTIFY_INFORMATION` buffer.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ParsedNotifyRecord {
    pub action: RawNotifyAction,
    pub path: RelativePath,
}

/// Coalesced native change item with optional rename source lineage.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WatchBatchItem {
    pub path: RelativePath,
    pub kind: FileEventKind,
    pub renamed_from: Option<RelativePath>,
}

impl WatchBatchItem {
    pub fn to_file_event(&self, workspace_id: &WorkspaceId) -> FileEvent {
        FileEvent {
            workspace_id: workspace_id.clone(),
            path: self.path.clone(),
            kind: self.kind,
        }
    }
}

/// Reason why an explicit workspace resync/reconcile is required.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ResyncReason {
    /// `ReadDirectoryChangesW` returned 0 bytes or `ERROR_NOTIFY_ENUM_DIR`.
    KernelBufferOverflow,
    /// Bounded in-memory event queue reached `max_queued_events`.
    EventQueueOverflow,
    /// A `FILE_NOTIFY_INFORMATION` buffer failed structural/UTF-16/lexical validation.
    CorruptNotifyBuffer(NotifyParseError),
    /// Periodic 60-second reconcile interval elapsed.
    PeriodicReconcileDue,
}

/// Signals emitted by [`NativeWatchSubscription`] to the coordinator/adapter.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum WatchSignal {
    /// Coalesced file event ready for emission to the bound `OwnerId`.
    Event {
        owner: OwnerId,
        generation: WatchGeneration,
        event: FileEvent,
        renamed_from: Option<RelativePath>,
    },
    /// Explicit resync request; the coordinator must run handle-pinned reconcile
    /// or transition to a terminal `FileWatchFailure` (never silent event loss).
    ResyncRequired {
        owner: OwnerId,
        workspace_id: WorkspaceId,
        generation: WatchGeneration,
        reason: ResyncReason,
    },
    /// Terminal watch failure matching the `DesktopPort.watchFiles` contract.
    Failure {
        owner: OwnerId,
        workspace_id: WorkspaceId,
        generation: WatchGeneration,
        failure: FileWatchFailure,
    },
}

/// Errors produced when validating a raw `FILE_NOTIFY_INFORMATION` buffer.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum NotifyParseError {
    EmptyOrOverflowBuffer,
    TruncatedHeader {
        offset: usize,
    },
    MisalignedOffset {
        offset: usize,
    },
    MalformedNextOffset {
        offset: usize,
        next_entry_offset: u32,
    },
    EmptyFileName {
        offset: usize,
    },
    OddUtf16ByteLength {
        offset: usize,
        byte_len: u32,
    },
    FileNameOutOfBounds {
        offset: usize,
        byte_len: u32,
    },
    UnknownAction(u32),
    InvalidUtf16 {
        offset: usize,
    },
    RootedOrSlashPath {
        raw: String,
    },
    AlternateDataStreamOrColon {
        raw: String,
    },
    PathTraversal {
        raw: String,
    },
    InvalidRelativePath {
        raw: String,
        error: PathError,
    },
    TooManyRecords {
        limit: usize,
    },
}

impl NotifyParseError {
    /// Maps a parse error to the contract [`FileWatchFailure`] code when treated
    /// as a terminal failure.
    pub fn to_watch_failure(&self) -> FileWatchFailure {
        match self {
            Self::PathTraversal { .. }
            | Self::RootedOrSlashPath { .. }
            | Self::AlternateDataStreamOrColon { .. } => FileWatchFailure::LinkNotAllowed,
            _ => FileWatchFailure::FileOperationFailed,
        }
    }
}

impl fmt::Display for NotifyParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyOrOverflowBuffer => {
                write!(f, "empty or overflow FILE_NOTIFY_INFORMATION buffer")
            }
            Self::TruncatedHeader { offset } => {
                write!(
                    f,
                    "truncated FILE_NOTIFY_INFORMATION header at offset {offset}"
                )
            }
            Self::MisalignedOffset { offset } => {
                write!(f, "misaligned FILE_NOTIFY_INFORMATION offset {offset}")
            }
            Self::MalformedNextOffset {
                offset,
                next_entry_offset,
            } => write!(
                f,
                "malformed NextEntryOffset {next_entry_offset} at offset {offset}"
            ),
            Self::EmptyFileName { offset } => {
                write!(f, "empty FileNameLength at offset {offset}")
            }
            Self::OddUtf16ByteLength { offset, byte_len } => write!(
                f,
                "odd UTF-16 FileNameLength ({byte_len} bytes) at offset {offset}"
            ),
            Self::FileNameOutOfBounds { offset, byte_len } => write!(
                f,
                "FileNameLength ({byte_len} bytes) out of bounds at offset {offset}"
            ),
            Self::UnknownAction(action) => {
                write!(f, "unknown FILE_ACTION discriminant: {action:#x}")
            }
            Self::InvalidUtf16 { offset } => {
                write!(f, "invalid UTF-16 sequence in FileName at offset {offset}")
            }
            Self::RootedOrSlashPath { raw } => {
                write!(f, "rooted or slash-bounded notification path: {raw:?}")
            }
            Self::AlternateDataStreamOrColon { raw } => {
                write!(f, "colon or NTFS alternate data stream rejected: {raw:?}")
            }
            Self::PathTraversal { raw } => {
                write!(f, "relative traversal segment rejected: {raw:?}")
            }
            Self::InvalidRelativePath { raw, error } => {
                write!(f, "invalid notification path {raw:?}: {error}")
            }
            Self::TooManyRecords { limit } => {
                write!(f, "notification buffer exceeded {limit} records")
            }
        }
    }
}

impl Error for NotifyParseError {}

/// Errors returned when verifying or duplicating a native directory handle or
/// interacting with a subscription.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum WatchNativeError {
    NullOrInvalidHandle,
    NotADiskHandle(u32),
    NotADirectory,
    ReparsePointNotAllowed,
    CleanupCapacityExceeded,
    CleanupUnavailable,
    SubscriptionSuperseded,
    OwnerRevoked,
    GenerationExhausted,
    IdentityMismatch {
        expected: DirectoryIdentity,
        actual: DirectoryIdentity,
    },
    Win32Error {
        operation: &'static str,
        code: u32,
    },
    ThreadSpawnFailed(String),
    AccessDenied(WatchAccessError),
}

impl WatchNativeError {
    pub fn to_watch_failure(&self) -> FileWatchFailure {
        match self {
            Self::ReparsePointNotAllowed => FileWatchFailure::LinkNotAllowed,
            Self::IdentityMismatch { .. } | Self::NotADirectory => FileWatchFailure::StaleWorkspace,
            _ => FileWatchFailure::FileOperationFailed,
        }
    }
}

impl fmt::Display for WatchNativeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NullOrInvalidHandle => write!(f, "null or INVALID_HANDLE_VALUE directory handle"),
            Self::NotADiskHandle(kind) => write!(f, "handle is not FILE_TYPE_DISK (type={kind})"),
            Self::NotADirectory => write!(f, "handle does not refer to a directory"),
            Self::ReparsePointNotAllowed => {
                write!(f, "directory handle is a reparse point (symlink/junction)")
            }
            Self::CleanupCapacityExceeded => {
                write!(f, "native watch cleanup capacity is exhausted")
            }
            Self::CleanupUnavailable => {
                write!(f, "native watch cleanup reaper is unavailable")
            }
            Self::SubscriptionSuperseded => {
                write!(f, "watch subscription was superseded before installation")
            }
            Self::OwnerRevoked => write!(f, "watch owner is being revoked"),
            Self::GenerationExhausted => write!(f, "watch generation space is exhausted"),
            Self::IdentityMismatch { expected, actual } => write!(
                f,
                "directory handle identity changed (expected {expected:?}, got {actual:?})"
            ),
            Self::Win32Error { operation, code } => {
                write!(f, "{operation} failed with Win32 error {code}")
            }
            Self::ThreadSpawnFailed(msg) => write!(f, "watch worker spawn failed: {msg}"),
            Self::AccessDenied(err) => write!(f, "{err}"),
        }
    }
}

impl Error for WatchNativeError {}

/// Access control errors when polling or draining a subscription.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum WatchAccessError {
    OwnerMismatch,
    WorkspaceMismatch,
    StaleGeneration {
        expected: WatchGeneration,
        actual: WatchGeneration,
    },
    SubscriptionStopped,
}

impl fmt::Display for WatchAccessError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::OwnerMismatch => write!(f, "subscription belongs to a different window owner"),
            Self::WorkspaceMismatch => write!(f, "subscription belongs to a different workspace"),
            Self::StaleGeneration { expected, actual } => write!(
                f,
                "stale watch generation {actual} (active generation is {expected})"
            ),
            Self::SubscriptionStopped => {
                write!(f, "watch subscription has been stopped or revoked")
            }
        }
    }
}

impl Error for WatchAccessError {}

/// Disposition returned by the trusted filesystem validator seam for each
/// candidate notification record or periodic check.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ValidatorDisposition {
    /// Path is contained within the pinned workspace root and is not a link/reparse traversal.
    Accept,
    /// Path is benignly ignored by policy (e.g., transient temp file filtered by coordinator).
    Ignore,
    /// Path or workspace violated containment or resource policy; fail subscription.
    Fail(FileWatchFailure),
    /// Coordinator requests an immediate full snapshot resync.
    RequestResync,
}

/// Explicit seam between the Windows native `ReadDirectoryChangesW` substrate
/// and the trusted filesystem validator / workspace coordinator (`windows_files` / `filesystem`).
///
/// # Coordinator Responsibilities
/// Implementations used by the production adapter must be bound to this exact
/// root identity and the active workspace registration. They must validate each
/// path component without following reparse points, enforce workspace depth and
/// count limits, and detect when the registered root path has been renamed or
/// replaced. This trait is an integration seam, not a containment proof.
///
/// 1. `validate_notified_path`: Given the pinned root identity and a lexically
///    validated [`RelativePath`], perform the component-by-component checks above.
/// 2. `verify_workspace_identity` (called every [`IDENTITY_CHECK_INTERVAL`] = 5s):
///    Confirm that the pinned handle still matches the active workspace registration
///    and that the registered root has not been unlinked or replaced.
/// 3. `on_reconcile_due` (called every [`RECONCILE_INTERVAL`] = 60s):
///    Either return reconciled [`WatchBatchItem`] diffs from a handle-pinned tree scan
///    (without following reparse points) or `None` to emit [`WatchSignal::ResyncRequired`]
///    so the upper coordinator schedules a full snapshot comparison.
pub trait WatchValidatorSeam: Send + Sync + 'static {
    /// Validates a notified relative path against the pinned root directory.
    fn validate_notified_path(
        &self,
        root_identity: DirectoryIdentity,
        path: &RelativePath,
        action: RawNotifyAction,
    ) -> ValidatorDisposition;

    /// Called every 5 seconds with the live handle identity read via
    /// `GetFileInformationByHandle`.
    fn verify_workspace_identity(
        &self,
        pinned_identity: DirectoryIdentity,
        live_identity: DirectoryIdentity,
    ) -> Result<(), FileWatchFailure> {
        if pinned_identity != live_identity {
            return Err(FileWatchFailure::StaleWorkspace);
        }
        Ok(())
    }

    /// Called every 60 seconds for periodic drift reconciliation.
    ///
    /// Returning `Ok(None)` emits [`WatchSignal::ResyncRequired`] with
    /// [`ResyncReason::PeriodicReconcileDue`] so the outer filesystem coordinator
    /// runs its handle-pinned snapshot scan (never faking enumeration here).
    fn on_reconcile_due(
        &self,
        _root_identity: DirectoryIdentity,
    ) -> Result<Option<Vec<WatchBatchItem>>, FileWatchFailure> {
        Ok(None)
    }
}

/// Minimal depth validator for tests and local substrate use. It does not establish
/// component containment, bind an active workspace registration, or detect a root
/// path that was renamed/replaced while its handle remains open. It is not a
/// production `WatchValidatorSeam`.
#[derive(Clone, Copy, Debug)]
pub struct DefaultWatchValidator {
    pub max_depth: usize,
}

impl Default for DefaultWatchValidator {
    fn default() -> Self {
        Self {
            max_depth: DEFAULT_MAX_TREE_DEPTH,
        }
    }
}

impl WatchValidatorSeam for DefaultWatchValidator {
    fn validate_notified_path(
        &self,
        _root_identity: DirectoryIdentity,
        path: &RelativePath,
        _action: RawNotifyAction,
    ) -> ValidatorDisposition {
        let depth = path.as_str().split('/').count();
        if depth > self.max_depth {
            return ValidatorDisposition::Fail(FileWatchFailure::TreeTooDeep);
        }
        ValidatorDisposition::Accept
    }
}

/// Tuning parameters for [`NativeWatchSubscription`].
#[derive(Clone, Copy, Debug)]
pub struct WatchConfig {
    pub notify_filter: u32,
    pub watch_subtree: bool,
    pub max_queued_events: usize,
    pub identity_check_interval: Duration,
    pub reconcile_interval: Duration,
}

impl Default for WatchConfig {
    fn default() -> Self {
        Self {
            notify_filter: DEFAULT_NOTIFY_FILTER,
            watch_subtree: true,
            max_queued_events: DEFAULT_MAX_QUEUED_EVENTS,
            identity_check_interval: IDENTITY_CHECK_INTERVAL,
            reconcile_interval: RECONCILE_INTERVAL,
        }
    }
}

// ---- Strict FILE_NOTIFY_INFORMATION Parser & Burst Coalescer -------------

/// Normalizes a Windows relative notification path (`\` separators) and
/// validates it against [`RelativePath`] rules plus explicit traversal and
/// ADS (`:`) checks.
pub fn normalize_and_validate_notify_path(raw: &str) -> Result<RelativePath, NotifyParseError> {
    if raw.is_empty() {
        return Err(NotifyParseError::InvalidRelativePath {
            raw: String::new(),
            error: PathError::Empty,
        });
    }
    if raw.starts_with('\\') || raw.starts_with('/') || raw.ends_with('\\') || raw.ends_with('/') {
        return Err(NotifyParseError::RootedOrSlashPath {
            raw: raw.to_owned(),
        });
    }
    if raw.contains(':') {
        return Err(NotifyParseError::AlternateDataStreamOrColon {
            raw: raw.to_owned(),
        });
    }

    let normalized = raw.replace('\\', "/");
    for segment in normalized.split('/') {
        if segment == "." || segment == ".." {
            return Err(NotifyParseError::PathTraversal {
                raw: raw.to_owned(),
            });
        }
    }

    match RelativePath::parse(&normalized) {
        Ok(path) => Ok(path),
        Err(PathError::RelativeSegment) => Err(NotifyParseError::PathTraversal {
            raw: raw.to_owned(),
        }),
        Err(PathError::ForbiddenCharacter(':')) => {
            Err(NotifyParseError::AlternateDataStreamOrColon {
                raw: raw.to_owned(),
            })
        }
        Err(PathError::LeadingSlash) => Err(NotifyParseError::RootedOrSlashPath {
            raw: raw.to_owned(),
        }),
        Err(error) => Err(NotifyParseError::InvalidRelativePath {
            raw: raw.to_owned(),
            error,
        }),
    }
}

/// Parses a raw `FILE_NOTIFY_INFORMATION` byte buffer returned by
/// `ReadDirectoryChangesW`.
///
/// Rejects empty buffers, misaligned offsets, truncated headers, backwards or
/// non-advancing `NextEntryOffset` values, out-of-bounds `FileNameLength`,
/// odd UTF-16 byte lengths, unpaired UTF-16 surrogates, unknown actions,
/// rooted/ADS/traversal paths, and buffers exceeding [`MAX_RECORDS_PER_BUFFER`].
pub fn parse_notify_buffer(buf: &[u8]) -> Result<Vec<ParsedNotifyRecord>, NotifyParseError> {
    if buf.is_empty() {
        return Err(NotifyParseError::EmptyOrOverflowBuffer);
    }

    let mut records = Vec::new();
    let mut offset = 0usize;

    loop {
        if records.len() >= MAX_RECORDS_PER_BUFFER {
            return Err(NotifyParseError::TooManyRecords {
                limit: MAX_RECORDS_PER_BUFFER,
            });
        }
        if !offset.is_multiple_of(4) {
            return Err(NotifyParseError::MisalignedOffset { offset });
        }
        let header_end = offset
            .checked_add(12)
            .ok_or(NotifyParseError::TruncatedHeader { offset })?;
        if header_end > buf.len() {
            return Err(NotifyParseError::TruncatedHeader { offset });
        }

        let next_entry_offset = u32::from_ne_bytes([
            buf[offset],
            buf[offset + 1],
            buf[offset + 2],
            buf[offset + 3],
        ]);
        let raw_action = u32::from_ne_bytes([
            buf[offset + 4],
            buf[offset + 5],
            buf[offset + 6],
            buf[offset + 7],
        ]);
        let file_name_length = u32::from_ne_bytes([
            buf[offset + 8],
            buf[offset + 9],
            buf[offset + 10],
            buf[offset + 11],
        ]);

        if file_name_length == 0 {
            return Err(NotifyParseError::EmptyFileName { offset });
        }
        if !file_name_length.is_multiple_of(2) {
            return Err(NotifyParseError::OddUtf16ByteLength {
                offset,
                byte_len: file_name_length,
            });
        }

        let name_end = header_end.checked_add(file_name_length as usize).ok_or(
            NotifyParseError::FileNameOutOfBounds {
                offset,
                byte_len: file_name_length,
            },
        )?;
        if name_end > buf.len() {
            return Err(NotifyParseError::FileNameOutOfBounds {
                offset,
                byte_len: file_name_length,
            });
        }

        let next_offset = if next_entry_offset == 0 {
            None
        } else {
            let min_stride = 12u32.saturating_add(file_name_length);
            if next_entry_offset < min_stride || !next_entry_offset.is_multiple_of(4) {
                return Err(NotifyParseError::MalformedNextOffset {
                    offset,
                    next_entry_offset,
                });
            }
            let next = offset.checked_add(next_entry_offset as usize).ok_or(
                NotifyParseError::MalformedNextOffset {
                    offset,
                    next_entry_offset,
                },
            )?;
            if next >= buf.len() {
                return Err(NotifyParseError::MalformedNextOffset {
                    offset,
                    next_entry_offset,
                });
            }
            Some(next)
        };

        let action = RawNotifyAction::from_raw(raw_action)?;
        let name_bytes = &buf[header_end..name_end];
        let mut utf16_units = Vec::with_capacity(name_bytes.len() / 2);
        for pair in name_bytes.chunks_exact(2) {
            utf16_units.push(u16::from_ne_bytes([pair[0], pair[1]]));
        }
        let raw_string = String::from_utf16(&utf16_units)
            .map_err(|_| NotifyParseError::InvalidUtf16 { offset })?;
        let path = normalize_and_validate_notify_path(&raw_string)?;

        records.push(ParsedNotifyRecord { action, path });

        match next_offset {
            Some(next) => offset = next,
            None => break,
        }
    }

    Ok(records)
}

/// Pairs `RenamedOldName` / `RenamedNewName` records and coalesces burst
/// notifications into deterministic [`WatchBatchItem`] entries.
///
/// - Adjacent `RenamedOldName(old)` + `RenamedNewName(new)` are paired:
///   `old` emits `Removed` (unless `old == new`) and `new` emits `Changed` with
///   `renamed_from: Some(old)`.
/// - Unpaired `RenamedOldName(old)` (e.g., moved outside watched root) emits `Removed`.
/// - Unpaired `RenamedNewName(new)` (e.g., moved into watched root) emits `Changed`.
/// - Chained renames `a -> b -> c` within the same burst preserve `renamed_from: Some(a)`
///   on `c` and keep `a` as `Removed`.
pub fn pair_and_coalesce_records(records: &[ParsedNotifyRecord]) -> Vec<WatchBatchItem> {
    let mut index_by_path: HashMap<RelativePath, usize> = HashMap::new();
    let mut items: Vec<WatchBatchItem> = Vec::new();
    let mut pending_old: Option<RelativePath> = None;

    fn upsert(
        index_by_path: &mut HashMap<RelativePath, usize>,
        items: &mut Vec<WatchBatchItem>,
        path: RelativePath,
        kind: FileEventKind,
        renamed_from: Option<RelativePath>,
    ) {
        if let Some(&idx) = index_by_path.get(&path) {
            let existing = &mut items[idx];
            existing.kind = kind;
            if renamed_from.is_some() {
                existing.renamed_from = renamed_from;
            } else if kind == FileEventKind::Removed {
                existing.renamed_from = None;
            }
        } else {
            let idx = items.len();
            index_by_path.insert(path.clone(), idx);
            items.push(WatchBatchItem {
                path,
                kind,
                renamed_from,
            });
        }
    }

    for record in records {
        match record.action {
            RawNotifyAction::RenamedOldName => {
                if let Some(prev_old) = pending_old.take() {
                    upsert(
                        &mut index_by_path,
                        &mut items,
                        prev_old,
                        FileEventKind::Removed,
                        None,
                    );
                }
                pending_old = Some(record.path.clone());
            }
            RawNotifyAction::RenamedNewName => {
                if let Some(old_path) = pending_old.take() {
                    if old_path == record.path {
                        upsert(
                            &mut index_by_path,
                            &mut items,
                            record.path.clone(),
                            FileEventKind::Changed,
                            None,
                        );
                    } else {
                        let origin = index_by_path
                            .get(&old_path)
                            .and_then(|&idx| items[idx].renamed_from.clone())
                            .unwrap_or_else(|| old_path.clone());
                        upsert(
                            &mut index_by_path,
                            &mut items,
                            old_path,
                            FileEventKind::Removed,
                            None,
                        );
                        upsert(
                            &mut index_by_path,
                            &mut items,
                            record.path.clone(),
                            FileEventKind::Changed,
                            Some(origin),
                        );
                    }
                } else {
                    upsert(
                        &mut index_by_path,
                        &mut items,
                        record.path.clone(),
                        FileEventKind::Changed,
                        None,
                    );
                }
            }
            RawNotifyAction::Added | RawNotifyAction::Modified => {
                if let Some(prev_old) = pending_old.take() {
                    upsert(
                        &mut index_by_path,
                        &mut items,
                        prev_old,
                        FileEventKind::Removed,
                        None,
                    );
                }
                upsert(
                    &mut index_by_path,
                    &mut items,
                    record.path.clone(),
                    FileEventKind::Changed,
                    None,
                );
            }
            RawNotifyAction::Removed => {
                if let Some(prev_old) = pending_old.take() {
                    upsert(
                        &mut index_by_path,
                        &mut items,
                        prev_old,
                        FileEventKind::Removed,
                        None,
                    );
                }
                upsert(
                    &mut index_by_path,
                    &mut items,
                    record.path.clone(),
                    FileEventKind::Removed,
                    None,
                );
            }
        }
    }

    if let Some(prev_old) = pending_old.take() {
        upsert(
            &mut index_by_path,
            &mut items,
            prev_old,
            FileEventKind::Removed,
            None,
        );
    }

    items
}

// ---- Windows Kernel Handle Verification & FFI ----------------------------

#[cfg(windows)]
mod win32 {
    use std::os::windows::io::RawHandle;

    pub type Bool = i32;
    pub const INVALID_HANDLE_VALUE: RawHandle = -1isize as RawHandle;

    #[cfg(test)]
    pub const FILE_LIST_DIRECTORY: u32 = 0x0000_0001;
    #[cfg(test)]
    pub const FILE_READ_ATTRIBUTES: u32 = 0x0000_0080;
    #[cfg(test)]
    pub const SYNCHRONIZE: u32 = 0x0010_0000;

    #[cfg(test)]
    pub const FILE_SHARE_READ: u32 = 0x0000_0001;
    #[cfg(test)]
    pub const FILE_SHARE_WRITE: u32 = 0x0000_0002;
    #[cfg(test)]
    pub const FILE_SHARE_DELETE: u32 = 0x0000_0004;

    #[cfg(test)]
    pub const OPEN_EXISTING: u32 = 3;
    #[cfg(test)]
    pub const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
    #[cfg(test)]
    pub const FILE_FLAG_OVERLAPPED: u32 = 0x4000_0000;
    #[cfg(test)]
    pub const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;

    pub const FILE_ATTRIBUTE_DIRECTORY: u32 = 0x0000_0010;
    pub const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
    pub const FILE_TYPE_DISK: u32 = 0x0001;

    pub const DUPLICATE_SAME_ACCESS: u32 = 0x0000_0002;

    pub const ERROR_OPERATION_ABORTED: u32 = 995;
    pub const ERROR_IO_PENDING: u32 = 997;
    pub const ERROR_NOTIFY_ENUM_DIR: u32 = 1022;

    pub const WAIT_OBJECT_0: u32 = 0;
    pub const WAIT_TIMEOUT: u32 = 0x0000_0102;

    #[derive(Clone, Copy, Default)]
    #[repr(C)]
    pub struct Overlapped {
        pub internal: usize,
        pub internal_high: usize,
        pub offset: u32,
        pub offset_high: u32,
        pub h_event: RawHandle,
    }

    #[link(name = "kernel32")]
    extern "system" {
        pub fn GetLastError() -> u32;
        pub fn GetCurrentProcess() -> RawHandle;
        pub fn DuplicateHandle(
            h_source_process_handle: RawHandle,
            h_source_handle: RawHandle,
            h_target_process_handle: RawHandle,
            lp_target_handle: *mut RawHandle,
            dw_desired_access: u32,
            b_inherit_handle: Bool,
            dw_options: u32,
        ) -> Bool;
        pub fn GetFileType(h_file: RawHandle) -> u32;
        pub fn CreateEventW(
            lp_event_attributes: *const core::ffi::c_void,
            b_manual_reset: Bool,
            b_initial_state: Bool,
            lp_name: *const u16,
        ) -> RawHandle;
        pub fn SetEvent(h_event: RawHandle) -> Bool;
        pub fn ResetEvent(h_event: RawHandle) -> Bool;
        pub fn WaitForMultipleObjects(
            n_count: u32,
            lp_handles: *const RawHandle,
            b_wait_all: Bool,
            dw_milliseconds: u32,
        ) -> u32;
        pub fn ReadDirectoryChangesW(
            h_directory: RawHandle,
            lp_buffer: *mut core::ffi::c_void,
            n_buffer_length: u32,
            b_watch_subtree: Bool,
            dw_notify_filter: u32,
            lp_bytes_returned: *mut u32,
            lp_overlapped: *mut Overlapped,
            lp_completion_routine: *const core::ffi::c_void,
        ) -> Bool;
        pub fn GetOverlappedResult(
            h_file: RawHandle,
            lp_overlapped: *const Overlapped,
            lp_number_of_bytes_transferred: *mut u32,
            b_wait: Bool,
        ) -> Bool;
        pub fn CancelIoEx(h_file: RawHandle, lp_overlapped: *const Overlapped) -> Bool;
        #[cfg(test)]
        pub fn CreateFileW(
            lp_file_name: *const u16,
            dw_desired_access: u32,
            dw_share_mode: u32,
            lp_security_attributes: *const core::ffi::c_void,
            dw_creation_disposition: u32,
            dw_flags_and_attributes: u32,
            h_template_file: RawHandle,
        ) -> RawHandle;
    }
}

/// Inspects a raw Windows handle via `GetFileType` and `GetFileInformationByHandle`.
///
/// This verifies the final opened object is a disk directory and not itself a
/// reparse point. It cannot establish whether an arbitrary handle was opened
/// through a junction or symlink; use [`TrustedDirectoryRoot`] for that proof.
#[cfg(windows)]
pub fn query_verified_directory_identity(
    handle: BorrowedHandle<'_>,
) -> Result<DirectoryIdentity, WatchNativeError> {
    let raw = handle.as_raw_handle();
    if raw.is_null() || raw == win32::INVALID_HANDLE_VALUE {
        return Err(WatchNativeError::NullOrInvalidHandle);
    }

    // SAFETY: `raw` is a borrowed handle checked for null/INVALID_HANDLE_VALUE.
    let file_type = unsafe { win32::GetFileType(raw) };
    if file_type != win32::FILE_TYPE_DISK {
        return Err(WatchNativeError::NotADiskHandle(file_type));
    }

    let mut info = ByHandleFileInformation::default();
    // SAFETY: `info` is valid writable stack storage for `BY_HANDLE_FILE_INFORMATION`.
    let ok = unsafe { GetFileInformationByHandle(raw, &mut info) };
    if ok == 0 {
        // SAFETY: Reads thread-local Win32 error code immediately after failure.
        let code = unsafe { win32::GetLastError() };
        return Err(WatchNativeError::Win32Error {
            operation: "GetFileInformationByHandle",
            code,
        });
    }

    if (info.file_attributes & win32::FILE_ATTRIBUTE_REPARSE_POINT) != 0 {
        return Err(WatchNativeError::ReparsePointNotAllowed);
    }
    if (info.file_attributes & win32::FILE_ATTRIBUTE_DIRECTORY) == 0 {
        return Err(WatchNativeError::NotADirectory);
    }

    let file_index = ((info.file_index_high as u64) << 32) | (info.file_index_low as u64);
    Ok(DirectoryIdentity {
        volume_serial_number: info.volume_serial_number,
        file_index,
    })
}

/// Duplicates a kernel handle within the current process (`DUPLICATE_SAME_ACCESS`,
/// non-inheritable) so the watcher owns an independent RAII [`OwnedHandle`].
#[cfg(windows)]
fn duplicate_owned_handle(handle: BorrowedHandle<'_>) -> Result<OwnedHandle, WatchNativeError> {
    let raw = handle.as_raw_handle();
    if raw.is_null() || raw == win32::INVALID_HANDLE_VALUE {
        return Err(WatchNativeError::NullOrInvalidHandle);
    }
    let mut duplicated: RawHandle = core::ptr::null_mut();
    // SAFETY: Duplicates within `GetCurrentProcess()` into `duplicated`.
    let ok = unsafe {
        let process = win32::GetCurrentProcess();
        win32::DuplicateHandle(
            process,
            raw,
            process,
            &mut duplicated,
            0,
            0,
            win32::DUPLICATE_SAME_ACCESS,
        )
    };
    if ok == 0 || duplicated.is_null() || duplicated == win32::INVALID_HANDLE_VALUE {
        // SAFETY: Reads thread-local Win32 error code immediately after failure.
        let code = unsafe { win32::GetLastError() };
        return Err(WatchNativeError::Win32Error {
            operation: "DuplicateHandle",
            code,
        });
    }
    // SAFETY: `duplicated` is a newly created kernel handle owned by this process.
    Ok(unsafe { OwnedHandle::from_raw_handle(duplicated) })
}

/// Opaque handoff from the trusted filesystem coordinator to the watch layer.
///
/// The coordinator must open the registered workspace root using its
/// component-by-component no-follow policy, including
/// `FILE_FLAG_OPEN_REPARSE_POINT` for the final component. A renderer path or
/// recent-document ID is not a root capability.
#[cfg(windows)]
#[derive(Debug)]
pub struct TrustedDirectoryRoot {
    handle: OwnedHandle,
    identity: DirectoryIdentity,
}

#[cfg(windows)]
impl TrustedDirectoryRoot {
    /// Accepts a candidate handle from the trusted filesystem opener and pins
    /// its final directory identity. This check does not prove that the handle
    /// was opened without following a link; that guarantee is the coordinator's
    /// responsibility.
    ///
    /// # Safety
    /// The handle must come from the trusted workspace opener after
    /// component-by-component no-follow traversal of the active workspace
    /// registration. Its final component must have been opened with
    /// `FILE_FLAG_OPEN_REPARSE_POINT` and the handle must have the access and
    /// overlapped mode required by `ReadDirectoryChangesW`.
    pub unsafe fn from_coordinator_open(handle: OwnedHandle) -> Result<Self, WatchNativeError> {
        let identity = query_verified_directory_identity(handle.as_handle())?;
        Ok(Self { handle, identity })
    }
}

/// Pinned, already-verified Windows directory handle supplied by the trusted
/// filesystem coordinator. Its only constructor consumes a
/// [`TrustedDirectoryRoot`] capability.
#[cfg(windows)]
#[derive(Debug)]
pub struct VerifiedDirectoryHandle {
    handle: OwnedHandle,
    identity: DirectoryIdentity,
}

#[cfg(windows)]
impl VerifiedDirectoryHandle {
    /// Consumes the coordinator-issued proof and rechecks its pinned identity.
    pub fn from_trusted_root(root: TrustedDirectoryRoot) -> Result<Self, WatchNativeError> {
        let live_identity = query_verified_directory_identity(root.handle.as_handle())?;
        if live_identity != root.identity {
            return Err(WatchNativeError::IdentityMismatch {
                expected: root.identity,
                actual: live_identity,
            });
        }
        Ok(Self {
            handle: root.handle,
            identity: live_identity,
        })
    }

    /// Duplicates this verified handle, re-checking that its pinned
    /// [`DirectoryIdentity`] and non-reparse directory status have not changed.
    pub fn try_clone(&self) -> Result<Self, WatchNativeError> {
        let duplicated = duplicate_owned_handle(self.handle.as_handle())?;
        let live_identity = query_verified_directory_identity(duplicated.as_handle())?;
        if live_identity != self.identity {
            return Err(WatchNativeError::IdentityMismatch {
                expected: self.identity,
                actual: live_identity,
            });
        }
        Ok(Self {
            handle: duplicated,
            identity: live_identity,
        })
    }

    /// Returns the pinned [`DirectoryIdentity`] recorded when the handle was verified.
    pub fn identity(&self) -> DirectoryIdentity {
        self.identity
    }

    /// Re-verifies the underlying kernel handle against its pinned [`DirectoryIdentity`].
    pub fn verify_live_identity(&self) -> Result<DirectoryIdentity, WatchNativeError> {
        let live = query_verified_directory_identity(self.handle.as_handle())?;
        if live != self.identity {
            return Err(WatchNativeError::IdentityMismatch {
                expected: self.identity,
                actual: live,
            });
        }
        Ok(live)
    }

    pub fn as_borrowed(&self) -> BorrowedHandle<'_> {
        self.handle.as_handle()
    }
}

#[cfg(windows)]
trait AsBorrowedHandleExt {
    fn as_handle(&self) -> BorrowedHandle<'_>;
}

#[cfg(windows)]
impl AsBorrowedHandleExt for OwnedHandle {
    fn as_handle(&self) -> BorrowedHandle<'_> {
        // SAFETY: `self` owns the handle for the lifetime of `&self`.
        unsafe { BorrowedHandle::borrow_raw(self.as_raw_handle()) }
    }
}

/// RAII wrapper for a Win32 manual-reset event (`CreateEventW`).
#[cfg(windows)]
struct Win32Event(OwnedHandle);

#[cfg(windows)]
impl Win32Event {
    fn new_manual_reset(initial_state: bool) -> Result<Self, WatchNativeError> {
        // SAFETY: Creates an unnamed manual-reset event with default security.
        let raw = unsafe {
            win32::CreateEventW(
                core::ptr::null(),
                1,
                if initial_state { 1 } else { 0 },
                core::ptr::null(),
            )
        };
        if raw.is_null() || raw == win32::INVALID_HANDLE_VALUE {
            // SAFETY: Reads thread-local Win32 error code immediately after failure.
            let code = unsafe { win32::GetLastError() };
            return Err(WatchNativeError::Win32Error {
                operation: "CreateEventW",
                code,
            });
        }
        // SAFETY: `raw` is a valid newly-created event handle.
        Ok(Self(unsafe { OwnedHandle::from_raw_handle(raw) }))
    }

    fn set(&self) {
        // SAFETY: `self.0` is a valid event handle.
        unsafe {
            win32::SetEvent(self.0.as_raw_handle());
        }
    }

    fn reset(&self) {
        // SAFETY: `self.0` is a valid event handle.
        unsafe {
            win32::ResetEvent(self.0.as_raw_handle());
        }
    }

    fn raw(&self) -> RawHandle {
        self.0.as_raw_handle()
    }
}

/// 8-byte aligned buffer for `ReadDirectoryChangesW` (`FILE_NOTIFY_INFORMATION`
/// requires at least `DWORD` alignment).
#[repr(align(8))]
struct AlignedNotifyBuffer([u8; NOTIFY_BUFFER_BYTES]);

impl AlignedNotifyBuffer {
    fn new() -> Box<Self> {
        Box::new(Self([0u8; NOTIFY_BUFFER_BYTES]))
    }
}

// ---- Bounded Shared Queue & Subscription State ---------------------------

struct BoundedSignalQueue {
    signals: VecDeque<WatchSignal>,
    pending_resync: Option<ResyncReason>,
    terminal_failure: Option<FileWatchFailure>,
    stopped: bool,
}

struct SharedSubscriptionState {
    key: WatchSubscriptionKey,
    root_identity: DirectoryIdentity,
    max_queued_events: usize,
    stopped: AtomicBool,
    terminal: AtomicBool,
    #[cfg(test)]
    read_armed: AtomicBool,
    queue: Mutex<BoundedSignalQueue>,
    condvar: Condvar,
}

impl SharedSubscriptionState {
    fn new(
        key: WatchSubscriptionKey,
        root_identity: DirectoryIdentity,
        max_queued_events: usize,
    ) -> Arc<Self> {
        Arc::new(Self {
            key,
            root_identity,
            max_queued_events: max_queued_events.max(1),
            stopped: AtomicBool::new(false),
            terminal: AtomicBool::new(false),
            #[cfg(test)]
            read_armed: AtomicBool::new(false),
            queue: Mutex::new(BoundedSignalQueue {
                signals: VecDeque::new(),
                pending_resync: None,
                terminal_failure: None,
                stopped: false,
            }),
            condvar: Condvar::new(),
        })
    }

    fn lock_queue(&self) -> MutexGuard<'_, BoundedSignalQueue> {
        self.queue
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn is_stopped(&self) -> bool {
        self.stopped.load(Ordering::Acquire)
    }

    fn should_exit_worker(&self) -> bool {
        self.is_stopped() || self.terminal.load(Ordering::Acquire)
    }

    fn has_terminal_failure(&self) -> bool {
        self.terminal.load(Ordering::Acquire)
    }

    fn mark_stopped_and_purge(&self) {
        self.stopped.store(true, Ordering::Release);
        self.terminal.store(true, Ordering::Release);
        let mut guard = self.lock_queue();
        guard.stopped = true;
        guard.signals.clear();
        guard.pending_resync = None;
        guard.terminal_failure = None;
        #[cfg(test)]
        self.read_armed.store(false, Ordering::Release);
        self.condvar.notify_all();
    }

    #[cfg(test)]
    fn set_read_armed(&self, armed: bool) {
        let _guard = self.lock_queue();
        self.read_armed.store(armed, Ordering::Release);
        self.condvar.notify_all();
    }

    #[cfg(test)]
    fn wait_until_read_armed(&self, timeout: Duration) -> bool {
        let started = Instant::now();
        let mut guard = self.lock_queue();
        loop {
            if self.read_armed.load(Ordering::Acquire) {
                return true;
            }
            if self.should_exit_worker() {
                return false;
            }
            let remaining = timeout.saturating_sub(started.elapsed());
            if remaining.is_zero() {
                return false;
            }
            let (next_guard, wait_result) = self
                .condvar
                .wait_timeout(guard, remaining)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            guard = next_guard;
            if wait_result.timed_out() && !self.read_armed.load(Ordering::Acquire) {
                return false;
            }
        }
    }

    /// Enqueues coalesced batch items without ever blocking the worker thread.
    /// If the queue reaches `max_queued_events`, latches
    /// [`ResyncReason::EventQueueOverflow`].
    fn push_batch(&self, items: Vec<WatchBatchItem>) {
        if self.should_exit_worker() || items.is_empty() {
            return;
        }
        let mut guard = self.lock_queue();
        if guard.stopped || self.has_terminal_failure() || guard.pending_resync.is_some() {
            return;
        }
        for item in items {
            // Coalesce in-place if the same path is already queued.
            if let Some((event, renamed_from)) =
                guard.signals.iter_mut().find_map(|signal| match signal {
                    WatchSignal::Event {
                        event,
                        renamed_from,
                        ..
                    } if event.path == item.path => Some((event, renamed_from)),
                    _ => None,
                })
            {
                event.kind = item.kind;
                if item.renamed_from.is_some() {
                    *renamed_from = item.renamed_from;
                } else if item.kind == FileEventKind::Removed {
                    *renamed_from = None;
                }
                continue;
            }

            if guard.signals.len() >= self.max_queued_events {
                guard.signals.clear();
                guard.pending_resync = Some(ResyncReason::EventQueueOverflow);
                break;
            }

            let event = item.to_file_event(&self.key.workspace_id);
            guard.signals.push_back(WatchSignal::Event {
                owner: self.key.owner.clone(),
                generation: self.key.generation,
                event,
                renamed_from: item.renamed_from,
            });
        }
        self.condvar.notify_all();
    }

    fn latch_resync(&self, reason: ResyncReason) {
        if self.should_exit_worker() {
            return;
        }
        let mut guard = self.lock_queue();
        if guard.stopped || self.has_terminal_failure() {
            return;
        }
        // The queued event stream is no longer a complete view. Drop it only
        // while publishing the explicit resync latch that accounts for the loss.
        guard.signals.clear();
        if guard.pending_resync.is_none() {
            guard.pending_resync = Some(reason);
        }
        self.condvar.notify_all();
    }

    fn latch_failure(&self, failure: FileWatchFailure) {
        if self.is_stopped() {
            return;
        }
        let mut guard = self.lock_queue();
        if guard.stopped || self.has_terminal_failure() {
            return;
        }
        guard.signals.clear();
        guard.pending_resync = None;
        guard.terminal_failure = Some(failure);
        self.terminal.store(true, Ordering::Release);
        self.condvar.notify_all();
    }

    fn verify_caller(
        &self,
        owner: &OwnerId,
        workspace_id: &WorkspaceId,
        generation: WatchGeneration,
    ) -> Result<(), WatchAccessError> {
        if &self.key.owner != owner {
            return Err(WatchAccessError::OwnerMismatch);
        }
        if &self.key.workspace_id != workspace_id {
            return Err(WatchAccessError::WorkspaceMismatch);
        }
        if self.key.generation != generation {
            return Err(WatchAccessError::StaleGeneration {
                expected: self.key.generation,
                actual: generation,
            });
        }
        if self.is_stopped() {
            return Err(WatchAccessError::SubscriptionStopped);
        }
        Ok(())
    }

    fn drain_locked(&self, guard: &mut BoundedSignalQueue) -> Vec<WatchSignal> {
        if guard.stopped || self.is_stopped() {
            guard.signals.clear();
            guard.pending_resync = None;
            guard.terminal_failure = None;
            return Vec::new();
        }

        let mut out = Vec::new();
        if let Some(failure) = guard.terminal_failure.take() {
            guard.signals.clear();
            guard.pending_resync = None;
            out.push(WatchSignal::Failure {
                owner: self.key.owner.clone(),
                workspace_id: self.key.workspace_id.clone(),
                generation: self.key.generation,
                failure,
            });
            return out;
        }

        if let Some(reason) = guard.pending_resync.take() {
            out.push(WatchSignal::ResyncRequired {
                owner: self.key.owner.clone(),
                workspace_id: self.key.workspace_id.clone(),
                generation: self.key.generation,
                reason,
            });
        }

        out.extend(guard.signals.drain(..));
        out
    }
}

// ---- Active Native Watch Subscription ------------------------------------

// A native subscription reserves cleanup capacity before its worker is
// created.  Consequently Drop can transfer, rather than detach or join, the
// worker handle and its cancellation resources to a fixed-size reaper.
#[cfg(windows)]
const NATIVE_REAPER_CAPACITY: usize = 256;
#[cfg(windows)]
const NATIVE_REAPER_WORKERS: usize = 2;

#[cfg(windows)]
type NativeReaperTask = Box<dyn FnOnce() + Send + 'static>;

#[cfg(windows)]
struct NativeReaperState {
    tasks: VecDeque<NativeReaperTask>,
    reservations: usize,
}

#[cfg(windows)]
struct NativeReaperShared {
    state: Mutex<NativeReaperState>,
    condvar: Condvar,
}

#[cfg(windows)]
struct NativeReaper {
    shared: Arc<NativeReaperShared>,
    // Keep the fixed reaper workers owned for the lifetime of the process.
    _workers: Vec<JoinHandle<()>>,
}

#[cfg(windows)]
impl NativeReaper {
    fn new() -> Result<Self, String> {
        let shared = Arc::new(NativeReaperShared {
            state: Mutex::new(NativeReaperState {
                tasks: VecDeque::with_capacity(NATIVE_REAPER_CAPACITY),
                reservations: 0,
            }),
            condvar: Condvar::new(),
        });
        let mut workers = Vec::with_capacity(NATIVE_REAPER_WORKERS);
        for index in 0..NATIVE_REAPER_WORKERS {
            let worker_shared = Arc::clone(&shared);
            match thread::Builder::new()
                .name(format!("modutex-native-watch-reaper-{index}"))
                .spawn(move || native_reaper_worker(worker_shared))
            {
                Ok(worker) => workers.push(worker),
                // One successfully started worker is sufficient.  Do not
                // discard its JoinHandle if starting the second worker fails.
                Err(error) if workers.is_empty() => return Err(error.to_string()),
                Err(_) => break,
            }
        }
        Ok(Self {
            shared,
            _workers: workers,
        })
    }
}

#[cfg(windows)]
fn native_reaper() -> Result<Arc<NativeReaper>, WatchNativeError> {
    static REAPER: OnceLock<Result<Arc<NativeReaper>, String>> = OnceLock::new();
    match REAPER.get_or_init(|| NativeReaper::new().map(Arc::new)) {
        Ok(reaper) => Ok(Arc::clone(reaper)),
        Err(_) => Err(WatchNativeError::CleanupUnavailable),
    }
}

#[cfg(windows)]
fn native_reaper_worker(shared: Arc<NativeReaperShared>) {
    loop {
        let task = {
            let mut state = shared
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            while state.tasks.is_empty() {
                state = shared
                    .condvar
                    .wait(state)
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
            }
            state.tasks.pop_front()
        };
        if let Some(task) = task {
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(task));
            let mut state = shared
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            state.reservations = state.reservations.saturating_sub(1);
            shared.condvar.notify_all();
        }
    }
}

#[cfg(windows)]
struct NativeReaperPermit {
    shared: Arc<NativeReaperShared>,
    queued: bool,
}

#[cfg(windows)]
impl NativeReaperPermit {
    fn reserve() -> Result<Self, WatchNativeError> {
        let reaper = native_reaper()?;
        let mut state = reaper
            .shared
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if state.reservations >= NATIVE_REAPER_CAPACITY {
            return Err(WatchNativeError::CleanupCapacityExceeded);
        }
        state.reservations += 1;
        drop(state);
        Ok(Self {
            shared: Arc::clone(&reaper.shared),
            queued: false,
        })
    }

    fn submit(mut self, task: impl FnOnce() + Send + 'static) {
        let mut state = self
            .shared
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        // Every queued task owns a prior reservation.  Queue saturation is
        // therefore impossible unless this ownership invariant is broken.
        debug_assert!(state.tasks.len() < NATIVE_REAPER_CAPACITY);
        state.tasks.push_back(Box::new(task));
        self.queued = true;
        self.shared.condvar.notify_one();
    }
}

#[cfg(windows)]
impl Drop for NativeReaperPermit {
    fn drop(&mut self) {
        if !self.queued {
            let mut state = self
                .shared
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            state.reservations = state.reservations.saturating_sub(1);
            self.shared.condvar.notify_all();
        }
    }
}

#[cfg(windows)]
struct WorkerJoinState {
    worker: Option<JoinHandle<()>>,
    joining: bool,
    joined: bool,
}

/// Handle to an active Windows `ReadDirectoryChangesW` subscription bound to a
/// single `(OwnerId, WorkspaceId, WatchGeneration)`.
#[cfg(windows)]
pub struct NativeWatchSubscription {
    shared: Arc<SharedSubscriptionState>,
    cancel_handle: Mutex<Option<OwnedHandle>>,
    stop_event: Arc<Win32Event>,
    worker: Mutex<WorkerJoinState>,
    joined: Condvar,
    reaper_permit: Mutex<Option<NativeReaperPermit>>,
}

#[cfg(windows)]
impl NativeWatchSubscription {
    /// Starts a real Windows `ReadDirectoryChangesW` worker on the verified
    /// directory handle.
    ///
    /// Duplicates the handle so the worker thread and cancellation handle own
    /// independent RAII handles; on any initialization or thread-spawn failure,
    /// all handles are closed immediately.
    pub fn start(
        key: WatchSubscriptionKey,
        verified_dir: VerifiedDirectoryHandle,
        validator: Arc<dyn WatchValidatorSeam>,
        config: WatchConfig,
    ) -> Result<Self, WatchNativeError> {
        let reaper_permit = NativeReaperPermit::reserve()?;
        Self::start_reserved(key, verified_dir, validator, config, reaper_permit)
    }

    fn start_reserved(
        key: WatchSubscriptionKey,
        verified_dir: VerifiedDirectoryHandle,
        validator: Arc<dyn WatchValidatorSeam>,
        config: WatchConfig,
        reaper_permit: NativeReaperPermit,
    ) -> Result<Self, WatchNativeError> {
        let root_identity = verified_dir.verify_live_identity()?;
        let cancel_handle = duplicate_owned_handle(verified_dir.as_borrowed())?;
        let stop_event = Arc::new(Win32Event::new_manual_reset(false)?);
        let io_event = Win32Event::new_manual_reset(false)?;

        let shared = SharedSubscriptionState::new(key, root_identity, config.max_queued_events);
        let worker_shared = Arc::clone(&shared);
        let worker_stop_event = Arc::clone(&stop_event);

        let spawn_result = thread::Builder::new()
            .name(format!(
                "modutex-watch-{}-g{}",
                shared.key.workspace_id.as_str(),
                shared.key.generation.get()
            ))
            .spawn(move || {
                run_watch_worker(
                    verified_dir,
                    io_event,
                    worker_stop_event,
                    worker_shared,
                    validator,
                    config,
                );
            });

        match spawn_result {
            Ok(join_handle) => Ok(Self {
                shared,
                cancel_handle: Mutex::new(Some(cancel_handle)),
                stop_event,
                worker: Mutex::new(WorkerJoinState {
                    worker: Some(join_handle),
                    joining: false,
                    joined: false,
                }),
                joined: Condvar::new(),
                reaper_permit: Mutex::new(Some(reaper_permit)),
            }),
            Err(err) => {
                shared.mark_stopped_and_purge();
                Err(WatchNativeError::ThreadSpawnFailed(err.to_string()))
            }
        }
    }

    pub fn key(&self) -> &WatchSubscriptionKey {
        &self.shared.key
    }

    pub fn root_identity(&self) -> DirectoryIdentity {
        self.shared.root_identity
    }

    pub fn is_stopped(&self) -> bool {
        self.shared.is_stopped()
    }

    /// `is_stopped` means cancellation was requested; it does not mean the
    /// worker has released its overlapped I/O storage or exited.
    pub fn is_joined(&self) -> bool {
        self.worker
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .joined
    }

    /// Requests cancellation without waiting for the worker or dropping any
    /// storage it may still be using.
    pub fn request_stop(&self) {
        self.shared.mark_stopped_and_purge();
        self.stop_event.set();
        let handle = self
            .cancel_handle
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(handle) = handle.as_ref() {
            // SAFETY: The independently owned handle refers to the same
            // directory object used by the worker.  The worker drains its
            // outstanding OVERLAPPED operation before it returns.
            unsafe {
                win32::CancelIoEx(handle.as_raw_handle(), core::ptr::null());
            }
        }
    }

    /// Joins the worker after requesting cancellation.  Returns false only
    /// when called by the worker itself; ownership is retained in that case.
    pub fn join_after_stop(&self) -> bool {
        self.request_stop();
        let worker = {
            let mut state = self
                .worker
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            loop {
                if state.joined {
                    return true;
                }
                if state.joining {
                    state = self
                        .joined
                        .wait(state)
                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                    continue;
                }
                let Some(worker) = state.worker.take() else {
                    // A subscription is only constructed after successful
                    // worker creation.  Reaching this branch means another
                    // joiner completed between observations.
                    state.joined = true;
                    self.joined.notify_all();
                    drop(state);
                    self.reaper_permit
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner())
                        .take();
                    return true;
                };
                if worker.thread().id() == thread::current().id() {
                    state.worker = Some(worker);
                    return false;
                }
                state.joining = true;
                break worker;
            }
        };

        // A panicked worker is still joined: its handle and all worker-owned
        // notification/OVERLAPPED storage are no longer live after this call.
        let _ = worker.join();
        let mut state = self
            .worker
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.joining = false;
        state.joined = true;
        self.joined.notify_all();
        drop(state);
        self.reaper_permit
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take();
        true
    }

    #[cfg(test)]
    fn wait_until_read_armed(&self, timeout: Duration) -> bool {
        self.shared.wait_until_read_armed(timeout)
    }

    /// Non-blocking drain of pending [`WatchSignal`]s for the bound owner,
    /// workspace, and generation.
    pub fn drain_signals(
        &self,
        owner: &OwnerId,
        workspace_id: &WorkspaceId,
        generation: WatchGeneration,
    ) -> Result<Vec<WatchSignal>, WatchAccessError> {
        self.shared.verify_caller(owner, workspace_id, generation)?;
        let mut guard = self.shared.lock_queue();
        self.shared.verify_caller(owner, workspace_id, generation)?;
        Ok(self.shared.drain_locked(&mut guard))
    }

    /// Waits up to `timeout` for at least one [`WatchSignal`] and drains all
    /// ready signals for the bound owner, workspace, and generation.
    pub fn wait_and_drain(
        &self,
        owner: &OwnerId,
        workspace_id: &WorkspaceId,
        generation: WatchGeneration,
        timeout: Duration,
    ) -> Result<Vec<WatchSignal>, WatchAccessError> {
        self.shared.verify_caller(owner, workspace_id, generation)?;
        let started = Instant::now();
        let mut guard = self.shared.lock_queue();

        while !guard.stopped
            && !self.shared.is_stopped()
            && guard.signals.is_empty()
            && guard.pending_resync.is_none()
            && guard.terminal_failure.is_none()
        {
            let remaining = timeout.saturating_sub(started.elapsed());
            if remaining.is_zero() {
                break;
            }
            let (next_guard, _) = self
                .shared
                .condvar
                .wait_timeout(guard, remaining)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            guard = next_guard;
        }

        self.shared.verify_caller(owner, workspace_id, generation)?;
        Ok(self.shared.drain_locked(&mut guard))
    }

    /// Idempotently stops the subscription, purges any queued emissions,
    /// cancels outstanding `ReadDirectoryChangesW` via `CancelIoEx`, and joins
    /// the worker thread.
    pub fn stop(&self) {
        let _ = self.join_after_stop();
    }
}

#[cfg(windows)]
impl Drop for NativeWatchSubscription {
    fn drop(&mut self) {
        self.request_stop();
        let state = self
            .worker
            .get_mut()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if state.joined {
            return;
        }
        if let Some(worker) = state.worker.take() {
            let cancel_handle = self
                .cancel_handle
                .get_mut()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .take();
            let permit = self
                .reaper_permit
                .get_mut()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .take();
            let stop_event = Arc::clone(&self.stop_event);
            let shared = Arc::clone(&self.shared);
            if let Some(permit) = permit {
                permit.submit(move || {
                    let _ = worker.join();
                    drop(cancel_handle);
                    drop(stop_event);
                    drop(shared);
                });
            } else {
                // This is an invariant fallback, not the normal UI path: never
                // detach a live native worker if its reserved reaper slot is
                // unexpectedly absent.
                let _ = worker.join();
                drop(cancel_handle);
            }
        }
    }
}

#[cfg(windows)]
fn cancel_and_drain_overlapped(dir_raw: RawHandle, overlapped: &mut win32::Overlapped) {
    // SAFETY: Cancels the specific `overlapped` I/O operation and waits with
    // `bWait = 1` in `GetOverlappedResult` so the kernel releases `overlapped`
    // and the notification buffer before stack unwind.
    unsafe {
        win32::CancelIoEx(dir_raw, overlapped);
        let mut transferred = 0u32;
        let _ = win32::GetOverlappedResult(dir_raw, overlapped, &mut transferred, 1);
    }
}

#[cfg(windows)]
fn normalized_interval(interval: Duration) -> Duration {
    interval.max(MIN_WATCH_INTERVAL).min(MAX_WATCH_INTERVAL)
}

#[cfg(windows)]
fn deadline_after(now: Instant, interval: Duration) -> Instant {
    now.checked_add(interval).unwrap_or(now)
}

#[cfg(windows)]
fn wait_timeout_millis(timeout: Duration) -> u32 {
    if timeout.is_zero() {
        return 0;
    }
    let fractional_millis = if timeout.subsec_nanos().is_multiple_of(1_000_000) {
        0
    } else {
        1
    };
    timeout
        .as_millis()
        .saturating_add(fractional_millis)
        .max(1)
        .min(u32::MAX as u128) as u32
}

#[cfg(windows)]
fn run_watch_worker(
    verified_dir: VerifiedDirectoryHandle,
    io_event: Win32Event,
    stop_event: Arc<Win32Event>,
    shared: Arc<SharedSubscriptionState>,
    validator: Arc<dyn WatchValidatorSeam>,
    config: WatchConfig,
) {
    let mut buffer = AlignedNotifyBuffer::new();
    let dir_raw = verified_dir.as_borrowed().as_raw_handle();
    let pinned_identity = verified_dir.identity();
    let identity_interval = normalized_interval(config.identity_check_interval);
    let reconcile_interval = normalized_interval(config.reconcile_interval);

    let now = Instant::now();
    let mut next_identity_check = deadline_after(now, identity_interval);
    let mut next_reconcile = deadline_after(now, reconcile_interval);

    while !shared.should_exit_worker() {
        io_event.reset();
        let mut overlapped = win32::Overlapped {
            internal: 0,
            internal_high: 0,
            offset: 0,
            offset_high: 0,
            h_event: io_event.raw(),
        };

        #[cfg(test)]
        shared.set_read_armed(false);

        // SAFETY: `dir_raw` is a verified directory handle; `buffer` is 8-byte
        // aligned and remains allocated for the entire lifetime of `overlapped`.
        // For overlapped I/O Windows requires `lpBytesReturned` to be NULL.
        let issued = unsafe {
            win32::ReadDirectoryChangesW(
                dir_raw,
                buffer.0.as_mut_ptr().cast::<core::ffi::c_void>(),
                NOTIFY_BUFFER_BYTES as u32,
                if config.watch_subtree { 1 } else { 0 },
                config.notify_filter,
                core::ptr::null_mut(),
                &mut overlapped,
                core::ptr::null(),
            )
        };

        if issued == 0 {
            // SAFETY: Reads thread-local Win32 error code immediately after failure.
            let err = unsafe { win32::GetLastError() };
            if err != win32::ERROR_IO_PENDING {
                if err == win32::ERROR_OPERATION_ABORTED || shared.should_exit_worker() {
                    break;
                }
                if err == win32::ERROR_NOTIFY_ENUM_DIR {
                    shared.latch_resync(ResyncReason::KernelBufferOverflow);
                    continue;
                }
                shared.latch_failure(FileWatchFailure::FileOperationFailed);
                break;
            }
        }

        #[cfg(test)]
        shared.set_read_armed(true);

        // Wait for completion while servicing root-identity and periodic
        // reconciliation checks. Any early exit cancels and drains this exact
        // OVERLAPPED request before its stack storage or buffer can be dropped.
        let io_completed = loop {
            if shared.should_exit_worker() {
                cancel_and_drain_overlapped(dir_raw, &mut overlapped);
                #[cfg(test)]
                shared.set_read_armed(false);
                return;
            }

            let now = Instant::now();
            let until_identity = next_identity_check.saturating_duration_since(now);
            let until_reconcile = next_reconcile.saturating_duration_since(now);
            let wait_slice = until_identity
                .min(until_reconcile)
                .min(Duration::from_secs(5));
            let wait_ms = wait_timeout_millis(wait_slice);

            let handles = [io_event.raw(), stop_event.raw()];
            // SAFETY: Both event handles are valid for the duration of the call.
            let wait_status =
                unsafe { win32::WaitForMultipleObjects(2, handles.as_ptr(), 0, wait_ms) };

            if wait_status == win32::WAIT_OBJECT_0 {
                break true;
            }
            if wait_status == win32::WAIT_OBJECT_0 + 1 || shared.should_exit_worker() {
                cancel_and_drain_overlapped(dir_raw, &mut overlapped);
                #[cfg(test)]
                shared.set_read_armed(false);
                return;
            }
            if wait_status != win32::WAIT_TIMEOUT {
                cancel_and_drain_overlapped(dir_raw, &mut overlapped);
                #[cfg(test)]
                shared.set_read_armed(false);
                if !shared.should_exit_worker() {
                    shared.latch_failure(FileWatchFailure::FileOperationFailed);
                }
                return;
            }

            let tick = Instant::now();
            if shared.should_exit_worker() {
                cancel_and_drain_overlapped(dir_raw, &mut overlapped);
                #[cfg(test)]
                shared.set_read_armed(false);
                return;
            }

            if tick >= next_identity_check {
                next_identity_check = deadline_after(tick, identity_interval);
                let live_identity =
                    match query_verified_directory_identity(verified_dir.as_borrowed()) {
                        Ok(live_identity) => live_identity,
                        Err(err) => {
                            cancel_and_drain_overlapped(dir_raw, &mut overlapped);
                            #[cfg(test)]
                            shared.set_read_armed(false);
                            shared.latch_failure(err.to_watch_failure());
                            return;
                        }
                    };

                let verified = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    validator.verify_workspace_identity(pinned_identity, live_identity)
                }));
                match verified {
                    Ok(Ok(())) => {}
                    Ok(Err(failure)) => {
                        cancel_and_drain_overlapped(dir_raw, &mut overlapped);
                        #[cfg(test)]
                        shared.set_read_armed(false);
                        shared.latch_failure(failure);
                        return;
                    }
                    Err(_) => {
                        cancel_and_drain_overlapped(dir_raw, &mut overlapped);
                        #[cfg(test)]
                        shared.set_read_armed(false);
                        shared.latch_failure(FileWatchFailure::FileOperationFailed);
                        return;
                    }
                }
            }

            if tick >= next_reconcile {
                next_reconcile = deadline_after(tick, reconcile_interval);
                let reconciled = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    validator.on_reconcile_due(pinned_identity)
                }));
                match reconciled {
                    Ok(Ok(Some(reconciled_items))) => shared.push_batch(reconciled_items),
                    Ok(Ok(None)) => {
                        shared.latch_resync(ResyncReason::PeriodicReconcileDue);
                    }
                    Ok(Err(failure)) => {
                        cancel_and_drain_overlapped(dir_raw, &mut overlapped);
                        #[cfg(test)]
                        shared.set_read_armed(false);
                        shared.latch_failure(failure);
                        return;
                    }
                    Err(_) => {
                        cancel_and_drain_overlapped(dir_raw, &mut overlapped);
                        #[cfg(test)]
                        shared.set_read_armed(false);
                        shared.latch_failure(FileWatchFailure::FileOperationFailed);
                        return;
                    }
                }
            }
        };

        #[cfg(test)]
        shared.set_read_armed(false);

        if !io_completed || shared.should_exit_worker() {
            cancel_and_drain_overlapped(dir_raw, &mut overlapped);
            break;
        }

        let mut transferred = 0u32;
        // SAFETY: `overlapped` completed; retrieves transferred byte count.
        let result_ok =
            unsafe { win32::GetOverlappedResult(dir_raw, &overlapped, &mut transferred, 1) };
        if result_ok == 0 {
            // SAFETY: Reads thread-local Win32 error code immediately after failure.
            let err = unsafe { win32::GetLastError() };
            if err == win32::ERROR_OPERATION_ABORTED || shared.should_exit_worker() {
                break;
            }
            if err == win32::ERROR_NOTIFY_ENUM_DIR {
                shared.latch_resync(ResyncReason::KernelBufferOverflow);
                continue;
            }
            shared.latch_failure(FileWatchFailure::FileOperationFailed);
            break;
        }

        if shared.should_exit_worker() {
            break;
        }

        // Per ReadDirectoryChangesW contract, 0 bytes transferred on success means
        // the kernel overflowed the caller buffer.
        if transferred == 0 || (transferred as usize) > NOTIFY_BUFFER_BYTES {
            shared.latch_resync(ResyncReason::KernelBufferOverflow);
            continue;
        }

        // The overlapped request has completed, so a validator panic here cannot
        // unwind while the kernel still owns the buffer or OVERLAPPED storage.
        let processed = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            process_raw_notification_slice(
                &buffer.0[..transferred as usize],
                pinned_identity,
                &*validator,
                &*shared,
            );
        }));
        if processed.is_err() {
            shared.latch_failure(FileWatchFailure::FileOperationFailed);
        }
    }
}

/// Validates a raw notification buffer slice, consults the [`WatchValidatorSeam`],
/// pairs renames, coalesces bursts, and enqueues signals or explicit resync/failure.
pub fn process_raw_notification_slice(
    raw_slice: &[u8],
    root_identity: DirectoryIdentity,
    validator: &dyn WatchValidatorSeam,
    shared_sink: &impl NotificationSink,
) {
    let parsed = match parse_notify_buffer(raw_slice) {
        Ok(records) => records,
        Err(NotifyParseError::EmptyOrOverflowBuffer) => {
            shared_sink.on_resync(ResyncReason::KernelBufferOverflow);
            return;
        }
        Err(
            err @ (NotifyParseError::PathTraversal { .. }
            | NotifyParseError::RootedOrSlashPath { .. }
            | NotifyParseError::AlternateDataStreamOrColon { .. }),
        ) => {
            shared_sink.on_failure(err.to_watch_failure());
            return;
        }
        Err(err) => {
            shared_sink.on_resync(ResyncReason::CorruptNotifyBuffer(err));
            return;
        }
    };

    let mut accepted = Vec::with_capacity(parsed.len());
    let mut resync_requested = false;

    for record in parsed {
        match validator.validate_notified_path(root_identity, &record.path, record.action) {
            ValidatorDisposition::Accept => accepted.push(record),
            ValidatorDisposition::Ignore => {}
            ValidatorDisposition::RequestResync => {
                resync_requested = true;
            }
            ValidatorDisposition::Fail(failure) => {
                shared_sink.on_failure(failure);
                return;
            }
        }
    }

    if resync_requested {
        shared_sink.on_resync(ResyncReason::PeriodicReconcileDue);
    }

    let coalesced = pair_and_coalesce_records(&accepted);
    if !coalesced.is_empty() {
        shared_sink.on_batch(coalesced);
    }
}

/// Sink abstraction allowing unit tests and the native subscription state to
/// share [`process_raw_notification_slice`].
pub trait NotificationSink {
    fn on_batch(&self, items: Vec<WatchBatchItem>);
    fn on_resync(&self, reason: ResyncReason);
    fn on_failure(&self, failure: FileWatchFailure);
}

impl NotificationSink for SharedSubscriptionState {
    fn on_batch(&self, items: Vec<WatchBatchItem>) {
        self.push_batch(items);
    }

    fn on_resync(&self, reason: ResyncReason) {
        self.latch_resync(reason);
    }

    fn on_failure(&self, failure: FileWatchFailure) {
        self.latch_failure(failure);
    }
}

impl<T: NotificationSink + ?Sized> NotificationSink for Arc<T> {
    fn on_batch(&self, items: Vec<WatchBatchItem>) {
        (**self).on_batch(items);
    }

    fn on_resync(&self, reason: ResyncReason) {
        (**self).on_resync(reason);
    }

    fn on_failure(&self, failure: FileWatchFailure) {
        (**self).on_failure(failure);
    }
}

// ---- Subscription Registry (Owner / Workspace / Generation Lifecycle) ----

#[cfg(windows)]
struct StartReservationState {
    cancelled: bool,
    finishing: bool,
    finished: bool,
    subscription: Option<Arc<NativeWatchSubscription>>,
}

/// Registry placeholder installed before a worker is started. It makes an
/// in-flight start visible to supersede/unsubscribe/revoke operations.
#[cfg(windows)]
struct StartReservation {
    generation: WatchGeneration,
    state: Mutex<StartReservationState>,
    condvar: Condvar,
}

#[cfg(windows)]
impl StartReservation {
    fn new(generation: WatchGeneration) -> Self {
        Self {
            generation,
            state: Mutex::new(StartReservationState {
                cancelled: false,
                finishing: false,
                finished: false,
                subscription: None,
            }),
            condvar: Condvar::new(),
        }
    }

    fn lock_state(&self) -> MutexGuard<'_, StartReservationState> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn is_cancelled(&self) -> bool {
        self.lock_state().cancelled
    }

    fn attach(&self, subscription: Arc<NativeWatchSubscription>) -> bool {
        let mut state = self.lock_state();
        if state.cancelled || state.finishing || state.finished {
            return false;
        }
        state.subscription = Some(subscription);
        true
    }

    /// Marks the reservation cancelled, stops an already-created worker, and
    /// waits until the start operation has completed its cleanup path.
    fn cancel(&self) {
        let subscription = {
            let mut state = self.lock_state();
            state.cancelled = true;
            state.subscription.clone()
        };

        if let Some(subscription) = subscription {
            subscription.request_stop();
        }
        self.condvar.notify_all();
    }

    /// Completes the reservation only after releasing its retained subscription.
    /// Dropping that last reference may itself stop and join a worker.
    fn finish(&self) {
        let subscription = {
            let mut state = self.lock_state();
            while state.finishing && !state.finished {
                state = self
                    .condvar
                    .wait(state)
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
            }

            if state.finished {
                return;
            }
            state.finishing = true;
            state.subscription.take()
        };

        drop(subscription);

        let mut state = self.lock_state();
        state.finishing = false;
        state.finished = true;
        self.condvar.notify_all();
    }
}

#[cfg(windows)]
pub struct WatchStartError {
    error: WatchNativeError,
    cleanup: Option<Arc<NativeWatchSubscription>>,
}

#[cfg(windows)]
impl WatchStartError {
    fn without_cleanup(error: WatchNativeError) -> Self {
        Self {
            error,
            cleanup: None,
        }
    }

    fn with_cleanup(error: WatchNativeError, cleanup: Arc<NativeWatchSubscription>) -> Self {
        Self {
            error,
            cleanup: Some(cleanup),
        }
    }

    pub fn error(&self) -> &WatchNativeError {
        &self.error
    }

    pub fn into_parts(self) -> (WatchNativeError, Option<Arc<NativeWatchSubscription>>) {
        (self.error, self.cleanup)
    }
}

#[cfg(windows)]
impl fmt::Debug for WatchStartError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("WatchStartError")
            .field("error", &self.error)
            .field("has_cleanup", &self.cleanup.is_some())
            .finish()
    }
}
#[cfg(windows)]
struct ReservationCompletion(Arc<StartReservation>);

#[cfg(windows)]
impl ReservationCompletion {
    fn new(reservation: Arc<StartReservation>) -> Self {
        Self(reservation)
    }
}

#[cfg(windows)]
impl Drop for ReservationCompletion {
    fn drop(&mut self) {
        self.0.finish();
    }
}

#[cfg(windows)]
enum RegistryEntry {
    Starting(Arc<StartReservation>),
    Active(Arc<NativeWatchSubscription>),
}

#[cfg(windows)]
impl RegistryEntry {
    fn generation(&self) -> WatchGeneration {
        match self {
            Self::Starting(reservation) => reservation.generation,
            Self::Active(subscription) => subscription.key().generation,
        }
    }
}

#[cfg(windows)]
struct RegistryState {
    /// `None` means all non-zero `u64` generations have been assigned.
    next_generation: Option<u64>,
    entries: HashMap<(OwnerId, WorkspaceId), RegistryEntry>,
    revoked_owners: HashSet<OwnerId>,
}

/// Manages active [`NativeWatchSubscription`] instances keyed by
/// `(OwnerId, WorkspaceId)` with monotonic [`WatchGeneration`] assignment.
#[cfg(windows)]
pub struct NativeWatchRegistry {
    state: Mutex<RegistryState>,
}

#[cfg(windows)]
impl Default for NativeWatchRegistry {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(windows)]
impl NativeWatchRegistry {
    pub fn new() -> Self {
        Self {
            state: Mutex::new(RegistryState {
                next_generation: Some(1),
                entries: HashMap::new(),
                revoked_owners: HashSet::new(),
            }),
        }
    }

    fn lock_state(&self) -> MutexGuard<'_, RegistryState> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn reservation_error(&self, owner: &OwnerId) -> WatchNativeError {
        if self.lock_state().revoked_owners.contains(owner) {
            WatchNativeError::OwnerRevoked
        } else {
            WatchNativeError::SubscriptionSuperseded
        }
    }

    fn remove_starting_if_current(
        &self,
        key: &(OwnerId, WorkspaceId),
        reservation: &Arc<StartReservation>,
    ) {
        let mut state = self.lock_state();
        let is_current = matches!(
            state.entries.get(key),
            Some(RegistryEntry::Starting(current)) if Arc::ptr_eq(current, reservation)
        );
        if is_current {
            state.entries.remove(key);
        }
    }

    /// Starts a new subscription for `(owner, workspace_id)`, stopping and
    /// superseding any previous subscription for that pair and returning its
    /// newly assigned [`WatchGeneration`].
    ///
    /// A reservation is installed while holding the registry lock, before
    /// stopping the prior entry or starting the new worker. Thus concurrent
    /// starts, unsubscriptions, and owner revocations cannot install a stale
    /// worker after a newer lifecycle operation.
    pub fn subscribe(
        &self,
        owner: OwnerId,
        workspace_id: WorkspaceId,
        verified_dir: VerifiedDirectoryHandle,
        validator: Arc<dyn WatchValidatorSeam>,
        config: WatchConfig,
    ) -> Result<(WatchGeneration, Arc<NativeWatchSubscription>), WatchNativeError> {
        self.subscribe_with_cleanup(owner, workspace_id, verified_dir, validator, config)
            .map_err(|failure| {
                let (error, cleanup) = failure.into_parts();
                if let Some(subscription) = cleanup {
                    subscription.stop();
                }
                error
            })
    }

    /// Production start seam.  The caller receives an owned subscription on
    /// every failure that occurred after a worker was created, so it can retain
    /// its workspace lease until that worker is actually joined.
    pub fn subscribe_with_cleanup(
        &self,
        owner: OwnerId,
        workspace_id: WorkspaceId,
        verified_dir: VerifiedDirectoryHandle,
        validator: Arc<dyn WatchValidatorSeam>,
        config: WatchConfig,
    ) -> Result<(WatchGeneration, Arc<NativeWatchSubscription>), WatchStartError> {
        // Reserve before replacing an existing subscription or creating a
        // worker.  Saturation therefore leaves the old subscription intact.
        let reaper_permit =
            NativeReaperPermit::reserve().map_err(WatchStartError::without_cleanup)?;
        let registry_key = (owner.clone(), workspace_id.clone());
        let (generation, reservation, previous, _completion) = {
            let mut state = self.lock_state();
            if state.revoked_owners.contains(&owner) {
                return Err(WatchStartError::without_cleanup(
                    WatchNativeError::OwnerRevoked,
                ));
            }
            let raw_generation = state
                .next_generation
                .ok_or_else(|| {
                    WatchStartError::without_cleanup(WatchNativeError::GenerationExhausted)
                })?;
            state.next_generation = raw_generation.checked_add(1);
            let generation = WatchGeneration::new(raw_generation)
                .ok_or_else(|| {
                    WatchStartError::without_cleanup(WatchNativeError::GenerationExhausted)
                })?;
            let reservation = Arc::new(StartReservation::new(generation));
            let completion = ReservationCompletion::new(Arc::clone(&reservation));
            let previous = state.entries.insert(
                registry_key.clone(),
                RegistryEntry::Starting(Arc::clone(&reservation)),
            );
            (generation, reservation, previous, completion)
        };

        if let Some(previous) = previous {
            stop_registry_entry(previous);
        }

        if reservation.is_cancelled() {
            return Err(WatchStartError::without_cleanup(
                self.reservation_error(&owner),
            ));
        }

        let key = WatchSubscriptionKey {
            owner: owner.clone(),
            workspace_id: workspace_id.clone(),
            generation,
        };
        let subscription =
            match NativeWatchSubscription::start_reserved(
                key,
                verified_dir,
                validator,
                config,
                reaper_permit,
            ) {
                Ok(subscription) => Arc::new(subscription),
                Err(error) => {
                    self.remove_starting_if_current(&registry_key, &reservation);
                    return Err(WatchStartError::without_cleanup(error));
                }
            };

        if !reservation.attach(Arc::clone(&subscription)) {
            subscription.request_stop();
            return Err(WatchStartError::with_cleanup(
                self.reservation_error(&owner),
                subscription,
            ));
        }

        let installation = {
            let mut state = self.lock_state();
            if state.revoked_owners.contains(&owner) {
                Err(WatchNativeError::OwnerRevoked)
            } else {
                let is_current = matches!(
                    state.entries.get(&registry_key),
                    Some(RegistryEntry::Starting(current))
                        if Arc::ptr_eq(current, &reservation)
                );
                if is_current {
                    state.entries.insert(
                        registry_key.clone(),
                        RegistryEntry::Active(Arc::clone(&subscription)),
                    );
                    Ok(())
                } else {
                    Err(WatchNativeError::SubscriptionSuperseded)
                }
            }
        };

        if let Err(error) = installation {
            subscription.request_stop();
            self.remove_starting_if_current(&registry_key, &reservation);
            return Err(WatchStartError::with_cleanup(error, subscription));
        }

        reservation.finish();
        Ok((generation, subscription))
    }

    /// Drains ready signals for `(owner, workspace_id, generation)`, rejecting
    /// stale generations or revoked subscriptions.
    pub fn drain(
        &self,
        owner: &OwnerId,
        workspace_id: &WorkspaceId,
        generation: WatchGeneration,
    ) -> Result<Vec<WatchSignal>, WatchAccessError> {
        let subscription = {
            let state = self.lock_state();
            match state.entries.get(&(owner.clone(), workspace_id.clone())) {
                Some(RegistryEntry::Active(subscription)) => {
                    let expected = subscription.key().generation;
                    if expected != generation {
                        return Err(WatchAccessError::StaleGeneration {
                            expected,
                            actual: generation,
                        });
                    }
                    Arc::clone(subscription)
                }
                Some(entry @ RegistryEntry::Starting(_)) => {
                    let expected = entry.generation();
                    if expected != generation {
                        return Err(WatchAccessError::StaleGeneration {
                            expected,
                            actual: generation,
                        });
                    }
                    return Err(WatchAccessError::SubscriptionStopped);
                }
                None => return Err(WatchAccessError::SubscriptionStopped),
            }
        };
        subscription.drain_signals(owner, workspace_id, generation)
    }

    /// Final synchronous dispatch gate for a batch returned by [`Self::drain`].
    /// Signal tags are checked against the requested binding, and the registry
    /// lifecycle mutex remains held through the callback. This linearizes the
    /// actual dispatch against subscription replacement and unsubscribe/revoke.
    ///
    /// The callback MUST be synchronous and non-reentrant: it must not call this
    /// registry's methods, await or block on async work, or hand off work that may
    /// emit later. Keep it limited to synchronous, owner-targeted event emission.
    pub fn dispatch_if_current(
        &self,
        owner: &OwnerId,
        workspace_id: &WorkspaceId,
        generation: WatchGeneration,
        signals: &[WatchSignal],
        dispatch: impl FnOnce(&[WatchSignal]),
    ) -> Result<(), WatchAccessError> {
        let state = self.lock_state();
        if state.revoked_owners.contains(owner) {
            return Err(WatchAccessError::SubscriptionStopped);
        }

        match state.entries.get(&(owner.clone(), workspace_id.clone())) {
            Some(RegistryEntry::Active(subscription)) => {
                let expected = subscription.key().generation;
                if expected != generation {
                    return Err(WatchAccessError::StaleGeneration {
                        expected,
                        actual: generation,
                    });
                }
                if subscription.is_stopped() {
                    return Err(WatchAccessError::SubscriptionStopped);
                }
            }
            Some(RegistryEntry::Starting(reservation)) => {
                if reservation.generation != generation {
                    return Err(WatchAccessError::StaleGeneration {
                        expected: reservation.generation,
                        actual: generation,
                    });
                }
                return Err(WatchAccessError::SubscriptionStopped);
            }
            None => return Err(WatchAccessError::SubscriptionStopped),
        }

        for signal in signals {
            let (signal_owner, signal_workspace, signal_generation) = match signal {
                WatchSignal::Event {
                    owner,
                    generation,
                    event,
                    ..
                } => (owner, &event.workspace_id, *generation),
                WatchSignal::ResyncRequired {
                    owner,
                    workspace_id,
                    generation,
                    ..
                }
                | WatchSignal::Failure {
                    owner,
                    workspace_id,
                    generation,
                    ..
                } => (owner, workspace_id, *generation),
            };
            if signal_owner != owner {
                return Err(WatchAccessError::OwnerMismatch);
            }
            if signal_workspace != workspace_id {
                return Err(WatchAccessError::WorkspaceMismatch);
            }
            if signal_generation != generation {
                return Err(WatchAccessError::StaleGeneration {
                    expected: generation,
                    actual: signal_generation,
                });
            }
        }

        dispatch(signals);
        Ok(())
    }

    /// Stops a specific workspace subscription if the generation matches (or
    /// unconditionally for `(owner, workspace_id)` when `generation` is `None`).
    /// A matching in-flight start is also invalidated and joined before return.
    pub fn unsubscribe(
        &self,
        owner: &OwnerId,
        workspace_id: &WorkspaceId,
        generation: Option<WatchGeneration>,
    ) -> bool {
        let key = (owner.clone(), workspace_id.clone());
        let removed = {
            let mut state = self.lock_state();
            let matches = state
                .entries
                .get(&key)
                .map(|entry| generation.is_none_or(|expected| entry.generation() == expected))
                .unwrap_or(false);
            if matches {
                state.entries.remove(&key)
            } else {
                None
            }
        };
        if let Some(entry) = removed {
            stop_registry_entry(entry);
            true
        } else {
            false
        }
    }

    /// Revokes a workspace subscription without requiring its generation.
    /// This also cancels a start reservation that has not yet installed a worker.
    pub fn revoke_workspace(&self, owner: &OwnerId, workspace_id: &WorkspaceId) -> bool {
        self.unsubscribe(owner, workspace_id, None)
    }

    /// Revokes all active subscriptions belonging to `owner` (e.g., on window close),
    /// cancelling pending `ReadDirectoryChangesW` I/O and joining worker threads.
    /// The owner label remains revoked for this registry's lifetime, preventing a
    /// late start or a reused label from restoring its event authority.
    pub fn revoke_owner(&self, owner: &OwnerId) -> usize {
        let (to_stop, active_count) = {
            let mut state = self.lock_state();
            state.revoked_owners.insert(owner.clone());
            let keys: Vec<(OwnerId, WorkspaceId)> = state
                .entries
                .keys()
                .filter(|key| &key.0 == owner)
                .cloned()
                .collect();
            let mut to_stop = Vec::with_capacity(keys.len());
            let mut active_count = 0usize;
            for key in keys {
                if let Some(entry) = state.entries.remove(&key) {
                    if matches!(entry, RegistryEntry::Active(_)) {
                        active_count += 1;
                    }
                    to_stop.push(entry);
                }
            }
            (to_stop, active_count)
        };

        for entry in to_stop {
            stop_registry_entry(entry);
        }
        active_count
    }
}

#[cfg(windows)]
fn stop_registry_entry(entry: RegistryEntry) {
    match entry {
        RegistryEntry::Starting(reservation) => reservation.cancel(),
        RegistryEntry::Active(subscription) => subscription.request_stop(),
    }
}

// ---- Native & Adversarial Tests ------------------------------------------

#[cfg(all(test, windows))]
#[path = "../../tests/unit/watch_native.rs"]
mod tests;
