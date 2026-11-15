// SPDX-License-Identifier: Apache-2.0
//! G3 managed/system compile coordinator candidate.
//!
//! This is a separate, unapplied review candidate. It uses the host-created
//! trusted profiles and the same shared FilesystemService as workspace IO. It
//! accepts no renderer executable, argv, environment, or root path.
//!
//! Compile source overlays are host-owned inputs, not changes to CompileRequest
//! or its wire contract. Results are settled only after process cleanup and
//! private staging cleanup are proven. An unproven filesystem preparation or
//! process cleanup retains the run and its compile lease.

#![cfg(all(windows, target_arch = "x86_64"))]

mod diagnostics;
mod profiles;
mod staging;

use std::{
    collections::{HashMap, HashSet},
    error::Error,
    ffi::OsString,
    fmt,
    panic::{catch_unwind, AssertUnwindSafe},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU8, AtomicUsize, Ordering},
        mpsc::{self, SyncSender, TrySendError},
        Arc, Condvar, Mutex, MutexGuard, OnceLock, PoisonError,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

use uuid::Uuid;

use self::{
    diagnostics::{
        append_log_line, cancelled_result, failure_result, filesystem_failure_text,
        parse_diagnostics, process_error_text, replace_case_insensitive, strip_terminal_controls,
        truncate_log_tail,
    },
    profiles::{
        build_process_environment, custom_system_profile, entry_stem, has_cached_latex_format,
        prepare_trusted_directory, resolve_search_paths, ResolvedProfile,
    },
    staging::{
        apply_overlay, compile_synctex_path, configured_compile_outputs, read_compile_pdf,
        read_compile_synctex, read_engine_log, snapshot_matches_ticket, stage_snapshot,
        validate_overlay, CompileLayout, CompileSourceSnapshot, EngineLog, OwnedCompileDirectory,
        PdfReadFailure,
    },
};
#[cfg(test)]
#[allow(unused_imports)]
use self::{
    profiles::{resolve_custom_executable, validate_profile_environment},
    staging::{CompileOverlayEntry, CompileOverlayFile},
};
pub(crate) use self::{
    profiles::{
        resolve_trusted_executable, validate_custom_command_template, ManagedProfile,
        SystemArgument, SystemProfile, SystemTool, TrustedCompileConfig,
    },
    staging::CompileOverlay,
};
#[cfg(test)]
#[allow(unused_imports)]
use crate::schemas::protocol::{DocumentVersion, Severity};
#[cfg(test)]
#[allow(unused_imports)]
use std::env;

use crate::{
    compile_config::{CompileProfile, CompileWorkspaceConfig},
    platform::process_tree::{
        cancellation_pair, CancellationHandle, CancellationToken, CleanupProof, ProcessError,
        ProcessErrorKind, ProcessLogs, ProcessOutput, ProcessSpec,
    },
    schemas::protocol::{
        CompileIdentity, CompileRequest, CompileResult, Diagnostic, DocumentId, Engine, OwnerId,
        RunId, WorkspaceId, MAX_LOG_CHARACTERS,
    },
    services::filesystem::{
        CompileInputLimits, CompileLeaseTicket, CompileSourceOverlay, FilesystemError,
        FilesystemService, TaskDrainHandle,
    },
    shared::relative_path::RelativePath,
};

const MAX_COMPILE_DEPTH: usize = 16;
const MAX_COMPILE_ENTRIES: usize = 4096;
const MAX_COMPILE_FILE_BYTES: usize = 32 * 1024 * 1024;
const MAX_COMPILE_TOTAL_BYTES: usize = 64 * 1024 * 1024;
const MAX_LOG_BYTES_PER_STREAM: usize = MAX_LOG_CHARACTERS;
const MAX_DIAGNOSTICS: usize = 256;
const MAX_OVERLAY_FILES: usize = MAX_COMPILE_ENTRIES;
const MAX_COMPILE_OUTPUT_LOG_BYTES: usize = 1024 * 1024;

const MAX_RUNS: usize = 4;
const MAX_QUEUED_RUNS: usize = 4;
const MAX_RUNS_PER_OWNER: usize = 2;
const MAX_GLOBAL_OWNED_RUNS: usize = 64;
const GLOBAL_WORKER_COUNT: usize = 2;
const GLOBAL_QUEUE_CAPACITY: usize = 32;

const DEFAULT_COLD_TIMEOUT: Duration = Duration::from_secs(300);
const DEFAULT_WARM_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_PROFILE_TIMEOUT: Duration = Duration::from_secs(24 * 60 * 60);
const CLEANUP_RETRY: Duration = Duration::from_millis(250);
const CLEANUP_RETRY_PAUSE: Duration = Duration::from_millis(50);
const RESULT_WAIT_SLICE: Duration = Duration::from_millis(100);

const PHASE_PREPARING: u8 = 0;
const PHASE_QUEUED: u8 = 1;
const PHASE_RUNNING: u8 = 2;
const PHASE_DRAINING: u8 = 3;
const PHASE_UNPROVEN: u8 = 4;
const PHASE_READY: u8 = 5;
const PHASE_CONSUMED: u8 = 6;

const ENGINE_NEVER_STARTED: u8 = 0;
const ENGINE_MAY_BE_RUNNING: u8 = 1;
const ENGINE_DRAINED: u8 = 2;

const CANCEL_NONE: u8 = 0;
const CANCEL_USER: u8 = 1;
const CANCEL_SUPERSEDED: u8 = 2;
const CANCEL_WORKSPACE_CLOSED: u8 = 3;
const CANCEL_OWNER_REVOKED: u8 = 4;
const CANCEL_SERVICE_DROPPED: u8 = 5;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum CompileServiceError {
    InvalidConfiguration(&'static str),
    InvalidRequest(&'static str),
    EngineUnavailable {
        engine: Engine,
        reason: &'static str,
    },
    Busy,
    CapacityExceeded,
    ExecutorUnavailable,
    OwnerRevoked,
    WorkspaceClosed,
    UnknownRun,
    CounterExhausted,
    WaitTimeout,
}

impl fmt::Display for CompileServiceError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidConfiguration(field) => {
                write!(f, "invalid compile configuration: {field}")
            }
            Self::InvalidRequest(field) => write!(f, "invalid compile request: {field}"),
            Self::EngineUnavailable { engine, reason } => {
                write!(f, "{engine:?} engine unavailable: {reason}")
            }
            Self::Busy => f.write_str("a compilation is already active for this owner"),
            Self::CapacityExceeded => f.write_str("compile capacity is exhausted"),
            Self::ExecutorUnavailable => f.write_str("compile worker executor unavailable"),
            Self::OwnerRevoked => f.write_str("compile owner has been revoked"),
            Self::WorkspaceClosed => f.write_str("compile workspace has been closed"),
            Self::UnknownRun => f.write_str("unknown or unauthorized compile run"),
            Self::CounterExhausted => f.write_str("compile run identifiers are exhausted"),
            Self::WaitTimeout => f.write_str("compile result wait timed out"),
        }
    }
}
impl Error for CompileServiceError {}

