// SPDX-License-Identifier: Apache-2.0
use super::*;
use crate::platform::file_identity::{is_symlink_or_reparse, open_file_no_follow};
use crate::schemas::protocol::{WorkspaceId, MAX_SAFE_INTEGER};
use serde_json::{json, Value};
use std::sync::{atomic::AtomicUsize, mpsc};

struct TempDirGuard {
    path: PathBuf,
}

impl TempDirGuard {
    fn new(prefix: &str) -> Self {
        let dir = env::temp_dir().join(format!(
            "modutex-g2-recent-{prefix}-{}-{}",
            std::process::id(),
            Uuid::new_v4()
        ));
        fs::create_dir_all(&dir).expect("create temp test dir");
        Self { path: dir }
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TempDirGuard {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

fn ts(val: u64) -> Timestamp {
    Timestamp::new(val).expect("valid timestamp")
}

fn create_tex_file(dir: &Path, name: &str, contents: &[u8]) -> PathBuf {
    fs::create_dir_all(dir).expect("create parent dir");
    let file_path = dir.join(name);
    fs::write(&file_path, contents).expect("write tex file");
    file_path
}

#[cfg(windows)]
fn create_windows_junction(link: &Path, target: &Path) {
    let output = std::process::Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(link)
        .arg(target)
        .output()
        .expect("launch cmd.exe to create required junction fixture");
    assert!(
        output.status.success(),
        "mklink /J failed: stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let meta = fs::symlink_metadata(link).expect("junction fixture exists");
    assert!(
        is_symlink_or_reparse(&meta),
        "fixture is not a Windows reparse point: {}",
        link.display()
    );
}

#[test]
fn mru_cap_reopen_id_stability_and_public_dto_hides_canonical_path() {
    let temp = TempDirGuard::new("mru-cap");
    let data_dir = resolve_host_data_dir_from(temp.path());
    let workspaces_root = temp.path().join("workspaces");
    let store = RecentStore::new(&data_dir);

    let mut created_ids = Vec::new();
    for i in 0..25u64 {
        let folder = workspaces_root.join(format!("proj-{i:02}"));
        create_tex_file(&folder, "main.tex", b"\\documentclass{article}");
        let entry = Some(RelativePath::parse("main.tex").expect("rel"));
        let target = TrustedRecentTarget::for_folder(&folder, entry, ts(1000 + i)).expect("target");
        let doc = store.record_opened(target).expect("record opened");
        let serialized = serde_json::to_value(&doc).expect("serialize public DTO");
        assert!(serialized.get("canonicalPath").is_none());
        created_ids.push(doc.id);
    }

    let listed = store.list_recent().expect("list recent");
    assert_eq!(listed.len(), MAX_RECENT_DOCUMENTS);
    assert_eq!(listed[0].label, "proj-24");
    assert_eq!(listed[0].opened_at.get(), 1024);
    assert_eq!(listed[19].label, "proj-05");

    // Reopen proj-10: must retain exact same RecentId and move to index 0.
    let proj_10_folder = workspaces_root.join("proj-10");
    let proj_10_original_id = created_ids[10].clone();
    let reopen_target = TrustedRecentTarget::for_folder(
        &proj_10_folder,
        Some(RelativePath::parse("main.tex").expect("rel")),
        ts(9999),
    )
    .expect("reopen target");
    let reopened_doc = store.record_opened(reopen_target).expect("reopen");
    assert_eq!(reopened_doc.id, proj_10_original_id);
    assert_eq!(reopened_doc.opened_at.get(), 9999);

    let listed_after = store.list_recent().expect("list after reopen");
    assert_eq!(listed_after.len(), MAX_RECENT_DOCUMENTS);
    assert_eq!(listed_after[0].id, proj_10_original_id);
    assert_eq!(listed_after[0].opened_at.get(), 9999);
    assert_eq!(
        listed_after
            .iter()
            .filter(|d| d.id == proj_10_original_id)
            .count(),
        1
    );
}

#[test]
fn canonical_path_dedupe_handles_relative_segments_and_windows_case_insensitivity() {
    let temp = TempDirGuard::new("path-dedupe");
    let store = RecentStore::new(temp.path().join("host-data"));
    let nested = temp.path().join("work").join("ThesisFolder");
    let tex_file = create_tex_file(&nested, "paper.tex", b"hello");

    let first = store
        .record_opened(TrustedRecentTarget::for_file(&tex_file, ts(100)).expect("first"))
        .expect("record first");

    let dotdot_path = temp
        .path()
        .join("work")
        .join("ThesisFolder")
        .join(".")
        .join("..")
        .join("ThesisFolder")
        .join("paper.tex");
    let second = store
        .record_opened(TrustedRecentTarget::for_file(&dotdot_path, ts(200)).expect("second"))
        .expect("record dotdot");

    assert_eq!(first.id, second.id);
    assert_eq!(store.list_recent().expect("list").len(), 1);

    #[cfg(windows)]
    {
        let upper_case_path = PathBuf::from(tex_file.to_string_lossy().to_uppercase());
        let third = store
            .record_opened(TrustedRecentTarget {
                kind: WorkspaceKind::File,
                target_path: upper_case_path,
                label: "paper.tex".to_owned(),
                entry_path: Some(RelativePath::parse("paper.tex").expect("rel")),
                opened_at: ts(300),
            })
            .expect("record uppercase variant");
        assert_eq!(third.id, first.id);
        let list = store.list_recent().expect("list after case variant");
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].opened_at.get(), 300);
    }
}

#[test]
fn remove_recent_preserves_document_and_missing_target_is_retained_until_removed() {
    let temp = TempDirGuard::new("remove-and-missing");
    let store = RecentStore::new(temp.path().join("host-data"));
    let doc_dir = temp.path().join("docs");
    let file_a = create_tex_file(&doc_dir, "keep.tex", b"keep-bytes");
    let file_b = create_tex_file(&doc_dir, "vanish.tex", b"vanish-bytes");

    let rec_a = store
        .record_opened(TrustedRecentTarget::for_file(&file_a, ts(10)).expect("a"))
        .expect("record a");
    let rec_b = store
        .record_opened(TrustedRecentTarget::for_file(&file_b, ts(20)).expect("b"))
        .expect("record b");

    // Delete file_b on disk; list_recent and resolve_recent_for_open must NOT prune it silently.
    fs::remove_file(&file_b).expect("delete file_b from disk");
    let listed = store.list_recent().expect("list retains missing");
    assert_eq!(listed.len(), 2);

    let open_missing = store.resolve_recent_for_open(rec_b.id.as_str(), ts(30));
    assert!(matches!(
        open_missing,
        Err(ref e) if e.code() == RecentErrorCode::TargetMissing
    ));
    // Still retained in store so UI can report/retry!
    assert_eq!(store.list_recent().expect("still retained").len(), 2);

    // Removing rec_a only removes history and preserves keep.tex on disk.
    assert!(store.remove_recent(rec_a.id.as_str()).expect("remove a"));
    assert_eq!(
        fs::read(&file_a).expect("keep.tex still exists"),
        b"keep-bytes"
    );
    let remaining = store.list_recent().expect("remaining");
    assert_eq!(remaining.len(), 1);
    assert_eq!(remaining[0].id, rec_b.id);
}

#[test]
fn invalid_ids_oversize_and_malformed_schemas_are_rejected_and_preserve_old_bytes() {
    let temp = TempDirGuard::new("malformed-schema");
    let data_dir = temp.path().join("host-data");
    fs::create_dir_all(&data_dir).expect("create data_dir");
    let store = RecentStore::new(&data_dir);
    let store_path = store.store_path();

    // Invalid ID rejected by remove_recent and resolve_recent_for_open.
    for bad_id in ["not-a-uuid", "123E4567-E89B-42D3-A456-426614174000", ""] {
        assert_eq!(
            store.remove_recent(bad_id).unwrap_err().code(),
            RecentErrorCode::InvalidId
        );
        assert_eq!(
            store
                .resolve_recent_for_open(bad_id, ts(1))
                .unwrap_err()
                .code(),
            RecentErrorCode::InvalidId
        );
    }

    let valid_id = "123e4567-e89b-42d3-a456-426614174000";
    let abs_path = if cfg!(windows) {
        r"C:\Users\test\main.tex"
    } else {
        "/tmp/main.tex"
    };

    let malformed_cases: Vec<Value> = vec![
        // Wrong version
        json!({"version": 2, "entries": []}),
        // Unknown top-level field
        json!({"version": 1, "entries": [], "extra": true}),
        // Unknown entry field
        json!({
            "version": 1,
            "entries": [{
                "id": valid_id,
                "label": "main.tex",
                "entryPath": "main.tex",
                "openedAt": 1,
                "kind": "file",
                "canonicalPath": abs_path,
                "unknownField": 123
            }]
        }),
        // Unsafe openedAt > MAX_SAFE_INTEGER
        json!({
            "version": 1,
            "entries": [{
                "id": valid_id,
                "label": "main.tex",
                "entryPath": "main.tex",
                "openedAt": MAX_SAFE_INTEGER + 1,
                "kind": "file",
                "canonicalPath": abs_path
            }]
        }),
        // Invalid label containing path slash
        json!({
            "version": 1,
            "entries": [{
                "id": valid_id,
                "label": "bad/label.tex",
                "entryPath": "main.tex",
                "openedAt": 1,
                "kind": "file",
                "canonicalPath": abs_path
            }]
        }),
    ];

    let workspace_dir = temp.path().join("ws");
    let valid_tex = create_tex_file(&workspace_dir, "main.tex", b"content");

    for case in malformed_cases {
        let raw_bytes = serde_json::to_vec(&case).expect("encode malformed case");
        fs::write(&store_path, &raw_bytes).expect("write malformed file");
        assert_eq!(
            store.list_recent().unwrap_err().code(),
            RecentErrorCode::MalformedSchema
        );

        // Attempting to record or admit a workspace must NOT overwrite the malformed file silently!
        let selection = TrustedWorkspaceSelection {
            workspace: WorkspaceInfo {
                id: WorkspaceId::parse("ws-1").expect("ws id"),
                label: "main.tex".to_owned(),
                entry_path: Some(RelativePath::parse("main.tex").expect("rel")),
            },
            kind: WorkspaceKind::File,
            target_path: valid_tex.clone(),
            opened_at: ts(50),
        };
        let outcome = store.admit_opened_workspace(selection.clone());
        assert_eq!(outcome.opened, selection.workspace);
        assert!(matches!(
            outcome.history,
            HistoryPersistenceStatus::Failed {
                code: RecentErrorCode::MalformedSchema,
                ..
            }
        ));
        assert_eq!(
            fs::read(&store_path).expect("read preserved bytes"),
            raw_bytes
        );
    }

    // Oversize file rejected prior to allocation and preserved on failed write.
    let oversize_bytes = vec![b' '; (MAX_RECENT_STORE_BYTES as usize) + 1024];
    fs::write(&store_path, &oversize_bytes).expect("write oversize file");
    assert_eq!(
        store.list_recent().unwrap_err().code(),
        RecentErrorCode::OversizeStore
    );
    assert_eq!(
        fs::read(&store_path)
            .expect("oversize bytes preserved")
            .len(),
        oversize_bytes.len()
    );
}

#[test]
fn atomic_retry_and_failure_cleanup_own_temp_only_preserving_old_bytes() {
    let temp = TempDirGuard::new("atomic-retry");
    let data_dir = temp.path().join("host-data");
    let store = RecentStore::new(&data_dir);
    let ws_dir = temp.path().join("ws");
    let tex_1 = create_tex_file(&ws_dir, "one.tex", b"1");
    let tex_2 = create_tex_file(&ws_dir, "two.tex", b"2");

    // Initial save succeeds.
    store
        .record_opened(TrustedRecentTarget::for_file(&tex_1, ts(10)).expect("t1"))
        .expect("initial save");
    let original_bytes = fs::read(store.store_path()).expect("read initial store bytes");

    // Place a foreign temp file in data_dir; store cleanup must NOT delete it.
    let foreign_temp = data_dir.join(".frontend-recent-v1.json.tmp-foreign");
    fs::write(&foreign_temp, b"foreign-in-flight").expect("write foreign temp");

    // Transient sharing-denial errors succeeding on attempt 4.
    let attempts = AtomicUsize::new(0);
    let doc = store
        .record_opened_with_renamer(
            TrustedRecentTarget::for_file(&tex_2, ts(20)).expect("t2"),
            |from, to| {
                let cur = attempts.fetch_add(1, Ordering::SeqCst) + 1;
                if cur < 4 {
                    return Err(io::Error::from_raw_os_error(32)); // ERROR_SHARING_VIOLATION
                }
                fs::rename(from, to)
            },
        )
        .expect("succeeds after transient retries");
    assert_eq!(doc.label, "two.tex");
    assert_eq!(attempts.load(Ordering::SeqCst), 4);
    assert!(foreign_temp.exists());

    let after_retry_bytes = fs::read(store.store_path()).expect("read after retry");
    assert_ne!(after_retry_bytes, original_bytes);

    // Permanent sharing violation across all 10 attempts preserves old bytes and leaves no orphan temp.
    let fail_attempts = AtomicUsize::new(0);
    let err = store
        .record_opened_with_renamer(
            TrustedRecentTarget::for_file(&tex_1, ts(30)).expect("t1 again"),
            |_from, _to| {
                fail_attempts.fetch_add(1, Ordering::SeqCst);
                Err(io::Error::from_raw_os_error(32))
            },
        )
        .expect_err("must fail after bounded retries");
    assert_eq!(err.code(), RecentErrorCode::PersistenceFailed);
    assert_eq!(fail_attempts.load(Ordering::SeqCst), RENAME_MAX_ATTEMPTS);
    assert_eq!(
        fs::read(store.store_path()).expect("preserved bytes after failure"),
        after_retry_bytes
    );
    assert!(foreign_temp.exists());

    let entries_in_dir: Vec<String> = fs::read_dir(&data_dir)
        .expect("read data_dir")
        .map(|e| e.expect("entry").file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(entries_in_dir.len(), 2); // Only frontend-recent-v1.json and foreign_temp
}

#[cfg(windows)]
#[test]
fn windows_real_sharing_denial_retries_and_recovers() {
    use std::os::windows::fs::OpenOptionsExt;

    let temp = TempDirGuard::new("win-share-retry");
    let data_dir = temp.path().join("host-data");
    let store = RecentStore::new(&data_dir);
    let ws_dir = temp.path().join("ws");
    let tex_1 = create_tex_file(&ws_dir, "a.tex", b"a");
    let tex_2 = create_tex_file(&ws_dir, "b.tex", b"b");

    store
        .record_opened(TrustedRecentTarget::for_file(&tex_1, ts(1)).expect("a"))
        .expect("seed store");

    // Hold store_path with FILE_SHARE_READ only (no FILE_SHARE_DELETE) for 35ms.
    let locked_handle = OpenOptions::new()
        .read(true)
        .share_mode(1)
        .open(store.store_path())
        .expect("open without delete share");
    let releaser = thread::spawn(move || {
        thread::sleep(Duration::from_millis(35));
        drop(locked_handle);
    });

    let res = store.record_opened(TrustedRecentTarget::for_file(&tex_2, ts(2)).expect("b"));
    releaser.join().expect("join releaser");
    assert!(res.is_ok(), "expected retry recovery, got: {res:?}");
    assert_eq!(store.list_recent().expect("list").len(), 2);
}

#[test]
fn concurrent_independent_store_instances_do_not_lose_updates() {
    let temp = TempDirGuard::new("concurrent");
    let data_dir = temp.path().join("shared-host-data");
    let ws_root = temp.path().join("workspaces");

    let thread_count = 8usize;
    let mut paths = Vec::new();
    for i in 0..thread_count {
        let dir = ws_root.join(format!("concurrent-{i}"));
        let file = create_tex_file(&dir, &format!("doc-{i}.tex"), b"x");
        paths.push(file);
    }

    let mut handles = Vec::new();
    for (i, file_path) in paths.into_iter().enumerate() {
        let dir_clone = data_dir.clone();
        handles.push(thread::spawn(move || {
            // Separate RecentStore instance per thread/window.
            let independent_store = RecentStore::new(dir_clone);
            let target =
                TrustedRecentTarget::for_file(file_path, ts(500 + i as u64)).expect("target");
            independent_store
                .record_opened(target)
                .expect("concurrent record_opened");
        }));
    }

    for h in handles {
        h.join().expect("join worker");
    }

    let verifier = RecentStore::new(&data_dir);
    let listed = verifier
        .list_recent()
        .expect("list after concurrent writes");
    assert_eq!(listed.len(), thread_count);
}

#[test]
fn first_recent_write_keeps_one_lock_across_parent_creation() {
    let temp = TempDirGuard::new("first-write-lock");
    let data_dir = temp.path().join("not-created-yet");
    let store_path = data_dir.join(RECENT_STORE_FILENAME);
    let lock_before = acquire_store_lock(&store_path);
    let one = create_tex_file(&temp.path().join("work"), "one.tex", b"1");
    let two = create_tex_file(&temp.path().join("work"), "two.tex", b"2");
    let first_store = RecentStore::new(&data_dir);
    let first_target = TrustedRecentTarget::for_file(&one, ts(1)).expect("first target");
    let (entered_tx, entered_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let first = thread::spawn(move || {
        first_store.record_opened_with_renamer(first_target, |from, to| {
            entered_tx.send(()).expect("signal first writer");
            release_rx.recv().expect("release first writer");
            fs::rename(from, to)
        })
    });

    entered_rx
        .recv_timeout(Duration::from_secs(2))
        .expect("first writer reached atomic replacement");
    let lock_after = acquire_store_lock(&store_path);
    assert!(Arc::ptr_eq(&lock_before, &lock_after));
    assert!(
        lock_after.try_lock().is_err(),
        "first writer still owns lock"
    );

    let second_store = RecentStore::new(&data_dir);
    let second = thread::spawn(move || {
        second_store.record_opened(TrustedRecentTarget::for_file(two, ts(2)).expect("second"))
    });
    release_tx.send(()).expect("release first writer");
    first
        .join()
        .expect("join first writer")
        .expect("first save");
    second
        .join()
        .expect("join second writer")
        .expect("second save");
    assert_eq!(
        RecentStore::new(&data_dir)
            .list_recent()
            .expect("list")
            .len(),
        2
    );
}

#[test]
fn target_replacement_between_check_and_open_is_rejected() {
    let temp = TempDirGuard::new("target-swap");
    let target = temp.path().join("workspace");
    let outside = temp.path().join("outside");
    create_tex_file(&target, "main.tex", b"inside");
    create_tex_file(&outside, "main.tex", b"outside");
    let entry = Some(RelativePath::parse("main.tex").expect("entry"));

    let result = TrustedFilesystemOpener::open_target_with_hook(
        &target,
        WorkspaceKind::Folder,
        &entry,
        || {
            fs::remove_dir_all(&target).expect("remove checked workspace");
            #[cfg(unix)]
            std::os::unix::fs::symlink(&outside, &target).expect("swap in symlink");
            #[cfg(windows)]
            create_windows_junction(&target, &outside);
        },
    );
    assert_eq!(result.unwrap_err().code(), RecentErrorCode::LinkNotAllowed);
    assert_eq!(
        fs::read(outside.join("main.tex")).expect("outside remains"),
        b"outside"
    );
    #[cfg(windows)]
    fs::remove_dir(&target).expect("remove junction fixture");
}

#[test]
fn store_file_replacement_between_check_and_open_is_rejected_without_following() {
    let temp = TempDirGuard::new("store-swap");
    let data_dir = temp.path().join("host-data");
    fs::create_dir_all(&data_dir).expect("create data directory");
    let store_path = data_dir.join(RECENT_STORE_FILENAME);
    fs::write(&store_path, b"checked-store").expect("write checked store");
    let outside_dir = temp.path().join("outside");
    fs::create_dir_all(&outside_dir).expect("create outside directory");
    let outside_file = outside_dir.join("secret.json");
    fs::write(&outside_file, b"outside-store").expect("write outside target");

    let result = bounded_read_store_bytes_with_opener(
        &store_path,
        &data_dir,
        MAX_RECENT_STORE_BYTES,
        |path| {
            fs::remove_file(path).expect("remove checked store file");
            #[cfg(unix)]
            std::os::unix::fs::symlink(&outside_file, path).expect("swap in file symlink");
            #[cfg(windows)]
            create_windows_junction(path, &outside_dir);
            open_file_no_follow(path)
        },
    );
    assert_eq!(result.unwrap_err().code(), RecentErrorCode::LinkNotAllowed);
    assert_eq!(
        fs::read(&outside_file).expect("outside target remains"),
        b"outside-store"
    );
    #[cfg(windows)]
    fs::remove_dir(&store_path).expect("remove junction fixture");
}

#[test]
fn rejects_symlink_or_reparse_store_targets() {
    let temp = TempDirGuard::new("symlink-reject");
    let real_dir = temp.path().join("real");
    fs::create_dir_all(&real_dir).expect("create real dir");
    let real_file = real_dir.join("target.json");
    fs::write(&real_file, b"{}").expect("write target file");

    let data_dir = temp.path().join("host-data");
    fs::create_dir_all(&data_dir).expect("create data_dir");
    #[cfg(unix)]
    let store_file_link = data_dir.join(RECENT_STORE_FILENAME);

    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(&real_file, &store_file_link).expect("create unix symlink");
        let store = RecentStore::new(&data_dir);
        assert_eq!(
            store.list_recent().unwrap_err().code(),
            RecentErrorCode::LinkNotAllowed
        );
    }

    #[cfg(windows)]
    {
        // Create a directory junction for the store directory using NTFS reparse point.
        let junction_dir = temp.path().join("junction-data-dir");
        create_windows_junction(&junction_dir, &real_dir);
        let store = RecentStore::new(&junction_dir);
        assert_eq!(
            store.list_recent().unwrap_err().code(),
            RecentErrorCode::LinkNotAllowed
        );
        fs::remove_dir(&junction_dir).expect("remove junction fixture");
    }
}
