// SPDX-License-Identifier: Apache-2.0
use super::*;
use std::collections::BTreeSet;

use crate::{
    schemas::protocol::{DocumentId, DocumentVersion, Revision, WorkspaceId},
    shared::relative_path::RelativePath,
};

fn identity() -> CompileIdentity {
    CompileIdentity {
        run_id: RunId::parse("run-1").expect("valid test run id"),
        workspace_id: WorkspaceId::parse("ws-1").expect("valid test workspace id"),
        entry_path: RelativePath::parse("main.tex").expect("valid test entry"),
        document_id: DocumentId::parse("doc-1").expect("valid test document id"),
        document_version: DocumentVersion::new(7).expect("safe test version"),
        saved_revision: Revision::parse("rev-1").expect("valid test revision"),
    }
}

#[test]
fn compile_success_wire_is_metadata_plus_pdf_token_only() {
    let value = serde_json::to_value(CompileResultMetadata::Success {
        identity: identity(),
        log: "ok".to_owned(),
        diagnostics: Vec::new(),
        pdf_token: "token-1".to_owned(),
    })
    .expect("serialize compile success metadata");
    let keys = value
        .as_object()
        .expect("object")
        .keys()
        .map(String::as_str)
        .collect::<BTreeSet<_>>();
    assert_eq!(
        keys,
        ["diagnostics", "identity", "log", "pdfToken", "status"]
            .into_iter()
            .collect()
    );
    assert_eq!(value["status"], "success");
    assert_eq!(value["pdfToken"], "token-1");
    assert!(value.get("pdf").is_none());
}

#[test]
fn compile_failure_wire_matches_the_current_adapter_shape() {
    let value = serde_json::to_value(CompileResultMetadata::Failure {
        identity: identity(),
        log: "failed".to_owned(),
        diagnostics: Vec::new(),
    })
    .expect("serialize compile failure metadata");
    let keys = value
        .as_object()
        .expect("object")
        .keys()
        .map(String::as_str)
        .collect::<BTreeSet<_>>();
    assert_eq!(
        keys,
        ["diagnostics", "identity", "log", "status"]
            .into_iter()
            .collect()
    );
    assert_eq!(value["status"], "failure");
    assert!(value.get("pdfToken").is_none());
}
