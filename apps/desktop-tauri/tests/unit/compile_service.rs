// SPDX-License-Identifier: Apache-2.0
use super::*;
use crate::{
    schemas::protocol::{FileRef, Timestamp},
    services::filesystem::FilesystemService,
    state::recent::RecentStore,
    state::sessions::SessionRegistry,
    state::settings::SettingsStore,
    state::workspace_leases::WorkspaceLeaseCoordinator,
};
use std::{
    fs,
    sync::{Condvar, Mutex},
};
use uuid::Uuid;

impl CompileWorkspaceConfig {
    fn default_for_request(request: &CompileRequest) -> Self {
        Self {
            revision: 0,
            main_file: Some(request.entry_path.clone()),
            profile: match request.engine {
                Engine::Managed => CompileProfile::Managed,
                Engine::System => CompileProfile::System,
            },
            output_dir: None,
            pdf_path: None,
            log_path: None,
            custom_command: None,
        }
    }
}

impl CompileService {
    fn start(
        &self,
        owner: &OwnerId,
        request: CompileRequest,
    ) -> Result<CompileIdentity, CompileServiceError> {
        let config = CompileWorkspaceConfig::default_for_request(&request);
        self.start_with_workspace_config(owner, request, CompileOverlay::default(), config, false)
    }

    fn start_with_overlay(
        &self,
        owner: &OwnerId,
        request: CompileRequest,
        overlay: CompileOverlay,
    ) -> Result<CompileIdentity, CompileServiceError> {
        let config = CompileWorkspaceConfig::default_for_request(&request);
        self.start_with_workspace_config(owner, request, overlay, config, false)
    }

    fn take_result(
        &self,
        owner: &OwnerId,
        identity: &CompileIdentity,
    ) -> Result<Option<CompileResult>, CompileServiceError> {
        Ok(self
            .take_result_with_artifacts(owner, identity)?
            .map(|delivery| delivery.result))
    }

    fn wait_result(
        &self,
        owner: &OwnerId,
        identity: &CompileIdentity,
        timeout: Duration,
    ) -> Result<Option<CompileResult>, CompileServiceError> {
        Ok(self
            .wait_result_with_artifacts(owner, identity, timeout)?
            .map(|delivery| delivery.result))
    }
}

static TEST_LOCK: Mutex<()> = Mutex::new(());
struct TestDirectory(PathBuf);
impl TestDirectory {
    fn new() -> Self {
        let path = env::temp_dir().join(format!(
            "modutex-g3-compile-{}-{}",
            std::process::id(),
            Uuid::new_v4().simple()
        ));
        fs::create_dir(&path).expect("create isolated compile test directory");
        Self(path)
    }
    fn path(&self) -> &Path {
        &self.0
    }
}
impl Drop for TestDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn managed_fontconfig_uses_private_configuration_and_preserves_existing_files() {
    let directory = TestDirectory::new();
    let cache = directory.path().join("cache & fonts");
    let environment =
        build_process_environment(&[], &[], None, directory.path(), Some(&cache)).unwrap();
    let path = environment
        .iter()
        .find(|(key, _)| key == "FONTCONFIG_FILE")
        .unwrap()
        .1
        .clone();
    assert_eq!(PathBuf::from(path), directory.path().join("fontconfig.xml"));
    let config = fs::read_to_string(directory.path().join("fontconfig.xml")).unwrap();
    assert!(config.contains("/Fonts</dir>"));
    assert!(config.contains("cache &amp; fonts/fontconfig"));
    assert!(!config.contains("<include"));
    assert!(build_process_environment(&[], &[], None, directory.path(), Some(&cache)).is_err());
    assert_eq!(
        fs::read_to_string(directory.path().join("fontconfig.xml")).unwrap(),
        config
    );
    let system = build_process_environment(&[], &[], None, directory.path(), None).unwrap();
    assert!(!system.iter().any(|(key, _)| key == "FONTCONFIG_FILE"));
    assert!(
        validate_profile_environment(vec![("FONTCONFIG_FILE".into(), "untrusted.xml".into())])
            .is_err()
    );
}

