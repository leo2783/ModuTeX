// SPDX-License-Identifier: Apache-2.0
//! Draft log diagnostics, shipout record validation, `.aux`/`.bbl`/`.fls`
//! export parsing, and source range replacement helpers.

use std::{
    collections::{BTreeMap, HashSet},
    fs,
    path::{Path, PathBuf},
};

use crate::{
    schemas::{
        draft::{
            DraftBibliographyEntry, DraftError, DraftErrorCode, DraftGeometry, DraftImageReference,
            DraftPageRecord, DraftReference, DraftSourceRange,
        },
        protocol::{Diagnostic, Severity, MAX_LOG_CHARACTERS},
    },
    services::filesystem::FilesystemError,
    shared::relative_path::RelativePath,
};

use super::{MAX_EXPORTED_ITEMS, MAX_OVERLAY_BYTES};

pub(super) fn validate_entry_path(path: &RelativePath) -> Result<(), DraftError> {
    if path.as_str().to_ascii_lowercase().ends_with(".tex") {
        Ok(())
    } else {
        Err(DraftError::new(
            DraftErrorCode::InvalidRequest,
            "Draft compilation requires a workspace-relative TeX entry path.",
        ))
    }
}

pub(crate) fn replace_source_range(
    original: &[u8],
    range: DraftSourceRange,
    replacement: &str,
) -> Result<Vec<u8>, DraftError> {
    if original.len() > MAX_OVERLAY_BYTES
        || replacement.len() > 1024 * 1024
        || range.start_byte > range.end_byte
    {
        return Err(DraftError::new(
            DraftErrorCode::InputTooLarge,
            "The Draft paragraph source or range exceeds its limit.",
        ));
    }
    let source = std::str::from_utf8(original).map_err(|_| {
        DraftError::new(
            DraftErrorCode::InvalidRequest,
            "Paragraph replacement requires a UTF-8 TeX entry file.",
        )
    })?;
    let start = range.start_byte as usize;
    let end = range.end_byte as usize;
    if end > source.len() || !source.is_char_boundary(start) || !source.is_char_boundary(end) {
        return Err(DraftError::new(
            DraftErrorCode::InvalidRequest,
            "The paragraph range is outside the entry or splits a UTF-8 character.",
        ));
    }
    let new_len = source
        .len()
        .saturating_sub(end - start)
        .saturating_add(replacement.len());
    if new_len > MAX_OVERLAY_BYTES {
        return Err(DraftError::new(
            DraftErrorCode::InputTooLarge,
            "The paragraph overlay exceeds the 32 MiB entry limit.",
        ));
    }
    let mut output = Vec::with_capacity(new_len);
    output.extend_from_slice(&original[..start]);
    output.extend_from_slice(replacement.as_bytes());
    output.extend_from_slice(&original[end..]);
    Ok(output)
}

pub(super) fn map_filesystem_error(error: FilesystemError) -> DraftError {
    use FilesystemError as Fs;
    match error {
        Fs::WorkspaceBusy => DraftError::new(
            DraftErrorCode::WorkspaceBusy,
            "A conflicting workspace operation is still active.",
        ),
        Fs::TimedOut => DraftError::new(
            DraftErrorCode::TimedOut,
            "The workspace operation exceeded its deadline.",
        ),
        Fs::Cancelled => DraftError::new(
            DraftErrorCode::Cancelled,
            "The workspace operation was cancelled.",
        ),
        Fs::StaleGeneration | Fs::StaleWorkspace => DraftError::new(
            DraftErrorCode::StaleWorkspace,
            "The workspace generation changed during Draft processing.",
        ),
        Fs::UnknownWorkspace | Fs::SessionClosed => DraftError::new(
            DraftErrorCode::WorkspaceDenied,
            "The Draft workspace is unavailable to this window.",
        ),
        Fs::FileTooLarge { .. } => DraftError::new(
            DraftErrorCode::InputTooLarge,
            "A Draft input or output exceeds the configured byte limit.",
        ),
        Fs::RevisionConflict { .. }
        | Fs::StaleDocumentVersion { .. }
        | Fs::DocumentIdentityMismatch { .. }
        | Fs::CompileIdentityMismatch(_) => DraftError::new(
            DraftErrorCode::StaleWorkspace,
            "The document or workspace changed during Draft processing.",
        ),
        Fs::CleanupUnproven { .. } => DraftError::new(
            DraftErrorCode::CleanupUnproven,
            "Workspace cleanup could not be proven.",
        ),
        _ => DraftError::new(
            DraftErrorCode::IoFailed,
            "The validated workspace operation failed.",
        ),
    }
}

