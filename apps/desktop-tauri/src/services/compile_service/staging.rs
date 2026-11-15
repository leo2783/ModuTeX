// SPDX-License-Identifier: Apache-2.0
//! Private compile staging directory ownership, source overlay application,
//! bounded artifact reading, and configured compile output assembly.

use std::{
    collections::{HashMap, HashSet},
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::{Path, PathBuf},
};

use crate::{
    compile_config::CompileWorkspaceConfig,
    schemas::protocol::{
        CompileRequest, CompileResult, DocumentId, DocumentVersion, FileEntry, FileKind, RunId,
        MAX_LOG_CHARACTERS, MAX_PDF_BYTES,
    },
    services::{
        filesystem::{CompileInputSnapshot, CompileOutputFile, CompileOutputKind},
        synctex_artifact,
    },
    shared::relative_path::RelativePath,
};

use super::{
    lock_recover,
    profiles::{entry_stem, ResolvedProfile},
    CompileServiceError, RunControl, MAX_COMPILE_DEPTH, MAX_COMPILE_ENTRIES,
    MAX_COMPILE_FILE_BYTES, MAX_COMPILE_OUTPUT_LOG_BYTES, MAX_COMPILE_TOTAL_BYTES,
    MAX_OVERLAY_FILES,
};

/// Host-owned unsaved entry bytes. The filesystem admission seam binds its
/// document identity/version while retaining the saved on-disk revision.
#[derive(Clone, Debug)]
pub(crate) struct CompileOverlayEntry {
    pub(crate) document_id: DocumentId,
    pub(crate) document_version: DocumentVersion,
    pub(crate) bytes: Vec<u8>,
}

/// Host-owned unsaved bytes for an auxiliary workspace-relative input.
#[derive(Clone, Debug)]
pub(crate) struct CompileOverlayFile {
    pub(crate) path: RelativePath,
    pub(crate) bytes: Vec<u8>,
}

/// Kept separate from CompileRequest until a strict IPC contract change is
/// reviewed. Bytes are staged in the private compile directory only.
#[derive(Clone, Debug, Default)]
pub(crate) struct CompileOverlay {
    pub(crate) entry: Option<CompileOverlayEntry>,
    pub(crate) files: Vec<CompileOverlayFile>,
}

#[derive(Clone, Debug)]
pub(super) struct CompileSourceFile {
    pub(super) path: RelativePath,
    pub(super) bytes: Vec<u8>,
}

#[derive(Clone, Debug)]
pub(super) struct CompileSourceSnapshot {
    pub(super) entries: Vec<FileEntry>,
    pub(super) files: Vec<CompileSourceFile>,
}

pub(super) struct CompileLayout {
    pub(super) input: PathBuf,
    pub(super) output: PathBuf,
    pub(super) temporary: PathBuf,
}

pub(super) struct OwnedCompileDirectory {
    pub(super) root: PathBuf,
    pub(super) input: PathBuf,
    pub(super) output: PathBuf,
    pub(super) temporary: PathBuf,
    pub(super) marker: PathBuf,
    pub(super) run_id: String,
    pub(super) allow_cleanup: bool,
    pub(super) removed: bool,
}

impl OwnedCompileDirectory {
    pub(super) fn create(base: &Path, run_id: &RunId) -> Result<Self, io::Error> {
        let root = base.join(format!("modutex-compile-{}", run_id.as_str()));
        fs::create_dir(&root)?;
        let result = Self {
            input: root.join("input"),
            output: root.join("output"),
            temporary: root.join("tmp"),
            marker: root.join(".modutex-owner"),
            root,
            run_id: run_id.as_str().to_owned(),
            allow_cleanup: true,
            removed: false,
        };
        result.create_owned_child(&result.input.clone())?;
        result.create_owned_child(&result.output.clone())?;
        result.create_owned_child(&result.temporary.clone())?;
        let mut marker = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&result.marker)?;
        marker.write_all(result.run_id.as_bytes())?;
        marker.sync_all()?;
        Ok(result)
    }

    pub(super) fn create_owned_child(&self, path: &Path) -> Result<(), io::Error> {
        fs::create_dir(path)?;
        let metadata = fs::symlink_metadata(path)?;
        if crate::platform::file_identity::is_symlink_or_reparse(&metadata) || !metadata.is_dir() {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "private compile directory was replaced",
            ));
        }
        Ok(())
    }

    pub(super) fn layout(&self) -> CompileLayout {
        CompileLayout {
            input: self.input.clone(),
            output: self.output.clone(),
            temporary: self.temporary.clone(),
        }
    }

    pub(super) fn remove_owned(&mut self) -> Result<(), String> {
        if self.removed {
            return Ok(());
        }
        if !self.allow_cleanup {
            return Err("process cleanup is not proven".to_owned());
        }
        let metadata = fs::symlink_metadata(&self.root)
            .map_err(|_| "private compile directory is unavailable".to_owned())?;
        if crate::platform::file_identity::is_symlink_or_reparse(&metadata) || !metadata.is_dir() {
            return Err("private compile directory identity is unsafe".to_owned());
        }
        let marker_meta = fs::symlink_metadata(&self.marker)
            .map_err(|_| "private compile ownership marker is missing".to_owned())?;
        if crate::platform::file_identity::is_symlink_or_reparse(&marker_meta)
            || !marker_meta.is_file()
        {
            return Err("private compile ownership marker is unsafe".to_owned());
        }
        let marker = read_regular_bounded(&self.marker, self.run_id.len())
            .map_err(|_| "private compile ownership marker cannot be read".to_owned())?;
        if marker != self.run_id.as_bytes() {
            return Err("private compile ownership marker does not match".to_owned());
        }
        remove_tree_no_follow(&self.root)
            .map_err(|_| "private compile directory cleanup failed".to_owned())?;
        self.removed = true;
        Ok(())
    }
}

