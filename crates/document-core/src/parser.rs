// SPDX-License-Identifier: Apache-2.0
use crate::changes::SourceSpan;
use crate::source::SourceDocument;
use crate::SourceError;
use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SyntaxKind {
    Text,
    Comment,
    Heading,
    Format,
    Math,
    Environment,
    Raw,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyntaxNode {
    pub kind: SyntaxKind,
    pub span: SourceSpan,
    pub name: String,
    pub content: Option<SourceSpan>,
    pub children: Vec<SyntaxNode>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ParseIssueCode {
    Unclosed,
    Mismatch,
    Depth,
    DynamicSyntax,
    Budget,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParseIssue {
    pub code: ParseIssueCode,
    pub offset: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceProjection {
    pub document_id: String,
    pub version: u64,
    pub nodes: Vec<SyntaxNode>,
    pub issues: Vec<ParseIssue>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParseLimits {
    pub max_nodes: usize,
    pub max_steps: usize,
}

impl Default for ParseLimits {
    fn default() -> Self {
        Self {
            max_nodes: 32_768,
            max_steps: 8_000_000,
        }
    }
}

struct SourceText {
    text: String,
    scalars: Vec<char>,
    byte_offsets: Vec<usize>,
    utf16_offsets: Vec<usize>,
}

impl SourceText {
    fn new(text: String) -> Self {
        let mut scalars = Vec::new();
        let mut byte_offsets = vec![0];
        let mut utf16_offsets = vec![0];
        let mut byte_offset = 0;
        let mut utf16_offset = 0;

        for scalar in text.chars() {
            scalars.push(scalar);
            byte_offset += scalar.len_utf8();
            utf16_offset += scalar.len_utf16();
            byte_offsets.push(byte_offset);
            utf16_offsets.push(utf16_offset);
        }

        Self {
            text,
            scalars,
            byte_offsets,
            utf16_offsets,
        }
    }

    fn len(&self) -> usize {
        self.scalars.len()
    }

    fn scalar(&self, at: usize) -> Option<char> {
        self.scalars.get(at).copied()
    }

    fn utf16_offset(&self, at: usize) -> usize {
        self.utf16_offsets[at]
    }

    fn slice(&self, from: usize, to: usize) -> &str {
        &self.text[self.byte_offsets[from]..self.byte_offsets[to]]
    }

    fn starts_with(&self, at: usize, value: &str) -> bool {
        self.slice(at, self.len()).starts_with(value)
    }

    fn find(&self, value: &str, from: usize, to: usize) -> Option<usize> {
        if from > to || to > self.len() {
            return None;
        }
        let relative_byte = self.slice(from, to).find(value)?;
        let absolute_byte = self.byte_offsets[from] + relative_byte;
        Some(
            self.byte_offsets
                .binary_search(&absolute_byte)
                .expect("a string match starts at a UTF-8 scalar boundary"),
        )
    }
}

#[derive(Debug)]
struct BudgetExhausted;

struct Command {
    name: String,
    at: usize,
    end: usize,
}

struct Environment {
    name: String,
    end: usize,
}

struct Closing {
    from: usize,
    to: usize,
}

struct Parser {
    text: SourceText,
    document_id: String,
    version: u64,
    limits: ParseLimits,
    steps: usize,
    count: usize,
    issues: Vec<ParseIssue>,
}

impl Parser {
    fn new(text: String, document_id: String, version: u64, limits: ParseLimits) -> Self {
        Self {
            text: SourceText::new(text),
            document_id,
            version,
            limits,
            steps: 0,
            count: 0,
            issues: Vec::new(),
        }
    }

    fn tick(&mut self) -> Result<(), BudgetExhausted> {
        self.steps = self.steps.checked_add(1).ok_or(BudgetExhausted)?;
        if self.steps > self.limits.max_steps {
            return Err(BudgetExhausted);
        }
        Ok(())
    }

    fn span(&self, from: usize, to: usize) -> SourceSpan {
        SourceSpan {
            document_id: self.document_id.clone(),
            version: self.version,
            from: self.text.utf16_offset(from),
            to: self.text.utf16_offset(to),
        }
    }

    fn node(
        &mut self,
        kind: SyntaxKind,
        from: usize,
        to: usize,
        name: String,
        content: Option<SourceSpan>,
        children: Vec<SyntaxNode>,
    ) -> Result<SyntaxNode, BudgetExhausted> {
        self.count = self.count.checked_add(1).ok_or(BudgetExhausted)?;
        if self.count > self.limits.max_nodes {
            return Err(BudgetExhausted);
        }
        Ok(SyntaxNode {
            kind,
            span: self.span(from, to),
            name,
            content,
            children,
        })
    }

    fn issue(&mut self, code: ParseIssueCode, at: usize) {
        self.issues.push(ParseIssue {
            code,
            offset: self.text.utf16_offset(at),
        });
    }

    fn command(&mut self, at: usize) -> Result<Command, BudgetExhausted> {
        let mut end = at + 1;
        if self
            .text
            .scalar(end)
            .is_some_and(|scalar| scalar.is_ascii_alphabetic())
        {
            while self
                .text
                .scalar(end)
                .is_some_and(|scalar| scalar.is_ascii_alphabetic())
            {
                self.tick()?;
                end += 1;
            }
        } else if end < self.text.len() {
            // A control symbol consumes one Unicode scalar, including an astral scalar.
            end += 1;
        }
        Ok(Command {
            name: self.text.slice(at + 1, end).to_owned(),
            at,
            end,
        })
    }

    fn comment_end(&mut self, mut at: usize, limit: usize) -> Result<usize, BudgetExhausted> {
        while at < limit && !matches!(self.text.scalar(at), Some('\n' | '\r')) {
            self.tick()?;
            at += 1;
        }
        Ok(at)
    }

    fn whitespace(&mut self, mut at: usize, limit: usize) -> Result<usize, BudgetExhausted> {
        while at < limit {
            self.tick()?;
            match self.text.scalar(at) {
                Some(scalar) if is_ecmascript_whitespace(scalar) => at += 1,
                Some('%') => at = self.comment_end(at, limit)?,
                _ => break,
            }
        }
        Ok(at)
    }

    // Escaped punctuation and comments do not balance groups.
    fn balanced(
        &mut self,
        at: usize,
        limit: usize,
        open: char,
        close: char,
    ) -> Result<Option<usize>, BudgetExhausted> {
        if self.text.scalar(at) != Some(open) {
            return Ok(None);
        }
        let mut depth = 1usize;
        let mut i = at + 1;
        while i < limit {
            self.tick()?;
            match self.text.scalar(i) {
                Some('\\') => i = self.command(i)?.end,
                Some('%') => i = self.comment_end(i, limit)?,
                Some(scalar) if scalar == open => {
                    depth += 1;
                    i += 1;
                }
                Some(scalar) if scalar == close => {
                    depth -= 1;
                    i += 1;
                    if depth == 0 {
                        return Ok(Some(i));
                    }
                }
                _ => i += 1,
            }
        }
        Ok(None)
    }

    fn environment_name(
        &mut self,
        at: usize,
        limit: usize,
    ) -> Result<Option<Environment>, BudgetExhausted> {
        let start = self.whitespace(at, limit)?;
        let Some(end) = self.balanced(start, limit, '{', '}')? else {
            return Ok(None);
        };
        let name = self.text.slice(start + 1, end - 1);
        if !is_environment_name(name) {
            return Ok(None);
        }
        Ok(Some(Environment {
            name: name.to_owned(),
            end,
        }))
    }

    fn literal_closing(&self, name: &str, at: usize, limit: usize) -> Option<Closing> {
        let marker = format!("\\end{{{name}}}");
        let from = self.text.find(&marker, at, self.text.len())?;
        let to = from + marker.chars().count();
        if to > limit {
            return None;
        }
        Some(Closing { from, to })
    }

    fn close_environment(
        &mut self,
        name: &str,
        at: usize,
        limit: usize,
    ) -> Result<Option<Closing>, BudgetExhausted> {
        let mut stack = vec![name.to_owned()];
        let mut i = at;
        while i < limit {
            self.tick()?;
            if self.text.scalar(i) == Some('%') {
                i = self.comment_end(i, limit)?;
                continue;
            }
            if self.text.scalar(i) != Some('\\') {
                i += 1;
                continue;
            }

            let command = self.command(i)?;
            i = command.end;
            if command.name == "verb" {
                let start = if self.text.scalar(i) == Some('*') {
                    i + 1
                } else {
                    i
                };
                if let Some(delimiter) = self.text.scalar(start) {
                    if !is_ecmascript_whitespace(delimiter) {
                        let marker = delimiter.to_string();
                        let end = self.text.find(&marker, start + 1, self.text.len());
                        let line_end = self.comment_end(start, limit)?;
                        match end {
                            Some(end) if end < line_end => i = end + 1,
                            _ => return Ok(None),
                        }
                    }
                }
                continue;
            }
            if command.name != "begin" && command.name != "end" {
                continue;
            }
            let Some(environment) = self.environment_name(command.end, limit)? else {
                continue;
            };

            if command.name == "begin" && is_literal_environment(&environment.name) {
                let Some(closing) = self.literal_closing(&environment.name, environment.end, limit)
                else {
                    return Ok(None);
                };
                i = closing.to;
                continue;
            }

            if command.name == "begin" {
                stack.push(environment.name);
            } else {
                if stack.last().map(String::as_str) != Some(environment.name.as_str()) {
                    self.issue(ParseIssueCode::Mismatch, command.at);
                    return Ok(None);
                }
                stack.pop();
                if stack.is_empty() {
                    return Ok(Some(Closing {
                        from: command.at,
                        to: environment.end,
                    }));
                }
            }
            i = environment.end;
        }
        Ok(None)
    }

    fn math_end(
        &mut self,
        at: usize,
        limit: usize,
        delimiter: &str,
    ) -> Result<Option<usize>, BudgetExhausted> {
        let delimiter_len = delimiter.chars().count();
        let mut i = at;
        while i < limit {
            self.tick()?;
            if self.text.scalar(i) == Some('%') {
                i = self.comment_end(i, limit)?;
                continue;
            }
            if self.text.starts_with(i, delimiter) {
                return Ok(Some(i + delimiter_len));
            }
            if self.text.scalar(i) == Some('\\') {
                i = self.command(i)?.end;
            } else {
                i += 1;
            }
        }
        Ok(None)
    }

    fn parse(
        &mut self,
        from: usize,
        to: usize,
        depth: usize,
    ) -> Result<Vec<SyntaxNode>, BudgetExhausted> {
        if depth > 64 {
            self.issue(ParseIssueCode::Depth, from);
            return Ok(vec![self.node(
                SyntaxKind::Raw,
                from,
                to,
                "depth-limit".to_owned(),
                None,
                Vec::new(),
            )?]);
        }

        let mut nodes = Vec::new();
        let mut i = from;
        while i < to {
            self.tick()?;
            let start = i;
            match self
                .text
                .scalar(i)
                .expect("parser index is within the source")
            {
                '%' => {
                    i = self.comment_end(i, to)?;
                    nodes.push(self.node(
                        SyntaxKind::Comment,
                        start,
                        i,
                        String::new(),
                        None,
                        Vec::new(),
                    )?);
                }
                '$' => {
                    let delimiter = if self.text.scalar(i + 1) == Some('$') {
                        "$$"
                    } else {
                        "$"
                    };
                    let delimiter_len = delimiter.chars().count();
                    let content_start = i + delimiter_len;
                    match self.math_end(content_start, to, delimiter)? {
                        None => {
                            self.issue(ParseIssueCode::Unclosed, i);
                            nodes.push(self.node(
                                SyntaxKind::Raw,
                                i,
                                to,
                                delimiter.to_owned(),
                                None,
                                Vec::new(),
                            )?);
                            i = to;
                        }
                        Some(end) => {
                            let content = self.span(content_start, end - delimiter_len);
                            nodes.push(self.node(
                                SyntaxKind::Math,
                                i,
                                end,
                                delimiter.to_owned(),
                                Some(content),
                                Vec::new(),
                            )?);
                            i = end;
                        }
                    }
                }
                '\\' => {
                    let command = self.command(i)?;
                    i = command.end;
                    if is_dynamic_command(&command.name) {
                        self.issue(ParseIssueCode::DynamicSyntax, start);
                        nodes.push(self.node(
                            SyntaxKind::Raw,
                            start,
                            to,
                            command.name,
                            None,
                            Vec::new(),
                        )?);
                        i = to;
                    } else if command.name == "(" || command.name == "[" {
                        let delimiter = if command.name == "(" { "\\)" } else { "\\]" };
                        match self.math_end(i, to, delimiter)? {
                            None => {
                                self.issue(ParseIssueCode::Unclosed, start);
                                nodes.push(self.node(
                                    SyntaxKind::Raw,
                                    start,
                                    to,
                                    command.name,
                                    None,
                                    Vec::new(),
                                )?);
                                i = to;
                            }
                            Some(end) => {
                                let content = self.span(i, end - 2);
                                nodes.push(self.node(
                                    SyntaxKind::Math,
                                    start,
                                    end,
                                    command.name,
                                    Some(content),
                                    Vec::new(),
                                )?);
                                i = end;
                            }
                        }
                    } else if command.name == "verb" {
                        let content_start = if self.text.scalar(i) == Some('*') {
                            i + 1
                        } else {
                            i
                        };
                        let delimiter = self.text.scalar(content_start);
                        let end = delimiter.and_then(|delimiter| {
                            if is_ecmascript_whitespace(delimiter) {
                                None
                            } else {
                                self.text.find(
                                    &delimiter.to_string(),
                                    content_start + 1,
                                    self.text.len(),
                                )
                            }
                        });
                        let line_end = self.comment_end(content_start, to)?;
                        if end.is_none_or(|end| end >= line_end) {
                            self.issue(ParseIssueCode::Unclosed, start);
                            i = line_end;
                            nodes.push(self.node(
                                SyntaxKind::Raw,
                                start,
                                i,
                                "verb".to_owned(),
                                None,
                                Vec::new(),
                            )?);
                        } else {
                            i = end.expect("a valid verb delimiter has a closing occurrence") + 1;
                            nodes.push(self.node(
                                SyntaxKind::Raw,
                                start,
                                i,
                                "verb".to_owned(),
                                None,
                                Vec::new(),
                            )?);
                        }
                    } else if command.name == "begin" {
                        let Some(environment) = self.environment_name(i, to)? else {
                            nodes.push(self.node(
                                SyntaxKind::Raw,
                                start,
                                i,
                                "begin".to_owned(),
                                None,
                                Vec::new(),
                            )?);
                            continue;
                        };
                        let closing = if is_literal_environment(&environment.name) {
                            self.literal_closing(&environment.name, environment.end, to)
                        } else {
                            self.close_environment(&environment.name, environment.end, to)?
                        };
                        let Some(closing) = closing else {
                            self.issue(ParseIssueCode::Unclosed, start);
                            nodes.push(self.node(
                                SyntaxKind::Raw,
                                start,
                                to,
                                environment.name,
                                None,
                                Vec::new(),
                            )?);
                            i = to;
                            continue;
                        };

                        i = closing.to;
                        let content = self.span(environment.end, closing.from);
                        if is_container(&environment.name) {
                            let children = self.parse(environment.end, closing.from, depth + 1)?;
                            nodes.push(self.node(
                                SyntaxKind::Environment,
                                start,
                                i,
                                environment.name,
                                Some(content),
                                children,
                            )?);
                        } else if environment.name == "equation" || environment.name == "equation*"
                        {
                            nodes.push(self.node(
                                SyntaxKind::Math,
                                start,
                                i,
                                environment.name,
                                Some(content),
                                Vec::new(),
                            )?);
                        } else {
                            nodes.push(self.node(
                                SyntaxKind::Raw,
                                start,
                                i,
                                environment.name,
                                Some(content),
                                Vec::new(),
                            )?);
                        }
                    } else {
                        let starred = self.text.scalar(i) == Some('*');
                        if starred {
                            i += 1;
                        }
                        let mut argument = self.whitespace(i, to)?;
                        let mut content = None;
                        let mut malformed = false;
                        while matches!(self.text.scalar(argument), Some('{' | '[')) {
                            self.tick()?;
                            let bracket = self.text.scalar(argument) == Some('[');
                            let (open, close) = if bracket { ('[', ']') } else { ('{', '}') };
                            let Some(end) = self.balanced(argument, to, open, close)? else {
                                malformed = true;
                                break;
                            };
                            if !bracket && content.is_none() {
                                content = Some((argument + 1, end - 1));
                            }
                            i = end;
                            if !bracket
                                && (is_heading(&command.name) || is_formatting(&command.name))
                            {
                                break;
                            }
                            argument = self.whitespace(i, to)?;
                        }

                        if malformed {
                            self.issue(ParseIssueCode::Unclosed, start);
                            i = to;
                            nodes.push(self.node(
                                SyntaxKind::Raw,
                                start,
                                i,
                                command.name,
                                None,
                                Vec::new(),
                            )?);
                        } else if command.name == "textcolor" && !starred {
                            let color = html_color_prefix(self.text.slice(start, i));
                            if let Some(color) = color {
                                let opening = start + "\\textcolor[HTML]{".len() + 7;
                                if let Some(end) = self.balanced(opening, to, '{', '}')? {
                                    if end == i {
                                        let color_content = self.span(opening + 1, end - 1);
                                        let children =
                                            self.parse(opening + 1, end - 1, depth + 1)?;
                                        nodes.push(self.node(
                                            SyntaxKind::Format,
                                            start,
                                            i,
                                            format!("color:{color}"),
                                            Some(color_content),
                                            children,
                                        )?);
                                    } else {
                                        nodes.push(self.node(
                                            SyntaxKind::Raw,
                                            start,
                                            i,
                                            command.name,
                                            None,
                                            Vec::new(),
                                        )?);
                                    }
                                } else {
                                    nodes.push(self.node(
                                        SyntaxKind::Raw,
                                        start,
                                        i,
                                        command.name,
                                        None,
                                        Vec::new(),
                                    )?);
                                }
                            } else if let Some((content_from, content_to)) = content {
                                if is_heading(&command.name) {
                                    let content_span = self.span(content_from, content_to);
                                    let children =
                                        self.parse(content_from, content_to, depth + 1)?;
                                    nodes.push(self.node(
                                        SyntaxKind::Heading,
                                        start,
                                        i,
                                        format!(
                                            "{}{}",
                                            command.name,
                                            if starred { "*" } else { "" }
                                        ),
                                        Some(content_span),
                                        children,
                                    )?);
                                } else if is_formatting(&command.name) && !starred {
                                    let content_span = self.span(content_from, content_to);
                                    let children =
                                        self.parse(content_from, content_to, depth + 1)?;
                                    nodes.push(self.node(
                                        SyntaxKind::Format,
                                        start,
                                        i,
                                        command.name,
                                        Some(content_span),
                                        children,
                                    )?);
                                } else {
                                    nodes.push(self.node(
                                        SyntaxKind::Raw,
                                        start,
                                        i,
                                        command.name,
                                        None,
                                        Vec::new(),
                                    )?);
                                }
                            } else {
                                nodes.push(self.node(
                                    SyntaxKind::Raw,
                                    start,
                                    i,
                                    command.name,
                                    None,
                                    Vec::new(),
                                )?);
                            }
                        } else if let Some((content_from, content_to)) = content {
                            if is_heading(&command.name) {
                                let content_span = self.span(content_from, content_to);
                                let children = self.parse(content_from, content_to, depth + 1)?;
                                nodes.push(self.node(
                                    SyntaxKind::Heading,
                                    start,
                                    i,
                                    format!("{}{}", command.name, if starred { "*" } else { "" }),
                                    Some(content_span),
                                    children,
                                )?);
                            } else if is_maketitle_metadata(&command.name) && !starred {
                                let content_span = self.span(content_from, content_to);
                                let children = self.parse(content_from, content_to, depth + 1)?;
                                nodes.push(self.node(
                                    SyntaxKind::Raw,
                                    start,
                                    i,
                                    command.name,
                                    Some(content_span),
                                    children,
                                )?);
                            } else if is_formatting(&command.name) && !starred {
                                let content_span = self.span(content_from, content_to);
                                let children = self.parse(content_from, content_to, depth + 1)?;
                                nodes.push(self.node(
                                    SyntaxKind::Format,
                                    start,
                                    i,
                                    command.name,
                                    Some(content_span),
                                    children,
                                )?);
                            } else {
                                nodes.push(self.node(
                                    SyntaxKind::Raw,
                                    start,
                                    i,
                                    command.name,
                                    None,
                                    Vec::new(),
                                )?);
                            }
                        } else {
                            nodes.push(self.node(
                                SyntaxKind::Raw,
                                start,
                                i,
                                command.name,
                                None,
                                Vec::new(),
                            )?);
                        }
                    }
                }
                '{' => {
                    let Some(end) = self.balanced(i, to, '{', '}')? else {
                        self.issue(ParseIssueCode::Unclosed, i);
                        i = to;
                        nodes.push(self.node(
                            SyntaxKind::Raw,
                            start,
                            i,
                            "group".to_owned(),
                            None,
                            Vec::new(),
                        )?);
                        continue;
                    };
                    i = end;
                    nodes.push(self.node(
                        SyntaxKind::Raw,
                        start,
                        i,
                        "group".to_owned(),
                        None,
                        Vec::new(),
                    )?);
                }
                '}' => {
                    self.issue(ParseIssueCode::Mismatch, i);
                    i += 1;
                    nodes.push(self.node(
                        SyntaxKind::Raw,
                        start,
                        i,
                        "unmatched-group".to_owned(),
                        None,
                        Vec::new(),
                    )?);
                }
                _ => {
                    while i < to
                        && !matches!(self.text.scalar(i), Some('%' | '$' | '\\' | '{' | '}'))
                    {
                        self.tick()?;
                        i += 1;
                    }
                    nodes.push(self.node(
                        SyntaxKind::Text,
                        start,
                        i,
                        String::new(),
                        None,
                        Vec::new(),
                    )?);
                }
            }
        }
        Ok(nodes)
    }
}

fn is_ecmascript_whitespace(scalar: char) -> bool {
    matches!(
        scalar,
        '\u{0009}'..='\u{000D}'
            | '\u{0020}'
            | '\u{00A0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200A}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202F}'
            | '\u{205F}'
            | '\u{3000}'
            | '\u{FEFF}'
    )
}

fn is_environment_name(name: &str) -> bool {
    let mut scalars = name.chars();
    matches!(scalars.next(), Some(scalar) if scalar.is_ascii_alphabetic())
        && scalars.all(|scalar| scalar.is_ascii_alphanumeric() || matches!(scalar, '*' | '_' | '-'))
}

fn is_literal_environment(name: &str) -> bool {
    matches!(name, "verbatim" | "verbatim*" | "lstlisting" | "minted")
}

fn is_container(name: &str) -> bool {
    matches!(name, "document" | "table" | "table*")
}

fn is_heading(name: &str) -> bool {
    matches!(name, "title" | "section" | "subsection" | "subsubsection")
}

fn is_maketitle_metadata(name: &str) -> bool {
    matches!(name, "author" | "date")
}

fn is_formatting(name: &str) -> bool {
    matches!(name, "textbf" | "textit" | "emph" | "underline")
}

fn is_dynamic_command(name: &str) -> bool {
    matches!(
        name,
        "catcode"
            | "def"
            | "gdef"
            | "edef"
            | "xdef"
            | "let"
            | "futurelet"
            | "csname"
            | "ExplSyntaxOn"
    )
}

fn html_color_prefix(value: &str) -> Option<String> {
    const PREFIX: &str = "\\textcolor[HTML]{";
    let bytes = value.as_bytes();
    let color_start = PREFIX.len();
    let color_end = color_start + 6;
    if !bytes.starts_with(PREFIX.as_bytes())
        || bytes.get(color_end) != Some(&b'}')
        || bytes.get(color_end + 1) != Some(&b'{')
        || !bytes
            .get(color_start..color_end)?
            .iter()
            .all(u8::is_ascii_hexdigit)
    {
        return None;
    }
    Some(value.get(color_start..color_end)?.to_ascii_uppercase())
}

pub fn parse_source(
    document: &SourceDocument,
    limits: ParseLimits,
) -> Result<SourceProjection, SourceError> {
    if limits.max_nodes == 0 || limits.max_steps == 0 {
        return Err(SourceError::Range);
    }

    let mut parser = Parser::new(
        document.text(),
        document.document_id().to_owned(),
        document.version(),
        limits,
    );
    let mut nodes = match parser.parse(0, parser.text.len(), 0) {
        Ok(nodes) => nodes,
        Err(BudgetExhausted) => {
            parser.count = 0;
            parser.issues.clear();
            parser.issues.push(ParseIssue {
                code: ParseIssueCode::Budget,
                offset: 0,
            });
            vec![parser
                .node(
                    SyntaxKind::Raw,
                    0,
                    parser.text.len(),
                    "parse-budget".to_owned(),
                    None,
                    Vec::new(),
                )
                .expect("a validated nonzero node budget admits the raw fallback")]
        }
    };

    if parser
        .issues
        .iter()
        .any(|issue| issue.code == ParseIssueCode::DynamicSyntax)
    {
        parser.count = 0;
        nodes = vec![parser
            .node(
                SyntaxKind::Raw,
                0,
                parser.text.len(),
                "dynamic-syntax".to_owned(),
                None,
                Vec::new(),
            )
            .expect("a validated nonzero node budget admits the raw fallback")];
    }

    Ok(SourceProjection {
        document_id: document.document_id().to_owned(),
        version: document.version(),
        nodes,
        issues: parser.issues,
    })
}

pub fn projection_is_current(document: &SourceDocument, projection: &SourceProjection) -> bool {
    document.document_id() == projection.document_id && document.version() == projection.version
}
