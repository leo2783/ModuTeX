// SPDX-License-Identifier: Apache-2.0
use super::*;
use std::fs;

#[test]
fn file_and_directory_identity_and_nofollow_round_trip() {
    let dir = std::env::temp_dir().join(format!("modutex-fi-test-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&dir).expect("create temp dir");
    let test_file = dir.join("test.txt");
    fs::write(&test_file, b"identity test").expect("write test file");

    let meta = fs::symlink_metadata(&test_file).expect("symlink_metadata file");
    assert!(!is_symlink_or_reparse(&meta));

    let f = open_file_no_follow(&test_file).expect("open_file_no_follow");
    let id_file = file_identity(&f).expect("file_identity file");

    let d = open_directory_no_follow(&dir).expect("open_directory_no_follow");
    let id_dir = file_identity(&d).expect("file_identity dir");

    assert_ne!(id_file, id_dir);

    drop((f, d));
    let _ = fs::remove_dir_all(&dir);
}
