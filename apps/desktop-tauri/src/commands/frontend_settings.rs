// SPDX-License-Identifier: Apache-2.0
//! Trusted-window commands for the host-owned frontend preferences store.

use std::{
    collections::{BTreeMap, HashSet},
    env,
    path::PathBuf,
};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tauri::{State, WebviewWindow};

use crate::{
    commands::frontend_files::verify_trusted_window,
    state::{
        desktop::FrontendFilesState,
        recent::bounded_read_store_bytes,
        settings::{
            decode_preference_value, ImportPreferencesResult, PreferenceKey, Preferences,
            ReadPreferencesResult, MAX_SETTINGS_STORE_BYTES,
        },
    },
};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreferencesSnapshot {
    pub preferences: Preferences,
    pub invalid: bool,
    pub recovered_fields: Vec<String>,
}

impl From<ReadPreferencesResult> for PreferencesSnapshot {
    fn from(result: ReadPreferencesResult) -> Self {
        Self {
            preferences: result.preferences,
            invalid: result.invalid,
            recovered_fields: result
                .recovered_fields
                .into_iter()
                .map(|key| key.as_str().to_owned())
                .collect(),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreferenceSetRequest {
    pub key: String,
    pub value: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreferencesImportRequest {
    pub legacy_record: BTreeMap<String, Value>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreferencesImportReceipt {
    pub preferences: Preferences,
    pub invalid: bool,
    pub recovered_fields: Vec<String>,
    pub imported: bool,
    pub already_imported: bool,
    pub legacy_electron_found: bool,
    pub remaining_electron_settings: Vec<String>,
}

struct LegacyElectronSettings {
    source_directory: PathBuf,
    preferences: BTreeMap<String, Value>,
    remaining_fields: Vec<String>,
}

fn read_preferences(state: &FrontendFilesState) -> Result<PreferencesSnapshot, String> {
    state
        .service()
        .read_preferences()
        .map(PreferencesSnapshot::from)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn frontend_settings_read(
    window: WebviewWindow,
    state: State<'_, FrontendFilesState>,
) -> Result<PreferencesSnapshot, String> {
    let _owner = verify_trusted_window(&window, &state)?;
    read_preferences(&state)
}

#[tauri::command]
pub fn frontend_settings_set(
    window: WebviewWindow,
    state: State<'_, FrontendFilesState>,
    request: PreferenceSetRequest,
) -> Result<PreferencesSnapshot, String> {
    let _owner = verify_trusted_window(&window, &state)?;
    let key = PreferenceKey::from_key_or_prefixed(&request.key)
        .ok_or_else(|| "invalid preference key".to_owned())?;
    let value = decode_preference_value(key, &request.value).map_err(|error| error.to_string())?;
    state
        .service()
        .set_preference(value)
        .map_err(|error| error.to_string())?;
    read_preferences(&state)
}

#[tauri::command]
pub fn frontend_settings_reset(
    window: WebviewWindow,
    state: State<'_, FrontendFilesState>,
) -> Result<PreferencesSnapshot, String> {
    let _owner = verify_trusted_window(&window, &state)?;
    state
        .service()
        .restore_default_preferences()
        .map(PreferencesSnapshot::from)
        .map_err(|error| error.to_string())
}

fn map_electron_settings(object: &Map<String, Value>) -> (BTreeMap<String, Value>, Vec<String>) {
    let mut mapped = BTreeMap::<PreferenceKey, Value>::new();
    let mut consumed = HashSet::<String>::new();

    for key in PreferenceKey::ALL {
        if let Some(value) = object.get(key.as_str()) {
            if decode_preference_value(key, value).is_ok() {
                mapped.insert(key, value.clone());
                consumed.insert(key.as_str().to_owned());
            }
        }
    }

    fn map_alias(
        object: &Map<String, Value>,
        key: PreferenceKey,
        alias: &str,
        mapped: &mut BTreeMap<PreferenceKey, Value>,
        consumed: &mut HashSet<String>,
    ) {
        if mapped.contains_key(&key) {
            return;
        }
        let Some(value) = object.get(alias) else {
            return;
        };
        if decode_preference_value(key, value).is_ok() {
            mapped.insert(key, value.clone());
            consumed.insert(alias.to_owned());
        }
    }

    map_alias(
        object,
        PreferenceKey::Language,
        "uiLocale",
        &mut mapped,
        &mut consumed,
    );
    map_alias(
        object,
        PreferenceKey::WrapLines,
        "sourceLineWrap",
        &mut mapped,
        &mut consumed,
    );
    map_alias(
        object,
        PreferenceKey::Appearance,
        "uiTheme",
        &mut mapped,
        &mut consumed,
    );

    let preferences = mapped
        .into_iter()
        .map(|(key, value)| (key.as_str().to_owned(), value))
        .collect();
    let mut remaining_fields = object
        .keys()
        .filter(|key| !consumed.contains(*key))
        .cloned()
        .collect::<Vec<_>>();
    remaining_fields.sort();
    (preferences, remaining_fields)
}

/// The released Electron product explicitly used `%APPDATA%/modutex-desktop/settings.json`.
/// Do not inspect arbitrary directories, the development override, or user documents.
fn read_legacy_electron_settings() -> Result<Option<LegacyElectronSettings>, String> {
    let Some(app_data) = env::var_os("APPDATA") else {
        return Ok(None);
    };
    let source_directory = PathBuf::from(app_data).join("modutex-desktop");
    let source_file = source_directory.join("settings.json");
    let Some(bytes) =
        bounded_read_store_bytes(&source_file, &source_directory, MAX_SETTINGS_STORE_BYTES)
            .map_err(|error| error.to_string())?
    else {
        return Ok(None);
    };

    // Electron's own reader accepted a UTF-8 BOM. Keep that compatibility while
    // leaving the source file untouched.
    let json = bytes.strip_prefix(b"\xef\xbb\xbf").unwrap_or(&bytes);
    let value: Value = serde_json::from_slice(json)
        .map_err(|_| "invalid legacy Electron settings JSON".to_owned())?;
    let object = value
        .as_object()
        .ok_or_else(|| "legacy Electron settings must be a record".to_owned())?;
    let (preferences, remaining_fields) = map_electron_settings(object);
    Ok(Some(LegacyElectronSettings {
        source_directory,
        preferences,
        remaining_fields,
    }))
}

fn validate_local_storage_record(record: &BTreeMap<String, Value>) -> Result<(), String> {
    if record.len() > PreferenceKey::ALL.len() * 2 {
        return Err("too many legacy preference fields".to_owned());
    }
    let mut total_bytes = 0usize;
    for (key, value) in record {
        if PreferenceKey::from_key_or_prefixed(key).is_none() {
            return Err("invalid legacy preference key".to_owned());
        }
        let encoded = serde_json::to_vec(value).map_err(|_| "invalid legacy preference value")?;
        total_bytes = total_bytes
            .checked_add(encoded.len())
            .ok_or_else(|| "legacy preference import exceeds its byte limit".to_owned())?;
        if total_bytes as u64 > MAX_SETTINGS_STORE_BYTES {
            return Err("legacy preference import exceeds its byte limit".to_owned());
        }
    }
    Ok(())
}

fn import_receipt(
    snapshot: PreferencesSnapshot,
    imported: Option<ImportPreferencesResult>,
    legacy_electron_found: bool,
    remaining_electron_settings: Vec<String>,
) -> PreferencesImportReceipt {
    let already_imported = imported
        .as_ref()
        .is_some_and(|result| result.already_imported);
    PreferencesImportReceipt {
        preferences: snapshot.preferences,
        invalid: snapshot.invalid,
        recovered_fields: snapshot.recovered_fields,
        imported: imported.is_some() && !already_imported,
        already_imported,
        legacy_electron_found,
        remaining_electron_settings,
    }
}

#[tauri::command]
pub fn frontend_settings_import(
    window: WebviewWindow,
    state: State<'_, FrontendFilesState>,
    request: PreferencesImportRequest,
) -> Result<PreferencesImportReceipt, String> {
    let _owner = verify_trusted_window(&window, &state)?;
    validate_local_storage_record(&request.legacy_record)?;
    let store = state.service().settings_store();
    if bounded_read_store_bytes(
        &store.store_path(),
        store.data_dir(),
        MAX_SETTINGS_STORE_BYTES,
    )
    .map_err(|error| error.to_string())?
    .is_some()
    {
        let imported = state
            .service()
            .import_legacy_preferences(&BTreeMap::new(), None)
            .map_err(|error| error.to_string())?;
        return Ok(import_receipt(
            read_preferences(&state)?,
            Some(imported),
            false,
            Vec::new(),
        ));
    }

    let electron = read_legacy_electron_settings()?;
    let legacy_electron_found = electron.is_some();
    let mut remaining_electron_settings = Vec::new();
    let mut legacy_source_directory = None;
    let mut legacy_record = request.legacy_record;
    if let Some(electron) = electron {
        remaining_electron_settings = electron.remaining_fields;
        legacy_source_directory = Some(electron.source_directory);
        for (key, value) in electron.preferences {
            legacy_record.entry(key).or_insert(value);
        }
    }

    if legacy_record.is_empty() && !legacy_electron_found {
        return Ok(import_receipt(
            read_preferences(&state)?,
            None,
            false,
            Vec::new(),
        ));
    }

    let imported = state
        .service()
        .import_legacy_preferences(&legacy_record, legacy_source_directory.as_deref())
        .map_err(|error| error.to_string())?;
    let snapshot = read_preferences(&state)?;
    Ok(import_receipt(
        snapshot,
        Some(imported),
        legacy_electron_found,
        remaining_electron_settings,
    ))
}

#[cfg(test)]
#[path = "../../tests/unit/frontend_settings.rs"]
mod tests;
