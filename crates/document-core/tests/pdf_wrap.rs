// SPDX-License-Identifier: Apache-2.0
use modutex_document_core::{pdf_wrapped_text, SourceError};

#[test]
fn wrapping_is_structural_and_preserves_source_bytes_and_line_endings() {
    let run = "1234567890".repeat(30);
    let source = format!("\u{feff}\\documentclass{{article}}\r\n{run}\r\n\\begin{{document}}\n{run}\r\n\\textbf{{{run}}}\n\\section{{{run}}}\r${run}$\r\n\\begin{{verbatim}}\n{run}\r\n\\end{{verbatim}}\r% {run}\n\\opaque{{{run}}}\r\n\\end{{document}}");
    let bytes = source.as_bytes().to_vec();
    let original = bytes.clone();

    let output = pdf_wrapped_text(&bytes).unwrap();
    let wrapped = String::from_utf8(output).unwrap();

    assert_eq!(bytes, original);
    assert_eq!(wrapped.matches("\\allowbreak{}").count(), 36);
    assert_eq!(wrapped.matches('\n').count(), source.matches('\n').count());
    assert_eq!(wrapped.matches('\r').count(), source.matches('\r').count());
    assert!(wrapped.contains(&format!("${run}$")));
    assert!(wrapped.contains(&format!("\\begin{{verbatim}}\n{run}\r\n\\end{{verbatim}}")));
    assert!(wrapped.contains(&format!("% {run}\n")));
    assert!(wrapped.contains(&format!("\\opaque{{{run}}}")));
    assert_eq!(wrapped.replace("\\allowbreak{}", ""), source);
}

#[test]
fn math_only_and_short_documents_are_returned_byte_for_byte() {
    let run = "1234567890".repeat(30);
    let source =
        format!("\\documentclass{{article}}\n\\begin{{document}}short ${run}$\\end{{document}}");
    let bytes = source.as_bytes().to_vec();
    assert_eq!(pdf_wrapped_text(&bytes).unwrap(), bytes);
}

#[test]
fn invalid_utf8_is_reported_by_the_source_core() {
    assert_eq!(pdf_wrapped_text(&[0xff]), Err(SourceError::Encoding));
}
