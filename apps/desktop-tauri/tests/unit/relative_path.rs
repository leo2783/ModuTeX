// SPDX-License-Identifier: Apache-2.0
use super::*;

#[test]
fn test_traversal() {
    assert_eq!(RelativePath::parse("."), Err(PathError::RelativeSegment));
    assert_eq!(RelativePath::parse(".."), Err(PathError::RelativeSegment));
    assert_eq!(
        RelativePath::parse("../foo"),
        Err(PathError::RelativeSegment)
    );
    assert_eq!(
        RelativePath::parse("foo/.."),
        Err(PathError::RelativeSegment)
    );
    assert_eq!(
        RelativePath::parse("foo/../bar"),
        Err(PathError::RelativeSegment)
    );
    assert_eq!(
        RelativePath::parse("foo/./bar"),
        Err(PathError::RelativeSegment)
    );
    assert_eq!(
        RelativePath::parse("./foo"),
        Err(PathError::RelativeSegment)
    );
    assert_eq!(
        RelativePath::parse("a/b/../../c"),
        Err(PathError::RelativeSegment)
    );
}

#[test]
fn test_drive_and_ads() {
    assert_eq!(
        RelativePath::parse("C:"),
        Err(PathError::ForbiddenCharacter(':'))
    );
    assert_eq!(
        RelativePath::parse("C:/foo"),
        Err(PathError::ForbiddenCharacter(':'))
    );
    assert_eq!(
        RelativePath::parse("c:/windows"),
        Err(PathError::ForbiddenCharacter(':'))
    );
    assert_eq!(
        RelativePath::parse("D:file.txt"),
        Err(PathError::ForbiddenCharacter(':'))
    );
    assert_eq!(
        RelativePath::parse("file.txt:stream"),
        Err(PathError::ForbiddenCharacter(':'))
    );
    assert_eq!(
        RelativePath::parse("docs/note.tex:zone"),
        Err(PathError::ForbiddenCharacter(':'))
    );
}

#[test]
fn test_unc_and_backslash() {
    assert_eq!(
        RelativePath::parse(r"\\server\share"),
        Err(PathError::ForbiddenCharacter('\\'))
    );
    assert_eq!(
        RelativePath::parse(r"foo\bar"),
        Err(PathError::ForbiddenCharacter('\\'))
    );
    assert_eq!(
        RelativePath::parse("//server/share"),
        Err(PathError::LeadingSlash)
    );
}

