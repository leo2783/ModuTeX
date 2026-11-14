// SPDX-License-Identifier: Apache-2.0
//! Compile log sanitization, terminal control stripping, tail truncation, and
//! TeX/LaTeX diagnostic parsing.

use std::collections::HashSet;

use crate::{
    platform::process_tree::ProcessErrorKind,
    schemas::protocol::{
        CompileIdentity, CompileResult, Diagnostic, Position, Severity, MAX_LOG_CHARACTERS,
        MAX_TEXT_UTF16,
    },
    services::filesystem::FilesystemError,
    shared::relative_path::RelativePath,
};

use super::{staging::CompileSourceSnapshot, MAX_DIAGNOSTICS};

pub(super) fn failure_result(
    identity: CompileIdentity,
    log: &str,
    diagnostics: Vec<Diagnostic>,
) -> CompileResult {
    let (log, _) = truncate_log_tail(log, MAX_LOG_CHARACTERS);
    CompileResult::Failure {
        identity,
        log,
        diagnostics: diagnostics.into_iter().take(MAX_DIAGNOSTICS).collect(),
    }
}

pub(super) fn cancelled_result(identity: CompileIdentity, log: &str) -> CompileResult {
    let log = if log.is_empty() {
        "Compilation cancelled.".to_owned()
    } else {
        truncate_log_tail(log, MAX_LOG_CHARACTERS).0
    };
    CompileResult::Cancelled {
        identity,
        log,
        diagnostics: Vec::new(),
    }
}

pub(super) fn filesystem_failure_text(error: &FilesystemError) -> &'static str {
    match error {
        FilesystemError::UnknownWorkspace => "Compile workspace is unavailable.",
        FilesystemError::SessionClosed | FilesystemError::StaleGeneration => {
            "Compile workspace was closed or changed."
        }
        FilesystemError::WorkspaceBusy => "Compile workspace is busy.",
        FilesystemError::TimedOut => "Compile workspace admission timed out.",
        FilesystemError::Cancelled => "Compilation was cancelled.",
        FilesystemError::NotFound => "Compile entry or input was not found.",
        FilesystemError::AccessDenied | FilesystemError::SharingViolation => {
            "Compile input cannot be read safely."
        }
        FilesystemError::LinkNotAllowed | FilesystemError::StaleWorkspace => {
            "Compile workspace path is unsafe or stale."
        }
        FilesystemError::TreeTooLarge | FilesystemError::FileTooLarge { .. } => {
            "Compile input exceeded a configured size limit."
        }
        FilesystemError::TreeTooDeep => "Compile input tree exceeded its depth limit.",
        FilesystemError::RevisionConflict { .. } => {
            "Saved entry revision changed before compilation."
        }
        FilesystemError::StaleDocumentVersion { .. }
        | FilesystemError::DocumentIdentityMismatch { .. }
        | FilesystemError::CompileIdentityMismatch(_) => {
            "Compile document identity does not match the saved snapshot."
        }
        FilesystemError::CleanupUnproven { .. } => "Compile cleanup could not be proven.",
        _ => "Compile filesystem operation failed.",
    }
}

pub(super) fn process_error_text(kind: ProcessErrorKind, exit_code: Option<u32>) -> &'static str {
    match (kind, exit_code) {
        #[cfg(not(all(windows, target_arch = "x86_64")))]
        (ProcessErrorKind::UnsupportedPlatform, _) => {
            "Compile engine is unsupported on this platform."
        }
        (ProcessErrorKind::InvalidExecutable, _) => "Configured compile engine is unavailable.",
        (ProcessErrorKind::InvalidWorkingDirectory, _) => "Compile working directory is invalid.",
        (ProcessErrorKind::InvalidTimeout, _) => "Compile timeout is invalid.",
        (ProcessErrorKind::InvalidLogLimit, _) => "Compile log limit is invalid.",
        (ProcessErrorKind::InvalidArgument, _) => "Trusted compile profile argument is invalid.",
        (ProcessErrorKind::CommandLineTooLong, _) => "Compile argv exceeds the platform limit.",
        (ProcessErrorKind::Cancelled, _) => "Compilation cancelled.",
        (ProcessErrorKind::DeadlineExceeded, _) => "Compile deadline exceeded.",
        (ProcessErrorKind::OutputLimitExceeded, _) => {
            "Compile output exceeded the configured limit."
        }
        (ProcessErrorKind::Spawn, _) => "Compile engine could not be started.",
        (ProcessErrorKind::AssignToJob, _) => "Compile engine could not be assigned to its job.",
        (ProcessErrorKind::Resume, _) => "Compile engine could not be resumed.",
        (ProcessErrorKind::ReadFailure, _) => "Compile engine output could not be read.",
        (ProcessErrorKind::WaitFailure, _) => "Compile engine wait failed.",
        (ProcessErrorKind::JobQueryFailure, _) => {
            "Compile process-tree status could not be verified."
        }
        (ProcessErrorKind::NonZeroExit, _) => "Compile engine exited unsuccessfully.",
        (ProcessErrorKind::CleanupFailed, _) => "Compile process-tree cleanup is being retried.",
        (ProcessErrorKind::CleanupCapacityExceeded, _) => "Compile cleanup capacity is exhausted.",
        (ProcessErrorKind::CleanupSupervisorUnavailable, _) => {
            "Compile cleanup supervisor is unavailable."
        }
        (ProcessErrorKind::Internal, _) => "Compile worker encountered an internal error.",
    }
}

