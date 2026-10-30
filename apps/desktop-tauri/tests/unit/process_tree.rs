// SPDX-License-Identifier: Apache-2.0
#[test]
fn limits_enforce_32_mib_boundary() {
    let valid = ProcessSpec::new(
        PathBuf::new(),
        PathBuf::new(),
        Vec::new(),
        Duration::from_secs(1),
        32 * 1024 * 1024,
    );
    assert!(validate_limits(&valid).is_ok());

    let invalid = ProcessSpec::new(
        PathBuf::new(),
        PathBuf::new(),
        Vec::new(),
        Duration::from_secs(1),
        32 * 1024 * 1024 + 1,
    );
    assert_eq!(
        validate_limits(&invalid).err().map(|e| e.kind),
        Some(ProcessErrorKind::InvalidLogLimit)
    );
}

use super::*;

#[test]
fn cancellation_is_monotonic_and_idempotent() {
    let (handle, token) = cancellation_pair();
    assert!(!token.is_cancelled());
    handle.cancel();
    handle.cancel();
    assert!(token.is_cancelled());
}

#[test]
fn limits_reject_zero_timeout_and_unbounded_retention() {
    let invalid_timeout = ProcessSpec::new(
        PathBuf::new(),
        PathBuf::new(),
        Vec::new(),
        Duration::ZERO,
        1,
    );
    assert_eq!(
        validate_limits(&invalid_timeout)
            .err()
            .map(|error| error.kind),
        Some(ProcessErrorKind::InvalidTimeout)
    );

    let unbounded_log = ProcessSpec::new(
        PathBuf::new(),
        PathBuf::new(),
        Vec::new(),
        Duration::from_secs(1),
        MAX_LOG_BYTES_PER_STREAM + 1,
    );
    assert_eq!(
        validate_limits(&unbounded_log)
            .err()
            .map(|error| error.kind),
        Some(ProcessErrorKind::InvalidLogLimit)
    );
    #[cfg(not(all(windows, target_arch = "x86_64")))]
    assert_eq!(
        ProcessError::simple(ProcessErrorKind::UnsupportedPlatform, "unsupported").kind,
        ProcessErrorKind::UnsupportedPlatform
    );
}

#[cfg(all(windows, target_arch = "x86_64"))]
mod native {
    use super::*;
    use std::{
        fs,
        io::Write,
        os::windows::ffi::OsStrExt,
        process::{Command, Stdio},
        sync::{
            atomic::{AtomicUsize, Ordering},
            mpsc,
        },
        thread,
        time::Instant,
    };

