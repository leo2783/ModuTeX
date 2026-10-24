// SPDX-License-Identifier: Apache-2.0
//! Official rmcp application callbacks and typed stdio proxy.

use std::{
    future::Future,
    io::{self, Write},
    pin::Pin,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};

use rmcp::{
    handler::server::ServerHandler,
    model::{
        CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock, Implementation,
        ListToolsResult, PaginatedRequestParams, ServerCapabilities, ServerConfig, Tool,
    },
    service::RequestContext,
    transport::streamable_http_server::{
        session::SessionManager,
        tower::{StreamableHttpServerConfig, StreamableHttpService},
    },
    ErrorData, RoleServer,
};
use serde_json::{json, Value};
use tokio::sync::{oneshot, Semaphore};
use tokio_util::sync::CancellationToken as TransportCancellationToken;

use crate::{
    schemas::protocol::{OwnerId, MAX_SAFE_INTEGER},
    services::mcp::core::{
        application_tool_definitions, CancellationToken, HostError, McpApplicationCallError,
        McpApplicationToolReply, McpCore, McpHost, McpRequestId, McpSession,
        MAX_PENDING_PER_SESSION, MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES,
    },
};

pub const MCP_HTTP_PORTS: [u16; 2] = [7317, 7318];
const MCP_CALLBACK_DRAIN_TIMEOUT: Duration = Duration::from_secs(3);

pub fn loopback_http_service_factory<H, M>(
    handler: McpRmcpHandler<H>,
    session_manager: Arc<M>,
    port: u16,
) -> io::Result<StreamableHttpService<McpRmcpHandler<H>, M>>
where
    H: McpHost + ?Sized + 'static,
    M: SessionManager + 'static,
{
    loopback_http_service_factory_with_cancellation(
        handler,
        session_manager,
        port,
        TransportCancellationToken::new(),
    )
}

pub(crate) fn loopback_http_service_factory_with_cancellation<H, M>(
    handler: McpRmcpHandler<H>,
    session_manager: Arc<M>,
    port: u16,
    cancellation_token: TransportCancellationToken,
) -> io::Result<StreamableHttpService<McpRmcpHandler<H>, M>>
where
    H: McpHost + ?Sized + 'static,
    M: SessionManager + 'static,
{
    if !MCP_HTTP_PORTS.contains(&port) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "MCP HTTP is restricted to ports 7317 and 7318",
        ));
    }
    let config = StreamableHttpServerConfig::default()
        .with_allowed_hosts([format!("127.0.0.1:{port}")])
        .with_max_request_body_bytes(MAX_REQUEST_BYTES)
        .with_cancellation_token(cancellation_token)
        .enforce_origin_validation();
    Ok(StreamableHttpService::new(
        move || Ok(handler.clone()),
        session_manager,
        config,
    ))
}

#[derive(Clone)]
pub struct McpCallbackCleanup {
    tasks: Arc<tokio::sync::Mutex<tokio::task::JoinSet<()>>>,
}

impl McpCallbackCleanup {
    pub async fn wait(&self) {
        let mut tasks = self.tasks.lock().await;
        while tasks.join_next().await.is_some() {}
    }

    /// `false` retains work owned by this token; it is not join proof.
    pub async fn wait_timeout(&self, timeout: Duration) -> bool {
        tokio::time::timeout(timeout, self.wait()).await.is_ok()
    }
}

pub struct McpRmcpHandler<H: McpHost + ?Sized> {
    core: Arc<McpCore<H>>,
    session: McpSession,
    next_request_id: Arc<AtomicU64>,
    pending: Arc<Semaphore>,
    callback_tasks: Arc<tokio::sync::Mutex<tokio::task::JoinSet<()>>>,
    closed: Arc<AtomicBool>,
}

impl<H: McpHost + ?Sized> Clone for McpRmcpHandler<H> {
    fn clone(&self) -> Self {
        Self {
            core: Arc::clone(&self.core),
            session: self.session.clone(),
            next_request_id: Arc::clone(&self.next_request_id),
            pending: Arc::clone(&self.pending),
            callback_tasks: Arc::clone(&self.callback_tasks),
            closed: Arc::clone(&self.closed),
        }
    }
}

