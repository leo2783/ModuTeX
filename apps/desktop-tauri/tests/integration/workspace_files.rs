// SPDX-License-Identifier: Apache-2.0
// Native Windows WorkspaceFiles integration coverage.
#![cfg(all(windows, target_arch = "x86_64"))]

use std::{
    fs,
    io::{self, Write},
    os::windows::{ffi::OsStrExt, fs::MetadataExt},
    path::{Path, PathBuf},
    sync::{atomic::AtomicBool, Arc},
    thread,
};

use modutex_desktop_tauri_lib::{
    platform::windows_files::{FsError, TrustedRoot},
    schemas::protocol::{OwnerId, WorkspaceId},
    shared::relative_path::RelativePath,
    state::{
        workspace_files::WorkspaceFilesState,
        workspace_leases::{
            CanonicalRootPath, RootIdentity, TrustedWorkspaceRoot, WorkspaceLeaseCoordinator,
        },
    },
};
use uuid::Uuid;

struct TempWorkspace(PathBuf);

impl TempWorkspace {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("modutex-ws-files-{}", Uuid::new_v4()));
        fs::create_dir(&path).expect("create temporary workspace");
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempWorkspace {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn relative(value: &str) -> RelativePath {
    RelativePath::parse(value).expect("valid relative path")
}

fn host_generation(
    root_path: &Path,
) -> (
    OwnerId,
    WorkspaceId,
    modutex_desktop_tauri_lib::state::workspace_leases::SessionGeneration,
) {
    let owner = OwnerId::from_label("main").expect("valid owner");
    let workspace = WorkspaceId::parse("workspace-test").expect("valid workspace");
    let trusted = TrustedWorkspaceRoot::new(
        RootIdentity::new(1, 2),
        CanonicalRootPath::from_trusted_path(root_path).expect("canonical path"),
    );
    let generation = WorkspaceLeaseCoordinator::new()
        .admit_trusted(&owner, &workspace, trusted)
        .expect("admit test workspace");
    (owner, workspace, generation)
}

fn create_symlink(target: &Path, link: &Path, directory: bool) -> io::Result<()> {
    #[link(name = "kernel32")]
    extern "system" {
        fn CreateSymbolicLinkW(link_name: *const u16, target_name: *const u16, flags: u32) -> u8;
    }
    const SYMBOLIC_LINK_FLAG_DIRECTORY: u32 = 0x1;
    const SYMBOLIC_LINK_FLAG_ALLOW_UNPRIVILEGED_CREATE: u32 = 0x2;
    let mut link_wide: Vec<u16> = link.as_os_str().encode_wide().collect();
    link_wide.push(0);
    let mut target_wide: Vec<u16> = target.as_os_str().encode_wide().collect();
    target_wide.push(0);
    let flags = SYMBOLIC_LINK_FLAG_ALLOW_UNPRIVILEGED_CREATE
        | if directory {
            SYMBOLIC_LINK_FLAG_DIRECTORY
        } else {
            0
        };
    let result = unsafe { CreateSymbolicLinkW(link_wide.as_ptr(), target_wide.as_ptr(), flags) };
    if result != 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[test]
fn real_file_and_directory_copy_rename_conflicts_unicode_and_long_paths() {
    let workspace = TempWorkspace::new();
    let root = TrustedRoot::open(workspace.path()).expect("trusted root");
    let cancelled = AtomicBool::new(false);

    root.create_directory(&relative("資料"))
        .expect("create Unicode directory");
    root.create_file(&relative("資料/源.tex"), "αβγ\n".as_bytes())
        .expect("create Unicode file");
    let cancelled_copy = AtomicBool::new(true);
    assert!(matches!(
        root.copy_path(
            &relative("資料/源.tex"),
            &relative("資料/取消副本.tex"),
            &cancelled_copy
        ),
        Err(FsError::Cancelled)
    ));
    assert!(matches!(
        root.stat(&relative("資料/取消副本.tex")),
        Err(FsError::NotFound)
    ));
    root.copy_path(
        &relative("資料/源.tex"),
        &relative("資料/複製.tex"),
        &cancelled,
    )
    .expect("copy file");
    assert_eq!(
        root.read_file(&relative("資料/複製.tex"))
            .expect("read copy")
            .bytes,
        "αβγ\n".as_bytes()
    );

    root.create_file(&relative("資料/occupied.tex"), b"keep")
        .expect("create conflict target");
    assert!(matches!(
        root.copy_path(
            &relative("資料/源.tex"),
            &relative("資料/occupied.tex"),
            &cancelled
        ),
        Err(FsError::RevisionConflict { .. })
    ));
    assert_eq!(
        root.read_file(&relative("資料/源.tex"))
            .expect("source remains after destination conflict")
            .bytes,
        "αβγ\n".as_bytes()
    );
    assert_eq!(
        root.read_file(&relative("資料/occupied.tex"))
            .expect("read existing target")
            .bytes,
        b"keep"
    );
    root.move_path(&relative("資料/複製.tex"), &relative("資料/renamed.tex"))
        .expect("rename by handle");
    assert!(matches!(
        root.move_path(&relative("資料/源.tex"), &relative("資料/occupied.tex")),
        Err(FsError::RevisionConflict { .. })
    ));

    root.create_directory(&relative("tree"))
        .expect("create source tree");
    root.create_directory(&relative("tree/sub"))
        .expect("create nested directory");
    root.create_file(&relative("tree/sub/file.txt"), b"tree bytes")
        .expect("create nested file");
    root.copy_path(&relative("tree"), &relative("tree-copy"), &cancelled)
        .expect("atomic directory copy");
    assert_eq!(
        root.read_file(&relative("tree-copy/sub/file.txt"))
            .expect("read copied tree")
            .bytes,
        b"tree bytes"
    );

    // The workspace-relative path is longer than MAX_PATH, while every
    // individual native segment remains within the Windows component limit.
    let segment = "d".repeat(110);
    let first = relative(&segment);
    root.create_directory(&first)
        .expect("create long-path level 1");
    let second = relative(&format!("{segment}/{segment}"));
    root.create_directory(&second)
        .expect("create long-path level 2");
    let third = relative(&format!("{segment}/{segment}/{segment}"));
    root.create_directory(&third)
        .expect("create long-path level 3");
    let long_file = relative(&format!("{segment}/{segment}/{segment}/終.tex"));
    assert!(long_file.as_str().len() > 260);
    root.create_file(&long_file, b"long path bytes")
        .expect("create beyond MAX_PATH");
    assert_eq!(
        root.read_file(&long_file)
            .expect("read beyond MAX_PATH")
            .bytes,
        b"long path bytes"
    );
}

#[test]
fn recoverable_delete_undo_owner_cleanup_and_conflict_never_overwrite() {
    let workspace = TempWorkspace::new();
    let root = TrustedRoot::open(workspace.path()).expect("trusted root");
    let (owner, workspace_id, generation) = host_generation(workspace.path());
    let state = WorkspaceFilesState::default();
    let path = relative("recover me.txt");
    root.create_file(&path, b"original bytes")
        .expect("create original");

    let receipt = state
        .delete_recoverable(&owner, &workspace_id, generation, &path, &root)
        .expect("recoverable delete");
    assert!(matches!(root.read_file(&path), Err(FsError::NotFound)));
    state
        .undo_recoverable(&owner, &workspace_id, generation, &receipt.token, &root)
        .expect("undo");
    assert_eq!(
        root.read_file(&path).expect("restored file").bytes,
        b"original bytes"
    );

    let receipt = state
        .delete_recoverable(&owner, &workspace_id, generation, &path, &root)
        .expect("second recoverable delete");
    let replacement = root
        .create_file(&path, b"external replacement")
        .expect("create concurrent replacement");
    let retained_token = receipt.token.clone();
    assert!(matches!(
        state.undo_recoverable(&owner, &workspace_id, generation, &retained_token, &root),
        Err(
            modutex_desktop_tauri_lib::services::filesystem::FilesystemError::RevisionConflict { .. }
        )
    ));
    assert_eq!(
        root.read_file(&path).expect("replacement remains").bytes,
        b"external replacement"
    );
    root.delete_file_if_revision(&path, &replacement.revision)
        .expect("remove fixture replacement");

    // Window/owner cleanup restores a pending deletion when its original name
    // is free. A failed restore remains a hidden tombstone, never a deletion.
    state.close_owner_gate(&owner);
    state
        .restore_workspace_recoveries(&owner, &workspace_id, generation, &root)
        .expect("owner cleanup restore");
    assert_eq!(
        root.read_file(&path).expect("cleanup restored file").bytes,
        b"original bytes"
    );
}

#[test]
fn directory_junction_cannot_expose_files_outside_the_workspace() {
    let workspace = TempWorkspace::new();
    let outside = TempWorkspace::new();
    let sentinel = outside.path().join("outside.txt");
    fs::write(&sentinel, b"outside sentinel").expect("create sentinel");
    let link = workspace.path().join("junction");
    let result = std::process::Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(&link)
        .arg(outside.path())
        .output()
        .expect("create junction fixture");
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    assert_ne!(
        fs::symlink_metadata(&link)
            .expect("junction metadata")
            .file_attributes()
            & 0x400,
        0,
        "fixture must be an actual reparse point"
    );
    let root = TrustedRoot::open(workspace.path()).expect("trusted root");
    assert!(matches!(
        root.read_file(&relative("junction/outside.txt")),
        Err(FsError::LinkNotAllowed)
    ));
    assert!(matches!(
        root.scan(Some(&relative("junction")), 4, 128, &AtomicBool::new(false)),
        Err(FsError::LinkNotAllowed)
    ));
    assert_eq!(
        fs::read(&sentinel).expect("sentinel survives"),
        b"outside sentinel"
    );
    fs::remove_dir(&link).expect("remove only junction, preserve target");
    assert_eq!(
        fs::read(&sentinel).expect("target survives junction cleanup"),
        b"outside sentinel"
    );
}

#[test]
fn links_are_rejected_and_path_swap_races_do_not_escape_the_trusted_root() {
    let workspace = TempWorkspace::new();
    let outside = TempWorkspace::new();
    let outside_file = outside.path().join("outside.txt");
    fs::write(&outside_file, b"outside sentinel").expect("create outside sentinel");
    let link = workspace.path().join("linked.txt");
    create_symlink(&outside_file, &link, false).expect("create file symlink fixture");
    fs::create_dir(workspace.path().join("folder-link-parent")).expect("create parent fixture");
    let outside_dir = outside.path().join("outside-dir");
    fs::create_dir(&outside_dir).expect("create outside directory");
    let dir_link = workspace.path().join("folder-link-parent").join("junction");
    create_symlink(&outside_dir, &dir_link, true).expect("create directory link fixture");

    let root = Arc::new(TrustedRoot::open(workspace.path()).expect("trusted root"));
    assert!(matches!(
        root.read_file(&relative("linked.txt")),
        Err(FsError::LinkNotAllowed)
    ));
    assert!(matches!(
        root.scan(
            Some(&relative("folder-link-parent/junction")),
            4,
            128,
            &AtomicBool::new(false)
        ),
        Err(FsError::LinkNotAllowed)
    ));

    let race_dir = workspace.path().join("race");
    fs::create_dir(&race_dir).expect("create race directory");
    let race_path = race_dir.join("leaf.txt");
    let race_relative = relative("race/leaf.txt");
    let root_for_actor = Arc::clone(&root);
    let outside_for_actor = outside_file.clone();
    let actor = thread::spawn(move || {
        for _ in 0..200 {
            let _ = fs::remove_file(&race_path);
            let _ = create_symlink(&outside_for_actor, &race_path, false);
            let _ = root_for_actor.read_file(&relative("race/leaf.txt"));
            let _ = fs::remove_file(&race_path);
            if let Ok(mut file) = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&race_path)
            {
                let _ = file.write_all(b"inside only");
            }
        }
    });
    for _ in 0..400 {
        match root.read_file(&race_relative) {
            Ok(read) => assert_eq!(read.bytes, b"inside only"),
            Err(FsError::NotFound)
            | Err(FsError::LinkNotAllowed)
            | Err(FsError::SharingViolation)
            | Err(FsError::AccessDenied) => {}
            Err(error) => panic!("unexpected race result: {error:?}"),
        }
    }
    actor.join().expect("race actor");
    assert_eq!(
        fs::read(outside_file).expect("outside sentinel survives"),
        b"outside sentinel"
    );
}

#[test]
fn bounded_scan_honors_cancellation_and_private_tombstones_are_not_listed() {
    let workspace = TempWorkspace::new();
    let root = TrustedRoot::open(workspace.path()).expect("trusted root");
    root.create_file(&relative("visible.txt"), b"visible")
        .expect("create visible file");
    let (owner, workspace_id, generation) = host_generation(workspace.path());
    let state = WorkspaceFilesState::default();
    let path = relative("pending.txt");
    root.create_file(&path, b"retained")
        .expect("create recoverable file");
    state
        .delete_recoverable(&owner, &workspace_id, generation, &path, &root)
        .expect("make private tombstone");

    let cancelled = AtomicBool::new(true);
    assert!(matches!(
        root.scan(None, 64, 4096, &cancelled),
        Err(FsError::Cancelled)
    ));
    let entries = root.list_files().expect("list ordinary files");
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].path.as_str(), "visible.txt");
}
