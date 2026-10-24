// SPDX-License-Identifier: Apache-2.0
//! Wire DTOs for the DesktopPort contract. Every payload is strict: exact
//! field sets, validated identifiers, JS-safe integers and explicit nulls.
//! Limits mirror the frontend contract validators and the active renderer
//! adapter (`desktop.ts`).

use std::{collections::HashSet, error::Error, fmt};

use serde::{de::Error as _, Deserialize, Deserializer, Serialize};

use crate::shared::relative_path::RelativePath;

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
    pub(crate) fn new(field: &'static str, reason: &'static str) -> Self {
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
        let lower = text.to_ascii_lowercase();
        if text.contains('/') || !(lower.ends_with(".tex") || lower.ends_with(".pdf")) {
            return Err(D::Error::custom(ProtocolError::new(
                "recent.entryPath",
                "expected a single TeX or PDF filename",
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

// ---- Native WorkspaceFiles commands ------------------------------------

/// Long-running tree operations are owner- and workspace-scoped. The
/// operation ID is only a cancellation handle; it grants no file capability.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceFilesTreeRequest {
    pub workspace_id: WorkspaceId,
    pub operation_id: RunId,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceFilesScanRequest {
    pub workspace_id: WorkspaceId,
    pub directory: RelativePath,
    pub max_depth: u32,
    pub max_entries: u32,
    pub operation_id: RunId,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceFilesSearchRequest {
    pub workspace_id: WorkspaceId,
    #[serde(deserialize_with = "nullable")]
    pub directory: Option<RelativePath>,
    pub query: String,
    pub max_results: u32,
    pub operation_id: RunId,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceFilePathRequest {
    pub workspace_id: WorkspaceId,
    pub path: RelativePath,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceFileCreateRequest {
    pub workspace_id: WorkspaceId,
    pub path: RelativePath,
    pub bytes: Vec<u8>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceFileMoveRequest {
    pub workspace_id: WorkspaceId,
    pub source: RelativePath,
    pub destination: RelativePath,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceFileCopyRequest {
    pub workspace_id: WorkspaceId,
    pub source: RelativePath,
    pub destination: RelativePath,
    pub operation_id: RunId,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceFilesCancelRequest {
    pub workspace_id: WorkspaceId,
    pub operation_id: RunId,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceFileStat {
    pub path: RelativePath,
    pub kind: FileKind,
    /// Always a JavaScript-safe integer; directories report zero.
    pub size_bytes: u64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceFileSearchHit {
    pub path: RelativePath,
    pub line: Position,
    pub preview: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceFileSearchResult {
    pub hits: Vec<WorkspaceFileSearchHit>,
    /// True when the result limit or a bounded input limit stopped the search.
    pub truncated: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceRecoverableDeleteReceipt {
    pub token: String,
    pub expires_in_ms: u64,
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

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum FileWatchResyncReason {
    PeriodicReconcileDue,
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
#[path = "../../tests/unit/protocol.rs"]
mod tests;
