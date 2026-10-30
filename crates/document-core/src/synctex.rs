// SPDX-License-Identifier: Apache-2.0
use flate2::bufread::GzDecoder;
use serde::Serialize;
use std::cmp::Ordering;
use std::collections::BTreeMap;
use std::fmt;
use std::io::Read;
use std::str;

const MAX_ENCODED_BYTES: usize = 32 * 1024 * 1024;
const MAX_DECODED_BYTES: usize = 64 * 1024 * 1024;
const MAX_RECORDS: usize = 1_000_000;
const MAX_NESTING: usize = 128;
const MAX_PATH_BYTES: usize = 32_767;
const MAX_COORDINATE_POINTS: f64 = 1_000_000_000_000.0;
const MAX_SCALE: f64 = 1_000_000_000_000.0;
const SP_TO_BP: f64 = 7200.0 / 7227.0 / 65536.0;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SynctexError {
    InputTooLarge,
    DecodedDataTooLarge,
    InvalidGzip,
    InvalidUtf8,
    InvalidHeader,
    UnsupportedVersion(u32),
    UnsupportedOutput,
    InvalidNumber,
    InvalidStructure,
    UnsupportedRecord,
    LimitExceeded,
    InvalidCoordinate,
}

impl fmt::Display for SynctexError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InputTooLarge => {
                formatter.write_str("SyncTeX input exceeds the encoded size limit")
            }
            Self::DecodedDataTooLarge => {
                formatter.write_str("SyncTeX data exceeds the decoded size limit")
            }
            Self::InvalidGzip => formatter.write_str("Invalid or unsupported gzip data"),
            Self::InvalidUtf8 => formatter.write_str("SyncTeX data is not valid UTF-8"),
            Self::InvalidHeader => formatter.write_str("Invalid SyncTeX header"),
            Self::UnsupportedVersion(version) => {
                write!(formatter, "Unsupported SyncTeX version {version}")
            }
            Self::UnsupportedOutput => formatter.write_str("SyncTeX output is not a PDF"),
            Self::InvalidNumber => formatter.write_str("Invalid SyncTeX number"),
            Self::InvalidStructure => formatter.write_str("Invalid or truncated SyncTeX structure"),
            Self::UnsupportedRecord => formatter.write_str("Unsupported SyncTeX record"),
            Self::LimitExceeded => formatter.write_str("SyncTeX structural limit exceeded"),
            Self::InvalidCoordinate => {
                formatter.write_str("Invalid or out-of-range SyncTeX coordinate")
            }
        }
    }
}

