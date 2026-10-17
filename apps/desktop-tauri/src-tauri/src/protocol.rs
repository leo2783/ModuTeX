// SPDX-License-Identifier: Apache-2.0
//! Wire DTOs for the DesktopPort contract. Every payload is strict: exact
//! field sets, validated identifiers, JS-safe integers and explicit nulls.
//! Limits mirror the frontend contract validators and the active renderer
//! adapter (`desktop.ts`).

use std::{collections::HashSet, error::Error, fmt};

use serde::{de::Error as _, Deserialize, Deserializer, Serialize};

use crate::relative_path::RelativePath;

pub const PROTOCOL_VERSION: u32 = 1;
/// Largest integer a JavaScript number represents exactly (2^53 - 1).
pub const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
/// Default text length in UTF-16 code units, as in the frontend validator.
pub const MAX_TEXT_UTF16: usize = 32_767;
/// Recent-document label and entry path length in UTF-16 code units.
pub const MAX_RECENT_TEXT_UTF16: usize = 4096;
/// Compile output limits used by the active renderer adapter.
pub const MAX_LOG_CHARACTERS: usize = 256 * 1024;
pub const MAX_DIAGNOSTICS: usize = 256;
pub const MAX_PDF_BYTES: usize = 32 * 1024 * 1024;
/// Read receipt limit for non-PDF files, as in the renderer adapter.
pub const MAX_READ_BYTES: usize = 5 * 1024 * 1024;
/// Managed image limits from the frontend contract.
pub const IMAGE_BYTES_LIMIT: usize = 5 * 1024 * 1024;
pub const MAX_IMAGES: usize = 4096;
pub const MAX_IMAGE_BATCH_BYTES: usize = 32 * 1024 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ProtocolError {
    field: &'static str,
    reason: &'static str,
}

impl ProtocolError {
    fn new(field: &'static str, reason: &'static str) -> Self {
        Self { field, reason }
    }

    pub fn field(&self) -> &'static str {
        self.field
    }
}

impl fmt::Display for ProtocolError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.field, self.reason)
    }
}

impl Error for ProtocolError {}

fn ascii_token(
    field: &'static str,
    value: &str,
    max: usize,
    extra: &[u8],
) -> Result<(), ProtocolError> {
    let valid = !value.is_empty()
        && value.len() <= max
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || extra.contains(&b));
    if valid {
        Ok(())
    } else {
        Err(ProtocolError::new(field, "invalid identifier"))
    }
}

macro_rules! identifier {
    ($name:ident) => {
        #[derive(Clone, Debug, Eq, PartialEq, Hash, Serialize)]
        #[serde(transparent)]
        pub struct $name(String);

        impl $name {
            pub fn parse(value: &str) -> Result<Self, ProtocolError> {
                ascii_token(stringify!($name), value, 128, b"")?;
                Ok(Self(value.to_owned()))
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
                let value = String::deserialize(deserializer)?;
                Self::parse(&value).map_err(D::Error::custom)
            }
        }
    };
}

identifier!(WorkspaceId);
identifier!(DocumentId);
identifier!(RunId);

/// Recent-document ID: exactly a lowercase canonical UUID v4 (version nibble
/// `4`, variant `8`/`9`/`a`/`b`), as required by the frontend validator.
#[derive(Clone, Debug, Eq, PartialEq, Hash, Serialize)]
#[serde(transparent)]
pub struct RecentId(String);

fn is_uuid_v4(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(i, b)| match i {
            8 | 13 | 18 | 23 => b == b'-',
            14 => b == b'4',
            19 => matches!(b, b'8' | b'9' | b'a' | b'b'),
            _ => matches!(b, b'0'..=b'9' | b'a'..=b'f'),
        })
}

