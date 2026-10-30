// SPDX-License-Identifier: Apache-2.0
use super::{
    filesystem, workspace, CompileConfigStore, CompileConfigUpdate, CompileOrigin, CompileProfile,
    RelativePath, SettingsStore, TempTree,
};
use crate::{
    compile_config::CompileWorkspaceConfig,
    schemas::protocol::{OwnerId, WorkspaceId},
};
use std::fs;

fn custom_update(workspace_id: WorkspaceId, expected_revision: u64) -> CompileConfigUpdate {
    CompileConfigUpdate {
        workspace_id,
        expected_revision,
        main_file: Some(RelativePath::parse("main.tex").unwrap()),
        profile: CompileProfile::Custom,
        output_dir: None,
        pdf_path: None,
        log_path: None,
        custom_command: Some(format!(
            "\"{}\" {{out}} {{main}}",
            std::env::current_exe().unwrap().display()
        )),
    }
}

#[test]
fn ui_can_save_select_and_prepare_a_custom_run_with_mcp_permission_off() {
    let temp = TempTree::new();
    let root = temp.child("project");
    let data = temp.child("data");
    fs::create_dir_all(&root).unwrap();
    fs::create_dir_all(&data).unwrap();
    fs::write(root.join("main.tex"), b"\\documentclass{article}\n").unwrap();

    let filesystem = filesystem(&data);
    let owner = OwnerId::from_label("main").unwrap();
    let opened = workspace(&filesystem, &owner, &root);
    let store = CompileConfigStore::new(data.clone());
    let settings = SettingsStore::new(data.join("settings"));
    assert!(!settings.mcp_compile_command_allowed().unwrap());

    let saved = store
        .update(
            &filesystem,
            &owner,
            custom_update(opened.id.clone(), 0),
            CompileOrigin::Ui,
        )
        .unwrap();
    assert_eq!(saved.profile, CompileProfile::Custom);
    assert!(saved.can_set_command);
    assert_eq!(saved.revision, 1);
    assert!(!settings.mcp_compile_command_allowed().unwrap());

    let selected = store
        .view_for_workspace(&filesystem, &owner, &opened.id, CompileOrigin::Ui)
        .unwrap();
    assert_eq!(selected.profile, CompileProfile::Custom);
    assert!(selected.can_set_command);
    assert_eq!(
        selected.custom_command.as_deref(),
        saved.custom_command.as_deref()
    );

    let ui_run_allowed = store
        .with_workspace_config(
            &filesystem,
            &owner,
            &opened.id,
            CompileOrigin::Ui,
            |config, custom_command_allowed| {
                assert_eq!(config.profile, CompileProfile::Custom);
                assert!(custom_command_allowed);
                Ok(custom_command_allowed)
            },
        )
        .unwrap();
    assert!(ui_run_allowed);
    assert!(!settings.mcp_compile_command_allowed().unwrap());

    let mcp_view = store
        .view_for_workspace(&filesystem, &owner, &opened.id, CompileOrigin::Mcp)
        .unwrap();
    assert_eq!(mcp_view.profile, CompileProfile::Custom);
    assert!(!mcp_view.can_set_command);

    let denied = store.update(
        &filesystem,
        &owner,
        custom_update(opened.id.clone(), saved.revision),
        CompileOrigin::Mcp,
    );
    assert!(denied.unwrap_err().contains("PERMISSION_DENIED"));

    let mcp_run_allowed = store
        .with_workspace_config(
            &filesystem,
            &owner,
            &opened.id,
            CompileOrigin::Mcp,
            |config, custom_command_allowed| {
                assert_eq!(config.profile, CompileProfile::Custom);
                Ok(custom_command_allowed)
            },
        )
        .unwrap();
    assert!(!mcp_run_allowed);
    assert!(!settings.mcp_compile_command_allowed().unwrap());

    let unchanged = store
        .view_for_workspace(&filesystem, &owner, &opened.id, CompileOrigin::Ui)
        .unwrap();
    assert_eq!(unchanged.revision, saved.revision);
    assert_eq!(unchanged.profile, CompileProfile::Custom);
    filesystem.close_workspace(&owner, &opened.id).unwrap();
}

fn config_with_main(main_file: Option<&str>) -> CompileWorkspaceConfig {
    let main_file = match main_file {
        Some(path) => serde_json::to_string(path).unwrap(),
        None => "null".to_owned(),
    };
    let json = format!(
        r#"{{"revision":0,"mainFile":{},"profile":"managed","outputDir":null,"pdf":null,"log":null,"customCommand":null}}"#,
        main_file
    );
    serde_json::from_str(&json).unwrap()
}

#[test]
fn an_unset_main_resolves_to_the_requested_entry_without_persisting_it() {
    let config = config_with_main(None);
    let requested = RelativePath::parse("chapters/current.tex").unwrap();

    assert_eq!(config.effective_main(&requested), &requested);
    assert!(config.main_file.is_none());
}

#[test]
fn a_stored_main_remains_authoritative_over_the_requested_entry() {
    let config = config_with_main(Some("main.tex"));
    let requested = RelativePath::parse("chapters/current.tex").unwrap();

    assert_eq!(config.effective_main(&requested).as_str(), "main.tex");
    assert_ne!(config.effective_main(&requested), &requested);
}

