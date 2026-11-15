// SPDX-License-Identifier: Apache-2.0
use super::*;
use crate::schemas::draft::DraftRenderableRecord;
use uuid::Uuid;

#[test]
fn parses_aux_and_bbl_exports_and_merges_citations() {
    let aux = r#"
\relax
\newlabel{sec:intro}{{1.1}{3}{Introduction}{section.1.1}{}}
\bibcite{knuth84}{Knuth84}
\citation{knuth84,lamport94}
"#;
    let bbl = r#"
\begin{thebibliography}{9}
\bibitem[Knuth, 1984]{knuth84}
Donald E. Knuth.
\newblock The \TeX book.
\bibitem{lamport94}
Leslie Lamport. LaTeX: A Document Preparation System.
\end{thebibliography}
"#;
    let (references, bibliography) = parse_aux_exports(aux, bbl);
    let intro = references
        .iter()
        .find(|item| item.key == "sec:intro")
        .expect("sec:intro reference");
    assert_eq!(intro.label, "1.1");
    assert_eq!(intro.page.as_deref(), Some("3"));

    let knuth_ref = references
        .iter()
        .find(|item| item.key == "knuth84")
        .expect("knuth84 citation reference");
    assert_eq!(knuth_ref.label, "Knuth84");

    assert_eq!(bibliography.len(), 2);
    assert_eq!(bibliography[0].key, "knuth84");
    assert_eq!(
        bibliography[0].citation_label.as_deref(),
        Some("Knuth, 1984")
    );
    assert!(bibliography[0].text.contains("Donald E. Knuth."));
    assert_eq!(bibliography[1].key, "lamport94");
}

#[test]
fn validates_geometry_pages_and_entry_paths() {
    assert!(validate_entry_path(&RelativePath::parse("chapters/main.TEX").unwrap()).is_ok());
    assert_eq!(
        validate_entry_path(&RelativePath::parse("chapters/notes.md").unwrap())
            .unwrap_err()
            .code,
        DraftErrorCode::InvalidRequest
    );

    let mut geom = DraftGeometry::default();
    assert!(valid_geometry(&geom));
    geom.paper_width_pt = -1.0;
    assert!(!valid_geometry(&geom));
    geom.paper_width_pt = f64::NAN;
    assert!(!valid_geometry(&geom));

    let valid_record = DraftRenderableRecord {
        kind: "glyph".to_owned(),
        text: Some("hello".to_owned()),
        x_pt: 72.0,
        y_pt: 72.0,
        width_pt: 24.0,
        height_pt: 10.0,
        font_id: Some(1),
    };
    let mut page = DraftPageRecord {
        number: 1,
        width_pt: 612.0,
        height_pt: 792.0,
        shipout_baseline_height_pt: 720.0,
        renderable_records: vec![valid_record],
        unsupported_content_reasons: Vec::new(),
    };
    assert!(valid_page(&page));
    page.number = 0;
    assert!(!valid_page(&page));
    page.number = 1;
    page.renderable_records[0].x_pt = f64::INFINITY;
    assert!(!valid_page(&page));
}

#[test]
fn replaces_source_range_and_rejects_invalid_utf8_or_bounds() {
    let original = "Hello \\textbf{world}!\n".as_bytes();
    let updated = replace_source_range(
        original,
        DraftSourceRange {
            start_byte: 6,
            end_byte: 20,
        },
        "\\emph{ModuTeX}",
    )
    .unwrap();
    assert_eq!(
        std::str::from_utf8(&updated).unwrap(),
        "Hello \\emph{ModuTeX}!\n"
    );

    // Inverted range
    assert_eq!(
        replace_source_range(
            original,
            DraftSourceRange {
                start_byte: 10,
                end_byte: 5,
            },
            "x",
        )
        .unwrap_err()
        .code,
        DraftErrorCode::InputTooLarge
    );

    // Splitting multi-byte UTF-8 character
    let multibyte = "測試文本".as_bytes();
    assert_eq!(
        replace_source_range(
            multibyte,
            DraftSourceRange {
                start_byte: 1,
                end_byte: 3,
            },
            "A",
        )
        .unwrap_err()
        .code,
        DraftErrorCode::InvalidRequest
    );
}

#[test]
fn sanitizes_logs_extracts_diagnostics_and_collects_workspace_images() {
    let root = env::temp_dir().join(format!("modutex-draft-test-{}", Uuid::new_v4()));
    let figures_dir = root.join("figures");
    fs::create_dir_all(&figures_dir).unwrap();
    let img_path = figures_dir.join("plot.png");
    fs::write(&img_path, b"png").unwrap();
    let ignored_path = figures_dir.join("notes.txt");
    fs::write(&ignored_path, b"txt").unwrap();

    let tex_bin = PathBuf::from(r"C:\texlive\2025\bin\windows\lualatex.exe");
    let raw_log = format!(
        "This is LuaHBTeX from {}\nEntering {}\n! Undefined control sequence.\nLaTeX Warning: Label(s) may have changed.\n",
        tex_bin.display(),
        root.display()
    );
    let sanitized = sanitize_log(&raw_log, &root, &tex_bin);
    assert!(sanitized.contains("<draft-work>"));
    assert!(sanitized.contains("<tex-distribution>"));
    assert!(!sanitized.contains(&root.to_string_lossy().to_string()));

    let diags = diagnostics_from_log(&sanitized);
    assert_eq!(diags.len(), 2);
    assert_eq!(diags[0].severity, Severity::Error);
    assert_eq!(diags[1].severity, Severity::Warning);

    let fls = format!(
        "PWD {}\nINPUT figures/plot.png\nINPUT figures/plot.png\nINPUT figures/notes.txt\n",
        root.display()
    );
    let images = collect_workspace_images(&root, &fls);
    let _ = fs::remove_dir_all(&root);
    assert_eq!(images.len(), 1);
    assert_eq!(images[0].path.as_str(), "figures/plot.png");
}
