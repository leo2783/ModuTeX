// SPDX-License-Identifier: Apache-2.0
//! Desktop window terminal state, bus, and lifecycle coordination (`src/state/terminal.rs`).

#![cfg(all(windows, target_arch = "x86_64"))]

use std::{
    collections::{HashMap, HashSet, VecDeque},
    ffi::OsString,
    fs, io,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Condvar, Mutex, MutexGuard, PoisonError,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

use tauri::{AppHandle, Emitter, Manager};

use crate::{
    schemas::{
        protocol::{OwnerId, WorkspaceId},
        terminal::{
            map_filesystem_error, validate_input_chunk, TerminalCommandError,
            TerminalCommandErrorCode, TerminalHostErrorCode, TerminalInputRequest,
            TerminalKillRequest, TerminalResizeRequest, TerminalSessionReceipt,
            TerminalSpawnRequest, TerminalWireEvent,
        },
    },
    services::{
        filesystem::FilesystemService,
        terminal_service::{
            cancellation_pair, BoundedEventSink, TerminalAvailability, TerminalCleanupProof,
            TerminalError, TerminalErrorKind, TerminalEvent, TerminalEventPayload,
            TerminalEventSink, TerminalQueueLimits, TerminalService, TerminalSessionId,
            TerminalSessionInfo, TerminalSinkError, TerminalSize, TerminalSpawnSpec,
            TerminalTeardownReport, TrustedShellConfig, DEFAULT_MAX_OUTPUT_CHUNKS,
            DEFAULT_MAX_OUTPUT_QUEUE_BYTES,
        },
    },
    state::workspace_leases::SessionGeneration,
};

pub const TERMINAL_EVENT: &str = "frontend://terminal/event";
pub const MAX_TERMINAL_SESSIONS: usize = 16;
pub const MAX_TERMINAL_OWNERS: usize = 16;
pub const MAX_PENDING_OPERATIONS: usize = 64;
pub const WORKSPACE_DRAIN_TIMEOUT: Duration = Duration::from_secs(5);

#[link(name = "kernel32")]
extern "system" {
    fn GetSystemDirectoryW(buffer: *mut u16, size: u32) -> u32;
}

pub fn trusted_system_directory() -> io::Result<PathBuf> {
    use std::os::windows::ffi::OsStringExt;

    const MAX_SYSTEM_DIRECTORY_UTF16: usize = 32_768;
    let mut buffer = vec![0u16; MAX_SYSTEM_DIRECTORY_UTF16];
    let length = unsafe { GetSystemDirectoryW(buffer.as_mut_ptr(), buffer.len() as u32) } as usize;
    if length == 0 {
        return Err(io::Error::last_os_error());
    }
    if length >= buffer.len() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Windows system directory exceeds the UTF-16 buffer limit",
        ));
    }
    Ok(PathBuf::from(OsString::from_wide(&buffer[..length])))
}

pub fn trusted_windows_shell() -> Result<TrustedShellConfig, TerminalCommandError> {
    let invalid = |detail: &'static str| TerminalCommandError {
        code: TerminalCommandErrorCode::Service(TerminalErrorKind::InvalidShellExecutable),
        detail: detail.to_owned(),
        cleanup: TerminalCleanupProof::NotRequired,
    };

    let expected_path = trusted_system_directory()
        .map_err(|_| invalid("Windows system directory is unavailable"))?
        .join("cmd.exe");
    let expected = canonical_regular_file(&expected_path)
        .map_err(|_| invalid("trusted Windows command processor is unavailable"))?;

    let configured = std::env::var_os("COMSPEC")
        .map(PathBuf::from)
        .unwrap_or_else(|| expected.clone());
    let actual = canonical_regular_file(&configured)
        .map_err(|_| invalid("COMSPEC is not a valid Windows command processor"))?;
    if !same_windows_path(&expected, &actual) {
        return Err(invalid(
            "COMSPEC does not resolve to the Windows system cmd.exe",
        ));
    }

    Ok(TrustedShellConfig::new(
        expected,
        vec![OsString::from("/D"), OsString::from("/Q")],
    ))
}

pub fn canonical_regular_file(path: &Path) -> io::Result<PathBuf> {
    if !path.is_absolute() || path.as_os_str().to_string_lossy().contains('\0') {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "expected an absolute regular-file path",
        ));
    }
    let link_metadata = fs::symlink_metadata(path)?;
    if link_metadata.file_type().is_symlink() || !link_metadata.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "path is not a non-symlink regular file",
        ));
    }
    let canonical = fs::canonicalize(path)?;
    if !fs::metadata(&canonical)?.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "canonical path is not a regular file",
        ));
    }
    Ok(canonical)
}

pub fn same_windows_path(left: &Path, right: &Path) -> bool {
    left.to_string_lossy()
        .eq_ignore_ascii_case(&right.to_string_lossy())
}

#[derive(Clone)]
pub(crate) struct SpawnBinding {
    pub(crate) owner: OwnerId,
    pub(crate) workspace_id: WorkspaceId,
}

#[derive(Clone)]
pub(crate) struct SessionBinding {
    pub(crate) owner: OwnerId,
    pub(crate) workspace_id: WorkspaceId,
    pub(crate) terminal_generation: u64,
    pub(crate) filesystem_generation: SessionGeneration,
    pub(crate) in_flight: usize,
    pub(crate) closing: bool,
}

#[derive(Default)]
pub(crate) struct StagedEvents {
    pub(crate) events: VecDeque<TerminalEvent>,
    pub(crate) data_bytes: usize,
}