struct WorkspaceFixture {
    owner: OwnerId,
    workspace_id: WorkspaceId,
    entry: RelativePath,
    revision: crate::schemas::protocol::Revision,
    root: PathBuf,
    document_id: DocumentId,
}
impl WorkspaceFixture {
    fn request(&self, version: u64) -> CompileRequest {
        CompileRequest {
            workspace_id: self.workspace_id.clone(),
            entry_path: self.entry.clone(),
            document_id: self.document_id.clone(),
            document_version: DocumentVersion::new(version).expect("safe version"),
            saved_revision: self.revision.clone(),
            engine: Engine::System,
        }
    }
}
fn new_filesystem(base: &Path) -> Arc<FilesystemService> {
    Arc::new(FilesystemService::new(
        Arc::new(SessionRegistry::new()),
        WorkspaceLeaseCoordinator::new(),
        RecentStore::new(base.join("recent")),
        SettingsStore::new(base.join("settings")),
    ))
}
fn add_workspace(
    filesystem: &Arc<FilesystemService>,
    base: &Path,
    owner_label: &str,
    source: &str,
) -> WorkspaceFixture {
    let owner = OwnerId::from_label(owner_label).expect("trusted test owner");
    let root = base.join(format!("workspace-{owner_label}"));
    fs::create_dir_all(root.join("sections")).expect("create nested source directory");
    fs::write(root.join("main.tex"), source).expect("write entry source");
    fs::write(
        root.join("sections").join("child.tex"),
        "Nested input for the compile snapshot.\n",
    )
    .expect("write nested source");
    let entry = RelativePath::parse("main.tex").expect("safe entry path");
    let opened = filesystem
        .open_workspace_folder(
            &owner,
            &root,
            Some(entry.clone()),
            Timestamp::new(1).expect("safe timestamp"),
        )
        .expect("open test workspace")
        .opened;
    let receipt = filesystem
        .read_file(
            &owner,
            &FileRef {
                workspace_id: opened.id.clone(),
                path: entry.clone(),
            },
        )
        .expect("read entry revision");
    WorkspaceFixture {
        owner,
        workspace_id: opened.id,
        entry,
        revision: receipt.revision,
        root,
        document_id: DocumentId::parse("doc-1").expect("safe document id"),
    }
}

type MockProcessRun =
    dyn FnMut(&ProcessInvocation, &CancellationToken) -> Result<ProcessOutput, ProcessError> + Send;

struct MockProcessExecutor {
    run_fn: Mutex<Box<MockProcessRun>>,
}
impl MockProcessExecutor {
    fn new<F>(f: F) -> Self
    where
        F: FnMut(&ProcessInvocation, &CancellationToken) -> Result<ProcessOutput, ProcessError>
            + Send
            + 'static,
    {
        Self {
            run_fn: Mutex::new(Box::new(f)),
        }
    }
    fn successful(pdf: Vec<u8>, log: &str) -> Arc<Self> {
        let log = log.to_owned();
        Arc::new(Self::new(move |invocation, _| {
            if let Some(parent) = invocation.output_pdf.parent() {
                fs::create_dir_all(parent).unwrap();
            }
            fs::write(&invocation.output_pdf, &pdf).unwrap();
            fs::write(&invocation.engine_log, &log).unwrap();
            Ok(ProcessOutput {
                pid: 1234,
                exit_code: 0,
                logs: ProcessLogs {
                    stdout: b"mock engine stdout\n".to_vec(),
                    stderr: Vec::new(),
                    stdout_truncated: false,
                    stderr_truncated: false,
                },
                active_processes_after_exit: 0,
            })
        }))
    }
}
impl ProcessExecutor for MockProcessExecutor {
    fn run(
        &self,
        invocation: &ProcessInvocation,
        cancellation: &CancellationToken,
    ) -> Result<ProcessOutput, ProcessError> {
        lock_recover(&self.run_fn)(invocation, cancellation)
    }
}
fn valid_pdf_bytes() -> Vec<u8> {
    b"%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n".to_vec()
}

fn write_valid_synctex(invocation: &ProcessInvocation) {
    use std::io::Write;
    let source = invocation.working_directory.join("main.tex");
    let text = format!(
        "SyncTeX Version:1\nInput:1:{}\nOutput:pdf\nContent:\n{{1\n}}\nPostamble:\nCount:0\n",
        source.to_str().unwrap()
    );
    let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    encoder.write_all(text.as_bytes()).unwrap();
    fs::write(
        invocation.output_synctex.as_ref().unwrap(),
        encoder.finish().unwrap(),
    )
    .unwrap();
}

fn repository_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .take(8)
        .find(|root| {
            root.join("apps/desktop-tauri/Cargo.toml").is_file()
                && root.join("apps/frontend").is_dir()
                && root
                    .join("packages/frontend-contracts/src/schemas/types.ts")
                    .is_file()
                && root.join("vendor").is_dir()
        })
        .expect("locate repository root using Cargo, frontend, contracts, and vendor markers")
        .to_path_buf()
}

fn fixed_vendor_tectonic() -> PathBuf {
    repository_root().join("vendor/tectonic/windows-x64/tectonic.exe")
}

fn create_test_system_profile(base: &Path) -> SystemProfile {
    let exe = env::current_exe().expect("test executable");
    let search = base.join("search");
    fs::create_dir_all(&search).expect("create search dir");
    SystemProfile::new(
        SystemTool::LatexMk,
        exe,
        vec![
            SystemArgument::Literal(OsString::from("-pdf")),
            SystemArgument::OutputDirectory,
            SystemArgument::EntryPath,
        ],
        vec![search],
        Vec::new(),
        Duration::from_secs(60),
        None,
    )
    .expect("valid system profile")
}
fn create_test_managed_profile(base: &Path) -> ManagedProfile {
    let exe = env::current_exe().expect("test executable");
    let cache = base.join("cache");
    let search = base.join("search");
    fs::create_dir_all(&cache).expect("create cache dir");
    fs::create_dir_all(&search).expect("create search dir");
    ManagedProfile::new(exe, cache, vec![search], Vec::new()).expect("valid managed profile")
}
fn create_test_config(base: &Path) -> TrustedCompileConfig {
    let temp_root = base.join("temp_root");
    fs::create_dir_all(&temp_root).expect("create temp root");
    TrustedCompileConfig::new(
        temp_root,
        Some(create_test_managed_profile(base)),
        Some(create_test_system_profile(base)),
    )
    .expect("valid config")
}

