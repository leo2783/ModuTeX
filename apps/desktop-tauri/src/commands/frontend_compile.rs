// SPDX-License-Identifier: Apache-2.0
//! Owner-checked Tauri commands for the real G3 compile coordinator.

use std::time::Duration;

use serde::Serialize;
use tauri::{ipc::Response as IpcResponse, State, WebviewWindow};

use crate::{
    commands::frontend_files::verify_trusted_window,
    compile_config::CompileOrigin,
    schemas::protocol::{CompileIdentity, CompileRequest, CompileResult, Diagnostic, RunId},
    services::compile_service::CompileDelivery,
    state::{
        compile::{CompileArtifactBinding, FrontendCompileState},
        desktop::FrontendFilesState,
    },
};

const COMPILE_RESULT_WAIT: Duration = Duration::from_secs(24 * 60 * 60);

/// Exact metadata shapes consumed by apps/frontend/src/features/files/tauri-files.ts.
/// PDF bytes are never serialized into this JSON response.
#[derive(Serialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub(crate) enum CompileResultMetadata {
    Success {
        identity: CompileIdentity,
        log: String,
        diagnostics: Vec<Diagnostic>,
        #[serde(rename = "pdfToken")]
        pdf_token: String,
    },
    Failure {
        identity: CompileIdentity,
        log: String,
        diagnostics: Vec<Diagnostic>,
    },
    Cancelled {
        identity: CompileIdentity,
        log: String,
        diagnostics: Vec<Diagnostic>,
    },
}

fn check_artifact_generation(
    files: &FrontendFilesState,
    owner: &crate::schemas::protocol::OwnerId,
    binding: &CompileArtifactBinding,
) -> Result<(), String> {
    let current = files.workspace_grant(owner, &binding.identity.workspace_id)?;
    if current.filesystem_generation != binding.filesystem_generation
        || current.epoch != binding.epoch
    {
        return Err("STALE_WORKSPACE".to_owned());
    }
    Ok(())
}

#[cfg(feature = "mcp")]
#[tauri::command]
pub fn frontend_start_compile(
    window: WebviewWindow,
    files: State<'_, FrontendFilesState>,
    bridge: State<'_, std::sync::Arc<crate::state::mcp::McpBridgeState>>,
    compile: State<'_, FrontendCompileState>,
    request: CompileRequest,
) -> Result<CompileIdentity, String> {
    let owner = verify_trusted_window(&window, &files)?;
    files.workspace_grant(&owner, &request.workspace_id)?;
    // MCP origin is selected only while the host-owned editor request is pending.
    let origin = if bridge.is_mcp_compile_pending(&owner, &request.workspace_id) {
        CompileOrigin::Mcp
    } else {
        CompileOrigin::Ui
    };
    compile
        .start(&owner, request, origin)
        .map_err(|error| error.to_string())
}

#[cfg(not(feature = "mcp"))]
#[tauri::command]
pub fn frontend_start_compile(
    window: WebviewWindow,
    files: State<'_, FrontendFilesState>,
    compile: State<'_, FrontendCompileState>,
    request: CompileRequest,
) -> Result<CompileIdentity, String> {
    let owner = verify_trusted_window(&window, &files)?;
    files.workspace_grant(&owner, &request.workspace_id)?;
    compile
        .start(&owner, request, CompileOrigin::Ui)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) async fn frontend_compile_result(
    window: WebviewWindow,
    files: State<'_, FrontendFilesState>,
    compile: State<'_, FrontendCompileState>,
    run_id: RunId,
) -> Result<CompileResultMetadata, String> {
    let owner = verify_trusted_window(&window, &files)?;
    let compile_runtime = (*compile).clone();
    let wait_owner = owner.clone();
    let wait_run_id = run_id.clone();
    let delivery = tauri::async_runtime::spawn_blocking(move || {
        compile_runtime.wait_run_result_with_artifacts(
            &wait_owner,
            &wait_run_id,
            COMPILE_RESULT_WAIT,
        )
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())?
    .ok_or_else(|| "Compile result wait timed out".to_owned())?;

    let owner = verify_trusted_window(&window, &files)?;
    let CompileDelivery { result, synctex } = delivery;
    match result {
        CompileResult::Success {
            identity,
            pdf,
            log,
            diagnostics,
        } => {
            let grant = files.workspace_grant(&owner, &identity.workspace_id)?;
            let (pdf_token, run_admission) = files.publish_compile_pdf(
                &owner,
                &identity.workspace_id,
                &grant,
                &identity,
                pdf,
            )?;
            if let Err(error) = compile.record_success(
                &owner,
                &identity,
                &grant,
                &files.tokens,
                (pdf_token.clone(), run_admission.clone()),
                synctex,
            ) {
                files.tokens.revoke_compile_run(&run_admission);
                return Err(error);
            }
            Ok(CompileResultMetadata::Success {
                identity,
                log,
                diagnostics,
                pdf_token,
            })
        }
        CompileResult::Failure {
            identity,
            log,
            diagnostics,
        } => {
            drop(synctex);
            files.workspace_grant(&owner, &identity.workspace_id)?;
            Ok(CompileResultMetadata::Failure {
                identity,
                log,
                diagnostics,
            })
        }
        CompileResult::Cancelled {
            identity,
            log,
            diagnostics,
        } => {
            drop(synctex);
            files.workspace_grant(&owner, &identity.workspace_id)?;
            Ok(CompileResultMetadata::Cancelled {
                identity,
                log,
                diagnostics,
            })
        }
    }
}

#[tauri::command]
pub fn frontend_cancel_compile(
    window: WebviewWindow,
    files: State<'_, FrontendFilesState>,
    compile: State<'_, FrontendCompileState>,
    run_id: RunId,
) -> Result<(), String> {
    let owner = verify_trusted_window(&window, &files)?;
    let _ = compile
        .cancel_run(&owner, &run_id)
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn frontend_take_compile_pdf(
    window: WebviewWindow,
    files: State<'_, FrontendFilesState>,
    compile: State<'_, FrontendCompileState>,
    token: String,
) -> Result<IpcResponse, String> {
    let owner = verify_trusted_window(&window, &files)?;
    let binding = compile.take_pdf_binding(&owner, &token)?;
    let result = (|| {
        check_artifact_generation(&files, &owner, &binding.artifact)?;
        let owner_admission = files.ensure_owner_admission(&owner)?;
        binding.take(&owner_admission, &token)
    })();
    binding.revoke();
    let bytes = result?;
    Ok(IpcResponse::new(bytes))
}

/// Separate one-shot binary hook: SyncTeX is not added to CompileResult JSON
/// or the DesktopPort compile DTO.
#[tauri::command]
pub fn frontend_take_compile_synctex(
    window: WebviewWindow,
    files: State<'_, FrontendFilesState>,
    compile: State<'_, FrontendCompileState>,
    run_id: RunId,
) -> Result<IpcResponse, String> {
    let owner = verify_trusted_window(&window, &files)?;
    let artifact = compile.take_synctex(&owner, &run_id)?;
    check_artifact_generation(&files, &owner, &artifact.binding)?;
    Ok(IpcResponse::new(artifact.bytes))
}

#[cfg(test)]
#[path = "../../tests/unit/frontend_compile.rs"]
mod tests;
