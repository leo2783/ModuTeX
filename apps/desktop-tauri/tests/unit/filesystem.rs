// SPDX-License-Identifier: Apache-2.0
use super::*;
use crate::schemas::protocol::{Engine, ImageBatch, ManagedImage};
use crate::state::recent::HistoryPersistenceStatus;
use std::fs;
use std::sync::mpsc;
use uuid::Uuid;

struct TempWorkspace {
    base: PathBuf,
}

impl TempWorkspace {
    fn new(tag: &str) -> Self {
        let base = std::env::temp_dir().join(format!(
            "modutex-g2-fs-{tag}-{}-{}",
            std::process::id(),
            Uuid::new_v4()
        ));
        fs::create_dir_all(&base).expect("create temp base");
        Self { base }
    }

    fn service(&self, drain_timeout: Duration) -> FilesystemService {
        let host_dir = self.base.join("host-data");
        FilesystemService::with_drain_timeout(
            Arc::new(SessionRegistry::new()),
            WorkspaceLeaseCoordinator::new(),
            RecentStore::new(&host_dir),
            SettingsStore::new(&host_dir),
            drain_timeout,
        )
    }
}

impl Drop for TempWorkspace {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.base);
    }
}

fn owner(label: &str) -> OwnerId {
    OwnerId::from_label(label).expect("owner")
}

fn ts(v: u64) -> Timestamp {
    Timestamp::new(v).expect("timestamp")
}

fn doc_id(s: &str) -> DocumentId {
    DocumentId::parse(s).expect("doc id")
}

fn doc_ver(v: u64) -> DocumentVersion {
    DocumentVersion::new(v).expect("doc ver")
}

fn rel(s: &str) -> RelativePath {
    RelativePath::parse(s).expect("rel path")
}

fn png_bytes() -> Vec<u8> {
    let mut b = vec![0u8; 16];
    b[..8].copy_from_slice(&[137, 80, 78, 71, 13, 10, 26, 10]);
    b
}

#[test]
fn open_list_read_write_and_revision_or_document_version_conflicts() {
    let tmp = TempWorkspace::new("crud");
    let svc = tmp.service(DEFAULT_CLOSE_DRAIN_TIMEOUT);
    let main = owner("main");
    let ws_dir = tmp.base.join("thesis");
    fs::create_dir_all(&ws_dir).unwrap();

    let opened = svc
        .open_workspace_folder(&main, &ws_dir, None, ts(100))
        .unwrap();
    assert!(opened.history.is_persisted());
    let ws_id = opened.opened.id;

    let w1 = svc
        .write_file(
            &main,
            &WriteRequest {
                workspace_id: ws_id.clone(),
                path: rel("chapters/intro.tex"),
                bytes: b"\\section{Intro}".to_vec(),
                expected_revision: None,
                document_id: doc_id("doc_intro"),
                document_version: doc_ver(2),
            },
        )
        .unwrap();

    let entries = svc.list_files(&main, &ws_id).unwrap();
    assert_eq!(entries.len(), 2);

    // Null revision on existing file must fail without altering tracked version or bytes.
    let conflict = svc.write_file(
        &main,
        &WriteRequest {
            workspace_id: ws_id.clone(),
            path: rel("chapters/intro.tex"),
            bytes: b"overwrite".to_vec(),
            expected_revision: None,
            document_id: doc_id("doc_intro"),
            document_version: doc_ver(3),
        },
    );
    assert!(matches!(
        conflict,
        Err(FilesystemError::RevisionConflict { .. })
    ));

    // Regression in documentVersion must fail.
    let stale_ver = svc.write_file(
        &main,
        &WriteRequest {
            workspace_id: ws_id.clone(),
            path: rel("chapters/intro.tex"),
            bytes: b"stale-ver".to_vec(),
            expected_revision: Some(w1.revision.clone()),
            document_id: doc_id("doc_intro"),
            document_version: doc_ver(1),
        },
    );
    assert!(matches!(
        stale_ver,
        Err(FilesystemError::StaleDocumentVersion { .. })
    ));

    // Mismatched documentId on same path must fail.
    let wrong_doc = svc.write_file(
        &main,
        &WriteRequest {
            workspace_id: ws_id.clone(),
            path: rel("chapters/intro.tex"),
            bytes: b"wrong-doc".to_vec(),
            expected_revision: Some(w1.revision.clone()),
            document_id: doc_id("doc_other"),
            document_version: doc_ver(3),
        },
    );
    assert!(matches!(
        wrong_doc,
        Err(FilesystemError::DocumentIdentityMismatch { .. })
    ));

    let read_back = svc
        .read_file(
            &main,
            &FileRef {
                workspace_id: ws_id.clone(),
                path: rel("chapters/intro.tex"),
            },
        )
        .unwrap();
    assert_eq!(read_back.bytes, b"\\section{Intro}");
    assert_eq!(read_back.revision, w1.revision);
    assert_eq!(read_back.document_id, Some(doc_id("doc_intro")));
    assert_eq!(read_back.document_version, Some(doc_ver(2)));
}

