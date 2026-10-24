// SPDX-License-Identifier: Apache-2.0
//! Desktop window admission and frontend files state (`src/state/desktop.rs`).
//!
//! Manages document window admission lifecycle, binary token access grants,
//! and coordinates watch cleanup on window close or owner revocation.

use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::{atomic::Ordering, Arc, Mutex, MutexGuard, PoisonError},
};

use crate::{
    platform::dialogs::{DialogSeam, NativeDialogSeam},
    schemas::protocol::{CompileIdentity, OwnerId, Revision, WorkspaceId},
    services::{
        file_watch::ActiveWatch,
        filesystem::{FilesystemError, FilesystemService},
        watch_native::NativeWatchRegistry,
    },
    shared::relative_path::RelativePath,
    state::{
        binary_tokens::{
            BinaryTokenStore, CompileRunAdmission, OwnerAdmission, TokenLimits, WorkspaceAdmission,
        },
        recent::RecentStore,
        sessions::SessionRegistry,
        settings::SettingsStore,
        workspace_files::WorkspaceFilesState,
        workspace_leases::{SessionGeneration, WorkspaceLeaseCoordinator},
    },
};

pub(crate) struct WorkspaceGrant {
    pub(crate) admission: WorkspaceAdmission,
    pub(crate) filesystem_generation: SessionGeneration,
    pub(crate) epoch: u64,
}

pub(crate) fn publish_compile_pdf_ticket(
    token_store: &BinaryTokenStore,
    workspace: &WorkspaceAdmission,
    identity: &CompileIdentity,
    bytes: Vec<u8>,
) -> Result<(String, CompileRunAdmission), String> {
    let run = token_store
        .admit_compile_run(workspace, identity.clone())
        .map_err(|error| error.to_string())?;
    let token = match token_store.issue_compile_pdf(&run, bytes) {
        Ok(token) => token,
        Err(error) => {
            token_store.revoke_compile_run(&run);
            return Err(error.to_string());
        }
    };
    Ok((token.to_wire(), run))
}

#[derive(Default)]
struct OwnerAdmissions {
    owner: Option<OwnerAdmission>,
    workspaces: HashMap<WorkspaceId, WorkspaceGrant>,
}

pub(crate) struct FrontendLifecycle {
    pub(crate) document_owners: HashSet<OwnerId>,
    pub(crate) revoked_owners: HashSet<OwnerId>,
    admissions: HashMap<OwnerId, OwnerAdmissions>,
    pub(crate) closing_workspaces: HashSet<(OwnerId, WorkspaceId)>,
    pub(crate) active_watches: HashMap<(OwnerId, WorkspaceId), Arc<ActiveWatch>>,
    pub(crate) next_admission_epoch: u64,
}

impl Default for FrontendLifecycle {
    fn default() -> Self {
        Self {
            document_owners: HashSet::new(),
            revoked_owners: HashSet::new(),
            admissions: HashMap::new(),
            closing_workspaces: HashSet::new(),
            active_watches: HashMap::new(),
            next_admission_epoch: 1,
        }
    }
}

pub struct FrontendFilesState {
    pub(crate) service: Arc<FilesystemService>,
    pub(crate) tokens: Arc<BinaryTokenStore>,
    pub(crate) native_watch: Arc<NativeWatchRegistry>,
    pub(crate) dialog: Arc<dyn DialogSeam>,
    pub(crate) lifecycle: Mutex<FrontendLifecycle>,
    pub(crate) workspace_files: WorkspaceFilesState,
    // Serializes start/replacement/stop/close transitions.  No native worker
    // join is performed while this lock is held.
    pub(crate) watch_transition: Mutex<()>,
}

impl FrontendFilesState {
    pub(crate) fn new(
        service: FilesystemService,
        tokens: Arc<BinaryTokenStore>,
        native_watch: Arc<NativeWatchRegistry>,
        dialog: Arc<dyn DialogSeam>,
    ) -> Self {
        Self {
            service: Arc::new(service),
            tokens,
            native_watch,
            dialog,
            lifecycle: Mutex::new(FrontendLifecycle::default()),
            workspace_files: WorkspaceFilesState::default(),
            watch_transition: Mutex::new(()),
        }
    }

    pub fn with_data_dir(data_dir: PathBuf) -> Result<Self, FilesystemError> {
        let recent_store = RecentStore::new(data_dir.clone());
        let settings_store = SettingsStore::new(data_dir);
        let service = FilesystemService::new(
            Arc::new(SessionRegistry::new()),
            WorkspaceLeaseCoordinator::new(),
            recent_store,
            settings_store,
        );
        let tokens = Arc::new(
            BinaryTokenStore::new(TokenLimits::default())
                .map_err(|_| FilesystemError::InvalidPath("invalid token limits".to_owned()))?,
        );
        let native_watch = Arc::new(NativeWatchRegistry::new());
        Ok(Self::new(
            service,
            tokens,
            native_watch,
            Arc::new(NativeDialogSeam),
        ))
    }

