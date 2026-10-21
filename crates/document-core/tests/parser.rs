// SPDX-License-Identifier: Apache-2.0
use modutex_document_core::changes::SourcePatch;
use modutex_document_core::parser::{
    parse_source, projection_is_current, ParseIssueCode, ParseLimits, SyntaxKind, SyntaxNode,
};
use modutex_document_core::source::{SourceDocument, SourceTransaction};
use modutex_document_core::SourceError;

fn open(text: &str) -> SourceDocument {
    SourceDocument::open(text.as_bytes(), "parser-test".to_owned()).expect("valid UTF-8 source")
}

fn assert_partition(document: &SourceDocument, nodes: &[SyntaxNode], from: usize, to: usize) {
    let mut at = from;
    for node in nodes {
        assert_eq!(node.span.from, at);
        assert!(node.span.to > at);
        assert!(node.span.to <= to);
        assert_eq!(node.span.document_id, document.document_id());
        assert_eq!(node.span.version, document.version());
        document
            .read(node.span.from, node.span.to)
            .expect("node spans use valid UTF-16 boundaries");
        at = node.span.to;

        if let Some(content) = &node.content {
            assert!(content.from >= node.span.from);
            assert!(content.to <= node.span.to);
            assert_eq!(content.document_id, document.document_id());
            assert_eq!(content.version, document.version());
            if !node.children.is_empty() {
                assert_partition(document, &node.children, content.from, content.to);
            }
        } else {
            assert!(node.children.is_empty());
        }
    }
    assert_eq!(at, to);
}

#[test]
fn astral_scalars_keep_utf16_offsets_and_source_bytes() {
    let source = format!("a{}\\section{{Heading}}", '\u{10400}');
    let document = open(&source);
    let original = document.to_bytes();
    let projection = parse_source(&document, ParseLimits::default()).expect("parse source");

    let heading = projection
        .nodes
        .iter()
        .find(|node| node.kind == SyntaxKind::Heading)
        .expect("heading is projected");
    assert_eq!(heading.span.from, 3);
    assert_eq!(
        document
            .read(heading.span.from, heading.span.to)
            .expect("heading span"),
        "\\section{Heading}"
    );
    assert_partition(&document, &projection.nodes, 0, document.len());
    assert_eq!(document.to_bytes(), original);
}

#[test]
fn nested_arguments_comments_and_escaped_braces_preserve_exact_spans() {
    let source = r"\section{A \{literal\} and {nested} % } ignored
 next}";
    let document = open(source);
    let projection = parse_source(&document, ParseLimits::default()).expect("parse source");
    let heading = &projection.nodes[0];

    assert_eq!(heading.kind, SyntaxKind::Heading);
    assert_eq!(
        document
            .read(
                heading.content.as_ref().expect("heading content").from,
                heading.content.as_ref().expect("heading content").to
            )
            .expect("content span"),
        "A \\{literal\\} and {nested} % } ignored\n next"
    );
    assert!(heading
        .children
        .iter()
        .any(|node| node.kind == SyntaxKind::Comment));
    assert_partition(&document, &projection.nodes, 0, document.len());
}

#[test]
fn nested_environments_comments_and_verbatim_do_not_close_the_outer_environment() {
    let source = concat!(
        "\\begin{document}\n",
        "% \\end{document}\n",
        "\\begin{table}\n",
        "\\section{Nested}\n",
        "\\begin{verbatim}\\end{document}% { $ \\end{verbatim}\n",
        "\\end{table}\n",
        "\\end{document}"
    );
    let document = open(source);
    let projection = parse_source(&document, ParseLimits::default()).expect("parse source");

    assert_eq!(projection.nodes.len(), 1);
    let root = &projection.nodes[0];
    assert_eq!(root.kind, SyntaxKind::Environment);
    assert_eq!(root.name, "document");
    let table = root
        .children
        .iter()
        .find(|node| node.kind == SyntaxKind::Environment)
        .expect("nested table environment");
    assert_eq!(table.name, "table");
    assert!(table.children.iter().any(|node| {
        node.kind == SyntaxKind::Raw && node.name == "verbatim" && node.children.is_empty()
    }));
    assert_partition(&document, &projection.nodes, 0, document.len());
}

