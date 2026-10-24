// SPDX-License-Identifier: Apache-2.0
//! ConPTY backend for `portable-pty` with kernel-atomic Job Object
//! containment. The process is assigned by `PROC_THREAD_ATTRIBUTE_JOB_LIST`
//! as part of `CreateProcessW`; it is never launched first and assigned later.

use anyhow::{anyhow, bail, Result};
use portable_pty::{Child, ChildKiller, ExitStatus, MasterPty, PtySize};
use std::{
    alloc::{alloc_zeroed, dealloc, Layout},
    ffi::{c_void, OsStr, OsString},
    fs::{self, File},
    io::{self, Read, Write},
    mem::{align_of, size_of, zeroed},
    os::windows::{
        ffi::OsStrExt,
        io::{FromRawHandle, RawHandle},
    },
    path::{Path, PathBuf},
    ptr::{null, null_mut, NonNull},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};

type Handle = *mut c_void;

const WAIT_OBJECT_0: u32 = 0;
const WAIT_TIMEOUT: u32 = 258;
const WAIT_FAILED: u32 = u32::MAX;

const EXTENDED_STARTUPINFO_PRESENT: u32 = 0x0008_0000;
const STARTF_USESTDHANDLES: u32 = 0x0000_0100;
const INVALID_HANDLE_VALUE: Handle = -1isize as Handle;
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS: u32 = 9;
const JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION_CLASS: u32 = 1;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x0000_2000;
/// Win32 wide strings are limited to 32,767 UTF-16 code units including NUL.
const MAX_WIN32_STRING_UTF16: usize = 32_767;
const MAX_PATH: usize = 260;

// ProcThreadAttributeValue(number, FALSE, TRUE, FALSE).
const PROC_THREAD_ATTRIBUTE_JOB_LIST: usize = 0x0002_000d;
const PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE: usize = 0x0002_0016;

#[repr(C)]
#[derive(Clone, Copy)]
struct Coord {
    x: i16,
    y: i16,
}

#[repr(C)]
struct StartupInfoW {
    cb: u32,
    _lp_reserved: *mut u16,
    _lp_desktop: *mut u16,
    _lp_title: *mut u16,
    _dw_x: u32,
    _dw_y: u32,
    _dw_x_size: u32,
    _dw_y_size: u32,
    _dw_x_count_chars: u32,
    _dw_y_count_chars: u32,
    _dw_fill_attribute: u32,
    _dw_flags: u32,
    _w_show_window: u16,
    _cb_reserved2: u16,
    _lp_reserved2: *mut u8,
    _h_std_input: Handle,
    _h_std_output: Handle,
    _h_std_error: Handle,
}

#[repr(C)]
struct StartupInfoExW {
    startup_info: StartupInfoW,
    attribute_list: *mut c_void,
}

#[repr(C)]
struct ProcessInformation {
    process_handle: Handle,
    thread_handle: Handle,
    process_id: u32,
    _thread_id: u32,
}

#[repr(C)]
struct JobObjectBasicLimitInformation {
    _per_process_user_time_limit: i64,
    _per_job_user_time_limit: i64,
    limit_flags: u32,
    _minimum_working_set_size: usize,
    _maximum_working_set_size: usize,
    _active_process_limit: u32,
    _affinity: usize,
    _priority_class: u32,
    _scheduling_class: u32,
}

#[repr(C)]
struct JobObjectIoCounters {
    _read_operation_count: u64,
    _write_operation_count: u64,
    _other_operation_count: u64,
    _read_transfer_count: u64,
    _write_transfer_count: u64,
    _other_transfer_count: u64,
}

#[repr(C)]
struct JobObjectExtendedLimitInformation {
    basic_limit_information: JobObjectBasicLimitInformation,
    _io_info: JobObjectIoCounters,
    _process_memory_limit: usize,
    _job_memory_limit: usize,
    _peak_process_memory_used: usize,
    _peak_job_memory_used: usize,
}

#[repr(C)]
struct JobObjectBasicAccountingInformation {
    _total_user_time: i64,
    _total_kernel_time: i64,
    _this_period_total_user_time: i64,
    _this_period_total_kernel_time: i64,
    _total_page_fault_count: u32,
    _total_processes: u32,
    active_processes: u32,
    _total_terminated_processes: u32,
}