#[test]
fn test_device_names() {
    // Base reserved names
    assert!(matches!(
        RelativePath::parse("con"),
        Err(PathError::ReservedDeviceName(_))
    ));
    assert!(matches!(
        RelativePath::parse("CON"),
        Err(PathError::ReservedDeviceName(_))
    ));
    assert!(matches!(
        RelativePath::parse("prn"),
        Err(PathError::ReservedDeviceName(_))
    ));
    assert!(matches!(
        RelativePath::parse("PRN"),
        Err(PathError::ReservedDeviceName(_))
    ));
    assert!(matches!(
        RelativePath::parse("aux"),
        Err(PathError::ReservedDeviceName(_))
    ));
    assert!(matches!(
        RelativePath::parse("AUX"),
        Err(PathError::ReservedDeviceName(_))
    ));
    assert!(matches!(
        RelativePath::parse("nul"),
        Err(PathError::ReservedDeviceName(_))
    ));
    assert!(matches!(
        RelativePath::parse("NUL"),
        Err(PathError::ReservedDeviceName(_))
    ));

    // With extensions
    assert!(matches!(
        RelativePath::parse("con.txt"),
        Err(PathError::ReservedDeviceName(_))
    ));
    assert!(matches!(
        RelativePath::parse("CON.tar.gz"),
        Err(PathError::ReservedDeviceName(_))
    ));
    assert!(matches!(
        RelativePath::parse("aux.tex"),
        Err(PathError::ReservedDeviceName(_))
    ));
    assert!(matches!(
        RelativePath::parse("nul.dat"),
        Err(PathError::ReservedDeviceName(_))
    ));
    assert!(matches!(
        RelativePath::parse("prn.pdf"),
        Err(PathError::ReservedDeviceName(_))
    ));

    // COM1-9 and LPT1-9
    assert!(matches!(
        RelativePath::parse("com1"),
        Err(PathError::ReservedDeviceName(_))
    ));
    assert!(matches!(
        RelativePath::parse("COM1.txt"),
        Err(PathError::ReservedDeviceName(_))
    ));
    assert!(matches!(
        RelativePath::parse("com9.log"),
        Err(PathError::ReservedDeviceName(_))
    ));
    assert!(matches!(
        RelativePath::parse("lpt1"),
        Err(PathError::ReservedDeviceName(_))
    ));
    assert!(matches!(
        RelativePath::parse("LPT1.pdf"),
        Err(PathError::ReservedDeviceName(_))
    ));
    assert!(matches!(
        RelativePath::parse("lpt9"),
        Err(PathError::ReservedDeviceName(_))
    ));

    // In subdirectories
    assert!(matches!(
        RelativePath::parse("folder/con/file.txt"),
        Err(PathError::ReservedDeviceName(_))
    ));
    assert!(matches!(
        RelativePath::parse("docs/aux.tex"),
        Err(PathError::ReservedDeviceName(_))
    ));

    // Non-reserved names that must pass
    assert!(RelativePath::parse("conflict").is_ok());
    assert!(RelativePath::parse("console.txt").is_ok());
    assert!(RelativePath::parse("auxiliary.tex").is_ok());
    assert!(RelativePath::parse("nulled.log").is_ok());
    assert!(RelativePath::parse("com0").is_ok());
    assert!(RelativePath::parse("com10").is_ok());
    assert!(RelativePath::parse("lpt0").is_ok());
    assert!(RelativePath::parse("lpt10.txt").is_ok());
    assert!(RelativePath::parse(".gitignore").is_ok());
    assert!(RelativePath::parse(".con").is_ok());
}

#[test]
fn test_trailing_ambiguity_and_empty_segments() {
    assert_eq!(
        RelativePath::parse("foo."),
        Err(PathError::TrailingDotOrSpace)
    );
    assert_eq!(
        RelativePath::parse("foo "),
        Err(PathError::TrailingDotOrSpace)
    );
    assert_eq!(
        RelativePath::parse("dir./file"),
        Err(PathError::TrailingDotOrSpace)
    );
    assert_eq!(
        RelativePath::parse("dir /file"),
        Err(PathError::TrailingDotOrSpace)
    );
    assert_eq!(RelativePath::parse("foo/"), Err(PathError::EmptySegment));
    assert_eq!(RelativePath::parse("/foo"), Err(PathError::LeadingSlash));
    assert_eq!(
        RelativePath::parse("foo//bar"),
        Err(PathError::EmptySegment)
    );

    // Spaces and dots inside segments are permitted
    assert!(RelativePath::parse("my folder/my file.name.tex").is_ok());
}

#[test]
fn test_control_characters() {
    assert_eq!(
        RelativePath::parse("foo\0bar"),
        Err(PathError::ForbiddenCharacter('\0'))
    );
    assert_eq!(
        RelativePath::parse("foo\tbar"),
        Err(PathError::ForbiddenCharacter('\t'))
    );
    assert_eq!(
        RelativePath::parse("foo\nbar"),
        Err(PathError::ForbiddenCharacter('\n'))
    );
    assert_eq!(
        RelativePath::parse("foo\rbar"),
        Err(PathError::ForbiddenCharacter('\r'))
    );
    assert_eq!(
        RelativePath::parse("foo\x1fbar"),
        Err(PathError::ForbiddenCharacter('\x1f'))
    );
    assert_eq!(
        RelativePath::parse("foo\x7fbar"),
        Err(PathError::ForbiddenCharacter('\x7f'))
    );
}

