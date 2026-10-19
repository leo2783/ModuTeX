// SPDX-License-Identifier: Apache-2.0
//! File watch bridge and reaper cleanup (`src/services/file_watch.rs`).
//!
//! Provides the native filesystem directory change monitor bridge,
//! delivery gate serialization, and reserved worker queue cleanup reaper.

use std::{
    collections::VecDeque,
    panic::{catch_unwind, AssertUnwindSafe},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Condvar, Mutex, MutexGuard, OnceLock, PoisonError, Weak,
    },
    thread::{self, JoinHandle},
    time::Duration,
};

use crate::{
    schemas::protocol::{
        FileWatchFailure, OwnerId, WorkspaceId,
    },
    services::{
        filesystem::{FilesystemService, TaskDrainHandle, WatchNotification},
        watch_native::{
            DefaultWatchValidator, DirectoryIdentity, NativeWatchRegistry, NativeWatchSubscription,
            RawNotifyAction, ValidatorDisposition, WatchAccessError, WatchConfig,
            WatchGeneration, WatchSignal, WatchValidatorSeam,
        },
    },
    shared::relative_path::RelativePath,
};

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
        root_identity: DirectoryIdentity,
        path: &RelativePath,
        action: RawNotifyAction,
    ) -> ValidatorDisposition {
        self.inner.validate_notified_path(root_identity, path, action)
    }
}

#[derive(Clone, Copy, Eq, PartialEq)]
pub(crate) enum DeliveryGateState {
    Pending,
    Active,
    Closed,
}

pub(crate) struct WatchDeliveryGate {
    state: Mutex<DeliveryGateState>,
    condvar: Condvar,
}

impl WatchDeliveryGate {
    pub(crate) fn new() -> Self {
        Self {
            state: Mutex::new(DeliveryGateState::Pending),
            condvar: Condvar::new(),
        }
    }

    pub(crate) fn activate(&self) -> bool {
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

    pub(crate) fn deactivate(&self) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        *state = DeliveryGateState::Closed;
        self.condvar.notify_all();
    }

    pub(crate) fn wait_until_active(&self) -> bool {
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
    pub(crate) fn enter(&self) -> Option<MutexGuard<'_, DeliveryGateState>> {
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

pub(crate) struct WatchCleanupPermit {
    queue: Arc<WatchCleanupQueue>,
    queued: bool,
}

impl WatchCleanupPermit {
    pub(crate) fn reserve() -> Result<Self, String> {
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

    pub(crate) fn submit(mut self, task: impl FnOnce() + Send + 'static) {
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

pub(crate) struct WatchCleanupResources {
    pub(crate) subscription: Arc<NativeWatchSubscription>,
    pub(crate) fs_drain: TaskDrainHandle,
    pub(crate) drain_worker: Option<JoinHandle<()>>,
    pub(crate) native_registry: Arc<NativeWatchRegistry>,
    pub(crate) owner: OwnerId,
    pub(crate) workspace_id: WorkspaceId,
    pub(crate) native_generation: WatchGeneration,
}

pub(crate) fn queue_watch_cleanup(permit: WatchCleanupPermit, resources: WatchCleanupResources) {
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

pub(crate) struct ActiveWatch {
    pub(crate) subscription_id: String,
    pub(crate) renderer_generation: u64,
    pub(crate) native_generation: WatchGeneration,
    pub(crate) native_subscription: Arc<NativeWatchSubscription>,
    pub(crate) fs_drain: TaskDrainHandle,
    pub(crate) native_registry: Arc<NativeWatchRegistry>,
    pub(crate) delivery_gate: Arc<WatchDeliveryGate>,
    pub(crate) cleanup_permit: Mutex<Option<WatchCleanupPermit>>,
    pub(crate) stopped: Arc<AtomicBool>,
    pub(crate) drain_worker: Mutex<Option<JoinHandle<()>>>,
}

impl ActiveWatch {
    pub(crate) fn request_cleanup(&self) {
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

pub(crate) fn valid_watch_identity(subscription_id: &str, generation: u64) -> bool {
    !subscription_id.is_empty()
        && subscription_id.len() <= 128
        && subscription_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
        && generation > 0
        && generation <= crate::schemas::protocol::MAX_SAFE_INTEGER
}

pub(crate) fn spawn_watch_bridge(
    owner: OwnerId,
    workspace_id: WorkspaceId,
    subscription_id: String,
    renderer_generation: u64,
    service: &FilesystemService,
    native_watch: &Arc<NativeWatchRegistry>,
    sink: Arc<dyn Fn(WatchNotification) + Send + Sync + 'static>,
    cleanup_permit: WatchCleanupPermit,
    stopped: Arc<AtomicBool>,
    delivery_gate: Arc<WatchDeliveryGate>,
) -> Result<Arc<ActiveWatch>, String> {
    let verified_dir = match service.open_verified_watch_target(&owner, &workspace_id) {
        Ok(handle) => handle,
        Err(error) => return Err(error.to_string()),
    };

    let native_sub_holder: Arc<Mutex<Option<Arc<NativeWatchSubscription>>>> =
        Arc::new(Mutex::new(None));
    let native_holder_for_cancel = Arc::clone(&native_sub_holder);
    let stopped_for_cancel = Arc::clone(&stopped);

    let fs_watch = service
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
    let (native_gen, native_sub) = match native_watch.subscribe_with_cleanup(
        owner.clone(),
        workspace_id.clone(),
        verified_dir,
        validator,
        WatchConfig::default(),
    ) {
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
                        native_registry: Arc::clone(native_watch),
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

    *native_sub_holder
        .lock()
        .unwrap_or_else(PoisonError::into_inner) = Some(Arc::clone(&native_sub));

    let drain_sub = Arc::clone(&native_sub);
    let drain_owner = owner.clone();
    let drain_ws = workspace_id.clone();
    let drain_stopped = Arc::clone(&stopped);
    let drain_gate = Arc::clone(&delivery_gate);
    let drain_handle = drain_fs.clone();
    let native_watch_registry = Arc::clone(native_watch);
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
                    native_registry: Arc::clone(native_watch),
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
        renderer_generation,
        native_generation: native_gen,
        native_subscription: Arc::clone(&native_sub),
        fs_drain: drain_fs,
        native_registry: Arc::clone(native_watch),
        delivery_gate: Arc::clone(&delivery_gate),
        cleanup_permit: Mutex::new(Some(cleanup_permit)),
        stopped,
        drain_worker: Mutex::new(Some(worker)),
    });
    *cleanup_trigger
        .lock()
        .unwrap_or_else(PoisonError::into_inner) = Some(Arc::downgrade(&active));

    Ok(active)
}