/// Result and optional SyncTeX bytes are delivered separately so neither
/// artifact needs to be embedded in a JSON result DTO.
pub(crate) struct CompileDelivery {
    pub(crate) result: CompileResult,
    pub(crate) synctex: Option<Vec<u8>>,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct RunScope {
    owner: OwnerId,
    workspace_id: WorkspaceId,
    entry_path: RelativePath,
    document_id: DocumentId,
}

struct RunControl {
    owner: OwnerId,
    identity: CompileIdentity,
    request: CompileRequest,
    scope: RunScope,
    profile: ResolvedProfile,
    overlay: CompileOverlay,
    workspace_config: CompileWorkspaceConfig,
    cancellation: CancellationHandle,
    cancellation_token: CancellationToken,
    cancel_reason: AtomicU8,
    publish_allowed: AtomicBool,
    admitted: AtomicBool,
    phase: AtomicU8,
    engine_state: AtomicU8,
    preparation_result: Mutex<Option<CompileResult>>,
    ticket: Mutex<Option<CompileLeaseTicket>>,
    drain_handle: Mutex<Option<TaskDrainHandle>>,
    run_directory: Mutex<Option<OwnedCompileDirectory>>,
    pending_process_error: Mutex<Option<ProcessError>>,
    result: Mutex<Option<CompileResult>>,
    synctex_result: Mutex<Option<Vec<u8>>>,
    workspace_root_for_redaction: Mutex<Option<PathBuf>>,
}

impl RunControl {
    fn request_cancel(&self, reason: u8) {
        let _ = self.cancel_reason.compare_exchange(
            CANCEL_NONE,
            reason,
            Ordering::AcqRel,
            Ordering::Acquire,
        );
        self.cancellation.cancel();
    }
    fn suppress_and_cancel(&self, reason: u8) {
        self.publish_allowed.store(false, Ordering::Release);
        self.request_cancel(reason);
    }
}

struct ServiceState {
    runs: HashMap<RunId, Arc<RunControl>>,
    latest: HashMap<RunScope, RunId>,
    revoked_owners: HashSet<OwnerId>,
    closed_workspaces: HashSet<(OwnerId, WorkspaceId)>,
    next_run: Option<u64>,
    shutdown: bool,
}

#[derive(Clone)]
struct ProcessInvocation {
    executable: PathBuf,
    working_directory: PathBuf,
    arguments: Vec<OsString>,
    environment: Vec<(OsString, OsString)>,
    timeout: Duration,
    output_pdf: PathBuf,
    engine_log: PathBuf,
    output_synctex: Option<PathBuf>,
}

trait ProcessExecutor: Send + Sync + 'static {
    fn run(
        &self,
        invocation: &ProcessInvocation,
        cancellation: &CancellationToken,
    ) -> Result<ProcessOutput, ProcessError>;
}

struct NativeProcessExecutor;

impl ProcessExecutor for NativeProcessExecutor {
    fn run(
        &self,
        invocation: &ProcessInvocation,
        cancellation: &CancellationToken,
    ) -> Result<ProcessOutput, ProcessError> {
        // The delivered process-owner API takes environment before timeout.
        // The environment is explicit and the host process environment is not
        // mutated by this coordinator.
        let spec = ProcessSpec::new_with_environment(
            invocation.executable.clone(),
            invocation.working_directory.clone(),
            invocation.arguments.clone(),
            invocation.environment.clone(),
            invocation.timeout,
            MAX_LOG_BYTES_PER_STREAM,
        );
        crate::platform::process_tree::run(&spec, cancellation)
    }
}

struct WorkItem {
    key: RunId,
    inner: Arc<CompileServiceInner>,
    control: Arc<RunControl>,
}

struct CompileExecutor {
    sender: SyncSender<WorkItem>,
    registry: Arc<Mutex<HashMap<RunId, Arc<CompileServiceInner>>>>,
    _workers: Mutex<Vec<JoinHandle<()>>>,
}

static GLOBAL_EXECUTOR: OnceLock<Result<Arc<CompileExecutor>, String>> = OnceLock::new();

impl CompileExecutor {
    fn start() -> Result<Self, String> {
        let (sender, receiver) = mpsc::sync_channel::<WorkItem>(GLOBAL_QUEUE_CAPACITY);
        let receiver = Arc::new(Mutex::new(receiver));
        let registry = Arc::new(Mutex::new(HashMap::new()));
        let mut workers = Vec::with_capacity(GLOBAL_WORKER_COUNT);
        for number in 0..GLOBAL_WORKER_COUNT {
            let receiver = Arc::clone(&receiver);
            let registry = Arc::clone(&registry);
            let worker = thread::Builder::new()
                .name(format!("modutex-compile-worker-{number}"))
                .spawn(move || loop {
                    let message = {
                        let guard = lock_recover(&receiver);
                        guard.recv()
                    };
                    let Ok(work) = message else {
                        break;
                    };
                    let inner = Arc::clone(&work.inner);
                    let control = Arc::clone(&work.control);
                    let terminal =
                        catch_unwind(AssertUnwindSafe(|| inner.execute(&control))).unwrap_or(false);
                    let terminal = if terminal {
                        true
                    } else {
                        catch_unwind(AssertUnwindSafe(|| inner.recover_after_panic(&control)))
                            .unwrap_or(false)
                    };
                    if terminal {
                        lock_recover(&registry).remove(&work.key);
                    }
                })
                .map_err(|error| format!("start compile worker: {error}"))?;
            workers.push(worker);
        }
        Ok(Self {
            sender,
            registry,
            _workers: Mutex::new(workers),
        })
    }

    fn submit(
        &self,
        inner: Arc<CompileServiceInner>,
        control: Arc<RunControl>,
    ) -> Result<(), CompileServiceError> {
        let key = control.identity.run_id.clone();
        {
            let mut registry = lock_recover(&self.registry);
            if registry.len() >= MAX_GLOBAL_OWNED_RUNS {
                return Err(CompileServiceError::CapacityExceeded);
            }
            if registry.contains_key(&key) {
                return Err(CompileServiceError::CounterExhausted);
            }
            registry.insert(key.clone(), Arc::clone(&inner));
        }
        let work = WorkItem {
            key: key.clone(),
            inner,
            control,
        };
        match self.sender.try_send(work) {
            Ok(()) => Ok(()),
            Err(TrySendError::Full(_)) => {
                lock_recover(&self.registry).remove(&key);
                Err(CompileServiceError::CapacityExceeded)
            }
            Err(TrySendError::Disconnected(_)) => {
                lock_recover(&self.registry).remove(&key);
                Err(CompileServiceError::ExecutorUnavailable)
            }
        }
    }
}

fn global_executor() -> Result<Arc<CompileExecutor>, CompileServiceError> {
    match GLOBAL_EXECUTOR.get_or_init(|| CompileExecutor::start().map(Arc::new)) {
        Ok(executor) => Ok(Arc::clone(executor)),
        Err(_) => Err(CompileServiceError::ExecutorUnavailable),
    }
}

struct CompileServiceInner {
    filesystem: Arc<FilesystemService>,
    config: TrustedCompileConfig,
    executor: Arc<CompileExecutor>,
    process_executor: Arc<dyn ProcessExecutor>,
    state: Mutex<ServiceState>,
    changed: Condvar,
    external_handles: AtomicUsize,
    nonce: String,
}

pub(crate) struct CompileService {
    inner: Arc<CompileServiceInner>,
}

impl Clone for CompileService {
    fn clone(&self) -> Self {
        self.inner.external_handles.fetch_add(1, Ordering::AcqRel);
        Self {
            inner: Arc::clone(&self.inner),
        }
    }
}
impl Drop for CompileService {
    fn drop(&mut self) {
        if self.inner.external_handles.fetch_sub(1, Ordering::AcqRel) == 1 {
            self.inner.shutdown();
        }
    }
}

impl CompileService {
    /// Uses the same shared filesystem service that owns workspace sessions and
    /// leases. Do not construct a second registry or lease coordinator.
    pub(crate) fn new(
        filesystem: Arc<FilesystemService>,
        config: TrustedCompileConfig,
    ) -> Result<Self, CompileServiceError> {
        Self::new_with_executor(filesystem, config, Arc::new(NativeProcessExecutor))
    }

    fn new_with_executor(
        filesystem: Arc<FilesystemService>,
        config: TrustedCompileConfig,
        process_executor: Arc<dyn ProcessExecutor>,
    ) -> Result<Self, CompileServiceError> {
        let executor = global_executor()?;
        Ok(Self {
            inner: Arc::new(CompileServiceInner {
                filesystem,
                config,
                executor,
                process_executor,
                state: Mutex::new(ServiceState {
                    runs: HashMap::new(),
                    latest: HashMap::new(),
                    revoked_owners: HashSet::new(),
                    closed_workspaces: HashSet::new(),
                    next_run: Some(1),
                    shutdown: false,
                }),
                changed: Condvar::new(),
                external_handles: AtomicUsize::new(1),
                nonce: Uuid::new_v4().simple().to_string(),
            }),
        })
    }