impl Drop for OwnedCompileDirectory {
    fn drop(&mut self) {
        if self.allow_cleanup && !self.removed {
            let _ = self.remove_owned();
        }
    }
}

pub(super) fn remove_tree_no_follow(path: &Path) -> io::Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    if crate::platform::file_identity::is_symlink_or_reparse(&metadata) {
        return if metadata.is_dir() {
            fs::remove_dir(path)
        } else {
            fs::remove_file(path)
        };
    }
    if metadata.is_dir() {
        for entry in fs::read_dir(path)? {
            remove_tree_no_follow(&entry?.path())?;
        }
        fs::remove_dir(path)
    } else {
        fs::remove_file(path)
    }
}

pub(super) fn stage_snapshot(
    input_root: &Path,
    snapshot: &CompileSourceSnapshot,
) -> Result<(), io::Error> {
    for entry in &snapshot.entries {
        if entry.kind == FileKind::Directory {
            create_relative_directory(input_root, entry.path.as_str())?;
        }
    }
    for file in &snapshot.files {
        let destination = relative_join(input_root, file.path.as_str());
        if let Some(parent) = destination.parent() {
            create_directory_chain(input_root, parent)?;
        }
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&destination)?;
        output.write_all(&file.bytes)?;
    }
    Ok(())
}

pub(super) fn create_relative_directory(root: &Path, relative: &str) -> Result<(), io::Error> {
    create_directory_chain(root, &relative_join(root, relative))
}

pub(super) fn create_directory_chain(root: &Path, directory: &Path) -> Result<(), io::Error> {
    let relative = directory.strip_prefix(root).map_err(|_| {
        io::Error::new(
            io::ErrorKind::PermissionDenied,
            "stage path escaped its root",
        )
    })?;
    let mut current = root.to_path_buf();
    for component in relative.components() {
        let std::path::Component::Normal(segment) = component else {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid staged directory component",
            ));
        };
        current.push(segment);
        match fs::symlink_metadata(&current) {
            Ok(metadata)
                if !crate::platform::file_identity::is_symlink_or_reparse(&metadata)
                    && metadata.is_dir() => {}
            Ok(_) => {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "staged directory is not a private directory",
                ))
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                fs::create_dir(&current)?;
                let metadata = fs::symlink_metadata(&current)?;
                if crate::platform::file_identity::is_symlink_or_reparse(&metadata)
                    || !metadata.is_dir()
                {
                    return Err(io::Error::new(
                        io::ErrorKind::PermissionDenied,
                        "staged directory was replaced",
                    ));
                }
            }
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

pub(super) fn relative_join(root: &Path, relative: &str) -> PathBuf {
    let mut path = root.to_path_buf();
    for segment in relative.split('/') {
        path.push(segment);
    }
    path
}

pub(super) fn snapshot_matches_ticket(
    control: &RunControl,
    snapshot: &CompileInputSnapshot,
) -> bool {
    let Some(entry) = snapshot
        .files
        .iter()
        .find(|file| file.path == control.request.entry_path)
    else {
        return false;
    };
    let ticket_guard = lock_recover(&control.ticket);
    let Some(ticket) = ticket_guard.as_ref() else {
        return false;
    };
    entry.bytes == ticket.entry_snapshot() && entry.revision == control.identity.saved_revision
}

