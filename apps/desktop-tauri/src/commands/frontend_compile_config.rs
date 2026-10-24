// SPDX-License-Identifier: Apache-2.0
//! Owner-checked commands for persisted G3 compile configuration.

#![cfg(all(windows, target_arch = "x86_64"))]

use tauri::{State, WebviewWindow};

use crate::{
    commands::frontend_files::verify_trusted_window,
    compile_config::{CompileConfigUpdate, CompileConfigView, CompileOrigin},
    schemas::protocol::WorkspaceId,
    state::{compile::FrontendCompileState, desktop::FrontendFilesState},
};

#[tauri::command]
pub fn frontend_get_compile_config(
    window: WebviewWindow,
    files: State<'_, FrontendFilesState>,
    compile: State<'_, FrontendCompileState>,
    workspace_id: WorkspaceId,
) -> Result<CompileConfigView, String> {
    let owner = verify_trusted_window(&window, &files)?;
    files.workspace_grant(&owner, &workspace_id)?;
    compile.get_compile_config(&owner, &workspace_id, CompileOrigin::Ui)
}

#[tauri::command]
pub fn frontend_update_compile_config(
    window: WebviewWindow,
    files: State<'_, FrontendFilesState>,
    compile: State<'_, FrontendCompileState>,
    request: CompileConfigUpdate,
) -> Result<CompileConfigView, String> {
    let owner = verify_trusted_window(&window, &files)?;
    files.workspace_grant(&owner, &request.workspace_id)?;
    compile.update_compile_config(&owner, request, CompileOrigin::Ui)
}

#[cfg(feature = "mcp")]
#[tauri::command]
pub fn frontend_get_mcp_compile_command_permission(
    window: WebviewWindow,
    files: State<'_, FrontendFilesState>,
    compile: State<'_, FrontendCompileState>,
) -> Result<bool, String> {
    let _owner = verify_trusted_window(&window, &files)?;
    compile.get_mcp_compile_command_permission()
}

#[cfg(feature = "mcp")]
#[tauri::command]
pub fn frontend_set_mcp_compile_command_permission(
    window: WebviewWindow,
    files: State<'_, FrontendFilesState>,
    compile: State<'_, FrontendCompileState>,
    enabled: bool,
) -> Result<bool, String> {
    let _owner = verify_trusted_window(&window, &files)?;
    compile.set_mcp_compile_command_permission(enabled)
}
