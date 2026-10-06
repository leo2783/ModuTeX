//! Typst's official parser, exposed to JavaScript in the shape Lezer wants.
//!
//! Design notes, because the obvious alternative was rejected deliberately:
//!
//! * `typst-syntax` is used UNPATCHED, straight from crates.io. `Source::edit` is the same public
//!   incremental reparser the language server uses, so nothing here needs privileged access to the
//!   crate's internals.
//! * The tree crosses into JS as ONE flat `Uint32Array` in Lezer's `Tree.build` buffer format,
//!   rather than as an object graph. That keeps the boundary to a single copy, and lets the JS side
//!   build a real, immutable `Tree` through Lezer's supported constructor instead of reinterpreting
//!   a foreign object as one.
//! * Node type ids are OUR OWN, assigned by `kind_id` below, not `SyntaxKind`'s discriminants.
//!   Discriminants shift whenever Typst adds a kind; a name->id table published alongside the
//!   buffer means the JS `NodeSet` is built from whatever this binary actually contains.
//!
//! Inspired by kxxt/codemirror-lang-typst (Apache-2.0), which demonstrated that compiling
//! typst-syntax to wasm is the right way to highlight Typst. The approach here differs: no fork of
//! Typst, and immutable trees.

use typst_syntax::{Source, SyntaxKind, SyntaxNode};
use wasm_bindgen::prelude::*;

/// The node kinds this build knows about, in id order. Index 0 is reserved by Lezer for
/// `NodeType.none`, so ids handed out here start at 1.
///
/// Deliberately exhaustive over `SyntaxKind` via `kind_id`'s match rather than a derive: a Typst
/// release that adds a kind then fails to compile HERE, which is a build error we can act on,
/// instead of silently mapping the new kind onto an existing one.
fn kind_name(kind: SyntaxKind) -> String {
    // NOT SyntaxKind::name(), which returns prose for humans - "line comment", "heading marker",
    // "keyword `let`". Tag maps (ours and codemirror-lang-typst's alike) are written against the
    // Rust VARIANT names - LineComment, HeadingMarker, Let - and SyntaxKind is a fieldless enum, so
    // its Debug output is exactly that. This is the one thing kxxt's fork patched kind.rs to
    // expose; Debug gets it without touching the crate.
    format!("{kind:?}")
}

/// A parsed Typst document that can be edited incrementally.
#[wasm_bindgen]
pub struct TypstSyntax {
    source: Source,
    /// node type names in id order (id = index + 1); grows as kinds are first seen, never shrinks
    names: Vec<String>,
}

#[wasm_bindgen]
impl TypstSyntax {
    #[wasm_bindgen(constructor)]
    pub fn new(text: &str) -> TypstSyntax {
        TypstSyntax {
            // `detached` = no FileId, which is right: this parser never resolves imports. Only the
            // compiler does that, and it is a separate process.
            source: Source::detached(text),
            names: Vec::new(),
        }
    }

    /// Replace the byte range `[from, to)` with `with`, reparsing incrementally.
    ///
    /// Offsets are BYTE offsets into the current text, which is what `Source` speaks. The JS side
    /// converts from CodeMirror's UTF-16 code-unit positions before calling.
    pub fn edit(&mut self, from: usize, to: usize, with: &str) {
        let len = self.source.text().len();
        // a stale or out-of-order edit would panic inside Source::edit and poison the wasm
        // instance; clamp instead, and let the caller's next full reparse correct any drift
        let from = from.min(len);
        let to = to.clamp(from, len);
        self.source.edit(from..to, with);
    }

    /// Replace the whole text. `Source::replace` diffs it down to one edit internally, so this is
    /// still cheaper than constructing a new parser.
    pub fn set_text(&mut self, text: &str) {
        self.source.replace(text);
    }

    pub fn text_len(&self) -> usize {
        self.source.text().len()
    }

