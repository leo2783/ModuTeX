// SPDX-License-Identifier: Apache-2.0
//! Owner-, workspace- and generation-bound G2 operation and undo capabilities.

use std::{
    collections::{HashMap, HashSet},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Condvar, Mutex, MutexGuard, PoisonError,
    },
    time::{Duration, Instant},
};

use crate::{
    platform::windows_files::TrustedRoot,
    schemas::protocol::{OwnerId, RunId, WorkspaceId, WorkspaceRecoverableDeleteReceipt},
    services::filesystem::FilesystemError,
    shared::relative_path::RelativePath,
    state::workspace_leases::SessionGeneration,
};

const MAX_ACTIVE_OPERATIONS_PER_WORKSPACE: usize = 16;
const MAX_ACTIVE_OPERATIONS: usize = 128;
const MAX_RECOVERABLE_DELETES_PER_OWNER: usize = 128;
const MAX_RECOVERABLE_DELETES: usize = 4096;
const RECOVERABLE_DELETE_LIFETIME: Duration = Duration::from_secs(30 * 60);
const WORKSPACE_OPERATION_DRAIN_TIMEOUT: Duration = Duration::from_secs(5);
const RECOVERABLE_DELETE_LIFETIME_MS: u64 = 30 * 60 * 1000;

#[cfg(test)]
#[path = "../../tests/unit/workspace_operations.rs"]
mod tests;

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct WorkspaceKey {
    owner: OwnerId,
    workspace_id: WorkspaceId,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct OperationKey {
    workspace: WorkspaceKey,
    operation_id: RunId,
}

#[derive(Default)]
struct OperationState {
    active: HashMap<WorkspaceKey, usize>,
    cancellable: HashMap<OperationKey, Arc<AtomicBool>>,
    closing_workspaces: HashSet<WorkspaceKey>,
    closed_workspaces: HashSet<WorkspaceKey>,
    closing_owners: HashSet<OwnerId>,
    closed_owners: HashSet<OwnerId>,
}

struct OperationRegistry {
    state: Mutex<OperationState>,
    drained: Condvar,
}

#[derive(Clone)]
struct RecoveryEntry {
    owner: OwnerId,
    workspace_id: WorkspaceId,
    generation: SessionGeneration,
    path: RelativePath,
    expires_at: Instant,
}

#[derive(Default)]
struct RecoveryBook {
    entries: HashMap<String, RecoveryEntry>,
    closed_owners: HashSet<OwnerId>,
    closing_workspaces: HashSet<WorkspaceKey>,
}

pub struct WorkspaceFilesState {
    operations: Arc<OperationRegistry>,
    recoveries: Mutex<RecoveryBook>,
}

pub(crate) struct WorkspaceFileOperation {
    registry: Arc<OperationRegistry>,
    workspace: WorkspaceKey,
    operation_id: Option<RunId>,
    cancelled: Arc<AtomicBool>,
}

impl WorkspaceFileOperation {
    pub(crate) fn cancellation(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.cancelled)
    }
}

impl Drop for WorkspaceFileOperation {
    fn drop(&mut self) {
        let mut state = self
            .registry
            .state
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if let Some(operation_id) = &self.operation_id {
            state.cancellable.remove(&OperationKey {
                workspace: self.workspace.clone(),
                operation_id: operation_id.clone(),
            });
        }
        if let Some(active) = state.active.get_mut(&self.workspace) {
            *active = active.saturating_sub(1);
            if *active == 0 {
                state.active.remove(&self.workspace);
            }
        }
        self.registry.drained.notify_all();
    }
}

impl Default for WorkspaceFilesState {
    fn default() -> Self {
        Self {
            operations: Arc::new(OperationRegistry {
                state: Mutex::new(OperationState::default()),
                drained: Condvar::new(),
            }),
            recoveries: Mutex::new(RecoveryBook::default()),
        }
    }
}

impl WorkspaceFilesState {
    fn lock_recoveries(&self) -> MutexGuard<'_, RecoveryBook> {
        self.recoveries
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    fn enter(
        &self,
        owner: OwnerId,
        workspace_id: WorkspaceId,
        operation_id: Option<RunId>,
    ) -> Result<WorkspaceFileOperation, FilesystemError> {
        let workspace = WorkspaceKey {
            owner: owner.clone(),
            workspace_id,
        };
        let mut state = self
            .operations
            .state
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if state.closed_owners.contains(&owner)
            || state.closing_owners.contains(&owner)
            || state.closed_workspaces.contains(&workspace)
            || state.closing_workspaces.contains(&workspace)
        {
            return Err(FilesystemError::SessionClosed);
        }
        let total: usize = state.active.values().copied().sum();
        let active = state.active.get(&workspace).copied().unwrap_or(0);
        if active >= MAX_ACTIVE_OPERATIONS_PER_WORKSPACE || total >= MAX_ACTIVE_OPERATIONS {
            return Err(FilesystemError::ResourceExhausted);
        }
        let cancelled = Arc::new(AtomicBool::new(false));
        if let Some(id) = &operation_id {
            let key = OperationKey {
                workspace: workspace.clone(),
                operation_id: id.clone(),
            };
            if state.cancellable.contains_key(&key) {
                return Err(FilesystemError::ResourceExhausted);
            }
            state.cancellable.insert(key, Arc::clone(&cancelled));
        }
        *state.active.entry(workspace.clone()).or_insert(0) += 1;
        Ok(WorkspaceFileOperation {
            registry: Arc::clone(&self.operations),
            workspace,
            operation_id,
            cancelled,
        })
    }

