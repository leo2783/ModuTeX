// SPDX-License-Identifier: Apache-2.0
use crate::changes::SourcePatch;
use crate::source::{SourceDocument, SourceTransaction};
use crate::SourceError;
use std::collections::BTreeMap;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EditorPatch {
    pub from: usize,
    pub to: usize,
    pub insert: String,
}

#[derive(Clone, Debug)]
pub struct EditorProjection {
    document: SourceDocument,
    length: usize,
    crlf: Vec<usize>,
    editor_corrections: Vec<EditorPatch>,
}

impl EditorProjection {
    fn from_parts(
        document: SourceDocument,
        crlf: Vec<usize>,
        editor_corrections: Vec<EditorPatch>,
    ) -> Self {
        let length = document
            .len()
            .checked_sub(crlf.len())
            .expect("each projected CRLF occupies one extra source code unit");
        Self {
            document,
            length,
            crlf,
            editor_corrections,
        }
    }

    /// Open a source snapshot and return its LF-normalized editor text.
    pub fn open(document: SourceDocument) -> (Self, String) {
        let original = document.text();
        let mut text = String::with_capacity(original.len());
        let mut crlf = Vec::new();
        let mut source_position = 0usize;
        let mut characters = original.chars().peekable();

        while let Some(character) = characters.next() {
            if character == '\r' {
                if characters.peek().copied() == Some('\n') {
                    let editor_position = source_position
                        .checked_sub(crlf.len())
                        .expect("CRLF positions cannot exceed the source position");
                    crlf.push(editor_position);
                    text.push('\n');
                    characters.next();
                    source_position += 2;
                } else {
                    text.push('\n');
                    source_position += 1;
                }
            } else {
                text.push(character);
                source_position += character.len_utf16();
            }
        }

        (Self::from_parts(document, crlf, Vec::new()), text)
    }

    pub fn document(&self) -> &SourceDocument {
        &self.document
    }

    pub fn len(&self) -> usize {
        self.length
    }

    pub fn is_empty(&self) -> bool {
        self.length == 0
    }

    /// Corrections are in the editor text immediately after the requested patches.
    pub fn editor_corrections(&self) -> &[EditorPatch] {
        &self.editor_corrections
    }

    /// Map an editor UTF-16 position to its source UTF-16 position.
    pub fn to_source(&self, position: usize) -> Result<usize, SourceError> {
        if position > self.length {
            return Err(SourceError::Range);
        }

        let mut low = 0usize;
        let mut high = self.crlf.len();
        while low < high {
            let middle = (low + high) / 2;
            if self.crlf[middle] < position {
                low = middle + 1;
            } else {
                high = middle;
            }
        }

        position.checked_add(low).ok_or(SourceError::Range)
    }

