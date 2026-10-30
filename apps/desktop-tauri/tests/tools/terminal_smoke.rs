// SPDX-License-Identifier: Apache-2.0

#[cfg(not(windows))]
fn main() {
    eprintln!("Error: pty_probe is only supported on Windows (ConPTY).");
    std::process::exit(1);
}

#[cfg(windows)]
fn main() {
    let exit_code = match run() {
        Ok(code) => code,
        Err(err) => {
            eprintln!("pty_probe fatal error: {err}");
            1
        }
    };
    if exit_code != 0 {
        std::process::exit(exit_code);
    }
}

#[cfg(windows)]
use portable_pty::{native_pty_system, Child, CommandBuilder, PtySize};
#[cfg(windows)]
use std::io::{Read, Write};
#[cfg(windows)]
use std::os::windows::io::{AsRawHandle, RawHandle};
#[cfg(windows)]
use std::path::PathBuf;
#[cfg(windows)]
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(windows)]
use std::sync::{mpsc, Arc, Mutex};
#[cfg(windows)]
use std::time::{Duration, Instant};

#[cfg(windows)]
#[link(name = "kernel32")]
extern "system" {
    fn CancelSynchronousIo(h_thread: RawHandle) -> i32;
    fn TerminateProcess(h_process: RawHandle, u_exit_code: u32) -> i32;
}

#[cfg(windows)]
const MAX_TRANSCRIPT_BYTES: usize = 1024 * 1024; // 1 MiB bounded transcript
#[cfg(windows)]
const ERROR_ACCESS_DENIED_WIN32: i32 = 5;

#[cfg(windows)]
type SharedPtyWriter = Arc<Mutex<Option<Box<dyn Write + Send>>>>;

#[cfg(windows)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ProbeMode {
    Normal,
    FailAfterReader,
    CancelLive,
}

#[cfg(windows)]
impl ProbeMode {
    fn as_str(self) -> &'static str {
        match self {
            Self::Normal => "normal",
            Self::FailAfterReader => "fail_after_reader",
            Self::CancelLive => "cancel_live",
        }
    }

    fn flag(self) -> Option<&'static str> {
        match self {
            Self::Normal => None,
            Self::FailAfterReader => Some("--fail-after-reader"),
            Self::CancelLive => Some("--cancel-live"),
        }
    }

    fn is_fault_mode(self) -> bool {
        !matches!(self, Self::Normal)
    }
}

#[cfg(windows)]
#[derive(Clone, Debug, Eq, PartialEq)]
enum SequenceStepError {
    InjectedFault(String),
    RuntimeFailure(String),
}

#[cfg(windows)]
#[derive(Clone, Debug, Eq, PartialEq)]
struct ProbeSummary {
    mode: ProbeMode,
    initial_size_matched: bool,
    valid_pid: bool,
    marker_detected: bool,
    resize_matched: bool,
    expected_fault_injected: bool,
    has_unexpected_sequence_error: bool,
    child_reaped: bool,
    graceful_exit: bool,
    forced_kill: bool,
    has_kill_error: bool,
    has_wait_error: bool,
    writer_closed: bool,
    reader_joined: bool,
    has_overflow: bool,
    cpr_error_detected: bool,
}

#[cfg(windows)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct ProbeEvaluation {
    full_cleanup_observed: bool,
    clean_teardown: bool,
    actual_cleanup_failure: bool,
    overall_success: bool,
}

#[cfg(windows)]
fn parse_mode_flag(arg: &str) -> Result<ProbeMode, String> {
    match arg {
        "--fail-after-reader" => Ok(ProbeMode::FailAfterReader),
        "--cancel-live" => Ok(ProbeMode::CancelLive),
        other => Err(format!(
            "Unknown flag '{other}'; expected --fail-after-reader or --cancel-live"
        )),
    }
}

#[cfg(windows)]
fn parse_cli_args(raw_args: &[String]) -> Result<(PathBuf, ProbeMode), String> {
    let (dir_arg, mode) = match raw_args {
        [single] => {
            if single.starts_with('-') {
                return Err(format!(
                    "Missing probe directory or unknown flag '{single}'. Usage: pty_probe <absolute-new-probe-directory> [--fail-after-reader | --cancel-live]"
                ));
            }
            (single.as_str(), ProbeMode::Normal)
        }
        [first, second] => {
            if first.starts_with('-') && !second.starts_with('-') {
                let mode = parse_mode_flag(first)?;
                (second.as_str(), mode)
            } else if !first.starts_with('-') {
                let mode = parse_mode_flag(second)?;
                (first.as_str(), mode)
            } else {
                return Err(format!(
                    "Invalid arguments '{first}' '{second}'. Usage: pty_probe <absolute-new-probe-directory> [--fail-after-reader | --cancel-live]"
                ));
            }
        }
        _ => {
            return Err(
                "Usage: pty_probe <absolute-new-probe-directory> [--fail-after-reader | --cancel-live]"
                    .to_string(),
            );
        }
    };

    if dir_arg.is_empty() {
        return Err("Error: probe directory must not be empty".to_string());
    }

    let probe_dir = PathBuf::from(dir_arg);
    if !probe_dir.is_absolute() {
        return Err(format!(
            "Error: probe directory must be an absolute path: {}",
            probe_dir.display()
        ));
    }

    Ok((probe_dir, mode))
}