pub(super) fn diagnostics_from_log(log: &str) -> Vec<Diagnostic> {
    let mut diagnostics = Vec::new();
    for line in log.lines() {
        let trimmed = line.trim();
        let severity = if trimmed.starts_with('!') {
            Some(Severity::Error)
        } else if trimmed.to_ascii_lowercase().contains("warning") {
            Some(Severity::Warning)
        } else {
            None
        };
        if let Some(severity) = severity {
            let message = trimmed.chars().take(4096).collect::<String>();
            if !message.is_empty() {
                diagnostics.push(Diagnostic {
                    severity,
                    message,
                    path: None,
                    line: None,
                    column: None,
                });
                if diagnostics.len() >= 256 {
                    break;
                }
            }
        }
    }
    diagnostics
}

pub(super) fn valid_geometry(geometry: &DraftGeometry) -> bool {
    [
        geometry.paper_width_pt,
        geometry.paper_height_pt,
        geometry.column_width_pt,
        geometry.foot_skip_pt,
        geometry.margin_left_pt,
        geometry.margin_right_pt,
        geometry.margin_top_pt,
        geometry.margin_bottom_pt,
    ]
    .iter()
    .all(|value| value.is_finite() && *value >= 0.0)
}

pub(super) fn valid_page(page: &DraftPageRecord) -> bool {
    page.number > 0
        && page.width_pt.is_finite()
        && page.height_pt.is_finite()
        && page.shipout_baseline_height_pt.is_finite()
        && page.width_pt >= 0.0
        && page.height_pt >= 0.0
        && page.renderable_records.iter().all(|record| {
            [record.x_pt, record.y_pt, record.width_pt, record.height_pt]
                .iter()
                .all(|value| value.is_finite())
        })
}

pub(super) fn sanitize_log(log: &str, root: &Path, executable: &Path) -> String {
    let mut output = log.to_owned();
    for (path, replacement) in [
        (root, "<draft-work>"),
        (
            executable.parent().unwrap_or(executable),
            "<tex-distribution>",
        ),
    ] {
        let text = path.to_string_lossy();
        if !text.is_empty() {
            output = output.replace(text.as_ref(), replacement);
        }
    }
    output.chars().take(MAX_LOG_CHARACTERS).collect()
}

pub(super) fn parse_braced_group(input: &str, start: usize) -> Option<(String, usize)> {
    let bytes = input.as_bytes();
    let mut open = start;
    while open < bytes.len() && bytes[open].is_ascii_whitespace() {
        open += 1;
    }
    if bytes.get(open) != Some(&b'{') {
        return None;
    }
    let mut depth = 1usize;
    let mut index = open + 1;
    let mut escaped = false;
    while index < bytes.len() {
        let byte = bytes[index];
        if escaped {
            escaped = false;
        } else if byte == b'\\' {
            escaped = true;
        } else if byte == b'{' {
            depth += 1;
        } else if byte == b'}' {
            depth -= 1;
            if depth == 0 {
                return Some((input[open + 1..index].to_owned(), index + 1));
            }
        }
        index += 1;
    }
    None
}

pub(super) fn parse_groups(input: &str) -> Vec<String> {
    let mut groups = Vec::new();
    let mut index = 0usize;
    while index < input.len() && groups.len() < 8 {
        if input.as_bytes()[index] == b'{' {
            if let Some((group, next)) = parse_braced_group(input, index) {
                groups.push(group);
                index = next;
                continue;
            }
        }
        index += 1;
    }
    groups
}

