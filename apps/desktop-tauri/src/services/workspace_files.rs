// SPDX-License-Identifier: Apache-2.0
//! G2 WorkspaceFiles operations layered on the existing FilesystemService
//! admission and Windows TrustedRoot handle primitives.

use std::sync::atomic::AtomicBool;

use crate::{
    schemas::protocol::{
        FileEntry, FileKind, OwnerId, Position, WorkspaceFileSearchHit, WorkspaceFileSearchResult,
        WorkspaceFileStat, WorkspaceId, MAX_READ_BYTES, MAX_SAFE_INTEGER, MAX_TEXT_UTF16,
    },
    services::filesystem::{FilesystemError, FilesystemService},
    shared::relative_path::RelativePath,
};

pub const MAX_WORKSPACE_SCAN_DEPTH: usize = 64;
pub const MAX_WORKSPACE_SCAN_ENTRIES: usize = 4096;
pub const MAX_WORKSPACE_SEARCH_RESULTS: usize = 256;
const MAX_WORKSPACE_SEARCH_BYTES: usize = 64 * 1024 * 1024;
const MAX_SEARCH_PREVIEW_CHARS: usize = 2048;

fn wire_stat(
    path: &RelativePath,
    kind: FileKind,
    size_bytes: u64,
) -> Result<WorkspaceFileStat, FilesystemError> {
    if size_bytes > MAX_SAFE_INTEGER {
        return Err(FilesystemError::FileTooLarge {
            size: size_bytes,
            limit: MAX_SAFE_INTEGER.min(usize::MAX as u64) as usize,
        });
    }
    Ok(WorkspaceFileStat {
        path: path.clone(),
        kind,
        size_bytes,
    })
}

impl FilesystemService {
    pub fn workspace_files_tree(
        &self,
        owner: &OwnerId,
        workspace_id: &WorkspaceId,
        cancelled: &AtomicBool,
    ) -> Result<Vec<FileEntry>, FilesystemError> {
        let access = self.workspace_file_read_access(owner, workspace_id)?;
        Ok(access.root.scan(
            None,
            MAX_WORKSPACE_SCAN_DEPTH,
            MAX_WORKSPACE_SCAN_ENTRIES,
            cancelled,
        )?)
    }

    pub fn workspace_files_scan(
        &self,
        owner: &OwnerId,
        workspace_id: &WorkspaceId,
        directory: &RelativePath,
        max_depth: usize,
        max_entries: usize,
        cancelled: &AtomicBool,
    ) -> Result<Vec<FileEntry>, FilesystemError> {
        let access = self.workspace_file_read_access(owner, workspace_id)?;
        Ok(access
            .root
            .scan(Some(directory), max_depth, max_entries, cancelled)?)
    }

    pub fn workspace_files_search(
        &self,
        owner: &OwnerId,
        workspace_id: &WorkspaceId,
        directory: Option<&RelativePath>,
        query: &str,
        max_results: usize,
        cancelled: &AtomicBool,
    ) -> Result<WorkspaceFileSearchResult, FilesystemError> {
        if query.is_empty() || query.encode_utf16().count() > MAX_TEXT_UTF16 {
            return Err(FilesystemError::InvalidPath(
                "invalid WorkspaceFiles search query".to_owned(),
            ));
        }
        if max_results == 0 || max_results > MAX_WORKSPACE_SEARCH_RESULTS {
            return Err(FilesystemError::ResourceExhausted);
        }
        let access = self.workspace_file_read_access(owner, workspace_id)?;
        let entries = access.root.scan(
            directory,
            MAX_WORKSPACE_SCAN_DEPTH,
            MAX_WORKSPACE_SCAN_ENTRIES,
            cancelled,
        )?;
        let needle = query.to_lowercase();
        let mut hits = Vec::new();
        let mut consumed = 0usize;
        let mut truncated = false;

        for entry in entries.iter().filter(|entry| entry.kind == FileKind::File) {
            if cancelled.load(std::sync::atomic::Ordering::Acquire) {
                return Err(FilesystemError::Cancelled);
            }
            if consumed >= MAX_WORKSPACE_SEARCH_BYTES {
                truncated = true;
                break;
            }
            let limit = MAX_READ_BYTES.min(MAX_WORKSPACE_SEARCH_BYTES - consumed);
            let read = match access.root.read_file_bounded(&entry.path, limit) {
                Ok(read) => read,
                Err(crate::platform::windows_files::FsError::FileTooLarge { .. }) => {
                    truncated = true;
                    continue;
                }
                Err(error) => return Err(error.into()),
            };
            consumed = consumed
                .checked_add(read.bytes.len())
                .ok_or(FilesystemError::ResourceExhausted)?;
            let Ok(text) = std::str::from_utf8(&read.bytes) else {
                continue;
            };
            for (index, line) in text.lines().enumerate() {
                if cancelled.load(std::sync::atomic::Ordering::Acquire) {
                    return Err(FilesystemError::Cancelled);
                }
                if line.to_lowercase().contains(&needle) {
                    let preview = line_preview(line);
                    let line_number = u64::try_from(index)
                        .ok()
                        .and_then(|value| value.checked_add(1))
                        .ok_or(FilesystemError::ResourceExhausted)?;
                    let line = Position::new(line_number)
                        .map_err(|_| FilesystemError::ResourceExhausted)?;
                    hits.push(WorkspaceFileSearchHit {
                        path: entry.path.clone(),
                        line,
                        preview,
                    });
                    if hits.len() == max_results {
                        truncated = true;
                        break;
                    }
                }
            }
            if hits.len() == max_results {
                break;
            }
        }
        Ok(WorkspaceFileSearchResult { hits, truncated })
    }

