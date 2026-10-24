// SPDX-License-Identifier: Apache-2.0
//! Agent-launched stdio proxy. rmcp owns stdout for protocol messages;
//! diagnostics are written only to stderr.

use std::process::ExitCode;

#[cfg(all(windows, target_arch = "x86_64"))]
#[tokio::main]
async fn main() -> ExitCode {
    let mut arguments = std::env::args_os().skip(1);
    let port = match arguments.next().as_deref() {
        None => 7317,
        Some(value) if value == "7317" => 7317,
        Some(value) if value == "7318" => 7318,
        _ => {
            eprintln!("usage: modutex-mcp-stdio [7317|7318]");
            return ExitCode::from(2);
        }
    };
    if arguments.next().is_some() {
        eprintln!("usage: modutex-mcp-stdio [7317|7318]");
        return ExitCode::from(2);
    }
    match modutex_desktop_tauri_lib::services::mcp::stdio::run_stdio_proxy_to_application(port)
        .await
    {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("modutex-mcp-stdio: {error}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(not(all(windows, target_arch = "x86_64")))]
fn main() -> ExitCode {
    eprintln!("modutex-mcp-stdio is supported only by the Windows x64 desktop host");
    ExitCode::from(2)
}
