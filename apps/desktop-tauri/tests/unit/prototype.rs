// SPDX-License-Identifier: Apache-2.0
use super::*;

#[test]
fn window_authorization_enforces_valid_main_owner() {
    assert_eq!(
        authorize_main_window("main").expect("main").as_str(),
        "main"
    );
    assert_eq!(
        authorize_main_window("g1-untrusted").unwrap_err(),
        "unauthorized window"
    );
    assert!(authorize_main_window("bad/label").is_err());
}

#[test]
fn prototype_payload_and_pdf_bounds_are_enforced() {
    assert!(validate_prototype_payload_len(MAX_PROTOTYPE_BYTES).is_ok());
    assert!(validate_prototype_payload_len(MAX_PROTOTYPE_BYTES + 1).is_err());

    assert!(validate_probe_pdf_file_len(MIN_PDF_BYTES - 1).is_err());
    assert!(validate_probe_pdf_file_len(MIN_PDF_BYTES).is_ok());
    assert!(validate_probe_pdf_file_len(MAX_PDF_BYTES).is_ok());
    assert!(validate_probe_pdf_file_len(MAX_PDF_BYTES + 1).is_err());

    let valid_pdf = b"%PDF-1.7\nbody\n%%EOF\n";
    assert!(validate_probe_pdf_bytes(valid_pdf).is_ok());
    assert!(validate_probe_pdf_bytes(b"%PDF-1.7\n%%EOF").is_err());
    assert!(validate_probe_pdf_bytes(b"NOT_A_PDF_HEADER_%%EOF").is_err());
    assert!(validate_probe_pdf_bytes(b"%PDF-1.7\nmissing_eof_marker").is_err());
}
