// SPDX-License-Identifier: Apache-2.0
use super::*;
use serde_json::json;
use std::{
    env,
    sync::{
        atomic::{AtomicUsize, Ordering},
        mpsc,
    },
    thread,
};
use uuid::Uuid;

struct TempDirGuard {
    path: PathBuf,
}

impl TempDirGuard {
    fn new(prefix: &str) -> Self {
        let dir = env::temp_dir().join(format!(
            "modutex-g2-settings-{prefix}-{}-{}",
            std::process::id(),
            Uuid::new_v4()
        ));
        fs::create_dir_all(&dir).expect("create temp test dir");
        Self { path: dir }
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TempDirGuard {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

#[test]
fn default_preferences_and_ranges_match_frontend_contract() {
    let temp = TempDirGuard::new("defaults");
    let store = SettingsStore::new(temp.path().join("host-settings"));

    let initial = store
        .read_preferences()
        .expect("read missing returns defaults");
    assert!(!initial.invalid);
    assert_eq!(initial.preferences, Preferences::default());
    assert_eq!(
        effective_appearance(initial.preferences.appearance, true),
        EffectiveAppearance::Dark
    );
    assert_eq!(
        effective_appearance(initial.preferences.appearance, false),
        EffectiveAppearance::Light
    );

    // Boundary font sizes 12 and 24 are accepted; 11 and 25 are rejected.
    assert!(store
        .set_preference(PreferenceValue::SourceFontSize(12))
        .is_ok());
    assert!(store
        .set_preference(PreferenceValue::SourceFontSize(24))
        .is_ok());
    assert_eq!(
        store
            .set_preference(PreferenceValue::SourceFontSize(11))
            .unwrap_err()
            .code(),
        SettingsErrorCode::InvalidPreference
    );
    assert_eq!(
        store
            .set_preference(PreferenceValue::SourceFontSize(25))
            .unwrap_err()
            .code(),
        SettingsErrorCode::InvalidPreference
    );
}

#[test]
fn valid_preference_fields_survive_corrupt_peer_fields() {
    let temp = TempDirGuard::new("corrupt-peer");
    let data_dir = temp.path().join("host-settings");
    fs::create_dir_all(&data_dir).expect("create data_dir");
    let store = SettingsStore::new(&data_dir);

    // Write a v1 settings file where language, appearance, showLineNumbers, and compileShortcut
    // are valid non-defaults, while sourceFontSize (99) and wrapLines ("not-a-bool") are corrupt.
    let mixed = json!({
        "version": 1,
        "preferences": {
            "language": "en",
            "appearance": "dark",
            "sourceFontSize": 99,
            "showLineNumbers": false,
            "wrapLines": "corrupt-boolean",
            "compileShortcut": "mod-shift-b"
        }
    });
    fs::write(
        store.store_path(),
        serde_json::to_vec_pretty(&mixed).expect("encode"),
    )
    .expect("write mixed settings");

    let result = store
        .read_preferences()
        .expect("read with per-field recovery");
    assert!(result.invalid);
    assert_eq!(result.preferences.language, Language::En);
    assert_eq!(result.preferences.appearance, Appearance::Dark);
    assert_eq!(
        result.preferences.source_font_size,
        DEFAULT_SOURCE_FONT_SIZE
    );
    assert!(!result.preferences.show_line_numbers);
    assert!(!result.preferences.wrap_lines);
    assert_eq!(
        result.preferences.compile_shortcut,
        CompileShortcut::ModShiftB
    );
    assert_eq!(
        result.recovered_fields,
        vec![PreferenceKey::SourceFontSize, PreferenceKey::WrapLines]
    );
}

#[test]
fn malformed_top_level_schema_and_oversize_preserve_old_bytes_on_failed_write() {
    let temp = TempDirGuard::new("malformed-preserve");
    let data_dir = temp.path().join("host-settings");
    fs::create_dir_all(&data_dir).expect("create data_dir");
    let store = SettingsStore::new(&data_dir);
    let store_path = store.store_path();

    let bad_cases = [
        b"{not-json".to_vec(),
        serde_json::to_vec(&json!({"version": 2, "preferences": {}})).expect("v2"),
        serde_json::to_vec(&json!({"version": 1, "preferences": {}, "extra": 1})).expect("extra"),
    ];

    for raw in bad_cases {
        fs::write(&store_path, &raw).expect("write bad settings");
        assert_eq!(
            store.read_preferences().unwrap_err().code(),
            SettingsErrorCode::MalformedSchema
        );
        // Attempting to save or set_preference must NOT destroy the malformed file silently.
        assert_eq!(
            store
                .set_preference(PreferenceValue::Language(Language::En))
                .unwrap_err()
                .code(),
            SettingsErrorCode::MalformedSchema
        );
        assert_eq!(fs::read(&store_path).expect("old bytes intact"), raw);
    }

    let oversize = vec![b' '; (MAX_SETTINGS_STORE_BYTES as usize) + 512];
    fs::write(&store_path, &oversize).expect("write oversize");
    assert_eq!(
        store.read_preferences().unwrap_err().code(),
        SettingsErrorCode::OversizeStore
    );
    assert_eq!(
        fs::read(&store_path).expect("oversize intact").len(),
        oversize.len()
    );
}

#[test]
fn concurrent_independent_settings_store_instances_preserve_all_field_updates() {
    let temp = TempDirGuard::new("concurrent-settings");
    let data_dir = temp.path().join("shared-settings");

    let updates = vec![
        PreferenceValue::Language(Language::En),
        PreferenceValue::Appearance(Appearance::Dark),
        PreferenceValue::SourceFontSize(20),
        PreferenceValue::ShowLineNumbers(false),
        PreferenceValue::WrapLines(true),
        PreferenceValue::CompileShortcut(CompileShortcut::None),
    ];

    let mut handles = Vec::new();
    for update in updates {
        let dir_clone = data_dir.clone();
        handles.push(thread::spawn(move || {
            let independent_store = SettingsStore::new(dir_clone);
            independent_store
                .set_preference(update)
                .expect("concurrent set_preference");
        }));
    }

    for h in handles {
        h.join().expect("join thread");
    }

    let final_state = SettingsStore::new(&data_dir)
        .read_preferences()
        .expect("read final preferences");
    assert!(!final_state.invalid);
    assert_eq!(
        final_state.preferences,
        Preferences {
            language: Language::En,
            appearance: Appearance::Dark,
            source_font_size: 20,
            show_line_numbers: false,
            wrap_lines: true,
            compile_shortcut: CompileShortcut::None,
        }
    );
}

#[test]
fn first_settings_write_keeps_one_lock_across_parent_creation() {
    let temp = TempDirGuard::new("first-write-lock");
    let data_dir = temp.path().join("not-created-yet");
    let store_path = data_dir.join(SETTINGS_STORE_FILENAME);
    let lock_before = acquire_settings_lock(&store_path);
    let first_store = SettingsStore::new(&data_dir);
    let (entered_tx, entered_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let first = thread::spawn(move || {
        first_store.set_preference_with_renamer(
            PreferenceValue::Language(Language::En),
            |from, to| {
                entered_tx.send(()).expect("signal first writer");
                release_rx.recv().expect("release first writer");
                fs::rename(from, to)
            },
        )
    });

    entered_rx
        .recv_timeout(std::time::Duration::from_secs(2))
        .expect("first writer reached atomic replacement");
    let lock_after = acquire_settings_lock(&store_path);
    assert!(Arc::ptr_eq(&lock_before, &lock_after));
    assert!(
        lock_after.try_lock().is_err(),
        "first writer still owns lock"
    );

    let second_store = SettingsStore::new(&data_dir);
    let second = thread::spawn(move || {
        second_store.set_preference(PreferenceValue::CompileShortcut(CompileShortcut::None))
    });
    release_tx.send(()).expect("release first writer");
    first
        .join()
        .expect("join first writer")
        .expect("first save");
    second
        .join()
        .expect("join second writer")
        .expect("second save");

    let final_state = SettingsStore::new(&data_dir)
        .read_preferences()
        .expect("read final preferences")
        .preferences;
    assert_eq!(final_state.language, Language::En);
    assert_eq!(final_state.compile_shortcut, CompileShortcut::None);
}

#[test]
fn atomic_retry_and_failure_leave_no_orphan_temp_and_preserve_old_bytes() {
    let temp = TempDirGuard::new("atomic-retry-settings");
    let data_dir = temp.path().join("host-settings");
    let store = SettingsStore::new(&data_dir);

    store
        .set_preference(PreferenceValue::Language(Language::En))
        .expect("initial write");
    let baseline_bytes = fs::read(store.store_path()).expect("read baseline");

    let foreign_tmp = data_dir.join(".frontend-settings-v1.json.tmp-other");
    fs::write(&foreign_tmp, b"keep-me").expect("write foreign tmp");

    let tries = AtomicUsize::new(0);
    store
        .set_preference_with_renamer(PreferenceValue::SourceFontSize(18), |from, to| {
            let n = tries.fetch_add(1, Ordering::SeqCst) + 1;
            if n < 3 {
                return Err(io::Error::from_raw_os_error(5)); // ERROR_ACCESS_DENIED
            }
            fs::rename(from, to)
        })
        .expect("succeeds on 3rd attempt");
    assert_eq!(tries.load(Ordering::SeqCst), 3);
    let updated_bytes = fs::read(store.store_path()).expect("read updated");
    assert_ne!(updated_bytes, baseline_bytes);

    // Exhaust all retries: old bytes preserved, own temp cleaned up, foreign temp untouched.
    let fail_tries = AtomicUsize::new(0);
    let err = store
        .set_preference_with_renamer(
            PreferenceValue::Appearance(Appearance::Light),
            |_from, _to| {
                fail_tries.fetch_add(1, Ordering::SeqCst);
                Err(io::Error::from_raw_os_error(32))
            },
        )
        .expect_err("must fail after 10 attempts");
    assert_eq!(err.code(), SettingsErrorCode::PersistenceFailed);
    assert_eq!(
        fs::read(store.store_path()).expect("bytes preserved"),
        updated_bytes
    );
    assert!(foreign_tmp.exists());

    let remaining_files: Vec<String> = fs::read_dir(&data_dir)
        .expect("list dir")
        .map(|e| e.expect("entry").file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(remaining_files.len(), 2);
}

#[test]
fn legacy_import_writes_to_separate_dir_without_mutating_source_and_is_idempotent() {
    let temp = TempDirGuard::new("legacy-import");
    let legacy_dir = temp.path().join("legacy-electron-data");
    fs::create_dir_all(&legacy_dir).expect("create legacy dir");
    let legacy_file = legacy_dir.join("legacy-config.json");
    let legacy_raw =
        br#"{"modutex.frontend.preferences.v1.language":"\"en\"","executablePath":"C:\\evil.exe"}"#;
    fs::write(&legacy_file, legacy_raw).expect("write legacy file");

    let mut record = BTreeMap::new();
    record.insert(
        "modutex.frontend.preferences.v1.language".to_owned(),
        json!("\"en\""),
    );
    record.insert(
        "modutex.frontend.preferences.v1.appearance".to_owned(),
        json!("\"dark\""),
    );
    record.insert(
        "modutex.frontend.preferences.v1.sourceFontSize".to_owned(),
        json!("18"),
    );
    record.insert(
        "modutex.frontend.preferences.v1.wrapLines".to_owned(),
        json!("invalid-bool"),
    );
    // Unrelated legacy executable/cache keys must never be copied into the v1 store.
    record.insert("executablePath".to_owned(), json!(r"C:\evil.exe"));
    record.insert("cacheDir".to_owned(), json!(r"C:\legacy-cache"));
    let record_snapshot = record.clone();

    // Rejects importing into the same directory as the legacy source directory.
    let same_dir_store = SettingsStore::new(&legacy_dir);
    assert_eq!(
        same_dir_store
            .import_legacy_record(&record, Some(&legacy_dir))
            .unwrap_err()
            .code(),
        SettingsErrorCode::SameAsLegacyDataDir
    );

    let new_host_dir = temp.path().join("tauri-host-data");
    let store = SettingsStore::new(&new_host_dir);
    let first_import = store
        .import_legacy_record(&record, Some(&legacy_dir))
        .expect("first import");
    assert!(!first_import.already_imported);
    assert!(first_import.invalid); // wrapLines was invalid and recovered to default false
    assert_eq!(first_import.preferences.language, Language::En);
    assert_eq!(first_import.preferences.appearance, Appearance::Dark);
    assert_eq!(first_import.preferences.source_font_size, 18);
    assert!(!first_import.preferences.wrap_lines);

    // Verify legacy source record and legacy directory were not mutated.
    assert_eq!(record, record_snapshot);
    assert_eq!(
        fs::read(&legacy_file).expect("read legacy file"),
        legacy_raw
    );
    let stored_text = fs::read_to_string(store.store_path()).expect("read new store");
    assert!(!stored_text.contains("evil.exe"));
    assert!(!stored_text.contains("legacy-cache"));

    // Retry is idempotent and returns the same preferences.
    let second_import = store
        .import_legacy_record(&record, Some(&legacy_dir))
        .expect("idempotent retry");
    assert!(second_import.already_imported);
    assert_eq!(second_import.preferences, first_import.preferences);
}