#[test]
fn external_file_revisions_advance_tracked_read_identity_for_source_and_pdf() {
    let tmp = TempWorkspace::new("external-read-identity");
    let svc = tmp.service(DEFAULT_CLOSE_DRAIN_TIMEOUT);
    let main = owner("main");
    let folder = tmp.base.join("project");
    fs::create_dir_all(&folder).unwrap();
    let ws_id = svc
        .open_workspace_folder(&main, &folder, None, ts(100))
        .unwrap()
        .opened
        .id;

    fs::write(folder.join("untracked.tex"), b"untracked source").unwrap();
    let untracked = svc
        .read_file(
            &main,
            &FileRef {
                workspace_id: ws_id.clone(),
                path: rel("untracked.tex"),
            },
        )
        .unwrap();
    assert_eq!(untracked.document_id, None);
    assert_eq!(untracked.document_version, None);

    let source = svc
        .write_file(
            &main,
            &WriteRequest {
                workspace_id: ws_id.clone(),
                path: rel("main.tex"),
                bytes: b"old source".to_vec(),
                expected_revision: None,
                document_id: doc_id("doc_main"),
                document_version: doc_ver(4),
            },
        )
        .unwrap();
    fs::write(folder.join("main.tex"), b"externally changed source").unwrap();

    let changed = svc
        .read_file(
            &main,
            &FileRef {
                workspace_id: ws_id.clone(),
                path: rel("main.tex"),
            },
        )
        .unwrap();
    assert_eq!(changed.bytes, b"externally changed source");
    assert_ne!(changed.revision, source.revision);
    assert_eq!(changed.document_id, Some(doc_id("doc_main")));
    assert_eq!(changed.document_version, Some(doc_ver(5)));

    let unchanged = svc
        .read_file(
            &main,
            &FileRef {
                workspace_id: ws_id.clone(),
                path: rel("main.tex"),
            },
        )
        .unwrap();
    assert_eq!(unchanged.document_version, changed.document_version);

    let pdf = svc
        .write_file(
            &main,
            &WriteRequest {
                workspace_id: ws_id.clone(),
                path: rel("appendix.pdf"),
                bytes: b"%PDF-old".to_vec(),
                expected_revision: None,
                document_id: doc_id("doc_pdf"),
                document_version: doc_ver(8),
            },
        )
        .unwrap();
    fs::write(folder.join("appendix.pdf"), b"%PDF-external").unwrap();
    let changed_pdf = svc
        .read_file_pdf(
            &main,
            &FileRef {
                workspace_id: ws_id.clone(),
                path: rel("appendix.pdf"),
            },
        )
        .unwrap();
    assert_eq!(changed_pdf.bytes, b"%PDF-external");
    assert_ne!(changed_pdf.revision, pdf.revision);
    assert_eq!(changed_pdf.document_id, Some(doc_id("doc_pdf")));
    assert_eq!(changed_pdf.document_version, Some(doc_ver(9)));

    svc.write_file(
        &main,
        &WriteRequest {
            workspace_id: ws_id.clone(),
            path: rel("max-version.tex"),
            bytes: b"old".to_vec(),
            expected_revision: None,
            document_id: doc_id("doc_max_version"),
            document_version: DocumentVersion::new(crate::schemas::protocol::MAX_SAFE_INTEGER - 1)
                .unwrap(),
        },
    )
    .unwrap();
    fs::write(folder.join("max-version.tex"), b"external").unwrap();
    let max_ref = FileRef {
        workspace_id: ws_id,
        path: rel("max-version.tex"),
    };
    assert!(matches!(
        svc.read_file(&main, &max_ref),
        Ok(ReadReceipt {
            document_version: Some(version),
            ..
        }) if version.get() == crate::schemas::protocol::MAX_SAFE_INTEGER
    ));
    fs::write(folder.join("max-version.tex"), b"external again").unwrap();
    assert!(matches!(
        svc.read_file(&main, &max_ref),
        Err(FilesystemError::Protocol(_))
    ));
}

#[test]
fn overlapping_roots_exclude_save_and_compile_and_validate_compile_snapshot() {
    let tmp = TempWorkspace::new("overlap");
    let svc = tmp.service(DEFAULT_CLOSE_DRAIN_TIMEOUT);
    let (oa, ob) = (owner("main"), owner("secondary"));
    let parent_dir = tmp.base.join("project");
    let child_dir = parent_dir.join("chapters");
    fs::create_dir_all(&child_dir).unwrap();

    let ws_parent = svc
        .open_workspace_folder(&oa, &parent_dir, None, ts(10))
        .unwrap()
        .opened
        .id;
    let ws_child = svc
        .open_workspace_folder(&ob, &child_dir, None, ts(20))
        .unwrap()
        .opened
        .id;

    let saved = svc
        .write_file(
            &oa,
            &WriteRequest {
                workspace_id: ws_parent.clone(),
                path: rel("main.tex"),
                bytes: b"\\documentclass{article}".to_vec(),
                expected_revision: None,
                document_id: doc_id("doc_main"),
                document_version: doc_ver(1),
            },
        )
        .unwrap();

    let ticket = svc
        .prepare_compile(
            &oa,
            RunId::parse("run-1").unwrap(),
            &CompileRequest {
                workspace_id: ws_parent.clone(),
                entry_path: rel("main.tex"),
                document_id: doc_id("doc_main"),
                document_version: doc_ver(1),
                saved_revision: saved.revision.clone(),
                engine: Engine::Managed,
            },
            Box::new(|| Ok(())),
        )
        .unwrap();

    // Child workspace save must be blocked while parent compile lease is active.
    let child_save = svc.write_file(
        &ob,
        &WriteRequest {
            workspace_id: ws_child.clone(),
            path: rel("part.tex"),
            bytes: b"blocked".to_vec(),
            expected_revision: None,
            document_id: doc_id("doc_part"),
            document_version: doc_ver(1),
        },
    );
    assert_eq!(child_save, Err(FilesystemError::WorkspaceBusy));

    let settled = ticket
        .settle(CompileResult::Success {
            identity: CompileIdentity {
                run_id: RunId::parse("run-1").unwrap(),
                workspace_id: ws_parent,
                entry_path: rel("main.tex"),
                document_id: doc_id("doc_main"),
                document_version: doc_ver(1),
                saved_revision: saved.revision,
            },
            pdf: b"%PDF-1.7\n".to_vec(),
            log: "ok".to_owned(),
            diagnostics: Vec::new(),
        })
        .unwrap();
    assert!(matches!(settled, CompileResult::Success { .. }));

    // Child save now succeeds after compile lease settles.
    assert!(svc
        .write_file(
            &ob,
            &WriteRequest {
                workspace_id: ws_child,
                path: rel("part.tex"),
                bytes: b"allowed".to_vec(),
                expected_revision: None,
                document_id: doc_id("doc_part"),
                document_version: doc_ver(1),
            },
        )
        .is_ok());
}

