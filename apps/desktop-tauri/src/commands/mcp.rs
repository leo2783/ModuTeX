// SPDX-License-Identifier: Apache-2.0
//! Narrow commands for the opt-in MCP service and trusted renderer rendezvous.
//! The invoking Tauri window, not a renderer argument, supplies the owner.

use tauri::{State, WebviewWindow};

use crate::{
    services::mcp::runtime::McpRuntime,
    state::mcp::{McpBridgeState, McpRendererReply},
};

#[tauri::command]
pub async fn frontend_mcp_set_enabled(
    window: WebviewWindow,
    bridge: State<'_, std::sync::Arc<McpBridgeState>>,
    runtime: State<'_, McpRuntime>,
    enabled: bool,
    port: Option<u16>,
) -> Result<bool, String> {
    let owner = bridge.authorize_window_label(window.label())?;
    let generation = bridge.registered_window_generation(&owner)?;
    bridge
        .validate_window(&owner, generation)
        .map_err(|_| "access denied: stale document window".to_owned())?;
    runtime.set_enabled(enabled, port.unwrap_or(7317)).await
}

#[tauri::command]
pub fn frontend_mcp_reply(
    window: WebviewWindow,
    bridge: State<'_, std::sync::Arc<McpBridgeState>>,
    reply: McpRendererReply,
) -> Result<(), String> {
    let owner = bridge.authorize_window_label(window.label())?;
    bridge.reply_from_window(&owner, reply)
}