    pub fn service(&self) -> &FilesystemService {
        self.service.as_ref()
    }

    /// Terminal and compile coordinators must clone this same initialized
    /// service rather than constructing a second registry or data store.
    pub fn shared_service(&self) -> Arc<FilesystemService> {
        Arc::clone(&self.service)
    }

    pub fn dialog(&self) -> &Arc<dyn DialogSeam> {
        &self.dialog
    }

    pub(crate) fn lock_lifecycle(&self) -> MutexGuard<'_, FrontendLifecycle> {
        self.lifecycle
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    pub(crate) fn lock_watch_transition(&self) -> MutexGuard<'_, ()> {
        self.watch_transition
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    /// Host-only registration.  Call only for a document window created by
    /// the trusted host; preview and external webviews are never registered.
    pub fn register_document_window_label(&self, label: &str) -> Result<OwnerId, String> {
        let _transition = self.lock_watch_transition();
        let owner = OwnerId::from_label(label).map_err(|error| error.to_string())?;
        let mut lifecycle = self.lock_lifecycle();
        if lifecycle.revoked_owners.contains(&owner) {
            return Err("access denied: owner revoked".to_owned());
        }
        if !lifecycle.document_owners.insert(owner.clone()) {
            return Err("access denied: owner already registered".to_owned());
        }
        Ok(owner)
    }

    pub(crate) fn require_owner_live_locked(
        &self,
        lifecycle: &FrontendLifecycle,
        owner: &OwnerId,
    ) -> Result<(), String> {
        if !lifecycle.document_owners.contains(owner) {
            return Err("access denied: unregistered document window".to_owned());
        }
        if lifecycle.revoked_owners.contains(owner) {
            return Err("access denied: owner revoked".to_owned());
        }
        Ok(())
    }

    pub(crate) fn require_document_owner(&self, owner: &OwnerId) -> Result<(), String> {
        let lifecycle = self.lock_lifecycle();
        self.require_owner_live_locked(&lifecycle, owner)
    }

    pub fn is_owner_revoked(&self, owner: &OwnerId) -> bool {
        self.lock_lifecycle().revoked_owners.contains(owner)
    }

    fn ensure_owner_admission_locked(
        &self,
        lifecycle: &mut FrontendLifecycle,
        owner: &OwnerId,
    ) -> Result<OwnerAdmission, String> {
        self.require_owner_live_locked(lifecycle, owner)?;
        if let Some(admission) = lifecycle
            .admissions
            .get(owner)
            .and_then(|entry| entry.owner.clone())
        {
            return Ok(admission);
        }
        let admission = self
            .tokens
            .admit_owner_generation(owner.clone())
            .map_err(|error| error.to_string())?;
        lifecycle.admissions.insert(
            owner.clone(),
            OwnerAdmissions {
                owner: Some(admission.clone()),
                workspaces: HashMap::new(),
            },
        );
        Ok(admission)
    }

    pub(crate) fn ensure_owner_admission(&self, owner: &OwnerId) -> Result<OwnerAdmission, String> {
        let _transition = self.lock_watch_transition();
        self.ensure_owner_admission_locked(&mut self.lock_lifecycle(), owner)
    }

    pub(crate) fn admit_workspace_locked(
        &self,
        lifecycle: &mut FrontendLifecycle,
        owner: &OwnerId,
        workspace_id: WorkspaceId,
    ) -> Result<WorkspaceAdmission, String> {
        self.require_owner_live_locked(lifecycle, owner)?;
        let key = (owner.clone(), workspace_id.clone());
        if lifecycle.closing_workspaces.contains(&key) {
            return Err("STALE_WORKSPACE".to_owned());
        }
        let filesystem_generation = self
            .service
            .workspace_generation(owner, &workspace_id)
            .map_err(|error| error.to_string())?;
        if let Some(existing) = lifecycle
            .admissions
            .get(owner)
            .and_then(|entry| entry.workspaces.get(&workspace_id))
        {
            if existing.filesystem_generation == filesystem_generation {
                return Ok(existing.admission.clone());
            }
        }
        let owner_admission = self.ensure_owner_admission_locked(lifecycle, owner)?;
        let epoch = lifecycle.next_admission_epoch;
        lifecycle.next_admission_epoch = epoch
            .checked_add(1)
            .ok_or_else(|| "workspace admission epoch exhausted".to_owned())?;
        let admission = self
            .tokens
            .admit_workspace_generation(&owner_admission, workspace_id.clone())
            .map_err(|error| error.to_string())?;
        lifecycle
            .admissions
            .entry(owner.clone())
            .or_default()
            .workspaces
            .insert(
                workspace_id,
                WorkspaceGrant {
                    admission: admission.clone(),
                    filesystem_generation,
                    epoch,
                },
            );
        Ok(admission)
    }

