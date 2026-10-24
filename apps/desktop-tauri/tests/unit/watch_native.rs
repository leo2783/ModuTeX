// SPDX-License-Identifier: Apache-2.0
use super::*;
use std::fs;
use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};

/// Encodes a test `FILE_NOTIFY_INFORMATION` record into `buf`.
fn append_raw_record(
    buf: &mut Vec<u8>,
    next_entry_offset: u32,
    action: u32,
    utf16_units: &[u16],
    override_byte_len: Option<u32>,
) {
    while !buf.len().is_multiple_of(4) {
        buf.push(0);
    }
    let byte_len = override_byte_len.unwrap_or((utf16_units.len() * 2) as u32);
    buf.extend_from_slice(&next_entry_offset.to_ne_bytes());
    buf.extend_from_slice(&action.to_ne_bytes());
    buf.extend_from_slice(&byte_len.to_ne_bytes());
    for &unit in utf16_units {
        buf.extend_from_slice(&unit.to_ne_bytes());
    }
}

fn encode_valid_records(items: &[(u32, &str)]) -> Vec<u8> {
    let mut buf = Vec::new();
    for (idx, (action, path)) in items.iter().enumerate() {
        let units: Vec<u16> = path.encode_utf16().collect();
        let raw_len = 12 + units.len() * 2;
        let padded_len = (raw_len + 3) & !3;
        let next = if idx + 1 == items.len() {
            0
        } else {
            padded_len as u32
        };
        append_raw_record(&mut buf, next, *action, &units, None);
        while !buf.len().is_multiple_of(4) {
            buf.push(0);
        }
    }
    buf
}

struct TempWatchDir {
    path: PathBuf,
}

impl TempWatchDir {
    fn new(prefix: &str) -> Self {
        let unique = format!(
            "modutex-watch-test-{}-{}-{}",
            prefix,
            std::process::id(),
            uuid::Uuid::new_v4()
        );
        let path = std::env::temp_dir().join(unique);
        fs::create_dir_all(&path).expect("create temp test dir");
        Self { path }
    }

    fn path(&self) -> &Path {
        &self.path
    }

    fn open_verified_handle(&self) -> VerifiedDirectoryHandle {
        let wide: Vec<u16> = self
            .path
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        // SAFETY: Opens our newly-created test directory's final component
        // with OPEN_REPARSE_POINT and the access/overlapped flags required by
        // ReadDirectoryChangesW. The test-only path is not renderer input.
        let raw = unsafe {
            win32::CreateFileW(
                wide.as_ptr(),
                win32::FILE_LIST_DIRECTORY | win32::FILE_READ_ATTRIBUTES | win32::SYNCHRONIZE,
                win32::FILE_SHARE_READ | win32::FILE_SHARE_WRITE | win32::FILE_SHARE_DELETE,
                core::ptr::null(),
                win32::OPEN_EXISTING,
                win32::FILE_FLAG_BACKUP_SEMANTICS
                    | win32::FILE_FLAG_OVERLAPPED
                    | win32::FILE_FLAG_OPEN_REPARSE_POINT,
                core::ptr::null_mut(),
            )
        };
        assert!(
            !raw.is_null() && raw != win32::INVALID_HANDLE_VALUE,
            "CreateFileW failed for temp dir"
        );
        // SAFETY: `raw` is the newly-created handle returned by CreateFileW.
        let owned = unsafe { OwnedHandle::from_raw_handle(raw) };
        // SAFETY: This test opened the temporary directory's final component
        // with OPEN_REPARSE_POINT; production callers use the trusted
        // filesystem coordinator's component-by-component no-follow opener.
        let root = unsafe { TrustedDirectoryRoot::from_coordinator_open(owned) }
            .expect("trusted test directory root");
        VerifiedDirectoryHandle::from_trusted_root(root).expect("verified directory handle")
    }
}

impl Drop for TempWatchDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

