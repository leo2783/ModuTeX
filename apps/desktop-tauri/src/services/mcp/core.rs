// SPDX-License-Identifier: Apache-2.0
//! Typed MCP application operations. rmcp owns protocol negotiation,
//! request IDs, JSON-RPC, and transport framing.

use std::{
    collections::{HashMap, HashSet},
    fmt,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, MutexGuard,
    },
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::{
    schemas::protocol::{DocumentId, OwnerId, Position, Severity, WorkspaceId, MAX_SAFE_INTEGER},
    shared::relative_path::RelativePath,
};

pub const MAX_REQUEST_BYTES: usize = 1024 * 1024;
pub const MAX_RESPONSE_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_PENDING_PER_SESSION: usize = 8;
pub const MAX_PENDING_TOTAL: usize = 128;
pub const MAX_MCP_SESSIONS: usize = 128;
pub const TOOL_REPLY_TIMEOUT: Duration = Duration::from_secs(2);

const MAX_WORKSPACES: usize = 64;
const MAX_EDITOR_TABS: usize = 4096;
const MAX_UNSAVED_TEXT_BYTES: usize = 5 * 1024 * 1024;
const MAX_DIAGNOSTICS: usize = 256;
const MAX_LOG_UTF16: usize = 256 * 1024;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SessionContext {
    owner: OwnerId,
    generation: u64,
}

impl SessionContext {
    pub fn owner(&self) -> &OwnerId {
        &self.owner
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }
}

/// Opaque handle issued by this core from trusted host state.
#[derive(Clone, Debug)]
pub struct McpSession {
    id: u64,
    context: SessionContext,
    core_identity: Arc<()>,
}