#[derive(Default)]
pub(crate) struct RouteState {
    pub(crate) sessions: HashMap<TerminalSessionId, SessionBinding>,
    pub(crate) spawns: HashMap<u64, SpawnBinding>,
    pub(crate) next_spawn_id: u64,
    pub(crate) active_owners: HashSet<OwnerId>,
    pub(crate) revoked_owners: HashSet<OwnerId>,
    pub(crate) closed_workspaces: HashSet<(OwnerId, WorkspaceId)>,
    pub(crate) owner_gates: HashMap<OwnerId, Arc<Mutex<()>>>,
    pub(crate) stopping: bool,
}

pub struct TerminalEventBus {
    pub(crate) output: Arc<BoundedEventSink>,
    pub(crate) staged: Mutex<StagedEvents>,
    pub(crate) routes: Mutex<RouteState>,
    pub(crate) changed: Condvar,
}

impl TerminalEventBus {
    pub fn new() -> Self {
        Self {
            output: Arc::new(BoundedEventSink::new(
                DEFAULT_MAX_OUTPUT_CHUNKS,
                DEFAULT_MAX_OUTPUT_QUEUE_BYTES,
            )),
            staged: Mutex::new(StagedEvents::default()),
            routes: Mutex::new(RouteState {
                next_spawn_id: 1,
                ..RouteState::default()
            }),
            changed: Condvar::new(),
        }
    }

    pub fn reserve_spawn(
        self: &Arc<Self>,
        owner: OwnerId,
        workspace_id: WorkspaceId,
    ) -> Result<SpawnAdmission, TerminalCommandError> {
        let mut routes = lock(&self.routes);
        if routes.revoked_owners.contains(&owner) {
            return Err(TerminalCommandError::host(
                TerminalHostErrorCode::OwnerRevoked,
                "terminal access has been revoked",
            ));
        }
        if routes
            .closed_workspaces
            .contains(&(owner.clone(), workspace_id.clone()))
        {
            return Err(TerminalCommandError::host(
                TerminalHostErrorCode::WorkspaceClosed,
                "workspace is closed",
            ));
        }
        if routes.sessions.len() + routes.spawns.len() >= MAX_TERMINAL_SESSIONS {
            return Err(TerminalCommandError::host(
                TerminalHostErrorCode::ResourceExhausted,
                "terminal session limit reached",
            ));
        }
        if !routes.active_owners.contains(&owner) {
            if routes.active_owners.len() >= MAX_TERMINAL_OWNERS {
                return Err(TerminalCommandError::host(
                    TerminalHostErrorCode::ResourceExhausted,
                    "terminal owner limit reached",
                ));
            }
            routes.active_owners.insert(owner.clone());
            routes
                .owner_gates
                .entry(owner.clone())
                .or_insert_with(|| Arc::new(Mutex::new(())));
        }
        let spawn_id = routes.next_spawn_id;
        routes.next_spawn_id = routes.next_spawn_id.checked_add(1).ok_or_else(|| {
            TerminalCommandError::host(
                TerminalHostErrorCode::ResourceExhausted,
                "terminal spawn identifiers exhausted",
            )
        })?;
        routes.spawns.insert(
            spawn_id,
            SpawnBinding {
                owner: owner.clone(),
                workspace_id: workspace_id.clone(),
            },
        );
        drop(routes);
        self.changed.notify_all();
        Ok(SpawnAdmission {
            bus: Arc::clone(self),
            spawn_id,
            owner,
            workspace_id,
            committed: false,
        })
    }

    pub(crate) fn commit_spawn(
        &self,
        admission: &SpawnAdmission,
        info: &TerminalSessionInfo,
        filesystem_generation: SessionGeneration,
    ) -> Result<TerminalSessionReceipt, TerminalCommandError> {
        let mut routes = lock(&self.routes);
        if routes.revoked_owners.contains(&admission.owner) {
            return Err(TerminalCommandError::host(
                TerminalHostErrorCode::OwnerRevoked,
                "terminal owner was revoked during spawn",
            ));
        }
        if routes
            .closed_workspaces
            .contains(&(admission.owner.clone(), admission.workspace_id.clone()))
        {
            return Err(TerminalCommandError::host(
                TerminalHostErrorCode::WorkspaceClosed,
                "workspace closed during terminal spawn",
            ));
        }
        let Some(spawn) = routes.spawns.get(&admission.spawn_id) else {
            return Err(TerminalCommandError::deferred(
                "terminal spawn admission was retired",
            ));
        };
        if spawn.owner != admission.owner
            || spawn.workspace_id != admission.workspace_id
            || info.workspace_id != admission.workspace_id
        {
            return Err(TerminalCommandError::host(
                TerminalHostErrorCode::Internal,
                "terminal spawn identity mismatch",
            ));
        }
        routes.spawns.remove(&admission.spawn_id);
        routes.sessions.insert(
            info.session_id.clone(),
            SessionBinding {
                owner: admission.owner.clone(),
                workspace_id: admission.workspace_id.clone(),
                terminal_generation: info.generation,
                filesystem_generation,
                in_flight: 0,
                closing: false,
            },
        );
        let receipt = TerminalSessionReceipt {
            session_id: info.session_id.clone(),
            workspace_id: info.workspace_id.clone(),
            generation: info.generation,
            size: info.size,
        };
        drop(routes);
        self.flush_staged_for_session(&info.session_id)
            .map_err(|_| {
                TerminalCommandError::from(TerminalError::with_cleanup(
                    TerminalErrorKind::OutputBackpressure,
                    "terminal output queue is full while completing spawn",
                    TerminalCleanupProof::Deferred,
                ))
            })?;
        self.changed.notify_all();
        Ok(receipt)
    }