#[test]
fn close_revokes_admission_first_invokes_cancellers_outside_lock_and_drops_late_events() {
    let tmp = TempWorkspace::new("close-drain");
    let svc = tmp.service(Duration::from_millis(80));
    let main = owner("main");
    let ws_dir = tmp.base.join("watched");
    fs::create_dir_all(&ws_dir).unwrap();

    let ws1 = svc
        .open_workspace_folder(&main, &ws_dir, None, ts(1))
        .unwrap()
        .opened
        .id;
    let events = Arc::new(Mutex::new(Vec::new()));
    let events_sink = Arc::clone(&events);
    let (cancel_tx, cancel_rx) = mpsc::channel();
    let svc_in_cb = svc.clone();
    let main_in_cb = main.clone();
    let ws1_in_cb = ws1.clone();

    let mut watch = svc
        .start_watch(
            &main,
            &ws1,
            Arc::new(move |ev| events_sink.lock().unwrap().push(ev)),
            Box::new(move || {
                // Re-entrant call proves lock is NOT held and admission is ALREADY revoked.
                let status = svc_in_cb.list_files(&main_in_cb, &ws1_in_cb).unwrap_err();
                cancel_tx.send(status).unwrap();
                Ok(())
            }),
        )
        .unwrap();

    assert_eq!(
        watch.emit_file_event(rel("main.tex"), FileEventKind::Changed),
        Ok(true)
    );
    // Internal stage artifacts are filtered.
    assert_eq!(
        watch.emit_file_event(rel(".modutex-stage-123-main.tex"), FileEventKind::Changed),
        Ok(false)
    );
    watch.finish_drain();

    assert_eq!(svc.close_workspace(&main, &ws1), Ok(()));
    assert_eq!(
        cancel_rx.recv_timeout(Duration::from_secs(1)).unwrap(),
        FilesystemError::SessionClosed
    );

    // Reopen same folder under a new generation; old watch handle must reject late events.
    let ws2 = svc
        .open_workspace_folder(&main, &ws_dir, None, ts(2))
        .unwrap()
        .opened
        .id;
    assert_ne!(ws1, ws2);
    assert_eq!(
        watch.emit_file_event(rel("late.tex"), FileEventKind::Changed),
        Err(FilesystemError::StaleGeneration)
    );
    assert_eq!(events.lock().unwrap().len(), 1);

    // Unproven cleanup (canceller returns error) must fail close without hanging.
    let _unproven_watch = svc
        .start_watch(
            &main,
            &ws2,
            Arc::new(|_| {}),
            Box::new(|| Err("watcher thread failed to stop".to_owned())),
        )
        .unwrap();
    let close_err = svc.close_workspace(&main, &ws2).unwrap_err();
    assert_eq!(close_err.code(), FilesystemErrorCode::CleanupUnproven);
    assert_eq!(
        svc.list_files(&main, &ws2),
        Err(FilesystemError::SessionClosed)
    );
}

#[test]
fn periodic_resync_uses_the_same_drained_and_stale_generation_fences_as_file_events() {
    use crate::schemas::protocol::FileWatchResyncReason;

    let tmp = TempWorkspace::new("resync-fence");
    let svc = tmp.service(Duration::from_millis(80));
    let main = owner("main");
    let folder = tmp.base.join("watched");
    fs::create_dir_all(&folder).unwrap();
    let first = svc
        .open_workspace_folder(&main, &folder, None, ts(1))
        .unwrap()
        .opened
        .id;
    let delivered = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&delivered);
    let mut watch = svc
        .start_watch(
            &main,
            &first,
            Arc::new(move |event| sink.lock().unwrap().push(event)),
            Box::new(|| Ok(())),
        )
        .unwrap();
    let drain = watch.drain_handle().unwrap();
    let reason = FileWatchResyncReason::PeriodicReconcileDue;

    drain.emit_resync(reason).unwrap();
    assert_eq!(
        *delivered.lock().unwrap(),
        vec![WatchNotification::ResyncRequired {
            workspace_id: first.clone(),
            reason,
        }]
    );
    drain.finish_drain().unwrap();
    watch.finish_drain();
    assert!(drain.emit_resync(reason).is_err());
    svc.close_workspace(&main, &first).unwrap();

    let second = svc
        .open_workspace_folder(&main, &folder, None, ts(2))
        .unwrap()
        .opened
        .id;
    assert_ne!(first, second);
    assert!(drain.emit_resync(reason).is_err());
    assert_eq!(delivered.lock().unwrap().len(), 1);
    svc.close_workspace(&main, &second).unwrap();
}

