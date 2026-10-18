// SPDX-License-Identifier: Apache-2.0
//! Real G2 DesktopPort host commands implementation (`src/frontend_files.rs`).
//!
//! Provides the 12 DesktopPort file commands matching the renderer contracts,
//! with owner authorization fence, native dialogs within spawn_blocking,
//! host-only 32MiB PDF tokens, and native directory change monitoring.

use std::{
    collections::{HashMap, HashSet, VecDeque},
    path::PathBuf,
    panic::{catch_unwind, AssertUnwindSafe},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Condvar, Mutex, MutexGuard, OnceLock, PoisonError, Weak,
    },
    thread::{self, JoinHandle},
    time::Duration,
};

use serde::Serialize;
use tauri::{ipc::Response as IpcResponse, Emitter, State, WebviewWindow};

use crate::{
    state::binary_tokens::{BinaryTokenStore, OwnerAdmission, TokenLimits, WorkspaceAdmission},
    services::filesystem::{FilesystemError, FilesystemService, TaskDrainHandle, WatchNotification},
    schemas::protocol::{
        validate_pdf, FileEntry, FileEvent, FileRef, FileWatchFailure,
        OwnerId, ReadReceipt, RecentDocument, RecentId, Revision, SaveAsReceipt, SaveAsRequest,
        Timestamp, WorkspaceId, WorkspaceInfo, WorkspaceKind, WriteReceipt, WriteRequest,
        MAX_PDF_BYTES, MAX_READ_BYTES,
    },
    state::recent::RecentStore,
    shared::relative_path::RelativePath,
    state::settings::SettingsStore,
    state::sessions::SessionRegistry,
    services::watch_native::{
        DefaultWatchValidator, NativeWatchRegistry, NativeWatchSubscription, RawNotifyAction,
        ValidatorDisposition, WatchAccessError, WatchConfig, WatchGeneration, WatchSignal,
        WatchValidatorSeam,
    },
    state::workspace_leases::WorkspaceLeaseCoordinator,
};

pub trait DialogSeam: Send + Sync {
    fn pick_folder(&self, window: &WebviewWindow) -> Option<PathBuf>;
    fn pick_file(&self, window: &WebviewWindow) -> Option<PathBuf>;
    fn save_file(&self, window: &WebviewWindow) -> Option<PathBuf>;
}

pub struct NativeDialogSeam;

impl DialogSeam for NativeDialogSeam {
    fn pick_folder(&self, window: &WebviewWindow) -> Option<PathBuf> {
        use tauri_plugin_dialog::DialogExt;
        window
            .dialog()
            .file()
            .set_parent(window)
            .blocking_pick_folder()
            .and_then(|fp| fp.into_path().ok())
    }

    fn pick_file(&self, window: &WebviewWindow) -> Option<PathBuf> {
        use tauri_plugin_dialog::DialogExt;
        window
            .dialog()
            .file()
            .set_parent(window)
            .blocking_pick_file()
            .and_then(|fp| fp.into_path().ok())
    }

    fn save_file(&self, window: &WebviewWindow) -> Option<PathBuf> {
        use tauri_plugin_dialog::DialogExt;
        window
            .dialog()
            .file()
            .set_parent(window)
            .blocking_save_file()
            .and_then(|fp| fp.into_path().ok())
    }
}

pub struct HostWatchValidator {
    inner: DefaultWatchValidator,
}

impl Default for HostWatchValidator {
    fn default() -> Self {
        Self::new()
    }
}

impl HostWatchValidator {
    pub fn new() -> Self {
        Self {
            inner: DefaultWatchValidator::default(),
        }
    }
}

