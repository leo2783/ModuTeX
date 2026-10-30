// SPDX-License-Identifier: Apache-2.0
//! App-lifetime, opt-in owner of the local HTTP service. No listener is
//! created during application setup.

use std::{
    sync::{Arc, Mutex, PoisonError},
    time::Duration,
};

use rmcp::transport::streamable_http_server::session::local::LocalSessionManager;
use tauri::async_runtime::JoinHandle;
use tokio::sync::oneshot;

use crate::{
    schemas::protocol::OwnerId,
    services::mcp::{
        core::McpCore,
        host::McpDesktopHost,
        http::{McpLoopbackCleanup, McpLoopbackHttpServer},
        rmcp::{McpRmcpHandler, MCP_HTTP_PORTS},
    },
    state::mcp::McpBridgeState,
};

pub const MCP_SERVICE_OWNER: &str = "mcp_service";

struct RuntimeState {
    server: Option<McpLoopbackHttpServer<McpDesktopHost>>,
    cleanup: Vec<McpLoopbackCleanup<McpDesktopHost>>,
    service_generation: Option<u64>,
    shutdown_in_progress: bool,
}

impl RuntimeState {
    fn new() -> Self {
        Self {
            server: None,
            cleanup: Vec::new(),
            service_generation: None,
            shutdown_in_progress: false,
        }
    }
}

struct RuntimeInner {
    bridge: Arc<McpBridgeState>,
    state: tokio::sync::Mutex<RuntimeState>,
    shutdown_tasks: Mutex<Vec<JoinHandle<()>>>,
}

#[derive(Clone)]
pub struct McpRuntime {
    inner: Arc<RuntimeInner>,
}

impl McpRuntime {
    pub fn new(bridge: Arc<McpBridgeState>) -> Self {
        Self {
            inner: Arc::new(RuntimeInner {
                bridge,
                state: tokio::sync::Mutex::new(RuntimeState::new()),
                shutdown_tasks: Mutex::new(Vec::new()),
            }),
        }
    }

    pub async fn set_enabled(&self, enabled: bool, port: u16) -> Result<bool, String> {
        self.join_finished_shutdown_tasks().await;
        self.set_enabled_inner(enabled, port).await
    }

    async fn set_enabled_inner(&self, enabled: bool, port: u16) -> Result<bool, String> {
        if enabled {
            let mut state = self.inner.state.lock().await;
            if state.server.is_some() {
                if state
                    .service_generation
                    .is_some_and(|generation| self.inner.bridge.service_is_active(generation))
                {
                    return Ok(true);
                }
                return Err("MCP shutdown is still in progress".to_owned());
            }
            if state.shutdown_in_progress {
                return Err("MCP shutdown is still in progress".to_owned());
            }
            if !MCP_HTTP_PORTS.contains(&port) {
                return Err("MCP HTTP accepts only ports 7317 and 7318".to_owned());
            }
            let index = 0;
            while index < state.cleanup.len() {
                match state.cleanup[index]
                    .wait_timeout(Duration::from_secs(3))
                    .await
                {
                    Ok(true) => {
                        state.cleanup.remove(index);
                    }
                    Ok(false) => {
                        return Err("previous MCP callbacks are still draining".to_owned());
                    }
                    Err(error) => return Err(format!("previous MCP cleanup failed: {error}")),
                }
            }

            let generation = self.inner.bridge.activate_service()?;
            let server = match self.start_server(generation, port).await {
                Ok(server) => server,
                Err(error) => {
                    self.inner.bridge.deactivate_service(generation);
                    return Err(error);
                }
            };
            if !self.inner.bridge.service_is_active(generation)
                || self.inner.bridge.live_window_count() == 0
            {
                self.inner.bridge.deactivate_service(generation);
                state.shutdown_in_progress = true;
                drop(state);
                let receiver = self.schedule_shutdown(server);
                let _ = receiver.await;
                return Err("MCP lost its final document owner during startup".to_owned());
            }
            state.service_generation = Some(generation);
            state.server = Some(server);
            Ok(true)
        } else {
            let (server, generation) = {
                let mut state = self.inner.state.lock().await;
                let generation = state.service_generation.take();
                if let Some(generation) = generation {
                    self.inner.bridge.deactivate_service(generation);
                }
                let server = state.server.take();
                if server.is_some() {
                    state.shutdown_in_progress = true;
                }
                (server, generation)
            };
            let Some(server) = server else {
                let _ = generation;
                return Ok(false);
            };
            let receiver = self.schedule_shutdown(server);
            match receiver.await {
                Ok(Ok(())) => Ok(false),
                Ok(Err(error)) => Err(error),
                Err(_) => Err("MCP shutdown supervisor did not return".to_owned()),
            }
        }
    }

    fn schedule_shutdown(
        &self,
        server: McpLoopbackHttpServer<McpDesktopHost>,
    ) -> oneshot::Receiver<Result<(), String>> {
        let (sender, receiver) = oneshot::channel();
        let inner = Arc::clone(&self.inner);
        let task = tauri::async_runtime::spawn(async move {
            let result = match server.shutdown().await {
                Ok(()) => Ok(()),
                Err(error) => {
                    let (shutdown_error, cleanup) = error.into_parts();
                    inner.state.lock().await.cleanup.push(cleanup);
                    Err(shutdown_error.to_string())
                }
            };
            inner.state.lock().await.shutdown_in_progress = false;
            let _ = sender.send(result);
        });
        self.inner
            .shutdown_tasks
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(task);
        receiver
    }

    async fn start_server(
        &self,
        generation: u64,
        port: u16,
    ) -> Result<McpLoopbackHttpServer<McpDesktopHost>, String> {
        let owner = OwnerId::from_label(MCP_SERVICE_OWNER).map_err(|error| error.to_string())?;
        let host = Arc::new(McpDesktopHost::new(
            Arc::clone(&self.inner.bridge),
            generation,
        ));
        let core = Arc::new(McpCore::new(host));
        let handler = McpRmcpHandler::from_trusted_host(core, owner, generation)
            .map_err(|error| error.to_string())?;
        McpLoopbackHttpServer::bind(handler, Arc::new(LocalSessionManager::default()), port)
            .await
            .map_err(|error| error.to_string())
    }

    /// Called by the Tauri destruction callback. The owned shutdown task and
    /// any timeout cleanup token remain retained in this app-lifetime state.
    pub fn window_closed(&self) {
        if self.inner.bridge.live_window_count() != 0
            || !self.inner.bridge.deactivate_current_service()
        {
            return;
        }
        let runtime = self.clone();
        let task = tauri::async_runtime::spawn(async move {
            let _ = runtime.set_enabled_inner(false, 7317).await;
        });
        self.inner
            .shutdown_tasks
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(task);
    }

    async fn join_finished_shutdown_tasks(&self) {
        let finished = {
            let mut tasks = self
                .inner
                .shutdown_tasks
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            let mut finished = Vec::new();
            let mut index = 0;
            while index < tasks.len() {
                if tasks[index].inner().is_finished() {
                    finished.push(tasks.swap_remove(index));
                } else {
                    index += 1;
                }
            }
            finished
        };
        for task in finished {
            let _ = task.await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::RuntimeState;

    #[test]
    fn mcp_listener_is_off_until_explicitly_enabled() {
        let state = RuntimeState::new();
        assert!(state.server.is_none());
        assert!(state.service_generation.is_none());
        assert!(!state.shutdown_in_progress);
    }
}
