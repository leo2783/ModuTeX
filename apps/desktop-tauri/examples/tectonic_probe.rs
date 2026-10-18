// SPDX-License-Identifier: Apache-2.0
//! Windows-only Tectonic engine probe (Apache-2.0, original ModuTeX code).
//!
//! Usage: `tectonic_probe <absolute-tectonic-exe> <absolute-probe-directory>`
//!
//! The probe directory must not exist. Everything the probe writes (fixture, cache,
//! temp, outputs, logs, receipt) lives beneath it. Nothing is deleted.
//!
//! API assumptions (windows-sys 0.61.2; features Win32_Foundation, Win32_Security,
//! Win32_System_Threading, Win32_System_JobObjects, Win32_System_Pipes):
//! - `CreateProcessW(app, mut cmdline, ..)` may modify the command-line buffer, so it is a
//!   mutable NUL-terminated UTF-16 `Vec`. With `CREATE_UNICODE_ENVIRONMENT` the environment
//!   is a UTF-16 `K=V\0...\0\0` block.
//! - A process created `CREATE_SUSPENDED` can be assigned to a job before `ResumeThread`,
//!   so descendants are born inside the job. Nested jobs are supported on Windows 8+.
//! - `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` kills every job member when the last job handle closes.
//! - `JobObjectBasicAccountingInformation.ActiveProcesses` counts live job members.
//! - Win32_System_Pipes is declared by the foundation owner but is not used here. stdout and
//!   stderr go to one inheritable file handle instead of pipes.
//! - Only direct-child termination plus the job's ActiveProcesses count are checked. This is
//!   not a full process-tree stress test.
//! - Tectonic CLI flags `--untrusted --keep-logs --synctex --outdir` and `TECTONIC_CACHE_DIR`
//!   come from the task specification. The PDF is expected at `<outdir>/main.pdf`.

#[cfg(not(windows))]
fn main() -> std::process::ExitCode {
    eprintln!("tectonic_probe: UNSUPPORTED platform; this probe only runs on Windows x64");
    std::process::ExitCode::from(2)
}

#[cfg(windows)]
fn main() -> std::process::ExitCode {
    match win::run() {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("tectonic_probe: FAILED: {e}");
            std::process::ExitCode::from(1)
        }
    }
}

#[cfg(windows)]
mod win {
    use std::collections::BTreeMap;
    use std::ffi::{c_void, OsStr, OsString};
    use std::fs::{self, File, OpenOptions};
    use std::io::{Read, Seek, SeekFrom, Write};
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::AsRawHandle;
    use std::path::{Component, Path, PathBuf, Prefix};
    use std::time::{Duration, Instant};
    use std::{mem, ptr};

    use windows_sys::Win32::Foundation::{
        CloseHandle, SetHandleInformation, HANDLE, HANDLE_FLAG_INHERIT, INVALID_HANDLE_VALUE,
        WAIT_OBJECT_0, WAIT_TIMEOUT,
    };
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectBasicAccountingInformation,
        JobObjectExtendedLimitInformation, QueryInformationJobObject, SetInformationJobObject,
        TerminateJobObject, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{
        CreateProcessW, GetExitCodeProcess, ResumeThread, TerminateProcess, WaitForSingleObject,
        CREATE_NO_WINDOW, CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT, PROCESS_INFORMATION,
        STARTF_USESHOWWINDOW, STARTF_USESTDHANDLES, STARTUPINFOW,
    };

    const COLD_DEADLINE: Duration = Duration::from_secs(300);
    const WARM_DEADLINE: Duration = Duration::from_secs(120);
    const LOG_CAP: u64 = 1024 * 1024;
    const POLL_MS: u32 = 100;
    const REAP_MS: u32 = 10_000;
    const IDLE_WAIT: Duration = Duration::from_secs(5);
    const PROBE_KILL_CODE: u32 = 0x4D58_0001;
    const PDF_MIN: u64 = 16;
    const PDF_MAX: u64 = 32 * 1024 * 1024;
    const MAX_CMDLINE_UTF16: usize = 32_767;
    const MARKER: &str = "MODUTEX-G1-TECTONIC";

    // ---------- RAII handle ----------

    struct Handle(HANDLE);

    impl Handle {
        fn raw(&self) -> HANDLE {
            self.0
        }
    }

