// SPDX-License-Identifier: Apache-2.0
//! MCP host backed by the shared filesystem service and the live editor
//! rendezvous in registered Tauri document windows.

use std::time::Instant;

use serde_json::{json, Value};

use crate::{
    compile_config::{
        CompileConfigStore, CompileConfigUpdate, CompileConfigView, CompileOrigin, CompileProfile,
        CompileWorkspaceConfig,
    },
    schemas::protocol::{OwnerId, WorkspaceId},
    services::{
        filesystem::FilesystemError,
        mcp::{
            core::{
                CancellationToken, CompileConfig, CompileStartResult, DiagnosticsSnapshot,
                EditorSnapshot, EditorTabSnapshot, HostError, McpHost, McpOperation, McpReply,
                McpRequestId, McpViewMode, OpenFileResult, OperationAck, SessionContext,
                UnsavedSnapshot, ViewModeResult, WorkspaceRoute, WorkspaceSnapshot,
            },
            runtime::MCP_SERVICE_OWNER,
        },
    },
    shared::relative_path::RelativePath,
    state::mcp::{McpBridgeState, WindowRegistration},
};

pub struct McpDesktopHost {
    bridge: std::sync::Arc<McpBridgeState>,
    service_generation: u64,
    compile_config: CompileConfigStore,
}

impl McpDesktopHost {
    pub(crate) fn new(bridge: std::sync::Arc<McpBridgeState>, service_generation: u64) -> Self {
        let data_dir = bridge
            .filesystem()
            .settings_store()
            .data_dir()
            .to_path_buf();
        Self {
            bridge,
            service_generation,
            compile_config: CompileConfigStore::new(data_dir),
        }
    }

    fn validate_native_call(
        &self,
        route: &WorkspaceRoute,
        deadline: Instant,
        cancellation: &CancellationToken,
    ) -> Result<(), HostError> {
        cancellation.check(deadline)?;
        if !self.bridge.service_is_active(self.service_generation) {
            return Err(HostError::StaleOwner);
        }
        self.validate_route(route)?;
        cancellation.check(deadline)?;
        if !self.bridge.service_is_active(self.service_generation) {
            return Err(HostError::StaleOwner);
        }
        Ok(())
    }

    fn read_native_config(
        &self,
        route: &WorkspaceRoute,
        deadline: Instant,
        cancellation: &CancellationToken,
    ) -> Result<(CompileWorkspaceConfig, bool), HostError> {
        self.validate_native_call(route, deadline, cancellation)?;
        let value = self
            .compile_config
            .with_workspace_config_checked(
                self.bridge.filesystem().as_ref(),
                &route.owner,
                &route.workspace_id,
                CompileOrigin::Mcp,
                || {
                    self.validate_native_call(route, deadline, cancellation)
                        .map_err(native_validation_code)
                },
                |config, allowed| Ok((config.clone(), allowed)),
            )
            .map_err(|error| map_compile_config_error(&error))?;
        self.validate_native_call(route, deadline, cancellation)?;
        Ok(value)
    }

    fn update_native_config(
        &self,
        route: &WorkspaceRoute,
        request: CompileConfigUpdate,
        origin: CompileOrigin,
        deadline: Instant,
        cancellation: &CancellationToken,
    ) -> Result<CompileConfigView, HostError> {
        self.validate_native_call(route, deadline, cancellation)?;
        let view = self
            .compile_config
            .update_checked(
                self.bridge.filesystem().as_ref(),
                &route.owner,
                request,
                origin,
                || {
                    self.validate_native_call(route, deadline, cancellation)
                        .map_err(native_validation_code)
                },
            )
            .map_err(|error| map_compile_config_error(&error))?;
        self.validate_native_call(route, deadline, cancellation)?;
        Ok(view)
    }

