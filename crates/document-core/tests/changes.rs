// SPDX-License-Identifier: Apache-2.0
use modutex_document_core::changes::{map_position, remap_span, Bias, SourcePatch, SourceSpan};
use modutex_document_core::source::{SourceDocument, SourceError, SourceTransaction};

fn patch(from: usize, to: usize, insert: &str) -> SourcePatch {
    SourcePatch {
        from,
        to,
        insert: insert.to_owned(),
        expected: None,
    }
}

fn span(document_id: &str, from: usize, to: usize, version: u64) -> SourceSpan {
    SourceSpan {
        document_id: document_id.to_owned(),
        from,
        to,
        version,
    }
}

#[test]
fn replacement_maps_untouched_spans_and_invalidates_intersections() {
    let document =
        SourceDocument::open(b"abcdef", "document-1".to_owned()).expect("valid UTF-8 source");
    let update = document
        .apply(&SourceTransaction {
            expected_version: 0,
            patches: vec![patch(2, 4, "XYZ")],
        })
        .expect("replace range");
    let document_id = update.document.document_id();

    assert_eq!(
        remap_span(&update.change, &span(document_id, 0, 2, 0),).expect("map preceding span"),
        Some(span(document_id, 0, 2, 1))
    );
    assert_eq!(
        remap_span(&update.change, &span(document_id, 4, 6, 0),).expect("map following span"),
        Some(span(document_id, 5, 7, 1))
    );
    assert_eq!(
        remap_span(&update.change, &span(document_id, 1, 5, 0),).expect("detect changed span"),
        None
    );
    assert_eq!(
        remap_span(&update.change, &span(document_id, 0, 2, 9),).unwrap_err(),
        SourceError::Version
    );
    assert_eq!(
        remap_span(&update.change, &span("foreign-document", 0, 2, 0),).unwrap_err(),
        SourceError::Version
    );
    assert_eq!(
        remap_span(&update.change, &span(document_id, 0, 8, 0),).unwrap_err(),
        SourceError::Range
    );
}

#[test]
fn insertion_affinity_keeps_adjacent_nodes_outside_inserted_text() {
    let document =
        SourceDocument::open(b"abcd", "document-1".to_owned()).expect("valid UTF-8 source");
    let update = document
        .apply(&SourceTransaction {
            expected_version: 0,
            patches: vec![patch(2, 2, "\u{10400}")],
        })
        .expect("insert at a scalar boundary");
    let document_id = update.document.document_id();

    assert_eq!(map_position(&update.change, 2, Bias::Before), Ok(2));
    assert_eq!(map_position(&update.change, 2, Bias::After), Ok(4));
    assert_eq!(
        remap_span(&update.change, &span(document_id, 0, 2, 0),).expect("map preceding span"),
        Some(span(document_id, 0, 2, 1))
    );
    assert_eq!(
        remap_span(&update.change, &span(document_id, 2, 4, 0),).expect("map following span"),
        Some(span(document_id, 4, 6, 1))
    );
    assert_eq!(
        remap_span(&update.change, &span(document_id, 2, 2, 0),).expect("map empty span"),
        Some(span(document_id, 4, 4, 1))
    );
    assert_eq!(
        remap_span(&update.change, &span(document_id, 1, 3, 0),).expect("detect changed span"),
        None
    );
}

#[test]
fn position_mapping_rejects_out_of_range_positions() {
    let document =
        SourceDocument::open(b"abc", "document-1".to_owned()).expect("valid UTF-8 source");
    let update = document
        .apply(&SourceTransaction {
            expected_version: 0,
            patches: vec![patch(1, 2, "XY")],
        })
        .expect("replace range");

    assert_eq!(
        map_position(&update.change, 4, Bias::After).unwrap_err(),
        SourceError::Range
    );
    assert_eq!(map_position(&update.change, 3, Bias::After), Ok(4));
}
