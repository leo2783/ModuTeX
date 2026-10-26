// SPDX-License-Identifier: Apache-2.0
//! Workspace lifecycle, admission generation and root-exclusion lease coordinator.
//!
//! Wraps [`SessionRegistry`] admission without performing filesystem I/O or
//! duplicating registry ownership. Callers supply opaque [`OwnerId`] and
//! [`WorkspaceId`] tokens together with a [`TrustedWorkspaceRoot`] (`RootIdentity`
//! + canonical normalized path) obtained from a validated native directory handle.
//!
//! Registry-coupled operations ([`WorkspaceLeaseCoordinator::admit_from_registry`],
//! [`WorkspaceLeaseCoordinator::close_with_registry`], and
//! [`WorkspaceLeaseCoordinator::revoke_owner_with_registry`]) serialize
//! [`SessionRegistry`] lookups and removals under the coordinator lock so admission
//! cannot race session close or owner revocation. Callers that instead use
//! [`WorkspaceLeaseCoordinator::admit_trusted`] or
//! [`WorkspaceLeaseCoordinator::admit_session`] while mutating [`SessionRegistry`]
//! directly must externally serialize open/admit/close for the target [`WorkspaceId`].

use std::{
    collections::{HashMap, HashSet},
    error::Error,
    fmt,
    num::NonZeroU64,
    panic::{catch_unwind, AssertUnwindSafe},
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Condvar, Mutex, MutexGuard, PoisonError, Weak,
    },
    time::{Duration, Instant},
};

use crate::{
    schemas::protocol::{OwnerId, WorkspaceId},
    state::sessions::{SessionError, SessionRegistry, WorkspaceSession},
};

pub type CancelCallback = Box<dyn FnOnce() + Send + 'static>;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LeaseError {
    InvalidRootPath,
    InvalidTimeout,
    UnknownSession,
    SessionClosed,
    StaleGeneration,
    WorkspaceAlreadyUsed,
    WouldBlock,
    TimedOut,
    Cancelled,
    CounterOverflow,
}

impl fmt::Display for LeaseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::InvalidRootPath => "trusted workspace root path must be canonical and absolute",
            Self::InvalidTimeout => "workspace lease timeout duration overflows clock",
            Self::UnknownSession => "unknown or unauthorized workspace session",
            Self::SessionClosed => "workspace session is closing or closed",
            Self::StaleGeneration => "workspace session generation is stale",
            Self::WorkspaceAlreadyUsed => "workspace identifier cannot be admitted more than once",
            Self::WouldBlock => "conflicting workspace lease is currently active or queued",
            Self::TimedOut => "timed out waiting for workspace lease",
            Self::Cancelled => "workspace lease request was cancelled",
            Self::CounterOverflow => "monotonic lease coordinator counter exhausted",
        })
    }
}

impl Error for LeaseError {}

impl From<SessionError> for LeaseError {
    fn from(_: SessionError) -> Self {
        Self::UnknownSession
    }
}

/// Windows handle-derived volume serial number and 128-bit file identifier.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash, Ord, PartialOrd)]
pub struct RootIdentity {
    volume_serial: u64,
    file_id: u128,
}

impl RootIdentity {
    pub const fn new(volume_serial: u64, file_id: u128) -> Self {
        Self {
            volume_serial,
            file_id,
        }
    }

    pub const fn from_windows_index(volume_serial: u32, high: u32, low: u32) -> Self {
        let file_id = ((high as u128) << 32) | (low as u128);
        Self {
            volume_serial: volume_serial as u64,
            file_id,
        }
    }

    pub const fn volume_serial(self) -> u64 {
        self.volume_serial
    }

    pub const fn file_id(self) -> u128 {
        self.file_id
    }
}

/// Canonical, case-folded absolute Windows path supplied by the handle owner.
#[derive(Clone, Debug, Eq, PartialEq, Hash)]
pub struct CanonicalRootPath {
    segments: Vec<String>,
}

