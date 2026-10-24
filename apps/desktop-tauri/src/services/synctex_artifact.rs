// SPDX-License-Identifier: Apache-2.0
//! Bounded normalization of SyncTeX paths proven to belong to the staged input.

use std::{
    collections::HashMap,
    fs,
    io::{self, Read, Write},
    path::Path,
};

use flate2::{read::MultiGzDecoder, write::GzEncoder, Compression};

use crate::shared::relative_path::RelativePath;

pub(super) const MAX_COMPRESSED_BYTES: usize = 32 * 1024 * 1024;
const MAX_DECOMPRESSED_BYTES: usize = 64 * 1024 * 1024;
const MAX_INPUT_RECORDS: usize = 4096;

pub(super) fn normalize_gzip<'a>(
    compressed: &[u8],
    input_root: &Path,
    snapshot_paths: impl IntoIterator<Item = &'a RelativePath>,
    entry_path: &RelativePath,
) -> Option<Vec<u8>> {
    if compressed.len() < 2
        || compressed.len() > MAX_COMPRESSED_BYTES
        || !compressed.starts_with(&[0x1f, 0x8b])
    {
        return None;
    }
    let root_text = normalize_absolute(input_root.to_str()?)?;
    let mut sources: HashMap<String, Option<&'a RelativePath>> = HashMap::new();
    let mut source_count = 0usize;
    for source in snapshot_paths {
        source_count = source_count.checked_add(1)?;
        if source_count > MAX_INPUT_RECORDS {
            return None;
        }
        let slot = sources
            .entry(source.as_str().to_lowercase())
            .or_insert(Some(source));
        if let Some(previous) = *slot {
            if previous.as_str() != source.as_str() {
                *slot = None;
            }
        }
    }

    let mut decoded = Vec::new();
    MultiGzDecoder::new(compressed)
        .take(MAX_DECOMPRESSED_BYTES as u64 + 1)
        .read_to_end(&mut decoded)
        .ok()?;
    if decoded.len() > MAX_DECOMPRESSED_BYTES {
        return None;
    }
    let text = std::str::from_utf8(&decoded).ok()?;
    let mut output = Vec::new();
    let mut safe_sources = HashMap::<String, bool>::new();
    let mut byte_count = 0usize;
    let mut input_records = 0usize;
    let mut first_line = true;
    let mut content_seen = false;
    let mut entry_mapped = false;

    for line in text.split_inclusive('\n') {
        let (body, ending) = split_line(line);
        if first_line {
            if body != "SyncTeX Version:1" {
                return None;
            }
            first_line = false;
        }
        let start = output.len();
        if content_seen && body.starts_with('!') {
            let digits = body.strip_prefix('!')?;
            if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
                return None;
            }
            digits.parse::<usize>().ok()?;
            let anchor = format!("!{byte_count}");
            append_bounded(&mut output, anchor.as_bytes())?;
            append_bounded(&mut output, ending.as_bytes())?;
            // Checkpoints are relative: the next distance starts with this
            // emitted anchor line, including its possibly changed digit width.
            byte_count = output.len().checked_sub(start)?;
        } else if let Some(fields) = body.strip_prefix("Input:") {
            input_records = input_records.checked_add(1)?;
            if input_records > MAX_INPUT_RECORDS {
                return None;
            }
            let (tag, raw_path) = fields.split_once(':')?;
            if tag.is_empty() || !tag.bytes().all(|byte| byte.is_ascii_digit()) {
                return None;
            }
            let source = source_for_input(raw_path, &root_text, &sources);
            let safe_source = match source {
                Some(source) => {
                    let safe = *safe_sources
                        .entry(source.as_str().to_owned())
                        .or_insert_with(|| staged_source_is_safe(input_root, source));
                    safe.then_some(source)
                }
                None => None,
            };
            if let Some(source) = safe_source {
                entry_mapped |= source == entry_path;
                append_bounded(&mut output, b"Input:")?;
                append_bounded(&mut output, tag.as_bytes())?;
                append_bounded(&mut output, b":")?;
                append_bounded(&mut output, source.as_str().as_bytes())?;
                append_bounded(&mut output, ending.as_bytes())?;
            } else {
                append_bounded(&mut output, line.as_bytes())?;
            }
            byte_count = byte_count.checked_add(output.len().checked_sub(start)?)?;
        } else {
            append_bounded(&mut output, line.as_bytes())?;
            byte_count = byte_count.checked_add(output.len().checked_sub(start)?)?;
        }
        if body == "Content:" {
            content_seen = true;
        }
    }
    if first_line || !content_seen || !entry_mapped {
        return None;
    }
    encode_gzip_bounded(&output)
}