fn assert_unproven_process_output(owner_label: &str, pid: u32, active_processes_after_exit: u32) {
    let dir = TestDirectory::new();
    let filesystem = new_filesystem(dir.path());
    let fixture = add_workspace(&filesystem, dir.path(), owner_label, "saved entry source\n");
    let request = fixture.request(1);
    let config = CompileWorkspaceConfig::default_for_request(&request);
    let cleanup_proven = Arc::new(AtomicBool::new(false));
    let executor = Arc::new(MockProcessExecutor::new(move |invocation, _| {
        if let Some(parent) = invocation.output_pdf.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(&invocation.output_pdf, valid_pdf_bytes()).unwrap();
        fs::write(&invocation.engine_log, "invalid process output test\n").unwrap();
        Ok(ProcessOutput {
            pid,
            exit_code: 0,
            logs: ProcessLogs::default(),
            active_processes_after_exit,
        })
    }));
    let service = CompileService::with_executor_for_test(
        Arc::clone(&filesystem),
        create_test_config(dir.path()),
        executor,
    )
    .expect("service");
    let profile = service
        .inner
        .resolve_profile(request.engine, &config, false)
        .expect("profile");
    let (cancellation, cancellation_token) = cancellation_pair();
    let run_id = RunId::parse(&format!("run-{owner_label}")).expect("run id");
    let identity = CompileIdentity {
        run_id: run_id.clone(),
        workspace_id: request.workspace_id.clone(),
        entry_path: request.entry_path.clone(),
        document_id: request.document_id.clone(),
        document_version: request.document_version,
        saved_revision: request.saved_revision.clone(),
    };
    let scope = RunScope {
        owner: fixture.owner.clone(),
        workspace_id: request.workspace_id.clone(),
        entry_path: request.entry_path.clone(),
        document_id: request.document_id.clone(),
    };
    let cancel_handle = cancellation.clone();
    let canceller: crate::services::filesystem::SubSystemCanceller = Box::new(move || {
        cancel_handle.cancel();
        Ok(())
    });
    let ticket = filesystem
        .prepare_compile(&fixture.owner, run_id.clone(), &request, canceller)
        .expect("prepare compile ticket");
    let drain_handle = ticket.drain_handle().expect("drain handle");
    let control = Arc::new(RunControl {
        owner: fixture.owner.clone(),
        identity: identity.clone(),
        request,
        scope: scope.clone(),
        profile,
        overlay: CompileOverlay::default(),
        workspace_config: config,
        cancellation,
        cancellation_token,
        cancel_reason: AtomicU8::new(CANCEL_NONE),
        publish_allowed: AtomicBool::new(true),
        admitted: AtomicBool::new(true),
        phase: AtomicU8::new(PHASE_PREPARING),
        engine_state: AtomicU8::new(ENGINE_NEVER_STARTED),
        preparation_result: Mutex::new(None),
        ticket: Mutex::new(Some(ticket)),
        drain_handle: Mutex::new(Some(drain_handle)),
        run_directory: Mutex::new(None),
        pending_process_error: Mutex::new(None),
        result: Mutex::new(None),
        synctex_result: Mutex::new(None),
        workspace_root_for_redaction: Mutex::new(None),
    });
    {
        let mut state = service.inner.lock_state();
        state.runs.insert(run_id.clone(), Arc::clone(&control));
        state.latest.insert(scope.clone(), run_id);
    }

    assert!(!service.inner.execute(&control));
    assert_eq!(control.phase.load(Ordering::Acquire), PHASE_UNPROVEN);
    assert_eq!(
        control.engine_state.load(Ordering::Acquire),
        ENGINE_MAY_BE_RUNNING
    );
    assert!(lock_recover(&control.result).is_none());
    assert!(lock_recover(&control.ticket).is_some());
    assert!(filesystem.has_undrained_cleanup(&fixture.workspace_id));
    {
        let state = service.inner.lock_state();
        assert!(state
            .runs
            .get(&identity.run_id)
            .is_some_and(|run| Arc::ptr_eq(run, &control)));
    }
    {
        let directory = lock_recover(&control.run_directory);
        let directory = directory.as_ref().expect("retained compile directory");
        assert!(directory.root.is_dir());
        assert!(!directory.allow_cleanup);
        assert!(!directory.removed);
    }

    // This mock never starts a process. The test releases its fixture only
    // after explicitly recording that mock-only cleanup proof.
    cleanup_proven.store(true, Ordering::Release);
    assert!(cleanup_proven.load(Ordering::Acquire));
    let mut directory = lock_recover(&control.run_directory)
        .take()
        .expect("retained compile directory");
    directory.allow_cleanup = true;
    directory.remove_owned().expect("mock cleanup proof");
    drop(directory);

    let mut ticket = lock_recover(&control.ticket)
        .take()
        .expect("retained compile ticket");
    ticket
        .finish_drain_with(|| {
            if cleanup_proven.load(Ordering::Acquire) {
                Ok(())
            } else {
                Err("mock process cleanup is not proven".to_owned())
            }
        })
        .expect("release ticket after mock cleanup proof");
    let drain_handle = lock_recover(&control.drain_handle)
        .take()
        .expect("retained drain handle");
    drain_handle
        .finish_drain_with(|| {
            if cleanup_proven.load(Ordering::Acquire) {
                Ok(())
            } else {
                Err("mock process cleanup is not proven".to_owned())
            }
        })
        .expect("release drain handle after mock cleanup proof");
    assert!(!filesystem.has_undrained_cleanup(&fixture.workspace_id));
    assert!(lock_recover(&control.result).is_none());
    {
        let mut state = service.inner.lock_state();
        state.runs.remove(&identity.run_id);
        state.latest.remove(&scope);
    }
}

