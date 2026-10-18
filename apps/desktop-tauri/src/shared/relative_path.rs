// SPDX-License-Identifier: Apache-2.0

//! Lexical path validation policy for workspace-relative filesystem paths.
//!
//! This module implements the lexical path validation rules matching the frontend
//! contract specification in `packages/frontend-contracts/src/validate.ts`.
//!
//! # Architecture Seam Notice
//! This type performs strictly lexical validation and normalization of path strings.
//! File system isolation and containment guarantees (G2) are enforced separately via
//! handle-based directory sandboxing and capability tokens at the I/O layer.

use serde::de::{Error as DeError, Visitor};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::error::Error;
use std::fmt;

/// Errors encountered while validating a workspace-relative path.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PathError {
    /// The path string is empty.
    Empty,
    /// The path exceeds the maximum length of 32,767 UTF-16 code units.
    TooLong(usize),
    /// The path contains a forbidden character (backslash, colon, or control character).
    ForbiddenCharacter(char),
    /// The path starts with a leading slash.
    LeadingSlash,
    /// The path contains an empty segment (e.g. consecutive slashes or trailing slash).
    EmptySegment,
    /// The path contains a traversal segment (`.` or `..`).
    RelativeSegment,
    /// A path segment ends with an ASCII dot or space.
    TrailingDotOrSpace,
    /// A path segment matches a reserved Windows device name.
    ReservedDeviceName(String),
}

impl fmt::Display for PathError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Empty => write!(f, "path must not be empty"),
            Self::TooLong(units) => {
                write!(
                    f,
                    "path length ({units} UTF-16 code units) exceeds 32767 limit"
                )
            }
            Self::ForbiddenCharacter(ch) => {
                write!(f, "path contains forbidden character: {ch:?}")
            }
            Self::LeadingSlash => write!(f, "path must not start with a leading slash"),
            Self::EmptySegment => write!(f, "path must not contain empty segments"),
            Self::RelativeSegment => {
                write!(
                    f,
                    "path must not contain relative traversal segments ('.' or '..')"
                )
            }
            Self::TrailingDotOrSpace => {
                write!(f, "path segment must not end with an ASCII dot or space")
            }
            Self::ReservedDeviceName(name) => {
                write!(f, "path segment is a reserved device name: {name}")
            }
        }
    }
}

impl Error for PathError {}

/// A validated workspace-relative filesystem path string.
///
/// Encapsulates a path that conforms strictly to the workspace-relative
/// contract rules defined in the frontend contracts.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct RelativePath(String);

impl RelativePath {
    /// Parses and validates a path string according to workspace-relative policy.
    pub fn parse(s: &str) -> Result<Self, PathError> {
        if s.is_empty() {
            return Err(PathError::Empty);
        }

        let mut utf16_len = 0usize;
        for ch in s.chars() {
            if ch == '\\' || ch == ':' || ch <= '\x1f' || ch == '\x7f' {
                return Err(PathError::ForbiddenCharacter(ch));
            }
            utf16_len += ch.len_utf16();
        }

        if utf16_len > 32767 {
            return Err(PathError::TooLong(utf16_len));
        }

        if s.starts_with('/') {
            return Err(PathError::LeadingSlash);
        }

        for part in s.split('/') {
            if part.is_empty() {
                return Err(PathError::EmptySegment);
            }
            if part == "." || part == ".." {
                return Err(PathError::RelativeSegment);
            }
            if part.ends_with('.') || part.ends_with(' ') {
                return Err(PathError::TrailingDotOrSpace);
            }
            if is_reserved_device_name(part) {
                return Err(PathError::ReservedDeviceName(part.to_string()));
            }
        }

        Ok(Self(s.to_string()))
    }

    /// Returns the underlying path as a string slice.
    #[inline]
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// Consumes the wrapper, returning the inner `String`.
    #[inline]
    pub fn into_string(self) -> String {
        self.0
    }
}

impl AsRef<str> for RelativePath {
    #[inline]
    fn as_ref(&self) -> &str {
        self.as_str()
    }
}

impl std::ops::Deref for RelativePath {
    type Target = str;

    #[inline]
    fn deref(&self) -> &Self::Target {
        self.as_str()
    }
}

impl fmt::Display for RelativePath {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl std::str::FromStr for RelativePath {
    type Err = PathError;

    #[inline]
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Self::parse(s)
    }
}

impl TryFrom<&str> for RelativePath {
    type Error = PathError;

    #[inline]
    fn try_from(s: &str) -> Result<Self, Self::Error> {
        Self::parse(s)
    }
}

impl TryFrom<String> for RelativePath {
    type Error = PathError;

    #[inline]
    fn try_from(s: String) -> Result<Self, Self::Error> {
        Self::parse(&s)
    }
}

impl Serialize for RelativePath {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for RelativePath {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct RelativePathVisitor;

        impl<'de> Visitor<'de> for RelativePathVisitor {
            type Value = RelativePath;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("a valid workspace-relative path string")
            }

            fn visit_str<E>(self, value: &str) -> Result<RelativePath, E>
            where
                E: DeError,
            {
                RelativePath::parse(value).map_err(DeError::custom)
            }

            fn visit_string<E>(self, value: String) -> Result<RelativePath, E>
            where
                E: DeError,
            {
                RelativePath::parse(&value).map_err(DeError::custom)
            }
        }

        deserializer.deserialize_str(RelativePathVisitor)
    }
}

/// Checks if a path segment is a Windows reserved device name.
///
/// Matches `/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i`.
fn is_reserved_device_name(part: &str) -> bool {
    let stem = match part.find('.') {
        Some(idx) => &part[..idx],
        None => part,
    };
    let bytes = stem.as_bytes();
    match bytes.len() {
        3 => {
            stem.eq_ignore_ascii_case("con")
                || stem.eq_ignore_ascii_case("prn")
                || stem.eq_ignore_ascii_case("aux")
                || stem.eq_ignore_ascii_case("nul")
        }
        4 => {
            let is_com_or_lpt = bytes[0..3].eq_ignore_ascii_case(b"com")
                || bytes[0..3].eq_ignore_ascii_case(b"lpt");
            is_com_or_lpt && (b'1'..=b'9').contains(&bytes[3])
        }
        _ => false,
    }
}

#[cfg(test)]
#[path = "../../tests/unit/relative_path.rs"]
mod tests;