#[link(name = "kernel32")]
extern "system" {
    fn CloseHandle(handle: Handle) -> i32;
    fn CreatePipe(
        read_pipe: *mut Handle,
        write_pipe: *mut Handle,
        pipe_attributes: *mut c_void,
        size: u32,
    ) -> i32;
    fn CreatePseudoConsole(
        size: Coord,
        input: Handle,
        output: Handle,
        flags: u32,
        pseudo_console: *mut Handle,
    ) -> i32;
    fn ResizePseudoConsole(pseudo_console: Handle, size: Coord) -> i32;
    fn ClosePseudoConsole(pseudo_console: Handle);
    fn InitializeProcThreadAttributeList(
        attribute_list: *mut c_void,
        attribute_count: u32,
        flags: u32,
        size: *mut usize,
    ) -> i32;
    fn UpdateProcThreadAttribute(
        attribute_list: *mut c_void,
        flags: u32,
        attribute: usize,
        value: *mut c_void,
        size: usize,
        previous_value: *mut c_void,
        return_size: *mut usize,
    ) -> i32;
    fn DeleteProcThreadAttributeList(attribute_list: *mut c_void);
    fn CreateJobObjectW(attributes: *mut c_void, name: *const u16) -> Handle;
    fn SetInformationJobObject(
        job: Handle,
        information_class: u32,
        information: *const c_void,
        information_length: u32,
    ) -> i32;
    fn QueryInformationJobObject(
        job: Handle,
        information_class: u32,
        information: *mut c_void,
        information_length: u32,
        return_length: *mut u32,
    ) -> i32;
    fn TerminateJobObject(job: Handle, exit_code: u32) -> i32;
    fn CreateProcessW(
        application_name: *const u16,
        command_line: *mut u16,
        process_attributes: *mut c_void,
        thread_attributes: *mut c_void,
        inherit_handles: i32,
        creation_flags: u32,
        environment: *const c_void,
        current_directory: *const u16,
        startup_info: *mut StartupInfoW,
        process_information: *mut ProcessInformation,
    ) -> i32;
    fn WaitForSingleObject(handle: Handle, milliseconds: u32) -> u32;
    fn GetExitCodeProcess(process: Handle, exit_code: *mut u32) -> i32;
    fn GetShortPathNameW(lpszLongPath: *const u16, lpszShortPath: *mut u16, cchBuffer: u32) -> u32;
}

fn win32_error(operation: &str) -> anyhow::Error {
    anyhow!("{operation}: {}", io::Error::last_os_error())
}

fn pty_coord(size: PtySize) -> Result<Coord> {
    if size.cols == 0
        || size.rows == 0
        || size.cols > i16::MAX as u16
        || size.rows > i16::MAX as u16
    {
        bail!("invalid ConPTY dimensions {}x{}", size.cols, size.rows);
    }
    Ok(Coord {
        x: size.cols as i16,
        y: size.rows as i16,
    })
}

fn os_units(value: &OsStr, label: &str, allow_empty: bool) -> Result<Vec<u16>> {
    let units: Vec<u16> = value.encode_wide().collect();
    if (!allow_empty && units.is_empty()) || units.contains(&0) {
        bail!("{label} is empty or contains an embedded NUL");
    }
    if units.len() >= MAX_WIN32_STRING_UTF16 {
        bail!("{label} exceeds the Win32 UTF-16 length limit");
    }
    Ok(units)
}

fn nul_terminated_wide(value: &OsStr, label: &str) -> Result<Vec<u16>> {
    let mut units = os_units(value, label, false)?;
    units.push(0);
    Ok(units)
}

fn append_backslashes(output: &mut Vec<u16>, count: usize) {
    output.extend(std::iter::repeat_n(b'\\' as u16, count));
}

/// Appends one argument using the Windows CRT backslash/quote rules. Quoting
/// every argument also preserves empty strings and arguments ending in `\`.
fn append_quoted_argument(output: &mut Vec<u16>, argument: &OsStr, label: &str) -> Result<()> {
    let units = os_units(argument, label, true)?;
    output.push(b'"' as u16);
    let mut backslashes = 0usize;

    for unit in units {
        if unit == b'\\' as u16 {
            backslashes += 1;
            continue;
        }
        if unit == b'"' as u16 {
            let escaped = backslashes
                .checked_mul(2)
                .and_then(|count| count.checked_add(1))
                .ok_or_else(|| anyhow!("{label} quoting overflow"))?;
            append_backslashes(output, escaped);
            output.push(unit);
        } else {
            append_backslashes(output, backslashes);
            output.push(unit);
        }
        backslashes = 0;
    }

    let trailing_backslashes = backslashes
        .checked_mul(2)
        .ok_or_else(|| anyhow!("{label} quoting overflow"))?;
    append_backslashes(output, trailing_backslashes);
    output.push(b'"' as u16);
    Ok(())
}

