// SPDX-License-Identifier: Apache-2.0

use crate::{
    schemas::draft::{DraftCompileRequest, DraftSourceRange},
    services::draft_service::{parse_aux_exports, replace_source_range},
    shared::relative_path::RelativePath,
};

#[test]
fn warm_body_rejects_tex_commands_math_and_oversized_input() {
    use crate::services::draft_warm::DraftWarmEngine;
    let document = |body: &str| {
        format!("\\documentclass{{article}}\n\\begin{{document}}\n{body}\n\\end{{document}}\n")
    };
    assert!(DraftWarmEngine::safe_document_body(document("Plain text").as_bytes()).is_some());
    for body in ["$x$", "\\input{secret}", "a%comment", "a_b", "a\0b"] {
        assert!(DraftWarmEngine::safe_document_body(document(body).as_bytes()).is_none());
    }
    assert!(
        DraftWarmEngine::safe_document_body(document(&"a".repeat(40_000)).as_bytes()).is_none()
    );
}

#[cfg(windows)]
#[test]
fn real_lualatex_warm_process_updates_frames_and_drains() {
    use crate::{
        platform::process_tree::cancellation_pair,
        schemas::protocol::{
            CompileRequest, DocumentId, DocumentVersion, Engine, FileRef, OwnerId, RunId, Timestamp,
        },
        services::draft_warm::DraftWarmEngine,
        services::filesystem::{CompileInputLimits, FilesystemService},
        state::{
            recent::RecentStore, sessions::SessionRegistry, settings::SettingsStore,
            workspace_leases::WorkspaceLeaseCoordinator,
        },
    };
    use std::{fs, path::PathBuf, sync::Arc, time::Duration};
    let executable = PathBuf::from(
        std::env::var_os("MODUTEX_TEST_LUALATEX").expect("set real LuaLaTeX executable"),
    );
    assert!(executable.is_file());
    let base = std::env::temp_dir().join(format!(
        "modutex-warm-test-{}",
        uuid::Uuid::new_v4().simple()
    ));
    fs::create_dir(&base).unwrap();
    let workspace = base.join("workspace");
    let scratch = base.join("scratch");
    fs::create_dir(&workspace).unwrap();
    fs::create_dir(&scratch).unwrap();
    let source =
        b"\\documentclass{article}\n\\begin{document}\nAlpha first frame\n\\end{document}\n";
    fs::write(workspace.join("main.tex"), source).unwrap();
    let service = FilesystemService::new(
        Arc::new(SessionRegistry::new()),
        WorkspaceLeaseCoordinator::new(),
        RecentStore::new(base.join("recent")),
        SettingsStore::new(base.join("settings")),
    );
    let owner = OwnerId::from_label("draft-real-warm").unwrap();
    let entry = RelativePath::parse("main.tex").unwrap();
    let opened = service
        .open_workspace_folder(
            &owner,
            &workspace,
            Some(entry.clone()),
            Timestamp::new(1).unwrap(),
        )
        .unwrap()
        .opened;
    let receipt = service
        .read_file(
            &owner,
            &FileRef {
                workspace_id: opened.id.clone(),
                path: entry.clone(),
            },
        )
        .unwrap();
    let request = CompileRequest {
        workspace_id: opened.id,
        entry_path: entry.clone(),
        document_id: DocumentId::parse("warm-document").unwrap(),
        document_version: DocumentVersion::new(1).unwrap(),
        saved_revision: receipt.revision,
        engine: Engine::System,
    };
    let run = RunId::parse("warm-start").unwrap();
    let mut ticket = service
        .prepare_compile(&owner, run.clone(), &request, Box::new(|| Ok(())))
        .unwrap();
    let snapshot = service
        .capture_compile_snapshot(
            &ticket,
            CompileInputLimits {
                max_depth: 8,
                max_entries: 32,
                max_file_bytes: 1024 * 1024,
                max_total_bytes: 2 * 1024 * 1024,
            },
        )
        .unwrap();
    let (_, cancellation) = cancellation_pair();
    let mut engine = match DraftWarmEngine::start(
        &executable,
        &scratch,
        &run,
        &entry,
        &snapshot,
        &cancellation,
        Duration::from_secs(40),
    ) {
        Ok(engine) => engine,
        Err(mut error) => {
            if let Some(pending) = error.pending.as_mut() {
                let _ = pending.stop(&cancellation, Duration::from_secs(10));
            }
            ticket.finish_drain();
            panic!("warm startup: {}", error.detail);
        }
    };
    let pid = engine.session.pid();
    let private_root = engine.root().to_owned();
    let text = |frame: &crate::services::draft_warm::DraftWarmFrame| {
        frame
            .extraction
            .pages
            .iter()
            .flat_map(|page| &page.renderable_records)
            .filter_map(|record| record.text.as_deref())
            .collect::<String>()
    };
    let verification = (|| -> Result<(), String> {
        let first = engine.typeset(
            &RunId::parse("warm-first").unwrap(),
            &entry,
            &snapshot,
            "Alpha first frame",
            &cancellation,
            Duration::from_secs(30),
        )?;
        let second = engine.typeset(
            &RunId::parse("warm-second").unwrap(),
            &entry,
            &snapshot,
            "Zebra second frame",
            &cancellation,
            Duration::from_secs(30),
        )?;
        assert_eq!(engine.session.pid(), pid);
        assert_ne!(text(&first), text(&second));
        assert!(
            text(&first).contains("Alpha"),
            "first glyphs: {}",
            text(&first)
        );
        assert!(
            text(&second).contains("Zebra"),
            "second glyphs: {}",
            text(&second)
        );
        assert!(first
            .extraction
            .pages
            .iter()
            .all(|page| page.width_pt > 0.0 && page.height_pt > 0.0));
        assert!(engine.is_usable());
        Ok(())
    })();
    let cleanup = engine.stop(&cancellation, Duration::from_secs(10));
    let drained = engine.is_drained();
    ticket.finish_drain();
    assert!(cleanup.is_ok(), "cleanup: {cleanup:?}");
    assert!(drained);
    assert!(
        !private_root.exists(),
        "private tree must retire after process drain"
    );
    drop(engine);
    drop(ticket);
    drop(snapshot);
    drop(service);
    fs::remove_dir_all(&base).unwrap();
    assert!(verification.is_ok(), "real warm frames: {verification:?}");
}

