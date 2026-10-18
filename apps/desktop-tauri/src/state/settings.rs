// SPDX-License-Identifier: Apache-2.0
//! Host-owned persistent store for user preferences (`frontend-settings-v1.json`).
//! Mirrors the exact `Preferences` types, ranges, defaults, and per-field
//! recovery semantics from `apps/frontend/src/state/preferences.ts`.

use std::{
    collections::{BTreeMap, HashMap},
    error::Error,
    fmt,
    fs::{self},
    io,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::state::recent::{
    atomic_write_store_bytes, bounded_read_store_bytes, check_path_not_symlink_or_reparse,
    normalized_path_identity_key, resolve_host_data_dir, RecentErrorCode, RecentStoreError,
};

/// File name for the v1 persistent settings store.
pub const SETTINGS_STORE_FILENAME: &str = "frontend-settings-v1.json";
/// Current schema version for `frontend-settings-v1.json`.
pub const SETTINGS_SCHEMA_VERSION: u32 = 1;
/// Maximum byte size checked before allocation when loading the settings store.
pub const MAX_SETTINGS_STORE_BYTES: u64 = 64 * 1024;
/// Maximum encoded character length for a single preference value, matching `preferences.ts`.
pub const MAX_ENCODED_PREFERENCE_LEN: usize = 64;
/// Legacy localStorage key prefix from `apps/frontend/src/state/preferences.ts`.
pub const LEGACY_PREFERENCE_PREFIX: &str = "modutex.frontend.preferences.v1.";
/// Minimum valid `sourceFontSize`.
pub const MIN_SOURCE_FONT_SIZE: u8 = 12;
/// Maximum valid `sourceFontSize`.
pub const MAX_SOURCE_FONT_SIZE: u8 = 24;
/// Default `sourceFontSize`.
pub const DEFAULT_SOURCE_FONT_SIZE: u8 = 14;

fn settings_locks() -> &'static Mutex<HashMap<String, Arc<Mutex<()>>>> {
    static LOCKS: OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();
    LOCKS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn acquire_settings_lock(store_path: &Path) -> Arc<Mutex<()>> {
    let key = normalized_path_identity_key(store_path);
    let mut map = settings_locks()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    Arc::clone(map.entry(key).or_insert_with(|| Arc::new(Mutex::new(()))))
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum Language {
    #[serde(rename = "zh-Hant")]
    ZhHant,
    #[serde(rename = "en")]
    En,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Appearance {
    System,
    Light,
    Dark,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EffectiveAppearance {
    Light,
    Dark,
}

/// Resolves the effective light/dark appearance matching `effectiveAppearance` in `preferences.ts`.
pub fn effective_appearance(appearance: Appearance, system_dark: bool) -> EffectiveAppearance {
    match appearance {
        Appearance::System => {
            if system_dark {
                EffectiveAppearance::Dark
            } else {
                EffectiveAppearance::Light
            }
        }
        Appearance::Light => EffectiveAppearance::Light,
        Appearance::Dark => EffectiveAppearance::Dark,
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum CompileShortcut {
    #[serde(rename = "mod-enter")]
    ModEnter,
    #[serde(rename = "mod-shift-b")]
    ModShiftB,
    #[serde(rename = "none")]
    None,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash, Ord, PartialOrd)]
pub enum PreferenceKey {
    Language,
    Appearance,
    SourceFontSize,
    ShowLineNumbers,
    WrapLines,
    CompileShortcut,
}

impl PreferenceKey {
    pub const ALL: [Self; 6] = [
        Self::Language,
        Self::Appearance,
        Self::SourceFontSize,
        Self::ShowLineNumbers,
        Self::WrapLines,
        Self::CompileShortcut,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Language => "language",
            Self::Appearance => "appearance",
            Self::SourceFontSize => "sourceFontSize",
            Self::ShowLineNumbers => "showLineNumbers",
            Self::WrapLines => "wrapLines",
            Self::CompileShortcut => "compileShortcut",
        }
    }

    pub fn from_key_or_prefixed(raw: &str) -> Option<Self> {
        let trimmed = raw.strip_prefix(LEGACY_PREFERENCE_PREFIX).unwrap_or(raw);
        match trimmed {
            "language" => Some(Self::Language),
            "appearance" => Some(Self::Appearance),
            "sourceFontSize" => Some(Self::SourceFontSize),
            "showLineNumbers" => Some(Self::ShowLineNumbers),
            "wrapLines" => Some(Self::WrapLines),
            "compileShortcut" => Some(Self::CompileShortcut),
            _ => None,
        }
    }
}

/// Strongly typed single preference value matching `Preferences[K]`.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PreferenceValue {
    Language(Language),
    Appearance(Appearance),
    SourceFontSize(u8),
    ShowLineNumbers(bool),
    WrapLines(bool),
    CompileShortcut(CompileShortcut),
}

/// Complete validated preferences struct matching `Preferences` in `preferences.ts`.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Preferences {
    pub language: Language,
    pub appearance: Appearance,
    pub source_font_size: u8,
    pub show_line_numbers: bool,
    pub wrap_lines: bool,
    pub compile_shortcut: CompileShortcut,
}

impl Default for Preferences {
    fn default() -> Self {
        Self {
            language: Language::ZhHant,
            appearance: Appearance::System,
            source_font_size: DEFAULT_SOURCE_FONT_SIZE,
            show_line_numbers: true,
            wrap_lines: false,
            compile_shortcut: CompileShortcut::ModEnter,
        }
    }
}

impl Preferences {
    pub fn validate(&self) -> Result<(), SettingsStoreError> {
        if !(MIN_SOURCE_FONT_SIZE..=MAX_SOURCE_FONT_SIZE).contains(&self.source_font_size) {
            return Err(SettingsStoreError::new(
                SettingsErrorCode::InvalidPreference,
                "sourceFontSize must be an integer between 12 and 24",
            ));
        }
        Ok(())
    }

    pub fn apply(&mut self, value: PreferenceValue) -> Result<(), SettingsStoreError> {
        match value {
            PreferenceValue::Language(v) => self.language = v,
            PreferenceValue::Appearance(v) => self.appearance = v,
            PreferenceValue::SourceFontSize(v) => {
                if !(MIN_SOURCE_FONT_SIZE..=MAX_SOURCE_FONT_SIZE).contains(&v) {
                    return Err(SettingsStoreError::new(
                        SettingsErrorCode::InvalidPreference,
                        "sourceFontSize out of range 12..=24",
                    ));
                }
                self.source_font_size = v;
            }
            PreferenceValue::ShowLineNumbers(v) => self.show_line_numbers = v,
            PreferenceValue::WrapLines(v) => self.wrap_lines = v,
            PreferenceValue::CompileShortcut(v) => self.compile_shortcut = v,
        }
        Ok(())
    }
}

/// Decodes and validates a single preference field matching `decodePreference` in `preferences.ts`.
pub fn decode_preference_value(
    key: PreferenceKey,
    value: &Value,
) -> Result<PreferenceValue, SettingsStoreError> {
    let encoded = serde_json::to_string(value).map_err(|_| {
        SettingsStoreError::new(
            SettingsErrorCode::InvalidPreference,
            "failed to encode preference value",
        )
    })?;
    if encoded.len() > MAX_ENCODED_PREFERENCE_LEN {
        return Err(SettingsStoreError::new(
            SettingsErrorCode::InvalidPreference,
            "preference value exceeds 64-byte encoded size bound",
        ));
    }

    match key {
        PreferenceKey::Language => match value.as_str() {
            Some("zh-Hant") => Ok(PreferenceValue::Language(Language::ZhHant)),
            Some("en") => Ok(PreferenceValue::Language(Language::En)),
            _ => Err(SettingsStoreError::new(
                SettingsErrorCode::InvalidPreference,
                "INVALID_PREFERENCE: language",
            )),
        },
        PreferenceKey::Appearance => match value.as_str() {
            Some("system") => Ok(PreferenceValue::Appearance(Appearance::System)),
            Some("light") => Ok(PreferenceValue::Appearance(Appearance::Light)),
            Some("dark") => Ok(PreferenceValue::Appearance(Appearance::Dark)),
            _ => Err(SettingsStoreError::new(
                SettingsErrorCode::InvalidPreference,
                "INVALID_PREFERENCE: appearance",
            )),
        },
        PreferenceKey::SourceFontSize => {
            let Some(num) = value.as_u64() else {
                return Err(SettingsStoreError::new(
                    SettingsErrorCode::InvalidPreference,
                    "INVALID_PREFERENCE: sourceFontSize must be an integer",
                ));
            };
            if (MIN_SOURCE_FONT_SIZE as u64..=MAX_SOURCE_FONT_SIZE as u64).contains(&num) {
                Ok(PreferenceValue::SourceFontSize(num as u8))
            } else {
                Err(SettingsStoreError::new(
                    SettingsErrorCode::InvalidPreference,
                    "INVALID_PREFERENCE: sourceFontSize out of range 12..=24",
                ))
            }
        }
        PreferenceKey::ShowLineNumbers => value
            .as_bool()
            .map(PreferenceValue::ShowLineNumbers)
            .ok_or_else(|| {
                SettingsStoreError::new(
                    SettingsErrorCode::InvalidPreference,
                    "INVALID_PREFERENCE: showLineNumbers must be boolean",
                )
            }),
        PreferenceKey::WrapLines => {
            value
                .as_bool()
                .map(PreferenceValue::WrapLines)
                .ok_or_else(|| {
                    SettingsStoreError::new(
                        SettingsErrorCode::InvalidPreference,
                        "INVALID_PREFERENCE: wrapLines must be boolean",
                    )
                })
        }
        PreferenceKey::CompileShortcut => match value.as_str() {
            Some("mod-enter") => Ok(PreferenceValue::CompileShortcut(CompileShortcut::ModEnter)),
            Some("mod-shift-b") => Ok(PreferenceValue::CompileShortcut(CompileShortcut::ModShiftB)),
            Some("none") => Ok(PreferenceValue::CompileShortcut(CompileShortcut::None)),
            _ => Err(SettingsStoreError::new(
                SettingsErrorCode::InvalidPreference,
                "INVALID_PREFERENCE: compileShortcut",
            )),
        },
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SettingsErrorCode {
    InvalidPreference,
    LinkNotAllowed,
    OversizeStore,
    MalformedSchema,
    SameAsLegacyDataDir,
    PersistenceFailed,
    IoFailed,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SettingsStoreError {
    code: SettingsErrorCode,
    message: String,
}

impl SettingsStoreError {
    pub fn new(code: SettingsErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn code(&self) -> SettingsErrorCode {
        self.code
    }

    pub fn message(&self) -> &str {
        &self.message
    }
}

impl fmt::Display for SettingsStoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:?}: {}", self.code, self.message)
    }
}

impl Error for SettingsStoreError {}

impl From<RecentStoreError> for SettingsStoreError {
    fn from(err: RecentStoreError) -> Self {
        let code = match err.code() {
            RecentErrorCode::LinkNotAllowed => SettingsErrorCode::LinkNotAllowed,
            RecentErrorCode::OversizeStore => SettingsErrorCode::OversizeStore,
            RecentErrorCode::MalformedSchema => SettingsErrorCode::MalformedSchema,
            RecentErrorCode::PersistenceFailed => SettingsErrorCode::PersistenceFailed,
            _ => SettingsErrorCode::IoFailed,
        };
        Self::new(code, err.message().to_owned())
    }
}

/// Result of reading preferences with per-field validation and default recovery.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReadPreferencesResult {
    pub preferences: Preferences,
    pub invalid: bool,
    pub recovered_fields: Vec<PreferenceKey>,
}

/// Result of importing legacy preferences into the independent host data dir.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ImportPreferencesResult {
    pub preferences: Preferences,
    pub invalid: bool,
    pub already_imported: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredSettingsEnvelopeWire {
    version: u32,
    preferences: Map<String, Value>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredSettingsWriteV1<'a> {
    version: u32,
    preferences: &'a Preferences,
}

fn recover_preferences_from_map(map: &Map<String, Value>) -> ReadPreferencesResult {
    let mut preferences = Preferences::default();
    let mut invalid = false;
    let mut recovered_fields = Vec::new();

    for key in map.keys() {
        if PreferenceKey::ALL
            .iter()
            .all(|k| k.as_str() != key.as_str())
        {
            invalid = true;
        }
    }

    for key in PreferenceKey::ALL {
        let Some(raw_val) = map.get(key.as_str()) else {
            continue;
        };
        match decode_preference_value(key, raw_val) {
            Ok(decoded) => {
                let _ = preferences.apply(decoded);
            }
            Err(_) => {
                invalid = true;
                recovered_fields.push(key);
            }
        }
    }

    ReadPreferencesResult {
        preferences,
        invalid,
        recovered_fields,
    }
}

/// Host-owned persistent store for `frontend-settings-v1.json`.
#[derive(Clone, Debug)]
pub struct SettingsStore {
    data_dir: PathBuf,
}

impl SettingsStore {
    pub fn new(data_dir: impl Into<PathBuf>) -> Self {
        Self {
            data_dir: data_dir.into(),
        }
    }

    pub fn with_default_data_dir() -> Result<Self, SettingsStoreError> {
        Ok(Self::new(resolve_host_data_dir()?))
    }

    pub fn data_dir(&self) -> &Path {
        &self.data_dir
    }

    pub fn store_path(&self) -> PathBuf {
        self.data_dir.join(SETTINGS_STORE_FILENAME)
    }

    /// Reads `frontend-settings-v1.json` with bounded allocation and per-field
    /// validation/default recovery so a corrupt field never overwrites valid
    /// peer fields.
    pub fn read_preferences(&self) -> Result<ReadPreferencesResult, SettingsStoreError> {
        let store_path = self.store_path();
        let lock = acquire_settings_lock(&store_path);
        let _guard = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        self.read_preferences_locked()
    }

    /// Updates a single preference field, preserving all other valid peer
    /// fields on disk, and writes atomically.
    pub fn set_preference(
        &self,
        value: PreferenceValue,
    ) -> Result<Preferences, SettingsStoreError> {
        self.set_preference_with_renamer(value, |from, to| fs::rename(from, to))
    }

    fn set_preference_with_renamer<F>(
        &self,
        value: PreferenceValue,
        rename_op: F,
    ) -> Result<Preferences, SettingsStoreError>
    where
        F: FnMut(&Path, &Path) -> io::Result<()>,
    {
        let store_path = self.store_path();
        let lock = acquire_settings_lock(&store_path);
        let _guard = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());

        let mut current = self.read_preferences_locked()?.preferences;
        current.apply(value)?;
        self.write_preferences_locked(&current, rename_op)?;
        Ok(current)
    }

    /// Validates and persists a complete `Preferences` struct atomically.
    pub fn save_preferences(&self, preferences: &Preferences) -> Result<(), SettingsStoreError> {
        preferences.validate()?;
        let store_path = self.store_path();
        let lock = acquire_settings_lock(&store_path);
        let _guard = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());

        // Verify existing store is not a malformed top-level schema before overwriting.
        let _ = self.read_preferences_locked()?;
        self.write_preferences_locked(preferences, |from, to| fs::rename(from, to))
    }

    /// Restores default preferences atomically and re-reads actual disk state.
    pub fn restore_defaults(&self) -> Result<ReadPreferencesResult, SettingsStoreError> {
        let store_path = self.store_path();
        let lock = acquire_settings_lock(&store_path);
        let _guard = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());

        let _ = self.read_preferences_locked()?;
        let defaults = Preferences::default();
        self.write_preferences_locked(&defaults, |from, to| fs::rename(from, to))?;
        self.read_preferences_locked()
    }

    /// Imports legacy preferences from an explicit validated key-value record
    /// into this store's separate app data directory without mutating any legacy
    /// source data. Retries are idempotent.
    pub fn import_legacy_record(
        &self,
        legacy_record: &BTreeMap<String, Value>,
        legacy_source_dir: Option<&Path>,
    ) -> Result<ImportPreferencesResult, SettingsStoreError> {
        if let Some(source_dir) = legacy_source_dir {
            check_path_not_symlink_or_reparse(source_dir, None)?;
            let src_key = normalized_path_identity_key(source_dir);
            let dst_key = normalized_path_identity_key(&self.data_dir);
            if src_key == dst_key {
                return Err(SettingsStoreError::new(
                    SettingsErrorCode::SameAsLegacyDataDir,
                    "target settings data directory must be separate from legacy source directory",
                ));
            }
        }

        let store_path = self.store_path();
        let lock = acquire_settings_lock(&store_path);
        let _guard = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());

        if bounded_read_store_bytes(&store_path, &self.data_dir, MAX_SETTINGS_STORE_BYTES)?
            .is_some()
        {
            let existing = self.read_preferences_locked()?;
            return Ok(ImportPreferencesResult {
                preferences: existing.preferences,
                invalid: existing.invalid,
                already_imported: true,
            });
        }

        let mut preferences = Preferences::default();
        let mut invalid = false;

        for key in PreferenceKey::ALL {
            let prefixed = format!("{LEGACY_PREFERENCE_PREFIX}{}", key.as_str());
            let raw_entry = legacy_record
                .get(&prefixed)
                .or_else(|| legacy_record.get(key.as_str()));
            let Some(raw_value) = raw_entry else {
                continue;
            };

            // Support both localStorage JSON-encoded strings (bounded <= 64 chars) and direct values.
            let candidate_value: Value = match raw_value {
                Value::String(s) => {
                    if s.len() > MAX_ENCODED_PREFERENCE_LEN {
                        invalid = true;
                        continue;
                    }
                    serde_json::from_str::<Value>(s).unwrap_or_else(|_| Value::String(s.clone()))
                }
                other => other.clone(),
            };

            match decode_preference_value(key, &candidate_value) {
                Ok(decoded) => {
                    let _ = preferences.apply(decoded);
                }
                Err(_) => {
                    invalid = true;
                }
            }
        }

        self.write_preferences_locked(&preferences, |from, to| fs::rename(from, to))?;
        Ok(ImportPreferencesResult {
            preferences,
            invalid,
            already_imported: false,
        })
    }

    fn read_preferences_locked(&self) -> Result<ReadPreferencesResult, SettingsStoreError> {
        let store_path = self.store_path();
        let Some(bytes) =
            bounded_read_store_bytes(&store_path, &self.data_dir, MAX_SETTINGS_STORE_BYTES)?
        else {
            return Ok(ReadPreferencesResult {
                preferences: Preferences::default(),
                invalid: false,
                recovered_fields: Vec::new(),
            });
        };

        let envelope: StoredSettingsEnvelopeWire =
            serde_json::from_slice(&bytes).map_err(|err| {
                SettingsStoreError::new(
                    SettingsErrorCode::MalformedSchema,
                    format!("invalid settings store JSON: {err}"),
                )
            })?;

        if envelope.version != SETTINGS_SCHEMA_VERSION {
            return Err(SettingsStoreError::new(
                SettingsErrorCode::MalformedSchema,
                format!("unsupported settings schema version: {}", envelope.version),
            ));
        }

        Ok(recover_preferences_from_map(&envelope.preferences))
    }

    fn write_preferences_locked<F>(
        &self,
        preferences: &Preferences,
        rename_op: F,
    ) -> Result<(), SettingsStoreError>
    where
        F: FnMut(&Path, &Path) -> io::Result<()>,
    {
        preferences.validate()?;
        let payload = StoredSettingsWriteV1 {
            version: SETTINGS_SCHEMA_VERSION,
            preferences,
        };
        let mut bytes = serde_json::to_vec_pretty(&payload).map_err(|err| {
            SettingsStoreError::new(
                SettingsErrorCode::PersistenceFailed,
                format!("failed to serialize settings store: {err}"),
            )
        })?;
        bytes.push(b'\n');
        if (bytes.len() as u64) > MAX_SETTINGS_STORE_BYTES {
            return Err(SettingsStoreError::new(
                SettingsErrorCode::OversizeStore,
                "serialized settings store exceeds maximum byte limit",
            ));
        }
        atomic_write_store_bytes(&self.data_dir, SETTINGS_STORE_FILENAME, &bytes, rename_op)?;
        Ok(())
    }
}

#[cfg(test)]
#[path = "../../tests/unit/settings.rs"]
mod tests;