#[test]
fn invalid_process_output_retains_the_run_directory_and_workspace_lease() {
    let _guard = TEST_LOCK.lock().unwrap();
    assert_unproven_process_output("invalid-pid-owner", 0, 0);
    assert_unproven_process_output("active-process-owner", 1234, 1);
}

#[test]
fn test_successful_system_compile_and_separate_synctex_delivery() {
    let _guard = TEST_LOCK.lock().unwrap();
    let dir = TestDirectory::new();
    let filesystem = new_filesystem(dir.path());
    let fixture = add_workspace(
        &filesystem,
        dir.path(),
        "success-owner",
        "saved entry source\n",
    );
    let executor = Arc::new(MockProcessExecutor::new(|invocation, _| {
        if let Some(parent) = invocation.output_pdf.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(&invocation.output_pdf, valid_pdf_bytes()).unwrap();
        fs::write(&invocation.engine_log, "clean compile transcript\n").unwrap();
        write_valid_synctex(invocation);
        Ok(ProcessOutput {
            pid: 1234,
            exit_code: 0,
            logs: ProcessLogs::default(),
            active_processes_after_exit: 0,
        })
    }));
    let service = CompileService::with_executor_for_test(
        filesystem,
        create_test_config(dir.path()),
        executor,
    )
    .expect("service");
    let identity = service
        .start(&fixture.owner, fixture.request(1))
        .expect("start");
    let delivery = service
        .wait_result_with_artifacts(&fixture.owner, &identity, Duration::from_secs(5))
        .expect("wait")
        .expect("delivery");
    assert!(
        matches!(&delivery.result, CompileResult::Success { identity: result_identity, .. } if result_identity == &identity)
    );
    use std::io::Read;
    let artifact = delivery
        .synctex
        .as_deref()
        .expect("separate normalized SyncTeX artifact");
    let mut normalized = String::new();
    flate2::read::GzDecoder::new(artifact)
        .read_to_string(&mut normalized)
        .unwrap();
    assert!(normalized.contains("Input:1:main.tex\n"));
    assert!(!normalized.contains("modutex-g3-compile-"));
    assert!(matches!(
        service.take_result(&fixture.owner, &identity),
        Err(CompileServiceError::UnknownRun)
    ));
}

#[test]
fn test_wait_result_rejects_retrieval_after_consumption() {
    let _guard = TEST_LOCK.lock().unwrap();
    let dir = TestDirectory::new();
    let filesystem = new_filesystem(dir.path());
    let fixture = add_workspace(
        &filesystem,
        dir.path(),
        "one-shot-owner",
        "saved entry source\n",
    );
    let service = CompileService::with_executor_for_test(
        filesystem,
        create_test_config(dir.path()),
        MockProcessExecutor::successful(valid_pdf_bytes(), "one-shot compile\n"),
    )
    .expect("service");
    let identity = service
        .start(&fixture.owner, fixture.request(1))
        .expect("start");

    let result = service
        .wait_result(&fixture.owner, &identity, Duration::from_secs(5))
        .expect("wait")
        .expect("compile result");
    assert!(matches!(
        &result,
        CompileResult::Success { pdf, .. } if pdf.starts_with(b"%PDF-")
    ));
    assert!(matches!(
        service.wait_result(&fixture.owner, &identity, Duration::from_secs(1)),
        Err(CompileServiceError::UnknownRun)
    ));
}

