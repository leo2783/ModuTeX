// SPDX-License-Identifier: Apache-2.0
use modutex_document_core::{EditorPatch, EditorProjection, SourceDocument, SourceError};

fn open(text: &str) -> (EditorProjection, String) {
    let document = SourceDocument::open(text.as_bytes(), "editor-test".to_owned()).unwrap();
    EditorProjection::open(document)
}

fn normalized(text: &str) -> String {
    text.replace("\r\n", "\n").replace('\r', "\n")
}

#[test]
fn opening_preserves_bytes_and_projects_mixed_line_endings_and_utf16_positions() {
    let fixtures = [
        "",
        "a\nb\n",
        "a\r\nb\r\n",
        "a\rb\r",
        "\u{feff}a\r\n雪\n\u{20000}\rfinal",
        "\r\n\r\n",
        "a\r\nb\nc\rd",
    ];

    for fixture in fixtures {
        let (projection, editor_text) = open(fixture);
        let source_text = fixture.strip_prefix("\u{feff}").unwrap_or(fixture);
        assert_eq!(editor_text, normalized(source_text));
        assert_eq!(
            projection.document().to_bytes(),
            fixture.as_bytes().to_vec()
        );
        assert_eq!(projection.len(), editor_text.encode_utf16().count());
        assert_eq!(
            projection.to_source(projection.len()).unwrap(),
            projection.document().len()
        );
    }
}

#[test]
fn crlf_positions_map_the_complete_newline_atom() {
    let (initial, _) = open("a\r\nb\nc\rd");
    let positions: Vec<usize> = (0..=7)
        .map(|position| initial.to_source(position).unwrap())
        .collect();
    assert_eq!(positions, [0, 1, 3, 4, 5, 6, 7, 8]);

    let changed = initial
        .apply(
            &[EditorPatch {
                from: 2,
                to: 3,
                insert: "B".to_owned(),
            }],
            0,
        )
        .unwrap();
    assert_eq!(changed.document().text(), "a\r\nB\nc\rd");

    let removed = changed
        .apply(
            &[EditorPatch {
                from: 1,
                to: 2,
                insert: String::new(),
            }],
            1,
        )
        .unwrap();
    assert_eq!(removed.document().text(), "aB\nc\rd");
}

#[test]
fn inserted_editor_newlines_use_preferred_eol_without_rewriting_old_breaks() {
    let (initial, _) = open("a\r\nb\r\nc\nd");
    let changed = initial
        .apply(
            &[EditorPatch {
                from: 2,
                to: 2,
                insert: "new\nline\n".to_owned(),
            }],
            0,
        )
        .unwrap();
    assert_eq!(changed.document().text(), "a\r\nnew\r\nline\r\nb\r\nc\nd");
    assert_eq!(
        changed.to_source(changed.len()).unwrap(),
        changed.document().len()
    );
}

#[test]
fn multiple_patches_use_original_editor_coordinates() {
    let (initial, _) = open("a\r\nb\r\nc\r\nd");
    let changed = initial
        .apply(
            &[
                EditorPatch {
                    from: 0,
                    to: 1,
                    insert: "AA".to_owned(),
                },
                EditorPatch {
                    from: 4,
                    to: 5,
                    insert: "C\nC".to_owned(),
                },
            ],
            0,
        )
        .unwrap();
    assert_eq!(changed.document().text(), "AA\r\nb\r\nC\r\nC\r\nd");

    let next = changed
        .apply(
            &[EditorPatch {
                from: changed.len() - 1,
                to: changed.len(),
                insert: "D".to_owned(),
            }],
            1,
        )
        .unwrap();
    assert_eq!(next.document().text(), "AA\r\nb\r\nC\r\nC\r\nD");
}

#[test]
fn restore_keeps_bytes_and_coordinates_while_versions_increase() {
    let (initial, _) = open("\u{feff}a\r\nb\nc\rd");
    let initial_bytes = initial.document().to_bytes();
    let edited = initial
        .apply(
            &[EditorPatch {
                from: 1,
                to: 6,
                insert: "\nnew\n".to_owned(),
            }],
            0,
        )
        .unwrap();

    let undo = edited.restore(&initial).unwrap();
    assert_eq!(undo.document().to_bytes(), initial_bytes);
    let redo = undo.restore(&edited).unwrap();
    assert_eq!(redo.document().to_bytes(), edited.document().to_bytes());
    assert_eq!(
        [
            edited.document().version(),
            undo.document().version(),
            redo.document().version(),
        ],
        [1, 2, 3]
    );
    assert_eq!(redo.to_source(redo.len()).unwrap(), redo.document().len());
}

