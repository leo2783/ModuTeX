// SPDX-License-Identifier: Apache-2.0
//! Host-owned Windows Git runtime. Git discovery is optional; executable,
//! workspace root, argv, timeout, cancellation and process cleanup are not
//! renderer-controlled. Commands are launched as argv elements through the
//! existing Windows process-tree runner, never through a shell.

use std::{
    env,
    ffi::{OsStr, OsString},
    fs::{self, File},
    io,
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread,
    time::{Duration, Instant},
};

use std::os::windows::ffi::OsStrExt;

use crate::{
    platform::{
        file_identity::{
            file_identity, is_symlink_or_reparse, open_directory_no_follow, open_file_no_follow,
            FileIdentity,
        },
        process_tree::{
            cancellation_pair, run as run_process_tree, CleanupProof, ProcessError,
            ProcessErrorKind, ProcessSpec,
        },
    },
    services::git_service::{
        GitAvailability, GitInvocation, GitPathFailure, GitProcessOutput, GitRunner,
        GitRunnerError, GitUnavailableReason, GitWorkspaceCapability, GitWorkspaceFailure,
    },
};

const DEFAULT_GIT_TIMEOUT: Duration = Duration::from_secs(120);
const PROCESS_TREE_STREAM_LIMIT: usize = 32 * 1024 * 1024;
const MAX_COMMAND_LINE_UTF16: usize = 32_767;
const CLEANUP_RETRY_SLICE: Duration = Duration::from_secs(1);
const CLEANUP_RETRY_BUDGET: Duration = Duration::from_secs(5);
const CANCELLATION_POLL: Duration = Duration::from_millis(10);
const MAX_HOOK_FILES: usize = 4096;

struct TrustedGitExecutable {
    path: PathBuf,
    identity: FileIdentity,
    // These handles deny delete sharing on Windows. Keep the executable and
    // its directory chain pinned so a path replacement cannot redirect spawn.
    _file: Arc<File>,
    _directory_pins: Vec<Arc<File>>,
}

/// One host-discovered executable and its runtime availability. No renderer
/// command accepts an executable path or can replace this instance.
pub struct GitNativeRuntime {
    executable: Option<TrustedGitExecutable>,
    availability: GitAvailability,
    timeout: Duration,
}

impl GitNativeRuntime {
    pub fn discover() -> Self {
        Self::discover_with_timeout(DEFAULT_GIT_TIMEOUT)
    }

    pub fn discover_with_timeout(timeout: Duration) -> Self {
        let timeout = if timeout.is_zero() {
            Duration::from_millis(1)
        } else {
            timeout
        };
        if unsafe_git_environment_present() {
            return Self::unavailable(GitUnavailableReason::UnsafeEnvironment, timeout);
        }
        Self::from_search_path(env::var_os("PATH").as_deref(), timeout)
    }

    fn unavailable(reason: GitUnavailableReason, timeout: Duration) -> Self {
        Self {
            executable: None,
            availability: GitAvailability::Unavailable { reason },
            timeout,
        }
    }

    fn from_search_path(path: Option<&OsStr>, timeout: Duration) -> Self {
        let mut unsafe_candidate_seen = false;
        if let Some(path) = path {
            for directory in env::split_paths(path) {
                // Empty and relative PATH entries can resolve through the
                // current directory, so they are never executable sources.
                if !directory.is_absolute() {
                    continue;
                }
                match inspect_executable(&directory.join("git.exe")) {
                    Ok(executable) => {
                        return Self {
                            executable: Some(executable),
                            availability: GitAvailability::Available,
                            timeout,
                        };
                    }
                    Err(GitUnavailableReason::UnsafeExecutable) => {
                        unsafe_candidate_seen = true;
                    }
                    Err(_) => {}
                }
            }
        }
        Self::unavailable(
            if unsafe_candidate_seen {
                GitUnavailableReason::UnsafeExecutable
            } else {
                GitUnavailableReason::NotInstalled
            },
            timeout,
        )
    }

    pub fn availability(&self) -> GitAvailability {
        self.availability
    }

