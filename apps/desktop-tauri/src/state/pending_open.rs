// SPDX-License-Identifier: Apache-2.0
use std::{
    collections::{HashMap, VecDeque},
    ffi::{OsStr, OsString},
    path::{Component, Path, PathBuf},
    sync::{Mutex, MutexGuard, PoisonError},
};

use crate::schemas::protocol::OwnerId;

pub const PENDING_OPEN_EVENT: &str = "frontend://open/pending";
pub const MAX_NATIVE_PATH_UTF16_UNITS: usize = 32_767;
pub const MAX_NATIVE_PATH_COMPONENTS: usize = 128;
pub const MAX_NATIVE_OPEN_ARGUMENTS: usize = 32;
pub const MAX_NATIVE_OPEN_FILES_PER_LAUNCH: usize = 8;
pub const MAX_PENDING_OPEN_PER_WINDOW: usize = 4;
pub const MAX_PENDING_OPEN_TOTAL: usize = 64;

#[derive(Default)]
struct OwnerQueue {
    label: String,
    paths: VecDeque<PathBuf>,
}

#[derive(Default)]
struct Queues {
    by_owner: HashMap<OwnerId, OwnerQueue>,
    total: usize,
}

#[derive(Default)]
pub struct PendingOpenState {
    queues: Mutex<Queues>,
}

impl PendingOpenState {
    fn lock(&self) -> MutexGuard<'_, Queues> {
        self.queues.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The host assigns the owner before building its trusted window.
    pub(crate) fn enqueue(
        &self,
        owner: &OwnerId,
        label: &str,
        path: PathBuf,
    ) -> Result<bool, &'static str> {
        let label_owner = OwnerId::from_label(label).map_err(|_| "invalid document owner")?;
        if &label_owner != owner {
            return Err("pending document owner mismatch");
        }
        if !is_native_open_path(&path) {
            return Err("invalid pending document path");
        }

        let mut queues = self.lock();
        if let Some(owner_queue) = queues.by_owner.get(owner) {
            if owner_queue.label != label {
                return Err("pending document owner mismatch");
            }
            if owner_queue
                .paths
                .iter()
                .any(|existing| same_path(existing, &path))
            {
                return Ok(false);
            }
            if owner_queue.paths.len() >= MAX_PENDING_OPEN_PER_WINDOW {
                return Err("pending document queue is full");
            }
        }
        if queues.total >= MAX_PENDING_OPEN_TOTAL {
            return Err("pending document queue is full");
        }

        let owner_queue = queues.by_owner.entry(owner.clone()).or_default();
        if owner_queue.label.is_empty() {
            owner_queue.label = label.to_owned();
        }
        owner_queue.paths.push_back(path);
        queues.total += 1;
        Ok(true)
    }

    /// A renderer can consume only the path assigned to its trusted window.
    pub(crate) fn take_for_owner(&self, owner: &OwnerId) -> Option<PathBuf> {
        let mut queues = self.lock();
        let (path, empty) = {
            let queue = queues.by_owner.get_mut(owner)?;
            let path = queue.paths.pop_front();
            (path, queue.paths.is_empty())
        };
        if path.is_some() {
            queues.total = queues.total.saturating_sub(1);
        }
        if empty {
            queues.by_owner.remove(owner);
        }
        path
    }

    pub(crate) fn owner_for_path(&self, path: &Path) -> Option<(OwnerId, String)> {
        self.lock()
            .by_owner
            .iter()
            .find(|(_, queue)| {
                queue
                    .paths
                    .iter()
                    .any(|candidate| same_path(candidate, path))
            })
            .map(|(owner, queue)| (owner.clone(), queue.label.clone()))
    }

    pub(crate) fn has_pending_for_owner(&self, owner: &OwnerId) -> bool {
        self.lock()
            .by_owner
            .get(owner)
            .is_some_and(|queue| !queue.paths.is_empty())
    }

    pub(crate) fn revoke_owner(&self, owner: &OwnerId) {
        let mut queues = self.lock();
        if let Some(queue) = queues.by_owner.remove(owner) {
            queues.total = queues.total.saturating_sub(queue.paths.len());
        }
    }
}

fn accepted_extension(path: &Path) -> bool {
    path.extension()
        .and_then(OsStr::to_str)
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("tex") || extension.eq_ignore_ascii_case("pdf")
        })
}

fn has_dot_components(path: &Path) -> bool {
    path.components()
        .any(|component| matches!(component, Component::CurDir | Component::ParentDir))
}

fn within_native_path_limits(path: &Path) -> bool {
    let Some(value) = path.to_str() else {
        return false;
    };
    value.encode_utf16().count() <= MAX_NATIVE_PATH_UTF16_UNITS
        && path.components().count() <= MAX_NATIVE_PATH_COMPONENTS
}

pub(crate) fn is_native_open_path(path: &Path) -> bool {
    path.is_absolute()
        && !has_dot_components(path)
        && within_native_path_limits(path)
        && accepted_extension(path)
}

pub(crate) fn parse_native_open_argument(argument: &OsStr, cwd: &Path) -> Option<PathBuf> {
    if !cwd.is_absolute() || has_dot_components(cwd) {
        return None;
    }
    let text = argument.to_str()?;
    if text.is_empty() || text.encode_utf16().count() > MAX_NATIVE_PATH_UTF16_UNITS {
        return None;
    }
    let argument_path = Path::new(text);
    if has_dot_components(argument_path) {
        return None;
    }
    if !argument_path.is_absolute()
        && argument_path
            .components()
            .any(|component| matches!(component, Component::Prefix(_) | Component::RootDir))
    {
        return None;
    }
    let path = if argument_path.is_absolute() {
        argument_path.to_path_buf()
    } else {
        cwd.join(argument_path)
    };
    is_native_open_path(&path).then_some(path)
}

pub(crate) fn collect_native_open_paths(
    arguments: impl IntoIterator<Item = OsString>,
    cwd: &Path,
) -> Vec<PathBuf> {
    let mut paths: Vec<PathBuf> = Vec::new();
    for argument in arguments.into_iter().take(MAX_NATIVE_OPEN_ARGUMENTS) {
        let Some(path) = parse_native_open_argument(&argument, cwd) else {
            continue;
        };
        if paths.iter().any(|existing| same_path(existing, &path)) {
            continue;
        }
        paths.push(path);
        if paths.len() == MAX_NATIVE_OPEN_FILES_PER_LAUNCH {
            break;
        }
    }
    paths
}

fn same_path(left: &Path, right: &Path) -> bool {
    #[cfg(windows)]
    {
        left.to_string_lossy()
            .eq_ignore_ascii_case(right.to_string_lossy().as_ref())
    }
    #[cfg(not(windows))]
    {
        left == right
    }
}

#[cfg(test)]
#[path = "../../tests/unit/pending_open.rs"]
mod tests;