fn build_command_line(executable: &OsStr, arguments: &[OsString]) -> Result<Vec<u16>> {
    let mut command_line = Vec::new();
    append_quoted_argument(&mut command_line, executable, "application name")?;
    if command_line.len() >= MAX_WIN32_STRING_UTF16 {
        bail!("command line exceeds the Win32 UTF-16 length limit");
    }

    for argument in arguments {
        command_line.push(b' ' as u16);
        append_quoted_argument(&mut command_line, argument, "shell argument")?;
        if command_line.len() >= MAX_WIN32_STRING_UTF16 {
            bail!("command line exceeds the Win32 UTF-16 length limit");
        }
    }

    command_line.push(0);
    Ok(command_line)
}

fn canonical_native_path(path: &Path, directory: bool, label: &str) -> Result<PathBuf> {
    let _ = os_units(path.as_os_str(), label, false)?;
    if !path.is_absolute() {
        bail!("{label} must be an absolute path");
    }
    let canonical = fs::canonicalize(path)
        .map_err(|error| anyhow!("verify {label} {}: {error}", path.display()))?;
    let metadata = fs::metadata(&canonical)
        .map_err(|error| anyhow!("inspect verified {label} {}: {error}", canonical.display()))?;
    if (directory && !metadata.is_dir()) || (!directory && !metadata.is_file()) {
        bail!(
            "{label} has an unexpected file type: {}",
            canonical.display()
        );
    }
    let _ = os_units(canonical.as_os_str(), label, false)?;
    Ok(canonical)
}

fn starts_with_ascii_ignore_case(value: &[u16], prefix: &[u8]) -> bool {
    value.len() >= prefix.len()
        && prefix.iter().enumerate().all(|(index, expected)| {
            let expected = *expected;
            value[index] == u16::from(expected.to_ascii_lowercase())
                || value[index] == u16::from(expected.to_ascii_uppercase())
        })
}

fn is_drive_absolute_path(path: &[u16]) -> bool {
    path.len() >= 3
        && ((u16::from(b'A')..=u16::from(b'Z')).contains(&path[0])
            || (u16::from(b'a')..=u16::from(b'z')).contains(&path[0]))
        && path[1] == u16::from(b':')
        && path[2] == u16::from(b'\\')
}

fn is_standard_unc_path(path: &[u16]) -> bool {
    let separator = u16::from(b'\\');
    if path.len() < 5
        || path[0] != separator
        || path[1] != separator
        || starts_with_ascii_ignore_case(path, b"\\\\?\\")
        || starts_with_ascii_ignore_case(path, b"\\\\.\\")
    {
        return false;
    }

    let rest = &path[2..];
    let Some(server_end) = rest.iter().position(|unit| *unit == separator) else {
        return false;
    };
    if server_end == 0 {
        return false;
    }
    let share = &rest[server_end + 1..];
    share.iter().take_while(|unit| **unit != separator).count() > 0
}

fn normalize_working_directory_syntax(raw: &[u16]) -> Result<Vec<u16>> {
    if raw.contains(&0) {
        bail!("working directory contains an embedded NUL");
    }

    if starts_with_ascii_ignore_case(raw, b"\\\\?\\UNC\\") {
        let tail = &raw[8..];
        let mut unc = Vec::with_capacity(tail.len() + 2);
        unc.extend_from_slice(&[b'\\' as u16, b'\\' as u16]);
        unc.extend_from_slice(tail);
        if !is_standard_unc_path(&unc) {
            bail!("working directory is not a supported UNC path");
        }
        Ok(unc)
    } else if starts_with_ascii_ignore_case(raw, b"\\\\?\\") {
        let drive_path = &raw[4..];
        if !is_drive_absolute_path(drive_path) {
            bail!("working directory is not a supported DOS drive path");
        }
        Ok(drive_path.to_vec())
    } else if is_drive_absolute_path(raw) || is_standard_unc_path(raw) {
        Ok(raw.to_vec())
    } else {
        bail!("working directory is not a supported absolute DOS drive or UNC path")
    }
}

