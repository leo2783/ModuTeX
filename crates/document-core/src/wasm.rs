// SPDX-License-Identifier: Apache-2.0
//! Synchronous wasm-bindgen facade over the native document-core state.
//!
//! JSON methods serialize the core serde types. Numeric inputs and outputs stay
//! within JavaScript's safe-integer range. Exported objects own their snapshots;
//! wasm-bindgen provides `free()` for explicitly releasing each handle.

use crate::changes::{map_position, remap_span, Bias, SourceChange, SourcePatch, SourceSpan};
use crate::editor_projection::{EditorPatch, EditorProjection};
use crate::parser::{
    parse_source, projection_is_current as core_projection_is_current, ParseLimits,
    SourceProjection, SyntaxKind, SyntaxNode,
};
use crate::pdf_wrap::pdf_wrapped_text;
use crate::source::{SourceDocument, SourceError, SourceTransaction, SourceUpdate};
use crate::synctex::{SynctexError, SynctexIndex};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Number;
use std::collections::HashMap;
use std::convert::TryFrom;
use wasm_bindgen::prelude::*;

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[wasm_bindgen(inline_js = r#"
export function newDocumentId() {
  return globalThis.crypto.randomUUID();
}

export function makeDocumentCoreError(name, code, message) {
  const error = new Error(message);
  error.name = name;
  error.code = code;
  return error;
}
"#)]
extern "C" {
    #[wasm_bindgen(catch, js_name = newDocumentId)]
    fn new_document_id() -> Result<String, JsValue>;

    #[wasm_bindgen(js_name = makeDocumentCoreError)]
    fn make_document_core_error(name: &str, code: &str, message: &str) -> JsValue;
}

fn source_error(error: SourceError) -> JsValue {
    let code = match error {
        SourceError::Encoding => "ENCODING",
        SourceError::Range => "RANGE",
        SourceError::Version => "VERSION",
        SourceError::Patch => "PATCH",
        SourceError::Content => "CONTENT",
        SourceError::Origin => "ORIGIN",
    };
    make_document_core_error("SourceError", code, &error.to_string())
}

fn bridge_error(code: &str, message: &str) -> JsValue {
    make_document_core_error("DocumentCoreError", code, message)
}

fn js_u64(value: f64, error: SourceError) -> Result<u64, JsValue> {
    if !value.is_finite() || value < 0.0 || value.fract() != 0.0 || value > MAX_SAFE_INTEGER as f64
    {
        return Err(source_error(error));
    }
    Ok(value as u64)
}

fn js_usize(value: f64) -> Result<usize, JsValue> {
    let value = js_u64(value, SourceError::Range)?;
    usize::try_from(value).map_err(|_| source_error(SourceError::Range))
}

fn js_version(value: f64) -> Result<u64, JsValue> {
    js_u64(value, SourceError::Version)
}

fn json_u64(value: &Number, error: SourceError) -> Result<u64, JsValue> {
    value
        .as_u64()
        .filter(|number| *number <= MAX_SAFE_INTEGER)
        .ok_or_else(|| source_error(error))
}

fn json_usize(value: &Number) -> Result<usize, JsValue> {
    let value = json_u64(value, SourceError::Range)?;
    usize::try_from(value).map_err(|_| source_error(SourceError::Range))
}

fn usize_is_safe(value: usize) -> bool {
    (value as u128) <= (MAX_SAFE_INTEGER as u128)
}

fn ensure_safe_document(document: &SourceDocument) -> Result<(), JsValue> {
    if document.version() > MAX_SAFE_INTEGER {
        return Err(source_error(SourceError::Version));
    }
    if !usize_is_safe(document.len())
        || !usize_is_safe(document.byte_len())
        || !usize_is_safe(document.piece_count())
    {
        return Err(source_error(SourceError::Range));
    }
    Ok(())
}

fn ensure_safe_change(change: &SourceChange) -> Result<(), JsValue> {
    if change.before_version > MAX_SAFE_INTEGER || change.after_version > MAX_SAFE_INTEGER {
        return Err(source_error(SourceError::Version));
    }
    if !usize_is_safe(change.old_length) || !usize_is_safe(change.new_length) {
        return Err(source_error(SourceError::Range));
    }
    for patch in &change.patches {
        if !usize_is_safe(patch.from)
            || !usize_is_safe(patch.to)
            || !usize_is_safe(patch.insert.encode_utf16().count())
        {
            return Err(source_error(SourceError::Range));
        }
    }
    Ok(())
}

fn validate_document_id(document_id: &str) -> Result<(), JsValue> {
    if document_id.is_empty() || document_id.encode_utf16().count() > 128 {
        return Err(bridge_error("IDENTITY", "Invalid source identity"));
    }
    Ok(())
}

fn encode_json<T: Serialize + ?Sized>(value: &T) -> Result<String, JsValue> {
    serde_json::to_string(value)
        .map_err(|_| bridge_error("SERIALIZATION", "Unable to serialize document-core value"))
}

fn hex_code_unit(bytes: &[u8], start: usize) -> Option<u16> {
    let end = start.checked_add(4)?;
    let digits = bytes.get(start..end)?;
    let mut value = 0u16;
    for digit in digits {
        let nibble = match digit {
            b'0'..=b'9' => digit - b'0',
            b'a'..=b'f' => digit - b'a' + 10,
            b'A'..=b'F' => digit - b'A' + 10,
            _ => return None,
        };
        value = (value << 4) | u16::from(nibble);
    }
    Some(value)
}

fn has_unpaired_surrogate_escape(input: &str) -> bool {
    let bytes = input.as_bytes();
    let mut index = 0usize;
    let mut in_string = false;

    while index < bytes.len() {
        if !in_string {
            if bytes[index] == b'"' {
                in_string = true;
            }
            index += 1;
            continue;
        }

        match bytes[index] {
            b'"' => {
                in_string = false;
                index += 1;
            }
            b'\\' if bytes.get(index + 1) == Some(&b'u') => {
                let Some(unit) = hex_code_unit(bytes, index.saturating_add(2)) else {
                    index = index.saturating_add(2);
                    continue;
                };
                if (0xd800..=0xdbff).contains(&unit) {
                    let next = index.saturating_add(6);
                    let low = if bytes.get(next) == Some(&b'\\')
                        && bytes.get(next.saturating_add(1)) == Some(&b'u')
                    {
                        hex_code_unit(bytes, next.saturating_add(2))
                    } else {
                        None
                    };
                    if !low.is_some_and(|value| (0xdc00..=0xdfff).contains(&value)) {
                        return true;
                    }
                    index = next.saturating_add(6);
                } else if (0xdc00..=0xdfff).contains(&unit) {
                    return true;
                } else {
                    index = index.saturating_add(6);
                }
            }
            b'\\' => index = index.saturating_add(2),
            _ => index += 1,
        }
    }
    false
}

fn decode_json<T: DeserializeOwned>(input: &str, fallback: SourceError) -> Result<T, JsValue> {
    serde_json::from_str(input).map_err(|_| {
        if has_unpaired_surrogate_escape(input) {
            source_error(SourceError::Encoding)
        } else {
            source_error(fallback)
        }
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TransactionInput {
    expected_version: Number,
    patches: Vec<SourcePatchInput>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SourcePatchInput {
    from: Number,
    to: Number,
    insert: String,
    #[serde(default)]
    expected: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SourceChangeInput {
    document_id: String,
    before_version: Number,
    after_version: Number,
    old_length: Number,
    new_length: Number,
    patches: Vec<SourcePatchInput>,
}

fn decode_transaction(input: &str) -> Result<SourceTransaction, JsValue> {
    let input: TransactionInput = decode_json(input, SourceError::Patch)?;
    let expected_version = json_u64(&input.expected_version, SourceError::Version)?;
    let mut patches = Vec::with_capacity(input.patches.len());
    for patch in input.patches {
        patches.push(SourcePatch {
            from: json_usize(&patch.from)?,
            to: json_usize(&patch.to)?,
            insert: patch.insert,
            expected: patch.expected,
        });
    }
    Ok(SourceTransaction {
        expected_version,
        patches,
    })
}

fn decode_change(input: &str) -> Result<SourceChange, JsValue> {
    let input: SourceChangeInput = decode_json(input, SourceError::Patch)?;
    let mut patches = Vec::with_capacity(input.patches.len());
    for patch in input.patches {
        patches.push(SourcePatch {
            from: json_usize(&patch.from)?,
            to: json_usize(&patch.to)?,
            insert: patch.insert,
            expected: patch.expected,
        });
    }
    Ok(SourceChange {
        document_id: input.document_id,
        before_version: json_u64(&input.before_version, SourceError::Version)?,
        after_version: json_u64(&input.after_version, SourceError::Version)?,
        old_length: json_usize(&input.old_length)?,
        new_length: json_usize(&input.new_length)?,
        patches,
    })
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EditorPatchInput {
    from: Number,
    to: Number,
    insert: String,
}

fn decode_editor_patches(input: &str) -> Result<Vec<EditorPatch>, JsValue> {
    let input: Vec<EditorPatchInput> = decode_json(input, SourceError::Patch)?;
    input
        .into_iter()
        .map(|patch| {
            Ok(EditorPatch {
                from: json_usize(&patch.from)?,
                to: json_usize(&patch.to)?,
                insert: patch.insert,
            })
        })
        .collect()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SourceSpanInput {
    document_id: String,
    from: Number,
    to: Number,
    version: Number,
}

fn decode_span(input: &str) -> Result<SourceSpan, JsValue> {
    let input: SourceSpanInput = decode_json(input, SourceError::Patch)?;
    Ok(SourceSpan {
        document_id: input.document_id,
        from: json_usize(&input.from)?,
        to: json_usize(&input.to)?,
        version: json_u64(&input.version, SourceError::Version)?,
    })
}

/// An immutable source snapshot. Pass a `Uint8Array` view to `open`; bytes are
/// owned by Rust after the call. `openAt` binds parser-worker identity/version.
#[wasm_bindgen(js_name = SourceDocument)]
pub struct WasmSourceDocument {
    inner: SourceDocument,
}

#[wasm_bindgen(js_class = SourceDocument)]
impl WasmSourceDocument {
    /// Open a new version-zero snapshot with a secure UUID identity.
    #[wasm_bindgen(js_name = open)]
    pub fn open(bytes: &[u8]) -> Result<WasmSourceDocument, JsValue> {
        let document_id = new_document_id()
            .map_err(|_| bridge_error("IDENTITY", "Secure UUID generation is unavailable"))?;
        validate_document_id(&document_id)?;
        let inner = SourceDocument::open(bytes, document_id).map_err(source_error)?;
        ensure_safe_document(&inner)?;
        Ok(WasmSourceDocument { inner })
    }

    /// Open a parser-worker snapshot with its actual supplied identity/version.
    #[wasm_bindgen(js_name = openAt)]
    pub fn open_at(
        bytes: &[u8],
        document_id: String,
        version: f64,
    ) -> Result<WasmSourceDocument, JsValue> {
        validate_document_id(&document_id)?;
        let version = js_version(version)?;
        let inner =
            SourceDocument::open_with_version(bytes, document_id, version).map_err(source_error)?;
        ensure_safe_document(&inner)?;
        Ok(WasmSourceDocument { inner })
    }

    /// Return an explicit immutable snapshot clone sharing the core's owned pieces.
    #[wasm_bindgen(js_name = cloneSnapshot)]
    pub fn clone_snapshot(&self) -> Result<WasmSourceDocument, JsValue> {
        ensure_safe_document(&self.inner)?;
        Ok(WasmSourceDocument {
            inner: self.inner.clone(),
        })
    }

    #[wasm_bindgen(getter, js_name = documentId)]
    pub fn document_id(&self) -> String {
        self.inner.document_id().to_owned()
    }

    #[wasm_bindgen(getter)]
    pub fn version(&self) -> f64 {
        self.inner.version() as f64
    }

    #[wasm_bindgen(getter)]
    pub fn length(&self) -> f64 {
        self.inner.len() as f64
    }

    #[wasm_bindgen(getter, js_name = byteLength)]
    pub fn byte_length(&self) -> f64 {
        self.inner.byte_len() as f64
    }

    #[wasm_bindgen(getter, js_name = pieceCount)]
    pub fn piece_count(&self) -> f64 {
        self.inner.piece_count() as f64
    }

    #[wasm_bindgen(getter, js_name = isEmpty)]
    pub fn is_empty(&self) -> bool {
        self.inner.is_empty()
    }

    /// Return the core `SourceProfile` as camelCase JSON.
    #[wasm_bindgen(js_name = profileJson)]
    pub fn profile_json(&self) -> Result<String, JsValue> {
        encode_json(self.inner.profile())
    }

    /// Read a UTF-16 range, rejecting positions inside a Unicode scalar.
    pub fn read(&self, from: f64, to: f64) -> Result<String, JsValue> {
        self.inner
            .read(js_usize(from)?, js_usize(to)?)
            .map_err(source_error)
    }

    /// Return an owned byte copy as a JavaScript `Uint8Array`.
    #[wasm_bindgen(js_name = toBytes)]
    pub fn to_bytes(&self) -> Result<Vec<u8>, JsValue> {
        ensure_safe_document(&self.inner)?;
        Ok(self.inner.to_bytes())
    }

    /// Apply a JSON-encoded core transaction and return owned update handles.
    pub fn apply(&self, transaction_json: &str) -> Result<WasmSourceUpdate, JsValue> {
        let transaction = decode_transaction(transaction_json)?;
        let update = self.inner.apply(&transaction).map_err(source_error)?;
        ensure_safe_document(&update.document)?;
        ensure_safe_change(&update.change)?;
        Ok(WasmSourceUpdate { inner: update })
    }

    /// Restore a snapshot from this source while advancing its version.
    pub fn restore(
        &self,
        snapshot: &WasmSourceDocument,
        expected_version: f64,
    ) -> Result<WasmSourceDocument, JsValue> {
        let document = self
            .inner
            .restore(&snapshot.inner, js_version(expected_version)?)
            .map_err(source_error)?;
        ensure_safe_document(&document)?;
        Ok(WasmSourceDocument { inner: document })
    }
}

/// An owned result of `SourceDocument.apply`.
#[wasm_bindgen(js_name = SourceUpdate)]
pub struct WasmSourceUpdate {
    inner: SourceUpdate,
}

#[wasm_bindgen(js_class = SourceUpdate)]
impl WasmSourceUpdate {
    /// Return an owned immutable document snapshot.
    #[wasm_bindgen(getter)]
    pub fn document(&self) -> WasmSourceDocument {
        WasmSourceDocument {
            inner: self.inner.document.clone(),
        }
    }

    /// Return an owned change handle.
    #[wasm_bindgen(getter)]
    pub fn change(&self) -> WasmSourceChange {
        WasmSourceChange {
            inner: self.inner.change.clone(),
        }
    }
}

/// An owned source change used by position and span mapping.
#[wasm_bindgen(js_name = SourceChange)]
pub struct WasmSourceChange {
    inner: SourceChange,
}

#[wasm_bindgen(js_class = SourceChange)]
impl WasmSourceChange {
    /// Serialize the actual core `SourceChange` with camelCase field names.
    #[wasm_bindgen(js_name = toJson)]
    pub fn to_json(&self) -> Result<String, JsValue> {
        ensure_safe_change(&self.inner)?;
        encode_json(&self.inner)
    }
}

/// Map a UTF-16 position through an owned source change.
#[wasm_bindgen(js_name = mapPosition)]
pub fn wasm_map_position(
    change: &WasmSourceChange,
    position: f64,
    bias: &str,
) -> Result<f64, JsValue> {
    map_position_checked(&change.inner, position, bias)
}

#[wasm_bindgen(js_name = mapPositionJson)]
pub fn wasm_map_position_json(
    change_json: &str,
    position: f64,
    bias: &str,
) -> Result<f64, JsValue> {
    let change = decode_change(change_json)?;
    ensure_safe_change(&change)?;
    map_position_checked(&change, position, bias)
}

fn map_position_checked(change: &SourceChange, position: f64, bias: &str) -> Result<f64, JsValue> {
    let bias = match bias {
        "before" => Bias::Before,
        "after" => Bias::After,
        _ => return Err(source_error(SourceError::Patch)),
    };
    let mapped = map_position(change, js_usize(position)?, bias).map_err(source_error)?;
    if !usize_is_safe(mapped) {
        return Err(source_error(SourceError::Range));
    }
    Ok(mapped as f64)
}

/// Remap a JSON-encoded source span; the result is a span JSON string or `null`.
#[wasm_bindgen(js_name = remapSpan)]
pub fn wasm_remap_span(change: &WasmSourceChange, span_json: &str) -> Result<String, JsValue> {
    let span = decode_span(span_json)?;
    let remapped = remap_span(&change.inner, &span).map_err(source_error)?;
    encode_json(&remapped)
}

#[wasm_bindgen(js_name = remapSpanJson)]
pub fn wasm_remap_span_json(change_json: &str, span_json: &str) -> Result<String, JsValue> {
    let change = decode_change(change_json)?;
    ensure_safe_change(&change)?;
    let span = decode_span(span_json)?;
    let remapped = remap_span(&change, &span).map_err(source_error)?;
    encode_json(&remapped)
}

/// An owned parser projection produced from the same source snapshot.
#[wasm_bindgen(js_name = SourceProjection)]
pub struct WasmSourceProjection {
    inner: SourceProjection,
}

const COMPACT_NODE_WORDS: usize = 8;
const COMPACT_ROOT_PARENT: u32 = u32::MAX;

fn compact_u32(value: usize) -> Result<u32, JsValue> {
    u32::try_from(value).map_err(|_| source_error(SourceError::Range))
}

fn compact_syntax_kind(kind: SyntaxKind) -> u32 {
    match kind {
        SyntaxKind::Text => 0,
        SyntaxKind::Comment => 1,
        SyntaxKind::Heading => 2,
        SyntaxKind::Format => 3,
        SyntaxKind::Math => 4,
        SyntaxKind::Environment => 5,
        SyntaxKind::Raw => 6,
    }
}

fn compact_name_index(
    name: &str,
    names: &mut Vec<String>,
    name_indices: &mut HashMap<String, u32>,
) -> Result<u32, JsValue> {
    if let Some(index) = name_indices.get(name) {
        return Ok(*index);
    }
    let index = compact_u32(names.len())?;
    names.push(name.to_owned());
    name_indices.insert(name.to_owned(), index);
    Ok(index)
}

fn append_compact_nodes(
    nodes: &[SyntaxNode],
    parent_index: Option<u32>,
    records: &mut Vec<u32>,
    names: &mut Vec<String>,
    name_indices: &mut HashMap<String, u32>,
) -> Result<(), JsValue> {
    for node in nodes {
        let node_index = compact_u32(records.len() / COMPACT_NODE_WORDS)?;
        if node_index == COMPACT_ROOT_PARENT {
            return Err(source_error(SourceError::Range));
        }
        let from = compact_u32(node.span.from)?;
        let to = compact_u32(node.span.to)?;
        let (has_content, content_from, content_to) = match &node.content {
            Some(content) => (1, compact_u32(content.from)?, compact_u32(content.to)?),
            None => (0, 0, 0),
        };
        let name_index = compact_name_index(&node.name, names, name_indices)?;

        records.extend_from_slice(&[
            compact_syntax_kind(node.kind),
            from,
            to,
            has_content,
            content_from,
            content_to,
            parent_index.unwrap_or(COMPACT_ROOT_PARENT),
            name_index,
        ]);
        append_compact_nodes(
            &node.children,
            Some(node_index),
            records,
            names,
            name_indices,
        )?;
    }
    Ok(())
}

fn collect_compact_names(
    nodes: &[SyntaxNode],
    names: &mut Vec<String>,
    name_indices: &mut HashMap<String, u32>,
) -> Result<(), JsValue> {
    for node in nodes {
        compact_name_index(&node.name, names, name_indices)?;
        collect_compact_names(&node.children, names, name_indices)?;
    }
    Ok(())
}

#[wasm_bindgen(js_class = SourceProjection)]
impl WasmSourceProjection {
    /// Serialize the actual parser projection in the existing camelCase shape.
    #[wasm_bindgen(js_name = toJson)]
    pub fn to_json(&self) -> Result<String, JsValue> {
        encode_json(&self.inner)
    }

    /// Return preorder node records as eight u32 words per node.
    ///
    /// The fields are kind, UTF-16 start/end, content flag/start/end,
    /// parent index, and deduplicated name index. Roots use u32::MAX as parent.
    #[wasm_bindgen(js_name = compactNodes)]
    pub fn compact_nodes(&self) -> Result<Vec<u32>, JsValue> {
        let mut records = Vec::new();
        let mut names = Vec::new();
        let mut name_indices = HashMap::new();
        append_compact_nodes(
            &self.inner.nodes,
            None,
            &mut records,
            &mut names,
            &mut name_indices,
        )?;
        Ok(records)
    }

    /// Serialize the deduplicated names in the same preorder used by compactNodes.
    #[wasm_bindgen(js_name = compactNamesJson)]
    pub fn compact_names_json(&self) -> Result<String, JsValue> {
        let mut names = Vec::new();
        let mut name_indices = HashMap::new();
        collect_compact_names(&self.inner.nodes, &mut names, &mut name_indices)?;
        encode_json(&names)
    }

    /// Serialize parser issues separately from the compact node records.
    #[wasm_bindgen(js_name = issuesJson)]
    pub fn issues_json(&self) -> Result<String, JsValue> {
        encode_json(&self.inner.issues)
    }

    #[wasm_bindgen(getter, js_name = documentId)]
    pub fn document_id(&self) -> String {
        self.inner.document_id.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn version(&self) -> f64 {
        self.inner.version as f64
    }
}

fn parse_projection(
    document: &WasmSourceDocument,
    limits: ParseLimits,
) -> Result<WasmSourceProjection, JsValue> {
    ensure_safe_document(&document.inner)?;
    let inner = parse_source(&document.inner, limits).map_err(source_error)?;
    Ok(WasmSourceProjection { inner })
}

/// Parse with the core's default limits and retain its source identity/version.
#[wasm_bindgen(js_name = parseSource)]
pub fn wasm_parse_source(document: &WasmSourceDocument) -> Result<WasmSourceProjection, JsValue> {
    parse_projection(document, ParseLimits::default())
}

/// Parse with explicit safe-integer node and step limits.
#[wasm_bindgen(js_name = parseSourceWithLimits)]
pub fn wasm_parse_source_with_limits(
    document: &WasmSourceDocument,
    max_nodes: f64,
    max_steps: f64,
) -> Result<WasmSourceProjection, JsValue> {
    parse_projection(
        document,
        ParseLimits {
            max_nodes: js_usize(max_nodes)?,
            max_steps: js_usize(max_steps)?,
        },
    )
}

/// Check projection identity using the core's document/version guard.
#[wasm_bindgen(js_name = projectionIsCurrent)]
pub fn wasm_projection_is_current(
    document: &WasmSourceDocument,
    projection: &WasmSourceProjection,
) -> bool {
    core_projection_is_current(&document.inner, &projection.inner)
}

/// An LF-normalized editor projection backed by the lossless Rust source.
#[wasm_bindgen(js_name = EditorProjection)]
pub struct WasmEditorProjection {
    inner: EditorProjection,
}

#[wasm_bindgen(js_class = EditorProjection)]
impl WasmEditorProjection {
    /// Open an editor projection from an owned source snapshot.
    #[wasm_bindgen(js_name = open)]
    pub fn open(document: &WasmSourceDocument) -> Result<WasmEditorProjection, JsValue> {
        ensure_safe_document(&document.inner)?;
        let (inner, _) = EditorProjection::open(document.inner.clone());
        Ok(WasmEditorProjection { inner })
    }

    /// Return the current LF-normalized editor text.
    pub fn text(&self) -> String {
        let (_, text) = EditorProjection::open(self.inner.document().clone());
        text
    }

    /// Return an owned source-document snapshot.
    #[wasm_bindgen(getter)]
    pub fn document(&self) -> WasmSourceDocument {
        WasmSourceDocument {
            inner: self.inner.document().clone(),
        }
    }

    #[wasm_bindgen(getter)]
    pub fn length(&self) -> f64 {
        self.inner.len() as f64
    }

    #[wasm_bindgen(getter, js_name = isEmpty)]
    pub fn is_empty(&self) -> bool {
        self.inner.is_empty()
    }

    /// Map an editor UTF-16 position to its source UTF-16 position.
    #[wasm_bindgen(js_name = toSource)]
    pub fn to_source(&self, position: f64) -> Result<f64, JsValue> {
        let position = self
            .inner
            .to_source(js_usize(position)?)
            .map_err(source_error)?;
        if !usize_is_safe(position) {
            return Err(source_error(SourceError::Range));
        }
        Ok(position as f64)
    }

    /// Serialize the core's actual editor correction patches.
    #[wasm_bindgen(js_name = editorCorrectionsJson)]
    pub fn editor_corrections_json(&self) -> Result<String, JsValue> {
        encode_json(self.inner.editor_corrections())
    }

    /// Apply JSON-encoded editor patches atomically at the expected version.
    pub fn apply(
        &self,
        patches_json: &str,
        expected_version: f64,
    ) -> Result<WasmEditorProjection, JsValue> {
        let patches = decode_editor_patches(patches_json)?;
        let inner = self
            .inner
            .apply(&patches, js_version(expected_version)?)
            .map_err(source_error)?;
        ensure_safe_document(inner.document())?;
        Ok(WasmEditorProjection { inner })
    }

    /// Restore an editor snapshot while advancing the source version.
    pub fn restore(
        &self,
        snapshot: &WasmEditorProjection,
    ) -> Result<WasmEditorProjection, JsValue> {
        let inner = self.inner.restore(&snapshot.inner).map_err(source_error)?;
        ensure_safe_document(inner.document())?;
        Ok(WasmEditorProjection { inner })
    }
}

/// Apply the core's typesetting-only wrapping to an owned byte copy.
#[wasm_bindgen(js_name = pdfWrappedText)]
pub fn wasm_pdf_wrapped_text(bytes: &[u8]) -> Result<Vec<u8>, JsValue> {
    pdf_wrapped_text(bytes).map_err(source_error)
}

fn synctex_error(error: SynctexError) -> JsValue {
    let code = match &error {
        SynctexError::InputTooLarge => "INPUT_TOO_LARGE",
        SynctexError::DecodedDataTooLarge => "DECODED_DATA_TOO_LARGE",
        SynctexError::InvalidGzip => "INVALID_GZIP",
        SynctexError::InvalidUtf8 => "INVALID_UTF8",
        SynctexError::InvalidHeader => "INVALID_HEADER",
        SynctexError::UnsupportedVersion(_) => "UNSUPPORTED_VERSION",
        SynctexError::UnsupportedOutput => "UNSUPPORTED_OUTPUT",
        SynctexError::InvalidNumber => "INVALID_NUMBER",
        SynctexError::InvalidStructure => "INVALID_STRUCTURE",
        SynctexError::UnsupportedRecord => "UNSUPPORTED_RECORD",
        SynctexError::LimitExceeded => "LIMIT_EXCEEDED",
        SynctexError::InvalidCoordinate => "INVALID_COORDINATE",
    };
    make_document_core_error("SynctexError", code, &error.to_string())
}

fn synctex_argument_error(code: &str, field: &str, expectation: &str) -> JsValue {
    let message = format!("Invalid SyncTeX {field}: expected {expectation}");
    make_document_core_error("SynctexError", code, &message)
}

fn js_synctex_positive_u32(value: f64, field: &str) -> Result<u32, JsValue> {
    let value = js_u64(value, SourceError::Range).map_err(|_| {
        synctex_argument_error(
            "INVALID_NUMBER",
            field,
            "a positive integer no greater than u32::MAX",
        )
    })?;
    if value == 0 {
        return Err(synctex_argument_error(
            "INVALID_NUMBER",
            field,
            "a positive integer no greater than u32::MAX",
        ));
    }
    u32::try_from(value).map_err(|_| {
        synctex_argument_error(
            "INVALID_NUMBER",
            field,
            "a positive integer no greater than u32::MAX",
        )
    })
}

// Keep this aligned with the core's MAX_COORDINATE_POINTS query limit.
const MAX_SYNCTEX_QUERY_COORDINATE: f64 = 1_000_000_000_000.0;

fn js_synctex_coordinate(value: f64, field: &str) -> Result<f64, JsValue> {
    if !value.is_finite() || value.abs() > MAX_SYNCTEX_QUERY_COORDINATE {
        return Err(synctex_argument_error(
            "INVALID_COORDINATE",
            field,
            "a finite PDF-point coordinate within +/- 1e12",
        ));
    }
    Ok(value)
}

/// An owned index over the bounded plain or gzip SyncTeX parser.
#[wasm_bindgen(js_name = SynctexIndex)]
pub struct WasmSynctexIndex {
    inner: SynctexIndex,
}

#[wasm_bindgen(js_class = SynctexIndex)]
impl WasmSynctexIndex {
    /// Parse SyncTeX bytes into an owned index.
    #[wasm_bindgen(js_name = parse)]
    pub fn parse(bytes: &[u8]) -> Result<WasmSynctexIndex, JsValue> {
        let inner = SynctexIndex::parse(bytes).map_err(synctex_error)?;
        Ok(WasmSynctexIndex { inner })
    }

    /// Return the core forward-search result as JSON, or JSON null if unmapped.
    #[wasm_bindgen(js_name = forwardSearch)]
    pub fn forward_search(
        &self,
        source: &str,
        line: f64,
        page_hint: Option<f64>,
    ) -> Result<String, JsValue> {
        let line = js_synctex_positive_u32(line, "line")?;
        let page_hint = page_hint
            .map(|value| js_synctex_positive_u32(value, "pageHint"))
            .transpose()?;
        encode_json(&self.inner.forward_search(source, line, page_hint))
    }

    /// Return the core inverse-search result as JSON, or JSON null if unmapped.
    #[wasm_bindgen(js_name = inverseSearch)]
    pub fn inverse_search(&self, page: f64, x: f64, y: f64) -> Result<String, JsValue> {
        let page = js_synctex_positive_u32(page, "page")?;
        let x = js_synctex_coordinate(x, "x")?;
        let y = js_synctex_coordinate(y, "y")?;
        encode_json(&self.inner.inverse_search(page, x, y))
    }
}
