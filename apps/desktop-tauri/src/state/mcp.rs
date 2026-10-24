// SPDX-License-Identifier: Apache-2.0
//! Host-owned MCP window registration and renderer rendezvous.
//!
//! Workspace and owner generations are minted and checked by host state.
//! Renderer replies can only satisfy the pending request addressed to their
//! own registered Tauri window.

use std::{
    collections::HashMap,
    sync::{
        mpsc::{self, SyncSender},
        Arc, Mutex, MutexGuard, PoisonError,
    },
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};

use crate::{
    schemas::protocol::{OwnerId, WorkspaceId, MAX_SAFE_INTEGER},
    services::filesystem::FilesystemService,
    services::mcp::core::{CancellationToken, HostError},
};

const RENDERER_REQUEST_EVENT: &str = "frontend://mcp/request";
const RENDERER_CANCEL_EVENT: &str = "frontend://mcp/cancel";
const MAX_RENDERER_REPLY_BYTES: usize = 64 * 1024 * 1024;
const MAX_REGISTERED_WINDOWS: usize = 64;

#[derive(Clone)]
pub(crate) struct WindowRegistration {
    pub(crate) owner: OwnerId,
    pub(crate) generation: u64,
}

struct PendingRendererCall {
    owner: OwnerId,
    owner_generation: u64,
    service_generation: u64,
    mcp_compile: bool,
    workspace_id: Option<WorkspaceId>,
    workspace_generation: Option<u64>,
    sender: SyncSender<Result<Value, HostError>>,
}

struct BridgeInner {
    owners: HashMap<OwnerId, u64>,
    focused: Option<OwnerId>,
    next_owner_generation: u64,
    next_request_id: u64,
    next_service_generation: u64,
    service_generation: Option<u64>,
    pending: HashMap<u64, PendingRendererCall>,
}