    impl Drop for Handle {
        fn drop(&mut self) {
            // Never close NULL or INVALID_HANDLE_VALUE.
            if !self.0.is_null() && self.0 != INVALID_HANDLE_VALUE {
                unsafe {
                    CloseHandle(self.0);
                }
            }
        }
    }

    fn os_err(ctx: &str) -> String {
        format!("{ctx}: {}", std::io::Error::last_os_error())
    }

    /// Fails if the log cannot be inspected or exceeds the retained-log cap; returns its length.
    fn check_log_cap(log: &Path) -> Result<u64, String> {
        let len = fs::metadata(log)
            .map_err(|e| format!("stat {}: {e}", log.display()))?
            .len();
        if len > LOG_CAP {
            return Err(format!(
                "log {} is {len} bytes, over the {LOG_CAP}-byte cap",
                log.display()
            ));
        }
        Ok(len)
    }

    // ---------- Job object + child ----------

    fn create_kill_on_close_job() -> Result<Handle, String> {
        unsafe {
            let raw = CreateJobObjectW(ptr::null(), ptr::null());
            if raw.is_null() {
                return Err(os_err("CreateJobObjectW"));
            }
            let job = Handle(raw);
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let ok = SetInformationJobObject(
                job.raw(),
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const c_void,
                mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            if ok == 0 {
                return Err(os_err("SetInformationJobObject(KILL_ON_JOB_CLOSE)"));
            }
            Ok(job)
        }
    }

    struct Child {
        job: Handle,
        process: Handle,
        thread: Handle,
        pid: u32,
        reaped: bool,
    }

    impl Child {
        /// Create suspended -> assign to job -> resume. Any failure after CreateProcessW
        /// succeeds drops `Child`, which terminates and reaps the process.
        fn spawn(
            exe: &Path,
            args: &[OsString],
            env: &[u16],
            cwd: &Path,
            stdin: HANDLE,
            stdout_err: HANDLE,
        ) -> Result<Child, String> {
            let job = create_kill_on_close_job()?;
            let app = wide_z(exe.as_os_str())?;
            let mut cmd = command_line(args)?;
            let cwd_w = wide_z(cwd.as_os_str())?;

            let child = unsafe {
                let mut si: STARTUPINFOW = mem::zeroed();
                si.cb = mem::size_of::<STARTUPINFOW>() as u32;
                si.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
                si.wShowWindow = 0; // SW_HIDE
                si.hStdInput = stdin;
                si.hStdOutput = stdout_err;
                si.hStdError = stdout_err;
                let mut pi: PROCESS_INFORMATION = mem::zeroed();
                let ok = CreateProcessW(
                    app.as_ptr(),
                    cmd.as_mut_ptr(),
                    ptr::null(),
                    ptr::null(),
                    1, // bInheritHandles: only the explicitly marked std handles are inheritable
                    CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW,
                    env.as_ptr() as *const c_void,
                    cwd_w.as_ptr(),
                    &si,
                    &mut pi,
                );
                if ok == 0 {
                    return Err(os_err("CreateProcessW"));
                }
                Child {
                    job,
                    process: Handle(pi.hProcess),
                    thread: Handle(pi.hThread),
                    pid: pi.dwProcessId,
                    reaped: false,
                }
            };

            unsafe {
                // Assign BEFORE resume so no descendant can escape the job.
                if AssignProcessToJobObject(child.job.raw(), child.process.raw()) == 0 {
                    return Err(os_err("AssignProcessToJobObject")); // Drop kills + reaps
                }
                if ResumeThread(child.thread.raw()) == u32::MAX {
                    return Err(os_err("ResumeThread")); // Drop kills + reaps
                }
            }
            Ok(child)
        }

        /// Best-effort kill of the whole job and the direct child (ignores errors).
        fn terminate(&self, code: u32) {
            unsafe {
                TerminateJobObject(self.job.raw(), code);
                TerminateProcess(self.process.raw(), code);
            }
        }

        fn exit_code(&self) -> Result<u32, String> {
            let mut code = 0u32;
            if unsafe { GetExitCodeProcess(self.process.raw(), &mut code) } == 0 {
                return Err(os_err("GetExitCodeProcess"));
            }
            Ok(code)
        }

        /// Terminate job + process, wait for the process to be signaled, return its exit code.
        fn terminate_and_reap(&mut self, code: u32) -> Result<u32, String> {
            self.terminate(code);
            let r = unsafe { WaitForSingleObject(self.process.raw(), REAP_MS) };
            if r != WAIT_OBJECT_0 {
                return Err(format!(
                    "child {} not reaped after termination (wait={r})",
                    self.pid
                ));
            }
            self.reaped = true;
            self.exit_code()
        }

        /// Kill the job and child, reap, then require the job to drain. Returns a message
        /// suffix describing the cleanup outcome for the caller's error.
        fn kill_and_drain(&mut self) -> String {
            match self.terminate_and_reap(PROBE_KILL_CODE) {
                Err(e) => format!("; cleanup failed: {e}"),
                Ok(_) => match self.wait_job_idle() {
                    Ok(_) => "; cleanup: child reaped, job drained".to_string(),
                    Err(e) => format!("; cleanup failed: {e}"),
                },
            }
        }

        /// Wait for natural exit. Each wait is bounded by the remaining deadline. The deadline
        /// and log cap are checked BEFORE a signaled exit is accepted. Any failure kills,
        /// reaps and verifies the job drains.
        fn wait_exit(&mut self, deadline: Instant, log: &Path) -> Result<u32, String> {
            loop {
                let remaining = deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    let c = self.kill_and_drain();
                    return Err(format!("deadline exceeded{c}"));
                }
                let slice = remaining.as_millis().min(POLL_MS as u128).max(1) as u32;
                let r = unsafe { WaitForSingleObject(self.process.raw(), slice) };
                if r != WAIT_OBJECT_0 && r != WAIT_TIMEOUT {
                    let e = os_err("WaitForSingleObject");
                    let c = self.kill_and_drain();
                    return Err(format!("{e}{c}"));
                }
                if let Err(e) = check_log_cap(log) {
                    let c = self.kill_and_drain();
                    return Err(format!("{e}{c}"));
                }
                if Instant::now() >= deadline {
                    let c = self.kill_and_drain();
                    return Err(format!("deadline exceeded{c}"));
                }
                if r == WAIT_OBJECT_0 {
                    break;
                }
            }
            self.reaped = true;
            self.exit_code()
        }

        fn active_processes(&self) -> Result<u32, String> {
            unsafe {
                let mut info: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = mem::zeroed();
                let ok = QueryInformationJobObject(
                    self.job.raw(),
                    JobObjectBasicAccountingInformation,
                    &mut info as *mut _ as *mut c_void,
                    mem::size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                    ptr::null_mut(),
                );
                if ok == 0 {
                    return Err(os_err("QueryInformationJobObject"));
                }
                Ok(info.ActiveProcesses)
            }
        }

        /// Require the job to drain to zero members; otherwise kill it and fail.
        fn wait_job_idle(&mut self) -> Result<u32, String> {
            let until = Instant::now() + IDLE_WAIT;
            loop {
                let n = self.active_processes()?;
                if n == 0 {
                    return Ok(0);
                }
                if Instant::now() >= until {
                    self.terminate(PROBE_KILL_CODE);
                    return Err(format!(
                        "job still has {n} active process(es) after child exit"
                    ));
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        }
    }

    impl Drop for Child {
        fn drop(&mut self) {
            if !self.reaped {
                self.terminate(PROBE_KILL_CODE);
                unsafe {
                    WaitForSingleObject(self.process.raw(), REAP_MS);
                }
            }
            // Job handle closes afterwards; KILL_ON_JOB_CLOSE kills any remaining member.
        }
    }

    // ---------- Argument / environment encoding ----------

    fn wide_z(s: &OsStr) -> Result<Vec<u16>, String> {
        let mut v: Vec<u16> = s.encode_wide().collect();
        if v.contains(&0) {
            return Err(format!("embedded NUL in {s:?}"));
        }
        v.push(0);
        Ok(v)
    }

    /// MSVCRT-compatible argv quoting.
    fn quote_arg(arg: &OsStr, out: &mut Vec<u16>) -> Result<(), String> {
        let w: Vec<u16> = arg.encode_wide().collect();
        if w.contains(&0) {
            return Err(format!("embedded NUL in argument {arg:?}"));
        }
        let plain = !w.is_empty()
            && !w.iter().any(|&c| {
                c == b' ' as u16
                    || c == b'\t' as u16
                    || c == b'\n' as u16
                    || c == 0x0B
                    || c == b'"' as u16
            });
        if plain {
            out.extend(w);
            return Ok(());
        }
        out.push(b'"' as u16);
        let mut backslashes = 0usize;
        for c in w {
            if c == b'\\' as u16 {
                backslashes += 1;
            } else if c == b'"' as u16 {
                out.extend(std::iter::repeat_n(b'\\' as u16, backslashes * 2 + 1));
                out.push(b'"' as u16);
                backslashes = 0;
            } else {
                out.extend(std::iter::repeat_n(b'\\' as u16, backslashes));
                backslashes = 0;
                out.push(c);
            }
        }
        out.extend(std::iter::repeat_n(b'\\' as u16, backslashes * 2));
        out.push(b'"' as u16);
        Ok(())
    }

    fn command_line(args: &[OsString]) -> Result<Vec<u16>, String> {
        let mut out = Vec::new();
        for (i, a) in args.iter().enumerate() {
            if i > 0 {
                out.push(b' ' as u16);
            }
            quote_arg(a, &mut out)?;
        }
        if out.len() + 1 > MAX_CMDLINE_UTF16 {
            return Err("command line exceeds 32767 UTF-16 units".to_string());
        }
        out.push(0);
        Ok(out)
    }

    /// Minimal explicit environment: system basics, optional proxy settings (needed for
    /// cold bundle downloads), PATH limited to System32, and isolated cache/temp dirs.
    /// Values are never printed.
    fn environment_block(cache: &Path, tmp: &Path) -> Result<Vec<u16>, String> {
        let mut map: BTreeMap<String, (OsString, OsString)> = BTreeMap::new();
        let mut put = |k: &str, v: OsString| {
            map.insert(k.to_ascii_uppercase(), (OsString::from(k), v));
        };
        let system_root = std::env::var_os("SystemRoot").ok_or("SystemRoot is not set")?;
        for k in [
            "SystemRoot",
            "SystemDrive",
            "windir",
            "ComSpec",
            "PATHEXT",
            "NUMBER_OF_PROCESSORS",
            "PROCESSOR_ARCHITECTURE",
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "ALL_PROXY",
            "NO_PROXY",
        ] {
            if let Some(v) = std::env::var_os(k) {
                put(k, v);
            }
        }
        let mut path = PathBuf::from(&system_root);
        path.push("System32");
        put("PATH", path.into_os_string());
        put("TECTONIC_CACHE_DIR", cache.as_os_str().to_os_string());
        put("TEMP", tmp.as_os_str().to_os_string());
        put("TMP", tmp.as_os_str().to_os_string());

        let mut block: Vec<u16> = Vec::new();
        for (_, (k, v)) in map {
            if v.encode_wide().any(|c| c == 0) {
                return Err(format!("embedded NUL in environment variable {k:?}"));
            }
            block.extend(k.encode_wide());
            block.push(b'=' as u16);
            block.extend(v.encode_wide());
            block.push(0);
        }
        block.push(0);
        Ok(block)
    }

    // ---------- Layout / validation ----------

    struct Layout {
        probe: PathBuf,
        main_tex: PathBuf,
        cold_out: PathBuf,
        warm_out: PathBuf,
        work: PathBuf,
        cache: PathBuf,
        tmp: PathBuf,
        logs: PathBuf,
    }

    fn require_drive_abs(p: &Path, label: &str) -> Result<(), String> {
        if !p.is_absolute() {
            return Err(format!("{label} must be absolute: {}", p.display()));
        }
        match p.components().next() {
            Some(Component::Prefix(pc)) => match pc.kind() {
                Prefix::Disk(_) | Prefix::VerbatimDisk(_) => {}
                _ => {
                    return Err(format!(
                        "{label} must use a drive-letter path: {}",
                        p.display()
                    ))
                }
            },
            _ => {
                return Err(format!(
                    "{label} must start with a drive prefix: {}",
                    p.display()
                ))
            }
        }
        if p.components()
            .any(|c| matches!(c, Component::ParentDir | Component::CurDir))
        {
            return Err(format!(
                "{label} must not contain '.' or '..': {}",
                p.display()
            ));
        }
        Ok(())
    }

    fn mkdir(p: &Path) -> Result<(), String> {
        fs::create_dir(p).map_err(|e| format!("create_dir {}: {e}", p.display()))
    }

    fn create_layout(probe: &Path) -> Result<Layout, String> {
        // Non-recursive: fails if the probe directory (or its parent) is not as required.
        fs::create_dir(probe).map_err(|e| {
            format!(
                "create_dir {} (must not already exist, parent must exist): {e}",
                probe.display()
            )
        })?;
        let src = probe.join("src");
        let l = Layout {
            probe: probe.to_path_buf(),
            main_tex: src.join("main.tex"),
            cold_out: probe.join("out-cold"),
            warm_out: probe.join("out-warm"),
            work: probe.join("work"),
            cache: probe.join("cache"),
            tmp: probe.join("tmp"),
            logs: probe.join("logs"),
        };
        for d in [
            &src,
            &l.cold_out,
            &l.warm_out,
            &l.work,
            &l.cache,
            &l.tmp,
            &l.logs,
        ] {
            mkdir(d)?;
        }
        let tex = format!(
            "\\documentclass{{article}}\n\\pagestyle{{empty}}\n\\begin{{document}}\n{MARKER}\\\\\nModuTeX engine probe second line.\n\\end{{document}}\n"
        );
        let mut f = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&l.main_tex)
            .map_err(|e| format!("create {}: {e}", l.main_tex.display()))?;
        f.write_all(tex.as_bytes())
            .map_err(|e| format!("write {}: {e}", l.main_tex.display()))?;
        Ok(l)
    }

    // ---------- Launch ----------

    fn set_inherit(h: HANDLE, on: bool) -> Result<(), String> {
        let flags = if on { HANDLE_FLAG_INHERIT } else { 0 };
        if unsafe { SetHandleInformation(h, HANDLE_FLAG_INHERIT, flags) } == 0 {
            return Err(os_err("SetHandleInformation"));
        }
        Ok(())
    }

    /// Opens a fresh log (stdout+stderr share one file handle) and NUL stdin, marks only
    /// those inheritable, spawns, then clears inheritance again. The probe is single-threaded,
    /// so no other child can inherit them in between.
    fn launch(
        exe: &Path,
        l: &Layout,
        env: &[u16],
        out_dir: &Path,
        log_name: &str,
    ) -> Result<(Child, PathBuf), String> {
        let log_path = l.logs.join(log_name);
        let log = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&log_path)
            .map_err(|e| format!("create {}: {e}", log_path.display()))?;
        let nul = File::open("NUL").map_err(|e| format!("open NUL: {e}"))?;
        let (hl, hn) = (log.as_raw_handle() as HANDLE, nul.as_raw_handle() as HANDLE);
        set_inherit(hl, true)?;
        set_inherit(hn, true)?;

        let args: Vec<OsString> = vec![
            exe.as_os_str().to_os_string(),
            "--untrusted".into(),
            "--keep-logs".into(),
            "--synctex".into(),
            "--outdir".into(),
            out_dir.as_os_str().to_os_string(),
            l.main_tex.as_os_str().to_os_string(),
        ];
        let spawned = Child::spawn(exe, &args, env, &l.work, hn, hl);
        let _ = set_inherit(hl, false);
        let _ = set_inherit(hn, false);
        Ok((spawned?, log_path))
    }

