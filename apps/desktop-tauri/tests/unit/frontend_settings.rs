use super::{map_electron_settings, validate_local_storage_record, PreferenceSetRequest};
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;

#[test]
fn legacy_values_map_only_supported_fields_without_promoting_compile_commands() {
    let source = json!({"uiLocale":"en","sourceLineWrap":true,"compileCommand":"untrusted command","mcpEnabled":true});
    let (mapped, remaining) = map_electron_settings(source.as_object().unwrap());
    assert_eq!(mapped.get("language"), Some(&json!("en")));
    assert_eq!(mapped.get("wrapLines"), Some(&json!(true)));
    assert!(!mapped.contains_key("compileCommand"));
    assert_eq!(remaining, vec!["compileCommand", "mcpEnabled"]);
}

#[test]
fn invalid_legacy_values_cannot_replace_valid_current_fields() {
    let source: Map<String, Value> = serde_json::from_value(
        json!({"language":"en","uiLocale":"zh-Hant","sourceFontSize":999,"sourceLineWrap":"true"}),
    )
    .unwrap();
    let (mapped, remaining) = map_electron_settings(&source);
    assert_eq!(mapped.get("language"), Some(&json!("en")));
    assert!(!mapped.contains_key("sourceFontSize"));
    assert!(!mapped.contains_key("wrapLines"));
    assert!(remaining.contains(&"sourceFontSize".to_owned()));
}

#[test]
fn import_record_rejects_unknown_fields_and_oversized_values() {
    let unknown = BTreeMap::from([("absolutePath".to_owned(), json!("C:/outside"))]);
    assert!(validate_local_storage_record(&unknown).is_err());
    let oversized = BTreeMap::from([("language".to_owned(), json!("x".repeat(65537)))]);
    assert!(validate_local_storage_record(&oversized).is_err());
    let accepted = BTreeMap::from([(
        "modutex.frontend.preferences.v1.language".to_owned(),
        json!("\"en\""),
    )]);
    assert!(validate_local_storage_record(&accepted).is_ok());
    assert!(serde_json::from_value::<PreferenceSetRequest>(
        json!({"key":"language","value":"en","owner":"foreign"})
    )
    .is_err());
}
