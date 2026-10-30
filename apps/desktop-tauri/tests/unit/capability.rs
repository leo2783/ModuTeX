// SPDX-License-Identifier: Apache-2.0
const UPDATER_PERMISSIONS: &[&str] = &[
    "updater:allow-check",
    "updater:allow-download",
    "updater:allow-install",
];

const G2_FILE_COMMANDS: &[&str] = &[
    "frontend_open_workspace",
    "frontend_list_recent",
    "frontend_open_recent",
    "frontend_remove_recent",
    "frontend_list_files",
    "frontend_read_file",
    "frontend_take_file_pdf",
    "frontend_write_file",
    "frontend_save_as",
    "frontend_watch_start",
    "frontend_watch_stop",
    "frontend_close_workspace",
];

const NEW_WINDOW_COMMANDS: &[&str] = &["frontend_new_window"];

const MANIFEST_COMMANDS: &[&str] = &[
    "host_health",
    "frontend_new_window",
    "frontend_open_workspace",
    "frontend_take_pending_open",
    "frontend_list_recent",
    "frontend_open_recent",
    "frontend_remove_recent",
    "frontend_list_files",
    "frontend_read_file",
    "frontend_take_file_pdf",
    "frontend_write_file",
    "frontend_save_as",
    "frontend_watch_start",
    "frontend_watch_stop",
    "frontend_close_workspace",
    "frontend_workspace_files_tree",
    "frontend_workspace_files_scan",
    "frontend_workspace_files_search",
    "frontend_workspace_files_cancel",
    "frontend_workspace_files_stat",
    "frontend_workspace_files_create_file",
    "frontend_workspace_files_create_directory",
    "frontend_workspace_files_move",
    "frontend_workspace_files_rename",
    "frontend_workspace_files_copy",
    "frontend_workspace_files_recycle",
    "frontend_workspace_files_delete",
    "frontend_workspace_files_undo_delete",
    "frontend_workspace_files_reveal",
    "frontend_start_compile",
    "frontend_compile_result",
    "frontend_cancel_compile",
    "frontend_take_compile_pdf",
    "frontend_take_compile_synctex",
    "frontend_format_latex",
    "frontend_draft_compile",
    "frontend_draft_typeset_paragraph",
    "frontend_draft_stop",
    "frontend_draft_takeover",
    "frontend_draft_save_pdf",
    "frontend_get_compile_config",
    "frontend_update_compile_config",
    "frontend_settings_read",
    "frontend_settings_set",
    "frontend_settings_reset",
    "frontend_settings_import",
    "frontend_terminal_availability",
    "frontend_terminal_spawn",
    "frontend_terminal_input",
    "frontend_terminal_resize",
    "frontend_terminal_kill",
    "frontend_git_availability",
    "frontend_git_status",
    "frontend_git_diff",
    "frontend_git_log",
    "frontend_git_show",
    "frontend_git_init",
    "frontend_git_stage",
    "frontend_git_unstage",
    "frontend_git_discard",
    "frontend_git_commit",
    "frontend_git_user_name",
    "prototype_bytes",
    "prototype_pdf",
    #[cfg(feature = "mcp")]
    "frontend_get_mcp_compile_command_permission",
    #[cfg(feature = "mcp")]
    "frontend_set_mcp_compile_command_permission",
    #[cfg(feature = "mcp")]
    "frontend_mcp_set_enabled",
    #[cfg(feature = "mcp")]
    "frontend_mcp_reply",
];

fn quoted_values(block: &str) -> Vec<&str> {
    block
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            let line = line.strip_suffix(',').unwrap_or(line);
            line.strip_prefix('"')?.strip_suffix('"')
        })
        .collect()
}

