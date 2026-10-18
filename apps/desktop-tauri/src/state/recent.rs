// SPDX-License-Identifier: Apache-2.0
//! Host-owned persistent store for recent documents (`frontend-recent-v1.json`).
//! Keeps canonical filesystem paths private to the native host while exposing
//! only validated `RecentDocument` DTOs to the renderer.

use std::{
    collections::{HashMap, HashSet},
    env,
    error::Error,
    fmt,
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex, OnceLock,
    },
    thread,
    time::Duration,
};

use serde::{de::Error as _, Deserialize, Deserializer, Serialize};
use uuid::Uuid;

use crate::{
    schemas::protocol::{
        RecentDocument, RecentId, Timestamp, WorkspaceInfo, WorkspaceKind, MAX_RECENT_TEXT_UTF16,
        MAX_TEXT_UTF16,
    },
    shared::relative_path::RelativePath,
};

/// Independent subdirectory name for the Tauri host persistent state.
pub const HOST_DATA_DIR_NAME: &str = "ModuTeX-Tauri-Host";
/// File name for the v1 recent-documents store.
pub const RECENT_STORE_FILENAME: &str = "frontend-recent-v1.json";
/// Current schema version for `frontend-recent-v1.json`.
pub const RECENT_SCHEMA_VERSION: u32 = 1;
/// Maximum number of MRU recent-document entries retained.
pub const MAX_RECENT_DOCUMENTS: usize = 20;
/// Maximum byte size checked prior to allocation when loading the store.
pub const MAX_RECENT_STORE_BYTES: u64 = 256 * 1024;
/// Maximum atomic replace attempts on Windows sharing/replace contention.
pub const RENAME_MAX_ATTEMPTS: usize = 10;
/// Base linear backoff step in milliseconds (10 + 20 + ... + 90 = 450ms).
pub const RENAME_RETRY_STEP_MS: u64 = 10;
/// Maximum cumulative retry sleep budget in milliseconds.
pub const RENAME_MAX_BACKOFF_MS: u64 = 450;

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(1);

fn store_locks() -> &'static Mutex<HashMap<String, Arc<Mutex<()>>>> {
    static LOCKS: OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();
    LOCKS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn acquire_store_lock(store_path: &Path) -> Arc<Mutex<()>> {
    let key = store_lock_key(store_path);
    let mut map = store_locks()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    Arc::clone(map.entry(key).or_insert_with(|| Arc::new(Mutex::new(()))))
}

pub(crate) fn normalized_path_identity_key(path: &Path) -> String {
    let base = if path.is_absolute() {
        path.to_path_buf()
    } else {
        env::current_dir()
            .map(|cwd| cwd.join(path))
            .unwrap_or_else(|_| path.to_path_buf())
    };

    // Lock identity must not depend on whether the store's parent has already
    // been created. Keep this lexical: filesystem canonicalization changes
    // its answer during a first write.
    let mut normalized = PathBuf::new();
    let mut root_components = 0usize;
    for component in base.components() {
        match component {
            Component::Prefix(prefix) => {
                normalized.push(prefix.as_os_str());
                root_components += 1;
            }
            Component::RootDir => {
                normalized.push(component.as_os_str());
                root_components += 1;
            }
            Component::CurDir => {}
            Component::ParentDir => {
                if matches!(
                    normalized.components().next_back(),
                    Some(Component::Normal(_))
                ) {
                    normalized.pop();
                } else if normalized.components().count() == root_components {
                    normalized.push("..");
                }
            }
            Component::Normal(name) => normalized.push(name),
        }
    }
    canonical_identity_key(&normalized.to_string_lossy())
}

fn store_lock_key(path: &Path) -> String {
    normalized_path_identity_key(path)
}

/// Resolves the default host-specific data directory independent of legacy paths.
pub fn resolve_host_data_dir() -> Result<PathBuf, RecentStoreError> {
    #[cfg(windows)]
    {
        if let Some(base) = env::var_os("LOCALAPPDATA").or_else(|| env::var_os("APPDATA")) {
            if !base.is_empty() {
                return Ok(PathBuf::from(base).join(HOST_DATA_DIR_NAME));
            }
        }
    }
    #[cfg(not(windows))]
    {
        if let Some(base) = env::var_os("XDG_DATA_HOME") {
            if !base.is_empty() {
                return Ok(PathBuf::from(base).join(HOST_DATA_DIR_NAME));
            }
        }
        if let Some(home) = env::var_os("HOME") {
            if !home.is_empty() {
                return Ok(PathBuf::from(home)
                    .join(".local")
                    .join("share")
                    .join(HOST_DATA_DIR_NAME));
            }
        }
    }
    Err(RecentStoreError::new(
        RecentErrorCode::IoFailed,
        "unable to resolve host application data directory",
    ))
}

/// Builds the independent host data directory beneath an explicit base directory.
pub fn resolve_host_data_dir_from(base_dir: &Path) -> PathBuf {
    base_dir.join(HOST_DATA_DIR_NAME)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RecentErrorCode {
    InvalidId,
    InvalidTarget,
    NotFound,
    TargetMissing,
    LinkNotAllowed,
    OversizeStore,
    MalformedSchema,
    PersistenceFailed,
    IoFailed,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RecentStoreError {
    code: RecentErrorCode,
    message: String,
}

impl RecentStoreError {
    pub fn new(code: RecentErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn code(&self) -> RecentErrorCode {
        self.code
    }

    pub fn message(&self) -> &str {
        &self.message
    }
}

impl fmt::Display for RecentStoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:?}: {}", self.code, self.message)
    }
}

impl Error for RecentStoreError {}

/// Trusted workspace selection result produced by the native workspace opener.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TrustedWorkspaceSelection {
    pub workspace: WorkspaceInfo,
    pub kind: WorkspaceKind,
    pub target_path: PathBuf,
    pub opened_at: Timestamp,
}

/// Host-validated target input for recording a recent workspace or document.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TrustedRecentTarget {
    pub kind: WorkspaceKind,
    pub target_path: PathBuf,
    pub label: String,
    pub entry_path: Option<RelativePath>,
    pub opened_at: Timestamp,
}

impl TrustedRecentTarget {
    pub fn from_selection(selection: &TrustedWorkspaceSelection) -> Self {
        Self {
            kind: selection.kind,
            target_path: selection.target_path.clone(),
            label: selection.workspace.label.clone(),
            entry_path: selection.workspace.entry_path.clone(),
            opened_at: selection.opened_at,
        }
    }

    pub fn for_folder(
        folder_path: impl Into<PathBuf>,
        entry_path: Option<RelativePath>,
        opened_at: Timestamp,
    ) -> Result<Self, RecentStoreError> {
        let target_path = folder_path.into();
        let label = extract_display_label(&target_path)?;
        validate_recent_entry_path(&entry_path)?;
        Ok(Self {
            kind: WorkspaceKind::Folder,
            target_path,
            label,
            entry_path,
            opened_at,
        })
    }

