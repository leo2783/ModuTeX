// SPDX-License-Identifier: Apache-2.0
//! Standard MCP stdio proxy to the explicitly enabled desktop HTTP service.
//! rmcp owns the client, stdio framing, and protocol output.

use std::{error::Error, future::Future, io, pin::Pin, sync::Arc};

use rmcp::{
    model::{
        CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock, ListToolsResult,
        PaginatedRequestParams, Tool,
    },
    service::{Peer, RunningService},
    transport::StreamableHttpClientTransport,
    RoleClient, ServiceExt,
};
use serde_json::json;

use crate::services::mcp::rmcp::{McpRmcpProxy, McpTypedUpstream, MCP_HTTP_PORTS};

pub fn application_http_uri(port: u16) -> io::Result<String> {
    if !MCP_HTTP_PORTS.contains(&port) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "MCP HTTP is restricted to ports 7317 and 7318",
        ));
    }
    Ok(format!("http://127.0.0.1:{port}/mcp"))
}

pub struct McpRmcpHttpUpstream {
    service: tokio::sync::Mutex<Option<RunningService<RoleClient, ()>>>,
    peer: Peer<RoleClient>,
    tools: ListToolsResult,
}

impl McpRmcpHttpUpstream {
    pub async fn connect(port: u16) -> Result<Self, Box<dyn Error + Send + Sync>> {
        let uri = application_http_uri(port)?;
        let transport = StreamableHttpClientTransport::from_uri(Arc::<str>::from(uri));
        let service = ().serve(transport).await?;
        let peer = service.peer().clone();
        let tools = match peer.list_all_tools().await {
            Ok(tools) => tools,
            Err(error) => {
                let _ = service.cancel().await;
                return Err(Box::new(error));
            }
        };
        let tools = match serde_json::from_value::<ListToolsResult>(json!({"tools": tools})) {
            Ok(tools) => tools,
            Err(error) => {
                let _ = service.cancel().await;
                return Err(Box::new(error));
            }
        };
        Ok(Self {
            service: tokio::sync::Mutex::new(Some(service)),
            peer,
            tools,
        })
    }
}

fn upstream_tool_error() -> CallToolResponse {
    CallToolResponse::Complete(CallToolResult::error(vec![ContentBlock::text(
        "{\"code\":\"UPSTREAM_UNAVAILABLE\",\"message\":\"The desktop MCP service did not complete the tool call.\"}",
    )]))
}

impl McpTypedUpstream for McpRmcpHttpUpstream {
    fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
    ) -> Pin<Box<dyn Future<Output = ListToolsResult> + Send + '_>> {
        let tools = self.tools.clone();
        Box::pin(async move { tools })
    }

    fn get_tool(&self, name: &str) -> Option<Tool> {
        self.tools
            .tools
            .iter()
            .find(|tool| tool.name.as_ref() == name)
            .cloned()
    }

    fn call_tool(
        &self,
        request: CallToolRequestParams,
    ) -> Pin<Box<dyn Future<Output = CallToolResponse> + Send + '_>> {
        let peer = self.peer.clone();
        Box::pin(async move {
            match peer.call_tool_once(request).await {
                Ok(response) => response,
                Err(_) => upstream_tool_error(),
            }
        })
    }

    fn close(&self) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
        Box::pin(async move {
            let service = self.service.lock().await.take();
            if let Some(service) = service {
                let _ = service.cancel().await;
            }
        })
    }
}

pub async fn run_stdio_proxy<U>(upstream: Arc<U>) -> Result<(), Box<dyn Error + Send + Sync>>
where
    U: McpTypedUpstream,
{
    let proxy = McpRmcpProxy::new(Arc::clone(&upstream));
    let service = match proxy.serve(rmcp::transport::stdio()).await {
        Ok(service) => service,
        Err(error) => {
            upstream.close().await;
            return Err(Box::new(error));
        }
    };
    let result = service.waiting().await;
    upstream.close().await;
    result?;
    Ok(())
}

pub async fn run_stdio_proxy_to_application(port: u16) -> Result<(), Box<dyn Error + Send + Sync>> {
    let upstream = Arc::new(McpRmcpHttpUpstream::connect(port).await?);
    run_stdio_proxy(upstream).await
}