    fn executable(&self) -> Result<&TrustedGitExecutable, GitRunnerError> {
        match (&self.executable, self.availability) {
            (Some(executable), GitAvailability::Available) => Ok(executable),
            (
                _,
                GitAvailability::Unavailable {
                    reason: GitUnavailableReason::UnsupportedPlatform,
                },
            ) => Err(GitRunnerError::UnsupportedPlatform),
            (_, GitAvailability::Unavailable { .. }) | (None, GitAvailability::Available) => {
                Err(GitRunnerError::Unavailable)
            }
        }
    }
}

fn inspect_executable(path: &Path) -> Result<TrustedGitExecutable, GitUnavailableReason> {
    if !path.is_absolute() {
        return Err(GitUnavailableReason::UnsafeExecutable);
    }
    let before = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Err(GitUnavailableReason::NotInstalled)
        }
        Err(_) => return Err(GitUnavailableReason::UnsafeExecutable),
    };
    if is_symlink_or_reparse(&before) || !before.is_file() {
        return Err(GitUnavailableReason::UnsafeExecutable);
    }

    let parent = path
        .parent()
        .ok_or(GitUnavailableReason::UnsafeExecutable)?;
    let _original_parent_pins = pin_directory_chain(parent)?;
    let original = open_file_no_follow(path).map_err(|_| GitUnavailableReason::UnsafeExecutable)?;
    let original_metadata = original
        .metadata()
        .map_err(|_| GitUnavailableReason::UnsafeExecutable)?;
    if is_symlink_or_reparse(&original_metadata) || !original_metadata.is_file() {
        return Err(GitUnavailableReason::UnsafeExecutable);
    }
    let original_identity =
        file_identity(&original).map_err(|_| GitUnavailableReason::UnsafeExecutable)?;

    let canonical = fs::canonicalize(path).map_err(|_| GitUnavailableReason::UnsafeExecutable)?;
    if !canonical.is_absolute() {
        return Err(GitUnavailableReason::UnsafeExecutable);
    }
    let canonical_parent = canonical
        .parent()
        .ok_or(GitUnavailableReason::UnsafeExecutable)?;
    let directory_pins = pin_directory_chain(canonical_parent)?;
    let canonical_file =
        open_file_no_follow(&canonical).map_err(|_| GitUnavailableReason::UnsafeExecutable)?;
    let canonical_metadata = canonical_file
        .metadata()
        .map_err(|_| GitUnavailableReason::UnsafeExecutable)?;
    if is_symlink_or_reparse(&canonical_metadata) || !canonical_metadata.is_file() {
        return Err(GitUnavailableReason::UnsafeExecutable);
    }
    let identity =
        file_identity(&canonical_file).map_err(|_| GitUnavailableReason::UnsafeExecutable)?;
    if identity != original_identity {
        return Err(GitUnavailableReason::UnsafeExecutable);
    }

    Ok(TrustedGitExecutable {
        path: canonical,
        identity,
        _file: Arc::new(canonical_file),
        _directory_pins: directory_pins,
    })
}

/// Opens every existing directory component without following reparse points.
/// Windows directory handles omit FILE_SHARE_DELETE in the supplied platform
/// seam, pinning the chain for the lifetime of the returned handles.
fn pin_directory_chain(path: &Path) -> Result<Vec<Arc<File>>, GitUnavailableReason> {
    if !path.is_absolute() {
        return Err(GitUnavailableReason::UnsafeExecutable);
    }
    let mut current = PathBuf::new();
    let mut pins = Vec::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => current.push(prefix.as_os_str()),
            Component::RootDir => {
                current.push(component.as_os_str());
                pin_one_directory(&current, &mut pins)?;
            }
            Component::Normal(segment) => {
                current.push(segment);
                pin_one_directory(&current, &mut pins)?;
            }
            Component::CurDir | Component::ParentDir => {
                return Err(GitUnavailableReason::UnsafeExecutable)
            }
        }
    }
    Ok(pins)
}