    pub(crate) fn finish_spawn(&self, spawn_id: u64, owner: &OwnerId) {
        let (idle_owner, discard_workspace) = {
            let mut routes = lock(&self.routes);
            let removed = routes.spawns.remove(&spawn_id);
            let has_session = routes.sessions.values().any(|item| &item.owner == owner);
            let has_spawn = routes.spawns.values().any(|item| &item.owner == owner);
            let idle = !has_session && !has_spawn && !routes.revoked_owners.contains(owner);
            let discard_workspace = removed.as_ref().is_some_and(|spawn| {
                !routes.spawns.values().any(|item| {
                    item.owner == spawn.owner && item.workspace_id == spawn.workspace_id
                }) && !routes.sessions.values().any(|item| {
                    item.owner == spawn.owner && item.workspace_id == spawn.workspace_id
                })
            });
            if idle {
                routes.active_owners.remove(owner);
                routes.owner_gates.remove(owner);
            }
            (
                idle,
                removed
                    .filter(|_| discard_workspace)
                    .map(|spawn| spawn.workspace_id),
            )
        };
        if let Some(workspace_id) = discard_workspace {
            self.discard_staged(owner, Some(&workspace_id));
        }
        if idle_owner {
            self.output.drop_for_owner(owner);
        }
        self.changed.notify_all();
    }

    pub(crate) fn begin_session_operation(
        self: &Arc<Self>,
        owner: &OwnerId,
        session_id: &TerminalSessionId,
    ) -> Result<(SessionBinding, SessionOperation), TerminalCommandError> {
        let mut routes = lock(&self.routes);
        if routes.revoked_owners.contains(owner) {
            return Err(TerminalCommandError::host(
                TerminalHostErrorCode::OwnerRevoked,
                "terminal owner was revoked",
            ));
        }
        let Some(binding) = routes.sessions.get(session_id) else {
            return Err(TerminalCommandError::host(
                TerminalHostErrorCode::SessionNotFound,
                "terminal session not found",
            ));
        };
        if &binding.owner != owner {
            return Err(TerminalCommandError::host(
                TerminalHostErrorCode::OwnerMismatch,
                "terminal session belongs to another owner",
            ));
        }
        let is_closed = routes
            .closed_workspaces
            .contains(&(owner.clone(), binding.workspace_id.clone()));
        let is_closing = binding.closing;
        if is_closed || is_closing {
            return Err(TerminalCommandError::host(
                TerminalHostErrorCode::WorkspaceClosed,
                "terminal session is closing",
            ));
        }
        let binding = routes.sessions.get_mut(session_id).expect("session exists");
        binding.in_flight = binding.in_flight.saturating_add(1);
        let snapshot = binding.clone();
        drop(routes);
        Ok((
            snapshot,
            SessionOperation {
                bus: Arc::clone(self),
                session_id: session_id.clone(),
            },
        ))
    }

    pub fn mark_session_closing(&self, session_id: &TerminalSessionId) {
        if let Some(binding) = lock(&self.routes).sessions.get_mut(session_id) {
            binding.closing = true;
        }
        self.changed.notify_all();
    }

    pub(crate) fn finish_session(&self, event: &TerminalEvent) {
        if !matches!(event.payload, TerminalEventPayload::Exit { .. }) {
            return;
        }
        let mut routes = lock(&self.routes);
        if routes
            .sessions
            .get(&event.session_id)
            .is_some_and(|binding| {
                event_identity_matches(
                    event,
                    &binding.owner,
                    &binding.workspace_id,
                    &event.session_id,
                    binding.terminal_generation,
                )
            })
        {
            routes.sessions.remove(&event.session_id);
        }
        let idle_owner = !routes
            .sessions
            .values()
            .any(|item| item.owner == event.owner)
            && !routes.spawns.values().any(|item| item.owner == event.owner)
            && !routes.revoked_owners.contains(&event.owner);
        if idle_owner {
            routes.active_owners.remove(&event.owner);
            routes.owner_gates.remove(&event.owner);
        }
        drop(routes);
        if idle_owner {
            self.output.drop_for_owner(&event.owner);
        }
        self.changed.notify_all();
    }

    pub fn fence_workspace(&self, owner: &OwnerId, workspace_id: &WorkspaceId) {
        let gate = {
            let mut routes = lock(&self.routes);
            let has_work = routes
                .sessions
                .values()
                .any(|item| &item.owner == owner && &item.workspace_id == workspace_id)
                || routes
                    .spawns
                    .values()
                    .any(|item| &item.owner == owner && &item.workspace_id == workspace_id);
            if !has_work {
                routes
                    .closed_workspaces
                    .insert((owner.clone(), workspace_id.clone()));
                self.changed.notify_all();
                return;
            }
            routes
                .owner_gates
                .entry(owner.clone())
                .or_insert_with(|| Arc::new(Mutex::new(())))
                .clone()
        };
        let _delivery = lock(&gate);
        let mut routes = lock(&self.routes);
        routes
            .closed_workspaces
            .insert((owner.clone(), workspace_id.clone()));
        for binding in routes.sessions.values_mut() {
            if &binding.owner == owner && &binding.workspace_id == workspace_id {
                binding.closing = true;
            }
        }
        drop(routes);
        self.discard_staged(owner, Some(workspace_id));
        self.changed.notify_all();
    }

