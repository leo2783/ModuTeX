// SPDX-License-Identifier: Apache-2.0
//! G2 DesktopPort filesystem coordinator (`src/filesystem.rs`).
//!
//! Combines [`SessionRegistry`], [`WorkspaceLeaseCoordinator`], [`TrustedRoot`],
//! [`RecentStore`], and [`SettingsStore`] to coordinate file lifecycle, compile
//! leases, and compile result validation without exposing absolute paths to the
//! renderer; compile engine execution and IPC are separate.

use std::{
    collections::{BTreeMap, HashMap, HashSet},
    error::Error,
    ffi::c_void,
    fmt,
    fs::{self, File, OpenOptions},
    io,
    panic::{catch_unwind, AssertUnwindSafe},
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Condvar, Mutex, MutexGuard, PoisonError, Weak,
    },
    time::{Duration, Instant},
};

use serde::Serialize;
use serde_json::Value;

use crate::{
    platform::file_identity::{
        file_identity as native_file_identity, is_symlink_or_reparse, open_directory_no_follow,
        open_file_no_follow,
    },
    platform::windows_files::{FileIdentity, FsError, RecoveryOutcome, TrustedRoot},
    schemas::protocol::{
        read_limit, validate_pdf, CompileIdentity, CompileRequest, CompileResult, DocumentId,
        DocumentVersion, FileEntry, FileEvent, FileEventKind, FileKind, FileRef, FileWatchFailure,
        HostHealth, OwnerId, ProtocolError, ReadReceipt, RecentDocument, Revision, RunId,
        SaveAsReceipt, SaveAsRequest, Timestamp, WorkspaceId, WorkspaceInfo, WorkspaceKind,
        WriteReceipt, WriteRequest, MAX_PDF_BYTES,
    },
    services::git_service::{
        GitPathFailure, GitPathIntent, GitPathKind, GitWorkspaceCapability, GitWorkspaceFailure,
    },
    shared::relative_path::{PathError, RelativePath},
    state::recent::{
        validate_recent_entry_path, RecentErrorCode, RecentStore, RecentStoreError,
        ResolvedRecentTarget, TrustedRecentTarget, TrustedWorkspaceCapability,
        TrustedWorkspaceSelection, WorkspaceOpenOutcome,
    },
    state::sessions::{SessionError, SessionRegistry},
    state::settings::{
        ImportPreferencesResult, PreferenceValue, Preferences, ReadPreferencesResult,
        SettingsErrorCode, SettingsStore, SettingsStoreError,
    },
    state::workspace_leases::{
        CanonicalRootPath, LeaseError, LeaseGuard, LeaseKind, RootIdentity, SessionGeneration,
        TrustedWorkspaceRoot, WorkspaceLeaseCoordinator,
    },
};

pub const DEFAULT_CLOSE_DRAIN_TIMEOUT: Duration = Duration::from_secs(5);
pub const MAX_TASKS_PER_WORKSPACE: usize = 64;
pub const MAX_RETIRING_WORKSPACES_PER_OWNER: usize = 16;
pub const MAX_RETIRING_WORKSPACES: usize = 64;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum FilesystemErrorCode {
    UnknownWorkspace,
    SessionClosed,
    StaleGeneration,
    WorkspaceBusy,
    TimedOut,
    Cancelled,
    NotFound,
    AccessDenied,
    SharingViolation,
    NotADirectory,
    IsADirectory,
    LinkNotAllowed,
    StaleWorkspace,
    InvalidPath,
    CorruptDirectoryRecord,
    TreeTooLarge,
    TreeTooDeep,
    FileTooLarge,
    RevisionConflict,
    RecoveryRequired,
    DocumentIdentityMismatch,
    StaleDocumentVersion,
    CompileIdentityMismatch,
    CleanupUnproven,
    StoreError,
    ProtocolViolation,
    ResourceExhausted,
    IoFailed,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum FilesystemError {
    UnknownWorkspace,
    SessionClosed,
    StaleGeneration,
    WorkspaceBusy,
    TimedOut,
    Cancelled,
    NotFound,
    AccessDenied,
    SharingViolation,
    NotADirectory,
    IsADirectory,
    LinkNotAllowed,
    StaleWorkspace,
    InvalidPath(String),
    CorruptDirectoryRecord,
    TreeTooLarge,
    TreeTooDeep,
    FileTooLarge {
        size: u64,
        limit: usize,
    },
    RevisionConflict {
        expected: Option<Revision>,
        actual: Option<Revision>,
    },
    RecoveryRequired,
    DocumentIdentityMismatch {
        expected: DocumentId,
        actual: DocumentId,
    },
    StaleDocumentVersion {
        expected_min: DocumentVersion,
        actual: DocumentVersion,
    },
    CompileIdentityMismatch(&'static str),
    CleanupUnproven {
        workspace_id: Option<WorkspaceId>,
        reason: String,
    },
    Store {
        code: &'static str,
        message: String,
    },
    Protocol(ProtocolError),
    ResourceExhausted,
    Io(u32),
}

impl FilesystemError {
    pub const fn code(&self) -> FilesystemErrorCode {
        match self {
            Self::UnknownWorkspace => FilesystemErrorCode::UnknownWorkspace,
            Self::SessionClosed => FilesystemErrorCode::SessionClosed,
            Self::StaleGeneration => FilesystemErrorCode::StaleGeneration,
            Self::WorkspaceBusy => FilesystemErrorCode::WorkspaceBusy,
            Self::TimedOut => FilesystemErrorCode::TimedOut,
            Self::Cancelled => FilesystemErrorCode::Cancelled,
            Self::NotFound => FilesystemErrorCode::NotFound,
            Self::AccessDenied => FilesystemErrorCode::AccessDenied,
            Self::SharingViolation => FilesystemErrorCode::SharingViolation,
            Self::NotADirectory => FilesystemErrorCode::NotADirectory,
            Self::IsADirectory => FilesystemErrorCode::IsADirectory,
            Self::LinkNotAllowed => FilesystemErrorCode::LinkNotAllowed,
            Self::StaleWorkspace => FilesystemErrorCode::StaleWorkspace,
            Self::InvalidPath(_) => FilesystemErrorCode::InvalidPath,
            Self::CorruptDirectoryRecord => FilesystemErrorCode::CorruptDirectoryRecord,
            Self::TreeTooLarge => FilesystemErrorCode::TreeTooLarge,
            Self::TreeTooDeep => FilesystemErrorCode::TreeTooDeep,
            Self::FileTooLarge { .. } => FilesystemErrorCode::FileTooLarge,
            Self::RevisionConflict { .. } => FilesystemErrorCode::RevisionConflict,
            Self::RecoveryRequired => FilesystemErrorCode::RecoveryRequired,
            Self::DocumentIdentityMismatch { .. } => FilesystemErrorCode::DocumentIdentityMismatch,
            Self::StaleDocumentVersion { .. } => FilesystemErrorCode::StaleDocumentVersion,
            Self::CompileIdentityMismatch(_) => FilesystemErrorCode::CompileIdentityMismatch,
            Self::CleanupUnproven { .. } => FilesystemErrorCode::CleanupUnproven,
            Self::Store { .. } => FilesystemErrorCode::StoreError,
            Self::Protocol(_) => FilesystemErrorCode::ProtocolViolation,
            Self::ResourceExhausted => FilesystemErrorCode::ResourceExhausted,
            Self::Io(_) => FilesystemErrorCode::IoFailed,
        }
    }
}

impl fmt::Display for FilesystemError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:?}: {self:?}", self.code())
    }
}

impl Error for FilesystemError {}

impl From<FsError> for FilesystemError {
    fn from(err: FsError) -> Self {
        match err {
            FsError::NotFound => Self::NotFound,
            FsError::AccessDenied => Self::AccessDenied,
            FsError::SharingViolation => Self::SharingViolation,
            FsError::NotADirectory => Self::NotADirectory,
            FsError::IsADirectory => Self::IsADirectory,
            FsError::LinkNotAllowed => Self::LinkNotAllowed,
            FsError::StaleWorkspace => Self::StaleWorkspace,
            FsError::InvalidPath => Self::InvalidPath("invalid native segment path".to_owned()),
            FsError::CorruptDirectoryRecord => Self::CorruptDirectoryRecord,
            FsError::TreeTooLarge => Self::TreeTooLarge,
            FsError::TreeTooDeep => Self::TreeTooDeep,
            FsError::FileTooLarge { size, limit } => Self::FileTooLarge { size, limit },
            FsError::Cancelled => Self::Cancelled,
            FsError::RevisionConflict { expected, actual } => {
                Self::RevisionConflict { expected, actual }
            }
            FsError::RecoveryRequired => Self::RecoveryRequired,
            FsError::Io(code) => Self::Io(code),
        }
    }
}

impl From<SessionError> for FilesystemError {
    fn from(err: SessionError) -> Self {
        match err {
            SessionError::RootNotAbsolute => {
                Self::InvalidPath("workspace root must be absolute".to_owned())
            }
            SessionError::RootNotDirectory => Self::NotADirectory,
            SessionError::IdsExhausted => Self::ResourceExhausted,
            SessionError::UnknownSession => Self::UnknownWorkspace,
        }
    }
}

impl From<LeaseError> for FilesystemError {
    fn from(err: LeaseError) -> Self {
        match err {
            LeaseError::InvalidRootPath => {
                Self::InvalidPath("invalid canonical workspace root".to_owned())
            }
            LeaseError::InvalidTimeout | LeaseError::TimedOut => Self::TimedOut,
            LeaseError::UnknownSession => Self::UnknownWorkspace,
            LeaseError::SessionClosed => Self::SessionClosed,
            LeaseError::StaleGeneration => Self::StaleGeneration,
            LeaseError::WorkspaceAlreadyUsed | LeaseError::CounterOverflow => {
                Self::ResourceExhausted
            }
            LeaseError::WouldBlock => Self::WorkspaceBusy,
            LeaseError::Cancelled => Self::Cancelled,
        }
    }
}

impl From<PathError> for FilesystemError {
    fn from(err: PathError) -> Self {
        Self::InvalidPath(err.to_string())
    }
}

impl From<ProtocolError> for FilesystemError {
    fn from(err: ProtocolError) -> Self {
        Self::Protocol(err)
    }
}

impl From<RecentStoreError> for FilesystemError {
    fn from(err: RecentStoreError) -> Self {
        match err.code() {
            RecentErrorCode::InvalidId | RecentErrorCode::InvalidTarget => {
                Self::InvalidPath(err.message().to_owned())
            }
            RecentErrorCode::NotFound | RecentErrorCode::TargetMissing => Self::NotFound,
            RecentErrorCode::LinkNotAllowed => Self::LinkNotAllowed,
            RecentErrorCode::OversizeStore => Self::Store {
                code: "OVERSIZE_STORE",
                message: err.message().to_owned(),
            },
            RecentErrorCode::MalformedSchema => Self::Store {
                code: "MALFORMED_SCHEMA",
                message: err.message().to_owned(),
            },
            RecentErrorCode::PersistenceFailed => Self::Store {
                code: "PERSISTENCE_FAILED",
                message: err.message().to_owned(),
            },
            RecentErrorCode::IoFailed => Self::Store {
                code: "IO_FAILED",
                message: err.message().to_owned(),
            },
        }
    }
}

impl From<SettingsStoreError> for FilesystemError {
    fn from(err: SettingsStoreError) -> Self {
        match err.code() {
            SettingsErrorCode::LinkNotAllowed => Self::LinkNotAllowed,
            SettingsErrorCode::InvalidPreference => Self::Store {
                code: "INVALID_PREFERENCE",
                message: err.message().to_owned(),
            },
            SettingsErrorCode::OversizeStore => Self::Store {
                code: "OVERSIZE_STORE",
                message: err.message().to_owned(),
            },
            SettingsErrorCode::MalformedSchema => Self::Store {
                code: "MALFORMED_SCHEMA",
                message: err.message().to_owned(),
            },
            SettingsErrorCode::SameAsLegacyDataDir => Self::Store {
                code: "SAME_AS_LEGACY_DATA_DIR",
                message: err.message().to_owned(),
            },
            SettingsErrorCode::PersistenceFailed => Self::Store {
                code: "PERSISTENCE_FAILED",
                message: err.message().to_owned(),
            },
            SettingsErrorCode::IoFailed => Self::Store {
                code: "IO_FAILED",
                message: err.message().to_owned(),
            },
        }
    }
}

pub fn map_fs_error_to_watch_failure(err: &FsError) -> FileWatchFailure {
    match err {
        FsError::TreeTooDeep => FileWatchFailure::TreeTooDeep,
        FsError::TreeTooLarge => FileWatchFailure::TreeTooLarge,
        FsError::StaleWorkspace => FileWatchFailure::StaleWorkspace,
        FsError::LinkNotAllowed => FileWatchFailure::LinkNotAllowed,
        _ => FileWatchFailure::FileOperationFailed,
    }
}

#[cfg(windows)]
use crate::platform::file_identity::query_raw_handle_metadata;

#[cfg(windows)]
#[link(name = "kernel32")]
extern "system" {
    fn GetFinalPathNameByHandleW(
        file: *mut c_void,
        file_path: *mut u16,
        file_path_len: u32,
        flags: u32,
    ) -> u32;
    fn GetLastError() -> u32;
}