pub(super) fn append_log_line(log: &str, line: &str) -> String {
    let mut result = String::with_capacity(log.len().saturating_add(line.len() + 1));
    result.push_str(log);
    if !result.is_empty() {
        result.push('\n');
    }
    result.push_str(line);
    truncate_log_tail(&result, MAX_LOG_CHARACTERS).0
}

pub(super) fn truncate_log_tail(value: &str, maximum: usize) -> (String, bool) {
    let count = value.chars().count();
    if count <= maximum {
        return (value.to_owned(), false);
    }
    let marker = "[earlier compile log output truncated]\n";
    let keep = maximum.saturating_sub(marker.chars().count());
    let tail = value
        .chars()
        .skip(count.saturating_sub(keep))
        .collect::<String>();
    (format!("{marker}{tail}"), true)
}

pub(super) fn strip_terminal_controls(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    let mut characters = value.chars().peekable();
    while let Some(character) = characters.next() {
        if character == '\u{1b}' {
            match characters.next() {
                Some('[') => {
                    for code in characters.by_ref() {
                        if ('@'..='~').contains(&code) {
                            break;
                        }
                    }
                }
                Some(']') => {
                    while let Some(code) = characters.next() {
                        if code == '\u{7}' {
                            break;
                        } else if code == '\u{1b}' && characters.peek() == Some(&'\\') {
                            characters.next();
                            break;
                        }
                    }
                }
                Some(_) | None => {}
            }
            continue;
        }
        if character == '\n'
            || character == '\r'
            || character == '\t'
            || (character >= '\u{20}' && character != '\u{7f}')
        {
            output.push(character);
        }
    }
    output
}

pub(super) fn replace_case_insensitive(input: &str, needle: &str, replacement: &str) -> String {
    if needle.is_empty() || needle.len() > input.len() {
        return input.to_owned();
    }
    let mut output = String::with_capacity(input.len());
    let mut cursor = 0usize;
    for (start, _) in input.char_indices() {
        if start < cursor {
            continue;
        }
        let end = start.saturating_add(needle.len());
        if end <= input.len()
            && input.is_char_boundary(end)
            && input[start..end].eq_ignore_ascii_case(needle)
        {
            output.push_str(&input[cursor..start]);
            output.push_str(replacement);
            cursor = end;
        }
    }
    output.push_str(&input[cursor..]);
    output
}

pub(super) fn parse_diagnostics(
    log: &str,
    snapshot: &CompileSourceSnapshot,
    entry_path: &RelativePath,
) -> Vec<Diagnostic> {
    let known_paths = snapshot
        .files
        .iter()
        .map(|file| file.path.as_str().to_lowercase())
        .collect::<HashSet<_>>();
    let mut diagnostics = Vec::new();
    let mut pending_latex_error: Option<String> = None;
    let mut continuation: Option<(String, Option<usize>)> = None;
    for line in log.lines() {
        let trimmed = line.trim();
        if let Some((prefix, index)) = &continuation {
            if let Some(rest) = trimmed.strip_prefix(prefix.as_str()) {
                if let Some(index) = index {
                    let diagnostic: &mut Diagnostic = &mut diagnostics[*index];
                    diagnostic.message = bounded_diagnostic_message(&format!(
                        "{} {}",
                        diagnostic.message,
                        rest.trim()
                    ));
                }
                continue;
            }
        }
        continuation = None;
        if let Some(message) = trimmed.strip_prefix('!') {
            if let Some(previous) = pending_latex_error.take() {
                push_diagnostic(
                    &mut diagnostics,
                    Severity::Error,
                    &previous,
                    Some(entry_path.clone()),
                    None,
                    None,
                );
            }
            pending_latex_error = Some(nonempty_message(message));
            continue;
        }
        if let Some(number) = trimmed.strip_prefix("l.") {
            if let Some(message) = pending_latex_error.take() {
                let line = number.split_whitespace().next().and_then(parse_position);
                push_diagnostic(
                    &mut diagnostics,
                    Severity::Error,
                    &message,
                    Some(entry_path.clone()),
                    line,
                    None,
                );
            }
            continue;
        }
        if let Some((severity, offset)) = diagnostic_marker(trimmed) {
            let prefix = if trimmed.starts_with("LaTeX Font ") {
                Some("(Font)".to_owned())
            } else {
                trimmed
                    .strip_prefix("Package ")
                    .and_then(|rest| rest.split_whitespace().next())
                    .map(|name| format!("({name})"))
            };
            if matches!(severity, Severity::Info) {
                continuation = prefix.map(|prefix| (prefix, None));
                continue;
            }
            continuation = prefix.map(|prefix| (prefix, Some(diagnostics.len())));
            let payload = trimmed[offset..].trim();
            if let Some(diagnostic) =
                parse_location_diagnostic(payload, severity, &known_paths, entry_path)
            {
                diagnostics.push(diagnostic);
            } else {
                push_diagnostic(
                    &mut diagnostics,
                    severity,
                    &nonempty_message(payload),
                    None,
                    None,
                    None,
                );
            }
            if diagnostics.len() >= MAX_DIAGNOSTICS {
                break;
            }
            continue;
        }
        if trimmed.starts_with("Missing character:")
            || trimmed.starts_with("Overfull ")
            || trimmed.starts_with("Underfull ")
        {
            push_diagnostic(
                &mut diagnostics,
                Severity::Warning,
                trimmed,
                None,
                None,
                None,
            );
            if diagnostics.len() >= MAX_DIAGNOSTICS {
                break;
            }
        }
    }
    if diagnostics.len() < MAX_DIAGNOSTICS {
        if let Some(message) = pending_latex_error {
            push_diagnostic(
                &mut diagnostics,
                Severity::Error,
                &message,
                Some(entry_path.clone()),
                None,
                None,
            );
        }
    }
    diagnostics.truncate(MAX_DIAGNOSTICS);
    diagnostics
}