    pub fn fence_owner(&self, owner: &OwnerId) -> bool {
        let gate = {
            let mut routes = lock(&self.routes);
            let has_work = routes.active_owners.contains(owner)
                || routes.spawns.values().any(|item| &item.owner == owner)
                || routes.sessions.values().any(|item| &item.owner == owner);
            if !has_work {
                routes.revoked_owners.insert(owner.clone());
                self.changed.notify_all();
                return false;
            }
            routes
                .owner_gates
                .entry(owner.clone())
                .or_insert_with(|| Arc::new(Mutex::new(())))
                .clone()
        };
        let _delivery = lock(&gate);
        let mut routes = lock(&self.routes);
        routes.revoked_owners.insert(owner.clone());
        for binding in routes.sessions.values_mut() {
            if &binding.owner == owner {
                binding.closing = true;
            }
        }
        drop(routes);
        self.output.drop_for_owner(owner);
        self.discard_staged(owner, None);
        self.changed.notify_all();
        true
    }

    pub fn wait_workspace_idle(
        &self,
        owner: &OwnerId,
        workspace_id: &WorkspaceId,
        timeout: Duration,
    ) -> bool {
        let deadline = Instant::now() + timeout;
        let mut routes = lock(&self.routes);
        loop {
            let pending_spawn = routes
                .spawns
                .values()
                .any(|item| &item.owner == owner && &item.workspace_id == workspace_id);
            let pending_operation = routes.sessions.values().any(|item| {
                &item.owner == owner && &item.workspace_id == workspace_id && item.in_flight != 0
            });
            if !pending_spawn && !pending_operation {
                return true;
            }
            let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
                return false;
            };
            let (next, result) = self
                .changed
                .wait_timeout(routes, remaining)
                .unwrap_or_else(PoisonError::into_inner);
            routes = next;
            if result.timed_out() {
                return false;
            }
        }
    }

    pub fn finish_workspace(&self, owner: &OwnerId, workspace_id: &WorkspaceId) {
        let mut routes = lock(&self.routes);
        routes
            .sessions
            .retain(|_, item| &item.owner != owner || &item.workspace_id != workspace_id);
        let idle_owner = !routes.sessions.values().any(|item| &item.owner == owner)
            && !routes.spawns.values().any(|item| &item.owner == owner)
            && !routes.revoked_owners.contains(owner);
        if idle_owner {
            routes.active_owners.remove(owner);
            routes.owner_gates.remove(owner);
        }
        drop(routes);
        self.discard_staged(owner, Some(workspace_id));
        if idle_owner {
            self.output.drop_for_owner(owner);
        }
        self.changed.notify_all();
    }

    pub fn finish_owner(&self, owner: &OwnerId) {
        let gate = {
            let routes = lock(&self.routes);
            routes.owner_gates.get(owner).cloned()
        };
        if let Some(gate) = gate {
            let _delivery = lock(&gate);
            self.output.drop_for_owner(owner);
            let mut routes = lock(&self.routes);
            routes.sessions.retain(|_, item| &item.owner != owner);
            routes.spawns.retain(|_, item| &item.owner != owner);
            routes.active_owners.remove(owner);
            routes.owner_gates.remove(owner);
        }
        self.discard_staged(owner, None);
        self.changed.notify_all();
    }

    pub fn active_owners(&self) -> Vec<OwnerId> {
        lock(&self.routes).active_owners.iter().cloned().collect()
    }

    pub fn dispatchable_owners(&self) -> Vec<OwnerId> {
        let routes = lock(&self.routes);
        routes
            .active_owners
            .iter()
            .filter(|owner| !routes.revoked_owners.contains(*owner))
            .cloned()
            .collect()
    }

    pub fn delivery_gate(&self, owner: &OwnerId) -> Option<Arc<Mutex<()>>> {
        lock(&self.routes).owner_gates.get(owner).cloned()
    }

    pub(crate) fn binding_for(&self, event: &TerminalEvent) -> Option<SessionBinding> {
        let routes = lock(&self.routes);
        if routes.revoked_owners.contains(&event.owner)
            || routes
                .closed_workspaces
                .contains(&(event.owner.clone(), event.workspace_id.clone()))
        {
            return None;
        }
        let binding = routes.sessions.get(&event.session_id)?;
        event_identity_matches(
            event,
            &binding.owner,
            &binding.workspace_id,
            &event.session_id,
            binding.terminal_generation,
        )
        .then(|| binding.clone())
    }

    pub(crate) fn event_is_current(&self, event: &TerminalEvent, binding: &SessionBinding) -> bool {
        let routes = lock(&self.routes);
        if routes.revoked_owners.contains(&event.owner)
            || routes
                .closed_workspaces
                .contains(&(event.owner.clone(), event.workspace_id.clone()))
        {
            return false;
        }
        routes
            .sessions
            .get(&event.session_id)
            .is_some_and(|current| {
                current.terminal_generation == binding.terminal_generation
                    && current.filesystem_generation == binding.filesystem_generation
                    && event_identity_matches(
                        event,
                        &current.owner,
                        &current.workspace_id,
                        &event.session_id,
                        current.terminal_generation,
                    )
            })
    }

    pub fn is_stopping(&self) -> bool {
        lock(&self.routes).stopping
    }

    pub fn wait_for_change(&self) {
        let routes = lock(&self.routes);
        let _ = self
            .changed
            .wait_timeout(routes, Duration::from_millis(50))
            .unwrap_or_else(PoisonError::into_inner);
    }

    pub fn stop(&self) {
        lock(&self.routes).stopping = true;
        self.changed.notify_all();
    }

    pub(crate) fn stage_event(&self, event: TerminalEvent) -> Result<(), TerminalSinkError> {
        let added_bytes = match &event.payload {
            TerminalEventPayload::Data { bytes, .. } => bytes.len(),
            TerminalEventPayload::Exit { .. } => 0,
        };
        let mut staged = lock(&self.staged);
        if matches!(event.payload, TerminalEventPayload::Data { .. })
            && (staged.events.len() >= DEFAULT_MAX_OUTPUT_CHUNKS
                || staged.data_bytes.saturating_add(added_bytes) > DEFAULT_MAX_OUTPUT_QUEUE_BYTES)
        {
            return Err(TerminalSinkError::Backpressure);
        }
        staged.data_bytes = staged.data_bytes.saturating_add(added_bytes);
        staged.events.push_back(event);
        drop(staged);
        self.changed.notify_all();
        Ok(())
    }

    pub(crate) fn flush_staged_for_session(
        &self,
        session_id: &TerminalSessionId,
    ) -> Result<(), TerminalSinkError> {
        let mut staged = lock(&self.staged);
        let mut pending = std::mem::take(&mut staged.events);
        staged.data_bytes = 0;
        let mut retained = VecDeque::new();

        while let Some(event) = pending.pop_front() {
            if &event.session_id == session_id && self.binding_for(&event).is_some() {
                if let Err(error) = self.output.emit(event.clone()) {
                    retained.push_back(event);
                    retained.append(&mut pending);
                    staged.data_bytes = retained.iter().map(event_data_bytes).sum();
                    staged.events = retained;
                    return Err(error);
                }
            } else if &event.session_id != session_id {
                retained.push_back(event);
            }
        }
        staged.data_bytes = retained.iter().map(event_data_bytes).sum();
        staged.events = retained;
        Ok(())
    }

    pub(crate) fn discard_staged(&self, owner: &OwnerId, workspace_id: Option<&WorkspaceId>) {
        let mut staged = lock(&self.staged);
        staged.events.retain(|event| {
            &event.owner != owner
                || workspace_id.is_some_and(|workspace| &event.workspace_id != workspace)
        });
        staged.data_bytes = staged.events.iter().map(event_data_bytes).sum();
    }
}

