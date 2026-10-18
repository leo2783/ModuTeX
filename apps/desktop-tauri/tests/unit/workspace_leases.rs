// SPDX-License-Identifier: Apache-2.0
use super::*;
use std::{fs, path::PathBuf, sync::mpsc, sync::Barrier, thread};
use uuid::Uuid;

struct TempDir(PathBuf);

impl TempDir {
    fn new(tag: &str) -> Self {
        let path = std::env::temp_dir().join(format!("modutex-leases-{tag}-{}", Uuid::new_v4()));
        fs::create_dir_all(&path).expect("create temp dir");
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn owner(label: &str) -> OwnerId {
    OwnerId::from_label(label).expect("owner")
}

fn ws(id: &str) -> WorkspaceId {
    WorkspaceId::parse(id).expect("ws")
}

fn root(vol: u64, fid: u128, path: &str) -> TrustedWorkspaceRoot {
    TrustedWorkspaceRoot::new(
        RootIdentity::new(vol, fid),
        CanonicalRootPath::parse(path).expect("path"),
    )
}

#[test]
fn parent_child_roots_exclude_save_and_compile_across_owners() {
    let coord = WorkspaceLeaseCoordinator::new();
    let (oa, ob) = (owner("main"), owner("secondary"));
    let (wa, wb) = (ws("ws-parent"), ws("ws-child"));
    coord
        .admit_trusted(&oa, &wa, root(1, 10, r"C:\Work\Thesis"))
        .unwrap();
    coord
        .admit_trusted(&ob, &wb, root(1, 11, r"\\?\c:/work/thesis/chapters"))
        .unwrap();

    let save = coord
        .try_acquire(&oa, &wa, None, LeaseKind::Save, None)
        .unwrap();
    assert_eq!(
        coord
            .try_acquire(&ob, &wb, None, LeaseKind::Compile, None)
            .err(),
        Some(LeaseError::WouldBlock)
    );

    let (tx, rx) = mpsc::channel();
    let c2 = coord.clone();
    let handle = thread::spawn(move || {
        let compile = c2
            .acquire_bounded(
                &ob,
                &wb,
                None,
                LeaseKind::Compile,
                LeaseWaitOptions {
                    timeout: Some(Duration::from_secs(5)),
                    cancel: None,
                },
                None,
            )
            .unwrap();
        tx.send(compile.kind()).unwrap();
    });
    assert!(coord.wait_until_queued(1, Duration::from_secs(5)));
    drop(save);
    assert_eq!(
        rx.recv_timeout(Duration::from_secs(5)).unwrap(),
        LeaseKind::Compile
    );
    handle.join().unwrap();
}

#[test]
fn disjoint_roots_progress_concurrently_via_barrier() {
    let coord = WorkspaceLeaseCoordinator::new();
    let (oa, ob) = (owner("a"), owner("b"));
    let (wa, wb) = (ws("ws-a"), ws("ws-b"));
    coord
        .admit_trusted(&oa, &wa, root(1, 20, r"C:\Work\Alpha"))
        .unwrap();
    coord
        .admit_trusted(&ob, &wb, root(1, 21, r"C:\Work\Beta"))
        .unwrap();

    let barrier = Arc::new(Barrier::new(2));
    let (c1, b1) = (coord.clone(), Arc::clone(&barrier));
    let t1 = thread::spawn(move || {
        let _g = c1
            .acquire_bounded(
                &oa,
                &wa,
                None,
                LeaseKind::Save,
                LeaseWaitOptions {
                    timeout: Some(Duration::from_secs(5)),
                    cancel: None,
                },
                None,
            )
            .unwrap();
        b1.wait();
    });
    let (c2, b2) = (coord.clone(), Arc::clone(&barrier));
    let t2 = thread::spawn(move || {
        let _g = c2
            .acquire_bounded(
                &ob,
                &wb,
                None,
                LeaseKind::Compile,
                LeaseWaitOptions {
                    timeout: Some(Duration::from_secs(5)),
                    cancel: None,
                },
                None,
            )
            .unwrap();
        b2.wait();
    });
    t1.join().unwrap();
    t2.join().unwrap();
}

#[test]
fn queued_cancel_and_close_free_waiters_without_resurrection() {
    let coord = WorkspaceLeaseCoordinator::new();
    let o = owner("main");
    let (w1, w2) = (ws("ws-1"), ws("ws-2"));
    coord
        .admit_trusted(&o, &w1, root(1, 30, r"C:\Work\Doc"))
        .unwrap();
    coord
        .admit_trusted(&o, &w2, root(1, 31, r"C:\Work\Doc\sub"))
        .unwrap();

    let held = coord
        .try_acquire(&o, &w1, None, LeaseKind::Save, None)
        .unwrap();
    let token = CancelToken::new();
    let (c_cancel, tok_clone, o1, w1_c) = (coord.clone(), token.clone(), o.clone(), w1.clone());
    let t_cancel = thread::spawn(move || {
        c_cancel
            .acquire_bounded(
                &o1,
                &w1_c,
                None,
                LeaseKind::Compile,
                LeaseWaitOptions {
                    timeout: None,
                    cancel: Some(&tok_clone),
                },
                None,
            )
            .err()
    });
    assert!(coord.wait_until_queued(1, Duration::from_secs(5)));
    let (c_close, o2, w2_c) = (coord.clone(), o.clone(), w2.clone());
    let t_close = thread::spawn(move || {
        c_close
            .acquire_bounded(
                &o2,
                &w2_c,
                None,
                LeaseKind::Save,
                LeaseWaitOptions::default(),
                None,
            )
            .err()
    });
    assert!(coord.wait_until_queued(2, Duration::from_secs(5)));

    token.cancel();
    assert_eq!(t_cancel.join().unwrap(), Some(LeaseError::Cancelled));
    coord.close_session(&o, &w2).unwrap();
    assert_eq!(t_close.join().unwrap(), Some(LeaseError::SessionClosed));
    drop(held);
    assert_eq!(
        coord
            .try_acquire(&o, &w2, None, LeaseKind::Read, None)
            .err(),
        Some(LeaseError::SessionClosed)
    );
    assert_eq!(
        coord
            .admit_trusted(&o, &w2, root(1, 31, r"C:\Work\Doc\sub"))
            .err(),
        Some(LeaseError::WorkspaceAlreadyUsed)
    );
}

#[test]
fn active_lease_close_cancels_outside_lock_and_drains_without_stale_admission() {
    let coord = WorkspaceLeaseCoordinator::new();
    let o = owner("main");
    let w = ws("ws-drain");
    let gen = coord
        .admit_trusted(&o, &w, root(2, 40, r"D:\Proj"))
        .unwrap();
    let read_lease = coord
        .try_acquire(&o, &w, Some(gen), LeaseKind::Read, None)
        .unwrap();
    let (cb_tx, cb_rx) = mpsc::channel();
    let (done_tx, done_rx) = mpsc::channel();
    let (c_cb, o_cb, w_cb) = (coord.clone(), o.clone(), w.clone());
    let watch_lease = coord
        .try_acquire(
            &o,
            &w,
            Some(gen),
            LeaseKind::Watch,
            Some(Box::new(move || {
                let err = c_cb
                    .try_acquire(&o_cb, &w_cb, Some(gen), LeaseKind::List, None)
                    .err();
                cb_tx.send(err).unwrap();
            })),
        )
        .unwrap();
    let (c_close, o_cl, w_cl) = (coord.clone(), o.clone(), w.clone());
    let closer = thread::spawn(move || {
        c_close.close_session(&o_cl, &w_cl).unwrap();
        done_tx.send(()).unwrap();
    });
    assert_eq!(
        cb_rx.recv_timeout(Duration::from_secs(5)).unwrap(),
        Some(LeaseError::SessionClosed)
    );
    drop(watch_lease);
    assert!(done_rx.try_recv().is_err());
    drop(read_lease);
    done_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    closer.join().unwrap();
}

#[test]
fn generation_rollover_and_alias_identity_are_enforced() {
    let coord = WorkspaceLeaseCoordinator::new();
    let (oa, ob) = (owner("a"), owner("b"));
    let (w1, w2, w3) = (ws("ws-alias-1"), ws("ws-alias-2"), ws("ws-exhaust"));
    coord.shared.lock().next_generation = Some(u64::MAX - 1);
    let g1 = coord
        .admit_trusted(&oa, &w1, root(9, 999, r"C:\Real\Root"))
        .unwrap();
    let g2 = coord
        .admit_trusted(&ob, &w2, root(9, 999, r"Z:\AliasMount"))
        .unwrap();
    assert_eq!(g2.get(), u64::MAX);
    assert_eq!(
        coord
            .admit_trusted(&oa, &w3, root(9, 1000, r"C:\Other"))
            .err(),
        Some(LeaseError::CounterOverflow)
    );

    let g_save = coord
        .try_acquire(&oa, &w1, Some(g1), LeaseKind::Save, None)
        .unwrap();
    assert_eq!(
        coord
            .try_acquire(&ob, &w2, Some(g2), LeaseKind::Compile, None)
            .err(),
        Some(LeaseError::WouldBlock)
    );
    assert_eq!(
        coord
            .try_acquire(&oa, &w1, Some(g2), LeaseKind::Read, None)
            .err(),
        Some(LeaseError::StaleGeneration)
    );
    drop(g_save);
    assert!(coord
        .try_acquire(&ob, &w2, Some(g2), LeaseKind::Compile, None)
        .is_ok());
}

#[test]
fn overflowing_timeout_is_rejected_without_panic() {
    let coord = WorkspaceLeaseCoordinator::new();
    let o = owner("main");
    let w = ws("ws-timeout");
    coord
        .admit_trusted(&o, &w, root(3, 50, r"C:\Work\Timeout"))
        .unwrap();

    assert_eq!(
        coord
            .acquire_bounded(
                &o,
                &w,
                None,
                LeaseKind::Read,
                LeaseWaitOptions {
                    timeout: Some(Duration::MAX),
                    cancel: None,
                },
                None,
            )
            .err(),
        Some(LeaseError::InvalidTimeout)
    );

    let _held = coord
        .try_acquire(&o, &w, None, LeaseKind::Save, None)
        .unwrap();
    assert_eq!(
        coord
            .acquire_bounded(
                &o,
                &w,
                None,
                LeaseKind::Compile,
                LeaseWaitOptions {
                    timeout: Some(Duration::MAX),
                    cancel: None,
                },
                None,
            )
            .err(),
        Some(LeaseError::InvalidTimeout)
    );
    assert!(!coord.wait_until_queued(1, Duration::MAX));
}

#[test]
fn cancel_token_reused_across_coordinators_wakes_all_waiters() {
    let coord_a = WorkspaceLeaseCoordinator::new();
    let coord_b = WorkspaceLeaseCoordinator::new();
    let o = owner("main");
    let (wa, wb) = (ws("ws-coord-a"), ws("ws-coord-b"));
    coord_a
        .admit_trusted(&o, &wa, root(4, 60, r"C:\Work\CoordA"))
        .unwrap();
    coord_b
        .admit_trusted(&o, &wb, root(5, 61, r"C:\Work\CoordB"))
        .unwrap();

    let _held_a = coord_a
        .try_acquire(&o, &wa, None, LeaseKind::Save, None)
        .unwrap();
    let _held_b = coord_b
        .try_acquire(&o, &wb, None, LeaseKind::Save, None)
        .unwrap();

    let shared_token = CancelToken::new();
    let (ca, ta, oa, wa_c) = (coord_a.clone(), shared_token.clone(), o.clone(), wa.clone());
    let waiter_a = thread::spawn(move || {
        ca.acquire_bounded(
            &oa,
            &wa_c,
            None,
            LeaseKind::Compile,
            LeaseWaitOptions {
                timeout: None,
                cancel: Some(&ta),
            },
            None,
        )
        .err()
    });
    let (cb, tb, ob, wb_c) = (coord_b.clone(), shared_token.clone(), o.clone(), wb.clone());
    let waiter_b = thread::spawn(move || {
        cb.acquire_bounded(
            &ob,
            &wb_c,
            None,
            LeaseKind::Compile,
            LeaseWaitOptions {
                timeout: None,
                cancel: Some(&tb),
            },
            None,
        )
        .err()
    });

    assert!(coord_a.wait_until_queued(1, Duration::from_secs(5)));
    assert!(coord_b.wait_until_queued(1, Duration::from_secs(5)));

    shared_token.cancel();
    assert_eq!(waiter_a.join().unwrap(), Some(LeaseError::Cancelled));
    assert_eq!(waiter_b.join().unwrap(), Some(LeaseError::Cancelled));
}

#[test]
fn registry_admission_and_close_or_revoke_are_serialized_without_zombie_sessions() {
    let dir = TempDir::new("registry-sync");
    let registry = SessionRegistry::new();
    let coord = WorkspaceLeaseCoordinator::new();
    let o = owner("main");

    let preclosed = registry.open(&o, dir.path(), None).unwrap();
    coord
        .close_with_registry(&registry, &o, preclosed.id())
        .unwrap();
    assert_eq!(
        coord
            .admit_from_registry(
                &registry,
                &o,
                preclosed.id(),
                root(6, 70, r"C:\Work\Preclosed")
            )
            .err(),
        Some(LeaseError::UnknownSession)
    );
    assert_eq!(
        coord
            .admit_session(&preclosed, root(6, 70, r"C:\Work\Preclosed"))
            .err(),
        Some(LeaseError::WorkspaceAlreadyUsed)
    );

    let active = registry.open(&o, dir.path(), None).unwrap();
    coord
        .admit_from_registry(&registry, &o, active.id(), root(6, 71, r"C:\Work\Active"))
        .unwrap();
    assert_eq!(coord.revoke_owner_with_registry(&registry, &o), 1);
    assert_eq!(
        registry.get(&o, active.id()),
        Err(SessionError::UnknownSession)
    );
    assert_eq!(
        coord
            .try_acquire(&o, active.id(), None, LeaseKind::Read, None)
            .err(),
        Some(LeaseError::SessionClosed)
    );
}

#[test]
fn unicode_and_emoji_root_paths_normalize_and_reject_invalid_without_panic() {
    let cn_root = CanonicalRootPath::parse(r"C:\中文").unwrap();
    let cn_child = CanonicalRootPath::parse(r"\\?\c:/中文/論文章節/🦀").unwrap();
    let cn_chapters = CanonicalRootPath::parse(r"C:\論文章節").unwrap();
    let emoji_boundary = CanonicalRootPath::parse(r"C:\a\🦀\b").unwrap();
    assert!(cn_root.overlaps(&cn_child));
    assert!(!cn_root.overlaps(&cn_chapters));
    assert!(!cn_root.overlaps(&emoji_boundary));

    let unc_a = CanonicalRootPath::parse(r"\\?\unc\伺服器\共用\論文").unwrap();
    let unc_b = CanonicalRootPath::parse(r"\\伺服器\共用\論文\🦀").unwrap();
    let unc_c = CanonicalRootPath::parse(r"\\?\UNC\srv\share\中文").unwrap();
    assert!(unc_a.overlaps(&unc_b));
    assert!(!unc_a.overlaps(&unc_c));

    let coord = WorkspaceLeaseCoordinator::new();
    let (oa, ob) = (owner("main"), owner("secondary"));
    let (wa, wb) = (ws("ws-cn-parent"), ws("ws-cn-child"));
    coord
        .admit_trusted(&oa, &wa, root(7, 80, r"C:\論文章節"))
        .unwrap();
    coord
        .admit_trusted(&ob, &wb, root(7, 81, r"\\?\c:/論文章節/🦀"))
        .unwrap();
    let _held = coord
        .try_acquire(&oa, &wa, None, LeaseKind::Save, None)
        .unwrap();
    assert_eq!(
        coord
            .try_acquire(&ob, &wb, None, LeaseKind::Compile, None)
            .err(),
        Some(LeaseError::WouldBlock)
    );

    for invalid in [
        r"中文\論文章節",
        r"\\?\中文\論文章節",
        r"\\?\UNC\中文",
        r"C:\中文\..\論文章節",
        r"C:\a\🦀\bad:seg",
    ] {
        assert_eq!(
            CanonicalRootPath::parse(invalid),
            Err(LeaseError::InvalidRootPath)
        );
    }
}
