// SPDX-License-Identifier: Apache-2.0
pub mod commands;
pub mod platform;
pub mod schemas;
pub mod services;
pub mod shared;
pub mod state;

#[cfg(all(windows, target_arch = "x86_64"))]
#[path = "state/compile_config.rs"]
pub mod compile_config;

use schemas::protocol::{HostHealth, OwnerId};
use tauri::http::header::{HeaderValue, CONTENT_TYPE};
use tauri::{Manager, WebviewWindowBuilder, WindowEvent};

/// Reports host liveness. The owner is derived from the invoking trusted
/// webview window, never from the payload.
#[cfg(all(windows, target_arch = "x86_64"))]
#[tauri::command]
fn host_health(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, state::desktop::FrontendFilesState>,
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

fn build_trusted_webview(
    app: &tauri::AppHandle,
    config: &tauri::utils::config::WindowConfig,
) -> Result<tauri::WebviewWindow, Box<dyn std::error::Error>> {
    Ok(WebviewWindowBuilder::from_config(app, config)?
        .on_web_resource_request(|request, response| {
            if response.status().is_success() && is_trusted_app_asset_uri(request.uri()) {
                if let Some(mime) = trusted_static_mime(request.uri().path()) {
                    response
                        .headers_mut()
                        .insert(CONTENT_TYPE, HeaderValue::from_static(mime));
                }
            }
        })
        .build()?)
}

#[cfg(all(windows, target_arch = "x86_64"))]
fn register_then_build_document_window<T>(
    files: &state::desktop::FrontendFilesState,
    label: &str,
    build: impl FnOnce(&OwnerId) -> Result<T, String>,
) -> Result<(OwnerId, T), String> {
    let owner = files.register_document_window_label(label)?;
    match build(&owner) {
        Ok(window) => Ok((owner, window)),
        Err(error) => {
            files.revoke_owner(&owner);
            Err(error)
        }
    }
}

#[cfg(all(windows, target_arch = "x86_64"))]
pub(crate) fn create_trusted_document_window(
    app: &tauri::AppHandle,
    config: &tauri::utils::config::WindowConfig,
    files: &state::desktop::FrontendFilesState,
) -> Result<tauri::WebviewWindow, String> {
    let (owner, window) = register_then_build_document_window(files, &config.label, |owner| {
        #[cfg(feature = "mcp")]
        let bridge = app.state::<std::sync::Arc<state::mcp::McpBridgeState>>();
        #[cfg(feature = "mcp")]
        if let Err(error) = bridge.register_window(owner.clone()) {
            bridge.close_window(owner);
            return Err(error.to_string());
        }
        #[cfg(not(feature = "mcp"))]
        let _ = owner;

        let result = build_trusted_webview(app, config).map_err(|error| error.to_string());
        #[cfg(feature = "mcp")]
        if result.is_err() {
            bridge.close_window(owner);
            app.state::<services::mcp::runtime::McpRuntime>()
                .window_closed();
        }
        result
    })?;

    #[cfg(feature = "mcp")]
    app.state::<std::sync::Arc<state::mcp::McpBridgeState>>()
        .set_focused(&owner);
    #[cfg(not(feature = "mcp"))]
    let _ = owner;

    Ok(window)
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

    #[cfg(all(windows, target_arch = "x86_64"))]
    {
        let files = app.state::<state::desktop::FrontendFilesState>();
        create_trusted_document_window(app.handle(), &main_config, &files)
            .map_err(std::io::Error::other)?;
    }
    #[cfg(not(all(windows, target_arch = "x86_64")))]
    {
        build_trusted_webview(app.handle(), &main_config)?;
    }

    Ok(())
}

pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .on_window_event(|window, event| {
            #[cfg(all(windows, target_arch = "x86_64", feature = "mcp"))]
            if let WindowEvent::Focused(true) = event {
                if let Ok(owner) = OwnerId::from_label(window.label()) {
                    window
                        .state::<std::sync::Arc<state::mcp::McpBridgeState>>()
                        .set_focused(&owner);
                }
            }
            if let WindowEvent::Destroyed = event {
                if let Ok(owner) = OwnerId::from_label(window.label()) {
                    #[cfg(all(windows, target_arch = "x86_64"))]
                    {
                        #[cfg(feature = "mcp")]
                        {
                            window
                                .state::<std::sync::Arc<state::mcp::McpBridgeState>>()
                                .close_window(&owner);
                            window
                                .state::<services::mcp::runtime::McpRuntime>()
                                .window_closed();
                        }
                        // Use the coordinated lifecycle path: it revokes file
                        // tokens, watches and workspace sessions, transferring
                        // owned watcher cleanup to the reserved reaper workers.
                        let _ = window
                            .state::<state::draft::FrontendDraftState>()
                            .revoke_owner(&owner);
                        let _ = window
                            .state::<state::terminal::FrontendTerminalState>()
                            .revoke_owner(&owner);
                        window
                            .state::<state::compile::FrontendCompileState>()
                            .revoke_owner(&owner);
                        window
                            .state::<state::desktop::FrontendFilesState>()
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
                let files = state::desktop::FrontendFilesState::with_data_dir(data_dir)?;
                let shared_filesystem = files.shared_service();
                let compile =
                    state::compile::FrontendCompileState::from_app(app, shared_filesystem.clone())
                        .map_err(std::io::Error::other)?;
                let draft =
                    state::draft::FrontendDraftState::from_app(app, shared_filesystem.clone())
                        .map_err(std::io::Error::other)?;
                let terminal = state::terminal::FrontendTerminalState::new(
                    shared_filesystem.clone(),
                    app.handle().clone(),
                )
                .map_err(std::io::Error::other)?;
                let git = state::git::FrontendGitState::new(shared_filesystem.clone());
                #[cfg(feature = "mcp")]
                let mcp_bridge = std::sync::Arc::new(state::mcp::McpBridgeState::new(
                    app.handle().clone(),
                    shared_filesystem,
                ));
                #[cfg(feature = "mcp")]
                let mcp_runtime =
                    services::mcp::runtime::McpRuntime::new(std::sync::Arc::clone(&mcp_bridge));
                #[cfg(not(feature = "mcp"))]
                drop(shared_filesystem);
                if !app.manage(files) {
                    return Err(
                        std::io::Error::other("FrontendFilesState is already managed").into(),
                    );
                }

                if !app.manage(compile) {
                    return Err(
                        std::io::Error::other("FrontendCompileState is already managed").into(),
                    );
                }

                if !app.manage(draft) {
                    return Err(
                        std::io::Error::other("FrontendDraftState is already managed").into(),
                    );
                }

                if !app.manage(terminal) {
                    return Err(
                        std::io::Error::other("FrontendTerminalState is already managed").into(),
                    );
                }

                if !app.manage(git) {
                    return Err(std::io::Error::other("FrontendGitState is already managed").into());
                }

                #[cfg(feature = "mcp")]
                if !app.manage(mcp_bridge) {
                    return Err(std::io::Error::other("McpBridgeState is already managed").into());
                }
                #[cfg(feature = "mcp")]
                if !app.manage(mcp_runtime) {
                    return Err(std::io::Error::other("McpRuntime is already managed").into());
                }
            }
            setup_main_window(app)?;
            #[cfg(feature = "g1-prototypes")]
            commands::prototype::setup(app)?;
            Ok(())
        });

    // Register the same owner-fenced frontend commands in the normal and prototype builds.
    #[cfg(all(windows, target_arch = "x86_64", feature = "g1-prototypes"))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        host_health,
        commands::frontend_window::frontend_new_window,
        #[cfg(feature = "mcp")]
        commands::mcp::frontend_mcp_set_enabled,
        #[cfg(feature = "mcp")]
        commands::mcp::frontend_mcp_reply,
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
        commands::frontend_compile::frontend_start_compile,
        commands::frontend_compile::frontend_compile_result,
        commands::frontend_compile::frontend_cancel_compile,
        commands::frontend_compile::frontend_take_compile_pdf,
        commands::frontend_compile::frontend_take_compile_synctex,
        commands::frontend_draft::frontend_draft_compile,
        commands::frontend_draft::frontend_draft_typeset_paragraph,
        commands::frontend_draft::frontend_draft_stop,
        commands::frontend_draft::frontend_draft_takeover,
        commands::frontend_draft::frontend_draft_save_pdf,
        commands::frontend_files::frontend_workspace_files_tree,
        commands::frontend_files::frontend_workspace_files_scan,
        commands::frontend_files::frontend_workspace_files_search,
        commands::frontend_files::frontend_workspace_files_cancel,
        commands::frontend_files::frontend_workspace_files_stat,
        commands::frontend_files::frontend_workspace_files_create_file,
        commands::frontend_files::frontend_workspace_files_create_directory,
        commands::frontend_files::frontend_workspace_files_move,
        commands::frontend_files::frontend_workspace_files_rename,
        commands::frontend_files::frontend_workspace_files_copy,
        commands::frontend_files::frontend_workspace_files_recycle,
        commands::frontend_files::frontend_workspace_files_delete,
        commands::frontend_files::frontend_workspace_files_undo_delete,
        commands::frontend_files::frontend_workspace_files_reveal,
        commands::frontend_terminal::frontend_terminal_availability,
        commands::frontend_terminal::frontend_terminal_spawn,
        commands::frontend_terminal::frontend_terminal_input,
        commands::frontend_terminal::frontend_terminal_resize,
        commands::frontend_terminal::frontend_terminal_kill,
        commands::frontend_git::frontend_git_availability,
        commands::frontend_git::frontend_git_status,
        commands::frontend_git::frontend_git_diff,
        commands::frontend_git::frontend_git_log,
        commands::frontend_git::frontend_git_show,
        commands::frontend_git::frontend_git_init,
        commands::frontend_git::frontend_git_stage,
        commands::frontend_git::frontend_git_unstage,
        commands::frontend_git::frontend_git_discard,
        commands::frontend_git::frontend_git_commit,
        commands::frontend_git::frontend_git_user_name,
        commands::frontend_compile_config::frontend_get_compile_config,
        commands::frontend_compile_config::frontend_update_compile_config,
        commands::frontend_settings::frontend_settings_read,
        commands::frontend_settings::frontend_settings_set,
        commands::frontend_settings::frontend_settings_reset,
        commands::frontend_settings::frontend_settings_import,
        #[cfg(feature = "mcp")]
        commands::frontend_compile_config::frontend_get_mcp_compile_command_permission,
        #[cfg(feature = "mcp")]
        commands::frontend_compile_config::frontend_set_mcp_compile_command_permission,
        commands::prototype::prototype_bytes,
        commands::prototype::prototype_pdf
    ]);

    #[cfg(all(windows, target_arch = "x86_64", not(feature = "g1-prototypes")))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        host_health,
        commands::frontend_window::frontend_new_window,
        #[cfg(feature = "mcp")]
        commands::mcp::frontend_mcp_set_enabled,
        #[cfg(feature = "mcp")]
        commands::mcp::frontend_mcp_reply,
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
        commands::frontend_compile::frontend_start_compile,
        commands::frontend_compile::frontend_compile_result,
        commands::frontend_compile::frontend_cancel_compile,
        commands::frontend_compile::frontend_take_compile_pdf,
        commands::frontend_compile::frontend_take_compile_synctex,
        commands::frontend_draft::frontend_draft_compile,
        commands::frontend_draft::frontend_draft_typeset_paragraph,
        commands::frontend_draft::frontend_draft_stop,
        commands::frontend_draft::frontend_draft_takeover,
        commands::frontend_draft::frontend_draft_save_pdf,
        commands::frontend_files::frontend_workspace_files_tree,
        commands::frontend_files::frontend_workspace_files_scan,
        commands::frontend_files::frontend_workspace_files_search,
        commands::frontend_files::frontend_workspace_files_cancel,
        commands::frontend_files::frontend_workspace_files_stat,
        commands::frontend_files::frontend_workspace_files_create_file,
        commands::frontend_files::frontend_workspace_files_create_directory,
        commands::frontend_files::frontend_workspace_files_move,
        commands::frontend_files::frontend_workspace_files_rename,
        commands::frontend_files::frontend_workspace_files_copy,
        commands::frontend_files::frontend_workspace_files_recycle,
        commands::frontend_files::frontend_workspace_files_delete,
        commands::frontend_files::frontend_workspace_files_undo_delete,
        commands::frontend_files::frontend_workspace_files_reveal,
        commands::frontend_terminal::frontend_terminal_availability,
        commands::frontend_terminal::frontend_terminal_spawn,
        commands::frontend_terminal::frontend_terminal_input,
        commands::frontend_terminal::frontend_terminal_resize,
        commands::frontend_terminal::frontend_terminal_kill,
        commands::frontend_git::frontend_git_availability,
        commands::frontend_git::frontend_git_status,
        commands::frontend_git::frontend_git_diff,
        commands::frontend_git::frontend_git_log,
        commands::frontend_git::frontend_git_show,
        commands::frontend_git::frontend_git_init,
        commands::frontend_git::frontend_git_stage,
        commands::frontend_git::frontend_git_unstage,
        commands::frontend_git::frontend_git_discard,
        commands::frontend_git::frontend_git_commit,
        commands::frontend_git::frontend_git_user_name,
        commands::frontend_compile_config::frontend_get_compile_config,
        commands::frontend_compile_config::frontend_update_compile_config,
        commands::frontend_settings::frontend_settings_read,
        commands::frontend_settings::frontend_settings_set,
        commands::frontend_settings::frontend_settings_reset,
        commands::frontend_settings::frontend_settings_import,
        #[cfg(feature = "mcp")]
        commands::frontend_compile_config::frontend_get_mcp_compile_command_permission,
        #[cfg(feature = "mcp")]
        commands::frontend_compile_config::frontend_set_mcp_compile_command_permission,
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

#[cfg(all(test, windows, target_arch = "x86_64"))]
#[path = "../tests/unit/unified_host.rs"]
mod unified_host_tests;

#[cfg(all(test, windows, target_arch = "x86_64"))]
#[path = "../tests/unit/frontend_terminal.rs"]
mod frontend_terminal_tests;

#[cfg(all(test, windows, target_arch = "x86_64"))]
#[path = "../tests/unit/document_window.rs"]
mod document_window_tests;

#[cfg(test)]
#[path = "../tests/unit/capability.rs"]
mod g2_capability_tests;