#[test]
fn reopen_recent_save_as_batch_rollback_and_reparse_rejection() {
    let tmp = TempWorkspace::new("recent-saveas");
    let svc = tmp.service(DEFAULT_CLOSE_DRAIN_TIMEOUT);
    let main = owner("main");
    let dir_a = tmp.base.join("dir_a");
    fs::create_dir_all(&dir_a).unwrap();
    let file_a = dir_a.join("paper.tex");
    fs::write(&file_a, b"v1").unwrap();

    let opened = svc.open_workspace_file(&main, &file_a, ts(10)).unwrap();
    let recent_id = match opened.history {
        HistoryPersistenceStatus::Persisted(doc) => doc.id,
        other => panic!("expected persisted recent: {other:?}"),
    };
    svc.close_workspace(&main, &opened.opened.id).unwrap();

    let reopened = svc
        .reopen_recent(&main, recent_id.as_str(), ts(20))
        .unwrap();
    assert_eq!(reopened.opened.label, "paper.tex");

    // SaveAs cancel returns Ok(None).
    let req = SaveAsRequest {
        images: Some(
            ImageBatch::new(vec![ManagedImage {
                path: rel("modutex-image-a1.png"),
                bytes: png_bytes(),
            }])
            .unwrap(),
        ),
        workspace_id: Some(reopened.opened.id.clone()),
        bytes: b"\\documentclass{book}".to_vec(),
        document_id: doc_id("doc_book"),
        document_version: doc_ver(1),
    };
    assert_eq!(svc.save_as(&main, &req, None, ts(30)).unwrap(), None);

    // SaveAs into a directory where the target .tex has an unowned recovery artifact must
    // roll back the newly written image so no partial files remain.
    let dir_fail = tmp.base.join("dir_fail");
    fs::create_dir_all(&dir_fail).unwrap();
    fs::write(dir_fail.join(".modutex-bak-book.tex"), b"precious").unwrap();
    let fail_target = dir_fail.join("book.tex");
    assert_eq!(
        svc.save_as(&main, &req, Some(&fail_target), ts(31)),
        Err(FilesystemError::RecoveryRequired)
    );
    assert!(!dir_fail.join("modutex-image-a1.png").exists());

    // Clean SaveAs succeeds and writes both image and TeX document.
    let dir_ok = tmp.base.join("dir_ok");
    fs::create_dir_all(&dir_ok).unwrap();
    let ok_target = dir_ok.join("book.tex");
    let saved = svc
        .save_as(&main, &req, Some(&ok_target), ts(32))
        .unwrap()
        .unwrap();
    assert_eq!(saved.opened.workspace.label, "book.tex");
    assert!(dir_ok.join("modutex-image-a1.png").exists());
    assert_eq!(fs::read(&ok_target).unwrap(), b"\\documentclass{book}");
}

#[test]
fn revoked_owner_blocks_later_and_racing_workspace_admissions() {
    let tmp = TempWorkspace::new("revoke-admission");
    let svc = tmp.service(DEFAULT_CLOSE_DRAIN_TIMEOUT);
    let (oa, ob) = (owner("main"), owner("secondary"));
    let ws_dir = tmp.base.join("proj");
    fs::create_dir_all(&ws_dir).unwrap();
    let tex_path = ws_dir.join("main.tex");
    fs::write(&tex_path, b"v1").unwrap();

    let reservation = svc.reserve_owner_admission(&oa).unwrap();
    let pinned = pin_and_validate_root(&ws_dir).unwrap();
    let svc_revoker = svc.clone();
    let oa_revoker = oa.clone();
    let revoker = std::thread::spawn(move || svc_revoker.revoke_owner(&oa_revoker));
    while !svc.lock_state().revoked_owners.contains(&oa) {
        std::thread::yield_now();
    }
    assert_eq!(
        svc.admit_pinned_workspace(
            &oa,
            reservation,
            pinned,
            WorkspaceKind::Folder,
            "proj".into(),
            None
        )
        .err(),
        Some(FilesystemError::SessionClosed)
    );
    assert_eq!(revoker.join().unwrap(), Ok(0));
    assert_eq!(
        svc.open_workspace_folder(&oa, &ws_dir, None, ts(2)),
        Err(FilesystemError::SessionClosed)
    );
    assert_eq!(
        svc.open_workspace_file(&oa, &tex_path, ts(3)),
        Err(FilesystemError::SessionClosed)
    );
    assert!(svc.open_workspace_folder(&ob, &ws_dir, None, ts(4)).is_ok());
}

