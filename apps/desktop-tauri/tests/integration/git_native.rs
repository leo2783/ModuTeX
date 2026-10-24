// SPDX-License-Identifier: Apache-2.0
//! Native Windows Git integration tests. These use the actual discovered Git
//! executable and the production process-tree runner, not an injected runner.

use std::{
    ffi::OsStr,
    fs,
    path::PathBuf,
    sync::{mpsc, Arc},
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use crate::{
    platform::process_tree::{CleanupProof, ProcessError, ProcessErrorKind, ProcessLogs},
    schemas::protocol::{OwnerId, Timestamp},
    services::{
        filesystem::{FilesystemError, FilesystemService},
        git_native::{GitNativeRuntime, NativeGitRunner},
        git_service::{
            GitAvailability, GitDiscardConfirmation, GitError, GitInvocation, GitProcessOutput,
            GitRunner, GitRunnerError, GitService, GitStatusCode, GitUnavailableReason,
            GitWorkspaceCapability, GitWorkspaceFailure,
        },
    },
    shared::relative_path::RelativePath,
    state::{
        recent::RecentStore, sessions::SessionRegistry, settings::SettingsStore,
        workspace_leases::WorkspaceLeaseCoordinator,
    },
};

struct TestTree(PathBuf);

#[test]
fn command_line_budget_counts_windows_quoting_and_unicode_units() {
    let units = |text: &str| super::quoted_argument_units(OsStr::new(text)).unwrap();
    assert_eq!(units("plain"), 5);
    assert_eq!(units("a b"), 5);
    assert_eq!(units("a\"b"), 6);
    assert_eq!(units("a\\\"b"), 8);
    assert_eq!(units("a b\\"), 7);
    assert_eq!(units("章節"), 2);
    assert_eq!(units("\u{10000}"), 2);
}

impl TestTree {
    fn new() -> Self {
        let path =
            std::env::temp_dir().join(format!("modutex-git-native-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&path).expect("create native Git test directory");
        Self(path)
    }
}

impl Drop for TestTree {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn open_test_workspace() -> (
    TestTree,
    FilesystemService,
    OwnerId,
    crate::schemas::protocol::WorkspaceId,
    PathBuf,
) {
    let tree = TestTree::new();
    let root = tree.0.join("repository");
    let data = tree.0.join("application-data");
    fs::create_dir_all(&root).expect("create repository root");
    fs::create_dir_all(&data).expect("create test data directory");

    let service = FilesystemService::new(
        Arc::new(SessionRegistry::new()),
        WorkspaceLeaseCoordinator::new(),
        RecentStore::new(data.clone()),
        SettingsStore::new(data),
    );
    let owner = OwnerId::from_label("git-native-integration").expect("valid test owner");
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock after epoch")
        .as_millis() as u64;
    let opened = service
        .open_workspace_folder(&owner, &root, None, Timestamp::new(now).unwrap())
        .expect("open native Git test workspace");
    (tree, service, owner, opened.opened.id, root)
}

#[test]
fn missing_git_is_a_typed_runtime_availability_result() {
    let missing_directory =
        std::env::temp_dir().join(format!("modutex-no-git-{}", uuid::Uuid::new_v4()));
    let search_path =
        std::env::join_paths(std::iter::once(missing_directory)).expect("build empty test PATH");
    let runtime = GitNativeRuntime::from_search_path(Some(&search_path), Duration::from_secs(1));
    assert_eq!(
        runtime.availability(),
        GitAvailability::Unavailable {
            reason: GitUnavailableReason::NotInstalled,
        }
    );
}

#[test]
fn cleanup_failed_without_ticket_is_bounded_and_keeps_the_workspace_lease() {
    let (_tree, filesystem, owner, workspace_id, _root) = open_test_workspace();
    let lease = filesystem
        .start_git_task(&owner, &workspace_id)
        .expect("acquire host Git workspace lease");
    let runner = NativeGitRunner::new(Arc::new(GitNativeRuntime::unavailable(
        GitUnavailableReason::NotInstalled,
        Duration::from_secs(1),
    )));
    let error = ProcessError {
        kind: ProcessErrorKind::CleanupFailed,
        cause: None,
        detail: "injected cleanup failure without a ticket".to_owned(),
        exit_code: None,
        logs: ProcessLogs::default(),
        cleanup: CleanupProof::Failed,
        pending_cleanup: None,
    };
    let check_service = filesystem.clone();
    let check_owner = owner.clone();
    let check_workspace = workspace_id.clone();
    let (sender, receiver) = mpsc::channel();
    let worker = thread::spawn(move || {
        let unproven = matches!(
            runner.process_error(&lease, error, 128, 128),
            Err(GitRunnerError::CleanupUnproven)
        );
        let busy = match check_service.start_git_task(&check_owner, &check_workspace) {
            Err(FilesystemError::WorkspaceBusy) => true,
            Ok(other) => {
                let _ = other.finish();
                false
            }
            Err(_) => false,
        };
        let finished = lease.finish().is_ok();
        sender
            .send((unproven, busy, finished))
            .expect("send cleanup fault-injection result");
    });
    let (unproven, busy, finished) = receiver
        .recv_timeout(Duration::from_secs(2))
        .expect("cleanup failure without a ticket must return promptly");
    worker.join().expect("join cleanup fault-injection worker");
    assert!(unproven);
    assert!(busy);
    assert!(finished);
    filesystem
        .close_workspace(&owner, &workspace_id)
        .expect("close test workspace");
}

#[test]
fn deferred_cleanup_keeps_the_workspace_lease_until_completion() {
    let (_tree, filesystem, owner, workspace_id, _root) = open_test_workspace();
    let lease = filesystem
        .start_git_task(&owner, &workspace_id)
        .expect("acquire host Git workspace lease");
    let cleanup_complete = lease.deferred_cleanup_callback();
    assert!(matches!(
        filesystem.start_git_task(&owner, &workspace_id),
        Err(FilesystemError::WorkspaceBusy)
    ));
    drop(lease);
    assert!(matches!(
        filesystem.start_git_task(&owner, &workspace_id),
        Err(FilesystemError::WorkspaceBusy)
    ));

    let close_service = filesystem.clone();
    let close_owner = owner.clone();
    let close_workspace = workspace_id.clone();
    let (sender, receiver) = mpsc::channel();
    let close_worker = thread::spawn(move || {
        let unproven = matches!(
            close_service.close_workspace(&close_owner, &close_workspace),
            Err(FilesystemError::CleanupUnproven { .. })
        );
        sender
            .send(unproven)
            .expect("send deferred-cleanup close result");
    });
    let unproven = receiver
        .recv_timeout(Duration::from_secs(2))
        .expect("workspace close must not wait indefinitely for deferred cleanup");
    close_worker.join().expect("join workspace-close worker");
    assert!(unproven);
    assert!(filesystem.has_undrained_cleanup(&workspace_id));

    cleanup_complete();
    assert!(!filesystem.has_undrained_cleanup(&workspace_id));
}

#[test]
fn stage_does_not_read_an_external_junction_swapped_after_path_validation() {
    assert_stage_rejects_junction_swap(&[RelativePath::parse("selected/sentinel.txt").unwrap()]);
}

#[test]
fn stage_directory_rejects_junction_swapped_after_path_validation() {
    assert_stage_rejects_junction_swap(&[RelativePath::parse("selected").unwrap()]);
}

#[test]
fn stage_all_rejects_junction_swapped_after_path_validation() {
    assert_stage_rejects_junction_swap(&[]);
}

fn assert_stage_rejects_junction_swap(paths: &[RelativePath]) {
    use std::sync::atomic::{AtomicBool, Ordering};
    struct SwapRunner {
        native: NativeGitRunner,
        root: PathBuf,
        outside: PathBuf,
        swapped: AtomicBool,
    }
    impl GitRunner for SwapRunner {
        fn run(
            &self,
            workspace: &dyn GitWorkspaceCapability,
            invocation: &GitInvocation,
        ) -> Result<GitProcessOutput, GitRunnerError> {
            if invocation.argv().iter().any(|arg| arg == OsStr::new("add")) {
                let selected = self.root.join("selected");
                if fs::rename(&selected, self.root.join("parked")).is_ok() {
                    let junction = std::process::Command::new("cmd")
                        .args(["/C", "mklink", "/J"])
                        .arg(&selected)
                        .arg(&self.outside)
                        .output()
                        .expect("create race junction");
                    assert!(junction.status.success(), "junction setup failed");
                    self.swapped.store(true, Ordering::Release);
                }
            }
            self.native.run(workspace, invocation)
        }

        fn path_argument_budget(
            &self,
            workspace: &dyn GitWorkspaceCapability,
            base_words: &[&str],
        ) -> Result<usize, GitRunnerError> {
            self.native.path_argument_budget(workspace, base_words)
        }
    }
    let (tree, filesystem, owner, workspace_id, root) = open_test_workspace();
    let outside = tree.0.join("outside");
    fs::create_dir(&outside).expect("outside fixture");
    fs::create_dir(root.join("selected")).expect("inside directory");
    fs::write(root.join("selected/sentinel.txt"), b"inside only").expect("inside file");
    fs::write(outside.join("sentinel.txt"), b"outside-only-sentinel").expect("outside file");
    let native = NativeGitRunner::new(Arc::new(GitNativeRuntime::discover()));
    let lease = filesystem
        .start_git_task(&owner, &workspace_id)
        .expect("workspace lease");
    GitService::new(&native)
        .init(&lease)
        .expect("initialize repository");
    let runner = SwapRunner {
        native,
        root: root.clone(),
        outside: outside.clone(),
        swapped: AtomicBool::new(false),
    };
    let result = GitService::new(&runner).stage(&lease, paths);
    let staged = std::process::Command::new("git")
        .arg("-C")
        .arg(&root)
        .args(["show", ":selected/sentinel.txt"])
        .output()
        .expect("inspect actual index");
    if runner.swapped.load(Ordering::Acquire) {
        fs::remove_dir(root.join("selected")).expect("remove only fixture junction");
        fs::rename(root.join("parked"), root.join("selected")).expect("restore inside directory");
    }
    assert_eq!(
        fs::read(outside.join("sentinel.txt")).unwrap(),
        b"outside-only-sentinel"
    );
    assert_ne!(
        staged.stdout, b"outside-only-sentinel",
        "stage read outside workspace after validation: {result:?}"
    );
    if result.is_ok() {
        assert_eq!(staged.stdout, b"inside only");
    }
}

#[test]
fn native_repository_lifecycle_preserves_git_operations_and_binary_output() {
    let (_tree, filesystem, owner, workspace_id, root) = open_test_workspace();
    let runtime = Arc::new(GitNativeRuntime::discover());
    assert_eq!(
        runtime.availability(),
        GitAvailability::Available,
        "the native integration runner requires Git for Windows"
    );
    let runner = NativeGitRunner::new(runtime);
    let git = GitService::new(&runner);
    let lease = filesystem
        .start_git_task(&owner, &workspace_id)
        .expect("acquire host Git workspace lease");

    git.init(&lease).expect("initialize native repository");
    assert!(matches!(git.init(&lease), Err(GitError::AlreadyRepository)));

    let config_path = root.join(".git").join("config");
    let mut config = fs::read_to_string(&config_path).expect("read initialized Git config");
    config.push_str("\n[user]\n\tname = Native Git Test\n\temail = native-git@example.invalid\n");
    fs::write(&config_path, config).expect("configure temporary repository identity");
    assert_eq!(
        git.user_name(&lease).expect("read configured Git user"),
        Some("Native Git Test".to_owned())
    );

    let entry = RelativePath::parse("main.tex").expect("valid TeX relative path");
    fs::write(root.join("main.tex"), b"first native Git snapshot\n").expect("write fixture");
    git.stage(&lease, std::slice::from_ref(&entry))
        .expect("stage initial file");
    let staged_diff = git
        .diff(&lease, true, &[])
        .expect("read staged binary diff");
    assert!(String::from_utf8_lossy(&staged_diff).contains("+first native Git snapshot"));
    git.commit(&lease, "initial native commit")
        .expect("commit initial file");

    let shown = git.show_head(&lease).expect("show exact HEAD output");
    assert!(String::from_utf8_lossy(&shown).contains("first native Git snapshot"));
    let log = git.log(&lease).expect("read bounded Git history");
    assert!(String::from_utf8_lossy(&log).contains("initial native commit"));
    assert!(git
        .status(&lease)
        .expect("read clean Git status")
        .entries
        .is_empty());

    fs::write(root.join("main.tex"), b"second native Git snapshot\n").expect("modify fixture");
    git.stage(&lease, std::slice::from_ref(&entry))
        .expect("stage changed file");
    let status = git.status(&lease).expect("read staged status");
    assert_eq!(status.entries.len(), 1);
    assert_eq!(status.entries[0].index, GitStatusCode::Modified);
    let diff = git
        .diff(&lease, true, std::slice::from_ref(&entry))
        .expect("read selected staged diff");
    assert!(String::from_utf8_lossy(&diff).contains("+second native Git snapshot"));

    git.unstage(&lease, std::slice::from_ref(&entry))
        .expect("unstage changed file");
    let status = git.status(&lease).expect("read unstaged status");
    assert_eq!(status.entries[0].index, GitStatusCode::Unchanged);
    let confirmation = GitDiscardConfirmation::issue(&lease, std::slice::from_ref(&entry)).unwrap();
    git.discard(&lease, std::slice::from_ref(&entry), &confirmation)
        .expect("discard confirmed tracked change");
    assert_eq!(
        fs::read(root.join("main.tex")).expect("read restored file"),
        b"first native Git snapshot\n"
    );

    let untracked = RelativePath::parse("new-file.txt").expect("valid untracked path");
    fs::write(root.join("new-file.txt"), b"untracked\n").expect("write untracked fixture");
    let confirmation =
        GitDiscardConfirmation::issue(&lease, std::slice::from_ref(&untracked)).unwrap();
    git.discard(&lease, std::slice::from_ref(&untracked), &confirmation)
        .expect("discard confirmed untracked file");
    assert!(!root.join("new-file.txt").exists());

    lease.finish().expect("prove and finish Git workspace task");
    filesystem
        .close_workspace(&owner, &workspace_id)
        .expect("close native Git test workspace");
}

#[test]
fn stage_all_batches_long_unicode_paths_and_preserves_ignore_rules() {
    let (_tree, filesystem, owner, workspace_id, root) = open_test_workspace();
    let runner = NativeGitRunner::new(Arc::new(GitNativeRuntime::discover()));
    let git = GitService::new(&runner);
    let lease = filesystem.start_git_task(&owner, &workspace_id).unwrap();
    git.init(&lease).unwrap();
    fs::write(root.join(".gitignore"), "ignored.bin\n").unwrap();
    fs::write(root.join("ignored.bin"), "excluded bytes").unwrap();
    for index in 0..400 {
        let name = format!("{:04}-{}-章節.tex", index, "long-name-".repeat(10));
        fs::write(root.join(name), "inside workspace\n").unwrap();
    }
    git.stage(&lease, &[])
        .expect("stage more than one Windows command-line batch");
    let status = git.status(&lease).unwrap();
    assert_eq!(status.entries.len(), 401);
    assert!(status
        .entries
        .iter()
        .all(|entry| entry.index == GitStatusCode::Added));
    assert!(!status
        .entries
        .iter()
        .any(|entry| entry.path.as_str() == "ignored.bin"));
    git.unstage(&lease, &[])
        .expect("unstage all long paths before initial commit");
    assert!(git
        .status(&lease)
        .unwrap()
        .entries
        .iter()
        .all(|entry| entry.index == GitStatusCode::Untracked));
    lease.finish().unwrap();
}

#[test]
fn unstage_directory_updates_only_selected_descendant_index_entries() {
    let (_tree, filesystem, owner, workspace_id, root) = open_test_workspace();
    let runner = NativeGitRunner::new(Arc::new(GitNativeRuntime::discover()));
    let git = GitService::new(&runner);
    let lease = filesystem.start_git_task(&owner, &workspace_id).unwrap();
    git.init(&lease).unwrap();
    fs::create_dir(root.join("chapter")).unwrap();
    fs::write(root.join("chapter/one.tex"), "first\n").unwrap();
    fs::write(root.join("chapter/two.tex"), "second\n").unwrap();
    fs::write(root.join("chapter-other.tex"), "keep staged\n").unwrap();
    git.stage(&lease, &[]).unwrap();
    git.unstage(&lease, &[RelativePath::parse("chapter").unwrap()])
        .unwrap();
    let status = git.status(&lease).unwrap();
    for entry in &status.entries {
        if entry.path.as_str().starts_with("chapter/") {
            assert_eq!(
                entry.index,
                GitStatusCode::Untracked,
                "directory descendant was not unstaged"
            );
        } else {
            assert_eq!(entry.path.as_str(), "chapter-other.tex");
            assert_eq!(
                entry.index,
                GitStatusCode::Added,
                "selection must preserve sibling index entries"
            );
        }
    }
    assert_eq!(status.entries.len(), 3);
    lease.finish().unwrap();
}

#[test]
fn stage_absent_path_cannot_recurse_into_a_new_external_junction() {
    struct InsertRunner {
        native: NativeGitRunner,
        root: PathBuf,
        outside: PathBuf,
    }
    impl GitRunner for InsertRunner {
        fn run(
            &self,
            workspace: &dyn GitWorkspaceCapability,
            invocation: &GitInvocation,
        ) -> Result<GitProcessOutput, GitRunnerError> {
            if invocation.argv().iter().any(|arg| arg == OsStr::new("add")) {
                let output = std::process::Command::new("cmd")
                    .args(["/C", "mklink", "/J"])
                    .arg(self.root.join("missing.tex"))
                    .arg(&self.outside)
                    .output()
                    .unwrap();
                assert!(output.status.success(), "fixture junction creation failed");
            }
            self.native.run(workspace, invocation)
        }
        fn path_argument_budget(
            &self,
            workspace: &dyn GitWorkspaceCapability,
            words: &[&str],
        ) -> Result<usize, GitRunnerError> {
            self.native.path_argument_budget(workspace, words)
        }
    }
    let (tree, filesystem, owner, workspace_id, root) = open_test_workspace();
    let outside = tree.0.join("outside-insertion");
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("sentinel.txt"), b"outside-only-sentinel").unwrap();
    let native = NativeGitRunner::new(Arc::new(GitNativeRuntime::discover()));
    let lease = filesystem.start_git_task(&owner, &workspace_id).unwrap();
    GitService::new(&native).init(&lease).unwrap();
    let runner = InsertRunner {
        native,
        root: root.clone(),
        outside: outside.clone(),
    };
    let result =
        GitService::new(&runner).stage(&lease, &[RelativePath::parse("missing.tex").unwrap()]);
    let staged = std::process::Command::new("git")
        .arg("-C")
        .arg(&root)
        .args(["show", ":missing.tex/sentinel.txt"])
        .output()
        .unwrap();
    let link = root.join("missing.tex");
    if fs::symlink_metadata(&link).is_ok() {
        fs::remove_dir(&link).unwrap();
    }
    assert_eq!(
        fs::read(outside.join("sentinel.txt")).unwrap(),
        b"outside-only-sentinel"
    );
    assert_ne!(
        staged.stdout, b"outside-only-sentinel",
        "Git read a new external junction after validating an absent path: {result:?}"
    );
    lease.finish().unwrap();
}

#[test]
fn closing_workspace_signals_the_registered_git_task_before_lease_release() {
    let (_tree, filesystem, owner, workspace_id, _root) = open_test_workspace();
    let lease = filesystem
        .start_git_task(&owner, &workspace_id)
        .expect("acquire registered Git task");
    let cancellation = lease
        .cancellation_signal()
        .expect("host Git task exposes cancellation");
    let closing_service = filesystem.clone();
    let closing_owner = owner.clone();
    let closing_workspace = workspace_id.clone();
    let close =
        thread::spawn(move || closing_service.close_workspace(&closing_owner, &closing_workspace));

    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while !cancellation.load(std::sync::atomic::Ordering::Acquire) {
        assert!(
            std::time::Instant::now() < deadline,
            "workspace close did not signal Git task cancellation"
        );
        thread::sleep(Duration::from_millis(5));
    }
    assert_eq!(lease.check_current(), Err(GitWorkspaceFailure::Cancelled));
    lease
        .finish()
        .expect("finish task after cancellation and cleanup");
    close
        .join()
        .expect("join workspace close")
        .expect("close workspace after Git task drain");
}

#[test]
fn safe_overridden_git_environment_keys_are_permitted_and_unsafe_keys_are_rejected() {
    // Keys in the host-owned override table must never be flagged as unsafe,
    // including case-variant representations.
    let safe_keys = [
        "GIT_PAGER",
        "git_pager",
        "Git_Pager",
        "GIT_TERMINAL_PROMPT",
        "git_terminal_prompt",
        "Git_Terminal_Prompt",
        "GIT_CONFIG_NOSYSTEM",
        "git_config_nosystem",
        "Git_Config_NoSystem",
    ];
    for key in safe_keys {
        assert!(
            !super::is_unsafe_git_env_key(OsStr::new(key)),
            "host-overridden key {key} must not be rejected as unsafe"
        );
    }

    // Uncontrolled/dangerous Git keys must remain strictly rejected as unsafe.
    let unsafe_keys = [
        "GIT_DIR",
        "git_dir",
        "GIT_WORK_TREE",
        "git_work_tree",
        "GIT_SSH",
        "GIT_SSH_COMMAND",
        "git_ssh_command",
        "GIT_EXEC_PATH",
        "GIT_EXTERNAL_DIFF",
        "GIT_CONFIG_PARAMETERS",
        "GIT_OBJECT_DIRECTORY",
        "GIT_HOOKS_PATH",
        "GIT_INDEX_FILE",
        "GIT_PAGER_EXTRA",
        "GIT_",
    ];
    for key in unsafe_keys {
        assert!(
            super::is_unsafe_git_env_key(OsStr::new(key)),
            "uncontrolled git key {key} must be rejected as unsafe"
        );
    }

    // Non-Git environment keys must not be flagged.
    let non_git_keys = ["PATH", "PAGER", "TEMP", "SYSTEMROOT", "CARGO"];
    for key in non_git_keys {
        assert!(
            !super::is_unsafe_git_env_key(OsStr::new(key)),
            "non-git key {key} must not be flagged"
        );
    }
}
