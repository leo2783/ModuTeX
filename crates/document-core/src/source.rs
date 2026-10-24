// SPDX-License-Identifier: Apache-2.0
use crate::changes::{SourceChange, SourcePatch};
use crate::utf8::{profile, Segment, SourceProfile};
use serde::Serialize;
use std::error::Error;
use std::fmt;
use std::sync::Arc;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SourceError {
    Encoding,
    Range,
    Version,
    Patch,
    Content,
    Origin,
}

impl fmt::Display for SourceError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            Self::Encoding => "source is not valid UTF-8",
            Self::Range => "range is outside the source or splits a Unicode scalar value",
            Self::Version => "source version is stale or exhausted",
            Self::Patch => "patches must be ordered, non-overlapping, and unambiguous",
            Self::Content => "patch expected content does not match",
            Self::Origin => "snapshot belongs to another source",
        };
        formatter.write_str(message)
    }
}

impl Error for SourceError {}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceTransaction {
    pub expected_version: u64,
    pub patches: Vec<SourcePatch>,
}

#[derive(Clone, Debug)]
pub struct SourceUpdate {
    pub document: SourceDocument,
    pub change: SourceChange,
}

#[derive(Debug)]
struct Origin;

#[derive(Clone, Debug)]
struct Piece {
    source: Arc<Segment>,
    from: usize,
    to: usize,
}

// Each compaction removes 127 pieces, amortizing its cost across later edits.
// The cheapest adjacent window usually keeps a large original segment shared
// during typing; its copy cost still depends on the selected window's bytes.
const MAX_PIECES: usize = 256;
const COMPACT_PIECES: usize = 128;

fn compact(pieces: &mut Vec<Piece>) -> Result<(), SourceError> {
    while pieces.len() > MAX_PIECES {
        let lengths: Vec<usize> = pieces
            .iter()
            .map(|piece| {
                piece
                    .source
                    .byte_slice(piece.from, piece.to)
                    .map(<[u8]>::len)
                    .ok_or(SourceError::Range)
            })
            .collect::<Result<_, _>>()?;
        let mut window_bytes = lengths[..COMPACT_PIECES]
            .iter()
            .try_fold(0usize, |total, length| total.checked_add(*length))
            .ok_or(SourceError::Range)?;
        let mut best_start = 0;
        let mut best_bytes = window_bytes;
        for end in COMPACT_PIECES..lengths.len() {
            window_bytes = (window_bytes - lengths[end - COMPACT_PIECES])
                .checked_add(lengths[end])
                .ok_or(SourceError::Range)?;
            if window_bytes < best_bytes {
                best_start = end + 1 - COMPACT_PIECES;
                best_bytes = window_bytes;
            }
        }

        let end = best_start + COMPACT_PIECES;
        let mut text = String::with_capacity(best_bytes);
        for piece in &pieces[best_start..end] {
            text.push_str(
                piece
                    .source
                    .text_slice(piece.from, piece.to)
                    .ok_or(SourceError::Range)?,
            );
        }
        let bytes = text.as_bytes().to_vec();
        let source = Arc::new(Segment::new(text, bytes));
        let to = source.utf16_len();
        pieces.splice(
            best_start..end,
            [Piece {
                source,
                from: 0,
                to,
            }],
        );
    }
    Ok(())
}

#[cfg(test)]
#[path = "../tests/unit/source_compaction.rs"]
mod tests;

#[derive(Clone, Debug)]
pub struct SourceDocument {
    document_id: String,
    version: u64,
    length: usize,
    byte_length: usize,
    profile: SourceProfile,
    pieces: Vec<Piece>,
    origin: Arc<Origin>,
}

fn append(target: &mut Vec<Piece>, piece: Piece) {
    if piece.from == piece.to {
        return;
    }

    if let Some(previous) = target.last_mut() {
        if Arc::ptr_eq(&previous.source, &piece.source) && previous.to == piece.from {
            previous.to = piece.to;
            return;
        }
    }

    target.push(piece);
}

impl SourceDocument {
    pub fn open(bytes: &[u8], document_id: String) -> Result<Self, SourceError> {
        Self::open_with_version(bytes, document_id, 0)
    }