fn try_identity_matched_short_path(path: &Path) -> Option<Vec<u16>> {
    let path_wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut buffer = vec![0u16; MAX_PATH + 16];
    let len =
        unsafe { GetShortPathNameW(path_wide.as_ptr(), buffer.as_mut_ptr(), buffer.len() as u32) };
    if len == 0 || len as usize >= buffer.len() {
        return None;
    }
    buffer.truncate(len as usize);
    let normalized_short = normalize_working_directory_syntax(&buffer).ok()?;
    if normalized_short.len() > MAX_PATH - 1 {
        return None;
    }
    use std::os::windows::ffi::OsStringExt;
    let short_os = OsString::from_wide(&normalized_short);
    let target_canonical = fs::canonicalize(path).ok()?;
    let short_canonical = fs::canonicalize(&short_os).ok()?;
    if target_canonical != short_canonical {
        return None;
    }
    Some(normalized_short)
}

fn working_directory_for_create_process(path: &Path) -> Result<Vec<u16>> {
    let raw: Vec<u16> = path.as_os_str().encode_wide().collect();
    let normalized = normalize_working_directory_syntax(&raw)?;
    let chosen = if normalized.len() > MAX_PATH - 1 {
        try_identity_matched_short_path(path).unwrap_or(normalized)
    } else {
        normalized
    };

    if chosen.len() >= MAX_WIN32_STRING_UTF16 {
        bail!("working directory exceeds the Win32 UTF-16 length limit");
    }
    let mut terminated = chosen;
    terminated.push(0);
    Ok(terminated)
}

/// A uniquely owned Win32 handle. It is kept private so process termination
/// remains available only through the Job Object capability.
#[derive(Debug)]
struct OwnedHandle(NonNull<c_void>);

// Win32 kernel handles may be transferred between threads; this wrapper owns
// the handle and closes it exactly once.
unsafe impl Send for OwnedHandle {}
unsafe impl Sync for OwnedHandle {}

impl OwnedHandle {
    unsafe fn from_raw(raw: Handle, operation: &str) -> Result<Self> {
        let Some(handle) = NonNull::new(raw) else {
            return Err(win32_error(operation));
        };
        if handle.as_ptr() as isize == -1 {
            bail!("{operation}: API returned an invalid handle");
        }
        Ok(Self(handle))
    }

    /// `CreateProcessW` success guarantees both process and primary-thread
    /// handles are non-null. This path performs no allocation or fallible work.
    unsafe fn from_process_creation_success(raw: Handle) -> Self {
        Self(NonNull::new_unchecked(raw))
    }

    fn as_raw(&self) -> Handle {
        self.0.as_ptr()
    }

    fn into_raw(self) -> Handle {
        let raw = self.0.as_ptr();
        std::mem::forget(self);
        raw
    }

    fn into_file(self) -> File {
        // The handle was created as one endpoint of a Win32 anonymous pipe.
        unsafe { File::from_raw_handle(self.into_raw() as RawHandle) }
    }
}

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.as_raw());
        }
    }
}

fn create_pipe() -> Result<(OwnedHandle, OwnedHandle)> {
    let mut read_pipe = null_mut();
    let mut write_pipe = null_mut();
    if unsafe { CreatePipe(&mut read_pipe, &mut write_pipe, null_mut(), 0) } == 0 {
        let error = win32_error("CreatePipe");
        unsafe {
            if !read_pipe.is_null() {
                let _ = CloseHandle(read_pipe);
            }
            if !write_pipe.is_null() {
                let _ = CloseHandle(write_pipe);
            }
        }
        return Err(error);
    }

    let read_pipe = unsafe { OwnedHandle::from_raw(read_pipe, "CreatePipe(read)")? };
    let write_pipe = unsafe { OwnedHandle::from_raw(write_pipe, "CreatePipe(write)")? };
    Ok((read_pipe, write_pipe))
}

#[derive(Debug)]
struct PseudoConsole(NonNull<c_void>);

// The Arc owning this handle prevents ClosePseudoConsole from racing its users.
unsafe impl Send for PseudoConsole {}
unsafe impl Sync for PseudoConsole {}

impl PseudoConsole {
    fn as_raw(&self) -> Handle {
        self.0.as_ptr()
    }
}

impl Drop for PseudoConsole {
    fn drop(&mut self) {
        unsafe {
            ClosePseudoConsole(self.as_raw());
        }
    }
}

