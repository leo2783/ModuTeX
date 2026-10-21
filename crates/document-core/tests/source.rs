// SPDX-License-Identifier: Apache-2.0
use modutex_document_core::changes::SourcePatch;
use modutex_document_core::source::{SourceDocument, SourceError, SourceTransaction};
use modutex_document_core::LineEndings;

fn open(text: &str, document_id: &str) -> SourceDocument {
    SourceDocument::open(text.as_bytes(), document_id.to_owned()).expect("valid test source")
}

fn patch(from: usize, to: usize, insert: &str, expected: Option<&str>) -> SourcePatch {
    SourcePatch {
        from,
        to,
        insert: insert.to_owned(),
        expected: expected.map(str::to_owned),
    }
}

#[test]
fn preserves_bom_mixed_line_endings_and_owned_input_bytes() {
    let mut original = vec![0xef, 0xbb, 0xbf];
    original.extend_from_slice("\u{feff}A\r\nB\nC\rD\r\n".as_bytes());
    let expected = original.clone();

    let document = SourceDocument::open(&original, "opaque-document-id".to_owned())
        .expect("valid UTF-8 source");

    assert!(document.profile().bom);
    assert_eq!(document.profile().encoding, "utf-8");
    assert_eq!(document.profile().preferred_line_ending, "\r\n");
    assert_eq!(
        document.profile().original_line_endings,
        LineEndings {
            lf: 1,
            crlf: 2,
            cr: 1,
        }
    );
    assert_eq!(document.byte_len(), expected.len());
    assert_eq!(document.to_bytes(), expected);
    assert_eq!(document.document_id(), "opaque-document-id");

    original.fill(0);
    assert_eq!(document.to_bytes(), expected);
}

#[test]
fn public_offsets_are_utf16_and_never_split_a_scalar() {
    let document = open("A\u{10400}\u{4e2d}B", "document-1");

    assert_eq!(document.len(), 5);
    assert_eq!(document.byte_len(), 9);
    assert_eq!(
        document.read(1, 3).expect("whole astral scalar"),
        "\u{10400}"
    );
    assert_eq!(document.read(1, 2).unwrap_err(), SourceError::Range);
    assert_eq!(document.read(0, 2).unwrap_err(), SourceError::Range);

    let split_patch = SourceTransaction {
        expected_version: 0,
        patches: vec![patch(2, 2, "x", None)],
    };
    assert_eq!(
        document.apply(&split_patch).unwrap_err(),
        SourceError::Range
    );

    let update = document
        .apply(&SourceTransaction {
            expected_version: 0,
            patches: vec![patch(1, 3, "X", Some("\u{10400}"))],
        })
        .expect("replace one scalar");
    assert_eq!(update.document.text(), "AX\u{4e2d}B");
    assert_eq!(update.document.len(), 4);
    assert_eq!(update.document.to_bytes(), "AX\u{4e2d}B".as_bytes());
    assert_eq!(document.text(), "A\u{10400}\u{4e2d}B");
}

#[test]
fn transactions_validate_atomically_and_noops_do_not_advance_versions() {
    let document = open("abcdefghij", "document-1");
    let original_bytes = document.to_bytes();

    let invalid_expected = SourceTransaction {
        expected_version: 0,
        patches: vec![
            patch(1, 3, "X", Some("bc")),
            patch(7, 9, "Y", Some("wrong")),
        ],
    };
    assert_eq!(
        document.apply(&invalid_expected).unwrap_err(),
        SourceError::Content
    );
    assert_eq!(document.to_bytes(), original_bytes);
    assert_eq!(document.version(), 0);

    let out_of_order = SourceTransaction {
        expected_version: 0,
        patches: vec![patch(3, 4, "X", None), patch(1, 2, "Y", None)],
    };
    assert_eq!(
        document.apply(&out_of_order).unwrap_err(),
        SourceError::Patch
    );

    let overlapping = SourceTransaction {
        expected_version: 0,
        patches: vec![patch(1, 4, "X", None), patch(3, 5, "Y", None)],
    };
    assert_eq!(
        document.apply(&overlapping).unwrap_err(),
        SourceError::Patch
    );

    let stale = SourceTransaction {
        expected_version: 1,
        patches: Vec::new(),
    };
    assert_eq!(document.apply(&stale).unwrap_err(), SourceError::Version);

    let noop = document
        .apply(&SourceTransaction {
            expected_version: 0,
            patches: vec![patch(1, 2, "b", Some("b"))],
        })
        .expect("no-op transaction");
    assert_eq!(noop.document.version(), 0);
    assert_eq!(noop.change.before_version, 0);
    assert_eq!(noop.change.after_version, 0);
    assert!(noop.change.patches.is_empty());
    assert_eq!(noop.document.to_bytes(), original_bytes);
}

