// SPDX-License-Identifier: Apache-2.0
use std::{
    env,
    ffi::OsString,
    fs,
    io::Write,
    os::windows::ffi::OsStrExt,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

use uuid::Uuid;

use crate::{
    platform::process_tree::{run, CancellationToken, ProcessSpec},
    schemas::protocol::{OwnerId, WorkspaceId, WorkspaceKind},
    services::filesystem::FilesystemService,
    shared::relative_path::RelativePath,
};

pub(crate) const MAX_SOURCE_BYTES: usize = 5 * 1024 * 1024;
const MAX_PATH_VALUE_WIDE_UNITS: usize = 32_767;
const MAX_LOCAL_SETTINGS_BYTES: usize = 128 * 1024;
const LOCAL_SETTINGS_NAME: &str = "localSettings.yaml";
const CLEANUP_RETRY_BUDGET: Duration = Duration::from_secs(5);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum SourceFormatError {
    InputTooLarge,
    ToolMissing,
    WorkspaceUnavailable,
    SettingsUnavailable,
    ProcessFailed,
    InvalidOutput,
}

struct ScratchDirectory {
    path: PathBuf,
}

impl ScratchDirectory {
    fn create() -> Result<Self, SourceFormatError> {
        let base = env::temp_dir();
        if !base.is_absolute() {
            return Err(SourceFormatError::ProcessFailed);
        }
        for _ in 0..16 {
            let path = base.join(format!("modutex-latexindent-{}", Uuid::new_v4()));
            match fs::create_dir(&path) {
                Ok(()) => {
                    let canonical = match fs::canonicalize(&path) {
                        Ok(path) => path,
                        Err(_) => {
                            let _ = fs::remove_dir(&path);
                            return Err(SourceFormatError::ProcessFailed);
                        }
                    };
                    return Ok(Self { path: canonical });
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(_) => return Err(SourceFormatError::ProcessFailed),
            }
        }
        Err(SourceFormatError::ProcessFailed)
    }
}

impl Drop for ScratchDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

fn find_latexindent() -> Option<PathBuf> {
    let path = env::var_os("PATH")?;
    if path
        .as_os_str()
        .encode_wide()
        .take(MAX_PATH_VALUE_WIDE_UNITS + 1)
        .count()
        > MAX_PATH_VALUE_WIDE_UNITS
    {
        return None;
    }
    for directory in env::split_paths(&path) {
        if !directory.is_absolute() {
            continue;
        }
        let executable = directory.join("latexindent.exe");
        if let Ok(executable) =
            crate::services::compile_service::resolve_trusted_executable(&executable)
        {
            return Some(executable);
        }
    }
    None
}

fn read_local_settings(
    filesystem: &FilesystemService,
    owner: &OwnerId,
    workspace_id: &WorkspaceId,
) -> Result<Option<Vec<u8>>, SourceFormatError> {
    let (kind, _) = filesystem
        .workspace_info(owner, workspace_id)
        .map_err(|_| SourceFormatError::WorkspaceUnavailable)?;
    if matches!(kind, WorkspaceKind::File) {
        return Ok(None);
    }

    let path = RelativePath::parse(LOCAL_SETTINGS_NAME)
        .map_err(|_| SourceFormatError::SettingsUnavailable)?;
    let read_access = filesystem
        .workspace_file_read_access(owner, workspace_id)
        .map_err(|_| SourceFormatError::WorkspaceUnavailable)?;
    let read = read_access
        .root
        .read_file_bounded(&path, MAX_LOCAL_SETTINGS_BYTES);
    drop(read_access);
    let bytes = match read {
        Ok(output) => output.bytes,
        Err(crate::platform::windows_files::FsError::NotFound) => return Ok(None),
        Err(_) => return Err(SourceFormatError::SettingsUnavailable),
    };
    if bytes.len() > MAX_LOCAL_SETTINGS_BYTES || std::str::from_utf8(&bytes).is_err() {
        return Err(SourceFormatError::SettingsUnavailable);
    }
    Ok(Some(bytes))
}

fn create_scratch_file(
    directory: &Path,
    name: &str,
    contents: &[u8],
) -> Result<PathBuf, SourceFormatError> {
    let path = directory.join(name);
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|_| SourceFormatError::ProcessFailed)?;
    file.write_all(contents)
        .map_err(|_| SourceFormatError::ProcessFailed)?;
    Ok(path)
}

fn path_argument(prefix: &str, path: &Path) -> OsString {
    let mut argument = OsString::from(prefix);
    argument.push(path.as_os_str());
    argument
}

pub(crate) fn format_latex(
    filesystem: &FilesystemService,
    owner: &OwnerId,
    workspace_id: &WorkspaceId,
    source: &str,
    cancellation: &CancellationToken,
) -> Result<String, SourceFormatError> {
    if source.len() > MAX_SOURCE_BYTES {
        return Err(SourceFormatError::InputTooLarge);
    }
    let local_settings = read_local_settings(filesystem, owner, workspace_id)?;
    let executable = find_latexindent().ok_or(SourceFormatError::ToolMissing)?;
    let scratch = ScratchDirectory::create()?;
    let input = create_scratch_file(&scratch.path, "input.tex", source.as_bytes())?;
    let log = scratch.path.join("latexindent.log");

    let mut arguments = vec![path_argument("-g=", &log)];
    if let Some(settings) = local_settings {
        let settings_path = create_scratch_file(&scratch.path, LOCAL_SETTINGS_NAME, &settings)?;
        arguments.push(path_argument("-l=", &settings_path));
    }
    arguments.push(input.as_os_str().to_os_string());

    let spec = ProcessSpec::new(
        executable,
        scratch.path.clone(),
        arguments,
        Duration::from_secs(20),
        MAX_SOURCE_BYTES,
    );
    let output = match run(&spec, cancellation) {
        Ok(output) => output,
        Err(mut error) => {
            let cleanup_deadline = Instant::now() + CLEANUP_RETRY_BUDGET;
            while error.has_pending_cleanup() {
                let remaining = cleanup_deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    break;
                }
                let _ = error.retry_cleanup(remaining.min(Duration::from_millis(250)));
                if error.has_pending_cleanup() {
                    let pause = Duration::from_millis(20)
                        .min(cleanup_deadline.saturating_duration_since(Instant::now()));
                    if !pause.is_zero() {
                        std::thread::sleep(pause);
                    }
                }
            }
            if error.has_pending_cleanup() {
                if let Some(mut pending) = error.take_pending_cleanup() {
                    pending.on_drained(move || drop(scratch));
                    drop(pending);
                }
            }
            return Err(SourceFormatError::ProcessFailed);
        }
    };
    if output.exit_code != 0
        || output.active_processes_after_exit != 0
        || output.logs.stdout_truncated
        || output.logs.stderr_truncated
        || output.logs.stdout.len() > MAX_SOURCE_BYTES
    {
        return Err(SourceFormatError::ProcessFailed);
    }
    String::from_utf8(output.logs.stdout).map_err(|_| SourceFormatError::InvalidOutput)
}

#[cfg(test)]
#[path = "../../tests/unit/source_format_settings.rs"]
mod tests;