#[test]
fn test_unsaved_overlay_is_staged_without_writing_workspace_bytes() {
    let _guard = TEST_LOCK.lock().unwrap();
    let dir = TestDirectory::new();
    let filesystem = new_filesystem(dir.path());
    let fixture = add_workspace(
        &filesystem,
        dir.path(),
        "overlay-owner",
        "saved entry source\n",
    );
    let entry_bytes = b"unsaved entry source\n".to_vec();
    let child_bytes = b"unsaved child source\n".to_vec();
    let expected_entry = entry_bytes.clone();
    let expected_child = child_bytes.clone();
    let executor = Arc::new(MockProcessExecutor::new(move |invocation, _| {
        assert_eq!(
            fs::read(invocation.working_directory.join("main.tex")).unwrap(),
            expected_entry
        );
        assert_eq!(
            fs::read(
                invocation
                    .working_directory
                    .join("sections")
                    .join("child.tex")
            )
            .unwrap(),
            expected_child
        );
        if let Some(parent) = invocation.output_pdf.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(&invocation.output_pdf, valid_pdf_bytes()).unwrap();
        fs::write(&invocation.engine_log, "overlay compile ok\n").unwrap();
        write_valid_synctex(invocation);
        Ok(ProcessOutput {
            pid: 1235,
            exit_code: 0,
            logs: ProcessLogs::default(),
            active_processes_after_exit: 0,
        })
    }));
    let service = CompileService::with_executor_for_test(
        Arc::clone(&filesystem),
        create_test_config(dir.path()),
        executor,
    )
    .expect("service");
    let request = fixture.request(2);
    let overlay = CompileOverlay {
        entry: Some(CompileOverlayEntry {
            document_id: request.document_id.clone(),
            document_version: request.document_version,
            bytes: entry_bytes,
        }),
        files: vec![CompileOverlayFile {
            path: RelativePath::parse("sections/child.tex").unwrap(),
            bytes: child_bytes,
        }],
    };
    let identity = service
        .start_with_overlay(&fixture.owner, request, overlay)
        .expect("start overlay compile");
    let delivery = service
        .wait_result_with_artifacts(&fixture.owner, &identity, Duration::from_secs(5))
        .expect("wait")
        .expect("delivery");
    assert!(matches!(delivery.result, CompileResult::Success { .. }));
    assert!(delivery.synctex.is_some());
    assert_eq!(
        fs::read(fixture.root.join("main.tex")).unwrap(),
        b"saved entry source\n"
    );
    assert_eq!(
        fs::read(fixture.root.join("sections").join("child.tex")).unwrap(),
        b"Nested input for the compile snapshot.\n"
    );
}

#[test]
fn test_changed_dependency_suppresses_success_and_synctex() {
    let _guard = TEST_LOCK.lock().unwrap();
    let dir = TestDirectory::new();
    let filesystem = new_filesystem(dir.path());
    let fixture = add_workspace(
        &filesystem,
        dir.path(),
        "stale-input-owner",
        "saved entry source\n",
    );
    let changed = fixture.root.join("sections").join("child.tex");
    let executor = Arc::new(MockProcessExecutor::new(move |invocation, _| {
        if let Some(parent) = invocation.output_pdf.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(&invocation.output_pdf, valid_pdf_bytes()).unwrap();
        fs::write(&invocation.engine_log, "compile completed\n").unwrap();
        write_valid_synctex(invocation);
        fs::write(&changed, b"changed outside captured snapshot\n").unwrap();
        Ok(ProcessOutput {
            pid: 1236,
            exit_code: 0,
            logs: ProcessLogs::default(),
            active_processes_after_exit: 0,
        })
    }));
    let service = CompileService::with_executor_for_test(
        filesystem,
        create_test_config(dir.path()),
        executor,
    )
    .expect("service");
    let identity = service
        .start(&fixture.owner, fixture.request(1))
        .expect("start");
    let delivery = service
        .wait_result_with_artifacts(&fixture.owner, &identity, Duration::from_secs(5))
        .expect("wait")
        .expect("delivery");
    assert!(matches!(delivery.result, CompileResult::Failure { .. }));
    assert!(delivery.synctex.is_none());
}

#[test]
fn test_invalid_tex_entry_is_rejected() {
    let _guard = TEST_LOCK.lock().unwrap();
    let dir = TestDirectory::new();
    let filesystem = new_filesystem(dir.path());
    let fixture = add_workspace(&filesystem, dir.path(), "invalid-owner", "entry\n");
    let service = CompileService::with_executor_for_test(
        filesystem,
        create_test_config(dir.path()),
        MockProcessExecutor::successful(valid_pdf_bytes(), "ok\n"),
    )
    .expect("service");
    let mut request = fixture.request(1);
    request.entry_path = RelativePath::parse("file.pdf").unwrap();
    assert_eq!(
        service.start(&fixture.owner, request).unwrap_err(),
        CompileServiceError::InvalidRequest("entryPath must name a TeX source")
    );
}

