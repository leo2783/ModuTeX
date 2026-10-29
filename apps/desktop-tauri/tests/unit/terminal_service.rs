// SPDX-License-Identifier: Apache-2.0
//! Unit and supervision tests for terminal service extracted from inline source.

pub(super) use super::windows_pty;
use super::*;

#[test]
fn session_ids_are_lowercase_uuid_v4_and_reject_invalid_tokens() {
    let id1 = TerminalSessionId::generate();
    let id2 = TerminalSessionId::generate();
    assert_ne!(id1, id2);
    assert_eq!(TerminalSessionId::parse(id1.as_str()).ok(), Some(id1));
    assert!(TerminalSessionId::parse("").is_err());
    assert!(TerminalSessionId::parse("not-a-uuid").is_err());
    assert!(TerminalSessionId::parse("123E4567-E89B-42D3-A456-426614174000").is_err());
}

#[test]
fn terminal_event_payload_exit_serializes_with_camel_case_exit_code() {
    let payload = TerminalEventPayload::Exit {
        exit_code: Some(0),
        reason: TerminalExitReason::GracefulExit,
    };
    let serialized = serde_json::to_string(&payload).expect("serialize exit payload");
    assert_eq!(
        serialized,
        r#"{"type":"exit","exitCode":0,"reason":"GRACEFUL_EXIT"}"#
    );
}

#[test]
fn utf8_stream_splitter_preserves_multibyte_codepoints_across_single_byte_splits() {
    let sample = "中文終端𠀀A\n";
    let mut splitter = Utf8StreamSplitter::new();
    let mut reconstructed_bytes = Vec::new();
    let mut reconstructed_text = String::new();

    for byte in sample.as_bytes() {
        if let Some((bytes, text)) = splitter.push(std::slice::from_ref(byte)) {
            reconstructed_bytes.extend_from_slice(&bytes);
            reconstructed_text.push_str(&text);
        }
    }
    if let Some((bytes, text)) = splitter.finish() {
        reconstructed_bytes.extend_from_slice(&bytes);
        reconstructed_text.push_str(&text);
    }

    assert_eq!(reconstructed_bytes, sample.as_bytes());
    assert_eq!(reconstructed_text, sample);
    assert!(!reconstructed_text.contains('\u{FFFD}'));
}

#[test]
fn bounded_byte_queue_enforces_chunk_and_byte_limits() {
    let mut queue = BoundedByteQueue::new(2, 4, 6);
    assert_eq!(
        queue.push(vec![]),
        Err(TerminalErrorKind::InvalidInputPayload)
    );
    assert_eq!(
        queue.push(vec![1, 2, 3, 4, 5]),
        Err(TerminalErrorKind::InvalidInputPayload)
    );
    assert_eq!(queue.push(vec![1, 2, 3, 4]), Ok(()));
    // Exceeds total byte limit (4 + 3 > 6)
    assert_eq!(
        queue.push(vec![5, 6, 7]),
        Err(TerminalErrorKind::InputBackpressure)
    );
    assert_eq!(queue.push(vec![5, 6]), Ok(()));
    // Exceeds chunk count limit (2 chunks)
    assert_eq!(
        queue.push(vec![7]),
        Err(TerminalErrorKind::InputBackpressure)
    );
    assert_eq!(queue.pop(), Some(vec![1, 2, 3, 4]));
    assert_eq!(queue.queued_bytes(), 2);
    queue.close_and_clear();
    assert_eq!(queue.push(vec![1]), Err(TerminalErrorKind::SessionClosed));
}

#[test]
fn terminate_classification_ignores_stale_error_on_nonzero_and_flags_real_errors() {
    let mut queried = false;
    let ok = classify_terminate_syscall(true, 1, || {
        queried = true;
        (Some(6), "stale invalid handle".to_string())
    });
    assert!(!queried);
    assert_eq!(resolve_kill_error(&ok, None), None);

    let err6 = classify_terminate_syscall(true, 0, || (Some(6), "invalid handle".to_string()));
    assert!(resolve_kill_error(&err6, Some(0)).is_some());

    let denied = classify_terminate_syscall(true, 0, || (Some(5), "access denied".to_string()));
    assert!(resolve_kill_error(&denied, None).is_some());
    assert_eq!(resolve_kill_error(&denied, Some(0)), None);
}