#[test]
fn second_owner_same_root_preserves_first_session_and_enforces_lease_exclusion() {
    let tmp = TempWorkspace::new("same-root-owners");
    let svc = tmp.service(DEFAULT_CLOSE_DRAIN_TIMEOUT);
    let (oa, ob) = (owner("main"), owner("secondary"));
    let ws_dir = tmp.base.join("shared");
    fs::create_dir_all(&ws_dir).unwrap();

    let ws_a = svc
        .open_workspace_folder(&oa, &ws_dir, None, ts(1))
        .unwrap()
        .opened
        .id;
    let gen_a = svc.workspace_generation(&oa, &ws_a).unwrap();
    let ws_b = svc
        .open_workspace_folder(&ob, &ws_dir, None, ts(2))
        .unwrap()
        .opened
        .id;
    let gen_b = svc.workspace_generation(&ob, &ws_b).unwrap();
    assert_ne!(gen_a, gen_b);
    assert_eq!(svc.workspace_generation(&oa, &ws_a), Ok(gen_a));

    let w_a = svc
        .write_file(
            &oa,
            &WriteRequest {
                workspace_id: ws_a.clone(),
                path: rel("main.tex"),
                bytes: b"\\section{A}".to_vec(),
                expected_revision: None,
                document_id: doc_id("doc_a"),
                document_version: doc_ver(1),
            },
        )
        .unwrap();
    assert_eq!(svc.list_files(&oa, &ws_a).unwrap().len(), 1);
    assert_eq!(
        svc.read_file(
            &ob,
            &FileRef {
                workspace_id: ws_b.clone(),
                path: rel("main.tex")
            }
        )
        .unwrap()
        .bytes,
        b"\\section{A}"
    );

    let ticket = svc
        .prepare_compile(
            &oa,
            RunId::parse("run-a").unwrap(),
            &CompileRequest {
                workspace_id: ws_a.clone(),
                entry_path: rel("main.tex"),
                document_id: doc_id("doc_a"),
                document_version: doc_ver(1),
                saved_revision: w_a.revision.clone(),
                engine: Engine::Managed,
            },
            Box::new(|| Ok(())),
        )
        .unwrap();
    assert_eq!(
        svc.write_file(
            &ob,
            &WriteRequest {
                workspace_id: ws_b.clone(),
                path: rel("main.tex"),
                bytes: b"\\section{B}".to_vec(),
                expected_revision: Some(w_a.revision.clone()),
                document_id: doc_id("doc_b"),
                document_version: doc_ver(1),
            }
        ),
        Err(FilesystemError::WorkspaceBusy)
    );
    drop(ticket);
}

#[test]
fn save_as_fault_injection_rolls_back_committed_existing_and_new_images_without_outside_changes() {
    let tmp = TempWorkspace::new("saveas-fault-rollback");
    let svc = tmp.service(DEFAULT_CLOSE_DRAIN_TIMEOUT);
    let main = owner("main");

    let source_dir = tmp.base.join("source_ws");
    fs::create_dir_all(&source_dir).unwrap();
    let source_tex = source_dir.join("origin.tex");
    fs::write(&source_tex, b"\\section{OriginalSource}").unwrap();
    let outside_file = tmp.base.join("outside.txt");
    fs::write(&outside_file, b"outside-untouched").unwrap();

    let src_opened = svc.open_workspace_file(&main, &source_tex, ts(10)).unwrap();

    let target_dir = tmp.base.join("target_ws");
    fs::create_dir_all(&target_dir).unwrap();
    let existing_img1_path = target_dir.join("modutex-image-a1.png");
    let mut orig_img1_bytes = png_bytes();
    orig_img1_bytes[8..12].copy_from_slice(&[1, 2, 3, 4]);
    fs::write(&existing_img1_path, &orig_img1_bytes).unwrap();

    let new_img2_path = target_dir.join("modutex-image-b2.png");
    let target_tex = target_dir.join("book.tex");
    fs::write(&target_tex, b"\\section{ExistingBook}").unwrap();
    let unrelated_target_file = target_dir.join("notes.txt");
    fs::write(&unrelated_target_file, b"keep-notes").unwrap();

    let mut new_img1_bytes = png_bytes();
    new_img1_bytes[8..12].copy_from_slice(&[9, 9, 9, 9]);
    let mut new_img2_bytes = png_bytes();
    new_img2_bytes[8..12].copy_from_slice(&[7, 7, 7, 7]);

    let req = SaveAsRequest {
        images: Some(
            ImageBatch::new(vec![
                ManagedImage {
                    path: rel("modutex-image-a1.png"),
                    bytes: new_img1_bytes.clone(),
                },
                ManagedImage {
                    path: rel("modutex-image-b2.png"),
                    bytes: new_img2_bytes.clone(),
                },
            ])
            .unwrap(),
        ),
        workspace_id: Some(src_opened.opened.id.clone()),
        bytes: b"\\documentclass{memoir}".to_vec(),
        document_id: doc_id("doc_book"),
        document_version: doc_ver(2),
    };

    // Fault on 2nd image write after 1st image (overwriting existing) is already committed.
    let res_second_fail = svc.save_as_with_hook(
        &main,
        &req,
        Some(&target_tex),
        ts(20),
        |step, path, root| {
            if step == 1 {
                assert_eq!(path.as_str(), "modutex-image-b2.png");
                assert_eq!(
                    root.read_file(&rel("modutex-image-a1.png")).unwrap().bytes,
                    new_img1_bytes
                );
                return Err(FsError::Io(5));
            }
            Ok(())
        },
    );
    assert_eq!(res_second_fail, Err(FilesystemError::Io(5)));
    assert_eq!(fs::read(&existing_img1_path).unwrap(), orig_img1_bytes);
    assert!(!new_img2_path.exists());
    assert_eq!(fs::read(&target_tex).unwrap(), b"\\section{ExistingBook}");
    assert_eq!(fs::read(&unrelated_target_file).unwrap(), b"keep-notes");
    assert_eq!(fs::read(&source_tex).unwrap(), b"\\section{OriginalSource}");
    assert_eq!(fs::read(&outside_file).unwrap(), b"outside-untouched");

    // Fault on final TeX write after both existing image 1 and new image 2 are committed.
    let res_third_fail = svc.save_as_with_hook(
        &main,
        &req,
        Some(&target_tex),
        ts(21),
        |step, path, root| {
            if step == 2 {
                assert_eq!(path.as_str(), "book.tex");
                assert_eq!(
                    root.read_file(&rel("modutex-image-a1.png")).unwrap().bytes,
                    new_img1_bytes
                );
                assert_eq!(
                    root.read_file(&rel("modutex-image-b2.png")).unwrap().bytes,
                    new_img2_bytes
                );
                return Err(FsError::SharingViolation);
            }
            Ok(())
        },
    );
    assert_eq!(res_third_fail, Err(FilesystemError::SharingViolation));
    assert_eq!(fs::read(&existing_img1_path).unwrap(), orig_img1_bytes);
    assert!(!new_img2_path.exists());
    assert_eq!(fs::read(&target_tex).unwrap(), b"\\section{ExistingBook}");

    // If a committed file is concurrently modified on disk before rollback runs,
    // delete_file_if_revision refuses to clobber it and save_as reports CleanupUnproven.
    let new_img2_path_hook = new_img2_path.clone();
    let res_unproven_rollback = svc.save_as_with_hook(
        &main,
        &req,
        Some(&target_tex),
        ts(22),
        move |step, _path, _root| {
            if step == 2 {
                fs::write(&new_img2_path_hook, b"external-concurrent-modification").unwrap();
                return Err(FsError::Io(99));
            }
            Ok(())
        },
    );
    assert_eq!(
        res_unproven_rollback.unwrap_err().code(),
        FilesystemErrorCode::CleanupUnproven
    );
    assert_eq!(fs::read(&existing_img1_path).unwrap(), orig_img1_bytes);
    assert_eq!(
        fs::read(&new_img2_path).unwrap(),
        b"external-concurrent-modification"
    );
    assert_eq!(fs::read(&target_tex).unwrap(), b"\\section{ExistingBook}");
}

