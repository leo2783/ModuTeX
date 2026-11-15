// SPDX-License-Identifier: Apache-2.0
use super::*;
use serde_json::json;

#[test]
fn git_request_dtos_reject_unknown_fields_and_traversal_paths() {
    let ws_ok = serde_json::from_value::<GitWorkspaceRequest>(json!({
        "workspaceId": "ws-1"
    }));
    assert!(ws_ok.is_ok());

    let ws_extra = serde_json::from_value::<GitWorkspaceRequest>(json!({
        "workspaceId": "ws-1",
        "argv": ["--version"]
    }));
    assert!(ws_extra.is_err());

    let diff_traversal = serde_json::from_value::<GitDiffRequest>(json!({
        "workspaceId": "ws-1",
        "staged": false,
        "paths": ["../secret.tex"]
    }));
    assert!(diff_traversal.is_err());

    let commit_ok = serde_json::from_value::<GitCommitRequest>(json!({
        "workspaceId": "ws-1",
        "message": "Initial commit"
    }));
    assert!(commit_ok.is_ok());
}

#[test]
fn discard_confirmation_message_truncates_long_paths_and_caps_path_list_at_eight() {
    let long_segment = "a".repeat(200);
    let long_rel = format!("{long_segment}/{long_segment}.tex");
    let mut paths = vec![RelativePath::parse(&long_rel).unwrap()];
    for idx in 1..10 {
        paths.push(RelativePath::parse(&format!("chapter-{idx}.tex")).unwrap());
    }

    let message = discard_confirmation_message(&paths);
    assert!(message.starts_with("Discard the selected Git changes?"));
    assert!(message.contains('…'));
    assert!(message.contains("…and 2 more path(s)."));
    assert!(!message.contains("chapter-8.tex"));
    assert!(!message.contains("chapter-9.tex"));
}