#[cfg(windows)]
fn evaluate_probe(summary: &ProbeSummary) -> ProbeEvaluation {
    let full_cleanup_observed = summary.child_reaped
        && !summary.has_kill_error
        && !summary.has_wait_error
        && summary.writer_closed
        && summary.reader_joined;

    let clean_teardown = match summary.mode {
        ProbeMode::Normal => full_cleanup_observed && summary.graceful_exit && !summary.forced_kill,
        ProbeMode::FailAfterReader | ProbeMode::CancelLive => {
            full_cleanup_observed && summary.forced_kill && !summary.graceful_exit
        }
    };

    let actual_cleanup_failure = !clean_teardown;

    let overall_success = match summary.mode {
        ProbeMode::Normal => {
            !summary.has_unexpected_sequence_error
                && !summary.expected_fault_injected
                && summary.initial_size_matched
                && summary.valid_pid
                && summary.marker_detected
                && summary.resize_matched
                && !summary.has_overflow
                && !summary.cpr_error_detected
                && clean_teardown
        }
        ProbeMode::FailAfterReader => {
            !summary.has_unexpected_sequence_error
                && summary.expected_fault_injected
                && summary.initial_size_matched
                && summary.valid_pid
                && !summary.has_overflow
                && !summary.cpr_error_detected
                && clean_teardown
        }
        ProbeMode::CancelLive => {
            !summary.has_unexpected_sequence_error
                && summary.expected_fault_injected
                && summary.initial_size_matched
                && summary.valid_pid
                && summary.marker_detected
                && !summary.has_overflow
                && !summary.cpr_error_detected
                && clean_teardown
        }
    };

    ProbeEvaluation {
        full_cleanup_observed,
        clean_teardown,
        actual_cleanup_failure,
        overall_success,
    }
}

#[cfg(windows)]
enum NativeTerminateOutcome {
    Terminated,
    MissingOrNullHandle,
    OsFailure {
        raw_os_error: Option<i32>,
        message: String,
    },
}

#[cfg(windows)]
fn classify_terminate_syscall<F>(
    has_valid_handle: bool,
    terminate_return_value: i32,
    last_error_on_zero: F,
) -> NativeTerminateOutcome
where
    F: FnOnce() -> (Option<i32>, String),
{
    if !has_valid_handle {
        return NativeTerminateOutcome::MissingOrNullHandle;
    }
    if terminate_return_value != 0 {
        return NativeTerminateOutcome::Terminated;
    }
    let (raw_os_error, message) = last_error_on_zero();
    NativeTerminateOutcome::OsFailure {
        raw_os_error,
        message,
    }
}

#[cfg(windows)]
fn resolve_kill_error(
    outcome: &NativeTerminateOutcome,
    observed_exit_code: Option<u32>,
) -> Option<String> {
    match outcome {
        NativeTerminateOutcome::Terminated => None,
        NativeTerminateOutcome::MissingOrNullHandle => {
            Some("Child process raw handle unavailable for native termination".to_string())
        }
        NativeTerminateOutcome::OsFailure {
            raw_os_error: Some(ERROR_ACCESS_DENIED_WIN32),
            ..
        } if observed_exit_code.is_some() => None,
        NativeTerminateOutcome::OsFailure {
            raw_os_error,
            message,
        } => match raw_os_error {
            Some(code) => Some(format!(
                "TerminateProcess failed (os error {code}): {message}"
            )),
            None => Some(format!("TerminateProcess failed: {message}")),
        },
    }
}

#[cfg(windows)]
fn terminate_child_process(raw_handle_opt: Option<RawHandle>) -> NativeTerminateOutcome {
    let Some(raw_handle) = raw_handle_opt.filter(|h| !h.is_null()) else {
        return classify_terminate_syscall(false, 0, || (None, String::new()));
    };
    let res = unsafe { TerminateProcess(raw_handle, 1) };
    classify_terminate_syscall(true, res, || {
        let err = std::io::Error::last_os_error();
        (err.raw_os_error(), err.to_string())
    })
}

#[cfg(windows)]
struct ChildGuard {
    child: Box<dyn Child + Send>,
    reaped: bool,
    exit_code: Option<u32>,
    graceful_exit: bool,
    forced_kill: bool,
    kill_error: Option<String>,
    wait_error: Option<String>,
}

#[cfg(windows)]
impl ChildGuard {
    fn new(child: Box<dyn Child + Send>) -> Self {
        Self {
            child,
            reaped: false,
            exit_code: None,
            graceful_exit: false,
            forced_kill: false,
            kill_error: None,
            wait_error: None,
        }
    }

    fn process_id(&self) -> Option<u32> {
        self.child.process_id()
    }

