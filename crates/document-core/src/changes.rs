// SPDX-License-Identifier: Apache-2.0
use crate::source::SourceError;
use serde::Serialize;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourcePatch {
    pub from: usize,
    pub to: usize,
    pub insert: String,
    pub expected: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceSpan {
    pub document_id: String,
    pub from: usize,
    pub to: usize,
    pub version: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceChange {
    pub document_id: String,
    pub before_version: u64,
    pub after_version: u64,
    pub old_length: usize,
    pub new_length: usize,
    pub patches: Vec<SourcePatch>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Bias {
    Before,
    After,
}

pub fn map_position(
    change: &SourceChange,
    position: usize,
    bias: Bias,
) -> Result<usize, SourceError> {
    if position > change.old_length {
        return Err(SourceError::Range);
    }

    let mut old_cursor = 0;
    let mut new_cursor: usize = 0;
    let mut previous_from = None;

    for patch in &change.patches {
        if patch.from > patch.to
            || patch.to > change.old_length
            || patch.from < old_cursor
            || previous_from.is_some_and(|previous| patch.from <= previous)
        {
            return Err(SourceError::Patch);
        }
        previous_from = Some(patch.from);

        let unchanged_length = patch.from - old_cursor;
        let mapped_patch_start = new_cursor
            .checked_add(unchanged_length)
            .ok_or(SourceError::Range)?;

        if position < patch.from {
            return new_cursor
                .checked_add(position - old_cursor)
                .ok_or(SourceError::Range);
        }

        let inserted_length = patch.insert.encode_utf16().count();
        let mapped_patch_end = mapped_patch_start
            .checked_add(inserted_length)
            .ok_or(SourceError::Range)?;

        if position == patch.from {
            return Ok(match bias {
                Bias::Before => mapped_patch_start,
                Bias::After => mapped_patch_end,
            });
        }

        if position < patch.to {
            return Ok(match bias {
                Bias::Before => mapped_patch_start,
                Bias::After => mapped_patch_end,
            });
        }

        old_cursor = patch.to;
        new_cursor = mapped_patch_end;
    }

    new_cursor
        .checked_add(position - old_cursor)
        .ok_or(SourceError::Range)
}

pub fn remap_span(
    change: &SourceChange,
    span: &SourceSpan,
) -> Result<Option<SourceSpan>, SourceError> {
    if span.document_id != change.document_id || span.version != change.before_version {
        return Err(SourceError::Version);
    }
    if span.from > span.to || span.to > change.old_length {
        return Err(SourceError::Range);
    }

    for patch in &change.patches {
        let touches = if patch.from == patch.to {
            patch.from > span.from && patch.from < span.to
        } else {
            patch.from < span.to && patch.to > span.from
        };
        if touches {
            return Ok(None);
        }
    }

    let from = map_position(change, span.from, Bias::After)?;
    let to_bias = if span.from == span.to {
        Bias::After
    } else {
        Bias::Before
    };
    let to = map_position(change, span.to, to_bias)?;

    Ok(Some(SourceSpan {
        document_id: span.document_id.clone(),
        from,
        to,
        version: change.after_version,
    }))
}
