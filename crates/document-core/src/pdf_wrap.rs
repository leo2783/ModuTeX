// SPDX-License-Identifier: Apache-2.0
use crate::changes::SourcePatch;
use crate::parser::{parse_source, ParseIssueCode, ParseLimits, SyntaxKind, SyntaxNode};
use crate::source::{SourceDocument, SourceTransaction};
use crate::SourceError;

/// Add TeX break opportunities to long ASCII runs in document body text.
///
/// Source snapshots and parser spans remain UTF-16 based; applying the resulting
/// patches through `SourceDocument` preserves the original BOM and untouched bytes.
pub fn pdf_wrapped_text(bytes: &[u8]) -> Result<Vec<u8>, SourceError> {
    let source = SourceDocument::open(bytes, "pdf-wrap".to_owned())?;
    let projection = parse_source(&source, ParseLimits::default())?;
    if projection
        .issues
        .iter()
        .any(|issue| issue.code == ParseIssueCode::Budget)
    {
        return Ok(bytes.to_vec());
    }

    let mut patches = Vec::new();
    collect_patches(&source, &projection.nodes, false, &mut patches)?;
    if patches.is_empty() {
        return Ok(bytes.to_vec());
    }

    let update = source.apply(&SourceTransaction {
        expected_version: source.version(),
        patches,
    })?;
    Ok(update.document.to_bytes())
}

fn collect_patches(
    source: &SourceDocument,
    nodes: &[SyntaxNode],
    in_document_body: bool,
    patches: &mut Vec<SourcePatch>,
) -> Result<(), SourceError> {
    for node in nodes {
        if node.kind == SyntaxKind::Environment {
            collect_patches(
                source,
                &node.children,
                in_document_body || node.name == "document",
                patches,
            )?;
        } else if in_document_body && node.kind == SyntaxKind::Format {
            collect_patches(source, &node.children, true, patches)?;
        } else if in_document_body && node.kind == SyntaxKind::Text {
            collect_text_patches(source, node, patches)?;
        }
    }
    Ok(())
}

fn collect_text_patches(
    source: &SourceDocument,
    node: &SyntaxNode,
    patches: &mut Vec<SourcePatch>,
) -> Result<(), SourceError> {
    let text = source.read(node.span.from, node.span.to)?;
    let bytes = text.as_bytes();
    let mut byte_offset = 0usize;
    let mut utf16_offset = 0usize;

    while byte_offset < bytes.len() {
        if bytes[byte_offset].is_ascii_alphanumeric() {
            let start_byte = byte_offset;
            let start_utf16 = utf16_offset;
            while byte_offset < bytes.len() && bytes[byte_offset].is_ascii_alphanumeric() {
                byte_offset += 1;
                utf16_offset += 1;
            }

            let run_length = byte_offset - start_byte;
            if run_length >= 32 {
                let run = &text[start_byte..byte_offset];
                let mut insert = String::with_capacity(run_length);
                for (chunk_index, chunk) in run.as_bytes().chunks(16).enumerate() {
                    if chunk_index != 0 {
                        insert.push_str(r"\allowbreak{}");
                    }
                    for byte in chunk {
                        insert.push(char::from(*byte));
                    }
                }

                let from = node
                    .span
                    .from
                    .checked_add(start_utf16)
                    .ok_or(SourceError::Range)?;
                let to = from.checked_add(run_length).ok_or(SourceError::Range)?;
                patches.push(SourcePatch {
                    from,
                    to,
                    insert,
                    expected: Some(run.to_owned()),
                });
            }
        } else {
            let character = text[byte_offset..]
                .chars()
                .next()
                .ok_or(SourceError::Encoding)?;
            byte_offset += character.len_utf8();
            utf16_offset += character.len_utf16();
        }
    }

    Ok(())
}