fn pin_one_directory(path: &Path, pins: &mut Vec<Arc<File>>) -> Result<(), GitUnavailableReason> {
    let metadata =
        fs::symlink_metadata(path).map_err(|_| GitUnavailableReason::UnsafeExecutable)?;
    if is_symlink_or_reparse(&metadata) || !metadata.is_dir() {
        return Err(GitUnavailableReason::UnsafeExecutable);
    }
    let directory =
        open_directory_no_follow(path).map_err(|_| GitUnavailableReason::UnsafeExecutable)?;
    let opened = directory
        .metadata()
        .map_err(|_| GitUnavailableReason::UnsafeExecutable)?;
    if is_symlink_or_reparse(&opened) || !opened.is_dir() {
        return Err(GitUnavailableReason::UnsafeExecutable);
    }
    file_identity(&directory).map_err(|_| GitUnavailableReason::UnsafeExecutable)?;
    pins.push(Arc::new(directory));
    Ok(())
}

const HOST_GIT_ENVIRONMENT_OVERRIDES: [(&str, &str); 3] = [
    ("GIT_TERMINAL_PROMPT", "0"),
    ("GIT_CONFIG_NOSYSTEM", "1"),
    ("GIT_PAGER", "cat"),
];

fn is_unsafe_git_env_key(key: &OsStr) -> bool {
    let key = key.to_string_lossy().to_ascii_uppercase();
    if !key.starts_with("GIT_") {
        return false;
    }
    !HOST_GIT_ENVIRONMENT_OVERRIDES
        .iter()
        .any(|(name, _)| key == *name)
}

/// Reject all inherited Git-specific controls except for the host-owned
/// overrides explicitly configured in `HOST_GIT_ENVIRONMENT_OVERRIDES`.
fn unsafe_git_environment_present() -> bool {
    env::vars_os().any(|(key, _)| is_unsafe_git_env_key(&key))
}

fn workspace_runner_error(error: GitWorkspaceFailure) -> GitRunnerError {
    match error {
        GitWorkspaceFailure::Closed | GitWorkspaceFailure::OwnerRevoked => GitRunnerError::Closed,
        GitWorkspaceFailure::Cancelled => GitRunnerError::Cancelled,
        GitWorkspaceFailure::StaleGeneration => GitRunnerError::StaleWorkspace,
    }
}

fn path_runner_error(_: GitPathFailure) -> GitRunnerError {
    GitRunnerError::UnsafeWorkspace
}

/// GitRunner implementation used by the existing GitService. Its executable
/// and arguments come exclusively from the host runtime and GitService.
pub struct NativeGitRunner {
    runtime: Arc<GitNativeRuntime>,
}

impl NativeGitRunner {
    pub fn new(runtime: Arc<GitNativeRuntime>) -> Self {
        Self { runtime }
    }

    fn verify_executable(&self, executable: &TrustedGitExecutable) -> Result<File, GitRunnerError> {
        if unsafe_git_environment_present() {
            return Err(GitRunnerError::UnsafeEnvironment);
        }
        let parent = executable
            .path
            .parent()
            .ok_or(GitRunnerError::UnsafeExecutable)?;
        let _parent_pins =
            pin_directory_chain(parent).map_err(|_| GitRunnerError::UnsafeExecutable)?;
        let metadata =
            fs::symlink_metadata(&executable.path).map_err(|_| GitRunnerError::UnsafeExecutable)?;
        if is_symlink_or_reparse(&metadata) || !metadata.is_file() {
            return Err(GitRunnerError::UnsafeExecutable);
        }
        let file =
            open_file_no_follow(&executable.path).map_err(|_| GitRunnerError::UnsafeExecutable)?;
        let opened = file
            .metadata()
            .map_err(|_| GitRunnerError::UnsafeExecutable)?;
        if is_symlink_or_reparse(&opened) || !opened.is_file() {
            return Err(GitRunnerError::UnsafeExecutable);
        }
        if file_identity(&file).map_err(|_| GitRunnerError::UnsafeExecutable)?
            != executable.identity
        {
            return Err(GitRunnerError::UnsafeExecutable);
        }
        Ok(file)
    }