#[test]
fn parser_rejects_malformed_offsets_odd_utf16_unknown_action_and_traversal() {
    assert_eq!(
        parse_notify_buffer(&[]),
        Err(NotifyParseError::EmptyOrOverflowBuffer)
    );

    assert_eq!(
        parse_notify_buffer(&[0u8; 8]),
        Err(NotifyParseError::TruncatedHeader { offset: 0 })
    );

    let mut bad_next = Vec::new();
    let units: Vec<u16> = "main.tex".encode_utf16().collect();
    append_raw_record(&mut bad_next, 64, FILE_ACTION_MODIFIED, &units, None);
    assert!(matches!(
        parse_notify_buffer(&bad_next),
        Err(NotifyParseError::MalformedNextOffset {
            offset: 0,
            next_entry_offset: 64
        })
    ));

    let mut overlap_next = Vec::new();
    append_raw_record(&mut overlap_next, 8, FILE_ACTION_MODIFIED, &units, None);
    overlap_next.resize(64, 0);
    assert!(matches!(
        parse_notify_buffer(&overlap_next),
        Err(NotifyParseError::MalformedNextOffset {
            offset: 0,
            next_entry_offset: 8
        })
    ));

    let mut misaligned = Vec::new();
    append_raw_record(&mut misaligned, 30, FILE_ACTION_MODIFIED, &units, None);
    misaligned.resize(64, 0);
    assert!(matches!(
        parse_notify_buffer(&misaligned),
        Err(NotifyParseError::MalformedNextOffset {
            offset: 0,
            next_entry_offset: 30
        })
    ));

    let mut odd_utf16 = Vec::new();
    append_raw_record(&mut odd_utf16, 0, FILE_ACTION_ADDED, &units, Some(5));
    assert_eq!(
        parse_notify_buffer(&odd_utf16),
        Err(NotifyParseError::OddUtf16ByteLength {
            offset: 0,
            byte_len: 5
        })
    );

    let mut oob_name = Vec::new();
    append_raw_record(&mut oob_name, 0, FILE_ACTION_ADDED, &units, Some(200));
    assert_eq!(
        parse_notify_buffer(&oob_name),
        Err(NotifyParseError::FileNameOutOfBounds {
            offset: 0,
            byte_len: 200
        })
    );

    let mut bad_surrogate = Vec::new();
    append_raw_record(
        &mut bad_surrogate,
        0,
        FILE_ACTION_ADDED,
        &[0xD800, 0x0061],
        None,
    );
    assert_eq!(
        parse_notify_buffer(&bad_surrogate),
        Err(NotifyParseError::InvalidUtf16 { offset: 0 })
    );

    let mut unknown_action = Vec::new();
    append_raw_record(&mut unknown_action, 0, 99, &units, None);
    assert_eq!(
        parse_notify_buffer(&unknown_action),
        Err(NotifyParseError::UnknownAction(99))
    );

    for bad_path in [r"..\escape.tex", r"sub\..\escape.tex", r".\main.tex"] {
        let buf = encode_valid_records(&[(FILE_ACTION_MODIFIED, bad_path)]);
        assert!(
            matches!(
                parse_notify_buffer(&buf),
                Err(NotifyParseError::PathTraversal { .. })
            ),
            "expected traversal rejection for {bad_path}"
        );
    }

    let ads_buf = encode_valid_records(&[(FILE_ACTION_ADDED, "main.tex:Zone.Identifier")]);
    assert!(matches!(
        parse_notify_buffer(&ads_buf),
        Err(NotifyParseError::AlternateDataStreamOrColon { .. })
    ));

    let rooted_buf = encode_valid_records(&[(FILE_ACTION_ADDED, r"\rooted.tex")]);
    assert!(matches!(
        parse_notify_buffer(&rooted_buf),
        Err(NotifyParseError::RootedOrSlashPath { .. })
    ));
}

