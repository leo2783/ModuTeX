// SPDX-License-Identifier: Apache-2.0
//! Unit & core verification tests for G2 DesktopPort host commands (`src/tests/frontend_files.rs`).

use std::{
    fs,
    path::PathBuf,
    sync::{Arc, Mutex},
};

use crate::{
    state::binary_tokens::{BinaryTokenStore, TokenDenied, TokenLimits},
    services::filesystem::{FilesystemError, FilesystemService},
    platform::dialogs::DialogSeam,
    state::desktop::FrontendFilesState,
    schemas::protocol::{
        DocumentId, DocumentVersion, FileRef, OwnerId, Revision, SaveAsRequest,
        Timestamp, WriteRequest, MAX_PDF_BYTES, MAX_READ_BYTES,
    },
    shared::relative_path::RelativePath,
    services::watch_native::NativeWatchRegistry,
};

struct MockDialog {
    pick_result: Mutex<Option<PathBuf>>,
    save_result: Mutex<Option<PathBuf>>,
}

impl MockDialog {
    fn new(pick: Option<PathBuf>, save: Option<PathBuf>) -> Self {
        Self {
            pick_result: Mutex::new(pick),
            save_result: Mutex::new(save),
        }
    }
}

impl DialogSeam for MockDialog {
    fn pick_folder(&self, _window: &tauri::WebviewWindow) -> Option<PathBuf> {
        self.pick_result.lock().unwrap().clone()
    }
    fn pick_file(&self, _window: &tauri::WebviewWindow) -> Option<PathBuf> {
        self.pick_result.lock().unwrap().clone()
    }
    fn save_file(&self, _window: &tauri::WebviewWindow) -> Option<PathBuf> {
        self.save_result.lock().unwrap().clone()
    }
}

