// SPDX-License-Identifier: Apache-2.0
//! App-lifetime Git coordinator backed by the existing FilesystemService task
//! registry and workspace lease coordinator.

use std::sync::Arc;

use serde::Serialize;

use crate::{
    schemas::protocol::{OwnerId, WorkspaceId},
    services::{
        filesystem::{FilesystemError, FilesystemErrorCode, FilesystemService, GitWorkspaceLease},
        git_native::{GitNativeRuntime, NativeGitRunner},
        git_service::{
            validate_discard_paths, GitAvailability, GitDiscardConfirmation, GitError,
            GitPathIntent, GitRunnerError, GitService, GitStatus, GitWorkspaceCapability,
        },
    },
    shared::relative_path::RelativePath,
    state::workspace_leases::LeaseKind,
};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommandFailure {
    pub code: String,
    pub message: String,
}

impl GitCommandFailure {
    pub(crate) fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }

    fn from_git(error: GitError) -> Self {
        Self::new(error.code(), error.to_string())
    }

    fn from_filesystem(error: FilesystemError) -> Self {
        let code = match error.code() {
            FilesystemErrorCode::UnknownWorkspace => "UNKNOWN_WORKSPACE",
            FilesystemErrorCode::SessionClosed => "WORKSPACE_CLOSED",
            FilesystemErrorCode::StaleGeneration | FilesystemErrorCode::StaleWorkspace => {
                "STALE_WORKSPACE"
            }
            FilesystemErrorCode::WorkspaceBusy => "WORKSPACE_BUSY",
            FilesystemErrorCode::Cancelled => "CANCELLED",
            FilesystemErrorCode::CleanupUnproven => "CLEANUP_UNPROVEN",
            FilesystemErrorCode::ResourceExhausted => "RESOURCE_EXHAUSTED",
            _ => "FILESYSTEM_ERROR",
        };
        Self::new(code, error.to_string())
    }
}

struct GitCoordinator {
    filesystem: Arc<FilesystemService>,
    runtime: Arc<GitNativeRuntime>,
    runner: Arc<NativeGitRunner>,
}

/// Cloneable Tauri-managed handle. Git's absence never prevents the filesystem
/// service or the desktop application from starting.
#[derive(Clone)]
pub struct FrontendGitState {
    inner: Arc<GitCoordinator>,
}

impl FrontendGitState {
    pub fn new(filesystem: Arc<FilesystemService>) -> Self {
        let runtime = Arc::new(GitNativeRuntime::discover());
        let runner = Arc::new(NativeGitRunner::new(Arc::clone(&runtime)));
        Self {
            inner: Arc::new(GitCoordinator {
                filesystem,
                runtime,
                runner,
            }),
        }
    }

    pub fn availability(&self) -> GitAvailability {
        self.inner.runtime.availability()
    }

