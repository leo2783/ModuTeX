// SPDX-License-Identifier: Apache-2.0
//! Bounded Windows handle substrate (G2): reparse-free root opening, segment-relative
//! `NtCreateFile` traversal, parent handle pinning, bounded directory enumeration,
//! pre-allocation size-checked reads, and crash-safe exclusive revision-checked writes.

use std::{
    ffi::c_void,
    fmt,
    mem::{align_of, offset_of, size_of, zeroed},
    os::windows::ffi::OsStrExt,
    path::Path,
    ptr::{null, null_mut},
    sync::atomic::{AtomicBool, AtomicU64, Ordering},
};

use sha2::{Digest, Sha256};
use windows_sys::{
    Wdk::{
        Foundation::OBJECT_ATTRIBUTES,
        Storage::FileSystem::{
            FileRenameInformation, NtCreateFile, NtSetInformationFile, FILE_CREATE,
            FILE_DIRECTORY_FILE, FILE_NON_DIRECTORY_FILE, FILE_OPEN, FILE_OPEN_FOR_BACKUP_INTENT,
            FILE_OPEN_IF, FILE_OPEN_REPARSE_POINT, FILE_SYNCHRONOUS_IO_NONALERT,
        },
    },
    Win32::{
        Foundation::{
            CloseHandle, GetLastError, ERROR_ACCESS_DENIED, ERROR_ALREADY_EXISTS,
            ERROR_FILE_NOT_FOUND, ERROR_NO_MORE_FILES, ERROR_PATH_NOT_FOUND,
            ERROR_SHARING_VIOLATION, HANDLE, INVALID_HANDLE_VALUE, NTSTATUS, OBJ_CASE_INSENSITIVE,
            STATUS_ACCESS_DENIED, STATUS_FILE_IS_A_DIRECTORY, STATUS_NOT_A_DIRECTORY,
            STATUS_OBJECT_NAME_COLLISION, STATUS_OBJECT_NAME_NOT_FOUND,
            STATUS_OBJECT_PATH_NOT_FOUND, STATUS_SHARING_VIOLATION, STATUS_SUCCESS, UNICODE_STRING,
        },
        Storage::FileSystem::{
            CreateFileW, FileDispositionInfo, FileIdBothDirectoryInfo,
            FileIdBothDirectoryRestartInfo, FlushFileBuffers, GetFileInformationByHandleEx,
            ReadFile, SetFileInformationByHandle, WriteFile, DELETE, FILE_ADD_FILE,
            FILE_ADD_SUBDIRECTORY, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_NORMAL,
            FILE_ATTRIBUTE_REPARSE_POINT, FILE_DISPOSITION_INFO, FILE_FLAG_BACKUP_SEMANTICS,
            FILE_FLAG_OPEN_REPARSE_POINT, FILE_ID_BOTH_DIR_INFO, FILE_LIST_DIRECTORY,
            FILE_READ_ATTRIBUTES, FILE_READ_DATA, FILE_RENAME_INFO, FILE_SHARE_DELETE,
            FILE_SHARE_READ, FILE_SHARE_WRITE, FILE_TRAVERSE, FILE_WRITE_ATTRIBUTES,
            FILE_WRITE_DATA, OPEN_EXISTING, SYNCHRONIZE,
        },
        System::IO::IO_STATUS_BLOCK,
    },
};

use crate::{
    schemas::protocol::{read_limit, FileEntry, FileKind, Revision, MAX_PDF_BYTES, MAX_READ_BYTES},
    shared::relative_path::RelativePath,
};

pub const MAX_LIST_ENTRIES: usize = 4096;
pub const MAX_DIRECTORY_DEPTH: usize = 64;
const DIR_BUFFER_BYTES: usize = 64 * 1024;
const INITIAL_READ_CAP_BYTES: usize = 64 * 1024;
const MAX_READ_CAP_BYTES: usize = 64 * 1024 * 1024;
const MAX_SEGMENT_BYTES: usize = 1024;
const MAX_SEGMENT_UTF16_UNITS: usize = 255;
const STAGE_PREFIX: &str = ".modutex-stage-";
const BACKUP_PREFIX: &str = ".modutex-bak-";
const TXN_PREFIX: &str = ".modutex-txn-";
const DELETE_TRASH_PREFIX: &str = ".modutex-trash-";
const COPY_STAGE_PREFIX: &str = ".modutex-copy-";
const RECYCLE_STAGE_PREFIX: &str = ".modutex-recycle-";
const MAX_COPY_TREE_BYTES: usize = 64 * 1024 * 1024;
static STAGE_COUNTER: AtomicU64 = AtomicU64::new(1);

#[repr(C)]
struct ShFileOpStructW {
    hwnd: *mut c_void,
    w_func: u32,
    p_from: *const u16,
    p_to: *const u16,
    flags: u16,
    any_operations_aborted: i32,
    name_mappings: *mut c_void,
    progress_title: *const u16,
}

#[link(name = "kernel32")]
extern "system" {
    fn GetFinalPathNameByHandleW(
        file: HANDLE,
        file_name: *mut u16,
        file_name_len: u32,
        flags: u32,
    ) -> u32;
}

#[link(name = "shell32")]
extern "system" {
    fn SHFileOperationW(operation: *mut ShFileOpStructW) -> i32;
    fn ShellExecuteW(
        hwnd: *mut c_void,
        operation: *const u16,
        file: *const u16,
        parameters: *const u16,
        directory: *const u16,
        show_command: i32,
    ) -> *mut c_void;
}