impl Default for TerminalEventBus {
    fn default() -> Self {
        Self::new()
    }
}

pub fn event_data_bytes(event: &TerminalEvent) -> usize {
    match &event.payload {
        TerminalEventPayload::Data { bytes, .. } => bytes.len(),
        TerminalEventPayload::Exit { .. } => 0,
    }
}

impl TerminalEventSink for TerminalEventBus {
    fn emit(&self, event: TerminalEvent) -> Result<(), TerminalSinkError> {
        let gate = lock(&self.routes)
            .owner_gates
            .get(&event.owner)
            .cloned()
            .ok_or(TerminalSinkError::Disconnected)?;
        let _delivery = lock(&gate);
        let routes = lock(&self.routes);
        if routes.stopping
            || routes.revoked_owners.contains(&event.owner)
            || routes
                .closed_workspaces
                .contains(&(event.owner.clone(), event.workspace_id.clone()))
        {
            return Err(TerminalSinkError::Disconnected);
        }
        let route = match routes.sessions.get(&event.session_id) {
            Some(binding)
                if event_identity_matches(
                    &event,
                    &binding.owner,
                    &binding.workspace_id,
                    &event.session_id,
                    binding.terminal_generation,
                ) =>
            {
                1
            }
            Some(_) => 0,
            None if routes.spawns.values().any(|spawn| {
                spawn.owner == event.owner && spawn.workspace_id == event.workspace_id
            }) =>
            {
                2
            }
            None => 0,
        };
        drop(routes);
        let result = match route {
            1 => self.output.emit(event),
            2 => self.stage_event(event),
            _ => Err(TerminalSinkError::Disconnected),
        };
        if result.is_ok() {
            self.changed.notify_all();
        }
        result
    }
}

pub fn event_identity_matches(
    event: &TerminalEvent,
    owner: &OwnerId,
    workspace_id: &WorkspaceId,
    session_id: &TerminalSessionId,
    generation: u64,
) -> bool {
    &event.owner == owner
        && &event.workspace_id == workspace_id
        && &event.session_id == session_id
        && event.generation == generation
}

pub struct SpawnAdmission {
    pub(crate) bus: Arc<TerminalEventBus>,
    pub(crate) spawn_id: u64,
    pub(crate) owner: OwnerId,
    pub(crate) workspace_id: WorkspaceId,
    pub(crate) committed: bool,
}

impl SpawnAdmission {
    pub fn commit(
        &mut self,
        info: &TerminalSessionInfo,
        filesystem_generation: SessionGeneration,
    ) -> Result<TerminalSessionReceipt, TerminalCommandError> {
        let receipt = self.bus.commit_spawn(self, info, filesystem_generation)?;
        self.committed = true;
        self.bus.changed.notify_all();
        Ok(receipt)
    }
}

impl Drop for SpawnAdmission {
    fn drop(&mut self) {
        if !self.committed {
            self.bus.finish_spawn(self.spawn_id, &self.owner);
        }
    }
}

pub struct SessionOperation {
    pub(crate) bus: Arc<TerminalEventBus>,
    pub(crate) session_id: TerminalSessionId,
}

impl Drop for SessionOperation {
    fn drop(&mut self) {
        if let Some(binding) = lock(&self.bus.routes).sessions.get_mut(&self.session_id) {
            binding.in_flight = binding.in_flight.saturating_sub(1);
        }
        self.bus.changed.notify_all();
    }
}

pub struct OperationPermit {
    count: Arc<AtomicUsize>,
}

impl Drop for OperationPermit {
    fn drop(&mut self) {
        self.count.fetch_sub(1, Ordering::AcqRel);
    }
}

pub(crate) struct CleanupQueueState {
    pub(crate) jobs: VecDeque<OwnerId>,
    pub(crate) scheduled: HashSet<OwnerId>,
    pub(crate) stopping: bool,
}

