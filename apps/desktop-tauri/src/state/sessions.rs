// SPDX-License-Identifier: Apache-2.0
//! Process-wide registry of workspace selections made through host-owned
//! native dialogs. A session binds an owner window to an absolute native root
//! and an optional entry path; the renderer only ever sees the opaque session ID.
//!
//! Roots are validated at open time only. The registry does not provide
//! filesystem race containment; file handle operations are handled separately.

use std::{
    collections::HashMap,
    error::Error,
    fmt, fs,
    path::{Path, PathBuf},
    sync::{Mutex, MutexGuard, OnceLock, PoisonError},
};

use uuid::Uuid;

use crate::{
    schemas::protocol::{OwnerId, WorkspaceId},
    shared::relative_path::RelativePath,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SessionError {
    RootNotAbsolute,
    RootNotDirectory,
    /// The monotonic ID counter is used up; IDs are never wrapped or reused.
    IdsExhausted,
    /// Unknown, revoked or foreign session; deliberately indistinguishable.
    UnknownSession,
}

impl fmt::Display for SessionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::RootNotAbsolute => "workspace root must be an absolute path",
            Self::RootNotDirectory => "workspace root must be an existing directory",
            Self::IdsExhausted => "workspace session identifiers are exhausted",
            Self::UnknownSession => "unknown workspace session",
        })
    }
}

impl Error for SessionError {}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkspaceSession {
    id: WorkspaceId,
    owner: OwnerId,
    root: PathBuf,
    entry: Option<RelativePath>,
}

impl WorkspaceSession {
    pub fn id(&self) -> &WorkspaceId {
        &self.id
    }

    pub fn owner(&self) -> &OwnerId {
        &self.owner
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn entry(&self) -> Option<&RelativePath> {
        self.entry.as_ref()
    }
}

struct State {
    live: HashMap<WorkspaceId, WorkspaceSession>,
    /// Next counter value to issue; `None` once the last value was issued.
    next: Option<u64>,
}

/// Issues IDs as `<random per-registry nonce>-<monotonic counter>`. A closed
/// ID is never reissued because the counter only advances, so no history of
/// closed IDs has to be kept.
pub struct SessionRegistry {
    nonce: String,
    state: Mutex<State>,
}

impl Default for SessionRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl SessionRegistry {
    pub fn new() -> Self {
        Self {
            nonce: Uuid::new_v4().simple().to_string(),
            state: Mutex::new(State {
                live: HashMap::new(),
                next: Some(1),
            }),
        }
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Registers a native selection for `owner` and returns the new session.
    pub fn open(
        &self,
        owner: &OwnerId,
        root: &Path,
        entry: Option<RelativePath>,
    ) -> Result<WorkspaceSession, SessionError> {
        if !root.is_absolute() {
            return Err(SessionError::RootNotAbsolute);
        }
        match fs::metadata(root) {
            Ok(metadata) if metadata.is_dir() => {}
            _ => return Err(SessionError::RootNotDirectory),
        }
        let mut guard = self.lock();
        let state = &mut *guard;
        let counter = state.next.ok_or(SessionError::IdsExhausted)?;
        let id = WorkspaceId::parse(&format!("{}-{counter}", self.nonce))
            .expect("nonce and counter form a valid identifier");
        state.next = counter.checked_add(1);
        let session = WorkspaceSession {
            id: id.clone(),
            owner: owner.clone(),
            root: root.to_path_buf(),
            entry,
        };
        state.live.insert(id, session.clone());
        Ok(session)
    }

    pub fn get(&self, owner: &OwnerId, id: &WorkspaceId) -> Result<WorkspaceSession, SessionError> {
        match self.lock().live.get(id) {
            Some(session) if &session.owner == owner => Ok(session.clone()),
            _ => Err(SessionError::UnknownSession),
        }
    }

    /// Closes one session owned by `owner`.
    pub fn close(&self, owner: &OwnerId, id: &WorkspaceId) -> Result<(), SessionError> {
        let mut guard = self.lock();
        match guard.live.get(id) {
            Some(session) if &session.owner == owner => {
                guard.live.remove(id);
                Ok(())
            }
            _ => Err(SessionError::UnknownSession),
        }
    }

    /// Drops every session of `owner` and no one else's; returns the count.
    pub fn revoke_owner(&self, owner: &OwnerId) -> usize {
        let mut guard = self.lock();
        let before = guard.live.len();
        guard.live.retain(|_, session| &session.owner != owner);
        before - guard.live.len()
    }

    pub fn live_count(&self) -> usize {
        self.lock().live.len()
    }
}

pub fn registry() -> &'static SessionRegistry {
    static REGISTRY: OnceLock<SessionRegistry> = OnceLock::new();
    REGISTRY.get_or_init(SessionRegistry::new)
}

#[cfg(test)]
#[path = "../../tests/unit/sessions.rs"]
mod tests;
