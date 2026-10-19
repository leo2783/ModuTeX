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
        validate_pdf, FileEntry, FileEvent, FileRef, FileWatchFailure,
        OwnerId, ReadReceipt, RecentDocument, RecentId, Revision, SaveAsReceipt, SaveAsRequest,
        Timestamp, WorkspaceId, WorkspaceInfo, WorkspaceKind, WriteReceipt, WriteRequest,
        MAX_PDF_BYTES, MAX_READ_BYTES,
    },
    services::{
        file_watch::{
            spawn_watch_bridge, valid_watch_identity, WatchCleanupPermit, WatchDeliveryGate,
        },
        filesystem::WatchNotification,
    },
    shared::relative_path::RelativePath,
    state::desktop::FrontendFilesState,
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
    let owner = OwnerId::from_label(window.label()).map_err(|_| {
        "access denied: untrusted window".to_owned()
    })?;
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
        WorkspaceKind::Folder => state.service.open_workspace_folder(&owner, &path, None, opened_at),
        WorkspaceKind::File => state.service.open_workspace_file(&owner, &path, opened_at),
    }
    .map_err(|e| e.to_string())?;
    if let Err(error) =
        state.admit_workspace_locked(&mut lifecycle, &owner, outcome.opened.id.clone())
    {
        let _ = state
            .service
            .close_workspace(&owner, &outcome.opened.id);
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
        let _ = state
            .service
            .close_workspace(&owner, &outcome.opened.id);
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
    state.service.remove_recent(id.as_str()).map_err(|e| e.to_string())?;
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
    state.service.list_files(&owner, &workspace_id).map_err(|e| e.to_string())
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
        let receipt = state.service.read_file(&owner, &file).map_err(|e| e.to_string())?;
        if receipt.bytes.len() > MAX_READ_BYTES {
            return Err("byte limit exceeded".to_string());
        }
        return Ok(ReadFileResult::NonPdf(receipt));
    }

    // Capture the exact capability and filesystem generation before I/O.
    let grant = state.workspace_grant(&owner, &file.workspace_id)?;
    let receipt = state.service.read_file_pdf(&owner, &file).map_err(|e| e.to_string())?;

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
    state.service.write_file(&owner, &request).map_err(|e| e.to_string())
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

    let chosen_path = tauri::async_runtime::spawn_blocking(move || {
        dialog.save_file(&win)
    })
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
        owner.clone(),
        workspace_id.clone(),
        subscription_id,
        generation,
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
        let still_current = state
            .require_owner_live_locked(&lifecycle, &owner)
            .is_ok()
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
pub fn frontend_close_workspace(
    window: WebviewWindow,
    state: State<'_, FrontendFilesState>,
    workspace_id: WorkspaceId,
) -> Result<(), String> {
    let owner = verify_trusted_window(&window, &state)?;
    let (watch, first_close) = state.begin_workspace_close(&owner, &workspace_id);
    if let Some(watch) = watch {
        state.stop_active_watch_instance(&watch);
    }
    if first_close {
        state.service.close_workspace(&owner, &workspace_id).map_err(|e| e.to_string())
    } else {
        state.service.process_pending_cleanup(&owner, &workspace_id).map_err(|e| e.to_string())
    }
}

#[cfg(test)]
#[path = "../../tests/unit/frontend_files.rs"]
mod tests;