pub(crate) struct CleanupQueue {
    pub(crate) state: Mutex<CleanupQueueState>,
    pub(crate) changed: Condvar,
}

impl CleanupQueue {
    pub fn new() -> Self {
        Self {
            state: Mutex::new(CleanupQueueState {
                jobs: VecDeque::new(),
                scheduled: HashSet::new(),
                stopping: false,
            }),
            changed: Condvar::new(),
        }
    }

    pub fn enqueue(&self, owner: OwnerId) -> bool {
        let mut state = lock(&self.state);
        if state.scheduled.contains(&owner) {
            return true;
        }
        if state.jobs.len() >= MAX_TERMINAL_OWNERS {
            return false;
        }
        state.scheduled.insert(owner.clone());
        state.jobs.push_back(owner);
        drop(state);
        self.changed.notify_one();
        true
    }

    pub fn next(&self) -> Option<OwnerId> {
        let mut state = lock(&self.state);
        loop {
            if let Some(owner) = state.jobs.pop_front() {
                return Some(owner);
            }
            if state.stopping {
                return None;
            }
            state = self
                .changed
                .wait(state)
                .unwrap_or_else(PoisonError::into_inner);
        }
    }

    pub fn complete(&self, owner: &OwnerId) {
        lock(&self.state).scheduled.remove(owner);
    }

    pub fn stop(&self) {
        lock(&self.state).stopping = true;
        self.changed.notify_all();
    }
}

pub struct TerminalCore {
    pub filesystem: Arc<FilesystemService>,
    pub service: Arc<TerminalService>,
    pub bus: Arc<TerminalEventBus>,
    pub operations: Arc<AtomicUsize>,
    pub(crate) cleanup: Arc<CleanupQueue>,
    pub shutdown_started: AtomicBool,
}

pub struct FrontendTerminalState {
    pub core: Arc<TerminalCore>,
    pub cleanup_worker: Mutex<Option<JoinHandle<()>>>,
    pub event_worker: Mutex<Option<JoinHandle<()>>>,
}

impl FrontendTerminalState {
    pub fn new(
        filesystem: Arc<FilesystemService>,
        app: AppHandle,
    ) -> Result<Self, TerminalCommandError> {
        let bus = Arc::new(TerminalEventBus::new());
        let sink: Arc<dyn TerminalEventSink> = bus.clone();
        let service = Arc::new(TerminalService::new(sink));
        let cleanup = Arc::new(CleanupQueue::new());
        let core = Arc::new(TerminalCore {
            filesystem,
            service,
            bus,
            operations: Arc::new(AtomicUsize::new(0)),
            cleanup,
            shutdown_started: AtomicBool::new(false),
        });

        let cleanup_core = Arc::clone(&core);
        let cleanup_worker = thread::Builder::new()
            .name("modutex-terminal-cleanup".to_owned())
            .spawn(move || cleanup_loop(cleanup_core))
            .map_err(|_| {
                TerminalCommandError::host(
                    TerminalHostErrorCode::Internal,
                    "could not start terminal cleanup worker",
                )
            })?;

        let event_core = Arc::clone(&core);
        let event_worker = match thread::Builder::new()
            .name("modutex-terminal-events".to_owned())
            .spawn(move || event_loop(event_core, app))
        {
            Ok(worker) => worker,
            Err(_) => {
                core.cleanup.stop();
                let _ = cleanup_worker.join();
                return Err(TerminalCommandError::host(
                    TerminalHostErrorCode::Internal,
                    "could not start terminal event worker",
                ));
            }
        };

        Ok(Self {
            core,
            cleanup_worker: Mutex::new(Some(cleanup_worker)),
            event_worker: Mutex::new(Some(event_worker)),
        })
    }

    pub(crate) fn operation_permit(&self) -> Result<OperationPermit, TerminalCommandError> {
        let count = Arc::clone(&self.core.operations);
        let mut current = count.load(Ordering::Acquire);
        loop {
            if current >= MAX_PENDING_OPERATIONS {
                return Err(TerminalCommandError::host(
                    TerminalHostErrorCode::ResourceExhausted,
                    "terminal operation queue is full",
                ));
            }
            match count.compare_exchange_weak(
                current,
                current + 1,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => return Ok(OperationPermit { count }),
                Err(actual) => current = actual,
            }
        }
    }

    pub(crate) async fn run_blocking<T, F>(&self, job: F) -> Result<T, TerminalCommandError>
    where
        T: Send + 'static,
        F: FnOnce() -> Result<T, TerminalCommandError> + Send + 'static,
    {
        let permit = self.operation_permit()?;
        tauri::async_runtime::spawn_blocking(move || {
            let _permit = permit;
            job()
        })
        .await
        .map_err(|_| {
            TerminalCommandError::deferred(
                "terminal worker ended unexpectedly; cleanup status is not proven",
            )
        })?
    }

    pub async fn availability(
        &self,
        owner: OwnerId,
        shell: TrustedShellConfig,
    ) -> Result<TerminalAvailability, TerminalCommandError> {
        let service = Arc::clone(&self.core.service);
        self.run_blocking(move || Ok(service.availability(&owner, &shell)))
            .await
    }