    fn ensure_still_running(&mut self) -> Result<(), String> {
        if self.reaped {
            return Err("Child already exited before fault injection".to_string());
        }
        match self.child.try_wait() {
            Ok(Some(status)) => {
                self.reaped = true;
                self.exit_code = Some(status.exit_code());
                self.graceful_exit = status.success();
                Err(format!(
                    "Child exited prematurely with code {} before fault injection",
                    status.exit_code()
                ))
            }
            Ok(None) => Ok(()),
            Err(e) => {
                let msg = e.to_string();
                self.wait_error = Some(msg.clone());
                Err(format!(
                    "Failed to poll child status before fault injection: {msg}"
                ))
            }
        }
    }

    fn poll_graceful(
        &mut self,
        deadline: Instant,
        rx: &mpsc::Receiver<Vec<u8>>,
        captured: &mut Vec<u8>,
        transcript_overflow: &mut bool,
    ) -> bool {
        while Instant::now() < deadline {
            drain_available(rx, captured, transcript_overflow);
            match self.child.try_wait() {
                Ok(Some(status)) => {
                    self.reaped = true;
                    self.exit_code = Some(status.exit_code());
                    self.graceful_exit = status.success();
                    return true;
                }
                Ok(None) => {
                    std::thread::sleep(Duration::from_millis(40));
                }
                Err(e) => {
                    self.wait_error = Some(e.to_string());
                    std::thread::sleep(Duration::from_millis(40));
                }
            }
        }
        false
    }

    fn kill_and_poll_bounded<F>(&mut self, timeout: Duration, mut on_poll: F) -> bool
    where
        F: FnMut(),
    {
        if self.reaped {
            return true;
        }

        match self.child.try_wait() {
            Ok(Some(status)) => {
                self.reaped = true;
                self.exit_code = Some(status.exit_code());
                self.graceful_exit = status.success();
                return true;
            }
            Ok(None) => {}
            Err(e) => {
                self.wait_error = Some(e.to_string());
            }
        }

        self.forced_kill = true;
        let terminate_outcome = terminate_child_process(self.child.as_raw_handle());

        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            on_poll();
            match self.child.try_wait() {
                Ok(Some(status)) => {
                    self.reaped = true;
                    self.exit_code = Some(status.exit_code());
                    self.kill_error = resolve_kill_error(&terminate_outcome, self.exit_code);
                    return true;
                }
                Ok(None) => {
                    std::thread::sleep(Duration::from_millis(25));
                }
                Err(e) => {
                    self.wait_error = Some(e.to_string());
                    std::thread::sleep(Duration::from_millis(25));
                }
            }
        }
        self.kill_error = resolve_kill_error(&terminate_outcome, self.exit_code);
        false
    }
}

#[cfg(windows)]
impl Drop for ChildGuard {
    fn drop(&mut self) {
        if !self.reaped {
            let _ = self.kill_and_poll_bounded(Duration::from_secs(2), || {});
        }
    }
}

#[cfg(windows)]
struct ReaderGuard {
    handle: Option<std::thread::JoinHandle<()>>,
    stop_flag: Arc<AtomicBool>,
    joined_cleanly: bool,
    cancel_io_used: bool,
}

#[cfg(windows)]
impl ReaderGuard {
    fn new(handle: std::thread::JoinHandle<()>, stop_flag: Arc<AtomicBool>) -> Self {
        Self {
            handle: Some(handle),
            stop_flag,
            joined_cleanly: false,
            cancel_io_used: false,
        }
    }

    fn stop_and_join_bounded(
        &mut self,
        rx: &mpsc::Receiver<Vec<u8>>,
        captured: &mut Vec<u8>,
        transcript_overflow: &mut bool,
    ) -> bool {
        self.stop_flag.store(true, Ordering::SeqCst);
        let finished = match self.handle.as_ref() {
            Some(handle_ref) => {
                let grace_deadline = Instant::now() + Duration::from_millis(300);
                while !handle_ref.is_finished() && Instant::now() < grace_deadline {
                    drain_available(rx, captured, transcript_overflow);
                    std::thread::sleep(Duration::from_millis(20));
                }

                let cancel_deadline = Instant::now() + Duration::from_secs(2);
                while !handle_ref.is_finished() && Instant::now() < cancel_deadline {
                    self.cancel_io_used = true;
                    unsafe {
                        let _ = CancelSynchronousIo(handle_ref.as_raw_handle());
                    }
                    drain_available(rx, captured, transcript_overflow);
                    std::thread::sleep(Duration::from_millis(25));
                }
                handle_ref.is_finished()
            }
            None => return self.joined_cleanly,
        };

        match (finished, self.handle.take()) {
            (true, Some(h)) => {
                self.joined_cleanly = h.join().is_ok();
            }
            (_, maybe_h) => {
                self.handle = maybe_h;
                self.joined_cleanly = false;
            }
        }

        drain_available(rx, captured, transcript_overflow);
        self.joined_cleanly
    }
}

