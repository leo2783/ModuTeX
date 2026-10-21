// SPDX-License-Identifier: Apache-2.0
use serde::Serialize;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LineEndings {
    pub lf: usize,
    pub crlf: usize,
    pub cr: usize,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceProfile {
    pub encoding: String,
    pub bom: bool,
    pub preferred_line_ending: String,
    pub original_line_endings: LineEndings,
}

const SPLIT_SURROGATE: usize = usize::MAX;

#[derive(Clone, Debug)]
pub(crate) struct Segment {
    text: String,
    bytes: Vec<u8>,
    offsets: Vec<usize>,
}

impl Segment {
    pub(crate) fn new(text: String, bytes: Vec<u8>) -> Self {
        let utf16_length = text.encode_utf16().count();
        let mut offsets = vec![SPLIT_SURROGATE; utf16_length + 1];
        let mut units = 0;

        for (byte_offset, scalar) in text.char_indices() {
            offsets[units] = byte_offset;
            units += scalar.len_utf16();
            offsets[units] = byte_offset + scalar.len_utf8();
        }

        if text.is_empty() {
            offsets[0] = 0;
        }

        Self {
            text,
            bytes,
            offsets,
        }
    }

    pub(crate) fn utf16_len(&self) -> usize {
        self.offsets.len() - 1
    }

    pub(crate) fn byte_boundary(&self, position: usize) -> Option<usize> {
        self.offsets
            .get(position)
            .copied()
            .filter(|offset| *offset != SPLIT_SURROGATE)
    }

    pub(crate) fn text_slice(&self, from: usize, to: usize) -> Option<&str> {
        let byte_from = self.byte_boundary(from)?;
        let byte_to = self.byte_boundary(to)?;
        self.text.get(byte_from..byte_to)
    }

    pub(crate) fn byte_slice(&self, from: usize, to: usize) -> Option<&[u8]> {
        let byte_from = self.byte_boundary(from)?;
        let byte_to = self.byte_boundary(to)?;
        self.bytes.get(byte_from..byte_to)
    }
}

pub(crate) fn profile(text: &str, bom: bool) -> SourceProfile {
    let mut line_endings = LineEndings {
        lf: 0,
        crlf: 0,
        cr: 0,
    };
    let mut characters = text.chars().peekable();

    while let Some(character) = characters.next() {
        match character {
            '\r' => {
                if characters.peek().copied() == Some('\n') {
                    let _ = characters.next();
                    line_endings.crlf += 1;
                } else {
                    line_endings.cr += 1;
                }
            }
            '\n' => line_endings.lf += 1,
            _ => {}
        }
    }

    let preferred_line_ending =
        if line_endings.crlf > line_endings.lf && line_endings.crlf >= line_endings.cr {
            "\r\n"
        } else if line_endings.cr > line_endings.lf && line_endings.cr > line_endings.crlf {
            "\r"
        } else {
            "\n"
        };

    SourceProfile {
        encoding: "utf-8".to_owned(),
        bom,
        preferred_line_ending: preferred_line_ending.to_owned(),
        original_line_endings: line_endings,
    }
}
