// SPDX-License-Identifier: Apache-2.0
use super::*;
use std::collections::VecDeque;
use std::sync::Mutex;

struct ScriptedRunner {
    calls: Mutex<Vec<GitInvocation>>,
    outputs: Mutex<VecDeque<GitProcessOutput>>,
}

impl ScriptedRunner {
    fn new(outputs: impl IntoIterator<Item = GitProcessOutput>) -> Self {
        Self {
            calls: Mutex::new(Vec::new()),
            outputs: Mutex::new(outputs.into_iter().collect()),
        }
    }
}

impl GitRunner for ScriptedRunner {
    fn run(
        &self,
        _workspace: &dyn GitWorkspaceCapability,
        invocation: &GitInvocation,
    ) -> Result<GitProcessOutput, GitRunnerError> {
        self.calls.lock().unwrap().push(invocation.clone());
        self.outputs
            .lock()
            .unwrap()
            .pop_front()
            .ok_or(GitRunnerError::ProcessTreeFailed)
    }

    fn path_argument_budget(
        &self,
        _workspace: &dyn GitWorkspaceCapability,
        _base_words: &[&str],
    ) -> Result<usize, GitRunnerError> {
        Ok(usize::MAX)
    }
}

struct TestWorkspace {
    owner: OwnerId,
    workspace_id: WorkspaceId,
    generation: u64,
    active: bool,
    path_kind: GitPathKind,
}

impl TestWorkspace {
    fn new() -> Self {
        Self {
            owner: OwnerId::from_label("window-main").unwrap(),
            workspace_id: WorkspaceId::parse("ws-1").unwrap(),
            generation: 7,
            active: true,
            path_kind: GitPathKind::File,
        }
    }
}

impl GitWorkspaceCapability for TestWorkspace {
    fn workspace_id(&self) -> &WorkspaceId {
        &self.workspace_id
    }

    fn owner(&self) -> &OwnerId {
        &self.owner
    }

    fn generation(&self) -> u64 {
        self.generation
    }

    fn check_current(&self) -> Result<(), GitWorkspaceFailure> {
        if self.active {
            Ok(())
        } else {
            Err(GitWorkspaceFailure::Closed)
        }
    }

    fn release_path_pins(&self) -> Result<(), GitPathFailure> {
        Ok(())
    }

    fn validate_path(
        &self,
        _path: &RelativePath,
        _intent: GitPathIntent,
    ) -> Result<(), GitPathFailure> {
        Ok(())
    }

    fn validate_all(&self, _intent: GitPathIntent) -> Result<(), GitPathFailure> {
        Ok(())
    }

    fn path_kind(&self, _path: &RelativePath) -> Result<GitPathKind, GitPathFailure> {
        Ok(self.path_kind)
    }
}

fn output(code: i32, stdout: &[u8]) -> GitProcessOutput {
    GitProcessOutput {
        exit_code: Some(code),
        stdout: stdout.to_vec(),
        stderr: Vec::new(),
    }
}

fn path(value: &str) -> RelativePath {
    RelativePath::parse(value).unwrap()
}

fn argv(invocation: &GitInvocation) -> Vec<String> {
    invocation
        .argv()
        .iter()
        .map(|argument| argument.to_string_lossy().into_owned())
        .collect()
}

#[test]
fn porcelain_parser_keeps_unicode_rename_untracked_and_conflict_records() {
    let entries = parse_porcelain_v1_z(
        b"R  docs/new-\xce\xb1.tex\0docs/old.tex\0?? untracked.tex\0UU merge.tex\0",
    )
    .unwrap();
    assert_eq!(entries.len(), 3);
    assert_eq!(entries[0].path.as_str(), "docs/new-α.tex");
    assert_eq!(
        entries[0].original_path.as_ref().unwrap().as_str(),
        "docs/old.tex"
    );
    assert!(entries[1].is_untracked());
    assert!(entries[2].is_conflicted());
    let type_changed = parse_porcelain_v1_z(b" T symlink.tex\0").unwrap();
    assert_eq!(type_changed[0].worktree, GitStatusCode::TypeChanged);
    assert_eq!(
        parse_porcelain_v1_z(b"?? line\nbreak.tex\0"),
        Err(GitError::InvalidPath)
    );
    assert_eq!(
        parse_porcelain_v1_z(b"?? invalid-\xff.tex\0"),
        Err(GitError::InvalidPathEncoding)
    );
    assert_eq!(
        parse_porcelain_v1_z(b" M missing-nul"),
        Err(GitError::MalformedStatus)
    );
}

