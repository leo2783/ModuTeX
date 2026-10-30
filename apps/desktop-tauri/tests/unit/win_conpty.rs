// SPDX-License-Identifier: Apache-2.0
use super::*;

#[test]
fn native_argv_quoting_preserves_unicode_quotes_spaces_and_trailing_backslashes() {
    let arguments = vec![
        OsString::from("white space"),
        OsString::from(r#"say "hello""#),
        OsString::from(r"C:\path with space\"),
        OsString::from("\u{7D42}\u{7AEF}\u{20000}"),
    ];
    let command_line = build_command_line(
        OsStr::new("C:\\Program Files\\終端\u{20000}\\shell.exe"),
        &arguments,
    )
    .expect("valid native argv");
    assert_eq!(command_line.last(), Some(&0));

    let actual = String::from_utf16(&command_line[..command_line.len() - 1])
        .expect("well-formed test command line");
    let expected = [
        "\"C:\\Program Files\\終端\u{20000}\\shell.exe\"",
        r#""white space""#,
        r#""say \"hello\"""#,
        r#""C:\path with space\\""#,
        "\"\u{7D42}\u{7AEF}\u{20000}\"",
    ]
    .join(" ");
    assert_eq!(actual, expected);
}

#[test]
fn native_argv_rejects_embedded_nul_and_overlong_command_line() {
    assert!(build_command_line(
        OsStr::new(r"C:\Windows\System32\cmd.exe"),
        &[OsString::from("bad\0argument")]
    )
    .is_err());

    let oversized = OsString::from("x".repeat(MAX_WIN32_STRING_UTF16));
    assert!(build_command_line(OsStr::new(r"C:\Windows\System32\cmd.exe"), &[oversized]).is_err());
}

#[test]
fn working_directory_normalization_preserves_drive_and_unicode_paths() {
    for (input, expected) in [
        (r"C:\work\dir", r"C:\work\dir"),
        (r"\\?\C:\work\dir", r"C:\work\dir"),
        (
            "\\\\?\\C:\\work\\test \u{5DE5}\u{4F5C}\u{5340} \u{20000}",
            "C:\\work\\test \u{5DE5}\u{4F5C}\u{5340} \u{20000}",
        ),
        (r"\\server\share\work", r"\\server\share\work"),
        (r"\\?\UNC\server\share\work", r"\\server\share\work"),
    ] {
        let wide = working_directory_for_create_process(Path::new(input))
            .expect("valid working directory");
        assert_eq!(wide.last(), Some(&0));
        let actual = String::from_utf16(&wide[..wide.len() - 1]).expect("valid UTF-16");
        assert_eq!(actual, expected);
    }
}

#[test]
fn working_directory_normalization_rejects_unsupported_namespaces() {
    for unsupported in [
        r"\\?\Volume{00000000-0000-0000-0000-000000000000}\work",
        r"\\?\GLOBALROOT\Device\HarddiskVolume1\work",
        r"\\.\PhysicalDrive0",
        r"relative\path",
    ] {
        assert!(working_directory_for_create_process(Path::new(unsupported)).is_err());
    }
}

struct TempDirCleanup(PathBuf);
impl Drop for TempDirCleanup {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn native_conpty_shell_spawns_in_canonical_unicode_working_directory_and_writes_file() {
    let pty_system = JobPtySystem;
    let mut pair = pty_system
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .expect("open native ConPTY pair");

    let base_dir =
        std::env::temp_dir().join(format!("modutex-conpty-test-{}", uuid::Uuid::new_v4()));
    let _cleanup = TempDirCleanup(base_dir.clone());
    let unicode_workspace = base_dir.join("\u{5DE5}\u{4F5C}\u{5340} \u{20000}");
    fs::create_dir_all(&unicode_workspace).expect("create test Unicode workspace directory");

    let cmd_path = std::env::var_os("COMSPEC")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Windows\System32\cmd.exe"));
    assert!(cmd_path.exists(), "cmd.exe must exist");

    let args = vec![OsString::from("/D"), OsString::from("/Q")];
    let descriptor = NativeSpawnDescriptor {
        executable: &cmd_path,
        arguments: &args,
        working_directory: &unicode_workspace,
    };

    let mut child = pair
        .spawn_trusted(&descriptor)
        .expect("spawn trusted shell inside Unicode workspace");

    let mut writer = pair.master.take_writer().expect("take PTY writer");
    let proof_name = "terminal-proof.txt";
    let proof_marker = format!("conpty-proof-{}", uuid::Uuid::new_v4());

    let command = format!("echo {proof_marker}>{proof_name}\r\nexit\r\n");
    writer
        .write_all(command.as_bytes())
        .expect("write command to ConPTY input");
    let _ = writer.flush();

    let proof_file = unicode_workspace.join(proof_name);
    let file_deadline = Instant::now() + Duration::from_secs(10);
    let mut actual_bytes = Vec::new();
    while Instant::now() < file_deadline {
        if proof_file.is_file() {
            if let Ok(bytes) = fs::read(&proof_file) {
                if bytes
                    .windows(proof_marker.len())
                    .any(|window| window == proof_marker.as_bytes())
                {
                    actual_bytes = bytes;
                    break;
                }
            }
        }
        thread::sleep(Duration::from_millis(25));
    }
    assert!(
        !actual_bytes.is_empty(),
        "shell must write file in canonical Unicode working directory"
    );

    let child_deadline = Instant::now() + Duration::from_secs(10);
    let mut exit_status = None;
    while Instant::now() < child_deadline {
        if let Some(status) = child.child.try_wait().expect("poll child status") {
            exit_status = Some(status);
            break;
        }
        thread::sleep(Duration::from_millis(25));
    }
    if exit_status.is_none() {
        let _ = child.job.terminate_all(1);
    }
    assert!(
        exit_status.is_some(),
        "child process did not exit within bounded timeout"
    );
}