    fn fixed_arguments(
        invocation: &GitInvocation,
        root: &Path,
    ) -> Result<Vec<OsString>, GitRunnerError> {
        let mut arguments = invocation.argv().to_vec();
        if arguments.len() < 3
            || arguments[0].as_os_str() != OsStr::new("--no-pager")
            || arguments[1].as_os_str() != OsStr::new("--literal-pathspecs")
        {
            return Err(GitRunnerError::ProcessTreeFailed);
        }

        let git_dir = root.join(".git");
        let hooks = git_dir.join("hooks");
        let mut global_arguments = vec![
            path_argument("--git-dir=", &git_dir),
            path_argument("--work-tree=", root),
            OsString::from("-c"),
            path_argument("core.hooksPath=", &hooks),
            OsString::from("-c"),
            OsString::from("core.fsmonitor=false"),
        ];
        arguments.splice(2..2, global_arguments.drain(..));
        Ok(arguments)
    }

    fn run_process(
        &self,
        workspace: &dyn GitWorkspaceCapability,
        executable: &TrustedGitExecutable,
        root: &Path,
        arguments: Vec<OsString>,
        cancellation: &crate::platform::process_tree::CancellationToken,
        invocation: &GitInvocation,
    ) -> Result<GitProcessOutput, GitRunnerError> {
        let stdout_limit = invocation.stdout_limit_bytes();
        let stderr_limit = invocation.stderr_limit_bytes();
        let stream_limit = stdout_limit.max(stderr_limit);
        if stream_limit == 0 || stream_limit > PROCESS_TREE_STREAM_LIMIT {
            return Err(GitRunnerError::OutputLimitExceeded);
        }
        let mut environment: Vec<(OsString, OsString)> = HOST_GIT_ENVIRONMENT_OVERRIDES
            .iter()
            .map(|(key, value)| (OsString::from(*key), OsString::from(*value)))
            .collect();
        environment.push((OsString::from("PAGER"), OsString::from("cat")));
        let spec = ProcessSpec::new(
            executable.path.clone(),
            root.to_path_buf(),
            arguments,
            self.runtime.timeout,
            stream_limit,
        )
        .with_environment(environment);

        match run_process_tree(&spec, cancellation) {
            Ok(output) => {
                if output.logs.stdout_truncated
                    || output.logs.stderr_truncated
                    || output.logs.stdout.len() > stdout_limit
                    || output.logs.stderr.len() > stderr_limit
                {
                    return Err(GitRunnerError::OutputLimitExceeded);
                }
                let exit_code = i32::try_from(output.exit_code)
                    .map_err(|_| GitRunnerError::ProcessTreeFailed)?;
                Ok(GitProcessOutput {
                    exit_code: Some(exit_code),
                    stdout: output.logs.stdout,
                    stderr: output.logs.stderr,
                })
            }
            Err(error) => self.process_error(workspace, error, stdout_limit, stderr_limit),
        }
    }

    fn process_error(
        &self,
        workspace: &dyn GitWorkspaceCapability,
        mut error: ProcessError,
        stdout_limit: usize,
        stderr_limit: usize,
    ) -> Result<GitProcessOutput, GitRunnerError> {
        // Do not return to the filesystem coordinator, and therefore do not
        // release its workspace lease, until the process-tree owner proves
        // the child, job and output readers are drained. If that cannot be
        // proven in a bounded foreground window, transfer the ticket to the
        // existing process-tree supervisor with a task-completion callback.
        let cleanup_deadline = Instant::now() + CLEANUP_RETRY_BUDGET;
        loop {
            if error.pending_cleanup.is_none() {
                if error.cleanup == CleanupProof::Failed {
                    return Err(GitRunnerError::CleanupUnproven);
                }
                break;
            }
            let remaining = cleanup_deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                if let Some(mut pending) = error.take_pending_cleanup() {
                    pending.on_drained(workspace.deferred_cleanup_callback());
                    drop(pending);
                }
                return Err(GitRunnerError::CleanupUnproven);
            }
            let _ = error.retry_cleanup(CLEANUP_RETRY_SLICE.min(remaining));
            if error.pending_cleanup.is_some() {
                thread::sleep(Duration::from_millis(20));
            }
        }
        if error.cleanup == CleanupProof::Failed || error.has_pending_cleanup() {
            return Err(GitRunnerError::CleanupUnproven);
        }