    pub fn for_file(
        file_path: impl Into<PathBuf>,
        opened_at: Timestamp,
    ) -> Result<Self, RecentStoreError> {
        let target_path = file_path.into();
        let file_name = extract_display_label(&target_path)?;
        let rel = RelativePath::parse(&file_name).map_err(|_| {
            RecentStoreError::new(
                RecentErrorCode::InvalidTarget,
                "recent file target must have a valid relative filename",
            )
        })?;
        let entry_path = Some(rel);
        validate_recent_entry_path(&entry_path)?;
        Ok(Self {
            kind: WorkspaceKind::File,
            target_path,
            label: file_name,
            entry_path,
            opened_at,
        })
    }
}

/// Host-only resolved recent target returned when opening an entry by ID.
#[derive(Clone, Debug)]
pub struct ResolvedRecentTarget {
    pub document: RecentDocument,
    pub kind: WorkspaceKind,
    capability: TrustedWorkspaceCapability,
}

impl ResolvedRecentTarget {
    /// Handle-bound target for the trusted workspace opener. The caller must
    /// derive its owner from the trusted webview and must not substitute a
    /// renderer-provided absolute path.
    pub fn capability(&self) -> &TrustedWorkspaceCapability {
        &self.capability
    }
}

impl PartialEq for ResolvedRecentTarget {
    fn eq(&self, other: &Self) -> bool {
        self.document == other.document
            && self.kind == other.kind
            && self.capability.canonical_path == other.capability.canonical_path
    }
}

impl Eq for ResolvedRecentTarget {}

/// Explicit seam reporting whether recent-history persistence succeeded without
/// undoing an already-succeeded workspace open operation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum HistoryPersistenceStatus {
    Persisted(RecentDocument),
    Failed {
        code: RecentErrorCode,
        warning: String,
    },
}

impl HistoryPersistenceStatus {
    pub fn is_persisted(&self) -> bool {
        matches!(self, Self::Persisted(_))
    }
}

/// Outcome pairing a completed workspace open value with its recent-history status.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkspaceOpenOutcome<T> {
    pub opened: T,
    pub history: HistoryPersistenceStatus,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredRecentFileV1 {
    version: u32,
    entries: Vec<StoredRecentEntry>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredRecentEntry {
    id: RecentId,
    #[serde(deserialize_with = "deserialize_recent_label")]
    label: String,
    #[serde(deserialize_with = "deserialize_recent_entry")]
    entry_path: Option<RelativePath>,
    opened_at: Timestamp,
    kind: WorkspaceKind,
    #[serde(deserialize_with = "deserialize_canonical_path")]
    canonical_path: String,
}

impl StoredRecentEntry {
    fn to_public_dto(&self) -> RecentDocument {
        RecentDocument {
            id: self.id.clone(),
            label: self.label.clone(),
            entry_path: self.entry_path.clone(),
            opened_at: self.opened_at,
        }
    }
}

fn extract_display_label(path: &Path) -> Result<String, RecentStoreError> {
    let name = path.file_name().and_then(|os| os.to_str()).ok_or_else(|| {
        RecentStoreError::new(
            RecentErrorCode::InvalidTarget,
            "target path is missing a valid UTF-8 display name",
        )
    })?;
    validate_recent_label(name)?;
    Ok(name.to_owned())
}

pub fn validate_recent_label(label: &str) -> Result<(), RecentStoreError> {
    let utf16_len = label.encode_utf16().count();
    if label.is_empty() || utf16_len > MAX_RECENT_TEXT_UTF16 {
        return Err(RecentStoreError::new(
            RecentErrorCode::InvalidTarget,
            "recent.label: invalid text length",
        ));
    }
    if label
        .chars()
        .any(|c| c < ' ' || c == '\u{7f}' || c == '/' || c == '\\')
    {
        return Err(RecentStoreError::new(
            RecentErrorCode::InvalidTarget,
            "recent.label: expected a display name, not a path",
        ));
    }
    Ok(())
}

pub fn validate_recent_entry_path(
    entry_path: &Option<RelativePath>,
) -> Result<(), RecentStoreError> {
    if let Some(path) = entry_path {
        let text = path.as_str();
        if text.encode_utf16().count() > MAX_RECENT_TEXT_UTF16 {
            return Err(RecentStoreError::new(
                RecentErrorCode::InvalidTarget,
                "recent.entryPath: invalid text length",
            ));
        }
        if text.contains('/') || !text.to_ascii_lowercase().ends_with(".tex") {
            return Err(RecentStoreError::new(
                RecentErrorCode::InvalidTarget,
                "recent.entryPath: expected a single TeX filename",
            ));
        }
    }
    Ok(())
}

fn validate_canonical_path_str(value: &str) -> Result<(), RecentStoreError> {
    let utf16_len = value.encode_utf16().count();
    if value.is_empty()
        || utf16_len > MAX_TEXT_UTF16
        || value.chars().any(|c| c < ' ' || c == '\u{7f}')
    {
        return Err(RecentStoreError::new(
            RecentErrorCode::MalformedSchema,
            "recent.canonicalPath: invalid path text",
        ));
    }
    let is_abs = Path::new(value).is_absolute()
        || value.starts_with(r"\\?\")
        || (value.len() >= 3
            && value.as_bytes()[0].is_ascii_alphabetic()
            && value.as_bytes()[1] == b':'
            && (value.as_bytes()[2] == b'\\' || value.as_bytes()[2] == b'/'));
    if !is_abs {
        return Err(RecentStoreError::new(
            RecentErrorCode::MalformedSchema,
            "recent.canonicalPath: expected an absolute canonical path",
        ));
    }
    Ok(())
}

fn deserialize_recent_label<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<String, D::Error> {
    let value = String::deserialize(deserializer)?;
    validate_recent_label(&value).map_err(D::Error::custom)?;
    Ok(value)
}

fn deserialize_recent_entry<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<RelativePath>, D::Error> {
    let value = Option::<RelativePath>::deserialize(deserializer)?;
    validate_recent_entry_path(&value).map_err(D::Error::custom)?;
    Ok(value)
}

fn deserialize_canonical_path<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<String, D::Error> {
    let value = String::deserialize(deserializer)?;
    validate_canonical_path_str(&value).map_err(D::Error::custom)?;
    Ok(value)
}

/// Produces a normalized Windows case-insensitive canonical identity key.
pub fn canonical_identity_key(raw_canonical: &str) -> String {
    let mut normalized = raw_canonical.replace('/', "\\");
    if let Some(rest) = normalized.strip_prefix(r"\\?\UNC\") {
        normalized = format!(r"\\{rest}");
    } else if let Some(rest) = normalized.strip_prefix(r"\\?\") {
        normalized = rest.to_owned();
    }
    while normalized.len() > 3 && normalized.ends_with('\\') {
        normalized.pop();
    }
    normalized.to_lowercase()
}

pub(crate) fn is_symlink_or_reparse(meta: &fs::Metadata) -> bool {
    if meta.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
        if (meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT) != 0 {
            return true;
        }
    }
    false
}

pub(crate) fn check_path_not_symlink_or_reparse(
    path: &Path,
    stop_at: Option<&Path>,
) -> Result<(), RecentStoreError> {
    let temp_root = env::temp_dir();
    let mut current = Some(path);
    while let Some(candidate) = current {
        if candidate == temp_root {
            break;
        }
        match fs::symlink_metadata(candidate) {
            Ok(meta) => {
                if is_symlink_or_reparse(&meta) {
                    return Err(RecentStoreError::new(
                        RecentErrorCode::LinkNotAllowed,
                        format!("symlink or reparse point rejected: {}", candidate.display()),
                    ));
                }
            }
            Err(err) if err.kind() == io::ErrorKind::NotFound => {}
            Err(err) => {
                return Err(RecentStoreError::new(
                    RecentErrorCode::IoFailed,
                    format!(
                        "failed to inspect metadata for {}: {err}",
                        candidate.display()
                    ),
                ));
            }
        }
        if let Some(boundary) = stop_at {
            if candidate == boundary {
                break;
            }
        }
        current = candidate.parent();
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct FileIdentity {
    volume: u64,
    index: u64,
}

#[cfg(windows)]
#[repr(C)]
#[derive(Clone, Copy, Default)]
struct Filetime {
    _low_date_time: u32,
    _high_date_time: u32,
}

/// Shared `BY_HANDLE_FILE_INFORMATION` ABI layout for native handle identity
/// checks in this module and `watch_native`.
#[cfg(windows)]
#[repr(C)]
#[derive(Clone, Copy, Default)]
pub(crate) struct ByHandleFileInformation {
    pub(crate) file_attributes: u32,
    _creation_time: Filetime,
    _last_access_time: Filetime,
    _last_write_time: Filetime,
    pub(crate) volume_serial_number: u32,
    _file_size_high: u32,
    _file_size_low: u32,
    _number_of_links: u32,
    pub(crate) file_index_high: u32,
    pub(crate) file_index_low: u32,
}

#[cfg(windows)]
#[link(name = "kernel32")]
extern "system" {
    pub(crate) fn GetFileInformationByHandle(
        file: *mut std::ffi::c_void,
        information: *mut ByHandleFileInformation,
    ) -> i32;
}

#[cfg(windows)]
fn file_identity(file: &File) -> io::Result<FileIdentity> {
    use std::{mem::MaybeUninit, os::windows::io::AsRawHandle};

    let mut information = MaybeUninit::<ByHandleFileInformation>::uninit();
    // The handle is an owned File opened by this module with no-follow flags.
    let succeeded =
        unsafe { GetFileInformationByHandle(file.as_raw_handle(), information.as_mut_ptr()) };
    if succeeded == 0 {
        return Err(io::Error::last_os_error());
    }
    let information = unsafe { information.assume_init() };
    Ok(FileIdentity {
        volume: u64::from(information.volume_serial_number),
        index: (u64::from(information.file_index_high) << 32)
            | u64::from(information.file_index_low),
    })
}

#[cfg(unix)]
fn file_identity(file: &File) -> io::Result<FileIdentity> {
    use std::os::unix::fs::MetadataExt;
    let meta = file.metadata()?;
    Ok(FileIdentity {
        volume: meta.dev(),
        index: meta.ino(),
    })
}

#[cfg(not(any(windows, unix)))]
fn file_identity(_file: &File) -> io::Result<FileIdentity> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "stable handle identity unavailable",
    ))
}

