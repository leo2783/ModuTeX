// SPDX-License-Identifier: Apache-2.0
use super::*;

#[test]
fn typing_compacts_small_pieces_without_copying_the_large_original() {
    let original = "a".repeat(1024 * 1024);
    let snapshot =
        SourceDocument::open(original.as_bytes(), "large-source".to_owned()).expect("valid source");
    let source = Arc::clone(&snapshot.pieces[0].source);
    let mut document = snapshot.clone();
    let mut compactions = 0;

    for _ in 0..2048 {
        let previous_count = document.piece_count();
        let position = document.len();
        document = document
            .apply(&SourceTransaction {
                expected_version: document.version(),
                patches: vec![SourcePatch {
                    from: position,
                    to: position,
                    insert: "x".to_owned(),
                    expected: None,
                }],
            })
            .expect("append character")
            .document;
        assert!(document.piece_count() <= MAX_PIECES);
        assert!(Arc::ptr_eq(&document.pieces[0].source, &source));
        if document.piece_count() < previous_count {
            compactions += 1;
        }
    }

    assert!(compactions > 1);
    assert_eq!(document.text(), format!("{original}{}", "x".repeat(2048)));
    assert_eq!(snapshot.text(), original);
    assert_eq!(snapshot.version(), 0);
}