    fn mcp_config_from_native(config: &CompileWorkspaceConfig, allowed: bool) -> CompileConfig {
        CompileConfig {
            command: config.custom_command.clone(),
            engine: compile_engine_name(config.profile).to_owned(),
            format: "pdf".to_owned(),
            output_dir: config.output_dir.clone(),
            pdf_path: config.pdf_path.clone(),
            log_path: config.log_path.clone(),
            can_set_command: allowed,
        }
    }

    fn mcp_config_from_view(view: &CompileConfigView) -> CompileConfig {
        CompileConfig {
            command: view.custom_command.clone(),
            engine: compile_engine_name(view.profile).to_owned(),
            format: "pdf".to_owned(),
            output_dir: view.output_dir.clone(),
            pdf_path: view.pdf_path.clone(),
            log_path: view.log_path.clone(),
            can_set_command: view.can_set_command,
        }
    }

    fn current_workspace_generation(
        &self,
        owner: &OwnerId,
        owner_generation: u64,
        workspace_id: &WorkspaceId,
    ) -> Result<u64, HostError> {
        self.bridge.validate_window(owner, owner_generation)?;
        self.bridge
            .filesystem()
            .workspace_generation(owner, workspace_id)
            .map(|generation| generation.get())
            .map_err(map_filesystem_error)
    }

    fn validate_route(&self, route: &WorkspaceRoute) -> Result<(), HostError> {
        let current = self.current_workspace_generation(
            &route.owner,
            route.owner_generation,
            &route.workspace_id,
        )?;
        if current != route.workspace_generation {
            return Err(HostError::StaleWorkspace);
        }
        let root = self
            .bridge
            .filesystem()
            .workspace_root_path(&route.owner, &route.workspace_id)
            .map_err(map_filesystem_error)?;
        if root.to_str() != Some(route.root.as_str()) {
            return Err(HostError::StaleWorkspace);
        }
        Ok(())
    }

    fn renderer_call(
        &self,
        route: &WorkspaceRoute,
        action: Value,
        deadline: Instant,
        cancellation: &CancellationToken,
    ) -> Result<Value, HostError> {
        self.validate_route(route)?;
        let registration = WindowRegistration {
            owner: route.owner.clone(),
            generation: route.owner_generation,
        };
        let result = self.bridge.request_renderer(
            self.service_generation,
            &registration,
            Some((route.workspace_id.clone(), route.workspace_generation)),
            action,
            deadline,
            cancellation,
        )?;
        self.validate_route(route)?;
        Ok(result)
    }