impl CanonicalRootPath {
    pub fn parse(raw: &str) -> Result<Self, LeaseError> {
        if raw.is_empty() || raw.chars().any(|c| c < ' ' || c == '\x7f') {
            return Err(LeaseError::InvalidRootPath);
        }
        let mut s = raw.replace('/', "\\");
        if let Some(unc) = s
            .get(..8)
            .filter(|p| p.eq_ignore_ascii_case("\\\\?\\UNC\\"))
            .and_then(|_| s.get(8..))
        {
            s = format!("\\\\{unc}");
        } else if let Some(rest) = s.strip_prefix("\\\\?\\") {
            s = rest.to_owned();
        }
        let (prefix, remainder) = if let Some(unc) = s.strip_prefix("\\\\") {
            if unc.starts_with('\\') {
                return Err(LeaseError::InvalidRootPath);
            }
            let mut parts = unc.splitn(3, '\\');
            let server = parts
                .next()
                .filter(|p| !p.is_empty())
                .ok_or(LeaseError::InvalidRootPath)?;
            let share = parts
                .next()
                .filter(|p| !p.is_empty())
                .ok_or(LeaseError::InvalidRootPath)?;
            if !valid_segment(server) || !valid_segment(share) {
                return Err(LeaseError::InvalidRootPath);
            }
            (
                format!("\\\\{}\\{}", server.to_uppercase(), share.to_uppercase()),
                parts.next().unwrap_or(""),
            )
        } else {
            let bytes = s.as_bytes();
            if bytes.len() < 3
                || !bytes[0].is_ascii_alphabetic()
                || bytes[1] != b':'
                || bytes[2] != b'\\'
            {
                return Err(LeaseError::InvalidRootPath);
            }
            (
                format!("{}:", (bytes[0] as char).to_ascii_uppercase()),
                &s[3..],
            )
        };
        let mut segments = vec![prefix];
        let trimmed = remainder.strip_suffix('\\').unwrap_or(remainder);
        if !trimmed.is_empty() {
            for part in trimmed.split('\\') {
                if !valid_segment(part) {
                    return Err(LeaseError::InvalidRootPath);
                }
                segments.push(part.to_uppercase());
            }
        }
        Ok(Self { segments })
    }

    pub fn from_trusted_path(path: &Path) -> Result<Self, LeaseError> {
        path.to_str()
            .ok_or(LeaseError::InvalidRootPath)
            .and_then(Self::parse)
    }

    pub fn overlaps(&self, other: &Self) -> bool {
        let common = self.segments.len().min(other.segments.len());
        self.segments[..common] == other.segments[..common]
    }
}

fn valid_segment(part: &str) -> bool {
    !part.is_empty()
        && part != "."
        && part != ".."
        && !part.contains(':')
        && !part.ends_with('.')
        && !part.ends_with(' ')
}

#[derive(Clone, Debug, Eq, PartialEq, Hash)]
pub struct TrustedWorkspaceRoot {
    identity: RootIdentity,
    canonical_path: CanonicalRootPath,
}

impl TrustedWorkspaceRoot {
    pub fn new(identity: RootIdentity, canonical_path: CanonicalRootPath) -> Self {
        Self {
            identity,
            canonical_path,
        }
    }

    pub fn identity(&self) -> RootIdentity {
        self.identity
    }

    pub fn canonical_path(&self) -> &CanonicalRootPath {
        &self.canonical_path
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash, Ord, PartialOrd)]
pub struct SessionGeneration(NonZeroU64);

impl SessionGeneration {
    pub const fn get(self) -> u64 {
        self.0.get()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash, Ord, PartialOrd)]
pub struct LeaseId(NonZeroU64);

