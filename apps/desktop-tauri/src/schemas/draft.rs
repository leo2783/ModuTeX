// SPDX-License-Identifier: Apache-2.0
//! Narrow renderer DTOs for the native Draft workflow.

use serde::{de::Error as _, Deserialize, Deserializer, Serialize};

use crate::schemas::protocol::{
    CompileIdentity, Diagnostic, DocumentId, DocumentVersion, Revision, RunId, WorkspaceId,
    WriteReceipt,
};
use crate::shared::relative_path::RelativePath;

const MAX_PARAGRAPH_SOURCE_BYTES: usize = 1024 * 1024;

fn paragraph_source<'de, D: Deserializer<'de>>(deserializer: D) -> Result<String, D::Error> {
    let source = String::deserialize(deserializer)?;
    if source.len() > MAX_PARAGRAPH_SOURCE_BYTES {
        return Err(D::Error::custom("paragraph source exceeds the 1 MiB limit"));
    }
    Ok(source)
}

fn required_nullable_revision<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Revision>, D::Error> {
    Option::<Revision>::deserialize(deserializer)
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DraftCompileRequest {
    pub workspace_id: WorkspaceId,
    pub entry_path: RelativePath,
    pub document_id: DocumentId,
    pub document_version: DocumentVersion,
    pub saved_revision: Revision,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DraftSourceRange {
    pub start_byte: u32,
    pub end_byte: u32,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DraftParagraphRequest {
    pub workspace_id: WorkspaceId,
    pub entry_path: RelativePath,
    pub document_id: DocumentId,
    pub document_version: DocumentVersion,
    pub saved_revision: Revision,
    pub range: DraftSourceRange,
    #[serde(deserialize_with = "paragraph_source")]
    pub source: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DraftWorkspaceRequest {
    pub workspace_id: WorkspaceId,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DraftSavePdfRequest {
    pub workspace_id: WorkspaceId,
    pub run_id: RunId,
    pub path: RelativePath,
    #[serde(deserialize_with = "required_nullable_revision")]
    pub expected_revision: Option<Revision>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum DraftMode {
    Full,
    Paragraph,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum DraftStatus {
    Success,
    Failure,
    Cancelled,
    Preempted,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DraftGeometry {
    pub paper_width_pt: f64,
    pub paper_height_pt: f64,
    pub column_width_pt: f64,
    pub foot_skip_pt: f64,
    pub margin_left_pt: f64,
    pub margin_right_pt: f64,
    pub margin_top_pt: f64,
    pub margin_bottom_pt: f64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DraftRenderableRecord {
    pub kind: String,
    pub x_pt: f64,
    pub y_pt: f64,
    pub width_pt: f64,
    pub height_pt: f64,
    pub text: Option<String>,
    pub font_id: Option<u32>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DraftPageRecord {
    pub number: u32,
    pub width_pt: f64,
    pub height_pt: f64,
    pub shipout_baseline_height_pt: f64,
    #[serde(default)]
    pub unsupported_content_reasons: Vec<String>,
    #[serde(default)]
    pub renderable_records: Vec<DraftRenderableRecord>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DraftExtractionRecord {
    #[serde(default)]
    pub geometry: DraftGeometry,
    #[serde(default)]
    pub pages: Vec<DraftPageRecord>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DraftReference {
    pub key: String,
    pub label: String,
    pub page: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DraftBibliographyEntry {
    pub key: String,
    pub citation_label: Option<String>,
    pub text: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DraftImageReference {
    pub path: RelativePath,
    pub page: Option<u32>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DraftDocumentResult {
    pub identity: CompileIdentity,
    pub mode: DraftMode,
    pub status: DraftStatus,
    pub elapsed_ms: u64,
    pub page_count: u32,
    pub renderable_record_count: u64,
    pub pass_count: u8,
    pub bibliography_pass_count: u8,
    pub geometry: DraftGeometry,
    pub pages: Vec<DraftPageRecord>,
    pub references: Vec<DraftReference>,
    pub bibliography: Vec<DraftBibliographyEntry>,
    pub images: Vec<DraftImageReference>,
    pub unsupported_content_reasons: Vec<String>,
    /// The real LuaLaTeX PDF remains the rendering fallback whenever records
    /// are incomplete or a page contains content the record extractor cannot
    /// represent.
    pub pdf_fallback: bool,
    pub diagnostics: Vec<Diagnostic>,
    pub log: String,
    pub failure: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pdf_token: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub(crate) enum DraftErrorCode {
    WorkspaceDenied,
    WorkspaceBusy,
    StaleWorkspace,
    EngineUnavailable,
    InvalidRequest,
    InputTooLarge,
    TimedOut,
    Cancelled,
    CleanupUnproven,
    ResourceExhausted,
    IoFailed,
    Internal,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DraftError {
    pub code: DraftErrorCode,
    pub message: String,
}

impl DraftError {
    pub(crate) fn new(code: DraftErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DraftStopReceipt {
    pub stopped: bool,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DraftTakeoverReceipt {
    pub preempted: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DraftSavedPdfReceipt {
    pub write: WriteReceipt,
}