impl std::error::Error for SynctexError {}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SynctexLocation {
    pub page: u32,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub depth: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SynctexSourceLocation {
    pub path: String,
    pub line: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub column: Option<u32>,
}

#[derive(Debug)]
pub struct SynctexIndex {
    records: Vec<Record>,
    source_paths: BTreeMap<u32, Option<String>>,
    source_tags: BTreeMap<String, Vec<u32>>,
    lines_by_tag: BTreeMap<u32, BTreeMap<u32, Vec<usize>>>,
    records_by_page: BTreeMap<u32, Vec<usize>>,
}

impl SynctexIndex {
    pub fn parse(bytes: &[u8]) -> Result<Self, SynctexError> {
        let decoded = decode_input(bytes)?;
        let utf8 = str::from_utf8(&decoded).map_err(|_| SynctexError::InvalidUtf8)?;
        let text = match utf8.strip_prefix('\u{feff}') {
            Some(without_bom) => without_bom,
            None => utf8,
        };

        let mut header = Header::default();
        let mut section = Section::Header;
        let mut raw_records = Vec::new();
        let mut boxes = Vec::new();
        let mut active_page = None;
        let mut content_record_count = 0usize;
        let mut postamble_count_seen = false;

        for line in text.lines() {
            if line.is_empty() {
                continue;
            }

            match section {
                Section::Header => {
                    if line == "Content:" {
                        section = Section::Content;
                    } else {
                        parse_header_line(line, &mut header)?;
                    }
                }
                Section::Content => {
                    if line == "Postamble:" {
                        if active_page.is_some() || !boxes.is_empty() {
                            return Err(SynctexError::InvalidStructure);
                        }
                        section = Section::Postamble;
                    } else if let Some(input) = line.strip_prefix("Input:") {
                        add_input(input, &mut header.inputs)?;
                    } else {
                        parse_content_record(
                            line,
                            &mut content_record_count,
                            &mut raw_records,
                            &mut active_page,
                            &mut boxes,
                        )?;
                    }
                }
                Section::Postamble => {
                    if line == "Post scriptum:" {
                        section = Section::PostScriptum;
                    } else if let Some(input) = line.strip_prefix("Input:") {
                        add_input(input, &mut header.inputs)?;
                    } else if let Some(count) = line.strip_prefix("Count:") {
                        if postamble_count_seen {
                            return Err(SynctexError::InvalidStructure);
                        }
                        if parse_u32(count)? as usize > MAX_RECORDS {
                            return Err(SynctexError::LimitExceeded);
                        }
                        postamble_count_seen = true;
                    } else if line.starts_with('!') {
                        parse_index_offset(line)?;
                    } else {
                        return Err(SynctexError::UnsupportedRecord);
                    }
                }
                Section::PostScriptum => {
                    // In SyncTeX v1, ! records are index offsets, not coordinate
                    // transforms. Other post-scriptum records are rejected rather
                    // than silently returning coordinates that may be transformed.
                    if line.starts_with('!') {
                        parse_index_offset(line)?;
                    } else {
                        return Err(SynctexError::UnsupportedRecord);
                    }
                }
            }
        }

        if section != Section::PostScriptum
            || !postamble_count_seen
            || active_page.is_some()
            || !boxes.is_empty()
        {
            return Err(SynctexError::InvalidStructure);
        }

        let transform = header.transform()?;
        Self::from_parts(header.inputs, raw_records, transform)
    }

    pub fn forward_search(
        &self,
        source: &str,
        line: u32,
        page_hint: Option<u32>,
    ) -> Option<SynctexLocation> {
        if line == 0 {
            return None;
        }
        let key = canonical_path(source)?;
        let tags = self.source_tags.get(&key)?;

        let mut closest: Option<(u32, u32)> = None;
        for tag in tags {
            let Some(lines) = self.lines_by_tag.get(tag) else {
                continue;
            };
            let Some(candidate_line) = closest_line(lines, line) else {
                continue;
            };
            let candidate = (candidate_line.abs_diff(line), candidate_line);
            if closest.is_none_or(|current| candidate < current) {
                closest = Some(candidate);
            }
        }
        let (_, selected_line) = closest?;
        let page_hint = page_hint.filter(|page| *page != 0);

        let mut best: Option<&Record> = None;
        for tag in tags {
            let Some(line_records) = self
                .lines_by_tag
                .get(tag)
                .and_then(|lines| lines.get(&selected_line))
            else {
                continue;
            };
            for index in line_records {
                let Some(record) = self.records.get(*index) else {
                    continue;
                };
                if best.is_none_or(|current| {
                    compare_forward(record, current, page_hint) == Ordering::Less
                }) {
                    best = Some(record);
                }
            }
        }

        best.map(|record| SynctexLocation {
            page: record.page,
            x: record.x,
            y: record.y,
            width: record.width,
            height: record.height,
            depth: record.depth,
        })
    }