fn handle_identity(
    file: &File,
    expect_directory: bool,
    description: &str,
) -> Result<FileIdentity, RecentStoreError> {
    let meta = file.metadata().map_err(|error| {
        RecentStoreError::new(
            RecentErrorCode::IoFailed,
            format!("failed to inspect {description} handle: {error}"),
        )
    })?;
    if is_symlink_or_reparse(&meta) {
        return Err(RecentStoreError::new(
            RecentErrorCode::LinkNotAllowed,
            format!("{description} handle is a symlink or reparse point"),
        ));
    }
    if meta.is_dir() != expect_directory || (!expect_directory && !meta.is_file()) {
        return Err(RecentStoreError::new(
            RecentErrorCode::InvalidTarget,
            format!("{description} handle has the wrong file kind"),
        ));
    }
    file_identity(file).map_err(|error| {
        RecentStoreError::new(
            RecentErrorCode::IoFailed,
            format!("failed to obtain stable {description} handle identity: {error}"),
        )
    })
}

fn target_path_error(path: &Path, error: io::Error) -> RecentStoreError {
    if matches!(fs::symlink_metadata(path), Ok(meta) if is_symlink_or_reparse(&meta)) {
        return RecentStoreError::new(
            RecentErrorCode::LinkNotAllowed,
            format!("symlink or reparse point rejected: {}", path.display()),
        );
    }
    let code = if error.kind() == io::ErrorKind::NotFound {
        RecentErrorCode::TargetMissing
    } else {
        RecentErrorCode::IoFailed
    };
    RecentStoreError::new(
        code,
        format!(
            "failed to open {} without following links: {error}",
            path.display()
        ),
    )
}

#[cfg(windows)]
fn open_file_no_follow(path: &Path) -> io::Result<File> {
    use std::os::windows::fs::OpenOptionsExt;
    const FILE_SHARE_READ: u32 = 0x0000_0001;
    const FILE_SHARE_WRITE: u32 = 0x0000_0002;
    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    let mut options = OpenOptions::new();
    options
        .read(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    options.open(path)
}

#[cfg(unix)]
fn unix_nofollow_flags(directory: bool) -> Option<i32> {
    #[cfg(any(target_os = "linux", target_os = "android"))]
    {
        return Some(if directory {
            0x0002_0000 | 0x0001_0000 // O_NOFOLLOW | O_DIRECTORY
        } else {
            0x0002_0000 // O_NOFOLLOW
        });
    }
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        return Some(if directory {
            0x0000_0100 | 0x0010_0000 // O_NOFOLLOW | O_DIRECTORY
        } else {
            0x0000_0100 // O_NOFOLLOW
        });
    }
    #[cfg(not(any(
        target_os = "linux",
        target_os = "android",
        target_os = "macos",
        target_os = "ios"
    )))]
    {
        let _ = directory;
        None
    }
}

#[cfg(unix)]
fn open_file_no_follow(path: &Path) -> io::Result<File> {
    use std::os::unix::fs::OpenOptionsExt;
    let flags = unix_nofollow_flags(false)
        .ok_or_else(|| io::Error::new(io::ErrorKind::Unsupported, "no-follow open unavailable"))?;
    let mut options = OpenOptions::new();
    options.read(true).custom_flags(flags);
    options.open(path)
}

