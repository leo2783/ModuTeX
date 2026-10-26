// SPDX-License-Identifier: Apache-2.0
//! Uses the actual native package binary as a child process and an official
//! rmcp client. Run against a Windows desktop host whose opt-in HTTP service
//! has been explicitly enabled.

#[cfg(all(windows, target_arch = "x86_64"))]
#[tokio::test]
#[ignore = "requires the Windows desktop host with its opt-in MCP HTTP service enabled on port 7317"]
async fn official_client_uses_the_actual_stdio_binary_and_shared_http_host() {
    use std::collections::HashSet;

    use rmcp::{
        model::{CallToolRequestParams, CallToolResponse},
        service::ServiceExt,
        transport::child_process::TokioChildProcess,
    };
    use serde_json::{json, Value};
    use tokio::process::Command;

    let mut command = Command::new(env!("CARGO_BIN_EXE_modutex-mcp-stdio"));
    command.arg("7317");
    let transport = TokioChildProcess::new(command).expect("spawn actual stdio executable");
    let client = ().serve(transport).await.expect("official SDK initialization");
    let tools = client.list_all_tools().await.expect("tools/list");
    let names = tools
        .iter()
        .map(|tool| tool.name.as_ref())
        .collect::<HashSet<_>>();
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
        .into_iter()
        .collect()
    );

    let request: CallToolRequestParams =
        serde_json::from_value(json!({"name": "get_editor_state", "arguments": {}})).unwrap();
    let response = client
        .call_tool_once(request)
        .await
        .expect("stdio proxy reaches the shared HTTP application host");
    let CallToolResponse::Complete(result) = response else {
        panic!("editor-state tool call must return a completed SDK result");
    };
    let value = serde_json::to_value(result).unwrap();
    assert_ne!(value.get("isError"), Some(&Value::Bool(true)));
    let snapshot: Value =
        serde_json::from_str(value["content"][0]["text"].as_str().unwrap()).unwrap();
    assert!(snapshot["workspaces"].is_array());
    assert!(snapshot["workspaces"]
        .as_array()
        .unwrap()
        .iter()
        .all(|workspace| {
            workspace.get("owner").is_none()
                && workspace.get("ownerGeneration").is_none()
                && workspace.get("generation").is_none()
        }));

    let request: CallToolRequestParams = serde_json::from_value(json!({
        "name": "set_compile_command",
        "arguments": {"command": "engine {main}"}
    }))
    .unwrap();
    let response = client
        .call_tool_once(request)
        .await
        .expect("default-denied command permission returns a typed tool result");
    let CallToolResponse::Complete(result) = response else {
        panic!("the MCP tool call completes with an SDK result");
    };
    assert_eq!(serde_json::to_value(result).unwrap()["isError"], true);
    let _ = client.cancel().await;
}