impl WatchValidatorSeam for HostWatchValidator {
    fn validate_notified_path(
        &self,
        root_identity: crate::services::watch_native::DirectoryIdentity,
        path: &RelativePath,
        action: RawNotifyAction,
    ) -> ValidatorDisposition {
        self.inner.validate_notified_path(root_identity, path, action)
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchEventMessage {
    pub subscription_id: String,
    pub generation: u64,
    pub event: FileEvent,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchErrorMessage {
    pub subscription_id: String,
    pub generation: u64,
    pub failure: FileWatchFailure,
}

#[derive(Serialize)]
#[serde(untagged)]
pub enum ReadFileResult {
    NonPdf(ReadReceipt),
    Pdf(PdfReadMetadata),
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfReadMetadata {
    pub workspace_id: WorkspaceId,
    pub path: RelativePath,
    pub revision: Revision,
    pub binary_token: String,
}

struct ActiveWatch {
    subscription_id: String,
    renderer_generation: u64,
    native_generation: WatchGeneration,
    native_subscription: Arc<NativeWatchSubscription>,
    fs_drain: TaskDrainHandle,
    native_registry: Arc<NativeWatchRegistry>,
    delivery_gate: Arc<WatchDeliveryGate>,
    cleanup_permit: Mutex<Option<WatchCleanupPermit>>,
    stopped: Arc<AtomicBool>,
    drain_worker: Mutex<Option<JoinHandle<()>>>,
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum DeliveryGateState {
    Pending,
    Active,
    Closed,
}

struct WatchDeliveryGate {
    state: Mutex<DeliveryGateState>,
    condvar: Condvar,
}

impl WatchDeliveryGate {
    fn new() -> Self {
        Self {
            state: Mutex::new(DeliveryGateState::Pending),
            condvar: Condvar::new(),
        }
    }

    fn activate(&self) -> bool {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if *state != DeliveryGateState::Pending {
            return false;
        }
        *state = DeliveryGateState::Active;
        self.condvar.notify_all();
        true
    }

    fn deactivate(&self) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        *state = DeliveryGateState::Closed;
        self.condvar.notify_all();
    }

    fn wait_until_active(&self) -> bool {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        while *state == DeliveryGateState::Pending {
            state = self
                .condvar
                .wait(state)
                .unwrap_or_else(PoisonError::into_inner);
        }
        *state == DeliveryGateState::Active
    }

    // The returned guard is held through the synchronous owner-targeted
    // emission.  Close/replacement therefore linearizes before or after that
    // emission, never in its middle.
    fn enter(&self) -> Option<MutexGuard<'_, DeliveryGateState>> {
        let state = self
            .state
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if *state == DeliveryGateState::Active {
            Some(state)
        } else {
            None
        }
    }
}

const MAX_WATCH_CLEANUP_RESERVATIONS: usize = 256;
const WATCH_CLEANUP_WORKERS: usize = 2;
type WatchCleanupTask = Box<dyn FnOnce() + Send + 'static>;

struct WatchCleanupQueueState {
    tasks: VecDeque<WatchCleanupTask>,
    reservations: usize,
}

struct WatchCleanupQueue {
    state: Mutex<WatchCleanupQueueState>,
    condvar: Condvar,
}

struct WatchCleanupReaper {
    queue: Arc<WatchCleanupQueue>,
    // Retain the fixed pool's join handles; it is never replaced by one thread
    // per cleanup request.
    _workers: Vec<JoinHandle<()>>,
}

impl WatchCleanupReaper {
    fn global() -> Result<Arc<Self>, String> {
        static REAPER: OnceLock<Result<Arc<WatchCleanupReaper>, String>> = OnceLock::new();
        REAPER
            .get_or_init(|| Self::new().map(Arc::new).map_err(|error| error.to_string()))
            .clone()
    }

    fn new() -> Result<Self, std::io::Error> {
        let queue = Arc::new(WatchCleanupQueue {
            state: Mutex::new(WatchCleanupQueueState {
                tasks: VecDeque::with_capacity(MAX_WATCH_CLEANUP_RESERVATIONS),
                reservations: 0,
            }),
            condvar: Condvar::new(),
        });
        let mut workers = Vec::with_capacity(WATCH_CLEANUP_WORKERS);
        for index in 0..WATCH_CLEANUP_WORKERS {
            let worker_queue = Arc::clone(&queue);
            match thread::Builder::new()
                .name(format!("modutex-frontend-watch-reaper-{index}"))
                .spawn(move || watch_cleanup_worker(worker_queue))
            {
                Ok(worker) => workers.push(worker),
                // Keep any successfully created worker owned if the optional
                // second worker cannot be started.
                Err(error) if workers.is_empty() => return Err(error),
                Err(_) => break,
            }
        }
        Ok(Self {
            queue,
            _workers: workers,
        })
    }
}

fn watch_cleanup_worker(queue: Arc<WatchCleanupQueue>) {
    loop {
        let task = {
            let mut state = queue
                .state
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            while state.tasks.is_empty() {
                state = queue
                    .condvar
                    .wait(state)
                    .unwrap_or_else(PoisonError::into_inner);
            }
            state.tasks.pop_front()
        };
        if let Some(task) = task {
            let _ = catch_unwind(AssertUnwindSafe(task));
            let mut state = queue
                .state
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            state.reservations = state.reservations.saturating_sub(1);
            queue.condvar.notify_all();
        }
    }
}

struct WatchCleanupPermit {
    queue: Arc<WatchCleanupQueue>,
    queued: bool,
}

impl WatchCleanupPermit {
    fn reserve() -> Result<Self, String> {
        let reaper = WatchCleanupReaper::global()?;
        let mut state = reaper
            .queue
            .state
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if state.reservations >= MAX_WATCH_CLEANUP_RESERVATIONS {
            return Err("watch cleanup capacity exceeded".to_owned());
        }
        state.reservations += 1;
        drop(state);
        Ok(Self {
            queue: Arc::clone(&reaper.queue),
            queued: false,
        })
    }

    fn submit(mut self, task: impl FnOnce() + Send + 'static) {
        let mut state = self
            .queue
            .state
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        debug_assert!(state.tasks.len() < MAX_WATCH_CLEANUP_RESERVATIONS);
        state.tasks.push_back(Box::new(task));
        self.queued = true;
        self.queue.condvar.notify_one();
    }
}

impl Drop for WatchCleanupPermit {
    fn drop(&mut self) {
        if !self.queued {
            let mut state = self
                .queue
                .state
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            state.reservations = state.reservations.saturating_sub(1);
            self.queue.condvar.notify_all();
        }
    }
}

struct WatchCleanupResources {
    subscription: Arc<NativeWatchSubscription>,
    fs_drain: TaskDrainHandle,
    drain_worker: Option<JoinHandle<()>>,
    native_registry: Arc<NativeWatchRegistry>,
    owner: OwnerId,
    workspace_id: WorkspaceId,
    native_generation: WatchGeneration,
}

fn queue_watch_cleanup(permit: WatchCleanupPermit, resources: WatchCleanupResources) {
    resources.subscription.request_stop();
    permit.submit(move || {
        let WatchCleanupResources {
            subscription,
            fs_drain,
            drain_worker,
            native_registry,
            owner,
            workspace_id,
            native_generation,
        } = resources;

        // This runs only on a reserved reaper worker, never on a Tauri command
        // or window-close callback.  The exact-generation unsubscribe cannot
        // remove a replacement subscription.
        let _ = native_registry.unsubscribe(
            &owner,
            &workspace_id,
            Some(native_generation),
        );
        let bridge_joined = if let Some(worker) = drain_worker {
            let _ = worker.join();
            true
        } else {
            true
        };

        // Do not release the filesystem watch lease until both worker handles
        // have been joined.  A failed join proof deliberately leaves the task
        // undrained so FilesystemService retains its lease for pending cleanup.
        while !subscription.join_after_stop() {
            thread::sleep(Duration::from_millis(10));
        }
        if bridge_joined && subscription.is_joined() {
            let proof_subscription = Arc::clone(&subscription);
            let _ = fs_drain.finish_drain_with(|| {
                if proof_subscription.is_joined() {
                    Ok(())
                } else {
                    Err("native watch worker was not joined".to_owned())
                }
            });
        }
    });
}

struct WorkspaceGrant {
    admission: WorkspaceAdmission,
    filesystem_generation: crate::state::workspace_leases::SessionGeneration,
    epoch: u64,
}

#[derive(Default)]
struct OwnerAdmissions {
    owner: Option<OwnerAdmission>,
    workspaces: HashMap<WorkspaceId, WorkspaceGrant>,
}

struct FrontendLifecycle {
    document_owners: HashSet<OwnerId>,
    revoked_owners: HashSet<OwnerId>,
    admissions: HashMap<OwnerId, OwnerAdmissions>,
    closing_workspaces: HashSet<(OwnerId, WorkspaceId)>,
    active_watches: HashMap<(OwnerId, WorkspaceId), Arc<ActiveWatch>>,
    next_admission_epoch: u64,
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
    service: Arc<FilesystemService>,
    tokens: Arc<BinaryTokenStore>,
    native_watch: Arc<NativeWatchRegistry>,
    dialog: Arc<dyn DialogSeam>,
    lifecycle: Mutex<FrontendLifecycle>,
    // Serializes start/replacement/stop/close transitions.  No native worker
    // join is performed while this lock is held.
    watch_transition: Mutex<()>,
}

impl FrontendFilesState {
    pub fn new(
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
        let tokens = Arc::new(BinaryTokenStore::new(TokenLimits::default()).map_err(|_| {
            FilesystemError::InvalidPath("invalid token limits".to_owned())
        })?);
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

    pub fn tokens(&self) -> &Arc<BinaryTokenStore> {
        &self.tokens
    }

    pub fn dialog(&self) -> &Arc<dyn DialogSeam> {
        &self.dialog
    }

    fn lock_lifecycle(&self) -> MutexGuard<'_, FrontendLifecycle> {
        self.lifecycle
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    fn lock_watch_transition(&self) -> MutexGuard<'_, ()> {
        self.watch_transition
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    /// Host-only registration.  Call only for a document window created by
    /// the trusted host; preview and external webviews are never registered.
    pub(crate) fn register_document_window_label(
        &self,
        label: &str,
    ) -> Result<OwnerId, String> {
        let _transition = self.lock_watch_transition();
        let owner = OwnerId::from_label(label).map_err(|error| error.to_string())?;
        let mut lifecycle = self.lock_lifecycle();
        if lifecycle.revoked_owners.contains(&owner) {
            return Err("access denied: owner revoked".to_owned());
        }
        lifecycle.document_owners.insert(owner.clone());
        Ok(owner)
    }

    fn require_owner_live_locked(
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

    fn require_document_owner(&self, owner: &OwnerId) -> Result<(), String> {
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

    pub fn ensure_owner_admission(&self, owner: &OwnerId) -> Result<OwnerAdmission, String> {
        let _transition = self.lock_watch_transition();
        self.ensure_owner_admission_locked(&mut self.lock_lifecycle(), owner)
    }

    fn admit_workspace_locked(
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

    pub fn admit_workspace(
        &self,
        owner: &OwnerId,
        workspace_id: WorkspaceId,
    ) -> Result<WorkspaceAdmission, String> {
        let _transition = self.lock_watch_transition();
        let mut lifecycle = self.lock_lifecycle();
        self.admit_workspace_locked(&mut lifecycle, owner, workspace_id)
    }

    fn workspace_grant_locked(
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

    fn workspace_grant(
        &self,
        owner: &OwnerId,
        workspace_id: &WorkspaceId,
    ) -> Result<WorkspaceGrant, String> {
        let lifecycle = self.lock_lifecycle();
        self.workspace_grant_locked(&lifecycle, owner, workspace_id)
    }

    fn publish_file_pdf(
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

    pub fn get_workspace_admission(
        &self,
        owner: &OwnerId,
        workspace_id: &WorkspaceId,
    ) -> Result<WorkspaceAdmission, String> {
        Ok(self
            .workspace_grant(owner, workspace_id)?
            .admission)
    }

    pub fn revoke_workspace(&self, owner: &OwnerId, workspace_id: &WorkspaceId) {
        let _transition = self.lock_watch_transition();
        let mut lifecycle = self.lock_lifecycle();
        if let Some(grant) = lifecycle
            .admissions
            .get_mut(owner)
            .and_then(|entry| entry.workspaces.remove(workspace_id))
        {
            self.tokens
                .revoke_workspace_generation(&grant.admission);
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
                    self.tokens
                        .revoke_owner_generation(&owner_admission);
                }
            }
            watches
        };
        drop(transition);
        for watch in watches_to_stop {
            self.stop_active_watch_instance(&watch);
        }

        // Both operations are non-joining here.  FilesystemService fences the
        // owner before its bounded drain wait; cleanup workers retain leases
        // until native and bridge joins are proven.
        self.native_watch.revoke_owner(owner);
        let _ = self.service.revoke_owner(owner);
    }

    fn stop_matching_watch(
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
                if watch.subscription_id == subscription_id && watch.renderer_generation == generation {
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

    fn stop_active_watch_instance(&self, watch: &Arc<ActiveWatch>) {
        watch.request_cleanup();
    }

    fn begin_workspace_close(
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
                self.tokens
                    .revoke_workspace_generation(&grant.admission);
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

impl ActiveWatch {
    fn request_cleanup(&self) {
        self.stopped.store(true, Ordering::Release);
        self.delivery_gate.deactivate();
        let permit = self
            .cleanup_permit
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        if let Some(permit) = permit {
            let drain_worker = self
                .drain_worker
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .take();
            queue_watch_cleanup(
                permit,
                WatchCleanupResources {
                    subscription: Arc::clone(&self.native_subscription),
                    fs_drain: self.fs_drain.clone(),
                    drain_worker,
                    native_registry: Arc::clone(&self.native_registry),
                    owner: self.native_subscription.key().owner.clone(),
                    workspace_id: self.native_subscription.key().workspace_id.clone(),
                    native_generation: self.native_generation,
                },
            );
        }
    }
}

impl Drop for ActiveWatch {
    fn drop(&mut self) {
        self.request_cleanup();
    }
}

fn valid_watch_identity(subscription_id: &str, generation: u64) -> bool {
    !subscription_id.is_empty()
        && subscription_id.len() <= 128
        && subscription_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
        && generation > 0
        && generation <= crate::schemas::protocol::MAX_SAFE_INTEGER
}

pub fn verify_trusted_window(
    window: &WebviewWindow,
    state: &FrontendFilesState,
) -> Result<OwnerId, String> {
    let owner = OwnerId::from_label(window.label()).map_err(|_| {
        "access denied: untrusted window".to_owned()
    })?;
    state.require_document_owner(&owner)?;
    Ok(owner)
}

#[tauri::command]
pub async fn frontend_open_workspace(
    window: WebviewWindow,
    state: State<'_, FrontendFilesState>,
    kind: WorkspaceKind,
) -> Result<Option<WorkspaceInfo>, String> {
    let _owner = verify_trusted_window(&window, &state)?;
    let dialog = Arc::clone(state.dialog());
    let win = window.clone();

    let chosen_path = tauri::async_runtime::spawn_blocking(move || match kind {
        WorkspaceKind::Folder => dialog.pick_folder(&win),
        WorkspaceKind::File => dialog.pick_file(&win),
    })
    .await
    .map_err(|e| e.to_string())?;

    let Some(path) = chosen_path else {
        return Ok(None);
    };

    let owner = verify_trusted_window(&window, &state)?;
    let _transition = state.lock_watch_transition();
    let mut lifecycle = state.lock_lifecycle();
    state.require_owner_live_locked(&lifecycle, &owner)?;
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    let opened_at = Timestamp::new(now_ms).map_err(|e| e.to_string())?;

    let outcome = match kind {
        WorkspaceKind::Folder => state.service.open_workspace_folder(&owner, &path, None, opened_at),
        WorkspaceKind::File => state.service.open_workspace_file(&owner, &path, opened_at),
    }
    .map_err(|e| e.to_string())?;
    if let Err(error) =
        state.admit_workspace_locked(&mut lifecycle, &owner, outcome.opened.id.clone())
    {
        let _ = state
            .service
            .close_workspace(&owner, &outcome.opened.id);
        return Err(error);
    }
    Ok(Some(outcome.opened))
}

#[tauri::command]
pub fn frontend_list_recent(
    window: WebviewWindow,
    state: State<'_, FrontendFilesState>,
) -> Result<Vec<RecentDocument>, String> {
    let owner = verify_trusted_window(&window, &state)?;
    let _lifecycle = state.lock_lifecycle();
    state.require_owner_live_locked(&_lifecycle, &owner)?;
    state.service.list_recent().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn frontend_open_recent(
    window: WebviewWindow,
    state: State<'_, FrontendFilesState>,
    id: RecentId,
) -> Result<WorkspaceInfo, String> {
    let owner = verify_trusted_window(&window, &state)?;
    let _transition = state.lock_watch_transition();
    let mut lifecycle = state.lock_lifecycle();
    state.require_owner_live_locked(&lifecycle, &owner)?;
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    let opened_at = Timestamp::new(now_ms).map_err(|e| e.to_string())?;

    let outcome = state
        .service
        .reopen_recent(&owner, id.as_str(), opened_at)
        .map_err(|e| e.to_string())?;

    if let Err(error) =
        state.admit_workspace_locked(&mut lifecycle, &owner, outcome.opened.id.clone())
    {
        let _ = state
            .service
            .close_workspace(&owner, &outcome.opened.id);
        return Err(error);
    }
    Ok(outcome.opened)
}

#[tauri::command]
pub fn frontend_remove_recent(
    window: WebviewWindow,
    state: State<'_, FrontendFilesState>,
    id: RecentId,
) -> Result<(), String> {
    let owner = verify_trusted_window(&window, &state)?;
    let _lifecycle = state.lock_lifecycle();
    state.require_owner_live_locked(&_lifecycle, &owner)?;
    state.service.remove_recent(id.as_str()).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn frontend_list_files(
    window: WebviewWindow,
    state: State<'_, FrontendFilesState>,
    workspace_id: WorkspaceId,
) -> Result<Vec<FileEntry>, String> {
    let owner = verify_trusted_window(&window, &state)?;
    state.require_document_owner(&owner)?;
    state.service.list_files(&owner, &workspace_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn frontend_read_file(
    window: WebviewWindow,
    state: State<'_, FrontendFilesState>,
    file: FileRef,
) -> Result<ReadFileResult, String> {
    let owner = verify_trusted_window(&window, &state)?;
    let is_pdf = file.path.as_str().to_ascii_lowercase().ends_with(".pdf");

    if !is_pdf {
        let receipt = state.service.read_file(&owner, &file).map_err(|e| e.to_string())?;
        if receipt.bytes.len() > MAX_READ_BYTES {
            return Err("byte limit exceeded".to_string());
        }
        return Ok(ReadFileResult::NonPdf(receipt));
    }

    // Capture the exact capability and filesystem generation before I/O.
    let grant = state.workspace_grant(&owner, &file.workspace_id)?;
    let receipt = state.service.read_file_pdf(&owner, &file).map_err(|e| e.to_string())?;

    if receipt.bytes.len() > MAX_PDF_BYTES {
        return Err("PDF byte limit exceeded".to_string());
    }
    validate_pdf(&receipt.bytes).map_err(|e| e.to_string())?;

    // Publication rechecks the captured grant under the same lifecycle lock
    // used by close/revoke.  It never mints a fresh capability after I/O.
    let token = state.publish_file_pdf(
        &owner,
        &file.workspace_id,
        &grant,
        file.path.clone(),
        receipt.revision.clone(),
        receipt.bytes,
    )?;

    Ok(ReadFileResult::Pdf(PdfReadMetadata {
        workspace_id: receipt.workspace_id,
        path: receipt.path,
        revision: receipt.revision,
        binary_token: token,
    }))
}

#[tauri::command]
pub fn frontend_take_file_pdf(
    window: WebviewWindow,
    state: State<'_, FrontendFilesState>,
    token: String,
) -> Result<IpcResponse, String> {
    let owner = verify_trusted_window(&window, &state)?;
    let owner_adm = state.ensure_owner_admission(&owner)?;
    let bytes = state
        .tokens
        .take_file_pdf(&owner_adm, &token)
        .map_err(|_| "TokenDenied".to_string())?;
    Ok(IpcResponse::new(bytes))
}

#[tauri::command]
pub fn frontend_write_file(
    window: WebviewWindow,
    state: State<'_, FrontendFilesState>,
    request: WriteRequest,
) -> Result<WriteReceipt, String> {
    let owner = verify_trusted_window(&window, &state)?;
    state.service.write_file(&owner, &request).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn frontend_save_as(
    window: WebviewWindow,
    state: State<'_, FrontendFilesState>,
    request: SaveAsRequest,
) -> Result<Option<SaveAsReceipt>, String> {
    let _owner = verify_trusted_window(&window, &state)?;
    let dialog = Arc::clone(state.dialog());
    let win = window.clone();

    let chosen_path = tauri::async_runtime::spawn_blocking(move || {
        dialog.save_file(&win)
    })
    .await
    .map_err(|e| e.to_string())?;

    let owner = verify_trusted_window(&window, &state)?;
    let _transition = state.lock_watch_transition();
    let mut lifecycle = state.lock_lifecycle();
    state.require_owner_live_locked(&lifecycle, &owner)?;
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    let opened_at = Timestamp::new(now_ms).map_err(|e| e.to_string())?;

    let maybe_outcome = state
        .service
        .save_as(&owner, &request, chosen_path.as_deref(), opened_at)
        .map_err(|e| e.to_string())?;

    if let Some(outcome) = maybe_outcome {
        if let Err(error) = state.admit_workspace_locked(
            &mut lifecycle,
            &owner,
            outcome.opened.workspace.id.clone(),
        ) {
            let _ = state
                .service
                .close_workspace(&owner, &outcome.opened.workspace.id);
            return Err(error);
        }
        Ok(Some(outcome.opened))
    } else {
        Ok(None)
    }
}

#[tauri::command]
pub fn frontend_watch_start(
    window: WebviewWindow,
    state: State<'_, FrontendFilesState>,
    workspace_id: WorkspaceId,
    subscription_id: String,
    generation: u64,
) -> Result<(), String> {
    let owner = verify_trusted_window(&window, &state)?;
    if !valid_watch_identity(&subscription_id, generation) {
        return Err("invalid subscription id".to_string());
    }
    // Reserve cleanup ownership before creating the filesystem task, native
    // watcher, or bridge thread.  The transition lock prevents a start from
    // installing after a concurrent close or owner revocation.
    let cleanup_permit = WatchCleanupPermit::reserve()?;
    let _transition = state.lock_watch_transition();
    {
        let lifecycle = state.lock_lifecycle();
        state.require_owner_live_locked(&lifecycle, &owner)?;
        state.workspace_grant_locked(&lifecycle, &owner, &workspace_id)?;
    }

    let previous = {
        let mut lifecycle = state.lock_lifecycle();
        let key = (owner.clone(), workspace_id.clone());
        if let Some(previous) = lifecycle.active_watches.remove(&key) {
            previous.delivery_gate.deactivate();
            previous.stopped.store(true, Ordering::Release);
            Some(previous)
        } else {
            None
        }
    };
    if let Some(previous) = previous {
        state.stop_active_watch_instance(&previous);
    }

    let stopped = Arc::new(AtomicBool::new(false));
    let failure_latched = Arc::new(AtomicBool::new(false));
    let delivery_gate = Arc::new(WatchDeliveryGate::new());
    let window_clone = window.clone();
    let sub_id = subscription_id.clone();
    let gen = generation;
    let stopped_for_sink = Arc::clone(&stopped);
    let failure_for_sink = Arc::clone(&failure_latched);
    let gate_for_sink = Arc::clone(&delivery_gate);
    let native_sub_holder: Arc<Mutex<Option<Arc<NativeWatchSubscription>>>> = Arc::new(Mutex::new(None));
    let native_holder_for_cancel = Arc::clone(&native_sub_holder);

    let sink = Arc::new(move |notif: WatchNotification| {
        if stopped_for_sink.load(Ordering::Acquire) {
            return;
        }
        let Some(_delivery) = gate_for_sink.enter() else {
            return;
        };
        if stopped_for_sink.load(Ordering::Acquire) {
            return;
        }
        match notif {
            WatchNotification::Event(event) => {
                if failure_for_sink.load(Ordering::Acquire) {
                    return;
                }
                let _ = window_clone.emit(
                    "frontend://files/event",
                    &WatchEventMessage {
                        subscription_id: sub_id.clone(),
                        generation: gen,
                        event,
                    },
                );
            }
            WatchNotification::Failure { failure, .. } => {
                if failure_for_sink.swap(true, Ordering::AcqRel) {
                    return;
                }
                stopped_for_sink.store(true, Ordering::Release);
                let _ = window_clone.emit(
                    "frontend://files/error",
                    &WatchErrorMessage {
                        subscription_id: sub_id.clone(),
                        generation: gen,
                        failure,
                    },
                );
            }
        }
    });

    let verified_dir = match state
        .service
        .open_verified_watch_target(&owner, &workspace_id)
    {
        Ok(handle) => handle,
        Err(error) => return Err(error.to_string()),
    };

    let stopped_for_cancel = Arc::clone(&stopped);
    let fs_watch = state
        .service
        .start_watch(
            &owner,
            &workspace_id,
            sink,
            Box::new(move || {
                stopped_for_cancel.store(true, Ordering::Release);
                if let Some(sub) = native_holder_for_cancel
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .as_ref()
                {
                    sub.request_stop();
                }
                Ok(())
            }),
        )
        .map_err(|e| e.to_string())?;

    let drain_fs = match fs_watch.drain_handle() {
        Ok(dh) => dh,
        Err(err) => {
            let mut fw = fs_watch;
            fw.finish_drain();
            return Err(err.to_string());
        }
    };
    drop(fs_watch);

    let validator = Arc::new(HostWatchValidator::new());
    let (native_gen, native_sub) = match state
        .native_watch
        .subscribe_with_cleanup(
            owner.clone(),
            workspace_id.clone(),
            verified_dir,
            validator,
            WatchConfig::default(),        )
    {
        Ok(res) => res,
        Err(start_error) => {
            let (error, cleanup) = start_error.into_parts();
            if let Some(subscription) = cleanup {
                // A native registry start failure can occur after the native
                // generation was allocated.  The error carries the actual
                // subscription, whose key is authoritative for cleanup.
                let native_generation = subscription.key().generation;
                queue_watch_cleanup(
                    cleanup_permit,
                    WatchCleanupResources {
                        subscription,
                        fs_drain: drain_fs,
                        drain_worker: None,
                        native_registry: Arc::clone(&state.native_watch),
                        owner: owner.clone(),
                        workspace_id: workspace_id.clone(),
                        native_generation,
                    },
                );
            } else {
                // No native worker was created, so this is the only branch
                // allowed to prove the filesystem task clean synchronously.
                let _ = drain_fs.finish_drain_with(|| Ok(()));
            }
            return Err(error.to_string());
        }
    };

    *native_sub_holder.lock().unwrap_or_else(PoisonError::into_inner) = Some(Arc::clone(&native_sub));

    let drain_sub = Arc::clone(&native_sub);
    let drain_owner = owner.clone();
    let drain_ws = workspace_id.clone();
    let drain_stopped = Arc::clone(&stopped);
    let drain_gate = Arc::clone(&delivery_gate);
    let drain_handle = drain_fs.clone();
    let native_watch_registry = Arc::clone(&state.native_watch);
    let cleanup_trigger: Arc<Mutex<Option<Weak<ActiveWatch>>>> =
        Arc::new(Mutex::new(None));
    let cleanup_trigger_for_worker = Arc::clone(&cleanup_trigger);

    let spawn_res = thread::Builder::new()
        .name(format!("modutex-fs-drain-{}", workspace_id.as_str()))
        .spawn(move || {
            if !drain_gate.wait_until_active() {
                drain_sub.request_stop();
                return;
            }
            while !drain_stopped.load(Ordering::Acquire) && !drain_sub.is_stopped() {
                match drain_sub.wait_and_drain(&drain_owner, &drain_ws, native_gen, Duration::from_millis(150)) {
                    Ok(signals) => {
                        if signals.is_empty() {
                            continue;
                        }
                        let _ = native_watch_registry.dispatch_if_current(
                            &drain_owner,
                            &drain_ws,
                            native_gen,
                            &signals,
                            |dispatched| {
                                for signal in dispatched {
                                    if drain_stopped.load(Ordering::Acquire) {
                                        break;
                                    }
                                    match signal {
                                        WatchSignal::Event { event, .. } => {
                                            let _ = drain_handle.emit_file_event(event.path.clone(), event.kind);
                                        }
                                        WatchSignal::Failure { failure, .. } => {
                                            let _ = drain_handle.emit_failure(*failure);
                                        }
                                        WatchSignal::ResyncRequired { .. } => {
                                            // DesktopPort has no resync payload;
                                            // surface the lost event stream as
                                            // one terminal contract failure.
                                            let _ = drain_handle.emit_failure(FileWatchFailure::FileOperationFailed);
                                        }
                                    }
                                }
                            },
                        );
                    }
                    Err(WatchAccessError::SubscriptionStopped) => break,
                    Err(_) => break,
                }
            }
            drain_sub.request_stop();
            if let Some(watch) = cleanup_trigger_for_worker
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .as_ref()
                .and_then(Weak::upgrade)
            {
                watch.request_cleanup();
            }
        });

    let worker = match spawn_res {
        Ok(worker) => worker,
        Err(err) => {
            queue_watch_cleanup(
                cleanup_permit,
                WatchCleanupResources {
                    subscription: native_sub,
                    fs_drain: drain_fs,
                    drain_worker: None,
                    native_registry: Arc::clone(&state.native_watch),
                    owner: owner.clone(),
                    workspace_id: workspace_id.clone(),
                    native_generation: native_gen,
                },
            );
            return Err(err.to_string());
        }
    };

    let active = Arc::new(ActiveWatch {
        subscription_id,
        renderer_generation: generation,
        native_generation: native_gen,
        native_subscription: Arc::clone(&native_sub),
        fs_drain: drain_fs,
        native_registry: Arc::clone(&state.native_watch),
        delivery_gate: Arc::clone(&delivery_gate),
        cleanup_permit: Mutex::new(Some(cleanup_permit)),
        stopped,
        drain_worker: Mutex::new(Some(worker)),
    });
    *cleanup_trigger
        .lock()
        .unwrap_or_else(PoisonError::into_inner) = Some(Arc::downgrade(&active));

    let installed = {
        let mut lifecycle = state.lock_lifecycle();
        let current_grant = state.workspace_grant_locked(&lifecycle, &owner, &workspace_id);
        let still_current = state
            .require_owner_live_locked(&lifecycle, &owner)
            .is_ok()
            && current_grant.is_ok()
            && !lifecycle
                .closing_workspaces
                .contains(&(owner.clone(), workspace_id.clone()));
        if still_current {
            lifecycle
                .active_watches
                .insert((owner.clone(), workspace_id), Arc::clone(&active));
            delivery_gate.activate()
        } else {
            false
        }
    };
    if !installed {
        active.request_cleanup();
        return Err("STALE_WORKSPACE".to_owned());
    }
    Ok(())
}

#[tauri::command]
pub fn frontend_watch_stop(
    window: WebviewWindow,
    state: State<'_, FrontendFilesState>,
    workspace_id: WorkspaceId,
    subscription_id: String,
    generation: u64,
) -> Result<(), String> {
    let owner = verify_trusted_window(&window, &state)?;
    let _ = state.stop_matching_watch(&owner, &workspace_id, &subscription_id, generation);
    Ok(())
}

#[tauri::command]
pub fn frontend_close_workspace(
    window: WebviewWindow,
    state: State<'_, FrontendFilesState>,
    workspace_id: WorkspaceId,
) -> Result<(), String> {
    let owner = verify_trusted_window(&window, &state)?;
    let (watch, first_close) = state.begin_workspace_close(&owner, &workspace_id);
    if let Some(watch) = watch {
        state.stop_active_watch_instance(&watch);
    }
    if first_close {
        state.service.close_workspace(&owner, &workspace_id).map_err(|e| e.to_string())
    } else {
        state.service.process_pending_cleanup(&owner, &workspace_id).map_err(|e| e.to_string())
    }
}

#[cfg(test)]
#[path = "../../tests/unit/frontend_files.rs"]
mod tests;