    pub(crate) fn workspace_grant_locked(
        &self,
        lifecycle: &FrontendLifecycle,
        owner: &OwnerId,
        workspace_id: &WorkspaceId,
    ) -> Result<WorkspaceGrant, String> {
        self.require_owner_live_locked(lifecycle, owner)?;
        if lifecycle
            .closing_workspaces
            .contains(&(owner.clone(), workspace_id.clone()))
        {
            return Err("STALE_WORKSPACE".to_owned());
        }
        let grant = lifecycle
            .admissions
            .get(owner)
            .and_then(|entry| entry.workspaces.get(workspace_id))
            .ok_or_else(|| "access denied: workspace not admitted or revoked".to_owned())?;
        let current_generation = self
            .service
            .workspace_generation(owner, workspace_id)
            .map_err(|error| error.to_string())?;
        if current_generation != grant.filesystem_generation {
            return Err("STALE_WORKSPACE".to_owned());
        }
        Ok(WorkspaceGrant {
            admission: grant.admission.clone(),
            filesystem_generation: grant.filesystem_generation,
            epoch: grant.epoch,
        })
    }

    pub(crate) fn workspace_grant(
        &self,
        owner: &OwnerId,
        workspace_id: &WorkspaceId,
    ) -> Result<WorkspaceGrant, String> {
        let lifecycle = self.lock_lifecycle();
        self.workspace_grant_locked(&lifecycle, owner, workspace_id)
    }

    pub(crate) fn publish_file_pdf(
        &self,
        owner: &OwnerId,
        workspace_id: &WorkspaceId,
        captured: &WorkspaceGrant,
        path: RelativePath,
        revision: Revision,
        bytes: Vec<u8>,
    ) -> Result<String, String> {
        let lifecycle = self.lock_lifecycle();
        let current = self.workspace_grant_locked(&lifecycle, owner, workspace_id)?;
        if current.epoch != captured.epoch
            || current.filesystem_generation != captured.filesystem_generation
        {
            return Err("STALE_WORKSPACE".to_owned());
        }
        self.tokens
            .issue_file_read_pdf(&captured.admission, path, revision, bytes)
            .map(|token| token.to_wire())
            .map_err(|error| error.to_string())
    }

    /// Publish compiler output against the complete host-owned compile
    /// identity. Its source entry may be TeX, not a PDF file path.
    pub(crate) fn publish_compile_pdf(
        &self,
        owner: &OwnerId,
        workspace_id: &WorkspaceId,
        captured: &WorkspaceGrant,
        identity: &CompileIdentity,
        bytes: Vec<u8>,
    ) -> Result<(String, CompileRunAdmission), String> {
        if &identity.workspace_id != workspace_id {
            return Err("compile identity belongs to another workspace".to_owned());
        }
        let lifecycle = self.lock_lifecycle();
        let current = self.workspace_grant_locked(&lifecycle, owner, workspace_id)?;
        if current.epoch != captured.epoch
            || current.filesystem_generation != captured.filesystem_generation
        {
            return Err("STALE_WORKSPACE".to_owned());
        }

        publish_compile_pdf_ticket(&self.tokens, &captured.admission, identity, bytes)
    }

    pub fn revoke_workspace(&self, owner: &OwnerId, workspace_id: &WorkspaceId) {
        let _transition = self.lock_watch_transition();
        let mut lifecycle = self.lock_lifecycle();
        if let Some(grant) = lifecycle
            .admissions
            .get_mut(owner)
            .and_then(|entry| entry.workspaces.remove(workspace_id))
        {
            self.tokens.revoke_workspace_generation(&grant.admission);
        }
    }