#[cfg(windows)]
fn query_std_file_identity(
    file: &File,
    expect_dir: bool,
) -> Result<(FileIdentity, u64), FilesystemError> {
    use std::os::windows::io::AsRawHandle;

    const FILE_ATTRIBUTE_DIRECTORY: u32 = 0x0010;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;

    let (identity, attributes, size) =
        query_raw_handle_metadata(file.as_raw_handle()).map_err(|error| match error.kind() {
            io::ErrorKind::NotFound => FilesystemError::NotFound,
            io::ErrorKind::PermissionDenied => FilesystemError::AccessDenied,
            _ => FilesystemError::Io(error.raw_os_error().map_or(0, |code| code as u32)),
        })?;
    if (attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0 {
        return Err(FilesystemError::LinkNotAllowed);
    }
    let is_dir = (attributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
    if expect_dir && !is_dir {
        return Err(FilesystemError::NotADirectory);
    }
    if !expect_dir && is_dir {
        return Err(FilesystemError::IsADirectory);
    }
    Ok((identity, size))
}

#[cfg(windows)]
fn query_final_path_from_handle(file: &File) -> Result<(String, PathBuf), FilesystemError> {
    use std::os::windows::io::AsRawHandle;
    let raw = file.as_raw_handle();
    let mut buf = vec![0u16; 1024];
    let mut len = unsafe { GetFinalPathNameByHandleW(raw, buf.as_mut_ptr(), buf.len() as u32, 0) };
    if len == 0 {
        return Err(FilesystemError::Io(unsafe { GetLastError() }));
    }
    if (len as usize) >= buf.len() {
        buf.resize((len as usize) + 1, 0);
        len = unsafe { GetFinalPathNameByHandleW(raw, buf.as_mut_ptr(), buf.len() as u32, 0) };
        if len == 0 || (len as usize) >= buf.len() {
            return Err(FilesystemError::Io(unsafe { GetLastError() }));
        }
    }
    let raw_final = String::from_utf16(&buf[..len as usize])
        .map_err(|_| FilesystemError::InvalidPath("non-UTF16 final handle path".to_owned()))?;
    let clean = if let Some(unc) = raw_final
        .get(..8)
        .filter(|p| p.eq_ignore_ascii_case("\\\\?\\UNC\\"))
        .and_then(|_| raw_final.get(8..))
    {
        format!("\\\\{unc}")
    } else if let Some(rest) = raw_final.strip_prefix("\\\\?\\") {
        rest.to_owned()
    } else {
        raw_final.clone()
    };
    Ok((raw_final, PathBuf::from(clean)))
}

#[cfg(windows)]
fn open_dir_no_follow_pinned(path: &Path) -> Result<File, FilesystemError> {
    use std::os::windows::fs::OpenOptionsExt;
    const FILE_SHARE_READ: u32 = 0x0000_0001;
    const FILE_SHARE_WRITE: u32 = 0x0000_0002;
    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;

    OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS)
        .open(path)
        .map_err(|err| match err.kind() {
            io::ErrorKind::NotFound => FilesystemError::NotFound,
            io::ErrorKind::PermissionDenied => FilesystemError::AccessDenied,
            _ => FilesystemError::Io(err.raw_os_error().unwrap_or(1) as u32),
        })
}

struct PinnedValidatedRoot {
    trusted_root: Arc<TrustedRoot>,
    workspace_root: TrustedWorkspaceRoot,
    canonical_path: PathBuf,
}

fn pin_and_validate_root(path: &Path) -> Result<PinnedValidatedRoot, FilesystemError> {
    if !path.is_absolute() {
        return Err(FilesystemError::InvalidPath(
            "workspace root path must be absolute".to_owned(),
        ));
    }
    let mut walk = PathBuf::new();
    let mut pinned_chain = Vec::new();
    for comp in path.components() {
        match comp {
            Component::Prefix(prefix) => walk.push(prefix.as_os_str()),
            Component::RootDir => {
                walk.push(comp.as_os_str());
                let dir = open_dir_no_follow_pinned(&walk)?;
                let _ = query_std_file_identity(&dir, true)?;
                pinned_chain.push(dir);
            }
            Component::CurDir => {}
            Component::ParentDir => {
                return Err(FilesystemError::InvalidPath(
                    "parent traversal segment not allowed in workspace root".to_owned(),
                ));
            }
            Component::Normal(seg) => {
                walk.push(seg);
                let dir = open_dir_no_follow_pinned(&walk)?;
                let _ = query_std_file_identity(&dir, true)?;
                pinned_chain.push(dir);
            }
        }
    }
    let leaf_dir = pinned_chain.last().ok_or_else(|| {
        FilesystemError::InvalidPath("workspace root has no directory handle".to_owned())
    })?;
    let (pinned_id, _) = query_std_file_identity(leaf_dir, true)?;
    let (raw_final, clean_canonical) = query_final_path_from_handle(leaf_dir)?;
    let canonical_root_path = CanonicalRootPath::parse(&raw_final)?;

    // Open TrustedRoot while every ancestor directory handle in `pinned_chain` is held without
    // FILE_SHARE_DELETE, then verify the handle FileIdentity matches `pinned_id`.
    let trusted_root = TrustedRoot::open(&clean_canonical)?;
    let verified_id = trusted_root.verify_alive()?;
    if verified_id != pinned_id {
        return Err(FilesystemError::StaleWorkspace);
    }
    let root_identity = RootIdentity::new(verified_id.volume_serial, verified_id.file_id);
    let workspace_root = TrustedWorkspaceRoot::new(root_identity, canonical_root_path);
    Ok(PinnedValidatedRoot {
        trusted_root: Arc::new(trusted_root),
        workspace_root,
        canonical_path: clean_canonical,
    })
}

fn pin_from_capability(
    capability: &TrustedWorkspaceCapability,
    kind: WorkspaceKind,
    entry_path: &Option<RelativePath>,
) -> Result<PinnedValidatedRoot, FilesystemError> {
    capability.validate_for_workspace_open()?;
    let (cap_root_id, _) = query_std_file_identity(capability.root_handle(), true)?;
    let (_, clean_root_path) = query_final_path_from_handle(capability.root_handle())?;
    let pinned = pin_and_validate_root(&clean_root_path)?;
    if pinned.trusted_root.identity() != cap_root_id {
        return Err(FilesystemError::LinkNotAllowed);
    }
    if let Some(ref entry_rel) = entry_path {
        let entry_file = capability
            .entry_handle()
            .ok_or_else(|| FilesystemError::InvalidPath("missing capability entry".to_owned()))?;
        let (cap_entry_id, _) = query_std_file_identity(entry_file, false)?;
        let read_out = if entry_rel.as_str().to_ascii_lowercase().ends_with(".pdf") {
            pinned.trusted_root.read_file_pdf(entry_rel)?
        } else {
            pinned.trusted_root.read_file(entry_rel)?
        };
        if read_out.identity != cap_entry_id {
            return Err(FilesystemError::LinkNotAllowed);
        }
    } else if kind == WorkspaceKind::File {
        return Err(FilesystemError::InvalidPath(
            "file workspace requires entryPath".to_owned(),
        ));
    }
    Ok(pinned)
}

#[cfg(all(windows, target_arch = "x86_64"))]
fn native_open_io_error(error: io::Error) -> FilesystemError {
    match error.kind() {
        io::ErrorKind::NotFound => FilesystemError::NotFound,
        io::ErrorKind::PermissionDenied => FilesystemError::AccessDenied,
        _ => FilesystemError::Io(error.raw_os_error().map_or(1, |code| code as u32)),
    }
}

#[cfg(all(windows, target_arch = "x86_64"))]
fn verify_native_open_root_identity(
    root_path: &Path,
    expected: FileIdentity,
) -> Result<(), FilesystemError> {
    let root = open_directory_no_follow(root_path).map_err(native_open_io_error)?;
    if native_file_identity(&root).map_err(native_open_io_error)? != expected {
        return Err(FilesystemError::StaleWorkspace);
    }
    Ok(())
}

#[cfg(all(windows, target_arch = "x86_64"))]
fn stat_native_open_target_identity(
    file_path: &Path,
) -> Result<(RootIdentity, RelativePath, FileIdentity), FilesystemError> {
    if !crate::state::pending_open::is_native_open_path(file_path) {
        return Err(FilesystemError::InvalidPath(
            "unsupported native document path".to_owned(),
        ));
    }
    let parent = file_path.parent().ok_or_else(|| {
        FilesystemError::InvalidPath("document path has no parent directory".to_owned())
    })?;
    let file_name = file_path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| FilesystemError::InvalidPath("invalid document name".to_owned()))?;
    let relative = RelativePath::parse(file_name)?;
    let pinned = pin_and_validate_root(parent)?;
    let root_file_identity = pinned.trusted_root.identity();
    let stat = pinned.trusted_root.stat(&relative)?;
    if stat.kind != FileKind::File {
        return Err(FilesystemError::InvalidPath(
            "native document target is not a regular file".to_owned(),
        ));
    }

    verify_native_open_root_identity(&pinned.canonical_path, root_file_identity)?;
    let target_path = pinned.canonical_path.join(relative.as_str());
    let path_metadata = fs::symlink_metadata(&target_path).map_err(native_open_io_error)?;
    if is_symlink_or_reparse(&path_metadata) {
        return Err(FilesystemError::LinkNotAllowed);
    }
    if !path_metadata.is_file() {
        return Err(FilesystemError::InvalidPath(
            "native document target is not a regular file".to_owned(),
        ));
    }
    let file = open_file_no_follow(&target_path).map_err(native_open_io_error)?;
    let opened_metadata = file.metadata().map_err(native_open_io_error)?;
    if is_symlink_or_reparse(&opened_metadata) {
        return Err(FilesystemError::LinkNotAllowed);
    }
    if !opened_metadata.is_file() {
        return Err(FilesystemError::InvalidPath(
            "native document target is not a regular file".to_owned(),
        ));
    }
    let identity = native_file_identity(&file).map_err(native_open_io_error)?;
    pinned.trusted_root.verify_alive()?;
    verify_native_open_root_identity(&pinned.canonical_path, root_file_identity)?;
    Ok((pinned.workspace_root.identity(), relative, identity))
}

fn is_internal_recovery_name(path: &RelativePath) -> bool {
    path.as_str().split('/').any(|seg| {
        seg.starts_with(".modutex-stage-")
            || seg.starts_with(".modutex-bak-")
            || seg.starts_with(".modutex-txn-")
            || seg.starts_with(".modutex-trash-")
            || seg.starts_with(".modutex-copy-")
            || seg.starts_with(".modutex-recycle-")
    })
}

#[derive(Clone, Debug)]
struct TrackedDocument {
    document_id: Option<DocumentId>,
    document_version: Option<DocumentVersion>,
    revision: Revision,
    identity: FileIdentity,
}

fn update_read_identity(
    tracked: &mut TrackedDocument,
    revision: Revision,
    identity: FileIdentity,
) -> Result<(), FilesystemError> {
    match (&tracked.document_id, tracked.document_version) {
        (Some(_), Some(version)) if tracked.revision != revision => {
            let next = version.get().checked_add(1).ok_or_else(|| {
                FilesystemError::Protocol(ProtocolError::new(
                    "documentVersion",
                    "document version exhausted",
                ))
            })?;
            tracked.document_version = Some(DocumentVersion::new(next)?);
        }
        (Some(_), Some(_)) | (None, None) => {}
        _ => {
            return Err(FilesystemError::Protocol(ProtocolError::new(
                "documentId",
                "tracked document identity must include both ID and version",
            )))
        }
    }
    tracked.revision = revision;
    tracked.identity = identity;
    Ok(())
}

pub type SubSystemCanceller = Box<dyn FnOnce() -> Result<(), String> + Send + 'static>;

const MAX_GIT_PIN_HANDLES: usize = 131_072;

#[derive(Default)]
struct GitPathPins {
    _handles: Vec<File>,
    identities: HashSet<FileIdentity>,
}

impl GitPathPins {
    fn retain(&mut self, file: File, identity: FileIdentity) -> Result<(), GitPathFailure> {
        if self.identities.contains(&identity) {
            return Ok(());
        }
        if self._handles.len() >= MAX_GIT_PIN_HANDLES {
            return Err(GitPathFailure::Unavailable);
        }
        self.identities.insert(identity);
        self._handles.push(file);
        Ok(())
    }
}

struct RegisteredTask {
    canceller: Option<SubSystemCanceller>,
    drained: Arc<AtomicBool>,
    abandoned: bool,
    drain_handles: usize,
    cancel_failed: Option<String>,
    lease: Option<LeaseGuard>,
    pins: GitPathPins,
}

struct SlotState {
    revoked: bool,
    closing_in_flight: bool,
    active_ops: usize,
    documents: HashMap<RelativePath, TrackedDocument>,
    doc_paths: HashMap<DocumentId, RelativePath>,
    tasks: HashMap<u64, RegisteredTask>,
}

#[derive(Clone, Copy, Debug)]
struct TaskDrainOptions {
    release_handle: bool,
    remove_if_active: bool,
}

struct WorkspaceSlot {
    workspace_id: WorkspaceId,
    owner: OwnerId,
    generation: SessionGeneration,
    kind: WorkspaceKind,
    info: WorkspaceInfo,
    canonical_root: PathBuf,
    root_meta: TrustedWorkspaceRoot,
    trusted_root: Arc<TrustedRoot>,
    state: Mutex<SlotState>,
    condvar: Condvar,
    delivery: Mutex<()>,
}

impl WorkspaceSlot {
    fn lock(&self) -> MutexGuard<'_, SlotState> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

struct ActiveOpGuard {
    service: FilesystemService,
    slot: Arc<WorkspaceSlot>,
    lease: Option<LeaseGuard>,
}

impl Drop for ActiveOpGuard {
    fn drop(&mut self) {
        drop(self.lease.take());
        let finalize_retiring = {
            let mut guard = self.slot.lock();
            guard.active_ops = guard.active_ops.saturating_sub(1);
            let ready = guard.revoked
                && !guard.closing_in_flight
                && guard.active_ops == 0
                && guard.tasks.values().all(|t| {
                    t.drained.load(Ordering::Acquire)
                        && t.cancel_failed.is_none()
                        && t.lease.is_none()
                });
            if ready {
                guard.tasks.clear();
            }
            self.slot.condvar.notify_all();
            ready
        };
        if finalize_retiring {
            self.service
                .finalize_retiring_slot(&self.slot.owner, &self.slot.workspace_id);
        }
    }
}

pub struct TerminalWorkspace {
    _op: ActiveOpGuard,
    generation: SessionGeneration,
    root: PathBuf,
}

impl TerminalWorkspace {
    pub fn generation(&self) -> SessionGeneration {
        self.generation
    }

    pub fn root(&self) -> &Path {
        &self.root
    }
}

/// A narrowly scoped G2 file-operation admission. It keeps the existing
/// workspace slot, owner, generation and coordinator lease alive while native
/// TrustedRoot primitives run; callers cannot provide or replace the
/// generation.
pub(crate) struct WorkspaceFileAccess {
    pub(crate) root: Arc<TrustedRoot>,
    pub(crate) generation: SessionGeneration,
    _active: ActiveOpGuard,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum WatchNotification {
    Event(FileEvent),
    Failure {
        workspace_id: WorkspaceId,
        failure: FileWatchFailure,
    },
    ResyncRequired {
        workspace_id: WorkspaceId,
        reason: crate::schemas::protocol::FileWatchResyncReason,
    },
}

/// Trusted immediate event sink for host synchronous serialized file-event delivery.
///
/// # Non-Reentrancy Contract
/// Implementations of this sink are called synchronously under a host delivery lock
/// to guarantee serialized delivery and prevent late callbacks from escaping after
/// workspace revocation or session close.
///
/// This sink MUST BE NON-REENTRANT: the host adapter MUST NOT invoke re-entrant
/// filesystem service operations synchronously from within the sink callback, to avoid
/// deadlock.
pub type WatchSink = Arc<dyn Fn(WatchNotification) + Send + Sync + 'static>;

struct TaskDrainHandleInner {
    service: FilesystemService,
    slot: Weak<WorkspaceSlot>,
    sink: WatchSink,
    owner: OwnerId,
    workspace_id: WorkspaceId,
    generation: SessionGeneration,
    task_id: u64,
    drained: Arc<AtomicBool>,
    released: AtomicBool,
}

impl Drop for TaskDrainHandleInner {
    fn drop(&mut self) {
        if !self.released.swap(true, Ordering::AcqRel) {
            self.service
                .abandon_task_handle(&self.workspace_id, self.generation, self.task_id);
        }
    }
}

#[derive(Clone)]
pub struct TaskDrainHandle {
    inner: Arc<TaskDrainHandleInner>,
}

impl TaskDrainHandle {
    pub fn workspace_id(&self) -> &WorkspaceId {
        &self.inner.workspace_id
    }

    pub fn generation(&self) -> SessionGeneration {
        self.inner.generation
    }

    pub fn task_id(&self) -> u64 {
        self.inner.task_id
    }

    pub fn is_drained(&self) -> bool {
        self.inner.drained.load(Ordering::Acquire)
    }

    pub fn emit_file_event(
        &self,
        path: RelativePath,
        kind: FileEventKind,
    ) -> Result<bool, FilesystemError> {
        if is_internal_recovery_name(&path) {
            return Ok(false);
        }
        self.dispatch_if_current(WatchNotification::Event(FileEvent {
            workspace_id: self.inner.workspace_id.clone(),
            path,
            kind,
        }))
    }

    pub fn emit_failure(&self, failure: FileWatchFailure) -> Result<(), FilesystemError> {
        self.dispatch_if_current(WatchNotification::Failure {
            workspace_id: self.inner.workspace_id.clone(),
            failure,
        })
        .map(|_| ())
    }

    pub(crate) fn emit_resync(
        &self,
        reason: crate::schemas::protocol::FileWatchResyncReason,
    ) -> Result<(), FilesystemError> {
        self.dispatch_if_current(WatchNotification::ResyncRequired {
            workspace_id: self.inner.workspace_id.clone(),
            reason,
        })
        .map(|_| ())
    }

    fn dispatch_if_current(
        &self,
        notification: WatchNotification,
    ) -> Result<bool, FilesystemError> {
        let Some(slot) = self.inner.slot.upgrade() else {
            self.inner.service.verify_event_gate(
                &self.inner.owner,
                &self.inner.workspace_id,
                self.inner.generation,
                &self.inner.slot,
            )?;
            return Err(FilesystemError::SessionClosed);
        };
        let delivery_guard = slot.delivery.lock().unwrap_or_else(PoisonError::into_inner);
        self.inner.service.verify_event_gate(
            &self.inner.owner,
            &self.inner.workspace_id,
            self.inner.generation,
            &self.inner.slot,
        )?;
        if self.inner.drained.load(Ordering::Acquire) {
            return Err(FilesystemError::SessionClosed);
        }
        {
            let slot_guard = slot.lock();
            if slot_guard.revoked {
                return Err(FilesystemError::SessionClosed);
            }
            if let Some(task) = slot_guard.tasks.get(&self.inner.task_id) {
                if task.drained.load(Ordering::Acquire) || task.cancel_failed.is_some() {
                    return Err(FilesystemError::SessionClosed);
                }
            } else {
                return Err(FilesystemError::SessionClosed);
            }
        }
        (self.inner.sink)(notification);
        drop(delivery_guard);
        Ok(true)
    }

    pub fn finish_drain(&self) -> Result<bool, FilesystemError> {
        let release_handle = !self.inner.released.swap(true, Ordering::AcqRel);
        self.inner.service.complete_task_drain_internal(
            &self.inner.owner,
            &self.inner.workspace_id,
            Some(self.inner.generation),
            self.inner.task_id,
            release_handle,
            true,
        )
    }

    pub fn finish_drain_with<F>(&self, prove_cleanup: F) -> Result<(), FilesystemError>
    where
        F: FnOnce() -> Result<(), String>,
    {
        let release_handle = !self.inner.released.swap(true, Ordering::AcqRel);
        self.inner.service.drain_task_with_proof_internal(
            &self.inner.owner,
            &self.inner.workspace_id,
            Some(self.inner.generation),
            self.inner.task_id,
            TaskDrainOptions {
                release_handle,
                remove_if_active: true,
            },
            prove_cleanup,
        )
    }
}

pub struct WatchSubscription {
    service: FilesystemService,
    slot: Weak<WorkspaceSlot>,
    owner: OwnerId,
    workspace_id: WorkspaceId,
    generation: SessionGeneration,
    task_id: u64,
    drained: Arc<AtomicBool>,
    handle_released: bool,
    sink: WatchSink,
}

impl WatchSubscription {
    pub fn workspace_id(&self) -> &WorkspaceId {
        &self.workspace_id
    }

    pub fn generation(&self) -> SessionGeneration {
        self.generation
    }

    pub fn task_id(&self) -> u64 {
        self.task_id
    }

    pub fn is_drained(&self) -> bool {
        self.drained.load(Ordering::Acquire)
    }

    pub fn drain_handle(&self) -> Result<TaskDrainHandle, FilesystemError> {
        let Some(slot) = self.slot.upgrade() else {
            return Err(FilesystemError::SessionClosed);
        };
        self.service
            .create_task_drain_handle(&slot, Arc::clone(&self.sink), self.task_id)
    }

    pub fn emit_file_event(
        &self,
        path: RelativePath,
        kind: FileEventKind,
    ) -> Result<bool, FilesystemError> {
        if is_internal_recovery_name(&path) {
            return Ok(false);
        }
        self.dispatch_if_current(WatchNotification::Event(FileEvent {
            workspace_id: self.workspace_id.clone(),
            path,
            kind,
        }))
    }

    pub fn emit_failure(&self, failure: FileWatchFailure) -> Result<(), FilesystemError> {
        self.dispatch_if_current(WatchNotification::Failure {
            workspace_id: self.workspace_id.clone(),
            failure,
        })
        .map(|_| ())
    }

