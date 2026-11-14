// SPDX-License-Identifier: Apache-2.0
use serde_json::Value;

const UPDATER_PERMISSIONS: &[&str] = &[
    "updater:allow-check",
    "updater:allow-download",
    "updater:allow-install",
];

#[test]
fn main_capability_is_the_exact_local_g2345_and_updater_union() {
    let capability: Value =
        serde_json::from_str(include_str!("../../capabilities/main.json")).unwrap();
    assert_eq!(capability["local"], true);
    assert_eq!(
        capability["windows"],
        serde_json::json!(["main", "document-*"])
    );

    let actual = capability["permissions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|value| value.as_str().unwrap().to_owned())
        .collect::<Vec<_>>();
    let mut actual = actual;
    actual.sort();

    let mut expected = vec![
        "allow-host-health".to_owned(),
        "allow-frontend-new-window".to_owned(),
        "allow-frontend-pending-open".to_owned(),
        "allow-frontend-files".to_owned(),
        "allow-frontend-compile".to_owned(),
        "allow-frontend-source-format".to_owned(),
        "allow-frontend-compile-config".to_owned(),
        "allow-frontend-settings".to_owned(),
        "allow-frontend-terminal".to_owned(),
        "allow-frontend-workspace-files".to_owned(),
        "allow-frontend-git".to_owned(),
        "allow-frontend-draft".to_owned(),
        "core:event:allow-listen".to_owned(),
        "core:event:allow-unlisten".to_owned(),
        "core:window:allow-close".to_owned(),
        "core:window:allow-destroy".to_owned(),
        "core:resources:allow-close".to_owned(),
        "dialog:allow-message".to_owned(),
    ];
    expected.extend(
        UPDATER_PERMISSIONS
            .iter()
            .map(|permission| (*permission).to_owned()),
    );
    expected.sort();
    assert_eq!(actual, expected);
}