#[test]
fn capability_and_build_manifest_have_the_closed_integrated_allowlist() {
    let capability: serde_json::Value =
        serde_json::from_str(include_str!("../../capabilities/main.json")).unwrap();
    assert_eq!(capability["local"], serde_json::json!(true));
    assert_eq!(
        capability["windows"],
        serde_json::json!(["main", "document-*"])
    );
    let mut expected_permissions = vec![
        "allow-host-health",
        "allow-frontend-new-window",
        "allow-frontend-pending-open",
        "allow-frontend-files",
        "allow-frontend-compile",
        "allow-frontend-source-format",
        "allow-frontend-compile-config",
        "allow-frontend-settings",
        "allow-frontend-terminal",
        "allow-frontend-workspace-files",
        "allow-frontend-git",
        "allow-frontend-draft",
        "core:event:allow-listen",
        "core:event:allow-unlisten",
        "core:window:allow-close",
        "core:window:allow-destroy",
        "core:resources:allow-close",
        "dialog:allow-message",
    ];
    expected_permissions.extend(UPDATER_PERMISSIONS.iter().copied());
    assert_eq!(
        capability["permissions"],
        serde_json::json!(expected_permissions)
    );

    let new_window_permission = include_str!("../../permissions/frontend-new-window.toml");
    assert!(new_window_permission
        .lines()
        .any(|line| line.trim() == "identifier = \"allow-frontend-new-window\""));
    let new_window_commands = new_window_permission
        .split_once("commands.allow = [")
        .expect("new-window command permission")
        .1
        .split_once(']')
        .expect("closed new-window command permission")
        .0;
    assert_eq!(quoted_values(new_window_commands), NEW_WINDOW_COMMANDS);

    let permission_block = include_str!("../../permissions/frontend_files.toml")
        .split_once("commands.allow = [")
        .expect("frontend command permission")
        .1
        .split_once(']')
        .expect("closed frontend command permission")
        .0;
    assert_eq!(quoted_values(permission_block), G2_FILE_COMMANDS);

    let compile_permission = include_str!("../../permissions/frontend-compile.toml");
    assert!(compile_permission
        .lines()
        .any(|line| line.trim() == "identifier = \"allow-frontend-compile\""));
    let compile_commands = compile_permission
        .split_once("commands.allow = [")
        .expect("compile command permission")
        .1
        .split_once(']')
        .expect("closed compile command permission")
        .0;
    assert_eq!(
        quoted_values(compile_commands),
        &[
            "frontend_start_compile",
            "frontend_compile_result",
            "frontend_cancel_compile",
            "frontend_take_compile_pdf",
            "frontend_take_compile_synctex",
        ]
    );
    let config_permission = include_str!("../../permissions/frontend_compile_config.toml");
    assert!(config_permission
        .lines()
        .any(|line| line.trim() == "identifier = \"allow-frontend-compile-config\""));
    let config_commands = config_permission
        .split_once("commands.allow = [")
        .expect("compile config command permission")
        .1
        .split_once(']')
        .expect("closed compile config command permission")
        .0;
    assert_eq!(
        quoted_values(config_commands),
        &[
            "frontend_get_compile_config",
            "frontend_update_compile_config",
        ]
    );

    let mcp_permission = include_str!("../../permissions/frontend-mcp.toml");
    let mcp_commands = mcp_permission
        .split_once("commands.allow = [")
        .unwrap()
        .1
        .split_once(']')
        .unwrap()
        .0;
    assert_eq!(
        quoted_values(mcp_commands),
        &[
            "frontend_get_mcp_compile_command_permission",
            "frontend_set_mcp_compile_command_permission",
            "frontend_mcp_set_enabled",
            "frontend_mcp_reply",
        ]
    );

    #[cfg(feature = "mcp")]
    let manifest_block = format!(
        "{}\n{}",
        include_str!("../../build.rs")
            .split_once("const BASE_COMMANDS: &[&str] = &[")
            .expect("Tauri app manifest base command list")
            .1
            .split_once("];")
            .expect("closed Tauri app manifest base command list")
            .0,
        include_str!("../../build.rs")
            .split_once("const MCP_COMMANDS: &[&str] = &[")
            .expect("Tauri app manifest mcp command list")
            .1
            .split_once("];")
            .expect("closed Tauri app manifest mcp command list")
            .0
    );
    #[cfg(feature = "mcp")]
    let manifest_block = manifest_block.as_str();
    #[cfg(not(feature = "mcp"))]
    let manifest_block = include_str!("../../build.rs")
        .split_once("const BASE_COMMANDS: &[&str] = &[")
        .expect("Tauri app manifest command list")
        .1
        .split_once("];")
        .expect("closed Tauri app manifest command list")
        .0;
    assert_eq!(quoted_values(manifest_block), MANIFEST_COMMANDS);
}