    fn workspace_snapshot(
        &self,
        registration: &WindowRegistration,
        value: &Value,
    ) -> Result<Option<WorkspaceSnapshot>, HostError> {
        let workspace_value = value
            .as_object()
            .and_then(|object| object.get("workspace"))
            .ok_or(HostError::InvalidSnapshot)?;
        if workspace_value.is_null() {
            return Ok(None);
        }
        let info: crate::schemas::protocol::WorkspaceInfo =
            serde_json::from_value(workspace_value.clone())
                .map_err(|_| HostError::InvalidSnapshot)?;
        let (_, trusted_info) = self
            .bridge
            .filesystem()
            .workspace_info(&registration.owner, &info.id)
            .map_err(map_filesystem_error)?;
        if trusted_info != info {
            return Err(HostError::StaleWorkspace);
        }
        let generation = self
            .bridge
            .filesystem()
            .workspace_generation(&registration.owner, &info.id)
            .map_err(map_filesystem_error)?
            .get();
        let root = self
            .bridge
            .filesystem()
            .workspace_root_path(&registration.owner, &info.id)
            .map_err(map_filesystem_error)?;
        let root = root.to_str().ok_or(HostError::InvalidSnapshot)?.to_owned();
        let object = value.as_object().ok_or(HostError::InvalidSnapshot)?;
        let active_path = optional_relative_path(object.get("activePath"))?;
        let main_file = optional_relative_path(object.get("mainFile"))?;
        let view_mode = match object.get("viewMode").and_then(Value::as_str) {
            Some("visual") => McpViewMode::Visual,
            Some("source") => McpViewMode::Source,
            Some("diff") => McpViewMode::Diff,
            _ => return Err(HostError::InvalidSnapshot),
        };
        let live_preview = object
            .get("livePreview")
            .and_then(Value::as_bool)
            .ok_or(HostError::InvalidSnapshot)?;
        let tabs_value = object
            .get("tabs")
            .and_then(Value::as_array)
            .ok_or(HostError::InvalidSnapshot)?;
        if tabs_value.len() > 4096 {
            return Err(HostError::InvalidSnapshot);
        }
        let tabs = tabs_value
            .iter()
            .cloned()
            .map(|tab| {
                serde_json::from_value::<EditorTabSnapshot>(tab)
                    .map_err(|_| HostError::InvalidSnapshot)
            })
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Some(WorkspaceSnapshot {
            id: info.id,
            owner: registration.owner.clone(),
            owner_generation: registration.generation,
            generation,
            root,
            label: info.label,
            entry_path: info.entry_path,
            active_path,
            main_file,
            view_mode,
            live_preview,
            tabs,
        }))
    }
    fn execute_renderer(
        &self,
        route: &WorkspaceRoute,
        operation: &McpOperation,
        deadline: Instant,
        cancellation: &CancellationToken,
    ) -> Result<McpReply, HostError> {
        self.validate_native_call(route, deadline, cancellation)?;
        let action = match operation {
            McpOperation::GetUnsaved => json!({"kind": "get_unsaved"}),
            McpOperation::GetDiagnostics => json!({"kind": "get_diagnostics"}),
            McpOperation::OpenFile { path, line } => json!({
                "kind": "open_file",
                "path": path.as_str(),
                "line": line.map(|line| line.get())
            }),
            McpOperation::ShowDiff { path } => json!({
                "kind": "show_diff",
                "path": path.as_ref().map(RelativePath::as_str)
            }),
            McpOperation::SetViewMode { mode } => json!({
                "kind": "set_view_mode",
                "mode": mode
            }),
            McpOperation::SyncTexToLine { line } => json!({
                "kind": "synctex_to_line",
                "line": line.get()
            }),
            McpOperation::SetMainFile { path } => json!({
                "kind": "set_main_file",
                "path": path.as_ref().map(RelativePath::as_str)
            }),
            McpOperation::Compile => json!({"kind": "compile"}),
            _ => return Err(HostError::InvalidInput),
        };
        let value = self.renderer_call(route, action, deadline, cancellation)?;
        match operation {
            McpOperation::GetUnsaved => serde_json::from_value::<UnsavedSnapshot>(value)
                .map(McpReply::Unsaved)
                .map_err(|_| HostError::InvalidReply),
            McpOperation::GetDiagnostics => serde_json::from_value::<DiagnosticsSnapshot>(value)
                .map(McpReply::Diagnostics)
                .map_err(|_| HostError::InvalidReply),
            McpOperation::OpenFile { .. } => serde_json::from_value::<OpenFileResult>(value)
                .map(McpReply::Opened)
                .map_err(|_| HostError::InvalidReply),
            McpOperation::ShowDiff { .. }
            | McpOperation::SyncTexToLine { .. }
            | McpOperation::SetMainFile { .. } => serde_json::from_value::<OperationAck>(value)
                .map(McpReply::Ack)
                .map_err(|_| HostError::InvalidReply),
            McpOperation::SetViewMode { .. } => serde_json::from_value::<ViewModeResult>(value)
                .map(McpReply::ViewMode)
                .map_err(|_| HostError::InvalidReply),
            McpOperation::Compile => serde_json::from_value::<CompileStartResult>(value)
                .map(McpReply::CompileStarted)
                .map_err(|_| HostError::InvalidReply),
            _ => Err(HostError::InvalidReply),
        }
    }
}