#[test]
fn math_headings_formatting_and_html_color_are_recognized_conservatively() {
    let document = open(
        r"\section[Short]{Long \textbf{title}} $x+1$ \(y\) \[z\] \
		 \begin{equation}a+b\end{equation} \
		 \textcolor[HTML]{ab12EF}{\textit{red}}",
    );
    let projection = parse_source(&document, ParseLimits::default()).expect("parse source");

    let heading = projection
        .nodes
        .iter()
        .find(|node| node.kind == SyntaxKind::Heading)
        .expect("heading");
    assert_eq!(
        document
            .read(
                heading.content.as_ref().expect("heading content").from,
                heading.content.as_ref().expect("heading content").to
            )
            .expect("heading content"),
        "Long \\textbf{title}"
    );
    assert!(heading
        .children
        .iter()
        .any(|node| node.kind == SyntaxKind::Format));
    assert_eq!(
        projection
            .nodes
            .iter()
            .filter(|node| node.kind == SyntaxKind::Math)
            .count(),
        4
    );
    let color = projection
        .nodes
        .iter()
        .find(|node| node.name == "color:AB12EF")
        .expect("HTML color format");
    assert_eq!(color.kind, SyntaxKind::Format);
    assert_eq!(color.children.len(), 1);
    assert_eq!(color.children[0].kind, SyntaxKind::Format);
    assert_partition(&document, &projection.nodes, 0, document.len());
}

#[test]
fn unknown_macros_and_environments_remain_opaque_raw_nodes() {
    let document = open(
        "\\opaque[option]{first}{second} % retained\n\
		 \\begin{opaque}\\section{hidden}\\end{opaque}\n\
		 \\section{visible}",
    );
    let projection = parse_source(&document, ParseLimits::default()).expect("parse source");

    let macro_node = &projection.nodes[0];
    assert_eq!(macro_node.kind, SyntaxKind::Raw);
    assert_eq!(macro_node.name, "opaque");
    assert!(macro_node.children.is_empty());
    assert_eq!(
        document
            .read(macro_node.span.from, macro_node.span.to)
            .expect("macro span"),
        "\\opaque[option]{first}{second}"
    );
    let environment = projection
        .nodes
        .iter()
        .find(|node| {
            node.name == "opaque" && node.kind == SyntaxKind::Raw && node.content.is_some()
        })
        .expect("opaque environment");
    assert!(environment.children.is_empty());
    assert_eq!(
        document
            .read(environment.span.from, environment.span.to)
            .expect("environment span"),
        "\\begin{opaque}\\section{hidden}\\end{opaque}"
    );
    let headings: Vec<_> = projection
        .nodes
        .iter()
        .filter(|node| node.kind == SyntaxKind::Heading && node.name == "section")
        .collect();
    assert_eq!(headings.len(), 1);
    let content = headings[0]
        .content
        .as_ref()
        .expect("visible heading content");
    assert_eq!(
        document
            .read(content.from, content.to)
            .expect("heading text"),
        "visible"
    );
    assert_partition(&document, &projection.nodes, 0, document.len());
}

#[test]
fn malformed_inputs_report_offsets_and_retain_the_unparsed_source() {
    for source in [
        "\\section{unfinished",
        "$unfinished",
        "\\begin{document}\\end{other}",
        "text}",
    ] {
        let document = open(source);
        let original = document.to_bytes();
        let projection =
            parse_source(&document, ParseLimits::default()).expect("malformed TeX is retained");

        assert!(!projection.issues.is_empty());
        assert_partition(&document, &projection.nodes, 0, document.len());
        assert_eq!(document.to_bytes(), original);
    }

    let document = open("\\begin{document}\\end{other}");
    let projection = parse_source(&document, ParseLimits::default()).expect("parse source");
    assert!(projection
        .issues
        .iter()
        .any(|issue| issue.code == ParseIssueCode::Mismatch));
    assert!(projection
        .issues
        .iter()
        .any(|issue| issue.code == ParseIssueCode::Unclosed));
    assert_eq!(
        projection.nodes.last().expect("raw suffix").kind,
        SyntaxKind::Raw
    );
}