    fn dispatch_if_current(
        &self,
        notification: WatchNotification,
    ) -> Result<bool, FilesystemError> {
        let Some(slot) = self.slot.upgrade() else {
            self.service.verify_event_gate(
                &self.owner,
                &self.workspace_id,
                self.generation,
                &self.slot,
            )?;
            return Err(FilesystemError::SessionClosed);
        };
        let delivery_guard = slot.delivery.lock().unwrap_or_else(PoisonError::into_inner);
        self.service.verify_event_gate(
            &self.owner,
            &self.workspace_id,
            self.generation,
            &self.slot,
        )?;
        if self.drained.load(Ordering::Acquire) {
            return Err(FilesystemError::SessionClosed);
        }
        {
            let slot_guard = slot.lock();
            if slot_guard.revoked {
                return Err(FilesystemError::SessionClosed);
            }
            if let Some(task) = slot_guard.tasks.get(&self.task_id) {
                if task.drained.load(Ordering::Acquire) || task.cancel_failed.is_some() {
                    return Err(FilesystemError::SessionClosed);
                }
            } else {
                return Err(FilesystemError::SessionClosed);
            }
        }
        (self.sink)(notification);
        drop(delivery_guard);
        Ok(true)
    }

    pub fn finish_drain(&mut self) {
        let release_handle = !self.handle_released;
        self.handle_released = true;
        let _ = self.service.complete_task_drain_internal(
            &self.owner,
            &self.workspace_id,
            Some(self.generation),
            self.task_id,
            release_handle,
            false,
        );
    }

    pub fn finish_drain_with<F>(&mut self, prove_cleanup: F) -> Result<(), FilesystemError>
    where
        F: FnOnce() -> Result<(), String>,
    {
        let release_handle = !self.handle_released;
        self.handle_released = true;
        self.service.drain_task_with_proof_internal(
            &self.owner,
            &self.workspace_id,
            Some(self.generation),
            self.task_id,
            TaskDrainOptions {
                release_handle,
                remove_if_active: false,
            },
            prove_cleanup,
        )
    }
}

impl Drop for WatchSubscription {
    fn drop(&mut self) {
        if !self.handle_released {
            self.handle_released = true;
            self.service
                .abandon_task_handle(&self.workspace_id, self.generation, self.task_id);
        }
    }
}

/// Host-only, owner- and generation-bound Git capability. Its registered
/// workspace task holds the operation's filesystem lease until the native
/// runner has proved that its process tree and readers are drained.
pub struct GitWorkspaceLease {
    service: FilesystemService,
    slot: Arc<WorkspaceSlot>,
    task_id: u64,
    cancellation: Arc<AtomicBool>,
    drain: TaskDrainHandle,
}

impl GitWorkspaceLease {
    fn with_task_pins<T>(
        &self,
        action: impl FnOnce(&mut GitPathPins) -> Result<T, GitPathFailure>,
    ) -> Result<T, GitPathFailure> {
        self.check_current().map_err(map_git_path_failure)?;
        let mut slot_state = self.slot.lock();
        if slot_state.revoked {
            return Err(GitPathFailure::Unavailable);
        }
        let Some(task) = slot_state.tasks.get_mut(&self.task_id) else {
            return Err(GitPathFailure::Unavailable);
        };
        if task.drained.load(Ordering::Acquire)
            || task.lease.is_none()
            || task.cancel_failed.is_some()
        {
            return Err(GitPathFailure::Unavailable);
        }
        action(&mut task.pins)
    }

    /// Complete the registered task only after the caller's native process
    /// runner has returned with a verified cleanup proof.
    pub fn finish(&self) -> Result<(), FilesystemError> {
        self.drain.finish_drain_with(|| Ok(()))
    }

    fn deferred_task_completion(&self) -> Box<dyn FnOnce() + Send + 'static> {
        let service = self.service.clone();
        let owner = self.slot.owner.clone();
        let workspace_id = self.slot.workspace_id.clone();
        let generation = self.slot.generation;
        let task_id = self.task_id;
        Box::new(move || {
            let _ = service.complete_task_drain_internal(
                &owner,
                &workspace_id,
                Some(generation),
                task_id,
                false,
                true,
            );
        })
    }
}

fn map_git_workspace_failure(error: &FilesystemError) -> GitWorkspaceFailure {
    match error {
        FilesystemError::StaleGeneration | FilesystemError::StaleWorkspace => {
            GitWorkspaceFailure::StaleGeneration
        }
        FilesystemError::Cancelled => GitWorkspaceFailure::Cancelled,
        FilesystemError::SessionClosed | FilesystemError::UnknownWorkspace => {
            GitWorkspaceFailure::Closed
        }
        _ => GitWorkspaceFailure::Closed,
    }
}

fn map_git_path_failure(error: GitWorkspaceFailure) -> GitPathFailure {
    match error {
        GitWorkspaceFailure::StaleGeneration => GitPathFailure::OutsideWorkspace,
        GitWorkspaceFailure::Cancelled
        | GitWorkspaceFailure::Closed
        | GitWorkspaceFailure::OwnerRevoked => GitPathFailure::Unavailable,
    }
}

impl GitWorkspaceCapability for GitWorkspaceLease {
    fn workspace_id(&self) -> &WorkspaceId {
        &self.slot.workspace_id
    }

    fn owner(&self) -> &OwnerId {
        &self.slot.owner
    }

    fn generation(&self) -> u64 {
        self.slot.generation.get()
    }

    fn root_path(&self) -> Result<&Path, GitPathFailure> {
        Ok(&self.slot.canonical_root)
    }

    fn cancellation_signal(&self) -> Option<Arc<AtomicBool>> {
        Some(Arc::clone(&self.cancellation))
    }

    fn check_current(&self) -> Result<(), GitWorkspaceFailure> {
        if self.cancellation.load(Ordering::Acquire) {
            return Err(GitWorkspaceFailure::Cancelled);
        }
        {
            let state = self.service.lock_state();
            let current = self
                .service
                .lookup_active_slot_locked(
                    &state,
                    &self.slot.owner,
                    &self.slot.workspace_id,
                    Some(self.slot.generation),
                )
                .map_err(|error| map_git_workspace_failure(&error))?;
            if !Arc::ptr_eq(&current, &self.slot) {
                return Err(GitWorkspaceFailure::StaleGeneration);
            }
            let slot_state = self.slot.lock();
            if slot_state.revoked {
                return Err(GitWorkspaceFailure::Closed);
            }
            let Some(task) = slot_state.tasks.get(&self.task_id) else {
                return Err(GitWorkspaceFailure::Closed);
            };
            if task.drained.load(Ordering::Acquire) || task.lease.is_none() {
                return Err(GitWorkspaceFailure::Closed);
            }
            if task.cancel_failed.is_some() {
                return Err(GitWorkspaceFailure::Closed);
            }
        }
        self.slot
            .trusted_root
            .verify_alive()
            .map_err(|_| GitWorkspaceFailure::StaleGeneration)?;
        Ok(())
    }

    fn validate_path(
        &self,
        path: &RelativePath,
        intent: GitPathIntent,
    ) -> Result<(), GitPathFailure> {
        let root = self.slot.canonical_root.as_path();
        self.with_task_pins(|pins| validate_git_relative_path(root, path, intent, pins))
    }

    fn validate_all(&self, intent: GitPathIntent) -> Result<(), GitPathFailure> {
        let root = self.slot.canonical_root.as_path();
        self.with_task_pins(|pins| validate_git_tree(root, intent, pins))
    }

    fn release_path_pins(&self) -> Result<(), GitPathFailure> {
        self.check_current().map_err(map_git_path_failure)?;
        let mut slot_state = self.slot.lock();
        if slot_state.revoked {
            return Err(GitPathFailure::Unavailable);
        }
        let Some(task) = slot_state.tasks.get_mut(&self.task_id) else {
            return Err(GitPathFailure::Unavailable);
        };
        task.pins = GitPathPins::default();
        Ok(())
    }

    fn path_kind(&self, path: &RelativePath) -> Result<GitPathKind, GitPathFailure> {
        let root = self.slot.canonical_root.as_path();
        self.with_task_pins(|pins| {
            validate_git_relative_path(root, path, GitPathIntent::Stage, pins)?;
            match fs::symlink_metadata(root.join(path.as_str())) {
                Ok(metadata) if metadata.is_file() => Ok(GitPathKind::File),
                Ok(metadata) if metadata.is_dir() => Ok(GitPathKind::Directory),
                Ok(_) => Err(GitPathFailure::Unavailable),
                Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(GitPathKind::Absent),
                Err(_) => Err(GitPathFailure::Unavailable),
            }
        })
    }

    fn deferred_cleanup_callback(&self) -> Box<dyn FnOnce() + Send + 'static> {
        self.deferred_task_completion()
    }
}

const MAX_GIT_TREE_ENTRIES: usize = 100_000;
const MAX_GIT_TREE_DEPTH: usize = 64;

fn open_git_component(
    path: &Path,
    expect_directory: bool,
) -> Result<(File, FileIdentity), GitPathFailure> {
    let metadata = fs::symlink_metadata(path).map_err(|_| GitPathFailure::Unavailable)?;
    if is_symlink_or_reparse(&metadata) {
        return Err(GitPathFailure::LinkOrReparsePoint);
    }
    if (expect_directory && !metadata.is_dir()) || (!expect_directory && !metadata.is_file()) {
        return Err(GitPathFailure::Unavailable);
    }
    let file = if expect_directory {
        open_directory_no_follow(path)
    } else {
        open_file_no_follow(path)
    }
    .map_err(|_| GitPathFailure::Unavailable)?;
    let opened = file.metadata().map_err(|_| GitPathFailure::Unavailable)?;
    if is_symlink_or_reparse(&opened) {
        return Err(GitPathFailure::LinkOrReparsePoint);
    }
    if (expect_directory && !opened.is_dir()) || (!expect_directory && !opened.is_file()) {
        return Err(GitPathFailure::Unavailable);
    }
    let identity = native_file_identity(&file).map_err(|_| GitPathFailure::Unavailable)?;
    Ok((file, identity))
}

fn validate_git_relative_path(
    root: &Path,
    path: &RelativePath,
    intent: GitPathIntent,
    pins: &mut GitPathPins,
) -> Result<(), GitPathFailure> {
    let parts: Vec<&str> = path.as_str().split('/').collect();
    if parts
        .first()
        .is_some_and(|part| part.eq_ignore_ascii_case(".git"))
    {
        return Err(GitPathFailure::OutsideWorkspace);
    }

    // Keep every walked handle in the registered task until the child and its
    // readers are drained, including CleanupUnproven.
    let (root_handle, root_identity) = open_git_component(root, true)?;
    pins.retain(root_handle, root_identity)?;
    let mut current = root.to_path_buf();
    for (index, part) in parts.iter().enumerate() {
        current.push(part);
        let metadata = match fs::symlink_metadata(&current) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(_) => return Err(GitPathFailure::Unavailable),
        };
        if is_symlink_or_reparse(&metadata) {
            return Err(GitPathFailure::LinkOrReparsePoint);
        }
        if index + 1 < parts.len() && !metadata.is_dir() {
            return Err(GitPathFailure::Unavailable);
        }
        if index + 1 == parts.len() && intent == GitPathIntent::Discard && metadata.is_dir() {
            return Err(GitPathFailure::Directory);
        }
        if !metadata.is_dir() && !metadata.is_file() {
            return Err(GitPathFailure::Unavailable);
        }
        let (component, identity) = open_git_component(&current, metadata.is_dir())?;
        if intent == GitPathIntent::Discard && index + 1 == parts.len() {
            drop(component);
        } else {
            pins.retain(component, identity)?;
        }
    }
    Ok(())
}

fn validate_git_tree(
    root: &Path,
    intent: GitPathIntent,
    pins: &mut GitPathPins,
) -> Result<(), GitPathFailure> {
    let (root_handle, root_identity) = open_git_component(root, true)?;
    pins.retain(root_handle, root_identity)?;
    let mut pending = vec![(root.to_path_buf(), String::new(), 0usize)];
    let mut visited = 0usize;
    while let Some((directory, prefix, depth)) = pending.pop() {
        if depth > MAX_GIT_TREE_DEPTH {
            return Err(GitPathFailure::Unavailable);
        }
        for entry in fs::read_dir(&directory).map_err(|_| GitPathFailure::Unavailable)? {
            let entry = entry.map_err(|_| GitPathFailure::Unavailable)?;
            visited = visited.checked_add(1).ok_or(GitPathFailure::Unavailable)?;
            if visited > MAX_GIT_TREE_ENTRIES {
                return Err(GitPathFailure::Unavailable);
            }
            let name = entry
                .file_name()
                .into_string()
                .map_err(|_| GitPathFailure::Unavailable)?;
            let path = entry.path();
            let metadata = fs::symlink_metadata(&path).map_err(|_| GitPathFailure::Unavailable)?;
            if is_symlink_or_reparse(&metadata) {
                return Err(GitPathFailure::LinkOrReparsePoint);
            }
            if name.eq_ignore_ascii_case(".git") {
                if !metadata.is_dir() && !metadata.is_file() {
                    return Err(GitPathFailure::Unavailable);
                }
                if metadata.is_dir() {
                    let (git_handle, git_identity) = open_git_component(&path, true)?;
                    pins.retain(git_handle, git_identity)?;
                }
                continue;
            }

            let relative = if prefix.is_empty() {
                name
            } else {
                format!("{prefix}/{name}")
            };
            let relative_path =
                RelativePath::parse(&relative).map_err(|_| GitPathFailure::OutsideWorkspace)?;
            validate_git_relative_path(root, &relative_path, intent, pins)?;
            if metadata.is_dir() {
                pending.push((path, relative, depth + 1));
            }
        }
    }
    Ok(())
}

