// SPDX-License-Identifier: Apache-2.0
const BASE_COMMANDS: &[&str] = &[
    "host_health",
    "frontend_new_window",
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
];

#[cfg(feature = "mcp")]
const MCP_COMMANDS: &[&str] = &[
    "frontend_get_mcp_compile_command_permission",
    "frontend_set_mcp_compile_command_permission",
    "frontend_mcp_set_enabled",
    "frontend_mcp_reply",
];

#[cfg(feature = "mcp")]
const TOTAL_COMMANDS: usize = BASE_COMMANDS.len() + MCP_COMMANDS.len();

#[cfg(feature = "mcp")]
static COMMANDS_WITH_MCP: [&str; TOTAL_COMMANDS] = {
    let mut commands = [""; TOTAL_COMMANDS];
    let mut index = 0;
    while index < BASE_COMMANDS.len() {
        commands[index] = BASE_COMMANDS[index];
        index += 1;
    }
    let mut mcp_index = 0;
    while mcp_index < MCP_COMMANDS.len() {
        commands[BASE_COMMANDS.len() + mcp_index] = MCP_COMMANDS[mcp_index];
        mcp_index += 1;
    }
    commands
};

#[cfg(feature = "mcp")]
static COMMANDS: &[&str] = &COMMANDS_WITH_MCP;
#[cfg(not(feature = "mcp"))]
static COMMANDS: &[&str] = BASE_COMMANDS;

fn main() {
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let target_env = std::env::var("CARGO_CFG_TARGET_ENV").unwrap_or_default();
    if target_os == "windows" && target_env == "msvc" {
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!(
            "cargo:rustc-link-arg=/MANIFESTDEPENDENCY:type='win32' name='Microsoft.Windows.Common-Controls' version='6.0.0.0' processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'"
        );
        // Tauri embeds the application manifest as a resource.
        println!("cargo:rustc-link-arg-bins=/MANIFEST:NO");
    }

    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to run tauri-build");
}
