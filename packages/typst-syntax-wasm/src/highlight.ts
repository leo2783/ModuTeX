// Which Typst syntax kind gets which highlight tag.
//
// Adapted from codemirror-lang-typst (Apache-2.0, © Levi Zim). It is vendored
// rather than imported because that package's entry point re-exports its own wasm-backed parser,
// so importing anything from it pulled a SECOND 320KB parser into the bundle alongside ours. This
// file is pure data; the parser it describes is the one in ../src/lib.rs.
//
// The keys are Typst's SyntaxKind VARIANT names, which is what our wasm emits (see kind_name).
import { styleTags, tags } from '@lezer/highlight';

export const typstHighlight = styleTags({
	Shebang: tags.documentMeta,
	'LineComment BlockComment': tags.comment,

	Text: tags.content,
	Linebreak: tags.contentSeparator,
	Escape: tags.escape,
	Shorthand: tags.contentSeparator,
	SmartQuote: tags.quote,
	'Strong/...': tags.strong,
	'Emph/...': tags.emphasis,
	// raw blocks line up with md fenced code: ``` delims are markers, the info string is a
	// labelName (md tags CodeInfo the same way), the content is monospace
	RawLang: tags.labelName,
	RawDelim: tags.processingInstruction,
	Raw: tags.monospace,
	// url, not link: a typst Link node is a bare autolink (https://..), i.e. the URL itself -
	// tags.link is underline-only in the theme because md applies it to whole [text](url) subtrees
	Link: tags.url,
	Label: tags.labelName,
	'Ref/...': tags.labelName,
	'Heading/...': tags.heading,
	// direct assignment beats the Heading/... rule: the `=` marker colours like md's `#` and a
	// LaTeX \section command, while the title text keeps the heading style (bold, plain)
	HeadingMarker: tags.processingInstruction,
	// marker tags, not tags.list: md's list rule spans the whole list SUBTREE, so a colour on
	// tags.list painted md item text - the theme colours only marker/command tags
	ListMarker: tags.processingInstruction,
	EnumMarker: tags.processingInstruction,
	TermMarker: tags.definitionOperator,

	MathText: tags.special(tags.string),
	MathIdent: tags.special(tags.variableName),
	'MathShorthand MathAlignPoint MathDelimited MathAttach MathPrimes MathFrac MathRoot': tags.special(tags.contentSeparator),

	Error: tags.invalid,

	// the hash is typst's syntax carrier the way the backslash starts a LaTeX command: it colours
	// with the markers/commands, not with control-flow keywords
	Hash: tags.processingInstruction,
	'LeftBrace RightBrace': tags.brace,
	'LeftBracket RightBracket': tags.bracket,
	'LeftParen RightParen': tags.paren,
	Comma: tags.separator,
	'Semicolon Colon Dot Dots': tags.punctuation,
	Dollar: tags.controlKeyword,
	'Plus Minus Slash Hat': tags.arithmeticOperator,
	Prime: tags.typeOperator,
	'Eq PlusEq HyphEq SlashEq StarEq': tags.updateOperator,
	'EqEq ExclEq Lt LtEq Gt GtEq': tags.compareOperator,
	Arrow: tags.controlOperator,
	Root: tags.arithmeticOperator,

	'Not And Or': tags.operatorKeyword,
	'None Auto': tags.literal,
	'If Else For While Break Continue Return': tags.controlKeyword,
	'Import Include': tags.moduleKeyword,
	'Let Set Show Context': tags.definitionKeyword,
	'As In': tags.operatorKeyword,

	// Code (a `{..}` code block) is deliberately untagged: it is live syntax whose tokens carry
	// their own tags, and a blanket monospace colour bled onto every plain ident inside it.
	// Raw above keeps the colour - that is the verbatim analogue of md fenced code.
	// the called name, not every ident: #image(..) colours like a LaTeX \command does, while a
	// plain variable stays uncoloured the way other languages leave variables
	'FuncCall/Ident': tags.function(tags.variableName),
	Ident: tags.variableName,
	Bool: tags.bool,
	Int: tags.integer,
	Float: tags.float,
	Numeric: tags.number,
	Str: tags.string
});
