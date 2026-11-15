// SPDX-License-Identifier: Apache-2.0
//! Draft LuaLaTeX toolchain discovery, temporary worktree lifecycle, and
//! compile artifact/failure records.

use std::{
    env, fs,
    path::{Path, PathBuf},
};

use crate::{
    platform::process_tree::ProcessErrorKind,
    schemas::{
        draft::{
            DraftBibliographyEntry, DraftError, DraftErrorCode, DraftGeometry, DraftImageReference,
            DraftPageRecord, DraftReference,
        },
        protocol::RunId,
    },
};

#[derive(Clone)]
pub(super) struct Toolchain {
    pub(super) lualatex: PathBuf,
    pub(super) biber: Option<PathBuf>,
    pub(super) bibtex: Option<PathBuf>,
}

impl Toolchain {
    pub(super) fn discover(resource_dir: &Path) -> Option<Self> {
        let bundled_dirs = [
            resource_dir.join("texlive").join("bin").join("windows"),
            resource_dir.join("texlive").join("bin").join("win32"),
            resource_dir.join("draft").join("bin"),
        ];
        let lualatex = find_fixed_executable("lualatex.exe", &bundled_dirs)?;
        let mut tool_dirs = vec![lualatex.parent()?.to_path_buf()];
        tool_dirs.extend(bundled_dirs);
        Some(Self {
            biber: find_fixed_executable("biber.exe", &tool_dirs),
            bibtex: find_fixed_executable("bibtex.exe", &tool_dirs),
            lualatex,
        })
    }
}

pub(super) fn find_fixed_executable(name: &str, preferred_dirs: &[PathBuf]) -> Option<PathBuf> {
    for directory in preferred_dirs {
        if directory.is_absolute() {
            if let Some(path) = canonical_executable(&directory.join(name)) {
                return Some(path);
            }
        }
    }
    let path_value = env::var_os("PATH")?;
    for directory in env::split_paths(&path_value).filter(|path| path.is_absolute()) {
        if let Some(path) = canonical_executable(&directory.join(name)) {
            return Some(path);
        }
    }
    None
}

pub(super) fn canonical_executable(path: &Path) -> Option<PathBuf> {
    if !path.is_absolute() {
        return None;
    }
    let canonical = fs::canonicalize(path).ok()?;
    fs::metadata(&canonical)
        .ok()
        .filter(|metadata| metadata.is_file())
        .map(|_| canonical)
}

pub(super) struct TempTree {
    pub(super) path: PathBuf,
    pub(super) removed: bool,
}

impl TempTree {
    pub(super) fn create(root: &Path, run_id: &RunId) -> Result<Self, DraftError> {
        let path = root.join(run_id.as_str());
        fs::create_dir(&path).map_err(|_| {
            DraftError::new(
                DraftErrorCode::IoFailed,
                "Could not create the private Draft work directory.",
            )
        })?;
        let canonical = fs::canonicalize(&path).map_err(|_| {
            DraftError::new(
                DraftErrorCode::IoFailed,
                "Could not verify the private Draft work directory.",
            )
        })?;
        if !canonical.is_absolute() {
            return Err(DraftError::new(
                DraftErrorCode::IoFailed,
                "The private Draft work directory is not absolute.",
            ));
        }
        Ok(Self {
            path: canonical,
            removed: false,
        })
    }

    pub(super) fn cleanup(&mut self) -> Result<(), DraftError> {
        if self.removed {
            return Ok(());
        }
        match fs::remove_dir_all(&self.path) {
            Ok(()) => {
                self.removed = true;
                Ok(())
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                self.removed = true;
                Ok(())
            }
            Err(_) => Err(DraftError::new(
                DraftErrorCode::IoFailed,
                "Draft output was produced, but its private work directory could not be removed.",
            )),
        }
    }
}

impl Drop for TempTree {
    fn drop(&mut self) {
        if !self.removed {
            let _ = fs::remove_dir_all(&self.path);
        }
    }
}

pub(super) struct ToolFailure {
    pub(super) kind: ProcessErrorKind,
    pub(super) exit_code: Option<u32>,
    pub(super) log: String,
    pub(super) cleanup_proven: bool,
}

pub(super) struct CompileFailure {
    pub(super) message: String,
    pub(super) kind: Option<ProcessErrorKind>,
    pub(super) log: String,
    pub(super) cleanup_proven: bool,
    pub(super) passes: u8,
    pub(super) bibliography_passes: u8,
}

pub(super) struct CompileArtifact {
    pub(super) pdf: Vec<u8>,
    pub(super) geometry: DraftGeometry,
    pub(super) pages: Vec<DraftPageRecord>,
    pub(super) references: Vec<DraftReference>,
    pub(super) bibliography: Vec<DraftBibliographyEntry>,
    pub(super) images: Vec<DraftImageReference>,
    pub(super) unsupported: Vec<String>,
    pub(super) log: String,
    pub(super) passes: u8,
    pub(super) bibliography_passes: u8,
}