    pub(crate) fn admit_operation(
        &self,
        owner: OwnerId,
        workspace_id: WorkspaceId,
    ) -> Result<WorkspaceFileOperation, FilesystemError> {
        self.enter(owner, workspace_id, None)
    }

    pub(crate) fn register_operation(
        &self,
        owner: OwnerId,
        workspace_id: WorkspaceId,
        operation_id: RunId,
    ) -> Result<WorkspaceFileOperation, FilesystemError> {
        self.enter(owner, workspace_id, Some(operation_id))
    }

    pub(crate) fn cancel_operation(
        &self,
        owner: &OwnerId,
        workspace_id: &WorkspaceId,
        operation_id: &RunId,
    ) {
        let state = self
            .operations
            .state
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if let Some(cancelled) = state.cancellable.get(&OperationKey {
            workspace: WorkspaceKey {
                owner: owner.clone(),
                workspace_id: workspace_id.clone(),
            },
            operation_id: operation_id.clone(),
        }) {
            cancelled.store(true, Ordering::Release);
        }
    }

    pub(crate) fn quiesce_workspace(
        &self,
        owner: &OwnerId,
        workspace_id: &WorkspaceId,
    ) -> Result<(), FilesystemError> {
        let key = WorkspaceKey {
            owner: owner.clone(),
            workspace_id: workspace_id.clone(),
        };
        let deadline = Instant::now()
            .checked_add(WORKSPACE_OPERATION_DRAIN_TIMEOUT)
            .ok_or(FilesystemError::TimedOut)?;
        let mut state = self
            .operations
            .state
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if state.closed_workspaces.contains(&key) {
            return Ok(());
        }
        state.closing_workspaces.insert(key.clone());
        for (operation, cancelled) in &state.cancellable {
            if operation.workspace == key {
                cancelled.store(true, Ordering::Release);
            }
        }
        while state.active.get(&key).copied().unwrap_or(0) > 0 {
            let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
                return Err(FilesystemError::TimedOut);
            };
            let (next, result) = self
                .operations
                .drained
                .wait_timeout(state, remaining)
                .unwrap_or_else(PoisonError::into_inner);
            state = next;
            if result.timed_out() && state.active.get(&key).copied().unwrap_or(0) > 0 {
                return Err(FilesystemError::TimedOut);
            }
        }
        drop(state);
        self.lock_recoveries().closing_workspaces.insert(key);
        Ok(())
    }

    pub(crate) fn abort_workspace_close(&self, owner: &OwnerId, workspace_id: &WorkspaceId) {
        let key = WorkspaceKey {
            owner: owner.clone(),
            workspace_id: workspace_id.clone(),
        };
        let mut state = self
            .operations
            .state
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let closed = state.closed_workspaces.contains(&key);
        if !closed {
            state.closing_workspaces.remove(&key);
        }
        drop(state);
        if !closed {
            self.lock_recoveries().closing_workspaces.remove(&key);
        }
    }

    pub(crate) fn finish_workspace_close(&self, owner: &OwnerId, workspace_id: &WorkspaceId) {
        let key = WorkspaceKey {
            owner: owner.clone(),
            workspace_id: workspace_id.clone(),
        };
        let mut state = self
            .operations
            .state
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        state.closing_workspaces.insert(key.clone());
        state.closed_workspaces.insert(key.clone());
        drop(state);
        self.lock_recoveries().closing_workspaces.insert(key);
    }

    /// Fences new operations, cancels bounded scans/copies and waits at most
    /// five seconds. A timed-out operation remains fenced and is drained by
    /// the existing FilesystemService close/revoke path.
    pub fn close_owner_gate(&self, owner: &OwnerId) {
        let deadline = Instant::now()
            .checked_add(WORKSPACE_OPERATION_DRAIN_TIMEOUT)
            .unwrap_or_else(Instant::now);
        let mut state = self
            .operations
            .state
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        state.closing_owners.insert(owner.clone());
        for (key, cancelled) in &state.cancellable {
            if &key.workspace.owner == owner {
                cancelled.store(true, Ordering::Release);
            }
        }
        loop {
            let active: usize = state
                .active
                .iter()
                .filter(|(key, _)| &key.owner == owner)
                .map(|(_, count)| *count)
                .sum();
            if active == 0 {
                break;
            }
            let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
                break;
            };
            let (next, result) = self
                .operations
                .drained
                .wait_timeout(state, remaining)
                .unwrap_or_else(PoisonError::into_inner);
            state = next;
            if result.timed_out() {
                break;
            }
        }
        state.closed_owners.insert(owner.clone());
        drop(state);
        self.lock_recoveries().closed_owners.insert(owner.clone());
    }

    pub(crate) fn has_recoveries(&self, owner: &OwnerId, workspace_id: &WorkspaceId) -> bool {
        self.lock_recoveries()
            .entries
            .values()
            .any(|entry| &entry.owner == owner && &entry.workspace_id == workspace_id)
    }

    pub(crate) fn recovery_workspaces(
        &self,
        owner: &OwnerId,
    ) -> Vec<(WorkspaceId, SessionGeneration)> {
        let book = self.lock_recoveries();
        let mut result = HashSet::new();
        for entry in book.entries.values().filter(|entry| &entry.owner == owner) {
            result.insert((entry.workspace_id.clone(), entry.generation));
        }
        result.into_iter().collect()
    }

    pub fn delete_recoverable(
        &self,
        owner: &OwnerId,
        workspace_id: &WorkspaceId,
        generation: SessionGeneration,
        path: &RelativePath,
        root: &TrustedRoot,
    ) -> Result<WorkspaceRecoverableDeleteReceipt, FilesystemError> {
        let mut book = self.lock_recoveries();
        let workspace = WorkspaceKey {
            owner: owner.clone(),
            workspace_id: workspace_id.clone(),
        };
        if book.closed_owners.contains(owner) || book.closing_workspaces.contains(&workspace) {
            return Err(FilesystemError::SessionClosed);
        }

        // Expired entries are first restored. A collision leaves the tombstone
        // intact and counted; capacity pressure never discards user bytes.
        let now = Instant::now();
        let expired: Vec<String> = book
            .entries
            .iter()
            .filter(|(_, entry)| {
                &entry.owner == owner
                    && &entry.workspace_id == workspace_id
                    && entry.generation == generation
                    && entry.expires_at <= now
            })
            .map(|(token, _)| token.clone())
            .collect();
        for token in expired {
            if let Some(entry) = book.entries.get(&token).cloned() {
                if root.undo_recoverable_delete(&entry.path, &token).is_ok() {
                    book.entries.remove(&token);
                }
            }
        }

        let owner_count = book
            .entries
            .values()
            .filter(|entry| &entry.owner == owner)
            .count();
        if owner_count >= MAX_RECOVERABLE_DELETES_PER_OWNER
            || book.entries.len() >= MAX_RECOVERABLE_DELETES
        {
            return Err(FilesystemError::ResourceExhausted);
        }
        let token = uuid::Uuid::new_v4().to_string();
        root.delete_recoverable(path, &token)?;
        book.entries.insert(
            token.clone(),
            RecoveryEntry {
                owner: owner.clone(),
                workspace_id: workspace_id.clone(),
                generation,
                path: path.clone(),
                expires_at: Instant::now() + RECOVERABLE_DELETE_LIFETIME,
            },
        );
        Ok(WorkspaceRecoverableDeleteReceipt {
            token,
            expires_in_ms: RECOVERABLE_DELETE_LIFETIME_MS,
        })
    }

    pub fn undo_recoverable(
        &self,
        owner: &OwnerId,
        workspace_id: &WorkspaceId,
        generation: SessionGeneration,
        token: &str,
        root: &TrustedRoot,
    ) -> Result<(), FilesystemError> {
        let mut book = self.lock_recoveries();
        let entry = book
            .entries
            .get(token)
            .cloned()
            .ok_or(FilesystemError::AccessDenied)?;
        if &entry.owner != owner
            || &entry.workspace_id != workspace_id
            || entry.generation != generation
        {
            return Err(FilesystemError::AccessDenied);
        }
        // Past expiry, a successful restore is cleanup; a conflict retains the
        // hidden tombstone rather than replacing the concurrent file.
        root.undo_recoverable_delete(&entry.path, token)?;
        book.entries.remove(token);
        Ok(())
    }

    pub fn restore_workspace_recoveries(
        &self,
        owner: &OwnerId,
        workspace_id: &WorkspaceId,
        generation: SessionGeneration,
        root: &TrustedRoot,
    ) -> Result<(), FilesystemError> {
        let mut book = self.lock_recoveries();
        let tokens: Vec<String> = book
            .entries
            .iter()
            .filter(|(_, entry)| {
                &entry.owner == owner
                    && &entry.workspace_id == workspace_id
                    && entry.generation == generation
            })
            .map(|(token, _)| token.clone())
            .collect();
        let mut errors = Vec::new();
        for token in tokens {
            let Some(entry) = book.entries.get(&token).cloned() else {
                continue;
            };
            match root.undo_recoverable_delete(&entry.path, &token) {
                Ok(()) => {
                    book.entries.remove(&token);
                }
                Err(error) => errors.push(error.to_string()),
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(FilesystemError::CleanupUnproven {
                workspace_id: Some(workspace_id.clone()),
                reason: errors.join("; "),
            })
        }
    }
}