    pub async fn spawn(
        &self,
        owner: OwnerId,
        request: TerminalSpawnRequest,
    ) -> Result<TerminalSessionReceipt, TerminalCommandError> {
        let size =
            TerminalSize::new(request.cols, request.rows).map_err(TerminalCommandError::from)?;
        let mut admission = self
            .core
            .bus
            .reserve_spawn(owner.clone(), request.workspace_id.clone())?;
        let filesystem = Arc::clone(&self.core.filesystem);
        let service = Arc::clone(&self.core.service);
        self.run_blocking(move || {
            let workspace = filesystem
                .acquire_terminal_workspace(&owner, &request.workspace_id)
                .map_err(map_filesystem_error)?;
            let filesystem_generation = workspace.generation();
            let working_directory = workspace.root().to_path_buf();
            if filesystem
                .workspace_generation(&owner, &request.workspace_id)
                .map_err(map_filesystem_error)?
                != filesystem_generation
            {
                return Err(TerminalCommandError::host(
                    TerminalHostErrorCode::WorkspaceUnavailable,
                    "workspace changed during terminal spawn",
                ));
            }

            let shell = trusted_windows_shell()?;
            let spec = TerminalSpawnSpec::new(
                owner.clone(),
                request.workspace_id.clone(),
                working_directory,
                shell,
                size,
            )
            .with_limits(TerminalQueueLimits::default());
            let (cancel_handle, cancellation) = cancellation_pair();
            let info = service
                .spawn(&spec, cancel_handle, cancellation)
                .map_err(TerminalCommandError::from)?;
            match admission.commit(&info, filesystem_generation) {
                Ok(receipt) => Ok(receipt),
                Err(error) => {
                    match service.kill(&owner, &info.session_id) {
                        Ok(report)
                            if report.cleanup == TerminalCleanupProof::SessionDrained =>
                        {
                            Err(error)
                        }
                        _ => Err(TerminalCommandError::deferred(
                            "terminal spawn was fenced; native cleanup remains owned by the terminal reaper",
                        )),
                    }
                }
            }
        })
        .await
    }

    pub async fn input(
        &self,
        owner: OwnerId,
        request: TerminalInputRequest,
    ) -> Result<(), TerminalCommandError> {
        validate_input_chunk(&request.data).map_err(|detail| {
            TerminalCommandError::host(TerminalHostErrorCode::InvalidRequest, detail)
        })?;
        let (binding, operation) = self
            .core
            .bus
            .begin_session_operation(&owner, &request.session_id)?;
        let filesystem = Arc::clone(&self.core.filesystem);
        let service = Arc::clone(&self.core.service);
        let bus = Arc::clone(&self.core.bus);
        self.run_blocking(move || {
            let _operation = operation;
            ensure_workspace_generation(&filesystem, &binding)?;
            match service.write_input(&owner, &request.session_id, request.data.as_bytes()) {
                Ok(()) => Ok(()),
                Err(error) => {
                    if matches!(
                        error.kind,
                        TerminalErrorKind::Cancelled
                            | TerminalErrorKind::OutputBackpressure
                            | TerminalErrorKind::OwnerRevoked
                            | TerminalErrorKind::SessionClosed
                    ) {
                        bus.mark_session_closing(&request.session_id);
                    }
                    Err(TerminalCommandError::from(error))
                }
            }
        })
        .await
    }

    pub async fn resize(
        &self,
        owner: OwnerId,
        request: TerminalResizeRequest,
    ) -> Result<TerminalSize, TerminalCommandError> {
        let size =
            TerminalSize::new(request.cols, request.rows).map_err(TerminalCommandError::from)?;
        let (binding, operation) = self
            .core
            .bus
            .begin_session_operation(&owner, &request.session_id)?;
        let filesystem = Arc::clone(&self.core.filesystem);
        let service = Arc::clone(&self.core.service);
        self.run_blocking(move || {
            let _operation = operation;
            ensure_workspace_generation(&filesystem, &binding)?;
            service
                .resize(&owner, &request.session_id, size)
                .map_err(TerminalCommandError::from)
        })
        .await
    }

    pub async fn kill(
        &self,
        owner: OwnerId,
        request: TerminalKillRequest,
    ) -> Result<TerminalTeardownReport, TerminalCommandError> {
        let (_binding, operation) = self
            .core
            .bus
            .begin_session_operation(&owner, &request.session_id)?;
        self.core.bus.mark_session_closing(&request.session_id);
        let service = Arc::clone(&self.core.service);
        self.run_blocking(move || {
            let _operation = operation;
            service
                .kill(&owner, &request.session_id)
                .map_err(TerminalCommandError::from)
        })
        .await
    }

    pub async fn close_workspace(
        &self,
        owner: &OwnerId,
        workspace_id: &WorkspaceId,
    ) -> Result<(), TerminalCommandError> {
        let permit = self.operation_permit()?;
        self.core.bus.fence_workspace(owner, workspace_id);
        let owner = owner.clone();
        let workspace_id = workspace_id.clone();
        let service = Arc::clone(&self.core.service);
        let bus = Arc::clone(&self.core.bus);
        tauri::async_runtime::spawn_blocking(move || {
            let _permit = permit;
            let reports = service.close_workspace(&owner, &workspace_id);
            let spawns_drained =
                bus.wait_workspace_idle(&owner, &workspace_id, WORKSPACE_DRAIN_TIMEOUT);
            bus.finish_workspace(&owner, &workspace_id);
            if !reports_are_drained(&reports, spawns_drained) {
                let cleanup = reports
                    .iter()
                    .find(|report| report.cleanup != TerminalCleanupProof::SessionDrained)
                    .map(|report| report.cleanup)
                    .unwrap_or(TerminalCleanupProof::Deferred);
                return Err(TerminalCommandError {
                    code: TerminalCommandErrorCode::Host(TerminalHostErrorCode::CleanupUnproven),
                    detail: "terminal workspace cleanup is not proven complete".to_owned(),
                    cleanup,
                });
            }
            Ok(())
        })
        .await
        .map_err(|_| TerminalCommandError::deferred("terminal close worker ended unexpectedly"))?
    }