fn create_test_state(mock_dialog: Arc<MockDialog>) -> (FrontendFilesState, PathBuf) {
    let tmp = std::env::temp_dir().join(format!("modutex-g2-test-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&tmp).unwrap();

    let service = FilesystemService::with_default_stores().unwrap();
    let tokens = Arc::new(BinaryTokenStore::new(TokenLimits::default()).unwrap());
    let native_watch = Arc::new(NativeWatchRegistry::new());
    let state = FrontendFilesState::new(service, tokens, native_watch, mock_dialog);
    state.register_document_window_label("main").unwrap();
    state.register_document_window_label("other").unwrap();
    (state, tmp)
}

#[test]
fn unregistered_window_is_denied_and_revoked_window_cannot_register_again() {
    let (state, tmp) = create_test_state(Arc::new(MockDialog::new(None, None)));
    let unknown = OwnerId::from_label("unregistered").unwrap();
    assert!(state.ensure_owner_admission(&unknown).is_err());
    state.register_document_window_label("unregistered").unwrap();
    assert!(state.ensure_owner_admission(&unknown).is_ok());
    state.revoke_owner(&unknown);
    assert!(state.register_document_window_label("unregistered").is_err());
    assert!(state.ensure_owner_admission(&unknown).is_err());
    let _ = fs::remove_dir_all(tmp);
}

#[test]
fn native_picker_cancellation_returns_null_without_modifications() {
    let dialog = Arc::new(MockDialog::new(None, None));
    let (state, tmp) = create_test_state(dialog);
    let owner = OwnerId::from_label("main").unwrap();

    let now_ms = 1_000_000u64;
    let opened_at = Timestamp::new(now_ms).unwrap();

    // Cancellation in save_as
    let req = SaveAsRequest {
        images: None,
        workspace_id: None,
        bytes: b"\\documentclass{article}".to_vec(),
        document_id: DocumentId::parse("doc-1").unwrap(),
        document_version: DocumentVersion::new(1).unwrap(),
    };
    let res = state.service.save_as(&owner, &req, None, opened_at).unwrap();
    assert!(res.is_none());

    let _ = fs::remove_dir_all(&tmp);
}

#[test]
fn file_size_limits_5mib_source_blocked_and_pdf_32mib_accepted() {
    let dialog = Arc::new(MockDialog::new(None, None));
    let (state, tmp) = create_test_state(dialog);
    let owner = OwnerId::from_label("main").unwrap();
    let opened_at = Timestamp::new(1_000_000).unwrap();

    let root_file = tmp.join("main.tex");
    fs::write(&root_file, b"% entry").unwrap();

    let outcome = state
        .service
        .open_workspace_file(&owner, &root_file, opened_at)
        .unwrap();
    let ws_id = outcome.opened.id;

    // 1. Source write > 5 MiB is rejected
    let big_source = vec![b'a'; MAX_READ_BYTES + 1];
    let write_req = WriteRequest {
        workspace_id: ws_id.clone(),
        path: RelativePath::parse("section.tex").unwrap(),
        bytes: big_source,
        expected_revision: None,
        document_id: DocumentId::parse("doc-section").unwrap(),
        document_version: DocumentVersion::new(1).unwrap(),
    };
    let write_res = state.service.write_file(&owner, &write_req);
    assert!(matches!(write_res, Err(FilesystemError::FileTooLarge { .. })));

    // 2. PDF write of 5 MiB + 1 is accepted (up to 32 MiB)
    let mut big_pdf = vec![0u8; MAX_READ_BYTES + 1024];
    big_pdf[..5].copy_from_slice(b"%PDF-");
    let pdf_req = WriteRequest {
        workspace_id: ws_id.clone(),
        path: RelativePath::parse("output.pdf").unwrap(),
        bytes: big_pdf.clone(),
        expected_revision: None,
        document_id: DocumentId::parse("doc-pdf").unwrap(),
        document_version: DocumentVersion::new(1).unwrap(),
    };
    let pdf_res = state.service.write_file(&owner, &pdf_req);
    assert!(pdf_res.is_ok());

    // 3. PDF write > 32 MiB is rejected
    let mut huge_pdf = vec![0u8; MAX_PDF_BYTES + 1];
    huge_pdf[..5].copy_from_slice(b"%PDF-");
    let huge_pdf_req = WriteRequest {
        workspace_id: ws_id.clone(),
        path: RelativePath::parse("oversized.pdf").unwrap(),
        bytes: huge_pdf,
        expected_revision: None,
        document_id: DocumentId::parse("doc-huge").unwrap(),
        document_version: DocumentVersion::new(1).unwrap(),
    };
    let huge_res = state.service.write_file(&owner, &huge_pdf_req);
    assert!(matches!(huge_res, Err(FilesystemError::FileTooLarge { .. })));

    let _ = fs::remove_dir_all(&tmp);
}

#[test]
fn raw_pdf_token_one_shot_and_cross_owner_denial() {
    let dialog = Arc::new(MockDialog::new(None, None));
    let (state, tmp) = create_test_state(dialog);
    let owner_a = OwnerId::from_label("main").unwrap();
    let owner_b = OwnerId::from_label("other").unwrap();
    let opened_at = Timestamp::new(1_000_000).unwrap();

    let root_file = tmp.join("doc.tex");
    fs::write(&root_file, b"\\documentclass{article}").unwrap();
    let pdf_file = tmp.join("doc.pdf");
    let pdf_content = b"%PDF-1.7 mock output stream";
    fs::write(&pdf_file, pdf_content).unwrap();

    let outcome = state
        .service
        .open_workspace_file(&owner_a, &root_file, opened_at)
        .unwrap();
    let ws_id = outcome.opened.id;

    // Match the real successful-open path: explicitly admit before reading tokens.
    let ws_adm = state.admit_workspace(&owner_a, ws_id.clone()).unwrap();
    let token = state
        .tokens()
        .issue_file_read_pdf(
            &ws_adm,
            RelativePath::parse("doc.pdf").unwrap(),
            Revision::parse("rev-1").unwrap(),
            pdf_content.to_vec(),
        )
        .unwrap();
    let wire = token.to_wire();

    // Cross-owner take is denied
    let owner_b_adm = state.ensure_owner_admission(&owner_b).unwrap();
    assert_eq!(
        state.tokens().take_file_pdf(&owner_b_adm, &wire),
        Err(TokenDenied)
    );

    // Legitimate owner takes token once
    let owner_a_adm = state.ensure_owner_admission(&owner_a).unwrap();
    let taken = state.tokens().take_file_pdf(&owner_a_adm, &wire).unwrap();
    assert_eq!(taken, pdf_content);

    // Second take fails (one-shot)
    assert_eq!(
        state.tokens().take_file_pdf(&owner_a_adm, &wire),
        Err(TokenDenied)
    );

    let _ = fs::remove_dir_all(&tmp);
}

#[test]
fn path_traversal_is_blocked() {
    assert!(RelativePath::parse("../evil.tex").is_err());
    assert!(RelativePath::parse("foo/../../bar.tex").is_err());
    assert!(RelativePath::parse("/absolute.tex").is_err());
    assert!(RelativePath::parse("c:\\windows\\system32").is_err());
}

#[test]
fn large_pdf_read_service_path_and_header_validation() {
    let dialog = Arc::new(MockDialog::new(None, None));
    let (state, tmp) = create_test_state(dialog);
    let owner = OwnerId::from_label("main").unwrap();
    let opened_at = Timestamp::new(1_000_000).unwrap();

    let root_file = tmp.join("doc.tex");
    fs::write(&root_file, b"\\documentclass{article}").unwrap();

    let outcome = state
        .service
        .open_workspace_file(&owner, &root_file, opened_at)
        .unwrap();
    let ws_id = outcome.opened.id;
    let _ = state.admit_workspace(&owner, ws_id.clone()).unwrap();

    // 1. Valid 6 MiB PDF file write (> 5 MiB source limit)
    let mut big_pdf = vec![0u8; MAX_READ_BYTES + 1024 * 1024];
    big_pdf[..5].copy_from_slice(b"%PDF-");
    let pdf_rel = RelativePath::parse("document.pdf").unwrap();
    let write_req = WriteRequest {
        workspace_id: ws_id.clone(),
        path: pdf_rel.clone(),
        bytes: big_pdf.clone(),
        expected_revision: None,
        document_id: DocumentId::parse("doc-pdf-large").unwrap(),
        document_version: DocumentVersion::new(1).unwrap(),
    };
    state.service.write_file(&owner, &write_req).unwrap();

    let file_ref = FileRef {
        workspace_id: ws_id.clone(),
        path: pdf_rel.clone(),
    };

    // 2. Normal read_file caps at 5 MiB and rejects the 6 MiB file
    let normal_res = state.service.read_file(&owner, &file_ref);
    assert!(matches!(normal_res, Err(FilesystemError::FileTooLarge { .. })));

    // 3. Explicit read_file_pdf accepts the 6 MiB PDF
    let pdf_receipt = state.service.read_file_pdf(&owner, &file_ref).unwrap();
    assert_eq!(pdf_receipt.bytes.len(), big_pdf.len());
    assert_eq!(pdf_receipt.bytes[..5], *b"%PDF-");

    // 4. Invalid header is rejected before allocation
    let fake_pdf_rel = RelativePath::parse("fake.pdf").unwrap();
    let fake_req = WriteRequest {
        workspace_id: ws_id.clone(),
        path: fake_pdf_rel.clone(),
        bytes: b"%PDF-valid-for-write-only".to_vec(),
        expected_revision: None,
        document_id: DocumentId::parse("doc-fake").unwrap(),
        document_version: DocumentVersion::new(1).unwrap(),
    };
    state.service.write_file(&owner, &fake_req).unwrap();
    // Overwrite with invalid header
    fs::write(tmp.join("fake.pdf"), b"NOT_A_VALID_PDF_HEADER").unwrap();
    let fake_ref = FileRef {
        workspace_id: ws_id.clone(),
        path: fake_pdf_rel,
    };
    let invalid_header_res = state.service.read_file_pdf(&owner, &fake_ref);
    assert!(invalid_header_res.is_err());

    let _ = fs::remove_dir_all(&tmp);
}

#[test]
fn window_revocation_durable_fence_prevents_readmission() {
    let dialog = Arc::new(MockDialog::new(None, None));
    let (state, tmp) = create_test_state(dialog);
    let owner = OwnerId::from_label("main").unwrap();
    let opened_at = Timestamp::new(1_000_000).unwrap();

    let root_file = tmp.join("doc.tex");
    fs::write(&root_file, b"\\documentclass{article}").unwrap();

    let outcome = state
        .service
        .open_workspace_file(&owner, &root_file, opened_at)
        .unwrap();
    let ws_id = outcome.opened.id;
    let _ = state.admit_workspace(&owner, ws_id.clone()).unwrap();

    // Durable owner revocation
    state.revoke_owner(&owner);
    assert!(state.is_owner_revoked(&owner));

    // Subsequent attempts to ensure owner or admit workspace MUST fail
    assert!(state.ensure_owner_admission(&owner).is_err());
    assert!(state.admit_workspace(&owner, ws_id.clone()).is_err());
    assert!(state.get_workspace_admission(&owner, &ws_id).is_err());

    // Verification that workspace session is closed in service
    assert_eq!(
        state.service.workspace_generation(&owner, &ws_id),
        Err(FilesystemError::SessionClosed)
    );

    let _ = fs::remove_dir_all(&tmp);
}
