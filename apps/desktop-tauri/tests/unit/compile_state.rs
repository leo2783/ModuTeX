// SPDX-License-Identifier: Apache-2.0
use super::{take_compile_pdf_ticket, MAX_COMPILE_PDF_BINDINGS, MAX_RETAINED_SYNCTEX_BYTES};

use crate::{
    schemas::protocol::{CompileIdentity, OwnerId, Revision, WorkspaceId},
    shared::relative_path::RelativePath,
    state::{
        binary_tokens::{BinaryTokenStore, TokenLimits},
        desktop::publish_compile_pdf_ticket,
    },
};

fn admitted_token_store() -> (
    BinaryTokenStore,
    OwnerId,
    crate::state::binary_tokens::OwnerAdmission,
    crate::state::binary_tokens::WorkspaceAdmission,
) {
    let store = BinaryTokenStore::new(TokenLimits::default()).unwrap();
    let owner = OwnerId::from_label("main").unwrap();
    let owner_admission = store.admit_owner_generation(owner.clone()).unwrap();
    let workspace = store
        .admit_workspace_generation(&owner_admission, WorkspaceId::parse("workspace-1").unwrap())
        .unwrap();
    (store, owner, owner_admission, workspace)
}

fn compile_identity(run_id: &str) -> CompileIdentity {
    let wire = format!(
        r#"{{"runId":"{}","workspaceId":"workspace-1","entryPath":"standalone.tex","documentId":"document-1","documentVersion":4,"savedRevision":"source-revision-4"}}"#,
        run_id
    );
    serde_json::from_str(&wire).unwrap()
}

#[test]
fn artifact_retention_limits_are_bounded() {
    assert_eq!(MAX_COMPILE_PDF_BINDINGS, 128);
    assert_eq!(MAX_RETAINED_SYNCTEX_BYTES, 32 * 1024 * 1024);
}

#[test]
fn compile_pdf_ticket_round_trips_for_tex_entry_without_cross_kind_reads() {
    let (store, _, owner_admission, workspace) = admitted_token_store();
    let identity = compile_identity("run-success");
    assert_eq!(identity.entry_path.as_str(), "standalone.tex");
    assert_eq!(identity.saved_revision.as_str(), "source-revision-4");

    let pdf = b"%PDF-1.7\ncompiled snapshot".to_vec();
    let (compile_token, run) =
        publish_compile_pdf_ticket(&store, &workspace, &identity, pdf.clone()).unwrap();

    let file_pdf = b"%PDF-1.7\nfile read".to_vec();
    let file_path: RelativePath = serde_json::from_str(r#""output.pdf""#).unwrap();
    let file_token = store
        .issue_file_read_pdf(
            &workspace,
            file_path,
            Revision::parse("disk-revision-1").unwrap(),
            file_pdf.clone(),
        )
        .unwrap()
        .to_wire();

    assert!(store
        .take_file_pdf(&owner_admission, &compile_token)
        .is_err());
    assert!(store
        .take_compile_pdf(&owner_admission, &file_token)
        .is_err());
    assert_eq!(
        store.take_file_pdf(&owner_admission, &file_token).unwrap(),
        file_pdf
    );
    assert_eq!(
        take_compile_pdf_ticket(&store, &owner_admission, &run, &compile_token).unwrap(),
        pdf
    );
    assert!(take_compile_pdf_ticket(&store, &owner_admission, &run, &compile_token).is_err());

    let replacement_run = store.admit_compile_run(&workspace, identity).unwrap();
    assert!(store.revoke_compile_run(&replacement_run));
}

#[test]
fn failed_compile_pdf_publication_releases_its_run_admission() {
    let (store, _, _, workspace) = admitted_token_store();
    let identity = compile_identity("run-invalid-pdf");
    assert!(
        publish_compile_pdf_ticket(&store, &workspace, &identity, b"not a PDF".to_vec(),).is_err()
    );

    let retry = store.admit_compile_run(&workspace, identity).unwrap();
    assert!(store.revoke_compile_run(&retry));
}

#[test]
fn compile_pdf_tickets_are_cleaned_on_run_workspace_and_owner_revocation() {
    let (store, owner, owner_admission, workspace) = admitted_token_store();
    let pdf = b"%PDF-1.7\ncompiled snapshot".to_vec();

    let run_identity = compile_identity("run-revoked");
    let (run_token, run) =
        publish_compile_pdf_ticket(&store, &workspace, &run_identity, pdf.clone()).unwrap();
    assert!(store.revoke_compile_run(&run));
    assert!(take_compile_pdf_ticket(&store, &owner_admission, &run, &run_token).is_err());

    let workspace_identity = compile_identity("run-stale-workspace");
    let (workspace_token, workspace_run) =
        publish_compile_pdf_ticket(&store, &workspace, &workspace_identity, pdf.clone()).unwrap();
    let current_workspace = store
        .admit_workspace_generation(&owner_admission, WorkspaceId::parse("workspace-1").unwrap())
        .unwrap();
    assert!(
        take_compile_pdf_ticket(&store, &owner_admission, &workspace_run, &workspace_token,)
            .is_err()
    );
    assert!(store
        .issue_compile_pdf(&workspace_run, pdf.clone())
        .is_err());

    let owner_identity = compile_identity("run-revoked-owner");
    let (owner_token, owner_run) =
        publish_compile_pdf_ticket(&store, &current_workspace, &owner_identity, pdf.clone())
            .unwrap();
    assert!(store.revoke_owner_generation(&owner_admission));
    let current_owner = store.admit_owner_generation(owner).unwrap();
    let _current_workspace = store
        .admit_workspace_generation(&current_owner, WorkspaceId::parse("workspace-1").unwrap())
        .unwrap();
    assert!(take_compile_pdf_ticket(&store, &current_owner, &owner_run, &owner_token).is_err());
    assert!(store.issue_compile_pdf(&owner_run, pdf).is_err());
}
