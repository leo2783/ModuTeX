// SPDX-License-Identifier: Apache-2.0
//! Narrow Git service seam. This module builds argv; it does not launch processes.
//! 原生整合驗收由 process-tree adapter 執行；本模組的注入式單元測試不等同原生驗收：
//! 1. coordinator 綁定固定 Git executable 與 workspace root，renderer 不提供 root、exe 或 argv。
//! 2. owner/generation 撤銷或關窗時取消執行中的工作，並終止整棵 process tree。
//! 3. 驗證 Windows argv、Unicode、binary stdout、輸出上限、退出碼及 bounded stderr。
//! 4. 驗證 ADS、traversal、junction、symlink、reparse point 與路徑競態均遭拒。
//! 5. 真 temporary repo 驗證 stage-all、unborn unstage、rename、untracked discard、commit hooks。
//! 6. 驗證 non-repo、no HEAD、merge conflict、取消、逾時及超限皆回傳 typed errors。
//! 7. 驗證 -z 舊／新路徑、含換行路徑的契約拒絕，以及 HEAD stdout bytes 原樣保留。

use std::{
    collections::HashSet,
    error::Error,
    ffi::OsString,
    fmt,
    sync::atomic::{AtomicBool, Ordering},
};

use crate::{
    schemas::protocol::{OwnerId, WorkspaceId},
    shared::relative_path::RelativePath,
};

