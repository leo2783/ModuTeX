// SPDX-License-Identifier: Apache-2.0
use serde_json::Value;

const UPDATER_PERMISSIONS: &[&str] = &[
    "updater:allow-check",
    "updater:allow-download",
    "updater:allow-install",
];

const COMMANDS: &[(&str, &str)] = &[
    (
        "frontend_take_pending_open",
        "commands::frontend_files::frontend_take_pending_open",
    ),
    (
        "frontend_format_latex",
        "commands::frontend_source_format::frontend_format_latex",
    ),
    (
        "frontend_new_window",
        "commands::frontend_window::frontend_new_window",
    ),
    (
        "frontend_settings_read",
        "commands::frontend_settings::frontend_settings_read",
    ),
    (
        "frontend_settings_set",
        "commands::frontend_settings::frontend_settings_set",
    ),
    (
        "frontend_settings_reset",
        "commands::frontend_settings::frontend_settings_reset",
    ),
    (
        "frontend_settings_import",
        "commands::frontend_settings::frontend_settings_import",
    ),
    (
        "frontend_open_workspace",
        "commands::frontend_files::frontend_open_workspace",
    ),
    (
        "frontend_list_recent",
        "commands::frontend_files::frontend_list_recent",
    ),
    (
        "frontend_open_recent",
        "commands::frontend_files::frontend_open_recent",
    ),
    (
        "frontend_remove_recent",
        "commands::frontend_files::frontend_remove_recent",
    ),
    (
        "frontend_list_files",
        "commands::frontend_files::frontend_list_files",
    ),
    (
        "frontend_read_file",
        "commands::frontend_files::frontend_read_file",
    ),
    (
        "frontend_take_file_pdf",
        "commands::frontend_files::frontend_take_file_pdf",
    ),
    (
        "frontend_write_file",
        "commands::frontend_files::frontend_write_file",
    ),
    (
        "frontend_save_as",
        "commands::frontend_files::frontend_save_as",
    ),
    (
        "frontend_watch_start",
        "commands::frontend_files::frontend_watch_start",
    ),
    (
        "frontend_watch_stop",
        "commands::frontend_files::frontend_watch_stop",
    ),
    (
        "frontend_close_workspace",
        "commands::frontend_files::frontend_close_workspace",
    ),
    (
        "frontend_workspace_files_tree",
        "commands::frontend_files::frontend_workspace_files_tree",
    ),
    (
        "frontend_workspace_files_scan",
        "commands::frontend_files::frontend_workspace_files_scan",
    ),
    (
        "frontend_workspace_files_search",
        "commands::frontend_files::frontend_workspace_files_search",
    ),
    (
        "frontend_workspace_files_cancel",
        "commands::frontend_files::frontend_workspace_files_cancel",
    ),
    (
        "frontend_workspace_files_stat",
        "commands::frontend_files::frontend_workspace_files_stat",
    ),
    (
        "frontend_workspace_files_create_file",
        "commands::frontend_files::frontend_workspace_files_create_file",
    ),
    (
        "frontend_workspace_files_create_directory",
        "commands::frontend_files::frontend_workspace_files_create_directory",
    ),
    (
        "frontend_workspace_files_move",
        "commands::frontend_files::frontend_workspace_files_move",
    ),
    (
        "frontend_workspace_files_rename",
        "commands::frontend_files::frontend_workspace_files_rename",
    ),
    (
        "frontend_workspace_files_copy",
        "commands::frontend_files::frontend_workspace_files_copy",
    ),
    (
        "frontend_workspace_files_recycle",
        "commands::frontend_files::frontend_workspace_files_recycle",
    ),
    (
        "frontend_workspace_files_delete",
        "commands::frontend_files::frontend_workspace_files_delete",
    ),
    (
        "frontend_workspace_files_undo_delete",
        "commands::frontend_files::frontend_workspace_files_undo_delete",
    ),
    (
        "frontend_workspace_files_reveal",
        "commands::frontend_files::frontend_workspace_files_reveal",
    ),
    (
        "frontend_start_compile",
        "commands::frontend_compile::frontend_start_compile",
    ),
    (
        "frontend_compile_result",
        "commands::frontend_compile::frontend_compile_result",
    ),
    (
        "frontend_cancel_compile",
        "commands::frontend_compile::frontend_cancel_compile",
    ),
    (
        "frontend_take_compile_pdf",
        "commands::frontend_compile::frontend_take_compile_pdf",
    ),
    (
        "frontend_take_compile_synctex",
        "commands::frontend_compile::frontend_take_compile_synctex",
    ),
    (
        "frontend_get_compile_config",
        "commands::frontend_compile_config::frontend_get_compile_config",
    ),
    (
        "frontend_update_compile_config",
        "commands::frontend_compile_config::frontend_update_compile_config",
    ),
    #[cfg(feature = "mcp")]
    (
        "frontend_get_mcp_compile_command_permission",
        "commands::frontend_compile_config::frontend_get_mcp_compile_command_permission",
    ),
    #[cfg(feature = "mcp")]
    (
        "frontend_set_mcp_compile_command_permission",
        "commands::frontend_compile_config::frontend_set_mcp_compile_command_permission",
    ),
    (
        "frontend_terminal_availability",
        "commands::frontend_terminal::frontend_terminal_availability",
    ),
    (
        "frontend_terminal_spawn",
        "commands::frontend_terminal::frontend_terminal_spawn",
    ),
    (
        "frontend_terminal_input",
        "commands::frontend_terminal::frontend_terminal_input",
    ),
    (
        "frontend_terminal_resize",
        "commands::frontend_terminal::frontend_terminal_resize",
    ),
    (
        "frontend_terminal_kill",
        "commands::frontend_terminal::frontend_terminal_kill",
    ),
    (
        "frontend_git_availability",
        "commands::frontend_git::frontend_git_availability",
    ),
    (
        "frontend_git_status",
        "commands::frontend_git::frontend_git_status",
    ),
    (
        "frontend_git_diff",
        "commands::frontend_git::frontend_git_diff",
    ),
    (
        "frontend_git_log",
        "commands::frontend_git::frontend_git_log",
    ),
    (
        "frontend_git_show",
        "commands::frontend_git::frontend_git_show",
    ),
    (
        "frontend_git_init",
        "commands::frontend_git::frontend_git_init",
    ),
    (
        "frontend_git_stage",
        "commands::frontend_git::frontend_git_stage",
    ),
    (
        "frontend_git_unstage",
        "commands::frontend_git::frontend_git_unstage",
    ),
    (
        "frontend_git_discard",
        "commands::frontend_git::frontend_git_discard",
    ),
    (
        "frontend_git_commit",
        "commands::frontend_git::frontend_git_commit",
    ),
    (
        "frontend_git_user_name",
        "commands::frontend_git::frontend_git_user_name",
    ),
];