#[cfg(all(windows, target_arch = "x86_64"))]
mod native {
    use super::*;

    #[test]
    fn conpty_lifecycle_utf8_resize_backpressure_and_owner_revocation() {
        let owner = OwnerId::from_label("main").expect("owner");
        let other_owner = OwnerId::from_label("secondary").expect("other owner");
        let workspace_id = WorkspaceId::parse("ws-1").expect("workspace");
        let sink = Arc::new(BoundedEventSink::new(256, 512 * 1024));
        let service = TerminalService::new(sink.clone());
        let shell = TrustedShellConfig::default_windows_shell();

        let avail = service.availability(&owner, &shell);
        assert!(avail.available, "ConPTY should be available: {avail:?}");

        let temp_dir = std::env::temp_dir().join(format!(
            "modutex-term-svc-{}",
            TerminalSessionId::generate()
        ));
        fs::create_dir_all(&temp_dir).expect("temp dir");

        let spec = TerminalSpawnSpec::new(
            owner.clone(),
            workspace_id,
            temp_dir.clone(),
            shell,
            TerminalSize::new(80, 24).expect("size"),
        );
        let (cancel_handle, cancel_token) = cancellation_pair();
        let info = service
            .spawn(&spec, cancel_handle, cancel_token)
            .expect("spawn ConPTY session");
        assert!(info.pid > 0);

        // Cross-owner access must be rejected.
        assert_eq!(
            service
                .write_input(&other_owner, &info.session_id, b"echo no\r\n")
                .err()
                .map(|e| e.kind),
            Some(TerminalErrorKind::OwnerMismatch)
        );

        service
            .write_input(&owner, &info.session_id, b"chcp 65001\r\n")
            .expect("chcp");
        service
            .write_input(
                &owner,
                &info.session_id,
                "set T_A=中文& set T_B=終端𠀀\r\necho %T_A%%T_B%\r\n".as_bytes(),
            )
            .expect("write unicode command");

        let resized = service
            .resize(
                &owner,
                &info.session_id,
                TerminalSize::new(100, 30).expect("100x30"),
            )
            .expect("resize");
        assert_eq!(
            resized,
            TerminalSize {
                cols: 100,
                rows: 30
            }
        );

        let deadline = Instant::now() + Duration::from_secs(5);
        let mut transcript = String::new();
        while Instant::now() < deadline && !transcript.contains("中文終端𠀀") {
            for ev in sink.drain_for_owner(&owner) {
                if let TerminalEventPayload::Data { text, .. } = ev.payload {
                    transcript.push_str(&text);
                }
            }
            thread::sleep(Duration::from_millis(25));
        }
        assert!(
            transcript.contains("中文終端𠀀"),
            "expected UTF-8 marker in transcript"
        );

        let report = service
            .kill(&owner, &info.session_id)
            .expect("kill session cleanly");
        assert_eq!(report.cleanup, TerminalCleanupProof::SessionDrained);
        assert!(report.child_reaped && report.writer_closed && report.reader_joined);

        let exit_events: Vec<_> = sink
            .drain_for_owner(&owner)
            .into_iter()
            .filter(|e| matches!(e.payload, TerminalEventPayload::Exit { .. }))
            .collect();
        assert_eq!(exit_events.len(), 1);

        let _ = fs::remove_dir_all(&temp_dir);
    }
}