pub const MAX_GIT_PATHS: usize = 4096;
const MAX_PATH_ARGUMENT_BYTES: usize = 512 * 1024;
const MAX_STATUS_OUTPUT_BYTES: usize = 8 * 1024 * 1024;
const MAX_SHOW_HEAD_BYTES: usize = 32 * 1024 * 1024;
const MAX_COMMAND_OUTPUT_BYTES: usize = 1024 * 1024;
const MAX_USER_NAME_BYTES: usize = 4096;
const MAX_STDERR_BYTES: usize = 16 * 1024;
const MAX_ERROR_DETAIL_BYTES: usize = 512;
const MAX_COMMIT_MESSAGE_UTF16: usize = 32_767;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GitWorkspaceFailure {
    Closed,
    Cancelled,
    StaleGeneration,
    OwnerRevoked,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GitPathFailure {
    OutsideWorkspace,
    LinkOrReparsePoint,
    Directory,
    Unavailable,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GitPathIntent {
    Stage,
    Unstage,
    Discard,
}

/// Host-only workspace capability. The coordinator must bind it to a trusted
/// workspace root, owner, and generation. Path validation must reject links or
/// reparse points on every component; discard validation must reject directories.
/// For an absent path, validate its existing parents and prove it remains in-root.
pub trait GitWorkspaceCapability: Send + Sync {
    /// Host-minted identity; generation values may be reused by another workspace.
    fn workspace_id(&self) -> &WorkspaceId;
    fn owner(&self) -> &OwnerId;
    fn generation(&self) -> u64;
    fn check_current(&self) -> Result<(), GitWorkspaceFailure>;
    fn validate_path(
        &self,
        path: &RelativePath,
        intent: GitPathIntent,
    ) -> Result<(), GitPathFailure>;
    /// Used for empty-path stage/unstage (all); validate the full applicable tree.
    fn validate_all(&self, intent: GitPathIntent) -> Result<(), GitPathFailure>;
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GitRunnerError {
    Cancelled,
    Closed,
    StaleWorkspace,
    TimedOut,
    LaunchFailed,
    ProcessTreeFailed,
    OutputLimitExceeded,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GitOperation {
    ProbeRepository,
    ProbeHead,
    Status,
    Init,
    ShowHead,
    Stage,
    Unstage,
    Discard,
    CheckStaged,
    Commit,
    UserName,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum GitError {
    WorkspaceClosed,
    WorkspaceCancelled,
    StaleWorkspace,
    OwnerRevoked,
    PathOutsideWorkspace,
    LinkNotAllowed,
    PathIsDirectory,
    PathUnavailable,
    InvalidPath,
    InvalidPathEncoding,
    MalformedStatus,
    TooManyStatusEntries,
    TooManyPaths,
    PathArgumentLimitExceeded,
    DuplicatePath,
    PathsRequired,
    NotRepository,
    AlreadyRepository,
    NoHead,
    UnresolvedConflicts {
        count: usize,
    },
    NothingToCommit,
    PathNotChanged,
    RenameRequiresBothPaths,
    ConfirmationMismatch,
    ConfirmationAlreadyUsed,
    InvalidCommitMessage,
    InvalidUserName,
    InvalidGitOutput,
    OutputLimitExceeded,
    ProcessExitUnavailable,
    CommandFailed {
        operation: GitOperation,
        exit_code: Option<i32>,
        stderr: String,
    },
    Runner(GitRunnerError),
}

impl fmt::Display for GitError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::CommandFailed {
                operation,
                exit_code,
                stderr,
            } => write!(f, "git {operation:?} failed (exit {exit_code:?}): {stderr}"),
            _ => write!(f, "Git operation failed: {self:?}"),
        }
    }
}

impl Error for GitError {}

impl From<GitWorkspaceFailure> for GitError {
    fn from(value: GitWorkspaceFailure) -> Self {
        match value {
            GitWorkspaceFailure::Closed => Self::WorkspaceClosed,
            GitWorkspaceFailure::Cancelled => Self::WorkspaceCancelled,
            GitWorkspaceFailure::StaleGeneration => Self::StaleWorkspace,
            GitWorkspaceFailure::OwnerRevoked => Self::OwnerRevoked,
        }
    }
}

impl From<GitPathFailure> for GitError {
    fn from(value: GitPathFailure) -> Self {
        match value {
            GitPathFailure::OutsideWorkspace => Self::PathOutsideWorkspace,
            GitPathFailure::LinkOrReparsePoint => Self::LinkNotAllowed,
            GitPathFailure::Directory => Self::PathIsDirectory,
            GitPathFailure::Unavailable => Self::PathUnavailable,
        }
    }
}

/// Arguments contain no executable or working directory. The runner obtains
/// those exclusively from the trusted workspace capability and must invoke
/// process_tree without a shell, enforce these limits while streaming, poll
/// check_current during execution, and terminate the process tree on revocation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitInvocation {
    argv: Vec<OsString>,
    stdout_limit_bytes: usize,
    stderr_limit_bytes: usize,
}

impl GitInvocation {
    fn new(arguments: Vec<OsString>, stdout_limit_bytes: usize) -> Self {
        let mut argv = Vec::with_capacity(arguments.len() + 2);
        argv.push(OsString::from("--no-pager"));
        argv.push(OsString::from("--literal-pathspecs"));
        argv.extend(arguments);
        Self {
            argv,
            stdout_limit_bytes,
            stderr_limit_bytes: MAX_STDERR_BYTES,
        }
    }

    pub fn argv(&self) -> &[OsString] {
        &self.argv
    }

    pub fn stdout_limit_bytes(&self) -> usize {
        self.stdout_limit_bytes
    }

    pub fn stderr_limit_bytes(&self) -> usize {
        self.stderr_limit_bytes
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitProcessOutput {
    pub exit_code: Option<i32>,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

/// Implemented later by the host process-tree adapter; this trait is not an IPC API.
pub trait GitRunner: Send + Sync {
    fn run(
        &self,
        workspace: &dyn GitWorkspaceCapability,
        invocation: &GitInvocation,
    ) -> Result<GitProcessOutput, GitRunnerError>;
}

/// One-use host token issued only after the host confirmation flow. It is bound
/// to the exact path list, owner, and workspace generation, never a renderer bool.
pub struct GitDiscardConfirmation {
    owner: OwnerId,
    workspace_id: WorkspaceId,
    generation: u64,
    paths: Vec<RelativePath>,
    used: AtomicBool,
}

impl GitDiscardConfirmation {
    pub fn issue(
        workspace: &dyn GitWorkspaceCapability,
        paths: &[RelativePath],
    ) -> Result<Self, GitError> {
        validate_selection(paths, false)?;
        workspace.check_current()?;
        Ok(Self {
            owner: workspace.owner().clone(),
            workspace_id: workspace.workspace_id().clone(),
            generation: workspace.generation(),
            paths: paths.to_vec(),
            used: AtomicBool::new(false),
        })
    }

    fn consume_for(
        &self,
        workspace: &dyn GitWorkspaceCapability,
        paths: &[RelativePath],
    ) -> Result<(), GitError> {
        if &self.owner != workspace.owner()
            || &self.workspace_id != workspace.workspace_id()
            || self.generation != workspace.generation()
            || self.paths.as_slice() != paths
        {
            return Err(GitError::ConfirmationMismatch);
        }
        workspace.check_current()?;
        self.used
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map(|_| ())
            .map_err(|_| GitError::ConfirmationAlreadyUsed)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GitStatusCode {
    Unchanged,
    Modified,
    TypeChanged,
    Added,
    Deleted,
    Renamed,
    Copied,
    Unmerged,
    Untracked,
}

impl GitStatusCode {
    fn parse(byte: u8) -> Option<Self> {
        match byte {
            b' ' => Some(Self::Unchanged),
            b'M' => Some(Self::Modified),
            b'T' => Some(Self::TypeChanged),
            b'A' => Some(Self::Added),
            b'D' => Some(Self::Deleted),
            b'R' => Some(Self::Renamed),
            b'C' => Some(Self::Copied),
            b'U' => Some(Self::Unmerged),
            b'?' => Some(Self::Untracked),
            _ => None,
        }
    }

    fn is_rename_or_copy(self) -> bool {
        matches!(self, Self::Renamed | Self::Copied)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitStatusEntry {
    pub index: GitStatusCode,
    pub worktree: GitStatusCode,
    /// For -z rename/copy records, `path` is the new name.
    pub path: RelativePath,
    pub original_path: Option<RelativePath>,
}

impl GitStatusEntry {
    fn is_renamed(&self) -> bool {
        self.index == GitStatusCode::Renamed || self.worktree == GitStatusCode::Renamed
    }

    fn is_copied(&self) -> bool {
        self.index == GitStatusCode::Copied || self.worktree == GitStatusCode::Copied
    }

    pub fn is_untracked(&self) -> bool {
        self.index == GitStatusCode::Untracked && self.worktree == GitStatusCode::Untracked
    }

    pub fn is_conflicted(&self) -> bool {
        self.index == GitStatusCode::Unmerged
            || self.worktree == GitStatusCode::Unmerged
            || matches!(
                (self.index, self.worktree),
                (GitStatusCode::Deleted, GitStatusCode::Deleted)
                    | (GitStatusCode::Added, GitStatusCode::Added)
            )
    }

    fn is_staged(&self) -> bool {
        self.index != GitStatusCode::Unchanged && self.index != GitStatusCode::Untracked
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitStatus {
    pub entries: Vec<GitStatusEntry>,
}

impl GitStatus {
    pub fn conflict_count(&self) -> usize {
        self.entries
            .iter()
            .filter(|entry| entry.is_conflicted())
            .count()
    }
}

/// Parses porcelain v1 `-z` records without splitting or decoding the whole
/// stream. Git's NUL-delimited rename record is `new-path\0old-path\0`.
pub fn parse_porcelain_v1_z(input: &[u8]) -> Result<Vec<GitStatusEntry>, GitError> {
    if input.len() > MAX_STATUS_OUTPUT_BYTES {
        return Err(GitError::OutputLimitExceeded);
    }
    let mut cursor = 0;
    let mut entries = Vec::new();
    while cursor < input.len() {
        if entries.len() >= MAX_GIT_PATHS {
            return Err(GitError::TooManyStatusEntries);
        }
        let record = take_nul_record(input, &mut cursor)?;
        if record.len() < 4 || record[2] != b' ' {
            return Err(GitError::MalformedStatus);
        }
        let index = GitStatusCode::parse(record[0]).ok_or(GitError::MalformedStatus)?;
        let worktree = GitStatusCode::parse(record[1]).ok_or(GitError::MalformedStatus)?;
        if (index == GitStatusCode::Untracked) != (worktree == GitStatusCode::Untracked)
            || (index == GitStatusCode::Unchanged && worktree == GitStatusCode::Unchanged)
        {
            return Err(GitError::MalformedStatus);
        }
        let path = parse_status_path(&record[3..])?;
        let original_path = if index.is_rename_or_copy() || worktree.is_rename_or_copy() {
            let old = parse_status_path(take_nul_record(input, &mut cursor)?)?;
            if old == path {
                return Err(GitError::MalformedStatus);
            }
            Some(old)
        } else {
            None
        };
        entries.push(GitStatusEntry {
            index,
            worktree,
            path,
            original_path,
        });
    }
    Ok(entries)
}

fn take_nul_record<'a>(input: &'a [u8], cursor: &mut usize) -> Result<&'a [u8], GitError> {
    let relative_end = input
        .get(*cursor..)
        .ok_or(GitError::MalformedStatus)?
        .iter()
        .position(|byte| *byte == 0)
        .ok_or(GitError::MalformedStatus)?;
    let end = *cursor + relative_end;
    let record = &input[*cursor..end];
    *cursor = end + 1;
    Ok(record)
}

fn parse_status_path(bytes: &[u8]) -> Result<RelativePath, GitError> {
    let text = std::str::from_utf8(bytes).map_err(|_| GitError::InvalidPathEncoding)?;
    RelativePath::parse(text).map_err(|_| GitError::InvalidPath)
}

pub struct GitService<'a> {
    runner: &'a dyn GitRunner,
}

impl<'a> GitService<'a> {
    pub fn new(runner: &'a dyn GitRunner) -> Self {
        Self { runner }
    }

    pub fn status(&self, workspace: &dyn GitWorkspaceCapability) -> Result<GitStatus, GitError> {
        self.ensure_repository(workspace)?;
        Ok(GitStatus {
            entries: self.read_status(workspace)?,
        })
    }

    /// Returns the exact stdout bytes emitted by `git show HEAD`.
    pub fn show_head(&self, workspace: &dyn GitWorkspaceCapability) -> Result<Vec<u8>, GitError> {
        self.ensure_repository(workspace)?;
        if !self.has_head(workspace)? {
            return Err(GitError::NoHead);
        }
        let output = self.run_success(
            workspace,
            plain_args(&["show", "--no-ext-diff", "--no-color", "HEAD"]),
            MAX_SHOW_HEAD_BYTES,
            GitOperation::ShowHead,
        )?;
        Ok(output.stdout)
    }

    pub fn init(&self, workspace: &dyn GitWorkspaceCapability) -> Result<(), GitError> {
        if self.repository_state(workspace)? {
            return Err(GitError::AlreadyRepository);
        }
        self.run_success(
            workspace,
            plain_args(&["init", "--quiet"]),
            MAX_COMMAND_OUTPUT_BYTES,
            GitOperation::Init,
        )?;
        if !self.repository_state(workspace)? {
            return Err(GitError::InvalidGitOutput);
        }
        Ok(())
    }

    /// Empty `paths` stages all tracked changes and untracked files.
    pub fn stage(
        &self,
        workspace: &dyn GitWorkspaceCapability,
        paths: &[RelativePath],
    ) -> Result<(), GitError> {
        self.validate_paths(workspace, paths, true, GitPathIntent::Stage)?;
        self.ensure_repository(workspace)?;
        let args = if paths.is_empty() {
            plain_args(&["add", "--all"])
        } else {
            args_with_paths(&["add", "--all"], paths)
        };
        self.run_success(
            workspace,
            args,
            MAX_COMMAND_OUTPUT_BYTES,
            GitOperation::Stage,
        )?;
        Ok(())
    }

    /// Empty `paths` unstages everything without changing the working tree.
    /// In an unborn repository, `read-tree --empty` clears the index safely.
    pub fn unstage(
        &self,
        workspace: &dyn GitWorkspaceCapability,
        paths: &[RelativePath],
    ) -> Result<(), GitError> {
        self.validate_paths(workspace, paths, true, GitPathIntent::Unstage)?;
        self.ensure_repository(workspace)?;
        let entries = self.read_status(workspace)?;
        let conflicts =
            matching_conflict_count(&entries, if paths.is_empty() { None } else { Some(paths) });
        if conflicts != 0 {
            return Err(GitError::UnresolvedConflicts { count: conflicts });
        }
        let has_head = self.has_head(workspace)?;
        if paths.is_empty() {
            let args = if has_head {
                plain_args(&["reset", "--quiet", "HEAD"])
            } else {
                plain_args(&["read-tree", "--empty"])
            };
            self.run_success(
                workspace,
                args,
                MAX_COMMAND_OUTPUT_BYTES,
                GitOperation::Unstage,
            )?;
            return Ok(());
        }

        let mut staged = Vec::new();
        let mut total_bytes = 0;
        for entry in &entries {
            if entry.is_staged() && entry_matches(entry, paths) {
                push_unique_path(&mut staged, &entry.path, &mut total_bytes)?;
                if entry.is_renamed() {
                    if let Some(old) = &entry.original_path {
                        push_unique_path(&mut staged, old, &mut total_bytes)?;
                    }
                }
            }
        }
        if staged.is_empty() {
            return Ok(());
        }
        self.validate_paths(workspace, &staged, false, GitPathIntent::Unstage)?;
        let args = if has_head {
            args_with_paths(&["reset", "--quiet", "HEAD"], &staged)
        } else {
            args_with_paths(
                &[
                    "rm",
                    "--quiet",
                    "--cached",
                    "--force",
                    "-r",
                    "--ignore-unmatch",
                ],
                &staged,
            )
        };
        self.run_success(
            workspace,
            args,
            MAX_COMMAND_OUTPUT_BYTES,
            GitOperation::Unstage,
        )?;
        Ok(())
    }

    /// Discards only changed file paths covered by a one-use host confirmation.
    /// `git clean` is deliberately not given `-d` or `-x`.
    pub fn discard(
        &self,
        workspace: &dyn GitWorkspaceCapability,
        paths: &[RelativePath],
        confirmation: &GitDiscardConfirmation,
    ) -> Result<(), GitError> {
        self.validate_paths(workspace, paths, false, GitPathIntent::Discard)?;
        self.ensure_repository(workspace)?;
        let entries = self.read_status(workspace)?;
        let selected: HashSet<&str> = paths.iter().map(|path| path.as_str()).collect();
        let mut matched = HashSet::new();
        let mut conflicts = 0;
        let mut tracked = Vec::new();
        let mut added = Vec::new();
        let mut untracked = Vec::new();
        let mut renames = Vec::new();
        let mut total_bytes = 0;

        for entry in &entries {
            let new_selected = selected.contains(entry.path.as_str());
            let old_selected = entry
                .original_path
                .as_ref()
                .is_some_and(|old| selected.contains(old.as_str()));
            if !new_selected && !old_selected {
                continue;
            }
            if let Some(old) = &entry.original_path {
                if entry.is_copied() && !entry.is_renamed() {
                    if !new_selected {
                        continue;
                    }
                    matched.insert(entry.path.as_str().to_owned());
                    if entry.is_conflicted() {
                        conflicts += 1;
                    } else if matches!(entry.index, GitStatusCode::Added | GitStatusCode::Copied) {
                        push_unique_path(&mut added, &entry.path, &mut total_bytes)?;
                    } else {
                        push_unique_path(&mut tracked, &entry.path, &mut total_bytes)?;
                    }
                } else {
                    if !new_selected || !old_selected {
                        return Err(GitError::RenameRequiresBothPaths);
                    }
                    matched.insert(entry.path.as_str().to_owned());
                    matched.insert(old.as_str().to_owned());
                    if entry.is_conflicted() {
                        conflicts += 1;
                    } else {
                        renames.push((old.clone(), entry.path.clone()));
                    }
                }
            } else {
                matched.insert(entry.path.as_str().to_owned());
                if entry.is_conflicted() {
                    conflicts += 1;
                } else if entry.is_untracked() {
                    push_unique_path(&mut untracked, &entry.path, &mut total_bytes)?;
                } else if entry.index == GitStatusCode::Added {
                    push_unique_path(&mut added, &entry.path, &mut total_bytes)?;
                } else {
                    push_unique_path(&mut tracked, &entry.path, &mut total_bytes)?;
                }
            }
        }
        if paths.iter().any(|path| !matched.contains(path.as_str())) {
            return Err(GitError::PathNotChanged);
        }
        if conflicts != 0 {
            return Err(GitError::UnresolvedConflicts { count: conflicts });
        }

        let has_head = self.has_head(workspace)?;
        if !has_head && (!tracked.is_empty() || !renames.is_empty()) {
            return Err(GitError::NoHead);
        }
        let mut rename_old = Vec::new();
        let mut rename_new = Vec::new();
        let mut rename_all = Vec::new();
        let mut rename_bytes = 0;
        for (old, new) in &renames {
            push_unique_path(&mut rename_old, old, &mut rename_bytes)?;
            push_unique_path(&mut rename_new, new, &mut rename_bytes)?;
            push_unique_path(&mut rename_all, old, &mut rename_bytes)?;
            push_unique_path(&mut rename_all, new, &mut rename_bytes)?;
        }
        confirmation.consume_for(workspace, paths)?;

        if !renames.is_empty() {
            self.run_paths(
                workspace,
                &["reset", "--quiet", "HEAD"],
                &rename_all,
                GitOperation::Discard,
            )?;
            self.run_paths(
                workspace,
                &["restore", "--source=HEAD", "--worktree"],
                &rename_old,
                GitOperation::Discard,
            )?;
            self.run_paths(
                workspace,
                &["clean", "--force"],
                &rename_new,
                GitOperation::Discard,
            )?;
        }
        if !added.is_empty() {
            if has_head {
                self.run_paths(
                    workspace,
                    &["reset", "--quiet", "HEAD"],
                    &added,
                    GitOperation::Discard,
                )?;
            } else {
                self.run_paths(
                    workspace,
                    &[
                        "rm",
                        "--quiet",
                        "--cached",
                        "--force",
                        "-r",
                        "--ignore-unmatch",
                    ],
                    &added,
                    GitOperation::Discard,
                )?;
            }
            self.run_paths(
                workspace,
                &["clean", "--force"],
                &added,
                GitOperation::Discard,
            )?;
        }
        if !tracked.is_empty() {
            self.run_paths(
                workspace,
                &["restore", "--source=HEAD", "--staged", "--worktree"],
                &tracked,
                GitOperation::Discard,
            )?;
        }
        if !untracked.is_empty() {
            self.run_paths(
                workspace,
                &["clean", "--force"],
                &untracked,
                GitOperation::Discard,
            )?;
        }
        Ok(())
    }

    pub fn commit(
        &self,
        workspace: &dyn GitWorkspaceCapability,
        message: &str,
    ) -> Result<Vec<u8>, GitError> {
        if message.is_empty()
            || message.encode_utf16().count() > MAX_COMMIT_MESSAGE_UTF16
            || message.contains('\0')
        {
            return Err(GitError::InvalidCommitMessage);
        }
        self.ensure_repository(workspace)?;
        let entries = self.read_status(workspace)?;
        let conflicts = matching_conflict_count(&entries, None);
        if conflicts != 0 {
            return Err(GitError::UnresolvedConflicts { count: conflicts });
        }
        let staged = self.run_success(
            workspace,
            plain_args(&["diff", "--cached", "--quiet", "--exit-code"]),
            64,
            GitOperation::CheckStaged,
        );
        match staged {
            Ok(_) => return Err(GitError::NothingToCommit),
            Err(GitError::CommandFailed {
                exit_code: Some(1), ..
            }) => {}
            Err(error) => return Err(error),
        }
        let output = self.run_success(
            workspace,
            vec![
                OsString::from("commit"),
                OsString::from("-m"),
                OsString::from(message),
            ],
            MAX_COMMAND_OUTPUT_BYTES,
            GitOperation::Commit,
        )?;
        Ok(output.stdout)
    }

    /// Read-only query of the effective host Git configuration; it never writes config.
    pub fn user_name(
        &self,
        workspace: &dyn GitWorkspaceCapability,
    ) -> Result<Option<String>, GitError> {
        let output = self.execute(
            workspace,
            plain_args(&["config", "--get", "user.name"]),
            MAX_USER_NAME_BYTES,
        )?;
        match output.exit_code {
            Some(1) => Ok(None),
            Some(0) => {
                let value = strip_one_line_ending(&output.stdout);
                if value.is_empty() || value.iter().any(|byte| matches!(byte, b'\n' | b'\r' | 0)) {
                    return Err(GitError::InvalidUserName);
                }
                let name = std::str::from_utf8(value).map_err(|_| GitError::InvalidUserName)?;
                if name.encode_utf16().count() > MAX_USER_NAME_BYTES {
                    return Err(GitError::InvalidUserName);
                }
                Ok(Some(name.to_owned()))
            }
            _ => Err(command_failure(output, GitOperation::UserName)),
        }
    }

    fn validate_paths(
        &self,
        workspace: &dyn GitWorkspaceCapability,
        paths: &[RelativePath],
        allow_empty: bool,
        intent: GitPathIntent,
    ) -> Result<(), GitError> {
        validate_selection(paths, allow_empty)?;
        workspace.check_current()?;
        if paths.is_empty() {
            workspace.validate_all(intent)?;
        } else {
            for path in paths {
                workspace.validate_path(path, intent)?;
            }
        }
        Ok(())
    }

    fn ensure_repository(&self, workspace: &dyn GitWorkspaceCapability) -> Result<(), GitError> {
        if self.repository_state(workspace)? {
            Ok(())
        } else {
            Err(GitError::NotRepository)
        }
    }

    fn repository_state(&self, workspace: &dyn GitWorkspaceCapability) -> Result<bool, GitError> {
        let output = self.execute(
            workspace,
            plain_args(&["rev-parse", "--is-inside-work-tree"]),
            128,
        )?;
        match output.exit_code {
            Some(0) => match strip_one_line_ending(&output.stdout) {
                b"true" => Ok(true),
                b"false" => Ok(false),
                _ => Err(GitError::InvalidGitOutput),
            },
            Some(_) => Ok(false),
            None => Err(GitError::ProcessExitUnavailable),
        }
    }

    fn has_head(&self, workspace: &dyn GitWorkspaceCapability) -> Result<bool, GitError> {
        let output = self.execute(
            workspace,
            plain_args(&["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]),
            128,
        )?;
        match output.exit_code {
            Some(0) if !output.stdout.is_empty() => Ok(true),
            Some(0) => Err(GitError::InvalidGitOutput),
            Some(1) => Ok(false),
            _ => Err(command_failure(output, GitOperation::ProbeHead)),
        }
    }

    fn read_status(
        &self,
        workspace: &dyn GitWorkspaceCapability,
    ) -> Result<Vec<GitStatusEntry>, GitError> {
        let output = self.run_success(
            workspace,
            plain_args(&[
                "status",
                "--porcelain=v1",
                "-z",
                "--untracked-files=all",
                "--renames",
            ]),
            MAX_STATUS_OUTPUT_BYTES,
            GitOperation::Status,
        )?;
        parse_porcelain_v1_z(&output.stdout)
    }

    fn run_paths(
        &self,
        workspace: &dyn GitWorkspaceCapability,
        words: &[&str],
        paths: &[RelativePath],
        operation: GitOperation,
    ) -> Result<(), GitError> {
        if paths.is_empty() {
            return Ok(());
        }
        self.run_success(
            workspace,
            args_with_paths(words, paths),
            MAX_COMMAND_OUTPUT_BYTES,
            operation,
        )?;
        Ok(())
    }

    fn run_success(
        &self,
        workspace: &dyn GitWorkspaceCapability,
        args: Vec<OsString>,
        stdout_limit: usize,
        operation: GitOperation,
    ) -> Result<GitProcessOutput, GitError> {
        let output = self.execute(workspace, args, stdout_limit)?;
        if output.exit_code == Some(0) {
            Ok(output)
        } else {
            Err(command_failure(output, operation))
        }
    }

    fn execute(
        &self,
        workspace: &dyn GitWorkspaceCapability,
        args: Vec<OsString>,
        stdout_limit: usize,
    ) -> Result<GitProcessOutput, GitError> {
        workspace.check_current()?;
        let invocation = GitInvocation::new(args, stdout_limit);
        let result = self.runner.run(workspace, &invocation);
        workspace.check_current()?;
        let output = result.map_err(|error| {
            if error == GitRunnerError::OutputLimitExceeded {
                GitError::OutputLimitExceeded
            } else {
                GitError::Runner(error)
            }
        })?;
        if output.stdout.len() > invocation.stdout_limit_bytes()
            || output.stderr.len() > invocation.stderr_limit_bytes()
        {
            return Err(GitError::OutputLimitExceeded);
        }
        if output.exit_code.is_none() {
            return Err(GitError::ProcessExitUnavailable);
        }
        Ok(output)
    }
}

fn validate_selection(paths: &[RelativePath], allow_empty: bool) -> Result<(), GitError> {
    if paths.is_empty() && !allow_empty {
        return Err(GitError::PathsRequired);
    }
    if paths.len() > MAX_GIT_PATHS {
        return Err(GitError::TooManyPaths);
    }
    let mut total = 0usize;
    let mut unique = HashSet::with_capacity(paths.len());
    for path in paths {
        total = total
            .checked_add(path.as_str().len())
            .ok_or(GitError::PathArgumentLimitExceeded)?;
        if total > MAX_PATH_ARGUMENT_BYTES {
            return Err(GitError::PathArgumentLimitExceeded);
        }
        if !unique.insert(path.as_str()) {
            return Err(GitError::DuplicatePath);
        }
    }
    Ok(())
}

fn push_unique_path(
    paths: &mut Vec<RelativePath>,
    path: &RelativePath,
    total_bytes: &mut usize,
) -> Result<(), GitError> {
    if paths.iter().any(|existing| existing == path) {
        return Ok(());
    }
    if paths.len() >= MAX_GIT_PATHS {
        return Err(GitError::TooManyPaths);
    }
    *total_bytes = total_bytes
        .checked_add(path.as_str().len())
        .ok_or(GitError::PathArgumentLimitExceeded)?;
    if *total_bytes > MAX_PATH_ARGUMENT_BYTES {
        return Err(GitError::PathArgumentLimitExceeded);
    }
    paths.push(path.clone());
    Ok(())
}

fn entry_matches(entry: &GitStatusEntry, paths: &[RelativePath]) -> bool {
    paths.iter().any(|path| {
        path == &entry.path
            || (entry.is_renamed() && entry.original_path.as_ref().is_some_and(|old| path == old))
    })
}

fn matching_conflict_count(entries: &[GitStatusEntry], paths: Option<&[RelativePath]>) -> usize {
    entries
        .iter()
        .filter(|entry| {
            entry.is_conflicted() && paths.is_none_or(|selected| entry_matches(entry, selected))
        })
        .count()
}

fn plain_args(words: &[&str]) -> Vec<OsString> {
    words.iter().map(OsString::from).collect()
}

fn args_with_paths(words: &[&str], paths: &[RelativePath]) -> Vec<OsString> {
    let mut args = plain_args(words);
    if !paths.is_empty() {
        args.push(OsString::from("--"));
        args.extend(paths.iter().map(|path| OsString::from(path.as_str())));
    }
    args
}

fn strip_one_line_ending(bytes: &[u8]) -> &[u8] {
    if let Some(without_lf) = bytes.strip_suffix(b"\n") {
        without_lf.strip_suffix(b"\r").unwrap_or(without_lf)
    } else {
        bytes
    }
}

fn command_failure(output: GitProcessOutput, operation: GitOperation) -> GitError {
    GitError::CommandFailed {
        operation,
        exit_code: output.exit_code,
        stderr: bounded_stderr(&output.stderr),
    }
}

fn bounded_stderr(bytes: &[u8]) -> String {
    let prefix = &bytes[..bytes.len().min(MAX_ERROR_DETAIL_BYTES)];
    let mut detail = String::with_capacity(MAX_ERROR_DETAIL_BYTES);
    let mut truncated = bytes.len() > prefix.len();
    for character in String::from_utf8_lossy(prefix).chars() {
        let safe = if character.is_control() {
            ' '
        } else {
            character
        };
        if detail.len() + safe.len_utf8() > MAX_ERROR_DETAIL_BYTES {
            truncated = true;
            break;
        }
        detail.push(safe);
    }
    if truncated && detail.len() + '…'.len_utf8() <= MAX_ERROR_DETAIL_BYTES {
        detail.push('…');
    }
    detail
}

#[cfg(test)]
#[path = "../../tests/unit/git_service.rs"]
mod tests;
