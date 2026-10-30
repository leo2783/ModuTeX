// SPDX-License-Identifier: Apache-2.0
//! Native LuaLaTeX Draft execution, shipout extraction, and warm paragraph
//! worker. The host selects every executable and argument; renderer DTOs carry
//! only workspace-relative document data.

use std::{
    collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque},
    env,
    ffi::OsString,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc::{self, Receiver, SyncSender, TrySendError},
        Arc, Condvar, Mutex, MutexGuard, PoisonError,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use crate::{
    platform::process_tree::{
        cancellation_pair, CancellationHandle, CancellationToken, CleanupProof, ProcessError,
        ProcessErrorKind, ProcessLogs, ProcessOutput, ProcessSpec,
    },
    schemas::draft::{
        DraftBibliographyEntry, DraftCompileRequest, DraftDocumentResult, DraftError,
        DraftErrorCode, DraftExtractionRecord, DraftGeometry, DraftImageReference, DraftMode,
        DraftPageRecord, DraftParagraphRequest, DraftReference, DraftSavePdfRequest,
        DraftSourceRange, DraftStatus,
    },
    schemas::protocol::OwnerId,
    schemas::protocol::{
        validate_pdf, CompileIdentity, CompileRequest, CompileResult, Diagnostic, DocumentId,
        DocumentVersion, Engine, FileRef, Revision, RunId, Severity, WorkspaceId, WriteReceipt,
        WriteRequest, MAX_LOG_CHARACTERS, MAX_PDF_BYTES,
    },
    services::draft_warm::DraftWarmEngine,
    services::filesystem::{
        CompileInputLimits, CompileInputSnapshot, CompileLeaseTicket, CompileSourceOverlay,
        FilesystemError, FilesystemService, SubSystemCanceller,
    },
    shared::relative_path::RelativePath,
};

const DRAFT_TIMEOUT: Duration = Duration::from_secs(300);
const CLEANUP_WAIT: Duration = Duration::from_secs(30);
const PROCESS_LOG_LIMIT: usize = 2 * 1024 * 1024;
const MAX_PASSES: u8 = 5;
const MAX_AUX_BYTES: usize = 4 * 1024 * 1024;
const MAX_BBL_BYTES: usize = 4 * 1024 * 1024;
const MAX_FLS_BYTES: usize = 8 * 1024 * 1024;
const MAX_EXTRACTION_BYTES: usize = 16 * 1024 * 1024;
const MAX_EXTRACTED_RECORDS: usize = 20_000;
const MAX_EXTRACTED_PAGES: usize = 1_000;
const MAX_EXPORTED_ITEMS: usize = 4_096;
const MAX_CACHED_PDFS: usize = 4;
const MAX_CACHED_PDF_BYTES: usize = 64 * 1024 * 1024;
const MAX_OVERLAY_BYTES: usize = 32 * 1024 * 1024;
const LUA_SHIPOUT_RESOURCE: &str = include_str!("../resources/draft/modutex-draft.lua");

static NEXT_RUN_NONCE: AtomicU64 = AtomicU64::new(1);

#[derive(Clone)]
pub(crate) struct DraftDelivery {
    pub(crate) result: DraftDocumentResult,
    pub(crate) pdf: Option<Vec<u8>>,
    generation: crate::state::workspace_leases::SessionGeneration,
}

#[derive(Clone)]
struct Toolchain {
    lualatex: PathBuf,
    biber: Option<PathBuf>,
    bibtex: Option<PathBuf>,
}