    /// Open bytes with an explicit snapshot identity and version.
    pub fn open_with_version(
        bytes: &[u8],
        document_id: String,
        version: u64,
    ) -> Result<Self, SourceError> {
        let bom = bytes.starts_with(&[0xef, 0xbb, 0xbf]);
        let body = if bom { &bytes[3..] } else { bytes };
        let text = std::str::from_utf8(body).map_err(|_| SourceError::Encoding)?;
        let source = Arc::new(Segment::new(text.to_owned(), body.to_vec()));
        let source_length = source.utf16_len();
        let pieces = if source_length == 0 {
            Vec::new()
        } else {
            vec![Piece {
                source,
                from: 0,
                to: source_length,
            }]
        };

        Self::from_parts(
            pieces,
            profile(text, bom),
            document_id,
            version,
            Arc::new(Origin),
        )
    }

    fn from_parts(
        pieces: Vec<Piece>,
        profile: SourceProfile,
        document_id: String,
        version: u64,
        origin: Arc<Origin>,
    ) -> Result<Self, SourceError> {
        let mut length = 0usize;
        let mut byte_length = if profile.bom { 3usize } else { 0usize };

        for piece in &pieces {
            if piece.from > piece.to || piece.to > piece.source.utf16_len() {
                return Err(SourceError::Range);
            }
            let byte_from = piece
                .source
                .byte_boundary(piece.from)
                .ok_or(SourceError::Range)?;
            let byte_to = piece
                .source
                .byte_boundary(piece.to)
                .ok_or(SourceError::Range)?;
            if byte_from > byte_to {
                return Err(SourceError::Range);
            }

            length = length
                .checked_add(piece.to - piece.from)
                .ok_or(SourceError::Range)?;
            byte_length = byte_length
                .checked_add(byte_to - byte_from)
                .ok_or(SourceError::Range)?;
        }

        Ok(Self {
            document_id,
            version,
            length,
            byte_length,
            profile,
            pieces,
            origin,
        })
    }

    pub fn document_id(&self) -> &str {
        &self.document_id
    }

    pub fn version(&self) -> u64 {
        self.version
    }

    pub fn len(&self) -> usize {
        self.length
    }

    pub fn piece_count(&self) -> usize {
        self.pieces.len()
    }

    pub fn is_empty(&self) -> bool {
        self.length == 0
    }

    pub fn byte_len(&self) -> usize {
        self.byte_length
    }

    pub fn profile(&self) -> &SourceProfile {
        &self.profile
    }

    fn check_range(&self, from: usize, to: usize) -> Result<(), SourceError> {
        if from > to || to > self.length {
            return Err(SourceError::Range);
        }
        Ok(())
    }

    fn check_boundary(&self, position: usize) -> Result<(), SourceError> {
        let mut cursor = 0usize;

        for piece in &self.pieces {
            let piece_length = piece.to - piece.from;
            let end = cursor.checked_add(piece_length).ok_or(SourceError::Range)?;
            if position >= cursor && position <= end {
                let local_position = piece
                    .from
                    .checked_add(position - cursor)
                    .ok_or(SourceError::Range)?;
                piece
                    .source
                    .byte_boundary(local_position)
                    .ok_or(SourceError::Range)?;
                return Ok(());
            }
            cursor = end;
        }

        if position == self.length {
            Ok(())
        } else {
            Err(SourceError::Range)
        }
    }

    fn slice(&self, from: usize, to: usize) -> Vec<Piece> {
        let mut result = Vec::new();
        let mut cursor = 0usize;

        for piece in &self.pieces {
            let end = cursor + (piece.to - piece.from);
            if cursor >= to {
                break;
            }

            let overlap_start = from.max(cursor);
            let overlap_end = to.min(end);
            if overlap_start < overlap_end {
                append(
                    &mut result,
                    Piece {
                        source: Arc::clone(&piece.source),
                        from: piece.from + (overlap_start - cursor),
                        to: piece.from + (overlap_end - cursor),
                    },
                );
            }
            cursor = end;
        }

        result
    }

