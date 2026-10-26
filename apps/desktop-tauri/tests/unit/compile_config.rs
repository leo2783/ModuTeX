// SPDX-License-Identifier: Apache-2.0
//! Native temporary-workspace persistence, snapshot exclusion, and output
//! transaction tests. The staging generator does not run these tests.

#![cfg(all(windows, target_arch = "x86_64"))]

use std::{
    fs,
    path::{Path, PathBuf},
    sync::Arc,
};

use crate::{
    compile_config::{CompileConfigStore, CompileConfigUpdate, CompileOrigin, CompileProfile},
    schemas::protocol::{
        CompileRequest, DocumentId, DocumentVersion, Engine, FileRef, OwnerId, Revision, RunId,
        Timestamp, WorkspaceId,
    },
    services::filesystem::{
        CompileInputLimits, CompileOutputFile, CompileOutputKind, FilesystemError,
        FilesystemService,
    },
    shared::relative_path::RelativePath,
    state::{
        recent::RecentStore, sessions::SessionRegistry, settings::SettingsStore,
        workspace_leases::WorkspaceLeaseCoordinator,
    },
};

struct TempTree(PathBuf);

impl TempTree {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "modutex-compile-config-{}",
            uuid::Uuid::new_v4().simple()
        ));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }

    fn child(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }
}

