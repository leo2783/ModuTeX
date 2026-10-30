// SPDX-License-Identifier: Apache-2.0
use serde::{Deserialize, Serialize};
use tauri::{State, WebviewWindow};

use crate::{
    commands::frontend_files::verify_trusted_window,
    schemas::protocol::WorkspaceId,
    services::source_format::{self, SourceFormatError, MAX_SOURCE_BYTES},
    state::{
        desktop::FrontendFilesState,
        source_format::{BeginError, FrontendSourceFormatState},
    },
};

const MAX_DOCUMENT_ID_BYTES: usize = 128;
const MAX_SAFE_DOCUMENT_VERSION: u64 = 9_007_199_254_740_991;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FormatLatexRequest {
    workspace_id: WorkspaceId,
    text: String,
    document_id: String,
    document_version: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FormatLatexReceipt {
    formatted: String,
    document_id: String,
    document_version: u64,
}

fn valid_document_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_DOCUMENT_ID_BYTES
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

fn format_error(error: SourceFormatError) -> String {
    match error {
		SourceFormatError::InputTooLarge => {
			"SOURCE_FORMAT_LIMIT: Source exceeds 5 MiB.".to_owned()
		}
		SourceFormatError::ToolMissing => "LATEXINDENT_NOT_FOUND: latexindent.exe was not found. Install TeX Live or MiKTeX and add latexindent.exe to PATH.".to_owned(),
		SourceFormatError::WorkspaceUnavailable => {
			"SOURCE_FORMAT_WORKSPACE: The workspace is no longer available.".to_owned()
		}
		SourceFormatError::SettingsUnavailable => {
			"SOURCE_FORMAT_SETTINGS: Project formatting settings could not be read safely.".to_owned()
		}
		SourceFormatError::ProcessFailed | SourceFormatError::InvalidOutput => {
			"SOURCE_FORMAT_FAILED: Formatting failed. The original source was not changed."
				.to_owned()
		}
	}
}

#[tauri::command]
pub(crate) async fn frontend_format_latex(
    window: WebviewWindow,
    files: State<'_, FrontendFilesState>,
    formats: State<'_, FrontendSourceFormatState>,
    request: FormatLatexRequest,
) -> Result<FormatLatexReceipt, String> {
    if request.text.len() > MAX_SOURCE_BYTES {
        return Err(format_error(SourceFormatError::InputTooLarge));
    }
    if !valid_document_id(&request.document_id)
        || request.document_version > MAX_SAFE_DOCUMENT_VERSION
    {
        return Err("SOURCE_FORMAT_REQUEST: Invalid document identity.".to_owned());
    }

    let owner = verify_trusted_window(&window, &files)
        .map_err(|_| "SOURCE_FORMAT_OWNER: Untrusted window.".to_owned())?;
    let permit = formats.begin(&owner).map_err(|error| match error {
        BeginError::OwnerBusy => "SOURCE_FORMAT_BUSY: Formatting is already running.".to_owned(),
        BeginError::CapacityReached => {
            "SOURCE_FORMAT_BUSY: Formatter capacity is temporarily full.".to_owned()
        }
    })?;
    let filesystem = files.shared_service();
    let workspace_id = request.workspace_id;

    let cancellation = permit.cancellation_token();
    let text = request.text;
    let document_id = request.document_id;
    let document_version = request.document_version;
    let joined = tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        source_format::format_latex(&filesystem, &owner, &workspace_id, &text, &cancellation).map(
            |formatted| FormatLatexReceipt {
                formatted,
                document_id,
                document_version,
            },
        )
    })
    .await
    .map_err(|_| {
        "SOURCE_FORMAT_FAILED: Formatting failed. The original source was not changed.".to_owned()
    })?;
    joined.map_err(format_error)
}