#[test]
fn test_cancelled_service_does_not_publish_success() {
    let _guard = TEST_LOCK.lock().unwrap();
    let dir = TestDirectory::new();
    let filesystem = new_filesystem(dir.path());
    let fixture = add_workspace(&filesystem, dir.path(), "cancel-owner", "saved source\n");
    let pair = Arc::new((Mutex::new(false), Condvar::new()));
    let entered = Arc::clone(&pair);
    let executor = Arc::new(MockProcessExecutor::new(move |_, cancellation| {
        let (lock, cvar) = &*entered;
        let mut started = lock.lock().unwrap();
        *started = true;
        cvar.notify_all();
        // Let the test observe entry and issue cancellation before waiting.
        drop(started);
        while !cancellation.is_cancelled() {
            thread::sleep(Duration::from_millis(10));
        }
        Err(ProcessError {
            kind: ProcessErrorKind::Cancelled,
            cause: None,
            detail: "cancelled".into(),
            exit_code: None,
            logs: ProcessLogs::default(),
            cleanup: CleanupProof::JobDrained,
            pending_cleanup: None,
        })
    }));
    let service = CompileService::with_executor_for_test(
        filesystem,
        create_test_config(dir.path()),
        executor,
    )
    .expect("service");
    let identity = service
        .start(&fixture.owner, fixture.request(1))
        .expect("start");
    {
        let (lock, cvar) = &*pair;
        let mut started = lock.lock().unwrap();
        while !*started {
            started = cvar.wait(started).unwrap();
        }
    }
    assert!(service.cancel(&fixture.owner, &identity).unwrap());
    let result = service
        .wait_result(&fixture.owner, &identity, Duration::from_secs(5))
        .expect("wait");
    assert!(matches!(result, Some(CompileResult::Cancelled { .. })));
}

#[test]
fn test_document_overlay_requires_matching_identity_and_version() {
    let request = CompileRequest {
        workspace_id: WorkspaceId::parse("ws-1").unwrap(),
        entry_path: RelativePath::parse("main.tex").unwrap(),
        document_id: DocumentId::parse("doc-1").unwrap(),
        document_version: DocumentVersion::new(2).unwrap(),
        saved_revision: crate::schemas::protocol::Revision::parse("rev-1").unwrap(),
        engine: Engine::System,
    };
    let overlay = CompileOverlay {
        entry: Some(CompileOverlayEntry {
            document_id: DocumentId::parse("doc-2").unwrap(),
            document_version: DocumentVersion::new(2).unwrap(),
            bytes: b"x".to_vec(),
        }),
        files: Vec::new(),
    };
    assert!(matches!(
        validate_overlay(&request, &overlay),
        Err(CompileServiceError::InvalidRequest(_))
    ));
}

#[test]
fn test_recover_after_panic_with_never_started_engine_drains_lease() {
    let _guard = TEST_LOCK.lock().unwrap();
    let dir = TestDirectory::new();
    let filesystem = new_filesystem(dir.path());
    let fixture = add_workspace(
        &filesystem,
        dir.path(),
        "panic-recovery-owner",
        "saved source\n",
    );
    let service = CompileService::with_executor_for_test(
        Arc::clone(&filesystem),
        create_test_config(dir.path()),
        MockProcessExecutor::successful(valid_pdf_bytes(), "ok\n"),
    )
    .expect("service");
    let request = fixture.request(1);
    let config = CompileWorkspaceConfig::default_for_request(&request);
    let profile = service
        .inner
        .resolve_profile(request.engine, &config, false)
        .expect("profile");
    let (cancellation, cancellation_token) = cancellation_pair();
    let run_id = RunId::parse("mtx-panic-recovery-1").expect("run_id");
    let identity = CompileIdentity {
        run_id: run_id.clone(),
        workspace_id: request.workspace_id.clone(),
        entry_path: request.entry_path.clone(),
        document_id: request.document_id.clone(),
        document_version: request.document_version,
        saved_revision: request.saved_revision.clone(),
    };
    let scope = RunScope {
        owner: fixture.owner.clone(),
        workspace_id: request.workspace_id.clone(),
        entry_path: request.entry_path.clone(),
        document_id: request.document_id.clone(),
    };
    let cancel_handle = cancellation.clone();
    let canceller: crate::services::filesystem::SubSystemCanceller = Box::new(move || {
        cancel_handle.cancel();
        Ok(())
    });
    let ticket = filesystem
        .prepare_compile(&fixture.owner, run_id.clone(), &request, canceller)
        .expect("prepare ticket");
    let drain_handle = ticket.drain_handle().expect("drain handle");
    let control = Arc::new(RunControl {
        owner: fixture.owner.clone(),
        identity: identity.clone(),
        request,
        scope: scope.clone(),
        profile,
        overlay: CompileOverlay::default(),
        workspace_config: config,
        cancellation,
        cancellation_token,
        cancel_reason: AtomicU8::new(CANCEL_NONE),
        publish_allowed: AtomicBool::new(true),
        admitted: AtomicBool::new(true),
        phase: AtomicU8::new(PHASE_RUNNING),
        engine_state: AtomicU8::new(ENGINE_NEVER_STARTED),
        preparation_result: Mutex::new(None),
        ticket: Mutex::new(Some(ticket)),
        drain_handle: Mutex::new(Some(drain_handle)),
        run_directory: Mutex::new(None),
        pending_process_error: Mutex::new(None),
        result: Mutex::new(None),
        synctex_result: Mutex::new(None),
        workspace_root_for_redaction: Mutex::new(None),
    });
    {
        let mut state = service.inner.lock_state();
        state.runs.insert(run_id.clone(), Arc::clone(&control));
        state.latest.insert(scope, run_id);
    }
    assert!(filesystem.has_undrained_cleanup(&fixture.workspace_id));
    let terminal = service.inner.recover_after_panic(&control);
    assert!(terminal);
    let result = service
        .take_result(&fixture.owner, &identity)
        .expect("take")
        .expect("result");
    assert!(matches!(result, CompileResult::Failure { .. }));
    assert!(!filesystem.has_undrained_cleanup(&fixture.workspace_id));
}

