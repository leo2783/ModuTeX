// SPDX-License-Identifier: Apache-2.0
pub mod changes;
pub mod editor_projection;
pub mod parser;
pub mod pdf_wrap;
pub mod source;
pub mod utf8;

pub use changes::{map_position, remap_span, Bias, SourceChange, SourcePatch, SourceSpan};
pub use editor_projection::{EditorPatch, EditorProjection};
pub use pdf_wrap::pdf_wrapped_text;
pub use source::{SourceDocument, SourceError, SourceTransaction, SourceUpdate};
pub use utf8::{LineEndings, SourceProfile};
