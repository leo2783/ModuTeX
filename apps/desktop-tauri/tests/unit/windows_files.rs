// SPDX-License-Identifier: Apache-2.0
use super::*;

fn build_record(name_u16: &[u16], attrs: u32, next_override: Option<u32>) -> Vec<u64> {
    let name_offset = offset_of!(FILE_ID_BOTH_DIR_INFO, FileName);
    let byte_len = (name_offset + name_u16.len() * 2).next_multiple_of(8);
    let mut buf = vec![0u64; byte_len / 8];
    unsafe {
        let hdr = buf.as_mut_ptr().cast::<FILE_ID_BOTH_DIR_INFO>();
        (*hdr).NextEntryOffset = next_override.unwrap_or(0);
        (*hdr).FileAttributes = attrs;
        (*hdr).FileNameLength = (name_u16.len() * 2) as u32;
        std::ptr::copy_nonoverlapping(
            name_u16.as_ptr().cast::<u8>(),
            buf.as_mut_ptr().cast::<u8>().add(name_offset),
            name_u16.len() * 2,
        );
    }
    buf
}

#[test]
fn dir_parser_rejects_malformed_reparse_and_invalid_utf16() {
    let valid = build_record(&"main.tex".encode_utf16().collect::<Vec<_>>(), 0, None);
    let bytes = unsafe { std::slice::from_raw_parts(valid.as_ptr().cast::<u8>(), valid.len() * 8) };
    assert_eq!(parse_dir_buffer(bytes).unwrap().len(), 1);

    let reparse = build_record(&[b'a' as u16], FILE_ATTRIBUTE_REPARSE_POINT, None);
    let bytes =
        unsafe { std::slice::from_raw_parts(reparse.as_ptr().cast::<u8>(), reparse.len() * 8) };
    assert_eq!(parse_dir_buffer(bytes), Err(FsError::LinkNotAllowed));

    let bad_utf16 = build_record(&[0xD800], 0, None);
    let bytes =
        unsafe { std::slice::from_raw_parts(bad_utf16.as_ptr().cast::<u8>(), bad_utf16.len() * 8) };
    assert_eq!(parse_dir_buffer(bytes), Err(FsError::InvalidPath));

    let bad_next = build_record(&[b'a' as u16], 0, Some(3));
    let bytes =
        unsafe { std::slice::from_raw_parts(bad_next.as_ptr().cast::<u8>(), bad_next.len() * 8) };
    assert_eq!(
        parse_dir_buffer(bytes),
        Err(FsError::CorruptDirectoryRecord)
    );
}