const MAX_COMPILE_SNAPSHOT_DEPTH: usize = 16;
const MAX_COMPILE_SNAPSHOT_ENTRIES: usize = 4096;
const MAX_COMPILE_SNAPSHOT_FILE_BYTES: usize = 32 * 1024 * 1024;
const MAX_COMPILE_SNAPSHOT_TOTAL_BYTES: usize = 64 * 1024 * 1024;
const MAX_COMPILE_ENTRY_OVERLAY_BYTES: usize = 32 * 1024 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct CompileInputLimits {
    pub(crate) max_depth: usize,
    pub(crate) max_entries: usize,
    pub(crate) max_file_bytes: usize,
    pub(crate) max_total_bytes: usize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct CompileInputFile {
    pub(crate) path: RelativePath,
    pub(crate) bytes: Vec<u8>,
    pub(crate) revision: Revision,
}

fn filter_compile_entries(entries: Vec<FileEntry>, excluded: &[RelativePath]) -> Vec<FileEntry> {
    let excluded = excluded
        .iter()
        .map(|path| path.as_str().to_lowercase())
        .collect::<Vec<_>>();
    entries
        .into_iter()
        .filter(|entry| {
            let path = entry.path.as_str().to_lowercase();
            !excluded
                .iter()
                .any(|blocked| path == *blocked || path.starts_with(&(blocked.clone() + "/")))
        })
        .collect()
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum CompileOutputKind {
    Pdf,
    Log,
}

#[derive(Clone, Debug)]
pub(crate) struct CompileOutputFile {
    pub(crate) path: RelativePath,
    pub(crate) bytes: Vec<u8>,
    pub(crate) kind: CompileOutputKind,
}

#[derive(Clone)]
struct CompileOutputPrior {
    path: RelativePath,
    previous: Option<Vec<u8>>,
    written_revision: Revision,
}

const MAX_COMPILE_OUTPUT_LOG_BYTES: usize = 1024 * 1024;
const MAX_COMPILE_OUTPUT_BACKUP_BYTES: usize = 32 * 1024 * 1024;

fn compile_output_limit(kind: CompileOutputKind) -> usize {
    match kind {
        CompileOutputKind::Pdf => MAX_PDF_BYTES,
        CompileOutputKind::Log => MAX_COMPILE_OUTPUT_LOG_BYTES,
    }
}

fn rollback_compile_output_bounded(
    root: &TrustedRoot,
    prior: &CompileOutputPrior,
) -> Result<(), FilesystemError> {
    const MAX_ROLLBACK_ATTEMPTS: usize = 10;
    for attempt in 0..MAX_ROLLBACK_ATTEMPTS {
        let state = root.read_file_bounded(&prior.path, MAX_COMPILE_OUTPUT_BACKUP_BYTES);
        match (&prior.previous, state) {
            (Some(previous), Ok(current)) if current.bytes == *previous => return Ok(()),
            (None, Err(FsError::NotFound)) => return Ok(()),
            (Some(previous), Ok(current)) if current.revision == prior.written_revision => {
                match root.write_file(&prior.path, previous, Some(&prior.written_revision)) {
                    Ok(written) => {
                        if let Ok(verified) =
                            root.read_file_bounded(&prior.path, MAX_COMPILE_OUTPUT_BACKUP_BYTES)
                        {
                            if verified.revision == written.revision && verified.bytes == *previous
                            {
                                return Ok(());
                            }
                        }
                    }
                    Err(_) => return Err(FilesystemError::StaleWorkspace),
                }
            }
            (None, Ok(current)) if current.revision == prior.written_revision => {
                match root.delete_file_if_revision(&prior.path, &prior.written_revision) {
                    Ok(_) => {
                        if matches!(
                            root.read_file_bounded(&prior.path, MAX_COMPILE_OUTPUT_BACKUP_BYTES),
                            Err(FsError::NotFound)
                        ) {
                            return Ok(());
                        }
                    }
                    Err(_) => return Err(FilesystemError::StaleWorkspace),
                }
            }
            _ => return Err(FilesystemError::StaleWorkspace),
        }
        if attempt + 1 < MAX_ROLLBACK_ATTEMPTS {
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
    }
    Err(FilesystemError::StaleWorkspace)
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct CompileInputSnapshot {
    pub(crate) entries: Vec<FileEntry>,
    pub(crate) files: Vec<CompileInputFile>,
    limits: CompileInputLimits,
}

/// Host-owned unsaved entry data. This is deliberately not a wire DTO.
pub(crate) struct CompileSourceOverlay<'a> {
    pub(crate) path: &'a RelativePath,
    pub(crate) document_id: &'a DocumentId,
    pub(crate) document_version: DocumentVersion,
    pub(crate) bytes: &'a [u8],
}

pub struct CompileLeaseTicket {
    service: FilesystemService,
    slot: Weak<WorkspaceSlot>,
    owner: OwnerId,
    identity: CompileIdentity,
    generation: SessionGeneration,
    canonical_root: PathBuf,
    entry_snapshot: Vec<u8>,
    task_id: u64,
    drained: Arc<AtomicBool>,
    handle_released: bool,
}

impl CompileLeaseTicket {
    pub fn identity(&self) -> &CompileIdentity {
        &self.identity
    }

    pub fn generation(&self) -> SessionGeneration {
        self.generation
    }

    pub fn canonical_root(&self) -> &Path {
        &self.canonical_root
    }

    pub fn entry_snapshot(&self) -> &[u8] {
        &self.entry_snapshot
    }

    pub fn task_id(&self) -> u64 {
        self.task_id
    }

    pub fn is_drained(&self) -> bool {
        self.drained.load(Ordering::Acquire)
    }

    pub fn drain_handle(&self) -> Result<TaskDrainHandle, FilesystemError> {
        let Some(slot) = self.slot.upgrade() else {
            return Err(FilesystemError::SessionClosed);
        };
        self.service
            .create_task_drain_handle(&slot, Arc::new(|_| ()), self.task_id)
    }

    /// Releases a Draft compile task only after its complete captured input
    /// snapshot and the returned compile identity have been revalidated.
    pub(crate) fn settle_with_snapshot(
        mut self,
        result: CompileResult,
        snapshot: &CompileInputSnapshot,
    ) -> Result<CompileResult, FilesystemError> {
        let validation = match self.service.validate_compile_snapshot(&self, snapshot) {
            Ok(()) => self.service.verify_compile_result(
                &self.owner,
                &self.identity,
                self.generation,
                &self.slot,
                self.task_id,
                result,
            ),
            Err(error) => Err(error),
        };
        let cleanup = self.release_after_native_settlement();
        match (validation, cleanup) {
            (Err(error), _) => Err(error),
            (Ok(_), Err(error)) => Err(error),
            (Ok(result), Ok(())) => Ok(result),
        }
    }

    /// Releases a completed metadata-only Draft frame after the saved input
    /// snapshot has been revalidated. The persistent warm child is not part of
    /// the per-frame compile lease.
    pub(crate) fn settle_metadata_with_snapshot(
        mut self,
        snapshot: &CompileInputSnapshot,
    ) -> Result<(), FilesystemError> {
        let validation = self.service.validate_compile_snapshot(&self, snapshot);
        let cleanup = self.release_after_native_settlement();
        match (validation, cleanup) {
            (Err(error), _) => Err(error),
            (Ok(()), Err(error)) => Err(error),
            (Ok(()), Ok(())) => Ok(()),
        }
    }

    fn release_after_native_settlement(&mut self) -> Result<(), FilesystemError> {
        let release_handle = !self.handle_released;
        let result = self.service.complete_task_drain_internal(
            &self.owner,
            &self.identity.workspace_id,
            Some(self.generation),
            self.task_id,
            release_handle,
            true,
        );
        if result.is_ok() {
            self.handle_released = true;
        }
        result.map(|_| ())
    }

    pub fn settle(mut self, result: CompileResult) -> Result<CompileResult, FilesystemError> {
        let validated = self.service.verify_compile_result(
            &self.owner,
            &self.identity,
            self.generation,
            &self.slot,
            self.task_id,
            result,
        )?;
        let release_handle = !self.handle_released;
        self.handle_released = true;
        let _ = self.service.complete_task_drain_internal(
            &self.owner,
            &self.identity.workspace_id,
            Some(self.generation),
            self.task_id,
            release_handle,
            true,
        );
        Ok(validated)
    }

    pub fn settle_with_drain<F>(
        mut self,
        result: CompileResult,
        prove_cleanup: F,
    ) -> Result<CompileResult, FilesystemError>
    where
        F: FnOnce() -> Result<(), String>,
    {
        let validated = self.service.verify_compile_result(
            &self.owner,
            &self.identity,
            self.generation,
            &self.slot,
            self.task_id,
            result,
        )?;
        let release_handle = !self.handle_released;
        self.handle_released = true;
        self.service.drain_task_with_proof_internal(
            &self.owner,
            &self.identity.workspace_id,
            Some(self.generation),
            self.task_id,
            TaskDrainOptions {
                release_handle,
                remove_if_active: true,
            },
            prove_cleanup,
        )?;
        Ok(validated)
    }

    pub fn finish_drain(&mut self) {
        let release_handle = !self.handle_released;
        self.handle_released = true;
        let _ = self.service.complete_task_drain_internal(
            &self.owner,
            &self.identity.workspace_id,
            Some(self.generation),
            self.task_id,
            release_handle,
            false,
        );
    }

    pub fn finish_drain_with<F>(&mut self, prove_cleanup: F) -> Result<(), FilesystemError>
    where
        F: FnOnce() -> Result<(), String>,
    {
        let release_handle = !self.handle_released;
        self.handle_released = true;
        self.service.drain_task_with_proof_internal(
            &self.owner,
            &self.identity.workspace_id,
            Some(self.generation),
            self.task_id,
            TaskDrainOptions {
                release_handle,
                remove_if_active: false,
            },
            prove_cleanup,
        )
    }
}

impl Drop for CompileLeaseTicket {
    fn drop(&mut self) {
        if !self.handle_released {
            self.handle_released = true;
            self.service.abandon_task_handle(
                &self.identity.workspace_id,
                self.generation,
                self.task_id,
            );
        }
    }
}

struct ServiceState {
    active: HashMap<WorkspaceId, Arc<WorkspaceSlot>>,
    retiring: HashMap<WorkspaceId, Arc<WorkspaceSlot>>,
    retired: HashMap<WorkspaceId, (OwnerId, SessionGeneration, RootIdentity)>,
    workspace_generation: HashMap<WorkspaceId, SessionGeneration>,
    latest_owner_root_generation: HashMap<(OwnerId, RootIdentity), SessionGeneration>,
    revoked_owners: HashSet<OwnerId>,
    admitting_owners: HashMap<OwnerId, usize>,
    next_task_id: u64,
}

struct SharedService {
    registry: Arc<SessionRegistry>,
    coordinator: WorkspaceLeaseCoordinator,
    recent_store: RecentStore,
    settings_store: SettingsStore,
    drain_timeout: Duration,
    state: Mutex<ServiceState>,
    admission_condvar: Condvar,
}

struct OwnerAdmissionReservation {
    shared: Arc<SharedService>,
    owner: OwnerId,
    active: bool,
}

impl OwnerAdmissionReservation {
    fn release_locked(&mut self, state: &mut ServiceState) {
        if self.active {
            self.active = false;
            if let Some(in_flight) = state.admitting_owners.get_mut(&self.owner) {
                *in_flight = in_flight.saturating_sub(1);
                if *in_flight == 0 {
                    state.admitting_owners.remove(&self.owner);
                }
            }
            self.shared.admission_condvar.notify_all();
        }
    }
}

impl Drop for OwnerAdmissionReservation {
    fn drop(&mut self) {
        if self.active {
            let shared = Arc::clone(&self.shared);
            let mut state = shared.state.lock().unwrap_or_else(PoisonError::into_inner);
            self.release_locked(&mut state);
        }
    }
}

#[derive(Clone)]
pub struct FilesystemService {
    shared: Arc<SharedService>,
}

impl FilesystemService {
    pub fn new(
        registry: Arc<SessionRegistry>,
        coordinator: WorkspaceLeaseCoordinator,
        recent_store: RecentStore,
        settings_store: SettingsStore,
    ) -> Self {
        Self::with_drain_timeout(
            registry,
            coordinator,
            recent_store,
            settings_store,
            DEFAULT_CLOSE_DRAIN_TIMEOUT,
        )
    }

    pub fn with_drain_timeout(
        registry: Arc<SessionRegistry>,
        coordinator: WorkspaceLeaseCoordinator,
        recent_store: RecentStore,
        settings_store: SettingsStore,
        drain_timeout: Duration,
    ) -> Self {
        Self {
            shared: Arc::new(SharedService {
                registry,
                coordinator,
                recent_store,
                settings_store,
                drain_timeout,
                state: Mutex::new(ServiceState {
                    active: HashMap::new(),
                    retiring: HashMap::new(),
                    retired: HashMap::new(),
                    workspace_generation: HashMap::new(),
                    latest_owner_root_generation: HashMap::new(),
                    revoked_owners: HashSet::new(),
                    admitting_owners: HashMap::new(),
                    next_task_id: 1,
                }),
                admission_condvar: Condvar::new(),
            }),
        }
    }

    pub fn with_default_stores() -> Result<Self, FilesystemError> {
        let recent_store = RecentStore::with_default_data_dir()?;
        let settings_store = SettingsStore::with_default_data_dir()?;
        Ok(Self::new(
            Arc::new(SessionRegistry::new()),
            WorkspaceLeaseCoordinator::new(),
            recent_store,
            settings_store,
        ))
    }

    fn lock_state(&self) -> MutexGuard<'_, ServiceState> {
        self.shared
            .state
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    pub fn host_health(&self, owner: &OwnerId) -> HostHealth {
        HostHealth::for_owner(owner)
    }

    pub fn recent_store(&self) -> &RecentStore {
        &self.shared.recent_store
    }

    pub fn settings_store(&self) -> &SettingsStore {
        &self.shared.settings_store
    }

    pub fn coordinator(&self) -> &WorkspaceLeaseCoordinator {
        &self.shared.coordinator
    }

    pub fn registry(&self) -> &SessionRegistry {
        &self.shared.registry
    }

    fn reserve_owner_admission(
        &self,
        owner: &OwnerId,
    ) -> Result<OwnerAdmissionReservation, FilesystemError> {
        let mut state = self.lock_state();
        if state.revoked_owners.contains(owner) {
            return Err(FilesystemError::SessionClosed);
        }
        let owner_retiring = state
            .retiring
            .values()
            .filter(|slot| &slot.owner == owner)
            .count();
        if state.retiring.len() >= MAX_RETIRING_WORKSPACES
            || owner_retiring >= MAX_RETIRING_WORKSPACES_PER_OWNER
        {
            return Err(FilesystemError::ResourceExhausted);
        }
        let in_flight = state.admitting_owners.entry(owner.clone()).or_insert(0);
        *in_flight = in_flight
            .checked_add(1)
            .ok_or(FilesystemError::ResourceExhausted)?;
        Ok(OwnerAdmissionReservation {
            shared: Arc::clone(&self.shared),
            owner: owner.clone(),
            active: true,
        })
    }

    fn admit_pinned_workspace(
        &self,
        owner: &OwnerId,
        mut reservation: OwnerAdmissionReservation,
        pinned: PinnedValidatedRoot,
        kind: WorkspaceKind,
        label: String,
        entry_path: Option<RelativePath>,
    ) -> Result<(WorkspaceInfo, SessionGeneration, Arc<WorkspaceSlot>), FilesystemError> {
        let mut initial_docs = HashMap::new();
        if let Some(ref entry_rel) = entry_path {
            let read_out = if entry_rel.as_str().to_ascii_lowercase().ends_with(".pdf") {
                pinned.trusted_root.read_file_pdf(entry_rel)?
            } else {
                pinned.trusted_root.read_file(entry_rel)?
            };
            initial_docs.insert(
                entry_rel.clone(),
                TrackedDocument {
                    document_id: None,
                    document_version: None,
                    revision: read_out.revision,
                    identity: read_out.identity,
                },
            );
        }
        let mut state = self.lock_state();
        if state.revoked_owners.contains(owner) {
            reservation.release_locked(&mut state);
            return Err(FilesystemError::SessionClosed);
        }
        let owner_retiring = state
            .retiring
            .values()
            .filter(|slot| &slot.owner == owner)
            .count();
        if state.retiring.len() >= MAX_RETIRING_WORKSPACES
            || owner_retiring >= MAX_RETIRING_WORKSPACES_PER_OWNER
        {
            reservation.release_locked(&mut state);
            return Err(FilesystemError::ResourceExhausted);
        }
        let res = (|| {
            let session =
                self.shared
                    .registry
                    .open(owner, &pinned.canonical_path, entry_path.clone())?;
            let ws_id = session.id().clone();
            let generation = match self.shared.coordinator.admit_from_registry(
                &self.shared.registry,
                owner,
                &ws_id,
                pinned.workspace_root.clone(),
            ) {
                Ok(gen) => gen,
                Err(err) => {
                    let _ = self.shared.registry.close(owner, &ws_id);
                    return Err(FilesystemError::from(err));
                }
            };
            let info = WorkspaceInfo {
                id: ws_id.clone(),
                label,
                entry_path,
            };
            let slot = Arc::new(WorkspaceSlot {
                workspace_id: ws_id.clone(),
                owner: owner.clone(),
                generation,
                kind,
                info: info.clone(),
                canonical_root: pinned.canonical_path,
                root_meta: pinned.workspace_root.clone(),
                trusted_root: pinned.trusted_root,
                state: Mutex::new(SlotState {
                    revoked: false,
                    closing_in_flight: false,
                    active_ops: 0,
                    documents: initial_docs,
                    doc_paths: HashMap::new(),
                    tasks: HashMap::new(),
                }),
                condvar: Condvar::new(),
                delivery: Mutex::new(()),
            });
            state.workspace_generation.insert(ws_id.clone(), generation);
            state.latest_owner_root_generation.insert(
                (owner.clone(), pinned.workspace_root.identity()),
                generation,
            );
            state.active.insert(ws_id, Arc::clone(&slot));
            Ok((info, generation, slot))
        })();
        reservation.release_locked(&mut state);
        res
    }

    pub fn open_workspace_folder(
        &self,
        owner: &OwnerId,
        folder_path: &Path,
        entry_path: Option<RelativePath>,
        opened_at: Timestamp,
    ) -> Result<WorkspaceOpenOutcome<WorkspaceInfo>, FilesystemError> {
        let reservation = self.reserve_owner_admission(owner)?;
        validate_recent_entry_path(&entry_path)?;
        let pinned = pin_and_validate_root(folder_path)?;
        let target_path = pinned.canonical_path.clone();
        let recent_target =
            TrustedRecentTarget::for_folder(&target_path, entry_path.clone(), opened_at)?;
        let (info, _, _) = self.admit_pinned_workspace(
            owner,
            reservation,
            pinned,
            WorkspaceKind::Folder,
            recent_target.label,
            entry_path,
        )?;
        let selection = TrustedWorkspaceSelection {
            workspace: info,
            kind: WorkspaceKind::Folder,
            target_path,
            opened_at,
        };
        Ok(self.shared.recent_store.admit_opened_workspace(selection))
    }

    pub fn open_workspace_file(
        &self,
        owner: &OwnerId,
        file_path: &Path,
        opened_at: Timestamp,
    ) -> Result<WorkspaceOpenOutcome<WorkspaceInfo>, FilesystemError> {
        let reservation = self.reserve_owner_admission(owner)?;
        if !file_path.is_absolute() {
            return Err(FilesystemError::InvalidPath(
                "file workspace target must be an absolute path".to_owned(),
            ));
        }
        let recent_target = TrustedRecentTarget::for_file(file_path, opened_at)?;
        let parent_dir = file_path.parent().ok_or_else(|| {
            FilesystemError::InvalidPath("file workspace target has no parent directory".to_owned())
        })?;
        let pinned = pin_and_validate_root(parent_dir)?;
        let canonical_file = pinned.canonical_path.join(&recent_target.label);
        let (info, _, _) = self.admit_pinned_workspace(
            owner,
            reservation,
            pinned,
            WorkspaceKind::File,
            recent_target.label,
            recent_target.entry_path,
        )?;
        let selection = TrustedWorkspaceSelection {
            workspace: info,
            kind: WorkspaceKind::File,
            target_path: canonical_file,
            opened_at,
        };
        Ok(self.shared.recent_store.admit_opened_workspace(selection))
    }

    #[cfg(all(windows, target_arch = "x86_64"))]
    pub fn validate_native_open_target(&self, file_path: &Path) -> Result<(), FilesystemError> {
        stat_native_open_target_identity(file_path).map(|_| ())
    }

    #[cfg(all(windows, target_arch = "x86_64"))]
    pub fn find_open_document_owner(
        &self,
        file_path: &Path,
    ) -> Result<Option<String>, FilesystemError> {
        let (root_identity, relative, file_identity) = stat_native_open_target_identity(file_path)?;
        let state = self.lock_state();
        for slot in state.active.values() {
            if slot.root_meta.identity() != root_identity {
                continue;
            }
            let slot_state = slot.lock();
            if slot_state.revoked {
                continue;
            }
            let is_open = slot_state.documents.iter().any(|(path, document)| {
                path.as_str().eq_ignore_ascii_case(relative.as_str())
                    && document.identity == file_identity
            });
            if is_open {
                return Ok(Some(slot.owner.as_str().to_owned()));
            }
        }
        Ok(None)
    }

    pub fn reopen_recent(
        &self,
        owner: &OwnerId,
        recent_id: &str,
        opened_at: Timestamp,
    ) -> Result<WorkspaceOpenOutcome<WorkspaceInfo>, FilesystemError> {
        let mut reservation = Some(self.reserve_owner_admission(owner)?);
        let mut admit_err: Option<FilesystemError> = None;
        let res = self.shared.recent_store.open_recent_with(
            recent_id,
            opened_at,
            |resolved: &ResolvedRecentTarget| {
                let pinned = match pin_from_capability(
                    resolved.capability(),
                    resolved.kind,
                    &resolved.document.entry_path,
                ) {
                    Ok(p) => p,
                    Err(e) => {
                        admit_err = Some(e);
                        return Err(RecentStoreError::new(
                            RecentErrorCode::IoFailed,
                            "capability validation failed",
                        ));
                    }
                };
                let res_guard = reservation.take().expect("admission reservation present");
                match self.admit_pinned_workspace(
                    owner,
                    res_guard,
                    pinned,
                    resolved.kind,
                    resolved.document.label.clone(),
                    resolved.document.entry_path.clone(),
                ) {
                    Ok((info, _, _)) => Ok(info),
                    Err(e) => {
                        admit_err = Some(e);
                        Err(RecentStoreError::new(
                            RecentErrorCode::IoFailed,
                            "workspace admission failed",
                        ))
                    }
                }
            },
        );
        match res {
            Ok(outcome) => Ok(outcome),
            Err(err) => Err(admit_err.unwrap_or_else(|| FilesystemError::from(err))),
        }
    }

    pub fn workspace_generation(
        &self,
        owner: &OwnerId,
        workspace_id: &WorkspaceId,
    ) -> Result<SessionGeneration, FilesystemError> {
        let state = self.lock_state();
        let slot = self.lookup_active_slot_locked(&state, owner, workspace_id, None)?;
        let slot_guard = slot.lock();
        if slot_guard.revoked {
            return Err(FilesystemError::SessionClosed);
        }
        Ok(slot.generation)
    }

    pub fn workspace_info(
        &self,
        owner: &OwnerId,
        workspace_id: &WorkspaceId,
    ) -> Result<(WorkspaceKind, WorkspaceInfo), FilesystemError> {
        let state = self.lock_state();
        let slot = self.lookup_active_slot_locked(&state, owner, workspace_id, None)?;
        let slot_guard = slot.lock();
        if slot_guard.revoked {
            return Err(FilesystemError::SessionClosed);
        }
        Ok((slot.kind, slot.info.clone()))
    }

    pub fn workspace_root_path(
        &self,
        owner: &OwnerId,
        workspace_id: &WorkspaceId,
    ) -> Result<PathBuf, FilesystemError> {
        let state = self.lock_state();
        let slot = self.lookup_active_slot_locked(&state, owner, workspace_id, None)?;
        let slot_guard = slot.lock();
        if slot_guard.revoked {
            return Err(FilesystemError::SessionClosed);
        }
        Ok(slot.canonical_root.clone())
    }

    /// Run a workspace configuration transaction under the same save lease used
    /// by filesystem mutations. The root and listing are obtained from the pinned
    /// workspace capability, not from renderer-provided absolute paths.
    pub(crate) fn with_workspace_config_write<T>(
        &self,
        owner: &OwnerId,
        workspace_id: &WorkspaceId,
        operation: impl FnOnce(&Path, &WorkspaceInfo, u64, &TrustedRoot) -> Result<T, FilesystemError>,
    ) -> Result<T, FilesystemError> {
        let op = self.begin_op(owner, workspace_id, None, LeaseKind::Save)?;
        op.slot.trusted_root.verify_alive()?;
        {
            let guard = op.slot.lock();
            if guard.revoked {
                return Err(FilesystemError::SessionClosed);
            }
        }
        operation(
            &op.slot.canonical_root,
            &op.slot.info,
            op.slot.generation.get(),
            &op.slot.trusted_root,
        )
    }

    fn lookup_active_slot_locked(
        &self,
        state: &ServiceState,
        owner: &OwnerId,
        workspace_id: &WorkspaceId,
        expected_gen: Option<SessionGeneration>,
    ) -> Result<Arc<WorkspaceSlot>, FilesystemError> {
        if let Some(slot) = state.active.get(workspace_id) {
            if &slot.owner != owner {
                return Err(FilesystemError::UnknownWorkspace);
            }
            let current_gen = state
                .workspace_generation
                .get(workspace_id)
                .copied()
                .ok_or(FilesystemError::StaleGeneration)?;
            if slot.generation != current_gen || expected_gen.is_some_and(|exp| exp != current_gen)
            {
                return Err(FilesystemError::StaleGeneration);
            }
            if state.revoked_owners.contains(owner) {
                return Err(FilesystemError::SessionClosed);
            }
            return Ok(Arc::clone(slot));
        }
        if let Some((ret_owner, ret_gen, root_id)) = state.retired.get(workspace_id) {
            if ret_owner != owner {
                return Err(FilesystemError::UnknownWorkspace);
            }
            if expected_gen.is_some_and(|exp| exp != *ret_gen)
                || (expected_gen.is_some()
                    && state
                        .latest_owner_root_generation
                        .get(&(owner.clone(), *root_id))
                        .is_some_and(|latest| *latest != *ret_gen))
            {
                return Err(FilesystemError::StaleGeneration);
            }
            return Err(FilesystemError::SessionClosed);
        }
        Err(FilesystemError::UnknownWorkspace)
    }

    fn begin_op(
        &self,
        owner: &OwnerId,
        workspace_id: &WorkspaceId,
        expected_gen: Option<SessionGeneration>,
        kind: LeaseKind,
    ) -> Result<ActiveOpGuard, FilesystemError> {
        let slot = {
            let state = self.lock_state();
            self.lookup_active_slot_locked(&state, owner, workspace_id, expected_gen)?
        };
        let mut slot_guard = slot.lock();
        if slot_guard.revoked {
            return Err(FilesystemError::SessionClosed);
        }
        let _ = self.shared.registry.get(owner, workspace_id)?;
        let lease = self.shared.coordinator.try_acquire(
            owner,
            workspace_id,
            Some(slot.generation),
            kind,
            None,
        )?;
        slot_guard.active_ops += 1;
        drop(slot_guard);
        Ok(ActiveOpGuard {
            service: self.clone(),
            slot,
            lease: Some(lease),
        })
    }

    pub fn acquire_terminal_workspace(
        &self,
        owner: &OwnerId,
        workspace_id: &WorkspaceId,
    ) -> Result<TerminalWorkspace, FilesystemError> {
        let op = self.begin_op(owner, workspace_id, None, LeaseKind::Read)?;
        let generation = op.slot.generation;
        let root = op.slot.canonical_root.clone();
        Ok(TerminalWorkspace {
            _op: op,
            generation,
            root,
        })
    }

    pub(crate) fn workspace_file_read_access(
        &self,
        owner: &OwnerId,
        workspace_id: &WorkspaceId,
    ) -> Result<WorkspaceFileAccess, FilesystemError> {
        let active = self.begin_op(owner, workspace_id, None, LeaseKind::Read)?;
        Ok(WorkspaceFileAccess {
            root: Arc::clone(&active.slot.trusted_root),
            generation: active.slot.generation,
            _active: active,
        })
    }

    pub(crate) fn workspace_file_write_access(
        &self,
        owner: &OwnerId,
        workspace_id: &WorkspaceId,
    ) -> Result<WorkspaceFileAccess, FilesystemError> {
        // Save is root-exclusive in WorkspaceLeaseCoordinator, so nested and
        // parent/child workspace roots conflict with reads that mutate either.
        let active = self.begin_op(owner, workspace_id, None, LeaseKind::Save)?;
        Ok(WorkspaceFileAccess {
            root: Arc::clone(&active.slot.trusted_root),
            generation: active.slot.generation,
            _active: active,
        })
    }

    pub fn list_files(
        &self,
        owner: &OwnerId,
        workspace_id: &WorkspaceId,
    ) -> Result<Vec<FileEntry>, FilesystemError> {
        let op = self.begin_op(owner, workspace_id, None, LeaseKind::List)?;
        Ok(op.slot.trusted_root.list_files()?)
    }

    pub fn read_file(
        &self,
        owner: &OwnerId,
        file: &FileRef,
    ) -> Result<ReadReceipt, FilesystemError> {
        let op = self.begin_op(owner, &file.workspace_id, None, LeaseKind::Read)?;
        let out = op.slot.trusted_root.read_file(&file.path)?;
        let (document_id, document_version) = {
            let mut slot_guard = op.slot.lock();
            if slot_guard.revoked {
                return Err(FilesystemError::SessionClosed);
            }
            let tracked =
                slot_guard
                    .documents
                    .entry(file.path.clone())
                    .or_insert(TrackedDocument {
                        document_id: None,
                        document_version: None,
                        revision: out.revision.clone(),
                        identity: out.identity,
                    });
            update_read_identity(tracked, out.revision.clone(), out.identity)?;
            (tracked.document_id.clone(), tracked.document_version)
        };
        Ok(ReadReceipt {
            workspace_id: file.workspace_id.clone(),
            path: file.path.clone(),
            bytes: out.bytes,
            revision: out.revision,
            document_id,
            document_version,
        })
    }

    pub fn read_file_pdf(
        &self,
        owner: &OwnerId,
        file: &FileRef,
    ) -> Result<ReadReceipt, FilesystemError> {
        if !file.path.as_str().to_ascii_lowercase().ends_with(".pdf") {
            return Err(FilesystemError::InvalidPath(
                "expected a PDF path".to_owned(),
            ));
        }
        let op = self.begin_op(owner, &file.workspace_id, None, LeaseKind::Read)?;
        let out = op.slot.trusted_root.read_file_pdf(&file.path)?;
        let (document_id, document_version) = {
            let mut slot_guard = op.slot.lock();
            if slot_guard.revoked {
                return Err(FilesystemError::SessionClosed);
            }
            let tracked =
                slot_guard
                    .documents
                    .entry(file.path.clone())
                    .or_insert(TrackedDocument {
                        document_id: None,
                        document_version: None,
                        revision: out.revision.clone(),
                        identity: out.identity,
                    });
            update_read_identity(tracked, out.revision.clone(), out.identity)?;
            (tracked.document_id.clone(), tracked.document_version)
        };
        Ok(ReadReceipt {
            workspace_id: file.workspace_id.clone(),
            path: file.path.clone(),
            bytes: out.bytes,
            revision: out.revision,
            document_id,
            document_version,
        })
    }

    pub fn write_file(
        &self,
        owner: &OwnerId,
        request: &WriteRequest,
    ) -> Result<WriteReceipt, FilesystemError> {
        let op = self.begin_op(owner, &request.workspace_id, None, LeaseKind::Save)?;
        let limit = read_limit(request.path.as_str());
        if request.bytes.len() > limit {
            return Err(FilesystemError::FileTooLarge {
                size: request.bytes.len() as u64,
                limit,
            });
        }
        if request.path.as_str().to_ascii_lowercase().ends_with(".pdf") {
            validate_pdf(&request.bytes)?;
        }
        {
            let slot_guard = op.slot.lock();
            if slot_guard.revoked {
                return Err(FilesystemError::SessionClosed);
            }
            if let Some(bound_path) = slot_guard.doc_paths.get(&request.document_id) {
                if bound_path != &request.path {
                    return Err(FilesystemError::DocumentIdentityMismatch {
                        expected: request.document_id.clone(),
                        actual: request.document_id.clone(),
                    });
                }
            }
            if let Some(tracked) = slot_guard.documents.get(&request.path) {
                if let Some(ref existing_doc_id) = tracked.document_id {
                    if existing_doc_id != &request.document_id {
                        return Err(FilesystemError::DocumentIdentityMismatch {
                            expected: existing_doc_id.clone(),
                            actual: request.document_id.clone(),
                        });
                    }
                }
                if let Some(existing_ver) = tracked.document_version {
                    if request.document_version.get() < existing_ver.get() {
                        return Err(FilesystemError::StaleDocumentVersion {
                            expected_min: existing_ver,
                            actual: request.document_version,
                        });
                    }
                }
            }
        }
        let write_out = op.slot.trusted_root.write_file(
            &request.path,
            &request.bytes,
            request.expected_revision.as_ref(),
        )?;
        {
            let mut slot_guard = op.slot.lock();
            slot_guard
                .doc_paths
                .insert(request.document_id.clone(), request.path.clone());
            slot_guard.documents.insert(
                request.path.clone(),
                TrackedDocument {
                    document_id: Some(request.document_id.clone()),
                    document_version: Some(request.document_version),
                    revision: write_out.revision.clone(),
                    identity: write_out.identity,
                },
            );
        }
        Ok(WriteReceipt {
            workspace_id: request.workspace_id.clone(),
            path: request.path.clone(),
            revision: write_out.revision,
            document_id: request.document_id.clone(),
            document_version: request.document_version,
        })
    }

    pub fn recover_file(
        &self,
        owner: &OwnerId,
        file: &FileRef,
    ) -> Result<RecoveryOutcome, FilesystemError> {
        let op = self.begin_op(owner, &file.workspace_id, None, LeaseKind::Save)?;
        Ok(op.slot.trusted_root.recover_write(&file.path)?)
    }

    pub fn save_as(
        &self,
        owner: &OwnerId,
        request: &SaveAsRequest,
        selected_target: Option<&Path>,
        opened_at: Timestamp,
    ) -> Result<Option<WorkspaceOpenOutcome<SaveAsReceipt>>, FilesystemError> {
        self.save_as_with_hook(owner, request, selected_target, opened_at, |_, _, _| Ok(()))
    }

    fn save_as_with_hook<F>(
        &self,
        owner: &OwnerId,
        request: &SaveAsRequest,
        selected_target: Option<&Path>,
        opened_at: Timestamp,
        mut before_write: F,
    ) -> Result<Option<WorkspaceOpenOutcome<SaveAsReceipt>>, FilesystemError>
    where
        F: FnMut(usize, &RelativePath, &TrustedRoot) -> Result<(), FsError>,
    {
        let mut reservation = self.reserve_owner_admission(owner)?;
        if let Some(ref source_ws) = request.workspace_id {
            let state = self.lock_state();
            let slot = self.lookup_active_slot_locked(&state, owner, source_ws, None)?;
            if slot.lock().revoked {
                return Err(FilesystemError::SessionClosed);
            }
        }
        let Some(target_file_path) = selected_target else {
            return Ok(None);
        };
        if !target_file_path.is_absolute() {
            return Err(FilesystemError::InvalidPath(
                "saveAs target path must be absolute".to_owned(),
            ));
        }
        let recent_target = TrustedRecentTarget::for_file(target_file_path, opened_at)?;
        let entry_rel = recent_target.entry_path.clone().ok_or_else(|| {
            FilesystemError::InvalidPath("saveAs target requires a TeX filename".to_owned())
        })?;
        let limit = read_limit(entry_rel.as_str());
        if request.bytes.len() > limit {
            return Err(FilesystemError::FileTooLarge {
                size: request.bytes.len() as u64,
                limit,
            });
        }
        let parent_dir = target_file_path.parent().ok_or_else(|| {
            FilesystemError::InvalidPath("saveAs target has no parent directory".to_owned())
        })?;
        let pinned = pin_and_validate_root(parent_dir)?;

        // Admit target session and acquire root-exclusive Save lease before writing.
        let session =
            self.shared
                .registry
                .open(owner, &pinned.canonical_path, Some(entry_rel.clone()))?;
        let new_ws_id = session.id().clone();
        let generation = match self.shared.coordinator.admit_from_registry(
            &self.shared.registry,
            owner,
            &new_ws_id,
            pinned.workspace_root.clone(),
        ) {
            Ok(gen) => gen,
            Err(err) => {
                let _ = self.shared.registry.close(owner, &new_ws_id);
                return Err(FilesystemError::from(err));
            }
        };
        let save_lease = match self.shared.coordinator.try_acquire(
            owner,
            &new_ws_id,
            Some(generation),
            LeaseKind::Save,
            None,
        ) {
            Ok(lease) => lease,
            Err(err) => {
                let _ = self.shared.coordinator.close_with_registry(
                    &self.shared.registry,
                    owner,
                    &new_ws_id,
                );
                return Err(FilesystemError::from(err));
            }
        };

        let mut planned_writes: Vec<(&RelativePath, &[u8])> = Vec::new();
        if let Some(ref batch) = request.images {
            for img in batch.as_slice() {
                planned_writes.push((&img.path, &img.bytes));
            }
        }
        planned_writes.push((&entry_rel, &request.bytes));

        let mut priors: Vec<Option<(Vec<u8>, Revision)>> = Vec::with_capacity(planned_writes.len());
        for (rel, _) in &planned_writes {
            match pinned.trusted_root.read_file(rel) {
                Ok(existing) => priors.push(Some((existing.bytes, existing.revision))),
                Err(FsError::NotFound) => priors.push(None),
                Err(err) => {
                    drop(save_lease);
                    let _ = self.shared.coordinator.close_with_registry(
                        &self.shared.registry,
                        owner,
                        &new_ws_id,
                    );
                    return Err(FilesystemError::from(err));
                }
            }
        }

        let mut committed: Vec<(&RelativePath, Option<Vec<u8>>, Revision)> =
            Vec::with_capacity(planned_writes.len());
        let mut write_failure: Option<FilesystemError> = None;
        let mut final_entry_out = None;

        for (idx, ((rel, bytes), prior)) in planned_writes.iter().zip(priors).enumerate() {
            if let Err(hook_err) = before_write(idx, rel, &pinned.trusted_root) {
                write_failure = Some(FilesystemError::from(hook_err));
                break;
            }
            let expected_rev = prior.as_ref().map(|(_, r)| r);
            match pinned.trusted_root.write_file(rel, bytes, expected_rev) {
                Ok(out) => {
                    if *rel == &entry_rel {
                        final_entry_out = Some(out.clone());
                    }
                    committed.push((*rel, prior.map(|(orig_bytes, _)| orig_bytes), out.revision));
                }
                Err(err) => {
                    write_failure = Some(FilesystemError::from(err));
                    break;
                }
            }
        }

        if write_failure.is_none() {
            let state = self.lock_state();
            if state.revoked_owners.contains(owner) {
                write_failure = Some(FilesystemError::SessionClosed);
            } else if let Some(ref source_ws) = request.workspace_id {
                if let Err(err) = self.lookup_active_slot_locked(&state, owner, source_ws, None) {
                    write_failure = Some(err);
                }
            }
        }

        let mut admitted_workspace = None;
        if write_failure.is_none() {
            let entry_out = final_entry_out
                .clone()
                .expect("entry write output recorded");
            let workspace = WorkspaceInfo {
                id: new_ws_id.clone(),
                label: recent_target.label.clone(),
                entry_path: Some(entry_rel.clone()),
            };
            let mut docs = HashMap::new();
            if let Some(ref batch) = request.images {
                for img in batch.as_slice() {
                    if let Some((_, _, ref rev)) =
                        committed.iter().find(|(p, _, _)| *p == &img.path)
                    {
                        docs.insert(
                            img.path.clone(),
                            TrackedDocument {
                                document_id: None,
                                document_version: None,
                                revision: rev.clone(),
                                identity: entry_out.identity,
                            },
                        );
                    }
                }
            }
            docs.insert(
                entry_rel.clone(),
                TrackedDocument {
                    document_id: Some(request.document_id.clone()),
                    document_version: Some(request.document_version),
                    revision: entry_out.revision.clone(),
                    identity: entry_out.identity,
                },
            );
            let mut doc_paths = HashMap::new();
            doc_paths.insert(request.document_id.clone(), entry_rel.clone());

            let canonical_file = pinned.canonical_path.join(&recent_target.label);
            let slot = Arc::new(WorkspaceSlot {
                workspace_id: new_ws_id.clone(),
                owner: owner.clone(),
                generation,
                kind: WorkspaceKind::File,
                info: workspace.clone(),
                canonical_root: pinned.canonical_path.clone(),
                root_meta: pinned.workspace_root.clone(),
                trusted_root: Arc::clone(&pinned.trusted_root),
                state: Mutex::new(SlotState {
                    revoked: false,
                    closing_in_flight: false,
                    active_ops: 0,
                    documents: docs,
                    doc_paths,
                    tasks: HashMap::new(),
                }),
                condvar: Condvar::new(),
                delivery: Mutex::new(()),
            });
            let mut state = self.lock_state();
            if state.revoked_owners.contains(owner) {
                write_failure = Some(FilesystemError::SessionClosed);
            } else {
                state
                    .workspace_generation
                    .insert(new_ws_id.clone(), generation);
                state.latest_owner_root_generation.insert(
                    (owner.clone(), pinned.workspace_root.identity()),
                    generation,
                );
                state.active.insert(new_ws_id.clone(), slot);
                reservation.release_locked(&mut state);
                admitted_workspace = Some((workspace, canonical_file, entry_out));
            }
        }

        if let Some(err) = write_failure {
            let mut rollback_errors: Vec<String> = Vec::new();
            for (rel, orig_bytes, written_rev) in committed.into_iter().rev() {
                match orig_bytes {
                    Some(prev_bytes) => {
                        match pinned
                            .trusted_root
                            .write_file(rel, &prev_bytes, Some(&written_rev))
                        {
                            Ok(restored) => match pinned.trusted_root.read_file(rel) {
                                Ok(verified)
                                    if verified.revision == restored.revision
                                        && verified.bytes == prev_bytes => {}
                                Ok(_) => rollback_errors.push(format!(
                                    "restored {} failed post-rollback verification",
                                    rel.as_str()
                                )),
                                Err(verify_err) => rollback_errors.push(format!(
                                    "restored {} verification read failed: {verify_err:?}",
                                    rel.as_str()
                                )),
                            },
                            Err(rb_err) => rollback_errors
                                .push(format!("restore {} failed: {rb_err:?}", rel.as_str())),
                        }
                    }
                    None => {
                        match pinned
                            .trusted_root
                            .delete_file_if_revision(rel, &written_rev)
                        {
                            Ok(()) => match pinned.trusted_root.read_file(rel) {
                                Err(FsError::NotFound) => {}
                                Ok(_) => rollback_errors.push(format!(
                                    "deleted {} still exists after rollback",
                                    rel.as_str()
                                )),
                                Err(verify_err) => rollback_errors.push(format!(
                                    "deleted {} verification failed: {verify_err:?}",
                                    rel.as_str()
                                )),
                            },
                            Err(rb_err) => rollback_errors
                                .push(format!("delete {} failed: {rb_err:?}", rel.as_str())),
                        }
                    }
                }
            }
            drop(save_lease);
            let _ = self.shared.coordinator.close_with_registry(
                &self.shared.registry,
                owner,
                &new_ws_id,
            );
            if !rollback_errors.is_empty() {
                return Err(FilesystemError::CleanupUnproven {
                    workspace_id: None,
                    reason: format!(
                        "saveAs failed ({err}) and rollback was incomplete: {}",
                        rollback_errors.join("; ")
                    ),
                });
            }
            return Err(err);
        }

        drop(save_lease);
        let (workspace, canonical_file, entry_out) =
            admitted_workspace.expect("admitted saveAs workspace");

        let selection = TrustedWorkspaceSelection {
            workspace: workspace.clone(),
            kind: WorkspaceKind::File,
            target_path: canonical_file,
            opened_at,
        };
        let open_outcome = self.shared.recent_store.admit_opened_workspace(selection);
        let write = WriteReceipt {
            workspace_id: new_ws_id,
            path: entry_rel,
            revision: entry_out.revision,
            document_id: request.document_id.clone(),
            document_version: request.document_version,
        };
        Ok(Some(WorkspaceOpenOutcome {
            opened: SaveAsReceipt {
                workspace: open_outcome.opened,
                write,
            },
            history: open_outcome.history,
        }))
    }

    pub fn start_git_task(
        &self,
        owner: &OwnerId,
        workspace_id: &WorkspaceId,
    ) -> Result<GitWorkspaceLease, FilesystemError> {
        self.start_git_task_with_kind(owner, workspace_id, LeaseKind::Save)
    }

    pub(crate) fn start_git_task_with_kind(
        &self,
        owner: &OwnerId,
        workspace_id: &WorkspaceId,
        kind: LeaseKind,
    ) -> Result<GitWorkspaceLease, FilesystemError> {
        let (slot, task_id) = {
            let mut state = self.lock_state();
            let slot = self.lookup_active_slot_locked(&state, owner, workspace_id, None)?;
            let task_id = state.next_task_id;
            state.next_task_id = task_id
                .checked_add(1)
                .ok_or(FilesystemError::ResourceExhausted)?;
            (slot, task_id)
        };

        slot.trusted_root.verify_alive()?;
        let mut slot_state = slot.lock();
        if slot_state.revoked {
            return Err(FilesystemError::SessionClosed);
        }
        if slot_state.tasks.len() >= MAX_TASKS_PER_WORKSPACE {
            if let Some((&drained_id, _)) = slot_state.tasks.iter().find(|(_, task)| {
                task.drained.load(Ordering::Acquire)
                    && task.lease.is_none()
                    && task.cancel_failed.is_none()
            }) {
                slot_state.tasks.remove(&drained_id);
            }
        }
        if slot_state.tasks.len() >= MAX_TASKS_PER_WORKSPACE {
            return Err(FilesystemError::ResourceExhausted);
        }
        let _ = self.shared.registry.get(owner, workspace_id)?;
        let lease = self.shared.coordinator.try_acquire(
            owner,
            workspace_id,
            Some(slot.generation),
            kind,
            None,
        )?;

        let cancellation = Arc::new(AtomicBool::new(false));
        let cancellation_for_close = Arc::clone(&cancellation);
        let canceller: SubSystemCanceller = Box::new(move || {
            cancellation_for_close.store(true, Ordering::Release);
            Ok(())
        });
        let drained = Arc::new(AtomicBool::new(false));
        let drain = TaskDrainHandle {
            inner: Arc::new(TaskDrainHandleInner {
                service: self.clone(),
                slot: Arc::downgrade(&slot),
                sink: Arc::new(|_: WatchNotification| {}),
                owner: owner.clone(),
                workspace_id: workspace_id.clone(),
                generation: slot.generation,
                task_id,
                drained: Arc::clone(&drained),
                released: AtomicBool::new(false),
            }),
        };

        slot_state.tasks.insert(
            task_id,
            RegisteredTask {
                canceller: Some(canceller),
                drained,
                abandoned: false,
                drain_handles: 1,
                cancel_failed: None,
                lease: Some(lease),
                pins: GitPathPins::default(),
            },
        );
        drop(slot_state);

        Ok(GitWorkspaceLease {
            service: self.clone(),
            slot,
            task_id,
            cancellation,
            drain,
        })
    }

    pub fn start_watch(
        &self,
        owner: &OwnerId,
        workspace_id: &WorkspaceId,
        sink: WatchSink,
        on_cancel: SubSystemCanceller,
    ) -> Result<WatchSubscription, FilesystemError> {
        let (slot, task_id) = {
            let mut state = self.lock_state();
            let slot = self.lookup_active_slot_locked(&state, owner, workspace_id, None)?;
            let task_id = state.next_task_id;
            state.next_task_id = state
                .next_task_id
                .checked_add(1)
                .ok_or(FilesystemError::ResourceExhausted)?;
            (slot, task_id)
        };
        slot.trusted_root.verify_alive()?;
        let drained = Arc::new(AtomicBool::new(false));
        let mut slot_guard = slot.lock();
        if slot_guard.revoked {
            return Err(FilesystemError::SessionClosed);
        }
        if slot_guard.tasks.len() >= MAX_TASKS_PER_WORKSPACE {
            if let Some((&drained_id, _)) = slot_guard.tasks.iter().find(|(_, t)| {
                t.drained.load(Ordering::Acquire) && t.lease.is_none() && t.cancel_failed.is_none()
            }) {
                slot_guard.tasks.remove(&drained_id);
            }
        }
        if slot_guard.tasks.len() >= MAX_TASKS_PER_WORKSPACE {
            return Err(FilesystemError::ResourceExhausted);
        }
        let _ = self.shared.registry.get(owner, workspace_id)?;
        let lease = self.shared.coordinator.try_acquire(
            owner,
            workspace_id,
            Some(slot.generation),
            LeaseKind::Watch,
            None,
        )?;
        slot_guard.tasks.insert(
            task_id,
            RegisteredTask {
                canceller: Some(on_cancel),
                drained: Arc::clone(&drained),
                abandoned: false,
                drain_handles: 1,
                cancel_failed: None,
                lease: Some(lease),
                pins: GitPathPins::default(),
            },
        );
        drop(slot_guard);
        Ok(WatchSubscription {
            service: self.clone(),
            slot: Arc::downgrade(&slot),
            owner: owner.clone(),
            workspace_id: workspace_id.clone(),
            generation: slot.generation,
            task_id,
            drained,
            handle_released: false,
            sink,
        })
    }

    #[cfg(all(windows, target_arch = "x86_64"))]
    pub fn open_verified_watch_target(
        &self,
        owner: &OwnerId,
        workspace_id: &WorkspaceId,
    ) -> Result<crate::services::watch_native::VerifiedDirectoryHandle, FilesystemError> {
        let state = self.lock_state();
        let slot = self.lookup_active_slot_locked(&state, owner, workspace_id, None)?;
        let slot_guard = slot.lock();
        if slot_guard.revoked {
            return Err(FilesystemError::SessionClosed);
        }
        slot.trusted_root.verify_alive()?;

        const FILE_SHARE_READ: u32 = 0x0000_0001;
        const FILE_SHARE_WRITE: u32 = 0x0000_0002;
        const FILE_SHARE_DELETE: u32 = 0x0000_0004;
        const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
        const FILE_FLAG_OVERLAPPED: u32 = 0x4000_0000;
        const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;

        use std::os::windows::fs::OpenOptionsExt;
        use std::os::windows::io::{FromRawHandle, IntoRawHandle};

        let file = OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
            .custom_flags(
                FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OVERLAPPED | FILE_FLAG_OPEN_REPARSE_POINT,
            )
            .open(&slot.canonical_root)
            .map_err(|err| match err.kind() {
                io::ErrorKind::NotFound => FilesystemError::NotFound,
                io::ErrorKind::PermissionDenied => FilesystemError::AccessDenied,
                _ => FilesystemError::Io(err.raw_os_error().unwrap_or(1) as u32),
            })?;

        let raw = file.into_raw_handle();
        let owned = unsafe { std::os::windows::io::OwnedHandle::from_raw_handle(raw) };
        let trusted_root = unsafe {
            crate::services::watch_native::TrustedDirectoryRoot::from_coordinator_open(owned)
                .map_err(|_| FilesystemError::LinkNotAllowed)?
        };
        let verified =
            crate::services::watch_native::VerifiedDirectoryHandle::from_trusted_root(trusted_root)
                .map_err(|_| FilesystemError::LinkNotAllowed)?;

        if verified.identity().volume_serial_number != slot.trusted_root.identity().volume_serial
            || verified.identity().file_index != slot.trusted_root.identity().file_id
        {
            return Err(FilesystemError::StaleWorkspace);
        }
        Ok(verified)
    }

    fn verify_event_gate(
        &self,
        owner: &OwnerId,
        workspace_id: &WorkspaceId,
        generation: SessionGeneration,
        weak_slot: &Weak<WorkspaceSlot>,
    ) -> Result<(), FilesystemError> {
        let state = self.lock_state();
        let slot = self.lookup_active_slot_locked(&state, owner, workspace_id, Some(generation))?;
        let Some(bound) = weak_slot.upgrade() else {
            return Err(FilesystemError::StaleGeneration);
        };
        if !Arc::ptr_eq(&slot, &bound) {
            return Err(FilesystemError::StaleGeneration);
        }
        let slot_guard = slot.lock();
        if slot_guard.revoked {
            return Err(FilesystemError::SessionClosed);
        }
        Ok(())
    }

    pub fn prepare_compile(
        &self,
        owner: &OwnerId,
        run_id: RunId,
        request: &CompileRequest,
        on_cancel: SubSystemCanceller,
    ) -> Result<CompileLeaseTicket, FilesystemError> {
        self.prepare_compile_internal(owner, run_id, request, None, on_cancel)
    }

    pub(crate) fn prepare_compile_with_overlay(
        &self,
        owner: &OwnerId,
        run_id: RunId,
        request: &CompileRequest,
        overlay: &CompileSourceOverlay<'_>,
        on_cancel: SubSystemCanceller,
    ) -> Result<CompileLeaseTicket, FilesystemError> {
        if overlay.path != &request.entry_path
            || overlay.document_id != &request.document_id
            || overlay.document_version != request.document_version
            || overlay.bytes.len() > MAX_COMPILE_ENTRY_OVERLAY_BYTES
        {
            return Err(FilesystemError::CompileIdentityMismatch(
                "compile source overlay does not match request",
            ));
        }
        self.prepare_compile_internal(owner, run_id, request, Some(overlay), on_cancel)
    }

    fn prepare_compile_internal(
        &self,
        owner: &OwnerId,
        run_id: RunId,
        request: &CompileRequest,
        overlay: Option<&CompileSourceOverlay<'_>>,
        on_cancel: SubSystemCanceller,
    ) -> Result<CompileLeaseTicket, FilesystemError> {
        let (slot, task_id) = {
            let mut state = self.lock_state();
            let slot =
                self.lookup_active_slot_locked(&state, owner, &request.workspace_id, None)?;
            let task_id = state.next_task_id;
            state.next_task_id = state
                .next_task_id
                .checked_add(1)
                .ok_or(FilesystemError::ResourceExhausted)?;
            (slot, task_id)
        };
        let mut slot_guard = slot.lock();
        if slot_guard.revoked {
            return Err(FilesystemError::SessionClosed);
        }
        if slot_guard.tasks.len() >= MAX_TASKS_PER_WORKSPACE {
            if let Some((&drained_id, _)) = slot_guard.tasks.iter().find(|(_, t)| {
                t.drained.load(Ordering::Acquire) && t.lease.is_none() && t.cancel_failed.is_none()
            }) {
                slot_guard.tasks.remove(&drained_id);
            }
        }
        if slot_guard.tasks.len() >= MAX_TASKS_PER_WORKSPACE {
            return Err(FilesystemError::ResourceExhausted);
        }
        let _ = self.shared.registry.get(owner, &request.workspace_id)?;
        let lease = self.shared.coordinator.try_acquire(
            owner,
            &request.workspace_id,
            Some(slot.generation),
            LeaseKind::Compile,
            None,
        )?;
        let read_out = slot.trusted_root.read_file(&request.entry_path)?;
        if read_out.revision != request.saved_revision {
            return Err(FilesystemError::RevisionConflict {
                expected: Some(request.saved_revision.clone()),
                actual: Some(read_out.revision),
            });
        }
        if let Some(tracked) = slot_guard.documents.get(&request.entry_path) {
            if let Some(ref doc_id) = tracked.document_id {
                if doc_id != &request.document_id {
                    return Err(FilesystemError::DocumentIdentityMismatch {
                        expected: doc_id.clone(),
                        actual: request.document_id.clone(),
                    });
                }
            }
            if let Some(doc_ver) = tracked.document_version {
                if overlay.is_some() && request.document_version.get() < doc_ver.get() {
                    return Err(FilesystemError::StaleDocumentVersion {
                        expected_min: doc_ver,
                        actual: request.document_version,
                    });
                }
                if overlay.is_none() && doc_ver != request.document_version {
                    return Err(FilesystemError::CompileIdentityMismatch(
                        "compile documentVersion does not match saved document version",
                    ));
                }
            }
        }
        let identity = CompileIdentity {
            run_id,
            workspace_id: request.workspace_id.clone(),
            entry_path: request.entry_path.clone(),
            document_id: request.document_id.clone(),
            document_version: request.document_version,
            saved_revision: request.saved_revision.clone(),
        };
        let drained = Arc::new(AtomicBool::new(false));
        // Finish every fallible ticket construction step before registering the
        // task. If preparation unwinds, the lease remains local and is dropped;
        // there is no registered task that the caller cannot identify or drain.
        let mut ticket = CompileLeaseTicket {
            service: self.clone(),
            slot: Arc::downgrade(&slot),
            owner: owner.clone(),
            identity,
            generation: slot.generation,
            canonical_root: slot.canonical_root.clone(),
            entry_snapshot: read_out.bytes,
            task_id,
            drained: Arc::clone(&drained),
            handle_released: true,
        };
        slot_guard.tasks.insert(
            task_id,
            RegisteredTask {
                canceller: Some(on_cancel),
                drained,
                abandoned: false,
                drain_handles: 1,
                cancel_failed: None,
                lease: Some(lease),
                pins: GitPathPins::default(),
            },
        );
        ticket.handle_released = false;
        drop(slot_guard);
        Ok(ticket)
    }

    fn validate_compile_input_limits(limits: CompileInputLimits) -> Result<(), FilesystemError> {
        if limits.max_depth == 0 || limits.max_depth > MAX_COMPILE_SNAPSHOT_DEPTH {
            return Err(FilesystemError::TreeTooDeep);
        }
        if limits.max_entries == 0 || limits.max_entries > MAX_COMPILE_SNAPSHOT_ENTRIES {
            return Err(FilesystemError::TreeTooLarge);
        }
        if limits.max_file_bytes == 0 || limits.max_file_bytes > MAX_COMPILE_SNAPSHOT_FILE_BYTES {
            return Err(FilesystemError::ResourceExhausted);
        }
        if limits.max_total_bytes == 0 || limits.max_total_bytes > MAX_COMPILE_SNAPSHOT_TOTAL_BYTES
        {
            return Err(FilesystemError::TreeTooLarge);
        }
        Ok(())
    }

    fn compile_ticket_slot(
        &self,
        ticket: &CompileLeaseTicket,
    ) -> Result<Arc<WorkspaceSlot>, FilesystemError> {
        if !Arc::ptr_eq(&self.shared, &ticket.service.shared) {
            return Err(FilesystemError::UnknownWorkspace);
        }
        self.verify_event_gate(
            &ticket.owner,
            &ticket.identity.workspace_id,
            ticket.generation,
            &ticket.slot,
        )?;
        let Some(slot) = ticket.slot.upgrade() else {
            return Err(FilesystemError::SessionClosed);
        };
        {
            let guard = slot.lock();
            if guard.revoked {
                return Err(FilesystemError::SessionClosed);
            }
            let Some(task) = guard.tasks.get(&ticket.task_id) else {
                return Err(FilesystemError::SessionClosed);
            };
            if let Some(reason) = &task.cancel_failed {
                return Err(FilesystemError::CleanupUnproven {
                    workspace_id: Some(ticket.identity.workspace_id.clone()),
                    reason: reason.clone(),
                });
            }
            if task.drained.load(Ordering::Acquire) || task.lease.is_none() {
                return Err(FilesystemError::SessionClosed);
            }
        }
        slot.trusted_root.verify_alive()?;
        Ok(slot)
    }

    pub(crate) fn capture_compile_snapshot(
        &self,
        ticket: &CompileLeaseTicket,
        limits: CompileInputLimits,
    ) -> Result<CompileInputSnapshot, FilesystemError> {
        self.capture_compile_snapshot_excluding(ticket, limits, &[])
    }

    pub(crate) fn capture_compile_snapshot_excluding(
        &self,
        ticket: &CompileLeaseTicket,
        limits: CompileInputLimits,
        excluded_paths: &[RelativePath],
    ) -> Result<CompileInputSnapshot, FilesystemError> {
        Self::validate_compile_input_limits(limits)?;
        let slot = self.compile_ticket_slot(ticket)?;
        let entries = filter_compile_entries(
            slot.trusted_root
                .list_compile_entries(limits.max_depth, limits.max_entries)?,
            excluded_paths,
        );
        let mut files = Vec::new();
        let mut total_bytes = 0usize;
        for entry in entries.iter().filter(|entry| entry.kind == FileKind::File) {
            let remaining = limits.max_total_bytes - total_bytes;
            let file_limit = limits.max_file_bytes.min(remaining);
            let read = match slot.trusted_root.read_file_bounded(&entry.path, file_limit) {
                Ok(read) => read,
                Err(FsError::FileTooLarge { .. }) if file_limit < limits.max_file_bytes => {
                    return Err(FilesystemError::TreeTooLarge);
                }
                Err(error) => return Err(FilesystemError::from(error)),
            };
            total_bytes = total_bytes
                .checked_add(read.bytes.len())
                .ok_or(FilesystemError::TreeTooLarge)?;
            if total_bytes > limits.max_total_bytes {
                return Err(FilesystemError::TreeTooLarge);
            }
            files.push(CompileInputFile {
                path: entry.path.clone(),
                bytes: read.bytes,
                revision: read.revision,
            });
        }

        let entry_file = files
            .iter()
            .find(|file| file.path == ticket.identity.entry_path)
            .ok_or(FilesystemError::NotFound)?;
        if entry_file.revision != ticket.identity.saved_revision
            || entry_file.bytes.as_slice() != ticket.entry_snapshot()
        {
            return Err(FilesystemError::RevisionConflict {
                expected: Some(ticket.identity.saved_revision.clone()),
                actual: Some(entry_file.revision.clone()),
            });
        }
        self.compile_ticket_slot(ticket)?;
        Ok(CompileInputSnapshot {
            entries,
            files,
            limits,
        })
    }

    pub(crate) fn validate_compile_snapshot(
        &self,
        ticket: &CompileLeaseTicket,
        snapshot: &CompileInputSnapshot,
    ) -> Result<(), FilesystemError> {
        self.validate_compile_snapshot_excluding(ticket, snapshot, &[])
    }

    pub(crate) fn validate_compile_snapshot_excluding(
        &self,
        ticket: &CompileLeaseTicket,
        snapshot: &CompileInputSnapshot,
        excluded_paths: &[RelativePath],
    ) -> Result<(), FilesystemError> {
        let slot = self.compile_ticket_slot(ticket)?;
        let limits = snapshot.limits;
        Self::validate_compile_input_limits(limits)?;
        let entries = filter_compile_entries(
            slot.trusted_root
                .list_compile_entries(limits.max_depth, limits.max_entries)?,
            excluded_paths,
        );
        if entries != snapshot.entries {
            return Err(FilesystemError::RevisionConflict {
                expected: None,
                actual: None,
            });
        }
        let file_count = entries
            .iter()
            .filter(|entry| entry.kind == FileKind::File)
            .count();
        if file_count != snapshot.files.len() {
            return Err(FilesystemError::RevisionConflict {
                expected: None,
                actual: None,
            });
        }

        let mut total_bytes = 0usize;
        for entry in entries.iter().filter(|entry| entry.kind == FileKind::File) {
            let expected = snapshot
                .files
                .iter()
                .find(|file| file.path == entry.path)
                .ok_or(FilesystemError::RevisionConflict {
                    expected: None,
                    actual: None,
                })?;
            let remaining = limits.max_total_bytes - total_bytes;
            let file_limit = limits.max_file_bytes.min(remaining);
            let read = match slot.trusted_root.read_file_bounded(&entry.path, file_limit) {
                Ok(read) => read,
                Err(FsError::FileTooLarge { .. }) if file_limit < limits.max_file_bytes => {
                    return Err(FilesystemError::TreeTooLarge);
                }
                Err(error) => return Err(FilesystemError::from(error)),
            };
            total_bytes = total_bytes
                .checked_add(read.bytes.len())
                .ok_or(FilesystemError::TreeTooLarge)?;
            if total_bytes > limits.max_total_bytes {
                return Err(FilesystemError::TreeTooLarge);
            }
            if read.revision != expected.revision || read.bytes != expected.bytes {
                return Err(FilesystemError::RevisionConflict {
                    expected: Some(expected.revision.clone()),
                    actual: Some(read.revision),
                });
            }
        }
        self.compile_ticket_slot(ticket)?;
        Ok(())
    }

    pub(crate) fn commit_compile_outputs<F>(
        &self,
        ticket: &CompileLeaseTicket,
        outputs: &[CompileOutputFile],
        is_cancelled: F,
    ) -> Result<(), FilesystemError>
    where
        F: Fn() -> bool,
    {
        self.commit_compile_outputs_inner(ticket, outputs, is_cancelled, |_, _| Ok(()))
    }

    #[cfg(test)]
    pub(crate) fn commit_compile_outputs_with_hook<F, H>(
        &self,
        ticket: &CompileLeaseTicket,
        outputs: &[CompileOutputFile],
        is_cancelled: F,
        before_write: H,
    ) -> Result<(), FilesystemError>
    where
        F: Fn() -> bool,
        H: FnMut(usize, &RelativePath) -> Result<(), FilesystemError>,
    {
        self.commit_compile_outputs_inner(ticket, outputs, is_cancelled, before_write)
    }

    fn commit_compile_outputs_inner<F, H>(
        &self,
        ticket: &CompileLeaseTicket,
        outputs: &[CompileOutputFile],
        is_cancelled: F,
        mut before_write: H,
    ) -> Result<(), FilesystemError>
    where
        F: Fn() -> bool,
        H: FnMut(usize, &RelativePath) -> Result<(), FilesystemError>,
    {
        if outputs.is_empty() {
            return Ok(());
        }
        if outputs.len() > 2 {
            return Err(FilesystemError::ResourceExhausted);
        }
        let slot = self.compile_ticket_slot(ticket)?;
        let entries = slot.trusted_root.list_files()?;
        let mut names = HashSet::new();
        let mut total = 0usize;
        for output in outputs {
            let path = output.path.as_str();
            let folded = path.to_lowercase();
            if !names.insert(folded)
                || output.path == ticket.identity.entry_path
                || is_internal_recovery_name(&output.path)
            {
                return Err(FilesystemError::InvalidPath(
                    "invalid compile output path".to_owned(),
                ));
            }
            let limit = compile_output_limit(output.kind);
            if output.bytes.len() > limit {
                return Err(FilesystemError::FileTooLarge {
                    size: output.bytes.len() as u64,
                    limit,
                });
            }
            match output.kind {
                CompileOutputKind::Pdf => {
                    if !path.to_ascii_lowercase().ends_with(".pdf") {
                        return Err(FilesystemError::InvalidPath(
                            "PDF output must use a .pdf path".to_owned(),
                        ));
                    }
                    validate_pdf(&output.bytes)?;
                }
                CompileOutputKind::Log => {
                    if !path.to_ascii_lowercase().ends_with(".log") {
                        return Err(FilesystemError::InvalidPath(
                            "log output must use a .log path".to_owned(),
                        ));
                    }
                }
            }
            total = total
                .checked_add(output.bytes.len())
                .ok_or(FilesystemError::ResourceExhausted)?;
            if total > MAX_PDF_BYTES + MAX_COMPILE_OUTPUT_LOG_BYTES {
                return Err(FilesystemError::ResourceExhausted);
            }
            if let Some((parent, _)) = path.rsplit_once('/') {
                let directory = entries.iter().any(|entry| {
                    entry.path.as_str().eq_ignore_ascii_case(parent)
                        && entry.kind == FileKind::Directory
                });
                if !directory {
                    return Err(FilesystemError::NotFound);
                }
            }
            if entries.iter().any(|entry| {
                entry.path.as_str().eq_ignore_ascii_case(path) && entry.kind == FileKind::Directory
            }) {
                return Err(FilesystemError::IsADirectory);
            }
        }

        let mut priors = Vec::with_capacity(outputs.len());
        let mut backup_total = 0usize;
        for output in outputs {
            let maximum = compile_output_limit(output.kind);
            match slot.trusted_root.read_file_bounded(&output.path, maximum) {
                Ok(previous) => {
                    backup_total = backup_total
                        .checked_add(previous.bytes.len())
                        .ok_or(FilesystemError::ResourceExhausted)?;
                    if backup_total > MAX_COMPILE_OUTPUT_BACKUP_BYTES {
                        return Err(FilesystemError::ResourceExhausted);
                    }
                    priors.push(Some(previous));
                }
                Err(FsError::NotFound) => priors.push(None),
                Err(error) => return Err(FilesystemError::from(error)),
            }
        }

        let mut committed = Vec::with_capacity(outputs.len());
        let mut failure = None;
        for (index, (output, prior)) in outputs.iter().zip(priors).enumerate() {
            if is_cancelled() {
                failure = Some(FilesystemError::Cancelled);
                break;
            }
            if let Err(error) = self.compile_ticket_slot(ticket) {
                failure = Some(error);
                break;
            }
            let hook = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                before_write(index, &output.path)
            }));
            match hook {
                Ok(Ok(())) => {}
                Ok(Err(error)) => {
                    failure = Some(error);
                    break;
                }
                Err(_) => {
                    failure = Some(FilesystemError::Io(1));
                    break;
                }
            }
            let expected = prior.as_ref().map(|item| &item.revision);
            match slot
                .trusted_root
                .write_file(&output.path, &output.bytes, expected)
            {
                Ok(written) => {
                    committed.push(CompileOutputPrior {
                        path: output.path.clone(),
                        previous: prior.map(|item| item.bytes),
                        written_revision: written.revision.clone(),
                    });
                    match slot
                        .trusted_root
                        .read_file_bounded(&output.path, compile_output_limit(output.kind))
                    {
                        Ok(current)
                            if current.revision == written.revision
                                && current.bytes == output.bytes => {}
                        Ok(_) => {
                            failure = Some(FilesystemError::StaleWorkspace);
                            break;
                        }
                        Err(error) => {
                            failure = Some(FilesystemError::from(error));
                            break;
                        }
                    }
                }
                Err(error) => {
                    failure = Some(FilesystemError::from(error));
                    break;
                }
            }
        }

        if failure.is_none() && is_cancelled() {
            failure = Some(FilesystemError::Cancelled);
        }
        if failure.is_none() {
            if let Err(error) = self.compile_ticket_slot(ticket) {
                failure = Some(error);
            }
        }
        if let Some(error) = failure {
            let mut cleanup_error = None;
            for prior in committed.iter().rev() {
                if let Err(cleanup) = rollback_compile_output_bounded(&slot.trusted_root, prior) {
                    if cleanup_error.is_none() {
                        cleanup_error = Some(cleanup);
                    }
                }
            }
            return Err(cleanup_error.unwrap_or(error));
        }
        Ok(())
    }

    fn verify_compile_result(
        &self,
        owner: &OwnerId,
        expected_identity: &CompileIdentity,
        generation: SessionGeneration,
        weak_slot: &Weak<WorkspaceSlot>,
        task_id: u64,
        result: CompileResult,
    ) -> Result<CompileResult, FilesystemError> {
        self.verify_event_gate(
            owner,
            &expected_identity.workspace_id,
            generation,
            weak_slot,
        )?;
        let actual_identity = match &result {
            CompileResult::Success { identity, pdf, .. } => {
                validate_pdf(pdf)?;
                identity
            }
            CompileResult::Failure { identity, .. } | CompileResult::Cancelled { identity, .. } => {
                identity
            }
        };
        if actual_identity != expected_identity {
            return Err(FilesystemError::CompileIdentityMismatch(
                "compile result identity does not match prepared compile identity",
            ));
        }
        let Some(slot) = weak_slot.upgrade() else {
            return Err(FilesystemError::SessionClosed);
        };
        {
            let slot_guard = slot.lock();
            if slot_guard.revoked {
                return Err(FilesystemError::SessionClosed);
            }
            let Some(task) = slot_guard.tasks.get(&task_id) else {
                return Err(FilesystemError::SessionClosed);
            };
            if let Some(ref reason) = task.cancel_failed {
                return Err(FilesystemError::CleanupUnproven {
                    workspace_id: Some(expected_identity.workspace_id.clone()),
                    reason: reason.clone(),
                });
            }
            if task.drained.load(Ordering::Acquire) || task.lease.is_none() {
                return Err(FilesystemError::SessionClosed);
            }
        }
        let current_disk = slot.trusted_root.read_file(&expected_identity.entry_path)?;
        if current_disk.revision != expected_identity.saved_revision {
            return Err(FilesystemError::RevisionConflict {
                expected: Some(expected_identity.saved_revision.clone()),
                actual: Some(current_disk.revision),
            });
        }
        Ok(result)
    }

    fn lookup_slot_for_drain_locked(
        &self,
        state: &ServiceState,
        owner: &OwnerId,
        workspace_id: &WorkspaceId,
        expected_gen: Option<SessionGeneration>,
    ) -> Result<Option<Arc<WorkspaceSlot>>, FilesystemError> {
        if let Some(slot) = state
            .active
            .get(workspace_id)
            .or_else(|| state.retiring.get(workspace_id))
        {
            if &slot.owner != owner {
                return Err(FilesystemError::UnknownWorkspace);
            }
            if expected_gen.is_some_and(|exp| exp != slot.generation) {
                return Err(FilesystemError::StaleGeneration);
            }
            return Ok(Some(Arc::clone(slot)));
        }
        if let Some((ret_owner, ret_gen, _)) = state.retired.get(workspace_id) {
            if ret_owner != owner {
                return Err(FilesystemError::UnknownWorkspace);
            }
            if expected_gen.is_some_and(|exp| exp != *ret_gen) {
                return Err(FilesystemError::StaleGeneration);
            }
            return Ok(None);
        }
        Err(FilesystemError::UnknownWorkspace)
    }

    fn create_task_drain_handle(
        &self,
        slot: &Arc<WorkspaceSlot>,
        sink: WatchSink,
        task_id: u64,
    ) -> Result<TaskDrainHandle, FilesystemError> {
        let owner = slot.owner.clone();
        let workspace_id = slot.workspace_id.clone();
        let generation = slot.generation;
        let mut guard = slot.lock();
        let task = guard
            .tasks
            .get_mut(&task_id)
            .ok_or(FilesystemError::SessionClosed)?;
        task.drain_handles = task
            .drain_handles
            .checked_add(1)
            .ok_or(FilesystemError::ResourceExhausted)?;
        let drained = Arc::clone(&task.drained);
        drop(guard);
        Ok(TaskDrainHandle {
            inner: Arc::new(TaskDrainHandleInner {
                service: self.clone(),
                slot: Arc::downgrade(slot),
                sink,
                owner,
                workspace_id,
                generation,
                task_id,
                drained,
                released: AtomicBool::new(false),
            }),
        })
    }

    fn abandon_task_handle(
        &self,
        workspace_id: &WorkspaceId,
        generation: SessionGeneration,
        task_id: u64,
    ) {
        let slot = {
            let state = self.lock_state();
            state
                .active
                .get(workspace_id)
                .or_else(|| state.retiring.get(workspace_id))
                .filter(|s| s.generation == generation)
                .cloned()
        };
        if let Some(slot) = slot {
            let mut guard = slot.lock();
            if let Some(task) = guard.tasks.get_mut(&task_id) {
                task.abandoned = true;
                task.drain_handles = task.drain_handles.saturating_sub(1);
            }
            slot.condvar.notify_all();
        }
    }

    fn finalize_retiring_slot(&self, owner: &OwnerId, workspace_id: &WorkspaceId) {
        let _ = self.shared.coordinator.close_session(owner, workspace_id);
        let mut state = self.lock_state();
        state.retiring.remove(workspace_id);
    }

    fn complete_task_drain_internal(
        &self,
        owner: &OwnerId,
        workspace_id: &WorkspaceId,
        expected_gen: Option<SessionGeneration>,
        task_id: u64,
        release_handle: bool,
        remove_if_active: bool,
    ) -> Result<bool, FilesystemError> {
        let Some(slot) = ({
            let state = self.lock_state();
            self.lookup_slot_for_drain_locked(&state, owner, workspace_id, expected_gen)?
        }) else {
            return Ok(false);
        };
        let (lease_to_drop, was_undrained, finalize_retiring) = {
            let mut guard = slot.lock();
            let mut lease_to_drop = None;
            let mut was_undrained = false;
            let revoked = guard.revoked;
            let mut should_remove = false;
            if let Some(task) = guard.tasks.get_mut(&task_id) {
                lease_to_drop = task.lease.take();
                task.cancel_failed = None;
                if release_handle {
                    task.drain_handles = task.drain_handles.saturating_sub(1);
                }
                was_undrained =
                    !task.drained.swap(true, Ordering::AcqRel) || lease_to_drop.is_some();
                should_remove = remove_if_active || (revoked && task.canceller.is_none());
            }
            if should_remove {
                guard.tasks.remove(&task_id);
            }
            let ready = guard.revoked
                && !guard.closing_in_flight
                && guard.active_ops == 0
                && guard.tasks.values().all(|t| {
                    t.drained.load(Ordering::Acquire)
                        && t.cancel_failed.is_none()
                        && t.lease.is_none()
                });
            if ready {
                guard.tasks.clear();
            }
            slot.condvar.notify_all();
            (lease_to_drop, was_undrained, ready)
        };
        drop(lease_to_drop);
        if finalize_retiring {
            self.finalize_retiring_slot(&slot.owner, &slot.workspace_id);
        }
        Ok(was_undrained)
    }

    fn drain_task_with_proof_internal<F>(
        &self,
        owner: &OwnerId,
        workspace_id: &WorkspaceId,
        expected_gen: Option<SessionGeneration>,
        task_id: u64,
        options: TaskDrainOptions,
        prove_cleanup: F,
    ) -> Result<(), FilesystemError>
    where
        F: FnOnce() -> Result<(), String>,
    {
        let Some(slot) = ({
            let state = self.lock_state();
            self.lookup_slot_for_drain_locked(&state, owner, workspace_id, expected_gen)?
        }) else {
            return Ok(());
        };
        let outcome = catch_unwind(AssertUnwindSafe(prove_cleanup));
        match outcome {
            Ok(Ok(())) => {
                let _ = self.complete_task_drain_internal(
                    owner,
                    workspace_id,
                    Some(slot.generation),
                    task_id,
                    options.release_handle,
                    options.remove_if_active,
                )?;
                Ok(())
            }
            Ok(Err(reason)) => {
                let mut guard = slot.lock();
                if let Some(task) = guard.tasks.get_mut(&task_id) {
                    if options.release_handle {
                        task.abandoned = true;
                        task.drain_handles = task.drain_handles.saturating_sub(1);
                    }
                    task.drained.store(false, Ordering::Release);
                    task.cancel_failed = Some(reason.clone());
                }
                slot.condvar.notify_all();
                Err(FilesystemError::CleanupUnproven {
                    workspace_id: Some(workspace_id.clone()),
                    reason,
                })
            }
            Err(_) => {
                let reason = "cleanup proof callback panicked".to_owned();
                let mut guard = slot.lock();
                if let Some(task) = guard.tasks.get_mut(&task_id) {
                    if options.release_handle {
                        task.abandoned = true;
                        task.drain_handles = task.drain_handles.saturating_sub(1);
                    }
                    task.drained.store(false, Ordering::Release);
                    task.cancel_failed = Some(reason.clone());
                }
                slot.condvar.notify_all();
                Err(FilesystemError::CleanupUnproven {
                    workspace_id: Some(workspace_id.clone()),
                    reason,
                })
            }
        }
    }

    pub fn complete_task_drain(
        &self,
        owner: &OwnerId,
        workspace_id: &WorkspaceId,
        task_id: u64,
    ) -> Result<bool, FilesystemError> {
        self.complete_task_drain_internal(owner, workspace_id, None, task_id, false, true)
    }

    pub fn drain_task_with_proof<F>(
        &self,
        owner: &OwnerId,
        workspace_id: &WorkspaceId,
        task_id: u64,
        prove_cleanup: F,
    ) -> Result<(), FilesystemError>
    where
        F: FnOnce() -> Result<(), String>,
    {
        self.drain_task_with_proof_internal(
            owner,
            workspace_id,
            None,
            task_id,
            TaskDrainOptions {
                release_handle: false,
                remove_if_active: true,
            },
            prove_cleanup,
        )
    }

    pub fn has_undrained_cleanup(&self, workspace_id: &WorkspaceId) -> bool {
        let slot = {
            let state = self.lock_state();
            state
                .retiring
                .get(workspace_id)
                .or_else(|| state.active.get(workspace_id))
                .cloned()
        };
        slot.is_some_and(|s| {
            let guard = s.lock();
            guard.active_ops > 0
                || guard.tasks.values().any(|t| {
                    !t.drained.load(Ordering::Acquire)
                        || t.cancel_failed.is_some()
                        || t.lease.is_some()
                })
        })
    }

    pub fn process_pending_cleanup(
        &self,
        owner: &OwnerId,
        workspace_id: &WorkspaceId,
    ) -> Result<(), FilesystemError> {
        let Some(slot) = ({
            let state = self.lock_state();
            self.lookup_slot_for_drain_locked(&state, owner, workspace_id, None)?
        }) else {
            return Ok(());
        };
        self.revoke_and_drain_slots(owner, vec![slot])
    }

    pub fn process_pending_cleanup_with<F>(
        &self,
        owner: &OwnerId,
        workspace_id: &WorkspaceId,
        mut prove_cleanup: F,
    ) -> Result<(), FilesystemError>
    where
        F: FnMut(u64) -> Result<(), String>,
    {
        let Some(slot) = ({
            let state = self.lock_state();
            self.lookup_slot_for_drain_locked(&state, owner, workspace_id, None)?
        }) else {
            return Ok(());
        };
        let pending: Vec<(u64, Option<SubSystemCanceller>)> = {
            let mut guard = slot.lock();
            guard
                .tasks
                .iter_mut()
                .filter(|(_, t)| {
                    !t.drained.load(Ordering::Acquire)
                        || t.cancel_failed.is_some()
                        || t.lease.is_some()
                })
                .map(|(&id, t)| (id, t.canceller.take()))
                .collect()
        };
        let mut errors: Vec<String> = Vec::new();
        for (task_id, maybe_cb) in pending {
            if let Some(cb) = maybe_cb {
                match catch_unwind(AssertUnwindSafe(cb)) {
                    Ok(Ok(())) => {}
                    Ok(Err(reason)) => {
                        let mut guard = slot.lock();
                        if let Some(t) = guard.tasks.get_mut(&task_id) {
                            t.drained.store(false, Ordering::Release);
                            t.cancel_failed = Some(reason.clone());
                        }
                        errors.push(reason);
                        continue;
                    }
                    Err(_) => {
                        let reason = "registered canceller panicked during cleanup".to_owned();
                        let mut guard = slot.lock();
                        if let Some(t) = guard.tasks.get_mut(&task_id) {
                            t.drained.store(false, Ordering::Release);
                            t.cancel_failed = Some(reason.clone());
                        }
                        errors.push(reason);
                        continue;
                    }
                }
            }
            if let Err(err) = self.drain_task_with_proof_internal(
                owner,
                workspace_id,
                Some(slot.generation),
                task_id,
                TaskDrainOptions {
                    release_handle: false,
                    remove_if_active: true,
                },
                || prove_cleanup(task_id),
            ) {
                errors.push(err.to_string());
            }
        }
        if !errors.is_empty() {
            return Err(FilesystemError::CleanupUnproven {
                workspace_id: Some(workspace_id.clone()),
                reason: errors.join("; "),
            });
        }
        self.revoke_and_drain_slots(owner, vec![slot])
    }

    fn revoke_and_drain_slots(
        &self,
        owner: &OwnerId,
        slots: Vec<Arc<WorkspaceSlot>>,
    ) -> Result<(), FilesystemError> {
        let mut cancellers: Vec<(Arc<WorkspaceSlot>, u64, SubSystemCanceller)> = Vec::new();
        for slot in &slots {
            let mut slot_guard = slot.lock();
            slot_guard.revoked = true;
            slot_guard.closing_in_flight = true;
            for (&task_id, task) in slot_guard.tasks.iter_mut() {
                if let Some(cb) = task.canceller.take() {
                    cancellers.push((Arc::clone(slot), task_id, cb));
                }
            }
            slot.condvar.notify_all();
        }

        // Invoke all registered cancellers strictly outside locks.
        let mut errors: Vec<(Option<WorkspaceId>, String)> = Vec::new();
        for (slot, task_id, cb) in cancellers {
            match catch_unwind(AssertUnwindSafe(cb)) {
                Ok(Ok(())) => {}
                Ok(Err(reason)) => {
                    let mut slot_guard = slot.lock();
                    if let Some(task) = slot_guard.tasks.get_mut(&task_id) {
                        task.drained.store(false, Ordering::Release);
                        task.cancel_failed = Some(reason.clone());
                    }
                    slot.condvar.notify_all();
                    errors.push((Some(slot.workspace_id.clone()), reason));
                }
                Err(_) => {
                    let reason = "registered canceller panicked during close".to_owned();
                    let mut slot_guard = slot.lock();
                    if let Some(task) = slot_guard.tasks.get_mut(&task_id) {
                        task.drained.store(false, Ordering::Release);
                        task.cancel_failed = Some(reason.clone());
                    }
                    slot.condvar.notify_all();
                    errors.push((Some(slot.workspace_id.clone()), reason));
                }
            }
        }

        // Drain any in-flight immediate event deliveries before draining tasks and finalizing.
        for slot in &slots {
            let delivery_guard = slot.delivery.lock().unwrap_or_else(PoisonError::into_inner);
            drop(delivery_guard);
        }

        let deadline = Instant::now() + self.shared.drain_timeout;
        for slot in &slots {
            let mut slot_guard = slot.lock();
            while slot_guard.active_ops > 0
                || slot_guard.tasks.values().any(|t| {
                    !t.drained.load(Ordering::Acquire)
                        && t.cancel_failed.is_none()
                        && !(t.abandoned && t.drain_handles == 0)
                })
            {
                let Some(rem) = deadline.checked_duration_since(Instant::now()) else {
                    break;
                };
                let (next_guard, wait_res) = slot
                    .condvar
                    .wait_timeout(slot_guard, rem)
                    .unwrap_or_else(PoisonError::into_inner);
                slot_guard = next_guard;
                if wait_res.timed_out() {
                    break;
                }
            }
            let drained_cleanly = slot_guard.active_ops == 0
                && slot_guard.tasks.values().all(|t| {
                    t.drained.load(Ordering::Acquire)
                        && t.cancel_failed.is_none()
                        && t.lease.is_none()
                });
            slot_guard.closing_in_flight = false;
            let mut leases_to_drop = Vec::new();
            if drained_cleanly {
                for (_, mut task) in slot_guard.tasks.drain() {
                    if let Some(l) = task.lease.take() {
                        leases_to_drop.push(l);
                    }
                }
            }
            drop(slot_guard);
            drop(leases_to_drop);
            let delivery_guard = slot.delivery.lock().unwrap_or_else(PoisonError::into_inner);
            drop(delivery_guard);
            if drained_cleanly {
                self.finalize_retiring_slot(owner, &slot.workspace_id);
            } else {
                let already_reported = errors
                    .iter()
                    .any(|(w, _)| w.as_ref() == Some(&slot.workspace_id));
                if !already_reported {
                    errors.push((
                        Some(slot.workspace_id.clone()),
                        "workspace active operations or registered tasks did not drain".to_owned(),
                    ));
                }
            }
        }

        if let Some((ws_id, first_reason)) = errors.first() {
            let combined = errors
                .iter()
                .map(|(_, r)| r.as_str())
                .collect::<Vec<_>>()
                .join("; ");
            let _ = first_reason;
            return Err(FilesystemError::CleanupUnproven {
                workspace_id: ws_id.clone(),
                reason: combined,
            });
        }
        Ok(())
    }

    pub fn close_workspace(
        &self,
        owner: &OwnerId,
        workspace_id: &WorkspaceId,
    ) -> Result<(), FilesystemError> {
        let slot = {
            let mut state = self.lock_state();
            let slot = self.lookup_active_slot_locked(&state, owner, workspace_id, None)?;
            state.active.remove(workspace_id);
            state
                .retiring
                .insert(workspace_id.clone(), Arc::clone(&slot));
            state.retired.insert(
                workspace_id.clone(),
                (owner.clone(), slot.generation, slot.root_meta.identity()),
            );
            let _ = self.shared.registry.close(owner, workspace_id);
            slot
        };
        self.revoke_and_drain_slots(owner, vec![slot])
    }

    pub fn revoke_owner(&self, owner: &OwnerId) -> Result<usize, FilesystemError> {
        let (slots, admission_drained) = {
            let mut state = self.lock_state();
            state.revoked_owners.insert(owner.clone());
            let deadline = Instant::now() + self.shared.drain_timeout;
            while state.admitting_owners.get(owner).copied().unwrap_or(0) > 0 {
                let Some(rem) = deadline.checked_duration_since(Instant::now()) else {
                    break;
                };
                let (next_state, wait_res) = self
                    .shared
                    .admission_condvar
                    .wait_timeout(state, rem)
                    .unwrap_or_else(PoisonError::into_inner);
                state = next_state;
                if wait_res.timed_out() {
                    break;
                }
            }
            let admission_drained = state.admitting_owners.get(owner).copied().unwrap_or(0) == 0;
            let owned_ids: Vec<WorkspaceId> = state
                .active
                .iter()
                .filter(|(_, s)| &s.owner == owner)
                .map(|(id, _)| id.clone())
                .collect();
            let mut removed = Vec::with_capacity(owned_ids.len());
            for id in owned_ids {
                if let Some(slot) = state.active.remove(&id) {
                    state.retiring.insert(id.clone(), Arc::clone(&slot));
                    state.retired.insert(
                        id,
                        (owner.clone(), slot.generation, slot.root_meta.identity()),
                    );
                    removed.push(slot);
                }
            }
            for (id, slot) in &state.retiring {
                if &slot.owner == owner && !removed.iter().any(|s| s.workspace_id == *id) {
                    removed.push(Arc::clone(slot));
                }
            }
            let _ = self.shared.registry.revoke_owner(owner);
            (removed, admission_drained)
        };
        let count = slots.len();
        self.revoke_and_drain_slots(owner, slots)?;
        if !admission_drained {
            return Err(FilesystemError::CleanupUnproven {
                workspace_id: None,
                reason: "in-flight owner workspace admission did not drain".to_owned(),
            });
        }
        Ok(count)
    }

    pub fn list_recent(&self) -> Result<Vec<RecentDocument>, FilesystemError> {
        Ok(self.shared.recent_store.list_recent()?)
    }

    pub fn remove_recent(&self, recent_id: &str) -> Result<bool, FilesystemError> {
        Ok(self.shared.recent_store.remove_recent(recent_id)?)
    }

    pub fn read_preferences(&self) -> Result<ReadPreferencesResult, FilesystemError> {
        Ok(self.shared.settings_store.read_preferences()?)
    }

    pub fn set_preference(&self, value: PreferenceValue) -> Result<Preferences, FilesystemError> {
        Ok(self.shared.settings_store.set_preference(value)?)
    }

    pub fn save_preferences(&self, preferences: &Preferences) -> Result<(), FilesystemError> {
        Ok(self.shared.settings_store.save_preferences(preferences)?)
    }

    pub fn restore_default_preferences(&self) -> Result<ReadPreferencesResult, FilesystemError> {
        Ok(self.shared.settings_store.restore_defaults()?)
    }

    pub fn import_legacy_preferences(
        &self,
        legacy_record: &BTreeMap<String, Value>,
        legacy_source_dir: Option<&Path>,
    ) -> Result<ImportPreferencesResult, FilesystemError> {
        Ok(self
            .shared
            .settings_store
            .import_legacy_record(legacy_record, legacy_source_dir)?)
    }
}

#[cfg(test)]
#[path = "../../tests/unit/filesystem.rs"]
mod tests;