#[test]
fn stage_uses_literal_argv_and_delimits_unicode_and_option_like_paths() {
    let runner = ScriptedRunner::new([output(0, b"true\n"), output(0, b"")]);
    let workspace = TestWorkspace::new();
    GitService::new(&runner)
        .stage(&workspace, &[path("-option/*.tex"), path("資料/章.tex")])
        .unwrap();
    let calls = runner.calls.lock().unwrap();
    assert_eq!(
        argv(&calls[1]),
        vec![
            "--no-pager",
            "--literal-pathspecs",
            "add",
            "--all",
            "--",
            "-option/*.tex",
            "資料/章.tex"
        ]
    );
}

#[test]
fn unstage_before_first_commit_clears_only_the_index() {
    let runner = ScriptedRunner::new([
        output(0, b"true\n"),
        output(0, b""),
        output(1, b""),
        output(0, b""),
    ]);
    let workspace = TestWorkspace::new();
    GitService::new(&runner).unstage(&workspace, &[]).unwrap();
    let calls = runner.calls.lock().unwrap();
    assert_eq!(
        argv(&calls[3]),
        vec!["--no-pager", "--literal-pathspecs", "read-tree", "--empty"]
    );
}

#[test]
fn copy_records_select_only_the_destination() {
    let workspace = TestWorkspace::new();
    let paths = [path("copied.tex")];
    let status = b"C  copied.tex\0source.tex\0";
    let unstage_runner = ScriptedRunner::new([
        output(0, b"true\n"),
        output(0, status),
        output(0, b"deadbeef\n"),
        output(0, b""),
    ]);
    GitService::new(&unstage_runner)
        .unstage(&workspace, &paths)
        .unwrap();
    let calls = unstage_runner.calls.lock().unwrap();
    assert_eq!(
        argv(&calls[3]),
        vec![
            "--no-pager",
            "--literal-pathspecs",
            "reset",
            "--quiet",
            "HEAD",
            "--",
            "copied.tex"
        ]
    );
    drop(calls);

    let confirmation = GitDiscardConfirmation::issue(&workspace, &paths).unwrap();
    let discard_runner = ScriptedRunner::new([
        output(0, b"true\n"),
        output(0, status),
        output(0, b"deadbeef\n"),
        output(0, b""),
        output(0, b""),
    ]);
    GitService::new(&discard_runner)
        .discard(&workspace, &paths, &confirmation)
        .unwrap();
    let calls = discard_runner.calls.lock().unwrap();
    assert_eq!(
        argv(&calls[3]),
        vec![
            "--no-pager",
            "--literal-pathspecs",
            "reset",
            "--quiet",
            "HEAD",
            "--",
            "copied.tex"
        ]
    );
    assert_eq!(
        argv(&calls[4]),
        vec![
            "--no-pager",
            "--literal-pathspecs",
            "clean",
            "--force",
            "--",
            "copied.tex"
        ]
    );
}

#[test]
fn stage_directory_expands_to_only_validated_changed_files() {
    let runner = ScriptedRunner::new([
        output(0, b"true\n"),
        output(0, b" M dir/a.tex\0?? dir/new.tex\0"),
        output(0, b""),
    ]);
    let workspace = TestWorkspace {
        path_kind: GitPathKind::Directory,
        ..TestWorkspace::new()
    };
    GitService::new(&runner)
        .stage(&workspace, &[path("dir")])
        .unwrap();
    let calls = runner.calls.lock().unwrap();
    assert_eq!(
        argv(&calls[2]),
        vec![
            "--no-pager",
            "--literal-pathspecs",
            "add",
            "--all",
            "--",
            "dir/a.tex",
            "dir/new.tex"
        ]
    );
}