    pub(crate) fn start_with_workspace_config(
        &self,
        owner: &OwnerId,
        request: CompileRequest,
        overlay: CompileOverlay,
        config: CompileWorkspaceConfig,
        custom_command_allowed: bool,
    ) -> Result<CompileIdentity, CompileServiceError> {
        self.inner
            .start(owner, request, overlay, config, custom_command_allowed)
    }

    /// Cancellation is monotonic and does not release a lease. Cleanup remains
    /// the worker's responsibility until process and staging drain are proven.
    pub(crate) fn cancel(
        &self,
        owner: &OwnerId,
        identity: &CompileIdentity,
    ) -> Result<bool, CompileServiceError> {
        let state = lock_recover(&self.inner.state);
        let control = state
            .runs
            .get(&identity.run_id)
            .filter(|control| &control.owner == owner && &control.identity == identity)
            .cloned()
            .ok_or(CompileServiceError::UnknownRun)?;
        if control.phase.load(Ordering::Acquire) == PHASE_READY {
            return Ok(false);
        }
        control.request_cancel(CANCEL_USER);
        self.inner.changed.notify_all();
        Ok(true)
    }

    pub(crate) fn take_result_with_artifacts(
        &self,
        owner: &OwnerId,
        identity: &CompileIdentity,
    ) -> Result<Option<CompileDelivery>, CompileServiceError> {
        self.inner.take_result_with_artifacts(owner, identity)
    }

    pub(crate) fn wait_result_with_artifacts(
        &self,
        owner: &OwnerId,
        identity: &CompileIdentity,
        timeout: Duration,
    ) -> Result<Option<CompileDelivery>, CompileServiceError> {
        let deadline = Instant::now()
            .checked_add(timeout)
            .ok_or(CompileServiceError::WaitTimeout)?;
        let mut state = lock_recover(&self.inner.state);
        loop {
            let control = state
                .runs
                .get(&identity.run_id)
                .filter(|control| &control.owner == owner && &control.identity == identity)
                .cloned()
                .ok_or(CompileServiceError::UnknownRun)?;
            if control.phase.load(Ordering::Acquire) == PHASE_READY {
                drop(state);
                return self.take_result_with_artifacts(owner, identity);
            }
            let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
                return Ok(None);
            };
            let waited = self
                .inner
                .changed
                .wait_timeout(state, remaining.min(RESULT_WAIT_SLICE));
            match waited {
                Ok((next, timeout_result)) => {
                    state = next;
                    if timeout_result.timed_out() && Instant::now() >= deadline {
                        return Ok(None);
                    }
                }
                Err(poisoned) => state = poisoned.into_inner().0,
            }
        }
    }

    pub(crate) fn cancel_run(
        &self,
        owner: &OwnerId,
        run_id: &RunId,
    ) -> Result<bool, CompileServiceError> {
        let identity = self.inner.identity_for_run(owner, run_id)?;
        self.cancel(owner, &identity)
    }

    pub(crate) fn wait_run_result_with_artifacts(
        &self,
        owner: &OwnerId,
        run_id: &RunId,
        timeout: Duration,
    ) -> Result<Option<CompileDelivery>, CompileServiceError> {
        let identity = self.inner.identity_for_run(owner, run_id)?;
        self.wait_result_with_artifacts(owner, &identity, timeout)
    }

    /// The host follows owner revocation with revocation of the same shared
    /// FilesystemService so its registered task cancellers are drained.
    pub(crate) fn revoke_owner(&self, owner: &OwnerId) -> usize {
        self.inner.revoke_owner(owner)
    }

    /// The host follows workspace notification with close on the same shared
    /// FilesystemService; that close waits for the compile task to drain.
    pub(crate) fn close_workspace(&self, owner: &OwnerId, workspace_id: &WorkspaceId) -> usize {
        self.inner.close_workspace(owner, workspace_id)
    }
}