#[test]
fn abandoned_or_unwound_tickets_retain_leases_and_retired_slot_until_explicit_host_drain() {
    let tmp = TempWorkspace::new("abandoned-ticket-drain");
    let svc = tmp.service(Duration::from_millis(60));
    let (oa, ob) = (owner("main"), owner("secondary"));
    let parent_dir = tmp.base.join("project");
    let child_dir = parent_dir.join("sub");
    fs::create_dir_all(&child_dir).unwrap();

    let ws_parent = svc
        .open_workspace_folder(&oa, &parent_dir, None, ts(1))
        .unwrap()
        .opened
        .id;
    let ws_child = svc
        .open_workspace_folder(&ob, &child_dir, None, ts(2))
        .unwrap()
        .opened
        .id;

    let saved = svc
        .write_file(
            &oa,
            &WriteRequest {
                workspace_id: ws_parent.clone(),
                path: rel("main.tex"),
                bytes: b"\\documentclass{article}".to_vec(),
                expected_revision: None,
                document_id: doc_id("doc_main"),
                document_version: doc_ver(1),
            },
        )
        .unwrap();

    // Simulate panic unwind dropping CompileLeaseTicket without settle/finish_drain.
    let svc_unwind = svc.clone();
    let oa_unwind = oa.clone();
    let ws_parent_unwind = ws_parent.clone();
    let rev_unwind = saved.revision.clone();
    let unwound_task_id = catch_unwind(AssertUnwindSafe(move || {
        let ticket = svc_unwind
            .prepare_compile(
                &oa_unwind,
                RunId::parse("run-unwind").unwrap(),
                &CompileRequest {
                    workspace_id: ws_parent_unwind,
                    entry_path: rel("main.tex"),
                    document_id: doc_id("doc_main"),
                    document_version: doc_ver(1),
                    saved_revision: rev_unwind,
                    engine: Engine::Managed,
                },
                Box::new(|| Ok(())),
            )
            .unwrap();
        let id = ticket.task_id();
        assert!(id > 0);
        panic!("simulated worker unwind before drain proof");
    }));
    assert!(unwound_task_id.is_err());
    assert!(svc.has_undrained_cleanup(&ws_parent));

    // Save/Compile exclusion must remain enforced on both parent and overlapping child root.
    assert_eq!(
        svc.write_file(
            &oa,
            &WriteRequest {
                workspace_id: ws_parent.clone(),
                path: rel("main.tex"),
                bytes: b"blocked-parent".to_vec(),
                expected_revision: Some(saved.revision.clone()),
                document_id: doc_id("doc_main"),
                document_version: doc_ver(2),
            },
        ),
        Err(FilesystemError::WorkspaceBusy)
    );
    assert_eq!(
        svc.write_file(
            &ob,
            &WriteRequest {
                workspace_id: ws_child.clone(),
                path: rel("child.tex"),
                bytes: b"blocked-child".to_vec(),
                expected_revision: None,
                document_id: doc_id("doc_child"),
                document_version: doc_ver(1),
            },
        ),
        Err(FilesystemError::WorkspaceBusy)
    );

    // Closing parent workspace while compile task is abandoned & undrained returns CleanupUnproven
    // and retains the retiring slot and its exclusive Compile lease.
    let close_err = svc.close_workspace(&oa, &ws_parent).unwrap_err();
    assert_eq!(close_err.code(), FilesystemErrorCode::CleanupUnproven);
    assert!(svc.has_undrained_cleanup(&ws_parent));
    assert_eq!(
        svc.write_file(
            &ob,
            &WriteRequest {
                workspace_id: ws_child.clone(),
                path: rel("child.tex"),
                bytes: b"still-blocked-child".to_vec(),
                expected_revision: None,
                document_id: doc_id("doc_child"),
                document_version: doc_ver(1),
            },
        ),
        Err(FilesystemError::WorkspaceBusy)
    );

    // Failing cleanup proof retains exclusion; verified cleanup proof releases it.
    assert_eq!(
        svc.process_pending_cleanup_with(&oa, &ws_parent, |_| {
            Err("child process still terminating".to_owned())
        })
        .unwrap_err()
        .code(),
        FilesystemErrorCode::CleanupUnproven
    );
    assert!(svc.has_undrained_cleanup(&ws_parent));

    assert_eq!(
        svc.process_pending_cleanup_with(&oa, &ws_parent, |_| Ok(())),
        Ok(())
    );
    assert!(!svc.has_undrained_cleanup(&ws_parent));
    assert!(svc
        .write_file(
            &ob,
            &WriteRequest {
                workspace_id: ws_child,
                path: rel("child.tex"),
                bytes: b"now-unblocked".to_vec(),
                expected_revision: None,
                document_id: doc_id("doc_child"),
                document_version: doc_ver(1),
            },
        )
        .is_ok());
}