    pub fn revoke_owner(&self, owner: &OwnerId) {
        let transition = self.lock_watch_transition();
        let watches_to_stop = {
            let mut lifecycle = self.lock_lifecycle();
            if !lifecycle.document_owners.contains(owner) {
                return;
            }
            lifecycle.revoked_owners.insert(owner.clone());
            let keys: Vec<(OwnerId, WorkspaceId)> = lifecycle
                .admissions
                .get(owner)
                .into_iter()
                .flat_map(|entry| entry.workspaces.keys())
                .map(|workspace| (owner.clone(), workspace.clone()))
                .collect();
            for key in keys {
                lifecycle.closing_workspaces.insert(key);
            }
            for ((watch_owner, _), watch) in lifecycle.active_watches.iter() {
                if watch_owner == owner {
                    watch.delivery_gate.deactivate();
                    watch.stopped.store(true, Ordering::Release);
                }
            }
            let watch_keys: Vec<(OwnerId, WorkspaceId)> = lifecycle
                .active_watches
                .keys()
                .filter(|(watch_owner, _)| watch_owner == owner)
                .cloned()
                .collect();
            let watches = watch_keys
                .into_iter()
                .filter_map(|key| lifecycle.active_watches.remove(&key))
                .collect::<Vec<_>>();
            if let Some(admissions) = lifecycle.admissions.remove(owner) {
                if let Some(owner_admission) = admissions.owner {
                    self.tokens.revoke_owner_generation(&owner_admission);
                }
            }
            watches
        };
        drop(transition);
        self.workspace_files.close_owner_gate(owner);
        for (workspace_id, generation) in self.workspace_files.recovery_workspaces(owner) {
            if let Ok(access) = self
                .service
                .workspace_file_write_access(owner, &workspace_id)
            {
                if access.generation == generation {
                    // Failure is fail-safe: the tombstone remains in the
                    // workspace and is never discarded during owner cleanup.
                    let _ = self.workspace_files.restore_workspace_recoveries(
                        owner,
                        &workspace_id,
                        generation,
                        &access.root,
                    );
                }
            }
        }
        for watch in watches_to_stop {
            self.stop_active_watch_instance(&watch);
        }

        // Both operations are non-joining here.  FilesystemService fences the
        // owner before its bounded drain wait; cleanup workers retain leases
        // until native and bridge joins are proven.
        self.native_watch.revoke_owner(owner);
        let _ = self.service.revoke_owner(owner);
    }

    pub(crate) fn stop_matching_watch(
        &self,
        owner: &OwnerId,
        workspace_id: &WorkspaceId,
        subscription_id: &str,
        generation: u64,
    ) -> bool {
        let _transition = self.lock_watch_transition();
        let removed = {
            let mut lifecycle = self.lock_lifecycle();
            let key = (owner.clone(), workspace_id.clone());
            if let Some(watch) = lifecycle.active_watches.get(&key) {
                if watch.subscription_id == subscription_id
                    && watch.renderer_generation == generation
                {
                    if let Some(watch) = lifecycle.active_watches.remove(&key) {
                        watch.delivery_gate.deactivate();
                        watch.stopped.store(true, Ordering::Release);
                        Some(watch)
                    } else {
                        None
                    }
                } else {
                    None
                }
            } else {
                None
            }
        };

        if let Some(watch) = removed {
            self.stop_active_watch_instance(&watch);
            true
        } else {
            false
        }
    }

    pub fn stop_workspace_watches(&self, owner: &OwnerId, workspace_id: &WorkspaceId) {
        let _transition = self.lock_watch_transition();
        let removed = {
            let mut lifecycle = self.lock_lifecycle();
            let key = (owner.clone(), workspace_id.clone());
            if let Some(watch) = lifecycle.active_watches.remove(&key) {
                watch.delivery_gate.deactivate();
                watch.stopped.store(true, Ordering::Release);
                Some(watch)
            } else {
                None
            }
        };
        if let Some(watch) = removed {
            self.stop_active_watch_instance(&watch);
        }
    }

    pub(crate) fn stop_active_watch_instance(&self, watch: &Arc<ActiveWatch>) {
        watch.request_cleanup();
    }

    pub(crate) fn begin_workspace_close(
        &self,
        owner: &OwnerId,
        workspace_id: &WorkspaceId,
    ) -> (Option<Arc<ActiveWatch>>, bool) {
        let _transition = self.lock_watch_transition();
        let mut lifecycle = self.lock_lifecycle();
        let key = (owner.clone(), workspace_id.clone());
        let first_close = lifecycle.closing_workspaces.insert(key.clone());
        if first_close {
            if let Some(grant) = lifecycle
                .admissions
                .get_mut(owner)
                .and_then(|entry| entry.workspaces.remove(workspace_id))
            {
                self.tokens.revoke_workspace_generation(&grant.admission);
            }
        }
        if let Some(watch) = lifecycle.active_watches.remove(&key) {
            watch.delivery_gate.deactivate();
            watch.stopped.store(true, Ordering::Release);
            (Some(watch), first_close)
        } else {
            (None, first_close)
        }
    }
}
