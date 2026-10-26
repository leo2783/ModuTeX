// SPDX-License-Identifier: Apache-2.0
//! Platform native dialog seam (`src/platform/dialogs.rs`).

use std::path::PathBuf;
use tauri::WebviewWindow;

pub trait DialogSeam: Send + Sync {
    fn pick_folder(&self, window: &WebviewWindow) -> Option<PathBuf>;
    fn pick_file(&self, window: &WebviewWindow) -> Option<PathBuf>;
    fn save_file(&self, window: &WebviewWindow) -> Option<PathBuf>;
}

pub struct NativeDialogSeam;

impl DialogSeam for NativeDialogSeam {
    fn pick_folder(&self, window: &WebviewWindow) -> Option<PathBuf> {
        use tauri_plugin_dialog::DialogExt;
        window
            .dialog()
            .file()
            .set_parent(window)
            .blocking_pick_folder()
            .and_then(|fp| fp.into_path().ok())
    }

    fn pick_file(&self, window: &WebviewWindow) -> Option<PathBuf> {
        use tauri_plugin_dialog::DialogExt;
        window
            .dialog()
            .file()
            .set_parent(window)
            .blocking_pick_file()
            .and_then(|fp| fp.into_path().ok())
    }

    fn save_file(&self, window: &WebviewWindow) -> Option<PathBuf> {
        use tauri_plugin_dialog::DialogExt;
        window
            .dialog()
            .file()
            .set_parent(window)
            .blocking_save_file()
            .and_then(|fp| fp.into_path().ok())
    }
}