fn split_line(line: &str) -> (&str, &str) {
    if let Some(body) = line.strip_suffix("\r\n") {
        (body, "\r\n")
    } else if let Some(body) = line.strip_suffix('\n') {
        (body, "\n")
    } else {
        (line, "")
    }
}

fn source_for_input<'a>(
    raw_path: &str,
    root: &str,
    sources: &HashMap<String, Option<&'a RelativePath>>,
) -> Option<&'a RelativePath> {
    let relative = relative_input_path(raw_path, root)?;
    sources
        .get(&relative.as_str().to_lowercase())
        .copied()
        .flatten()
}

fn relative_input_path(raw_path: &str, root: &str) -> Option<RelativePath> {
    let normalized = raw_path.replace('\\', "/");
    if normalized.starts_with('/') || normalized.as_bytes().get(1) == Some(&b':') {
        let absolute = normalize_absolute(raw_path)?;
        if !absolute.get(..root.len())?.eq_ignore_ascii_case(root) {
            return None;
        }
        let suffix = absolute.get(root.len()..)?;
        let suffix = if root.ends_with('/') {
            suffix
        } else {
            suffix.strip_prefix('/')?
        };
        return RelativePath::parse(suffix).ok();
    }
    if normalized.contains(':') {
        return None;
    }
    let mut relative = normalized.as_str();
    while let Some(rest) = relative.strip_prefix("./") {
        relative = rest;
    }
    RelativePath::parse(relative).ok()
}

fn normalize_absolute(path: &str) -> Option<String> {
    let normalized = path.replace('\\', "/");
    let normalized = normalized.strip_prefix("//?/").unwrap_or(&normalized);
    let bytes = normalized.as_bytes();
    if normalized.starts_with("//")
        || bytes.len() < 3
        || !bytes[0].is_ascii_alphabetic()
        || bytes[1] != b':'
        || bytes[2] != b'/'
        || normalized
            .chars()
            .any(|character| character <= '\u{1f}' || character == '\u{7f}')
    {
        return None;
    }
    let tail = &normalized[3..];
    if !tail.is_empty()
        && tail.split('/').any(|segment| {
            segment.is_empty() || segment == "." || segment == ".." || segment.contains(':')
        })
    {
        return None;
    }
    Some(normalized.to_owned())
}

fn staged_source_is_safe(input_root: &Path, source: &RelativePath) -> bool {
    if crate::state::recent::check_path_not_symlink_or_reparse(input_root, None).is_err() {
        return false;
    }
    let Ok(root_metadata) = fs::symlink_metadata(input_root) else {
        return false;
    };
    if crate::platform::file_identity::is_symlink_or_reparse(&root_metadata)
        || !root_metadata.is_dir()
    {
        return false;
    }
    let mut path = input_root.to_path_buf();
    let mut segments = source.as_str().split('/').peekable();
    while let Some(segment) = segments.next() {
        path.push(segment);
        if crate::state::recent::check_path_not_symlink_or_reparse(&path, None).is_err() {
            return false;
        }
        let Ok(metadata) = fs::symlink_metadata(&path) else {
            return false;
        };
        let expected_type = if segments.peek().is_some() {
            metadata.is_dir()
        } else {
            metadata.is_file()
        };
        if crate::platform::file_identity::is_symlink_or_reparse(&metadata) || !expected_type {
            return false;
        }
    }
    let Ok(canonical_root) = fs::canonicalize(input_root) else {
        return false;
    };
    let Ok(canonical_source) = fs::canonicalize(&path) else {
        return false;
    };
    canonical_source.starts_with(&canonical_root)
}

fn append_bounded(output: &mut Vec<u8>, bytes: &[u8]) -> Option<()> {
    let length = output.len().checked_add(bytes.len())?;
    if length > MAX_DECOMPRESSED_BYTES {
        return None;
    }
    output.try_reserve(bytes.len()).ok()?;
    output.extend_from_slice(bytes);
    Some(())
}

struct BoundedWriter(Vec<u8>);

impl Write for BoundedWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let length = self
            .0
            .len()
            .checked_add(bytes.len())
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "gzip size overflow"))?;
        if length > MAX_COMPRESSED_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "compressed SyncTeX limit exceeded",
            ));
        }
        self.0
            .try_reserve(bytes.len())
            .map_err(|_| io::Error::new(io::ErrorKind::OutOfMemory, "gzip allocation failed"))?;
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn encode_gzip_bounded(bytes: &[u8]) -> Option<Vec<u8>> {
    let mut encoder = GzEncoder::new(BoundedWriter(Vec::new()), Compression::fast());
    encoder.write_all(bytes).ok()?;
    Some(encoder.finish().ok()?.0)
}

#[cfg(test)]
#[path = "../../tests/unit/synctex_artifact.rs"]
mod tests;