#[test]
fn main_capability_is_the_exact_local_g2345_and_updater_union() {
    let capability: Value =
        serde_json::from_str(include_str!("../../capabilities/main.json")).unwrap();
    assert_eq!(capability["local"], true);
    assert_eq!(
        capability["windows"],
        serde_json::json!(["main", "document-*"])
    );

    let actual = capability["permissions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|value| value.as_str().unwrap().to_owned())
        .collect::<Vec<_>>();
    let mut actual = actual;
    actual.sort();

    let mut expected = vec![
        "allow-host-health".to_owned(),
        "allow-frontend-new-window".to_owned(),
        "allow-frontend-pending-open".to_owned(),
        "allow-frontend-files".to_owned(),
        "allow-frontend-compile".to_owned(),
        "allow-frontend-source-format".to_owned(),
        "allow-frontend-compile-config".to_owned(),
        "allow-frontend-settings".to_owned(),
        "allow-frontend-terminal".to_owned(),
        "allow-frontend-workspace-files".to_owned(),
        "allow-frontend-git".to_owned(),
        "allow-frontend-draft".to_owned(),
        "core:event:allow-listen".to_owned(),
        "core:event:allow-unlisten".to_owned(),
        "core:window:allow-close".to_owned(),
        "core:window:allow-destroy".to_owned(),
        "core:resources:allow-close".to_owned(),
        "dialog:allow-message".to_owned(),
    ];
    expected.extend(
        UPDATER_PERMISSIONS
            .iter()
            .map(|permission| (*permission).to_owned()),
    );
    expected.sort();
    assert_eq!(actual, expected);
}

#[test]
fn static_command_manifest_matches_both_handler_declarations() {
    let manifest = include_str!("../../build.rs");
    let handlers = include_str!("../../src/lib.rs");

    assert_eq!(manifest.matches("\"host_health\"").count(), 1);
    for (name, handler) in COMMANDS {
        assert_eq!(
            manifest.matches(&format!("\"{name}\"")).count(),
            1,
            "{name}"
        );
        assert_eq!(handlers.matches(handler).count(), 2, "{handler}");
    }
    assert_eq!(manifest.matches("\"prototype_bytes\"").count(), 1);
    assert_eq!(manifest.matches("\"prototype_pdf\"").count(), 1);
    assert!(handlers.contains("pub mod compile_config;"));
}