#[test]
fn commit_message_is_one_argument_and_head_output_is_raw_bytes() {
    let message = "--no-verify\ncommit λ";
    let runner = ScriptedRunner::new([
        output(0, b"true\n"),
        output(0, b""),
        output(1, b""),
        output(0, b"commit output\n"),
    ]);
    let workspace = TestWorkspace::new();
    assert_eq!(
        GitService::new(&runner)
            .commit(&workspace, message)
            .unwrap(),
        b"commit output\n"
    );
    let calls = runner.calls.lock().unwrap();
    assert_eq!(
        argv(&calls[3]),
        vec!["--no-pager", "--literal-pathspecs", "commit", "-m", message]
    );

    let raw = [0, 255, b'\n'];
    let show_runner = ScriptedRunner::new([
        output(0, b"true\n"),
        output(0, b"deadbeef\n"),
        output(0, &raw),
    ]);
    assert_eq!(
        GitService::new(&show_runner).show_head(&workspace).unwrap(),
        raw
    );
}

#[test]
fn discard_requires_exact_confirmed_paths_and_uses_narrow_restore() {
    let runner = ScriptedRunner::new([
        output(0, b"true\n"),
        output(0, b" M note.tex\0"),
        output(0, b"deadbeef\n"),
        output(0, b""),
    ]);
    let workspace = TestWorkspace::new();
    let paths = [path("note.tex")];
    let confirmation = GitDiscardConfirmation::issue(&workspace, &paths).unwrap();
    GitService::new(&runner)
        .discard(&workspace, &paths, &confirmation)
        .unwrap();
    let calls = runner.calls.lock().unwrap();
    assert_eq!(
        argv(&calls[3]),
        vec![
            "--no-pager",
            "--literal-pathspecs",
            "restore",
            "--source=HEAD",
            "--staged",
            "--worktree",
            "--",
            "note.tex"
        ]
    );
}

#[test]
fn discard_confirmation_is_bound_to_workspace_identity() {
    let first = TestWorkspace::new();
    let second = TestWorkspace {
        workspace_id: WorkspaceId::parse("ws-2").unwrap(),
        ..TestWorkspace::new()
    };
    assert_eq!(first.owner(), second.owner());
    assert_eq!(first.generation(), second.generation());

    let paths = [path("note.tex")];
    let confirmation = GitDiscardConfirmation::issue(&first, &paths).unwrap();
    assert_eq!(
        confirmation.consume_for(&second, &paths),
        Err(GitError::ConfirmationMismatch)
    );
    assert_eq!(confirmation.consume_for(&first, &paths), Ok(()));
}

#[test]
fn repository_and_conflict_errors_are_typed() {
    let not_repo = ScriptedRunner::new([output(128, b"")]);
    assert_eq!(
        GitService::new(&not_repo).status(&TestWorkspace::new()),
        Err(GitError::NotRepository)
    );

    let conflict = ScriptedRunner::new([output(0, b"true\n"), output(0, b"UU merge.tex\0")]);
    assert_eq!(
        GitService::new(&conflict).commit(&TestWorkspace::new(), "message"),
        Err(GitError::UnresolvedConflicts { count: 1 })
    );
}

#[test]
fn user_name_is_a_read_only_unicode_config_query() {
    let runner = ScriptedRunner::new([output(0, "Māori Name\n".as_bytes())]);
    assert_eq!(
        GitService::new(&runner)
            .user_name(&TestWorkspace::new())
            .unwrap(),
        Some("Māori Name".to_owned())
    );
    assert_eq!(
        argv(&runner.calls.lock().unwrap()[0]),
        vec![
            "--no-pager",
            "--literal-pathspecs",
            "config",
            "--get",
            "user.name"
        ]
    );
}