impl McpHost for McpDesktopHost {
    fn validate_session(&self, context: &SessionContext) -> Result<(), HostError> {
        if context.owner().as_str() != MCP_SERVICE_OWNER
            || context.generation() != self.service_generation
            || !self.bridge.service_is_active(self.service_generation)
            || self.bridge.live_window_count() == 0
        {
            return Err(HostError::StaleOwner);
        }
        Ok(())
    }

    fn editor_snapshot(
        &self,
        context: &SessionContext,
        deadline: Instant,
        cancellation: &CancellationToken,
    ) -> Result<EditorSnapshot, HostError> {
        self.validate_session(context)?;
        let mut registrations = self.bridge.registered_windows();
        registrations.sort_by(|left, right| left.owner.as_str().cmp(right.owner.as_str()));
        let focused_owner = self.bridge.focused_owner();
        let mut workspaces = Vec::new();
        let mut focused = None;
        for registration in registrations {
            cancellation.check(deadline)?;
            if self
                .bridge
                .validate_window(&registration.owner, registration.generation)
                .is_err()
            {
                continue;
            }
            let value = match self.bridge.request_renderer(
                self.service_generation,
                &registration,
                None,
                json!({"kind": "editor_state"}),
                deadline,
                cancellation,
            ) {
                Ok(value) => value,
                Err(HostError::StaleOwner) => continue,
                Err(error) => return Err(error),
            };
            let workspace = match self.workspace_snapshot(&registration, &value) {
                Ok(workspace) => workspace,
                Err(HostError::StaleWorkspace | HostError::NotFound) => continue,
                Err(error) => return Err(error),
            };
            let Some(workspace) = workspace else {
                continue;
            };
            if focused_owner.as_ref() == Some(&registration.owner) {
                focused = Some(workspace.id.clone());
            }
            workspaces.push(workspace);
        }
        self.validate_session(context)?;
        Ok(EditorSnapshot {
            focused,
            workspaces,
        })
    }

    fn execute(
        &self,
        route: &WorkspaceRoute,
        _request_id: &McpRequestId,
        operation: &McpOperation,
        deadline: Instant,
        cancellation: &CancellationToken,
    ) -> Result<McpReply, HostError> {
        self.validate_native_call(route, deadline, cancellation)?;
        match operation {
            McpOperation::GetCompileConfig => {
                let (config, allowed) = self.read_native_config(route, deadline, cancellation)?;
                Ok(McpReply::CompileConfig(Self::mcp_config_from_native(
                    &config, allowed,
                )))
            }
            McpOperation::SetMainFile { path } => {
                let (current, _) = self.read_native_config(route, deadline, cancellation)?;
                let request = CompileConfigUpdate {
                    workspace_id: route.workspace_id.clone(),
                    expected_revision: current.revision,
                    main_file: path.clone(),
                    profile: current.profile,
                    output_dir: current.output_dir.clone(),
                    pdf_path: current.pdf_path.clone(),
                    log_path: current.log_path.clone(),
                    custom_command: current.custom_command.clone(),
                };
                self.update_native_config(
                    route,
                    request,
                    CompileOrigin::McpPaths,
                    deadline,
                    cancellation,
                )?;
                // Persist natively, then retain the editor acknowledgement for this editor operation.
                self.execute_renderer(route, operation, deadline, cancellation)
            }
            McpOperation::SetOutputPaths {
                output_dir,
                pdf,
                log,
            } => {
                let (current, _) = self.read_native_config(route, deadline, cancellation)?;
                let request = CompileConfigUpdate {
                    workspace_id: route.workspace_id.clone(),
                    expected_revision: current.revision,
                    main_file: current.main_file.clone(),
                    profile: current.profile,
                    output_dir: output_dir.clone().or(current.output_dir.clone()),
                    pdf_path: pdf.clone().or(current.pdf_path.clone()),
                    log_path: log.clone().or(current.log_path.clone()),
                    custom_command: current.custom_command.clone(),
                };
                let view = self.update_native_config(
                    route,
                    request,
                    CompileOrigin::McpPaths,
                    deadline,
                    cancellation,
                )?;
                Ok(McpReply::OutputPaths(Self::mcp_config_from_view(&view)))
            }
            McpOperation::SetCompileCommand { command } => {
                let (current, _) = self.read_native_config(route, deadline, cancellation)?;
                let request = CompileConfigUpdate {
                    workspace_id: route.workspace_id.clone(),
                    expected_revision: current.revision,
                    main_file: current.main_file.clone(),
                    profile: CompileProfile::Custom,
                    output_dir: current.output_dir.clone(),
                    pdf_path: current.pdf_path.clone(),
                    log_path: current.log_path.clone(),
                    custom_command: Some(command.clone()),
                };
                self.update_native_config(
                    route,
                    request,
                    CompileOrigin::Mcp,
                    deadline,
                    cancellation,
                )?;
                Ok(McpReply::Ack(OperationAck {
                    ok: true,
                    reason: None,
                }))
            }
            _ => self.execute_renderer(route, operation, deadline, cancellation),
        }
    }

