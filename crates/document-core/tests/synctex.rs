// SPDX-License-Identifier: Apache-2.0
use flate2::write::GzEncoder;
use flate2::Compression;
use modutex_document_core::{SynctexError, SynctexIndex};
use std::io::Write;

fn document(
    inputs: &str,
    records: &str,
    unit: &str,
    magnification: &str,
    x_offset: &str,
    y_offset: &str,
) -> Vec<u8> {
    format!(
		"SyncTeX Version:1\n{inputs}Output:pdf\nMagnification:{magnification}\nUnit:{unit}\nX Offset:{x_offset}\nY Offset:{y_offset}\nContent:\n{records}Postamble:\nCount:30\n!17\nPost scriptum:\n!24\n"
	)
	.into_bytes()
}

fn simple_records() -> &'static str {
    "{1\n[17,7:655360,1310720:1310720,655360,65536\nh17,7,4:655360,1310720:655360,327680,65536\n]\n}1\n"
}

#[test]
fn cjk_punctuation_rules_preserve_signed_width_and_navigation() {
    // Actual XeTeX/xeCJK punctuation adjustment from the bilingual article.
    let bytes = document(
        "Input:1:article.tex\n",
        "{1\nr1,5:18496774,8865055:-422052,0,0\n}1\n",
        "1",
        "1000",
        "0",
        "0",
    );
    let index = SynctexIndex::parse(&bytes).expect("signed rule width is valid SyncTeX");
    let location = index.forward_search("article.tex", 5, None).unwrap();
    assert!(location.width < 0.0);
    let source = index
        .inverse_search(1, location.x + location.width / 2.0, location.y)
        .unwrap();
    assert_eq!(source.path, "article.tex");
    assert_eq!(source.line, 5);
}

#[test]
fn forward_and_inverse_search_use_pdf_points_and_preserve_source_identity() {
    let source = r"C:\Users\TeX\文档\main.tex";
    let inputs = format!("Input:17:{source}\n");
    let bytes = document(&inputs, simple_records(), "1", "1000", "0", "0");
    let index = SynctexIndex::parse(&bytes).expect("valid plain SyncTeX");
    let location = index
        .forward_search(source, 7, None)
        .expect("mapped source line");
    let sp_to_bp = 7200.0 / 7227.0 / 65536.0;
    assert_eq!(location.page, 1);
    assert!((location.x - 10.0 * 7200.0 / 7227.0).abs() < 1e-9);
    assert!((location.y - 15.0 * 7200.0 / 7227.0).abs() < 1e-9);
    assert!((location.width - 10.0 * 7200.0 / 7227.0).abs() < 1e-9);
    assert!((location.height - 5.0 * 7200.0 / 7227.0).abs() < 1e-9);
    assert!((location.depth - sp_to_bp * 65536.0).abs() < 1e-9);

    let source_location = index
        .inverse_search(
            location.page,
            location.x + location.width / 2.0,
            location.y + location.height / 2.0,
        )
        .expect("mapped PDF point");
    assert_eq!(source_location.path, source);
    assert_eq!(source_location.line, 7);
    assert_eq!(source_location.column, Some(4));
}

#[test]
fn gzip_and_plain_inputs_build_identical_indexes() {
    let plain = document(
        "Input:17:C:\\資料\\main.tex\n",
        simple_records(),
        "1",
        "1000",
        "0",
        "0",
    );
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(&plain).expect("gzip input");
    let gzip = encoder.finish().expect("complete gzip");

    let plain_index = SynctexIndex::parse(&plain).expect("plain SyncTeX");
    let gzip_index = SynctexIndex::parse(&gzip).expect("gzip SyncTeX");
    assert_eq!(
        plain_index.forward_search(r"C:/資料/main.tex", 7, None),
        gzip_index.forward_search(r"C:\資料\main.tex", 7, None)
    );
}

#[test]
fn windows_paths_are_not_resolved_by_basename_and_sparse_tags_are_preserved() {
    let inputs = concat!(
        "Input:2:C:\\alpha\\paper.tex\n",
        "Input:900:C:\\beta\\paper.tex\n",
        "Input:901:\n",
    );
    let records = concat!(
        "{1\n",
        "[2,3:655360,1310720:655360,327680,0\n",
        "]\n",
        "}1\n",
        "{2\n",
        "[900,3:1310720,1310720:655360,327680,0\n",
        "]\n",
        "}2\n",
    );
    let index = SynctexIndex::parse(&document(inputs, records, "1", "1000", "0", "0"))
        .expect("valid sparse input tags");

    let alpha = index
        .forward_search(r"C:\alpha\paper.tex", 3, None)
        .expect("first full path");
    let beta = index
        .forward_search(r"C:\beta\paper.tex", 3, None)
        .expect("second full path");
    assert_ne!(alpha.x, beta.x);
    assert!(index.forward_search("paper.tex", 3, None).is_none());
}