#[test]
fn dynamic_syntax_disables_the_entire_editable_projection() {
    let commented = open("% \\catcode`\\%=12\n\\section{A}");
    let ordinary = parse_source(&commented, ParseLimits::default()).expect("parse source");
    assert!(ordinary.issues.is_empty());
    assert!(ordinary
        .nodes
        .iter()
        .any(|node| node.kind == SyntaxKind::Heading));

    let document = open("Before \\def\\x{value} after");
    let projection = parse_source(&document, ParseLimits::default()).expect("parse source");
    assert_eq!(projection.nodes.len(), 1);
    assert_eq!(projection.nodes[0].kind, SyntaxKind::Raw);
    assert_eq!(projection.nodes[0].name, "dynamic-syntax");
    assert_eq!(projection.issues[0].code, ParseIssueCode::DynamicSyntax);
    assert_partition(&document, &projection.nodes, 0, document.len());
}

#[test]
fn recursive_depth_is_bounded_without_losing_the_source_suffix() {
    let source = format!("{}x{}", "\\textbf{".repeat(70), "}".repeat(70));
    let document = open(&source);
    let projection = parse_source(&document, ParseLimits::default()).expect("parse source");

    assert!(projection
        .issues
        .iter()
        .any(|issue| issue.code == ParseIssueCode::Depth));
    assert_partition(&document, &projection.nodes, 0, document.len());
}

#[test]
fn node_and_step_exhaustion_return_a_whole_source_raw_projection() {
    let document = open("\\section{A}\n\\textbf{B}\nplain");
    let original = document.to_bytes();
    for limits in [
        ParseLimits {
            max_nodes: 1,
            max_steps: 10_000,
        },
        ParseLimits {
            max_nodes: 100,
            max_steps: 2,
        },
    ] {
        let projection = parse_source(&document, limits).expect("budget exhaustion is a result");
        assert_eq!(projection.issues.len(), 1);
        assert_eq!(projection.issues[0].code, ParseIssueCode::Budget);
        assert_eq!(projection.issues[0].offset, 0);
        assert_eq!(projection.nodes.len(), 1);
        assert_eq!(projection.nodes[0].kind, SyntaxKind::Raw);
        assert_eq!(projection.nodes[0].name, "parse-budget");
        assert_partition(&document, &projection.nodes, 0, document.len());
        assert_eq!(document.to_bytes(), original);
    }
}

#[test]
fn zero_budgets_are_range_errors() {
    let document = open("source");
    assert!(matches!(
        parse_source(
            &document,
            ParseLimits {
                max_nodes: 0,
                max_steps: 1
            }
        ),
        Err(SourceError::Range)
    ));
    assert!(matches!(
        parse_source(
            &document,
            ParseLimits {
                max_nodes: 1,
                max_steps: 0
            }
        ),
        Err(SourceError::Range)
    ));
}

#[test]
fn projections_are_bound_to_document_identity_and_version() {
    let document = open("A");
    let projection = parse_source(&document, ParseLimits::default()).expect("parse source");
    assert!(projection_is_current(&document, &projection));
    let other = SourceDocument::open(b"A", "other-document".to_owned()).expect("other source");
    assert!(!projection_is_current(&other, &projection));

    let update = document
        .apply(&SourceTransaction {
            expected_version: document.version(),
            patches: vec![SourcePatch {
                from: 0,
                to: 1,
                insert: "B".to_owned(),
                expected: Some("A".to_owned()),
            }],
        })
        .expect("apply source transaction");
    assert!(!projection_is_current(&update.document, &projection));
}