pub(super) fn validate_overlay(
    request: &CompileRequest,
    overlay: &CompileOverlay,
) -> Result<(), CompileServiceError> {
    let count = overlay
        .files
        .len()
        .checked_add(usize::from(overlay.entry.is_some()))
        .ok_or(CompileServiceError::InvalidRequest(
            "compile overlay file count overflow",
        ))?;
    if count > MAX_OVERLAY_FILES {
        return Err(CompileServiceError::InvalidRequest(
            "compile overlay contains too many files",
        ));
    }
    if let Some(entry) = &overlay.entry {
        if entry.document_id != request.document_id
            || entry.document_version != request.document_version
            || entry.bytes.len() > MAX_COMPILE_FILE_BYTES
        {
            return Err(CompileServiceError::InvalidRequest(
                "entry overlay identity or size does not match the request",
            ));
        }
    }
    let mut names = HashSet::new();
    if overlay.entry.is_some() {
        names.insert(request.entry_path.as_str().to_lowercase());
    }
    let mut total = overlay
        .entry
        .as_ref()
        .map_or(0usize, |entry| entry.bytes.len());
    for file in &overlay.files {
        let folded = file.path.as_str().to_lowercase();
        if file.path == request.entry_path && overlay.entry.is_none() {
            return Err(CompileServiceError::InvalidRequest(
                "entry overlay must be bound to document identity and version",
            ));
        }
        if !valid_compile_overlay_path(&file.path)
            || file.bytes.len() > MAX_COMPILE_FILE_BYTES
            || !names.insert(folded)
        {
            return Err(CompileServiceError::InvalidRequest(
                "compile overlay path is unsafe, repeated, or too large",
            ));
        }
        total = total
            .checked_add(file.bytes.len())
            .ok_or(CompileServiceError::InvalidRequest(
                "compile overlay total size overflow",
            ))?;
        if total > MAX_COMPILE_TOTAL_BYTES {
            return Err(CompileServiceError::InvalidRequest(
                "compile overlay exceeds the total input limit",
            ));
        }
    }
    if total > MAX_COMPILE_TOTAL_BYTES {
        return Err(CompileServiceError::InvalidRequest(
            "compile overlay exceeds the total input limit",
        ));
    }
    Ok(())
}

pub(super) fn valid_compile_overlay_path(path: &RelativePath) -> bool {
    // The snapshot's directory depth is bounded independently of the generic
    // RelativePath limit. A file may be one segment below the deepest allowed
    // directory, but an overlay must not introduce a deeper staged tree.
    if path.as_str().split('/').count() > MAX_COMPILE_DEPTH + 1 {
        return false;
    }
    let mut segments = path.as_str().split('/');
    let Some(first) = segments.next() else {
        return false;
    };
    if first.eq_ignore_ascii_case("output") {
        return false;
    }
    !std::iter::once(first).chain(segments).any(|segment| {
        let lower = segment.to_ascii_lowercase();
        lower == ".git"
            || lower == "node_modules"
            || lower.starts_with(".modutex-stage-")
            || lower.starts_with(".modutex-bak-")
            || lower.starts_with(".modutex-txn-")
    })
}