pub(crate) fn parse_aux_exports(
    aux: &str,
    bbl: &str,
) -> (Vec<DraftReference>, Vec<DraftBibliographyEntry>) {
    let mut references = BTreeMap::<String, DraftReference>::new();
    let mut citations = BTreeMap::<String, String>::new();
    for line in aux.lines().take(MAX_EXPORTED_ITEMS * 8) {
        if let Some(position) = line.find("\\newlabel") {
            let start = position + "\\newlabel".len();
            if let Some((key, after_key)) = parse_braced_group(line, start) {
                if let Some((value, _)) = parse_braced_group(line, after_key) {
                    let parts = parse_groups(&value);
                    if !key.is_empty() {
                        references.insert(
                            key.clone(),
                            DraftReference {
                                key,
                                label: parts.first().cloned().unwrap_or_default(),
                                page: parts.get(1).cloned(),
                            },
                        );
                    }
                }
            }
        }
        if let Some(position) = line.find("\\bibcite") {
            let start = position + "\\bibcite".len();
            if let Some((key, after_key)) = parse_braced_group(line, start) {
                if let Some((label, _)) = parse_braced_group(line, after_key) {
                    citations.insert(key, label);
                }
            }
        }
        if let Some(position) = line.find("\\citation") {
            let start = position + "\\citation".len();
            if let Some((keys, _)) = parse_braced_group(line, start) {
                for key in keys.split(',').take(MAX_EXPORTED_ITEMS) {
                    if !key.is_empty() {
                        references
                            .entry(key.to_owned())
                            .or_insert_with(|| DraftReference {
                                key: key.to_owned(),
                                label: citations.get(key).cloned().unwrap_or_default(),
                                page: None,
                            });
                    }
                }
            }
        }
    }
    for (key, label) in &citations {
        references
            .entry(key.clone())
            .and_modify(|reference| reference.label = label.clone())
            .or_insert_with(|| DraftReference {
                key: key.clone(),
                label: label.clone(),
                page: None,
            });
    }

    let mut bibliography = Vec::new();
    let lines: Vec<&str> = bbl.lines().take(32_768).collect();
    let mut index = 0usize;
    while index < lines.len() && bibliography.len() < MAX_EXPORTED_ITEMS {
        let Some(marker) = lines[index].find("\\bibitem") else {
            index += 1;
            continue;
        };
        let mut rest = &lines[index][marker + "\\bibitem".len()..];
        let mut label = None;
        if let Some(stripped) = rest.trim_start().strip_prefix('[') {
            if let Some(end) = stripped.find(']') {
                label = Some(stripped[..end].to_owned());
                rest = &stripped[end + 1..];
            }
        }
        let Some((key, after_key)) = parse_braced_group(rest, 0) else {
            index += 1;
            continue;
        };
        let mut body = rest[after_key..].trim().to_owned();
        index += 1;
        while index < lines.len() && !lines[index].contains("\\bibitem") {
            if body.len() < 8192 {
                if !body.is_empty() {
                    body.push(' ');
                }
                body.push_str(lines[index].trim());
            }
            index += 1;
        }
        body.truncate(body.len().min(8192));
        bibliography.push(DraftBibliographyEntry {
            citation_label: label.or_else(|| citations.get(&key).cloned()),
            key,
            text: body,
        });
    }
    (
        references.into_values().take(MAX_EXPORTED_ITEMS).collect(),
        bibliography,
    )
}

pub(super) fn collect_workspace_images(root: &Path, fls: &str) -> Vec<DraftImageReference> {
    let canonical_root = match fs::canonicalize(root) {
        Ok(path) => path,
        Err(_) => return Vec::new(),
    };
    let mut seen = HashSet::new();
    let mut images = Vec::new();
    for line in fls.lines().take(65_536) {
        let Some(raw) = line.strip_prefix("INPUT ") else {
            continue;
        };
        let path = PathBuf::from(raw);
        let absolute = if path.is_absolute() {
            path
        } else {
            root.join(path)
        };
        let Ok(canonical) = fs::canonicalize(absolute) else {
            continue;
        };
        let Ok(relative) = canonical.strip_prefix(&canonical_root) else {
            continue;
        };
        let Some(text) = relative.to_str() else {
            continue;
        };
        let normalized = text.replace('\\', "/");
        let lower = normalized.to_ascii_lowercase();
        if ![".png", ".jpg", ".jpeg", ".pdf", ".eps"]
            .iter()
            .any(|extension| lower.ends_with(extension))
        {
            continue;
        }
        let Ok(path) = RelativePath::parse(&normalized) else {
            continue;
        };
        if seen.insert(path.clone()) {
            images.push(DraftImageReference { path, page: None });
            if images.len() >= MAX_EXPORTED_ITEMS {
                break;
            }
        }
    }
    images
}
