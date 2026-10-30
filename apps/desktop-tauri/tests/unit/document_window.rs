// SPDX-License-Identifier: Apache-2.0
use crate::{
    register_then_build_document_window, schemas::protocol::OwnerId,
    state::desktop::FrontendFilesState,
};
use std::{fs, path::PathBuf};

const TEST_LABEL: &str = "document-123e4567-e89b-42d3-a456-426614174000";

struct TestDataDir(PathBuf);

impl TestDataDir {
    fn new() -> Self {
        let path =
            std::env::temp_dir().join(format!("modutex-document-window-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&path).expect("create isolated frontend data directory");
        Self(path)
    }
}

impl Drop for TestDataDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn frontend_files() -> (TestDataDir, FrontendFilesState) {
    let data_dir = TestDataDir::new();
    let files = FrontendFilesState::with_data_dir(data_dir.0.clone())
        .expect("create isolated frontend files state");
    (data_dir, files)
}

#[test]
fn failed_webview_build_revokes_the_pre_registered_owner() {
    let (_data_dir, files) = frontend_files();
    let owner = OwnerId::from_label(TEST_LABEL).unwrap();

    let result = register_then_build_document_window::<()>(&files, TEST_LABEL, |_| {
        Err("simulated webview creation failure".to_owned())
    });

    assert_eq!(
        result.err().as_deref(),
        Some("simulated webview creation failure")
    );
    assert!(files.require_document_owner(&owner).is_err());
    assert!(files.is_owner_revoked(&owner));
    assert!(files.register_document_window_label(TEST_LABEL).is_err());
}

#[test]
fn duplicate_window_admission_is_rejected_before_building() {
    let (_data_dir, files) = frontend_files();
    let (owner, ()) =
        register_then_build_document_window::<()>(&files, TEST_LABEL, |_| Ok(())).unwrap();
    let mut build_called = false;

    let result = register_then_build_document_window::<()>(&files, TEST_LABEL, |_| {
        build_called = true;
        Ok(())
    });

    assert!(result.is_err());
    assert!(!build_called);
    assert!(files.require_document_owner(&owner).is_ok());
}