#[derive(Debug)]
struct JobObject {
    handle: OwnedHandle,
}

impl JobObject {
    fn create() -> Result<Arc<Self>> {
        let raw = unsafe { CreateJobObjectW(null_mut(), null()) };
        // A private, non-inheritable job is configured before any process exists.
        let handle = unsafe { OwnedHandle::from_raw(raw, "CreateJobObjectW")? };
        let mut limits: JobObjectExtendedLimitInformation = unsafe { zeroed() };
        limits.basic_limit_information.limit_flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let configured = unsafe {
            SetInformationJobObject(
                handle.as_raw(),
                JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS,
                (&limits as *const JobObjectExtendedLimitInformation).cast(),
                size_of::<JobObjectExtendedLimitInformation>() as u32,
            )
        };
        if configured == 0 {
            return Err(win32_error("SetInformationJobObject"));
        }
        Ok(Arc::new(Self { handle }))
    }

    fn active_processes(&self) -> io::Result<u32> {
        let mut information: JobObjectBasicAccountingInformation = unsafe { zeroed() };
        let queried = unsafe {
            QueryInformationJobObject(
                self.handle.as_raw(),
                JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION_CLASS,
                (&mut information as *mut JobObjectBasicAccountingInformation).cast(),
                size_of::<JobObjectBasicAccountingInformation>() as u32,
                null_mut(),
            )
        };
        if queried == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(information.active_processes)
    }

    fn terminate_all(&self, exit_code: u32) -> io::Result<()> {
        if self.active_processes()? == 0 {
            return Ok(());
        }
        if unsafe { TerminateJobObject(self.handle.as_raw(), exit_code) } != 0 {
            return Ok(());
        }

        let error = io::Error::last_os_error();
        // The last member may have exited between the accounting query and
        // TerminateJobObject. Treat that race as an already-completed kill.
        if self.active_processes()? == 0 {
            Ok(())
        } else {
            Err(error)
        }
    }
}

/// Retained job capability used by session cleanup and native verification.
/// A group is drained only when the kernel reports no active job processes.
#[derive(Clone, Debug)]
pub(crate) struct JobProcessGroup(Arc<JobObject>);

impl JobProcessGroup {
    pub(crate) fn active_processes(&self) -> io::Result<u32> {
        self.0.active_processes()
    }

    pub(crate) fn terminate_all(&self, exit_code: u32) -> io::Result<()> {
        self.0.terminate_all(exit_code)
    }
}

#[derive(Debug)]
struct JobKiller {
    job: Arc<JobObject>,
}

impl ChildKiller for JobKiller {
    fn kill(&mut self) -> io::Result<()> {
        self.job.terminate_all(1)?;
        Ok(())
    }

    fn clone_killer(&self) -> Box<dyn ChildKiller + Send + Sync> {
        Box::new(Self {
            job: Arc::clone(&self.job),
        })
    }
}

/// Owns the attribute list and its JOB_LIST array together. Windows requires
/// the array referenced by JOB_LIST to remain valid through
/// DeleteProcThreadAttributeList.
struct ProcThreadAttributeList {
    list: NonNull<c_void>,
    layout: Layout,
    job_handles: Vec<Handle>,
}

impl ProcThreadAttributeList {
    fn new(job: Handle, pseudo_console: Handle) -> Result<Self> {
        let mut required_size = 0usize;
        unsafe {
            // The sizing call is expected to return false and fill required_size.
            let _ = InitializeProcThreadAttributeList(null_mut(), 2, 0, &mut required_size);
        }
        if required_size == 0 {
            return Err(win32_error("InitializeProcThreadAttributeList(size)"));
        }
        let layout = Layout::from_size_align(required_size, align_of::<usize>())
            .map_err(|error| anyhow!("invalid process attribute-list layout: {error}"))?;
        let allocation = unsafe { alloc_zeroed(layout) };
        let Some(list) = NonNull::new(allocation.cast::<c_void>()) else {
            bail!("allocate process attribute list failed");
        };
        if unsafe { InitializeProcThreadAttributeList(list.as_ptr(), 2, 0, &mut required_size) }
            == 0
        {
            let error = win32_error("InitializeProcThreadAttributeList");
            unsafe {
                dealloc(list.as_ptr().cast::<u8>(), layout);
            }
            return Err(error);
        }

        let mut result = Self {
            list,
            layout,
            job_handles: Vec::new(),
        };
        result
            .job_handles
            .try_reserve_exact(1)
            .map_err(|error| anyhow!("allocate JOB_LIST storage: {error}"))?;
        result.job_handles.push(job);

        // JOB_LIST receives a pointer to the ordered HANDLE array, not a HANDLE
        // value. Its Vec is retained until this attribute list is deleted.
        if unsafe {
            UpdateProcThreadAttribute(
                result.list.as_ptr(),
                0,
                PROC_THREAD_ATTRIBUTE_JOB_LIST,
                result.job_handles.as_ptr() as *mut c_void,
                size_of::<Handle>(),
                null_mut(),
                null_mut(),
            )
        } == 0
        {
            return Err(win32_error("UpdateProcThreadAttribute(JOB_LIST)"));
        }

        // PSEUDOCONSOLE takes the HPCON value itself as lpValue.
        if unsafe {
            UpdateProcThreadAttribute(
                result.list.as_ptr(),
                0,
                PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE,
                pseudo_console,
                size_of::<Handle>(),
                null_mut(),
                null_mut(),
            )
        } == 0
        {
            return Err(win32_error("UpdateProcThreadAttribute(PSEUDOCONSOLE)"));
        }

        Ok(result)
    }