#[cfg(not(any(windows, unix)))]
fn open_file_no_follow(_path: &Path) -> io::Result<File> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "no-follow open unavailable",
    ))
}

#[cfg(windows)]
fn open_directory_no_follow(path: &Path) -> io::Result<File> {
    use std::os::windows::fs::OpenOptionsExt;
    const FILE_SHARE_READ: u32 = 0x0000_0001;
    const FILE_SHARE_WRITE: u32 = 0x0000_0002;
    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
    let mut options = OpenOptions::new();
    options
        .read(true)
        // Omitting FILE_SHARE_DELETE pins every walked directory against
        // rename/replacement until the trusted capability is dropped.
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS);
    options.open(path)
}

#[cfg(unix)]
fn open_directory_no_follow(path: &Path) -> io::Result<File> {
    use std::os::unix::fs::OpenOptionsExt;
    let flags = unix_nofollow_flags(true)
        .ok_or_else(|| io::Error::new(io::ErrorKind::Unsupported, "no-follow open unavailable"))?;
    let mut options = OpenOptions::new();
    options.read(true).custom_flags(flags);
    options.open(path)
}

#[cfg(not(any(windows, unix)))]
fn open_directory_no_follow(_path: &Path) -> io::Result<File> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "no-follow directory open unavailable",
    ))
}

#[derive(Debug)]
struct PinnedDirectory {
    path: PathBuf,
    handles: Vec<File>,
    identity: FileIdentity,
}

impl PinnedDirectory {
    fn handle(&self) -> &File {
        self.handles
            .last()
            .expect("pinned directory has a root handle")
    }
}

fn absolute_path(path: &Path) -> Result<PathBuf, RecentStoreError> {
    if path.is_absolute() {
        return Ok(path.to_path_buf());
    }
    env::current_dir()
        .map(|cwd| cwd.join(path))
        .map_err(|error| {
            RecentStoreError::new(
                RecentErrorCode::IoFailed,
                format!("failed to resolve current directory: {error}"),
            )
        })
}

fn open_directory_component(path: &Path) -> Result<File, RecentStoreError> {
    let file = open_directory_no_follow(path).map_err(|error| target_path_error(path, error))?;
    handle_identity(&file, true, "opened directory")?;
    Ok(file)
}

/// Opens every path component without following links. On Windows the opened
/// directory handles also deny delete sharing, pinning the walked path.
fn open_pinned_directory(path: &Path) -> Result<PinnedDirectory, RecentStoreError> {
    let absolute = absolute_path(path)?;
    let mut current = PathBuf::new();
    let mut handles = Vec::new();
    for component in absolute.components() {
        match component {
            Component::Prefix(prefix) => current.push(prefix.as_os_str()),
            Component::RootDir => {
                current.push(component.as_os_str());
                handles.push(open_directory_component(&current)?);
            }
            Component::CurDir => {}
            Component::ParentDir => {
                if handles.len() <= 1 || !current.pop() {
                    return Err(RecentStoreError::new(
                        RecentErrorCode::InvalidTarget,
                        "workspace path escapes its filesystem root",
                    ));
                }
                handles.pop();
            }
            Component::Normal(name) => {
                current.push(name);
                handles.push(open_directory_component(&current)?);
            }
        }
    }
    let handle = handles.last().ok_or_else(|| {
        RecentStoreError::new(
            RecentErrorCode::InvalidTarget,
            "expected an absolute directory path",
        )
    })?;
    let identity = handle_identity(handle, true, "pinned directory")?;
    Ok(PinnedDirectory {
        path: current,
        handles,
        identity,
    })
}

fn verify_handle_identity(
    file: &File,
    expected: FileIdentity,
    expect_directory: bool,
) -> Result<(), RecentStoreError> {
    if handle_identity(file, expect_directory, "pinned target")? != expected {
        return Err(RecentStoreError::new(
            RecentErrorCode::LinkNotAllowed,
            "pinned target handle identity or kind changed",
        ));
    }
    Ok(())
}

/// Handle-bound proof passed to the workspace opener. Its fields are private:
/// only `TrustedFilesystemOpener` constructs it, using no-follow opens and
/// identities captured before and after opening. Metadata from an arbitrary
/// already-followed handle is not accepted as proof.
#[derive(Clone)]
pub struct TrustedWorkspaceCapability {
    kind: WorkspaceKind,
    root: Arc<PinnedDirectory>,
    target: Arc<File>,
    entry: Option<Arc<File>>,
    target_identity: FileIdentity,
    entry_identity: Option<FileIdentity>,
    canonical_path: PathBuf,
}

impl fmt::Debug for TrustedWorkspaceCapability {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("TrustedWorkspaceCapability")
            .field("kind", &self.kind)
            .field("target_identity", &self.target_identity)
            .field("has_entry", &self.entry.is_some())
            .finish()
    }
}

impl TrustedWorkspaceCapability {
    pub fn root_handle(&self) -> &File {
        self.root.handle()
    }

    pub fn target_handle(&self) -> &File {
        &self.target
    }

    pub fn entry_handle(&self) -> Option<&File> {
        self.entry.as_deref()
    }