#[test]
fn draft_compile_dto_is_strict_and_workspace_relative() {
    let request: DraftCompileRequest = serde_json::from_str(
        r#"{
            "workspaceId":"workspace_1",
            "entryPath":"src/main.tex",
            "documentId":"document_1",
            "documentVersion":4,
            "savedRevision":"disk:revision-1"
        }"#,
    )
    .expect("valid Draft compile DTO");
    assert_eq!(request.entry_path.as_str(), "src/main.tex");

    let with_tool: Result<DraftCompileRequest, _> = serde_json::from_str(
        r#"{
            "workspaceId":"workspace_1",
            "entryPath":"main.tex",
            "documentId":"document_1",
            "documentVersion":4,
            "savedRevision":"disk:revision-1",
            "executable":"arbitrary.exe"
        }"#,
    );
    assert!(with_tool.is_err());
    assert!(RelativePath::parse("../outside.tex").is_err());
}

#[test]
fn paragraph_overlay_requires_utf8_boundaries_and_respects_bounds() {
    let original = "A\u{20000}B".as_bytes();
    let replaced = replace_source_range(
        original,
        DraftSourceRange {
            start_byte: 1,
            end_byte: 5,
        },
        "paragraph",
    )
    .expect("replacement at UTF-8 boundaries");
    assert_eq!(replaced, b"AparagraphB");

    assert!(replace_source_range(
        original,
        DraftSourceRange {
            start_byte: 2,
            end_byte: 5,
        },
        "x",
    )
    .is_err());
    assert!(replace_source_range(
        original,
        DraftSourceRange {
            start_byte: 5,
            end_byte: 1,
        },
        "x",
    )
    .is_err());
}

#[test]
fn aux_and_bbl_exports_preserve_nested_reference_groups() {
    let (references, bibliography) = parse_aux_exports(
        r#"\newlabel{sec:intro}{{2.1}{7}{Intro}{section.2.1}{}}
\citation{knuth,lamport}
\bibcite{knuth}{1}"#,
        r#"\begin{thebibliography}{1}
\bibitem{knuth} Knuth, \emph{The TeXbook}.
\bibitem[2]{lamport} Lamport, \emph{LaTeX}.
\end{thebibliography}"#,
    );
    assert_eq!(references.len(), 3);
    assert_eq!(references[0].key, "knuth");
    assert_eq!(references[0].label, "1");
    assert_eq!(references[2].page.as_deref(), Some("7"));
    assert_eq!(bibliography.len(), 2);
    assert_eq!(bibliography[1].citation_label.as_deref(), Some("2"));
}