impl Toolchain {
    fn discover(resource_dir: &Path) -> Option<Self> {
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

fn find_fixed_executable(name: &str, preferred_dirs: &[PathBuf]) -> Option<PathBuf> {
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

fn canonical_executable(path: &Path) -> Option<PathBuf> {
    if !path.is_absolute() {
        return None;
    }
    let canonical = fs::canonicalize(path).ok()?;
    fs::metadata(&canonical)
        .ok()
        .filter(|metadata| metadata.is_file())
        .map(|_| canonical)
}

#[derive(Clone, Eq, Hash, PartialEq)]
struct WorkspaceKey {
    owner: OwnerId,
    workspace_id: WorkspaceId,
}

struct ActiveRun {
    id: u64,
    cancellation: CancellationHandle,
    preempted: Arc<AtomicBool>,
}

struct ParagraphDaemon {
    generation: crate::state::workspace_leases::SessionGeneration,
    sender: SyncSender<DaemonMessage>,
    worker: Option<JoinHandle<()>>,
}

struct CachedPdf {
    owner: OwnerId,
    identity: CompileIdentity,
    generation: crate::state::workspace_leases::SessionGeneration,
    bytes: Vec<u8>,
}

struct RuntimeState {
    next_id: u64,
    active: HashMap<WorkspaceKey, ActiveRun>,
    daemons: HashMap<WorkspaceKey, ParagraphDaemon>,
    cached_pdfs: HashMap<RunId, CachedPdf>,
    cached_order: VecDeque<RunId>,
    cached_bytes: usize,
}

struct Inner {
    filesystem: Arc<FilesystemService>,
    toolchain: Option<Toolchain>,
    scratch_root: PathBuf,
    state: Mutex<RuntimeState>,
    changed: Condvar,
}

#[derive(Clone)]
pub(crate) struct DraftService {
    inner: Arc<Inner>,
}

struct ActiveRunGuard {
    inner: Arc<Inner>,
    key: WorkspaceKey,
    id: u64,
}

impl Drop for ActiveRunGuard {
    fn drop(&mut self) {
        let mut state = lock_state(&self.inner);
        if state
            .active
            .get(&self.key)
            .is_some_and(|active| active.id == self.id)
        {
            state.active.remove(&self.key);
        }
        self.inner.changed.notify_all();
    }
}

struct OperationContext {
    _guard: ActiveRunGuard,
    run_id: RunId,
    generation: crate::state::workspace_leases::SessionGeneration,
    cancellation: CancellationHandle,
    token: CancellationToken,
    preempted: Arc<AtomicBool>,
}

enum DaemonMessage {
    Typeset {
        owner: OwnerId,
        request: Box<DraftParagraphRequest>,
        context: OperationContext,
        reply: SyncSender<Result<DraftDelivery, DraftError>>,
    },
    Stop(SyncSender<Result<(), DraftError>>),
}

#[derive(Clone)]
struct CompileSource {
    workspace_id: WorkspaceId,
    entry_path: RelativePath,
    document_id: DocumentId,
    document_version: DocumentVersion,
    saved_revision: Revision,
}

impl From<DraftCompileRequest> for CompileSource {
    fn from(request: DraftCompileRequest) -> Self {
        Self {
            workspace_id: request.workspace_id,
            entry_path: request.entry_path,
            document_id: request.document_id,
            document_version: request.document_version,
            saved_revision: request.saved_revision,
        }
    }
}

impl From<&DraftParagraphRequest> for CompileSource {
    fn from(request: &DraftParagraphRequest) -> Self {
        Self {
            workspace_id: request.workspace_id.clone(),
            entry_path: request.entry_path.clone(),
            document_id: request.document_id.clone(),
            document_version: request.document_version,
            saved_revision: request.saved_revision.clone(),
        }
    }
}

struct TempTree {
    path: PathBuf,
    removed: bool,
}

impl TempTree {
    fn create(root: &Path, run_id: &RunId) -> Result<Self, DraftError> {
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

    fn cleanup(&mut self) -> Result<(), DraftError> {
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

struct ToolFailure {
    kind: ProcessErrorKind,
    exit_code: Option<u32>,
    log: String,
    cleanup_proven: bool,
}

struct CompileFailure {
    message: String,
    kind: Option<ProcessErrorKind>,
    log: String,
    cleanup_proven: bool,
    passes: u8,
    bibliography_passes: u8,
}

struct CompileArtifact {
    pdf: Vec<u8>,
    geometry: DraftGeometry,
    pages: Vec<DraftPageRecord>,
    references: Vec<DraftReference>,
    bibliography: Vec<DraftBibliographyEntry>,
    images: Vec<DraftImageReference>,
    unsupported: Vec<String>,
    log: String,
    passes: u8,
    bibliography_passes: u8,
}

impl DraftService {
    pub(crate) fn new(
        filesystem: Arc<FilesystemService>,
        resource_dir: &Path,
        cache_dir: &Path,
    ) -> Result<Self, DraftError> {
        let requested_root = cache_dir.join("modutex-draft");
        fs::create_dir_all(&requested_root).map_err(|_| {
            DraftError::new(
                DraftErrorCode::IoFailed,
                "Could not create the private Draft cache directory.",
            )
        })?;
        let scratch_root = fs::canonicalize(&requested_root).map_err(|_| {
            DraftError::new(
                DraftErrorCode::IoFailed,
                "Could not verify the private Draft cache directory.",
            )
        })?;
        if !scratch_root.is_absolute() {
            return Err(DraftError::new(
                DraftErrorCode::IoFailed,
                "The private Draft cache directory is not absolute.",
            ));
        }
        Ok(Self {
            inner: Arc::new(Inner {
                filesystem,
                toolchain: Toolchain::discover(resource_dir),
                scratch_root,
                state: Mutex::new(RuntimeState {
                    next_id: 1,
                    active: HashMap::new(),
                    daemons: HashMap::new(),
                    cached_pdfs: HashMap::new(),
                    cached_order: VecDeque::new(),
                    cached_bytes: 0,
                }),
                changed: Condvar::new(),
            }),
        })
    }

    pub(crate) fn compile(
        &self,
        owner: &OwnerId,
        request: DraftCompileRequest,
    ) -> Result<DraftDelivery, DraftError> {
        validate_entry_path(&request.entry_path)?;
        self.require_engine()?;
        let generation = self
            .inner
            .filesystem
            .workspace_generation(owner, &request.workspace_id)
            .map_err(map_filesystem_error)?;
        let _ = self.stop_workspace(owner, &request.workspace_id, true)?;
        let run_id = new_run_id()?;
        let key = workspace_key(owner, &request.workspace_id);
        let context = begin_operation(&self.inner, key, generation, run_id)?;
        self.execute_document(
            owner,
            CompileSource::from(request),
            None,
            DraftMode::Full,
            context,
        )
    }

    pub(crate) fn typeset_paragraph(
        &self,
        owner: &OwnerId,
        request: DraftParagraphRequest,
    ) -> Result<DraftDelivery, DraftError> {
        validate_entry_path(&request.entry_path)?;
        self.require_engine()?;
        if request.source.len() > 1024 * 1024 || request.range.start_byte > request.range.end_byte {
            return Err(DraftError::new(
                DraftErrorCode::InvalidRequest,
                "The paragraph range or source is invalid.",
            ));
        }
        let generation = self
            .inner
            .filesystem
            .workspace_generation(owner, &request.workspace_id)
            .map_err(map_filesystem_error)?;
        let run_id = new_run_id()?;
        let key = workspace_key(owner, &request.workspace_id);
        let sender = ensure_paragraph_daemon(&self.inner, key.clone(), generation)?;
        let context = begin_operation(&self.inner, key, generation, run_id)?;
        let cancel = context.cancellation.clone();
        let (reply, receiver) = mpsc::sync_channel(1);
        let message = DaemonMessage::Typeset {
            owner: owner.clone(),
            request: Box::new(request),
            context,
            reply,
        };
        match sender.try_send(message) {
            Ok(()) => {}
            Err(TrySendError::Full(_)) => {
                return Err(DraftError::new(
                    DraftErrorCode::WorkspaceBusy,
                    "The Draft paragraph daemon already has a pending request.",
                ));
            }
            Err(TrySendError::Disconnected(_)) => {
                return Err(DraftError::new(
                    DraftErrorCode::ResourceExhausted,
                    "The Draft paragraph daemon stopped before accepting the request.",
                ));
            }
        }
        match receiver.recv_timeout(DRAFT_TIMEOUT + CLEANUP_WAIT) {
            Ok(result) => result,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                cancel.cancel();
                Err(DraftError::new(
                    DraftErrorCode::TimedOut,
                    "Paragraph typesetting exceeded its bounded response deadline; cleanup remains active.",
                ))
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => Err(DraftError::new(
                DraftErrorCode::Internal,
                "The Draft paragraph daemon ended without a result.",
            )),
        }
    }

    fn require_engine(&self) -> Result<&Toolchain, DraftError> {
        self.inner.toolchain.as_ref().ok_or_else(|| {
            DraftError::new(
                DraftErrorCode::EngineUnavailable,
                "LuaLaTeX is unavailable. Install a TeX distribution that includes LuaLaTeX, or add its trusted executable directory to the desktop host PATH, then restart the application.",
            )
        })
    }

    fn execute_document(
        &self,
        owner: &OwnerId,
        source: CompileSource,
        paragraph: Option<(DraftSourceRange, String)>,
        mode: DraftMode,
        context: OperationContext,
    ) -> Result<DraftDelivery, DraftError> {
        let started = Instant::now();
        let identity = CompileIdentity {
            run_id: context.run_id.clone(),
            workspace_id: source.workspace_id.clone(),
            entry_path: source.entry_path.clone(),
            document_id: source.document_id.clone(),
            document_version: source.document_version,
            saved_revision: source.saved_revision.clone(),
        };

        if context.token.is_cancelled() {
            return Ok(DraftDelivery {
                result: result_without_pdf(
                    identity,
                    mode,
                    if context.preempted.load(Ordering::Acquire) {
                        DraftStatus::Preempted
                    } else {
                        DraftStatus::Cancelled
                    },
                    started,
                    0,
                    0,
                    String::new(),
                    None,
                ),
                pdf: None,
                generation: context.generation,
            });
        }

        let overlay_bytes = match paragraph.as_ref() {
            Some((range, replacement)) => {
                Some(self.paragraph_overlay(owner, &source, *range, replacement)?)
            }
            None => None,
        };
        let mut ticket = self.prepare_ticket(owner, &source, &context, overlay_bytes.as_deref())?;
        let mut snapshot = match self.inner.filesystem.capture_compile_snapshot(
            &ticket,
            CompileInputLimits {
                max_depth: 16,
                max_entries: 4096,
                max_file_bytes: 32 * 1024 * 1024,
                max_total_bytes: 64 * 1024 * 1024,
            },
        ) {
            Ok(snapshot) => snapshot,
            Err(error) => {
                ticket.finish_drain();
                return Err(map_filesystem_error(error));
            }
        };
        let baseline_snapshot = snapshot.clone();
        if let Some((range, replacement)) = paragraph {
            let entry = match snapshot
                .files
                .iter_mut()
                .find(|file| file.path == source.entry_path)
            {
                Some(entry) => entry,
                None => {
                    ticket.finish_drain();
                    return Err(DraftError::new(
                        DraftErrorCode::WorkspaceDenied,
                        "The Draft entry file is not present in the validated input snapshot.",
                    ));
                }
            };
            let updated = match replace_source_range(&entry.bytes, range, &replacement) {
                Ok(bytes) => bytes,
                Err(error) => {
                    ticket.finish_drain();
                    return Err(error);
                }
            };
            if overlay_bytes.as_deref() != Some(updated.as_slice()) {
                ticket.finish_drain();
                return Err(DraftError::new(
                    DraftErrorCode::StaleWorkspace,
                    "The Draft entry changed while its paragraph overlay was being admitted.",
                ));
            }
            entry.bytes = updated;
        }

        let artifact = compile_staged(
            &self.inner,
            &context.run_id,
            &source.entry_path,
            &snapshot,
            &context.token,
            started,
        );

        let (result, pdf, settled) = match artifact {
            Ok(artifact) if context.token.is_cancelled() => {
                let status = if context.preempted.load(Ordering::Acquire) {
                    DraftStatus::Preempted
                } else {
                    DraftStatus::Cancelled
                };
                let result = result_without_pdf(
                    identity.clone(),
                    mode,
                    status,
                    started,
                    artifact.passes,
                    artifact.bibliography_passes,
                    artifact.log.clone(),
                    None,
                );
                (
                    result,
                    None,
                    CompileResult::Cancelled {
                        identity: identity.clone(),
                        log: artifact.log,
                        diagnostics: Vec::new(),
                    },
                )
            }
            Ok(artifact) => {
                let mut unsupported: BTreeSet<String> =
                    artifact.unsupported.iter().cloned().collect();
                for page in &artifact.pages {
                    unsupported.extend(page.unsupported_content_reasons.iter().cloned());
                }
                let fallback = artifact.pages.is_empty() || !unsupported.is_empty();
                if artifact.pages.is_empty() {
                    unsupported.insert("shipout-records-unavailable".to_owned());
                }
                let record_count = artifact
                    .pages
                    .iter()
                    .map(|page| page.renderable_records.len() as u64)
                    .sum();
                let diagnostics = diagnostics_from_log(&artifact.log);
                let result = DraftDocumentResult {
                    identity: identity.clone(),
                    mode,
                    status: DraftStatus::Success,
                    elapsed_ms: elapsed_ms(started),
                    page_count: artifact.pages.len().min(u32::MAX as usize) as u32,
                    renderable_record_count: record_count,
                    pass_count: artifact.passes,
                    bibliography_pass_count: artifact.bibliography_passes,
                    geometry: artifact.geometry,
                    pages: artifact.pages,
                    references: artifact.references,
                    bibliography: artifact.bibliography,
                    images: artifact.images,
                    unsupported_content_reasons: unsupported.into_iter().collect(),
                    pdf_fallback: fallback,
                    diagnostics: diagnostics.clone(),
                    log: artifact.log.clone(),
                    failure: None,
                    pdf_token: None,
                };
                (
                    result,
                    Some(artifact.pdf.clone()),
                    CompileResult::Success {
                        identity: identity.clone(),
                        pdf: artifact.pdf,
                        log: artifact.log,
                        diagnostics,
                    },
                )
            }
            Err(failure) => {
                if !failure.cleanup_proven {
                    let _ = ticket.finish_drain_with(|| {
                        Err("native process-tree cleanup was not proven".to_owned())
                    });
                    return Err(DraftError::new(
                        DraftErrorCode::CleanupUnproven,
                        "Draft process-tree cleanup could not be proven; the workspace lease remains held.",
                    ));
                }
                let cancelled = context.token.is_cancelled()
                    || failure.kind == Some(ProcessErrorKind::Cancelled);
                let status = if cancelled && context.preempted.load(Ordering::Acquire) {
                    DraftStatus::Preempted
                } else if cancelled {
                    DraftStatus::Cancelled
                } else {
                    DraftStatus::Failure
                };
                let message = if cancelled {
                    "Draft compilation was cancelled."
                } else {
                    &failure.message
                };
                let diagnostics = diagnostics_from_log(&failure.log);
                let diagnostics = if diagnostics.is_empty() && !cancelled {
                    vec![Diagnostic {
                        severity: Severity::Error,
                        message: message.to_owned(),
                        path: None,
                        line: None,
                        column: None,
                    }]
                } else {
                    diagnostics
                };
                let result = result_without_pdf(
                    identity.clone(),
                    mode,
                    status,
                    started,
                    failure.passes,
                    failure.bibliography_passes,
                    failure.log.clone(),
                    Some(message.to_owned()),
                )
                .with_diagnostics(diagnostics.clone());
                let settled = if cancelled {
                    CompileResult::Cancelled {
                        identity: identity.clone(),
                        log: failure.log,
                        diagnostics,
                    }
                } else {
                    CompileResult::Failure {
                        identity: identity.clone(),
                        log: failure.log,
                        diagnostics,
                    }
                };
                (result, None, settled)
            }
        };

        let _validated = ticket
            .settle_with_snapshot(settled, &baseline_snapshot)
            .map_err(map_filesystem_error)?;
        Ok(DraftDelivery {
            result,
            pdf,
            generation: context.generation,
        })
    }

    fn execute_paragraph(
        &self,
        owner: &OwnerId,
        request: DraftParagraphRequest,
        context: OperationContext,
        warm_engine: &mut Option<DraftWarmEngine>,
    ) -> Result<DraftDelivery, DraftError> {
        let started = Instant::now();
        let source = CompileSource::from(&request);
        let identity = CompileIdentity {
            run_id: context.run_id.clone(),
            workspace_id: source.workspace_id.clone(),
            entry_path: source.entry_path.clone(),
            document_id: source.document_id.clone(),
            document_version: source.document_version,
            saved_revision: source.saved_revision.clone(),
        };
        if context.token.is_cancelled() {
            return Ok(cancelled_paragraph_delivery(
                identity,
                started,
                context.generation,
                context.preempted.load(Ordering::Acquire),
                String::new(),
            ));
        }

        // A previous failed exchange is never reused. Retry drain before
        // admitting another request; its old ticket callback remains attached.
        if warm_engine
            .as_ref()
            .is_some_and(|engine| !engine.is_usable())
        {
            let (_, cleanup_token) = cancellation_pair();
            self.stop_warm_engine(warm_engine, None, &cleanup_token)?;
        }

        let overlay_bytes =
            self.paragraph_overlay(owner, &source, request.range, &request.source)?;
        let mut ticket = self.prepare_ticket(owner, &source, &context, Some(&overlay_bytes))?;
        let mut snapshot = match self.inner.filesystem.capture_compile_snapshot(
            &ticket,
            CompileInputLimits {
                max_depth: 16,
                max_entries: 4096,
                max_file_bytes: 32 * 1024 * 1024,
                max_total_bytes: 64 * 1024 * 1024,
            },
        ) {
            Ok(snapshot) => snapshot,
            Err(error) => {
                ticket.finish_drain();
                return Err(map_filesystem_error(error));
            }
        };
        let baseline_snapshot = snapshot.clone();
        let entry = match snapshot
            .files
            .iter_mut()
            .find(|file| file.path == source.entry_path)
        {
            Some(entry) => entry,
            None => {
                ticket
                    .settle_metadata_with_snapshot(&baseline_snapshot)
                    .map_err(map_filesystem_error)?;
                return Err(DraftError::new(
                    DraftErrorCode::WorkspaceDenied,
                    "The Draft entry file is not present in the validated input snapshot.",
                ));
            }
        };
        let overlay = match replace_source_range(&entry.bytes, request.range, &request.source) {
            Ok(bytes) => bytes,
            Err(error) => {
                ticket
                    .settle_metadata_with_snapshot(&baseline_snapshot)
                    .map_err(map_filesystem_error)?;
                return Err(error);
            }
        };
        if overlay != overlay_bytes {
            ticket
                .settle_metadata_with_snapshot(&baseline_snapshot)
                .map_err(map_filesystem_error)?;
            return Err(DraftError::new(
                DraftErrorCode::StaleWorkspace,
                "The Draft entry changed while its paragraph overlay was being admitted.",
            ));
        }
        entry.bytes = overlay;
        let entry_bytes = snapshot
            .files
            .iter()
            .find(|file| file.path == source.entry_path)
            .map(|file| file.bytes.as_slice())
            .ok_or_else(|| {
                DraftError::new(
                    DraftErrorCode::WorkspaceDenied,
                    "The Draft entry disappeared from its validated snapshot.",
                )
            })?;
        let Some(body) = DraftWarmEngine::safe_document_body(entry_bytes) else {
            self.stop_warm_engine(warm_engine, Some(&ticket), &context.token)?;
            return self.fallback_paragraph(owner, request, context, ticket, &baseline_snapshot);
        };

        if warm_engine
            .as_ref()
            .is_some_and(|engine| !engine.matches(&snapshot, &source.entry_path))
        {
            self.stop_warm_engine(warm_engine, Some(&ticket), &context.token)?;
        }
        if warm_engine.is_none() {
            let Some(toolchain) = self.inner.toolchain.as_ref() else {
                return self.fallback_paragraph(
                    owner,
                    request,
                    context,
                    ticket,
                    &baseline_snapshot,
                );
            };
            match DraftWarmEngine::start(
                &toolchain.lualatex,
                &self.inner.scratch_root,
                &context.run_id,
                &source.entry_path,
                &snapshot,
                &context.token,
                DRAFT_TIMEOUT,
            ) {
                Ok(engine) => *warm_engine = Some(engine),
                Err(mut failure) => {
                    let detail = sanitize_log(
                        &failure.detail,
                        &self.inner.scratch_root,
                        &toolchain.lualatex,
                    );
                    if let Some(engine) = failure.pending.take() {
                        *warm_engine = Some(*engine);
                        if let Err(mut cleanup_error) =
                            self.stop_warm_engine(warm_engine, Some(&ticket), &context.token)
                        {
                            cleanup_error
                                .message
                                .push_str("\nDraft warm startup also failed: ");
                            cleanup_error.message.extend(detail.chars().take(4096));
                            return Err(cleanup_error);
                        }
                        if context.token.is_cancelled() {
                            ticket
                                .settle_metadata_with_snapshot(&baseline_snapshot)
                                .map_err(map_filesystem_error)?;
                            return retain_warm_start_failure(
                                Ok(cancelled_paragraph_delivery(
                                    identity,
                                    started,
                                    context.generation,
                                    context.preempted.load(Ordering::Acquire),
                                    String::new(),
                                )),
                                &detail,
                            );
                        }
                        return retain_warm_start_failure(
                            self.fallback_paragraph(
                                owner,
                                request,
                                context,
                                ticket,
                                &baseline_snapshot,
                            ),
                            &detail,
                        );
                    }
                    if context.token.is_cancelled() {
                        ticket
                            .settle_metadata_with_snapshot(&baseline_snapshot)
                            .map_err(map_filesystem_error)?;
                        return retain_warm_start_failure(
                            Ok(cancelled_paragraph_delivery(
                                identity,
                                started,
                                context.generation,
                                context.preempted.load(Ordering::Acquire),
                                String::new(),
                            )),
                            &detail,
                        );
                    }
                    return retain_warm_start_failure(
                        self.fallback_paragraph(
                            owner,
                            request,
                            context,
                            ticket,
                            &baseline_snapshot,
                        ),
                        &detail,
                    );
                }
            }
        }

        let frame = {
            let engine = warm_engine.as_mut().expect("warm engine was started");
            engine.typeset(
                &context.run_id,
                &source.entry_path,
                &snapshot,
                &body,
                &context.token,
                DRAFT_TIMEOUT,
            )
        };
        let frame = match frame {
            Ok(frame) => frame,
            Err(_) => {
                let cancelled = context.token.is_cancelled();
                self.stop_warm_engine(warm_engine, Some(&ticket), &context.token)?;
                if cancelled {
                    ticket
                        .settle_metadata_with_snapshot(&baseline_snapshot)
                        .map_err(map_filesystem_error)?;
                    return Ok(cancelled_paragraph_delivery(
                        identity,
                        started,
                        context.generation,
                        context.preempted.load(Ordering::Acquire),
                        String::new(),
                    ));
                }
                return self.fallback_paragraph(
                    owner,
                    request,
                    context,
                    ticket,
                    &baseline_snapshot,
                );
            }
        };

        let complete = frame.extraction.pages.len() == 1
            && valid_geometry(&frame.extraction.geometry)
            && frame.extraction.pages.iter().all(valid_page)
            && frame
                .extraction
                .pages
                .iter()
                .all(|page| page.unsupported_content_reasons.is_empty())
            && frame
                .extraction
                .pages
                .iter()
                .map(|page| page.renderable_records.len())
                .sum::<usize>()
                <= MAX_EXTRACTED_RECORDS;
        if !complete {
            self.stop_warm_engine(warm_engine, Some(&ticket), &context.token)?;
            if context.token.is_cancelled() {
                ticket
                    .settle_metadata_with_snapshot(&baseline_snapshot)
                    .map_err(map_filesystem_error)?;
                return Ok(cancelled_paragraph_delivery(
                    identity,
                    started,
                    context.generation,
                    context.preempted.load(Ordering::Acquire),
                    String::new(),
                ));
            }
            return self.fallback_paragraph(owner, request, context, ticket, &baseline_snapshot);
        }
        if context.token.is_cancelled() {
            ticket
                .settle_metadata_with_snapshot(&baseline_snapshot)
                .map_err(map_filesystem_error)?;
            return Ok(cancelled_paragraph_delivery(
                identity,
                started,
                context.generation,
                context.preempted.load(Ordering::Acquire),
                String::new(),
            ));
        }

        let engine = warm_engine.as_ref().expect("warm engine remains active");
        let toolchain = self
            .inner
            .toolchain
            .as_ref()
            .expect("warm toolchain exists");
        let log = sanitize_log(&frame.log, engine.root(), &toolchain.lualatex);
        let diagnostics = diagnostics_from_log(&log);
        let fls = String::from_utf8_lossy(&frame.fls).into_owned();
        let images = collect_workspace_images(engine.root(), &fls);
        let aux = String::from_utf8_lossy(&frame.aux).into_owned();
        let bbl = String::from_utf8_lossy(&frame.bbl).into_owned();
        let (references, bibliography) = parse_aux_exports(&aux, &bbl);
        let pages = frame.extraction.pages;
        let record_count = pages
            .iter()
            .map(|page| page.renderable_records.len() as u64)
            .sum();
        let result = DraftDocumentResult {
            identity,
            mode: DraftMode::Paragraph,
            status: DraftStatus::Success,
            elapsed_ms: elapsed_ms(started),
            page_count: pages.len().min(u32::MAX as usize) as u32,
            renderable_record_count: record_count,
            pass_count: 1,
            bibliography_pass_count: 0,
            geometry: frame.extraction.geometry,
            pages,
            references,
            bibliography,
            images,
            unsupported_content_reasons: Vec::new(),
            pdf_fallback: false,
            diagnostics,
            log,
            failure: None,
            pdf_token: None,
        };
        ticket
            .settle_metadata_with_snapshot(&baseline_snapshot)
            .map_err(map_filesystem_error)?;
        Ok(DraftDelivery {
            result,
            pdf: None,
            generation: context.generation,
        })
    }

    fn fallback_paragraph(
        &self,
        owner: &OwnerId,
        request: DraftParagraphRequest,
        context: OperationContext,
        ticket: CompileLeaseTicket,
        baseline_snapshot: &CompileInputSnapshot,
    ) -> Result<DraftDelivery, DraftError> {
        ticket
            .settle_metadata_with_snapshot(baseline_snapshot)
            .map_err(map_filesystem_error)?;
        self.execute_document(
            owner,
            CompileSource::from(&request),
            Some((request.range, request.source)),
            DraftMode::Paragraph,
            context,
        )
    }

    fn stop_warm_engine(
        &self,
        slot: &mut Option<DraftWarmEngine>,
        ticket: Option<&crate::services::filesystem::CompileLeaseTicket>,
        cancellation: &CancellationToken,
    ) -> Result<(), DraftError> {
        let Some(mut engine) = slot.take() else {
            return Ok(());
        };
        match engine.stop(cancellation, CLEANUP_WAIT) {
            Ok(()) => Ok(()),
            Err(_) if engine.is_drained() => Ok(()),
            Err(detail) => {
                let callback_result = if let Some(ticket) = ticket {
                    match ticket.drain_handle() {
                        Ok(drain) => {
                            engine.on_drained(move || {
                                let _ = drain.finish_drain_with(|| Ok(()));
                            });
                            Ok(())
                        }
                        Err(error) => Err(error.to_string()),
                    }
                } else {
                    Ok(())
                };
                *slot = Some(engine);
                let suffix = callback_result
                    .err()
                    .map(|error| format!("; input lease remains retained: {error}"))
                    .unwrap_or_default();
                Err(DraftError::new(
                    DraftErrorCode::CleanupUnproven,
                    format!("Draft warm process-tree drain could not be proven: {detail}{suffix}"),
                ))
            }
        }
    }

    fn paragraph_overlay(
        &self,
        owner: &OwnerId,
        source: &CompileSource,
        range: DraftSourceRange,
        replacement: &str,
    ) -> Result<Vec<u8>, DraftError> {
        let receipt = self
            .inner
            .filesystem
            .read_file(
                owner,
                &FileRef {
                    workspace_id: source.workspace_id.clone(),
                    path: source.entry_path.clone(),
                },
            )
            .map_err(map_filesystem_error)?;
        if receipt.revision != source.saved_revision {
            return Err(map_filesystem_error(FilesystemError::RevisionConflict {
                expected: Some(source.saved_revision.clone()),
                actual: Some(receipt.revision),
            }));
        }
        replace_source_range(&receipt.bytes, range, replacement)
    }

    fn prepare_ticket(
        &self,
        owner: &OwnerId,
        source: &CompileSource,
        context: &OperationContext,
        overlay_bytes: Option<&[u8]>,
    ) -> Result<CompileLeaseTicket, DraftError> {
        let request = CompileRequest {
            workspace_id: source.workspace_id.clone(),
            entry_path: source.entry_path.clone(),
            document_id: source.document_id.clone(),
            document_version: source.document_version,
            saved_revision: source.saved_revision.clone(),
            engine: Engine::System,
        };
        let cancellation = context.cancellation.clone();
        let on_cancel: SubSystemCanceller = Box::new(move || {
            cancellation.cancel();
            Ok(())
        });
        let result = match overlay_bytes {
            Some(bytes) => {
                let overlay = CompileSourceOverlay {
                    path: &source.entry_path,
                    document_id: &source.document_id,
                    document_version: source.document_version,
                    bytes,
                };
                self.inner.filesystem.prepare_compile_with_overlay(
                    owner,
                    context.run_id.clone(),
                    &request,
                    &overlay,
                    on_cancel,
                )
            }
            None => self.inner.filesystem.prepare_compile(
                owner,
                context.run_id.clone(),
                &request,
                on_cancel,
            ),
        };
        result.map_err(map_filesystem_error)
    }

    pub(crate) fn stop(
        &self,
        owner: &OwnerId,
        workspace_id: &WorkspaceId,
    ) -> Result<bool, DraftError> {
        self.inner
            .filesystem
            .workspace_generation(owner, workspace_id)
            .map_err(map_filesystem_error)?;
        self.stop_workspace(owner, workspace_id, false)
    }

    pub(crate) fn takeover(
        &self,
        owner: &OwnerId,
        workspace_id: &WorkspaceId,
    ) -> Result<bool, DraftError> {
        self.inner
            .filesystem
            .workspace_generation(owner, workspace_id)
            .map_err(map_filesystem_error)?;
        self.stop_workspace(owner, workspace_id, true)
    }

    fn stop_workspace(
        &self,
        owner: &OwnerId,
        workspace_id: &WorkspaceId,
        preempted: bool,
    ) -> Result<bool, DraftError> {
        let key = workspace_key(owner, workspace_id);
        let mut stopped = cancel_active(&self.inner, &key, preempted)?;
        let daemon = lock_state(&self.inner).daemons.remove(&key);
        if let Some(mut daemon) = daemon {
            stopped = true;
            let (reply, receiver) = mpsc::sync_channel(1);
            let _ = daemon.sender.send(DaemonMessage::Stop(reply));
            let cleanup = receiver.recv().unwrap_or_else(|_| {
                Err(DraftError::new(
                    DraftErrorCode::CleanupUnproven,
                    "The Draft paragraph daemon ended before proving warm-process cleanup.",
                ))
            });
            if let Some(worker) = daemon.worker.take() {
                if worker.join().is_err() {
                    return Err(DraftError::new(
                        DraftErrorCode::CleanupUnproven,
                        "The Draft paragraph daemon did not join cleanly.",
                    ));
                }
            }
            cleanup?;
        }
        Ok(stopped)
    }

    pub(crate) fn revoke_owner(&self, owner: &OwnerId) -> Result<(), DraftError> {
        let keys: HashSet<WorkspaceKey> = {
            let state = lock_state(&self.inner);
            state
                .active
                .keys()
                .chain(state.daemons.keys())
                .filter(|key| &key.owner == owner)
                .cloned()
                .collect()
        };
        let mut first_error = None;
        for key in keys {
            if let Err(error) = self.stop_workspace(owner, &key.workspace_id, true) {
                if first_error.is_none() {
                    first_error = Some(error);
                }
            }
        }
        {
            let mut state = lock_state(&self.inner);
            let removed: Vec<RunId> = state
                .cached_pdfs
                .iter()
                .filter(|(_, cached)| &cached.owner == owner)
                .map(|(run_id, _)| run_id.clone())
                .collect();
            for run_id in removed {
                remove_cached_pdf(&mut state, &run_id);
            }
        }
        match first_error {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }

    pub(crate) fn cache_success(
        &self,
        owner: &OwnerId,
        delivery: &DraftDelivery,
        pdf: &[u8],
    ) -> Result<(), DraftError> {
        if delivery.result.status != DraftStatus::Success
            || pdf.len() > MAX_PDF_BYTES
            || validate_pdf(pdf).is_err()
        {
            return Err(DraftError::new(
                DraftErrorCode::InvalidRequest,
                "Only a validated successful Draft PDF can be retained.",
            ));
        }
        let current = self
            .inner
            .filesystem
            .workspace_generation(owner, &delivery.result.identity.workspace_id)
            .map_err(map_filesystem_error)?;
        if current != delivery.generation {
            return Err(DraftError::new(
                DraftErrorCode::StaleWorkspace,
                "The Draft workspace generation changed before PDF retention.",
            ));
        }
        let run_id = delivery.result.identity.run_id.clone();
        let mut state = lock_state(&self.inner);
        if state.cached_pdfs.contains_key(&run_id) {
            remove_cached_pdf(&mut state, &run_id);
        }
        while state.cached_pdfs.len() >= MAX_CACHED_PDFS
            || state.cached_bytes.saturating_add(pdf.len()) > MAX_CACHED_PDF_BYTES
        {
            let Some(oldest) = state.cached_order.pop_front() else {
                break;
            };
            remove_cached_pdf(&mut state, &oldest);
        }
        state.cached_bytes = state.cached_bytes.saturating_add(pdf.len());
        state.cached_order.push_back(run_id.clone());
        state.cached_pdfs.insert(
            run_id,
            CachedPdf {
                owner: owner.clone(),
                identity: delivery.result.identity.clone(),
                generation: delivery.generation,
                bytes: pdf.to_vec(),
            },
        );
        Ok(())
    }

    pub(crate) fn save_pdf(
        &self,
        owner: &OwnerId,
        request: DraftSavePdfRequest,
    ) -> Result<WriteReceipt, DraftError> {
        if !request.path.as_str().to_ascii_lowercase().ends_with(".pdf") {
            return Err(DraftError::new(
                DraftErrorCode::InvalidRequest,
                "The Draft save target must be a workspace-relative PDF path.",
            ));
        }
        let current_generation = self
            .inner
            .filesystem
            .workspace_generation(owner, &request.workspace_id)
            .map_err(map_filesystem_error)?;
        let cached = {
            let state = lock_state(&self.inner);
            let cached = state.cached_pdfs.get(&request.run_id).ok_or_else(|| {
                DraftError::new(
                    DraftErrorCode::InvalidRequest,
                    "The requested Draft PDF is no longer available.",
                )
            })?;
            if &cached.owner != owner
                || cached.identity.workspace_id != request.workspace_id
                || cached.generation != current_generation
            {
                return Err(DraftError::new(
                    DraftErrorCode::WorkspaceDenied,
                    "The Draft PDF is not owned by this current workspace.",
                ));
            }
            cached.bytes.clone()
        };
        let document_id = DocumentId::parse(&format!("draft-pdf-{}", request.run_id.as_str()))
            .map_err(|_| {
                DraftError::new(
                    DraftErrorCode::ResourceExhausted,
                    "Could not allocate a Draft PDF document identity.",
                )
            })?;
        let document_version = DocumentVersion::new(0).map_err(|_| {
            DraftError::new(
                DraftErrorCode::Internal,
                "Could not create the Draft PDF document version.",
            )
        })?;
        let write = WriteRequest {
            workspace_id: request.workspace_id,
            path: request.path,
            bytes: cached,
            expected_revision: request.expected_revision,
            document_id,
            document_version,
        };
        self.inner
            .filesystem
            .write_file(owner, &write)
            .map_err(map_filesystem_error)
    }
}

fn cancelled_paragraph_delivery(
    identity: CompileIdentity,
    started: Instant,
    generation: crate::state::workspace_leases::SessionGeneration,
    preempted: bool,
    log: String,
) -> DraftDelivery {
    let status = if preempted {
        DraftStatus::Preempted
    } else {
        DraftStatus::Cancelled
    };
    DraftDelivery {
        result: result_without_pdf(
            identity,
            DraftMode::Paragraph,
            status,
            started,
            0,
            0,
            log,
            None,
        ),
        pdf: None,
        generation,
    }
}

fn retain_warm_start_failure(
    result: Result<DraftDelivery, DraftError>,
    detail: &str,
) -> Result<DraftDelivery, DraftError> {
    const PREFIX: &str = "Draft warm paragraph startup failed: ";
    let mut message = PREFIX.to_owned();
    message.extend(
        detail
            .chars()
            .take(4096usize.saturating_sub(PREFIX.chars().count())),
    );
    match result {
        Ok(mut delivery) => {
            if delivery.result.diagnostics.len() < 256 {
                delivery.result.diagnostics.push(Diagnostic {
                    severity: Severity::Warning,
                    message,
                    path: None,
                    line: None,
                    column: None,
                });
            } else {
                append_bounded(&mut delivery.result.log, "\n");
                append_bounded(&mut delivery.result.log, &message);
            }
            Ok(delivery)
        }
        Err(mut error) => {
            error
                .message
                .push_str("\nThe Draft fallback also failed; warm startup detail: ");
            error.message.extend(detail.chars().take(4096));
            Err(error)
        }
    }
}

fn remove_cached_pdf(state: &mut RuntimeState, run_id: &RunId) {
    if let Some(cached) = state.cached_pdfs.remove(run_id) {
        state.cached_bytes = state.cached_bytes.saturating_sub(cached.bytes.len());
        state.cached_order.retain(|id| id != run_id);
    }
}

fn lock_state(inner: &Inner) -> MutexGuard<'_, RuntimeState> {
    inner.state.lock().unwrap_or_else(PoisonError::into_inner)
}

fn workspace_key(owner: &OwnerId, workspace_id: &WorkspaceId) -> WorkspaceKey {
    WorkspaceKey {
        owner: owner.clone(),
        workspace_id: workspace_id.clone(),
    }
}

fn begin_operation(
    inner: &Arc<Inner>,
    key: WorkspaceKey,
    generation: crate::state::workspace_leases::SessionGeneration,
    run_id: RunId,
) -> Result<OperationContext, DraftError> {
    let deadline = Instant::now() + CLEANUP_WAIT;
    let mut state = lock_state(inner);
    loop {
        if let Some(active) = state.active.get(&key) {
            active.preempted.store(true, Ordering::Release);
            active.cancellation.cancel();
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(DraftError::new(
                    DraftErrorCode::WorkspaceBusy,
                    "The previous Draft operation has not completed native cleanup.",
                ));
            }
            let (next, timeout) = inner
                .changed
                .wait_timeout(state, remaining)
                .unwrap_or_else(PoisonError::into_inner);
            state = next;
            if timeout.timed_out() && state.active.contains_key(&key) {
                return Err(DraftError::new(
                    DraftErrorCode::WorkspaceBusy,
                    "The previous Draft operation has not completed native cleanup.",
                ));
            }
            continue;
        }
        let id = state.next_id;
        state.next_id = id.checked_add(1).ok_or_else(|| {
            DraftError::new(
                DraftErrorCode::ResourceExhausted,
                "The Draft operation sequence is exhausted.",
            )
        })?;
        let (cancellation, token) = cancellation_pair();
        let preempted = Arc::new(AtomicBool::new(false));
        state.active.insert(
            key.clone(),
            ActiveRun {
                id,
                cancellation: cancellation.clone(),
                preempted: Arc::clone(&preempted),
            },
        );
        return Ok(OperationContext {
            _guard: ActiveRunGuard {
                inner: Arc::clone(inner),
                key,
                id,
            },
            run_id,
            generation,
            cancellation,
            token,
            preempted,
        });
    }
}

fn cancel_active(
    inner: &Arc<Inner>,
    key: &WorkspaceKey,
    preempted: bool,
) -> Result<bool, DraftError> {
    let deadline = Instant::now() + CLEANUP_WAIT;
    let mut state = lock_state(inner);
    let mut found = false;
    loop {
        let Some(active) = state.active.get(key) else {
            return Ok(found);
        };
        found = true;
        if preempted {
            active.preempted.store(true, Ordering::Release);
        }
        active.cancellation.cancel();
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(DraftError::new(
                DraftErrorCode::CleanupUnproven,
                "Draft cancellation was requested, but native process cleanup is still pending.",
            ));
        }
        let (next, timeout) = inner
            .changed
            .wait_timeout(state, remaining)
            .unwrap_or_else(PoisonError::into_inner);
        state = next;
        if timeout.timed_out() && state.active.contains_key(key) {
            return Err(DraftError::new(
                DraftErrorCode::CleanupUnproven,
                "Draft cancellation was requested, but native process cleanup is still pending.",
            ));
        }
    }
}

fn ensure_paragraph_daemon(
    inner: &Arc<Inner>,
    key: WorkspaceKey,
    generation: crate::state::workspace_leases::SessionGeneration,
) -> Result<SyncSender<DaemonMessage>, DraftError> {
    loop {
        let mut state = lock_state(inner);
        if let Some(daemon) = state.daemons.get(&key) {
            if daemon.generation != generation {
                return Err(DraftError::new(
                    DraftErrorCode::StaleWorkspace,
                    "The paragraph daemon belongs to another workspace generation.",
                ));
            }
            if daemon
                .worker
                .as_ref()
                .is_some_and(|worker| !worker.is_finished())
            {
                return Ok(daemon.sender.clone());
            }
        }
        if let Some(mut ended) = state.daemons.remove(&key) {
            drop(state);
            if let Some(worker) = ended.worker.take() {
                let _ = worker.join();
            }
            continue;
        }
        let id = state.next_id;
        state.next_id = id.checked_add(1).ok_or_else(|| {
            DraftError::new(
                DraftErrorCode::ResourceExhausted,
                "The Draft daemon sequence is exhausted.",
            )
        })?;
        let (sender, receiver) = mpsc::sync_channel(1);
        let worker_inner = Arc::clone(inner);
        let worker_key = key.clone();
        let worker = thread::Builder::new()
            .name("draft-paragraph-daemon".to_owned())
            .spawn(move || paragraph_daemon_loop(worker_inner, worker_key, generation, receiver))
            .map_err(|_| {
                DraftError::new(
                    DraftErrorCode::ResourceExhausted,
                    "Could not start the bounded Draft paragraph daemon.",
                )
            })?;
        state.daemons.insert(
            key,
            ParagraphDaemon {
                generation,
                sender: sender.clone(),
                worker: Some(worker),
            },
        );
        return Ok(sender);
    }
}

fn paragraph_daemon_loop(
    inner: Arc<Inner>,
    _key: WorkspaceKey,
    generation: crate::state::workspace_leases::SessionGeneration,
    receiver: Receiver<DaemonMessage>,
) {
    let mut warm_engine: Option<DraftWarmEngine> = None;
    while let Ok(message) = receiver.recv() {
        match message {
            DaemonMessage::Stop(reply) => {
                let result = if let Some(mut engine) = warm_engine.take() {
                    let (_, cleanup_token) = cancellation_pair();
                    let stopped = engine.stop(&cleanup_token, CLEANUP_WAIT);
                    if engine.is_drained() {
                        Ok(())
                    } else {
                        let detail = stopped
                            .err()
                            .unwrap_or_else(|| "Draft warm process remains live.".to_owned());
                        drop(engine);
                        Err(DraftError::new(
                            DraftErrorCode::CleanupUnproven,
                            format!("Draft warm cleanup remains supervised: {detail}"),
                        ))
                    }
                } else {
                    Ok(())
                };
                let _ = reply.send(result);
                break;
            }
            DaemonMessage::Typeset {
                owner,
                request,
                context,
                reply,
            } => {
                let result = if context.generation != generation {
                    Err(DraftError::new(
                        DraftErrorCode::StaleWorkspace,
                        "The paragraph request belongs to another workspace generation.",
                    ))
                } else {
                    DraftService {
                        inner: Arc::clone(&inner),
                    }
                    .execute_paragraph(
                        &owner,
                        *request,
                        context,
                        &mut warm_engine,
                    )
                };
                let _ = reply.send(result);
            }
        }
    }
}

fn new_run_id() -> Result<RunId, DraftError> {
    let nonce = NEXT_RUN_NONCE.fetch_add(1, Ordering::Relaxed);
    let time = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    RunId::parse(&format!("draft-{time:x}-{nonce:x}")).map_err(|_| {
        DraftError::new(
            DraftErrorCode::ResourceExhausted,
            "Could not allocate a unique Draft run identity.",
        )
    })
}

fn validate_entry_path(path: &RelativePath) -> Result<(), DraftError> {
    if path.as_str().to_ascii_lowercase().ends_with(".tex") {
        Ok(())
    } else {
        Err(DraftError::new(
            DraftErrorCode::InvalidRequest,
            "Draft compilation requires a workspace-relative TeX entry path.",
        ))
    }
}

pub(crate) fn replace_source_range(
    original: &[u8],
    range: DraftSourceRange,
    replacement: &str,
) -> Result<Vec<u8>, DraftError> {
    if original.len() > MAX_OVERLAY_BYTES
        || replacement.len() > 1024 * 1024
        || range.start_byte > range.end_byte
    {
        return Err(DraftError::new(
            DraftErrorCode::InputTooLarge,
            "The Draft paragraph source or range exceeds its limit.",
        ));
    }
    let source = std::str::from_utf8(original).map_err(|_| {
        DraftError::new(
            DraftErrorCode::InvalidRequest,
            "Paragraph replacement requires a UTF-8 TeX entry file.",
        )
    })?;
    let start = range.start_byte as usize;
    let end = range.end_byte as usize;
    if end > source.len() || !source.is_char_boundary(start) || !source.is_char_boundary(end) {
        return Err(DraftError::new(
            DraftErrorCode::InvalidRequest,
            "The paragraph range is outside the entry or splits a UTF-8 character.",
        ));
    }
    let new_len = source
        .len()
        .saturating_sub(end - start)
        .saturating_add(replacement.len());
    if new_len > MAX_OVERLAY_BYTES {
        return Err(DraftError::new(
            DraftErrorCode::InputTooLarge,
            "The paragraph overlay exceeds the 32 MiB entry limit.",
        ));
    }
    let mut output = Vec::with_capacity(new_len);
    output.extend_from_slice(&original[..start]);
    output.extend_from_slice(replacement.as_bytes());
    output.extend_from_slice(&original[end..]);
    Ok(output)
}

fn map_filesystem_error(error: FilesystemError) -> DraftError {
    use FilesystemError as Fs;
    match error {
        Fs::WorkspaceBusy => DraftError::new(
            DraftErrorCode::WorkspaceBusy,
            "A conflicting workspace operation is still active.",
        ),
        Fs::TimedOut => DraftError::new(
            DraftErrorCode::TimedOut,
            "The workspace operation exceeded its deadline.",
        ),
        Fs::Cancelled => DraftError::new(
            DraftErrorCode::Cancelled,
            "The workspace operation was cancelled.",
        ),
        Fs::StaleGeneration | Fs::StaleWorkspace => DraftError::new(
            DraftErrorCode::StaleWorkspace,
            "The workspace generation changed during Draft processing.",
        ),
        Fs::UnknownWorkspace | Fs::SessionClosed => DraftError::new(
            DraftErrorCode::WorkspaceDenied,
            "The Draft workspace is unavailable to this window.",
        ),
        Fs::FileTooLarge { .. } => DraftError::new(
            DraftErrorCode::InputTooLarge,
            "A Draft input or output exceeds the configured byte limit.",
        ),
        Fs::RevisionConflict { .. }
        | Fs::StaleDocumentVersion { .. }
        | Fs::DocumentIdentityMismatch { .. }
        | Fs::CompileIdentityMismatch(_) => DraftError::new(
            DraftErrorCode::StaleWorkspace,
            "The document or workspace changed during Draft processing.",
        ),
        Fs::CleanupUnproven { .. } => DraftError::new(
            DraftErrorCode::CleanupUnproven,
            "Workspace cleanup could not be proven.",
        ),
        _ => DraftError::new(
            DraftErrorCode::IoFailed,
            "The validated workspace operation failed.",
        ),
    }
}

fn compile_staged(
    inner: &Inner,
    run_id: &RunId,
    entry_path: &RelativePath,
    snapshot: &CompileInputSnapshot,
    token: &CancellationToken,
    started: Instant,
) -> Result<CompileArtifact, CompileFailure> {
    let Some(toolchain) = inner.toolchain.as_ref() else {
        return Err(CompileFailure {
            message: "LuaLaTeX is unavailable. Install a TeX distribution that includes LuaLaTeX, or add its trusted executable directory to the desktop host PATH.".to_owned(),
            kind: None,
            log: String::new(),
            cleanup_proven: true,
            passes: 0,
            bibliography_passes: 0,
        });
    };
    let mut tree =
        TempTree::create(&inner.scratch_root, run_id).map_err(|error| CompileFailure {
            message: error.message,
            kind: None,
            log: String::new(),
            cleanup_proven: true,
            passes: 0,
            bibliography_passes: 0,
        })?;
    let result = compile_in_tree(
        toolchain, &tree.path, run_id, entry_path, snapshot, token, started,
    );
    let cleanup = tree.cleanup();
    match (result, cleanup) {
        (Ok(artifact), Ok(())) => Ok(artifact),
        (Err(mut failure), Err(_)) => {
            failure
                .message
                .push_str(" Private Draft work cleanup also failed.");
            failure.cleanup_proven = false;
            Err(failure)
        }
        (Err(failure), Ok(())) => Err(failure),
        (Ok(_), Err(error)) => Err(CompileFailure {
            message: error.message,
            kind: None,
            log: String::new(),
            cleanup_proven: false,
            passes: 0,
            bibliography_passes: 0,
        }),
    }
}

fn compile_in_tree(
    toolchain: &Toolchain,
    root: &Path,
    run_id: &RunId,
    entry_path: &RelativePath,
    snapshot: &CompileInputSnapshot,
    token: &CancellationToken,
    started: Instant,
) -> Result<CompileArtifact, CompileFailure> {
    stage_snapshot(root, snapshot).map_err(|message| CompileFailure {
        message,
        kind: None,
        log: String::new(),
        cleanup_proven: true,
        passes: 0,
        bibliography_passes: 0,
    })?;

    let jobname = format!("modutex-draft-{}", run_id.as_str());
    let runtime_dir_name = format!(".modutex-draft-runtime-{}", run_id.as_str());
    let runtime_dir = root.join(&runtime_dir_name);
    fs::create_dir(&runtime_dir).map_err(|_| CompileFailure {
        message: "Could not create the private Draft Lua resource directory.".to_owned(),
        kind: None,
        log: String::new(),
        cleanup_proven: true,
        passes: 0,
        bibliography_passes: 0,
    })?;
    write_new_file(
        &runtime_dir.join("modutex-draft.lua"),
        LUA_SHIPOUT_RESOURCE.as_bytes(),
    )
    .map_err(|_| CompileFailure {
        message: "Could not materialize the packaged Draft shipout extractor.".to_owned(),
        kind: None,
        log: String::new(),
        cleanup_proven: true,
        passes: 0,
        bibliography_passes: 0,
    })?;

    let deadline = started.checked_add(DRAFT_TIMEOUT).unwrap_or(started);
    let mut log = String::new();
    let mut passes = 0u8;
    let mut bibliography_passes = 0u8;
    run_latex_pass(
        toolchain,
        root,
        entry_path,
        &jobname,
        &runtime_dir_name,
        token,
        deadline,
        &mut log,
    )
    .map_err(|failure| {
        passes = 1;
        compile_failure(
            "LuaLaTeX did not complete the first pass.",
            failure,
            &log,
            passes,
            0,
        )
    })?;
    passes = 1;

    let bcf_path = root.join(format!("{jobname}.bcf"));
    let aux_path = root.join(format!("{jobname}.aux"));
    if bcf_path.is_file() {
        let Some(biber) = toolchain.biber.as_ref() else {
            return Err(CompileFailure {
                message: "This document requires Biber, but no trusted biber.exe was found beside LuaLaTeX or on the host PATH.".to_owned(),
                kind: None,
                log,
                cleanup_proven: true,
                passes,
                bibliography_passes,
            });
        };
        run_bibliography_tool(biber, &jobname, root, token, deadline, &mut log, "Biber").map_err(
            |failure| {
                compile_failure(
                    "Biber did not complete the bibliography pass.",
                    failure,
                    &log,
                    passes,
                    bibliography_passes,
                )
            },
        )?;
        bibliography_passes = 1;
    } else if read_optional_text(&aux_path, MAX_AUX_BYTES)
        .ok()
        .flatten()
        .is_some_and(|aux| aux.contains("\\bibdata"))
    {
        let Some(bibtex) = toolchain.bibtex.as_ref() else {
            return Err(CompileFailure {
                message: "This document requires BibTeX, but no trusted bibtex.exe was found beside LuaLaTeX or on the host PATH.".to_owned(),
                kind: None,
                log,
                cleanup_proven: true,
                passes,
                bibliography_passes,
            });
        };
        run_bibliography_tool(bibtex, &jobname, root, token, deadline, &mut log, "BibTeX")
            .map_err(|failure| {
                compile_failure(
                    "BibTeX did not complete the bibliography pass.",
                    failure,
                    &log,
                    passes,
                    bibliography_passes,
                )
            })?;
        bibliography_passes = 1;
    }

    let minimum_passes = if bibliography_passes > 0 { 3 } else { 2 };
    let mut previous_aux = read_optional_bytes(&aux_path, MAX_AUX_BYTES).ok().flatten();
    while passes < MAX_PASSES {
        if token.is_cancelled() {
            return Err(CompileFailure {
                message: "Draft compilation was cancelled.".to_owned(),
                kind: Some(ProcessErrorKind::Cancelled),
                log,
                cleanup_proven: true,
                passes,
                bibliography_passes,
            });
        }
        run_latex_pass(
            toolchain,
            root,
            entry_path,
            &jobname,
            &runtime_dir_name,
            token,
            deadline,
            &mut log,
        )
        .map_err(|failure| {
            compile_failure(
                "LuaLaTeX did not complete a reference pass.",
                failure,
                &log,
                passes.saturating_add(1),
                bibliography_passes,
            )
        })?;
        passes = passes.saturating_add(1);
        let current_aux = read_optional_bytes(&aux_path, MAX_AUX_BYTES).ok().flatten();
        let changed = current_aux != previous_aux;
        previous_aux = current_aux;
        let lower_log = log.to_ascii_lowercase();
        let requested_rerun = lower_log.contains("rerun to get cross-references")
            || lower_log.contains("please (re)run");
        if passes >= minimum_passes && !changed && !requested_rerun {
            break;
        }
    }
    if token.is_cancelled() {
        return Err(CompileFailure {
            message: "Draft compilation was cancelled.".to_owned(),
            kind: Some(ProcessErrorKind::Cancelled),
            log,
            cleanup_proven: true,
            passes,
            bibliography_passes,
        });
    }

    let pdf_path = root.join(format!("{jobname}.pdf"));
    let pdf = read_bounded_file(&pdf_path, MAX_PDF_BYTES).map_err(|_| CompileFailure {
        message: "LuaLaTeX did not produce a readable PDF within the 32 MiB limit.".to_owned(),
        kind: None,
        log: log.clone(),
        cleanup_proven: true,
        passes,
        bibliography_passes,
    })?;
    validate_pdf(&pdf).map_err(|_| CompileFailure {
        message: "LuaLaTeX produced an invalid PDF header.".to_owned(),
        kind: None,
        log: log.clone(),
        cleanup_proven: true,
        passes,
        bibliography_passes,
    })?;

    let mut geometry = DraftGeometry::default();
    let mut pages = Vec::new();
    let extraction_path = root.join(format!("{jobname}.draft.json"));
    let mut unsupported = Vec::new();
    match read_bounded_file(&extraction_path, MAX_EXTRACTION_BYTES)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<DraftExtractionRecord>(&bytes).ok())
    {
        Some(extraction) => {
            geometry = extraction.geometry;
            pages = extraction.pages;
            if pages.len() > MAX_EXTRACTED_PAGES
                || pages
                    .iter()
                    .map(|page| page.renderable_records.len())
                    .sum::<usize>()
                    > MAX_EXTRACTED_RECORDS
                || !valid_geometry(&geometry)
                || pages.iter().any(|page| !valid_page(page))
            {
                pages.clear();
                geometry = DraftGeometry::default();
                unsupported.push("shipout-record-limits-or-invalid-metrics".to_owned());
            }
        }
        None => unsupported.push("shipout-records-unavailable".to_owned()),
    }

    let aux = read_optional_text(&aux_path, MAX_AUX_BYTES)
        .ok()
        .flatten()
        .unwrap_or_default();
    let bbl = read_optional_text(&root.join(format!("{jobname}.bbl")), MAX_BBL_BYTES)
        .ok()
        .flatten()
        .unwrap_or_default();
    let (references, bibliography) = parse_aux_exports(&aux, &bbl);
    let images = read_optional_text(&root.join(format!("{jobname}.fls")), MAX_FLS_BYTES)
        .ok()
        .flatten()
        .map(|fls| collect_workspace_images(root, &fls))
        .unwrap_or_default();
    let log = sanitize_log(&log, root, &toolchain.lualatex);
    Ok(CompileArtifact {
        pdf,
        geometry,
        pages,
        references,
        bibliography,
        images,
        unsupported,
        log,
        passes,
        bibliography_passes,
    })
}

fn stage_snapshot(root: &Path, snapshot: &CompileInputSnapshot) -> Result<(), String> {
    for entry in &snapshot.entries {
        if entry.kind == crate::schemas::protocol::FileKind::Directory {
            let path = join_relative(root, entry.path.as_str());
            fs::create_dir_all(path).map_err(|_| {
                "Could not materialize a validated workspace directory for Draft.".to_owned()
            })?;
        }
    }
    for file in &snapshot.files {
        if file.bytes.len() > 32 * 1024 * 1024 {
            return Err("A Draft input file exceeds the 32 MiB per-file limit.".to_owned());
        }
        let path = join_relative(root, file.path.as_str());
        let parent = path
            .parent()
            .ok_or_else(|| "A validated Draft input has no parent directory.".to_owned())?;
        fs::create_dir_all(parent)
            .map_err(|_| "Could not create a private directory for Draft input.".to_owned())?;
        write_new_file(&path, &file.bytes).map_err(|_| {
            "Could not copy a validated workspace file into the private Draft snapshot.".to_owned()
        })?;
    }
    Ok(())
}

fn join_relative(root: &Path, relative: &str) -> PathBuf {
    let mut output = root.to_path_buf();
    for segment in relative.split('/') {
        output.push(segment);
    }
    output
}

fn write_new_file(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut file = OpenOptions::new().write(true).create_new(true).open(path)?;
    file.write_all(bytes)
}

#[expect(
    clippy::too_many_arguments,
    reason = "Keep the validated per-run inputs explicit at the LuaLaTeX pass boundary."
)]
fn run_latex_pass(
    toolchain: &Toolchain,
    root: &Path,
    entry_path: &RelativePath,
    jobname: &str,
    runtime_dir: &str,
    token: &CancellationToken,
    deadline: Instant,
    log: &mut String,
) -> Result<(), ToolFailure> {
    let arguments = vec![
        OsString::from("-no-shell-escape"),
        OsString::from("-halt-on-error"),
        OsString::from("-interaction=nonstopmode"),
        OsString::from("-file-line-error"),
        OsString::from("-recorder"),
        OsString::from(format!("-jobname={jobname}")),
        OsString::from(format!("-output-directory={}", root.display())),
        OsString::from(format!("--lua={runtime_dir}/modutex-draft.lua")),
        OsString::from(format!("./{}", entry_path.as_str())),
    ];
    let output = run_tool(&toolchain.lualatex, root, arguments, token, deadline)?;
    append_process_logs(log, &output.logs);
    if output.active_processes_after_exit != 0 || output.exit_code != 0 {
        return Err(ToolFailure {
            kind: ProcessErrorKind::JobQueryFailure,
            exit_code: Some(output.exit_code),
            log: log.clone(),
            cleanup_proven: false,
        });
    }
    Ok(())
}

fn run_bibliography_tool(
    executable: &Path,
    jobname: &str,
    root: &Path,
    token: &CancellationToken,
    deadline: Instant,
    log: &mut String,
    label: &str,
) -> Result<(), ToolFailure> {
    let output = run_tool(
        executable,
        root,
        vec![OsString::from(jobname)],
        token,
        deadline,
    )?;
    append_process_logs(log, &output.logs);
    if output.active_processes_after_exit != 0 || output.exit_code != 0 {
        return Err(ToolFailure {
            kind: ProcessErrorKind::JobQueryFailure,
            exit_code: Some(output.exit_code),
            log: format!("{label} exited without a verified process-tree drain."),
            cleanup_proven: false,
        });
    }
    Ok(())
}

fn run_tool(
    executable: &Path,
    root: &Path,
    arguments: Vec<OsString>,
    token: &CancellationToken,
    deadline: Instant,
) -> Result<ProcessOutput, ToolFailure> {
    if token.is_cancelled() {
        return Err(ToolFailure {
            kind: ProcessErrorKind::Cancelled,
            exit_code: None,
            log: String::new(),
            cleanup_proven: true,
        });
    }
    let timeout = deadline.saturating_duration_since(Instant::now());
    if timeout.is_zero() {
        return Err(ToolFailure {
            kind: ProcessErrorKind::DeadlineExceeded,
            exit_code: None,
            log: String::new(),
            cleanup_proven: true,
        });
    }
    let environment = vec![
        (OsString::from("openin_any"), OsString::from("p")),
        (OsString::from("openout_any"), OsString::from("p")),
        (OsString::from("shell_escape"), OsString::from("f")),
        (
            OsString::from("TEXMFOUTPUT"),
            root.as_os_str().to_os_string(),
        ),
    ];
    let spec = ProcessSpec::new_with_environment(
        executable.to_path_buf(),
        root.to_path_buf(),
        arguments,
        environment,
        timeout,
        PROCESS_LOG_LIMIT,
    );
    match crate::platform::process_tree::run(&spec, token) {
        Ok(output) => Ok(output),
        Err(mut error) => Err(resolve_process_error(&mut error)),
    }
}

fn resolve_process_error(error: &mut ProcessError) -> ToolFailure {
    let kind = error.cause.unwrap_or(error.kind);
    let exit_code = error.exit_code;
    let mut logs = error.logs.clone();
    let mut cleanup_proven = matches!(
        error.cleanup,
        CleanupProof::NotRequired | CleanupProof::JobDrained
    );
    if let Some(mut pending) = error.take_pending_cleanup() {
        loop {
            match pending.retry(Duration::from_millis(250)) {
                Ok(final_logs) => {
                    logs = final_logs;
                    cleanup_proven = true;
                    break;
                }
                Err(_) => thread::sleep(Duration::from_millis(100)),
            }
        }
    }
    ToolFailure {
        kind,
        exit_code,
        log: logs_to_text(&logs),
        cleanup_proven,
    }
}

fn compile_failure(
    message: &str,
    failure: ToolFailure,
    current_log: &str,
    passes: u8,
    bibliography_passes: u8,
) -> CompileFailure {
    let mut log = current_log.to_owned();
    append_bounded(&mut log, &failure.log);
    let reason = match failure.kind {
        ProcessErrorKind::Cancelled => "Draft compilation was cancelled.",
        ProcessErrorKind::DeadlineExceeded => "The total Draft compilation deadline expired.",
        ProcessErrorKind::OutputLimitExceeded => "LuaLaTeX output exceeded its bounded log limit.",
        #[cfg(not(all(windows, target_arch = "x86_64")))]
        ProcessErrorKind::UnsupportedPlatform => {
            "Native Draft execution is supported only on Windows x64."
        }
        ProcessErrorKind::NonZeroExit => "The TeX tool exited with a nonzero status.",
        ProcessErrorKind::CleanupFailed => "Native process-tree cleanup could not be proven.",
        _ => message,
    };
    let detail = failure
        .exit_code
        .map(|code| format!("{reason} Exit code: {code}."))
        .unwrap_or_else(|| reason.to_owned());
    CompileFailure {
        message: detail,
        kind: Some(failure.kind),
        log,
        cleanup_proven: failure.cleanup_proven,
        passes,
        bibliography_passes,
    }
}

fn append_process_logs(target: &mut String, logs: &ProcessLogs) {
    if !logs.stdout.is_empty() {
        append_bounded(target, &String::from_utf8_lossy(&logs.stdout));
    }
    if !logs.stderr.is_empty() {
        append_bounded(target, &String::from_utf8_lossy(&logs.stderr));
    }
}

fn logs_to_text(logs: &ProcessLogs) -> String {
    let mut output = String::new();
    append_process_logs(&mut output, logs);
    output
}

fn append_bounded(target: &mut String, source: &str) {
    let remaining = MAX_LOG_CHARACTERS.saturating_sub(target.chars().count());
    if remaining == 0 {
        return;
    }
    target.extend(source.chars().take(remaining));
}

#[expect(
    clippy::too_many_arguments,
    reason = "Keep the result metadata explicit at this shared status-construction boundary."
)]
fn result_without_pdf(
    identity: CompileIdentity,
    mode: DraftMode,
    status: DraftStatus,
    started: Instant,
    passes: u8,
    bibliography_passes: u8,
    log: String,
    failure: Option<String>,
) -> DraftDocumentResult {
    DraftDocumentResult {
        identity,
        mode,
        status,
        elapsed_ms: elapsed_ms(started),
        page_count: 0,
        renderable_record_count: 0,
        pass_count: passes,
        bibliography_pass_count: bibliography_passes,
        geometry: DraftGeometry::default(),
        pages: Vec::new(),
        references: Vec::new(),
        bibliography: Vec::new(),
        images: Vec::new(),
        unsupported_content_reasons: Vec::new(),
        pdf_fallback: false,
        diagnostics: diagnostics_from_log(&log),
        log,
        failure,
        pdf_token: None,
    }
}