    pub fn read(&self, from: usize, to: usize) -> Result<String, SourceError> {
        self.check_range(from, to)?;
        self.check_boundary(from)?;
        self.check_boundary(to)?;

        let mut result = String::new();
        for piece in self.slice(from, to) {
            let text = piece
                .source
                .text_slice(piece.from, piece.to)
                .ok_or(SourceError::Range)?;
            result.push_str(text);
        }
        Ok(result)
    }

    pub fn text(&self) -> String {
        self.read(0, self.length)
            .expect("a complete source snapshot has valid scalar boundaries")
    }

    pub fn to_bytes(&self) -> Vec<u8> {
        let mut result = Vec::with_capacity(self.byte_length);
        if self.profile.bom {
            result.extend_from_slice(&[0xef, 0xbb, 0xbf]);
        }

        for piece in &self.pieces {
            let bytes = piece
                .source
                .byte_slice(piece.from, piece.to)
                .expect("source pieces have valid scalar boundaries");
            result.extend_from_slice(bytes);
        }
        result
    }

    fn expect_version(&self, version: u64) -> Result<(), SourceError> {
        if version != self.version {
            return Err(SourceError::Version);
        }
        Ok(())
    }

    fn next_version(&self) -> Result<u64, SourceError> {
        self.version.checked_add(1).ok_or(SourceError::Version)
    }

    pub fn apply(&self, transaction: &SourceTransaction) -> Result<SourceUpdate, SourceError> {
        self.expect_version(transaction.expected_version)?;

        let mut active = Vec::new();
        let mut previous_patch: Option<(usize, usize)> = None;

        for candidate in &transaction.patches {
            self.check_range(candidate.from, candidate.to)?;
            self.check_boundary(candidate.from)?;
            self.check_boundary(candidate.to)?;

            if let Some((previous_from, previous_to)) = previous_patch {
                if candidate.from <= previous_from || candidate.from < previous_to {
                    return Err(SourceError::Patch);
                }
            }
            previous_patch = Some((candidate.from, candidate.to));

            let existing = self.read(candidate.from, candidate.to)?;
            if let Some(expected) = candidate.expected.as_deref() {
                if expected != existing {
                    return Err(SourceError::Content);
                }
            }
            if existing != candidate.insert {
                active.push(candidate.clone());
            }
        }

        if active.is_empty() {
            return Ok(SourceUpdate {
                document: self.clone(),
                change: SourceChange {
                    document_id: self.document_id.clone(),
                    before_version: self.version,
                    after_version: self.version,
                    old_length: self.length,
                    new_length: self.length,
                    patches: Vec::new(),
                },
            });
        }

        let next_version = self.next_version()?;
        let mut pieces = Vec::new();
        let mut cursor = 0usize;

        for patch in &active {
            for piece in self.slice(cursor, patch.from) {
                append(&mut pieces, piece);
            }

            if !patch.insert.is_empty() {
                let source = Arc::new(Segment::new(
                    patch.insert.clone(),
                    patch.insert.as_bytes().to_vec(),
                ));
                let inserted_length = source.utf16_len();
                append(
                    &mut pieces,
                    Piece {
                        source,
                        from: 0,
                        to: inserted_length,
                    },
                );
            }
            cursor = patch.to;
        }

        for piece in self.slice(cursor, self.length) {
            append(&mut pieces, piece);
        }

        compact(&mut pieces)?;

        let document = Self::from_parts(
            pieces,
            self.profile.clone(),
            self.document_id.clone(),
            next_version,
            Arc::clone(&self.origin),
        )?;
        let change = SourceChange {
            document_id: self.document_id.clone(),
            before_version: self.version,
            after_version: document.version,
            old_length: self.length,
            new_length: document.length,
            patches: active,
        };

        Ok(SourceUpdate { document, change })
    }

    pub fn restore(&self, snapshot: &Self, expected_version: u64) -> Result<Self, SourceError> {
        self.expect_version(expected_version)?;
        if !Arc::ptr_eq(&self.origin, &snapshot.origin) {
            return Err(SourceError::Origin);
        }

        Self::from_parts(
            snapshot.pieces.clone(),
            self.profile.clone(),
            self.document_id.clone(),
            self.next_version()?,
            Arc::clone(&self.origin),
        )
    }
}