    /// The node-type table for the tree most recently returned by `buffer`, as newline-separated
    /// names in id order. Id 0 is Lezer's `NodeType.none` and is not listed.
    pub fn node_names(&self) -> String {
        self.names.join("\n")
    }

    /// The syntax tree, flattened into Lezer's `Tree.build` buffer format.
    ///
    /// Four values per node - `[typeId, from, to, size]` - where `size` counts the array entries
    /// covering the node AND its children. Children come before their parent, and siblings in
    /// document order, which is the post-order Lezer's buffer cursor reads.
    ///
    /// Offsets are UTF-16 code units, not bytes: CodeMirror positions are UTF-16, and converting
    /// here (where the text is at hand) is cheaper and less error-prone than doing it in JS.
    pub fn buffer(&mut self) -> Vec<u32> {
        // The name table is NEVER cleared. Lezer trees reference node types by id into a NodeSet,
        // so an id has to mean the same thing for the life of the parser: clearing it would let a
        // kind that appeared in one parse be renumbered in the next, and any tree still held by an
        // older editor state would silently decode to the wrong node types. Growing only is safe -
        // a longer table is a superset, and old ids keep their meaning.
        let mut out = Vec::new();
        // rebuilt from `names` so ids stay exactly what they were assigned before
        let mut ids: std::collections::HashMap<String, u32> =
            self.names.iter().enumerate().map(|(i, n)| (n.clone(), i as u32 + 1)).collect();
        let text = self.source.text();
        let root = self.source.root();
        // the root itself is NOT emitted: Tree.build takes it as `topID` and wraps the buffer
        let mut pos = Pos { byte: 0, utf16: 0 };
        for child in root.children() {
            emit(child, &mut pos, text, &mut out, &mut ids, &mut self.names);
        }
        out
    }

    /// The id `Tree.build` should use for the top node.
    pub fn top_name(&self) -> String {
        kind_name(self.source.root().kind()).to_string()
    }
}

/// Assign (or look up) the Lezer node id for a kind. Ids start at 1; 0 is `NodeType.none`.
fn id_for(kind: SyntaxKind, ids: &mut std::collections::HashMap<String, u32>, names: &mut Vec<String>) -> u32 {
    let name = kind_name(kind);
    if let Some(id) = ids.get(&name) {
        return *id;
    }
    names.push(name.clone());
    let id = names.len() as u32; // 1-based
    ids.insert(name, id);
    id
}

/// A cursor over the source in both units at once.
///
/// Both are tracked incrementally because CodeMirror addresses text in UTF-16 code units while
/// `SyntaxNode::len` is bytes. Converting by re-measuring `text[..offset]` at every node would be
/// quadratic in the document length; advancing per leaf keeps the whole walk linear.
struct Pos {
    byte: usize,
    utf16: u32,
}

/// Append `node` and its subtree to `out` in Lezer buffer order (children before parents),
/// advancing `pos` across the text the node covers.
fn emit(
    node: &SyntaxNode,
    pos: &mut Pos,
    text: &str,
    out: &mut Vec<u32>,
    ids: &mut std::collections::HashMap<String, u32>,
    names: &mut Vec<String>,
) {
    let from = pos.utf16;
    let start_entries = out.len();
    let id = id_for(node.kind(), ids, names);

    if node.children().len() == 0 {
        // a leaf owns its bytes: advance both counters across exactly that slice
        let end = (pos.byte + node.len()).min(text.len());
        pos.utf16 += text[pos.byte..end].chars().map(|c| c.len_utf16() as u32).sum::<u32>();
        pos.byte = end;
    } else {
        for child in node.children() {
            emit(child, pos, text, out, ids, names);
        }
    }

    // +4 for this node's own entry: Lezer's `size` counts the node AND its children, four
    // array slots each
    let size = (out.len() - start_entries) as u32 + 4;
    out.extend_from_slice(&[id, from, pos.utf16, size]);
}