    pub fn workspace_file_stat(
        &self,
        owner: &OwnerId,
        workspace_id: &WorkspaceId,
        path: &RelativePath,
    ) -> Result<WorkspaceFileStat, FilesystemError> {
        let access = self.workspace_file_read_access(owner, workspace_id)?;
        let stat = access.root.stat(path)?;
        wire_stat(path, stat.kind, stat.size_bytes)
    }

    pub fn workspace_file_create(
        &self,
        owner: &OwnerId,
        workspace_id: &WorkspaceId,
        path: &RelativePath,
        bytes: &[u8],
    ) -> Result<WorkspaceFileStat, FilesystemError> {
        let access = self.workspace_file_write_access(owner, workspace_id)?;
        access.root.create_file(path, bytes)?;
        wire_stat(path, FileKind::File, bytes.len() as u64)
    }

    pub fn workspace_directory_create(
        &self,
        owner: &OwnerId,
        workspace_id: &WorkspaceId,
        path: &RelativePath,
    ) -> Result<WorkspaceFileStat, FilesystemError> {
        let access = self.workspace_file_write_access(owner, workspace_id)?;
        access.root.create_directory(path)?;
        wire_stat(path, FileKind::Directory, 0)
    }

    pub fn workspace_file_move(
        &self,
        owner: &OwnerId,
        workspace_id: &WorkspaceId,
        source: &RelativePath,
        destination: &RelativePath,
    ) -> Result<WorkspaceFileStat, FilesystemError> {
        let access = self.workspace_file_write_access(owner, workspace_id)?;
        let stat = access.root.move_path(source, destination)?;
        wire_stat(destination, stat.kind, stat.size_bytes)
    }

    pub fn workspace_file_copy(
        &self,
        owner: &OwnerId,
        workspace_id: &WorkspaceId,
        source: &RelativePath,
        destination: &RelativePath,
        cancelled: &AtomicBool,
    ) -> Result<WorkspaceFileStat, FilesystemError> {
        let access = self.workspace_file_write_access(owner, workspace_id)?;
        let stat = access.root.copy_path(source, destination, cancelled)?;
        wire_stat(destination, stat.kind, stat.size_bytes)
    }

    pub fn workspace_file_recycle(
        &self,
        owner: &OwnerId,
        workspace_id: &WorkspaceId,
        path: &RelativePath,
    ) -> Result<(), FilesystemError> {
        let access = self.workspace_file_write_access(owner, workspace_id)?;
        access.root.recycle_path(path)?;
        Ok(())
    }

    pub fn workspace_file_reveal(
        &self,
        owner: &OwnerId,
        workspace_id: &WorkspaceId,
        path: &RelativePath,
    ) -> Result<(), FilesystemError> {
        let access = self.workspace_file_read_access(owner, workspace_id)?;
        access.root.reveal_in_explorer(path)?;
        Ok(())
    }
}

fn line_preview(line: &str) -> String {
    line.chars().take(MAX_SEARCH_PREVIEW_CHARS).collect()
}