    fn as_raw(&self) -> *mut c_void {
        self.list.as_ptr()
    }
}

impl Drop for ProcThreadAttributeList {
    fn drop(&mut self) {
        // `job_handles` remains alive until after this Drop body completes.
        unsafe {
            DeleteProcThreadAttributeList(self.list.as_ptr());
            dealloc(self.list.as_ptr().cast::<u8>(), self.layout);
        }
    }
}

/// Host-created, non-IPC spawn descriptor. The terminal service supplies its
/// already verified executable and cwd, plus the trusted shell argv.
pub(crate) struct NativeSpawnDescriptor<'a> {
    pub(crate) executable: &'a Path,
    pub(crate) arguments: &'a [OsString],
    pub(crate) working_directory: &'a Path,
}

pub(crate) struct SpawnedChild {
    pub(crate) child: Box<dyn Child + Send + Sync>,
    pub(crate) job: JobProcessGroup,
}

pub(crate) struct NativePtyPair {
    pub(crate) master: Box<dyn MasterPty + Send>,
    slave: Option<ConPtySlave>,
}

#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct JobPtySystem;

impl JobPtySystem {
    pub(crate) fn openpty(&self, size: PtySize) -> Result<NativePtyPair> {
        let coordinate = pty_coord(size)?;
        let (input_for_console, input_for_host) = create_pipe()?;
        let (output_for_host, output_for_console) = create_pipe()?;
        let mut raw_console = null_mut();
        let result = unsafe {
            CreatePseudoConsole(
                coordinate,
                input_for_console.as_raw(),
                output_for_console.as_raw(),
                0,
                &mut raw_console,
            )
        };
        if result < 0 {
            if !raw_console.is_null() {
                unsafe {
                    ClosePseudoConsole(raw_console);
                }
            }
            bail!(
                "CreatePseudoConsole failed with HRESULT 0x{:08X}",
                result as u32
            );
        }
        let Some(raw_console) = NonNull::new(raw_console) else {
            bail!("CreatePseudoConsole returned a null HPCON");
        };
        let pseudo_console = Arc::new(PseudoConsole(raw_console));

        // ConPTY owns its duplicated ends; only the host's input writer and
        // output reader remain open in this process.
        drop(input_for_console);
        drop(output_for_console);

        Ok(NativePtyPair {
            master: Box::new(ConPtyMaster {
                pseudo_console: Arc::clone(&pseudo_console),
                size: Mutex::new(size),
                input_writer: Mutex::new(Some(input_for_host.into_file())),
                output_reader: Mutex::new(Some(output_for_host.into_file())),
            }),
            slave: Some(ConPtySlave { pseudo_console }),
        })
    }
}

struct ConPtyMaster {
    pseudo_console: Arc<PseudoConsole>,
    size: Mutex<PtySize>,
    input_writer: Mutex<Option<File>>,
    output_reader: Mutex<Option<File>>,
}

impl MasterPty for ConPtyMaster {
    fn resize(&self, size: PtySize) -> Result<()> {
        let coordinate = pty_coord(size)?;
        let mut current_size = self
            .size
            .lock()
            .map_err(|_| anyhow!("ConPTY size mutex poisoned"))?;
        let result = unsafe { ResizePseudoConsole(self.pseudo_console.as_raw(), coordinate) };
        if result < 0 {
            bail!(
                "ResizePseudoConsole failed with HRESULT 0x{:08X}",
                result as u32
            );
        }
        *current_size = size;
        Ok(())
    }