    // ---------- PDF validation ----------

    struct PdfInfo {
        path: PathBuf,
        len: u64,
    }

    fn validate_pdf(path: &Path) -> Result<PdfInfo, String> {
        let mut f = File::open(path).map_err(|e| format!("open PDF {}: {e}", path.display()))?;
        let len = f.metadata().map_err(|e| format!("stat PDF: {e}"))?.len();
        if !(PDF_MIN..=PDF_MAX).contains(&len) {
            return Err(format!("PDF length {len} outside {PDF_MIN}..={PDF_MAX}"));
        }
        let mut head = [0u8; 5];
        f.read_exact(&mut head)
            .map_err(|e| format!("read PDF header: {e}"))?;
        if &head != b"%PDF-" {
            return Err("PDF header %PDF- missing".to_string());
        }
        let tail_len = len.min(1024);
        f.seek(SeekFrom::End(-(tail_len as i64)))
            .map_err(|e| format!("seek PDF tail: {e}"))?;
        let mut tail = vec![0u8; tail_len as usize];
        f.read_exact(&mut tail)
            .map_err(|e| format!("read PDF tail: {e}"))?;
        if !tail.windows(5).any(|w| w == b"%%EOF") {
            return Err("PDF trailer %%EOF missing in last 1KiB".to_string());
        }
        Ok(PdfInfo {
            path: path.to_path_buf(),
            len,
        })
    }

