// SPDX-License-Identifier: Apache-2.0
pub mod commands;
pub mod platform;
pub mod schemas;
pub mod services;
pub mod shared;
pub mod state;

use schemas::protocol::{HostHealth, OwnerId};
use tauri::http::header::{HeaderValue, CONTENT_TYPE};
use tauri::{Manager, WebviewWindowBuilder, WindowEvent};

/// Reports host liveness. The owner is derived from the invoking trusted
/// webview window, never from the payload.
#[cfg(all(windows, target_arch = "x86_64"))]
#[tauri::command]
fn host_health(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, commands::frontend_files::FrontendFilesState>,
) -> Result<HostHealth, String> {
    let owner = commands::frontend_files::verify_trusted_window(&window, &state)?;
    Ok(HostHealth::for_owner(&owner))
}

#[cfg(not(all(windows, target_arch = "x86_64")))]
#[tauri::command]
fn host_health(window: tauri::WebviewWindow) -> Result<HostHealth, String> {
    let owner = OwnerId::from_label(window.label()).map_err(|error| error.to_string())?;
    Ok(HostHealth::for_owner(&owner))
}

fn is_trusted_app_asset_uri(uri: &tauri::http::Uri) -> bool {
    let Some(scheme) = uri.scheme_str() else {
        return false;
    };
    let Some(authority) = uri.authority().map(|auth| auth.as_str()) else {
        return false;
    };
    (scheme.eq_ignore_ascii_case("tauri") && authority.eq_ignore_ascii_case("localhost"))
        || (scheme.eq_ignore_ascii_case("http")
            && authority.eq_ignore_ascii_case("tauri.localhost"))
}

fn trusted_static_mime(path: &str) -> Option<&'static str> {
    let ext = std::path::Path::new(path).extension()?.to_str()?;
    if ext.eq_ignore_ascii_case("js") || ext.eq_ignore_ascii_case("mjs") {
        Some("text/javascript")
    } else if ext.eq_ignore_ascii_case("css") {
        Some("text/css")
    } else if ext.eq_ignore_ascii_case("html") || ext.eq_ignore_ascii_case("htm") {
        Some("text/html")
    } else if ext.eq_ignore_ascii_case("json") || ext.eq_ignore_ascii_case("map") {
        Some("application/json")
    } else if ext.eq_ignore_ascii_case("svg") {
        Some("image/svg+xml")
    } else if ext.eq_ignore_ascii_case("wasm") {
        Some("application/wasm")
    } else {
        None
    }
}

fn setup_main_window(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let main_config = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == "main")
        .cloned()
        .ok_or("missing main window config")?;

    // Register the configured document window before creating its webview, so
    // no command invocation can precede trusted-owner registration.
    #[cfg(all(windows, target_arch = "x86_64"))]
    app.state::<commands::frontend_files::FrontendFilesState>()
        .register_document_window_label(&main_config.label)
        .map_err(|error| std::io::Error::other(error))?;

    // Keep the same trusted static MIME handling for release custom-protocol
    // assets and the configured development URL.
    WebviewWindowBuilder::from_config(app, &main_config)?
        .on_web_resource_request(|request, response| {
            if response.status().is_success() && is_trusted_app_asset_uri(request.uri()) {
                if let Some(mime) = trusted_static_mime(request.uri().path()) {
                    response
                        .headers_mut()
                        .insert(CONTENT_TYPE, HeaderValue::from_static(mime));
                }
            }
        })
        .build()?;

    Ok(())
}

pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .on_window_event(|window, event| {
            if let WindowEvent::Destroyed = event {
                if let Ok(owner) = OwnerId::from_label(window.label()) {
                    #[cfg(all(windows, target_arch = "x86_64"))]
                    {
                        // Use the coordinated lifecycle path: it revokes file
                        // tokens, watches and workspace sessions, transferring
                        // owned watcher cleanup to the reserved reaper workers.
                        window
                            .state::<commands::frontend_files::FrontendFilesState>()
                            .revoke_owner(&owner);
                    }
                    #[cfg(not(all(windows, target_arch = "x86_64")))]
                    state::sessions::registry().revoke_owner(&owner);
                }
            }
        })
        .setup(|app| {
            #[cfg(all(windows, target_arch = "x86_64"))]
            {
                let data_dir = app.path().app_data_dir()?;
                std::fs::create_dir_all(&data_dir)?;

                // Construct one app-lifetime state. Its shared Arc<FilesystemService>
                // is the service used by all G2 handlers and future G3 consumers.
                let files = commands::frontend_files::FrontendFilesState::with_data_dir(data_dir)?;
                if !app.manage(files) {
                    return Err(std::io::Error::other("FrontendFilesState is already managed")
                    .into());
                }
            }
            setup_main_window(app)?;
            #[cfg(feature = "g1-prototypes")]
            commands::prototype::setup(app)?;
            Ok(())
        });

