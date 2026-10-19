// SPDX-License-Identifier: Apache-2.0
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

const MANIFEST_COMMANDS: &[&str] = &[
    "host_health",
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
    "prototype_bytes",
    "prototype_pdf",
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
fn capability_and_build_manifest_have_the_closed_g2_allowlist() {
    let capability: serde_json::Value =
        serde_json::from_str(include_str!("../../capabilities/main.json")).unwrap();
    assert_eq!(capability["local"], serde_json::json!(true));
    assert_eq!(capability["windows"], serde_json::json!(["main"]));
    assert_eq!(
        capability["permissions"],
        serde_json::json!([
            "allow-host-health",
            "allow-frontend-files",
            "core:event:allow-listen",
            "core:event:allow-unlisten",
            "dialog:allow-message"
        ])
    );

    let permission_block = include_str!("../../permissions/frontend_files.toml")
        .split_once("commands.allow = [")
        .expect("frontend command permission")
        .1
        .split_once(']')
        .expect("closed frontend command permission")
        .0;
    assert_eq!(quoted_values(permission_block), G2_FILE_COMMANDS);

    let manifest_block = include_str!("../../build.rs")
        .split_once(".commands(&[")
        .expect("Tauri app manifest command list")
        .1
        .split_once("])")
        .expect("closed Tauri app manifest command list")
        .0;
    assert_eq!(quoted_values(manifest_block), MANIFEST_COMMANDS);
}