    fn execute<T>(
        &self,
        owner: &OwnerId,
        workspace_id: &WorkspaceId,
        kind: LeaseKind,
        operation: impl FnOnce(&GitService<'_>, &GitWorkspaceLease) -> Result<T, GitError>,
    ) -> Result<T, GitCommandFailure> {
        let lease = self
            .inner
            .filesystem
            .start_git_task_with_kind(owner, workspace_id, kind)
            .map_err(GitCommandFailure::from_filesystem)?;
        let service = GitService::new(self.inner.runner.as_ref());
        let result = operation(&service, &lease);
        if matches!(
            &result,
            Err(GitError::Runner(GitRunnerError::CleanupUnproven))
        ) {
            return result.map_err(GitCommandFailure::from_git);
        }
        let cleanup = lease.finish();
        match cleanup {
            Ok(()) => result.map_err(GitCommandFailure::from_git),
            Err(error) => Err(GitCommandFailure::from_filesystem(error)),
        }
    }

    pub(crate) fn status(
        &self,
        owner: &OwnerId,
        workspace_id: &WorkspaceId,
    ) -> Result<GitStatus, GitCommandFailure> {
        self.execute(
            owner,
            workspace_id,
            LeaseKind::Read,
            |service, workspace| service.status(workspace),
        )
    }

    pub(crate) fn diff(
        &self,
        owner: &OwnerId,
        workspace_id: &WorkspaceId,
        staged: bool,
        paths: Vec<RelativePath>,
    ) -> Result<Vec<u8>, GitCommandFailure> {
        self.execute(
            owner,
            workspace_id,
            LeaseKind::Read,
            |service, workspace| service.diff(workspace, staged, &paths),
        )
    }

    pub(crate) fn log(
        &self,
        owner: &OwnerId,
        workspace_id: &WorkspaceId,
    ) -> Result<Vec<u8>, GitCommandFailure> {
        self.execute(
            owner,
            workspace_id,
            LeaseKind::Read,
            |service, workspace| service.log(workspace),
        )
    }

    pub(crate) fn show(
        &self,
        owner: &OwnerId,
        workspace_id: &WorkspaceId,
    ) -> Result<Vec<u8>, GitCommandFailure> {
        self.execute(
            owner,
            workspace_id,
            LeaseKind::Read,
            |service, workspace| service.show_head(workspace),
        )
    }

    pub(crate) fn init(
        &self,
        owner: &OwnerId,
        workspace_id: &WorkspaceId,
    ) -> Result<(), GitCommandFailure> {
        self.execute(
            owner,
            workspace_id,
            LeaseKind::Save,
            |service, workspace| service.init(workspace),
        )
    }

    pub(crate) fn stage(
        &self,
        owner: &OwnerId,
        workspace_id: &WorkspaceId,
        paths: Vec<RelativePath>,
    ) -> Result<(), GitCommandFailure> {
        self.execute(
            owner,
            workspace_id,
            LeaseKind::Save,
            |service, workspace| service.stage(workspace, &paths),
        )
    }

    pub(crate) fn unstage(
        &self,
        owner: &OwnerId,
        workspace_id: &WorkspaceId,
        paths: Vec<RelativePath>,
    ) -> Result<(), GitCommandFailure> {
        self.execute(
            owner,
            workspace_id,
            LeaseKind::Save,
            |service, workspace| service.unstage(workspace, &paths),
        )
    }

    pub(crate) fn discard(
        &self,
        owner: &OwnerId,
        workspace_id: &WorkspaceId,
        paths: Vec<RelativePath>,
        confirm: impl FnOnce() -> bool,
    ) -> Result<bool, GitCommandFailure> {
        self.execute(
            owner,
            workspace_id,
            LeaseKind::Save,
            |service, workspace| {
                // Validate the exact selection and its current host-owned paths
                // before asking the user to authorize a destructive operation.
                validate_discard_paths(&paths)?;
                workspace.check_current()?;
                for path in &paths {
                    workspace.validate_path(path, GitPathIntent::Discard)?;
                }
                if !confirm() {
                    return Ok(false);
                }
                let confirmation = GitDiscardConfirmation::issue(workspace, &paths)?;
                service.discard(workspace, &paths, &confirmation)?;
                Ok(true)
            },
        )
    }

    pub(crate) fn commit(
        &self,
        owner: &OwnerId,
        workspace_id: &WorkspaceId,
        message: String,
    ) -> Result<Vec<u8>, GitCommandFailure> {
        self.execute(
            owner,
            workspace_id,
            LeaseKind::Save,
            |service, workspace| service.commit(workspace, &message),
        )
    }

    pub(crate) fn user_name(
        &self,
        owner: &OwnerId,
        workspace_id: &WorkspaceId,
    ) -> Result<Option<String>, GitCommandFailure> {
        self.execute(
            owner,
            workspace_id,
            LeaseKind::Read,
            |service, workspace| service.user_name(workspace),
        )
    }
}
