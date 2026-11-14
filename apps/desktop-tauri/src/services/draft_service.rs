// SPDX-License-Identifier: Apache-2.0
//! Native LuaLaTeX Draft execution, shipout extraction, and warm paragraph
//! worker. The host selects every executable and argument; renderer DTOs carry
//! only workspace-relative document data.

mod compiler;
mod exports;
mod toolchain;

use std::{
    collections::{BTreeSet, HashMap, HashSet, VecDeque},
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc::{self, Receiver, SyncSender, TrySendError},
        Arc, Condvar, Mutex, MutexGuard, PoisonError,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

#[cfg(test)]
#[allow(unused_imports)]
use self::{
    compiler::{
        append_process_logs, compile_failure, join_relative, logs_to_text, read_bounded_file,
        read_optional_bytes, read_optional_text, write_new_file,
    },
    exports::{parse_braced_group, parse_groups},
    toolchain::{canonical_executable, TempTree, ToolFailure},
};
#[cfg(test)]
#[allow(unused_imports)]
use crate::schemas::draft::DraftPageRecord;
#[cfg(test)]
#[allow(unused_imports)]
use std::env;
pub(crate) use self::exports::{parse_aux_exports, replace_source_range};
use self::{
    compiler::{append_bounded, compile_staged},
    exports::{
        collect_workspace_images, diagnostics_from_log, map_filesystem_error, sanitize_log,
        valid_geometry, valid_page, validate_entry_path,
    },
    toolchain::Toolchain,
};

use crate::{
    platform::process_tree::{
        cancellation_pair, CancellationHandle, CancellationToken, ProcessErrorKind,
    },
    schemas::draft::{
        DraftCompileRequest, DraftDocumentResult, DraftError, DraftErrorCode, DraftGeometry,
        DraftMode, DraftParagraphRequest, DraftSavePdfRequest, DraftSourceRange, DraftStatus,
    },
    schemas::protocol::OwnerId,
    schemas::protocol::{
        validate_pdf, CompileIdentity, CompileRequest, CompileResult, Diagnostic, DocumentId,
        DocumentVersion, Engine, FileRef, Revision, RunId, Severity, WorkspaceId, WriteReceipt,
        WriteRequest, MAX_PDF_BYTES,
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
const LUA_SHIPOUT_RESOURCE: &str =
    include_str!("../resources/draft/modutex-draft.lua");

static NEXT_RUN_NONCE: AtomicU64 = AtomicU64::new(1);

#[derive(Clone)]
pub(crate) struct DraftDelivery {
    pub(crate) result: DraftDocumentResult,
    pub(crate) pdf: Option<Vec<u8>>,
    generation: crate::state::workspace_leases::SessionGeneration,
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

#[cfg(test)]
#[path = "../../tests/unit/draft_service.rs"]
mod tests;
