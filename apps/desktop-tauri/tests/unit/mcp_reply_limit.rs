// SPDX-License-Identifier: Apache-2.0
use super::bounded_value_size;

#[test]
fn accepted_source_limit_survives_the_renderer_reply_boundary() {
    let value = serde_json::json!({
        "text": "x".repeat(5 * 1024 * 1024),
        "dirty": true
    });
    let wire_bytes = serde_json::to_vec(&value).expect("serialize accepted source");
    assert!(wire_bytes.len() < 6 * 1024 * 1024);
    assert!(bounded_value_size(&value, 0, &mut 0, &mut 0));
}

#[test]
fn escaped_source_is_bounded_by_its_real_wire_size() {
    let value = serde_json::json!({"text": "\u{0001}".repeat(11 * 1024 * 1024)});
    assert!(serde_json::to_vec(&value).unwrap().len() > 64 * 1024 * 1024);
    assert!(!bounded_value_size(&value, 0, &mut 0, &mut 0));
}

#[test]
fn accepted_multibyte_non_ascii_source_survives_reply_boundary() {
    let value = serde_json::json!({
        "text": "é".repeat(2560 * 1024),
        "dirty": false
    });
    let wire_bytes = serde_json::to_vec(&value).expect("serialize multibyte source");
    assert!(wire_bytes.len() <= 6 * 1024 * 1024);
    assert!(bounded_value_size(&value, 0, &mut 0, &mut 0));
}

#[test]
fn worstcase_control_escapes_supported_within_ceiling() {
    let value = serde_json::json!({
        "text": "\u{0001}".repeat(5 * 1024 * 1024),
        "dirty": true
    });
    let wire_bytes = serde_json::to_vec(&value).expect("serialize worstcase escaped source");
    assert!(wire_bytes.len() > 30 * 1024 * 1024);
    assert!(wire_bytes.len() <= 64 * 1024 * 1024);
    assert!(bounded_value_size(&value, 0, &mut 0, &mut 0));
}

#[test]
fn raw_source_overlimit_is_rejected() {
    let value = serde_json::json!({
        "text": "x".repeat(65 * 1024 * 1024)
    });
    assert!(!bounded_value_size(&value, 0, &mut 0, &mut 0));
}

#[test]
fn recursion_depth_exceeding_limit_is_rejected() {
    let mut value = serde_json::json!("leaf");
    for _ in 0..33 {
        value = serde_json::json!([value]);
    }
    assert!(!bounded_value_size(&value, 0, &mut 0, &mut 0));
}

#[test]
fn node_count_exceeding_limit_is_rejected() {
    let inner: Vec<serde_json::Value> = (0..2001).map(|i| serde_json::json!(i)).collect();
    let outer: Vec<serde_json::Value> = (0..10)
        .map(|_| serde_json::Value::Array(inner.clone()))
        .collect();
    let value = serde_json::Value::Array(outer);
    assert!(!bounded_value_size(&value, 0, &mut 0, &mut 0));
}

#[test]
fn array_items_exceeding_limit_is_rejected() {
    let items: Vec<serde_json::Value> = (0..4097).map(|i| serde_json::json!(i)).collect();
    let value = serde_json::Value::Array(items);
    assert!(!bounded_value_size(&value, 0, &mut 0, &mut 0));
}

#[test]
fn object_key_length_exceeding_limit_is_rejected() {
    let long_key = "k".repeat(4097);
    let mut map = serde_json::Map::new();
    map.insert(long_key, serde_json::json!(1));
    let value = serde_json::Value::Object(map);
    assert!(!bounded_value_size(&value, 0, &mut 0, &mut 0));
}