pub(super) fn apply_overlay(
    disk: &CompileInputSnapshot,
    request: &CompileRequest,
    overlay: &CompileOverlay,
) -> Result<CompileSourceSnapshot, CompileServiceError> {
    validate_overlay(request, overlay)?;
    let mut entries = disk.entries.clone();
    let mut files = disk
        .files
        .iter()
        .map(|file| CompileSourceFile {
            path: file.path.clone(),
            bytes: file.bytes.clone(),
        })
        .collect::<Vec<_>>();
    let mut file_indexes = files
        .iter()
        .enumerate()
        .map(|(index, file)| (file.path.clone(), index))
        .collect::<HashMap<_, _>>();
    let mut replacements: Vec<(&RelativePath, &[u8])> = Vec::new();
    if let Some(entry) = &overlay.entry {
        replacements.push((&request.entry_path, &entry.bytes));
    }
    for file in &overlay.files {
        replacements.push((&file.path, &file.bytes));
    }
    for (path, bytes) in replacements {
        let kind = entries
            .iter()
            .find(|entry| &entry.path == path)
            .map(|entry| entry.kind);
        match kind {
            Some(FileKind::Directory) => {
                return Err(CompileServiceError::InvalidRequest(
                    "compile overlay targets a directory",
                ))
            }
            Some(FileKind::File) => {
                let Some(index) = file_indexes.get(path).copied() else {
                    return Err(CompileServiceError::InvalidRequest(
                        "compile overlay file is absent from the pinned snapshot",
                    ));
                };
                files[index].bytes = bytes.to_vec();
            }
            None => {
                if path == &request.entry_path {
                    return Err(CompileServiceError::InvalidRequest(
                        "compile entry overlay is not a saved workspace file",
                    ));
                }
                if entries
                    .iter()
                    .any(|entry| entry.path.as_str().eq_ignore_ascii_case(path.as_str()))
                {
                    return Err(CompileServiceError::InvalidRequest(
                        "compile overlay path has an ambiguous case-insensitive collision",
                    ));
                }
                if let Some((parent_text, _)) = path.as_str().rsplit_once('/') {
                    let parent = RelativePath::parse(parent_text).map_err(|_| {
                        CompileServiceError::InvalidRequest(
                            "compile overlay parent path is invalid",
                        )
                    })?;
                    if !entries
                        .iter()
                        .any(|entry| entry.path == parent && entry.kind == FileKind::Directory)
                    {
                        return Err(CompileServiceError::InvalidRequest(
                            "new compile overlay files require an existing workspace directory",
                        ));
                    }
                }
                let index = files.len();
                file_indexes.insert(path.clone(), index);
                entries.push(FileEntry {
                    path: path.clone(),
                    kind: FileKind::File,
                });
                files.push(CompileSourceFile {
                    path: path.clone(),
                    bytes: bytes.to_vec(),
                });
            }
        }
    }
    let mut total = 0usize;
    for file in &files {
        total = total
            .checked_add(file.bytes.len())
            .ok_or(CompileServiceError::InvalidRequest(
                "effective compile snapshot size overflow",
            ))?;
        if file.bytes.len() > MAX_COMPILE_FILE_BYTES || total > MAX_COMPILE_TOTAL_BYTES {
            return Err(CompileServiceError::InvalidRequest(
                "effective compile snapshot exceeds configured limits",
            ));
        }
    }
    if entries.len() > MAX_COMPILE_ENTRIES {
        return Err(CompileServiceError::InvalidRequest(
            "effective compile snapshot contains too many entries",
        ));
    }
    entries.sort_by(|a, b| a.path.as_str().cmp(b.path.as_str()));
    files.sort_by(|a, b| a.path.as_str().cmp(b.path.as_str()));
    Ok(CompileSourceSnapshot { entries, files })
}

pub(super) fn compile_synctex_path(
    control: &RunControl,
    output_directory: &Path,
) -> Option<PathBuf> {
    let stem = match &control.profile {
        ResolvedProfile::Managed { .. } => entry_stem(&control.request.entry_path).ok()?,
        ResolvedProfile::System {
            synctex: true,
            output_stem,
            ..
        } => output_stem
            .as_ref()
            .and_then(|stem| stem.to_str())
            .map(str::to_owned)
            .or_else(|| entry_stem(&control.request.entry_path).ok())?,
        ResolvedProfile::System { synctex: false, .. } => return None,
    };
    Some(output_directory.join(format!("{stem}.synctex.gz")))
}

pub(super) fn read_compile_synctex<'a>(
    path: &Path,
    input_root: &Path,
    snapshot_paths: impl IntoIterator<Item = &'a RelativePath>,
    entry_path: &RelativePath,
) -> Option<Vec<u8>> {
    let metadata = fs::symlink_metadata(path).ok()?;
    if crate::platform::file_identity::is_symlink_or_reparse(&metadata)
        || !metadata.is_file()
        || metadata.len() < 2
        || metadata.len() > synctex_artifact::MAX_COMPRESSED_BYTES as u64
    {
        return None;
    }
    let bytes = read_regular_bounded(path, synctex_artifact::MAX_COMPRESSED_BYTES).ok()?;
    synctex_artifact::normalize_gzip(&bytes, input_root, snapshot_paths, entry_path)
}

