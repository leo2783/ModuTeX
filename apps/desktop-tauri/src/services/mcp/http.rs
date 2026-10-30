// SPDX-License-Identifier: Apache-2.0
//! Opt-in loopback Streamable HTTP server using the official rmcp service.
//! The listener, accept task, connections, and callback join proof have
//! explicit owners through bounded shutdown.

use std::{
    error::Error,
    fmt, io,
    net::{IpAddr, Ipv4Addr, SocketAddr},
    sync::Arc,
    time::Duration,
};

use hyper::server::conn::http1;
use hyper_util::{rt::TokioIo, service::TowerToHyperService};
use rmcp::transport::streamable_http_server::{
    session::SessionManager, tower::StreamableHttpService,
};
use tokio::{
    net::TcpListener,
    sync::Semaphore,
    task::{JoinHandle, JoinSet},
};
use tokio_util::sync::CancellationToken as TransportCancellationToken;

use crate::services::mcp::{
    core::McpHost,
    rmcp::{loopback_http_service_factory_with_cancellation, McpRmcpHandler, MCP_HTTP_PORTS},
};

const MAX_HTTP_CONNECTIONS: usize = 128;
const HTTP_CONNECTION_DRAIN_TIMEOUT: Duration = Duration::from_secs(2);
const HTTP_SERVER_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(3);

struct McpLoopbackOwner<H: McpHost + ?Sized + 'static> {
    cancellation: TransportCancellationToken,
    accept_task: tokio::sync::Mutex<Option<JoinHandle<io::Result<()>>>>,
    handler: McpRmcpHandler<H>,
}

pub struct McpLoopbackCleanup<H: McpHost + ?Sized + 'static> {
    owner: Arc<McpLoopbackOwner<H>>,
}

impl<H: McpHost + ?Sized + 'static> McpLoopbackCleanup<H> {
    pub async fn wait(&mut self) -> io::Result<()> {
        let accept_result = {
            let mut accept_task = self.owner.accept_task.lock().await;
            let result = match accept_task.as_mut() {
                Some(task) => Some((&mut *task).await),
                None => None,
            };
            if result.is_some() {
                accept_task.take();
            }
            result
        };
        let accept_result = match accept_result {
            Some(Ok(result)) => result,
            Some(Err(error)) => Err(io::Error::other(error)),
            None => Ok(()),
        };
        self.owner.handler.cleanup_token().wait().await;
        accept_result
    }

    pub async fn wait_timeout(&mut self, timeout: Duration) -> Result<bool, io::Error> {
        match tokio::time::timeout(timeout, self.wait()).await {
            Ok(result) => result.map(|()| true),
            Err(_) => Ok(false),
        }
    }
}

pub struct McpLoopbackShutdownError<H: McpHost + ?Sized + 'static> {
    error: io::Error,
    cleanup: McpLoopbackCleanup<H>,
}

impl<H: McpHost + ?Sized + 'static> McpLoopbackShutdownError<H> {
    pub fn into_parts(self) -> (io::Error, McpLoopbackCleanup<H>) {
        (self.error, self.cleanup)
    }
}

impl<H: McpHost + ?Sized + 'static> fmt::Debug for McpLoopbackShutdownError<H> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("McpLoopbackShutdownError")
            .field("error", &self.error)
            .field("cleanup_token_retained", &true)
            .finish()
    }
}

impl<H: McpHost + ?Sized + 'static> fmt::Display for McpLoopbackShutdownError<H> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "MCP HTTP shutdown did not complete cleanly: {} (cleanup token retained)",
            self.error
        )
    }
}

impl<H: McpHost + ?Sized + 'static> Error for McpLoopbackShutdownError<H> {}

pub struct McpLoopbackHttpServer<H: McpHost + ?Sized + 'static> {
    address: SocketAddr,
    owner: Arc<McpLoopbackOwner<H>>,
}

impl<H: McpHost + ?Sized + 'static> McpLoopbackHttpServer<H> {
    pub async fn bind<M>(
        handler: McpRmcpHandler<H>,
        session_manager: Arc<M>,
        port: u16,
    ) -> io::Result<Self>
    where
        M: SessionManager + 'static,
    {
        if !MCP_HTTP_PORTS.contains(&port) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "MCP HTTP is restricted to ports 7317 and 7318",
            ));
        }
        let listener =
            TcpListener::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port)).await?;
        let address = listener.local_addr()?;
        let cancellation = TransportCancellationToken::new();
        let service = loopback_http_service_factory_with_cancellation(
            handler.clone(),
            session_manager,
            address.port(),
            cancellation.clone(),
        )?;
        let owner = Arc::new(McpLoopbackOwner {
            cancellation: cancellation.clone(),
            accept_task: tokio::sync::Mutex::new(None),
            handler,
        });
        let task_owner = Arc::clone(&owner);
        let accept_task = tokio::spawn(async move {
            let _task_owner = task_owner;
            accept_loop(listener, service, cancellation).await
        });
        *owner.accept_task.lock().await = Some(accept_task);
        Ok(Self { address, owner })
    }

    pub fn local_addr(&self) -> SocketAddr {
        self.address
    }

    pub async fn shutdown(self) -> Result<(), McpLoopbackShutdownError<H>> {
        self.owner.handler.revoke();
        self.owner.cancellation.cancel();
        let mut cleanup = McpLoopbackCleanup {
            owner: Arc::clone(&self.owner),
        };
        match cleanup.wait_timeout(HTTP_SERVER_SHUTDOWN_TIMEOUT).await {
            Ok(true) => Ok(()),
            Ok(false) => Err(McpLoopbackShutdownError {
                error: io::Error::new(
                    io::ErrorKind::TimedOut,
                    "bounded shutdown expired before join proof was available",
                ),
                cleanup,
            }),
            Err(error) => Err(McpLoopbackShutdownError { error, cleanup }),
        }
    }
}

impl<H: McpHost + ?Sized + 'static> Drop for McpLoopbackHttpServer<H> {
    fn drop(&mut self) {
        self.owner.handler.revoke();
        self.owner.cancellation.cancel();
    }
}

async fn accept_loop<H, M>(
    listener: TcpListener,
    service: StreamableHttpService<McpRmcpHandler<H>, M>,
    cancellation: TransportCancellationToken,
) -> io::Result<()>
where
    H: McpHost + ?Sized + 'static,
    M: SessionManager + 'static,
{
    let mut connections = JoinSet::new();
    let permits = Arc::new(Semaphore::new(MAX_HTTP_CONNECTIONS));
    loop {
        let accepted = tokio::select! {
            biased;
            _ = cancellation.cancelled() => break,
            result = listener.accept() => Some(result?),
            _ = connections.join_next(), if !connections.is_empty() => None,
        };
        let Some((stream, _peer)) = accepted else {
            continue;
        };
        let Ok(permit) = Arc::clone(&permits).try_acquire_owned() else {
            drop(stream);
            continue;
        };
        let connection_service = TowerToHyperService::new(service.clone());
        connections.spawn(async move {
            let _permit = permit;
            let builder = http1::Builder::new();
            let _ = builder
                .serve_connection(TokioIo::new(stream), connection_service)
                .await;
        });
    }

    if tokio::time::timeout(HTTP_CONNECTION_DRAIN_TIMEOUT, async {
        while connections.join_next().await.is_some() {}
    })
    .await
    .is_err()
    {
        connections.abort_all();
        while connections.join_next().await.is_some() {}
    }
    Ok(())
}
