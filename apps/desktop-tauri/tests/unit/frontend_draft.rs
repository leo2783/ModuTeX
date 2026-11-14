// SPDX-License-Identifier: Apache-2.0
use super::*;
use serde_json::json;

#[test]
fn denied_produces_workspace_denied_draft_error() {
    let error = denied();
    assert_eq!(error.code, DraftErrorCode::WorkspaceDenied);
    assert!(error.message.contains("not authorized"));
}

#[test]
fn draft_requests_reject_unknown_fields_and_invalid_paths() {
    let valid_compile = serde_json::from_value::<DraftCompileRequest>(json!({
        "workspaceId": "ws-1",
        "entryPath": "paper/main.tex",
        "documentId": "doc-1",
        "documentVersion": 1,
        "savedRevision": "rev-1"
    }));
    assert!(valid_compile.is_ok());

    let extra_field = serde_json::from_value::<DraftCompileRequest>(json!({
        "workspaceId": "ws-1",
        "entryPath": "paper/main.tex",
        "documentId": "doc-1",
        "documentVersion": 1,
        "savedRevision": "rev-1",
        "executable": "cmd.exe"
    }));
    assert!(extra_field.is_err());

    let traversal_save = serde_json::from_value::<DraftSavePdfRequest>(json!({
        "workspaceId": "ws-1",
        "runId": "run-1",
        "path": "../outside.pdf",
        "expectedRevision": null
    }));
    assert!(traversal_save.is_err());
}