impl<H: McpHost + ?Sized + 'static> McpRmcpHandler<H> {
    pub fn from_trusted_host(
        core: Arc<McpCore<H>>,
        owner: OwnerId,
        generation: u64,
    ) -> Result<Self, HostError> {
        let session = core.open_stateless_session(owner, generation)?;
        Ok(Self {
            core,
            session,
            next_request_id: Arc::new(AtomicU64::new(1)),
            pending: Arc::new(Semaphore::new(MAX_PENDING_PER_SESSION)),
            callback_tasks: Arc::new(tokio::sync::Mutex::new(tokio::task::JoinSet::new())),
            closed: Arc::new(AtomicBool::new(false)),
        })
    }

    pub fn revoke(&self) {
        self.closed.store(true, Ordering::Release);
        self.pending.close();
        self.core.close_session(&self.session);
    }

    pub async fn shutdown(&self) -> Result<(), McpCallbackCleanup> {
        self.revoke();
        let cleanup = self.cleanup_token();
        if cleanup.wait_timeout(MCP_CALLBACK_DRAIN_TIMEOUT).await {
            Ok(())
        } else {
            Err(cleanup)
        }
    }

    pub(crate) fn cleanup_token(&self) -> McpCallbackCleanup {
        McpCallbackCleanup {
            tasks: Arc::clone(&self.callback_tasks),
        }
    }

    fn next_internal_request_id(&self) -> Option<McpRequestId> {
        let next = self
            .next_request_id
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |current| {
                (current <= MAX_SAFE_INTEGER).then_some(current + 1)
            })
            .ok()?;
        i64::try_from(next).ok().map(McpRequestId::Number)
    }

    async fn spawn_application_call(
        &self,
        request_id: McpRequestId,
        name: String,
        arguments: Value,
        cancellation: CancellationToken,
    ) -> Result<oneshot::Receiver<McpApplicationToolReply>, McpApplicationToolReply> {
        if self.closed.load(Ordering::Acquire) {
            return Err(application_error(McpApplicationCallError::StaleSession));
        }
        let permit = Arc::clone(&self.pending)
            .try_acquire_owned()
            .map_err(|_| application_error(McpApplicationCallError::Busy))?;
        let core = Arc::clone(&self.core);
        let session = self.session.clone();
        let (sender, receiver) = oneshot::channel();
        let mut tasks = self.callback_tasks.lock().await;
        while tasks.try_join_next().is_some() {}
        if self.closed.load(Ordering::Acquire) {
            return Err(application_error(McpApplicationCallError::StaleSession));
        }

        // Track the blocking callback itself. Its permit and join-set owner
        // remain alive until the exact callback has returned.
        let callback_tasks = Arc::clone(&self.callback_tasks);
        tasks.spawn_blocking(move || {
            let _callback_tasks = callback_tasks;
            let _permit = permit;
            let reply = match core.call_application_tool(
                &session,
                request_id,
                &name,
                arguments,
                cancellation,
            ) {
                Ok(reply) => reply,
                Err(error) => application_error(error),
            };
            let _ = sender.send(reply);
        });
        Ok(receiver)
    }
}

fn server_config() -> ServerConfig {
    ServerConfig::new(ServerCapabilities::builder().enable_tools().build()).with_server_info(
        Implementation::new("modutex-desktop", env!("CARGO_PKG_VERSION")),
    )
}

fn sdk_tools() -> ListToolsResult {
    serde_json::from_value(json!({"tools": application_tool_definitions()}))
        .expect("fixed ModuTeX tool definitions are rmcp Tool values")
}

fn application_error(error: McpApplicationCallError) -> McpApplicationToolReply {
    let (code, message) = match error {
        McpApplicationCallError::InvalidParams => {
            ("INVALID_INPUT", "The tool arguments are invalid.")
        }
        McpApplicationCallError::StaleSession => {
            ("STALE_OWNER", "The trusted MCP service identity is stale.")
        }
        McpApplicationCallError::Busy => ("CAPACITY", "The host request capacity is exhausted."),
        McpApplicationCallError::Timeout => {
            ("TIMEOUT", "The host did not reply before the deadline.")
        }
        McpApplicationCallError::Cancelled => ("CANCELLED", "The host operation was cancelled."),
    };
    McpApplicationToolReply {
        payload: json!({"code": code, "message": message}),
        is_error: true,
    }
}

fn sdk_tool_response(reply: McpApplicationToolReply) -> CallToolResponse {
    let content = vec![ContentBlock::text(bounded_payload_text(&reply.payload))];
    let result = if reply.is_error {
        CallToolResult::error(content)
    } else {
        CallToolResult::success(content)
    };
    CallToolResponse::Complete(result)
}

const MAX_TOOL_JSON_BYTES: usize = (MAX_RESPONSE_BYTES - 4096) / 6;
const RESPONSE_TOO_LARGE: &str =
    "{\"code\":\"RESPONSE_TOO_LARGE\",\"message\":\"Tool result exceeds the response limit.\"}";

struct BoundedJsonWriter {
    bytes: Vec<u8>,
    limit: usize,
}

impl Write for BoundedJsonWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() > self.limit.saturating_sub(self.bytes.len()) {
            return Err(io::Error::new(
                io::ErrorKind::WriteZero,
                "tool payload exceeds its response limit",
            ));
        }
        self.bytes.extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn bounded_payload_text(payload: &Value) -> String {
    let mut writer = BoundedJsonWriter {
        bytes: Vec::with_capacity(16 * 1024),
        limit: MAX_TOOL_JSON_BYTES,
    };
    if serde_json::to_writer(&mut writer, payload).is_err() {
        return RESPONSE_TOO_LARGE.to_owned();
    }
    String::from_utf8(writer.bytes).unwrap_or_else(|_| RESPONSE_TOO_LARGE.to_owned())
}

