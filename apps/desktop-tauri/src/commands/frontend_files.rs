// SPDX-License-Identifier: Apache-2.0
//! Real G2 DesktopPort host commands implementation (`src/frontend_files.rs`).
//!
//! Provides the 12 DesktopPort file commands matching the renderer contracts,
//! with owner authorization fence, native dialogs within spawn_blocking,
//! host-only 32MiB PDF tokens, and native directory change monitoring.

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

use serde::Serialize;
use tauri::{ipc::Response as IpcResponse, Emitter, State, WebviewWindow};

use crate::{
    schemas::protocol::{
        validate_pdf, FileEntry, FileEvent, FileRef, FileWatchFailure, FileWatchResyncReason,
        OwnerId, ReadReceipt, RecentDocument, RecentId, Revision, SaveAsReceipt, SaveAsRequest,
        Timestamp, WorkspaceFileCopyRequest, WorkspaceFileCreateRequest, WorkspaceFileMoveRequest,
        WorkspaceFilePathRequest, WorkspaceFileSearchResult, WorkspaceFileStat,
        WorkspaceFilesCancelRequest, WorkspaceFilesScanRequest, WorkspaceFilesSearchRequest,
        WorkspaceFilesTreeRequest, WorkspaceId, WorkspaceInfo, WorkspaceKind,
        WorkspaceRecoverableDeleteReceipt, WriteReceipt, WriteRequest, MAX_PDF_BYTES,
        MAX_READ_BYTES,
    },
    services::{
        file_watch::{
            spawn_watch_bridge, valid_watch_identity, WatchBridgeIdentity, WatchCleanupPermit,
            WatchDeliveryGate,
        },
        filesystem::WatchNotification,
    },
    shared::relative_path::RelativePath,
    state::{
        compile::FrontendCompileState, desktop::FrontendFilesState, terminal::FrontendTerminalState,
    },
};
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchEventMessage {
    pub subscription_id: String,
    pub generation: u64,
    pub event: FileEvent,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchResyncMessage {
    pub subscription_id: String,
    pub generation: u64,
    pub reason: FileWatchResyncReason,
}

#[tauri::command]
pub async fn frontend_workspace_files_tree(
    window: WebviewWindow,
    state: State<'_, FrontendFilesState>,
    request: WorkspaceFilesTreeRequest,
) -> Result<Vec<FileEntry>, String> {
    let owner = verify_trusted_window(&window, &state)?;
    let operation = state
        .workspace_files
        .register_operation(
            owner.clone(),
            request.workspace_id.clone(),
            request.operation_id,
        )
        .map_err(|error| error.to_string())?;
    let cancelled = operation.cancellation();
    let service = state.shared_service();
    let workspace_id = request.workspace_id;
    tauri::async_runtime::spawn_blocking(move || {
        let _operation = operation;
        service
            .workspace_files_tree(&owner, &workspace_id, &cancelled)
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn frontend_workspace_files_scan(
    window: WebviewWindow,
    state: State<'_, FrontendFilesState>,
    request: WorkspaceFilesScanRequest,
) -> Result<Vec<FileEntry>, String> {
    let owner = verify_trusted_window(&window, &state)?;
    let operation = state
        .workspace_files
        .register_operation(
            owner.clone(),
            request.workspace_id.clone(),
            request.operation_id,
        )
        .map_err(|error| error.to_string())?;
    let cancelled = operation.cancellation();
    let service = state.shared_service();
    let workspace_id = request.workspace_id;
    let directory = request.directory;
    let max_depth = request.max_depth as usize;
    let max_entries = request.max_entries as usize;
    tauri::async_runtime::spawn_blocking(move || {
        let _operation = operation;
        service
            .workspace_files_scan(
                &owner,
                &workspace_id,
                &directory,
                max_depth,
                max_entries,
                &cancelled,
            )
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn frontend_workspace_files_search(
    window: WebviewWindow,
    state: State<'_, FrontendFilesState>,
    request: WorkspaceFilesSearchRequest,
) -> Result<WorkspaceFileSearchResult, String> {
    let owner = verify_trusted_window(&window, &state)?;
    let operation = state
        .workspace_files
        .register_operation(
            owner.clone(),
            request.workspace_id.clone(),
            request.operation_id,
        )
        .map_err(|error| error.to_string())?;
    let cancelled = operation.cancellation();
    let service = state.shared_service();
    let workspace_id = request.workspace_id;
    let directory = request.directory;
    let query = request.query;
    let max_results = request.max_results as usize;
    tauri::async_runtime::spawn_blocking(move || {
        let _operation = operation;
        service
            .workspace_files_search(
                &owner,
                &workspace_id,
                directory.as_ref(),
                &query,
                max_results,
                &cancelled,
            )
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn frontend_workspace_files_cancel(
    window: WebviewWindow,
    state: State<'_, FrontendFilesState>,
    request: WorkspaceFilesCancelRequest,
) -> Result<(), String> {
    let owner = verify_trusted_window(&window, &state)?;
    state
        .workspace_files
        .cancel_operation(&owner, &request.workspace_id, &request.operation_id);
    Ok(())
}

#[tauri::command]
pub fn frontend_workspace_files_stat(
    window: WebviewWindow,
    state: State<'_, FrontendFilesState>,
    request: WorkspaceFilePathRequest,
) -> Result<WorkspaceFileStat, String> {
    let owner = verify_trusted_window(&window, &state)?;
    let _operation = state
        .workspace_files
        .admit_operation(owner.clone(), request.workspace_id.clone())
        .map_err(|error| error.to_string())?;
    state
        .service
        .workspace_file_stat(&owner, &request.workspace_id, &request.path)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn frontend_workspace_files_create_file(
    window: WebviewWindow,
    state: State<'_, FrontendFilesState>,
    request: WorkspaceFileCreateRequest,
) -> Result<WorkspaceFileStat, String> {
    let owner = verify_trusted_window(&window, &state)?;
    let _operation = state
        .workspace_files
        .admit_operation(owner.clone(), request.workspace_id.clone())
        .map_err(|error| error.to_string())?;
    state
        .service
        .workspace_file_create(&owner, &request.workspace_id, &request.path, &request.bytes)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn frontend_workspace_files_create_directory(
    window: WebviewWindow,
    state: State<'_, FrontendFilesState>,
    request: WorkspaceFilePathRequest,
) -> Result<WorkspaceFileStat, String> {
    let owner = verify_trusted_window(&window, &state)?;
    let _operation = state
        .workspace_files
        .admit_operation(owner.clone(), request.workspace_id.clone())
        .map_err(|error| error.to_string())?;
    state
        .service
        .workspace_directory_create(&owner, &request.workspace_id, &request.path)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn frontend_workspace_files_move(
    window: WebviewWindow,
    state: State<'_, FrontendFilesState>,
    request: WorkspaceFileMoveRequest,
) -> Result<WorkspaceFileStat, String> {
    let owner = verify_trusted_window(&window, &state)?;
    let _operation = state
        .workspace_files
        .admit_operation(owner.clone(), request.workspace_id.clone())
        .map_err(|error| error.to_string())?;
    state
        .service
        .workspace_file_move(
            &owner,
            &request.workspace_id,
            &request.source,
            &request.destination,
        )
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn frontend_workspace_files_rename(
    window: WebviewWindow,
    state: State<'_, FrontendFilesState>,
    request: WorkspaceFileMoveRequest,
) -> Result<WorkspaceFileStat, String> {
    let owner = verify_trusted_window(&window, &state)?;
    let _operation = state
        .workspace_files
        .admit_operation(owner.clone(), request.workspace_id.clone())
        .map_err(|error| error.to_string())?;
    state
        .service
        .workspace_file_move(
            &owner,
            &request.workspace_id,
            &request.source,
            &request.destination,
        )
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn frontend_workspace_files_copy(
    window: WebviewWindow,
    state: State<'_, FrontendFilesState>,
    request: WorkspaceFileCopyRequest,
) -> Result<WorkspaceFileStat, String> {
    let owner = verify_trusted_window(&window, &state)?;
    let operation = state
        .workspace_files
        .register_operation(
            owner.clone(),
            request.workspace_id.clone(),
            request.operation_id,
        )
        .map_err(|error| error.to_string())?;
    let cancelled = operation.cancellation();
    let service = state.shared_service();
    let workspace_id = request.workspace_id;
    let source = request.source;
    let destination = request.destination;
    tauri::async_runtime::spawn_blocking(move || {
        let _operation = operation;
        service
            .workspace_file_copy(&owner, &workspace_id, &source, &destination, &cancelled)
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn frontend_workspace_files_recycle(
    window: WebviewWindow,
    state: State<'_, FrontendFilesState>,
    request: WorkspaceFilePathRequest,
) -> Result<(), String> {
    let owner = verify_trusted_window(&window, &state)?;
    let _operation = state
        .workspace_files
        .admit_operation(owner.clone(), request.workspace_id.clone())
        .map_err(|error| error.to_string())?;
    state
        .service
        .workspace_file_recycle(&owner, &request.workspace_id, &request.path)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn frontend_workspace_files_delete(
    window: WebviewWindow,
    state: State<'_, FrontendFilesState>,
    request: WorkspaceFilePathRequest,
) -> Result<WorkspaceRecoverableDeleteReceipt, String> {
    let owner = verify_trusted_window(&window, &state)?;
    let _operation = state
        .workspace_files
        .admit_operation(owner.clone(), request.workspace_id.clone())
        .map_err(|error| error.to_string())?;
    let access = state
        .service
        .workspace_file_write_access(&owner, &request.workspace_id)
        .map_err(|error| error.to_string())?;
    state
        .workspace_files
        .delete_recoverable(
            &owner,
            &request.workspace_id,
            access.generation,
            &request.path,
            &access.root,
        )
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn frontend_workspace_files_undo_delete(
    window: WebviewWindow,
    state: State<'_, FrontendFilesState>,
    workspace_id: WorkspaceId,
    token: String,
) -> Result<(), String> {
    let owner = verify_trusted_window(&window, &state)?;
    let _operation = state
        .workspace_files
        .admit_operation(owner.clone(), workspace_id.clone())
        .map_err(|error| error.to_string())?;
    let access = state
        .service
        .workspace_file_write_access(&owner, &workspace_id)
        .map_err(|error| error.to_string())?;
    state
        .workspace_files
        .undo_recoverable(
            &owner,
            &workspace_id,
            access.generation,
            &token,
            &access.root,
        )
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn frontend_workspace_files_reveal(
    window: WebviewWindow,
    state: State<'_, FrontendFilesState>,
    request: WorkspaceFilePathRequest,
) -> Result<(), String> {
    let owner = verify_trusted_window(&window, &state)?;
    let _operation = state
        .workspace_files
        .admit_operation(owner.clone(), request.workspace_id.clone())
        .map_err(|error| error.to_string())?;
    state
        .service
        .workspace_file_reveal(&owner, &request.workspace_id, &request.path)
        .map_err(|error| error.to_string())
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchErrorMessage {
    pub subscription_id: String,
    pub generation: u64,
    pub failure: FileWatchFailure,
}

#[derive(Serialize)]
#[serde(untagged)]
pub enum ReadFileResult {
    NonPdf(ReadReceipt),
    Pdf(PdfReadMetadata),
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfReadMetadata {
    pub workspace_id: WorkspaceId,
    pub path: RelativePath,
    pub revision: Revision,
    pub binary_token: String,
}

pub fn verify_trusted_window(
    window: &WebviewWindow,
    state: &FrontendFilesState,
) -> Result<OwnerId, String> {
    let owner = OwnerId::from_label(window.label())
        .map_err(|_| "access denied: untrusted window".to_owned())?;
    state.require_document_owner(&owner)?;
    Ok(owner)
}

#[tauri::command]
pub async fn frontend_open_workspace(
    window: WebviewWindow,
    state: State<'_, FrontendFilesState>,
    kind: WorkspaceKind,
) -> Result<Option<WorkspaceInfo>, String> {
    let _owner = verify_trusted_window(&window, &state)?;
    let dialog = Arc::clone(state.dialog());
    let win = window.clone();

    let chosen_path = tauri::async_runtime::spawn_blocking(move || match kind {
        WorkspaceKind::Folder => dialog.pick_folder(&win),
        WorkspaceKind::File => dialog.pick_file(&win),
    })
    .await
    .map_err(|e| e.to_string())?;

    let Some(path) = chosen_path else {
        return Ok(None);
    };

    let owner = verify_trusted_window(&window, &state)?;
    let _transition = state.lock_watch_transition();
    let mut lifecycle = state.lock_lifecycle();
    state.require_owner_live_locked(&lifecycle, &owner)?;
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    let opened_at = Timestamp::new(now_ms).map_err(|e| e.to_string())?;

    let outcome = match kind {
        WorkspaceKind::Folder => state
            .service
            .open_workspace_folder(&owner, &path, None, opened_at),
        WorkspaceKind::File => state.service.open_workspace_file(&owner, &path, opened_at),
    }
    .map_err(|e| e.to_string())?;
    if let Err(error) =
        state.admit_workspace_locked(&mut lifecycle, &owner, outcome.opened.id.clone())
    {
        let _ = state.service.close_workspace(&owner, &outcome.opened.id);
        return Err(error);
    }
    Ok(Some(outcome.opened))
}

#[tauri::command]
pub fn frontend_list_recent(
    window: WebviewWindow,
    state: State<'_, FrontendFilesState>,
) -> Result<Vec<RecentDocument>, String> {
    let owner = verify_trusted_window(&window, &state)?;
    let _lifecycle = state.lock_lifecycle();
    state.require_owner_live_locked(&_lifecycle, &owner)?;
    state.service.list_recent().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn frontend_open_recent(
    window: WebviewWindow,
    state: State<'_, FrontendFilesState>,
    id: RecentId,
) -> Result<WorkspaceInfo, String> {
    let owner = verify_trusted_window(&window, &state)?;
    let _transition = state.lock_watch_transition();
    let mut lifecycle = state.lock_lifecycle();
    state.require_owner_live_locked(&lifecycle, &owner)?;
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    let opened_at = Timestamp::new(now_ms).map_err(|e| e.to_string())?;

    let outcome = state
        .service
        .reopen_recent(&owner, id.as_str(), opened_at)
        .map_err(|e| e.to_string())?;

    if let Err(error) =
        state.admit_workspace_locked(&mut lifecycle, &owner, outcome.opened.id.clone())
    {
        let _ = state.service.close_workspace(&owner, &outcome.opened.id);
        return Err(error);
    }
    Ok(outcome.opened)
}

#[tauri::command]
pub fn frontend_remove_recent(
    window: WebviewWindow,
    state: State<'_, FrontendFilesState>,
    id: RecentId,
) -> Result<(), String> {
    let owner = verify_trusted_window(&window, &state)?;
    let _lifecycle = state.lock_lifecycle();
    state.require_owner_live_locked(&_lifecycle, &owner)?;
    state
        .service
        .remove_recent(id.as_str())
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn frontend_list_files(
    window: WebviewWindow,
    state: State<'_, FrontendFilesState>,
    workspace_id: WorkspaceId,
) -> Result<Vec<FileEntry>, String> {
    let owner = verify_trusted_window(&window, &state)?;
    state.require_document_owner(&owner)?;
    state
        .service
        .list_files(&owner, &workspace_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn frontend_read_file(
    window: WebviewWindow,
    state: State<'_, FrontendFilesState>,
    file: FileRef,
) -> Result<ReadFileResult, String> {
    let owner = verify_trusted_window(&window, &state)?;
    let is_pdf = file.path.as_str().to_ascii_lowercase().ends_with(".pdf");

    if !is_pdf {
        let receipt = state
            .service
            .read_file(&owner, &file)
            .map_err(|e| e.to_string())?;
        if receipt.bytes.len() > MAX_READ_BYTES {
            return Err("byte limit exceeded".to_string());
        }
        return Ok(ReadFileResult::NonPdf(receipt));
    }

    // Capture the exact capability and filesystem generation before I/O.
    let grant = state.workspace_grant(&owner, &file.workspace_id)?;
    let receipt = state
        .service
        .read_file_pdf(&owner, &file)
        .map_err(|e| e.to_string())?;

    if receipt.bytes.len() > MAX_PDF_BYTES {
        return Err("PDF byte limit exceeded".to_string());
    }
    validate_pdf(&receipt.bytes).map_err(|e| e.to_string())?;

    // Publication rechecks the captured grant under the same lifecycle lock
    // used by close/revoke.  It never mints a fresh capability after I/O.
    let token = state.publish_file_pdf(
        &owner,
        &file.workspace_id,
        &grant,
        file.path.clone(),
        receipt.revision.clone(),
        receipt.bytes,
    )?;

    Ok(ReadFileResult::Pdf(PdfReadMetadata {
        workspace_id: receipt.workspace_id,
        path: receipt.path,
        revision: receipt.revision,
        binary_token: token,
    }))
}

#[tauri::command]
pub fn frontend_take_file_pdf(
    window: WebviewWindow,
    state: State<'_, FrontendFilesState>,
    token: String,
) -> Result<IpcResponse, String> {
    let owner = verify_trusted_window(&window, &state)?;
    let owner_adm = state.ensure_owner_admission(&owner)?;
    let bytes = state
        .tokens
        .take_file_pdf(&owner_adm, &token)
        .map_err(|_| "TokenDenied".to_string())?;
    Ok(IpcResponse::new(bytes))
}

#[tauri::command]
pub fn frontend_write_file(
    window: WebviewWindow,
    state: State<'_, FrontendFilesState>,
    request: WriteRequest,
) -> Result<WriteReceipt, String> {
    let owner = verify_trusted_window(&window, &state)?;
    state
        .service
        .write_file(&owner, &request)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn frontend_save_as(
    window: WebviewWindow,
    state: State<'_, FrontendFilesState>,
    request: SaveAsRequest,
) -> Result<Option<SaveAsReceipt>, String> {
    let _owner = verify_trusted_window(&window, &state)?;
    let dialog = Arc::clone(state.dialog());
    let win = window.clone();

    let chosen_path = tauri::async_runtime::spawn_blocking(move || dialog.save_file(&win))
        .await
        .map_err(|e| e.to_string())?;

    let owner = verify_trusted_window(&window, &state)?;
    let _transition = state.lock_watch_transition();
    let mut lifecycle = state.lock_lifecycle();
    state.require_owner_live_locked(&lifecycle, &owner)?;
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    let opened_at = Timestamp::new(now_ms).map_err(|e| e.to_string())?;

    let maybe_outcome = state
        .service
        .save_as(&owner, &request, chosen_path.as_deref(), opened_at)
        .map_err(|e| e.to_string())?;

    if let Some(outcome) = maybe_outcome {
        if let Err(error) = state.admit_workspace_locked(
            &mut lifecycle,
            &owner,
            outcome.opened.workspace.id.clone(),
        ) {
            let _ = state
                .service
                .close_workspace(&owner, &outcome.opened.workspace.id);
            return Err(error);
        }
        Ok(Some(outcome.opened))
    } else {
        Ok(None)
    }
}

#[tauri::command]
pub fn frontend_watch_start(
    window: WebviewWindow,
    state: State<'_, FrontendFilesState>,
    workspace_id: WorkspaceId,
    subscription_id: String,
    generation: u64,
) -> Result<(), String> {
    let owner = verify_trusted_window(&window, &state)?;
    if !valid_watch_identity(&subscription_id, generation) {
        return Err("invalid subscription id".to_string());
    }
    // Reserve cleanup ownership before creating the filesystem task, native
    // watcher, or bridge thread.  The transition lock prevents a start from
    // installing after a concurrent close or owner revocation.
    let cleanup_permit = WatchCleanupPermit::reserve()?;
    let _transition = state.lock_watch_transition();
    {
        let lifecycle = state.lock_lifecycle();
        state.require_owner_live_locked(&lifecycle, &owner)?;
        state.workspace_grant_locked(&lifecycle, &owner, &workspace_id)?;
    }

    let previous = {
        let mut lifecycle = state.lock_lifecycle();
        let key = (owner.clone(), workspace_id.clone());
        if let Some(previous) = lifecycle.active_watches.remove(&key) {
            previous.delivery_gate.deactivate();
            previous.stopped.store(true, Ordering::Release);
            Some(previous)
        } else {
            None
        }
    };
    if let Some(previous) = previous {
        state.stop_active_watch_instance(&previous);
    }

    let stopped = Arc::new(AtomicBool::new(false));
    let failure_latched = Arc::new(AtomicBool::new(false));
    let delivery_gate = Arc::new(WatchDeliveryGate::new());
    let window_clone = window.clone();
    let sub_id = subscription_id.clone();
    let gen = generation;
    let expected_watch_workspace = workspace_id.clone();
    let stopped_for_sink = Arc::clone(&stopped);
    let failure_for_sink = Arc::clone(&failure_latched);
    let gate_for_sink = Arc::clone(&delivery_gate);

    let sink = Arc::new(move |notif: WatchNotification| {
        if stopped_for_sink.load(Ordering::Acquire) {
            return;
        }
        let Some(_delivery) = gate_for_sink.enter() else {
            return;
        };
        if stopped_for_sink.load(Ordering::Acquire) {
            return;
        }
        match notif {
            WatchNotification::Event(event) => {
                if failure_for_sink.load(Ordering::Acquire) {
                    return;
                }
                let _ = window_clone.emit(
                    "frontend://files/event",
                    &WatchEventMessage {
                        subscription_id: sub_id.clone(),
                        generation: gen,
                        event,
                    },
                );
            }
            WatchNotification::ResyncRequired {
                workspace_id: event_workspace_id,
                reason,
            } => {
                if failure_for_sink.load(Ordering::Acquire)
                    || event_workspace_id != expected_watch_workspace
                {
                    return;
                }
                let _ = window_clone.emit(
                    "frontend://files/resync",
                    &WatchResyncMessage {
                        subscription_id: sub_id.clone(),
                        generation: gen,
                        reason,
                    },
                );
            }
            WatchNotification::Failure { failure, .. } => {
                if failure_for_sink.swap(true, Ordering::AcqRel) {
                    return;
                }
                stopped_for_sink.store(true, Ordering::Release);
                let _ = window_clone.emit(
                    "frontend://files/error",
                    &WatchErrorMessage {
                        subscription_id: sub_id.clone(),
                        generation: gen,
                        failure,
                    },
                );
            }
        }
    });

    let active = spawn_watch_bridge(
        WatchBridgeIdentity {
            owner: owner.clone(),
            workspace_id: workspace_id.clone(),
            subscription_id,
            renderer_generation: generation,
        },
        &state.service,
        &state.native_watch,
        sink,
        cleanup_permit,
        stopped,
        Arc::clone(&delivery_gate),
    )?;

    let installed = {
        let mut lifecycle = state.lock_lifecycle();
        let current_grant = state.workspace_grant_locked(&lifecycle, &owner, &workspace_id);
        let still_current = state.require_owner_live_locked(&lifecycle, &owner).is_ok()
            && current_grant.is_ok()
            && !lifecycle
                .closing_workspaces
                .contains(&(owner.clone(), workspace_id.clone()));
        if still_current {
            lifecycle
                .active_watches
                .insert((owner.clone(), workspace_id), Arc::clone(&active));
            delivery_gate.activate()
        } else {
            false
        }
    };
    if !installed {
        active.request_cleanup();
        return Err("STALE_WORKSPACE".to_owned());
    }
    Ok(())
}

#[tauri::command]
pub fn frontend_watch_stop(
    window: WebviewWindow,
    state: State<'_, FrontendFilesState>,
    workspace_id: WorkspaceId,
    subscription_id: String,
    generation: u64,
) -> Result<(), String> {
    let owner = verify_trusted_window(&window, &state)?;
    let _ = state.stop_matching_watch(&owner, &workspace_id, &subscription_id, generation);
    Ok(())
}

#[tauri::command]
pub async fn frontend_close_workspace(
    window: WebviewWindow,
    state: State<'_, FrontendFilesState>,
    compile: State<'_, FrontendCompileState>,
    terminal_state: State<'_, FrontendTerminalState>,
    workspace_id: WorkspaceId,
) -> Result<(), String> {
    let owner = verify_trusted_window(&window, &state)?;

    if let Ok(generation) = state.service.workspace_generation(&owner, &workspace_id) {
        state
            .workspace_files
            .quiesce_workspace(&owner, &workspace_id)
            .map_err(|error| error.to_string())?;
        if state.workspace_files.has_recoveries(&owner, &workspace_id) {
            let access = match state
                .service
                .workspace_file_write_access(&owner, &workspace_id)
            {
                Ok(access) => access,
                Err(error) => {
                    state
                        .workspace_files
                        .abort_workspace_close(&owner, &workspace_id);
                    return Err(error.to_string());
                }
            };
            if let Err(error) = state.workspace_files.restore_workspace_recoveries(
                &owner,
                &workspace_id,
                generation,
                &access.root,
            ) {
                state
                    .workspace_files
                    .abort_workspace_close(&owner, &workspace_id);
                return Err(error.to_string());
            }
        }
        state
            .workspace_files
            .finish_workspace_close(&owner, &workspace_id);
    }

    let (watch, first_close) = state.begin_workspace_close(&owner, &workspace_id);
    if let Some(watch) = watch {
        state.stop_active_watch_instance(&watch);
    }
    compile.close_workspace(&owner, &workspace_id);
    let terminal_result = terminal_state.close_workspace(&owner, &workspace_id).await;
    let fs_result = if first_close {
        state
            .service
            .close_workspace(&owner, &workspace_id)
            .map_err(|e| e.to_string())
    } else {
        state
            .service
            .process_pending_cleanup(&owner, &workspace_id)
            .map_err(|e| e.to_string())
    };

    match (terminal_result, fs_result) {
        (Ok(()), Ok(())) => Ok(()),
        (Err(terminal_error), Ok(())) => Err(terminal_error.to_string()),
        (Ok(()), Err(filesystem_error)) => Err(filesystem_error),
        (Err(terminal_error), Err(filesystem_error)) => Err(format!(
            "terminal cleanup failed: {terminal_error}; filesystem cleanup failed: {filesystem_error}"
        )),
    }
}
#[cfg(test)]
#[path = "../../tests/unit/frontend_files.rs"]
mod tests;
