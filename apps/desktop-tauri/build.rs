// SPDX-License-Identifier: Apache-2.0
fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
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
        ]),
    ))
    .expect("failed to run tauri-build");
}
