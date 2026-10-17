// SPDX-License-Identifier: Apache-2.0
pub mod protocol;
pub mod relative_path;
pub mod sessions;

use protocol::{HostHealth, OwnerId};
use tauri::WindowEvent;

/// Reports host liveness. The owner is derived from the invoking trusted
/// webview window, never from the payload.
#[tauri::command]
fn host_health(window: tauri::WebviewWindow) -> Result<HostHealth, String> {
    let owner = OwnerId::from_label(window.label()).map_err(|error| error.to_string())?;
    Ok(HostHealth::for_owner(&owner))
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .on_window_event(|window, event| {
            if let WindowEvent::Destroyed = event {
                if let Ok(owner) = OwnerId::from_label(window.label()) {
                    sessions::registry().revoke_owner(&owner);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![host_health])
        .run(tauri::generate_context!())
        .expect("error while running the ModuTeX desktop host");
}