    fn get_size(&self) -> Result<PtySize> {
        self.size
            .lock()
            .map(|size| *size)
            .map_err(|_| anyhow!("ConPTY size mutex poisoned"))
    }

    fn try_clone_reader(&self) -> Result<Box<dyn Read + Send>> {
        let reader = self
            .output_reader
            .lock()
            .map_err(|_| anyhow!("ConPTY output-reader mutex poisoned"))?;
        let reader = reader
            .as_ref()
            .ok_or_else(|| anyhow!("ConPTY output reader was already closed"))?;
        Ok(Box::new(reader.try_clone()?))
    }

    fn take_writer(&self) -> Result<Box<dyn Write + Send>> {
        let mut writer = self
            .input_writer
            .lock()
            .map_err(|_| anyhow!("ConPTY input-writer mutex poisoned"))?;
        let writer = writer
            .take()
            .ok_or_else(|| anyhow!("ConPTY input writer was already taken"))?;
        Ok(Box::new(writer))
    }
}

impl NativePtyPair {
    pub(crate) fn spawn_trusted(
        &mut self,
        descriptor: &NativeSpawnDescriptor<'_>,
    ) -> Result<SpawnedChild> {
        let slave = self
            .slave
            .as_ref()
            .ok_or_else(|| anyhow!("ConPTY slave can spawn only one process"))?;
        let spawned = slave.spawn_trusted(descriptor)?;
        self.slave.take();
        Ok(spawned)
    }
}

struct ConPtySlave {
    pseudo_console: Arc<PseudoConsole>,
}

impl ConPtySlave {
    fn spawn_trusted(&self, descriptor: &NativeSpawnDescriptor<'_>) -> Result<SpawnedChild> {
        let executable = canonical_native_path(descriptor.executable, false, "shell executable")?;
        let working_directory =
            canonical_native_path(descriptor.working_directory, true, "working directory")?;
        let application_name = nul_terminated_wide(executable.as_os_str(), "application name")?;
        let mut command_line = build_command_line(executable.as_os_str(), descriptor.arguments)?;
        let current_directory = working_directory_for_create_process(&working_directory)?;
        let is_unc = is_standard_unc_path(&current_directory[..current_directory.len() - 1]);
        let is_cmd = executable
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.eq_ignore_ascii_case("cmd.exe"));
        if is_unc && is_cmd {
            bail!("cmd.exe does not support UNC paths as working directory");
        }

        let job = JobObject::create()?;
        let process_group = JobProcessGroup(Arc::clone(&job));
        // Allocate the Child before process creation. On CreateProcessW success,
        // its native process handle is adopted immediately with no fallible gap.
        let mut child = Box::new(WinChild::before_spawn(Arc::clone(&job)));
        let attributes =
            ProcThreadAttributeList::new(job.handle.as_raw(), self.pseudo_console.as_raw())?;
        let mut startup_info: StartupInfoW = unsafe { zeroed() };
        startup_info.cb = size_of::<StartupInfoExW>() as u32;
        startup_info._dw_flags = STARTF_USESTDHANDLES;
        startup_info._h_std_input = INVALID_HANDLE_VALUE;
        startup_info._h_std_output = INVALID_HANDLE_VALUE;
        startup_info._h_std_error = INVALID_HANDLE_VALUE;
        let mut startup_info_ex = StartupInfoExW {
            startup_info,
            attribute_list: attributes.as_raw(),
        };
        let mut process_information = ProcessInformation {
            process_handle: null_mut(),
            thread_handle: null_mut(),
            process_id: 0,
            _thread_id: 0,
        };

        // The host supplies no environment overrides. A null environment pointer
        // preserves CreateProcessW inheritance, including non-Unicode entries.
        // JOB_LIST assigns the process before it can run. No suspended process,
        // post-spawn assignment, or forwarded parent stdio handles are used.
        let created = unsafe {
            CreateProcessW(
                application_name.as_ptr(),
                command_line.as_mut_ptr(),
                null_mut(),
                null_mut(),
                0,
                EXTENDED_STARTUPINFO_PRESENT,
                null(),
                current_directory.as_ptr(),
                &mut startup_info_ex.startup_info,
                &mut process_information,
            )
        };
        if created == 0 {
            let error = io::Error::last_os_error();
            unsafe {
                if !process_information.thread_handle.is_null() {
                    let _ = CloseHandle(process_information.thread_handle);
                }
                if !process_information.process_handle.is_null() {
                    let _ = CloseHandle(process_information.process_handle);
                }
            }
            return Err(anyhow!("CreateProcessW: {error}"));
        }