pub(super) fn configured_compile_outputs(
    config: &CompileWorkspaceConfig,
    request: &CompileRequest,
    result: &CompileResult,
) -> Result<Vec<CompileOutputFile>, CompileServiceError> {
    let CompileResult::Success { pdf, log, .. } = result else {
        return Ok(Vec::new());
    };
    let stem = entry_stem(&request.entry_path)?;
    let join = |directory: &RelativePath, leaf: &str| {
        RelativePath::parse(&format!("{}/{}", directory.as_str(), leaf))
            .map_err(|_| CompileServiceError::InvalidConfiguration("compile output path"))
    };
    let pdf_path = match (&config.pdf_path, &config.output_dir) {
        (Some(path), _) => Some(path.clone()),
        (None, Some(directory)) => Some(join(directory, &format!("{stem}.pdf"))?),
        (None, None) => None,
    };
    let log_path = match (&config.log_path, &config.output_dir) {
        (Some(path), _) => Some(path.clone()),
        (None, Some(directory)) => Some(join(directory, &format!("{stem}.log"))?),
        (None, None) => None,
    };
    let mut outputs = Vec::with_capacity(2);
    if let Some(path) = pdf_path {
        outputs.push(CompileOutputFile {
            path,
            bytes: pdf.clone(),
            kind: CompileOutputKind::Pdf,
        });
    }
    if let Some(path) = log_path {
        let bytes = log.as_bytes();
        if bytes.len() > MAX_COMPILE_OUTPUT_LOG_BYTES {
            return Err(CompileServiceError::InvalidConfiguration(
                "compile log output limit",
            ));
        }
        outputs.push(CompileOutputFile {
            path,
            bytes: bytes.to_vec(),
            kind: CompileOutputKind::Log,
        });
    }
    Ok(outputs)
}

pub(super) fn read_regular_bounded(path: &Path, maximum: usize) -> Result<Vec<u8>, io::Error> {
    let mut file = open_read_no_follow(path)?;
    let metadata = file.metadata()?;
    if crate::platform::file_identity::is_symlink_or_reparse(&metadata) || !metadata.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "not a regular file",
        ));
    }
    if metadata.len() > maximum as u64 {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "file too large"));
    }
    let reserve = usize::try_from(metadata.len())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "file too large"))?;
    let mut bytes = Vec::new();
    bytes
        .try_reserve_exact(reserve)
        .map_err(|_| io::Error::new(io::ErrorKind::OutOfMemory, "allocation failed"))?;
    Read::by_ref(&mut file)
        .take(maximum as u64 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > maximum {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "byte limit exceeded",
        ));
    }
    if file.metadata()?.len() != bytes.len() as u64 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "file changed while being read",
        ));
    }
    Ok(bytes)
}

pub(super) fn open_read_no_follow(path: &Path) -> Result<File, io::Error> {
    use std::os::windows::fs::OpenOptionsExt;
    const FILE_SHARE_READ: u32 = 0x0000_0001;
    const FILE_SHARE_WRITE: u32 = 0x0000_0002;
    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
}

pub(super) enum EngineLog {
    Missing,
    Bytes(Vec<u8>),
    TooLarge,
    Failed,
}

pub(super) fn read_engine_log(path: &Path) -> EngineLog {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => EngineLog::Missing,
        Err(_) => EngineLog::Failed,
        Ok(metadata) if crate::platform::file_identity::is_symlink_or_reparse(&metadata) => {
            EngineLog::Failed
        }
        Ok(metadata) if metadata.len() > MAX_LOG_CHARACTERS as u64 => EngineLog::TooLarge,
        Ok(_) => match read_regular_bounded(path, MAX_LOG_CHARACTERS) {
            Ok(bytes) => EngineLog::Bytes(bytes),
            Err(error) if error.kind() == io::ErrorKind::InvalidData => EngineLog::TooLarge,
            Err(_) => EngineLog::Failed,
        },
    }
}

pub(super) enum PdfReadFailure {
    Missing,
    TooLarge,
    Invalid,
}

pub(super) fn read_compile_pdf(
    path: &Path,
    _output_directory: &Path,
) -> Result<Vec<u8>, PdfReadFailure> {
    let metadata = fs::symlink_metadata(path).map_err(|error| {
        if error.kind() == io::ErrorKind::NotFound {
            PdfReadFailure::Missing
        } else {
            PdfReadFailure::Invalid
        }
    })?;
    if crate::platform::file_identity::is_symlink_or_reparse(&metadata) || !metadata.is_file() {
        return Err(PdfReadFailure::Invalid);
    }
    if metadata.len() < 16 {
        return Err(PdfReadFailure::Invalid);
    }
    if metadata.len() > MAX_PDF_BYTES as u64 {
        return Err(PdfReadFailure::TooLarge);
    }
    let bytes = read_regular_bounded(path, MAX_PDF_BYTES).map_err(|error| {
        if error.kind() == io::ErrorKind::InvalidData {
            PdfReadFailure::TooLarge
        } else {
            PdfReadFailure::Invalid
        }
    })?;
    if bytes.len() < 16
        || !bytes.starts_with(b"%PDF-")
        || !bytes[bytes.len().saturating_sub(1024)..]
            .windows(5)
            .any(|window| window == b"%%EOF")
    {
        return Err(PdfReadFailure::Invalid);
    }
    Ok(bytes)
}