#[cfg(all(windows, target_arch = "x86_64"))]
mod native_tests {
    use super::*;

    static NATIVE_TEST_LOCK: Mutex<()> = Mutex::new(());

    // This test is also the real child executable for the native runner
    // regression below. Ordinary test-harness invocation has no `--`
    // separator and therefore performs no work.
    #[test]
    fn native_compile_helper() {
        let arguments = env::args_os().collect::<Vec<_>>();
        let Some(separator) = arguments
            .iter()
            .position(|argument| argument == std::ffi::OsStr::new("--"))
        else {
            return;
        };
        if arguments
            .get(separator + 1)
            .and_then(|value| value.to_str())
            != Some("write-pdf")
        {
            return;
        }
        let output = PathBuf::from(
            arguments
                .get(separator + 2)
                .expect("native compile helper output directory"),
        );
        fs::write(output.join("main.pdf"), valid_pdf_bytes())
            .expect("write native compile helper PDF");
        fs::write(
            output.join("main.log"),
            "native process-tree compile helper\n",
        )
        .expect("write native compile helper log");
    }

    #[test]
    fn native_process_tree_compile_releases_task_and_staging() {
        let _guard = NATIVE_TEST_LOCK.lock().unwrap();
        let dir = TestDirectory::new();
        let filesystem = new_filesystem(dir.path());
        let fixture = add_workspace(
            &filesystem,
            dir.path(),
            "native-runner-owner",
            "saved entry source\n",
        );
        let executable = env::current_exe().expect("native test executable");
        let profile = SystemProfile::new(
            SystemTool::TrustedCustom,
            executable,
            vec![
                SystemArgument::Literal(OsString::from("--exact")),
                SystemArgument::Literal(OsString::from(
                    "services::compile_service::tests::native_tests::native_compile_helper",
                )),
                SystemArgument::Literal(OsString::from("--nocapture")),
                SystemArgument::Literal(OsString::from("--")),
                SystemArgument::Literal(OsString::from("write-pdf")),
                SystemArgument::OutputDirectory,
                SystemArgument::EntryPath,
            ],
            Vec::new(),
            Vec::new(),
            Duration::from_secs(30),
            None,
        )
        .expect("valid test-only trusted helper profile");
        let temporary_root = dir.path().join("native-compile-temp");
        let config = TrustedCompileConfig::new(temporary_root.clone(), None, Some(profile))
            .expect("trusted test configuration");
        let service =
            CompileService::new(Arc::clone(&filesystem), config).expect("native compile service");

        let identity = service
            .start(&fixture.owner, fixture.request(1))
            .expect("start native process-tree compile");
        let result = service
            .wait_result(&fixture.owner, &identity, Duration::from_secs(45))
            .expect("wait for native process-tree compile")
            .expect("native compile result");
        assert!(
            matches!(result, CompileResult::Success { .. }),
            "native runner result: {result:?}"
        );
        assert!(!filesystem.has_undrained_cleanup(&fixture.workspace_id));
        assert!(
            fs::read_dir(&temporary_root)
                .expect("inspect compile staging root")
                .next()
                .is_none(),
            "native compile staging directory must be removed before settlement"
        );
    }

