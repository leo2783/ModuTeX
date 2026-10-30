// SPDX-License-Identifier: Apache-2.0
//! App-lifetime state for owner-scoped Draft runs and paragraph daemons.

use std::sync::Arc;

use tauri::Manager;

use crate::{
    schemas::draft::{
        DraftCompileRequest, DraftDocumentResult, DraftError, DraftParagraphRequest,
        DraftSavePdfRequest, DraftWorkspaceRequest,
    },
    schemas::protocol::{OwnerId, WriteReceipt},
    services::draft_service::{DraftDelivery, DraftService},
    services::filesystem::FilesystemService,
};

#[derive(Clone)]
pub(crate) struct FrontendDraftState {
    service: DraftService,
}

impl FrontendDraftState {
    pub(crate) fn from_app(
        app: &tauri::App,
        filesystem: Arc<FilesystemService>,
    ) -> Result<Self, String> {
        let resource_dir = app
            .path()
            .resource_dir()
            .map_err(|error| error.to_string())?;
        let cache_dir = app
            .path()
            .app_cache_dir()
            .map_err(|error| error.to_string())?;
        let service = DraftService::new(filesystem, &resource_dir, &cache_dir)
            .map_err(|error| error.message)?;
        Ok(Self { service })
    }

    pub(crate) fn compile(
        &self,
        owner: &OwnerId,
        request: DraftCompileRequest,
    ) -> Result<DraftDelivery, DraftError> {
        self.service.compile(owner, request)
    }

    pub(crate) fn typeset_paragraph(
        &self,
        owner: &OwnerId,
        request: DraftParagraphRequest,
    ) -> Result<DraftDelivery, DraftError> {
        self.service.typeset_paragraph(owner, request)
    }

    pub(crate) fn stop(
        &self,
        owner: &OwnerId,
        request: &DraftWorkspaceRequest,
    ) -> Result<bool, DraftError> {
        self.service.stop(owner, &request.workspace_id)
    }

    pub(crate) fn takeover(
        &self,
        owner: &OwnerId,
        request: &DraftWorkspaceRequest,
    ) -> Result<bool, DraftError> {
        self.service.takeover(owner, &request.workspace_id)
    }

    pub(crate) fn cache_success(
        &self,
        owner: &OwnerId,
        delivery: &DraftDelivery,
        pdf: &[u8],
    ) -> Result<(), DraftError> {
        self.service.cache_success(owner, delivery, pdf)
    }

    pub(crate) fn save_pdf(
        &self,
        owner: &OwnerId,
        request: DraftSavePdfRequest,
    ) -> Result<WriteReceipt, DraftError> {
        self.service.save_pdf(owner, request)
    }

    pub(crate) fn revoke_owner(&self, owner: &OwnerId) -> Result<(), DraftError> {
        self.service.revoke_owner(owner)
    }

    pub(crate) fn publishable_result(
        mut delivery: DraftDelivery,
        pdf_token: Option<String>,
    ) -> DraftDocumentResult {
        delivery.result.pdf_token = pdf_token;
        delivery.result
    }
}