impl RecentId {
    pub fn parse(value: &str) -> Result<Self, ProtocolError> {
        if !is_uuid_v4(value) {
            return Err(ProtocolError::new(
                "recent.id",
                "invalid recent-document identifier",
            ));
        }
        Ok(Self(value.to_owned()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl<'de> Deserialize<'de> for RecentId {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = String::deserialize(deserializer)?;
        Self::parse(&value).map_err(D::Error::custom)
    }
}

macro_rules! safe_integer {
    ($name:ident, $min:expr) => {
        #[derive(Clone, Copy, Debug, Eq, PartialEq, Hash, Serialize)]
        #[serde(transparent)]
        pub struct $name(u64);

        impl $name {
            const MINIMUM: u64 = $min;

            pub fn new(value: u64) -> Result<Self, ProtocolError> {
                if !(Self::MINIMUM..=MAX_SAFE_INTEGER).contains(&value) {
                    return Err(ProtocolError::new(
                        stringify!($name),
                        "expected a JavaScript-safe integer in range",
                    ));
                }
                Ok(Self(value))
            }

            pub fn get(self) -> u64 {
                self.0
            }
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
                Self::new(u64::deserialize(deserializer)?).map_err(D::Error::custom)
            }
        }
    };
}

safe_integer!(DocumentVersion, 0);
safe_integer!(Timestamp, 0);
safe_integer!(Position, 1);

/// Disk revision token: ASCII `[A-Za-z0-9:_-]`, length 1..=256.
#[derive(Clone, Debug, Eq, PartialEq, Hash, Serialize)]
#[serde(transparent)]
pub struct Revision(String);

impl Revision {
    pub fn parse(value: &str) -> Result<Self, ProtocolError> {
        ascii_token("revision", value, 256, b":")?;
        Ok(Self(value.to_owned()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl<'de> Deserialize<'de> for Revision {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = String::deserialize(deserializer)?;
        Self::parse(&value).map_err(D::Error::custom)
    }
}

/// Identity of the calling window. Host-only: it is built from a trusted
/// window label and is intentionally neither `Deserialize` nor `Serialize`.
#[derive(Clone, Debug, Eq, PartialEq, Hash)]
pub struct OwnerId(String);

impl OwnerId {
    /// Call only with the label of the trusted webview window.
    pub fn from_label(label: &str) -> Result<Self, ProtocolError> {
        ascii_token("owner", label, 128, b"")?;
        Ok(Self(label.to_owned()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostHealth {
    pub protocol_version: u32,
    pub host_version: &'static str,
    pub owner: String,
}

impl HostHealth {
    pub fn for_owner(owner: &OwnerId) -> Self {
        Self {
            protocol_version: PROTOCOL_VERSION,
            host_version: env!("CARGO_PKG_VERSION"),
            owner: owner.as_str().to_owned(),
        }
    }
}

// ---- binary validation ---------------------------------------------------

/// Maximum read-receipt size: PDFs may be larger than other files.
pub fn read_limit(path: &str) -> usize {
    if path.to_ascii_lowercase().ends_with(".pdf") {
        MAX_PDF_BYTES
    } else {
        MAX_READ_BYTES
    }
}

pub fn validate_pdf(bytes: &[u8]) -> Result<(), ProtocolError> {
    if bytes.len() > MAX_PDF_BYTES {
        return Err(ProtocolError::new("pdf", "byte limit exceeded"));
    }
    if !bytes.starts_with(b"%PDF-") {
        return Err(ProtocolError::new("pdf", "missing PDF header"));
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ImageType {
    Png,
    Jpeg,
}

/// Accepts only PNG and JPEG signatures within the 5 MiB image limit.
pub fn image_type(bytes: &[u8]) -> Result<ImageType, ProtocolError> {
    let invalid = ProtocolError::new("image.bytes", "unsupported image type or size");
    if bytes.len() > IMAGE_BYTES_LIMIT || bytes.len() < 12 {
        return Err(invalid);
    }
    if bytes.starts_with(&[137, 80, 78, 71, 13, 10, 26, 10]) {
        Ok(ImageType::Png)
    } else if bytes.starts_with(&[255, 216, 255]) && bytes.ends_with(&[255, 217]) {
        Ok(ImageType::Jpeg)
    } else {
        Err(invalid)
    }
}

/// The image content type must agree with the path extension.
pub fn validate_image_file(path: &str, bytes: &[u8]) -> Result<(), ProtocolError> {
    let lower = path.to_ascii_lowercase();
    let agrees = match image_type(bytes)? {
        ImageType::Png => lower.ends_with(".png"),
        ImageType::Jpeg => lower.ends_with(".jpg") || lower.ends_with(".jpeg"),
    };
    if agrees {
        Ok(())
    } else {
        Err(ProtocolError::new(
            "image.path",
            "extension does not match image type",
        ))
    }
}

// ---- field-level deserializers -------------------------------------------

/// Nullable field that must be present (explicit `null`), like the TS validator.
fn nullable<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)
}

/// Optional field that may be absent but, when present, must not be null.
fn present<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

fn bounded_text<'de, D: Deserializer<'de>>(
    deserializer: D,
    field: &'static str,
    max: usize,
    allow_empty: bool,
) -> Result<String, D::Error> {
    let value = String::deserialize(deserializer)?;
    if (!allow_empty && value.is_empty()) || value.encode_utf16().count() > max {
        return Err(D::Error::custom(ProtocolError::new(
            field,
            "invalid text length",
        )));
    }
    Ok(value)
}

fn workspace_label<'de, D: Deserializer<'de>>(deserializer: D) -> Result<String, D::Error> {
    bounded_text(deserializer, "label", MAX_TEXT_UTF16, false)
}

fn recent_label<'de, D: Deserializer<'de>>(deserializer: D) -> Result<String, D::Error> {
    let value = bounded_text(deserializer, "recent.label", MAX_RECENT_TEXT_UTF16, false)?;
    if value
        .chars()
        .any(|c| c < ' ' || c == '\u{7f}' || c == '/' || c == '\\')
    {
        return Err(D::Error::custom(ProtocolError::new(
            "recent.label",
            "expected a display name, not a path",
        )));
    }
    Ok(value)
}

fn recent_entry<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<RelativePath>, D::Error> {
    let value = Option::<RelativePath>::deserialize(deserializer)?;
    if let Some(path) = &value {
        let text = path.as_str();
        if text.encode_utf16().count() > MAX_RECENT_TEXT_UTF16 {
            return Err(D::Error::custom(ProtocolError::new(
                "recent.entryPath",
                "invalid text length",
            )));
        }
        if text.contains('/') || !text.to_ascii_lowercase().ends_with(".tex") {
            return Err(D::Error::custom(ProtocolError::new(
                "recent.entryPath",
                "expected a single TeX filename",
            )));
        }
    }
    Ok(value)
}

fn message<'de, D: Deserializer<'de>>(deserializer: D) -> Result<String, D::Error> {
    bounded_text(deserializer, "message", MAX_TEXT_UTF16, false)
}

fn compile_log<'de, D: Deserializer<'de>>(deserializer: D) -> Result<String, D::Error> {
    bounded_text(deserializer, "log", MAX_LOG_CHARACTERS, true)
}

fn pdf_bytes<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Vec<u8>, D::Error> {
    let bytes = Vec::<u8>::deserialize(deserializer)?;
    validate_pdf(&bytes).map_err(D::Error::custom)?;
    Ok(bytes)
}

fn diagnostic_list<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Vec<Diagnostic>, D::Error> {
    let items = Vec::<Diagnostic>::deserialize(deserializer)?;
    if items.len() > MAX_DIAGNOSTICS {
        return Err(D::Error::custom(ProtocolError::new(
            "diagnostics",
            "too many diagnostics",
        )));
    }
    Ok(items)
}

// ---- DTOs ----------------------------------------------------------------

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WorkspaceKind {
    Folder,
    File,
}

#[derive(Clone, Debug, Eq, PartialEq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileRef {
    pub workspace_id: WorkspaceId,
    pub path: RelativePath,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceInfo {
    pub id: WorkspaceId,
    #[serde(deserialize_with = "workspace_label")]
    pub label: String,
    #[serde(deserialize_with = "nullable")]
    pub entry_path: Option<RelativePath>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecentDocument {
    pub id: RecentId,
    #[serde(deserialize_with = "recent_label")]
    pub label: String,
    #[serde(deserialize_with = "recent_entry")]
    pub entry_path: Option<RelativePath>,
    pub opened_at: Timestamp,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FileKind {
    File,
    Directory,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileEntry {
    pub path: RelativePath,
    pub kind: FileKind,
}

/// Read receipt; `bytes` is bounded by [`read_limit`] for the receipt path.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", try_from = "ReadReceiptWire")]
pub struct ReadReceipt {
    pub workspace_id: WorkspaceId,
    pub path: RelativePath,
    pub bytes: Vec<u8>,
    pub revision: Revision,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReadReceiptWire {
    workspace_id: WorkspaceId,
    path: RelativePath,
    bytes: Vec<u8>,
    revision: Revision,
}

impl TryFrom<ReadReceiptWire> for ReadReceipt {
    type Error = ProtocolError;

    fn try_from(wire: ReadReceiptWire) -> Result<Self, Self::Error> {
        if wire.bytes.len() > read_limit(wire.path.as_str()) {
            return Err(ProtocolError::new("bytes", "byte limit exceeded"));
        }
        Ok(Self {
            workspace_id: wire.workspace_id,
            path: wire.path,
            bytes: wire.bytes,
            revision: wire.revision,
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WriteRequest {
    pub workspace_id: WorkspaceId,
    pub path: RelativePath,
    pub bytes: Vec<u8>,
    #[serde(deserialize_with = "nullable")]
    pub expected_revision: Option<Revision>,
    pub document_id: DocumentId,
    pub document_version: DocumentVersion,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WriteReceipt {
    pub workspace_id: WorkspaceId,
    pub path: RelativePath,
    pub revision: Revision,
    pub document_id: DocumentId,
    pub document_version: DocumentVersion,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ManagedImage {
    pub path: RelativePath,
    pub bytes: Vec<u8>,
}

/// Managed-image batch: at most [`MAX_IMAGES`] entries and 32 MiB in total;
/// names are `modutex-image-<hex/dashes>.(png|jpg|jpeg)`, unique
/// case-insensitively; each image is a PNG/JPEG of at most 5 MiB whose type
/// agrees with its extension.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(transparent)]
pub struct ImageBatch(Vec<ManagedImage>);

fn managed_image_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    let Some(rest) = lower.strip_prefix("modutex-image-") else {
        return false;
    };
    let Some((stem, extension)) = rest.rsplit_once('.') else {
        return false;
    };
    matches!(extension, "png" | "jpg" | "jpeg")
        && !stem.is_empty()
        && stem
            .bytes()
            .all(|b| b.is_ascii_digit() || matches!(b, b'a'..=b'f' | b'-'))
}

impl ImageBatch {
    pub fn new(images: Vec<ManagedImage>) -> Result<Self, ProtocolError> {
        let invalid = |reason| ProtocolError::new("images", reason);
        if images.len() > MAX_IMAGES {
            return Err(invalid("too many images"));
        }
        let mut names = HashSet::new();
        let mut total = 0usize;
        for image in &images {
            let name = image.path.as_str();
            if !managed_image_name(name) || !names.insert(name.to_ascii_lowercase()) {
                return Err(invalid("invalid or repeated managed image name"));
            }
            total = total.saturating_add(image.bytes.len());
            if total > MAX_IMAGE_BATCH_BYTES {
                return Err(invalid("image batch exceeds 32 MiB"));
            }
            validate_image_file(name, &image.bytes)?;
        }
        Ok(Self(images))
    }

    pub fn as_slice(&self) -> &[ManagedImage] {
        &self.0
    }
}

impl<'de> Deserialize<'de> for ImageBatch {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Self::new(Vec::<ManagedImage>::deserialize(deserializer)?).map_err(D::Error::custom)
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveAsRequest {
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub images: Option<ImageBatch>,
    #[serde(deserialize_with = "nullable")]
    pub workspace_id: Option<WorkspaceId>,
    pub bytes: Vec<u8>,
    pub document_id: DocumentId,
    pub document_version: DocumentVersion,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SaveAsReceipt {
    pub workspace: WorkspaceInfo,
    pub write: WriteReceipt,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FileEventKind {
    Changed,
    Removed,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileEvent {
    pub workspace_id: WorkspaceId,
    pub path: RelativePath,
    pub kind: FileEventKind,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum FileWatchFailure {
    TreeTooDeep,
    TreeTooLarge,
    StaleWorkspace,
    LinkNotAllowed,
    FileOperationFailed,
}

#[derive(Clone, Debug, Eq, PartialEq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CompileIdentity {
    pub run_id: RunId,
    pub workspace_id: WorkspaceId,
    pub entry_path: RelativePath,
    pub document_id: DocumentId,
    pub document_version: DocumentVersion,
    pub saved_revision: Revision,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Engine {
    Managed,
    System,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CompileRequest {
    pub workspace_id: WorkspaceId,
    pub entry_path: RelativePath,
    pub document_id: DocumentId,
    pub document_version: DocumentVersion,
    pub saved_revision: Revision,
    pub engine: Engine,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Error,
    Warning,
    Info,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(try_from = "DiagnosticWire")]
pub struct Diagnostic {
    pub severity: Severity,
    pub message: String,
    pub path: Option<RelativePath>,
    pub line: Option<Position>,
    pub column: Option<Position>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DiagnosticWire {
    severity: Severity,
    #[serde(deserialize_with = "message")]
    message: String,
    #[serde(deserialize_with = "nullable")]
    path: Option<RelativePath>,
    #[serde(deserialize_with = "nullable")]
    line: Option<Position>,
    #[serde(deserialize_with = "nullable")]
    column: Option<Position>,
}

impl TryFrom<DiagnosticWire> for Diagnostic {
    type Error = ProtocolError;

    fn try_from(wire: DiagnosticWire) -> Result<Self, Self::Error> {
        if (wire.line.is_some() && wire.path.is_none())
            || (wire.column.is_some() && wire.line.is_none())
        {
            return Err(ProtocolError::new(
                "location",
                "incomplete diagnostic location",
            ));
        }
        Ok(Self {
            severity: wire.severity,
            message: wire.message,
            path: wire.path,
            line: wire.line,
            column: wire.column,
        })
    }
}

/// Compile status union. Only `success` carries a PDF.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "lowercase", deny_unknown_fields)]
pub enum CompileResult {
    Success {
        identity: CompileIdentity,
        #[serde(deserialize_with = "pdf_bytes")]
        pdf: Vec<u8>,
        #[serde(deserialize_with = "compile_log")]
        log: String,
        #[serde(deserialize_with = "diagnostic_list")]
        diagnostics: Vec<Diagnostic>,
    },
    Failure {
        identity: CompileIdentity,
        #[serde(deserialize_with = "compile_log")]
        log: String,
        #[serde(deserialize_with = "diagnostic_list")]
        diagnostics: Vec<Diagnostic>,
    },
    Cancelled {
        identity: CompileIdentity,
        #[serde(deserialize_with = "compile_log")]
        log: String,
        #[serde(deserialize_with = "diagnostic_list")]
        diagnostics: Vec<Diagnostic>,
    },
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::de::DeserializeOwned;
    use serde_json::{from_value, json, to_value, Value};

    fn rejects<T: DeserializeOwned>(value: Value) {
        assert!(from_value::<T>(value.clone()).is_err(), "accepted {value}");
    }

    fn accepts<T: DeserializeOwned>(value: Value) -> T {
        from_value(value.clone()).unwrap_or_else(|error| panic!("rejected {value}: {error}"))
    }

    fn round_trip<T: Serialize + DeserializeOwned + PartialEq + fmt::Debug>(value: Value) {
        let parsed: T = accepts(value.clone());
        let encoded = to_value(&parsed).expect("serialize");
        assert_eq!(encoded, value);
        assert_eq!(accepts::<T>(encoded), parsed);
    }

    fn png(len: usize) -> Vec<u8> {
        let mut bytes = vec![0; len];
        bytes[..8].copy_from_slice(&[137, 80, 78, 71, 13, 10, 26, 10]);
        bytes
    }

    fn jpeg() -> Vec<u8> {
        vec![255, 216, 255, 0, 0, 0, 0, 0, 0, 0, 255, 217]
    }

    fn write_request() -> Value {
        json!({"workspaceId": "ws-1", "path": "main.tex", "bytes": [104, 105],
            "expectedRevision": "rev:1", "documentId": "doc_1", "documentVersion": 3})
    }

    fn compile_request() -> Value {
        json!({"workspaceId": "ws-1", "entryPath": "main.tex", "documentId": "doc_1",
            "documentVersion": 3, "savedRevision": "sha256:abc", "engine": "managed"})
    }

    fn identity() -> Value {
        json!({"runId": "run-1", "workspaceId": "ws-1", "entryPath": "main.tex",
            "documentId": "doc_1", "documentVersion": 3, "savedRevision": "sha256:abc"})
    }

    fn success() -> Value {
        json!({"status": "success", "identity": identity(), "pdf": [37, 80, 68, 70, 45, 49],
            "log": "ok", "diagnostics": [{"severity": "warning", "message": "w",
                "path": "main.tex", "line": 3, "column": null}]})
    }

    fn failure() -> Value {
        json!({"status": "failure", "identity": identity(), "log": "", "diagnostics": []})
    }

    fn save_as(images: Value) -> Value {
        json!({"images": images, "workspaceId": null, "bytes": [],
            "documentId": "doc_1", "documentVersion": 0})
    }

    #[test]
    fn unknown_fields_are_rejected() {
        let mut request = write_request();
        request["extra"] = json!(true);
        rejects::<WriteRequest>(request);
        let mut request = compile_request();
        request["extra"] = json!(1);
        rejects::<CompileRequest>(request);
        let mut nested = failure();
        nested["identity"]["extra"] = json!("x");
        rejects::<CompileResult>(nested);
        let mut with_pdf = failure();
        with_pdf["pdf"] = json!([37, 80, 68, 70, 45]);
        rejects::<CompileResult>(with_pdf);
        rejects::<FileRef>(json!({"workspaceId": "ws-1", "path": "../escape.tex"}));
    }

    #[test]
    fn bad_identifiers_are_rejected() {
        let bad_ids = [
            json!(""),
            json!("a b"),
            json!("a/b"),
            json!("é"),
            json!("a.b"),
            json!("a".repeat(129)),
            json!(5),
            json!(null),
        ];
        for bad in bad_ids {
            let mut request = write_request();
            request["workspaceId"] = bad.clone();
            rejects::<WriteRequest>(request);
            let mut request = write_request();
            request["documentId"] = bad;
            rejects::<WriteRequest>(request);
        }
        let mut edge = write_request();
        edge["workspaceId"] = json!("a".repeat(128));
        accepts::<WriteRequest>(edge);
        for bad in [
            json!(""),
            json!("a b"),
            json!("a/b"),
            json!("a".repeat(257)),
        ] {
            let mut request = write_request();
            request["expectedRevision"] = bad;
            rejects::<WriteRequest>(request);
        }
        let mut missing = write_request();
        missing
            .as_object_mut()
            .expect("object")
            .remove("expectedRevision");
        rejects::<WriteRequest>(missing);
    }

    #[test]
    fn document_version_must_be_a_safe_non_negative_integer() {
        let bad_versions = [
            json!(-1),
            json!(9_007_199_254_740_992u64),
            json!(1.5),
            json!("1"),
            json!(null),
        ];
        for bad in bad_versions {
            let mut request = write_request();
            request["documentVersion"] = bad;
            rejects::<WriteRequest>(request);
        }
        for good in [json!(0), json!(9_007_199_254_740_991u64)] {
            let mut request = write_request();
            request["documentVersion"] = good;
            accepts::<WriteRequest>(request);
        }
    }

    #[test]
    fn invalid_byte_payloads_are_rejected() {
        let bad_bytes = [
            json!([256]),
            json!([-1]),
            json!([1.5]),
            json!([1, "a"]),
            json!("hi"),
            json!(null),
        ];
        for bad in bad_bytes {
            let mut request = write_request();
            request["bytes"] = bad;
            rejects::<WriteRequest>(request);
        }
        let mut empty = write_request();
        empty["bytes"] = json!([]);
        accepts::<WriteRequest>(empty);
        let mut no_header = success();
        no_header["pdf"] = json!([1, 2, 3, 4, 5]);
        rejects::<CompileResult>(no_header);
    }

    #[test]
    fn pdf_and_read_limits_follow_the_renderer_adapter() {
        assert_eq!(MAX_PDF_BYTES, 32 * 1024 * 1024);
        assert_eq!(MAX_LOG_CHARACTERS, 256 * 1024);
        assert_eq!(MAX_DIAGNOSTICS, 256);
        let mut pdf = b"%PDF-".to_vec();
        pdf.resize(MAX_PDF_BYTES, 0);
        assert!(validate_pdf(&pdf).is_ok());
        pdf.push(0);
        assert!(validate_pdf(&pdf).is_err());
        assert!(validate_pdf(b"%PDF").is_err());

        assert_eq!(read_limit("a.PDF"), MAX_PDF_BYTES);
        assert_eq!(read_limit("a.tex"), MAX_READ_BYTES);
        let wire = |path: &str, len: usize| ReadReceiptWire {
            workspace_id: WorkspaceId::parse("ws-1").expect("id"),
            path: RelativePath::parse(path).expect("path"),
            bytes: vec![0; len],
            revision: Revision::parse("r1").expect("revision"),
        };
        assert!(ReadReceipt::try_from(wire("a.tex", MAX_READ_BYTES)).is_ok());
        assert!(ReadReceipt::try_from(wire("a.tex", MAX_READ_BYTES + 1)).is_err());
        assert!(ReadReceipt::try_from(wire("a.pdf", MAX_READ_BYTES + 1)).is_ok());

        let mut many = vec![failure()["diagnostics"].clone()];
        many.clear();
        let diagnostic = json!({"severity": "info", "message": "m",
            "path": null, "line": null, "column": null});
        let mut result = failure();
        result["diagnostics"] = Value::Array(vec![diagnostic.clone(); MAX_DIAGNOSTICS]);
        accepts::<CompileResult>(result.clone());
        result["diagnostics"] = Value::Array(vec![diagnostic; MAX_DIAGNOSTICS + 1]);
        rejects::<CompileResult>(result);
        let mut result = failure();
        result["log"] = json!("x".repeat(MAX_LOG_CHARACTERS));
        accepts::<CompileResult>(result.clone());
        result["log"] = json!("x".repeat(MAX_LOG_CHARACTERS + 1));
        rejects::<CompileResult>(result);
    }

    #[test]
    fn bad_engine_and_status_are_rejected() {
        for bad in [json!("remote"), json!("Managed"), json!(null), json!(1)] {
            let mut request = compile_request();
            request["engine"] = bad;
            rejects::<CompileRequest>(request);
        }
        let mut system = compile_request();
        system["engine"] = json!("system");
        accepts::<CompileRequest>(system);
        for bad in ["done", "Success", ""] {
            let mut result = failure();
            result["status"] = json!(bad);
            rejects::<CompileResult>(result);
        }
        let mut no_status = failure();
        no_status.as_object_mut().expect("object").remove("status");
        rejects::<CompileResult>(no_status);
        let mut no_pdf = success();
        no_pdf.as_object_mut().expect("object").remove("pdf");
        rejects::<CompileResult>(no_pdf);
        rejects::<FileWatchFailure>(json!("OTHER"));
    }

    #[test]
    fn diagnostics_require_consistent_locations() {
        let base = |path: Value, line: Value, column: Value| {
            json!({"severity": "error", "message": "m",
                "path": path, "line": line, "column": column})
        };
        accepts::<Diagnostic>(base(json!(null), json!(null), json!(null)));
        accepts::<Diagnostic>(base(json!("a.tex"), json!(1), json!(2)));
        rejects::<Diagnostic>(base(json!(null), json!(1), json!(null)));
        rejects::<Diagnostic>(base(json!("a.tex"), json!(null), json!(2)));
        rejects::<Diagnostic>(base(json!("a.tex"), json!(0), json!(null)));
        rejects::<Diagnostic>(json!({"severity": "fatal", "message": "m",
            "path": null, "line": null, "column": null}));
        rejects::<Diagnostic>(json!({"severity": "error", "message": "m",
            "path": null, "line": null}));
    }

    #[test]
    fn nullable_fields_must_be_explicit() {
        rejects::<WorkspaceInfo>(json!({"id": "ws-1", "label": "Thesis"}));
        round_trip::<WorkspaceInfo>(json!({"id": "ws-1", "label": "Thesis", "entryPath": null}));
    }

    #[test]
    fn recent_documents_follow_the_contract_rules() {
        let id = "123e4567-e89b-42d3-a456-426614174000";
        let recent = |label: &str, entry: Value| json!({"id": id, "label": label, "entryPath": entry, "openedAt": 1});
        rejects::<RecentDocument>(recent("a/b", json!(null)));
        rejects::<RecentDocument>(recent("", json!(null)));
        rejects::<RecentDocument>(recent(&"x".repeat(4097), json!(null)));
        accepts::<RecentDocument>(recent(&"x".repeat(4096), json!(null)));
        rejects::<RecentDocument>(recent("Thesis", json!("dir/main.tex")));
        rejects::<RecentDocument>(recent("Thesis", json!("main.pdf")));
        accepts::<RecentDocument>(recent("Thesis", json!("MAIN.TEX")));
        let entry = |len: usize| json!(format!("{}.tex", "a".repeat(len - 4)));
        accepts::<RecentDocument>(recent("Thesis", entry(4096)));
        rejects::<RecentDocument>(recent("Thesis", entry(4097)));
    }

    #[test]
    fn recent_ids_are_exact_lowercase_uuid_v4() {
        let valid = "123e4567-e89b-42d3-a456-426614174000";
        let recent =
            |id: Value| json!({"id": id, "label": "Thesis", "entryPath": null, "openedAt": 1});
        let accepted = [
            valid,
            "00000000-0000-4000-8000-000000000000",
            "ffffffff-ffff-4fff-bfff-ffffffffffff",
            "123e4567-e89b-42d3-9456-426614174000",
            "123e4567-e89b-42d3-b456-426614174000",
        ];
        for id in accepted {
            round_trip::<RecentDocument>(recent(json!(id)));
        }
        let rejected = [
            "",
            "doc_1",
            "ws-1",
            "123E4567-E89B-42D3-A456-426614174000",
            "123e4567-e89b-42d3-A456-426614174000",
            "123e4567-e89b-12d3-a456-426614174000",
            "123e4567-e89b-52d3-a456-426614174000",
            "123e4567-e89b-42d3-c456-426614174000",
            "123e4567-e89b-42d3-7456-426614174000",
            "123e4567-e89b-42d3-a456-42661417400",
            "123e4567-e89b-42d3-a456-4266141740000",
            " 123e4567-e89b-42d3-a456-426614174000",
            "123e4567-e89b-42d3-a456-426614174000 ",
            "123e4567-e89b-42d3-a456-426614174000\n",
            "123e4567e89b42d3a456426614174000",
            "{123e4567-e89b-42d3-a456-426614174000}",
            "123e4567-e89b-42d3-a456-42661417400g",
            "123e4567_e89b_42d3_a456_426614174000",
            "123e4567-e89b-42d3-a456-42661417400é",
        ];
        for id in rejected {
            rejects::<RecentDocument>(recent(json!(id)));
            rejects::<RecentId>(json!(id));
        }
        rejects::<RecentId>(json!(5));
        rejects::<RecentId>(json!(null));
        let id = RecentId::parse(valid).expect("valid UUID v4");
        assert_eq!(id.as_str(), valid);
        assert_eq!(to_value(&id).expect("serialize"), json!(valid));
        assert!(RecentId::parse("doc_1").is_err());
    }

    #[test]
    fn image_signature_size_and_extension_are_enforced() {
        assert_eq!(image_type(&png(12)), Ok(ImageType::Png));
        assert_eq!(image_type(&jpeg()), Ok(ImageType::Jpeg));
        assert!(image_type(&png(11)).is_err());
        assert!(image_type(&png(IMAGE_BYTES_LIMIT)).is_ok());
        assert!(image_type(&png(IMAGE_BYTES_LIMIT + 1)).is_err());
        assert!(image_type(&[255, 216, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0]).is_err());
        assert!(image_type(&[0; 16]).is_err());
        assert!(validate_image_file("a.PNG", &png(12)).is_ok());
        assert!(validate_image_file("a.jpeg", &jpeg()).is_ok());
        assert!(validate_image_file("a.jpg", &png(12)).is_err());
        assert!(validate_image_file("a.png", &jpeg()).is_err());
    }

    #[test]
    fn image_batches_are_validated() {
        let image = |path: &str, bytes: Vec<u8>| json!({"path": path, "bytes": bytes});
        accepts::<SaveAsRequest>(save_as(json!([image(
            "modutex-image-0a1b-2c.PNG",
            png(12)
        )])));
        rejects::<SaveAsRequest>(save_as(json!([image("photo.png", png(12))])));
        rejects::<SaveAsRequest>(save_as(json!([
            image("modutex-image-aa.png", png(12)),
            image("modutex-image-AA.png", png(12)),
        ])));
        rejects::<SaveAsRequest>(save_as(json!([image("modutex-image-aa.jpg", png(12))])));
        rejects::<SaveAsRequest>(save_as(json!([image("modutex-image-aa.png", jpeg())])));
        rejects::<SaveAsRequest>(save_as(json!([image("modutex-image-aa.png", vec![1])])));
        rejects::<SaveAsRequest>(save_as(json!(null)));
        let mut absent = save_as(json!([]));
        absent.as_object_mut().expect("object").remove("images");
        assert!(accepts::<SaveAsRequest>(absent).images.is_none());
    }

    #[test]
    fn image_batch_count_and_aggregate_limits() {
        let entry = |name: String, bytes: Vec<u8>| ManagedImage {
            path: RelativePath::parse(&name).expect("path"),
            bytes,
        };
        let tiny = |count: usize| {
            (0..count)
                .map(|i| entry(format!("modutex-image-{i:x}.png"), png(12)))
                .collect::<Vec<_>>()
        };
        assert!(ImageBatch::new(tiny(MAX_IMAGES)).is_ok());
        assert!(ImageBatch::new(tiny(MAX_IMAGES + 1)).is_err());
        let large = |count: usize| {
            (0..count)
                .map(|i| entry(format!("modutex-image-{i}.png"), png(IMAGE_BYTES_LIMIT)))
                .collect::<Vec<_>>()
        };
        assert!(ImageBatch::new(large(6)).is_ok());
        assert!(ImageBatch::new(large(7)).is_err());
    }

    #[test]
    fn identities_round_trip_unchanged() {
        round_trip::<FileRef>(json!({"workspaceId": "ws-1", "path": "chapters/one.tex"}));
        round_trip::<RecentDocument>(json!({"id": "123e4567-e89b-42d3-a456-426614174000",
            "label": "Thesis", "entryPath": "main.tex", "openedAt": 1_760_000_000_000u64}));
        round_trip::<FileEntry>(json!({"path": "figs", "kind": "directory"}));
        round_trip::<ReadReceipt>(json!({"workspaceId": "ws-1", "path": "main.tex",
            "bytes": [0, 255], "revision": "sha256:abc"}));
        round_trip::<WriteRequest>(write_request());
        round_trip::<WriteReceipt>(json!({"workspaceId": "ws-1", "path": "main.tex",
            "revision": "rev:2", "documentId": "doc_1", "documentVersion": 3}));
        round_trip::<SaveAsRequest>(json!({
            "images": [
                {"path": "modutex-image-0a1b-2c.png", "bytes": png(12)},
                {"path": "modutex-image-ab-1.jpg", "bytes": jpeg()}
            ],
            "workspaceId": "ws-1", "bytes": [1], "documentId": "doc_1", "documentVersion": 1}));
        round_trip::<SaveAsReceipt>(json!({
            "workspace": {"id": "ws-2", "label": "New", "entryPath": "main.tex"},
            "write": {"workspaceId": "ws-2", "path": "main.tex", "revision": "r1",
                "documentId": "doc_1", "documentVersion": 1}}));
        round_trip::<FileEvent>(json!({"workspaceId": "ws-1", "path": "a.tex", "kind": "removed"}));
        round_trip::<FileWatchFailure>(json!("TREE_TOO_DEEP"));
        round_trip::<CompileIdentity>(identity());
        round_trip::<CompileRequest>(compile_request());
        round_trip::<CompileResult>(success());
        round_trip::<CompileResult>(failure());
        let mut cancelled = failure();
        cancelled["status"] = json!("cancelled");
        round_trip::<CompileResult>(cancelled);
        match accepts::<CompileResult>(success()) {
            CompileResult::Success { identity, pdf, .. } => {
                assert_eq!(identity.run_id.as_str(), "run-1");
                assert_eq!(identity.document_version.get(), 3);
                assert_eq!(pdf, b"%PDF-1");
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn owner_comes_from_trusted_label_and_reports_host_health() {
        assert!(OwnerId::from_label("a/b").is_err());
        assert!(OwnerId::from_label("").is_err());
        let owner = OwnerId::from_label("main").expect("main");
        assert_eq!(
            to_value(HostHealth::for_owner(&owner)).expect("serialize"),
            json!({"protocolVersion": 1, "hostVersion": env!("CARGO_PKG_VERSION"), "owner": "main"})
        );
    }
}