impl LeaseId {
    pub const fn get(self) -> u64 {
        self.0.get()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LeaseKind {
    Read,
    List,
    Save,
    Compile,
    Run,
    Watch,
}

impl LeaseKind {
    pub const fn is_root_exclusive(self) -> bool {
        matches!(self, Self::Save | Self::Compile)
    }
}

#[derive(Clone, Default)]
pub struct CancelToken {
    inner: Arc<CancelInner>,
}

#[derive(Default)]
struct CancelInner {
    cancelled: AtomicBool,
    coordinators: Mutex<Vec<Weak<Shared>>>,
}

impl CancelToken {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn is_cancelled(&self) -> bool {
        self.inner.cancelled.load(Ordering::Acquire)
    }

    pub fn cancel(&self) {
        let coordinators = {
            let mut guard = self
                .inner
                .coordinators
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            self.inner.cancelled.store(true, Ordering::Release);
            guard.retain(|weak| weak.strong_count() > 0);
            guard.clone()
        };
        for weak in coordinators {
            if let Some(shared) = weak.upgrade() {
                let _guard = shared.lock();
                shared.condvar.notify_all();
            }
        }
    }

    fn bind(&self, shared: &Arc<Shared>) -> bool {
        let mut guard = self
            .inner
            .coordinators
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if self.is_cancelled() {
            return true;
        }
        let candidate = Arc::downgrade(shared);
        guard.retain(|existing| existing.strong_count() > 0);
        if !guard
            .iter()
            .any(|existing| Weak::ptr_eq(existing, &candidate))
        {
            guard.push(candidate);
        }
        false
    }
}

/// Timeout and cancellation controls for a bounded lease acquisition.
#[derive(Default)]
pub struct LeaseWaitOptions<'a> {
    pub timeout: Option<Duration>,
    pub cancel: Option<&'a CancelToken>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Lifecycle {
    Active,
    Closing,
}

struct SessionRecord {
    owner: OwnerId,
    generation: SessionGeneration,
    root: TrustedWorkspaceRoot,
    lifecycle: Lifecycle,
    active_leases: usize,
}

struct ActiveLease {
    workspace_id: WorkspaceId,
    generation: SessionGeneration,
    kind: LeaseKind,
    root: TrustedWorkspaceRoot,
    on_cancel: Option<CancelCallback>,
}

struct Waiter {
    ticket: u64,
    workspace_id: WorkspaceId,
    generation: SessionGeneration,
    root: TrustedWorkspaceRoot,
}

struct State {
    sessions: HashMap<WorkspaceId, SessionRecord>,
    retired_workspaces: HashSet<WorkspaceId>,
    identity_aliases: HashMap<RootIdentity, Vec<CanonicalRootPath>>,
    active_leases: HashMap<LeaseId, ActiveLease>,
    wait_queue: Vec<Waiter>,
    next_generation: Option<u64>,
    next_lease_id: Option<u64>,
    next_wait_ticket: Option<u64>,
}

impl State {
    fn admit_locked(
        &mut self,
        owner: &OwnerId,
        workspace_id: &WorkspaceId,
        root: TrustedWorkspaceRoot,
    ) -> Result<SessionGeneration, LeaseError> {
        if self.sessions.contains_key(workspace_id)
            || self.retired_workspaces.contains(workspace_id)
        {
            return Err(LeaseError::WorkspaceAlreadyUsed);
        }
        let raw = self.next_generation.ok_or(LeaseError::CounterOverflow)?;
        let generation =
            SessionGeneration(NonZeroU64::new(raw).ok_or(LeaseError::CounterOverflow)?);
        self.next_generation = raw.checked_add(1);
        let aliases = self.identity_aliases.entry(root.identity).or_default();
        if !aliases.contains(&root.canonical_path) {
            aliases.push(root.canonical_path.clone());
        }
        self.sessions.insert(
            workspace_id.clone(),
            SessionRecord {
                owner: owner.clone(),
                generation,
                root,
                lifecycle: Lifecycle::Active,
                active_leases: 0,
            },
        );
        Ok(generation)
    }

    fn roots_conflict(&self, a: &TrustedWorkspaceRoot, b: &TrustedWorkspaceRoot) -> bool {
        if a.identity == b.identity || a.canonical_path.overlaps(&b.canonical_path) {
            return true;
        }
        let a_aliases = self.identity_aliases.get(&a.identity);
        let b_aliases = self.identity_aliases.get(&b.identity);
        if let Some(ap) = a_aliases {
            if ap.iter().any(|p| p.overlaps(&b.canonical_path)) {
                return true;
            }
            if let Some(bp) = b_aliases {
                if ap.iter().any(|pa| bp.iter().any(|pb| pa.overlaps(pb))) {
                    return true;
                }
            }
        }
        b_aliases.is_some_and(|bp| bp.iter().any(|p| p.overlaps(&a.canonical_path)))
    }