#[cfg(windows)]
impl Drop for ReaderGuard {
    fn drop(&mut self) {
        self.stop_flag.store(true, Ordering::SeqCst);
        let finished = match self.handle.as_ref() {
            Some(handle_ref) => {
                let cancel_deadline = Instant::now() + Duration::from_millis(500);
                while !handle_ref.is_finished() && Instant::now() < cancel_deadline {
                    unsafe {
                        let _ = CancelSynchronousIo(handle_ref.as_raw_handle());
                    }
                    std::thread::sleep(Duration::from_millis(20));
                }
                handle_ref.is_finished()
            }
            None => false,
        };

        match (finished, self.handle.take()) {
            (true, Some(h)) => {
                let _ = h.join();
            }
            (_, maybe_h) => {
                self.handle = maybe_h;
            }
        }
    }
}

#[cfg(windows)]
fn drain_available(
    rx: &mpsc::Receiver<Vec<u8>>,
    captured: &mut Vec<u8>,
    transcript_overflow: &mut bool,
) {
    while let Ok(chunk) = rx.try_recv() {
        if captured.len() + chunk.len() > MAX_TRANSCRIPT_BYTES {
            *transcript_overflow = true;
            let remaining = MAX_TRANSCRIPT_BYTES.saturating_sub(captured.len());
            captured.extend_from_slice(&chunk[..remaining]);
        } else {
            captured.extend_from_slice(&chunk);
        }
    }
}

#[cfg(windows)]
fn write_to_pty(writer_arc: &SharedPtyWriter, data: &[u8]) -> Result<(), String> {
    let mut guard = writer_arc
        .lock()
        .map_err(|e| format!("Failed to lock writer mutex: {e}"))?;
    match guard.as_mut() {
        Some(w) => {
            w.write_all(data)
                .map_err(|e| format!("Failed to write to PTY: {e}"))?;
            w.flush()
                .map_err(|e| format!("Failed to flush PTY writer: {e}"))?;
            Ok(())
        }
        None => Err("PTY writer already closed".to_string()),
    }
}