pub(super) fn diagnostic_marker(line: &str) -> Option<(Severity, usize)> {
    let lower = line.to_ascii_lowercase();
    for (marker, severity) in [
        ("error:", Severity::Error),
        ("warning:", Severity::Warning),
        ("info:", Severity::Info),
    ] {
        if let Some(index) = lower.find(marker) {
            return Some((severity, index + marker.len()));
        }
    }
    None
}

pub(super) fn parse_location_diagnostic(
    payload: &str,
    severity: Severity,
    known_paths: &HashSet<String>,
    entry_path: &RelativePath,
) -> Option<Diagnostic> {
    for (colon, character) in payload.char_indices() {
        if character != ':' {
            continue;
        }
        let (line_number, after_line) = parse_number_field(&payload[colon + 1..])?;
        let path_text = payload[..colon].trim().trim_matches('"');
        let (column, message) = match parse_number_field(after_line) {
            Some((column, rest)) => (Position::new(column).ok(), rest.trim()),
            None => (None, after_line.trim()),
        };
        let path = map_diagnostic_path(path_text, known_paths, entry_path);
        let line = Position::new(line_number).ok();
        return Some(Diagnostic {
            severity,
            message: bounded_diagnostic_message(message),
            path,
            line,
            column: if line.is_some() { column } else { None },
        });
    }
    None
}

pub(super) fn parse_number_field(value: &str) -> Option<(u64, &str)> {
    let value = value.trim_start();
    let digits = value
        .char_indices()
        .take_while(|(_, character)| character.is_ascii_digit())
        .map(|(index, character)| index + character.len_utf8())
        .last()?;
    if !value[digits..].starts_with(':') {
        return None;
    }
    Some((value[..digits].parse::<u64>().ok()?, &value[digits + 1..]))
}

pub(super) fn map_diagnostic_path(
    raw: &str,
    known_paths: &HashSet<String>,
    entry_path: &RelativePath,
) -> Option<RelativePath> {
    let mut candidate = raw.replace('\\', "/").trim_matches('"').to_owned();
    for prefix in ["<compile>/input/", "<workspace>/", "input/", "./"] {
        if candidate
            .get(..prefix.len())
            .is_some_and(|part| part.eq_ignore_ascii_case(prefix))
        {
            candidate = candidate[prefix.len()..].to_owned();
            break;
        }
    }
    let normalized = candidate.trim_start_matches("./");
    if normalized.is_empty() {
        return Some(entry_path.clone());
    }
    let path = RelativePath::parse(normalized).ok()?;
    known_paths
        .contains(&path.as_str().to_lowercase())
        .then_some(path)
}

pub(super) fn parse_position(value: &str) -> Option<Position> {
    let value = value.trim_start();
    let digits = value
        .char_indices()
        .take_while(|(_, character)| character.is_ascii_digit())
        .map(|(index, character)| index + character.len_utf8())
        .last()?;
    Position::new(value[..digits].parse::<u64>().ok()?).ok()
}

pub(super) fn push_diagnostic(
    diagnostics: &mut Vec<Diagnostic>,
    severity: Severity,
    message: &str,
    path: Option<RelativePath>,
    line: Option<Position>,
    column: Option<Position>,
) {
    if diagnostics.len() < MAX_DIAGNOSTICS {
        diagnostics.push(Diagnostic {
            severity,
            message: bounded_diagnostic_message(message),
            path,
            line,
            column: if line.is_some() { column } else { None },
        });
    }
}

pub(super) fn nonempty_message(value: &str) -> String {
    let value = value.trim();
    if value.is_empty() {
        "Compiler diagnostic.".to_owned()
    } else {
        bounded_diagnostic_message(value)
    }
}

pub(super) fn bounded_diagnostic_message(value: &str) -> String {
    let mut result = value
        .trim()
        .chars()
        .take(MAX_TEXT_UTF16)
        .collect::<String>();
    if result.is_empty() {
        result.push_str("Compiler diagnostic.");
    }
    result
}