#[test]
fn invalid_stale_and_unicode_splitting_edits_are_rejected_atomically() {
    let (initial, _) = open("\u{20000}\r\ntext");
    let original_bytes = initial.document().to_bytes();

    assert!(matches!(
        initial.apply(
            &[EditorPatch {
                from: 1,
                to: 1,
                insert: "x".to_owned(),
            }],
            0
        ),
        Err(SourceError::Range)
    ));
    assert!(matches!(
        initial.apply(
            &[EditorPatch {
                from: 0,
                to: 0,
                insert: "\r\n".to_owned(),
            }],
            0
        ),
        Err(SourceError::Patch)
    ));
    assert!(matches!(
        initial.apply(
            &[EditorPatch {
                from: 0,
                to: 0,
                insert: "x".to_owned(),
            }],
            2
        ),
        Err(SourceError::Version)
    ));
    assert!(matches!(
        initial.to_source(initial.len() + 1),
        Err(SourceError::Range)
    ));
    assert!(matches!(
        initial.apply(
            &[
                EditorPatch {
                    from: 0,
                    to: 4,
                    insert: "x".to_owned(),
                },
                EditorPatch {
                    from: 3,
                    to: 5,
                    insert: "y".to_owned(),
                },
            ],
            0
        ),
        Err(SourceError::Patch)
    ));

    let (other, _) = open("another source");
    assert!(matches!(initial.restore(&other), Err(SourceError::Origin)));
    assert_eq!(initial.document().to_bytes(), original_bytes);
    assert_eq!(initial.document().version(), 0);
}

#[test]
fn incremental_edits_match_a_normalized_editor_text_oracle() {
    let (mut projection, _) = open("a\r\nb\nc\rd\r\n");
    let mut oracle = normalized(&projection.document().text());

    for index in 0..150 {
        let length = oracle.encode_utf16().count();
        let from = (index * 17) % (length + 1);
        let to = (from + index % 3).min(length);
        let insert = match index % 4 {
            0 => "x",
            1 => "\n",
            2 => "A\nB",
            _ => "",
        };

        projection = projection
            .apply(
                &[EditorPatch {
                    from,
                    to,
                    insert: insert.to_owned(),
                }],
                projection.document().version(),
            )
            .unwrap();
        oracle.replace_range(from..to, insert);
        for correction in projection.editor_corrections().iter().rev() {
            oracle.replace_range(correction.from..correction.to, &correction.insert);
        }

        assert_eq!(normalized(&projection.document().text()), oracle);
        assert_eq!(projection.len(), oracle.encode_utf16().count());
        assert_eq!(
            projection.to_source(projection.len()).unwrap(),
            projection.document().len()
        );
    }
}

#[test]
fn one_transaction_joins_many_crlf_boundaries_and_restores_history() {
    for count in [1, 8, 128, 1024] {
        let input = format!("\u{feff}{}", "A\rX\nB\r\n".repeat(count));
        let (initial, _) = open(&input);
        let patches: Vec<EditorPatch> = (0..count)
            .map(|index| EditorPatch {
                from: index * 6 + 2,
                to: index * 6 + 3,
                insert: String::new(),
            })
            .collect();
        let edited = initial.apply(&patches, 0).unwrap();
        let expected = format!("\u{feff}{}", "A\r\nB\r\n".repeat(count));

        assert_eq!(edited.document().to_bytes(), expected.as_bytes());
        assert_eq!(edited.editor_corrections().len(), count);

        let (oracle, _) = open(&expected);
        for position in 0..=oracle.len() {
            assert_eq!(
                edited.to_source(position).unwrap(),
                oracle.to_source(position).unwrap()
            );
        }

        let undone = edited.restore(&initial).unwrap();
        assert_eq!(undone.document().to_bytes(), input.as_bytes());
        let redone = undone.restore(&edited).unwrap();
        assert_eq!(redone.document().to_bytes(), edited.document().to_bytes());
        assert_eq!(
            [
                edited.document().version(),
                undone.document().version(),
                redone.document().version(),
            ],
            [1, 2, 3]
        );
    }
}

#[test]
fn edits_that_join_newline_atoms_report_only_the_required_correction() {
    let (initial, _) = open("\n\nA\rX\nZ");
    let changed = initial
        .apply(
            &[EditorPatch {
                from: 4,
                to: 5,
                insert: String::new(),
            }],
            0,
        )
        .unwrap();
    assert_eq!(changed.document().text(), "\n\nA\r\nZ");
    assert_eq!(
        changed.editor_corrections(),
        &[EditorPatch {
            from: 4,
            to: 5,
            insert: String::new(),
        }]
    );
    assert_eq!(
        changed.len(),
        normalized(&changed.document().text())
            .encode_utf16()
            .count()
    );
    assert_eq!(
        changed.to_source(changed.len()).unwrap(),
        changed.document().len()
    );
    assert_eq!(
        changed.restore(&initial).unwrap().document().to_bytes(),
        initial.document().to_bytes()
    );

    let (after_cr, _) = open("\n\nA\rZ");
    let inserted = after_cr
        .apply(
            &[EditorPatch {
                from: 4,
                to: 4,
                insert: "\n".to_owned(),
            }],
            0,
        )
        .unwrap();
    assert_eq!(inserted.document().text(), "\n\nA\r\nZ");
    assert_eq!(
        inserted.editor_corrections(),
        &[EditorPatch {
            from: 4,
            to: 5,
            insert: String::new(),
        }]
    );

    let (before_lf, _) = open("\r\rA\nZ");
    let inserted = before_lf
        .apply(
            &[EditorPatch {
                from: 3,
                to: 3,
                insert: "\n".to_owned(),
            }],
            0,
        )
        .unwrap();
    assert_eq!(inserted.document().text(), "\r\rA\r\nZ");
    assert_eq!(
        inserted.editor_corrections(),
        &[EditorPatch {
            from: 4,
            to: 5,
            insert: String::new(),
        }]
    );
}