fn standard_tool_error(code: &str, message: &str) -> CallToolResponse {
    let text = serde_json::to_string(&json!({"code": code, "message": message}))
        .unwrap_or_else(|_| "{\"code\":\"HOST_UNAVAILABLE\"}".to_owned());
    CallToolResponse::Complete(CallToolResult::error(vec![ContentBlock::text(text)]))
}

struct CancelHostCallOnDrop(CancellationToken);

impl Drop for CancelHostCallOnDrop {
    fn drop(&mut self) {
        self.0.cancel();
    }
}

impl<H: McpHost + ?Sized + 'static> ServerHandler for McpRmcpHandler<H> {
    fn get_info(&self) -> ServerConfig {
        server_config()
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        Ok(sdk_tools())
    }

    fn get_tool(&self, name: &str) -> Option<Tool> {
        application_tool_definitions()
            .into_iter()
            .find(|tool| tool["name"].as_str() == Some(name))
            .and_then(|tool| serde_json::from_value(tool).ok())
    }

    fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> impl Future<Output = Result<CallToolResponse, ErrorData>> + Send + '_ {
        let handler = self.clone();
        let request_cancellation = context.ct.clone();
        drop(context);
        async move {
            let name = request.name.to_string();
            let arguments = Value::Object(request.arguments.unwrap_or_default());
            let Some(request_id) = handler.next_internal_request_id() else {
                return Ok(sdk_tool_response(application_error(
                    McpApplicationCallError::Busy,
                )));
            };
            let cancellation = CancellationToken::default();
            let cancel_on_drop = CancelHostCallOnDrop(cancellation.clone());
            let result = handler
                .spawn_application_call(request_id, name, arguments, cancellation.clone())
                .await;
            let reply = match result {
                Err(reply) => reply,
                Ok(receiver) => tokio::select! {
                    biased;
                    _ = request_cancellation.cancelled() => {
                        cancellation.cancel();
                        application_error(McpApplicationCallError::Cancelled)
                    }
                    reply = receiver => reply.unwrap_or_else(|_| McpApplicationToolReply {
                        payload: json!({
                            "code": "HOST_UNAVAILABLE",
                            "message": "The host tool worker did not complete."
                        }),
                        is_error: true,
                    }),
                },
            };
            drop(cancel_on_drop);
            Ok(sdk_tool_response(reply))
        }
    }
}

pub trait McpTypedUpstream: Send + Sync + 'static {
    fn list_tools(
        &self,
        request: Option<PaginatedRequestParams>,
    ) -> Pin<Box<dyn Future<Output = ListToolsResult> + Send + '_>>;

    fn get_tool(&self, name: &str) -> Option<Tool>;

    fn call_tool(
        &self,
        request: CallToolRequestParams,
    ) -> Pin<Box<dyn Future<Output = CallToolResponse> + Send + '_>>;

    fn close(&self) -> Pin<Box<dyn Future<Output = ()> + Send + '_>>;
}

pub struct McpRmcpProxy<U: McpTypedUpstream> {
    upstream: Arc<U>,
    pending: Arc<Semaphore>,
}

impl<U: McpTypedUpstream> McpRmcpProxy<U> {
    pub fn new(upstream: Arc<U>) -> Self {
        Self {
            upstream,
            pending: Arc::new(Semaphore::new(MAX_PENDING_PER_SESSION)),
        }
    }
}

impl<U: McpTypedUpstream> ServerHandler for McpRmcpProxy<U> {
    fn get_info(&self) -> ServerConfig {
        server_config()
    }

    fn list_tools(
        &self,
        request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> impl Future<Output = Result<ListToolsResult, ErrorData>> + Send + '_ {
        let upstream = Arc::clone(&self.upstream);
        async move { Ok(upstream.list_tools(request).await) }
    }

    fn get_tool(&self, name: &str) -> Option<Tool> {
        self.upstream.get_tool(name)
    }

    fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> impl Future<Output = Result<CallToolResponse, ErrorData>> + Send + '_ {
        let upstream = Arc::clone(&self.upstream);
        let pending = Arc::clone(&self.pending);
        let request_cancellation = context.ct.clone();
        drop(context);
        async move {
            let Ok(permit) = pending.try_acquire_owned() else {
                return Ok(standard_tool_error(
                    "CAPACITY",
                    "The host request capacity is exhausted.",
                ));
            };
            let _permit = permit;
            let call = upstream.call_tool(request);
            tokio::pin!(call);
            tokio::select! {
                biased;
                _ = request_cancellation.cancelled() => Ok(standard_tool_error(
                    "CANCELLED",
                    "The tool operation was cancelled."
                )),
                response = &mut call => Ok(response),
            }
        }
    }
}