    /// Rechecks the identities pinned by the trusted no-follow constructor
    /// before handing the capability to a workspace opener.
    pub fn validate_for_workspace_open(&self) -> Result<(), RecentStoreError> {
        verify_handle_identity(self.root.handle(), self.root.identity, true)?;
        verify_handle_identity(
            &self.target,
            self.target_identity,
            self.kind == WorkspaceKind::Folder,
        )?;
        if let (Some(entry), Some(identity)) = (&self.entry, self.entry_identity) {
            verify_handle_identity(entry, identity, false)?;
        } else if self.entry.is_some() || self.entry_identity.is_some() {
            return Err(RecentStoreError::new(
                RecentErrorCode::InvalidTarget,
                "incomplete pinned entry capability",
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Copy)]
struct TargetPreflight {
    target: FileIdentity,
    entry: Option<FileIdentity>,
}

struct TrustedFilesystemOpener;

impl TrustedFilesystemOpener {
    fn open_target(
        target_path: &Path,
        kind: WorkspaceKind,
        entry_path: &Option<RelativePath>,
    ) -> Result<TrustedWorkspaceCapability, RecentStoreError> {
        Self::open_target_with_hook(target_path, kind, entry_path, || {})
    }

    fn open_target_with_hook<F>(
        target_path: &Path,
        kind: WorkspaceKind,
        entry_path: &Option<RelativePath>,
        before_open: F,
    ) -> Result<TrustedWorkspaceCapability, RecentStoreError>
    where
        F: FnOnce(),
    {
        validate_recent_entry_path(entry_path)?;
        check_path_not_symlink_or_reparse(target_path, None)?;
        let target_meta = fs::symlink_metadata(target_path)
            .map_err(|error| target_path_error(target_path, error))?;
        if is_symlink_or_reparse(&target_meta) {
            return Err(RecentStoreError::new(
                RecentErrorCode::LinkNotAllowed,
                "workspace target must not be a symlink or reparse point",
            ));
        }
        match kind {
            WorkspaceKind::Folder if !target_meta.is_dir() => {
                return Err(RecentStoreError::new(
                    RecentErrorCode::InvalidTarget,
                    "expected a directory for folder workspace target",
                ));
            }
            WorkspaceKind::File if !target_meta.is_file() => {
                return Err(RecentStoreError::new(
                    RecentErrorCode::InvalidTarget,
                    "expected a regular file for file workspace target",
                ));
            }
            _ => {}
        }
        let target_identity = match kind {
            WorkspaceKind::Folder => open_pinned_directory(target_path)?.identity,
            WorkspaceKind::File => {
                let absolute = absolute_path(target_path)?;
                let name = absolute.file_name().ok_or_else(|| {
                    RecentStoreError::new(
                        RecentErrorCode::InvalidTarget,
                        "file workspace target has no filename",
                    )
                })?;
                let parent = absolute.parent().ok_or_else(|| {
                    RecentStoreError::new(
                        RecentErrorCode::InvalidTarget,
                        "file workspace target has no parent directory",
                    )
                })?;
                let root = open_pinned_directory(parent)?;
                let path = root.path.join(name);
                let file =
                    open_file_no_follow(&path).map_err(|error| target_path_error(&path, error))?;
                handle_identity(&file, false, "workspace file")?
            }
        };
        let entry_identity = match (kind, entry_path) {
            (WorkspaceKind::Folder, Some(entry)) => {
                let entry_full = target_path.join(entry.as_str());
                check_path_not_symlink_or_reparse(&entry_full, Some(target_path))?;
                let root = open_pinned_directory(target_path)?;
                let path = root.path.join(entry.as_str());
                let file =
                    open_file_no_follow(&path).map_err(|error| target_path_error(&path, error))?;
                Some(handle_identity(&file, false, "folder entry")?)
            }
            (WorkspaceKind::File, Some(entry))
                if target_path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| {
                        #[cfg(windows)]
                        {
                            name.eq_ignore_ascii_case(entry.as_str())
                        }
                        #[cfg(not(windows))]
                        {
                            name == entry.as_str()
                        }
                    }) =>
            {
                Some(target_identity)
            }
            (WorkspaceKind::File, _) => {
                return Err(RecentStoreError::new(
                    RecentErrorCode::InvalidTarget,
                    "file workspace target requires its matching entryPath",
                ));
            }
            (WorkspaceKind::Folder, None) => None,
        };
        let preflight = TargetPreflight {
            target: target_identity,
            entry: entry_identity,
        };

        // Tests use this boundary to deterministically replace a checked path.
        // Security comes from the no-follow opens and identity comparisons below.
        before_open();

        let (root, target, entry, target_identity, canonical_path) = match kind {
            WorkspaceKind::Folder => {
                let root = Arc::new(open_pinned_directory(target_path)?);
                if root.identity != preflight.target {
                    return Err(RecentStoreError::new(
                        RecentErrorCode::LinkNotAllowed,
                        "workspace root identity changed before open",
                    ));
                }
                let target = Arc::new(root.handle().try_clone().map_err(|error| {
                    RecentStoreError::new(
                        RecentErrorCode::IoFailed,
                        format!("failed to pin workspace root handle: {error}"),
                    )
                })?);
                let entry = match entry_path {
                    Some(entry) => {
                        let path = root.path.join(entry.as_str());
                        let file = open_file_no_follow(&path)
                            .map_err(|error| target_path_error(&path, error))?;
                        let identity = handle_identity(&file, false, "folder entry")?;
                        if Some(identity) != preflight.entry {
                            return Err(RecentStoreError::new(
                                RecentErrorCode::LinkNotAllowed,
                                "folder entry identity changed before no-follow open",
                            ));
                        }
                        Some(Arc::new(file))
                    }
                    None => None,
                };
                (
                    root.clone(),
                    target,
                    entry,
                    preflight.target,
                    root.path.clone(),
                )
            }
            WorkspaceKind::File => {
                let absolute = absolute_path(target_path)?;
                let name = absolute.file_name().ok_or_else(|| {
                    RecentStoreError::new(
                        RecentErrorCode::InvalidTarget,
                        "file workspace target has no filename",
                    )
                })?;
                let parent = absolute.parent().ok_or_else(|| {
                    RecentStoreError::new(
                        RecentErrorCode::InvalidTarget,
                        "file workspace target has no parent directory",
                    )
                })?;
                let root = Arc::new(open_pinned_directory(parent)?);
                let path = root.path.join(name);
                let file =
                    open_file_no_follow(&path).map_err(|error| target_path_error(&path, error))?;
                let identity = handle_identity(&file, false, "workspace file")?;
                if identity != preflight.target {
                    return Err(RecentStoreError::new(
                        RecentErrorCode::LinkNotAllowed,
                        "workspace file identity changed before no-follow open",
                    ));
                }
                let file = Arc::new(file);
                (root, file.clone(), Some(file), preflight.target, path)
            }
        };

        let capability = TrustedWorkspaceCapability {
            kind,
            root,
            target,
            entry,
            target_identity,
            entry_identity: preflight.entry,
            canonical_path,
        };
        capability.validate_for_workspace_open()?;
        Ok(capability)
    }
}

pub(crate) fn is_retryable_rename_error(err: &io::Error) -> bool {
    if err.kind() == io::ErrorKind::PermissionDenied {
        return true;
    }
    matches!(err.raw_os_error(), Some(5 | 32 | 33))
}

pub(crate) fn ensure_store_dir_ready(data_dir: &Path) -> Result<(), RecentStoreError> {
    check_path_not_symlink_or_reparse(data_dir, None)?;
    match fs::symlink_metadata(data_dir) {
        Ok(meta) => {
            if is_symlink_or_reparse(&meta) {
                return Err(RecentStoreError::new(
                    RecentErrorCode::LinkNotAllowed,
                    "store directory must not be a symlink or reparse point",
                ));
            }
            if !meta.is_dir() {
                return Err(RecentStoreError::new(
                    RecentErrorCode::PersistenceFailed,
                    "store data path exists but is not a directory",
                ));
            }
        }
        Err(err) if err.kind() == io::ErrorKind::NotFound => {
            fs::create_dir_all(data_dir).map_err(|create_err| {
                RecentStoreError::new(
                    RecentErrorCode::PersistenceFailed,
                    format!("failed to create store directory: {create_err}"),
                )
            })?;
            check_path_not_symlink_or_reparse(data_dir, None)?;
            let meta = fs::symlink_metadata(data_dir).map_err(|stat_err| {
                RecentStoreError::new(
                    RecentErrorCode::PersistenceFailed,
                    format!("failed to verify store directory: {stat_err}"),
                )
            })?;
            if is_symlink_or_reparse(&meta) || !meta.is_dir() {
                return Err(RecentStoreError::new(
                    RecentErrorCode::LinkNotAllowed,
                    "created store directory resolved to symlink/reparse or non-directory",
                ));
            }
        }
        Err(err) => {
            return Err(RecentStoreError::new(
                RecentErrorCode::IoFailed,
                format!("failed to inspect store directory: {err}"),
            ));
        }
    }
    let _ = open_pinned_directory(data_dir)?;
    Ok(())
}

pub(crate) fn validate_existing_store_target(
    store_path: &Path,
    data_dir: &Path,
) -> Result<Option<fs::Metadata>, RecentStoreError> {
    check_path_not_symlink_or_reparse(store_path, Some(data_dir))?;
    match fs::symlink_metadata(store_path) {
        Ok(meta) => {
            if is_symlink_or_reparse(&meta) {
                return Err(RecentStoreError::new(
                    RecentErrorCode::LinkNotAllowed,
                    "store file target must not be a symlink or reparse point",
                ));
            }
            if !meta.is_file() {
                return Err(RecentStoreError::new(
                    RecentErrorCode::PersistenceFailed,
                    "store file target exists and is not a regular file",
                ));
            }
            Ok(Some(meta))
        }
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(RecentStoreError::new(
            RecentErrorCode::IoFailed,
            format!("failed to inspect store file target: {err}"),
        )),
    }
}

pub(crate) fn bounded_read_store_bytes(
    store_path: &Path,
    data_dir: &Path,
    max_bytes: u64,
) -> Result<Option<Vec<u8>>, RecentStoreError> {
    bounded_read_store_bytes_with_opener(store_path, data_dir, max_bytes, open_file_no_follow)
}

fn bounded_read_store_bytes_with_opener<F>(
    store_path: &Path,
    data_dir: &Path,
    max_bytes: u64,
    open_file: F,
) -> Result<Option<Vec<u8>>, RecentStoreError>
where
    F: FnOnce(&Path) -> io::Result<File>,
{
    check_path_not_symlink_or_reparse(data_dir, None)?;
    match fs::symlink_metadata(data_dir) {
        Ok(dir_meta) => {
            if is_symlink_or_reparse(&dir_meta) {
                return Err(RecentStoreError::new(
                    RecentErrorCode::LinkNotAllowed,
                    "store directory must not be a symlink or reparse point",
                ));
            }
            if !dir_meta.is_dir() {
                return Err(RecentStoreError::new(
                    RecentErrorCode::PersistenceFailed,
                    "store data path exists but is not a directory",
                ));
            }
        }
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(err) => {
            return Err(RecentStoreError::new(
                RecentErrorCode::IoFailed,
                format!("failed to inspect store directory: {err}"),
            ));
        }
    }
    let _pinned_data_dir = open_pinned_directory(data_dir)?;
    let Some(meta) = validate_existing_store_target(store_path, data_dir)? else {
        return Ok(None);
    };
    if meta.len() > max_bytes {
        return Err(RecentStoreError::new(
            RecentErrorCode::OversizeStore,
            format!("store file length {} exceeds limit {max_bytes}", meta.len()),
        ));
    }
    let preflight_file = match open_file_no_follow(store_path) {
        Ok(file) => file,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(target_path_error(store_path, err)),
    };
    let preflight_identity = handle_identity(&preflight_file, false, "store file")?;
    drop(preflight_file);
    let file = match open_file(store_path) {
        Ok(file) => file,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(target_path_error(store_path, err)),
    };
    let opened_identity = handle_identity(&file, false, "opened store file")?;
    if opened_identity != preflight_identity {
        return Err(RecentStoreError::new(
            RecentErrorCode::LinkNotAllowed,
            "store file identity changed between path inspection and no-follow open",
        ));
    }
    let path_file =
        open_file_no_follow(store_path).map_err(|error| target_path_error(store_path, error))?;
    if handle_identity(&path_file, false, "store path")? != opened_identity {
        return Err(RecentStoreError::new(
            RecentErrorCode::LinkNotAllowed,
            "store path no longer identifies the opened regular file",
        ));
    }
    let handle_meta = file.metadata().map_err(|err| {
        RecentStoreError::new(
            RecentErrorCode::IoFailed,
            format!("failed to stat open store file: {err}"),
        )
    })?;
    if handle_meta.len() > max_bytes {
        return Err(RecentStoreError::new(
            RecentErrorCode::OversizeStore,
            format!(
                "open store file length {} exceeds limit {max_bytes}",
                handle_meta.len()
            ),
        ));
    }
    let capacity = (handle_meta.len() as usize).min(max_bytes as usize);
    let mut bytes = Vec::with_capacity(capacity);
    file.take(max_bytes + 1)
        .read_to_end(&mut bytes)
        .map_err(|err| {
            RecentStoreError::new(
                RecentErrorCode::IoFailed,
                format!("failed reading store bytes: {err}"),
            )
        })?;
    if (bytes.len() as u64) > max_bytes {
        return Err(RecentStoreError::new(
            RecentErrorCode::OversizeStore,
            "store stream exceeded maximum byte bound during read",
        ));
    }
    Ok(Some(bytes))
}

fn create_exclusive_temp_file(
    data_dir: &Path,
    store_filename: &str,
) -> Result<(File, PathBuf), RecentStoreError> {
    let pid = std::process::id();
    for _ in 0..16 {
        let seq = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let unique = Uuid::new_v4();
        let temp_name = format!(".{store_filename}.tmp-{pid}-{seq}-{unique}");
        let temp_path = data_dir.join(temp_name);
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp_path)
        {
            Ok(file) => return Ok((file, temp_path)),
            Err(err) if err.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(err) => {
                return Err(RecentStoreError::new(
                    RecentErrorCode::PersistenceFailed,
                    format!("failed to create exclusive temp file: {err}"),
                ));
            }
        }
    }
    Err(RecentStoreError::new(
        RecentErrorCode::PersistenceFailed,
        "exhausted attempts to allocate non-colliding temporary store file",
    ))
}

pub(crate) fn atomic_write_store_bytes<F>(
    data_dir: &Path,
    store_filename: &str,
    bytes: &[u8],
    mut rename_op: F,
) -> Result<(), RecentStoreError>
where
    F: FnMut(&Path, &Path) -> io::Result<()>,
{
    ensure_store_dir_ready(data_dir)?;
    let _pinned_data_dir = open_pinned_directory(data_dir)?;
    let store_path = data_dir.join(store_filename);
    let _ = validate_existing_store_target(&store_path, data_dir)?;

    let (mut temp_file, temp_path) = create_exclusive_temp_file(data_dir, store_filename)?;
    let write_res = (|| -> io::Result<()> {
        temp_file.write_all(bytes)?;
        temp_file.flush()?;
        temp_file.sync_all()?;
        Ok(())
    })();
    drop(temp_file);

    if let Err(err) = write_res {
        let _ = fs::remove_file(&temp_path);
        return Err(RecentStoreError::new(
            RecentErrorCode::PersistenceFailed,
            format!("failed to write and flush temporary store file: {err}"),
        ));
    }

    let mut spent_backoff_ms = 0u64;
    let mut last_err: Option<io::Error> = None;

    for attempt in 1..=RENAME_MAX_ATTEMPTS {
        if let Err(target_err) = validate_existing_store_target(&store_path, data_dir) {
            let _ = fs::remove_file(&temp_path);
            return Err(target_err);
        }
        match rename_op(&temp_path, &store_path) {
            Ok(()) => return Ok(()),
            Err(err) => {
                let retryable = is_retryable_rename_error(&err);
                last_err = Some(err);
                if !retryable || attempt == RENAME_MAX_ATTEMPTS {
                    break;
                }
                let remaining = RENAME_MAX_BACKOFF_MS.saturating_sub(spent_backoff_ms);
                if remaining == 0 {
                    break;
                }
                let step_ms = ((attempt as u64) * RENAME_RETRY_STEP_MS).min(remaining);
                spent_backoff_ms = spent_backoff_ms.saturating_add(step_ms);
                thread::sleep(Duration::from_millis(step_ms));
            }
        }
    }

    let _ = fs::remove_file(&temp_path);
    let msg = last_err
        .map(|e| e.to_string())
        .unwrap_or_else(|| "unknown rename failure".to_owned());
    Err(RecentStoreError::new(
        RecentErrorCode::PersistenceFailed,
        format!("atomic replace failed after bounded retries: {msg}"),
    ))
}

/// Host-owned persistent store for `frontend-recent-v1.json`.
#[derive(Clone, Debug)]
pub struct RecentStore {
    data_dir: PathBuf,
}

impl RecentStore {
    pub fn new(data_dir: impl Into<PathBuf>) -> Self {
        Self {
            data_dir: data_dir.into(),
        }
    }