    fn waiter_is_live(&self, waiter: &Waiter) -> bool {
        self.sessions
            .get(&waiter.workspace_id)
            .is_some_and(|session| {
                session.generation == waiter.generation && session.lifecycle == Lifecycle::Active
            })
    }

    fn exclusive_blocked(&self, root: &TrustedWorkspaceRoot, my_ticket: Option<u64>) -> bool {
        let active_conflict = self
            .active_leases
            .values()
            .any(|l| l.kind.is_root_exclusive() && self.roots_conflict(&l.root, root));
        if active_conflict {
            return true;
        }
        self.wait_queue.iter().any(|w| {
            my_ticket.is_none_or(|t| w.ticket < t)
                && self.waiter_is_live(w)
                && self.roots_conflict(&w.root, root)
        })
    }

    fn verify_active(
        &self,
        owner: &OwnerId,
        workspace_id: &WorkspaceId,
        expected_gen: Option<SessionGeneration>,
    ) -> Result<(SessionGeneration, TrustedWorkspaceRoot), LeaseError> {
        match self.sessions.get(workspace_id) {
            Some(rec) if &rec.owner == owner => {
                if let Some(gen) = expected_gen {
                    if rec.generation != gen {
                        return Err(LeaseError::StaleGeneration);
                    }
                }
                if rec.lifecycle != Lifecycle::Active {
                    return Err(LeaseError::SessionClosed);
                }
                Ok((rec.generation, rec.root.clone()))
            }
            _ if self.retired_workspaces.contains(workspace_id) => Err(LeaseError::SessionClosed),
            _ => Err(LeaseError::UnknownSession),
        }
    }

    fn grant_lease(
        &mut self,
        workspace_id: &WorkspaceId,
        generation: SessionGeneration,
        root: TrustedWorkspaceRoot,
        kind: LeaseKind,
        on_cancel: Option<CancelCallback>,
    ) -> Result<LeaseId, LeaseError> {
        let raw_id = self.next_lease_id.ok_or(LeaseError::CounterOverflow)?;
        let lease_id = LeaseId(NonZeroU64::new(raw_id).ok_or(LeaseError::CounterOverflow)?);
        let session = self
            .sessions
            .get_mut(workspace_id)
            .ok_or(LeaseError::SessionClosed)?;
        let next_active = session
            .active_leases
            .checked_add(1)
            .ok_or(LeaseError::CounterOverflow)?;
        self.next_lease_id = raw_id.checked_add(1);
        session.active_leases = next_active;
        self.active_leases.insert(
            lease_id,
            ActiveLease {
                workspace_id: workspace_id.clone(),
                generation,
                kind,
                root,
                on_cancel,
            },
        );
        Ok(lease_id)
    }
}

struct Shared {
    state: Mutex<State>,
    condvar: Condvar,
}

impl Shared {
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

#[derive(Clone, Default)]
pub struct WorkspaceLeaseCoordinator {
    shared: Arc<Shared>,
}

impl Default for Shared {
    fn default() -> Self {
        Self {
            state: Mutex::new(State {
                sessions: HashMap::new(),
                retired_workspaces: HashSet::new(),
                identity_aliases: HashMap::new(),
                active_leases: HashMap::new(),
                wait_queue: Vec::new(),
                next_generation: Some(1),
                next_lease_id: Some(1),
                next_wait_ticket: Some(1),
            }),
            condvar: Condvar::new(),
        }
    }
}

impl WorkspaceLeaseCoordinator {
    pub fn new() -> Self {
        Self::default()
    }

    /// Admits a caller-verified `(owner, workspace_id, root)` tuple directly.
    ///
    /// Callers bypassing [`Self::admit_from_registry`] must externally serialize
    /// session open/admit/close for `workspace_id`.
    pub fn admit_trusted(
        &self,
        owner: &OwnerId,
        workspace_id: &WorkspaceId,
        root: TrustedWorkspaceRoot,
    ) -> Result<SessionGeneration, LeaseError> {
        let mut guard = self.shared.lock();
        guard.admit_locked(owner, workspace_id, root)
    }

