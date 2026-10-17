// SPDX-License-Identifier: Apache-2.0
fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&["host_health"])),
    )
    .expect("failed to run tauri-build");
}