    pub fn with_default_data_dir() -> Result<Self, RecentStoreError> {
        Ok(Self::new(resolve_host_data_dir()?))
    }

    pub fn data_dir(&self) -> &Path {
        &self.data_dir
    }

    pub fn store_path(&self) -> PathBuf {
        self.data_dir.join(RECENT_STORE_FILENAME)
    }

    /// Lists the public `RecentDocument` DTOs in MRU order without pruning
    /// nonexistent paths so the UI can report or retry missing targets.
    pub fn list_recent(&self) -> Result<Vec<RecentDocument>, RecentStoreError> {
        let store_path = self.store_path();
        let lock = acquire_store_lock(&store_path);
        let _guard = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let entries = self.load_entries_locked()?;
        Ok(entries
            .iter()
            .map(StoredRecentEntry::to_public_dto)
            .collect())
    }

    /// Records an opened workspace target into `frontend-recent-v1.json`, reusing
    /// the existing UUIDv4 `RecentId` when the canonical Windows case-insensitive
    /// path already exists and capping the MRU list at 20 entries.
    pub fn record_opened(
        &self,
        target: TrustedRecentTarget,
    ) -> Result<RecentDocument, RecentStoreError> {
        self.record_opened_with_renamer(target, |from, to| fs::rename(from, to))
    }