    pub fn inverse_search(&self, page: u32, x: f64, y: f64) -> Option<SynctexSourceLocation> {
        if page == 0
            || !x.is_finite()
            || !y.is_finite()
            || x.abs() > MAX_COORDINATE_POINTS
            || y.abs() > MAX_COORDINATE_POINTS
        {
            return None;
        }
        let page_records = self.records_by_page.get(&page)?;
        let mut best: Option<(&Record, f64)> = None;

        for index in page_records {
            let Some(record) = self.records.get(*index) else {
                continue;
            };
            if !matches!(self.source_paths.get(&record.tag), Some(Some(_))) {
                continue;
            }
            let Some(distance) = distance_to_record(record, x, y) else {
                continue;
            };
            if best.is_none_or(|(current, current_distance)| {
                compare_inverse(record, distance, current, current_distance) == Ordering::Less
            }) {
                best = Some((record, distance));
            }
        }

        let (record, _) = best?;
        let path = match self.source_paths.get(&record.tag) {
            Some(Some(path)) => path.clone(),
            _ => return None,
        };
        Some(SynctexSourceLocation {
            path,
            line: record.line,
            column: record.column,
        })
    }

    fn from_parts(
        source_paths: BTreeMap<u32, Option<String>>,
        raw_records: Vec<RawRecord>,
        transform: Transform,
    ) -> Result<Self, SynctexError> {
        let mut source_tags = BTreeMap::<String, Vec<u32>>::new();
        for (tag, path) in &source_paths {
            if let Some(path) = path {
                let key = canonical_path(path).ok_or(SynctexError::InvalidHeader)?;
                source_tags.entry(key).or_default().push(*tag);
            }
        }

        let mut records = Vec::new();
        let mut lines_by_tag = BTreeMap::<u32, BTreeMap<u32, Vec<usize>>>::new();
        let mut records_by_page = BTreeMap::<u32, Vec<usize>>::new();

        for raw in raw_records {
            let source_path = source_paths
                .get(&raw.tag)
                .ok_or(SynctexError::InvalidStructure)?;
            let queryable = raw.line != 0 && source_path.is_some();
            let tag = raw.tag;
            let line = raw.line;
            let page = raw.page;
            let record = transform_record(raw, transform)?;
            let index = records.len();
            records.push(record);

            if queryable {
                lines_by_tag
                    .entry(tag)
                    .or_default()
                    .entry(line)
                    .or_default()
                    .push(index);
                records_by_page.entry(page).or_default().push(index);
            }
        }

        Ok(Self {
            records,
            source_paths,
            source_tags,
            lines_by_tag,
            records_by_page,
        })
    }
}

#[derive(Default)]
struct Header {
    version: Option<u32>,
    output: Option<String>,
    magnification: Option<f64>,
    unit: Option<f64>,
    x_offset: Option<i64>,
    y_offset: Option<i64>,
    inputs: BTreeMap<u32, Option<String>>,
}

impl Header {
    fn transform(&self) -> Result<Transform, SynctexError> {
        if self.version.is_none() {
            return Err(SynctexError::InvalidHeader);
        }
        let output = self.output.as_deref().ok_or(SynctexError::InvalidHeader)?;
        let output_bytes = output.as_bytes();
        let has_pdf_suffix = output_bytes.len() >= 4
            && output_bytes[output_bytes.len() - 4..].eq_ignore_ascii_case(b".pdf");
        if !output.eq_ignore_ascii_case("pdf") && !has_pdf_suffix {
            return Err(SynctexError::UnsupportedOutput);
        }

        let magnification = self.magnification.ok_or(SynctexError::InvalidHeader)?;
        let unit = self.unit.ok_or(SynctexError::InvalidHeader)?;
        let x_offset = self.x_offset.ok_or(SynctexError::InvalidHeader)?;
        let y_offset = self.y_offset.ok_or(SynctexError::InvalidHeader)?;
        if magnification <= 0.0 || unit <= 0.0 {
            return Err(SynctexError::InvalidNumber);
        }

        // SyncTeX positions are scaled points. Unit and magnification apply
        // before conversion from TeX points to PDF big points (72dpi).
        let scale = unit * (magnification / 1000.0) * SP_TO_BP;
        if !scale.is_finite() || scale <= 0.0 || scale > MAX_SCALE {
            return Err(SynctexError::InvalidCoordinate);
        }

        Ok(Transform {
            scale,
            x_offset,
            y_offset,
        })
    }
}

#[derive(Clone, Copy)]
struct Transform {
    scale: f64,
    x_offset: i64,
    y_offset: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RecordKind {
    Box,
    Glyph,
    Rule,
    Kern,
    Glue,
    Math,
    Boundary,
    Form,
}

#[derive(Clone, Copy)]
enum PayloadShape {
    Dimensions,
    Kern,
    Point,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum BoxKind {
    Horizontal,
    Vertical,
}

struct RawRecord {
    page: u32,
    tag: u32,
    line: u32,
    column: Option<u32>,
    h: i64,
    v: i64,
    width: i64,
    height: i64,
    depth: i64,
    kind: RecordKind,
    nesting: u8,
    order: usize,
}

#[derive(Clone, Copy, Debug)]
struct Record {
    page: u32,
    tag: u32,
    line: u32,
    column: Option<u32>,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    depth: f64,
    kind: RecordKind,
    nesting: u8,
    order: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Section {
    Header,
    Content,
    Postamble,
    PostScriptum,
}

fn decode_input(bytes: &[u8]) -> Result<Vec<u8>, SynctexError> {
    if bytes.len() > MAX_ENCODED_BYTES {
        return Err(SynctexError::InputTooLarge);
    }
    let is_gzip = bytes.first() == Some(&0x1f) && bytes.get(1) == Some(&0x8b);
    if !is_gzip {
        return Ok(bytes.to_vec());
    }

    let mut decoder = GzDecoder::new(bytes);
    let mut decoded = Vec::new();
    let read_result = {
        let mut capped = decoder.by_ref().take(MAX_DECODED_BYTES as u64 + 1);
        capped.read_to_end(&mut decoded)
    };
    if read_result.is_err() {
        return Err(SynctexError::InvalidGzip);
    }
    if decoded.len() > MAX_DECODED_BYTES {
        return Err(SynctexError::DecodedDataTooLarge);
    }
    if !decoder.into_inner().is_empty() {
        return Err(SynctexError::InvalidGzip);
    }
    Ok(decoded)
}

fn parse_header_line(line: &str, header: &mut Header) -> Result<(), SynctexError> {
    if let Some(input) = line.strip_prefix("Input:") {
        return add_input(input, &mut header.inputs);
    }
    if let Some(version) = line.strip_prefix("SyncTeX Version:") {
        if header.version.is_some() {
            return Err(SynctexError::InvalidHeader);
        }
        let version = parse_u32(version)?;
        if version != 1 {
            return Err(SynctexError::UnsupportedVersion(version));
        }
        header.version = Some(version);
        return Ok(());
    }
    if let Some(output) = line.strip_prefix("Output:") {
        if output.is_empty()
            || output.len() > MAX_PATH_BYTES
            || output.chars().any(char::is_control)
        {
            return Err(SynctexError::InvalidHeader);
        }
        set_once(&mut header.output, output.to_owned())
    } else if let Some(magnification) = line.strip_prefix("Magnification:") {
        let magnification = parse_finite_number(magnification)?;
        if magnification <= 0.0 {
            return Err(SynctexError::InvalidNumber);
        }
        set_once(&mut header.magnification, magnification)
    } else if let Some(unit) = line.strip_prefix("Unit:") {
        let unit = parse_finite_number(unit)?;
        if unit <= 0.0 {
            return Err(SynctexError::InvalidNumber);
        }
        set_once(&mut header.unit, unit)
    } else if let Some(offset) = line.strip_prefix("X Offset:") {
        set_once(&mut header.x_offset, parse_i64(offset)?)
    } else if let Some(offset) = line.strip_prefix("Y Offset:") {
        set_once(&mut header.y_offset, parse_i64(offset)?)
    } else {
        Err(SynctexError::UnsupportedRecord)
    }
}

fn set_once<T>(slot: &mut Option<T>, value: T) -> Result<(), SynctexError> {
    if slot.is_some() {
        return Err(SynctexError::InvalidHeader);
    }
    *slot = Some(value);
    Ok(())
}

fn add_input(value: &str, inputs: &mut BTreeMap<u32, Option<String>>) -> Result<(), SynctexError> {
    let (tag_text, path) = value.split_once(':').ok_or(SynctexError::InvalidHeader)?;
    let tag = parse_positive_u32(tag_text)?;
    if inputs.len() >= MAX_RECORDS {
        return Err(SynctexError::LimitExceeded);
    }
    if path.len() > MAX_PATH_BYTES || path.chars().any(char::is_control) {
        return Err(SynctexError::InvalidHeader);
    }
    if inputs.contains_key(&tag) {
        return Err(SynctexError::InvalidHeader);
    }
    let path = if path.is_empty() {
        None
    } else {
        Some(path.to_owned())
    };
    inputs.insert(tag, path);
    Ok(())
}

fn parse_content_record(
    line: &str,
    record_count: &mut usize,
    raw_records: &mut Vec<RawRecord>,
    active_page: &mut Option<u32>,
    boxes: &mut Vec<BoxKind>,
) -> Result<(), SynctexError> {
    if *record_count >= MAX_RECORDS {
        return Err(SynctexError::LimitExceeded);
    }
    *record_count += 1;

    let first = line
        .as_bytes()
        .first()
        .copied()
        .ok_or(SynctexError::InvalidStructure)?;
    match first {
        b'!' => parse_index_offset(line),
        b'{' => {
            if line.starts_with('{') {
                if active_page.is_some() || !boxes.is_empty() {
                    return Err(SynctexError::InvalidStructure);
                }
                let page =
                    parse_positive_u32(line.get(1..).ok_or(SynctexError::InvalidStructure)?)?;
                *active_page = Some(page);
                Ok(())
            } else {
                Err(SynctexError::InvalidStructure)
            }
        }
        b'}' => {
            let page = parse_positive_u32(line.get(1..).ok_or(SynctexError::InvalidStructure)?)?;
            if !boxes.is_empty() || *active_page != Some(page) {
                return Err(SynctexError::InvalidStructure);
            }
            *active_page = None;
            Ok(())
        }
        b'[' | b'(' => {
            let page = (*active_page).ok_or(SynctexError::InvalidStructure)?;
            if boxes.len() >= MAX_NESTING {
                return Err(SynctexError::LimitExceeded);
            }
            let box_kind = if first == b'[' {
                BoxKind::Horizontal
            } else {
                BoxKind::Vertical
            };
            let nesting = u8::try_from(boxes.len() + 1).map_err(|_| SynctexError::LimitExceeded)?;
            let raw = parse_node_payload(
                line.get(1..).ok_or(SynctexError::InvalidStructure)?,
                page,
                RecordKind::Box,
                PayloadShape::Dimensions,
                nesting,
            )?;
            append_raw(raw_records, raw)?;
            boxes.push(box_kind);
            Ok(())
        }
        b']' | b')' => {
            if line.len() != 1 {
                return Err(SynctexError::InvalidStructure);
            }
            let expected = if first == b']' {
                BoxKind::Horizontal
            } else {
                BoxKind::Vertical
            };
            match boxes.pop() {
                Some(actual) if actual == expected => Ok(()),
                _ => Err(SynctexError::InvalidStructure),
            }
        }
        b'h' | b'v' | b'r' | b'f' | b'k' | b'g' | b'$' | b'x' => {
            let page = (*active_page).ok_or(SynctexError::InvalidStructure)?;
            let nesting = u8::try_from(boxes.len()).map_err(|_| SynctexError::LimitExceeded)?;
            let (kind, shape) = match first {
                b'h' | b'v' => (RecordKind::Glyph, PayloadShape::Dimensions),
                b'r' => (RecordKind::Rule, PayloadShape::Dimensions),
                b'f' => (RecordKind::Form, PayloadShape::Dimensions),
                b'k' => (RecordKind::Kern, PayloadShape::Kern),
                b'g' => (RecordKind::Glue, PayloadShape::Point),
                b'$' => (RecordKind::Math, PayloadShape::Point),
                b'x' => (RecordKind::Boundary, PayloadShape::Point),
                _ => return Err(SynctexError::UnsupportedRecord),
            };
            let raw = parse_node_payload(
                line.get(1..).ok_or(SynctexError::InvalidStructure)?,
                page,
                kind,
                shape,
                nesting,
            )?;
            append_raw(raw_records, raw)
        }
        _ => Err(SynctexError::UnsupportedRecord),
    }
}

fn append_raw(raw_records: &mut Vec<RawRecord>, mut record: RawRecord) -> Result<(), SynctexError> {
    if raw_records.len() >= MAX_RECORDS {
        return Err(SynctexError::LimitExceeded);
    }
    record.order = raw_records.len();
    raw_records.push(record);
    Ok(())
}

fn parse_node_payload(
    payload: &str,
    page: u32,
    kind: RecordKind,
    shape: PayloadShape,
    nesting: u8,
) -> Result<RawRecord, SynctexError> {
    let mut parts = payload.split(':');
    let identity_text = parts.next().ok_or(SynctexError::InvalidStructure)?;
    let position_text = parts.next().ok_or(SynctexError::InvalidStructure)?;
    let (identity, identity_len) = parse_integer_fields::<3>(identity_text)?;
    if identity_len != 2 && identity_len != 3 {
        return Err(SynctexError::InvalidStructure);
    }
    let tag = u32::try_from(identity[0]).map_err(|_| SynctexError::InvalidNumber)?;
    if tag == 0 {
        return Err(SynctexError::InvalidNumber);
    }
    let line = u32::try_from(identity[1]).map_err(|_| SynctexError::InvalidNumber)?;
    let column = if identity_len == 3 {
        let column = u32::try_from(identity[2]).map_err(|_| SynctexError::InvalidNumber)?;
        if column == 0 {
            return Err(SynctexError::InvalidNumber);
        }
        Some(column)
    } else {
        None
    };

    let (position, position_len) = parse_integer_fields::<3>(position_text)?;
    if position_len != 2 {
        return Err(SynctexError::InvalidStructure);
    }

    let (width, height, depth) = match shape {
        PayloadShape::Dimensions => {
            let dimensions_text = parts.next().ok_or(SynctexError::InvalidStructure)?;
            let (dimensions, dimensions_len) = parse_integer_fields::<3>(dimensions_text)?;
            if dimensions_len != 3 {
                return Err(SynctexError::InvalidStructure);
            }
            // XeTeX emits signed rule widths for xeCJK punctuation adjustments.
            // Preserve that direction; scaling and endpoint bounds still apply.
            if dimensions[1..].iter().any(|dimension| *dimension < 0)
                || dimensions[0] < 0 && kind != RecordKind::Rule
            {
                return Err(SynctexError::InvalidCoordinate);
            }
            (dimensions[0], dimensions[1], dimensions[2])
        }
        PayloadShape::Kern => {
            let width_text = parts.next().ok_or(SynctexError::InvalidStructure)?;
            let (width, width_len) = parse_integer_fields::<1>(width_text)?;
            if width_len != 1 {
                return Err(SynctexError::InvalidStructure);
            }
            (width[0], 0, 0)
        }
        PayloadShape::Point => (0, 0, 0),
    };
    if parts.next().is_some() {
        return Err(SynctexError::InvalidStructure);
    }

    Ok(RawRecord {
        page,
        tag,
        line,
        column,
        h: position[0],
        v: position[1],
        width,
        height,
        depth,
        kind,
        nesting,
        order: 0,
    })
}

fn parse_integer_fields<const N: usize>(value: &str) -> Result<([i64; N], usize), SynctexError> {
    let mut fields = [0i64; N];
    let mut count = 0usize;
    for field in value.split(',') {
        if count >= N {
            return Err(SynctexError::InvalidStructure);
        }
        fields[count] = parse_i64(field)?;
        count += 1;
    }
    Ok((fields, count))
}

fn parse_i64(value: &str) -> Result<i64, SynctexError> {
    let bytes = value.as_bytes();
    let start = if bytes.first() == Some(&b'-') || bytes.first() == Some(&b'+') {
        1
    } else {
        0
    };
    if start == bytes.len() || bytes[start..].iter().any(|byte| !byte.is_ascii_digit()) {
        return Err(SynctexError::InvalidNumber);
    }
    value
        .parse::<i64>()
        .map_err(|_| SynctexError::InvalidNumber)
}

fn parse_u32(value: &str) -> Result<u32, SynctexError> {
    let bytes = value.as_bytes();
    if bytes.is_empty() || bytes.iter().any(|byte| !byte.is_ascii_digit()) {
        return Err(SynctexError::InvalidNumber);
    }
    value
        .parse::<u32>()
        .map_err(|_| SynctexError::InvalidNumber)
}

fn parse_positive_u32(value: &str) -> Result<u32, SynctexError> {
    let number = parse_u32(value)?;
    if number == 0 {
        return Err(SynctexError::InvalidNumber);
    }
    Ok(number)
}

fn parse_u64(value: &str) -> Result<u64, SynctexError> {
    let bytes = value.as_bytes();
    if bytes.is_empty() || bytes.iter().any(|byte| !byte.is_ascii_digit()) {
        return Err(SynctexError::InvalidNumber);
    }
    value
        .parse::<u64>()
        .map_err(|_| SynctexError::InvalidNumber)
}

fn parse_finite_number(value: &str) -> Result<f64, SynctexError> {
    if value.is_empty()
        || value
            .bytes()
            .any(|byte| !byte.is_ascii_digit() && !matches!(byte, b'+' | b'-' | b'.' | b'e' | b'E'))
    {
        return Err(SynctexError::InvalidNumber);
    }
    let number = value
        .parse::<f64>()
        .map_err(|_| SynctexError::InvalidNumber)?;
    if !number.is_finite() {
        return Err(SynctexError::InvalidNumber);
    }
    Ok(number)
}

fn parse_index_offset(line: &str) -> Result<(), SynctexError> {
    let offset = line
        .strip_prefix('!')
        .ok_or(SynctexError::InvalidStructure)?;
    parse_u64(offset).map(|_| ())
}

fn transform_record(raw: RawRecord, transform: Transform) -> Result<Record, SynctexError> {
    let horizontal = raw
        .h
        .checked_add(transform.x_offset)
        .ok_or(SynctexError::InvalidCoordinate)?;
    let baseline = raw
        .v
        .checked_add(transform.y_offset)
        .ok_or(SynctexError::InvalidCoordinate)?;
    let top = baseline
        .checked_sub(raw.height)
        .ok_or(SynctexError::InvalidCoordinate)?;

    let x = scale_coordinate(horizontal, transform.scale)?;
    let y = scale_coordinate(top, transform.scale)?;
    let width = scale_coordinate(raw.width, transform.scale)?;
    let height = scale_coordinate(raw.height, transform.scale)?;
    let depth = scale_coordinate(raw.depth, transform.scale)?;
    validate_coordinate(x + width)?;
    validate_coordinate(y + height + depth)?;

    Ok(Record {
        page: raw.page,
        tag: raw.tag,
        line: raw.line,
        column: raw.column,
        x,
        y,
        width,
        height,
        depth,
        kind: raw.kind,
        nesting: raw.nesting,
        order: raw.order,
    })
}

fn scale_coordinate(value: i64, scale: f64) -> Result<f64, SynctexError> {
    let coordinate = value as f64 * scale;
    validate_coordinate(coordinate)?;
    Ok(coordinate)
}

fn validate_coordinate(value: f64) -> Result<(), SynctexError> {
    if !value.is_finite() || value.abs() > MAX_COORDINATE_POINTS {
        return Err(SynctexError::InvalidCoordinate);
    }
    Ok(())
}

fn canonical_path(path: &str) -> Option<String> {
    if path.is_empty() || path.len() > MAX_PATH_BYTES || path.chars().any(char::is_control) {
        return None;
    }
    let bytes = path.as_bytes();
    let has_windows_drive = bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':';
    let mut key = String::with_capacity(path.len());
    for (index, character) in path.char_indices() {
        let normalized = if character == '\\' {
            '/'
        } else if index == 0 && has_windows_drive {
            character.to_ascii_lowercase()
        } else {
            character
        };
        key.push(normalized);
    }
    Some(key)
}

fn closest_line(lines: &BTreeMap<u32, Vec<usize>>, target: u32) -> Option<u32> {
    let lower = lines.range(..=target).next_back().map(|(line, _)| *line);
    let upper = lines.range(target..).next().map(|(line, _)| *line);
    match (lower, upper) {
        (None, None) => None,
        (Some(line), None) | (None, Some(line)) => Some(line),
        (Some(lower), Some(upper)) => {
            if target - lower <= upper - target {
                Some(lower)
            } else {
                Some(upper)
            }
        }
    }
}

fn kind_rank(kind: RecordKind) -> u8 {
    match kind {
        RecordKind::Glyph | RecordKind::Rule => 0,
        RecordKind::Box | RecordKind::Form => 1,
        RecordKind::Kern => 2,
        RecordKind::Glue => 3,
        RecordKind::Math => 4,
        RecordKind::Boundary => 5,
    }
}

fn record_area(record: &Record) -> f64 {
    record.width.abs() * (record.height + record.depth)
}

fn compare_forward(left: &Record, right: &Record, page_hint: Option<u32>) -> Ordering {
    let left_page_distance = page_hint.map_or(0, |page| left.page.abs_diff(page));
    let right_page_distance = page_hint.map_or(0, |page| right.page.abs_diff(page));
    let left_area = record_area(left);
    let right_area = record_area(right);
    left_page_distance
        .cmp(&right_page_distance)
        .then_with(|| left.page.cmp(&right.page))
        .then_with(|| kind_rank(left.kind).cmp(&kind_rank(right.kind)))
        .then_with(|| (left_area == 0.0).cmp(&(right_area == 0.0)))
        .then_with(|| left_area.total_cmp(&right_area))
        .then_with(|| right.nesting.cmp(&left.nesting))
        .then_with(|| left.y.total_cmp(&right.y))
        .then_with(|| left.x.total_cmp(&right.x))
        .then_with(|| left.tag.cmp(&right.tag))
        .then_with(|| left.order.cmp(&right.order))
}

fn distance_to_record(record: &Record, x: f64, y: f64) -> Option<f64> {
    let far_x = record.x + record.width;
    let far_y = record.y + record.height + record.depth;
    if !far_x.is_finite() || !far_y.is_finite() {
        return None;
    }
    let left = record.x.min(far_x);
    let right = record.x.max(far_x);
    let top = record.y.min(far_y);
    let bottom = record.y.max(far_y);
    let dx = if x < left {
        left - x
    } else if x > right {
        x - right
    } else {
        0.0
    };
    let dy = if y < top {
        top - y
    } else if y > bottom {
        y - bottom
    } else {
        0.0
    };
    let distance = dx.hypot(dy);
    if distance.is_finite() {
        Some(distance)
    } else {
        None
    }
}

fn compare_inverse(
    left: &Record,
    left_distance: f64,
    right: &Record,
    right_distance: f64,
) -> Ordering {
    let left_area = record_area(left);
    let right_area = record_area(right);
    left_distance
        .total_cmp(&right_distance)
        .then_with(|| kind_rank(left.kind).cmp(&kind_rank(right.kind)))
        .then_with(|| (left_area == 0.0).cmp(&(right_area == 0.0)))
        .then_with(|| left_area.total_cmp(&right_area))
        .then_with(|| right.nesting.cmp(&left.nesting))
        .then_with(|| left.line.cmp(&right.line))
        .then_with(|| left.column.cmp(&right.column))
        .then_with(|| left.tag.cmp(&right.tag))
        .then_with(|| left.order.cmp(&right.order))
}