    // ---------- Entry ----------

    pub fn run() -> Result<(), String> {
        let argv: Vec<OsString> = std::env::args_os().skip(1).collect();
        if argv.len() != 2 {
            return Err(
                "usage: tectonic_probe <absolute-tectonic-exe> <absolute-probe-directory>"
                    .to_string(),
            );
        }
        let exe = PathBuf::from(&argv[0]);
        let probe = PathBuf::from(&argv[1]);
        require_drive_abs(&exe, "tectonic exe")?;
        require_drive_abs(&probe, "probe directory")?;
        if !exe.is_file() {
            return Err(format!("tectonic exe is not a file: {}", exe.display()));
        }

        let l = create_layout(&probe)?;
        let env = environment_block(&l.cache, &l.tmp)?;

        // 1) Cold compile (real deadline 300 s).
        let t0 = Instant::now();
        let (mut child, cold_log) = launch(&exe, &l, &env, &l.cold_out, "cold.log")?;
        let cold_pid = child.pid;
        let code = child.wait_exit(t0 + COLD_DEADLINE, &cold_log)?;
        let cold_elapsed = t0.elapsed();
        if code != 0 {
            let c = child.kill_and_drain();
            return Err(format!(
                "tectonic exited with code {code}; see {}{c}",
                cold_log.display()
            ));
        }
        let cold_idle = child.wait_job_idle()?;
        drop(child);
        let cold_log_len = check_log_cap(&cold_log)?;
        let pdf = validate_pdf(&l.cold_out.join("main.pdf"))?;
        let synctex_present = l.cold_out.join("main.synctex.gz").is_file();
        let engine_log_present = l.cold_out.join("main.log").is_file();

        // 2) Warm run: suspended -> assigned -> resumed, then immediate job termination + reap.
        let t1 = Instant::now();
        let (mut warm, warm_log) = launch(&exe, &l, &env, &l.warm_out, "cancel.log")?;
        let warm_pid = warm.pid;
        let warm_exit = warm.terminate_and_reap(PROBE_KILL_CODE)?;
        if warm_exit != PROBE_KILL_CODE {
            let c = warm.kill_and_drain();
            return Err(format!(
                "warm child exited with {warm_exit} before probe termination; cancellation not proven{c}"
            ));
        }
        let warm_idle = warm.wait_job_idle()?;
        drop(warm);
        let warm_elapsed = t1.elapsed();
        if warm_elapsed > WARM_DEADLINE {
            return Err(format!(
                "cancel cleanup took {warm_elapsed:?}, over {WARM_DEADLINE:?}"
            ));
        }
        let warm_log_len = check_log_cap(&warm_log)?;

        // 3) Receipt (written only after every check passed). This example computes no hashes.
        let receipt = serde_json::json!({
            "schema": "modutex.g1.tectonic_probe.v1",
            "run_id": uuid::Uuid::new_v4().to_string(),
            "tectonic_exe": exe.to_string_lossy(),
            "probe_dir": l.probe.to_string_lossy(),
            "cold": {
                "pid": cold_pid,
                "exit_code": code,
                "elapsed_ms": cold_elapsed.as_millis() as u64,
                "deadline_s": COLD_DEADLINE.as_secs(),
                "log_path": cold_log.to_string_lossy(),
                "log_len": cold_log_len,
                "job_active_processes_after_exit": cold_idle,
                "engine_log_present": engine_log_present,
                "synctex_present": synctex_present,
                "pdf": {
                    "path": pdf.path.to_string_lossy(),
                    "len": pdf.len,
                    "header_pdf": true,
                    "trailer_eof": true
                }
            },
            "cancel": {
                "pid": warm_pid,
                "started_suspended_assigned_resumed": true,
                "terminated_by_probe": true,
                "exit_code": warm_exit,
                "elapsed_ms": warm_elapsed.as_millis() as u64,
                "deadline_s": WARM_DEADLINE.as_secs(),
                "log_path": warm_log.to_string_lossy(),
                "log_len": warm_log_len,
                "job_active_processes_after_termination": warm_idle,
                "scope": "direct child reaped + job ActiveProcesses==0; not a full process-tree stress test"
            }
        });
        let receipt_path = l.probe.join("receipt.json");
        let text = serde_json::to_string_pretty(&receipt)
            .map_err(|e| format!("serialize receipt: {e}"))?;
        let mut f = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&receipt_path)
            .map_err(|e| format!("create {}: {e}", receipt_path.display()))?;
        f.write_all(text.as_bytes())
            .map_err(|e| format!("write receipt: {e}"))?;
        println!("{text}");
        Ok(())
    }
}