    fn record_opened_with_renamer<F>(
        &self,
        target: TrustedRecentTarget,
        rename_op: F,
    ) -> Result<RecentDocument, RecentStoreError>
    where
        F: FnMut(&Path, &Path) -> io::Result<()>,
    {
        validate_recent_label(&target.label)?;
        validate_recent_entry_path(&target.entry_path)?;
        let capability = TrustedFilesystemOpener::open_target(
            &target.target_path,
            target.kind,
            &target.entry_path,
        )?;
        let canonical_buf = capability.canonical_path.clone();
        let canonical_str = canonical_buf.to_string_lossy().into_owned();
        validate_canonical_path_str(&canonical_str)?;
        let target_key = canonical_identity_key(&canonical_str);

        let store_path = self.store_path();
        let lock = acquire_store_lock(&store_path);
        let _guard = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());

        let existing_entries = self.load_entries_locked()?;
        let mut existing_id: Option<RecentId> = None;
        let mut used_ids = HashSet::new();
        let mut retained = Vec::with_capacity(existing_entries.len().min(MAX_RECENT_DOCUMENTS));

        for entry in existing_entries {
            if canonical_identity_key(&entry.canonical_path) == target_key {
                if existing_id.is_none() {
                    existing_id = Some(entry.id);
                }
            } else {
                used_ids.insert(entry.id.as_str().to_owned());
                retained.push(entry);
            }
        }

        let id = match existing_id {
            Some(id) => id,
            None => generate_unique_recent_id(&used_ids)?,
        };

        let new_entry = StoredRecentEntry {
            id,
            label: target.label,
            entry_path: target.entry_path,
            opened_at: target.opened_at,
            kind: target.kind,
            canonical_path: canonical_str,
        };
        let dto = new_entry.to_public_dto();

        let mut updated = Vec::with_capacity((retained.len() + 1).min(MAX_RECENT_DOCUMENTS));
        updated.push(new_entry);
        for entry in retained {
            if updated.len() >= MAX_RECENT_DOCUMENTS {
                break;
            }
            updated.push(entry);
        }

        self.save_entries_locked(&updated, rename_op)?;
        Ok(dto)
    }

    /// Admits an already-opened trusted workspace selection and records its
    /// recent-document history without failing or undoing the open operation if
    /// history persistence fails.
    pub fn admit_opened_workspace(
        &self,
        selection: TrustedWorkspaceSelection,
    ) -> WorkspaceOpenOutcome<WorkspaceInfo> {
        let target = TrustedRecentTarget::from_selection(&selection);
        let history = match self.record_opened(target) {
            Ok(doc) => HistoryPersistenceStatus::Persisted(doc),
            Err(err) => HistoryPersistenceStatus::Failed {
                code: err.code(),
                warning: err.message().to_owned(),
            },
        };
        WorkspaceOpenOutcome {
            opened: selection.workspace,
            history,
        }
    }

    /// Resolves a recent-document entry by ID for opening, retaining the entry
    /// if the target path is missing on disk so the UI can report/retry, and
    /// keeping the open outcome independent of history persistence failures.
    pub fn resolve_recent_for_open(
        &self,
        id: &str,
        opened_at: Timestamp,
    ) -> Result<WorkspaceOpenOutcome<ResolvedRecentTarget>, RecentStoreError> {
        self.open_recent_with(id, opened_at, |resolved| Ok(resolved.clone()))
    }