impl CompileServiceInner {
    fn lock_state(&self) -> MutexGuard<'_, ServiceState> {
        lock_recover(&self.state)
    }

    fn identity_for_run(
        &self,
        owner: &OwnerId,
        run_id: &RunId,
    ) -> Result<CompileIdentity, CompileServiceError> {
        let state = self.lock_state();
        state
            .runs
            .get(run_id)
            .filter(|control| &control.owner == owner)
            .map(|control| control.identity.clone())
            .ok_or(CompileServiceError::UnknownRun)
    }

    fn resolve_profile(
        &self,
        engine: Engine,
        config: &CompileWorkspaceConfig,
        custom_command_allowed: bool,
    ) -> Result<ResolvedProfile, CompileServiceError> {
        match config.profile {
            CompileProfile::Managed if engine == Engine::Managed => {
                let profile =
                    self.config
                        .managed
                        .as_ref()
                        .ok_or(CompileServiceError::EngineUnavailable {
                            engine,
                            reason: "no trusted Tectonic profile is configured",
                        })?;
                let executable = resolve_trusted_executable(&profile.executable).map_err(|_| {
                    CompileServiceError::EngineUnavailable {
                        engine,
                        reason: "configured Tectonic executable is missing or unsafe",
                    }
                })?;
                let search_paths = resolve_search_paths(&profile.search_paths).map_err(|_| {
                    CompileServiceError::EngineUnavailable {
                        engine,
                        reason: "configured managed search path is missing or unsafe",
                    }
                })?;
                Ok(ResolvedProfile::Managed {
                    #[cfg(test)]
                    test_bundle: profile.test_bundle.clone(),
                    executable,
                    cache_directory: profile.cache_directory.clone(),
                    search_paths,
                    environment: profile.environment.clone(),
                    cold_timeout: profile.cold_timeout,
                    warm_timeout: profile.warm_timeout,
                })
            }
            CompileProfile::System if engine == Engine::System => {
                let profile =
                    self.config
                        .system
                        .as_ref()
                        .ok_or(CompileServiceError::EngineUnavailable {
                            engine,
                            reason: "no trusted system TeX profile is configured",
                        })?;
                let executable = resolve_trusted_executable(&profile.executable).map_err(|_| {
                    CompileServiceError::EngineUnavailable {
                        engine,
                        reason: "configured system TeX executable is missing or unsafe",
                    }
                })?;
                let search_paths = resolve_search_paths(&profile.search_paths).map_err(|_| {
                    CompileServiceError::EngineUnavailable {
                        engine,
                        reason: "configured system TeX search path is missing or unsafe",
                    }
                })?;
                Ok(ResolvedProfile::System {
                    executable,
                    arguments: profile.arguments.clone(),
                    search_paths,
                    environment: profile.environment.clone(),
                    timeout: profile.timeout,
                    output_stem: profile.output_stem.clone(),
                    synctex: profile.synctex,
                })
            }
            CompileProfile::Custom if engine == Engine::System => {
                if !custom_command_allowed {
                    return Err(CompileServiceError::EngineUnavailable {
                        engine,
                        reason: "custom compile command permission is disabled",
                    });
                }
                let command = config.custom_command.as_deref().ok_or(
                    CompileServiceError::InvalidConfiguration("custom command is missing"),
                )?;
                let profile = custom_system_profile(command)?;
                Ok(ResolvedProfile::System {
                    executable: profile.executable,
                    arguments: profile.arguments,
                    search_paths: profile.search_paths,
                    environment: profile.environment,
                    timeout: profile.timeout,
                    output_stem: profile.output_stem,
                    synctex: profile.synctex,
                })
            }
            _ => Err(CompileServiceError::InvalidRequest(
                "compile engine does not match the persisted workspace profile",
            )),
        }
    }

    fn start(
        self: &Arc<Self>,
        owner: &OwnerId,
        request: CompileRequest,
        overlay: CompileOverlay,
        mut workspace_config: CompileWorkspaceConfig,
        custom_command_allowed: bool,
    ) -> Result<CompileIdentity, CompileServiceError> {
        if !request
            .entry_path
            .as_str()
            .to_ascii_lowercase()
            .ends_with(".tex")
        {
            return Err(CompileServiceError::InvalidRequest(
                "entryPath must name a TeX source",
            ));
        }
        validate_overlay(&request, &overlay)?;
        // Resolve the per-run default before capturing inputs so the generated PDF
        // is excluded from later snapshots just like an explicit output path.
        if workspace_config.output_dir.is_none() && workspace_config.pdf_path.is_none() {
            let entry = request.entry_path.as_str();
            workspace_config.pdf_path = Some(
                RelativePath::parse(&format!("{}.pdf", &entry[..entry.len() - 4]))
                    .map_err(|_| CompileServiceError::InvalidConfiguration("default PDF path"))?,
            );
        }
        // An unset main file uses this request's TeX entry for this run only.
        let effective_main = workspace_config.effective_main(&request.entry_path);
        if effective_main != &request.entry_path {
            return Err(CompileServiceError::InvalidRequest(
                "entryPath does not match the persisted workspace main file",
            ));
        }
        if workspace_config.profile.engine() != request.engine {
            return Err(CompileServiceError::InvalidRequest(
                "engine does not match the persisted workspace profile",
            ));
        }
        // Resolve and recheck a host-created executable before reserving a run,
        // filesystem lease, or runnable worker. A renderer request never contains argv.
        let profile =
            self.resolve_profile(request.engine, &workspace_config, custom_command_allowed)?;
        let (control, identity) = {
            let mut state = self.lock_state();
            if state.shutdown {
                return Err(CompileServiceError::ExecutorUnavailable);
            }
            if state.revoked_owners.contains(owner) {
                return Err(CompileServiceError::OwnerRevoked);
            }
            if state
                .closed_workspaces
                .contains(&(owner.clone(), request.workspace_id.clone()))
            {
                return Err(CompileServiceError::WorkspaceClosed);
            }
            let owner_runs = state
                .runs
                .values()
                .filter(|run| &run.owner == owner)
                .collect::<Vec<_>>();
            if owner_runs.len() >= MAX_RUNS_PER_OWNER {
                return Err(CompileServiceError::CapacityExceeded);
            }
            if owner_runs
                .iter()
                .any(|run| is_active_phase(run.phase.load(Ordering::Acquire)))
            {
                return Err(CompileServiceError::Busy);
            }
            if state.runs.len() >= MAX_RUNS {
                return Err(CompileServiceError::CapacityExceeded);
            }
            let queued = state
                .runs
                .values()
                .filter(|run| {
                    matches!(
                        run.phase.load(Ordering::Acquire),
                        PHASE_PREPARING | PHASE_QUEUED
                    )
                })
                .count();
            if queued >= MAX_QUEUED_RUNS {
                return Err(CompileServiceError::CapacityExceeded);
            }
            let counter = state
                .next_run
                .ok_or(CompileServiceError::CounterExhausted)?;
            state.next_run = counter.checked_add(1);
            let run_id = RunId::parse(&format!("mtx-{}-{counter}", self.nonce))
                .map_err(|_| CompileServiceError::CounterExhausted)?;
            let identity = CompileIdentity {
                run_id,
                workspace_id: request.workspace_id.clone(),
                entry_path: request.entry_path.clone(),
                document_id: request.document_id.clone(),
                document_version: request.document_version,
                saved_revision: request.saved_revision.clone(),
            };
            let scope = RunScope {
                owner: owner.clone(),
                workspace_id: request.workspace_id.clone(),
                entry_path: request.entry_path.clone(),
                document_id: request.document_id.clone(),
            };
            let (cancellation, cancellation_token) = cancellation_pair();
            let control = Arc::new(RunControl {
                owner: owner.clone(),
                identity: identity.clone(),
                request: request.clone(),
                scope,
                profile,
                overlay,
                workspace_config: workspace_config.clone(),
                cancellation,
                cancellation_token,
                cancel_reason: AtomicU8::new(CANCEL_NONE),
                publish_allowed: AtomicBool::new(true),
                admitted: AtomicBool::new(false),
                phase: AtomicU8::new(PHASE_PREPARING),
                engine_state: AtomicU8::new(ENGINE_NEVER_STARTED),
                preparation_result: Mutex::new(None),
                ticket: Mutex::new(None),
                drain_handle: Mutex::new(None),
                run_directory: Mutex::new(None),
                pending_process_error: Mutex::new(None),
                result: Mutex::new(None),
                synctex_result: Mutex::new(None),
                workspace_root_for_redaction: Mutex::new(None),
            });
            state
                .runs
                .insert(identity.run_id.clone(), Arc::clone(&control));
            (control, identity)
        };

        // Reserve bounded worker capacity before creating the filesystem ticket.
        if let Err(error) = self.executor.submit(Arc::clone(self), Arc::clone(&control)) {
            let mut state = self.lock_state();
            state.runs.remove(&identity.run_id);
            self.changed.notify_all();
            return Err(error);
        }
        {
            let mut state = self.lock_state();
            let revoked = state.shutdown || state.revoked_owners.contains(owner);
            let closed = state
                .closed_workspaces
                .contains(&(owner.clone(), request.workspace_id.clone()));
            if revoked || closed {
                control.suppress_and_cancel(if revoked {
                    CANCEL_OWNER_REVOKED
                } else {
                    CANCEL_WORKSPACE_CLOSED
                });
            } else if let Some(old_id) = state
                .latest
                .insert(control.scope.clone(), identity.run_id.clone())
            {
                if old_id != identity.run_id {
                    if let Some(old) = state.runs.get(&old_id).cloned() {
                        old.suppress_and_cancel(CANCEL_SUPERSEDED);
                        if old.phase.load(Ordering::Acquire) == PHASE_READY {
                            old.phase.store(PHASE_CONSUMED, Ordering::Release);
                            state.runs.remove(&old_id);
                        }
                    }
                }
            }
        }

        let cancel_handle = control.cancellation.clone();
        let canceller: crate::services::filesystem::SubSystemCanceller = Box::new(move || {
            cancel_handle.cancel();
            Ok(())
        });
        let prepared = catch_unwind(AssertUnwindSafe(|| {
            if let Some(entry) = control.overlay.entry.as_ref() {
                self.filesystem.prepare_compile_with_overlay(
                    owner,
                    identity.run_id.clone(),
                    &request,
                    &CompileSourceOverlay {
                        path: &request.entry_path,
                        document_id: &entry.document_id,
                        document_version: entry.document_version,
                        bytes: &entry.bytes,
                    },
                    canceller,
                )
            } else {
                self.filesystem
                    .prepare_compile(owner, identity.run_id.clone(), &request, canceller)
            }
        }));

        let mut start_error = None;
        match prepared {
            Ok(Ok(ticket)) => {
                if ticket.identity() != &identity {
                    *lock_recover(&control.preparation_result) = Some(failure_result(
                        identity.clone(),
                        "Prepared compile identity did not match the request.",
                        Vec::new(),
                    ));
                } else {
                    *lock_recover(&control.workspace_root_for_redaction) =
                        Some(ticket.canonical_root().to_path_buf());
                }
                match ticket.drain_handle() {
                    Ok(drain) => {
                        *lock_recover(&control.drain_handle) = Some(drain);
                        *lock_recover(&control.ticket) = Some(ticket);
                    }
                    Err(_) => {
                        let _ =
                            lock_recover(&control.preparation_result).get_or_insert_with(|| {
                                failure_result(
                                    identity.clone(),
                                    "Compile cleanup handle could not be created.",
                                    Vec::new(),
                                )
                            });
                        *lock_recover(&control.ticket) = Some(ticket);
                    }
                }
            }
            Ok(Err(error)) => {
                *lock_recover(&control.preparation_result) = Some(failure_result(
                    identity.clone(),
                    filesystem_failure_text(&error),
                    Vec::new(),
                ));
            }
            Err(_) => {
                // Filesystem preparation registers its task only after all
                // fallible ticket construction. An unwind therefore leaves no
                // task or lease behind and can settle as an ordinary failure.
                *lock_recover(&control.preparation_result) = Some(failure_result(
                    identity.clone(),
                    "Compile filesystem preparation failed before task admission.",
                    Vec::new(),
                ));
            }
        }

        let state = self.lock_state();
        let revoked = state.shutdown || state.revoked_owners.contains(owner);
        let closed = state
            .closed_workspaces
            .contains(&(owner.clone(), request.workspace_id.clone()));
        if revoked || closed {
            control.suppress_and_cancel(if revoked {
                CANCEL_OWNER_REVOKED
            } else {
                CANCEL_WORKSPACE_CLOSED
            });
            start_error = Some(if revoked {
                CompileServiceError::OwnerRevoked
            } else {
                CompileServiceError::WorkspaceClosed
            });
        }
        control.phase.store(PHASE_QUEUED, Ordering::Release);
        control.admitted.store(true, Ordering::Release);
        self.changed.notify_all();
        drop(state);
        if let Some(error) = start_error {
            return Err(error);
        }
        Ok(identity)
    }

    fn wait_for_admission(&self, control: &RunControl) {
        if !control.admitted.load(Ordering::Acquire) {
            let _state = self
                .changed
                .wait_while(self.lock_state(), |_| {
                    !control.admitted.load(Ordering::Acquire)
                })
                .unwrap_or_else(PoisonError::into_inner);
        }
    }

    fn execute(&self, control: &Arc<RunControl>) -> bool {
        self.wait_for_admission(control);
        control.phase.store(PHASE_RUNNING, Ordering::Release);
        if let Some(result) = lock_recover(&control.preparation_result).take() {
            return self.finish_result(control, result);
        }
        if control.cancellation_token.is_cancelled() {
            return self.finish_result(control, cancelled_result(control.identity.clone(), ""));
        }

        let disk_snapshot = {
            let ticket_guard = lock_recover(&control.ticket);
            let Some(ticket) = ticket_guard.as_ref() else {
                return self.finish_result(
                    control,
                    failure_result(
                        control.identity.clone(),
                        "Compile preparation returned no filesystem ticket.",
                        Vec::new(),
                    ),
                );
            };
            let excluded = control.workspace_config.snapshot_exclusions();
            self.filesystem.capture_compile_snapshot_excluding(
                ticket,
                CompileInputLimits {
                    max_depth: MAX_COMPILE_DEPTH,
                    max_entries: MAX_COMPILE_ENTRIES,
                    max_file_bytes: MAX_COMPILE_FILE_BYTES,
                    max_total_bytes: MAX_COMPILE_TOTAL_BYTES,
                },
                &excluded,
            )
        };
        let disk_snapshot = match disk_snapshot {
            Ok(snapshot) => snapshot,
            Err(error) => {
                return self.finish_result(
                    control,
                    failure_result(
                        control.identity.clone(),
                        filesystem_failure_text(&error),
                        Vec::new(),
                    ),
                )
            }
        };
        if !snapshot_matches_ticket(control, &disk_snapshot) {
            return self.finish_result(
                control,
                failure_result(
                    control.identity.clone(),
                    "Compile entry bytes or revision changed while capturing the input snapshot.",
                    Vec::new(),
                ),
            );
        }
        let snapshot = match apply_overlay(&disk_snapshot, &control.request, &control.overlay) {
            Ok(snapshot) => snapshot,
            Err(_) => {
                return self.finish_result(
                    control,
                    failure_result(
                        control.identity.clone(),
                        "Compile source overlay is invalid or exceeds configured limits.",
                        Vec::new(),
                    ),
                )
            }
        };
        if control.cancellation_token.is_cancelled() {
            return self.finish_result(control, cancelled_result(control.identity.clone(), ""));
        }

        let directory = match OwnedCompileDirectory::create(
            &self.config.temporary_root,
            &control.identity.run_id,
        ) {
            Ok(directory) => directory,
            Err(_) => {
                return self.finish_result(
                    control,
                    failure_result(
                        control.identity.clone(),
                        "Private compile staging directory could not be created.",
                        Vec::new(),
                    ),
                )
            }
        };
        let layout = directory.layout();
        *lock_recover(&control.run_directory) = Some(directory);
        if stage_snapshot(&layout.input, &snapshot).is_err() {
            return self.finish_result(
                control,
                failure_result(
                    control.identity.clone(),
                    "Bounded workspace input snapshot could not be staged.",
                    Vec::new(),
                ),
            );
        }
        if control.cancellation_token.is_cancelled() {
            return self.finish_result(control, cancelled_result(control.identity.clone(), ""));
        }
        let invocation = match self.make_invocation(control, &layout) {
            Ok(invocation) => invocation,
            Err(_) => {
                return self.finish_result(
                    control,
                    failure_result(
                        control.identity.clone(),
                        "Trusted compile profile preparation failed.",
                        Vec::new(),
                    ),
                )
            }
        };

        if let Some(directory) = lock_recover(&control.run_directory).as_mut() {
            directory.allow_cleanup = false;
        }
        control
            .engine_state
            .store(ENGINE_MAY_BE_RUNNING, Ordering::Release);
        let runner_result = catch_unwind(AssertUnwindSafe(|| {
            self.process_executor
                .run(&invocation, &control.cancellation_token)
        }));
        let process = match runner_result {
            Ok(Ok(output)) => {
                if output.pid == 0 || output.active_processes_after_exit != 0 {
                    control.phase.store(PHASE_UNPROVEN, Ordering::Release);
                    return false;
                }
                control
                    .engine_state
                    .store(ENGINE_DRAINED, Ordering::Release);
                self.allow_directory_cleanup(control);
                self.result_from_output(control, &snapshot, &layout, &invocation.engine_log, output)
            }
            Ok(Err(error)) => {
                *lock_recover(&control.pending_process_error) = Some(error);
                let Some(error) = self.drain_process_error(control) else {
                    control.phase.store(PHASE_UNPROVEN, Ordering::Release);
                    return false;
                };
                control
                    .engine_state
                    .store(ENGINE_DRAINED, Ordering::Release);
                self.allow_directory_cleanup(control);
                self.result_from_process_error(control, &snapshot, &invocation.engine_log, error)
            }
            Err(_) => {
                control.phase.store(PHASE_UNPROVEN, Ordering::Release);
                return false;
            }
        };

        let mut result = process;
        if !control.cancellation_token.is_cancelled() {
            let excluded = control.workspace_config.snapshot_exclusions();
            let validation = {
                let ticket_guard = lock_recover(&control.ticket);
                ticket_guard.as_ref().map(|ticket| {
                    self.filesystem.validate_compile_snapshot_excluding(
                        ticket,
                        &disk_snapshot,
                        &excluded,
                    )
                })
            };
            if !matches!(validation, Some(Ok(()))) {
                result = failure_result(
                    control.identity.clone(),
                    "Workspace compile inputs changed before result settlement.",
                    match &result {
                        CompileResult::Failure { diagnostics, .. } => diagnostics.clone(),
                        _ => Vec::new(),
                    },
                );
            }
        }

        if !control.cancellation_token.is_cancelled() {
            let outputs = match configured_compile_outputs(
                &control.workspace_config,
                &control.request,
                &result,
            ) {
                Ok(outputs) => outputs,
                Err(_) => {
                    result = failure_result(
                        control.identity.clone(),
                        "Configured compile output paths are invalid.",
                        Vec::new(),
                    );
                    Vec::new()
                }
            };
            if !outputs.is_empty() && matches!(&result, CompileResult::Success { .. }) {
                let commit = {
                    let ticket_guard = lock_recover(&control.ticket);
                    ticket_guard.as_ref().map(|ticket| {
                        self.filesystem
                            .commit_compile_outputs(ticket, &outputs, || {
                                control.cancellation_token.is_cancelled()
                            })
                    })
                };
                match commit {
                    Some(Ok(())) => {}
                    Some(Err(FilesystemError::Cancelled)) => {
                        let log = match &result {
                            CompileResult::Success { log, .. } => log.clone(),
                            _ => String::new(),
                        };
                        result = cancelled_result(control.identity.clone(), &log);
                    }
                    _ => {
                        let (log, diagnostics) = match &result {
                            CompileResult::Success {
                                log, diagnostics, ..
                            } => (log.clone(), diagnostics.clone()),
                            _ => (String::new(), Vec::new()),
                        };
                        result = failure_result(
                            control.identity.clone(),
                            &append_log_line(&log, "Configured compile outputs could not be committed safely; previous files were restored."),
                            diagnostics,
                        );
                    }
                }
            }
        }
        self.finish_result(control, result)
    }

    fn make_invocation(
        &self,
        control: &RunControl,
        layout: &CompileLayout,
    ) -> Result<ProcessInvocation, CompileServiceError> {
        let entry = &control.request.entry_path;
        let default_stem = entry_stem(entry)?;
        let invocation = match &control.profile {
            ResolvedProfile::Managed {
                #[cfg(test)]
                test_bundle,
                executable,
                cache_directory,
                search_paths,
                environment,
                cold_timeout,
                warm_timeout,
            } => {
                let cache = prepare_trusted_directory(cache_directory).map_err(|_| {
                    CompileServiceError::EngineUnavailable {
                        engine: Engine::Managed,
                        reason: "managed cache directory is missing or unsafe",
                    }
                })?;
                let warm = has_cached_latex_format(&cache).map_err(|_| {
                    CompileServiceError::EngineUnavailable {
                        engine: Engine::Managed,
                        reason: "managed cache could not be inspected",
                    }
                })?;
                let arguments = vec![
                    OsString::from("--untrusted"),
                    OsString::from("--keep-logs"),
                    OsString::from("--synctex"),
                    OsString::from("--outdir"),
                    layout.output.as_os_str().to_owned(),
                    OsString::from(entry.as_str()),
                ];
                #[cfg(test)]
                let arguments = {
                    let mut arguments = arguments;
                    if let Some(bundle) = test_bundle {
                        arguments.splice(
                            0..0,
                            [
                                OsString::from("--bundle"),
                                OsString::from(
                                    tauri::Url::from_file_path(bundle)
                                        .expect("absolute local test bundle")
                                        .as_str(),
                                ),
                                OsString::from("--only-cached"),
                            ],
                        );
                    }
                    arguments
                };
                let process_environment = build_process_environment(
                    environment,
                    search_paths,
                    Some(executable),
                    &layout.temporary,
                    Some(&cache),
                )?;
                Ok(ProcessInvocation {
                    executable: executable.clone(),
                    working_directory: layout.input.clone(),
                    arguments,
                    environment: process_environment,
                    timeout: if warm { *warm_timeout } else { *cold_timeout },
                    output_pdf: layout.output.join(format!("{default_stem}.pdf")),
                    engine_log: layout.output.join(format!("{default_stem}.log")),
                    output_synctex: Some(layout.output.join(format!("{default_stem}.synctex.gz"))),
                })
            }
            ResolvedProfile::System {
                executable,
                arguments,
                search_paths,
                environment,
                timeout,
                output_stem,
                synctex,
                ..
            } => {
                let default_output_stem = OsString::from(default_stem.as_str());
                let output_stem = output_stem.as_ref().unwrap_or(&default_output_stem);
                let mut argv = Vec::with_capacity(arguments.len() + usize::from(*synctex));
                if *synctex {
                    argv.push(OsString::from("-synctex=1"));
                }
                for argument in arguments {
                    match argument {
                        SystemArgument::Literal(value) => argv.push(value.clone()),
                        SystemArgument::EntryPath => argv.push(OsString::from(entry.as_str())),
                        SystemArgument::OutputDirectory => {
                            argv.push(layout.output.as_os_str().to_owned())
                        }
                        SystemArgument::OutputDirectoryWithPrefix(prefix) => {
                            let mut value = prefix.clone();
                            value.push(layout.output.as_os_str());
                            argv.push(value);
                        }
                    }
                }
                let stem =
                    output_stem
                        .to_str()
                        .ok_or(CompileServiceError::InvalidConfiguration(
                            "PDF output stem must be UTF-8",
                        ))?;
                let process_environment = build_process_environment(
                    environment,
                    search_paths,
                    Some(executable),
                    &layout.temporary,
                    None,
                )?;
                Ok(ProcessInvocation {
                    executable: executable.clone(),
                    working_directory: layout.input.clone(),
                    arguments: argv,
                    environment: process_environment,
                    timeout: *timeout,
                    output_pdf: layout.output.join(format!("{stem}.pdf")),
                    engine_log: layout.output.join(format!("{stem}.log")),
                    output_synctex: if *synctex {
                        Some(layout.output.join(format!("{stem}.synctex.gz")))
                    } else {
                        None
                    },
                })
            }
        }?;
        let output_directory = layout.output.as_path();
        if invocation.output_pdf.parent() != Some(output_directory)
            || invocation.engine_log.parent() != Some(output_directory)
            || invocation
                .output_synctex
                .as_ref()
                .is_some_and(|path| path.parent() != Some(output_directory))
        {
            return Err(CompileServiceError::InvalidConfiguration(
                "compile outputs must remain in the private output directory",
            ));
        }
        Ok(invocation)
    }

    fn result_from_output(
        &self,
        control: &RunControl,
        snapshot: &CompileSourceSnapshot,
        layout: &CompileLayout,
        engine_log_path: &Path,
        output: ProcessOutput,
    ) -> CompileResult {
        let mut log_parts = vec![
            String::from_utf8_lossy(&output.logs.stdout).into_owned(),
            String::from_utf8_lossy(&output.logs.stderr).into_owned(),
        ];
        let log_state = read_engine_log(engine_log_path);
        let mut log_limit_failed = false;
        match log_state {
            EngineLog::Bytes(bytes) => log_parts.push(String::from_utf8_lossy(&bytes).into_owned()),
            EngineLog::Missing => {}
            EngineLog::TooLarge => {
                log_limit_failed = true;
                log_parts.push("Compiler log exceeded the configured limit.".to_owned());
            }
            EngineLog::Failed => {
                log_parts.push("Compiler log could not be safely read.".to_owned())
            }
        }
        let (log, combined_truncated) = self.safe_compile_log(control, &log_parts);
        let diagnostics = parse_diagnostics(&log, snapshot, &control.request.entry_path);
        if control.cancellation_token.is_cancelled() {
            return cancelled_result(control.identity.clone(), &log);
        }
        if output.exit_code != 0 {
            return failure_result(
                control.identity.clone(),
                &append_log_line(
                    &log,
                    &format!("Compiler exited with code {}.", output.exit_code),
                ),
                diagnostics,
            );
        }
        if output.logs.stdout_truncated || output.logs.stderr_truncated || log_limit_failed {
            return failure_result(
                control.identity.clone(),
                &append_log_line(&log, "Compiler output exceeded the configured log limit."),
                diagnostics,
            );
        }
        let _ = combined_truncated;
        let result =
            self.success_or_output_failure(control, &log, diagnostics, &layout.output, snapshot);
        if matches!(&result, CompileResult::Success { .. }) {
            *lock_recover(&control.synctex_result) = compile_synctex_path(control, &layout.output)
                .as_deref()
                .and_then(|path| {
                    read_compile_synctex(
                        path,
                        &layout.input,
                        snapshot.files.iter().map(|file| &file.path),
                        &control.request.entry_path,
                    )
                });
        }
        result
    }

    fn success_or_output_failure(
        &self,
        control: &RunControl,
        log: &str,
        diagnostics: Vec<Diagnostic>,
        output_directory: &Path,
        _snapshot: &CompileSourceSnapshot,
    ) -> CompileResult {
        let output_path = match &control.profile {
            ResolvedProfile::Managed { .. } => match entry_stem(&control.request.entry_path) {
                Ok(stem) => output_directory.join(format!("{stem}.pdf")),
                Err(_) => return failure_result(control.identity.clone(), log, diagnostics),
            },
            ResolvedProfile::System { output_stem, .. } => {
                let stem = output_stem
                    .as_ref()
                    .and_then(|value| value.to_str().map(str::to_owned))
                    .or_else(|| entry_stem(&control.request.entry_path).ok());
                let Some(stem) = stem else {
                    return failure_result(control.identity.clone(), log, diagnostics);
                };
                output_directory.join(format!("{stem}.pdf"))
            }
        };
        match read_compile_pdf(&output_path, output_directory) {
            Ok(pdf) => CompileResult::Success {
                identity: control.identity.clone(),
                pdf,
                log: log.to_owned(),
                diagnostics,
            },
            Err(PdfReadFailure::Missing) => failure_result(
                control.identity.clone(),
                &append_log_line(log, "Compiler did not produce the expected PDF."),
                diagnostics,
            ),
            Err(PdfReadFailure::TooLarge) => failure_result(
                control.identity.clone(),
                &append_log_line(log, "Compiler PDF exceeded the 32 MiB limit."),
                diagnostics,
            ),
            Err(PdfReadFailure::Invalid) => failure_result(
                control.identity.clone(),
                &append_log_line(log, "Compiler output was not a complete valid PDF."),
                diagnostics,
            ),
        }
    }

    fn result_from_process_error(
        &self,
        control: &RunControl,
        snapshot: &CompileSourceSnapshot,
        engine_log_path: &Path,
        error: RunnerFailure,
    ) -> CompileResult {
        let mut log_parts = vec![
            String::from_utf8_lossy(&error.logs.stdout).into_owned(),
            String::from_utf8_lossy(&error.logs.stderr).into_owned(),
            process_error_text(error.kind, error.exit_code).to_owned(),
        ];
        match read_engine_log(engine_log_path) {
            EngineLog::Bytes(bytes) => log_parts.push(String::from_utf8_lossy(&bytes).into_owned()),
            EngineLog::Missing => {}
            EngineLog::TooLarge => {
                log_parts.push("Compiler log exceeded the configured limit.".into())
            }
            EngineLog::Failed => {}
        }
        let (log, _) = self.safe_compile_log(control, &log_parts);
        if control.cancellation_token.is_cancelled() || error.kind == ProcessErrorKind::Cancelled {
            return cancelled_result(control.identity.clone(), &log);
        }
        failure_result(
            control.identity.clone(),
            &log,
            parse_diagnostics(&log, snapshot, &control.request.entry_path),
        )
    }

    fn safe_compile_log(&self, control: &RunControl, parts: &[String]) -> (String, bool) {
        let mut combined = String::new();
        for part in parts {
            if !part.is_empty() {
                if !combined.is_empty() {
                    combined.push('\n');
                }
                combined.push_str(part);
            }
        }
        let mut clean = strip_terminal_controls(&combined);
        let mut redactions = vec![
            (control.identity.run_id.as_str().to_owned(), "<run>"),
            (
                self.config.temporary_root.to_string_lossy().into_owned(),
                "<temp>",
            ),
        ];
        if let Some(directory) = lock_recover(&control.run_directory).as_ref() {
            redactions.push((directory.root.to_string_lossy().into_owned(), "<compile>"));
        }
        if let Some(root) = lock_recover(&control.workspace_root_for_redaction).as_ref() {
            redactions.push((root.to_string_lossy().into_owned(), "<workspace>"));
        }
        match &control.profile {
            ResolvedProfile::Managed {
                executable,
                cache_directory,
                ..
            } => {
                redactions.push((executable.to_string_lossy().into_owned(), "<engine>"));
                redactions.push((cache_directory.to_string_lossy().into_owned(), "<cache>"));
            }
            ResolvedProfile::System { executable, .. } => {
                redactions.push((executable.to_string_lossy().into_owned(), "<engine>"))
            }
        }
        for (path, replacement) in redactions {
            if path.is_empty() {
                continue;
            }
            clean = replace_case_insensitive(&clean, &path, replacement);
            let forward = path.replace('\\', "/");
            if forward != path {
                clean = replace_case_insensitive(&clean, &forward, replacement);
            }
            let backward = path.replace('/', "\\");
            if backward != path {
                clean = replace_case_insensitive(&clean, &backward, replacement);
            }
        }
        truncate_log_tail(&clean, MAX_LOG_CHARACTERS)
    }

    fn drain_process_error(&self, control: &RunControl) -> Option<RunnerFailure> {
        loop {
            let mut guard = lock_recover(&control.pending_process_error);
            let error = guard.as_mut()?;
            match error.cleanup {
                CleanupProof::NotRequired | CleanupProof::JobDrained => {
                    return guard.take().map(RunnerFailure::from_proven_error)
                }
                CleanupProof::Failed => {
                    if !error.has_pending_cleanup() {
                        control.phase.store(PHASE_UNPROVEN, Ordering::Release);
                        return None;
                    }
                    match error.retry_cleanup(CLEANUP_RETRY) {
                        Ok(CleanupProof::NotRequired | CleanupProof::JobDrained) => {
                            return guard.take().map(RunnerFailure::from_proven_error)
                        }
                        Ok(CleanupProof::Failed) | Err(_) => {}
                    }
                }
            }
            drop(guard);
            thread::sleep(CLEANUP_RETRY_PAUSE);
        }
    }

    fn allow_directory_cleanup(&self, control: &RunControl) {
        if let Some(directory) = lock_recover(&control.run_directory).as_mut() {
            directory.allow_cleanup = true;
        }
    }

    fn finish_result(&self, control: &Arc<RunControl>, mut result: CompileResult) -> bool {
        if control.engine_state.load(Ordering::Acquire) == ENGINE_MAY_BE_RUNNING {
            control.phase.store(PHASE_UNPROVEN, Ordering::Release);
            return false;
        }
        control.phase.store(PHASE_DRAINING, Ordering::Release);
        if !self.remove_run_directory_until_proven(control) {
            control.phase.store(PHASE_UNPROVEN, Ordering::Release);
            return false;
        }
        if control.cancellation_token.is_cancelled() {
            let log = match &result {
                CompileResult::Success { log, .. }
                | CompileResult::Failure { log, .. }
                | CompileResult::Cancelled { log, .. } => log.clone(),
            };
            result = cancelled_result(control.identity.clone(), &log);
        }
        if !matches!(&result, CompileResult::Success { .. }) {
            lock_recover(&control.synctex_result).take();
        }
        let ticket = lock_recover(&control.ticket).take();
        if let Some(ticket) = ticket {
            let has_fallback_drain = lock_recover(&control.drain_handle).is_some();
            if !has_fallback_drain {
                if control.engine_state.load(Ordering::Acquire) != ENGINE_NEVER_STARTED {
                    *lock_recover(&control.ticket) = Some(ticket);
                    control.phase.store(PHASE_UNPROVEN, Ordering::Release);
                    return false;
                }
                let mut ticket = ticket;
                if ticket.finish_drain_with(|| Ok(())).is_err() {
                    *lock_recover(&control.ticket) = Some(ticket);
                    control.phase.store(PHASE_UNPROVEN, Ordering::Release);
                    return false;
                }
                result = failure_result(
                    control.identity.clone(),
                    "Compile cleanup handle was unavailable; no engine was started.",
                    Vec::new(),
                );
            } else {
                let fallback = failure_result(
                    control.identity.clone(),
                    "Compile result did not match the current saved workspace snapshot.",
                    Vec::new(),
                );
                match ticket.settle_with_drain(result, || Ok(())) {
                    Ok(validated) => result = validated,
                    Err(_) => {
                        if !self.finish_fallback_drain_until_proven(control) {
                            control.phase.store(PHASE_UNPROVEN, Ordering::Release);
                            return false;
                        }
                        result = fallback;
                    }
                }
            }
        } else if lock_recover(&control.drain_handle).is_some() {
            // A worker unwind can consume the ticket while its Drop only marks
            // the task handle abandoned. Always use the independently retained
            // drain handle before publishing a recovered result.
            if !self.finish_fallback_drain_until_proven(control) {
                control.phase.store(PHASE_UNPROVEN, Ordering::Release);
                return false;
            }
            result = failure_result(
                control.identity.clone(),
                "Compile task cleanup was recovered after an internal failure.",
                Vec::new(),
            );
        }
        self.publish_or_retire(control, result)
    }

    fn remove_run_directory_until_proven(&self, control: &RunControl) -> bool {
        loop {
            let mut guard = lock_recover(&control.run_directory);
            let Some(directory) = guard.as_mut() else {
                return true;
            };
            if !directory.allow_cleanup {
                return false;
            }
            match directory.remove_owned() {
                Ok(()) => {
                    guard.take();
                    return true;
                }
                Err(_) => {
                    drop(guard);
                    thread::sleep(CLEANUP_RETRY_PAUSE);
                }
            }
        }
    }

    fn finish_fallback_drain_until_proven(&self, control: &RunControl) -> bool {
        loop {
            let mut guard = lock_recover(&control.drain_handle);
            let Some(handle) = guard.as_ref() else {
                return false;
            };
            match handle.finish_drain_with(|| Ok(())) {
                Ok(()) => {
                    guard.take();
                    return true;
                }
                Err(_) => {
                    drop(guard);
                    thread::sleep(CLEANUP_RETRY_PAUSE);
                }
            }
        }
    }

    fn publish_or_retire(&self, control: &Arc<RunControl>, mut result: CompileResult) -> bool {
        let mut state = self.lock_state();
        let is_latest = state
            .latest
            .get(&control.scope)
            .is_some_and(|run_id| run_id == &control.identity.run_id);
        let authorized = !state.shutdown
            && !state.revoked_owners.contains(&control.owner)
            && !state
                .closed_workspaces
                .contains(&(control.owner.clone(), control.identity.workspace_id.clone()));
        if control.publish_allowed.load(Ordering::Acquire) && is_latest && authorized {
            if control.cancellation_token.is_cancelled() {
                let log = match &result {
                    CompileResult::Success { log, .. }
                    | CompileResult::Failure { log, .. }
                    | CompileResult::Cancelled { log, .. } => log.clone(),
                };
                result = cancelled_result(control.identity.clone(), &log);
                lock_recover(&control.synctex_result).take();
            }
            *lock_recover(&control.result) = Some(result);
            control.phase.store(PHASE_READY, Ordering::Release);
            self.changed.notify_all();
            return true;
        }
        lock_recover(&control.synctex_result).take();
        control.phase.store(PHASE_CONSUMED, Ordering::Release);
        state.runs.remove(&control.identity.run_id);
        if is_latest {
            state.latest.remove(&control.scope);
        }
        self.changed.notify_all();
        true
    }

    fn take_result_with_artifacts(
        &self,
        owner: &OwnerId,
        identity: &CompileIdentity,
    ) -> Result<Option<CompileDelivery>, CompileServiceError> {
        let mut state = self.lock_state();
        let control = state
            .runs
            .get(&identity.run_id)
            .filter(|control| &control.owner == owner && &control.identity == identity)
            .cloned()
            .ok_or(CompileServiceError::UnknownRun)?;
        if control.phase.load(Ordering::Acquire) != PHASE_READY {
            return Ok(None);
        }
        let result = lock_recover(&control.result).take();
        let synctex = lock_recover(&control.synctex_result).take();
        control.phase.store(PHASE_CONSUMED, Ordering::Release);
        state.runs.remove(&identity.run_id);
        if state
            .latest
            .get(&control.scope)
            .is_some_and(|run_id| run_id == &identity.run_id)
        {
            state.latest.remove(&control.scope);
        }
        self.changed.notify_all();
        Ok(result.map(|result| CompileDelivery {
            synctex: if matches!(&result, CompileResult::Success { .. }) {
                synctex
            } else {
                None
            },
            result,
        }))
    }

    fn revoke_owner(&self, owner: &OwnerId) -> usize {
        let mut state = self.lock_state();
        state.revoked_owners.insert(owner.clone());
        state.latest.retain(|scope, _| &scope.owner != owner);
        let mut removed_ready = Vec::new();
        let mut affected = 0;
        for (run_id, control) in &state.runs {
            if &control.owner != owner {
                continue;
            }
            affected += 1;
            control.suppress_and_cancel(CANCEL_OWNER_REVOKED);
            if control.phase.load(Ordering::Acquire) == PHASE_READY {
                control.phase.store(PHASE_CONSUMED, Ordering::Release);
                removed_ready.push(run_id.clone());
            }
        }
        for run_id in removed_ready {
            state.runs.remove(&run_id);
        }
        self.changed.notify_all();
        affected
    }

    fn close_workspace(&self, owner: &OwnerId, workspace_id: &WorkspaceId) -> usize {
        let mut state = self.lock_state();
        state
            .closed_workspaces
            .insert((owner.clone(), workspace_id.clone()));
        state
            .latest
            .retain(|scope, _| &scope.owner != owner || &scope.workspace_id != workspace_id);
        let mut removed_ready = Vec::new();
        let mut affected = 0;
        for (run_id, control) in &state.runs {
            if &control.owner != owner || &control.identity.workspace_id != workspace_id {
                continue;
            }
            affected += 1;
            control.suppress_and_cancel(CANCEL_WORKSPACE_CLOSED);
            if control.phase.load(Ordering::Acquire) == PHASE_READY {
                control.phase.store(PHASE_CONSUMED, Ordering::Release);
                removed_ready.push(run_id.clone());
            }
        }
        for run_id in removed_ready {
            state.runs.remove(&run_id);
        }
        self.changed.notify_all();
        affected
    }

    fn shutdown(&self) {
        let mut state = self.lock_state();
        if state.shutdown {
            return;
        }
        state.shutdown = true;
        state.latest.clear();
        let mut removed_ready = Vec::new();
        for (run_id, control) in &state.runs {
            control.suppress_and_cancel(CANCEL_SERVICE_DROPPED);
            if control.phase.load(Ordering::Acquire) == PHASE_READY {
                control.phase.store(PHASE_CONSUMED, Ordering::Release);
                removed_ready.push(run_id.clone());
            }
        }
        for run_id in removed_ready {
            state.runs.remove(&run_id);
        }
        self.changed.notify_all();
    }

    fn recover_after_panic(&self, control: &Arc<RunControl>) -> bool {
        loop {
            match control.engine_state.load(Ordering::Acquire) {
                ENGINE_NEVER_STARTED | ENGINE_DRAINED => {
                    if control.engine_state.load(Ordering::Acquire) == ENGINE_DRAINED {
                        self.allow_directory_cleanup(control);
                    }
                    return self.finish_result(
                        control,
                        failure_result(
                            control.identity.clone(),
                            "Compile worker recovered from an internal failure.",
                            Vec::new(),
                        ),
                    );
                }
                ENGINE_MAY_BE_RUNNING => {
                    if lock_recover(&control.pending_process_error).is_some() {
                        if let Some(error) = self.drain_process_error(control) {
                            control
                                .engine_state
                                .store(ENGINE_DRAINED, Ordering::Release);
                            self.allow_directory_cleanup(control);
                            return self.finish_result(
                                control,
                                failure_result(
                                    control.identity.clone(),
                                    process_error_text(error.kind, error.exit_code),
                                    Vec::new(),
                                ),
                            );
                        }
                    }
                    control.phase.store(PHASE_UNPROVEN, Ordering::Release);
                    thread::sleep(CLEANUP_RETRY_PAUSE);
                }
                _ => {
                    control.phase.store(PHASE_UNPROVEN, Ordering::Release);
                    thread::sleep(CLEANUP_RETRY_PAUSE);
                }
            }
        }
    }
}

struct RunnerFailure {
    kind: ProcessErrorKind,
    exit_code: Option<u32>,
    logs: ProcessLogs,
}
impl RunnerFailure {
    fn from_proven_error(error: ProcessError) -> Self {
        Self {
            kind: error.cause.unwrap_or(error.kind),
            exit_code: error.exit_code,
            logs: error.logs,
        }
    }
}

fn is_active_phase(phase: u8) -> bool {
    matches!(
        phase,
        PHASE_PREPARING | PHASE_QUEUED | PHASE_RUNNING | PHASE_DRAINING | PHASE_UNPROVEN
    )
}
fn lock_recover<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

#[cfg(test)]
impl CompileService {
    fn with_executor_for_test(
        filesystem: Arc<FilesystemService>,
        config: TrustedCompileConfig,
        executor: Arc<dyn ProcessExecutor>,
    ) -> Result<Self, CompileServiceError> {
        Self::new_with_executor(filesystem, config, executor)
    }
}

#[cfg(test)]
#[path = "../../tests/unit/compile_service.rs"]
mod tests;