#[cfg(windows)]
fn run() -> Result<i32, Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    let (probe_dir, mode) = match parse_cli_args(&args[1..]) {
        Ok(parsed) => parsed,
        Err(msg) => {
            eprintln!("{msg}");
            return Ok(1);
        }
    };

    if probe_dir.exists() {
        eprintln!(
            "Error: probe directory already exists: {}",
            probe_dir.display()
        );
        return Ok(1);
    }

    std::fs::create_dir(&probe_dir)?;

    let comspec = std::env::var("COMSPEC").unwrap_or_else(|_| "powershell.exe".to_string());
    let system_root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".to_string());
    let cmd_exe_path = format!("{}\\System32\\cmd.exe", system_root);

    let initial_req_size = PtySize {
        rows: 24,
        cols: 80,
        pixel_width: 0,
        pixel_height: 0,
    };

    let pty_system = native_pty_system();
    let pair = pty_system.openpty(initial_req_size)?;
    let actual_initial_size = pair.master.get_size()?;
    let initial_size_matched = actual_initial_size.cols == 80 && actual_initial_size.rows == 24;
    if !initial_size_matched {
        return Err(std::io::Error::other(format!(
            "Initial PTY size mismatch: expected 80x24, got {}x{}",
            actual_initial_size.cols, actual_initial_size.rows
        ))
        .into());
    }

    let mut cmd = CommandBuilder::new(&cmd_exe_path);
    cmd.arg("/D");
    cmd.arg("/Q");
    cmd.cwd(&probe_dir);

    let child = pair.slave.spawn_command(cmd)?;
    drop(pair.slave);

    let mut child_guard = ChildGuard::new(child);
    let pid_opt = child_guard.process_id();
    let (process_id, valid_pid) = match pid_opt {
        Some(pid) if pid > 0 => (pid, true),
        Some(pid) => (pid, false),
        None => (0, false),
    };

    let mut master_opt = Some(pair.master);
    let (tx, rx) = mpsc::sync_channel::<Vec<u8>>(32);
    let channel_overflow = Arc::new(AtomicBool::new(false));
    let cpr_write_error = Arc::new(AtomicBool::new(false));
    let reader_stop = Arc::new(AtomicBool::new(false));

    let mut writer_arc_opt: Option<SharedPtyWriter> = None;
    let mut reader_guard_opt: Option<ReaderGuard> = None;

    let mut captured_bytes: Vec<u8> = Vec::new();
    let mut transcript_overflow = false;
    let mut final_cols: u16 = 0;
    let mut final_rows: u16 = 0;
    let mut resize_matched = false;
    let mut marker_detected = false;

    let marker = "中文終端\u{20000}";
    let marker_bytes = marker.as_bytes();

    let sequence_result: Result<(), SequenceStepError> = (|| {
        if !valid_pid {
            return Err(SequenceStepError::RuntimeFailure(
                "Spawned child returned invalid or missing PID".to_string(),
            ));
        }

        let master_ref = master_opt
            .as_ref()
            .ok_or_else(|| SequenceStepError::RuntimeFailure("Master PTY missing".to_string()))?;
        let mut reader = master_ref.try_clone_reader().map_err(|e| {
            SequenceStepError::RuntimeFailure(format!("Failed to clone PTY reader: {e}"))
        })?;
        let raw_writer = master_ref.take_writer().map_err(|e| {
            SequenceStepError::RuntimeFailure(format!("Failed to take PTY writer: {e}"))
        })?;

        let writer_arc = Arc::new(Mutex::new(Some(raw_writer)));
        let writer_for_reader = Arc::clone(&writer_arc);
        writer_arc_opt = Some(Arc::clone(&writer_arc));

        let channel_overflow_for_reader = Arc::clone(&channel_overflow);
        let cpr_write_error_for_reader = Arc::clone(&cpr_write_error);
        let reader_stop_for_thread = Arc::clone(&reader_stop);

        let reader_handle = std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            let mut tail = Vec::with_capacity(3);
            while !reader_stop_for_thread.load(Ordering::SeqCst) {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let chunk = &buf[..n];
                        let mut scan = tail.clone();
                        scan.extend_from_slice(chunk);
                        if !reader_stop_for_thread.load(Ordering::SeqCst)
                            && scan.windows(4).any(|w| w == b"\x1b[6n")
                        {
                            match writer_for_reader.lock() {
                                Ok(mut guard) => match guard.as_mut() {
                                    Some(w) => {
                                        if (w.write_all(b"\x1b[1;1R").is_err()
                                            || w.flush().is_err())
                                            && !reader_stop_for_thread.load(Ordering::SeqCst)
                                        {
                                            cpr_write_error_for_reader
                                                .store(true, Ordering::SeqCst);
                                        }
                                    }
                                    None => {
                                        if !reader_stop_for_thread.load(Ordering::SeqCst) {
                                            cpr_write_error_for_reader
                                                .store(true, Ordering::SeqCst);
                                        }
                                    }
                                },
                                Err(_) => {
                                    cpr_write_error_for_reader.store(true, Ordering::SeqCst);
                                }
                            }
                        }
                        tail.clear();
                        if scan.len() >= 3 {
                            tail.extend_from_slice(&scan[scan.len() - 3..]);
                        } else {
                            tail.extend_from_slice(&scan);
                        }
                        match tx.try_send(chunk.to_vec()) {
                            Ok(_) => {}
                            Err(mpsc::TrySendError::Full(_)) => {
                                channel_overflow_for_reader.store(true, Ordering::SeqCst);
                            }
                            Err(mpsc::TrySendError::Disconnected(_)) => {
                                break;
                            }
                        }
                    }
                    Err(_) => break,
                }
            }
        });

        reader_guard_opt = Some(ReaderGuard::new(reader_handle, Arc::clone(&reader_stop)));

        if mode == ProbeMode::FailAfterReader {
            let settle_deadline = Instant::now() + Duration::from_millis(100);
            while Instant::now() < settle_deadline {
                drain_available(&rx, &mut captured_bytes, &mut transcript_overflow);
                std::thread::sleep(Duration::from_millis(20));
            }
            child_guard
                .ensure_still_running()
                .map_err(SequenceStepError::RuntimeFailure)?;
            return Err(SequenceStepError::InjectedFault(
                "injected fault: simulated error after reader spawn (--fail-after-reader)"
                    .to_string(),
            ));
        }

        // Send chcp 65001
        write_to_pty(&writer_arc, b"chcp 65001\r\n").map_err(SequenceStepError::RuntimeFailure)?;
        let chcp_deadline = Instant::now() + Duration::from_millis(200);
        while Instant::now() < chcp_deadline {
            drain_available(&rx, &mut captured_bytes, &mut transcript_overflow);
            std::thread::sleep(Duration::from_millis(20));
        }

        // Send separate variables so full marker does not appear in any command input
        write_to_pty(&writer_arc, "set G1_A=中文\r\n".as_bytes())
            .map_err(SequenceStepError::RuntimeFailure)?;
        let set_a_deadline = Instant::now() + Duration::from_millis(100);
        while Instant::now() < set_a_deadline {
            drain_available(&rx, &mut captured_bytes, &mut transcript_overflow);
            std::thread::sleep(Duration::from_millis(20));
        }

        write_to_pty(&writer_arc, "set G1_B=終端\u{20000}\r\n".as_bytes())
            .map_err(SequenceStepError::RuntimeFailure)?;
        let set_b_deadline = Instant::now() + Duration::from_millis(100);
        while Instant::now() < set_b_deadline {
            drain_available(&rx, &mut captured_bytes, &mut transcript_overflow);
            std::thread::sleep(Duration::from_millis(20));
        }

        write_to_pty(&writer_arc, b"echo %G1_A%%G1_B%\r\n")
            .map_err(SequenceStepError::RuntimeFailure)?;

        let marker_deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < marker_deadline {
            drain_available(&rx, &mut captured_bytes, &mut transcript_overflow);
            if captured_bytes
                .windows(marker_bytes.len())
                .any(|w| w == marker_bytes)
            {
                marker_detected = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(30));
        }

        if !marker_detected {
            return Err(SequenceStepError::RuntimeFailure(
                "Expected UTF-8 marker was not detected within 5s deadline".to_string(),
            ));
        }

        if mode == ProbeMode::CancelLive {
            child_guard
                .ensure_still_running()
                .map_err(SequenceStepError::RuntimeFailure)?;
            return Err(SequenceStepError::InjectedFault(
                "injected fault: forced live-shell cancellation (--cancel-live)".to_string(),
            ));
        }

        // Resize to 100x30
        let resize_target = PtySize {
            rows: 30,
            cols: 100,
            pixel_width: 0,
            pixel_height: 0,
        };
        let master_for_resize = master_opt.as_ref().ok_or_else(|| {
            SequenceStepError::RuntimeFailure("Master PTY missing before resize".to_string())
        })?;
        master_for_resize.resize(resize_target).map_err(|e| {
            SequenceStepError::RuntimeFailure(format!("Failed to resize master PTY: {e}"))
        })?;
        let actual_final_size = master_for_resize.get_size().map_err(|e| {
            SequenceStepError::RuntimeFailure(format!(
                "Failed to query master PTY size after resize: {e}"
            ))
        })?;
        final_cols = actual_final_size.cols;
        final_rows = actual_final_size.rows;
        resize_matched = final_cols == 100 && final_rows == 30;

        // Graceful exit
        write_to_pty(&writer_arc, b"exit /b 0\r\n").map_err(SequenceStepError::RuntimeFailure)?;

        let exit_deadline = Instant::now() + Duration::from_secs(10);
        let exited = child_guard.poll_graceful(
            exit_deadline,
            &rx,
            &mut captured_bytes,
            &mut transcript_overflow,
        );
        if !exited {
            return Err(SequenceStepError::RuntimeFailure(
                "Child did not exit gracefully within 10s deadline".to_string(),
            ));
        }

        Ok(())
    })();

    let (
        expected_fault_injected,
        injected_fault_message,
        unexpected_sequence_error,
        sequence_error,
    ) = match &sequence_result {
        Ok(()) => (false, None, None, None),
        Err(SequenceStepError::InjectedFault(msg)) => {
            (true, Some(msg.clone()), None, Some(msg.clone()))
        }
        Err(SequenceStepError::RuntimeFailure(msg)) => {
            eprintln!("pty_probe sequence error: {msg}");
            (false, None, Some(msg.clone()), Some(msg.clone()))
        }
    };

    // Unconditional final cleanup in strict order:
    // 1. Ensure child is terminated and reaped via bounded try_wait polling
    if !child_guard.reaped {
        let _ = child_guard.kill_and_poll_bounded(Duration::from_secs(3), || {
            drain_available(&rx, &mut captured_bytes, &mut transcript_overflow);
        });
    }

    // 2. Signal reader thread to stop before next read
    reader_stop.store(true, Ordering::SeqCst);

    // 3. Drop PTY writer
    let writer_closed = match writer_arc_opt.as_ref() {
        Some(arc) => match arc.lock() {
            Ok(mut guard) => guard.take().is_some(),
            Err(_) => false,
        },
        None => false,
    };

    // 4. Drop PTY master handle
    drop(master_opt.take());

    // 5. Stop, repeatedly CancelSynchronousIo if still blocked, and join reader once finished
    let (reader_joined, cancel_io_used) = match reader_guard_opt.as_mut() {
        Some(rg) => {
            let joined =
                rg.stop_and_join_bounded(&rx, &mut captured_bytes, &mut transcript_overflow);
            (joined, rg.cancel_io_used)
        }
        None => (false, false),
    };

    // 6. Final non-blocking drain of remaining channel chunks
    drain_available(&rx, &mut captured_bytes, &mut transcript_overflow);

    if !marker_detected {
        marker_detected = captured_bytes
            .windows(marker_bytes.len())
            .any(|w| w == marker_bytes);
    }

    let channel_overflow_detected = channel_overflow.load(Ordering::SeqCst);
    let cpr_error_detected = cpr_write_error.load(Ordering::SeqCst);
    let has_overflow = transcript_overflow || channel_overflow_detected;

    let summary = ProbeSummary {
        mode,
        initial_size_matched,
        valid_pid,
        marker_detected,
        resize_matched,
        expected_fault_injected,
        has_unexpected_sequence_error: unexpected_sequence_error.is_some(),
        child_reaped: child_guard.reaped,
        graceful_exit: child_guard.graceful_exit,
        forced_kill: child_guard.forced_kill,
        has_kill_error: child_guard.kill_error.is_some(),
        has_wait_error: child_guard.wait_error.is_some(),
        writer_closed,
        reader_joined,
        has_overflow,
        cpr_error_detected,
    };
    let eval = evaluate_probe(&summary);
    let clean_teardown = eval.clean_teardown;
    let overall_success = eval.overall_success;

    let transcript_path = probe_dir.join("transcript.bin");
    std::fs::write(&transcript_path, &captured_bytes)?;

    let run_id = uuid::Uuid::new_v4().to_string();
    let result_json = serde_json::json!({
        "run_id": run_id,
        "mode": mode.as_str(),
        "requested_flag": mode.flag(),
        "expected_fault_mode": mode.is_fault_mode(),
        "expected_fault_injected": expected_fault_injected,
        "injected_fault_message": injected_fault_message,
        "unexpected_sequence_error": unexpected_sequence_error,
        "actual_cleanup_failure": eval.actual_cleanup_failure,
        "cleanup_succeeded": eval.full_cleanup_observed,
        "child_reaped": child_guard.reaped,
        "forced_kill": child_guard.forced_kill,
        "writer_closed": writer_closed,
        "reader_joined": reader_joined,
        "process_id": process_id,
        "valid_pid": valid_pid,
        "default_shell_comspec": comspec,
        "command": cmd_exe_path,
        "marker": marker,
        "marker_detected": marker_detected,
        "initial_size": {
            "cols": actual_initial_size.cols,
            "rows": actual_initial_size.rows,
            "matched": initial_size_matched,
        },
        "final_size": {
            "cols": final_cols,
            "rows": final_rows,
            "matched": resize_matched,
        },
        "child_exit": {
            "reaped": child_guard.reaped,
            "exit_code": child_guard.exit_code,
            "graceful_exit": child_guard.graceful_exit,
            "forced_kill": child_guard.forced_kill,
            "kill_error": child_guard.kill_error,
            "wait_error": child_guard.wait_error,
        },
        "captured_byte_length": captured_bytes.len(),
        "overflow": {
            "channel_overflow": channel_overflow_detected,
            "transcript_overflow": transcript_overflow,
            "has_overflow": has_overflow,
        },
        "cpr_write_error": cpr_error_detected,
        "sequence_error": sequence_error,
        "fault_verification": {
            "mode": mode.as_str(),
            "flag": mode.flag(),
            "expected_fault_mode": mode.is_fault_mode(),
            "expected_fault_injected": expected_fault_injected,
            "injected_fault_message": injected_fault_message,
            "unexpected_error": unexpected_sequence_error,
            "actual_cleanup_failure": eval.actual_cleanup_failure,
            "full_cleanup_observed": eval.full_cleanup_observed,
            "child_reaped": child_guard.reaped,
            "forced_kill": child_guard.forced_kill,
            "writer_closed": writer_closed,
            "reader_joined": reader_joined,
        },
        "teardown_result": {
            "writer_closed": writer_closed,
            "reader_joined": reader_joined,
            "cancel_io_used": cancel_io_used,
            "child_reaped": child_guard.reaped,
            "forced_kill": child_guard.forced_kill,
            "clean_teardown": clean_teardown,
            "cleanup_succeeded": eval.full_cleanup_observed,
            "actual_cleanup_failure": eval.actual_cleanup_failure,
        },
        "transcript_file": transcript_path.display().to_string(),
        "overall_success": overall_success,
    });

    let json_output = serde_json::to_string_pretty(&result_json)?;
    let result_file_path = probe_dir.join("probe_result.json");
    std::fs::write(&result_file_path, json_output.as_bytes())?;

    println!("{}", json_output);

    if overall_success {
        Ok(0)
    } else {
        Ok(1)
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    fn s(items: &[&str]) -> Vec<String> {
        items.iter().map(|v| (*v).to_string()).collect()
    }

    fn normal_summary() -> ProbeSummary {
        ProbeSummary {
            mode: ProbeMode::Normal,
            initial_size_matched: true,
            valid_pid: true,
            marker_detected: true,
            resize_matched: true,
            expected_fault_injected: false,
            has_unexpected_sequence_error: false,
            child_reaped: true,
            graceful_exit: true,
            forced_kill: false,
            has_kill_error: false,
            has_wait_error: false,
            writer_closed: true,
            reader_joined: true,
            has_overflow: false,
            cpr_error_detected: false,
        }
    }

    #[test]
    fn cli_parser_accepts_normal_and_supported_fault_flags() {
        let (dir, mode) = parse_cli_args(&s(&[r"C:\temp\probe-1"])).expect("normal");
        assert_eq!(dir, PathBuf::from(r"C:\temp\probe-1"));
        assert_eq!(mode, ProbeMode::Normal);

        let (dir, mode) =
            parse_cli_args(&s(&[r"C:\temp\probe-2", "--fail-after-reader"])).expect("fail after");
        assert_eq!(dir, PathBuf::from(r"C:\temp\probe-2"));
        assert_eq!(mode, ProbeMode::FailAfterReader);

        let (dir, mode) =
            parse_cli_args(&s(&["--fail-after-reader", r"C:\temp\probe-2"])).expect("flag first");
        assert_eq!(dir, PathBuf::from(r"C:\temp\probe-2"));
        assert_eq!(mode, ProbeMode::FailAfterReader);

        let (dir, mode) =
            parse_cli_args(&s(&[r"C:\temp\probe-3", "--cancel-live"])).expect("cancel live");
        assert_eq!(dir, PathBuf::from(r"C:\temp\probe-3"));
        assert_eq!(mode, ProbeMode::CancelLive);

        let (dir, mode) =
            parse_cli_args(&s(&["--cancel-live", r"C:\temp\probe-3"])).expect("cancel first");
        assert_eq!(dir, PathBuf::from(r"C:\temp\probe-3"));
        assert_eq!(mode, ProbeMode::CancelLive);
    }

    #[test]
    fn cli_parser_rejects_unknown_flags_and_invalid_paths() {
        assert!(parse_cli_args(&[]).is_err());
        assert!(parse_cli_args(&s(&["--fail-after-reader"])).is_err());
        assert!(parse_cli_args(&s(&[r"C:\temp\probe", "--unknown-flag"])).is_err());
        assert!(parse_cli_args(&s(&["--unknown-flag", r"C:\temp\probe"])).is_err());
        assert!(parse_cli_args(&s(&[r"C:\temp\probe", "extra"])).is_err());
        assert!(parse_cli_args(&s(&["relative\\path"])).is_err());
        assert!(parse_cli_args(&s(&["relative\\path", "--cancel-live"])).is_err());
        assert!(parse_cli_args(&s(&[
            r"C:\temp\probe",
            "--fail-after-reader",
            "--cancel-live"
        ]))
        .is_err());
    }

    #[test]
    fn evaluation_distinguishes_fault_modes_and_rejects_arbitrary_or_cleanup_failures() {
        let normal = normal_summary();
        let eval = evaluate_probe(&normal);
        assert!(eval.overall_success);
        assert!(eval.clean_teardown);
        assert!(!eval.actual_cleanup_failure);

        let mut fail_after = ProbeSummary {
            mode: ProbeMode::FailAfterReader,
            marker_detected: false,
            resize_matched: false,
            expected_fault_injected: true,
            graceful_exit: false,
            forced_kill: true,
            ..normal_summary()
        };
        let eval = evaluate_probe(&fail_after);
        assert!(eval.overall_success);
        assert!(eval.full_cleanup_observed);
        assert!(!eval.actual_cleanup_failure);

        // Arbitrary runtime failure before fault injection must not succeed
        fail_after.expected_fault_injected = false;
        fail_after.has_unexpected_sequence_error = true;
        assert!(!evaluate_probe(&fail_after).overall_success);

        // Incomplete cleanup (e.g., reader not joined or writer not closed) must fail
        fail_after.expected_fault_injected = true;
        fail_after.has_unexpected_sequence_error = false;
        fail_after.reader_joined = false;
        let eval = evaluate_probe(&fail_after);
        assert!(!eval.overall_success);
        assert!(eval.actual_cleanup_failure);

        let mut cancel_live = ProbeSummary {
            mode: ProbeMode::CancelLive,
            marker_detected: true,
            resize_matched: false,
            expected_fault_injected: true,
            graceful_exit: false,
            forced_kill: true,
            ..normal_summary()
        };
        assert!(evaluate_probe(&cancel_live).overall_success);

        // Cancel-live requires marker_detected to prove the shell was live
        cancel_live.marker_detected = false;
        assert!(!evaluate_probe(&cancel_live).overall_success);
    }

    #[test]
    fn native_terminate_classification_ignores_stale_error_on_nonzero_and_reports_real_failures() {
        // Nonzero BOOL from TerminateProcess is success; GetLastError closure must not run
        let mut last_error_queried = false;
        let outcome = classify_terminate_syscall(true, 1, || {
            last_error_queried = true;
            (Some(6), "The handle is invalid. (os error 6)".to_string())
        });
        assert!(!last_error_queried);
        assert_eq!(resolve_kill_error(&outcome, Some(1)), None);

        // Actual zero return with ERROR_INVALID_HANDLE (6) is always a kill error
        let invalid_handle = classify_terminate_syscall(true, 0, || {
            (Some(6), "The handle is invalid. (os error 6)".to_string())
        });
        let err = resolve_kill_error(&invalid_handle, Some(1)).expect("must report error 6");
        assert!(err.contains("os error 6"));

        // Missing or null raw handle is always a kill error
        let missing = classify_terminate_syscall(false, 0, || (None, String::new()));
        assert!(resolve_kill_error(&missing, Some(1)).is_some());
        assert!(resolve_kill_error(
            &terminate_child_process(Some(std::ptr::null_mut())),
            Some(1)
        )
        .is_some());

        // ERROR_ACCESS_DENIED (5) on zero return is only accepted with actual observed exit code
        let access_denied = classify_terminate_syscall(true, 0, || {
            (
                Some(ERROR_ACCESS_DENIED_WIN32),
                "Access is denied.".to_string(),
            )
        });
        assert!(resolve_kill_error(&access_denied, None).is_some());
        assert_eq!(resolve_kill_error(&access_denied, Some(0)), None);
    }
}