pub use crate::platform::file_identity::FileIdentity;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReadOutput {
    pub bytes: Vec<u8>,
    pub revision: Revision,
    pub identity: FileIdentity,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WriteOutput {
    pub revision: Revision,
    pub identity: FileIdentity,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct StatOutput {
    pub kind: FileKind,
    pub size_bytes: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RecoveryOutcome {
    Clean,
    RolledBackToBackup,
    CleanedResidualArtifacts,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum FsError {
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
    FileTooLarge {
        size: u64,
        limit: usize,
    },
    Cancelled,
    RevisionConflict {
        expected: Option<Revision>,
        actual: Option<Revision>,
    },
    RecoveryRequired,
    Io(u32),
}

impl fmt::Display for FsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{self:?}")
    }
}
impl std::error::Error for FsError {}

struct OwnedHandle(HANDLE);
unsafe impl Send for OwnedHandle {}
unsafe impl Sync for OwnedHandle {}

impl OwnedHandle {
    fn new(h: HANDLE) -> Result<Self, FsError> {
        if h.is_null() || h == INVALID_HANDLE_VALUE {
            Err(FsError::Io(unsafe { GetLastError() }))
        } else {
            Ok(Self(h))
        }
    }
    fn raw(&self) -> HANDLE {
        self.0
    }
}

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        if !self.0.is_null() && self.0 != INVALID_HANDLE_VALUE {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}

pub struct PinnedParent {
    handle: OwnedHandle,
    pub identity: FileIdentity,
    pub leaf_name: String,
}

pub struct TrustedRoot {
    handle: OwnedHandle,
    identity: FileIdentity,
}

pub fn compute_revision(bytes: &[u8]) -> Revision {
    let digest = Sha256::digest(bytes);
    let mut text = String::with_capacity(7 + 64);
    text.push_str("sha256:");
    for b in digest {
        use fmt::Write as _;
        let _ = write!(&mut text, "{b:02x}");
    }
    Revision::parse(&text).expect("sha256 hex is always a valid Revision")
}

pub fn compute_identity_revision(identity: FileIdentity, bytes: &[u8]) -> Revision {
    let mut hasher = Sha256::new();
    hasher.update(b"modutex-rev-v1:");
    hasher.update(identity.volume_serial.to_le_bytes());
    hasher.update(identity.file_id.to_le_bytes());
    hasher.update((bytes.len() as u64).to_le_bytes());
    hasher.update(bytes);
    let digest = hasher.finalize();
    let mut text = String::with_capacity(7 + 64);
    text.push_str("sha256:");
    for b in digest {
        use fmt::Write as _;
        let _ = write!(&mut text, "{b:02x}");
    }
    Revision::parse(&text).expect("sha256 hex is always a valid Revision")
}

fn next_nonce(root: FileIdentity, parent: FileIdentity, leaf: &str) -> String {
    let seq = STAGE_COUNTER.fetch_add(1, Ordering::Relaxed);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let mut hasher = Sha256::new();
    hasher.update(b"modutex-nonce-v1:");
    hasher.update(std::process::id().to_le_bytes());
    hasher.update(seq.to_le_bytes());
    hasher.update(nanos.to_le_bytes());
    hasher.update(root.volume_serial.to_le_bytes());
    hasher.update(root.file_id.to_le_bytes());
    hasher.update(parent.volume_serial.to_le_bytes());
    hasher.update(parent.file_id.to_le_bytes());
    hasher.update(leaf.as_bytes());
    let digest = hasher.finalize();
    let mut out = String::with_capacity(32);
    for b in &digest[..16] {
        use fmt::Write as _;
        let _ = write!(&mut out, "{b:02x}");
    }
    out
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TransactionParams {
    pub nonce: String,
    pub root: FileIdentity,
    pub parent: FileIdentity,
    pub relative_path: String,
    pub leaf_name: String,
    pub stage_name: String,
    pub backup_name: String,
    pub original_target: Option<(FileIdentity, u64)>,
    pub stage_id: FileIdentity,
    pub stage_size: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct TransactionRecord {
    version: u32,
    nonce: String,
    root: FileIdentity,
    parent: FileIdentity,
    relative_path: String,
    leaf_name: String,
    stage_name: String,
    backup_name: String,
    original_target: Option<(FileIdentity, u64)>,
    stage_id: FileIdentity,
    stage_size: u64,
    mac: String,
}

impl TransactionRecord {
    fn new(params: TransactionParams) -> Self {
        let mut rec = Self {
            version: 1,
            nonce: params.nonce,
            root: params.root,
            parent: params.parent,
            relative_path: params.relative_path,
            leaf_name: params.leaf_name,
            stage_name: params.stage_name,
            backup_name: params.backup_name,
            original_target: params.original_target,
            stage_id: params.stage_id,
            stage_size: params.stage_size,
            mac: String::new(),
        };
        rec.mac = rec.compute_mac();
        rec
    }

    fn compute_mac(&self) -> String {
        let mut hasher = Sha256::new();
        hasher.update(b"modutex-txn-v1|");
        hasher.update(self.version.to_le_bytes());
        hasher.update(self.nonce.as_bytes());
        hasher.update(b"|");
        hasher.update(self.root.volume_serial.to_le_bytes());
        hasher.update(self.root.file_id.to_le_bytes());
        hasher.update(b"|");
        hasher.update(self.parent.volume_serial.to_le_bytes());
        hasher.update(self.parent.file_id.to_le_bytes());
        hasher.update(b"|");
        hasher.update(self.relative_path.as_bytes());
        hasher.update(b"|");
        hasher.update(self.leaf_name.as_bytes());
        hasher.update(b"|");
        hasher.update(self.stage_name.as_bytes());
        hasher.update(b"|");
        hasher.update(self.backup_name.as_bytes());
        hasher.update(b"|");
        if let Some((orig, sz)) = self.original_target {
            hasher.update([1u8]);
            hasher.update(orig.volume_serial.to_le_bytes());
            hasher.update(orig.file_id.to_le_bytes());
            hasher.update(sz.to_le_bytes());
        } else {
            hasher.update([0u8]);
        }
        hasher.update(b"|");
        hasher.update(self.stage_id.volume_serial.to_le_bytes());
        hasher.update(self.stage_id.file_id.to_le_bytes());
        hasher.update(self.stage_size.to_le_bytes());
        let digest = hasher.finalize();
        let mut out = String::with_capacity(64);
        for b in digest {
            use fmt::Write as _;
            let _ = write!(&mut out, "{b:02x}");
        }
        out
    }

    fn encode(&self) -> Vec<u8> {
        use fmt::Write as _;
        let mut text = String::new();
        let _ = writeln!(&mut text, "modutex-txn-v{}", self.version);
        let _ = writeln!(&mut text, "{}", self.nonce);
        let _ = writeln!(
            &mut text,
            "{:016x}:{:032x}",
            self.root.volume_serial, self.root.file_id
        );
        let _ = writeln!(
            &mut text,
            "{:016x}:{:032x}",
            self.parent.volume_serial, self.parent.file_id
        );
        let _ = writeln!(&mut text, "{}", self.relative_path);
        let _ = writeln!(&mut text, "{}", self.leaf_name);
        let _ = writeln!(&mut text, "{}", self.stage_name);
        let _ = writeln!(&mut text, "{}", self.backup_name);
        match self.original_target {
            Some((id, sz)) => {
                let _ = writeln!(
                    &mut text,
                    "1:{:016x}:{:032x}:{:016x}",
                    id.volume_serial, id.file_id, sz
                );
            }
            None => {
                let _ = writeln!(&mut text, "0");
            }
        }
        let _ = writeln!(
            &mut text,
            "{:016x}:{:032x}:{:016x}",
            self.stage_id.volume_serial, self.stage_id.file_id, self.stage_size
        );
        let _ = write!(&mut text, "{}", self.mac);
        text.into_bytes()
    }

    fn decode(bytes: &[u8]) -> Option<Self> {
        let text = std::str::from_utf8(bytes).ok()?;
        let mut lines = text.split('\n');
        if lines.next()? != "modutex-txn-v1" {
            return None;
        }
        let nonce = lines.next()?.to_owned();
        let root = Self::parse_identity(lines.next()?)?;
        let parent = Self::parse_identity(lines.next()?)?;
        let relative_path = lines.next()?.to_owned();
        let leaf_name = lines.next()?.to_owned();
        let stage_name = lines.next()?.to_owned();
        let backup_name = lines.next()?.to_owned();
        let orig_line = lines.next()?;
        let original_target = if orig_line == "0" {
            None
        } else {
            let rest = orig_line.strip_prefix("1:")?;
            Some(Self::parse_identity_and_size(rest)?)
        };
        let (stage_id, stage_size) = Self::parse_identity_and_size(lines.next()?)?;
        let mac = lines.next()?.to_owned();
        if lines.next().is_some() {
            return None;
        }
        Some(Self {
            version: 1,
            nonce,
            root,
            parent,
            relative_path,
            leaf_name,
            stage_name,
            backup_name,
            original_target,
            stage_id,
            stage_size,
            mac,
        })
    }

    fn parse_identity(s: &str) -> Option<FileIdentity> {
        let (vol_hex, id_hex) = s.split_once(':')?;
        if vol_hex.len() != 16 || id_hex.len() != 32 {
            return None;
        }
        Some(FileIdentity {
            volume_serial: u64::from_str_radix(vol_hex, 16).ok()?,
            file_id: u128::from_str_radix(id_hex, 16).ok()?,
        })
    }

    fn parse_identity_and_size(s: &str) -> Option<(FileIdentity, u64)> {
        let (vol_hex, rest) = s.split_once(':')?;
        let (id_hex, sz_hex) = rest.split_once(':')?;
        if vol_hex.len() != 16 || id_hex.len() != 32 || sz_hex.len() != 16 {
            return None;
        }
        Some((
            FileIdentity {
                volume_serial: u64::from_str_radix(vol_hex, 16).ok()?,
                file_id: u128::from_str_radix(id_hex, 16).ok()?,
            },
            u64::from_str_radix(sz_hex, 16).ok()?,
        ))
    }

    fn validate_for(
        &self,
        root: FileIdentity,
        parent: FileIdentity,
        path: &RelativePath,
        leaf_name: &str,
    ) -> Option<(Option<(FileIdentity, u64)>, FileIdentity)> {
        if self.version != 1
            || self.nonce.len() != 32
            || !self
                .nonce
                .bytes()
                .all(|b| b.is_ascii_digit() || matches!(b, b'a'..=b'f'))
            || self.mac != self.compute_mac()
            || self.root != root
            || self.parent != parent
            || self.relative_path != path.as_str()
            || self.leaf_name != leaf_name
            || self.stage_name != stage_file_name(&self.nonce, leaf_name)
            || self.backup_name != backup_file_name(&self.nonce, leaf_name)
        {
            return None;
        }
        Some((self.original_target, self.stage_id))
    }
}

fn stage_file_name(nonce: &str, leaf: &str) -> String {
    format!("{STAGE_PREFIX}{nonce}-{leaf}")
}

fn backup_file_name(nonce: &str, leaf: &str) -> String {
    format!("{BACKUP_PREFIX}{nonce}-{leaf}")
}

fn txn_file_name(leaf: &str) -> String {
    format!("{TXN_PREFIX}{leaf}")
}

fn is_any_recovery_artifact(name: &str) -> bool {
    name.starts_with(STAGE_PREFIX)
        || name.starts_with(BACKUP_PREFIX)
        || name.starts_with(TXN_PREFIX)
        || is_private_workspace_artifact(name)
}

fn is_private_workspace_artifact(name: &str) -> bool {
    name.starts_with(DELETE_TRASH_PREFIX)
        || name.starts_with(COPY_STAGE_PREFIX)
        || name.starts_with(RECYCLE_STAGE_PREFIX)
}

fn is_artifact_for_leaf(name: &str, leaf: &str) -> bool {
    if name == format!("{TXN_PREFIX}{leaf}")
        || name == format!("{BACKUP_PREFIX}{leaf}")
        || name == format!("{STAGE_PREFIX}{leaf}")
    {
        return true;
    }
    let suffix = format!("-{leaf}");
    name.strip_prefix(STAGE_PREFIX)
        .or_else(|| name.strip_prefix(BACKUP_PREFIX))
        .or_else(|| name.strip_prefix(TXN_PREFIX))
        .is_some_and(|rest| rest.ends_with(&suffix))
}

fn map_ntstatus(status: NTSTATUS) -> FsError {
    match status {
        STATUS_OBJECT_NAME_NOT_FOUND | STATUS_OBJECT_PATH_NOT_FOUND => FsError::NotFound,
        STATUS_ACCESS_DENIED => FsError::AccessDenied,
        STATUS_SHARING_VIOLATION => FsError::SharingViolation,
        STATUS_OBJECT_NAME_COLLISION => FsError::RevisionConflict {
            expected: None,
            actual: None,
        },
        STATUS_NOT_A_DIRECTORY => FsError::NotADirectory,
        STATUS_FILE_IS_A_DIRECTORY => FsError::IsADirectory,
        other => FsError::Io(other as u32),
    }
}

fn map_win32_error(err: u32) -> FsError {
    match err {
        ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND => FsError::NotFound,
        ERROR_ACCESS_DENIED => FsError::AccessDenied,
        ERROR_SHARING_VIOLATION => FsError::SharingViolation,
        ERROR_ALREADY_EXISTS => FsError::RevisionConflict {
            expected: None,
            actual: None,
        },
        other => FsError::Io(other),
    }
}

fn query_handle_meta(handle: HANDLE) -> Result<(FileIdentity, u32, u64), FsError> {
    let (identity, attributes, size) =
        crate::platform::file_identity::query_raw_handle_metadata(handle)
            .map_err(|error| map_win32_error(error.raw_os_error().unwrap_or(1) as u32))?;
    if (attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0 {
        return Err(FsError::LinkNotAllowed);
    }
    Ok((identity, attributes, size))
}

fn nt_open_segment(
    parent: HANDLE,
    segment: &str,
    access: u32,
    share: u32,
    disposition: u32,
    options: u32,
) -> Result<OwnedHandle, FsError> {
    if segment.is_empty()
        || segment.len() > MAX_SEGMENT_BYTES
        || segment
            .encode_utf16()
            .take(MAX_SEGMENT_UTF16_UNITS + 1)
            .count()
            > MAX_SEGMENT_UTF16_UNITS
        || segment.contains('/')
        || segment.contains('\\')
        || segment.contains(':')
        || segment.contains('\0')
    {
        return Err(FsError::InvalidPath);
    }
    let mut utf16: Vec<u16> = segment.encode_utf16().collect();
    let byte_len = utf16.len().checked_mul(2).ok_or(FsError::InvalidPath)?;
    if byte_len > u16::MAX as usize {
        return Err(FsError::InvalidPath);
    }
    let ustr = UNICODE_STRING {
        Length: byte_len as u16,
        MaximumLength: byte_len as u16,
        Buffer: utf16.as_mut_ptr(),
    };
    let oa = OBJECT_ATTRIBUTES {
        Length: size_of::<OBJECT_ATTRIBUTES>() as u32,
        RootDirectory: parent,
        ObjectName: &ustr,
        Attributes: OBJ_CASE_INSENSITIVE,
        SecurityDescriptor: null(),
        SecurityQualityOfService: null(),
    };
    let mut iosb: IO_STATUS_BLOCK = unsafe { zeroed() };
    let mut handle: HANDLE = null_mut();
    let status = unsafe {
        NtCreateFile(
            &mut handle,
            access | SYNCHRONIZE,
            &oa,
            &mut iosb,
            null(),
            FILE_ATTRIBUTE_NORMAL,
            share,
            disposition,
            options | FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT,
            null(),
            0,
        )
    };
    if status != STATUS_SUCCESS {
        return Err(map_ntstatus(status));
    }
    OwnedHandle::new(handle)
}

fn rename_relative(
    file: HANDLE,
    parent: HANDLE,
    target_name: &str,
    replace_if_exists: bool,
) -> Result<(), FsError> {
    if target_name.is_empty()
        || target_name.len() > MAX_SEGMENT_BYTES
        || target_name
            .encode_utf16()
            .take(MAX_SEGMENT_UTF16_UNITS + 1)
            .count()
            > MAX_SEGMENT_UTF16_UNITS
        || target_name.contains('/')
        || target_name.contains('\\')
        || target_name.contains(':')
        || target_name.contains('\0')
    {
        return Err(FsError::InvalidPath);
    }
    let utf16: Vec<u16> = target_name.encode_utf16().collect();
    let name_bytes = utf16.len().checked_mul(2).ok_or(FsError::InvalidPath)?;
    let name_offset = offset_of!(FILE_RENAME_INFO, FileName);
    let total_bytes = (name_offset + name_bytes).max(size_of::<FILE_RENAME_INFO>());
    let mut aligned = vec![0u64; total_bytes.div_ceil(8)];
    let mut iosb: IO_STATUS_BLOCK = unsafe { zeroed() };
    unsafe {
        let ptr = aligned.as_mut_ptr().cast::<FILE_RENAME_INFO>();
        *(ptr.cast::<u8>()) = u8::from(replace_if_exists);
        (*ptr).RootDirectory = parent;
        (*ptr).FileNameLength = name_bytes as u32;
        std::ptr::copy_nonoverlapping(
            utf16.as_ptr().cast::<u8>(),
            aligned.as_mut_ptr().cast::<u8>().add(name_offset),
            name_bytes,
        );
        let status = NtSetInformationFile(
            file,
            &mut iosb,
            aligned.as_ptr().cast(),
            total_bytes as u32,
            FileRenameInformation,
        );
        if status != STATUS_SUCCESS {
            return Err(map_ntstatus(status));
        }
    }
    Ok(())
}

fn mark_delete_on_close(file: HANDLE) -> Result<(), FsError> {
    let mut disp: FILE_DISPOSITION_INFO = unsafe { zeroed() };
    unsafe {
        *(&mut disp as *mut FILE_DISPOSITION_INFO).cast::<u8>() = 1;
        if SetFileInformationByHandle(
            file,
            FileDispositionInfo,
            (&disp as *const FILE_DISPOSITION_INFO).cast(),
            size_of::<FILE_DISPOSITION_INFO>() as u32,
        ) == 0
        {
            return Err(map_win32_error(GetLastError()));
        }
    }
    Ok(())
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ParsedDirRecord {
    name: String,
    is_dir: bool,
}

fn parse_dir_buffer(buf: &[u8]) -> Result<Vec<ParsedDirRecord>, FsError> {
    parse_dir_buffer_raw(buf, false)
}

fn parse_dir_buffer_raw(
    buf: &[u8],
    allow_artifacts: bool,
) -> Result<Vec<ParsedDirRecord>, FsError> {
    let align = align_of::<FILE_ID_BOTH_DIR_INFO>();
    let name_offset = offset_of!(FILE_ID_BOTH_DIR_INFO, FileName);
    if !(buf.as_ptr() as usize).is_multiple_of(align)
        || buf.len() < name_offset
        || buf.len() > DIR_BUFFER_BYTES
    {
        return Err(FsError::CorruptDirectoryRecord);
    }
    let mut records = Vec::new();
    let mut offset = 0usize;
    loop {
        if !offset.is_multiple_of(align)
            || offset
                .checked_add(name_offset)
                .is_none_or(|end| end > buf.len())
        {
            return Err(FsError::CorruptDirectoryRecord);
        }
        let hdr = unsafe { &*(buf.as_ptr().add(offset).cast::<FILE_ID_BOTH_DIR_INFO>()) };
        let next = hdr.NextEntryOffset as usize;
        let name_len = hdr.FileNameLength as usize;
        let attrs = hdr.FileAttributes;
        let short_len = hdr.ShortNameLength;
        let name_start = offset + name_offset;
        let name_end = name_start
            .checked_add(name_len)
            .ok_or(FsError::CorruptDirectoryRecord)?;
        if name_len == 0
            || !name_len.is_multiple_of(2)
            || name_len > MAX_SEGMENT_BYTES * 2
            || name_end > buf.len()
            || !(0..=24).contains(&short_len)
            || short_len % 2 != 0
            || hdr.EndOfFile < 0
            || hdr.AllocationSize < 0
        {
            return Err(FsError::CorruptDirectoryRecord);
        }
        if next != 0 {
            let next_offset = offset
                .checked_add(next)
                .ok_or(FsError::CorruptDirectoryRecord)?;
            if next < name_offset + name_len
                || !next.is_multiple_of(align)
                || next_offset > buf.len()
            {
                return Err(FsError::CorruptDirectoryRecord);
            }
        }
        let u16_slice = unsafe {
            std::slice::from_raw_parts(buf.as_ptr().add(name_start).cast::<u16>(), name_len / 2)
        };
        if (attrs & FILE_ATTRIBUTE_REPARSE_POINT) != 0 {
            return Err(FsError::LinkNotAllowed);
        }
        let name = String::from_utf16(u16_slice).map_err(|_| FsError::InvalidPath)?;
        if name != "." && name != ".." {
            // Managed recoverable deletes and atomic-copy staging are private
            // host state, not user files and not an interrupted write journal.
            if is_private_workspace_artifact(&name) {
                // Deliberately omit it from ordinary listings.
            } else if is_any_recovery_artifact(&name) {
                if !allow_artifacts {
                    return Err(FsError::RecoveryRequired);
                }
            } else {
                RelativePath::parse(&name).map_err(|_| FsError::InvalidPath)?;
            }
            if !is_private_workspace_artifact(&name) {
                if records.len() >= MAX_LIST_ENTRIES {
                    return Err(FsError::TreeTooLarge);
                }
                records.push(ParsedDirRecord {
                    name,
                    is_dir: (attrs & FILE_ATTRIBUTE_DIRECTORY) != 0,
                });
            }
        }
        if next == 0 {
            break;
        }
        offset += next;
    }
    Ok(records)
}

fn list_parent_artifacts(parent_handle: HANDLE, leaf: &str) -> Result<Vec<String>, FsError> {
    let mut aligned_buf = vec![0u64; DIR_BUFFER_BYTES / 8];
    let mut artifacts = Vec::new();
    let mut first = true;
    loop {
        let class = if first {
            FileIdBothDirectoryRestartInfo
        } else {
            FileIdBothDirectoryInfo
        };
        first = false;
        let ok = unsafe {
            GetFileInformationByHandleEx(
                parent_handle,
                class,
                aligned_buf.as_mut_ptr().cast(),
                DIR_BUFFER_BYTES as u32,
            )
        };
        if ok == 0 {
            let err = unsafe { GetLastError() };
            if err == ERROR_NO_MORE_FILES {
                break;
            }
            return Err(map_win32_error(err));
        }
        let bytes = unsafe {
            std::slice::from_raw_parts(aligned_buf.as_ptr().cast::<u8>(), DIR_BUFFER_BYTES)
        };
        for rec in parse_dir_buffer_raw(bytes, true)? {
            if is_artifact_for_leaf(&rec.name, leaf) {
                if rec.is_dir || artifacts.len() >= MAX_LIST_ENTRIES {
                    return Err(FsError::RecoveryRequired);
                }
                artifacts.push(rec.name);
            }
        }
    }
    Ok(artifacts)
}

impl TrustedRoot {
    pub fn open(path: &Path) -> Result<Self, FsError> {
        let mut wide: Vec<u16> = path.as_os_str().encode_wide().collect();
        wide.push(0);
        let raw = unsafe {
            CreateFileW(
                wide.as_ptr(),
                // Keep the root handle to traversal, metadata, and child creation;
                // read/write/delete access is requested on pinned leaf handles.
                FILE_LIST_DIRECTORY
                    | FILE_TRAVERSE
                    | FILE_READ_ATTRIBUTES
                    | FILE_ADD_FILE
                    | FILE_ADD_SUBDIRECTORY
                    | SYNCHRONIZE,
                // Pin each directory name while an operation uses its handle.
                // In particular, shell handoff and rename cannot follow a
                // replaced parent after validation.
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                null(),
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                null_mut(),
            )
        };
        let handle = OwnedHandle::new(raw)?;
        let (identity, attrs, _) = query_handle_meta(handle.raw())?;
        if (attrs & FILE_ATTRIBUTE_DIRECTORY) == 0 {
            return Err(FsError::NotADirectory);
        }
        Ok(Self { handle, identity })
    }

    pub fn identity(&self) -> FileIdentity {
        self.identity
    }

    pub fn verify_alive(&self) -> Result<FileIdentity, FsError> {
        let (current, attrs, _) = query_handle_meta(self.handle.raw())?;
        if (attrs & FILE_ATTRIBUTE_DIRECTORY) == 0 || current != self.identity {
            return Err(FsError::StaleWorkspace);
        }
        Ok(current)
    }

    pub fn pin_parent(
        &self,
        path: &RelativePath,
        create_missing_dirs: bool,
    ) -> Result<PinnedParent, FsError> {
        self.pin_parent_impl(path, create_missing_dirs, false)
    }

    fn pin_parent_impl(
        &self,
        path: &RelativePath,
        create_missing_dirs: bool,
        allow_private: bool,
    ) -> Result<PinnedParent, FsError> {
        self.verify_alive()?;
        if !allow_private && path.as_str().split('/').any(is_private_workspace_artifact) {
            return Err(FsError::InvalidPath);
        }
        let mut segments = Vec::with_capacity(MAX_DIRECTORY_DEPTH);
        for seg in path.as_str().split('/') {
            if segments.len() >= MAX_DIRECTORY_DEPTH {
                return Err(FsError::TreeTooDeep);
            }
            segments.push(seg);
        }
        let (leaf, parents) = segments.split_last().ok_or(FsError::InvalidPath)?;
        let mut current: Option<OwnedHandle> = None;
        let mut current_id = self.identity;
        for seg in parents {
            let base = current.as_ref().map_or(self.handle.raw(), OwnedHandle::raw);
            let disp = if create_missing_dirs {
                FILE_OPEN_IF
            } else {
                FILE_OPEN
            };
            let next = nt_open_segment(
                base,
                seg,
                FILE_LIST_DIRECTORY
                    | FILE_TRAVERSE
                    | FILE_READ_ATTRIBUTES
                    | FILE_ADD_FILE
                    | FILE_ADD_SUBDIRECTORY,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                disp,
                FILE_DIRECTORY_FILE | FILE_OPEN_FOR_BACKUP_INTENT,
            )?;
            let (id, attrs, _) = query_handle_meta(next.raw())?;
            if (attrs & FILE_ATTRIBUTE_DIRECTORY) == 0 {
                return Err(FsError::NotADirectory);
            }
            if id.volume_serial != self.identity.volume_serial {
                return Err(FsError::LinkNotAllowed);
            }
            current_id = id;
            current = Some(next);
        }
        let handle = match current {
            Some(h) => h,
            None => Self::open_dup_root(self.handle.raw(), self.identity)?,
        };
        Ok(PinnedParent {
            handle,
            identity: current_id,
            leaf_name: (*leaf).to_owned(),
        })
    }

    fn open_dup_root(root: HANDLE, expected: FileIdentity) -> Result<OwnedHandle, FsError> {
        let oa = OBJECT_ATTRIBUTES {
            Length: size_of::<OBJECT_ATTRIBUTES>() as u32,
            RootDirectory: root,
            ObjectName: &UNICODE_STRING {
                Length: 0,
                MaximumLength: 0,
                Buffer: null_mut(),
            },
            Attributes: OBJ_CASE_INSENSITIVE,
            SecurityDescriptor: null(),
            SecurityQualityOfService: null(),
        };
        let mut iosb: IO_STATUS_BLOCK = unsafe { zeroed() };
        let mut h: HANDLE = null_mut();
        let status = unsafe {
            NtCreateFile(
                &mut h,
                FILE_LIST_DIRECTORY
                    | FILE_TRAVERSE
                    | FILE_READ_ATTRIBUTES
                    | FILE_ADD_FILE
                    | FILE_ADD_SUBDIRECTORY
                    | SYNCHRONIZE,
                &oa,
                &mut iosb,
                null(),
                FILE_ATTRIBUTE_NORMAL,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                FILE_OPEN,
                FILE_DIRECTORY_FILE
                    | FILE_OPEN_REPARSE_POINT
                    | FILE_SYNCHRONOUS_IO_NONALERT
                    | FILE_OPEN_FOR_BACKUP_INTENT,
                null(),
                0,
            )
        };
        if status != STATUS_SUCCESS {
            return Err(map_ntstatus(status));
        }
        let handle = OwnedHandle::new(h)?;
        let (id, _, _) = query_handle_meta(handle.raw())?;
        if id != expected {
            return Err(FsError::StaleWorkspace);
        }
        Ok(handle)
    }

    pub fn list_files(&self) -> Result<Vec<FileEntry>, FsError> {
        self.verify_alive()?;
        let root_dup = Self::open_dup_root(self.handle.raw(), self.identity)?;
        let mut stack = vec![(root_dup, None::<RelativePath>, 0usize)];
        let mut entries = Vec::new();
        let mut aligned_buf = vec![0u64; DIR_BUFFER_BYTES / 8];
        while let Some((dir_handle, prefix, depth)) = stack.pop() {
            let mut first = true;
            loop {
                let class = if first {
                    FileIdBothDirectoryRestartInfo
                } else {
                    FileIdBothDirectoryInfo
                };
                first = false;
                let ok = unsafe {
                    GetFileInformationByHandleEx(
                        dir_handle.raw(),
                        class,
                        aligned_buf.as_mut_ptr().cast(),
                        DIR_BUFFER_BYTES as u32,
                    )
                };
                if ok == 0 {
                    let err = unsafe { GetLastError() };
                    if err == ERROR_NO_MORE_FILES {
                        break;
                    }
                    return Err(map_win32_error(err));
                }
                let bytes = unsafe {
                    std::slice::from_raw_parts(aligned_buf.as_ptr().cast::<u8>(), DIR_BUFFER_BYTES)
                };
                for rec in parse_dir_buffer(bytes)? {
                    if entries.len() >= MAX_LIST_ENTRIES {
                        return Err(FsError::TreeTooLarge);
                    }
                    let rel_str = match &prefix {
                        Some(p) => format!("{p}/{}", rec.name),
                        None => rec.name.clone(),
                    };
                    let rel_path =
                        RelativePath::parse(&rel_str).map_err(|_| FsError::InvalidPath)?;
                    if rec.is_dir {
                        if depth + 1 >= MAX_DIRECTORY_DEPTH {
                            return Err(FsError::TreeTooDeep);
                        }
                        let child = nt_open_segment(
                            dir_handle.raw(),
                            &rec.name,
                            FILE_LIST_DIRECTORY | FILE_TRAVERSE | FILE_READ_ATTRIBUTES,
                            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                            FILE_OPEN,
                            FILE_DIRECTORY_FILE | FILE_OPEN_FOR_BACKUP_INTENT,
                        )?;
                        let (id, attrs, _) = query_handle_meta(child.raw())?;
                        if (attrs & FILE_ATTRIBUTE_DIRECTORY) == 0
                            || id.volume_serial != self.identity.volume_serial
                        {
                            return Err(FsError::LinkNotAllowed);
                        }
                        entries.push(FileEntry {
                            path: rel_path.clone(),
                            kind: FileKind::Directory,
                        });
                        stack.push((child, Some(rel_path), depth + 1));
                    } else {
                        entries.push(FileEntry {
                            path: rel_path,
                            kind: FileKind::File,
                        });
                    }
                }
            }
        }
        entries.sort_by(|a, b| a.path.as_str().cmp(b.path.as_str()));
        Ok(entries)
    }

    /// Bounded handle-relative scan. Results use workspace-relative paths even
    /// when `directory` selects a subtree. Cancellation is checked between
    /// directory records, not just between directory opens.
    pub fn scan(
        &self,
        directory: Option<&RelativePath>,
        max_depth: usize,
        max_entries: usize,
        cancelled: &AtomicBool,
    ) -> Result<Vec<FileEntry>, FsError> {
        if max_depth == 0 || max_depth > MAX_DIRECTORY_DEPTH {
            return Err(FsError::TreeTooDeep);
        }
        if max_entries == 0 || max_entries > MAX_LIST_ENTRIES {
            return Err(FsError::TreeTooLarge);
        }
        if cancelled.load(Ordering::Acquire) {
            return Err(FsError::Cancelled);
        }
        self.verify_alive()?;

        let (start, prefix) = if let Some(path) = directory {
            let parent = self.pin_parent(path, false)?;
            let handle = nt_open_segment(
                parent.handle.raw(),
                &parent.leaf_name,
                FILE_LIST_DIRECTORY | FILE_TRAVERSE | FILE_READ_ATTRIBUTES,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                FILE_OPEN,
                FILE_DIRECTORY_FILE | FILE_OPEN_FOR_BACKUP_INTENT,
            )?;
            let (identity, attributes, _) = query_handle_meta(handle.raw())?;
            if (attributes & FILE_ATTRIBUTE_DIRECTORY) == 0 {
                return Err(FsError::NotADirectory);
            }
            if identity.volume_serial != self.identity.volume_serial {
                return Err(FsError::LinkNotAllowed);
            }
            (handle, Some(path.clone()))
        } else {
            (Self::open_dup_root(self.handle.raw(), self.identity)?, None)
        };

        let mut stack = vec![(start, prefix, 0usize)];
        let mut entries = Vec::new();
        let mut aligned_buf = vec![0u64; DIR_BUFFER_BYTES / 8];
        while let Some((dir_handle, prefix, depth)) = stack.pop() {
            let mut first = true;
            loop {
                if cancelled.load(Ordering::Acquire) {
                    return Err(FsError::Cancelled);
                }
                let class = if first {
                    FileIdBothDirectoryRestartInfo
                } else {
                    FileIdBothDirectoryInfo
                };
                first = false;
                let ok = unsafe {
                    GetFileInformationByHandleEx(
                        dir_handle.raw(),
                        class,
                        aligned_buf.as_mut_ptr().cast(),
                        DIR_BUFFER_BYTES as u32,
                    )
                };
                if ok == 0 {
                    let error = unsafe { GetLastError() };
                    if error == ERROR_NO_MORE_FILES {
                        break;
                    }
                    return Err(map_win32_error(error));
                }
                let bytes = unsafe {
                    std::slice::from_raw_parts(aligned_buf.as_ptr().cast::<u8>(), DIR_BUFFER_BYTES)
                };
                for record in parse_dir_buffer(bytes)? {
                    if cancelled.load(Ordering::Acquire) {
                        return Err(FsError::Cancelled);
                    }
                    let child_depth = depth.checked_add(1).ok_or(FsError::TreeTooDeep)?;
                    if child_depth > max_depth {
                        return Err(FsError::TreeTooDeep);
                    }
                    if entries.len() >= max_entries {
                        return Err(FsError::TreeTooLarge);
                    }
                    let relative = match &prefix {
                        Some(parent) => format!("{parent}/{}", record.name),
                        None => record.name.clone(),
                    };
                    let path = RelativePath::parse(&relative).map_err(|_| FsError::InvalidPath)?;
                    if record.is_dir && child_depth < max_depth {
                        let child = nt_open_segment(
                            dir_handle.raw(),
                            &record.name,
                            FILE_LIST_DIRECTORY | FILE_TRAVERSE | FILE_READ_ATTRIBUTES,
                            FILE_SHARE_READ | FILE_SHARE_WRITE,
                            FILE_OPEN,
                            FILE_DIRECTORY_FILE | FILE_OPEN_FOR_BACKUP_INTENT,
                        )?;
                        let (identity, attributes, _) = query_handle_meta(child.raw())?;
                        if (attributes & FILE_ATTRIBUTE_DIRECTORY) == 0
                            || identity.volume_serial != self.identity.volume_serial
                        {
                            return Err(FsError::LinkNotAllowed);
                        }
                        entries.push(FileEntry {
                            path: path.clone(),
                            kind: FileKind::Directory,
                        });
                        stack.push((child, Some(path), child_depth));
                    } else {
                        entries.push(FileEntry {
                            path,
                            kind: if record.is_dir {
                                FileKind::Directory
                            } else {
                                FileKind::File
                            },
                        });
                    }
                }
            }
        }
        entries.sort_by(|left, right| left.path.as_str().cmp(right.path.as_str()));
        Ok(entries)
    }

    pub fn stat(&self, path: &RelativePath) -> Result<StatOutput, FsError> {
        let parent = self.pin_parent(path, false)?;
        let handle = nt_open_segment(
            parent.handle.raw(),
            &parent.leaf_name,
            FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            FILE_OPEN,
            FILE_OPEN_FOR_BACKUP_INTENT,
        )?;
        let (identity, attributes, size) = query_handle_meta(handle.raw())?;
        if identity.volume_serial != self.identity.volume_serial {
            return Err(FsError::LinkNotAllowed);
        }
        Ok(StatOutput {
            kind: if (attributes & FILE_ATTRIBUTE_DIRECTORY) != 0 {
                FileKind::Directory
            } else {
                FileKind::File
            },
            size_bytes: if (attributes & FILE_ATTRIBUTE_DIRECTORY) != 0 {
                0
            } else {
                size
            },
        })
    }

    pub fn create_file(&self, path: &RelativePath, bytes: &[u8]) -> Result<WriteOutput, FsError> {
        self.create_file_internal(path, bytes, false, None)
    }

    fn create_file_internal(
        &self,
        path: &RelativePath,
        bytes: &[u8],
        allow_private: bool,
        cancelled: Option<&AtomicBool>,
    ) -> Result<WriteOutput, FsError> {
        if cancelled.is_some_and(|flag| flag.load(Ordering::Acquire)) {
            return Err(FsError::Cancelled);
        }
        let limit = read_limit(path.as_str()).min(MAX_READ_CAP_BYTES);
        if bytes.len() > limit {
            return Err(FsError::FileTooLarge {
                size: bytes.len() as u64,
                limit,
            });
        }
        let parent = self.pin_parent_impl(path, false, allow_private)?;
        let file = nt_open_segment(
            parent.handle.raw(),
            &parent.leaf_name,
            FILE_WRITE_DATA | FILE_WRITE_ATTRIBUTES | FILE_READ_ATTRIBUTES | DELETE,
            0,
            FILE_CREATE,
            FILE_NON_DIRECTORY_FILE,
        )?;
        let write_result = if let Some(cancelled) = cancelled {
            write_and_flush_cancelable(file.raw(), bytes, cancelled)
        } else {
            write_and_flush(file.raw(), bytes)
        };
        if let Err(error) = write_result {
            mark_delete_on_close(file.raw()).map_err(|_| FsError::RecoveryRequired)?;
            return Err(error);
        }
        let (identity, attributes, size) = query_handle_meta(file.raw())?;
        if (attributes & FILE_ATTRIBUTE_DIRECTORY) != 0
            || identity.volume_serial != self.identity.volume_serial
            || size != bytes.len() as u64
        {
            return Err(FsError::StaleWorkspace);
        }
        Ok(WriteOutput {
            revision: compute_identity_revision(identity, bytes),
            identity,
        })
    }

    pub fn create_directory(&self, path: &RelativePath) -> Result<FileIdentity, FsError> {
        self.create_directory_internal(path, false)
    }

    fn create_directory_internal(
        &self,
        path: &RelativePath,
        allow_private: bool,
    ) -> Result<FileIdentity, FsError> {
        let parent = self.pin_parent_impl(path, false, allow_private)?;
        let directory = nt_open_segment(
            parent.handle.raw(),
            &parent.leaf_name,
            FILE_LIST_DIRECTORY | FILE_TRAVERSE | FILE_READ_ATTRIBUTES | DELETE,
            0,
            FILE_CREATE,
            FILE_DIRECTORY_FILE | FILE_OPEN_FOR_BACKUP_INTENT,
        )?;
        let (identity, attributes, _) = query_handle_meta(directory.raw())?;
        if (attributes & FILE_ATTRIBUTE_DIRECTORY) == 0
            || identity.volume_serial != self.identity.volume_serial
        {
            return Err(FsError::LinkNotAllowed);
        }
        Ok(identity)
    }

    pub fn move_path(
        &self,
        source: &RelativePath,
        destination: &RelativePath,
    ) -> Result<StatOutput, FsError> {
        self.move_path_internal(source, destination, false, false)
    }

    fn move_path_internal(
        &self,
        source: &RelativePath,
        destination: &RelativePath,
        source_private: bool,
        destination_private: bool,
    ) -> Result<StatOutput, FsError> {
        if source.as_str() == destination.as_str()
            || source.as_str().to_lowercase() == destination.as_str().to_lowercase()
        {
            return self.stat(source);
        }
        let source_parent = self.pin_parent_impl(source, false, source_private)?;
        let destination_parent = self.pin_parent_impl(destination, false, destination_private)?;
        let source_handle = nt_open_segment(
            source_parent.handle.raw(),
            &source_parent.leaf_name,
            FILE_READ_ATTRIBUTES | DELETE,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            FILE_OPEN,
            FILE_OPEN_FOR_BACKUP_INTENT,
        )?;
        let (identity, attributes, size) = query_handle_meta(source_handle.raw())?;
        if identity.volume_serial != self.identity.volume_serial {
            return Err(FsError::LinkNotAllowed);
        }
        if (attributes & FILE_ATTRIBUTE_DIRECTORY) != 0 {
            let from = source.as_str().to_lowercase();
            let to = destination.as_str().to_lowercase();
            if to.starts_with(&format!("{from}/")) {
                return Err(FsError::InvalidPath);
            }
        }
        rename_relative(
            source_handle.raw(),
            destination_parent.handle.raw(),
            &destination_parent.leaf_name,
            false,
        )?;
        let moved = nt_open_segment(
            destination_parent.handle.raw(),
            &destination_parent.leaf_name,
            FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            FILE_OPEN,
            FILE_OPEN_FOR_BACKUP_INTENT,
        )?;
        let (moved_identity, moved_attributes, moved_size) = query_handle_meta(moved.raw())?;
        if moved_identity != identity || moved_attributes != attributes || moved_size != size {
            return Err(FsError::StaleWorkspace);
        }
        Ok(StatOutput {
            kind: if (attributes & FILE_ATTRIBUTE_DIRECTORY) != 0 {
                FileKind::Directory
            } else {
                FileKind::File
            },
            size_bytes: if (attributes & FILE_ATTRIBUTE_DIRECTORY) != 0 {
                0
            } else {
                size
            },
        })
    }

    /// Copy a file or directory tree to a fresh destination. A directory copy
    /// is assembled under a private same-volume staging directory, revalidated
    /// against its source snapshot, then published by one no-replace rename.
    pub fn copy_path(
        &self,
        source: &RelativePath,
        destination: &RelativePath,
        cancelled: &AtomicBool,
    ) -> Result<StatOutput, FsError> {
        if source.as_str() == destination.as_str()
            || source.as_str().to_lowercase() == destination.as_str().to_lowercase()
        {
            return Err(FsError::RevisionConflict {
                expected: None,
                actual: None,
            });
        }
        if cancelled.load(Ordering::Acquire) {
            return Err(FsError::Cancelled);
        }
        let source_stat = self.stat(source)?;
        if source_stat.kind == FileKind::File {
            let source_read = self.read_file_bounded(source, read_limit(source.as_str()))?;
            let parent = destination
                .as_str()
                .rsplit_once('/')
                .map_or("", |(parent, _)| parent);
            let extension = if source.as_str().to_ascii_lowercase().ends_with(".pdf") {
                "pdf"
            } else {
                "tmp"
            };
            let stage_leaf = format!("{COPY_STAGE_PREFIX}{}.{}", uuid::Uuid::new_v4(), extension);
            let stage_text = if parent.is_empty() {
                stage_leaf
            } else {
                format!("{parent}/{stage_leaf}")
            };
            let stage = RelativePath::parse(&stage_text).map_err(|_| FsError::InvalidPath)?;
            let staged =
                self.create_file_internal(&stage, &source_read.bytes, true, Some(cancelled))?;
            let outcome = (|| {
                if cancelled.load(Ordering::Acquire) {
                    return Err(FsError::Cancelled);
                }
                let current = self.read_file_bounded(source, read_limit(source.as_str()))?;
                if current.revision != source_read.revision {
                    return Err(FsError::RevisionConflict {
                        expected: Some(source_read.revision.clone()),
                        actual: Some(current.revision),
                    });
                }
                // This is the cancellation/commit boundary. Once the
                // no-replace rename succeeds, the copy is committed.
                if cancelled.load(Ordering::Acquire) {
                    return Err(FsError::Cancelled);
                }
                self.move_path_internal(&stage, destination, true, false)
            })();
            if outcome.is_err()
                && self
                    .delete_file_if_revision_internal(&stage, &staged.revision, true)
                    .is_err()
            {
                return Err(FsError::RecoveryRequired);
            }
            return outcome;
        }
        let source_folded = source.as_str().to_lowercase();
        let destination_folded = destination.as_str().to_lowercase();
        if destination_folded.starts_with(&format!("{source_folded}/")) {
            return Err(FsError::InvalidPath);
        }

        let snapshot = self.scan(
            Some(source),
            MAX_DIRECTORY_DEPTH,
            MAX_LIST_ENTRIES,
            cancelled,
        )?;
        let stage_name = format!("{COPY_STAGE_PREFIX}{}", uuid::Uuid::new_v4());
        let stage_root = RelativePath::parse(&stage_name).map_err(|_| FsError::InvalidPath)?;
        let mut staged_files: Vec<(RelativePath, Revision)> = Vec::new();
        let mut staged_directories: Vec<(RelativePath, FileIdentity)> = Vec::new();

        let copy_result = (|| {
            let identity = self.create_directory_internal(&stage_root, true)?;
            staged_directories.push((stage_root.clone(), identity));
            let mut source_revisions = Vec::new();
            let mut total_bytes = 0usize;

            for entry in &snapshot {
                if cancelled.load(Ordering::Acquire) {
                    return Err(FsError::Cancelled);
                }
                let prefix = format!("{}/", source.as_str());
                let suffix = entry
                    .path
                    .as_str()
                    .strip_prefix(&prefix)
                    .ok_or(FsError::InvalidPath)?;
                let target_text = format!("{stage_name}/{suffix}");
                let target = RelativePath::parse(&target_text).map_err(|_| FsError::InvalidPath)?;
                match entry.kind {
                    FileKind::Directory => {
                        let identity = self.create_directory_internal(&target, true)?;
                        staged_directories.push((target, identity));
                    }
                    FileKind::File => {
                        let read =
                            self.read_file_bounded(&entry.path, read_limit(entry.path.as_str()))?;
                        total_bytes = total_bytes
                            .checked_add(read.bytes.len())
                            .ok_or(FsError::TreeTooLarge)?;
                        if total_bytes > MAX_COPY_TREE_BYTES {
                            return Err(FsError::TreeTooLarge);
                        }
                        let output =
                            self.create_file_internal(&target, &read.bytes, true, Some(cancelled))?;
                        staged_files.push((target, output.revision));
                        source_revisions.push((entry.path.clone(), read.revision));
                    }
                }
            }

            if self.scan(
                Some(source),
                MAX_DIRECTORY_DEPTH,
                MAX_LIST_ENTRIES,
                cancelled,
            )? != snapshot
            {
                return Err(FsError::RevisionConflict {
                    expected: None,
                    actual: None,
                });
            }
            for (path, expected) in source_revisions {
                if cancelled.load(Ordering::Acquire) {
                    return Err(FsError::Cancelled);
                }
                let actual = self.read_file_bounded(&path, read_limit(path.as_str()))?;
                if actual.revision != expected {
                    return Err(FsError::RevisionConflict {
                        expected: Some(expected),
                        actual: Some(actual.revision),
                    });
                }
            }
            if cancelled.load(Ordering::Acquire) {
                return Err(FsError::Cancelled);
            }
            self.move_path_internal(&stage_root, destination, true, false)
        })();

        match copy_result {
            Ok(stat) => Ok(stat),
            Err(error) => {
                let cleanup = self.cleanup_copy_stage(&staged_files, &staged_directories);
                if cleanup.is_err() {
                    Err(FsError::RecoveryRequired)
                } else {
                    Err(error)
                }
            }
        }
    }

    fn cleanup_copy_stage(
        &self,
        files: &[(RelativePath, Revision)],
        directories: &[(RelativePath, FileIdentity)],
    ) -> Result<(), FsError> {
        for (path, revision) in files.iter().rev() {
            self.delete_file_if_revision_internal(path, revision, true)?;
        }
        for (path, identity) in directories.iter().rev() {
            self.remove_empty_directory_internal(path, *identity, true)?;
        }
        Ok(())
    }

    fn remove_empty_directory_internal(
        &self,
        path: &RelativePath,
        expected_identity: FileIdentity,
        allow_private: bool,
    ) -> Result<(), FsError> {
        let parent = self.pin_parent_impl(path, false, allow_private)?;
        let directory = nt_open_segment(
            parent.handle.raw(),
            &parent.leaf_name,
            FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | DELETE,
            0,
            FILE_OPEN,
            FILE_DIRECTORY_FILE | FILE_OPEN_FOR_BACKUP_INTENT,
        )?;
        let (identity, attributes, _) = query_handle_meta(directory.raw())?;
        if identity != expected_identity || (attributes & FILE_ATTRIBUTE_DIRECTORY) == 0 {
            return Err(FsError::StaleWorkspace);
        }
        mark_delete_on_close(directory.raw())
    }

    /// Move a file or directory to a host-owned sibling tombstone. Undo uses
    /// an atomic no-replace rename, so an external destination is never lost.
    pub fn delete_recoverable(&self, path: &RelativePath, token: &str) -> Result<(), FsError> {
        if !valid_recovery_token(token) {
            return Err(FsError::InvalidPath);
        }
        let parent = self.pin_parent(path, false)?;
        let item = nt_open_segment(
            parent.handle.raw(),
            &parent.leaf_name,
            FILE_READ_ATTRIBUTES | DELETE,
            0,
            FILE_OPEN,
            FILE_OPEN_FOR_BACKUP_INTENT,
        )?;
        let (identity, _, _) = query_handle_meta(item.raw())?;
        if identity.volume_serial != self.identity.volume_serial {
            return Err(FsError::LinkNotAllowed);
        }
        let trash_name = format!("{DELETE_TRASH_PREFIX}{token}");
        rename_relative(item.raw(), parent.handle.raw(), &trash_name, false)
    }

    pub fn undo_recoverable_delete(&self, path: &RelativePath, token: &str) -> Result<(), FsError> {
        if !valid_recovery_token(token) {
            return Err(FsError::InvalidPath);
        }
        let parent = self.pin_parent(path, false)?;
        match nt_open_segment(
            parent.handle.raw(),
            &parent.leaf_name,
            FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            FILE_OPEN,
            FILE_OPEN_FOR_BACKUP_INTENT,
        ) {
            Ok(_) => {
                return Err(FsError::RevisionConflict {
                    expected: None,
                    actual: None,
                })
            }
            Err(FsError::NotFound) => {}
            Err(error) => return Err(error),
        }
        let trash_name = format!("{DELETE_TRASH_PREFIX}{token}");
        let item = nt_open_segment(
            parent.handle.raw(),
            &trash_name,
            FILE_READ_ATTRIBUTES | DELETE,
            0,
            FILE_OPEN,
            FILE_OPEN_FOR_BACKUP_INTENT,
        )?;
        let (identity, _, _) = query_handle_meta(item.raw())?;
        if identity.volume_serial != self.identity.volume_serial {
            return Err(FsError::LinkNotAllowed);
        }
        // No replacement flag: a concurrent file created at `path` wins.
        rename_relative(item.raw(), parent.handle.raw(), &parent.leaf_name, false)?;
        let restored = nt_open_segment(
            parent.handle.raw(),
            &parent.leaf_name,
            FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            FILE_OPEN,
            FILE_OPEN_FOR_BACKUP_INTENT,
        )?;
        if query_handle_meta(restored.raw())?.0 != identity {
            return Err(FsError::StaleWorkspace);
        }
        Ok(())
    }

    /// Send an item to the Windows Recycle Bin through the native shell API.
    /// FOF_ALLOWUNDO is mandatory; on shell failure the staged item is restored
    /// with a no-replace handle rename, or left intact under its private name.
    pub fn recycle_path(&self, path: &RelativePath) -> Result<(), FsError> {
        let parent = self.pin_parent(path, false)?;
        let item = nt_open_segment(
            parent.handle.raw(),
            &parent.leaf_name,
            FILE_READ_ATTRIBUTES | DELETE,
            0,
            FILE_OPEN,
            FILE_OPEN_FOR_BACKUP_INTENT,
        )?;
        let (identity, _, _) = query_handle_meta(item.raw())?;
        if identity.volume_serial != self.identity.volume_serial {
            return Err(FsError::LinkNotAllowed);
        }
        let token = uuid::Uuid::new_v4().simple().to_string();
        let stage_name = format!("{RECYCLE_STAGE_PREFIX}{token}");
        rename_relative(item.raw(), parent.handle.raw(), &stage_name, false)?;
        drop(item);

        let staged_path = final_path_from_handle(parent.handle.raw())?.join(&stage_name);
        let shell_result = shell_recycle(&staged_path);
        let staged = nt_open_segment(
            parent.handle.raw(),
            &stage_name,
            FILE_READ_ATTRIBUTES | DELETE,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            FILE_OPEN,
            FILE_OPEN_FOR_BACKUP_INTENT,
        );
        match staged {
            Err(FsError::NotFound) if shell_result.is_ok() => Ok(()),
            Err(FsError::NotFound) => Err(shell_result.unwrap_err()),
            Ok(staged_handle) => {
                let (staged_identity, _, _) = query_handle_meta(staged_handle.raw())?;
                if staged_identity != identity {
                    return Err(FsError::RecoveryRequired);
                }
                // The exact staged handle is renamed; a replacement at the
                // private name cannot be moved over the original.
                rename_relative(
                    staged_handle.raw(),
                    parent.handle.raw(),
                    &parent.leaf_name,
                    false,
                )
                .map_err(|_| FsError::RecoveryRequired)?;
                match shell_result {
                    Err(error) => Err(error),
                    Ok(()) => Err(FsError::RecoveryRequired),
                }
            }
            Err(error) => Err(error),
        }
    }

    /// Reveal an existing workspace item in Explorer. The renderer supplies
    /// only a RelativePath; the absolute path comes from the verified root
    /// handle and the executable/operation are fixed by this host.
    pub fn reveal_in_explorer(&self, path: &RelativePath) -> Result<(), FsError> {
        let stat = self.stat(path)?;
        let mut target = final_path_from_handle(self.handle.raw())?;
        target.push(path.as_str().replace('/', "\\"));
        let target = target.to_string_lossy().into_owned();
        let quoted = quote_windows_argument(&target);
        let parameters = if stat.kind == FileKind::File {
            format!("/select,{quoted}")
        } else {
            quoted
        };
        let operation: Vec<u16> = "open".encode_utf16().chain(Some(0)).collect();
        let executable: Vec<u16> = "explorer.exe".encode_utf16().chain(Some(0)).collect();
        let parameters: Vec<u16> = parameters.encode_utf16().chain(Some(0)).collect();
        let result = unsafe {
            ShellExecuteW(
                std::ptr::null_mut(),
                operation.as_ptr(),
                executable.as_ptr(),
                parameters.as_ptr(),
                std::ptr::null(),
                1,
            )
        };
        if result as usize <= 32 {
            return Err(FsError::Io(result as usize as u32));
        }
        Ok(())
    }

    pub fn read_file(&self, path: &RelativePath) -> Result<ReadOutput, FsError> {
        let limit = MAX_READ_BYTES;
        let parent = self.pin_parent(path, false)?;
        if !list_parent_artifacts(parent.handle.raw(), &parent.leaf_name)?.is_empty() {
            return Err(FsError::RecoveryRequired);
        }
        let file = nt_open_segment(
            parent.handle.raw(),
            &parent.leaf_name,
            FILE_READ_DATA | FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ,
            FILE_OPEN,
            FILE_NON_DIRECTORY_FILE,
        )?;
        read_from_handle(file.raw(), self.identity.volume_serial, limit)
    }

    pub fn read_file_pdf(&self, path: &RelativePath) -> Result<ReadOutput, FsError> {
        let limit = MAX_PDF_BYTES;
        if !path.as_str().to_ascii_lowercase().ends_with(".pdf") {
            return Err(FsError::InvalidPath);
        }
        let parent = self.pin_parent(path, false)?;
        if !list_parent_artifacts(parent.handle.raw(), &parent.leaf_name)?.is_empty() {
            return Err(FsError::RecoveryRequired);
        }
        let file = nt_open_segment(
            parent.handle.raw(),
            &parent.leaf_name,
            FILE_READ_DATA | FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ,
            FILE_OPEN,
            FILE_NON_DIRECTORY_FILE,
        )?;
        read_pdf_from_handle(file.raw(), self.identity.volume_serial, limit)
    }

    pub fn write_file(
        &self,
        path: &RelativePath,
        bytes: &[u8],
        expected_revision: Option<&Revision>,
    ) -> Result<WriteOutput, FsError> {
        self.write_file_internal(path, bytes, expected_revision, None)
    }

    fn write_file_internal(
        &self,
        path: &RelativePath,
        bytes: &[u8],
        expected_revision: Option<&Revision>,
        after_backup_rename: Option<&mut dyn FnMut(&PinnedParent)>,
    ) -> Result<WriteOutput, FsError> {
        let limit = read_limit(path.as_str()).min(MAX_READ_CAP_BYTES);
        if bytes.len() > limit {
            return Err(FsError::FileTooLarge {
                size: bytes.len() as u64,
                limit,
            });
        }
        let parent = self.pin_parent(path, true)?;
        if !list_parent_artifacts(parent.handle.raw(), &parent.leaf_name)?.is_empty() {
            return Err(FsError::RecoveryRequired);
        }
        let existing = match nt_open_segment(
            parent.handle.raw(),
            &parent.leaf_name,
            FILE_READ_DATA | FILE_READ_ATTRIBUTES | DELETE,
            0,
            FILE_OPEN,
            FILE_NON_DIRECTORY_FILE,
        ) {
            Ok(handle) => {
                let current = read_from_handle(handle.raw(), self.identity.volume_serial, limit)?;
                match expected_revision {
                    Some(exp) if exp == &current.revision => {
                        Some((handle, current.identity, current.bytes.len() as u64))
                    }
                    exp => {
                        return Err(FsError::RevisionConflict {
                            expected: exp.cloned(),
                            actual: Some(current.revision),
                        });
                    }
                }
            }
            Err(FsError::NotFound) => {
                if let Some(exp) = expected_revision {
                    return Err(FsError::RevisionConflict {
                        expected: Some(exp.clone()),
                        actual: None,
                    });
                }
                None
            }
            Err(e) => return Err(e),
        };
        let nonce = next_nonce(self.identity, parent.identity, &parent.leaf_name);
        let stage_name = stage_file_name(&nonce, &parent.leaf_name);
        let bak_name = backup_file_name(&nonce, &parent.leaf_name);
        let txn_name = txn_file_name(&parent.leaf_name);
        let stage = nt_open_segment(
            parent.handle.raw(),
            &stage_name,
            FILE_WRITE_DATA | FILE_WRITE_ATTRIBUTES | FILE_READ_ATTRIBUTES | DELETE,
            0,
            FILE_CREATE,
            FILE_NON_DIRECTORY_FILE,
        )?;
        if let Err(err) = write_and_flush(stage.raw(), bytes) {
            mark_delete_on_close(stage.raw()).map_err(|_| FsError::RecoveryRequired)?;
            return Err(err);
        }
        let (stage_id, stage_attrs, stage_size) = match query_handle_meta(stage.raw()) {
            Ok(meta) => meta,
            Err(err) => {
                mark_delete_on_close(stage.raw()).map_err(|_| FsError::RecoveryRequired)?;
                return Err(err);
            }
        };
        if (stage_attrs & FILE_ATTRIBUTE_DIRECTORY) != 0
            || stage_id.volume_serial != self.identity.volume_serial
            || stage_size != bytes.len() as u64
        {
            mark_delete_on_close(stage.raw()).map_err(|_| FsError::RecoveryRequired)?;
            return Err(FsError::StaleWorkspace);
        }
        let orig_meta = existing.as_ref().map(|(_, id, sz)| (*id, *sz));
        let record = TransactionRecord::new(TransactionParams {
            nonce,
            root: self.identity,
            parent: parent.identity,
            relative_path: path.as_str().to_owned(),
            leaf_name: parent.leaf_name.clone(),
            stage_name,
            backup_name: bak_name.clone(),
            original_target: orig_meta,
            stage_id,
            stage_size,
        });
        let txn_bytes = record.encode();
        let txn = match nt_open_segment(
            parent.handle.raw(),
            &txn_name,
            FILE_WRITE_DATA | FILE_WRITE_ATTRIBUTES | FILE_READ_ATTRIBUTES | DELETE,
            0,
            FILE_CREATE,
            FILE_NON_DIRECTORY_FILE,
        ) {
            Ok(h) => h,
            Err(err) => {
                mark_delete_on_close(stage.raw()).map_err(|_| FsError::RecoveryRequired)?;
                return Err(err);
            }
        };
        if let Err(err) = write_and_flush(txn.raw(), &txn_bytes) {
            let s_del = mark_delete_on_close(stage.raw());
            let t_del = mark_delete_on_close(txn.raw());
            if s_del.is_err() || t_del.is_err() {
                return Err(FsError::RecoveryRequired);
            }
            return Err(err);
        }
        let (parent_now, parent_attrs, _) = match query_handle_meta(parent.handle.raw()) {
            Ok(meta) => meta,
            Err(_) => {
                let _ = mark_delete_on_close(stage.raw());
                let _ = mark_delete_on_close(txn.raw());
                return Err(FsError::RecoveryRequired);
            }
        };
        if (parent_attrs & FILE_ATTRIBUTE_DIRECTORY) == 0
            || parent_now != parent.identity
            || self.verify_alive().is_err()
        {
            let s_del = mark_delete_on_close(stage.raw());
            let t_del = mark_delete_on_close(txn.raw());
            if s_del.is_err() || t_del.is_err() {
                return Err(FsError::RecoveryRequired);
            }
            return Err(FsError::StaleWorkspace);
        }
        if let Some((target_handle, target_id, target_size)) = existing {
            let (cur_id, cur_attrs, cur_size) = match query_handle_meta(target_handle.raw()) {
                Ok(meta) => meta,
                Err(_) => {
                    let _ = mark_delete_on_close(stage.raw());
                    let _ = mark_delete_on_close(txn.raw());
                    return Err(FsError::RecoveryRequired);
                }
            };
            if cur_id != target_id
                || (cur_attrs & FILE_ATTRIBUTE_DIRECTORY) != 0
                || cur_size != target_size
            {
                let s_del = mark_delete_on_close(stage.raw());
                let t_del = mark_delete_on_close(txn.raw());
                if s_del.is_err() || t_del.is_err() {
                    return Err(FsError::RecoveryRequired);
                }
                return Err(FsError::StaleWorkspace);
            }
            if let Err(err) =
                rename_relative(target_handle.raw(), parent.handle.raw(), &bak_name, false)
            {
                let s_del = mark_delete_on_close(stage.raw());
                let t_del = mark_delete_on_close(txn.raw());
                if s_del.is_err() || t_del.is_err() {
                    return Err(FsError::RecoveryRequired);
                }
                return Err(err);
            }
            if let Some(barrier) = after_backup_rename {
                barrier(&parent);
            }
            if let Err(err) =
                rename_relative(stage.raw(), parent.handle.raw(), &parent.leaf_name, false)
            {
                if rename_relative(
                    target_handle.raw(),
                    parent.handle.raw(),
                    &parent.leaf_name,
                    false,
                )
                .is_err()
                {
                    return Err(FsError::RecoveryRequired);
                }
                let (restored_id, restored_attrs, restored_size) =
                    match query_handle_meta(target_handle.raw()) {
                        Ok(meta) => meta,
                        Err(_) => return Err(FsError::RecoveryRequired),
                    };
                if restored_id != target_id
                    || (restored_attrs & FILE_ATTRIBUTE_DIRECTORY) != 0
                    || restored_size != target_size
                {
                    return Err(FsError::RecoveryRequired);
                }
                if mark_delete_on_close(stage.raw()).is_err()
                    || mark_delete_on_close(txn.raw()).is_err()
                {
                    return Err(FsError::RecoveryRequired);
                }
                return Err(err);
            }
            if mark_delete_on_close(target_handle.raw()).is_err()
                || mark_delete_on_close(txn.raw()).is_err()
            {
                return Err(FsError::RecoveryRequired);
            }
            drop(target_handle);
            drop(txn);
        } else {
            if let Some(barrier) = after_backup_rename {
                barrier(&parent);
            }
            if let Err(err) =
                rename_relative(stage.raw(), parent.handle.raw(), &parent.leaf_name, false)
            {
                if mark_delete_on_close(stage.raw()).is_err()
                    || mark_delete_on_close(txn.raw()).is_err()
                {
                    return Err(FsError::RecoveryRequired);
                }
                return Err(err);
            }
            if mark_delete_on_close(txn.raw()).is_err() {
                return Err(FsError::RecoveryRequired);
            }
            drop(txn);
        }
        let (final_id, final_attrs, final_size) = query_handle_meta(stage.raw())?;
        if (final_attrs & FILE_ATTRIBUTE_DIRECTORY) != 0
            || final_id != stage_id
            || final_size != bytes.len() as u64
        {
            return Err(FsError::StaleWorkspace);
        }
        Ok(WriteOutput {
            revision: compute_identity_revision(final_id, bytes),
            identity: final_id,
        })
    }

    pub fn delete_file_if_revision(
        &self,
        path: &RelativePath,
        expected_revision: &Revision,
    ) -> Result<(), FsError> {
        self.delete_file_if_revision_internal(path, expected_revision, false)
    }

    fn delete_file_if_revision_internal(
        &self,
        path: &RelativePath,
        expected_revision: &Revision,
        allow_private: bool,
    ) -> Result<(), FsError> {
        let limit = read_limit(path.as_str()).min(MAX_READ_CAP_BYTES);
        let parent = self.pin_parent_impl(path, false, allow_private)?;
        if !list_parent_artifacts(parent.handle.raw(), &parent.leaf_name)?.is_empty() {
            return Err(FsError::RecoveryRequired);
        }
        let file = nt_open_segment(
            parent.handle.raw(),
            &parent.leaf_name,
            FILE_READ_DATA | FILE_READ_ATTRIBUTES | DELETE,
            0,
            FILE_OPEN,
            FILE_NON_DIRECTORY_FILE,
        )?;
        let current = read_from_handle(file.raw(), self.identity.volume_serial, limit)?;
        if &current.revision != expected_revision {
            return Err(FsError::RevisionConflict {
                expected: Some(expected_revision.clone()),
                actual: Some(current.revision),
            });
        }
        let (parent_now, parent_attrs, _) = query_handle_meta(parent.handle.raw())?;
        if (parent_attrs & FILE_ATTRIBUTE_DIRECTORY) == 0
            || parent_now != parent.identity
            || self.verify_alive().is_err()
        {
            return Err(FsError::StaleWorkspace);
        }
        mark_delete_on_close(file.raw())?;
        drop(file);
        match nt_open_segment(
            parent.handle.raw(),
            &parent.leaf_name,
            FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            FILE_OPEN,
            FILE_NON_DIRECTORY_FILE,
        ) {
            Err(FsError::NotFound) => Ok(()),
            Ok(reopened) => {
                let (reopened_id, _, _) = query_handle_meta(reopened.raw())?;
                if reopened_id == current.identity {
                    Err(FsError::SharingViolation)
                } else {
                    Ok(())
                }
            }
            Err(e) => Err(e),
        }
    }

    pub fn recover_write(&self, path: &RelativePath) -> Result<RecoveryOutcome, FsError> {
        let parent = self.pin_parent(path, false)?;
        let artifacts = list_parent_artifacts(parent.handle.raw(), &parent.leaf_name)?;
        if artifacts.is_empty() {
            return Ok(RecoveryOutcome::Clean);
        }
        let txn_name = txn_file_name(&parent.leaf_name);
        if !artifacts.iter().any(|name| name == &txn_name) {
            return Err(FsError::RecoveryRequired);
        }
        let txn_handle = nt_open_segment(
            parent.handle.raw(),
            &txn_name,
            FILE_READ_DATA | FILE_READ_ATTRIBUTES | DELETE,
            0,
            FILE_OPEN,
            FILE_NON_DIRECTORY_FILE,
        )?;
        let txn_read = read_from_handle(txn_handle.raw(), self.identity.volume_serial, 64 * 1024)
            .map_err(|_| FsError::RecoveryRequired)?;
        let record = TransactionRecord::decode(&txn_read.bytes).ok_or(FsError::RecoveryRequired)?;
        let (orig_expected, stage_expected_id) = record
            .validate_for(self.identity, parent.identity, path, &parent.leaf_name)
            .ok_or(FsError::RecoveryRequired)?;
        if artifacts.iter().any(|name| {
            name != &txn_name && name != &record.stage_name && name != &record.backup_name
        }) {
            return Err(FsError::RecoveryRequired);
        }
        let bak_handle = if artifacts.iter().any(|name| name == &record.backup_name) {
            let h = nt_open_segment(
                parent.handle.raw(),
                &record.backup_name,
                FILE_READ_ATTRIBUTES | DELETE,
                0,
                FILE_OPEN,
                FILE_NON_DIRECTORY_FILE,
            )?;
            let (bak_id, bak_attrs, bak_size) = query_handle_meta(h.raw())?;
            let Some((orig_id, orig_size)) = orig_expected else {
                return Err(FsError::RecoveryRequired);
            };
            if (bak_attrs & FILE_ATTRIBUTE_DIRECTORY) != 0
                || bak_id != orig_id
                || bak_size != orig_size
            {
                return Err(FsError::RecoveryRequired);
            }
            Some(h)
        } else {
            None
        };
        let stage_handle = if artifacts.iter().any(|name| name == &record.stage_name) {
            let h = nt_open_segment(
                parent.handle.raw(),
                &record.stage_name,
                FILE_READ_ATTRIBUTES | DELETE,
                0,
                FILE_OPEN,
                FILE_NON_DIRECTORY_FILE,
            )?;
            let (stg_id, stg_attrs, stg_size) = query_handle_meta(h.raw())?;
            if (stg_attrs & FILE_ATTRIBUTE_DIRECTORY) != 0
                || stg_id != stage_expected_id
                || stg_size != record.stage_size
            {
                return Err(FsError::RecoveryRequired);
            }
            Some(h)
        } else {
            None
        };
        let target_open = nt_open_segment(
            parent.handle.raw(),
            &parent.leaf_name,
            FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            FILE_OPEN,
            FILE_NON_DIRECTORY_FILE,
        );
        match target_open {
            Err(FsError::NotFound) => {
                if let Some((orig_id, orig_size)) = orig_expected {
                    let bak = bak_handle.ok_or(FsError::RecoveryRequired)?;
                    rename_relative(bak.raw(), parent.handle.raw(), &parent.leaf_name, false)?;
                    let (restored_id, restored_attrs, restored_size) =
                        query_handle_meta(bak.raw())?;
                    if (restored_attrs & FILE_ATTRIBUTE_DIRECTORY) != 0
                        || restored_id != orig_id
                        || restored_size != orig_size
                    {
                        return Err(FsError::RecoveryRequired);
                    }
                    if let Some(stg) = stage_handle {
                        mark_delete_on_close(stg.raw())?;
                    }
                    mark_delete_on_close(txn_handle.raw())?;
                    Ok(RecoveryOutcome::RolledBackToBackup)
                } else {
                    if bak_handle.is_some() {
                        return Err(FsError::RecoveryRequired);
                    }
                    if let Some(stg) = stage_handle {
                        mark_delete_on_close(stg.raw())?;
                    }
                    mark_delete_on_close(txn_handle.raw())?;
                    Ok(RecoveryOutcome::CleanedResidualArtifacts)
                }
            }
            Ok(target_handle) => {
                let (target_id, target_attrs, target_size) =
                    query_handle_meta(target_handle.raw())?;
                if (target_attrs & FILE_ATTRIBUTE_DIRECTORY) != 0 {
                    return Err(FsError::IsADirectory);
                }
                let is_committed_stage = target_id == stage_expected_id
                    && target_size == record.stage_size
                    && stage_handle.is_none();
                let is_original_target = orig_expected.is_some_and(|(orig_id, orig_size)| {
                    target_id == orig_id && target_size == orig_size
                }) && bak_handle.is_none();
                if !is_committed_stage && !is_original_target {
                    return Err(FsError::RecoveryRequired);
                }
                if let Some(bak) = bak_handle {
                    mark_delete_on_close(bak.raw())?;
                }
                if let Some(stg) = stage_handle {
                    mark_delete_on_close(stg.raw())?;
                }
                mark_delete_on_close(txn_handle.raw())?;
                Ok(RecoveryOutcome::CleanedResidualArtifacts)
            }
            Err(e) => Err(e),
        }
    }
}

fn read_from_handle(
    handle: HANDLE,
    expected_vol: u64,
    limit: usize,
) -> Result<ReadOutput, FsError> {
    let capped_limit = limit.min(MAX_READ_CAP_BYTES);
    let (identity, attrs, size) = query_handle_meta(handle)?;
    if (attrs & FILE_ATTRIBUTE_DIRECTORY) != 0 {
        return Err(FsError::IsADirectory);
    }
    if identity.volume_serial != expected_vol {
        return Err(FsError::LinkNotAllowed);
    }
    if size > capped_limit as u64 {
        return Err(FsError::FileTooLarge {
            size,
            limit: capped_limit,
        });
    }
    let initial_cap = (size as usize)
        .min(capped_limit)
        .min(INITIAL_READ_CAP_BYTES);
    let mut bytes = Vec::with_capacity(initial_cap);
    let mut chunk = [0u8; 64 * 1024];
    loop {
        let mut read = 0u32;
        if unsafe {
            ReadFile(
                handle,
                chunk.as_mut_ptr(),
                chunk.len() as u32,
                &mut read,
                null_mut(),
            )
        } == 0
        {
            return Err(map_win32_error(unsafe { GetLastError() }));
        }
        if read == 0 {
            break;
        }
        let new_len = bytes
            .len()
            .checked_add(read as usize)
            .ok_or(FsError::FileTooLarge {
                size: u64::MAX,
                limit: capped_limit,
            })?;
        if new_len > capped_limit {
            return Err(FsError::FileTooLarge {
                size: new_len as u64,
                limit: capped_limit,
            });
        }
        bytes
            .try_reserve(read as usize)
            .map_err(|_| FsError::FileTooLarge {
                size: new_len as u64,
                limit: capped_limit,
            })?;
        bytes.extend_from_slice(&chunk[..read as usize]);
    }
    let (after_id, after_attrs, after_size) = query_handle_meta(handle)?;
    if (after_attrs & FILE_ATTRIBUTE_DIRECTORY) != 0
        || after_id != identity
        || after_size != bytes.len() as u64
    {
        return Err(FsError::StaleWorkspace);
    }
    let revision = compute_identity_revision(identity, &bytes);
    Ok(ReadOutput {
        bytes,
        revision,
        identity,
    })
}

fn read_pdf_from_handle(
    handle: HANDLE,
    expected_vol: u64,
    limit: usize,
) -> Result<ReadOutput, FsError> {
    let capped_limit = limit.min(MAX_READ_CAP_BYTES);
    let (identity, attrs, size) = query_handle_meta(handle)?;
    if (attrs & FILE_ATTRIBUTE_DIRECTORY) != 0 {
        return Err(FsError::IsADirectory);
    }
    if identity.volume_serial != expected_vol {
        return Err(FsError::LinkNotAllowed);
    }
    if size > capped_limit as u64 {
        return Err(FsError::FileTooLarge {
            size,
            limit: capped_limit,
        });
    }
    if size < 5 {
        return Err(FsError::InvalidPath);
    }
    let mut chunk = [0u8; 64 * 1024];
    let mut read = 0u32;
    if unsafe {
        ReadFile(
            handle,
            chunk.as_mut_ptr(),
            chunk.len() as u32,
            &mut read,
            null_mut(),
        )
    } == 0
    {
        return Err(map_win32_error(unsafe { GetLastError() }));
    }
    if (read as usize) < 5 || !chunk[..read as usize].starts_with(b"%PDF-") {
        return Err(FsError::InvalidPath);
    }
    let initial_cap = (size as usize).min(capped_limit);
    let mut bytes = Vec::with_capacity(initial_cap.min(INITIAL_READ_CAP_BYTES));
    bytes.extend_from_slice(&chunk[..read as usize]);
    while bytes.len() < size as usize {
        let mut read = 0u32;
        if unsafe {
            ReadFile(
                handle,
                chunk.as_mut_ptr(),
                chunk.len() as u32,
                &mut read,
                null_mut(),
            )
        } == 0
        {
            return Err(map_win32_error(unsafe { GetLastError() }));
        }
        if read == 0 {
            break;
        }
        let new_len = bytes
            .len()
            .checked_add(read as usize)
            .ok_or(FsError::FileTooLarge {
                size: u64::MAX,
                limit: capped_limit,
            })?;
        if new_len > capped_limit {
            return Err(FsError::FileTooLarge {
                size: new_len as u64,
                limit: capped_limit,
            });
        }
        bytes
            .try_reserve(read as usize)
            .map_err(|_| FsError::FileTooLarge {
                size: new_len as u64,
                limit: capped_limit,
            })?;
        bytes.extend_from_slice(&chunk[..read as usize]);
    }
    let (after_id, after_attrs, after_size) = query_handle_meta(handle)?;
    if (after_attrs & FILE_ATTRIBUTE_DIRECTORY) != 0
        || after_id != identity
        || after_size != bytes.len() as u64
    {
        return Err(FsError::StaleWorkspace);
    }
    let revision = compute_identity_revision(identity, &bytes);
    Ok(ReadOutput {
        bytes,
        revision,
        identity,
    })
}

fn write_and_flush(handle: HANDLE, bytes: &[u8]) -> Result<(), FsError> {
    write_and_flush_with_cancel(handle, bytes, None)
}

fn write_and_flush_cancelable(
    handle: HANDLE,
    bytes: &[u8],
    cancelled: &AtomicBool,
) -> Result<(), FsError> {
    write_and_flush_with_cancel(handle, bytes, Some(cancelled))
}

fn write_and_flush_with_cancel(
    handle: HANDLE,
    mut bytes: &[u8],
    cancelled: Option<&AtomicBool>,
) -> Result<(), FsError> {
    while !bytes.is_empty() {
        if cancelled.is_some_and(|flag| flag.load(Ordering::Acquire)) {
            return Err(FsError::Cancelled);
        }
        let to_write = bytes.len().min(1024 * 1024) as u32;
        let mut written = 0u32;
        if unsafe { WriteFile(handle, bytes.as_ptr(), to_write, &mut written, null_mut()) } == 0 {
            return Err(map_win32_error(unsafe { GetLastError() }));
        }
        if written == 0 {
            return Err(FsError::Io(0));
        }
        bytes = &bytes[written as usize..];
    }
    if cancelled.is_some_and(|flag| flag.load(Ordering::Acquire)) {
        return Err(FsError::Cancelled);
    }
    if unsafe { FlushFileBuffers(handle) } == 0 {
        return Err(map_win32_error(unsafe { GetLastError() }));
    }
    Ok(())
}

impl TrustedRoot {
    /// Bounded compile-tree listing through the trusted root handle. Generated
    /// trees are pruned before descent; links/reparse points remain fail-closed.
    pub fn list_compile_entries(
        &self,
        max_depth: usize,
        max_entries: usize,
    ) -> Result<Vec<FileEntry>, FsError> {
        self.verify_alive()?;
        let depth_limit = max_depth.min(MAX_DIRECTORY_DEPTH);
        let entry_limit = max_entries.min(MAX_LIST_ENTRIES);
        let root_dup = Self::open_dup_root(self.handle.raw(), self.identity)?;
        let mut stack = vec![(root_dup, None::<RelativePath>, 0usize)];
        let mut entries = Vec::new();
        let mut aligned_buf = vec![0u64; DIR_BUFFER_BYTES / 8];

        while let Some((dir_handle, prefix, depth)) = stack.pop() {
            let mut first = true;
            loop {
                let class = if first {
                    FileIdBothDirectoryRestartInfo
                } else {
                    FileIdBothDirectoryInfo
                };
                first = false;
                let ok = unsafe {
                    GetFileInformationByHandleEx(
                        dir_handle.raw(),
                        class,
                        aligned_buf.as_mut_ptr().cast(),
                        DIR_BUFFER_BYTES as u32,
                    )
                };
                if ok == 0 {
                    let error = unsafe { GetLastError() };
                    if error == ERROR_NO_MORE_FILES {
                        break;
                    }
                    return Err(map_win32_error(error));
                }
                let bytes = unsafe {
                    std::slice::from_raw_parts(aligned_buf.as_ptr().cast::<u8>(), DIR_BUFFER_BYTES)
                };
                for record in parse_dir_buffer_raw(bytes, true)? {
                    if is_any_recovery_artifact(&record.name)
                        || record.name.eq_ignore_ascii_case(".git")
                        || record.name.eq_ignore_ascii_case("node_modules")
                        || (prefix.is_none() && record.name.eq_ignore_ascii_case("output"))
                    {
                        continue;
                    }
                    let relative = match &prefix {
                        Some(parent) => format!("{parent}/{}", record.name),
                        None => record.name.clone(),
                    };
                    let path = RelativePath::parse(&relative).map_err(|_| FsError::InvalidPath)?;
                    if entries.len() >= entry_limit {
                        return Err(FsError::TreeTooLarge);
                    }

                    if record.is_dir {
                        let child_depth = depth.checked_add(1).ok_or(FsError::TreeTooDeep)?;
                        if child_depth > depth_limit {
                            return Err(FsError::TreeTooDeep);
                        }
                        let child = nt_open_segment(
                            dir_handle.raw(),
                            &record.name,
                            FILE_LIST_DIRECTORY | FILE_TRAVERSE | FILE_READ_ATTRIBUTES,
                            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                            FILE_OPEN,
                            FILE_DIRECTORY_FILE | FILE_OPEN_FOR_BACKUP_INTENT,
                        )?;
                        let (identity, attributes, _) = query_handle_meta(child.raw())?;
                        if (attributes & FILE_ATTRIBUTE_DIRECTORY) == 0
                            || identity.volume_serial != self.identity.volume_serial
                        {
                            return Err(FsError::LinkNotAllowed);
                        }
                        entries.push(FileEntry {
                            path: path.clone(),
                            kind: FileKind::Directory,
                        });
                        stack.push((child, Some(path), child_depth));
                    } else {
                        entries.push(FileEntry {
                            path,
                            kind: FileKind::File,
                        });
                    }
                }
            }
        }
        entries.sort_by(|left, right| left.path.as_str().cmp(right.path.as_str()));
        Ok(entries)
    }

    /// Reads one workspace-relative file through pinned parent and leaf handles.
    /// `read_from_handle` checks size before allocation and caps subsequent growth.
    pub fn read_file_bounded(
        &self,
        path: &RelativePath,
        maximum: usize,
    ) -> Result<ReadOutput, FsError> {
        let parent = self.pin_parent(path, false)?;
        if !list_parent_artifacts(parent.handle.raw(), &parent.leaf_name)?.is_empty() {
            return Err(FsError::RecoveryRequired);
        }
        let file = nt_open_segment(
            parent.handle.raw(),
            &parent.leaf_name,
            FILE_READ_DATA | FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ,
            FILE_OPEN,
            FILE_NON_DIRECTORY_FILE,
        )?;
        read_from_handle(file.raw(), self.identity.volume_serial, maximum)
    }
}

fn valid_recovery_token(token: &str) -> bool {
    token.len() == 36
        && token.bytes().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => byte == b'-',
            _ => byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'),
        })
}

fn final_path_from_handle(handle: HANDLE) -> Result<std::path::PathBuf, FsError> {
    let required = unsafe { GetFinalPathNameByHandleW(handle, null_mut(), 0, 0) };
    if required == 0 {
        return Err(map_win32_error(unsafe { GetLastError() }));
    }
    let mut buffer = vec![0u16; required as usize + 1];
    let length =
        unsafe { GetFinalPathNameByHandleW(handle, buffer.as_mut_ptr(), buffer.len() as u32, 0) };
    if length == 0 || length as usize >= buffer.len() {
        return Err(map_win32_error(unsafe { GetLastError() }));
    }
    let raw = String::from_utf16(&buffer[..length as usize]).map_err(|_| FsError::InvalidPath)?;
    let normalized = if let Some(unc) = raw.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{unc}")
    } else {
        raw
    };
    Ok(std::path::PathBuf::from(normalized))
}

fn shell_recycle(path: &Path) -> Result<(), FsError> {
    const FO_DELETE: u32 = 3;
    const FOF_SILENT: u16 = 0x0004;
    const FOF_NOCONFIRMATION: u16 = 0x0010;
    const FOF_ALLOWUNDO: u16 = 0x0040;
    const FOF_NOERRORUI: u16 = 0x0400;

    let mut source: Vec<u16> = path.as_os_str().encode_wide().collect();
    source.push(0);
    source.push(0);
    let mut operation = ShFileOpStructW {
        hwnd: null_mut(),
        w_func: FO_DELETE,
        p_from: source.as_ptr(),
        p_to: null(),
        flags: FOF_SILENT | FOF_NOCONFIRMATION | FOF_ALLOWUNDO | FOF_NOERRORUI,
        any_operations_aborted: 0,
        name_mappings: null_mut(),
        progress_title: null(),
    };
    let result = unsafe { SHFileOperationW(&mut operation) };
    if result != 0 {
        return Err(FsError::Io(result as u32));
    }
    if operation.any_operations_aborted != 0 {
        return Err(FsError::RecoveryRequired);
    }
    Ok(())
}

fn quote_windows_argument(value: &str) -> String {
    let mut output = String::from("\"");
    let mut backslashes = 0usize;
    for character in value.chars() {
        if character == '\\' {
            backslashes += 1;
            continue;
        }
        if character == '"' {
            output.push_str(&"\\".repeat(backslashes * 2 + 1));
            output.push('"');
        } else {
            output.push_str(&"\\".repeat(backslashes));
            output.push(character);
        }
        backslashes = 0;
    }
    output.push_str(&"\\".repeat(backslashes * 2));
    output.push('"');
    output
}

#[cfg(test)]
#[path = "../../tests/unit/windows_files.rs"]
mod tests;
