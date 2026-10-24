// SPDX-License-Identifier: Apache-2.0
use crate::{
    commands::frontend_files::verify_trusted_window, schemas::protocol::OwnerId,
    state::desktop::FrontendFilesState,
};
use tauri::{Manager, State, WebviewWindow};

fn new_document_window_label() -> Result<String, String> {
    let label = format!("document-{}", uuid::Uuid::new_v4());
    OwnerId::from_label(&label)
        .map_err(|_| "invalid generated document window label".to_owned())?;
    Ok(label)
}

#[tauri::command]
pub async fn frontend_new_window(
    window: WebviewWindow,
    state: State<'_, FrontendFilesState>,
) -> Result<String, String> {
    let _caller = verify_trusted_window(&window, &state)?;
    let app = window.app_handle();
    let mut config = app
        .config()
        .app
        .windows
        .iter()
        .find(|candidate| candidate.label == "main")
        .cloned()
        .ok_or_else(|| "missing main window config".to_owned())?;

    let label = new_document_window_label()?;
    if app.get_webview_window(&label).is_some() {
        return Err("generated document window label is already in use".to_owned());
    }
    OwnerId::from_label(&label)
        .map_err(|_| "invalid generated document window label".to_owned())?;
    config.label = label.clone();

    crate::create_trusted_document_window(app, &config, &state)?;
    Ok(label)
}

#[cfg(test)]
mod tests {
    use super::new_document_window_label;
    use crate::schemas::protocol::OwnerId;

    #[test]
    fn generated_document_window_labels_are_unique_and_validated() {
        let first = new_document_window_label().unwrap();
        let second = new_document_window_label().unwrap();

        assert_ne!(first, second);
        assert!(first.starts_with("document-"));
        assert!(second.starts_with("document-"));
        assert!(OwnerId::from_label(&first).is_ok());
        assert!(OwnerId::from_label(&second).is_ok());
    }
}