#[cfg(all(windows, target_arch = "x86_64"))]
mod reviewer_supervision_tests {
    use super::*;
    use std::{
        fs, thread,
        time::{Duration, Instant},
    };
    #[test]
    fn reviewer_post_spawn_failure_retains_cleanup_until_the_fault_is_released() {
        let path =
            std::env::temp_dir().join(format!("modutex-terminal-fault-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&path).unwrap();
        let owner = OwnerId::from_label("main").unwrap();
        let service = TerminalService::new(Arc::new(BoundedEventSink::new(128, 65536)));
        let spec = TerminalSpawnSpec::new(
            owner,
            WorkspaceId::parse("ws-review-fault").unwrap(),
            path.clone(),
            TrustedShellConfig::default_windows_shell(),
            TerminalSize::new(80, 24).unwrap(),
        );
        let (cancel, token) = cancellation_pair();
        let probe = super::windows_pty::inject_after_spawn_failure();
        let begin = Instant::now();
        let result = service.spawn(&spec, cancel, token);
        let elapsed = begin.elapsed();
        let enqueued = probe.enqueued();
        let completed_while_held = probe.completed();
        probe.release();
        let end = Instant::now() + Duration::from_secs(5);
        while !probe.completed() && Instant::now() < end {
            thread::sleep(Duration::from_millis(10))
        }
        let completed = probe.completed();
        if let Ok(info) = &result {
            let _ = service.kill(&spec.owner, &info.session_id);
        }
        drop(service);
        let _ = fs::remove_dir_all(path);
        let error = result.expect_err("fault must fail after real child creation");
        assert_eq!(error.kind, TerminalErrorKind::SpawnFailed);
        assert_eq!(error.cleanup, TerminalCleanupProof::Deferred);
        assert!(elapsed < Duration::from_secs(2));
        assert!(enqueued);
        assert!(
            !completed_while_held,
            "cleanup cannot be claimed while fault prevents native proof"
        );
        assert!(
            completed,
            "owned reaper must eventually complete after release"
        );
    }
    #[test]
    fn reviewer_dropping_service_reaps_its_real_child_process() {
        use windows_sys::Win32::{
            Foundation::CloseHandle,
            System::Threading::{OpenProcess, WaitForSingleObject},
        };
        let path =
            std::env::temp_dir().join(format!("modutex-terminal-drop-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&path).unwrap();
        let owner = OwnerId::from_label("main").unwrap();
        let service = TerminalService::new(Arc::new(BoundedEventSink::new(128, 65536)));
        let spec = TerminalSpawnSpec::new(
            owner,
            WorkspaceId::parse("ws-review-drop").unwrap(),
            path.clone(),
            TrustedShellConfig::default_windows_shell(),
            TerminalSize::new(80, 24).unwrap(),
        );
        let (cancel, token) = cancellation_pair();
        let info = service.spawn(&spec, cancel, token).unwrap();
        let handle = unsafe { OpenProcess(0x00100000, 0, info.pid) };
        assert!(!handle.is_null());
        let begin = Instant::now();
        drop(service);
        let elapsed = begin.elapsed();
        let waited = unsafe { WaitForSingleObject(handle, 5000) };
        unsafe { CloseHandle(handle) };
        let _ = fs::remove_dir_all(path);
        assert!(
            elapsed < Duration::from_secs(3),
            "service drop must finish bounded ownership transfer"
        );
        assert_eq!(
            waited, 0,
            "real child process must be signaled after service drop"
        );
    }

    fn resolve_test_node_exe() -> PathBuf {
        let standard = PathBuf::from(r"C:\Program Files\nodejs\node.exe");
        if standard.is_file() {
            return fs::canonicalize(&standard).unwrap_or(standard);
        }
        if let Some(pf) = std::env::var_os("ProgramFiles") {
            let p = PathBuf::from(pf).join(r"nodejs\node.exe");
            if p.is_file() {
                return fs::canonicalize(&p).unwrap_or(p);
            }
        }
        if let Some(path_var) = std::env::var_os("PATH") {
            for entry in std::env::split_paths(&path_var) {
                let candidate = entry.join("node.exe");
                if candidate.is_file() {
                    return fs::canonicalize(&candidate).unwrap_or(candidate);
                }
            }
        }
        panic!("node.exe required for ConPTY native parity verification");
    }

    #[test]
    fn reviewer_descendant_node_tree_and_leader_exit_leaves_job_zero() {
        use windows_sys::Win32::{
            Foundation::CloseHandle,
            System::Threading::{OpenProcess, WaitForSingleObject},
        };
        let node_exe = resolve_test_node_exe();
        let path = std::env::temp_dir().join(format!(
            "modutex-terminal-node-tree-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir(&path).unwrap();
        let owner = OwnerId::from_label("main").unwrap();
        let sink = Arc::new(BoundedEventSink::new(256, 1024 * 1024));
        let service = TerminalService::new(sink.clone());
        let script_path = path.join("terminal-node-tree.cjs");
        fs::write(
            &script_path,
            include_str!("../fixtures/terminal-node-tree.cjs"),
        )
        .unwrap();
        let shell = TrustedShellConfig::new(node_exe, vec![script_path.into_os_string()]);
        let spec = TerminalSpawnSpec::new(
            owner.clone(),
            WorkspaceId::parse("ws-node-leader-exit").unwrap(),
            path.clone(),
            shell,
            TerminalSize::new(80, 24).unwrap(),
        );
        let (cancel, token) = cancellation_pair();
        let info = service
            .spawn(&spec, cancel, token)
            .expect("spawn node leader");
        let job = service
            .session_job_process_group(&info.session_id)
            .expect("session job");

        let deadline = Instant::now() + Duration::from_secs(6);
        let mut transcript = String::new();
        while Instant::now() < deadline
            && (!transcript.contains("GRANDCHILD_NODE_UTF8_終端𠀀_READY_")
                || !transcript.contains("LEADER_NODE_PID_"))
        {
            for ev in sink.drain_for_owner(&owner) {
                if let TerminalEventPayload::Data { text, .. } = ev.payload {
                    transcript.push_str(&text);
                }
            }
            thread::sleep(Duration::from_millis(25));
        }

        assert!(
            transcript.contains("GRANDCHILD_NODE_UTF8_終端𠀀_READY_"),
            "PTY must capture descendant unique UTF-8 marker; transcript={transcript:?}; active={:?}; io={:?}; node_trace={:?}",
            job.active_processes(), service.session_io_progress(&info.session_id),
            fs::read_to_string(path.join("startup-trace.jsonl"))
        );
        assert!(
            transcript.contains("LEADER_NODE_PID_"),
            "PTY must capture leader process marker; transcript={transcript:?}; io={:?}; node_trace={:?}",
            service.session_io_progress(&info.session_id), fs::read_to_string(path.join("startup-trace.jsonl"))
        );

        let child_marker = "CHILD_";
        let child_idx = transcript
            .find(child_marker)
            .expect("child marker in transcript");
        let child_pid_str: String = transcript[child_idx + child_marker.len()..]
            .chars()
            .take_while(|c| c.is_ascii_digit())
            .collect();
        let child_pid: u32 = child_pid_str.parse().expect("valid grandchild pid");
        assert!(child_pid > 0);
        assert_ne!(child_pid, info.pid);

        let leader_handle = unsafe { OpenProcess(0x00100000, 0, info.pid) };
        assert!(
            !leader_handle.is_null(),
            "leader process handle must be openable"
        );
        let child_handle = unsafe { OpenProcess(0x00100000, 0, child_pid) };
        assert!(
            !child_handle.is_null(),
            "grandchild process handle must be openable"
        );

        // Release only after the PTY has delivered both markers and the test owns
        // both process handles. CI load must not race a fixed leader lifetime.
        fs::write(path.join("release-leader"), b"exit").unwrap();
        let drain_deadline = Instant::now() + Duration::from_secs(6);
        while Instant::now() < drain_deadline && job.active_processes().unwrap_or(1) > 0 {
            for _ in sink.drain_for_owner(&owner) {}
            thread::sleep(Duration::from_millis(25));
        }

        let leader_waited = unsafe { WaitForSingleObject(leader_handle, 5000) };
        let child_waited = unsafe { WaitForSingleObject(child_handle, 5000) };
        let active_remaining = job.active_processes().unwrap_or(u32::MAX);

        unsafe {
            CloseHandle(child_handle);
            CloseHandle(leader_handle);
        }
        let _ = fs::remove_dir_all(path);

        assert_eq!(leader_waited, 0, "leader must exit");
        assert_eq!(
            child_waited, 0,
            "grandchild must be terminated when leader exit leaves job 0"
        );
        assert_eq!(active_remaining, 0, "job active processes must reach 0");
    }

    #[test]
    fn reviewer_descendant_node_tree_explicit_kill_and_service_drop_reap_grandchild() {
        use windows_sys::Win32::{
            Foundation::CloseHandle,
            System::Threading::{OpenProcess, WaitForSingleObject},
        };
        let node_exe = resolve_test_node_exe();
        let path = std::env::temp_dir().join(format!(
            "modutex-terminal-node-kill-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir(&path).unwrap();
        let owner = OwnerId::from_label("main").unwrap();
        let sink = Arc::new(BoundedEventSink::new(256, 1024 * 1024));
        let service = TerminalService::new(sink.clone());
        let script = r#"const cp=require('child_process');const c=cp.spawn(process.execPath,['-e','console.log("GRANDCHILD_NODE_UTF8_終端𠀀_KILL_"+process.pid);setInterval(()=>{},30000);'],{stdio:'inherit'});console.log("LEADER_NODE_PID_"+process.pid+"_CHILD_"+c.pid);setInterval(()=>{},30000);"#;
        let shell = TrustedShellConfig::new(
            node_exe.clone(),
            vec![OsString::from("-e"), OsString::from(script)],
        );
        let spec = TerminalSpawnSpec::new(
            owner.clone(),
            WorkspaceId::parse("ws-node-kill").unwrap(),
            path.clone(),
            shell,
            TerminalSize::new(80, 24).unwrap(),
        );
        let (cancel, token) = cancellation_pair();
        let info = service
            .spawn(&spec, cancel, token)
            .expect("spawn node leader");
        let job = service
            .session_job_process_group(&info.session_id)
            .expect("session job");

        let deadline = Instant::now() + Duration::from_secs(6);
        let mut transcript = String::new();
        while Instant::now() < deadline
            && (!transcript.contains("GRANDCHILD_NODE_UTF8_終端𠀀_KILL_")
                || !transcript.contains("LEADER_NODE_PID_"))
        {
            for ev in sink.drain_for_owner(&owner) {
                if let TerminalEventPayload::Data { text, .. } = ev.payload {
                    transcript.push_str(&text);
                }
            }
            thread::sleep(Duration::from_millis(25));
        }

        let child_marker = "CHILD_";
        let child_idx = transcript
            .find(child_marker)
            .expect("child marker in transcript");
        let child_pid_str: String = transcript[child_idx + child_marker.len()..]
            .chars()
            .take_while(|c| c.is_ascii_digit())
            .collect();
        let child_pid: u32 = child_pid_str.parse().expect("valid grandchild pid");

        let leader_handle = unsafe { OpenProcess(0x00100000, 0, info.pid) };
        assert!(!leader_handle.is_null());
        let child_handle = unsafe { OpenProcess(0x00100000, 0, child_pid) };
        assert!(!child_handle.is_null());

        assert!(
            job.active_processes().unwrap_or(0) >= 2,
            "job must contain both leader and grandchild"
        );

        let report = service
            .kill(&owner, &info.session_id)
            .expect("explicit kill");
        assert_eq!(report.cleanup, TerminalCleanupProof::SessionDrained);
        assert!(report.child_reaped);

        let leader_waited = unsafe { WaitForSingleObject(leader_handle, 5000) };
        let child_waited = unsafe { WaitForSingleObject(child_handle, 5000) };
        let active_remaining = job.active_processes().unwrap_or(u32::MAX);

        unsafe {
            CloseHandle(child_handle);
            CloseHandle(leader_handle);
        }

        assert_eq!(leader_waited, 0, "explicit kill must terminate leader");
        assert_eq!(child_waited, 0, "explicit kill must reap grandchild");
        assert_eq!(
            active_remaining, 0,
            "job must be drained to 0 after explicit kill"
        );

        let path2 = std::env::temp_dir().join(format!(
            "modutex-terminal-node-drop-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir(&path2).unwrap();
        let sink2 = Arc::new(BoundedEventSink::new(256, 1024 * 1024));
        let service2 = TerminalService::new(sink2.clone());
        let shell2 =
            TrustedShellConfig::new(node_exe, vec![OsString::from("-e"), OsString::from(script)]);
        let spec2 = TerminalSpawnSpec::new(
            owner.clone(),
            WorkspaceId::parse("ws-node-drop").unwrap(),
            path2.clone(),
            shell2,
            TerminalSize::new(80, 24).unwrap(),
        );
        let (cancel2, token2) = cancellation_pair();
        let info2 = service2
            .spawn(&spec2, cancel2, token2)
            .expect("spawn node leader 2");
        let job2 = service2
            .session_job_process_group(&info2.session_id)
            .expect("session job 2");

        let deadline2 = Instant::now() + Duration::from_secs(6);
        let mut transcript2 = String::new();
        while Instant::now() < deadline2
            && (!transcript2.contains("GRANDCHILD_NODE_UTF8_終端𠀀_KILL_")
                || !transcript2.contains("LEADER_NODE_PID_"))
        {
            for ev in sink2.drain_for_owner(&owner) {
                if let TerminalEventPayload::Data { text, .. } = ev.payload {
                    transcript2.push_str(&text);
                }
            }
            thread::sleep(Duration::from_millis(25));
        }

        let child_idx2 = transcript2
            .find(child_marker)
            .expect("child marker in transcript 2");
        let child_pid_str2: String = transcript2[child_idx2 + child_marker.len()..]
            .chars()
            .take_while(|c| c.is_ascii_digit())
            .collect();
        let child_pid2: u32 = child_pid_str2.parse().expect("valid grandchild pid 2");

        let leader_handle2 = unsafe { OpenProcess(0x00100000, 0, info2.pid) };
        assert!(!leader_handle2.is_null());
        let child_handle2 = unsafe { OpenProcess(0x00100000, 0, child_pid2) };
        assert!(!child_handle2.is_null());

        assert!(job2.active_processes().unwrap_or(0) >= 2);

        drop(service2);

        let leader_waited2 = unsafe { WaitForSingleObject(leader_handle2, 5000) };
        let child_waited2 = unsafe { WaitForSingleObject(child_handle2, 5000) };

        let wait_drain = Instant::now() + Duration::from_secs(5);
        while job2.active_processes().unwrap_or(1) > 0 && Instant::now() < wait_drain {
            thread::sleep(Duration::from_millis(25));
        }
        let active_remaining2 = job2.active_processes().unwrap_or(u32::MAX);

        unsafe {
            CloseHandle(child_handle2);
            CloseHandle(leader_handle2);
        }
        let _ = fs::remove_dir_all(path);
        let _ = fs::remove_dir_all(path2);

        assert_eq!(leader_waited2, 0, "service drop must terminate leader");
        assert_eq!(child_waited2, 0, "service drop must reap grandchild");
        assert_eq!(
            active_remaining2, 0,
            "job must be drained to 0 after service drop"
        );
    }

    #[test]
    fn reviewer_injected_failed_spawn_retains_job_until_real_drain() {
        let path =
            std::env::temp_dir().join(format!("modutex-terminal-drain-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&path).unwrap();
        let owner = OwnerId::from_label("main").unwrap();
        let service = TerminalService::new(Arc::new(BoundedEventSink::new(128, 65536)));
        let spec = TerminalSpawnSpec::new(
            owner,
            WorkspaceId::parse("ws-drain-fault").unwrap(),
            path.clone(),
            TrustedShellConfig::default_windows_shell(),
            TerminalSize::new(80, 24).unwrap(),
        );
        let (cancel, token) = cancellation_pair();
        let probe = super::windows_pty::inject_after_spawn_failure();
        let result = service.spawn(&spec, cancel, token);
        assert!(result.is_err());
        let job = probe
            .job_process_group()
            .expect("recorded job group from injected fault");
        let active_while_held = job.active_processes().unwrap_or(0);
        assert!(
            active_while_held >= 1,
            "job must retain processes while fault holds cleanup"
        );
        assert!(
            !probe.completed(),
            "cleanup must not complete while fault is held"
        );
        probe.release();
        let deadline = Instant::now() + Duration::from_secs(5);
        while !probe.completed() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
        assert!(
            probe.completed(),
            "reaper must finish cleanup after probe release"
        );
        let active_after = job.active_processes().unwrap();
        assert_eq!(
            active_after, 0,
            "job must have 0 active processes after real drain"
        );
        drop(service);
        let _ = fs::remove_dir_all(path);
    }
}