trait AddDiagnostics {
    fn with_diagnostics(self, diagnostics: Vec<Diagnostic>) -> Self;
}

impl AddDiagnostics for DraftDocumentResult {
    fn with_diagnostics(mut self, diagnostics: Vec<Diagnostic>) -> Self {
        self.diagnostics = diagnostics;
        self
    }
}

fn elapsed_ms(started: Instant) -> u64 {
    started.elapsed().as_millis().min(u64::MAX as u128) as u64
}

fn diagnostics_from_log(log: &str) -> Vec<Diagnostic> {
    let mut diagnostics = Vec::new();
    for line in log.lines() {
        let trimmed = line.trim();
        let severity = if trimmed.starts_with('!') {
            Some(Severity::Error)
        } else if trimmed.to_ascii_lowercase().contains("warning") {
            Some(Severity::Warning)
        } else {
            None
        };
        if let Some(severity) = severity {
            let message = trimmed.chars().take(4096).collect::<String>();
            if !message.is_empty() {
                diagnostics.push(Diagnostic {
                    severity,
                    message,
                    path: None,
                    line: None,
                    column: None,
                });
                if diagnostics.len() >= 256 {
                    break;
                }
            }
        }
    }
    diagnostics
}

fn valid_geometry(geometry: &DraftGeometry) -> bool {
    [
        geometry.paper_width_pt,
        geometry.paper_height_pt,
        geometry.column_width_pt,
        geometry.foot_skip_pt,
        geometry.margin_left_pt,
        geometry.margin_right_pt,
        geometry.margin_top_pt,
        geometry.margin_bottom_pt,
    ]
    .iter()
    .all(|value| value.is_finite() && *value >= 0.0)
}

