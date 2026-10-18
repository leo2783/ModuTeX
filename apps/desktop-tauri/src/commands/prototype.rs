// SPDX-License-Identifier: Apache-2.0

use std::fs::File;
use std::io::Read;
use std::path::Path;

use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::schemas::protocol::{OwnerId, MAX_PDF_BYTES};

const MIN_PDF_BYTES: usize = 16;
const MAX_PROTOTYPE_BYTES: usize = 5 * 1024 * 1024;

pub struct ProbePdf(pub Vec<u8>);

fn validate_probe_pdf_file_len(file_len: usize) -> Result<(), String> {
    if !(MIN_PDF_BYTES..=MAX_PDF_BYTES).contains(&file_len) {
        return Err(format!(
            "MODUTEX_G1_PDF file size {file_len} bytes is outside 16B..32MiB bounds"
        ));
    }
    Ok(())
}

fn validate_probe_pdf_bytes(bytes: &[u8]) -> Result<(), String> {
    if !(MIN_PDF_BYTES..=MAX_PDF_BYTES).contains(&bytes.len()) {
        return Err("MODUTEX_G1_PDF read size is outside 16B..32MiB bounds".into());
    }

    if !bytes.starts_with(b"%PDF-") {
        return Err("MODUTEX_G1_PDF file missing %PDF- header".into());
    }

    let tail = &bytes[bytes.len().saturating_sub(1024)..];
    if !tail.windows(5).any(|w| w == b"%%EOF") {
        return Err("MODUTEX_G1_PDF file missing %%EOF marker near end".into());
    }

    Ok(())
}

fn authorize_main_window(label: &str) -> Result<OwnerId, String> {
    let owner = OwnerId::from_label(label).map_err(|error| error.to_string())?;
    if owner.as_str() != "main" {
        return Err("unauthorized window".into());
    }
    Ok(owner)
}

fn validate_prototype_payload_len(len: usize) -> Result<(), String> {
    if len > MAX_PROTOTYPE_BYTES {
        return Err(format!("payload exceeds maximum 5MiB limit: {len} bytes"));
    }
    Ok(())
}

fn init_probe_pdf() -> Result<ProbePdf, Box<dyn std::error::Error>> {
    let path_str = match std::env::var("MODUTEX_G1_PDF") {
        Ok(val) if !val.is_empty() => val,
        _ => return Ok(ProbePdf(Vec::new())),
    };

    let path = Path::new(&path_str);
    let file = File::open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        return Err("MODUTEX_G1_PDF must point to a regular file".into());
    }

    let file_len = metadata.len() as usize;
    validate_probe_pdf_file_len(file_len)?;

    let mut reader = file.take((MAX_PDF_BYTES + 1) as u64);
    let mut bytes = Vec::with_capacity(file_len);
    reader.read_to_end(&mut bytes)?;

    validate_probe_pdf_bytes(&bytes)?;

    Ok(ProbePdf(bytes))
}

pub fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let probe_pdf = init_probe_pdf()?;
    app.manage(probe_pdf);

    if std::env::var("MODUTEX_G1_UNTRUSTED_WINDOW").as_deref() == Ok("1") {
        WebviewWindowBuilder::new(app, "g1-untrusted", WebviewUrl::App("index.html".into()))
            .visible(false)
            .build()?;
    }

    Ok(())
}

#[tauri::command]
pub fn prototype_bytes(window: WebviewWindow, request: Request<'_>) -> Result<Response, String> {
    authorize_main_window(window.label())?;

    let raw_bytes = match request.body() {
        InvokeBody::Raw(bytes) => bytes,
        InvokeBody::Json(_) => return Err("JSON body rejected; raw binary expected".into()),
    };

    validate_prototype_payload_len(raw_bytes.len())?;

    Ok(Response::new(raw_bytes.clone()))
}

#[tauri::command]
pub fn prototype_pdf(
    window: WebviewWindow,
    state: State<'_, ProbePdf>,
) -> Result<Response, String> {
    authorize_main_window(window.label())?;

    let probe_pdf = state.inner();
    if probe_pdf.0.is_empty() {
        return Err("PROBE_PDF_UNAVAILABLE".into());
    }

    Ok(Response::new(probe_pdf.0.clone()))
}

#[cfg(test)]
#[path = "../../tests/unit/prototype.rs"]
mod tests;
