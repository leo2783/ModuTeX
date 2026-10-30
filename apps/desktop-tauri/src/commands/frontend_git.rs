// SPDX-License-Identifier: Apache-2.0
//! Narrow owner-authorized Git commands. The renderer selects only a workspace,
//! validated relative paths and operation data; it never supplies executable,
//! root, or argv. Blocking native work runs away from the Tauri async executor.

use std::sync::mpsc;

use serde::Deserialize;
use tauri::{ipc::Response as IpcResponse, State, WebviewWindow};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

use crate::{
    commands::frontend_files::verify_trusted_window,
    schemas::protocol::{OwnerId, WorkspaceId},
    services::git_service::{GitAvailability, GitStatus},
    shared::relative_path::RelativePath,
    state::{
        desktop::FrontendFilesState,
        git::{FrontendGitState, GitCommandFailure},
    },
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct GitWorkspaceRequest {
    workspace_id: WorkspaceId,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct GitPathsRequest {
    workspace_id: WorkspaceId,
    paths: Vec<RelativePath>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct GitDiffRequest {
    workspace_id: WorkspaceId,
    staged: bool,
    paths: Vec<RelativePath>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct GitCommitRequest {
    workspace_id: WorkspaceId,
    message: String,
}

fn authorized_owner(
    window: &WebviewWindow,
    files: &FrontendFilesState,
) -> Result<OwnerId, GitCommandFailure> {
    verify_trusted_window(window, files)
        .map_err(|error| GitCommandFailure::new("ACCESS_DENIED", error))
}

async fn spawn_git<T>(
    operation: impl FnOnce() -> Result<T, GitCommandFailure> + Send + 'static,
) -> Result<T, GitCommandFailure>
where
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|error| GitCommandFailure::new("HOST_TASK_FAILED", error.to_string()))?
}

fn discard_confirmation_message(paths: &[RelativePath]) -> String {
    let mut message =
        String::from("Discard the selected Git changes? This operation cannot be undone here.");
    for path in paths.iter().take(8) {
        let mut shown = path.as_str().chars().take(257).collect::<String>();
        if shown.chars().count() > 256 {
            shown = shown.chars().take(256).collect::<String>();
            shown.push('…');
        }
        message.push_str("\n\n");
        message.push_str(&shown);
    }
    if paths.len() > 8 {
        message.push_str(&format!("\n\n…and {} more path(s).", paths.len() - 8));
    }
    message
}

fn ask_discard_confirmation(window: WebviewWindow, message: String) -> bool {
    let (sender, receiver) = mpsc::sync_channel(1);
    window
        .dialog()
        .message(message)
        .title("Discard Git changes")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancel)
        .show(move |confirmed| {
            let _ = sender.send(confirmed);
        });
    receiver.recv().unwrap_or(false)
}

#[tauri::command]
pub fn frontend_git_availability(
    window: WebviewWindow,
    files: State<'_, FrontendFilesState>,
    git: State<'_, FrontendGitState>,
) -> Result<GitAvailability, GitCommandFailure> {
    let _owner = authorized_owner(&window, files.inner())?;
    Ok(git.availability())
}

#[tauri::command]
pub(crate) async fn frontend_git_status(
    window: WebviewWindow,
    files: State<'_, FrontendFilesState>,
    git: State<'_, FrontendGitState>,
    request: GitWorkspaceRequest,
) -> Result<GitStatus, GitCommandFailure> {
    let owner = authorized_owner(&window, files.inner())?;
    let git = git.inner().clone();
    spawn_git(move || git.status(&owner, &request.workspace_id)).await
}

#[tauri::command]
pub(crate) async fn frontend_git_diff(
    window: WebviewWindow,
    files: State<'_, FrontendFilesState>,
    git: State<'_, FrontendGitState>,
    request: GitDiffRequest,
) -> Result<IpcResponse, GitCommandFailure> {
    let owner = authorized_owner(&window, files.inner())?;
    let git = git.inner().clone();
    let bytes =
        spawn_git(move || git.diff(&owner, &request.workspace_id, request.staged, request.paths))
            .await?;
    Ok(IpcResponse::new(bytes))
}

#[tauri::command]
pub(crate) async fn frontend_git_log(
    window: WebviewWindow,
    files: State<'_, FrontendFilesState>,
    git: State<'_, FrontendGitState>,
    request: GitWorkspaceRequest,
) -> Result<IpcResponse, GitCommandFailure> {
    let owner = authorized_owner(&window, files.inner())?;
    let git = git.inner().clone();
    let bytes = spawn_git(move || git.log(&owner, &request.workspace_id)).await?;
    Ok(IpcResponse::new(bytes))
}

#[tauri::command]
pub(crate) async fn frontend_git_show(
    window: WebviewWindow,
    files: State<'_, FrontendFilesState>,
    git: State<'_, FrontendGitState>,
    request: GitWorkspaceRequest,
) -> Result<IpcResponse, GitCommandFailure> {
    let owner = authorized_owner(&window, files.inner())?;
    let git = git.inner().clone();
    let bytes = spawn_git(move || git.show(&owner, &request.workspace_id)).await?;
    Ok(IpcResponse::new(bytes))
}

#[tauri::command]
pub(crate) async fn frontend_git_init(
    window: WebviewWindow,
    files: State<'_, FrontendFilesState>,
    git: State<'_, FrontendGitState>,
    request: GitWorkspaceRequest,
) -> Result<(), GitCommandFailure> {
    let owner = authorized_owner(&window, files.inner())?;
    let git = git.inner().clone();
    spawn_git(move || git.init(&owner, &request.workspace_id)).await
}

#[tauri::command]
pub(crate) async fn frontend_git_stage(
    window: WebviewWindow,
    files: State<'_, FrontendFilesState>,
    git: State<'_, FrontendGitState>,
    request: GitPathsRequest,
) -> Result<(), GitCommandFailure> {
    let owner = authorized_owner(&window, files.inner())?;
    let git = git.inner().clone();
    spawn_git(move || git.stage(&owner, &request.workspace_id, request.paths)).await
}

#[tauri::command]
pub(crate) async fn frontend_git_unstage(
    window: WebviewWindow,
    files: State<'_, FrontendFilesState>,
    git: State<'_, FrontendGitState>,
    request: GitPathsRequest,
) -> Result<(), GitCommandFailure> {
    let owner = authorized_owner(&window, files.inner())?;
    let git = git.inner().clone();
    spawn_git(move || git.unstage(&owner, &request.workspace_id, request.paths)).await
}

#[tauri::command]
pub(crate) async fn frontend_git_discard(
    window: WebviewWindow,
    files: State<'_, FrontendFilesState>,
    git: State<'_, FrontendGitState>,
    request: GitPathsRequest,
) -> Result<bool, GitCommandFailure> {
    let owner = authorized_owner(&window, files.inner())?;
    let git = git.inner().clone();
    let prompt = window.clone();
    let message = discard_confirmation_message(&request.paths);
    spawn_git(move || {
        git.discard(&owner, &request.workspace_id, request.paths, move || {
            ask_discard_confirmation(prompt, message)
        })
    })
    .await
}

#[tauri::command]
pub(crate) async fn frontend_git_commit(
    window: WebviewWindow,
    files: State<'_, FrontendFilesState>,
    git: State<'_, FrontendGitState>,
    request: GitCommitRequest,
) -> Result<IpcResponse, GitCommandFailure> {
    let owner = authorized_owner(&window, files.inner())?;
    let git = git.inner().clone();
    let bytes =
        spawn_git(move || git.commit(&owner, &request.workspace_id, request.message)).await?;
    Ok(IpcResponse::new(bytes))
}

#[tauri::command]
pub(crate) async fn frontend_git_user_name(
    window: WebviewWindow,
    files: State<'_, FrontendFilesState>,
    git: State<'_, FrontendGitState>,
    request: GitWorkspaceRequest,
) -> Result<Option<String>, GitCommandFailure> {
    let owner = authorized_owner(&window, files.inner())?;
    let git = git.inner().clone();
    spawn_git(move || git.user_name(&owner, &request.workspace_id)).await
}