        let kind = error.cause.unwrap_or(error.kind);
        if kind == ProcessErrorKind::NonZeroExit {
            if error.logs.stdout_truncated
                || error.logs.stderr_truncated
                || error.logs.stdout.len() > stdout_limit
                || error.logs.stderr.len() > stderr_limit
            {
                return Err(GitRunnerError::OutputLimitExceeded);
            }
            let code = error.exit_code.ok_or(GitRunnerError::ProcessTreeFailed)?;
            let exit_code = i32::try_from(code).map_err(|_| GitRunnerError::ProcessTreeFailed)?;
            return Ok(GitProcessOutput {
                exit_code: Some(exit_code),
                stdout: error.logs.stdout,
                stderr: error.logs.stderr,
            });
        }

        Err(match kind {
            #[cfg(not(all(windows, target_arch = "x86_64")))]
            ProcessErrorKind::UnsupportedPlatform => GitRunnerError::UnsupportedPlatform,
            ProcessErrorKind::InvalidExecutable => GitRunnerError::UnsafeExecutable,
            ProcessErrorKind::InvalidWorkingDirectory => GitRunnerError::UnsafeWorkspace,
            ProcessErrorKind::Cancelled => GitRunnerError::Cancelled,
            ProcessErrorKind::DeadlineExceeded => GitRunnerError::TimedOut,
            ProcessErrorKind::OutputLimitExceeded => GitRunnerError::OutputLimitExceeded,
            ProcessErrorKind::CleanupFailed => GitRunnerError::ProcessTreeFailed,
            ProcessErrorKind::Spawn | ProcessErrorKind::AssignToJob | ProcessErrorKind::Resume => {
                GitRunnerError::LaunchFailed
            }
            ProcessErrorKind::InvalidTimeout
            | ProcessErrorKind::InvalidLogLimit
            | ProcessErrorKind::InvalidArgument
            | ProcessErrorKind::CommandLineTooLong
            | ProcessErrorKind::ReadFailure
            | ProcessErrorKind::WaitFailure
            | ProcessErrorKind::JobQueryFailure
            | ProcessErrorKind::NonZeroExit
            | ProcessErrorKind::CleanupCapacityExceeded
            | ProcessErrorKind::CleanupSupervisorUnavailable
            | ProcessErrorKind::Internal => GitRunnerError::ProcessTreeFailed,
        })
    }
}

fn path_argument(prefix: &str, path: &Path) -> OsString {
    let mut argument = OsString::from(prefix);
    argument.push(path.as_os_str());
    argument
}

fn quoted_argument_units(value: &OsStr) -> Result<usize, GitRunnerError> {
    let mut length = 0usize;
    let mut needs_quotes = false;
    for unit in value.encode_wide() {
        if unit == 0 {
            return Err(GitRunnerError::ProcessTreeFailed);
        }
        length = length
            .checked_add(1)
            .ok_or(GitRunnerError::CommandLineTooLong)?;
        if matches!(unit, 0x20 | 0x09 | 0x0a | 0x0d | 0x0b | 0x22) {
            needs_quotes = true;
        }
    }
    if length == 0 {
        needs_quotes = true;
    }
    if !needs_quotes {
        return Ok(length);
    }

    let mut total = 2usize;
    let mut backslashes = 0usize;
    for unit in value.encode_wide() {
        if unit == b'\\' as u16 {
            backslashes = backslashes
                .checked_add(1)
                .ok_or(GitRunnerError::CommandLineTooLong)?;
        } else if unit == b'"' as u16 {
            // Windows emits 2*N backslashes followed by the quote itself.
            let escaped = backslashes
                .checked_mul(2)
                .and_then(|value| value.checked_add(2))
                .ok_or(GitRunnerError::CommandLineTooLong)?;
            total = total
                .checked_add(escaped)
                .ok_or(GitRunnerError::CommandLineTooLong)?;
            backslashes = 0;
        } else {
            total = total
                .checked_add(backslashes)
                .and_then(|value| value.checked_add(1))
                .ok_or(GitRunnerError::CommandLineTooLong)?;
            backslashes = 0;
        }
    }
    total = total
        .checked_add(
            backslashes
                .checked_mul(2)
                .ok_or(GitRunnerError::CommandLineTooLong)?,
        )
        .ok_or(GitRunnerError::CommandLineTooLong)?;
    Ok(total)
}