fn valid_page(page: &DraftPageRecord) -> bool {
    page.number > 0
        && page.width_pt.is_finite()
        && page.height_pt.is_finite()
        && page.shipout_baseline_height_pt.is_finite()
        && page.width_pt >= 0.0
        && page.height_pt >= 0.0
        && page.renderable_records.iter().all(|record| {
            [record.x_pt, record.y_pt, record.width_pt, record.height_pt]
                .iter()
                .all(|value| value.is_finite())
        })
}

fn read_bounded_file(path: &Path, maximum: usize) -> std::io::Result<Vec<u8>> {
    let file = File::open(path)?;
    let mut limited = file.take(maximum as u64 + 1);
    let mut output = Vec::new();
    limited.read_to_end(&mut output)?;
    if output.len() > maximum {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "bounded Draft output exceeded its limit",
        ));
    }
    Ok(output)
}

fn read_optional_bytes(path: &Path, maximum: usize) -> std::io::Result<Option<Vec<u8>>> {
    match read_bounded_file(path, maximum) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

fn read_optional_text(path: &Path, maximum: usize) -> std::io::Result<Option<String>> {
    read_optional_bytes(path, maximum)
        .map(|bytes| bytes.map(|bytes| String::from_utf8_lossy(&bytes).into_owned()))
}

fn sanitize_log(log: &str, root: &Path, executable: &Path) -> String {
    let mut output = log.to_owned();
    for (path, replacement) in [
        (root, "<draft-work>"),
        (
            executable.parent().unwrap_or(executable),
            "<tex-distribution>",
        ),
    ] {
        let text = path.to_string_lossy();
        if !text.is_empty() {
            output = output.replace(text.as_ref(), replacement);
        }
    }
    output.chars().take(MAX_LOG_CHARACTERS).collect()
}

fn parse_braced_group(input: &str, start: usize) -> Option<(String, usize)> {
    let bytes = input.as_bytes();
    let mut open = start;
    while open < bytes.len() && bytes[open].is_ascii_whitespace() {
        open += 1;
    }
    if bytes.get(open) != Some(&b'{') {
        return None;
    }
    let mut depth = 1usize;
    let mut index = open + 1;
    let mut escaped = false;
    while index < bytes.len() {
        let byte = bytes[index];
        if escaped {
            escaped = false;
        } else if byte == b'\\' {
            escaped = true;
        } else if byte == b'{' {
            depth += 1;
        } else if byte == b'}' {
            depth -= 1;
            if depth == 0 {
                return Some((input[open + 1..index].to_owned(), index + 1));
            }
        }
        index += 1;
    }
    None
}

fn parse_groups(input: &str) -> Vec<String> {
    let mut groups = Vec::new();
    let mut index = 0usize;
    while index < input.len() && groups.len() < 8 {
        if input.as_bytes()[index] == b'{' {
            if let Some((group, next)) = parse_braced_group(input, index) {
                groups.push(group);
                index = next;
                continue;
            }
        }
        index += 1;
    }
    groups
}

pub(crate) fn parse_aux_exports(
    aux: &str,
    bbl: &str,
) -> (Vec<DraftReference>, Vec<DraftBibliographyEntry>) {
    let mut references = BTreeMap::<String, DraftReference>::new();
    let mut citations = BTreeMap::<String, String>::new();
    for line in aux.lines().take(MAX_EXPORTED_ITEMS * 8) {
        if let Some(position) = line.find("\\newlabel") {
            let start = position + "\\newlabel".len();
            if let Some((key, after_key)) = parse_braced_group(line, start) {
                if let Some((value, _)) = parse_braced_group(line, after_key) {
                    let parts = parse_groups(&value);
                    if !key.is_empty() {
                        references.insert(
                            key.clone(),
                            DraftReference {
                                key,
                                label: parts.first().cloned().unwrap_or_default(),
                                page: parts.get(1).cloned(),
                            },
                        );
                    }
                }
            }
        }
        if let Some(position) = line.find("\\bibcite") {
            let start = position + "\\bibcite".len();
            if let Some((key, after_key)) = parse_braced_group(line, start) {
                if let Some((label, _)) = parse_braced_group(line, after_key) {
                    citations.insert(key, label);
                }
            }
        }
        if let Some(position) = line.find("\\citation") {
            let start = position + "\\citation".len();
            if let Some((keys, _)) = parse_braced_group(line, start) {
                for key in keys.split(',').take(MAX_EXPORTED_ITEMS) {
                    if !key.is_empty() {
                        references
                            .entry(key.to_owned())
                            .or_insert_with(|| DraftReference {
                                key: key.to_owned(),
                                label: citations.get(key).cloned().unwrap_or_default(),
                                page: None,
                            });
                    }
                }
            }
        }
    }
    for (key, label) in &citations {
        references
            .entry(key.clone())
            .and_modify(|reference| reference.label = label.clone())
            .or_insert_with(|| DraftReference {
                key: key.clone(),
                label: label.clone(),
                page: None,
            });
    }

    let mut bibliography = Vec::new();
    let lines: Vec<&str> = bbl.lines().take(32_768).collect();
    let mut index = 0usize;
    while index < lines.len() && bibliography.len() < MAX_EXPORTED_ITEMS {
        let Some(marker) = lines[index].find("\\bibitem") else {
            index += 1;
            continue;
        };
        let mut rest = &lines[index][marker + "\\bibitem".len()..];
        let mut label = None;
        if let Some(stripped) = rest.trim_start().strip_prefix('[') {
            if let Some(end) = stripped.find(']') {
                label = Some(stripped[..end].to_owned());
                rest = &stripped[end + 1..];
            }
        }
        let Some((key, after_key)) = parse_braced_group(rest, 0) else {
            index += 1;
            continue;
        };
        let mut body = rest[after_key..].trim().to_owned();
        index += 1;
        while index < lines.len() && !lines[index].contains("\\bibitem") {
            if body.len() < 8192 {
                if !body.is_empty() {
                    body.push(' ');
                }
                body.push_str(lines[index].trim());
            }
            index += 1;
        }
        body.truncate(body.len().min(8192));
        bibliography.push(DraftBibliographyEntry {
            citation_label: label.or_else(|| citations.get(&key).cloned()),
            key,
            text: body,
        });
    }
    (
        references.into_values().take(MAX_EXPORTED_ITEMS).collect(),
        bibliography,
    )
}

fn collect_workspace_images(root: &Path, fls: &str) -> Vec<DraftImageReference> {
    let canonical_root = match fs::canonicalize(root) {
        Ok(path) => path,
        Err(_) => return Vec::new(),
    };
    let mut seen = HashSet::new();
    let mut images = Vec::new();
    for line in fls.lines().take(65_536) {
        let Some(raw) = line.strip_prefix("INPUT ") else {
            continue;
        };
        let path = PathBuf::from(raw);
        let absolute = if path.is_absolute() {
            path
        } else {
            root.join(path)
        };
        let Ok(canonical) = fs::canonicalize(absolute) else {
            continue;
        };
        let Ok(relative) = canonical.strip_prefix(&canonical_root) else {
            continue;
        };
        let Some(text) = relative.to_str() else {
            continue;
        };
        let normalized = text.replace('\\', "/");
        let lower = normalized.to_ascii_lowercase();
        if ![".png", ".jpg", ".jpeg", ".pdf", ".eps"]
            .iter()
            .any(|extension| lower.ends_with(extension))
        {
            continue;
        }
        let Ok(path) = RelativePath::parse(&normalized) else {
            continue;
        };
        if seen.insert(path.clone()) {
            images.push(DraftImageReference { path, page: None });
            if images.len() >= MAX_EXPORTED_ITEMS {
                break;
            }
        }
    }
    images
}
