// SPDX-License-Identifier: Apache-2.0
use super::*;
use crate::compile_config::CompileProfile;
use serde_json::json;

#[test]
fn compile_config_update_rejects_unknown_fields_and_control_characters_in_custom_command() {
    let valid: CompileConfigUpdate = serde_json::from_value(json!({
        "workspaceId": "ws-1",
        "expectedRevision": 1,
        "mainFile": "main.tex",
        "profile": "custom",
        "outputDir": "build",
        "pdf": "build/main.pdf",
        "log": "build/main.log",
        "customCommand": "latexmk -pdf -outdir={out} {main}"
    }))
    .expect("valid CompileConfigUpdate");
    assert_eq!(valid.profile, CompileProfile::Custom);

    let unknown_field = serde_json::from_value::<CompileConfigUpdate>(json!({
        "workspaceId": "ws-1",
        "expectedRevision": 1,
        "mainFile": null,
        "profile": "managed",
        "outputDir": null,
        "pdf": null,
        "log": null,
        "customCommand": null,
        "extra": true
    }));
    assert!(unknown_field.is_err());

    let control_char = serde_json::from_value::<CompileConfigUpdate>(json!({
        "workspaceId": "ws-1",
        "expectedRevision": 1,
        "mainFile": null,
        "profile": "custom",
        "outputDir": null,
        "pdf": null,
        "log": null,
        "customCommand": "latexmk\u{0007} {main} {out}"
    }));
    assert!(control_char.is_err());
}

#[test]
fn ui_compile_origin_always_allows_setting_command() {
    assert!(!CompileOrigin::Ui.is_mcp());
    assert!(CompileOrigin::Ui.can_set_command(false));
    assert!(CompileOrigin::Ui.can_set_command(true));
}