#[test]
fn bounded_admission_limits_reject_when_stuck_tasks_or_retiring_workspaces_accumulate() {
    let tmp = TempWorkspace::new("bounded-stuck-limits");
    let svc = tmp.service(Duration::from_millis(20));
    let main = owner("main");
    let ws_dir = tmp.base.join("ws");
    fs::create_dir_all(&ws_dir).unwrap();

    let ws_id = svc
        .open_workspace_folder(&main, &ws_dir, None, ts(1))
        .unwrap()
        .opened
        .id;
    let mut first_task_id = None;
    for _ in 0..MAX_TASKS_PER_WORKSPACE {
        let sub = svc
            .start_watch(&main, &ws_id, Arc::new(|_| {}), Box::new(|| Ok(())))
            .unwrap();
        if first_task_id.is_none() {
            first_task_id = Some(sub.task_id());
        }
        drop(sub); // abandoned without finish_drain
    }
    assert_eq!(
        svc.start_watch(&main, &ws_id, Arc::new(|_| {}), Box::new(|| Ok(())))
            .err(),
        Some(FilesystemError::ResourceExhausted)
    );
    assert_eq!(
        svc.complete_task_drain(&main, &ws_id, first_task_id.unwrap()),
        Ok(true)
    );
    let mut recovered_sub = svc
        .start_watch(&main, &ws_id, Arc::new(|_| {}), Box::new(|| Ok(())))
        .unwrap();
    recovered_sub.finish_drain();
}