fn command_line_units(executable: &OsStr, arguments: &[OsString]) -> Result<usize, GitRunnerError> {
    let mut total = quoted_argument_units(executable)?;
    for argument in arguments {
        let argument_units = quoted_argument_units(argument)?;
        total = total
            .checked_add(1)
            .and_then(|value| value.checked_add(argument_units))
            .ok_or(GitRunnerError::CommandLineTooLong)?;
    }
    if total > MAX_COMMAND_LINE_UTF16 - 1 {
        return Err(GitRunnerError::CommandLineTooLong);
    }
    Ok(total)
}

struct GitMetadataGuard {
    _ancestors: Vec<Arc<File>>,
    _root: File,
    _git_dir: Option<File>,
    _hooks: Option<File>,
}

fn open_metadata_component(
    path: &Path,
    expect_directory: bool,
) -> Result<Option<File>, GitRunnerError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(GitRunnerError::UnsafeWorkspace),
    };
    if is_symlink_or_reparse(&metadata) {
        return Err(GitRunnerError::UnsafeWorkspace);
    }
    if (expect_directory && !metadata.is_dir()) || (!expect_directory && !metadata.is_file()) {
        return Err(GitRunnerError::UnsafeWorkspace);
    }
    let file = if expect_directory {
        open_directory_no_follow(path)
    } else {
        open_file_no_follow(path)
    }
    .map_err(|_| GitRunnerError::UnsafeWorkspace)?;
    let opened = file
        .metadata()
        .map_err(|_| GitRunnerError::UnsafeWorkspace)?;
    if is_symlink_or_reparse(&opened)
        || (expect_directory && !opened.is_dir())
        || (!expect_directory && !opened.is_file())
    {
        return Err(GitRunnerError::UnsafeWorkspace);
    }
    file_identity(&file).map_err(|_| GitRunnerError::UnsafeWorkspace)?;
    Ok(Some(file))
}

fn verify_hook_entries(hooks: &Path) -> Result<(), GitRunnerError> {
    let mut count = 0usize;
    for entry in fs::read_dir(hooks).map_err(|_| GitRunnerError::UnsafeWorkspace)? {
        let entry = entry.map_err(|_| GitRunnerError::UnsafeWorkspace)?;
        count = count
            .checked_add(1)
            .ok_or(GitRunnerError::UnsafeWorkspace)?;
        if count > MAX_HOOK_FILES {
            return Err(GitRunnerError::UnsafeWorkspace);
        }
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path).map_err(|_| GitRunnerError::UnsafeWorkspace)?;
        if is_symlink_or_reparse(&metadata) || !metadata.is_file() {
            return Err(GitRunnerError::UnsafeWorkspace);
        }
        let file = open_file_no_follow(&path).map_err(|_| GitRunnerError::UnsafeWorkspace)?;
        let opened = file
            .metadata()
            .map_err(|_| GitRunnerError::UnsafeWorkspace)?;
        if is_symlink_or_reparse(&opened) || !opened.is_file() {
            return Err(GitRunnerError::UnsafeWorkspace);
        }
        file_identity(&file).map_err(|_| GitRunnerError::UnsafeWorkspace)?;
    }
    Ok(())
}