#[test]
fn mcp_native_admission_keeps_permission_stable_until_the_callback_settles() {
    use std::{
        sync::{mpsc, Arc},
        thread,
        time::Duration,
    };
    let temp = TempTree::new();
    let root = temp.child("project");
    let data = temp.child("data");
    fs::create_dir_all(&root).unwrap();
    fs::create_dir_all(&data).unwrap();
    fs::write(root.join("main.tex"), b"\\documentclass{article}\n").unwrap();
    let filesystem = filesystem(&data);
    let owner = OwnerId::from_label("main").unwrap();
    let opened = workspace(&filesystem, &owner, &root);
    let store = Arc::new(CompileConfigStore::new(data.clone()));
    let settings = Arc::new(SettingsStore::new(data.join("settings")));
    settings.set_mcp_compile_command_allowed(true).unwrap();
    let (entered_tx, entered_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let operation = {
        let filesystem = filesystem.clone();
        let store = store.clone();
        let owner = owner.clone();
        let workspace_id = opened.id.clone();
        thread::spawn(move || {
            store.with_workspace_config(
                &filesystem,
                &owner,
                &workspace_id,
                CompileOrigin::Mcp,
                |_, allowed| {
                    entered_tx.send(allowed).unwrap();
                    release_rx.recv_timeout(Duration::from_secs(5)).unwrap();
                    Ok(allowed)
                },
            )
        })
    };
    assert!(entered_rx.recv_timeout(Duration::from_secs(5)).unwrap());
    let (started_tx, started_rx) = mpsc::channel();
    let (revoked_tx, revoked_rx) = mpsc::channel();
    let revoker = {
        let settings = settings.clone();
        thread::spawn(move || {
            started_tx.send(()).unwrap();
            let result = settings.set_mcp_compile_command_allowed(false);
            revoked_tx.send(result.is_ok()).unwrap();
            result
        })
    };
    started_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    let premature_revoke = revoked_rx.recv_timeout(Duration::from_millis(100));
    release_tx.send(()).unwrap();
    let admission = operation.join().unwrap().unwrap();
    revoker.join().unwrap().unwrap();
    assert!(
        matches!(premature_revoke, Err(mpsc::RecvTimeoutError::Timeout)),
        "permission revocation must wait for the native admission callback"
    );
    assert!(admission);
    assert!(!store
        .with_workspace_config(
            &filesystem,
            &owner,
            &opened.id,
            CompileOrigin::Mcp,
            |_, allowed| Ok(allowed)
        )
        .unwrap());
    filesystem.close_workspace(&owner, &opened.id).unwrap();
}

#[test]
fn rejected_native_route_check_does_not_persist_a_config_update() {
    let temp = TempTree::new();
    let root = temp.child("project");
    let data = temp.child("data");
    fs::create_dir_all(&root).unwrap();
    fs::create_dir_all(&data).unwrap();
    fs::write(root.join("main.tex"), b"\\documentclass{article}\n").unwrap();
    let filesystem = filesystem(&data);
    let owner = OwnerId::from_label("main").unwrap();
    let opened = workspace(&filesystem, &owner, &root);
    let store = CompileConfigStore::new(data.clone());
    SettingsStore::new(data.join("settings"))
        .set_mcp_compile_command_allowed(true)
        .unwrap();
    let result = store.update_checked(
        &filesystem,
        &owner,
        custom_update(opened.id.clone(), 0),
        CompileOrigin::Mcp,
        || Err("STALE_OWNER".to_owned()),
    );
    assert!(result.unwrap_err().contains("STALE_OWNER"));
    let current = store
        .view_for_workspace(&filesystem, &owner, &opened.id, CompileOrigin::Ui)
        .unwrap();
    assert_eq!(current.revision, 0);
    assert_eq!(current.profile, CompileProfile::Managed);
    assert_eq!(current.custom_command, None);
    filesystem.close_workspace(&owner, &opened.id).unwrap();
}

#[test]
fn mcp_paths_origin_can_update_output_paths_with_custom_profile_when_command_unchanged() {
    let temp = TempTree::new();
    let root = temp.child("project");
    let data = temp.child("data");
    fs::create_dir_all(&root).unwrap();
    fs::create_dir_all(&data).unwrap();
    fs::write(root.join("main.tex"), b"\\documentclass{article}\n").unwrap();

    let filesystem = filesystem(&data);
    let owner = OwnerId::from_label("main").unwrap();
    let opened = workspace(&filesystem, &owner, &root);
    let store = CompileConfigStore::new(data.clone());
    let settings = SettingsStore::new(data.join("settings"));
    assert!(!settings.mcp_compile_command_allowed().unwrap());

    let saved = store
        .update(
            &filesystem,
            &owner,
            custom_update(opened.id.clone(), 0),
            CompileOrigin::Ui,
        )
        .unwrap();
    assert_eq!(saved.revision, 1);
    assert_eq!(saved.profile, CompileProfile::Custom);

    let mut paths_update = custom_update(opened.id.clone(), saved.revision);
    paths_update.pdf_path = Some(RelativePath::parse("custom.pdf").unwrap());

    let updated = store
        .update(&filesystem, &owner, paths_update, CompileOrigin::McpPaths)
        .unwrap();
    assert_eq!(updated.revision, 2);
    assert_eq!(updated.profile, CompileProfile::Custom);
    assert_eq!(updated.custom_command, saved.custom_command);
    assert_eq!(
        updated.pdf_path,
        Some(RelativePath::parse("custom.pdf").unwrap())
    );
    assert!(!updated.can_set_command);

    let mut escalating = custom_update(opened.id.clone(), updated.revision);
    escalating.custom_command = Some(format!(
        "\"{}\" --escalated {{out}} {{main}}",
        std::env::current_exe().unwrap().display()
    ));
    let denied = store.update(&filesystem, &owner, escalating, CompileOrigin::McpPaths);
    assert!(denied.unwrap_err().contains("PERMISSION_DENIED"));
    filesystem.close_workspace(&owner, &opened.id).unwrap();
}