#[test]
fn offsets_magnification_nested_boxes_and_page_hints_are_applied() {
    let records = concat!(
        "{1\n",
        "[1,5:655360,1310720:1310720,655360,0\n",
        "(1,5:655360,1310720:655360,327680,0\n",
        "h1,5:655360,1310720:327680,327680,0\n",
        ")\n",
        "]\n",
        "}1\n",
        "{2\n",
        "[1,5:3276800,1310720:1310720,655360,0\n",
        "h1,5:3276800,1310720:655360,327680,0\n",
        "]\n",
        "}2\n",
    );
    let index = SynctexIndex::parse(&document(
        "Input:1:C:\\project\\main.tex\n",
        records,
        "2",
        "2000",
        "65536",
        "-65536",
    ))
    .expect("valid transformed records");

    let page_one = index
        .forward_search("C:/project/main.tex", 5, Some(1))
        .expect("first hinted page");
    let page_two = index
        .forward_search("C:/project/main.tex", 5, Some(2))
        .expect("second hinted page");
    assert_eq!(page_one.page, 1);
    assert_eq!(page_two.page, 2);
    assert!(page_two.x > page_one.x);

    let scale = 4.0 * 7200.0 / 7227.0 / 65536.0;
    assert!((page_one.x - 11.0 * 65536.0 * scale).abs() < 1e-9);
    assert!((page_one.y - 14.0 * 65536.0 * scale).abs() < 1e-9);
    assert_eq!(
        index
            .inverse_search(
                2,
                page_two.x + page_two.width / 2.0,
                page_two.y + page_two.height / 2.0,
            )
            .map(|location| (location.path, location.line)),
        Some((String::from("C:\\project\\main.tex"), 5))
    );
}

#[test]
fn parses_the_owned_tectonic_fixture_and_accepts_empty_input_labels() {
    let fixture = r"SyncTeX Version:1
Input:1:C:\Users\qet63\Documents\ModuTeX\.verification-artifacts\tauri\engine-runtime-20261018-b\src\main.tex
Input:2:
Input:3:
Input:4:
Input:5:
Input:6:
Output:pdf
Magnification:1000
Unit:1
X Offset:0
Y Offset:0
Content:
!241
{1
[1,6:4736287,46220575:26673152,41484288,0
(1,6:4736287,4736287:0,0,0
)
[1,6:8799519,46220575:22609920,40435712,0
[1,6:8799519,6571295:22609920,786432,0
(1,6:8799519,6571295:22609920,0,0
h1,6:8799519,6571295:22609920,0,0
)
]
[1,6:8799519,44254495:22609920,36044800,0
(1,6:8799519,8865055:22609920,462029,14417
h1,4:8799519,8865055:983040,0,0
k1,5:31409439,8865055:13257277
g1,6:31409439,8865055
)
(1,6:8799519,9651487:22609920,454820,135003
g1,5:11894785,9651487
g1,5:13933610,9651487
g1,5:15774516,9651487
g1,5:17889363,9651487
k1,6:31409439,9651487:12318146
g1,6:31409439,9651487
)
]
(1,6:8799519,46220575:22609920,0,0
h1,6:8799519,46220575:22609920,0,0
)
]
]
!669
}1
Input:7:
!17
Postamble:
Count:30
!24
Post scriptum:
";
    let index = SynctexIndex::parse(fixture.as_bytes()).expect("owned Tectonic fixture");
    assert!(index
		.forward_search(
			r"C:\Users\qet63\Documents\ModuTeX\.verification-artifacts\tauri\engine-runtime-20261018-b\src\main.tex",
			6,
			Some(1),
		)
		.is_some());
}