    /// Admits a pre-fetched [`WorkspaceSession`] snapshot.
    ///
    /// Prefer [`Self::admit_from_registry`] when a [`SessionRegistry`] is present so
    /// lookup and coordinator admission execute atomically under the coordinator lock.
    pub fn admit_session(
        &self,
        session: &WorkspaceSession,
        root: TrustedWorkspaceRoot,
    ) -> Result<SessionGeneration, LeaseError> {
        self.admit_trusted(session.owner(), session.id(), root)
    }

    /// Atomically verifies `(owner, workspace_id)` in `registry` and admits it under
    /// the coordinator lock so concurrent [`Self::close_with_registry`] or
    /// [`Self::revoke_owner_with_registry`] calls cannot race admission.
    pub fn admit_from_registry(
        &self,
        registry: &SessionRegistry,
        owner: &OwnerId,
        workspace_id: &WorkspaceId,
        root: TrustedWorkspaceRoot,
    ) -> Result<SessionGeneration, LeaseError> {
        let mut guard = self.shared.lock();
        let session = registry.get(owner, workspace_id)?;
        guard.admit_locked(session.owner(), session.id(), root)
    }

    pub fn try_acquire(
        &self,
        owner: &OwnerId,
        workspace_id: &WorkspaceId,
        expected_gen: Option<SessionGeneration>,
        kind: LeaseKind,
        on_cancel: Option<CancelCallback>,
    ) -> Result<LeaseGuard, LeaseError> {
        let mut guard = self.shared.lock();
        let (generation, root) = guard.verify_active(owner, workspace_id, expected_gen)?;
        if kind.is_root_exclusive() && guard.exclusive_blocked(&root, None) {
            return Err(LeaseError::WouldBlock);
        }
        let lease_id = guard.grant_lease(workspace_id, generation, root, kind, on_cancel)?;
        Ok(LeaseGuard {
            shared: Arc::clone(&self.shared),
            lease_id: Some(lease_id),
            generation,
            kind,
        })
    }

    pub fn acquire_bounded(
        &self,
        owner: &OwnerId,
        workspace_id: &WorkspaceId,
        expected_gen: Option<SessionGeneration>,
        kind: LeaseKind,
        wait_options: LeaseWaitOptions<'_>,
        on_cancel: Option<CancelCallback>,
    ) -> Result<LeaseGuard, LeaseError> {
        let LeaseWaitOptions { timeout, cancel } = wait_options;
        let deadline = match timeout {
            Some(d) => Some(
                Instant::now()
                    .checked_add(d)
                    .ok_or(LeaseError::InvalidTimeout)?,
            ),
            None => None,
        };
        if cancel.is_some_and(|c| c.bind(&self.shared)) {
            return Err(LeaseError::Cancelled);
        }
        let mut guard = self.shared.lock();
        let (generation, root) = guard.verify_active(owner, workspace_id, expected_gen)?;
        if !kind.is_root_exclusive() || !guard.exclusive_blocked(&root, None) {
            let lease_id = guard.grant_lease(workspace_id, generation, root, kind, on_cancel)?;
            return Ok(LeaseGuard {
                shared: Arc::clone(&self.shared),
                lease_id: Some(lease_id),
                generation,
                kind,
            });
        }
        let ticket = guard.next_wait_ticket.ok_or(LeaseError::CounterOverflow)?;
        guard.next_wait_ticket = ticket.checked_add(1);
        guard.wait_queue.push(Waiter {
            ticket,
            workspace_id: workspace_id.clone(),
            generation,
            root: root.clone(),
        });
        self.shared.condvar.notify_all();
        let result = loop {
            if cancel.is_some_and(CancelToken::is_cancelled) {
                break Err(LeaseError::Cancelled);
            }
            if let Err(err) = guard.verify_active(owner, workspace_id, Some(generation)) {
                break Err(err);
            }
            if !guard.exclusive_blocked(&root, Some(ticket)) {
                guard.wait_queue.retain(|w| w.ticket != ticket);
                match guard.grant_lease(workspace_id, generation, root, kind, on_cancel) {
                    Ok(lease_id) => {
                        self.shared.condvar.notify_all();
                        return Ok(LeaseGuard {
                            shared: Arc::clone(&self.shared),
                            lease_id: Some(lease_id),
                            generation,
                            kind,
                        });
                    }
                    Err(err) => break Err(err),
                }
            }
            if let Some(end) = deadline {
                let Some(rem) = end.checked_duration_since(Instant::now()) else {
                    break Err(LeaseError::TimedOut);
                };
                let (next_guard, wait_res) = self
                    .shared
                    .condvar
                    .wait_timeout(guard, rem)
                    .unwrap_or_else(PoisonError::into_inner);
                guard = next_guard;
                if wait_res.timed_out() && guard.exclusive_blocked(&root, Some(ticket)) {
                    break Err(LeaseError::TimedOut);
                }
            } else {
                guard = self
                    .shared
                    .condvar
                    .wait(guard)
                    .unwrap_or_else(PoisonError::into_inner);
            }
        };
        guard.wait_queue.retain(|w| w.ticket != ticket);
        self.shared.condvar.notify_all();
        result
    }