#[test]
fn root_read_write_revision_and_recovery_round_trip() {
    let dir = std::env::temp_dir().join(format!("modutex-g2-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let root = TrustedRoot::open(&dir).unwrap();
    assert_eq!(root.verify_alive().unwrap(), root.identity());
    let rel = RelativePath::parse("chapters/intro.tex").unwrap();
    let w1 = root.write_file(&rel, b"hello", None).unwrap();
    assert!(matches!(
        root.write_file(&rel, b"conflict", None),
        Err(FsError::RevisionConflict { .. })
    ));
    let r1 = root.read_file(&rel).unwrap();
    assert_eq!(r1.bytes, b"hello");
    assert_eq!(r1.revision, w1.revision);
    let w2 = root
        .write_file(&rel, b"updated", Some(&w1.revision))
        .unwrap();
    assert_ne!(w1.revision, w2.revision);
    assert_eq!(root.read_file(&rel).unwrap().bytes, b"updated");
    assert_eq!(root.list_files().unwrap().len(), 2);
    let root_rel = RelativePath::parse("main.tex").unwrap();
    let rw = root.write_file(&root_rel, b"root-level", None).unwrap();
    assert_eq!(root.read_file(&root_rel).unwrap().revision, rw.revision);
    assert_eq!(root.list_files().unwrap().len(), 3);
    drop(root);
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn same_bytes_replacement_triggers_revision_conflict() {
    let dir = std::env::temp_dir().join(format!("modutex-g2-samebytes-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let root = TrustedRoot::open(&dir).unwrap();
    let rel = RelativePath::parse("chapters/intro.tex").unwrap();
    let w1 = root.write_file(&rel, b"identical", None).unwrap();
    let r1 = root.read_file(&rel).unwrap();
    assert_eq!(r1.identity, w1.identity);
    assert_eq!(r1.revision, w1.revision);

    let target_path = dir.join("chapters").join("intro.tex");
    let displaced_path = dir.join("chapters").join("displaced.tex");
    std::fs::rename(&target_path, &displaced_path).unwrap();
    std::fs::write(&target_path, b"identical").unwrap();
    std::fs::remove_file(&displaced_path).unwrap();

    let r2 = root.read_file(&rel).unwrap();
    assert_eq!(r2.bytes, b"identical");
    assert_ne!(r2.identity, w1.identity);
    assert_ne!(r2.revision, w1.revision);

    let conflict = root.write_file(&rel, b"after-replace", Some(&w1.revision));
    assert_eq!(
        conflict,
        Err(FsError::RevisionConflict {
            expected: Some(w1.revision),
            actual: Some(r2.revision.clone()),
        })
    );
    let w2 = root
        .write_file(&rel, b"after-replace", Some(&r2.revision))
        .unwrap();
    assert_eq!(root.read_file(&rel).unwrap().revision, w2.revision);
    drop(root);
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn unowned_backup_retained_and_never_deleted() {
    let dir = std::env::temp_dir().join(format!("modutex-g2-unowned-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let root = TrustedRoot::open(&dir).unwrap();
    let rel = RelativePath::parse("chapters/intro.tex").unwrap();
    let w1 = root.write_file(&rel, b"user-doc", None).unwrap();

    let unowned_bak = dir.join("chapters").join(".modutex-bak-intro.tex");
    std::fs::write(&unowned_bak, b"unowned-precious-backup").unwrap();

    assert_eq!(root.read_file(&rel), Err(FsError::RecoveryRequired));
    assert_eq!(
        root.write_file(&rel, b"overwrite", Some(&w1.revision)),
        Err(FsError::RecoveryRequired)
    );
    assert_eq!(root.list_files(), Err(FsError::RecoveryRequired));
    assert_eq!(root.recover_write(&rel), Err(FsError::RecoveryRequired));
    assert_eq!(
        std::fs::read(&unowned_bak).unwrap(),
        b"unowned-precious-backup"
    );
    assert_eq!(
        std::fs::read(dir.join("chapters").join("intro.tex")).unwrap(),
        b"user-doc"
    );

    let rel_missing = RelativePath::parse("chapters/other.tex").unwrap();
    let unowned_other_bak = dir.join("chapters").join(".modutex-bak-other.tex");
    std::fs::write(&unowned_other_bak, b"unowned-other").unwrap();
    assert_eq!(
        root.recover_write(&rel_missing),
        Err(FsError::RecoveryRequired)
    );
    assert_eq!(std::fs::read(&unowned_other_bak).unwrap(), b"unowned-other");
    assert!(!dir.join("chapters").join("other.tex").exists());

    std::fs::remove_file(&unowned_bak).unwrap();
    std::fs::remove_file(&unowned_other_bak).unwrap();
    assert_eq!(root.recover_write(&rel).unwrap(), RecoveryOutcome::Clean);
    assert_eq!(root.read_file(&rel).unwrap().bytes, b"user-doc");
    drop(root);
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn interruption_between_rename_with_failed_rollback() {
    let dir = std::env::temp_dir().join(format!("modutex-g2-barrier-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let root = TrustedRoot::open(&dir).unwrap();
    let rel = RelativePath::parse("chapters/intro.tex").unwrap();
    let w1 = root.write_file(&rel, b"original-v1", None).unwrap();

    let mut barrier = |parent: &PinnedParent| {
        let interloper = nt_open_segment(
            parent.handle.raw(),
            &parent.leaf_name,
            FILE_WRITE_DATA | FILE_WRITE_ATTRIBUTES | FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            FILE_CREATE,
            FILE_NON_DIRECTORY_FILE,
        )
        .unwrap();
        write_and_flush(interloper.raw(), b"interloper-bytes").unwrap();
    };
    let res = root.write_file_internal(
        &rel,
        b"candidate-v2",
        Some(&w1.revision),
        Some(&mut barrier),
    );
    assert_eq!(res, Err(FsError::RecoveryRequired));

    assert_eq!(root.read_file(&rel), Err(FsError::RecoveryRequired));
    assert_eq!(
        root.write_file(&rel, b"candidate-v3", Some(&w1.revision)),
        Err(FsError::RecoveryRequired)
    );
    assert_eq!(root.list_files(), Err(FsError::RecoveryRequired));
    assert_eq!(root.recover_write(&rel), Err(FsError::RecoveryRequired));

    std::fs::remove_file(dir.join("chapters").join("intro.tex")).unwrap();
    assert_eq!(
        root.recover_write(&rel).unwrap(),
        RecoveryOutcome::RolledBackToBackup
    );
    assert_eq!(root.recover_write(&rel).unwrap(), RecoveryOutcome::Clean);
    let restored = root.read_file(&rel).unwrap();
    assert_eq!(restored.bytes, b"original-v1");
    assert_eq!(restored.identity, w1.identity);
    assert_eq!(restored.revision, w1.revision);
    drop(root);
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn rename_relative_handle_pinned_commits_and_maps_collision() {
    let dir = std::env::temp_dir().join(format!("modutex-g2-ntrename-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let root = TrustedRoot::open(&dir).unwrap();
    let rel = RelativePath::parse("nested/target.tex").unwrap();
    let parent = root.pin_parent(&rel, true).unwrap();
    let stage = nt_open_segment(
        parent.handle.raw(),
        ".modutex-stage-test",
        FILE_WRITE_DATA | FILE_WRITE_ATTRIBUTES | FILE_READ_ATTRIBUTES | DELETE,
        0,
        FILE_CREATE,
        FILE_NON_DIRECTORY_FILE,
    )
    .unwrap();
    write_and_flush(stage.raw(), b"control").unwrap();
    rename_relative(stage.raw(), parent.handle.raw(), &parent.leaf_name, false).unwrap();
    drop(stage);
    assert_eq!(root.read_file(&rel).unwrap().bytes, b"control");

    let other = nt_open_segment(
        parent.handle.raw(),
        ".modutex-stage-collision",
        FILE_WRITE_DATA | FILE_READ_ATTRIBUTES | DELETE,
        0,
        FILE_CREATE,
        FILE_NON_DIRECTORY_FILE,
    )
    .unwrap();
    assert!(matches!(
        rename_relative(other.raw(), parent.handle.raw(), &parent.leaf_name, false),
        Err(FsError::RevisionConflict { .. })
    ));
    mark_delete_on_close(other.raw()).unwrap();
    drop((other, parent, root));
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn delete_file_if_revision_deletes_matching_and_refuses_modified_or_replaced_identity() {
    let dir = std::env::temp_dir().join(format!("modutex-g2-delrev-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let root = TrustedRoot::open(&dir).unwrap();

    let rel_ok = RelativePath::parse("chapters/rollback_ok.tex").unwrap();
    let w_ok = root
        .write_file(&rel_ok, b"created-by-save-as", None)
        .unwrap();
    root.delete_file_if_revision(&rel_ok, &w_ok.revision)
        .unwrap();
    assert_eq!(root.read_file(&rel_ok), Err(FsError::NotFound));
    assert_eq!(
        root.delete_file_if_revision(&rel_ok, &w_ok.revision),
        Err(FsError::NotFound)
    );

    let rel_mod = RelativePath::parse("chapters/modified.tex").unwrap();
    let w_mod = root.write_file(&rel_mod, b"original-bytes", None).unwrap();
    let mod_path = dir.join("chapters").join("modified.tex");
    std::fs::write(&mod_path, b"externally-edited-bytes").unwrap();
    let r_mod = root.read_file(&rel_mod).unwrap();
    assert_eq!(
        root.delete_file_if_revision(&rel_mod, &w_mod.revision),
        Err(FsError::RevisionConflict {
            expected: Some(w_mod.revision),
            actual: Some(r_mod.revision),
        })
    );
    assert_eq!(
        root.read_file(&rel_mod).unwrap().bytes,
        b"externally-edited-bytes"
    );

    let rel_id = RelativePath::parse("chapters/same_bytes.tex").unwrap();
    let w_id = root
        .write_file(&rel_id, b"identical-payload", None)
        .unwrap();
    let id_path = dir.join("chapters").join("same_bytes.tex");
    let displaced = dir.join("chapters").join("displaced_same_bytes.tex");
    std::fs::rename(&id_path, &displaced).unwrap();
    std::fs::write(&id_path, b"identical-payload").unwrap();
    std::fs::remove_file(&displaced).unwrap();
    let r_id = root.read_file(&rel_id).unwrap();
    assert_eq!(r_id.bytes, b"identical-payload");
    assert_ne!(r_id.identity, w_id.identity);
    assert_ne!(r_id.revision, w_id.revision);
    assert_eq!(
        root.delete_file_if_revision(&rel_id, &w_id.revision),
        Err(FsError::RevisionConflict {
            expected: Some(w_id.revision),
            actual: Some(r_id.revision.clone()),
        })
    );
    assert_eq!(root.read_file(&rel_id).unwrap().bytes, b"identical-payload");
    root.delete_file_if_revision(&rel_id, &r_id.revision)
        .unwrap();
    assert_eq!(root.read_file(&rel_id), Err(FsError::NotFound));

    drop(root);
    std::fs::remove_dir_all(&dir).unwrap();
}