#[test]
fn test_unicode_and_emoji_length_boundaries() {
    assert_eq!(RelativePath::parse(""), Err(PathError::Empty));

    // Valid international characters and emojis
    assert!(RelativePath::parse("文件/測試.tex").is_ok());
    assert!(RelativePath::parse("日本語/ノート.txt").is_ok());
    assert!(RelativePath::parse("café/résumé.pdf").is_ok());
    assert!(RelativePath::parse("🎉/🦀.tex").is_ok());

    // Exactly 32767 UTF-16 code units (ASCII)
    let exact_limit = "a".repeat(32767);
    assert!(RelativePath::parse(&exact_limit).is_ok());

    // Exceeds 32767 UTF-16 code units (ASCII)
    let too_long = "a".repeat(32768);
    assert_eq!(
        RelativePath::parse(&too_long),
        Err(PathError::TooLong(32768))
    );

    // Emoji accounting: 16383 emojis (32766 code units) + 1 ASCII 'a' = 32767 code units
    let emoji_exact = "🦀".repeat(16383) + "a";
    assert_eq!(emoji_exact.encode_utf16().count(), 32767);
    assert!(RelativePath::parse(&emoji_exact).is_ok());

    // 16384 emojis = 32768 UTF-16 code units
    let emoji_too_long = "🦀".repeat(16384);
    assert_eq!(emoji_too_long.encode_utf16().count(), 32768);
    assert_eq!(
        RelativePath::parse(&emoji_too_long),
        Err(PathError::TooLong(32768))
    );
}

#[test]
fn test_literal_preservation() {
    // %2e%2e must be preserved literally, not decoded to ..
    let p = RelativePath::parse("%2e%2e").expect("should accept %2e%2e");
    assert_eq!(p.as_str(), "%2e%2e");

    let p2 = RelativePath::parse("docs/%2e%2e/file.tex").expect("should accept path with %2e%2e");
    assert_eq!(p2.as_str(), "docs/%2e%2e/file.tex");

    // Literal tilde and percent sequences
    let p3 = RelativePath::parse("~backup.tex").expect("should accept literal tilde");
    assert_eq!(p3.as_str(), "~backup.tex");

    let p4 = RelativePath::parse("folder/%20name%/file.txt").expect("should accept percent");
    assert_eq!(p4.as_str(), "folder/%20name%/file.txt");
}

#[test]
fn test_serde_roundtrip_and_rejections() {
    let valid_path = RelativePath::parse("folder/sub/doc.tex").unwrap();
    let json = serde_json::to_string(&valid_path).expect("serialization succeeds");
    assert_eq!(json, "\"folder/sub/doc.tex\"");

    let deserialized: RelativePath = serde_json::from_str(&json).expect("deserialization succeeds");
    assert_eq!(valid_path, deserialized);

    // Rejection of non-string JSON values
    assert!(serde_json::from_str::<RelativePath>("42").is_err());
    assert!(serde_json::from_str::<RelativePath>("true").is_err());
    assert!(serde_json::from_str::<RelativePath>("null").is_err());
    assert!(serde_json::from_str::<RelativePath>("[\"folder/sub\"]").is_err());
    assert!(serde_json::from_str::<RelativePath>("{\"path\": \"folder/sub\"}").is_err());

    // Rejection of unsafe strings during deserialization
    assert!(serde_json::from_str::<RelativePath>("\"../escape\"").is_err());
    assert!(serde_json::from_str::<RelativePath>("\"C:/foo\"").is_err());
    assert!(serde_json::from_str::<RelativePath>("\"con\"").is_err());
    assert!(serde_json::from_str::<RelativePath>("\"/root\"").is_err());
    assert!(serde_json::from_str::<RelativePath>("\"\"").is_err());
}
