// SPDX-License-Identifier: Apache-2.0
// Real updater HTTP transport and signature checks. No installer is launched.
#![cfg(all(windows, target_arch = "x86_64"))]

use std::{
    io::{Read, Write},
    net::TcpListener,
    thread,
    time::{Duration, Instant},
};
use tauri::test::{mock_builder, mock_context, noop_assets};
use tauri_plugin_updater::UpdaterExt;

const PUBLIC_KEY: &str = include_str!("../fixtures/updater/public-key.txt");
const SIGNATURE: &str = include_str!("../fixtures/updater/payload.bin.sig");
const PAYLOAD: &[u8] = include_bytes!("../fixtures/updater/payload.bin");

async fn download_fixture(version: &str, corrupt: bool) -> tauri_plugin_updater::Result<Vec<u8>> {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    listener.set_nonblocking(true).unwrap();
    let manifest = serde_json::json!({
        "version": version,
        "platforms": { "windows-x86_64": {
            "url": format!("http://{address}/payload"),
            "signature": SIGNATURE.trim()
        }}
    })
    .to_string();
    let mut payload = PAYLOAD.to_vec();
    if corrupt {
        payload[0] ^= 1;
    }
    let server = thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut served = 0;
        while served < 2 && Instant::now() < deadline {
            let (mut stream, _) = match listener.accept() {
                Ok(connection) => connection,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(5));
                    continue;
                }
                Err(error) => panic!("fixture accept failed: {error}"),
            };
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut request = Vec::new();
            let mut chunk = [0_u8; 512];
            while !request.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
                let count = stream.read(&mut chunk).unwrap();
                if count == 0 {
                    break;
                }
                request.extend_from_slice(&chunk[..count]);
                assert!(request.len() <= 8192, "fixture request limit");
            }
            let body = if request.starts_with(b"GET /latest.json ") {
                manifest.as_bytes()
            } else {
                assert!(request.starts_with(b"GET /payload "));
                &payload
            };
            let headers = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            stream.write_all(headers.as_bytes()).unwrap();
            stream.write_all(body).unwrap();
            served += 1;
        }
        assert_eq!(served, 2, "manifest and artifact must both be fetched");
    });
    let mut context = mock_context(noop_assets());
    context.config_mut().plugins.0.insert(
        "updater".into(),
        serde_json::json!({
            "pubkey": PUBLIC_KEY.trim(),
            "endpoints": [format!("http://{address}/latest.json")],
            "requireSignedVersion": true,
            "dangerousInsecureTransportProtocol": true
        }),
    );
    let app = mock_builder()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .build(context)
        .unwrap();
    let outcome = async {
        let update = app
            .updater_builder()
            .timeout(Duration::from_secs(5))
            .build()?
            .check()
            .await?
            .expect("fixture announces a newer version");
        update.download(|_, _| {}, || {}).await
    }
    .await;
    server.join().unwrap();
    outcome
}

#[tokio::test]
async fn official_updater_accepts_version_bound_signature_for_original_bytes() {
    assert_eq!(download_fixture("0.4.0", false).await.unwrap(), PAYLOAD);
}

#[tokio::test]
async fn official_updater_rejects_modified_artifact_bytes() {
    assert!(download_fixture("0.4.0", true).await.is_err());
}

#[tokio::test]
async fn official_updater_rejects_manifest_version_not_bound_by_signature() {
    assert!(download_fixture("0.5.0", false).await.is_err());
}
