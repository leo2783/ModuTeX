// SPDX-License-Identifier: Apache-2.0
//! Main-window-only, owner-checked commands for the native Draft service.

use tauri::{State, WebviewWindow};

use crate::{
    commands::frontend_files::verify_trusted_window,
    schemas::draft::{
        DraftCompileRequest, DraftDocumentResult, DraftError, DraftErrorCode,
        DraftParagraphRequest, DraftSavePdfRequest, DraftSavedPdfReceipt, DraftStopReceipt,
        DraftTakeoverReceipt, DraftWorkspaceRequest,
    },
    schemas::protocol::OwnerId,
    state::desktop::FrontendFilesState,
    state::draft::FrontendDraftState,
};

fn denied() -> DraftError {
    DraftError::new(
        DraftErrorCode::WorkspaceDenied,
        "The calling window is not authorized for this Draft workspace.",
    )
}

fn trusted_owner(
    window: &WebviewWindow,
    files: &FrontendFilesState,
) -> Result<OwnerId, DraftError> {
    verify_trusted_window(window, files).map_err(|_| denied())
}

fn publish_delivery(
    files: &FrontendFilesState,
    draft: &FrontendDraftState,
    owner: &OwnerId,
    mut delivery: crate::services::draft_service::DraftDelivery,
) -> Result<DraftDocumentResult, DraftError> {
    let mut token = None;
    if let Some(pdf) = delivery.pdf.take() {
        draft.cache_success(owner, &delivery, &pdf)?;
        let identity = &delivery.result.identity;
        let grant = files
            .workspace_grant(owner, &identity.workspace_id)
            .map_err(|_| denied())?;
        token = Some(
            files
                .publish_file_pdf(
                    owner,
                    &identity.workspace_id,
                    &grant,
                    identity.entry_path.clone(),
                    identity.saved_revision.clone(),
                    pdf,
                )
                .map_err(|_| {
                    DraftError::new(
                        DraftErrorCode::StaleWorkspace,
                        "The workspace changed before the Draft PDF could be published.",
                    )
                })?,
        );
    }
    Ok(FrontendDraftState::publishable_result(delivery, token))
}

#[tauri::command]
pub(crate) async fn frontend_draft_compile(
    window: WebviewWindow,
    files: State<'_, FrontendFilesState>,
    draft: State<'_, FrontendDraftState>,
    request: DraftCompileRequest,
) -> Result<DraftDocumentResult, DraftError> {
    let owner = trusted_owner(&window, &files)?;
    files
        .workspace_grant(&owner, &request.workspace_id)
        .map_err(|_| denied())?;
    let runtime = (*draft).clone();
    let run_owner = owner.clone();
    let delivery =
        tauri::async_runtime::spawn_blocking(move || runtime.compile(&run_owner, request))
            .await
            .map_err(|_| DraftError::new(DraftErrorCode::Internal, "Draft worker failed."))??;
    let owner = trusted_owner(&window, &files)?;
    publish_delivery(&files, &draft, &owner, delivery)
}

#[tauri::command]
pub(crate) async fn frontend_draft_typeset_paragraph(
    window: WebviewWindow,
    files: State<'_, FrontendFilesState>,
    draft: State<'_, FrontendDraftState>,
    request: DraftParagraphRequest,
) -> Result<DraftDocumentResult, DraftError> {
    let owner = trusted_owner(&window, &files)?;
    files
        .workspace_grant(&owner, &request.workspace_id)
        .map_err(|_| denied())?;
    let runtime = (*draft).clone();
    let run_owner = owner.clone();
    let delivery = tauri::async_runtime::spawn_blocking(move || {
        runtime.typeset_paragraph(&run_owner, request)
    })
    .await
    .map_err(|_| DraftError::new(DraftErrorCode::Internal, "Draft paragraph worker failed."))??;
    let owner = trusted_owner(&window, &files)?;
    publish_delivery(&files, &draft, &owner, delivery)
}

#[tauri::command]
pub(crate) async fn frontend_draft_stop(
    window: WebviewWindow,
    files: State<'_, FrontendFilesState>,
    draft: State<'_, FrontendDraftState>,
    request: DraftWorkspaceRequest,
) -> Result<DraftStopReceipt, DraftError> {
    let owner = trusted_owner(&window, &files)?;
    files
        .workspace_grant(&owner, &request.workspace_id)
        .map_err(|_| denied())?;
    let runtime = (*draft).clone();
    let stopped = tauri::async_runtime::spawn_blocking(move || runtime.stop(&owner, &request))
        .await
        .map_err(|_| DraftError::new(DraftErrorCode::Internal, "Draft stop worker failed."))??;
    Ok(DraftStopReceipt { stopped })
}

#[tauri::command]
pub(crate) async fn frontend_draft_takeover(
    window: WebviewWindow,
    files: State<'_, FrontendFilesState>,
    draft: State<'_, FrontendDraftState>,
    request: DraftWorkspaceRequest,
) -> Result<DraftTakeoverReceipt, DraftError> {
    let owner = trusted_owner(&window, &files)?;
    files
        .workspace_grant(&owner, &request.workspace_id)
        .map_err(|_| denied())?;
    let runtime = (*draft).clone();
    let preempted =
        tauri::async_runtime::spawn_blocking(move || runtime.takeover(&owner, &request))
            .await
            .map_err(|_| {
                DraftError::new(DraftErrorCode::Internal, "Draft takeover worker failed.")
            })??;
    Ok(DraftTakeoverReceipt { preempted })
}

#[tauri::command]
pub(crate) async fn frontend_draft_save_pdf(
    window: WebviewWindow,
    files: State<'_, FrontendFilesState>,
    draft: State<'_, FrontendDraftState>,
    request: DraftSavePdfRequest,
) -> Result<DraftSavedPdfReceipt, DraftError> {
    let owner = trusted_owner(&window, &files)?;
    files
        .workspace_grant(&owner, &request.workspace_id)
        .map_err(|_| denied())?;
    let runtime = (*draft).clone();
    let write = tauri::async_runtime::spawn_blocking(move || runtime.save_pdf(&owner, request))
        .await
        .map_err(|_| {
            DraftError::new(DraftErrorCode::Internal, "Draft PDF save worker failed.")
        })??;
    Ok(DraftSavedPdfReceipt { write })
}