    fn finish_close_session(&self, workspace_id: &WorkspaceId, callbacks: Vec<CancelCallback>) {
        for cb in callbacks {
            let _ = catch_unwind(AssertUnwindSafe(cb));
        }
        let mut guard = self.shared.lock();
        while guard
            .sessions
            .get(workspace_id)
            .is_some_and(|r| r.active_leases > 0)
            || guard
                .wait_queue
                .iter()
                .any(|w| &w.workspace_id == workspace_id)
        {
            guard = self
                .shared
                .condvar
                .wait(guard)
                .unwrap_or_else(PoisonError::into_inner);
        }
        guard.sessions.remove(workspace_id);
        self.shared.condvar.notify_all();
    }

    pub fn close_session(
        &self,
        owner: &OwnerId,
        workspace_id: &WorkspaceId,
    ) -> Result<(), LeaseError> {
        let callbacks = {
            let mut guard = self.shared.lock();
            match guard.sessions.get_mut(workspace_id) {
                Some(rec) if &rec.owner == owner => rec.lifecycle = Lifecycle::Closing,
                _ => return Err(LeaseError::UnknownSession),
            }
            guard.retired_workspaces.insert(workspace_id.clone());
            let cbs = guard
                .active_leases
                .values_mut()
                .filter(|l| &l.workspace_id == workspace_id)
                .filter_map(|l| l.on_cancel.take())
                .collect::<Vec<_>>();
            self.shared.condvar.notify_all();
            cbs
        };
        self.finish_close_session(workspace_id, callbacks);
        Ok(())
    }

    /// Atomically closes `workspace_id` in `registry` and retires/drains it in the
    /// coordinator so concurrent [`Self::admit_from_registry`] or [`Self::admit_session`]
    /// calls cannot resurrect the closed session.
    pub fn close_with_registry(
        &self,
        registry: &SessionRegistry,
        owner: &OwnerId,
        workspace_id: &WorkspaceId,
    ) -> Result<(), LeaseError> {
        let callbacks = {
            let mut guard = self.shared.lock();
            if guard
                .sessions
                .get(workspace_id)
                .is_some_and(|rec| &rec.owner != owner)
            {
                return Err(LeaseError::UnknownSession);
            }
            registry.close(owner, workspace_id)?;
            guard.retired_workspaces.insert(workspace_id.clone());
            let Some(rec) = guard.sessions.get_mut(workspace_id) else {
                self.shared.condvar.notify_all();
                return Ok(());
            };
            rec.lifecycle = Lifecycle::Closing;
            let cbs = guard
                .active_leases
                .values_mut()
                .filter(|l| &l.workspace_id == workspace_id)
                .filter_map(|l| l.on_cancel.take())
                .collect::<Vec<_>>();
            self.shared.condvar.notify_all();
            cbs
        };
        self.finish_close_session(workspace_id, callbacks);
        Ok(())
    }