pub struct McpBridgeState {
    app: AppHandle,
    filesystem: Arc<FilesystemService>,
    inner: Mutex<BridgeInner>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RendererRequest {
    request_id: u64,
    owner_generation: u64,
    workspace_id: Option<WorkspaceId>,
    workspace_generation: Option<u64>,
    action: Value,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RendererCancel {
    request_id: u64,
    owner_generation: u64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct McpRendererReply {
    pub request_id: u64,
    pub owner_generation: u64,
    pub workspace_id: Option<WorkspaceId>,
    pub workspace_generation: Option<u64>,
    pub value: Value,
    pub error: Option<McpRendererError>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct McpRendererError {
    pub code: String,
}

impl McpBridgeState {
    pub fn new(app: AppHandle, filesystem: Arc<FilesystemService>) -> Self {
        Self {
            app,
            filesystem,
            inner: Mutex::new(BridgeInner {
                owners: HashMap::new(),
                focused: None,
                next_owner_generation: 1,
                next_request_id: 1,
                next_service_generation: 1,
                service_generation: None,
                pending: HashMap::new(),
            }),
        }
    }

    fn lock(&self) -> MutexGuard<'_, BridgeInner> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Called only after the same label has been registered by
    /// `FrontendFilesState` as a trusted document window.
    pub fn register_window(&self, owner: OwnerId) -> Result<(), String> {
        let mut inner = self.lock();
        if owner.as_str() == "mcp_service" || inner.owners.contains_key(&owner) {
            return Err("document window is already registered".to_owned());
        }
        if inner.owners.len() >= MAX_REGISTERED_WINDOWS {
            return Err("document window capacity exceeded".to_owned());
        }
        let generation = inner.next_owner_generation;
        if generation == 0 || generation > MAX_SAFE_INTEGER {
            return Err("document window generations are exhausted".to_owned());
        }
        inner.next_owner_generation = generation
            .checked_add(1)
            .ok_or_else(|| "document window generations are exhausted".to_owned())?;
        inner.owners.insert(owner, generation);
        Ok(())
    }

    pub fn set_focused(&self, owner: &OwnerId) {
        let mut inner = self.lock();
        if inner.owners.contains_key(owner) {
            inner.focused = Some(owner.clone());
        }
    }

    pub fn close_window(&self, owner: &OwnerId) {
        let pending = {
            let mut inner = self.lock();
            inner.owners.remove(owner);
            if inner.focused.as_ref() == Some(owner) {
                inner.focused = None;
            }
            let ids = inner
                .pending
                .iter()
                .filter(|(_, call)| &call.owner == owner)
                .map(|(id, _)| *id)
                .collect::<Vec<_>>();
            ids.into_iter()
                .filter_map(|id| inner.pending.remove(&id).map(|call| (id, call)))
                .collect::<Vec<_>>()
        };
        self.cancel_calls(pending, HostError::StaleOwner);
    }

    pub(crate) fn registered_windows(&self) -> Vec<WindowRegistration> {
        self.lock()
            .owners
            .iter()
            .map(|(owner, generation)| WindowRegistration {
                owner: owner.clone(),
                generation: *generation,
            })
            .collect()
    }

    pub(crate) fn registered_window_generation(&self, owner: &OwnerId) -> Result<u64, String> {
        self.lock()
            .owners
            .get(owner)
            .copied()
            .ok_or_else(|| "access denied: unregistered document window".to_owned())
    }

    pub(crate) fn focused_owner(&self) -> Option<OwnerId> {
        self.lock().focused.clone()
    }

    pub(crate) fn live_window_count(&self) -> usize {
        self.lock().owners.len()
    }

    pub(crate) fn filesystem(&self) -> &Arc<FilesystemService> {
        &self.filesystem
    }

    pub(crate) fn validate_window(
        &self,
        owner: &OwnerId,
        generation: u64,
    ) -> Result<(), HostError> {
        if self.lock().owners.get(owner).copied() == Some(generation) {
            Ok(())
        } else {
            Err(HostError::StaleOwner)
        }
    }

    pub(crate) fn authorize_window_label(&self, label: &str) -> Result<OwnerId, String> {
        let owner = OwnerId::from_label(label).map_err(|_| "access denied".to_owned())?;
        if self.lock().owners.contains_key(&owner) {
            Ok(owner)
        } else {
            Err("access denied: unregistered document window".to_owned())
        }
    }

    pub(crate) fn activate_service(&self) -> Result<u64, String> {
        let mut inner = self.lock();
        if inner.service_generation.is_some() {
            return Err("MCP service is already active".to_owned());
        }
        if inner.owners.is_empty() {
            return Err("MCP service requires a live document window".to_owned());
        }
        let generation = inner.next_service_generation;
        if generation == 0 || generation > MAX_SAFE_INTEGER {
            return Err("MCP service generations are exhausted".to_owned());
        }
        inner.next_service_generation = generation
            .checked_add(1)
            .ok_or_else(|| "MCP service generations are exhausted".to_owned())?;
        inner.service_generation = Some(generation);
        Ok(generation)
    }

    pub(crate) fn service_is_active(&self, generation: u64) -> bool {
        self.lock().service_generation == Some(generation)
    }

    pub(crate) fn deactivate_service(&self, generation: u64) {
        let pending = {
            let mut inner = self.lock();
            if inner.service_generation != Some(generation) {
                return;
            }
            inner.service_generation = None;
            let ids = inner.pending.keys().copied().collect::<Vec<_>>();
            ids.into_iter()
                .filter_map(|id| inner.pending.remove(&id).map(|call| (id, call)))
                .collect::<Vec<_>>()
        };
        self.cancel_calls(pending, HostError::Cancelled);
    }

    pub(crate) fn deactivate_current_service(&self) -> bool {
        let pending = {
            let mut inner = self.lock();
            if inner.service_generation.take().is_none() {
                return false;
            }
            let ids = inner.pending.keys().copied().collect::<Vec<_>>();
            ids.into_iter()
                .filter_map(|id| inner.pending.remove(&id).map(|call| (id, call)))
                .collect::<Vec<_>>()
        };
        self.cancel_calls(pending, HostError::Cancelled);
        true
    }

    /// The compile origin is derived from a host-owned pending request, never renderer data.
    pub(crate) fn is_mcp_compile_pending(
        &self,
        owner: &OwnerId,
        workspace_id: &WorkspaceId,
    ) -> bool {
        let generation = match self.filesystem.workspace_generation(owner, workspace_id) {
            Ok(generation) => generation.get(),
            Err(_) => return false,
        };
        let inner = self.lock();
        inner.pending.values().any(|call| {
            call.mcp_compile
                && &call.owner == owner
                && call.workspace_id.as_ref() == Some(workspace_id)
                && call.workspace_generation == Some(generation)
                && inner.owners.get(owner) == Some(&call.owner_generation)
                && inner.service_generation == Some(call.service_generation)
        })
    }

    fn cancel_calls(&self, pending: Vec<(u64, PendingRendererCall)>, reason: HostError) {
        for (request_id, call) in pending {
            let _ = call.sender.send(Err(reason));
            if let Some(window) = self.app.get_webview_window(call.owner.as_str()) {
                let _ = window.emit(
                    RENDERER_CANCEL_EVENT,
                    &RendererCancel {
                        request_id,
                        owner_generation: call.owner_generation,
                    },
                );
            }
        }
    }

    pub(crate) fn request_renderer(
        &self,
        service_generation: u64,
        registration: &WindowRegistration,
        workspace: Option<(WorkspaceId, u64)>,
        action: Value,
        deadline: Instant,
        cancellation: &CancellationToken,
    ) -> Result<Value, HostError> {
        let (workspace_id, workspace_generation) = match workspace {
            Some((workspace_id, generation)) => (Some(workspace_id), Some(generation)),
            None => (None, None),
        };
        let mcp_compile = action.get("kind").and_then(Value::as_str) == Some("compile");
        let (sender, receiver) = mpsc::sync_channel(1);
        let (request_id, request) = {
            let mut inner = self.lock();
            if inner.service_generation != Some(service_generation) {
                return Err(HostError::StaleOwner);
            }
            if inner.owners.get(&registration.owner).copied() != Some(registration.generation) {
                return Err(HostError::StaleOwner);
            }
            let request_id = inner.next_request_id;
            if request_id == 0 || request_id > MAX_SAFE_INTEGER {
                return Err(HostError::Capacity);
            }
            inner.next_request_id = request_id.checked_add(1).ok_or(HostError::Capacity)?;
            inner.pending.insert(
                request_id,
                PendingRendererCall {
                    owner: registration.owner.clone(),
                    owner_generation: registration.generation,
                    service_generation,
                    mcp_compile,
                    workspace_id: workspace_id.clone(),
                    workspace_generation,
                    sender,
                },
            );
            (
                request_id,
                RendererRequest {
                    request_id,
                    owner_generation: registration.generation,
                    workspace_id,
                    workspace_generation,
                    action,
                },
            )
        };

        let Some(window) = self.app.get_webview_window(registration.owner.as_str()) else {
            self.lock().pending.remove(&request_id);
            return Err(HostError::StaleOwner);
        };
        if window.emit(RENDERER_REQUEST_EVENT, &request).is_err() {
            self.lock().pending.remove(&request_id);
            return Err(HostError::Unavailable);
        }

        loop {
            if cancellation.is_cancelled() {
                self.cancel_pending(request_id);
                return Err(HostError::Cancelled);
            }
            let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
                self.cancel_pending(request_id);
                return Err(HostError::Timeout);
            };
            match receiver.recv_timeout(remaining.min(Duration::from_millis(20))) {
                Ok(result) => return result,
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    if self
                        .validate_window(&registration.owner, registration.generation)
                        .is_err()
                    {
                        self.lock().pending.remove(&request_id);
                        return Err(HostError::StaleOwner);
                    }
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return Err(HostError::Unavailable);
                }
            }
        }
    }

    fn cancel_pending(&self, request_id: u64) {
        if let Some(call) = self.lock().pending.remove(&request_id) {
            if let Some(window) = self.app.get_webview_window(call.owner.as_str()) {
                let _ = window.emit(
                    RENDERER_CANCEL_EVENT,
                    &RendererCancel {
                        request_id,
                        owner_generation: call.owner_generation,
                    },
                );
            }
        }
    }

    pub fn reply_from_window(
        &self,
        owner: &OwnerId,
        reply: McpRendererReply,
    ) -> Result<(), String> {
        if reply.request_id == 0
            || reply.request_id > MAX_SAFE_INTEGER
            || reply.owner_generation == 0
            || reply.owner_generation > MAX_SAFE_INTEGER
            || reply
                .workspace_generation
                .is_some_and(|generation| generation == 0 || generation > MAX_SAFE_INTEGER)
            || reply.workspace_id.is_some() != reply.workspace_generation.is_some()
            || reply
                .error
                .as_ref()
                .is_some_and(|error| !valid_renderer_error_code(&error.code))
            || reply.error.is_some() && !reply.value.is_null()
        {
            return Err("invalid MCP renderer response".to_owned());
        }
        let mut nodes = 0;
        let mut size = 0;
        if !bounded_value_size(&reply.value, 0, &mut nodes, &mut size) {
            return Err("MCP renderer response exceeds its byte limit".to_owned());
        }

        let (sender, result) = {
            let mut inner = self.lock();
            if inner.owners.get(owner).copied() != Some(reply.owner_generation) {
                return Err("access denied: stale renderer generation".to_owned());
            }
            let Some(pending) = inner.pending.get(&reply.request_id) else {
                return Err("MCP renderer request is no longer pending".to_owned());
            };
            if &pending.owner != owner
                || pending.owner_generation != reply.owner_generation
                || pending.workspace_id != reply.workspace_id
                || pending.workspace_generation != reply.workspace_generation
            {
                return Err("access denied: MCP renderer response identity mismatch".to_owned());
            }
            let pending = inner
                .pending
                .remove(&reply.request_id)
                .ok_or_else(|| "MCP renderer request is no longer pending".to_owned())?;
            let result = match reply.error {
                None => Ok(reply.value),
                Some(error) => Err(renderer_error(&error.code)),
            };
            (pending.sender, result)
        };
        sender
            .send(result)
            .map_err(|_| "MCP host request has already ended".to_owned())
    }
}

fn valid_renderer_error_code(code: &str) -> bool {
    !code.is_empty()
        && code.len() <= 64
        && code
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
}

fn json_string_wire_len(text: &str) -> usize {
    let mut len = 2usize;
    for &b in text.as_bytes() {
        let escaped_len = match b {
            b'"' | b'\\' | b'\x08' | b'\x0c' | b'\n' | b'\r' | b'\t' => 2,
            0x00..=0x1f => 6,
            _ => 1,
        };
        len = len.saturating_add(escaped_len);
    }
    len
}

fn bounded_value_size(value: &Value, depth: usize, nodes: &mut usize, size: &mut usize) -> bool {
    *nodes += 1;
    if depth > 32 || *nodes > 20_000 {
        return false;
    }
    let add = |size: &mut usize, amount: usize| {
        *size = size.saturating_add(amount);
        *size <= MAX_RENDERER_REPLY_BYTES
    };
    match value {
        Value::Null => add(size, 4),
        Value::Bool(true) => add(size, 4),
        Value::Bool(false) => add(size, 5),
        Value::Number(number) => add(size, number.to_string().len()),
        Value::String(text) => add(size, json_string_wire_len(text)),
        Value::Array(items) => {
            if items.len() > 4096 || !add(size, 2) {
                return false;
            }
            for (index, item) in items.iter().enumerate() {
                if (index > 0 && !add(size, 1)) || !bounded_value_size(item, depth + 1, nodes, size)
                {
                    return false;
                }
            }
            true
        }
        Value::Object(items) => {
            if items.len() > 4096 || !add(size, 2) {
                return false;
            }
            for (index, (key, item)) in items.iter().enumerate() {
                if key.len() > 4096
                    || (index > 0 && !add(size, 1))
                    || !add(size, json_string_wire_len(key).saturating_add(1))
                    || !bounded_value_size(item, depth + 1, nodes, size)
                {
                    return false;
                }
            }
            true
        }
    }
}

fn renderer_error(code: &str) -> HostError {
    match code {
        "STALE_OWNER" => HostError::StaleOwner,
        "STALE_WORKSPACE" => HostError::StaleWorkspace,
        "WORKSPACE_NOT_FOUND" => HostError::WorkspaceNotFound,
        "AMBIGUOUS_WORKSPACE" => HostError::AmbiguousWorkspace,
        "NO_FOCUSED_WORKSPACE" => HostError::NoFocusedWorkspace,
        "NOT_GIT_REPOSITORY" => HostError::NotGitRepository,
        "NOT_FOUND" => HostError::NotFound,
        "CONFLICT" | "FILE_CONFLICT" => HostError::Conflict,
        "PERMISSION_DENIED" => HostError::PermissionDenied,
        "INVALID_INPUT" => HostError::InvalidInput,
        "TIMEOUT" => HostError::Timeout,
        "CANCELLED" => HostError::Cancelled,
        "CAPACITY" | "BUSY" => HostError::Capacity,
        _ => HostError::Unavailable,
    }
}

#[cfg(test)]
#[path = "../../tests/unit/mcp_reply_limit.rs"]
mod reviewer_reply_limit_tests;
