// SPDX-License-Identifier: Apache-2.0
// Behavioral fixtures captured from the existing editor grammar during Rust migration.
use modutex_document_core::{
    parser::{parse_source, ParseLimits, SyntaxNode},
    source::SourceDocument,
};
fn flatten(nodes: &[SyntaxNode], depth: usize, out: &mut Vec<String>) {
    for n in nodes {
        out.push(format!(
            "{}|{:?}|{}:{}|{}|{}",
            depth,
            n.kind,
            n.span.from,
            n.span.to,
            n.name,
            n.content
                .as_ref()
                .map(|s| format!("{}:{}", s.from, s.to))
                .unwrap_or_default()
        ));
        flatten(&n.children, depth + 1, out);
    }
}
#[test]
fn editor_grammar_cases_preserve_structure_issues_and_utf16_spans() {
    {
        let input = "plain\r\n雪\rline\n";
        let doc = SourceDocument::open(input.as_bytes(), "fixture".to_owned()).expect("source");
        let p = parse_source(&doc, ParseLimits::default()).expect("parse");
        let mut actual = Vec::new();
        flatten(&p.nodes, 0, &mut actual);
        let expected: Vec<String> = vec!["0|Text|0:14||".to_owned()];
        assert_eq!(actual, expected, "text");
        let actual: Vec<String> = p
            .issues
            .iter()
            .map(|i| format!("{:?}@{}", i.code, i.offset))
            .collect();
        let expected: Vec<String> = vec![];
        assert_eq!(actual, expected, "text issues");
        assert_eq!(doc.to_bytes(), input.as_bytes());
    }
    {
        let input = "𠀀 $x$ \\section{雪𠀀}";
        let doc = SourceDocument::open(input.as_bytes(), "fixture".to_owned()).expect("source");
        let p = parse_source(&doc, ParseLimits::default()).expect("parse");
        let mut actual = Vec::new();
        flatten(&p.nodes, 0, &mut actual);
        let expected: Vec<String> = vec![
            "0|Text|0:3||".to_owned(),
            "0|Math|3:6|$|4:5".to_owned(),
            "0|Text|6:7||".to_owned(),
            "0|Heading|7:20|section|16:19".to_owned(),
            "1|Text|16:19||".to_owned(),
        ];
        assert_eq!(actual, expected, "astral");
        let actual: Vec<String> = p
            .issues
            .iter()
            .map(|i| format!("{:?}@{}", i.code, i.offset))
            .collect();
        let expected: Vec<String> = vec![];
        assert_eq!(actual, expected, "astral issues");
        assert_eq!(doc.to_bytes(), input.as_bytes());
    }
    {
        let input = "\\section{A \\textbf{B}}\n\\begin{document}x\\end{document}";
        let doc = SourceDocument::open(input.as_bytes(), "fixture".to_owned()).expect("source");
        let p = parse_source(&doc, ParseLimits::default()).expect("parse");
        let mut actual = Vec::new();
        flatten(&p.nodes, 0, &mut actual);
        let expected: Vec<String> = vec![
            "0|Heading|0:22|section|9:21".to_owned(),
            "1|Text|9:11||".to_owned(),
            "1|Format|11:21|textbf|19:20".to_owned(),
            "2|Text|19:20||".to_owned(),
            "0|Text|22:23||".to_owned(),
            "0|Environment|23:54|document|39:40".to_owned(),
            "1|Text|39:40||".to_owned(),
        ];
        assert_eq!(actual, expected, "nested");
        let actual: Vec<String> = p
            .issues
            .iter()
            .map(|i| format!("{:?}@{}", i.code, i.offset))
            .collect();
        let expected: Vec<String> = vec![];
        assert_eq!(actual, expected, "nested issues");
        assert_eq!(doc.to_bytes(), input.as_bytes());
    }
    {
        let input = "\\unknown[opt]{x}{y} trailing";
        let doc = SourceDocument::open(input.as_bytes(), "fixture".to_owned()).expect("source");
        let p = parse_source(&doc, ParseLimits::default()).expect("parse");
        let mut actual = Vec::new();
        flatten(&p.nodes, 0, &mut actual);
        let expected: Vec<String> = vec![
            "0|Raw|0:19|unknown|".to_owned(),
            "0|Text|19:28||".to_owned(),
        ];
        assert_eq!(actual, expected, "unknown");
        let actual: Vec<String> = p
            .issues
            .iter()
            .map(|i| format!("{:?}@{}", i.code, i.offset))
            .collect();
        let expected: Vec<String> = vec![];
        assert_eq!(actual, expected, "unknown issues");
        assert_eq!(doc.to_bytes(), input.as_bytes());
    }
    {
        let input = "\\% \\$ \\{literal\\} % comment\nend";
        let doc = SourceDocument::open(input.as_bytes(), "fixture".to_owned()).expect("source");
        let p = parse_source(&doc, ParseLimits::default()).expect("parse");
        let mut actual = Vec::new();
        flatten(&p.nodes, 0, &mut actual);
        let expected: Vec<String> = vec![
            "0|Raw|0:2|%|".to_owned(),
            "0|Text|2:3||".to_owned(),
            "0|Raw|3:5|$|".to_owned(),
            "0|Text|5:6||".to_owned(),
            "0|Raw|6:8|{|".to_owned(),
            "0|Text|8:15||".to_owned(),
            "0|Raw|15:17|}|".to_owned(),
            "0|Text|17:18||".to_owned(),
            "0|Comment|18:27||".to_owned(),
            "0|Text|27:31||".to_owned(),
        ];
        assert_eq!(actual, expected, "escaped");
        let actual: Vec<String> = p
            .issues
            .iter()
            .map(|i| format!("{:?}@{}", i.code, i.offset))
            .collect();
        let expected: Vec<String> = vec![];
        assert_eq!(actual, expected, "escaped issues");
        assert_eq!(doc.to_bytes(), input.as_bytes());
    }
    {
        let input = "a $x$ $$y$$ \\(z\\) \\[w\\]";
        let doc = SourceDocument::open(input.as_bytes(), "fixture".to_owned()).expect("source");
        let p = parse_source(&doc, ParseLimits::default()).expect("parse");
        let mut actual = Vec::new();
        flatten(&p.nodes, 0, &mut actual);
        let expected: Vec<String> = vec![
            "0|Text|0:2||".to_owned(),
            "0|Math|2:5|$|3:4".to_owned(),
            "0|Text|5:6||".to_owned(),
            "0|Math|6:11|$$|8:9".to_owned(),
            "0|Text|11:12||".to_owned(),
            "0|Math|12:17|(|14:15".to_owned(),
            "0|Text|17:18||".to_owned(),
            "0|Math|18:23|[|20:21".to_owned(),
        ];
        assert_eq!(actual, expected, "math");
        let actual: Vec<String> = p
            .issues
            .iter()
            .map(|i| format!("{:?}@{}", i.code, i.offset))
            .collect();
        let expected: Vec<String> = vec![];
        assert_eq!(actual, expected, "math issues");
        assert_eq!(doc.to_bytes(), input.as_bytes());
    }
    {
        let input = "\\begin{verbatim}\\begin{bad}%\\end{verbatim} after";
        let doc = SourceDocument::open(input.as_bytes(), "fixture".to_owned()).expect("source");
        let p = parse_source(&doc, ParseLimits::default()).expect("parse");
        let mut actual = Vec::new();
        flatten(&p.nodes, 0, &mut actual);
        let expected: Vec<String> = vec![
            "0|Raw|0:42|verbatim|16:28".to_owned(),
            "0|Text|42:48||".to_owned(),
        ];
        assert_eq!(actual, expected, "verbatim");
        let actual: Vec<String> = p
            .issues
            .iter()
            .map(|i| format!("{:?}@{}", i.code, i.offset))
            .collect();
        let expected: Vec<String> = vec![];
        assert_eq!(actual, expected, "verbatim issues");
        assert_eq!(doc.to_bytes(), input.as_bytes());
    }
    {
        let input = "\\verb|\\section{x}%| tail";
        let doc = SourceDocument::open(input.as_bytes(), "fixture".to_owned()).expect("source");
        let p = parse_source(&doc, ParseLimits::default()).expect("parse");
        let mut actual = Vec::new();
        flatten(&p.nodes, 0, &mut actual);
        let expected: Vec<String> =
            vec!["0|Raw|0:19|verb|".to_owned(), "0|Text|19:24||".to_owned()];
        assert_eq!(actual, expected, "verb");
        let actual: Vec<String> = p
            .issues
            .iter()
            .map(|i| format!("{:?}@{}", i.code, i.offset))
            .collect();
        let expected: Vec<String> = vec![];
        assert_eq!(actual, expected, "verb issues");
        assert_eq!(doc.to_bytes(), input.as_bytes());
    }
    {
        let input = "\\begin{document}\\end{table}";
        let doc = SourceDocument::open(input.as_bytes(), "fixture".to_owned()).expect("source");
        let p = parse_source(&doc, ParseLimits::default()).expect("parse");
        let mut actual = Vec::new();
        flatten(&p.nodes, 0, &mut actual);
        let expected: Vec<String> = vec!["0|Raw|0:27|document|".to_owned()];
        assert_eq!(actual, expected, "mismatch");
        let actual: Vec<String> = p
            .issues
            .iter()
            .map(|i| format!("{:?}@{}", i.code, i.offset))
            .collect();
        let expected: Vec<String> = vec!["Mismatch@16".to_owned(), "Unclosed@0".to_owned()];
        assert_eq!(actual, expected, "mismatch issues");
        assert_eq!(doc.to_bytes(), input.as_bytes());
    }
    {
        let input = "\\textbf{abc";
        let doc = SourceDocument::open(input.as_bytes(), "fixture".to_owned()).expect("source");
        let p = parse_source(&doc, ParseLimits::default()).expect("parse");
        let mut actual = Vec::new();
        flatten(&p.nodes, 0, &mut actual);
        let expected: Vec<String> = vec!["0|Raw|0:11|textbf|".to_owned()];
        assert_eq!(actual, expected, "unclosed");
        let actual: Vec<String> = p
            .issues
            .iter()
            .map(|i| format!("{:?}@{}", i.code, i.offset))
            .collect();
        let expected: Vec<String> = vec!["Unclosed@0".to_owned()];
        assert_eq!(actual, expected, "unclosed issues");
        assert_eq!(doc.to_bytes(), input.as_bytes());
    }
    {
        let input = "before \\def\\foo{x} after";
        let doc = SourceDocument::open(input.as_bytes(), "fixture".to_owned()).expect("source");
        let p = parse_source(&doc, ParseLimits::default()).expect("parse");
        let mut actual = Vec::new();
        flatten(&p.nodes, 0, &mut actual);
        let expected: Vec<String> = vec!["0|Raw|0:24|dynamic-syntax|".to_owned()];
        assert_eq!(actual, expected, "dynamic");
        let actual: Vec<String> = p
            .issues
            .iter()
            .map(|i| format!("{:?}@{}", i.code, i.offset))
            .collect();
        let expected: Vec<String> = vec!["DynamicSyntax@7".to_owned()];
        assert_eq!(actual, expected, "dynamic issues");
        assert_eq!(doc.to_bytes(), input.as_bytes());
    }
    {
        let input = "\\textcolor[HTML]{a0B1c2}{hello}";
        let doc = SourceDocument::open(input.as_bytes(), "fixture".to_owned()).expect("source");
        let p = parse_source(&doc, ParseLimits::default()).expect("parse");
        let mut actual = Vec::new();
        flatten(&p.nodes, 0, &mut actual);
        let expected: Vec<String> = vec![
            "0|Format|0:31|color:A0B1C2|25:30".to_owned(),
            "1|Text|25:30||".to_owned(),
        ];
        assert_eq!(actual, expected, "color");
        let actual: Vec<String> = p
            .issues
            .iter()
            .map(|i| format!("{:?}@{}", i.code, i.offset))
            .collect();
        let expected: Vec<String> = vec![];
        assert_eq!(actual, expected, "color issues");
        assert_eq!(doc.to_bytes(), input.as_bytes());
    }
    {
        let input = "\\textcolor [HTML]{a0B1c2}{hello}";
        let doc = SourceDocument::open(input.as_bytes(), "fixture".to_owned()).expect("source");
        let p = parse_source(&doc, ParseLimits::default()).expect("parse");
        let mut actual = Vec::new();
        flatten(&p.nodes, 0, &mut actual);
        let expected: Vec<String> = vec!["0|Raw|0:32|textcolor|".to_owned()];
        assert_eq!(actual, expected, "color-space");
        let actual: Vec<String> = p
            .issues
            .iter()
            .map(|i| format!("{:?}@{}", i.code, i.offset))
            .collect();
        let expected: Vec<String> = vec![];
        assert_eq!(actual, expected, "color-space issues");
        assert_eq!(doc.to_bytes(), input.as_bytes());
    }
    {
        let input = "\\section﻿{A}";
        let doc = SourceDocument::open(input.as_bytes(), "fixture".to_owned()).expect("source");
        let p = parse_source(&doc, ParseLimits::default()).expect("parse");
        let mut actual = Vec::new();
        flatten(&p.nodes, 0, &mut actual);
        let expected: Vec<String> = vec![
            "0|Heading|0:12|section|10:11".to_owned(),
            "1|Text|10:11||".to_owned(),
        ];
        assert_eq!(actual, expected, "feff-whitespace");
        let actual: Vec<String> = p
            .issues
            .iter()
            .map(|i| format!("{:?}@{}", i.code, i.offset))
            .collect();
        let expected: Vec<String> = vec![];
        assert_eq!(actual, expected, "feff-whitespace issues");
        assert_eq!(doc.to_bytes(), input.as_bytes());
    }
    {
        let input = "\\section{A}";
        let doc = SourceDocument::open(input.as_bytes(), "fixture".to_owned()).expect("source");
        let p = parse_source(&doc, ParseLimits::default()).expect("parse");
        let mut actual = Vec::new();
        flatten(&p.nodes, 0, &mut actual);
        let expected: Vec<String> = vec![
            "0|Raw|0:8|section|".to_owned(),
            "0|Text|8:9||".to_owned(),
            "0|Raw|9:12|group|".to_owned(),
        ];
        assert_eq!(actual, expected, "nel-whitespace");
        let actual: Vec<String> = p
            .issues
            .iter()
            .map(|i| format!("{:?}@{}", i.code, i.offset))
            .collect();
        let expected: Vec<String> = vec![];
        assert_eq!(actual, expected, "nel-whitespace issues");
        assert_eq!(doc.to_bytes(), input.as_bytes());
    }
    {
        let input = "{x} }";
        let doc = SourceDocument::open(input.as_bytes(), "fixture".to_owned()).expect("source");
        let p = parse_source(&doc, ParseLimits::default()).expect("parse");
        let mut actual = Vec::new();
        flatten(&p.nodes, 0, &mut actual);
        let expected: Vec<String> = vec![
            "0|Raw|0:3|group|".to_owned(),
            "0|Text|3:4||".to_owned(),
            "0|Raw|4:5|unmatched-group|".to_owned(),
        ];
        assert_eq!(actual, expected, "literal-braces");
        let actual: Vec<String> = p
            .issues
            .iter()
            .map(|i| format!("{:?}@{}", i.code, i.offset))
            .collect();
        let expected: Vec<String> = vec!["Mismatch@4".to_owned()];
        assert_eq!(actual, expected, "literal-braces issues");
        assert_eq!(doc.to_bytes(), input.as_bytes());
    }
    {
        let input = "\\section% c\r\n{A}";
        let doc = SourceDocument::open(input.as_bytes(), "fixture".to_owned()).expect("source");
        let p = parse_source(&doc, ParseLimits::default()).expect("parse");
        let mut actual = Vec::new();
        flatten(&p.nodes, 0, &mut actual);
        let expected: Vec<String> = vec![
            "0|Heading|0:16|section|14:15".to_owned(),
            "1|Text|14:15||".to_owned(),
        ];
        assert_eq!(actual, expected, "comments-in-args");
        let actual: Vec<String> = p
            .issues
            .iter()
            .map(|i| format!("{:?}@{}", i.code, i.offset))
            .collect();
        let expected: Vec<String> = vec![];
        assert_eq!(actual, expected, "comments-in-args issues");
        assert_eq!(doc.to_bytes(), input.as_bytes());
    }
    {
        let input = "\\section*{A} \\textbf*{B}";
        let doc = SourceDocument::open(input.as_bytes(), "fixture".to_owned()).expect("source");
        let p = parse_source(&doc, ParseLimits::default()).expect("parse");
        let mut actual = Vec::new();
        flatten(&p.nodes, 0, &mut actual);
        let expected: Vec<String> = vec![
            "0|Heading|0:12|section*|10:11".to_owned(),
            "1|Text|10:11||".to_owned(),
            "0|Text|12:13||".to_owned(),
            "0|Raw|13:24|textbf|".to_owned(),
        ];
        assert_eq!(actual, expected, "star");
        let actual: Vec<String> = p
            .issues
            .iter()
            .map(|i| format!("{:?}@{}", i.code, i.offset))
            .collect();
        let expected: Vec<String> = vec![];
        assert_eq!(actual, expected, "star issues");
        assert_eq!(doc.to_bytes(), input.as_bytes());
    }
}