mod reviewer_acceptance {
    // Independent service lifecycle acceptance; controlled temp directories only.
    use crate::{
        schemas::protocol::{OwnerId, Timestamp},
        services::filesystem::FilesystemService,
        state::recent::RecentStore,
        state::sessions::SessionRegistry,
        state::settings::SettingsStore,
        state::workspace_leases::WorkspaceLeaseCoordinator,
    };
    use std::{fs, path::PathBuf, sync::Arc};
    struct Fixture {
        base: PathBuf,
        workspace: PathBuf,
        svc: FilesystemService,
    }
    impl Fixture {
        fn new() -> Self {
            let base = std::env::temp_dir().join(format!(
                "modutex-review-coordinator-{}",
                uuid::Uuid::new_v4()
            ));
            let workspace = base.join("workspace");
            fs::create_dir_all(&workspace).unwrap();
            let data = base.join("host");
            let svc = FilesystemService::new(
                Arc::new(SessionRegistry::new()),
                WorkspaceLeaseCoordinator::new(),
                RecentStore::new(&data),
                SettingsStore::new(&data),
            );
            Self {
                base,
                workspace,
                svc,
            }
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.base);
        }
    }
    #[test]
    fn second_owner_same_root_does_not_invalidate_first_workspace() {
        let f = Fixture::new();
        let a = OwnerId::from_label("main").unwrap();
        let b = OwnerId::from_label("other").unwrap();
        let first = f
            .svc
            .open_workspace_folder(&a, &f.workspace, None, Timestamp::new(1).unwrap())
            .unwrap()
            .opened;
        let second = f
            .svc
            .open_workspace_folder(&b, &f.workspace, None, Timestamp::new(2).unwrap())
            .unwrap()
            .opened;
        assert!(f.svc.list_files(&b, &second.id).is_ok());
        let valid = f.svc.list_files(&a, &first.id);
        f.svc.revoke_owner(&a).unwrap();
        f.svc.revoke_owner(&b).unwrap();
        assert!(
            valid.is_ok(),
            "opening same root for another owner must preserve first workspace: {valid:?}"
        );
    }
    #[test]
    fn revoked_window_owner_cannot_admit_a_new_workspace() {
        let f = Fixture::new();
        let owner = OwnerId::from_label("main").unwrap();
        f.svc.revoke_owner(&owner).unwrap();
        let admitted =
            f.svc
                .open_workspace_folder(&owner, &f.workspace, None, Timestamp::new(1).unwrap());
        if admitted.is_ok() {
            f.svc.revoke_owner(&owner).unwrap();
        }
        assert!(
            admitted.is_err(),
            "owner revocation must also block later or racing admission"
        );
    }

    #[test]
    fn reopening_same_root_keeps_old_workspace_closable_and_new_one_usable() {
        let f = Fixture::new();
        let owner = OwnerId::from_label("main").unwrap();
        let a = f
            .svc
            .open_workspace_folder(&owner, &f.workspace, None, Timestamp::new(1).unwrap())
            .unwrap()
            .opened;
        let b = f
            .svc
            .open_workspace_folder(&owner, &f.workspace, None, Timestamp::new(2).unwrap())
            .unwrap()
            .opened;
        let closed = f.svc.close_workspace(&owner, &a.id);
        let active = f.svc.list_files(&owner, &b.id);
        f.svc.revoke_owner(&owner).unwrap();
        assert!(
            closed.is_ok(),
            "old workspace must remain cleanable after reopen: {closed:?}"
        );
        assert!(active.is_ok());
    }

    #[test]
    fn dropping_compile_ticket_does_not_release_input_lease_without_drain_proof() {
        use crate::{
            schemas::protocol::{
                CompileRequest, DocumentId, DocumentVersion, Engine, RunId, WriteRequest,
            },
            services::filesystem::FilesystemError,
            shared::relative_path::RelativePath,
        };
        let f = Fixture::new();
        let owner = OwnerId::from_label("main").unwrap();
        let ws = f
            .svc
            .open_workspace_folder(&owner, &f.workspace, None, Timestamp::new(1).unwrap())
            .unwrap()
            .opened
            .id;
        let write = WriteRequest {
            workspace_id: ws.clone(),
            path: RelativePath::parse("main.tex").unwrap(),
            bytes: b"source".to_vec(),
            expected_revision: None,
            document_id: DocumentId::parse("doc_review").unwrap(),
            document_version: DocumentVersion::new(1).unwrap(),
        };
        let saved = f.svc.write_file(&owner, &write).unwrap();
        let ticket = f
            .svc
            .prepare_compile(
                &owner,
                RunId::parse("run-review-drop").unwrap(),
                &CompileRequest {
                    workspace_id: ws,
                    entry_path: write.path.clone(),
                    document_id: write.document_id.clone(),
                    document_version: write.document_version,
                    saved_revision: saved.revision.clone(),
                    engine: Engine::Managed,
                },
                Box::new(|| Ok(())),
            )
            .unwrap();
        drop(ticket);
        let changed = WriteRequest {
            expected_revision: Some(saved.revision),
            bytes: b"replacement".to_vec(),
            ..write
        };
        assert_eq!(
            f.svc.write_file(&owner, &changed),
            Err(FilesystemError::WorkspaceBusy),
            "dropping ticket cannot prove process/readers are stopped"
        );
    }

    #[test]
    fn workspace_close_waits_for_admitted_delivery_and_blocks_later_callbacks() {
        use crate::{
            schemas::protocol::FileEventKind, services::filesystem::TaskDrainHandle,
            shared::relative_path::RelativePath,
        };
        use std::{
            sync::{
                atomic::{AtomicUsize, Ordering},
                mpsc, Mutex,
            },
            thread,
            time::Duration,
        };
        let f = Fixture::new();
        let owner = OwnerId::from_label("main").unwrap();
        let ws = f
            .svc
            .open_workspace_folder(&owner, &f.workspace, None, Timestamp::new(1).unwrap())
            .unwrap()
            .opened
            .id;
        let (entered_tx, entered_rx) = mpsc::sync_channel(1);
        let (release_tx, release_rx) = mpsc::sync_channel(1);
        let release_rx = Arc::new(Mutex::new(release_rx));
        let deliveries = Arc::new(AtomicUsize::new(0));
        let counted = deliveries.clone();
        let handle: Arc<Mutex<Option<TaskDrainHandle>>> = Arc::new(Mutex::new(None));
        let for_cancel = handle.clone();
        let watch = f
            .svc
            .start_watch(
                &owner,
                &ws,
                Arc::new(move |_| {
                    counted.fetch_add(1, Ordering::SeqCst);
                    entered_tx.send(()).unwrap();
                    release_rx
                        .lock()
                        .unwrap()
                        .recv_timeout(Duration::from_secs(3))
                        .unwrap();
                }),
                Box::new(move || {
                    for_cancel
                        .lock()
                        .unwrap()
                        .as_ref()
                        .unwrap()
                        .finish_drain()
                        .map(|_| ())
                        .map_err(|e| e.to_string())
                }),
            )
            .unwrap();
        *handle.lock().unwrap() = Some(watch.drain_handle().unwrap());
        let watch = Arc::new(watch);
        let sending = watch.clone();
        let emitter = thread::spawn(move || {
            sending.emit_file_event(
                RelativePath::parse("main.tex").unwrap(),
                FileEventKind::Changed,
            )
        });
        entered_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        let closing_service = f.svc.clone();
        let closing_owner = owner.clone();
        let closing_ws = ws.clone();
        let (closed_tx, closed_rx) = mpsc::sync_channel(1);
        let closer = thread::spawn(move || {
            closed_tx
                .send(closing_service.close_workspace(&closing_owner, &closing_ws))
                .unwrap()
        });
        let not_closed_yet = closed_rx.recv_timeout(Duration::from_millis(60));
        release_tx.send(()).unwrap();
        let emitted = emitter.join().unwrap();
        let closed = closed_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        closer.join().unwrap();
        assert!(
            matches!(not_closed_yet, Err(mpsc::RecvTimeoutError::Timeout)),
            "close must not report drain while delivery remains in progress"
        );
        assert_eq!(emitted, Ok(true));
        assert_eq!(closed, Ok(()));
        assert!(watch
            .emit_file_event(
                RelativePath::parse("main.tex").unwrap(),
                FileEventKind::Changed
            )
            .is_err());
        assert_eq!(deliveries.load(Ordering::SeqCst), 1);
    }
}