#[test]
fn rename_pairing_and_burst_coalescing_preserve_causal_order() {
    let raw = encode_valid_records(&[
        (FILE_ACTION_ADDED, r"chapters\draft.tex"),
        (FILE_ACTION_MODIFIED, r"chapters\draft.tex"),
        (FILE_ACTION_RENAMED_OLD_NAME, r"chapters\draft.tex"),
        (FILE_ACTION_RENAMED_NEW_NAME, r"chapters\final.tex"),
        (FILE_ACTION_MODIFIED, r"chapters\final.tex"),
        (FILE_ACTION_RENAMED_OLD_NAME, r"orphan_old.tex"),
        (FILE_ACTION_RENAMED_NEW_NAME, r"paired_from_orphan.tex"),
        (FILE_ACTION_RENAMED_OLD_NAME, r"moved_out.tex"),
    ]);

    let parsed = parse_notify_buffer(&raw).expect("valid buffer");
    let coalesced = pair_and_coalesce_records(&parsed);

    assert_eq!(
        coalesced,
        vec![
            WatchBatchItem {
                path: RelativePath::parse("chapters/draft.tex").unwrap(),
                kind: FileEventKind::Removed,
                renamed_from: None,
            },
            WatchBatchItem {
                path: RelativePath::parse("chapters/final.tex").unwrap(),
                kind: FileEventKind::Changed,
                renamed_from: Some(RelativePath::parse("chapters/draft.tex").unwrap()),
            },
            WatchBatchItem {
                path: RelativePath::parse("orphan_old.tex").unwrap(),
                kind: FileEventKind::Removed,
                renamed_from: None,
            },
            WatchBatchItem {
                path: RelativePath::parse("paired_from_orphan.tex").unwrap(),
                kind: FileEventKind::Changed,
                renamed_from: Some(RelativePath::parse("orphan_old.tex").unwrap()),
            },
            WatchBatchItem {
                path: RelativePath::parse("moved_out.tex").unwrap(),
                kind: FileEventKind::Removed,
                renamed_from: None,
            },
        ]
    );
}

#[test]
fn non_directory_handle_is_rejected_by_trusted_directory_root() {
    let temp = TempWatchDir::new("non-dir");
    let file_path = temp.path().join("single.tex");
    fs::write(&file_path, b"\\documentclass{article}").expect("write file");
    let file = fs::File::open(&file_path).expect("open file");
    let owned: OwnedHandle = file.into();
    // SAFETY: This handle is deliberately a regular file; the constructor
    // rejects it before it can be used as a directory watch capability.
    let result = unsafe { TrustedDirectoryRoot::from_coordinator_open(owned) };
    assert_eq!(result.unwrap_err(), WatchNativeError::NotADirectory);
}

