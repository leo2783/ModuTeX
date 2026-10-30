// SPDX-License-Identifier: Apache-2.0
use super::{is_trusted_app_asset_uri, trusted_static_mime};

#[test]
fn mime_override_requires_exact_packaged_asset_origin() {
    for value in [
        "tauri://localhost/assets/pdf-read.js",
        "http://tauri.localhost/assets/pdf.worker.mjs",
    ] {
        assert!(is_trusted_app_asset_uri(&value.parse().unwrap()), "{value}");
    }
    for value in [
        "/assets/pdf-read.js",
        "https://tauri.localhost/assets/pdf-read.js",
        "http://tauri.localhost:80/assets/pdf-read.js",
        "http://tauri.localhost.evil.test/assets/pdf-read.js",
        "http://tauri.localhost@evil.test/assets/pdf-read.js",
        "tauri://localhost.evil.test/assets/pdf-read.js",
        "http://ipc.localhost/assets/pdf-read.js",
    ] {
        assert!(
            !is_trusted_app_asset_uri(&value.parse().unwrap()),
            "{value}"
        );
    }
}

#[test]
fn executable_assets_keep_script_mime_without_retyping_documents() {
    assert_eq!(
        trusted_static_mime("/assets/pdf-read.js"),
        Some("text/javascript")
    );
    assert_eq!(
        trusted_static_mime("/assets/pdf.worker.mjs"),
        Some("text/javascript")
    );
    assert_eq!(
        trusted_static_mime("/assets/font.wasm"),
        Some("application/wasm")
    );
    for path in [
        "/document.pdf",
        "/picture.png",
        "/unknown",
        "/script.js.pdf",
    ] {
        assert_eq!(trusted_static_mime(path), None, "{path}");
    }
}