#[derive(Clone, Debug, Eq, PartialEq, Hash)]
pub enum McpRequestId {
    String(String),
    Number(i64),
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum McpViewMode {
    Visual,
    Source,
    Diff,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorSnapshot {
    pub line: Position,
    pub column: Position,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectionSnapshot {
    pub start_line: Position,
    pub start_column: Position,
    pub end_line: Position,
    pub end_column: Position,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorTabSnapshot {
    pub path: RelativePath,
    pub dirty: bool,
    pub cursor: Option<CursorSnapshot>,
    pub selection: Option<SelectionSnapshot>,
}

/// Owner and generation fields route inside the host and are not serialized
/// to MCP clients.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSnapshot {
    pub id: WorkspaceId,
    #[serde(skip)]
    pub owner: OwnerId,
    #[serde(skip)]
    pub owner_generation: u64,
    #[serde(skip)]
    pub generation: u64,
    pub root: String,
    pub label: String,
    pub entry_path: Option<RelativePath>,
    pub active_path: Option<RelativePath>,
    pub main_file: Option<RelativePath>,
    pub view_mode: McpViewMode,
    pub live_preview: bool,
    pub tabs: Vec<EditorTabSnapshot>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorSnapshot {
    pub focused: Option<WorkspaceId>,
    pub workspaces: Vec<WorkspaceSnapshot>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnsavedSnapshot {
    pub dirty: bool,
    pub path: Option<RelativePath>,
    pub text: Option<String>,
    pub document_id: Option<DocumentId>,
    pub document_version: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpDiagnostic {
    pub severity: Severity,
    pub message: String,
    pub path: Option<RelativePath>,
    pub line: Option<Position>,
    pub column: Option<Position>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsSnapshot {
    pub compiling: bool,
    pub log_written_at: u64,
    pub end_signal: String,
    pub diagnostics: Vec<McpDiagnostic>,
    pub log: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenFileResult {
    pub opened: RelativePath,
    pub line: Option<Position>,
    pub switched_to_source: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationAck {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewModeResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub view_mode: Option<McpViewMode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompileStartResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompileConfig {
    pub command: Option<String>,
    pub engine: String,
    pub format: String,
    pub output_dir: Option<RelativePath>,
    #[serde(rename = "pdf")]
    pub pdf_path: Option<RelativePath>,
    #[serde(rename = "log")]
    pub log_path: Option<RelativePath>,
    pub can_set_command: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum McpOperation {
    GetUnsaved,
    GetDiagnostics,
    OpenFile {
        path: RelativePath,
        line: Option<Position>,
    },
    ShowDiff {
        path: Option<RelativePath>,
    },
    SetViewMode {
        mode: McpViewMode,
    },
    SyncTexToLine {
        line: Position,
    },
    SetMainFile {
        path: Option<RelativePath>,
    },
    Compile,
    GetCompileConfig,
    SetOutputPaths {
        output_dir: Option<RelativePath>,
        pdf: Option<RelativePath>,
        log: Option<RelativePath>,
    },
    SetCompileCommand {
        command: String,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum McpReply {
    Unsaved(UnsavedSnapshot),
    Diagnostics(DiagnosticsSnapshot),
    Opened(OpenFileResult),
    Ack(OperationAck),
    ViewMode(ViewModeResult),
    CompileStarted(CompileStartResult),
    CompileConfig(CompileConfig),
    OutputPaths(CompileConfig),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HostError {
    StaleOwner,
    StaleWorkspace,
    WorkspaceNotFound,
    AmbiguousWorkspace,
    NoFocusedWorkspace,
    PermissionDenied,
    NotGitRepository,
    NotFound,
    Conflict,
    InvalidInput,
    InvalidSnapshot,
    InvalidReply,
    Unavailable,
    Timeout,
    Cancelled,
    Capacity,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkspaceRoute {
    pub owner: OwnerId,
    pub owner_generation: u64,
    pub workspace_id: WorkspaceId,
    pub workspace_generation: u64,
    pub root: String,
}

/// `execute` must validate the exact route and return only after the matching
/// editor acknowledgement. Compile-command permission defaults to denied.
pub trait McpHost: Send + Sync {
    fn validate_session(&self, context: &SessionContext) -> Result<(), HostError>;

    fn editor_snapshot(
        &self,
        context: &SessionContext,
        deadline: Instant,
        cancellation: &CancellationToken,
    ) -> Result<EditorSnapshot, HostError>;

    fn execute(
        &self,
        route: &WorkspaceRoute,
        request_id: &McpRequestId,
        operation: &McpOperation,
        deadline: Instant,
        cancellation: &CancellationToken,
    ) -> Result<McpReply, HostError>;

    fn compile_command_allowed(
        &self,
        _route: &WorkspaceRoute,
        _deadline: Instant,
        _cancellation: &CancellationToken,
    ) -> Result<bool, HostError> {
        Ok(false)
    }
}

#[derive(Clone, Debug, Default)]
pub struct CancellationToken(Arc<AtomicBool>);

impl CancellationToken {
    pub fn cancel(&self) {
        self.0.store(true, Ordering::Release);
    }

    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::Acquire)
    }

    pub fn check(&self, deadline: Instant) -> Result<(), HostError> {
        if self.is_cancelled() {
            Err(HostError::Cancelled)
        } else if Instant::now() >= deadline {
            Err(HostError::Timeout)
        } else {
            Ok(())
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct McpApplicationToolReply {
    pub payload: Value,
    pub is_error: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum McpApplicationCallError {
    InvalidParams,
    StaleSession,
    Busy,
    Timeout,
    Cancelled,
}

struct SessionState {
    context: SessionContext,
    pending: HashMap<McpRequestId, CancellationToken>,
}

struct CoreState {
    next_session_id: u64,
    sessions: HashMap<u64, SessionState>,
}

pub struct McpCore<H: McpHost + ?Sized> {
    host: Arc<H>,
    state: Mutex<CoreState>,
    identity: Arc<()>,
}

impl<H: McpHost + ?Sized> McpCore<H> {
    pub fn new(host: Arc<H>) -> Self {
        Self {
            host,
            state: Mutex::new(CoreState {
                next_session_id: 1,
                sessions: HashMap::new(),
            }),
            identity: Arc::new(()),
        }
    }

    fn lock_state(&self) -> MutexGuard<'_, CoreState> {
        self.state.lock().unwrap_or_else(|error| error.into_inner())
    }

    pub fn open_stateless_session(
        &self,
        owner: OwnerId,
        generation: u64,
    ) -> Result<McpSession, HostError> {
        let context = SessionContext { owner, generation };
        self.host.validate_session(&context)?;
        let mut state = self.lock_state();
        if state.sessions.len() >= MAX_MCP_SESSIONS {
            return Err(HostError::Capacity);
        }
        let id = state.next_session_id;
        state.next_session_id = id.checked_add(1).ok_or(HostError::Capacity)?;
        state.sessions.insert(
            id,
            SessionState {
                context: context.clone(),
                pending: HashMap::new(),
            },
        );
        Ok(McpSession {
            id,
            context,
            core_identity: Arc::clone(&self.identity),
        })
    }

    pub fn close_session(&self, session: &McpSession) {
        if Arc::ptr_eq(&session.core_identity, &self.identity) {
            self.remove_session(session.id);
        }
    }

    fn remove_session(&self, id: u64) {
        if let Some(session) = self.lock_state().sessions.remove(&id) {
            for cancellation in session.pending.values() {
                cancellation.cancel();
            }
        }
    }

    fn session_context(&self, session: &McpSession) -> Result<SessionContext, HostError> {
        if !Arc::ptr_eq(&session.core_identity, &self.identity) {
            return Err(HostError::StaleOwner);
        }
        let state = self.lock_state();
        let entry = state
            .sessions
            .get(&session.id)
            .ok_or(HostError::StaleOwner)?;
        if entry.context != session.context {
            return Err(HostError::StaleOwner);
        }
        Ok(entry.context.clone())
    }

    fn validate_service_session(&self, session: &McpSession) -> Result<SessionContext, HostError> {
        let context = self.session_context(session)?;
        if let Err(error) = self.host.validate_session(&context) {
            if matches!(error, HostError::StaleOwner | HostError::StaleWorkspace) {
                self.close_session(session);
            }
            return Err(error);
        }
        Ok(context)
    }

    fn register_pending(
        &self,
        session: &McpSession,
        request_id: &McpRequestId,
        cancellation: CancellationToken,
    ) -> Result<PendingGuard<'_, H>, McpApplicationCallError> {
        if !Arc::ptr_eq(&session.core_identity, &self.identity) {
            return Err(McpApplicationCallError::StaleSession);
        }
        let mut state = self.lock_state();
        let total = state
            .sessions
            .values()
            .map(|entry| entry.pending.len())
            .sum::<usize>();
        if total >= MAX_PENDING_TOTAL {
            return Err(McpApplicationCallError::Busy);
        }
        let entry = state
            .sessions
            .get_mut(&session.id)
            .ok_or(McpApplicationCallError::StaleSession)?;
        if entry.context != session.context {
            return Err(McpApplicationCallError::StaleSession);
        }
        if entry.pending.contains_key(request_id) || entry.pending.len() >= MAX_PENDING_PER_SESSION
        {
            return Err(McpApplicationCallError::Busy);
        }
        entry
            .pending
            .insert(request_id.clone(), cancellation.clone());
        Ok(PendingGuard {
            core: self,
            session_id: session.id,
            request_id: request_id.clone(),
            cancellation,
        })
    }

    pub(crate) fn call_application_tool(
        &self,
        session: &McpSession,
        request_id: McpRequestId,
        name: &str,
        arguments: Value,
        cancellation: CancellationToken,
    ) -> Result<McpApplicationToolReply, McpApplicationCallError> {
        let mut tree_nodes = 0;
        let mut size_nodes = 0;
        let mut encoded_bytes = 0;
        if !bounded_text(name, 128, false)
            || !arguments.is_object()
            || !validate_json_tree(&arguments, 0, &mut tree_nodes)
            || !bounded_json_size(&arguments, 0, &mut size_nodes, &mut encoded_bytes)
        {
            return Err(McpApplicationCallError::InvalidParams);
        }
        let invocation = parse_tool_invocation(name, &arguments)
            .map_err(|()| McpApplicationCallError::InvalidParams)?;
        self.run_tool_application(session, &request_id, invocation, cancellation)
    }

    fn run_tool_application(
        &self,
        session: &McpSession,
        request_id: &McpRequestId,
        invocation: ToolInvocation,
        cancellation: CancellationToken,
    ) -> Result<McpApplicationToolReply, McpApplicationCallError> {
        let pending = self.register_pending(session, request_id, cancellation.clone())?;
        let deadline = Instant::now() + TOOL_REPLY_TIMEOUT;
        let result = cancellation.check(deadline).and_then(|()| {
            self.invoke_tool(session, request_id, invocation, deadline, &cancellation)
        });
        let final_check = cancellation.check(deadline);
        drop(pending);
        if let Err(error) = final_check {
            return self.application_failure(session, error);
        }
        match result {
            Ok((payload, is_error)) => {
                self.validate_service_session(session)
                    .map_err(session_validation_error)?;
                Ok(McpApplicationToolReply { payload, is_error })
            }
            Err(error) => self.application_failure(session, error),
        }
    }

    fn application_failure(
        &self,
        session: &McpSession,
        error: HostError,
    ) -> Result<McpApplicationToolReply, McpApplicationCallError> {
        self.validate_service_session(session)
            .map_err(session_validation_error)?;
        match error {
            HostError::Cancelled => Err(McpApplicationCallError::Cancelled),
            HostError::Timeout => Err(McpApplicationCallError::Timeout),
            other => Ok(McpApplicationToolReply {
                payload: host_error_value(other),
                is_error: true,
            }),
        }
    }

    fn invoke_tool(
        &self,
        session: &McpSession,
        request_id: &McpRequestId,
        invocation: ToolInvocation,
        deadline: Instant,
        cancellation: &CancellationToken,
    ) -> Result<(Value, bool), HostError> {
        cancellation.check(deadline)?;
        let context = self.validate_service_session(session)?;
        let (root, operation) = match invocation {
            ToolInvocation::EditorState => {
                let snapshot = self
                    .host
                    .editor_snapshot(&context, deadline, cancellation)?;
                self.validate_service_session(session)?;
                validate_editor_snapshot(&snapshot)?;
                cancellation.check(deadline)?;
                return Ok((to_value(&snapshot)?, false));
            }
            ToolInvocation::Workspace { root, operation } => (root, operation),
        };

        let snapshot = self
            .host
            .editor_snapshot(&context, deadline, cancellation)?;
        self.validate_service_session(session)?;
        validate_editor_snapshot(&snapshot)?;
        let route = resolve_route(&snapshot, root.as_deref())?;
        cancellation.check(deadline)?;

        let permission_hint = match &operation {
            McpOperation::GetCompileConfig | McpOperation::SetOutputPaths { .. } => None,
            McpOperation::SetCompileCommand { .. } => {
                self.validate_service_session(session)?;
                let allowed = self
                    .host
                    .compile_command_allowed(&route, deadline, cancellation)?;
                self.validate_service_session(session)?;
                if !allowed {
                    return Err(HostError::PermissionDenied);
                }
                None
            }
            _ => None,
        };
        cancellation.check(deadline)?;
        self.validate_service_session(session)?;
        let reply = self
            .host
            .execute(&route, request_id, &operation, deadline, cancellation)?;
        self.validate_service_session(session)?;
        cancellation.check(deadline)?;
        reply_payload(&operation, reply, permission_hint)
    }
}

struct PendingGuard<'a, H: McpHost + ?Sized> {
    core: &'a McpCore<H>,
    session_id: u64,
    request_id: McpRequestId,
    cancellation: CancellationToken,
}

impl<H: McpHost + ?Sized> Drop for PendingGuard<'_, H> {
    fn drop(&mut self) {
        let mut state = self.core.lock_state();
        if let Some(entry) = state.sessions.get_mut(&self.session_id) {
            let same_call = entry
                .pending
                .get(&self.request_id)
                .is_some_and(|current| Arc::ptr_eq(&current.0, &self.cancellation.0));
            if same_call {
                entry.pending.remove(&self.request_id);
            }
        }
    }
}

enum ToolInvocation {
    EditorState,
    Workspace {
        root: Option<String>,
        operation: McpOperation,
    },
}

fn object(value: &Value) -> Result<&Map<String, Value>, ()> {
    value.as_object().ok_or(())
}

fn ensure_keys(object: &Map<String, Value>, allowed: &[&str]) -> Result<(), ()> {
    if object.keys().any(|key| !allowed.contains(&key.as_str())) {
        Err(())
    } else {
        Ok(())
    }
}

fn required<'a>(object: &'a Map<String, Value>, key: &str) -> Result<&'a Value, ()> {
    object.get(key).ok_or(())
}

fn bounded_text(value: &str, maximum_utf16: usize, allow_empty: bool) -> bool {
    (allow_empty || !value.is_empty()) && value.encode_utf16().count() <= maximum_utf16
}

fn plain_text(value: &str, maximum_utf16: usize, allow_empty: bool) -> bool {
    bounded_text(value, maximum_utf16, allow_empty) && !value.chars().any(char::is_control)
}

fn input_string(value: &Value, maximum_utf16: usize, allow_empty: bool) -> Result<&str, ()> {
    value
        .as_str()
        .filter(|value| bounded_text(value, maximum_utf16, allow_empty))
        .ok_or(())
}

fn validate_json_tree(value: &Value, depth: usize, nodes: &mut usize) -> bool {
    *nodes += 1;
    if depth > 32 || *nodes > 20_000 {
        return false;
    }
    match value {
        Value::Array(values) => {
            values.len() <= 4096
                && values
                    .iter()
                    .all(|value| validate_json_tree(value, depth + 1, nodes))
        }
        Value::Object(values) => {
            values.len() <= 4096
                && values.iter().all(|(key, value)| {
                    key.len() <= 256 && validate_json_tree(value, depth + 1, nodes)
                })
        }
        Value::String(value) => value.len() <= MAX_REQUEST_BYTES,
        _ => true,
    }
}

fn add_bounded_json_bytes(total: &mut usize, amount: usize) -> bool {
    *total = total.saturating_add(amount);
    *total <= MAX_REQUEST_BYTES
}

fn bounded_json_size(value: &Value, depth: usize, nodes: &mut usize, total: &mut usize) -> bool {
    *nodes += 1;
    if depth > 32 || *nodes > 20_000 {
        return false;
    }
    match value {
        Value::Null => add_bounded_json_bytes(total, 4),
        Value::Bool(true) => add_bounded_json_bytes(total, 4),
        Value::Bool(false) => add_bounded_json_bytes(total, 5),
        Value::Number(number) => add_bounded_json_bytes(total, number.to_string().len()),
        Value::String(text) => {
            add_bounded_json_bytes(total, text.len().saturating_mul(6).saturating_add(2))
        }
        Value::Array(items) => {
            if items.len() > 4096 || !add_bounded_json_bytes(total, 2) {
                return false;
            }
            for (index, item) in items.iter().enumerate() {
                if (index > 0 && !add_bounded_json_bytes(total, 1))
                    || !bounded_json_size(item, depth + 1, nodes, total)
                {
                    return false;
                }
            }
            true
        }
        Value::Object(items) => {
            if items.len() > 4096 || !add_bounded_json_bytes(total, 2) {
                return false;
            }
            for (index, (key, item)) in items.iter().enumerate() {
                if (index > 0 && !add_bounded_json_bytes(total, 1))
                    || !add_bounded_json_bytes(total, key.len().saturating_mul(6).saturating_add(3))
                    || !bounded_json_size(item, depth + 1, nodes, total)
                {
                    return false;
                }
            }
            true
        }
    }
}

fn position(value: &Value) -> Result<Position, ()> {
    let number = value.as_number().ok_or(())?;
    if !number.is_i64() && !number.is_u64() {
        return Err(());
    }
    let value = number
        .as_u64()
        .or_else(|| number.as_i64().and_then(|value| u64::try_from(value).ok()))
        .filter(|value| *value > 0 && *value <= MAX_SAFE_INTEGER)
        .ok_or(())?;
    Position::new(value).map_err(|_| ())
}

fn relative_path(value: &Value) -> Result<RelativePath, ()> {
    RelativePath::parse(input_string(value, 32_767, false)?).map_err(|_| ())
}

fn required_path(object: &Map<String, Value>, key: &str) -> Result<RelativePath, ()> {
    relative_path(required(object, key)?)
}

fn optional_path(object: &Map<String, Value>, key: &str) -> Result<Option<RelativePath>, ()> {
    object
        .get(key)
        .filter(|value| !value.is_null())
        .map(relative_path)
        .transpose()
}

fn optional_root(object: &Map<String, Value>) -> Result<Option<String>, ()> {
    object
        .get("root")
        .map(|value| {
            let root = input_string(value, 4096, false)?;
            if !plain_text(root, 4096, false) {
                return Err(());
            }
            Ok(root.to_owned())
        })
        .transpose()
}

fn parse_tool_invocation(name: &str, arguments: &Value) -> Result<ToolInvocation, ()> {
    if !bounded_text(name, 128, false) {
        return Err(());
    }
    let arguments = object(arguments)?;
    let operation = match name {
        "get_editor_state" => {
            ensure_keys(arguments, &[])?;
            return Ok(ToolInvocation::EditorState);
        }
        "get_unsaved" => {
            ensure_keys(arguments, &["root"])?;
            McpOperation::GetUnsaved
        }
        "get_diagnostics" => {
            ensure_keys(arguments, &["root"])?;
            McpOperation::GetDiagnostics
        }
        "open_file" => {
            ensure_keys(arguments, &["path", "line", "root"])?;
            McpOperation::OpenFile {
                path: required_path(arguments, "path")?,
                line: arguments
                    .get("line")
                    .filter(|value| !value.is_null())
                    .map(position)
                    .transpose()?,
            }
        }
        "show_diff" => {
            ensure_keys(arguments, &["path", "root"])?;
            McpOperation::ShowDiff {
                path: optional_path(arguments, "path")?,
            }
        }
        "set_view_mode" => {
            ensure_keys(arguments, &["mode", "root"])?;
            let mode = match input_string(required(arguments, "mode")?, 16, false)? {
                "visual" => McpViewMode::Visual,
                "source" => McpViewMode::Source,
                "diff" => McpViewMode::Diff,
                _ => return Err(()),
            };
            McpOperation::SetViewMode { mode }
        }
        "synctex_to_line" => {
            ensure_keys(arguments, &["line", "root"])?;
            McpOperation::SyncTexToLine {
                line: position(required(arguments, "line")?)?,
            }
        }
        "set_main_file" => {
            ensure_keys(arguments, &["path", "root"])?;
            let path = optional_path(arguments, "path")?;
            if path.as_ref().is_some_and(|path| {
                let lower = path.as_str().to_ascii_lowercase();
                !lower.ends_with(".tex")
            }) {
                return Err(());
            }
            McpOperation::SetMainFile { path }
        }
        "compile" => {
            ensure_keys(arguments, &["root"])?;
            McpOperation::Compile
        }
        "get_compile_config" => {
            ensure_keys(arguments, &["root"])?;
            McpOperation::GetCompileConfig
        }
        "set_output_paths" => {
            ensure_keys(arguments, &["outputDir", "pdf", "log", "root"])?;
            let output_dir = optional_path(arguments, "outputDir")?;
            let pdf = optional_path(arguments, "pdf")?;
            let log = optional_path(arguments, "log")?;
            if output_dir.is_none() && pdf.is_none() && log.is_none() {
                return Err(());
            }
            McpOperation::SetOutputPaths {
                output_dir,
                pdf,
                log,
            }
        }
        "set_compile_command" => {
            ensure_keys(arguments, &["command", "root"])?;
            let command = input_string(required(arguments, "command")?, 4096, false)?;
            if !plain_text(command, 4096, false) || !command.contains("{main}") {
                return Err(());
            }
            McpOperation::SetCompileCommand {
                command: command.to_owned(),
            }
        }
        _ => return Err(()),
    };
    Ok(ToolInvocation::Workspace {
        root: optional_root(arguments)?,
        operation,
    })
}

fn object_schema(properties: Value, required: &[&str]) -> Value {
    json!({
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "properties": properties,
        "required": required,
        "additionalProperties": false
    })
}

fn string_property(description: &str, maximum: usize) -> Value {
    json!({
        "type": "string",
        "minLength": 1,
        "maxLength": maximum,
        "description": description
    })
}

fn root_property() -> Value {
    string_property(
        "Exact root of an open workspace owned by a registered document window. Omit only to use the focused workspace.",
        4096,
    )
}

fn tool_definition(
    name: &str,
    description: &str,
    properties: Value,
    required: &[&str],
    read_only: bool,
    idempotent: bool,
) -> Value {
    json!({
        "name": name,
        "title": name,
        "description": description,
        "inputSchema": object_schema(properties, required),
        "annotations": {
            "readOnlyHint": read_only,
            "destructiveHint": false,
            "idempotentHint": idempotent,
            "openWorldHint": false
        }
    })
}

pub(crate) fn application_tool_definitions() -> Vec<Value> {
    let path = || {
        string_property(
            "Workspace-relative path; absolute paths and traversal are rejected.",
            32_767,
        )
    };
    let line = json!({
        "type": "integer",
        "minimum": 1,
        "maximum": MAX_SAFE_INTEGER,
        "description": "One-based source line."
    });
    let nullable_path = json!({"oneOf": [path(), {"type": "null"}]});
    let mut output_paths = object_schema(
        json!({
            "outputDir": path(),
            "pdf": path(),
            "log": path(),
            "root": root_property()
        }),
        &[],
    );
    output_paths["anyOf"] = json!([
        {"required": ["outputDir"]},
        {"required": ["pdf"]},
        {"required": ["log"]}
    ]);
    let mut tools = vec![
        tool_definition(
            "get_editor_state",
            "Read owner-scoped workspaces, active file, dirty tabs, view mode, and live-preview state.",
            json!({}),
            &[],
            true,
            true,
        ),
        tool_definition(
            "get_unsaved",
            "Read the active editor draft and its document identity.",
            json!({"root": root_property()}),
            &[],
            true,
            true,
        ),
        tool_definition(
            "get_diagnostics",
            "Read the latest compile diagnostics, state, log timestamp, end signal, and bounded log.",
            json!({"root": root_property()}),
            &[],
            true,
            true,
        ),
        tool_definition(
            "open_file",
            "Open a workspace-relative file. An optional line selects Source and positions the cursor.",
            json!({"path": path(), "line": line, "root": root_property()}),
            &["path"],
            false,
            true,
        ),
        tool_definition(
            "show_diff",
            "Show a file's difference from Git HEAD. A non-Git workspace is refused.",
            json!({"path": path(), "root": root_property()}),
            &[],
            false,
            true,
        ),
        tool_definition(
            "set_view_mode",
            "Switch the current editor to visual, source, or diff view and wait for confirmation.",
            json!({
                "mode": {"type": "string", "enum": ["visual", "source", "diff"]},
                "root": root_property()
            }),
            &["mode"],
            false,
            true,
        ),
        tool_definition(
            "synctex_to_line",
            "Synchronize the PDF preview to a one-based source line.",
            json!({"line": line, "root": root_property()}),
            &["line"],
            false,
            true,
        ),
        tool_definition(
            "set_main_file",
            "Select a workspace-relative .tex main file; null clears the current editor main file.",
            json!({"path": nullable_path, "root": root_property()}),
            &[],
            false,
            true,
        ),
        tool_definition(
            "compile",
            "Start the editor's selected compile workflow and wait for its acknowledgement.",
            json!({"root": root_property()}),
            &[],
            false,
            false,
        ),
        tool_definition(
            "get_compile_config",
            "Read the resolved engine, format, command profile, output paths, and separately granted command permission.",
            json!({"root": root_property()}),
            &[],
            true,
            true,
        ),
        tool_definition(
            "set_output_paths",
            "Change relative output directory, PDF, and/or log paths without changing the active command.",
            output_paths["properties"].clone(),
            &[],
            false,
            true,
        ),
        tool_definition(
            "set_compile_command",
            "Request a compile command containing {main}. Default-denied; requires a separate host permission.",
            json!({
                "command": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 4096,
                    "description": "User-authorized command template containing the literal {main} placeholder."
                },
                "root": root_property()
            }),
            &["command"],
            false,
            true,
        ),
    ];
    tools[10]["inputSchema"] = output_paths;
    tools
}

fn validate_editor_snapshot(snapshot: &EditorSnapshot) -> Result<(), HostError> {
    if snapshot.workspaces.len() > MAX_WORKSPACES {
        return Err(HostError::InvalidSnapshot);
    }
    let mut ids = HashSet::new();
    let mut tab_count = 0usize;
    for workspace in &snapshot.workspaces {
        if !ids.insert(workspace.id.clone())
            || !plain_text(&workspace.root, 4096, false)
            || !plain_text(&workspace.label, 4096, false)
            || workspace.owner_generation == 0
            || workspace.owner_generation > MAX_SAFE_INTEGER
            || workspace.generation == 0
            || workspace.generation > MAX_SAFE_INTEGER
        {
            return Err(HostError::InvalidSnapshot);
        }
        tab_count = tab_count.saturating_add(workspace.tabs.len());
        if tab_count > MAX_EDITOR_TABS {
            return Err(HostError::InvalidSnapshot);
        }
    }
    if snapshot
        .focused
        .as_ref()
        .is_some_and(|focused| !ids.contains(focused))
    {
        return Err(HostError::InvalidSnapshot);
    }
    Ok(())
}

fn resolve_route(
    snapshot: &EditorSnapshot,
    requested_root: Option<&str>,
) -> Result<WorkspaceRoute, HostError> {
    let workspace = if let Some(root) = requested_root {
        let mut matches = snapshot
            .workspaces
            .iter()
            .filter(|workspace| workspace.root == root);
        let workspace = matches.next().ok_or(HostError::WorkspaceNotFound)?;
        if matches.next().is_some() {
            return Err(HostError::AmbiguousWorkspace);
        }
        workspace
    } else {
        let focused = snapshot
            .focused
            .as_ref()
            .ok_or(HostError::NoFocusedWorkspace)?;
        snapshot
            .workspaces
            .iter()
            .find(|workspace| &workspace.id == focused)
            .ok_or(HostError::NoFocusedWorkspace)?
    };
    Ok(WorkspaceRoute {
        owner: workspace.owner.clone(),
        owner_generation: workspace.owner_generation,
        workspace_id: workspace.id.clone(),
        workspace_generation: workspace.generation,
        root: workspace.root.clone(),
    })
}

fn validate_unsaved(value: &UnsavedSnapshot) -> Result<(), HostError> {
    if value.dirty != value.text.is_some()
        || value
            .text
            .as_ref()
            .is_some_and(|text| text.len() > MAX_UNSAVED_TEXT_BYTES)
        || value
            .document_version
            .is_some_and(|version| version > MAX_SAFE_INTEGER)
    {
        return Err(HostError::InvalidReply);
    }
    Ok(())
}

fn validate_diagnostics(value: &DiagnosticsSnapshot) -> Result<(), HostError> {
    if value.log_written_at > MAX_SAFE_INTEGER
        || !plain_text(&value.end_signal, 4096, true)
        || value.diagnostics.len() > MAX_DIAGNOSTICS
        || value
            .log
            .as_ref()
            .is_some_and(|log| log.encode_utf16().count() > MAX_LOG_UTF16)
    {
        return Err(HostError::InvalidReply);
    }
    for diagnostic in &value.diagnostics {
        if !bounded_text(&diagnostic.message, 32_767, false)
            || (diagnostic.line.is_some() && diagnostic.path.is_none())
            || (diagnostic.column.is_some() && diagnostic.line.is_none())
        {
            return Err(HostError::InvalidReply);
        }
    }
    Ok(())
}

fn validate_compile_config(value: &CompileConfig) -> Result<(), HostError> {
    if !plain_text(&value.engine, 256, false)
        || !plain_text(&value.format, 256, false)
        || value
            .command
            .as_ref()
            .is_some_and(|command| !plain_text(command, 4096, false))
    {
        return Err(HostError::InvalidReply);
    }
    Ok(())
}

fn validate_ack(value: &OperationAck) -> Result<(), HostError> {
    if value
        .reason
        .as_ref()
        .is_some_and(|reason| !bounded_text(reason, 4096, false))
    {
        Err(HostError::InvalidReply)
    } else {
        Ok(())
    }
}

fn to_value<T: Serialize>(value: &T) -> Result<Value, HostError> {
    serde_json::to_value(value).map_err(|_| HostError::InvalidReply)
}

fn reply_payload(
    operation: &McpOperation,
    reply: McpReply,
    permission_hint: Option<bool>,
) -> Result<(Value, bool), HostError> {
    let (value, is_error) = match (operation, reply) {
        (McpOperation::GetUnsaved, McpReply::Unsaved(value)) => {
            validate_unsaved(&value)?;
            (to_value(&value)?, false)
        }
        (McpOperation::GetDiagnostics, McpReply::Diagnostics(value)) => {
            validate_diagnostics(&value)?;
            (to_value(&value)?, false)
        }
        (McpOperation::OpenFile { path, line }, McpReply::Opened(value)) => {
            if value.opened != *path
                || value.line != *line
                || (line.is_some() && !value.switched_to_source)
            {
                return Err(HostError::InvalidReply);
            }
            (to_value(&value)?, false)
        }
        (
            McpOperation::ShowDiff { .. }
            | McpOperation::SyncTexToLine { .. }
            | McpOperation::SetMainFile { .. }
            | McpOperation::SetCompileCommand { .. },
            McpReply::Ack(value),
        ) => {
            validate_ack(&value)?;
            let is_error = !value.ok;
            (to_value(&value)?, is_error)
        }
        (McpOperation::SetViewMode { mode }, McpReply::ViewMode(value)) => {
            if value
                .reason
                .as_ref()
                .is_some_and(|reason| !bounded_text(reason, 4096, false))
                || (value.ok && value.view_mode != Some(*mode))
            {
                return Err(HostError::InvalidReply);
            }
            let is_error = !value.ok;
            (to_value(&value)?, is_error)
        }
        (McpOperation::Compile, McpReply::CompileStarted(value)) => {
            if value
                .mode
                .as_ref()
                .is_some_and(|mode| !plain_text(mode, 256, false))
                || value
                    .note
                    .as_ref()
                    .is_some_and(|note| !bounded_text(note, 4096, true))
            {
                return Err(HostError::InvalidReply);
            }
            let is_error = !value.ok;
            (to_value(&value)?, is_error)
        }
        (McpOperation::GetCompileConfig, McpReply::CompileConfig(mut value)) => {
            value.can_set_command = permission_hint.unwrap_or(value.can_set_command);
            validate_compile_config(&value)?;
            (to_value(&value)?, false)
        }
        (
            McpOperation::SetOutputPaths {
                output_dir,
                pdf,
                log,
            },
            McpReply::OutputPaths(mut value),
        ) => {
            if output_dir
                .as_ref()
                .is_some_and(|path| value.output_dir.as_ref() != Some(path))
                || pdf
                    .as_ref()
                    .is_some_and(|path| value.pdf_path.as_ref() != Some(path))
                || log
                    .as_ref()
                    .is_some_and(|path| value.log_path.as_ref() != Some(path))
            {
                return Err(HostError::InvalidReply);
            }
            value.can_set_command = permission_hint.unwrap_or(value.can_set_command);
            validate_compile_config(&value)?;
            (to_value(&value)?, false)
        }
        _ => return Err(HostError::InvalidReply),
    };
    Ok((value, is_error))
}

fn host_error_code(error: HostError) -> &'static str {
    match error {
        HostError::StaleOwner => "STALE_OWNER",
        HostError::StaleWorkspace => "STALE_WORKSPACE",
        HostError::WorkspaceNotFound => "WORKSPACE_NOT_FOUND",
        HostError::AmbiguousWorkspace => "AMBIGUOUS_WORKSPACE",
        HostError::NoFocusedWorkspace => "NO_FOCUSED_WORKSPACE",
        HostError::PermissionDenied => "PERMISSION_DENIED",
        HostError::NotGitRepository => "NOT_GIT_REPOSITORY",
        HostError::NotFound => "NOT_FOUND",
        HostError::Conflict => "CONFLICT",
        HostError::InvalidInput => "INVALID_INPUT",
        HostError::InvalidSnapshot => "INVALID_HOST_SNAPSHOT",
        HostError::InvalidReply => "INVALID_HOST_REPLY",
        HostError::Unavailable => "HOST_UNAVAILABLE",
        HostError::Timeout => "TIMEOUT",
        HostError::Cancelled => "CANCELLED",
        HostError::Capacity => "CAPACITY",
    }
}

fn host_error_message(error: HostError) -> &'static str {
    match error {
        HostError::StaleOwner => "The calling owner is closed or stale.",
        HostError::StaleWorkspace => "The selected workspace is closed or stale.",
        HostError::WorkspaceNotFound => "The requested workspace is not open.",
        HostError::AmbiguousWorkspace => "More than one open workspace has that root.",
        HostError::NoFocusedWorkspace => "No focused workspace is available.",
        HostError::PermissionDenied => "The separate compile-command permission is disabled.",
        HostError::NotGitRepository => "The selected workspace is not a Git repository.",
        HostError::NotFound => "The requested editor item was not found.",
        HostError::Conflict => "The host rejected the operation because of a conflict.",
        HostError::InvalidInput => "The host rejected the operation input.",
        HostError::InvalidSnapshot => "The host returned an invalid editor snapshot.",
        HostError::InvalidReply => "The host returned an invalid operation reply.",
        HostError::Unavailable => "The requested host service is unavailable.",
        HostError::Timeout => "The host did not reply before the deadline.",
        HostError::Cancelled => "The host operation was cancelled.",
        HostError::Capacity => "The host request capacity is exhausted.",
    }
}

fn host_error_value(error: HostError) -> Value {
    json!({
        "code": host_error_code(error),
        "message": host_error_message(error)
    })
}

fn session_validation_error(error: HostError) -> McpApplicationCallError {
    match error {
        HostError::StaleOwner | HostError::StaleWorkspace => McpApplicationCallError::StaleSession,
        HostError::Timeout => McpApplicationCallError::Timeout,
        HostError::Cancelled => McpApplicationCallError::Cancelled,
        _ => McpApplicationCallError::InvalidParams,
    }
}

impl fmt::Display for HostError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(host_error_message(*self))
    }
}

#[cfg(test)]
mod tests {
    use super::application_tool_definitions;

    #[test]
    fn fixed_tool_list_and_schemas_remain_closed() {
        let tools = application_tool_definitions();
        let names = tools
            .iter()
            .map(|tool| tool["name"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            names,
            [
                "get_editor_state",
                "get_unsaved",
                "get_diagnostics",
                "open_file",
                "show_diff",
                "set_view_mode",
                "synctex_to_line",
                "set_main_file",
                "compile",
                "get_compile_config",
                "set_output_paths",
                "set_compile_command",
            ]
        );
        assert!(tools.iter().all(|tool| {
            tool["inputSchema"]["type"] == "object"
                && tool["inputSchema"]["additionalProperties"] == false
        }));
    }
}