    pub fn revoke_owner(&self, owner: &OwnerId) -> Result<(), TerminalCommandError> {
        if self.core.bus.fence_owner(owner) && !self.core.cleanup.enqueue(owner.clone()) {
            return Err(TerminalCommandError::deferred(
                "terminal cleanup queue is full; owner remains fenced",
            ));
        }
        Ok(())
    }

    pub async fn shutdown(&self) {
        if self.core.shutdown_started.swap(true, Ordering::AcqRel) {
            return;
        }
        for owner in self.core.bus.active_owners() {
            if self.core.bus.fence_owner(&owner) {
                let _ = self.core.cleanup.enqueue(owner);
            }
        }
        self.core.cleanup.stop();
        let cleanup_worker = lock(&self.cleanup_worker).take();
        if let Some(worker) = cleanup_worker {
            let _ = tauri::async_runtime::spawn_blocking(move || worker.join()).await;
        }
        self.core.bus.stop();
        let event_worker = lock(&self.event_worker).take();
        if let Some(worker) = event_worker {
            let _ = tauri::async_runtime::spawn_blocking(move || worker.join()).await;
        }
    }
}

impl Drop for FrontendTerminalState {
    fn drop(&mut self) {
        self.core.cleanup.stop();
        self.core.bus.stop();
        let cleanup_worker = lock(&self.cleanup_worker).take();
        let event_worker = lock(&self.event_worker).take();
        if cleanup_worker.is_some() || event_worker.is_some() {
            // Dropping this join handle detaches the blocking task; its closure
            // owns and joins both workers, so cleanup continues to completion.
            drop(tauri::async_runtime::spawn_blocking(move || {
                if let Some(worker) = cleanup_worker {
                    let _ = worker.join();
                }
                if let Some(worker) = event_worker {
                    let _ = worker.join();
                }
            }));
        }
    }
}

pub(crate) fn ensure_workspace_generation(
    filesystem: &FilesystemService,
    binding: &SessionBinding,
) -> Result<(), TerminalCommandError> {
    let generation = filesystem
        .workspace_generation(&binding.owner, &binding.workspace_id)
        .map_err(map_filesystem_error)?;
    if generation != binding.filesystem_generation {
        return Err(TerminalCommandError::host(
            TerminalHostErrorCode::WorkspaceUnavailable,
            "workspace generation is stale",
        ));
    }
    Ok(())
}

pub fn reports_are_drained(reports: &[TerminalTeardownReport], spawns_drained: bool) -> bool {
    spawns_drained
        && reports
            .iter()
            .all(|report| report.cleanup == TerminalCleanupProof::SessionDrained)
}

pub fn cleanup_loop(core: Arc<TerminalCore>) {
    while let Some(owner) = core.cleanup.next() {
        let _reports = core.service.revoke_owner(&owner);
        core.bus.finish_owner(&owner);
        core.cleanup.complete(&owner);
    }

    for owner in core.bus.active_owners() {
        core.bus.fence_owner(&owner);
        let _reports = core.service.revoke_owner(&owner);
        core.bus.finish_owner(&owner);
    }
}

pub fn event_loop(core: Arc<TerminalCore>, app: AppHandle) {
    loop {
        let owners = core.bus.dispatchable_owners();
        let mut delivered_work = false;
        for owner in owners {
            for event in core.bus.output.drain_for_owner(&owner) {
                delivered_work = true;
                dispatch_event(&core, &app, event);
            }
        }
        if core.bus.is_stopping() {
            return;
        }
        if !delivered_work {
            core.bus.wait_for_change();
        }
    }
}

pub fn dispatch_event(core: &TerminalCore, app: &AppHandle, event: TerminalEvent) {
    let Some(binding) = core.bus.binding_for(&event) else {
        return;
    };
    if ensure_workspace_generation(&core.filesystem, &binding).is_err() {
        let owner = binding.owner.clone();
        let workspace_id = binding.workspace_id.clone();
        core.bus.fence_workspace(&owner, &workspace_id);
        let reports = core.service.close_workspace(&owner, &workspace_id);
        let drained = core
            .bus
            .wait_workspace_idle(&owner, &workspace_id, WORKSPACE_DRAIN_TIMEOUT);
        core.bus.finish_workspace(&owner, &workspace_id);
        let _ = reports_are_drained(&reports, drained);
        return;
    }
    let Some(gate) = core.bus.delivery_gate(&event.owner) else {
        return;
    };
    let Some(window) = app.get_webview_window(event.owner.as_str()) else {
        let owner = event.owner.clone();
        drop(gate);
        request_owner_revoke(core, &owner);
        return;
    };

    let is_exit = matches!(event.payload, TerminalEventPayload::Exit { .. });
    let owner = event.owner.clone();
    let session_id = event.session_id.clone();
    let delivery = lock(&gate);
    let delivered = if core.bus.event_is_current(&event, &binding) {
        window
            .emit(TERMINAL_EVENT, TerminalWireEvent::from_event(event.clone()))
            .is_ok()
    } else {
        true
    };
    drop(delivery);
    if !delivered {
        request_owner_revoke(core, &owner);
    }
    if is_exit {
        let _ = core.service.kill(&owner, &session_id);
        core.bus.finish_session(&event);
    }
}

pub fn request_owner_revoke(core: &TerminalCore, owner: &OwnerId) {
    if core.bus.fence_owner(owner) {
        let _ = core.cleanup.enqueue(owner.clone());
    }
}

pub fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}