impl Drop for TempTree {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn filesystem(data: &Path) -> Arc<FilesystemService> {
    Arc::new(FilesystemService::new(
        Arc::new(SessionRegistry::new()),
        WorkspaceLeaseCoordinator::new(),
        RecentStore::new(data.join("recent")),
        SettingsStore::new(data.join("settings")),
    ))
}

fn workspace(
    filesystem: &FilesystemService,
    owner: &OwnerId,
    root: &Path,
) -> crate::schemas::protocol::WorkspaceInfo {
    let opened = filesystem
        .open_workspace_folder(
            owner,
            root,
            Some(RelativePath::parse("main.tex").unwrap()),
            Timestamp::new(1).unwrap(),
        )
        .unwrap();
    opened.opened
}

fn config_update(workspace_id: WorkspaceId, revision: u64) -> CompileConfigUpdate {
    CompileConfigUpdate {
        workspace_id,
        expected_revision: revision,
        main_file: Some(RelativePath::parse("main.tex").unwrap()),
        profile: CompileProfile::Managed,
        output_dir: Some(RelativePath::parse("build").unwrap()),
        pdf_path: None,
        log_path: None,
        custom_command: None,
    }
}

#[test]
fn compile_configuration_persists_by_trusted_owner_and_canonical_workspace() {
    let temp = TempTree::new();
    let root = temp.child("project");
    let data = temp.child("data");
    fs::create_dir_all(root.join("build")).unwrap();
    fs::create_dir_all(&data).unwrap();
    fs::write(root.join("main.tex"), b"\\documentclass{article}\n").unwrap();

    let filesystem = filesystem(&data);
    let owner = OwnerId::from_label("main").unwrap();
    let opened = workspace(&filesystem, &owner, &root);
    let store = CompileConfigStore::new(data.clone());

    let first = store
        .update(
            &filesystem,
            &owner,
            config_update(opened.id.clone(), 0),
            CompileOrigin::Ui,
        )
        .unwrap();
    assert_eq!(first.revision, 1);
    assert_eq!(first.main_file.as_ref().unwrap().as_str(), "main.tex");
    assert_eq!(first.output_dir.as_ref().unwrap().as_str(), "build");

    let reopened_store = CompileConfigStore::new(data.clone());
    let reopened = reopened_store
        .view_for_workspace(&filesystem, &owner, &opened.id, CompileOrigin::Ui)
        .unwrap();
    assert_eq!(reopened, first);

    let other_owner = OwnerId::from_label("side").unwrap();
    let other =
        reopened_store.view_for_workspace(&filesystem, &other_owner, &opened.id, CompileOrigin::Ui);
    assert!(
        other.is_err(),
        "a different owner cannot borrow the workspace capability"
    );

    let conflict = reopened_store.update(
        &filesystem,
        &owner,
        config_update(opened.id.clone(), 0),
        CompileOrigin::Ui,
    );
    assert_eq!(conflict.unwrap_err(), "CONFIG_CONFLICT");
    filesystem.close_workspace(&owner, &opened.id).unwrap();
}

#[test]
fn separate_mcp_command_permission_is_persisted_and_default_off() {
    let temp = TempTree::new();
    let settings = SettingsStore::new(temp.child("settings"));
    assert!(!settings.mcp_compile_command_allowed().unwrap());
    assert!(settings.set_mcp_compile_command_allowed(true).unwrap());
    assert!(SettingsStore::new(temp.child("settings"))
        .mcp_compile_command_allowed()
        .unwrap());
    assert!(!settings.set_mcp_compile_command_allowed(false).unwrap());
    assert!(!settings.mcp_compile_command_allowed().unwrap());
}

fn compile_ticket(
    filesystem: &FilesystemService,
    owner: &OwnerId,
    workspace_id: WorkspaceId,
) -> (crate::services::filesystem::CompileLeaseTicket, Revision) {
    let entry = RelativePath::parse("main.tex").unwrap();
    let receipt = filesystem
        .read_file(
            owner,
            &FileRef {
                workspace_id: workspace_id.clone(),
                path: entry.clone(),
            },
        )
        .unwrap();
    let request = CompileRequest {
        workspace_id,
        entry_path: entry,
        document_id: DocumentId::parse("doc-one").unwrap(),
        document_version: DocumentVersion::new(0).unwrap(),
        saved_revision: receipt.revision.clone(),
        engine: Engine::Managed,
    };
    let ticket = filesystem
        .prepare_compile(
            owner,
            RunId::parse("run-one").unwrap(),
            &request,
            Box::new(|| Ok(())),
        )
        .unwrap();
    (ticket, receipt.revision)
}

#[test]
fn configured_output_directory_is_excluded_from_compile_snapshots_and_outputs_commit() {
    let temp = TempTree::new();
    let root = temp.child("project");
    let data = temp.child("data");
    fs::create_dir_all(root.join("build")).unwrap();
    fs::create_dir_all(&data).unwrap();
    fs::write(root.join("main.tex"), b"\\documentclass{article}\n").unwrap();
    fs::write(root.join("build/old.pdf"), b"%PDF-old").unwrap();

    let filesystem = filesystem(&data);
    let owner = OwnerId::from_label("main").unwrap();
    let opened = workspace(&filesystem, &owner, &root);
    let (mut ticket, _) = compile_ticket(&filesystem, &owner, opened.id.clone());
    let excluded = [RelativePath::parse("build").unwrap()];
    let snapshot = filesystem
        .capture_compile_snapshot_excluding(
            &ticket,
            CompileInputLimits {
                max_depth: 16,
                max_entries: 4096,
                max_file_bytes: 32 * 1024 * 1024,
                max_total_bytes: 64 * 1024 * 1024,
            },
            &excluded,
        )
        .unwrap();
    assert!(snapshot
        .files
        .iter()
        .all(|file| !file.path.as_str().starts_with("build/")));
    filesystem
        .validate_compile_snapshot_excluding(&ticket, &snapshot, &excluded)
        .unwrap();

    filesystem
        .commit_compile_outputs(
            &ticket,
            &[
                CompileOutputFile {
                    path: RelativePath::parse("build/main.pdf").unwrap(),
                    bytes: b"%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n".to_vec(),
                    kind: CompileOutputKind::Pdf,
                },
                CompileOutputFile {
                    path: RelativePath::parse("build/main.log").unwrap(),
                    bytes: b"compile log\n".to_vec(),
                    kind: CompileOutputKind::Log,
                },
            ],
            || false,
        )
        .unwrap();
    ticket.finish_drain_with(|| Ok(())).unwrap();

    let pdf = filesystem
        .read_file(
            &owner,
            &FileRef {
                workspace_id: opened.id.clone(),
                path: RelativePath::parse("build/main.pdf").unwrap(),
            },
        )
        .unwrap();
    assert!(pdf.bytes.starts_with(b"%PDF-"));
    let log = filesystem
        .read_file(
            &owner,
            &FileRef {
                workspace_id: opened.id.clone(),
                path: RelativePath::parse("build/main.log").unwrap(),
            },
        )
        .unwrap();
    assert_eq!(log.bytes, b"compile log\n");
    filesystem.close_workspace(&owner, &opened.id).unwrap();
}

#[test]
fn failed_multi_output_commit_rolls_back_only_outputs_written_by_this_run() {
    let temp = TempTree::new();
    let root = temp.child("project");
    let data = temp.child("data");
    fs::create_dir_all(root.join("build")).unwrap();
    fs::create_dir_all(&data).unwrap();
    fs::write(root.join("main.tex"), b"\\documentclass{article}\n").unwrap();

    let filesystem = filesystem(&data);
    let owner = OwnerId::from_label("main").unwrap();
    let opened = workspace(&filesystem, &owner, &root);
    let (mut ticket, _) = compile_ticket(&filesystem, &owner, opened.id.clone());
    let second = root.join("build/main.log");
    let result = filesystem.commit_compile_outputs_with_hook(
        &ticket,
        &[
            CompileOutputFile {
                path: RelativePath::parse("build/main.pdf").unwrap(),
                bytes: b"%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n".to_vec(),
                kind: CompileOutputKind::Pdf,
            },
            CompileOutputFile {
                path: RelativePath::parse("build/main.log").unwrap(),
                bytes: b"run log\n".to_vec(),
                kind: CompileOutputKind::Log,
            },
        ],
        || false,
        |index, _| {
            if index == 1 {
                fs::write(&second, b"concurrent external file").unwrap();
            }
            Ok(())
        },
    );
    assert!(result.is_err());
    ticket.finish_drain_with(|| Ok(())).unwrap();
    assert!(!root.join("build/main.pdf").exists());
    assert_eq!(fs::read(second).unwrap(), b"concurrent external file");
    filesystem.close_workspace(&owner, &opened.id).unwrap();
}

#[test]
fn compile_output_commit_settles_and_preserves_external_bytes_on_first_target_conflict() {
    let temp = TempTree::new();
    let root = temp.child("project");
    let data = temp.child("data");
    fs::create_dir_all(root.join("build")).unwrap();
    fs::create_dir_all(&data).unwrap();
    fs::write(root.join("main.tex"), b"\\documentclass{article}\n").unwrap();

    let filesystem = filesystem(&data);
    let owner = OwnerId::from_label("main").unwrap();
    let opened = workspace(&filesystem, &owner, &root);
    let (mut ticket, _) = compile_ticket(&filesystem, &owner, opened.id.clone());
    let first = root.join("build/main.pdf");
    let external_bytes = b"concurrent external rewrite of first target";

    let start = std::time::Instant::now();
    let result = filesystem.commit_compile_outputs_with_hook(
        &ticket,
        &[
            CompileOutputFile {
                path: RelativePath::parse("build/main.pdf").unwrap(),
                bytes: b"%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n".to_vec(),
                kind: CompileOutputKind::Pdf,
            },
            CompileOutputFile {
                path: RelativePath::parse("build/main.log").unwrap(),
                bytes: b"run log\n".to_vec(),
                kind: CompileOutputKind::Log,
            },
        ],
        || false,
        |index, _| {
            if index == 1 {
                fs::write(&first, external_bytes).unwrap();
                return Err(FilesystemError::Io(1));
            }
            Ok(())
        },
    );
    assert!(result.is_err());
    assert!(
        start.elapsed() < std::time::Duration::from_secs(5),
        "operation must settle within finite deadline"
    );
    ticket.finish_drain_with(|| Ok(())).unwrap();
    assert_eq!(fs::read(&first).unwrap(), external_bytes);
    filesystem.close_workspace(&owner, &opened.id).unwrap();
}

#[test]
fn compile_config_rejects_typ_and_accepts_uppercase_tex() {
    let make_config = |main: &str| super::CompileWorkspaceConfig {
        revision: 0,
        main_file: Some(RelativePath::parse(main).unwrap()),
        profile: CompileProfile::Managed,
        output_dir: None,
        pdf_path: None,
        log_path: None,
        custom_command: None,
    };

    let typ_config = make_config("main.typ");
    assert_eq!(
        typ_config.validate_internal().unwrap_err(),
        "INVALID_MAIN_FILE"
    );

    let upper_typ_config = make_config("MAIN.TYP");
    assert_eq!(
        upper_typ_config.validate_internal().unwrap_err(),
        "INVALID_MAIN_FILE"
    );

    let upper_tex_config = make_config("MAIN.TEX");
    assert!(upper_tex_config.validate_internal().is_ok());

    let mixed_tex_config = make_config("nested/doc.TeX");
    assert!(mixed_tex_config.validate_internal().is_ok());
}

#[path = "compile_config_origin.rs"]
mod origin_tests;