        // CreateProcessW success guarantees these handles. Adopt both before any
        // cleanup or other operation can fail.
        let process_handle = unsafe {
            OwnedHandle::from_process_creation_success(process_information.process_handle)
        };
        let thread_handle = unsafe {
            OwnedHandle::from_process_creation_success(process_information.thread_handle)
        };
        child.process = Some(process_handle);
        child.process_id = process_information.process_id;
        drop(thread_handle);
        drop(attributes);

        let child: Box<dyn Child + Send + Sync> = child;
        Ok(SpawnedChild {
            child,
            job: process_group,
        })
    }
}

#[derive(Debug)]
struct WinChild {
    process: Option<OwnedHandle>,
    job: Arc<JobObject>,
    process_id: u32,
    reaped_exit_code: Option<u32>,
    termination_requested: bool,
}

impl WinChild {
    fn before_spawn(job: Arc<JobObject>) -> Self {
        Self {
            process: None,
            job,
            process_id: 0,
            reaped_exit_code: None,
            termination_requested: false,
        }
    }

    fn direct_exit_code(&self) -> io::Result<Option<u32>> {
        let process = self
            .process
            .as_ref()
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "process handle unavailable"))?;
        match unsafe { WaitForSingleObject(process.as_raw(), 0) } {
            WAIT_TIMEOUT => Ok(None),
            WAIT_OBJECT_0 => {
                let mut exit_code = 0;
                if unsafe { GetExitCodeProcess(process.as_raw(), &mut exit_code) } == 0 {
                    return Err(io::Error::last_os_error());
                }
                Ok(Some(exit_code))
            }
            WAIT_FAILED => Err(io::Error::last_os_error()),
            value => Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("WaitForSingleObject returned unexpected status {value}"),
            )),
        }
    }
}

impl ChildKiller for WinChild {
    fn kill(&mut self) -> io::Result<()> {
        self.job.terminate_all(1)?;
        Ok(())
    }

    fn clone_killer(&self) -> Box<dyn ChildKiller + Send + Sync> {
        Box::new(JobKiller {
            job: Arc::clone(&self.job),
        })
    }
}

impl Child for WinChild {
    fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        if let Some(exit_code) = self.reaped_exit_code {
            return Ok(Some(ExitStatus::with_exit_code(exit_code)));
        }
        let Some(exit_code) = self.direct_exit_code()? else {
            return Ok(None);
        };

        // A signaled leader is not a completed PTY session while any process
        // remains in its private job. Terminate the owned job and poll until its
        // active-process count reaches zero before returning Some.
        let deadline = Instant::now() + Duration::from_millis(250);
        loop {
            if self.job.active_processes()? == 0 {
                self.reaped_exit_code = Some(exit_code);
                return Ok(Some(ExitStatus::with_exit_code(exit_code)));
            }
            if !self.termination_requested {
                self.job.terminate_all(1)?;
                self.termination_requested = true;
            }
            if Instant::now() >= deadline {
                return Ok(None);
            }
            thread::sleep(Duration::from_millis(5));
        }
    }

    fn wait(&mut self) -> io::Result<ExitStatus> {
        loop {
            if let Some(status) = self.try_wait()? {
                return Ok(status);
            }
            thread::sleep(Duration::from_millis(10));
        }
    }

    fn process_id(&self) -> Option<u32> {
        Some(self.process_id)
    }

    fn as_raw_handle(&self) -> Option<RawHandle> {
        self.process
            .as_ref()
            .map(|process| process.as_raw() as RawHandle)
    }
}

impl Drop for WinChild {
    fn drop(&mut self) {
        if self.reaped_exit_code.is_none() {
            // Drop and cleanup-ticket handoff retain the job capability. Closing
            // its last handle is also protected by KILL_ON_JOB_CLOSE.
            let _ = self.job.terminate_all(1);
        }
    }
}

#[cfg(test)]
#[path = "../../tests/unit/win_conpty.rs"]
mod tests;
