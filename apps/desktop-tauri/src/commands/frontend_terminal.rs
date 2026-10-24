// SPDX-License-Identifier: Apache-2.0
//! Thin Tauri command handlers for frontend terminal (`src/commands/frontend_terminal.rs`).

#![cfg(all(windows, target_arch = "x86_64"))]

use tauri::{State, WebviewWindow};

use crate::{
    commands::frontend_files::verify_trusted_window,
    schemas::{
        protocol::OwnerId,
        terminal::{
            TerminalCommandError, TerminalHostErrorCode, TerminalInputRequest, TerminalKillRequest,
            TerminalResizeRequest, TerminalSessionReceipt, TerminalSpawnRequest,
        },
    },
    services::terminal_service::{
        TerminalAvailability, TerminalErrorKind, TerminalSize, TerminalTeardownReport,
    },
    state::{
        desktop::FrontendFilesState,
        terminal::{trusted_windows_shell, FrontendTerminalState},
    },
};

fn verify_terminal_caller(
    window: &WebviewWindow,
    files_state: &FrontendFilesState,
) -> Result<OwnerId, TerminalCommandError> {
    verify_trusted_window(window, files_state).map_err(|err| {
        TerminalCommandError::host(
            TerminalHostErrorCode::UntrustedWindow,
            format!("untrusted terminal window: {err}"),
        )
    })
}

#[tauri::command]
pub async fn frontend_terminal_availability(
    window: WebviewWindow,
    files_state: State<'_, FrontendFilesState>,
    state: State<'_, FrontendTerminalState>,
) -> Result<TerminalAvailability, TerminalCommandError> {
    let owner = verify_terminal_caller(&window, &files_state)?;
    let shell = match trusted_windows_shell() {
        Ok(shell) => shell,
        Err(error) => {
            return Ok(TerminalAvailability {
                available: false,
                reason: Some(TerminalErrorKind::InvalidShellExecutable),
                detail: Some(error.detail().to_owned()),
            })
        }
    };
    state.availability(owner, shell).await
}

#[tauri::command]
pub async fn frontend_terminal_spawn(
    window: WebviewWindow,
    files_state: State<'_, FrontendFilesState>,
    state: State<'_, FrontendTerminalState>,
    request: TerminalSpawnRequest,
) -> Result<TerminalSessionReceipt, TerminalCommandError> {
    let owner = verify_terminal_caller(&window, &files_state)?;
    state.spawn(owner, request).await
}

#[tauri::command]
pub async fn frontend_terminal_input(
    window: WebviewWindow,
    files_state: State<'_, FrontendFilesState>,
    state: State<'_, FrontendTerminalState>,
    request: TerminalInputRequest,
) -> Result<(), TerminalCommandError> {
    let owner = verify_terminal_caller(&window, &files_state)?;
    state.input(owner, request).await
}

#[tauri::command]
pub async fn frontend_terminal_resize(
    window: WebviewWindow,
    files_state: State<'_, FrontendFilesState>,
    state: State<'_, FrontendTerminalState>,
    request: TerminalResizeRequest,
) -> Result<TerminalSize, TerminalCommandError> {
    let owner = verify_terminal_caller(&window, &files_state)?;
    state.resize(owner, request).await
}

#[tauri::command]
pub async fn frontend_terminal_kill(
    window: WebviewWindow,
    files_state: State<'_, FrontendFilesState>,
    state: State<'_, FrontendTerminalState>,
    request: TerminalKillRequest,
) -> Result<TerminalTeardownReport, TerminalCommandError> {
    let owner = verify_terminal_caller(&window, &files_state)?;
    state.kill(owner, request).await
}