#[test]
fn rejects_malformed_headers_structure_numbers_and_unhandled_records() {
    let valid = document(
        "Input:17:main.tex\n",
        simple_records(),
        "1",
        "1000",
        "0",
        "0",
    );
    let invalid_utf8 = [0xff, 0xfe];
    assert_eq!(
        SynctexIndex::parse(&invalid_utf8).err(),
        Some(SynctexError::InvalidUtf8)
    );

    let version_two = String::from_utf8(valid.clone())
        .expect("test document is UTF-8")
        .replacen("SyncTeX Version:1", "SyncTeX Version:2", 1);
    assert_eq!(
        SynctexIndex::parse(version_two.as_bytes()).err(),
        Some(SynctexError::UnsupportedVersion(2))
    );

    let nonfinite = document(
        "Input:17:main.tex\n",
        simple_records(),
        "NaN",
        "1000",
        "0",
        "0",
    );
    assert_eq!(
        SynctexIndex::parse(&nonfinite).err(),
        Some(SynctexError::InvalidNumber)
    );

    let zero_unit = document(
        "Input:17:main.tex\n",
        simple_records(),
        "0",
        "1000",
        "0",
        "0",
    );
    assert_eq!(
        SynctexIndex::parse(&zero_unit).err(),
        Some(SynctexError::InvalidNumber)
    );

    let overflowing_offset = document(
        "Input:17:main.tex\n",
        simple_records(),
        "1",
        "1000",
        "9223372036854775807",
        "0",
    );
    assert_eq!(
        SynctexIndex::parse(&overflowing_offset).err(),
        Some(SynctexError::InvalidCoordinate)
    );

    let mismatched_boxes = document(
        "Input:1:main.tex\n",
        "{1\n[1,1:0,0:1,1,0\n)\n}1\n",
        "1",
        "1000",
        "0",
        "0",
    );
    assert_eq!(
        SynctexIndex::parse(&mismatched_boxes).err(),
        Some(SynctexError::InvalidStructure)
    );

    let unsupported = document(
        "Input:1:main.tex\n",
        "{1\n@1,2,3\n}1\n",
        "1",
        "1000",
        "0",
        "0",
    );
    assert_eq!(
        SynctexIndex::parse(&unsupported).err(),
        Some(SynctexError::UnsupportedRecord)
    );

    let truncated = valid[..valid.len() - 12].to_vec();
    assert!(SynctexIndex::parse(&truncated).is_err());
}

#[test]
fn rejects_truncated_gzip_and_enforces_encoded_and_decoded_size_limits() {
    let plain = document(
        "Input:17:main.tex\n",
        simple_records(),
        "1",
        "1000",
        "0",
        "0",
    );
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(&plain).expect("gzip input");
    let gzip = encoder.finish().expect("complete gzip");
    assert_eq!(
        SynctexIndex::parse(&gzip[..gzip.len() - 5]).err(),
        Some(SynctexError::InvalidGzip)
    );

    let encoded_oversize = vec![b'x'; 32 * 1024 * 1024 + 1];
    assert_eq!(
        SynctexIndex::parse(&encoded_oversize).err(),
        Some(SynctexError::InputTooLarge)
    );

    let mut bomb_encoder = GzEncoder::new(Vec::new(), Compression::fast());
    let block = [b' '; 8192];
    for _ in 0..((64 * 1024 * 1024 + 8192) / 8192) {
        bomb_encoder
            .write_all(&block)
            .expect("write bounded test block");
    }
    let bomb = bomb_encoder.finish().expect("finish test gzip");
    assert_eq!(
        SynctexIndex::parse(&bomb).err(),
        Some(SynctexError::DecodedDataTooLarge)
    );
}

#[test]
fn nearest_line_and_inverse_box_distance_are_deterministic() {
    let records = concat!(
        "{1\n",
        "[1,8:655360,1310720:1310720,655360,0\n",
        "h1,8:655360,1310720:327680,327680,0\n",
        "]\n",
        "[1,10:2621440,1310720:1310720,655360,0\n",
        "h1,10:2621440,1310720:327680,327680,0\n",
        "]\n",
        "}1\n",
    );
    let index = SynctexIndex::parse(&document(
        "Input:1:main.tex\n",
        records,
        "1",
        "1000",
        "0",
        "0",
    ))
    .expect("valid nearby lines");

    let nearest = index
        .forward_search("main.tex", 9, None)
        .expect("nearest source line");
    let line_eight_x = 10.0 * 7200.0 / 7227.0;
    assert!((nearest.x - line_eight_x).abs() < 1e-9);
    let inverse = index
        .inverse_search(
            1,
            nearest.x + nearest.width / 2.0,
            nearest.y + nearest.height / 2.0,
        )
        .expect("nearest source box");
    assert_eq!(inverse.line, 8);
}