    #[test]
    fn vendor_tectonic_compiles_and_reuses_test_owned_warm_cache() {
        let _guard = NATIVE_TEST_LOCK.lock().unwrap();
        let dir = TestDirectory::new();
        let filesystem = new_filesystem(dir.path());
        let fixture = add_workspace(
                &filesystem,
                dir.path(),
                "vendor-tectonic-owner",
                "\\documentclass{article}\n\\begin{document}\nG3 native integration.\n\\end{document}\n",
            );
        let executable = fixed_vendor_tectonic();
        assert!(
            executable.is_file(),
            "fixed vendor Tectonic executable is missing: {}",
            executable.display()
        );

        // Keep mutable engine cache state under this test's isolated directory.
        // The first real compile warms it; the second verifies warm-timeout selection.
        let cache = dir.path().join("tectonic-cache");
        fs::create_dir(&cache).expect("create test-owned Tectonic cache");
        let temporary_root = dir.path().join("tectonic-compile-temp");
        let first_profile =
            ManagedProfile::new(executable.clone(), cache.clone(), Vec::new(), Vec::new())
                .expect("fixed vendor managed profile");
        let first_config =
            TrustedCompileConfig::new(temporary_root.clone(), Some(first_profile), None)
                .expect("first managed configuration");
        let first_service = CompileService::new(Arc::clone(&filesystem), first_config)
            .expect("first managed compile service");
        let mut first_request = fixture.request(1);
        first_request.engine = Engine::Managed;
        let first_identity = first_service
            .start(&fixture.owner, first_request)
            .expect("start first vendor Tectonic compile");
        let first_result = first_service
            .wait_result(&fixture.owner, &first_identity, Duration::from_secs(360))
            .expect("wait for first vendor Tectonic compile")
            .expect("first vendor Tectonic result");
        assert!(
            matches!(first_result, CompileResult::Success { .. }),
            "first vendor Tectonic result: {first_result:?}"
        );
        assert!(
            has_cached_latex_format(&cache).expect("inspect verified Tectonic cache"),
            "the first compile must populate test-owned warm-format evidence"
        );
        drop(first_service);

        let warm_profile = ManagedProfile::new(executable, cache.clone(), Vec::new(), Vec::new())
            .expect("fixed vendor managed profile")
            .with_timeouts(Duration::from_millis(1), Duration::from_secs(120))
            .expect("bounded test-only warm timeout");
        let warm_config =
            TrustedCompileConfig::new(temporary_root.clone(), Some(warm_profile), None)
                .expect("warm managed configuration");
        let warm_service = CompileService::new(Arc::clone(&filesystem), warm_config)
            .expect("warm managed compile service");
        let mut warm_request = fixture.request(2);
        warm_request.engine = Engine::Managed;
        let warm_identity = warm_service
            .start(&fixture.owner, warm_request)
            .expect("start warm vendor Tectonic compile");
        let warm_result = warm_service
            .wait_result(&fixture.owner, &warm_identity, Duration::from_secs(150))
            .expect("wait for warm vendor Tectonic compile")
            .expect("warm vendor Tectonic result");
        assert!(
            matches!(warm_result, CompileResult::Success { .. }),
            "warm vendor Tectonic result: {warm_result:?}"
        );
        assert!(!filesystem.has_undrained_cleanup(&fixture.workspace_id));
        assert!(
            fs::read_dir(&temporary_root)
                .expect("inspect Tectonic staging root")
                .next()
                .is_none(),
            "Tectonic staging directory must be removed before settlement"
        );
    }
}

#[test]
fn custom_executable_resolution_accepts_bare_names_and_quoted_absolute_paths() {
    let dir = TestDirectory::new();
    let bin = dir.path().join("owned custom tools");
    fs::create_dir_all(&bin).expect("create owned executable directory");
    let test_executable = env::current_exe().expect("test executable");
    let latexmk = bin.join("latexmk.exe");
    let lualatex = bin.join("lualatex.EXE");
    fs::copy(&test_executable, &latexmk).expect("create owned latexmk executable fixture");
    fs::copy(&test_executable, &lualatex).expect("create owned lualatex executable fixture");
    let path_value = bin.as_os_str();

    let trusted_latexmk = resolve_trusted_executable(&latexmk).expect("trusted latexmk fixture");
    assert_eq!(
        resolve_custom_executable("latexmk", Some(path_value)).unwrap(),
        trusted_latexmk
    );
    assert_eq!(
        resolve_custom_executable("latexmk.exe", Some(path_value)).unwrap(),
        trusted_latexmk
    );

    let trusted_lualatex = resolve_trusted_executable(&lualatex).expect("trusted lualatex fixture");
    assert_eq!(
        resolve_custom_executable("lualatex", Some(path_value)).unwrap(),
        trusted_lualatex
    );
    assert_eq!(
        resolve_custom_executable("lualatex.EXE", Some(path_value)).unwrap(),
        trusted_lualatex
    );

    let command = format!("\"{}\" {{out}} {{main}}", lualatex.display());
    let _profile =
        custom_system_profile(&command).expect("quoted absolute executable path with spaces");
}

#[test]
fn custom_executable_resolution_rejects_relative_paths_and_scripts() {
    let dir = TestDirectory::new();
    let bin = dir.path().join("owned executables");
    fs::create_dir_all(&bin).expect("create owned executable directory");
    let script = bin.join("compile.cmd");
    fs::write(&script, b"@echo off\n").expect("create owned script fixture");

    assert!(matches!(
        resolve_custom_executable(r".\compile.exe", Some(bin.as_os_str())),
        Err(CompileServiceError::InvalidConfiguration(
            "custom executable must be absolute or a PATH name"
        ))
    ));
    assert!(matches!(
        resolve_custom_executable("compile.cmd", Some(bin.as_os_str())),
        Err(CompileServiceError::InvalidConfiguration(
            "custom executable must be a native Windows executable"
        ))
    ));
    assert!(matches!(
        resolve_custom_executable(script.to_str().unwrap(), Some(bin.as_os_str())),
        Err(CompileServiceError::InvalidConfiguration(
            "custom executable must be a native Windows executable"
        ))
    ));

    let name = format!("modutex-owned-{}.exe", Uuid::new_v4().simple());
    fs::copy(
        env::current_exe().expect("test executable"),
        bin.join(&name),
    )
    .expect("create owned current-directory lookup fixture");
    let bare_name = name.strip_suffix(".exe").unwrap();
    assert!(matches!(
        resolve_custom_executable(bare_name, Some(std::ffi::OsStr::new("."))),
        Err(CompileServiceError::InvalidConfiguration(
            "custom executable is missing or unsafe"
        ))
    ));
}