#[test]
fn native_tempdir_create_write_rename_delete_observes_actual_notifications() {
    let temp = TempWatchDir::new("crud");
    let sub_dir = temp.path().join("sections");
    fs::create_dir_all(&sub_dir).expect("create sections subdir");

    let verified = temp.open_verified_handle();
    let owner = OwnerId::from_label("main").expect("owner");
    let ws = WorkspaceId::parse("ws-native-1").expect("ws");
    let gen = WatchGeneration::new(1).unwrap();

    let subscription = NativeWatchSubscription::start(
        WatchSubscriptionKey {
            owner: owner.clone(),
            workspace_id: ws.clone(),
            generation: gen,
        },
        verified,
        Arc::new(DefaultWatchValidator::default()),
        WatchConfig::default(),
    )
    .expect("start native watch subscription");

    assert!(
        subscription.wait_until_read_armed(Duration::from_secs(2)),
        "worker did not arm ReadDirectoryChangesW"
    );

    let p1 = sub_dir.join("intro.tex");
    let p2 = sub_dir.join("opening.tex");
    fs::write(&p1, b"hello").expect("create intro.tex");
    fs::write(&p1, b"hello world").expect("modify intro.tex");
    fs::rename(&p1, &p2).expect("rename intro.tex -> opening.tex");

    let mut observed_events: Vec<FileEvent> = Vec::new();
    let mut saw_rename_lineage = false;
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        let signals = subscription
            .wait_and_drain(&owner, &ws, gen, Duration::from_millis(200))
            .expect("drain");
        for signal in signals {
            if let WatchSignal::Event {
                event,
                renamed_from,
                ..
            } = signal
            {
                if event.path.as_str() == "sections/opening.tex"
                    && renamed_from.as_ref().map(|path| path.as_str()) == Some("sections/intro.tex")
                {
                    saw_rename_lineage = true;
                }
                observed_events.push(event);
            }
        }
        let has_intro = observed_events
            .iter()
            .any(|event| event.path.as_str() == "sections/intro.tex");
        let has_opening = observed_events.iter().any(|event| {
            event.path.as_str() == "sections/opening.tex" && event.kind == FileEventKind::Changed
        });
        if has_intro && has_opening {
            break;
        }
    }

    assert!(
        observed_events
            .iter()
            .any(|event| event.path.as_str() == "sections/intro.tex"),
        "expected notification for sections/intro.tex, got {observed_events:?}"
    );
    assert!(
        observed_events.iter().any(|event| {
            event.path.as_str() == "sections/opening.tex" && event.kind == FileEventKind::Changed
        }),
        "expected Changed notification for sections/opening.tex, got {observed_events:?}"
    );
    assert!(
        saw_rename_lineage,
        "expected rename pairing from sections/intro.tex to sections/opening.tex"
    );

    fs::remove_file(&p2).expect("remove opening.tex");
    let mut saw_removed = false;
    let delete_deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < delete_deadline && !saw_removed {
        let signals = subscription
            .wait_and_drain(&owner, &ws, gen, Duration::from_millis(200))
            .expect("drain delete");
        for signal in signals {
            if let WatchSignal::Event { event, .. } = signal {
                if event.path.as_str() == "sections/opening.tex"
                    && event.kind == FileEventKind::Removed
                {
                    saw_removed = true;
                }
            }
        }
    }
    assert!(
        saw_removed,
        "expected Removed event for sections/opening.tex"
    );

    subscription.stop();
}

#[test]
fn stop_while_read_pending_terminates_promptly_and_blocks_later_emissions() {
    let temp = TempWatchDir::new("cancel-pending");
    let verified = temp.open_verified_handle();
    let owner = OwnerId::from_label("main").expect("owner");
    let ws = WorkspaceId::parse("ws-cancel").expect("ws");
    let gen = WatchGeneration::new(1).unwrap();

    let subscription = NativeWatchSubscription::start(
        WatchSubscriptionKey {
            owner: owner.clone(),
            workspace_id: ws.clone(),
            generation: gen,
        },
        verified,
        Arc::new(DefaultWatchValidator::default()),
        WatchConfig::default(),
    )
    .expect("start subscription");

    assert!(
        subscription.wait_until_read_armed(Duration::from_secs(2)),
        "worker did not arm ReadDirectoryChangesW"
    );

    let start_stop = Instant::now();
    subscription.stop();
    let elapsed = start_stop.elapsed();
    assert!(
        elapsed < Duration::from_secs(2),
        "CancelIoEx + thread join took too long: {elapsed:?}"
    );

    subscription.stop();
    assert!(subscription.is_stopped());

    fs::write(temp.path().join("after_stop.tex"), b"x").expect("write after stop");
    assert_eq!(
        subscription.drain_signals(&owner, &ws, gen),
        Err(WatchAccessError::SubscriptionStopped)
    );
}