    /// Apply editor-coordinate patches atomically, preserving untouched source bytes.
    pub fn apply(
        &self,
        patches: &[EditorPatch],
        expected_version: u64,
    ) -> Result<Self, SourceError> {
        let mut source_patches = Vec::with_capacity(patches.len());
        for patch in patches {
            if patch.insert.contains('\r') {
                return Err(SourceError::Patch);
            }

            source_patches.push(SourcePatch {
                from: self.to_source(patch.from)?,
                to: self.to_source(patch.to)?,
                insert: patch
                    .insert
                    .replace('\n', &self.document.profile().preferred_line_ending),
                expected: None,
            });
        }

        let transaction = SourceTransaction {
            expected_version,
            patches: source_patches,
        };
        let update = self.document.apply(&transaction)?;
        let next = update.document;

        if next.version() == self.document.version() {
            return Ok(Self::from_parts(next, self.crlf.clone(), Vec::new()));
        }

        let preferred_crlf = self.document.profile().preferred_line_ending == "\r\n";
        let mut next_crlf = Vec::new();
        let mut crlf_index = 0usize;
        let mut editor_old_cursor = 0usize;
        let mut editor_new_cursor = 0usize;

        for (editor_patch, source_patch) in patches.iter().zip(&transaction.patches) {
            let mapped_from = editor_new_cursor
                .checked_add(
                    editor_patch
                        .from
                        .checked_sub(editor_old_cursor)
                        .ok_or(SourceError::Patch)?,
                )
                .ok_or(SourceError::Range)?;

            while crlf_index < self.crlf.len() && self.crlf[crlf_index] < editor_patch.from {
                let position = editor_new_cursor
                    .checked_add(
                        self.crlf[crlf_index]
                            .checked_sub(editor_old_cursor)
                            .ok_or(SourceError::Patch)?,
                    )
                    .ok_or(SourceError::Range)?;
                next_crlf.push(position);
                crlf_index += 1;
            }
            while crlf_index < self.crlf.len() && self.crlf[crlf_index] < editor_patch.to {
                crlf_index += 1;
            }

            let inserted_length = editor_patch.insert.encode_utf16().count();
            if preferred_crlf {
                for (offset, unit) in editor_patch.insert.encode_utf16().enumerate() {
                    if unit == b'\n' as u16 {
                        next_crlf.push(mapped_from.checked_add(offset).ok_or(SourceError::Range)?);
                    }
                }
            }

            editor_old_cursor = editor_patch.to;
            editor_new_cursor = mapped_from
                .checked_add(inserted_length)
                .ok_or(SourceError::Range)?;

            // Keep the source patch in lockstep with its editor patch. Its UTF-16
            // length is used below when examining newly joined newline boundaries.
            let _ = source_patch;
        }

        while crlf_index < self.crlf.len() {
            let position = editor_new_cursor
                .checked_add(
                    self.crlf[crlf_index]
                        .checked_sub(editor_old_cursor)
                        .ok_or(SourceError::Patch)?,
                )
                .ok_or(SourceError::Range)?;
            next_crlf.push(position);
            crlf_index += 1;
        }

        let mut joined = BTreeMap::new();
        let mut source_old_cursor = 0usize;
        let mut source_new_cursor = 0usize;
        editor_old_cursor = 0;
        editor_new_cursor = 0;

        for (editor_patch, source_patch) in patches.iter().zip(&transaction.patches) {
            let source_from = source_new_cursor
                .checked_add(
                    source_patch
                        .from
                        .checked_sub(source_old_cursor)
                        .ok_or(SourceError::Patch)?,
                )
                .ok_or(SourceError::Range)?;
            let editor_from = editor_new_cursor
                .checked_add(
                    editor_patch
                        .from
                        .checked_sub(editor_old_cursor)
                        .ok_or(SourceError::Patch)?,
                )
                .ok_or(SourceError::Range)?;
            let source_insert_length = source_patch.insert.encode_utf16().count();
            let editor_insert_length = editor_patch.insert.encode_utf16().count();
            let source_to = source_from
                .checked_add(source_insert_length)
                .ok_or(SourceError::Range)?;
            let editor_to = editor_from
                .checked_add(editor_insert_length)
                .ok_or(SourceError::Range)?;

            inspect_join(&next, source_from, editor_from, &mut joined)?;
            inspect_join(&next, source_to, editor_to, &mut joined)?;

            source_old_cursor = source_patch.to;
            source_new_cursor = source_to;
            editor_old_cursor = editor_patch.to;
            editor_new_cursor = editor_to;
        }

        let mut removed: Vec<usize> = joined.values().copied().collect();
        removed.sort_unstable();
        removed.dedup();
        if removed.is_empty() {
            return Ok(Self::from_parts(next, next_crlf, Vec::new()));
        }

        let mut adjusted_crlf = Vec::with_capacity(next_crlf.len() + removed.len());
        for position in next_crlf {
            adjusted_crlf.push(shifted_position(position, &removed));
        }

        let mut corrections = Vec::with_capacity(removed.len());
        for position in &removed {
            let start = position.checked_sub(1).ok_or(SourceError::Range)?;
            adjusted_crlf.push(shifted_position(start, &removed));
            corrections.push(EditorPatch {
                from: *position,
                to: position.checked_add(1).ok_or(SourceError::Range)?,
                insert: String::new(),
            });
        }
        adjusted_crlf.sort_unstable();

        Ok(Self::from_parts(next, adjusted_crlf, corrections))
    }

    /// Restore a snapshot from this source, advancing the current version.
    pub fn restore(&self, snapshot: &Self) -> Result<Self, SourceError> {
        let document = self
            .document
            .restore(&snapshot.document, self.document.version())?;
        Ok(Self::from_parts(
            document,
            snapshot.crlf.clone(),
            Vec::new(),
        ))
    }
}

fn inspect_join(
    document: &SourceDocument,
    source_boundary: usize,
    editor_boundary: usize,
    joined: &mut BTreeMap<usize, usize>,
) -> Result<(), SourceError> {
    if source_boundary == 0 || source_boundary >= document.len() {
        return Ok(());
    }

    match document.read(source_boundary - 1, source_boundary + 1) {
        Ok(text) if text == "\r\n" => {
            joined.insert(source_boundary, editor_boundary);
            Ok(())
        }
        Ok(_) | Err(SourceError::Range) => Ok(()),
        Err(error) => Err(error),
    }
}

fn shifted_position(position: usize, removed: &[usize]) -> usize {
    let mut low = 0usize;
    let mut high = removed.len();
    while low < high {
        let middle = (low + high) / 2;
        if removed[middle] < position {
            low = middle + 1;
        } else {
            high = middle;
        }
    }
    position - low
}
