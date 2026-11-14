// SPDX-License-Identifier: Apache-2.0
use super::*;
use serde_json::json;

#[test]
fn validates_document_id_charset_and_length_bounds() {
    assert!(valid_document_id("doc_1-main"));
    assert!(valid_document_id(&"a".repeat(MAX_DOCUMENT_ID_BYTES)));

    assert!(!valid_document_id(""));
    assert!(!valid_document_id(&"a".repeat(MAX_DOCUMENT_ID_BYTES + 1)));
    assert!(!valid_document_id("doc/1"));
    assert!(!valid_document_id("doc.tex"));
}

#[test]
fn maps_source_format_errors_to_stable_prefixed_messages() {
    assert!(format_error(SourceFormatError::InputTooLarge).starts_with("SOURCE_FORMAT_LIMIT:"));
    assert!(format_error(SourceFormatError::ToolMissing).starts_with("LATEXINDENT_NOT_FOUND:"));
    assert!(
        format_error(SourceFormatError::WorkspaceUnavailable)
            .starts_with("SOURCE_FORMAT_WORKSPACE:")
    );
    assert!(
        format_error(SourceFormatError::SettingsUnavailable)
            .starts_with("SOURCE_FORMAT_SETTINGS:")
    );
    assert!(format_error(SourceFormatError::ProcessFailed).starts_with("SOURCE_FORMAT_FAILED:"));
    assert!(format_error(SourceFormatError::InvalidOutput).starts_with("SOURCE_FORMAT_FAILED:"));
}

#[test]
fn format_latex_request_rejects_unknown_fields() {
    let ok = serde_json::from_value::<FormatLatexRequest>(json!({
        "workspaceId": "ws-1",
        "text": "\\section{Intro}\n",
        "documentId": "doc-1",
        "documentVersion": 3
    }));
    assert!(ok.is_ok());

    let extra = serde_json::from_value::<FormatLatexRequest>(json!({
        "workspaceId": "ws-1",
        "text": "\\section{Intro}\n",
        "documentId": "doc-1",
        "documentVersion": 3,
        "flags": ["-w"]
    }));
    assert!(extra.is_err());
}