#[test]
fn overflow_path_requests_explicit_resync_without_silent_loss() {
    let temp = TempWatchDir::new("overflow");
    let verified = temp.open_verified_handle();
    let owner = OwnerId::from_label("main").expect("owner");
    let ws = WorkspaceId::parse("ws-overflow").expect("ws");
    let gen = WatchGeneration::new(1).unwrap();
    let config = WatchConfig {
        max_queued_events: 2,
        ..WatchConfig::default()
    };

    let subscription = NativeWatchSubscription::start(
        WatchSubscriptionKey {
            owner: owner.clone(),
            workspace_id: ws.clone(),
            generation: gen,
        },
        verified,
        Arc::new(DefaultWatchValidator::default()),
        config,
    )
    .expect("start subscription");

    assert!(
        subscription.wait_until_read_armed(Duration::from_secs(2)),
        "worker did not arm ReadDirectoryChangesW"
    );

    for i in 0..12 {
        let file_path = temp.path().join(format!("burst_{i}.tex"));
        fs::write(&file_path, b"burst").expect("write burst file");
    }

    let mut saw_resync = false;
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline && !saw_resync {
        let signals = subscription
            .wait_and_drain(&owner, &ws, gen, Duration::from_millis(200))
            .expect("drain overflow");
        for signal in signals {
            if matches!(
                signal,
                WatchSignal::ResyncRequired {
                    reason: ResyncReason::EventQueueOverflow | ResyncReason::KernelBufferOverflow,
                    ..
                }
            ) {
                saw_resync = true;
            }
        }
    }

    assert!(
        saw_resync,
        "expected explicit WatchSignal::ResyncRequired on overflow"
    );
    subscription.stop();
}

#[test]
fn pending_reservation_cancellation_returns_before_start_cleanup_finishes() {
    let generation = WatchGeneration::new(7).unwrap();
    let reservation = Arc::new(StartReservation::new(generation));
    let waiting_reservation = Arc::clone(&reservation);
    let (done_tx, done_rx) = std::sync::mpsc::channel();
    let waiter = thread::spawn(move || {
        waiting_reservation.cancel();
        done_tx.send(()).unwrap();
    });
    let returned_before_finish = done_rx.recv_timeout(Duration::from_secs(2)).is_ok();
    let observed_cancel = reservation.is_cancelled();
    let finished_before_proof = reservation.lock_state().finished;
    reservation.finish();
    waiter.join().expect("reservation cancellation worker");
    assert!(
        returned_before_finish,
        "cancel must not block the UI waiting for start cleanup"
    );
    assert!(
        observed_cancel,
        "admission must be revoked before cancel returns"
    );
    assert!(
        !finished_before_proof,
        "cancellation is not cleanup completion proof"
    );
    assert!(reservation.lock_state().finished);
}

#[test]
fn stale_generation_and_revoked_owner_are_rejected() {
    let temp1 = TempWatchDir::new("gen1");
    let temp2 = TempWatchDir::new("gen2");
    let registry = NativeWatchRegistry::new();
    let owner = OwnerId::from_label("main").expect("owner");
    let other_owner = OwnerId::from_label("secondary").expect("other owner");
    let ws = WorkspaceId::parse("ws-gen").expect("ws");

    let (gen1, sub1) = registry
        .subscribe(
            owner.clone(),
            ws.clone(),
            temp1.open_verified_handle(),
            Arc::new(DefaultWatchValidator::default()),
            WatchConfig::default(),
        )
        .expect("subscribe gen1");

    let (gen2, sub2) = registry
        .subscribe(
            owner.clone(),
            ws.clone(),
            temp2.open_verified_handle(),
            Arc::new(DefaultWatchValidator::default()),
            WatchConfig::default(),
        )
        .expect("subscribe gen2");

    assert_ne!(gen1, gen2);
    assert!(sub1.is_stopped(), "superseded generation must be stopped");
    assert!(!sub2.is_stopped());

    assert_eq!(
        registry.drain(&owner, &ws, gen1),
        Err(WatchAccessError::StaleGeneration {
            expected: gen2,
            actual: gen1,
        })
    );

    assert_eq!(
        sub2.drain_signals(&other_owner, &ws, gen2),
        Err(WatchAccessError::OwnerMismatch)
    );

    assert_eq!(registry.revoke_owner(&owner), 1);
    assert!(sub2.is_stopped());
    assert_eq!(
        registry.drain(&owner, &ws, gen2),
        Err(WatchAccessError::SubscriptionStopped)
    );
    assert!(matches!(
        registry.subscribe(
            owner,
            ws,
            temp1.open_verified_handle(),
            Arc::new(DefaultWatchValidator::default()),
            WatchConfig::default(),
        ),
        Err(WatchNativeError::OwnerRevoked)
    ));
}