    fn compile_command_allowed(
        &self,
        route: &WorkspaceRoute,
        deadline: Instant,
        cancellation: &CancellationToken,
    ) -> Result<bool, HostError> {
        self.validate_native_call(route, deadline, cancellation)?;
        let allowed = self
            .bridge
            .filesystem()
            .settings_store()
            .mcp_compile_command_allowed()
            .map_err(|_| HostError::Unavailable)?;
        self.validate_native_call(route, deadline, cancellation)?;
        Ok(allowed)
    }
}

fn compile_engine_name(profile: CompileProfile) -> &'static str {
    match profile {
        CompileProfile::Managed => "managed",
        CompileProfile::System | CompileProfile::Custom => "system",
    }
}

fn native_validation_code(error: HostError) -> String {
    match error {
        HostError::StaleOwner => "STALE_OWNER",
        HostError::StaleWorkspace => "STALE_WORKSPACE",
        HostError::Timeout => "TIMEOUT",
        HostError::Cancelled => "CANCELLED",
        _ => "HOST_UNAVAILABLE",
    }
    .to_owned()
}

fn map_compile_config_error(error: &str) -> HostError {
    if error.contains("CONFIG_CONFLICT") {
        HostError::Conflict
    } else if error.contains("PERMISSION_DENIED") {
        HostError::PermissionDenied
    } else if error.contains("STALE_OWNER") {
        HostError::StaleOwner
    } else if error.contains("STALE_WORKSPACE") {
        HostError::StaleWorkspace
    } else if error.contains("TIMEOUT") {
        HostError::Timeout
    } else if error.contains("CANCELLED") {
        HostError::Cancelled
    } else if [
        "INVALID",
        "REQUIRED",
        "COLLISION",
        "OUTPUT_",
        "MAIN_FILE",
        "CUSTOM_COMMAND",
    ]
    .iter()
    .any(|part| error.contains(part))
    {
        HostError::InvalidInput
    } else {
        HostError::Unavailable
    }
}

fn optional_relative_path(value: Option<&Value>) -> Result<Option<RelativePath>, HostError> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(path)) => RelativePath::parse(path)
            .map(Some)
            .map_err(|_| HostError::InvalidSnapshot),
        _ => Err(HostError::InvalidSnapshot),
    }
}

fn map_filesystem_error(error: FilesystemError) -> HostError {
    match error {
        FilesystemError::UnknownWorkspace
        | FilesystemError::SessionClosed
        | FilesystemError::StaleGeneration
        | FilesystemError::StaleWorkspace => HostError::StaleWorkspace,
        FilesystemError::NotFound => HostError::NotFound,
        FilesystemError::AccessDenied => HostError::PermissionDenied,
        FilesystemError::RevisionConflict { .. } => HostError::Conflict,
        _ => HostError::Unavailable,
    }
}