fn verify_git_metadata(root: &Path) -> Result<GitMetadataGuard, GitRunnerError> {
    if !root.is_absolute() {
        return Err(GitRunnerError::UnsafeWorkspace);
    }
    let ancestors = match root.parent() {
        Some(parent) => pin_directory_chain(parent).map_err(|_| GitRunnerError::UnsafeWorkspace)?,
        None => Vec::new(),
    };
    let root_handle =
        open_metadata_component(root, true)?.ok_or(GitRunnerError::UnsafeWorkspace)?;
    let git_path = root.join(".git");
    let Some(git_dir_handle) = open_metadata_component(&git_path, true)? else {
        // A non-repository workspace must remain usable by `git init` and by
        // the repository probe that returns the typed NotRepository result.
        return Ok(GitMetadataGuard {
            _ancestors: ancestors,
            _root: root_handle,
            _git_dir: None,
            _hooks: None,
        });
    };

    for (name, is_directory) in [
        ("config", false),
        ("HEAD", false),
        ("index", false),
        ("objects", true),
        ("refs", true),
        ("hooks", true),
    ] {
        let _ = open_metadata_component(&git_path.join(name), is_directory)?;
    }
    for redirected in [
        git_path.join("commondir"),
        git_path.join("objects").join("info").join("alternates"),
    ] {
        match fs::symlink_metadata(&redirected) {
            Ok(_) => return Err(GitRunnerError::UnsafeWorkspace),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(_) => return Err(GitRunnerError::UnsafeWorkspace),
        }
    }

    let hooks_path = git_path.join("hooks");
    let hooks = open_metadata_component(&hooks_path, true)?;
    if hooks.is_some() {
        verify_hook_entries(&hooks_path)?;
    }
    Ok(GitMetadataGuard {
        _ancestors: ancestors,
        _root: root_handle,
        _git_dir: Some(git_dir_handle),
        _hooks: hooks,
    })
}

impl GitRunner for NativeGitRunner {
    fn path_argument_budget(
        &self,
        workspace: &dyn GitWorkspaceCapability,
        base_words: &[&str],
    ) -> Result<usize, GitRunnerError> {
        let executable = self.runtime.executable()?;
        let root = workspace.root_path().map_err(path_runner_error)?;
        let base_arguments: Vec<OsString> = base_words
            .iter()
            .map(|word| OsString::from(*word))
            .collect();
        let invocation = GitInvocation::new(base_arguments, 1);
        let arguments = Self::fixed_arguments(&invocation, root)?;
        let used = command_line_units(executable.path.as_os_str(), &arguments)?;
        Ok((MAX_COMMAND_LINE_UTF16 - 1)
            .saturating_sub(used)
            .saturating_sub(3))
    }

    fn run(
        &self,
        workspace: &dyn GitWorkspaceCapability,
        invocation: &GitInvocation,
    ) -> Result<GitProcessOutput, GitRunnerError> {
        workspace.check_current().map_err(workspace_runner_error)?;
        let executable = self.runtime.executable()?;
        let _executable_handle = self.verify_executable(executable)?;
        let root = workspace.root_path().map_err(path_runner_error)?;
        let _metadata_guard = verify_git_metadata(root)?;
        let arguments = Self::fixed_arguments(invocation, root)?;
        command_line_units(executable.path.as_os_str(), &arguments)?;

        let cancellation_signal = workspace
            .cancellation_signal()
            .unwrap_or_else(|| Arc::new(AtomicBool::new(false)));
        let (cancel_handle, cancel_token) = cancellation_pair();
        let bridge_finished = Arc::new(AtomicBool::new(false));
        let finished_for_bridge = Arc::clone(&bridge_finished);
        let cancelled_for_bridge = Arc::clone(&cancellation_signal);
        let bridge = thread::Builder::new()
            .name("git-process-cancellation-bridge".to_owned())
            .spawn(move || {
                while !finished_for_bridge.load(Ordering::Acquire) {
                    if cancelled_for_bridge.load(Ordering::Acquire) {
                        cancel_handle.cancel();
                        return;
                    }
                    thread::sleep(CANCELLATION_POLL);
                }
            })
            .map_err(|_| GitRunnerError::ProcessTreeFailed)?;

        let result = self.run_process(
            workspace,
            executable,
            root,
            arguments,
            &cancel_token,
            invocation,
        );
        bridge_finished.store(true, Ordering::Release);
        if bridge.join().is_err() {
            return Err(GitRunnerError::ProcessTreeFailed);
        }

        // The supervisor owns cleanup and the workspace-task callback now.
        // Do not mask that state with a post-run workspace check.
        if matches!(&result, Err(GitRunnerError::CleanupUnproven)) {
            return result;
        }

        // Recheck workspace and metadata after native execution as well as
        // before it. A stale workspace never yields a successful Git result.
        let _post_metadata_guard = verify_git_metadata(root)?;
        workspace.check_current().map_err(workspace_runner_error)?;
        result
    }
}

#[cfg(test)]
#[path = "../../tests/integration/git_native.rs"]
mod integration_tests;