#[test]
fn multi_patch_edits_use_original_coordinates_and_preserve_untouched_bytes() {
    let document = open("abcdefghij", "document-1");
    let update = document
        .apply(&SourceTransaction {
            expected_version: 0,
            patches: vec![
                patch(1, 3, "\u{4e2d}", Some("bc")),
                patch(7, 9, "XYZ", Some("hi")),
            ],
        })
        .expect("ordered non-overlapping patches");

    assert_eq!(document.text(), "abcdefghij");
    assert_eq!(update.document.text(), "a\u{4e2d}defgXYZj");
    assert_eq!(update.document.version(), 1);
    assert_eq!(update.document.to_bytes(), "a\u{4e2d}defgXYZj".as_bytes());
    assert_eq!(update.change.old_length, 10);
    assert_eq!(update.change.new_length, 10);
}

#[test]
fn restore_shares_snapshot_content_without_rewinding_versions() {
    let original = vec![
        0xef, 0xbb, 0xbf, b'A', b'\r', b'\n', 0xf0, 0x90, 0x90, 0x80, b'\r', b'\n',
    ];
    let initial =
        SourceDocument::open(&original, "document-1".to_owned()).expect("valid UTF-8 source");
    let edited = initial
        .apply(&SourceTransaction {
            expected_version: 0,
            patches: vec![patch(0, 1, "changed", Some("A"))],
        })
        .expect("edit")
        .document;

    let undo = edited
        .restore(&initial, 1)
        .expect("restore initial snapshot");
    assert_eq!(undo.version(), 2);
    assert_eq!(undo.to_bytes(), original);
    assert_eq!(edited.to_bytes()[..4], [0xef, 0xbb, 0xbf, b'c']);
    assert_eq!(
        edited.restore(&initial, 0).unwrap_err(),
        SourceError::Version
    );

    let redo = undo.restore(&edited, 2).expect("restore edited snapshot");
    assert_eq!(redo.version(), 3);
    assert_eq!(redo.to_bytes(), edited.to_bytes());

    let foreign = SourceDocument::open(&original, "document-1".to_owned()).expect("another source");
    assert_eq!(redo.restore(&foreign, 3).unwrap_err(), SourceError::Origin);
}

#[test]
fn invalid_utf8_is_rejected_without_repair() {
    for bytes in [
        &[0xc0, 0xaf][..],
        &[0xe2, 0x82][..],
        &[0xed, 0xa0, 0x80][..],
    ] {
        assert_eq!(
            SourceDocument::open(bytes, "document-1".to_owned()).unwrap_err(),
            SourceError::Encoding
        );
    }
}

#[test]
fn empty_source_keeps_valid_zero_length_operations() {
    let document = SourceDocument::open(&[], "document-1".to_owned()).expect("empty source");

    assert!(document.is_empty());
    assert_eq!(document.len(), 0);
    assert_eq!(document.byte_len(), 0);
    assert_eq!(document.read(0, 0).expect("empty read"), "");
    assert!(document.to_bytes().is_empty());
}