    fn begin_revoke_owner_locked(
        &self,
        guard: &mut MutexGuard<'_, State>,
        owner: &OwnerId,
    ) -> (Vec<WorkspaceId>, Vec<CancelCallback>) {
        let ids: Vec<WorkspaceId> = guard
            .sessions
            .iter_mut()
            .filter(|(_, r)| &r.owner == owner)
            .map(|(id, r)| {
                r.lifecycle = Lifecycle::Closing;
                id.clone()
            })
            .collect();
        for id in &ids {
            guard.retired_workspaces.insert(id.clone());
        }
        let cbs = guard
            .active_leases
            .values_mut()
            .filter(|l| ids.contains(&l.workspace_id))
            .filter_map(|l| l.on_cancel.take())
            .collect::<Vec<_>>();
        self.shared.condvar.notify_all();
        (ids, cbs)
    }

    fn finish_revoke_owner(&self, ids: Vec<WorkspaceId>, callbacks: Vec<CancelCallback>) -> usize {
        for cb in callbacks {
            let _ = catch_unwind(AssertUnwindSafe(cb));
        }
        let mut guard = self.shared.lock();
        while ids.iter().any(|id| {
            guard.sessions.get(id).is_some_and(|r| r.active_leases > 0)
                || guard.wait_queue.iter().any(|w| &w.workspace_id == id)
        }) {
            guard = self
                .shared
                .condvar
                .wait(guard)
                .unwrap_or_else(PoisonError::into_inner);
        }
        for id in &ids {
            guard.sessions.remove(id);
        }
        self.shared.condvar.notify_all();
        ids.len()
    }

    pub fn revoke_owner(&self, owner: &OwnerId) -> usize {
        let (ids, callbacks) = {
            let mut guard = self.shared.lock();
            self.begin_revoke_owner_locked(&mut guard, owner)
        };
        self.finish_revoke_owner(ids, callbacks)
    }

    /// Atomically revokes `owner` in `registry` under the coordinator lock before
    /// draining admitted sessions for `owner`.
    pub fn revoke_owner_with_registry(&self, registry: &SessionRegistry, owner: &OwnerId) -> usize {
        let (ids, callbacks) = {
            let mut guard = self.shared.lock();
            let _ = registry.revoke_owner(owner);
            self.begin_revoke_owner_locked(&mut guard, owner)
        };
        self.finish_revoke_owner(ids, callbacks)
    }

    pub fn wait_until_queued(&self, min_queued: usize, timeout: Duration) -> bool {
        let Some(deadline) = Instant::now().checked_add(timeout) else {
            return false;
        };
        let mut guard = self.shared.lock();
        while guard.wait_queue.len() < min_queued {
            let Some(rem) = deadline.checked_duration_since(Instant::now()) else {
                return false;
            };
            let (next, res) = self
                .shared
                .condvar
                .wait_timeout(guard, rem)
                .unwrap_or_else(PoisonError::into_inner);
            guard = next;
            if res.timed_out() {
                return guard.wait_queue.len() >= min_queued;
            }
        }
        true
    }
}

pub struct LeaseGuard {
    shared: Arc<Shared>,
    lease_id: Option<LeaseId>,
    generation: SessionGeneration,
    kind: LeaseKind,
}

impl LeaseGuard {
    pub fn id(&self) -> LeaseId {
        self.lease_id.expect("active lease")
    }

    pub fn generation(&self) -> SessionGeneration {
        self.generation
    }

    pub fn kind(&self) -> LeaseKind {
        self.kind
    }
}

impl Drop for LeaseGuard {
    fn drop(&mut self) {
        if let Some(id) = self.lease_id.take() {
            let mut guard = self.shared.lock();
            if let Some(active) = guard.active_leases.remove(&id) {
                if active.generation == self.generation {
                    if let Some(session) = guard.sessions.get_mut(&active.workspace_id) {
                        if session.generation == active.generation {
                            session.active_leases = session.active_leases.saturating_sub(1);
                        }
                    }
                }
            }
            self.shared.condvar.notify_all();
        }
    }
}

#[cfg(test)]
#[path = "../../tests/unit/workspace_leases.rs"]
mod tests;