    /// Resolves a recent entry by `id`, invokes the caller's workspace opener
    /// once the target is verified on disk, and then updates MRU order and
    /// `openedAt` without undoing the open result if history persistence fails.
    pub fn open_recent_with<T, F>(
        &self,
        id: &str,
        opened_at: Timestamp,
        opener: F,
    ) -> Result<WorkspaceOpenOutcome<T>, RecentStoreError>
    where
        F: FnOnce(&ResolvedRecentTarget) -> Result<T, RecentStoreError>,
    {
        let parsed_id = RecentId::parse(id)
            .map_err(|err| RecentStoreError::new(RecentErrorCode::InvalidId, err.to_string()))?;

        let stored_entry = {
            let store_path = self.store_path();
            let lock = acquire_store_lock(&store_path);
            let _guard = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            let entries = self.load_entries_locked()?;
            entries
                .into_iter()
                .find(|entry| entry.id == parsed_id)
                .ok_or_else(|| {
                    RecentStoreError::new(
                        RecentErrorCode::NotFound,
                        format!("recent document ID not found: {}", parsed_id.as_str()),
                    )
                })?
        };

        // Validate target existence and reject symlinks/reparse points without pruning history.
        let target_path = PathBuf::from(&stored_entry.canonical_path);
        let capability = TrustedFilesystemOpener::open_target(
            &target_path,
            stored_entry.kind,
            &stored_entry.entry_path,
        )?;
        let canonical_buf = capability.canonical_path.clone();

        let updated_doc = RecentDocument {
            id: stored_entry.id.clone(),
            label: stored_entry.label.clone(),
            entry_path: stored_entry.entry_path.clone(),
            opened_at,
        };
        let resolved = ResolvedRecentTarget {
            document: updated_doc,
            kind: stored_entry.kind,
            capability,
        };

        let opened = opener(&resolved)?;

        let touch_target = TrustedRecentTarget {
            kind: stored_entry.kind,
            target_path: canonical_buf,
            label: stored_entry.label,
            entry_path: stored_entry.entry_path,
            opened_at,
        };
        let history = match self.record_opened(touch_target) {
            Ok(doc) => HistoryPersistenceStatus::Persisted(doc),
            Err(err) => HistoryPersistenceStatus::Failed {
                code: err.code(),
                warning: err.message().to_owned(),
            },
        };

        Ok(WorkspaceOpenOutcome { opened, history })
    }

    /// Removes a recent entry from history by UUIDv4 `id` without deleting or
    /// modifying the underlying workspace or document on disk.
    pub fn remove_recent(&self, id: &str) -> Result<bool, RecentStoreError> {
        let parsed_id = RecentId::parse(id)
            .map_err(|err| RecentStoreError::new(RecentErrorCode::InvalidId, err.to_string()))?;
        let store_path = self.store_path();
        let lock = acquire_store_lock(&store_path);
        let _guard = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());

        let mut entries = self.load_entries_locked()?;
        let before = entries.len();
        entries.retain(|entry| entry.id != parsed_id);
        let removed = entries.len() != before;
        if removed {
            self.save_entries_locked(&entries, |from, to| fs::rename(from, to))?;
        }
        Ok(removed)
    }

    fn load_entries_locked(&self) -> Result<Vec<StoredRecentEntry>, RecentStoreError> {
        let store_path = self.store_path();
        let Some(bytes) =
            bounded_read_store_bytes(&store_path, &self.data_dir, MAX_RECENT_STORE_BYTES)?
        else {
            return Ok(Vec::new());
        };

        let parsed: StoredRecentFileV1 = serde_json::from_slice(&bytes).map_err(|err| {
            RecentStoreError::new(
                RecentErrorCode::MalformedSchema,
                format!("invalid recent store JSON: {err}"),
            )
        })?;

        if parsed.version != RECENT_SCHEMA_VERSION {
            return Err(RecentStoreError::new(
                RecentErrorCode::MalformedSchema,
                format!("unsupported recent schema version: {}", parsed.version),
            ));
        }
        if parsed.entries.len() > MAX_RECENT_DOCUMENTS {
            return Err(RecentStoreError::new(
                RecentErrorCode::MalformedSchema,
                format!(
                    "recent store contains {} entries, exceeding maximum {}",
                    parsed.entries.len(),
                    MAX_RECENT_DOCUMENTS
                ),
            ));
        }

        let mut seen_ids = HashSet::with_capacity(parsed.entries.len());
        let mut seen_paths = HashSet::with_capacity(parsed.entries.len());
        let mut deduped = Vec::with_capacity(parsed.entries.len());

        for entry in parsed.entries {
            if entry.kind == WorkspaceKind::File && entry.entry_path.is_none() {
                return Err(RecentStoreError::new(
                    RecentErrorCode::MalformedSchema,
                    "file entry in recent store is missing entryPath",
                ));
            }
            if !seen_ids.insert(entry.id.as_str().to_owned()) {
                return Err(RecentStoreError::new(
                    RecentErrorCode::MalformedSchema,
                    "duplicate recent.id in recent store",
                ));
            }
            let key = canonical_identity_key(&entry.canonical_path);
            if seen_paths.insert(key) {
                deduped.push(entry);
            }
        }

        Ok(deduped)
    }

    fn save_entries_locked<F>(
        &self,
        entries: &[StoredRecentEntry],
        rename_op: F,
    ) -> Result<(), RecentStoreError>
    where
        F: FnMut(&Path, &Path) -> io::Result<()>,
    {
        let payload = StoredRecentFileV1 {
            version: RECENT_SCHEMA_VERSION,
            entries: entries.to_vec(),
        };
        let mut bytes = serde_json::to_vec_pretty(&payload).map_err(|err| {
            RecentStoreError::new(
                RecentErrorCode::PersistenceFailed,
                format!("failed to serialize recent store: {err}"),
            )
        })?;
        bytes.push(b'\n');
        if (bytes.len() as u64) > MAX_RECENT_STORE_BYTES {
            return Err(RecentStoreError::new(
                RecentErrorCode::OversizeStore,
                "serialized recent store exceeds maximum byte limit",
            ));
        }
        atomic_write_store_bytes(&self.data_dir, RECENT_STORE_FILENAME, &bytes, rename_op)
    }
}

fn generate_unique_recent_id(used_ids: &HashSet<String>) -> Result<RecentId, RecentStoreError> {
    for _ in 0..16 {
        let candidate = Uuid::new_v4().to_string();
        if !used_ids.contains(&candidate) {
            return RecentId::parse(&candidate)
                .map_err(|err| RecentStoreError::new(RecentErrorCode::InvalidId, err.to_string()));
        }
    }
    Err(RecentStoreError::new(
        RecentErrorCode::PersistenceFailed,
        "unable to generate unique UUIDv4 for recent document",
    ))
}

#[cfg(test)]
#[path = "../../tests/unit/recent.rs"]
mod tests;