    // Keep this exact name in sync with the helper test: a stale filter can
    // leave a nested libtest process waiting without ever writing its marker.
    const HELPER_FILTER: &str = "platform::process_tree::tests::native::helper_entry";
    static NEXT_DIRECTORY: AtomicUsize = AtomicUsize::new(1);

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            for _ in 0..128 {
                let number = NEXT_DIRECTORY.fetch_add(1, Ordering::Relaxed);
                let path = std::env::temp_dir().join(format!(
                    "modutex-process-tree-{}-{number}",
                    std::process::id()
                ));
                match fs::create_dir(&path) {
                    Ok(()) => return Self(path),
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                    Err(error) => panic!("create test directory: {error}"),
                }
            }
            panic!("could not allocate a unique process-tree test directory")
        }

        fn path(&self) -> &std::path::Path {
            &self.0
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn helper_spec(
        directory: &TestDirectory,
        mode: &str,
        extra: &[OsString],
        timeout: Duration,
        log_limit: usize,
    ) -> ProcessSpec {
        let executable = std::env::current_exe().expect("current test executable");
        let mut arguments = vec![
            OsString::from("--exact"),
            OsString::from(HELPER_FILTER),
            OsString::from("--nocapture"),
            OsString::from("--test-threads=1"),
            OsString::from("--"),
            OsString::from(mode),
        ];
        arguments.extend_from_slice(extra);
        ProcessSpec::new(
            executable,
            directory.path().to_path_buf(),
            arguments,
            timeout,
            log_limit,
        )
    }

    /// Bounded differential diagnostic comparing startup flag variants.
    /// Production uses STARTF_USESTDHANDLES with CREATE_NO_WINDOW.
    /// OldWindowHint serves as an explicit bounded negative control demonstrating
    /// that STARTF_USESHOWWINDOW stalls Rust libtest.
    #[test]
    fn reviewer_libtest_list_startup_flag_variants_are_diagnostic() {
        let directory = TestDirectory::new();
        let executable = std::env::current_exe().expect("current test executable");
        let args = vec![OsString::from("--list"), OsString::from("--nocapture")];
        let spec = ProcessSpec::new(
            executable.clone(),
            directory.path().to_path_buf(),
            args.clone(),
            Duration::from_secs(5),
            256 * 1024,
        );
        let negative_spec = ProcessSpec::new(
            executable,
            directory.path().to_path_buf(),
            args,
            Duration::from_secs(2),
            256 * 1024,
        );
        let prefix =
            |bytes: &[u8]| String::from_utf8_lossy(&bytes[..bytes.len().min(256)]).into_owned();
        let mut production_passed = false;
        let mut without_create_no_window_passed = false;
        let mut outcomes = Vec::new();

        // 1. Production variant: STARTF_USESTDHANDLES + CREATE_NO_WINDOW
        {
            let (_, token) = cancellation_pair();
            match windows_impl::test_hooks::run_with_startup_variant(
                &spec,
                &token,
                windows_impl::StartupVariant::Production,
            ) {
                Ok(output) => {
                    let listed_helper =
                        String::from_utf8_lossy(&output.logs.stdout).contains(HELPER_FILTER);
                    production_passed = output.exit_code == 0
                        && output.active_processes_after_exit == 0
                        && listed_helper;
                    outcomes.push(format!(
							"Production: success={production_passed}, exit={}, active={}, stdout={}, stderr={}, listed_helper={listed_helper}, stdout_prefix={:?}, stderr_prefix={:?}",
							output.exit_code,
							output.active_processes_after_exit,
							output.logs.stdout.len(),
							output.logs.stderr.len(),
							prefix(&output.logs.stdout),
							prefix(&output.logs.stderr),
						));
                }
                Err(error) => {
                    outcomes.push(format!(
							"Production: kind={:?}, detail={}, exit={:?}, stdout={}, stderr={}, cleanup={:?}, stdout_prefix={:?}, stderr_prefix={:?}",
							error.kind,
							error.detail,
							error.exit_code,
							error.logs.stdout.len(),
							error.logs.stderr.len(),
							error.cleanup,
							prefix(&error.logs.stdout),
							prefix(&error.logs.stderr),
						));
                }
            }
        }

        // 2. WithoutCreateNoWindow variant: STARTF_USESTDHANDLES only (no CREATE_NO_WINDOW)
        {
            let (_, token) = cancellation_pair();
            match windows_impl::test_hooks::run_with_startup_variant(
                &spec,
                &token,
                windows_impl::StartupVariant::WithoutCreateNoWindow,
            ) {
                Ok(output) => {
                    let listed_helper =
                        String::from_utf8_lossy(&output.logs.stdout).contains(HELPER_FILTER);
                    without_create_no_window_passed = output.exit_code == 0
                        && output.active_processes_after_exit == 0
                        && listed_helper;
                    outcomes.push(format!(
							"WithoutCreateNoWindow: success={without_create_no_window_passed}, exit={}, active={}, stdout={}, stderr={}, listed_helper={listed_helper}, stdout_prefix={:?}, stderr_prefix={:?}",
							output.exit_code,
							output.active_processes_after_exit,
							output.logs.stdout.len(),
							output.logs.stderr.len(),
							prefix(&output.logs.stdout),
							prefix(&output.logs.stderr),
						));
                }
                Err(error) => {
                    outcomes.push(format!(
							"WithoutCreateNoWindow: kind={:?}, detail={}, exit={:?}, stdout={}, stderr={}, cleanup={:?}, stdout_prefix={:?}, stderr_prefix={:?}",
							error.kind,
							error.detail,
							error.exit_code,
							error.logs.stdout.len(),
							error.logs.stderr.len(),
							error.cleanup,
							prefix(&error.logs.stdout),
							prefix(&error.logs.stderr),
						));
                }
            }
        }

        // 3. OldWindowHint variant: bounded negative control with STARTF_USESHOWWINDOW
        {
            let (_, token) = cancellation_pair();
            match windows_impl::test_hooks::run_with_startup_variant(
                &negative_spec,
                &token,
                windows_impl::StartupVariant::OldWindowHint,
            ) {
                Ok(output) => {
                    let listed_helper =
                        String::from_utf8_lossy(&output.logs.stdout).contains(HELPER_FILTER);
                    let success = output.exit_code == 0
                        && output.active_processes_after_exit == 0
                        && listed_helper;
                    outcomes.push(format!(
							"OldWindowHint: observational_success={success}, exit={}, active={}, stdout={}, stderr={}, listed_helper={listed_helper}, stdout_prefix={:?}, stderr_prefix={:?}",
							output.exit_code,
							output.active_processes_after_exit,
							output.logs.stdout.len(),
							output.logs.stderr.len(),
							prefix(&output.logs.stdout),
							prefix(&output.logs.stderr),
						));
                }
                Err(error) => {
                    outcomes.push(format!(
							"OldWindowHint: observational_failure, kind={:?}, detail={}, exit={:?}, stdout={}, stderr={}, cleanup={:?}, stdout_prefix={:?}, stderr_prefix={:?}",
							error.kind,
							error.detail,
							error.exit_code,
							error.logs.stdout.len(),
							error.logs.stderr.len(),
							error.cleanup,
							prefix(&error.logs.stdout),
							prefix(&error.logs.stderr),
						));
                }
            }
        }

        assert!(
            production_passed,
            "Production startup flags must succeed libtest listing: {}",
            outcomes.join(" | ")
        );
        assert!(
            without_create_no_window_passed,
            "WithoutCreateNoWindow startup flags must succeed libtest listing: {}",
            outcomes.join(" | ")
        );
    }

    fn spawn_run(
        spec: ProcessSpec,
        token: CancellationToken,
    ) -> (
        std::sync::mpsc::Receiver<Result<ProcessOutput, ProcessError>>,
        thread::JoinHandle<()>,
    ) {
        let (sender, receiver) = mpsc::sync_channel(1);
        let worker = thread::spawn(move || {
            let result = run(&spec, &token);
            let _ = sender.send(result);
        });
        (receiver, worker)
    }

    #[test]
    fn helper_entry() {
        let arguments: Vec<OsString> = std::env::args_os().collect();
        let separator = match arguments
            .iter()
            .position(|argument| argument == std::ffi::OsStr::new("--"))
        {
            Some(index) => index,
            None => return,
        };
        let mode = match arguments
            .get(separator + 1)
            .and_then(|value| value.to_str())
        {
            Some(mode) => mode,
            None => return,
        };
        match mode {
            "touch" => {
                let path = match arguments.get(separator + 2) {
                    Some(path) => PathBuf::from(path),
                    None => std::process::exit(71),
                };
                if fs::write(path, b"spawned").is_err() {
                    std::process::exit(72);
                }
            }
            "stdio" => {
                let marker = match arguments.get(separator + 2) {
                    Some(path) => PathBuf::from(path),
                    None => std::process::exit(81),
                };
                if fs::write(marker, b"stdio helper entered").is_err() {
                    std::process::exit(82);
                }
                let mut stdout = std::io::stdout().lock();
                let mut stderr = std::io::stderr().lock();
                if stdout.write_all(b"MODUTEX_STDOUT_PIPE_TOKEN\n").is_err()
                    || stdout.flush().is_err()
                {
                    std::process::exit(83);
                }
                if stderr.write_all(b"MODUTEX_STDERR_PIPE_TOKEN\n").is_err()
                    || stderr.flush().is_err()
                {
                    std::process::exit(84);
                }
            }
            "exit" => {
                let code = arguments
                    .get(separator + 2)
                    .and_then(|value| value.to_str())
                    .and_then(|value| value.parse::<i32>().ok())
                    .unwrap_or(73);
                std::process::exit(code);
            }
            "sleep" | "sleep-child" => loop {
                thread::sleep(Duration::from_secs(30));
            },
            "large" => {
                if let Some(marker) = arguments.get(separator + 2) {
                    let _ = fs::write(marker, b"entered-large");
                }
                let stdout = std::io::stdout();
                let stderr = std::io::stderr();
                let mut stdout = stdout.lock();
                let mut stderr = stderr.lock();
                let out_block = [b'O'; 8192];
                let err_block = [b'E'; 8192];
                for _ in 0..128 {
                    if stdout.write_all(&out_block).is_err() {
                        return;
                    }
                }
                for _ in 0..128 {
                    if stderr.write_all(&err_block).is_err() {
                        return;
                    }
                }
                let _ = stdout.flush();
                let _ = stderr.flush();
            }
            "leader-descendant" => {
                let marker = match arguments.get(separator + 2) {
                    Some(path) => PathBuf::from(path),
                    None => std::process::exit(74),
                };
                let executable = match std::env::current_exe() {
                    Ok(path) => path,
                    Err(_) => std::process::exit(75),
                };
                let spawned = Command::new(executable)
                    .arg("--exact")
                    .arg(HELPER_FILTER)
                    .arg("--nocapture")
                    .arg("--")
                    .arg("sleep-child")
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn();
                if spawned.is_err() {
                    std::process::exit(76);
                }
                if fs::write(marker, b"leader is exiting").is_err() {
                    std::process::exit(77);
                }
                std::process::exit(0);
            }
            "env" => {
                let var_name = match arguments.get(separator + 2) {
                    Some(var) => var,
                    None => std::process::exit(78),
                };
                let expected_val = match arguments.get(separator + 3) {
                    Some(val) => val,
                    None => std::process::exit(79),
                };
                let actual_val = std::env::var_os(var_name).unwrap_or_default();
                std::process::exit(if actual_val == *expected_val { 0 } else { 80 });
            }
            _ => {}
        }
    }

    #[test]
    fn canonical_long_unicode_working_directory_runs_unchanged_helper() {
        let directory = TestDirectory::new();
        let mut working_directory = directory.path().to_path_buf();
        for index in 0..8 {
            working_directory.push(format!("資料{index}-{}", "x".repeat(32)));
            fs::create_dir(&working_directory).expect("create long Unicode working directory");
        }
        assert!(working_directory.as_os_str().encode_wide().count() > 260);

        let marker = directory
            .path()
            .join("long-working-directory-helper-marker");
        let extra = [marker.as_os_str().to_os_string()];
        let mut spec = helper_spec(
            &directory,
            "touch",
            &extra,
            Duration::from_secs(5),
            64 * 1024,
        );
        spec.working_directory = working_directory;

        let (_, token) = cancellation_pair();
        let output = run(&spec, &token).expect("unchanged native helper should launch");
        assert_eq!(output.exit_code, 0);
        assert_eq!(output.active_processes_after_exit, 0);
        assert!(
            String::from_utf8_lossy(&output.logs.stdout).contains(HELPER_FILTER),
            "the existing helper test must be selected"
        );
        assert_eq!(fs::read(&marker).expect("helper entry marker"), b"spawned");
    }

    #[test]
    fn self_hosted_helper_filter_executes_marker_mode() {
        let directory = TestDirectory::new();
        let marker = directory.path().join("helper-marker");
        let extra = [marker.as_os_str().to_os_string()];
        let spec = helper_spec(
            &directory,
            "touch",
            &extra,
            Duration::from_secs(5),
            64 * 1024,
        );
        let (_, token) = cancellation_pair();
        let output = run(&spec, &token).expect("exactly selected helper should run");

        assert_eq!(output.exit_code, 0);
        assert_eq!(output.active_processes_after_exit, 0);
        assert_eq!(fs::read(&marker).expect("helper marker"), b"spawned");
    }

    #[test]
    fn reviewer_same_helper_with_explicit_environment_enters_before_deadline() {
        let directory = TestDirectory::new();
        let marker = directory.path().join("explicit-environment-helper-marker");
        let extra = [marker.as_os_str().to_os_string()];
        let spec = helper_spec(&directory, "touch", &extra, Duration::from_secs(5), 65536)
            .with_environment(std::env::vars_os().collect());
        let (_, token) = cancellation_pair();
        let output =
            run(&spec, &token).expect("same native helper with explicit inherited environment");
        assert_eq!(output.exit_code, 0);
        assert_eq!(output.active_processes_after_exit, 0);
        assert_eq!(fs::read(&marker).expect("helper entry marker"), b"spawned");
    }

    #[test]
    fn reviewer_same_helper_without_single_thread_flag_enters_before_deadline() {
        let directory = TestDirectory::new();
        let marker = directory.path().join("default-thread-helper-marker");
        let extra = [marker.as_os_str().to_os_string()];
        let mut spec = helper_spec(&directory, "touch", &extra, Duration::from_secs(5), 65536);
        spec.arguments
            .retain(|value| value != std::ffi::OsStr::new("--test-threads=1"));
        let (_, token) = cancellation_pair();
        let output = run(&spec, &token).expect("same helper with default libtest threading");
        assert_eq!(output.exit_code, 0);
        assert_eq!(output.active_processes_after_exit, 0);
        assert_eq!(fs::read(&marker).expect("helper entry marker"), b"spawned");
    }

    #[test]
    fn self_hosted_helper_receives_and_writes_both_inherited_pipe_handles() {
        let directory = TestDirectory::new();
        let marker = directory.path().join("stdio-marker");
        let extra = [marker.as_os_str().to_os_string()];
        let spec = helper_spec(
            &directory,
            "stdio",
            &extra,
            Duration::from_secs(10),
            64 * 1024,
        );
        let (_, token) = cancellation_pair();
        let output = run(&spec, &token).expect("self-hosted stdio helper should finish");

        assert_eq!(output.exit_code, 0);
        assert_eq!(output.active_processes_after_exit, 0);
        assert_eq!(
            fs::read(&marker).expect("helper entry marker"),
            b"stdio helper entered"
        );
        let stdout_token = b"MODUTEX_STDOUT_PIPE_TOKEN\n";
        let stderr_token = b"MODUTEX_STDERR_PIPE_TOKEN\n";
        assert!(output
            .logs
            .stdout
            .windows(stdout_token.len())
            .any(|window| window == stdout_token));
        assert!(output
            .logs
            .stderr
            .windows(stderr_token.len())
            .any(|window| window == stderr_token));
    }

    #[test]
    fn cancellation_before_spawn_never_starts_the_helper() {
        let directory = TestDirectory::new();
        let marker = directory.path().join("must-not-exist");
        let extra = [marker.as_os_str().to_os_string()];
        let spec = helper_spec(
            &directory,
            "touch",
            &extra,
            Duration::from_secs(3),
            64 * 1024,
        );
        let (handle, token) = cancellation_pair();
        handle.cancel();
        let error = run(&spec, &token).expect_err("cancelled before spawn");
        assert_eq!(error.kind, ProcessErrorKind::Cancelled);
        assert_eq!(error.cleanup, CleanupProof::NotRequired);
        assert!(!error.has_pending_cleanup());
        assert!(!marker.exists());
    }

    #[test]
    fn missing_executable_is_rejected_before_spawn() {
        let directory = TestDirectory::new();
        let spec = ProcessSpec::new(
            directory.path().join("missing-engine.exe"),
            directory.path().to_path_buf(),
            Vec::new(),
            Duration::from_secs(1),
            64 * 1024,
        );
        let (_, token) = cancellation_pair();
        let error = run(&spec, &token).expect_err("missing executable");
        assert_eq!(error.kind, ProcessErrorKind::InvalidExecutable);
        assert_eq!(error.cleanup, CleanupProof::NotRequired);
        assert!(!error.has_pending_cleanup());
    }

    #[test]
    fn nonzero_exit_is_reported_after_verified_job_drain() {
        let directory = TestDirectory::new();
        let spec = helper_spec(
            &directory,
            "exit",
            &[OsString::from("7")],
            Duration::from_secs(5),
            64 * 1024,
        );
        let (_, token) = cancellation_pair();
        let error = run(&spec, &token).expect_err("nonzero child result");
        assert_eq!(error.kind, ProcessErrorKind::NonZeroExit);
        assert_eq!(error.exit_code, Some(7));
        assert_eq!(error.cleanup, CleanupProof::JobDrained);
        assert!(!error.has_pending_cleanup());
    }

    #[test]
    fn timeout_kills_and_drains_the_tree() {
        let directory = TestDirectory::new();
        let spec = helper_spec(
            &directory,
            "sleep",
            &[],
            Duration::from_millis(250),
            64 * 1024,
        );
        let (_, token) = cancellation_pair();
        let started = Instant::now();
        let error = run(&spec, &token).expect_err("deadline should expire");
        assert!(started.elapsed() >= Duration::from_millis(200));
        assert_eq!(error.kind, ProcessErrorKind::DeadlineExceeded);
        assert_eq!(error.cleanup, CleanupProof::JobDrained);
        assert!(!error.has_pending_cleanup());
    }

    #[test]
    fn both_large_streams_are_drained_concurrently() {
        let directory = TestDirectory::new();
        let marker = directory.path().join("large-marker");
        let extra = [marker.as_os_str().to_os_string()];
        let spec = helper_spec(
            &directory,
            "large",
            &extra,
            Duration::from_secs(10),
            2 * 1024 * 1024,
        );
        let (_, token) = cancellation_pair();
        let result = run(&spec, &token);
        let stage = fs::read_to_string(&marker).unwrap_or_else(|e| format!("no-marker:{e}"));
        let _ = fs::remove_file(&marker);
        let output = result.unwrap_or_else(|e| {
            panic!(
                "stage={stage}; kind={:?}; detail={}; stdout={}; stderr={}; cleanup={:?}",
                e.kind,
                e.detail,
                e.logs.stdout.len(),
                e.logs.stderr.len(),
                e.cleanup
            )
        });
        assert_eq!(stage, "entered-large");
        let payload_len = 1024 * 1024;
        assert!(output.pid != 0);
        assert_eq!(output.exit_code, 0);
        // The self-hosted Rust libtest executable wraps `helper_entry` stdout
        // with its test-runner banner while leaving the 1 MiB payload intact.
        let o_start = output
            .logs
            .stdout
            .iter()
            .position(|byte| *byte == b'O')
            .expect("stdout payload start");
        assert!(output.logs.stdout.len() >= o_start + payload_len);
        assert!(output.logs.stdout[o_start..o_start + payload_len]
            .iter()
            .all(|byte| *byte == b'O'));
        assert_eq!(
            output
                .logs
                .stdout
                .iter()
                .filter(|&&byte| byte == b'O')
                .count(),
            payload_len
        );
        assert_eq!(output.logs.stderr.len(), payload_len);
        assert!(output.logs.stderr.iter().all(|byte| *byte == b'E'));
        assert!(!output.logs.stdout_truncated);
        assert!(!output.logs.stderr_truncated);
        assert_eq!(output.active_processes_after_exit, 0);
    }

    #[test]
    fn log_overflow_is_failure_not_success() {
        let directory = TestDirectory::new();
        let marker = directory.path().join("overflow-marker");
        let extra = [marker.as_os_str().to_os_string()];
        let spec = helper_spec(&directory, "large", &extra, Duration::from_secs(10), 4096);
        let (_, token) = cancellation_pair();
        let error = run(&spec, &token).expect_err("overflow must fail");
        assert_eq!(error.kind, ProcessErrorKind::OutputLimitExceeded);
        assert_eq!(error.cleanup, CleanupProof::JobDrained);
        assert!(error.logs.stdout_truncated || error.logs.stderr_truncated);
    }

    #[test]
    fn cancellation_after_leader_exit_kills_its_descendant() {
        let directory = TestDirectory::new();
        let marker = directory.path().join("leader-ready");
        let extra = [marker.as_os_str().to_os_string()];
        let spec = helper_spec(
            &directory,
            "leader-descendant",
            &extra,
            Duration::from_secs(15),
            64 * 1024,
        );
        let (handle, token) = cancellation_pair();
        let (receiver, worker) = spawn_run(spec, token);
        let marker_deadline = Instant::now() + Duration::from_secs(5);
        while !marker.exists() && Instant::now() < marker_deadline {
            thread::sleep(Duration::from_millis(10));
        }
        assert!(marker.exists(), "leader did not launch its descendant");
        // The helper writes the marker immediately before exiting. Allow the
        // leader to exit while its sleeping descendant remains in the job.
        thread::sleep(Duration::from_millis(200));
        handle.cancel();
        let result = receiver
            .recv_timeout(Duration::from_secs(15))
            .expect("process-tree cancellation result");
        assert!(worker.join().is_ok());
        let error = result.expect_err("descendant must keep the run unsettled");
        assert_eq!(error.kind, ProcessErrorKind::Cancelled);
        assert_eq!(error.cleanup, CleanupProof::JobDrained);
    }

    #[test]
    fn pending_cleanup_ticket_supports_cancel_retry_and_supervised_drop() {
        let directory = TestDirectory::new();
        let spec = helper_spec(&directory, "sleep", &[], Duration::from_secs(10), 64 * 1024);
        let mut error = windows_impl::test_hooks::spawn_unproven_cleanup_error(&spec)
            .expect("spawn unproven cleanup error");
        assert_eq!(error.kind, ProcessErrorKind::CleanupFailed);
        assert_eq!(error.cause, Some(ProcessErrorKind::DeadlineExceeded));
        assert_eq!(error.cleanup, CleanupProof::Failed);
        assert!(error.has_pending_cleanup());

        // Cancelled drain preserves the ticket on `error` so caller keeps lease.
        let (cancel_handle, cancel_token) = cancellation_pair();
        cancel_handle.cancel();
        assert!(error
            .drain_cleanup(&cancel_token, Duration::from_millis(50))
            .is_err());
        assert_eq!(error.cleanup, CleanupProof::Failed);
        assert!(error.has_pending_cleanup());

        // Retry resolves the ticket and upgrades proof to JobDrained.
        let proof = error
            .retry_cleanup(Duration::from_secs(5))
            .expect("retry cleanup should drain");
        assert_eq!(proof, CleanupProof::JobDrained);
        assert_eq!(error.cleanup, CleanupProof::JobDrained);
        assert!(!error.has_pending_cleanup());

        // Dropping an unresolved ticket transfers ownership to bounded host
        // supervision without detaching threads or leaking handles.
        let dropped_error = windows_impl::test_hooks::spawn_unproven_cleanup_error(&spec)
            .expect("spawn second unproven cleanup error");
        assert!(dropped_error.has_pending_cleanup());
        drop(dropped_error);
    }

    #[test]
    fn pending_cleanup_keeps_scratch_until_drain_for_retry_and_supervised_drop() {
        for supervised in [false, true] {
            let directory = TestDirectory::new();
            let scratch = directory.path().join("scratch");
            std::fs::create_dir(&scratch).unwrap();
            std::fs::write(scratch.join("input.tex"), b"retained input").unwrap();
            let spec = helper_spec(&directory, "sleep", &[], Duration::from_secs(10), 64 * 1024);
            let mut error = windows_impl::test_hooks::spawn_unproven_cleanup_error(&spec)
                .expect("spawn real child with unresolved cleanup ownership");
            let mut ticket = error.take_pending_cleanup().expect("live cleanup ticket");
            let (sender, receiver) = std::sync::mpsc::channel();
            let owned_scratch = scratch.clone();
            ticket.on_drained(move || {
                let result = std::fs::remove_dir_all(owned_scratch);
                let _ = sender.send(result);
            });
            assert!(!ticket.is_drained());
            assert!(scratch.join("input.tex").exists());
            assert!(matches!(
                receiver.try_recv(),
                Err(std::sync::mpsc::TryRecvError::Empty)
            ));
            if supervised {
                drop(ticket);
            } else {
                ticket
                    .retry(Duration::from_secs(5))
                    .expect("terminate and drain child");
                assert!(ticket.is_drained());
                drop(ticket);
            }
            receiver
                .recv_timeout(Duration::from_secs(5))
                .expect("drained callback must run after either cleanup path")
                .expect("scratch cleanup succeeds");
            assert!(!scratch.exists());
            assert!(matches!(
                receiver.try_recv(),
                Err(std::sync::mpsc::TryRecvError::Disconnected)
            ));
        }
    }

    #[test]
    fn explicit_environment_is_propagated_to_child() {
        let executable = std::env::current_exe().expect("current test executable");
        let key = OsString::from("MODUTEX_PROCESS_TREE_PROPAGATION_TEST");
        let val = OsString::from("VerifiedNativeEnvValue42");
        let arguments = vec![
            OsString::from("--exact"),
            OsString::from(HELPER_FILTER),
            OsString::from("--nocapture"),
            OsString::from("--"),
            OsString::from("env"),
            key.clone(),
            val.clone(),
        ];
        let spec = ProcessSpec::new(
            executable,
            std::env::temp_dir(),
            arguments,
            Duration::from_secs(5),
            64 * 1024,
        )
        .with_environment(vec![(key, val)]);
        let (_, token) = cancellation_pair();
        let output = run(&spec, &token).expect("env propagation run");
        assert_eq!(output.exit_code, 0);
        assert_eq!(output.active_processes_after_exit, 0);
    }

    #[test]
    fn environment_block_handles_empty_double_nul_and_per_drive_and_ordinal_sort() {
        let key_lower = OsString::from("modutex_unicode_test_path");
        let val_1 = OsString::from("ValueA");
        let key_upper = OsString::from("MODUTEX_UNICODE_TEST_PATH");
        let val_2 = OsString::from("ValueB");
        let drive_key = OsString::from("=C:");
        let drive_val = OsString::from(r"C:\Windows\System32");

        let block = windows_impl::test_hooks::test_environment_block(&[
            (key_lower, val_1),
            (key_upper, val_2.clone()),
            (drive_key.clone(), drive_val.clone()),
        ])
        .expect("valid env block");

        assert!(block.len() >= 2);
        assert_eq!(block[block.len() - 1], 0);
        assert_eq!(block[block.len() - 2], 0);

        let block_str = String::from_utf16_lossy(&block);
        assert!(block_str.contains("=C:=C:\\Windows\\System32\0"));
        assert!(block_str.contains("MODUTEX_UNICODE_TEST_PATH=ValueB\0"));
        assert!(!block_str.contains("modutex_unicode_test_path=ValueA\0"));
    }

    #[test]
    fn environment_block_rejects_invalid_names_and_embedded_nul() {
        let empty_key = (OsString::from(""), OsString::from("val"));
        assert!(windows_impl::test_hooks::test_environment_block(&[empty_key]).is_err());

        let embedded_eq = (OsString::from("FOO=BAR"), OsString::from("val"));
        assert!(windows_impl::test_hooks::test_environment_block(&[embedded_eq]).is_err());

        use std::os::windows::ffi::OsStringExt;
        let nul_key_u16 = [b'K' as u16, 0, b'Y' as u16];
        let nul_key = (OsString::from_wide(&nul_key_u16), OsString::from("val"));
        assert!(windows_impl::test_hooks::test_environment_block(&[nul_key]).is_err());

        let nul_val_u16 = [b'V' as u16, 0, b'L' as u16];
        let nul_val = (OsString::from("KEY"), OsString::from_wide(&nul_val_u16));
        assert!(windows_impl::test_hooks::test_environment_block(&[nul_val]).is_err());
    }
}