// The public TypeScript compile adapter remains unchanged. These four G3
// commands are intentionally not registered or permissioned until the real
// compile coordinator is integrated; no placeholder success route is provided.
#[cfg(all(windows, target_arch = "x86_64", feature = "g1-prototypes"))]
let builder = builder.invoke_handler(tauri::generate_handler![
    host_health,
    commands::frontend_files::frontend_open_workspace,
    commands::frontend_files::frontend_list_recent,
    commands::frontend_files::frontend_open_recent,
    commands::frontend_files::frontend_remove_recent,
    commands::frontend_files::frontend_list_files,
    commands::frontend_files::frontend_read_file,
    commands::frontend_files::frontend_take_file_pdf,
    commands::frontend_files::frontend_write_file,
    commands::frontend_files::frontend_save_as,
    commands::frontend_files::frontend_watch_start,
    commands::frontend_files::frontend_watch_stop,
    commands::frontend_files::frontend_close_workspace,
    commands::prototype::prototype_bytes,
    commands::prototype::prototype_pdf
]);

#[cfg(all(windows, target_arch = "x86_64", not(feature = "g1-prototypes")))]
let builder = builder.invoke_handler(tauri::generate_handler![
    host_health,
    commands::frontend_files::frontend_open_workspace,
    commands::frontend_files::frontend_list_recent,
    commands::frontend_files::frontend_open_recent,
    commands::frontend_files::frontend_remove_recent,
    commands::frontend_files::frontend_list_files,
    commands::frontend_files::frontend_read_file,
    commands::frontend_files::frontend_take_file_pdf,
    commands::frontend_files::frontend_write_file,
    commands::frontend_files::frontend_save_as,
    commands::frontend_files::frontend_watch_start,
    commands::frontend_files::frontend_watch_stop,
    commands::frontend_files::frontend_close_workspace
]);

#[cfg(feature = "g1-prototypes")]
#[cfg(not(all(windows, target_arch = "x86_64")))]
let builder = builder.invoke_handler(tauri::generate_handler![
    host_health,
    commands::prototype::prototype_bytes,
    commands::prototype::prototype_pdf
]);

#[cfg(all(
    not(all(windows, target_arch = "x86_64")),
    not(feature = "g1-prototypes")
))]
let builder = builder.invoke_handler(tauri::generate_handler![host_health]);

builder
        .run(tauri::generate_context!())
        .expect("error while running the ModuTeX desktop host");
}

#[cfg(test)]
#[path = "../tests/unit/lib.rs"]
mod asset_tests;

#[cfg(test)]
mod g2_capability_tests {
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
            serde_json::from_str(include_str!("../capabilities/main.json")).unwrap();
        assert_eq!(capability["local"], serde_json::json!(true));
        assert_eq!(capability["windows"], serde_json::json!(["main"]));
        assert_eq!(
            capability["permissions"],
            serde_json::json!([
                "allow-host-health",
                "allow-frontend-files",
                "core:event:allow-listen",
                "core:event:allow-unlisten"
            ])
        );

        let permission_block = include_str!("../permissions/frontend_files.toml")
            .split_once("commands.allow = [")
            .expect("frontend command permission")
            .1
            .split_once(']')
            .expect("closed frontend command permission")
            .0;
        assert_eq!(quoted_values(permission_block), G2_FILE_COMMANDS);

        let manifest_block = include_str!("../build.rs")
            .split_once(".commands(&[")
            .expect("Tauri app manifest command list")
            .1
            .split_once("])")
            .expect("closed Tauri app manifest command list")
            .0;
        assert_eq!(quoted_values(manifest_block), MANIFEST_COMMANDS);
    }
}
