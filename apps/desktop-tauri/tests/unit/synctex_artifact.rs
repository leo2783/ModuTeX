// SPDX-License-Identifier: Apache-2.0
use super::normalize_gzip;
use crate::shared::relative_path::RelativePath;
use flate2::{read::MultiGzDecoder, write::GzEncoder, Compression};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::Command,
};
use uuid::Uuid;

struct TestDirectory(PathBuf);

impl TestDirectory {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "modutex-synctex-{}-{}",
            std::process::id(),
            Uuid::new_v4().simple()
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TestDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn fixture() -> (TestDirectory, PathBuf, Vec<RelativePath>) {
    let directory = TestDirectory::new();
    let input_root = directory
        .path()
        .join(format!("owned-{}", "\u{03a9}"))
        .join("owned-run")
        .join("input");
    let nested_name = format!("{}.tex", "\u{5b50}");
    fs::create_dir_all(input_root.join("sections")).unwrap();
    fs::write(input_root.join("main.tex"), b"main source").unwrap();
    fs::write(
        input_root.join("sections").join(&nested_name),
        b"nested source",
    )
    .unwrap();
    let paths = vec![
        RelativePath::parse("main.tex").unwrap(),
        RelativePath::parse(&format!("sections/{nested_name}")).unwrap(),
    ];
    (directory, input_root, paths)
}

fn append_line(text: &mut String, byte_count: &mut usize, line: &str) {
    text.push_str(line);
    text.push('\n');
    *byte_count = (*byte_count).checked_add(line.len() + 1).unwrap();
}

fn append_anchor(text: &mut String, byte_count: &mut usize) -> usize {
    let distance = *byte_count;
    let line = format!("!{distance}\n");
    text.push_str(&line);
    *byte_count = line.len();
    distance
}

fn append_header(text: &mut String, byte_count: &mut usize, main: &str) {
    append_line(text, byte_count, "SyncTeX Version:1");
    append_line(text, byte_count, &format!("Input:1:{main}"));
    append_line(text, byte_count, "Output:pdf");
    append_line(text, byte_count, "Magnification:1000");
    append_line(text, byte_count, "Unit:1");
    append_line(text, byte_count, "X Offset:0");
    append_line(text, byte_count, "Y Offset:0");
    append_line(text, byte_count, "Content:");
}

fn gzip(text: &str) -> Vec<u8> {
    let mut encoder = GzEncoder::new(Vec::new(), Compression::fast());
    encoder.write_all(text.as_bytes()).unwrap();
    encoder.finish().unwrap()
}

fn gunzip(bytes: &[u8]) -> String {
    let mut decoder = MultiGzDecoder::new(bytes);
    let mut text = String::new();
    decoder.read_to_string(&mut text).unwrap();
    text
}

fn anchor_values(text: &str) -> Vec<usize> {
    text.lines()
        .filter_map(|line| line.strip_prefix('!')?.parse().ok())
        .collect()
}

fn assert_relative_anchor_distances(text: &str) {
    let mut byte_count = 0usize;
    let mut content_seen = false;
    for line in text.split_inclusive('\n') {
        let body = line.strip_suffix('\n').unwrap_or(line);
        let body = body.strip_suffix('\r').unwrap_or(body);
        if content_seen && body.starts_with('!') {
            let distance = body.strip_prefix('!').unwrap().parse::<usize>().unwrap();
            assert_eq!(distance, byte_count);
            byte_count = line.len();
        } else {
            byte_count += line.len();
        }
        if body == "Content:" {
            content_seen = true;
        }
    }
}

#[test]
fn maps_absolute_and_relative_inputs_in_header_and_later_content() {
    let (_directory, input_root, paths) = fixture();
    let main = input_root.join("main.tex").to_str().unwrap().to_owned();
    let nested = input_root
        .join("sections")
        .join(format!("{}.tex", "\u{5b50}"))
        .to_str()
        .unwrap()
        .to_owned();
    let mut raw = String::new();
    let mut byte_count = 0usize;
    append_header(&mut raw, &mut byte_count, &main);
    append_line(&mut raw, &mut byte_count, "{1");
    append_line(&mut raw, &mut byte_count, "[1,1:0,0:0,0,0");
    append_line(&mut raw, &mut byte_count, "h1,1:0,0:0,0,0");
    append_line(&mut raw, &mut byte_count, "]");
    append_line(&mut raw, &mut byte_count, "}");
    append_line(&mut raw, &mut byte_count, &format!("Input:2:{nested}"));
    append_line(&mut raw, &mut byte_count, "{2");
    append_line(&mut raw, &mut byte_count, "[2,1:0,0:0,0,0");
    append_line(&mut raw, &mut byte_count, "]");
    append_line(&mut raw, &mut byte_count, "}");
    append_line(&mut raw, &mut byte_count, "Input:3:./main.tex");
    append_line(
        &mut raw,
        &mut byte_count,
        &format!("Input:4:sections/{}.tex", "\u{5b50}"),
    );
    append_anchor(&mut raw, &mut byte_count);
    append_line(&mut raw, &mut byte_count, "Postamble:");
    append_line(&mut raw, &mut byte_count, "Count:2");
    assert_relative_anchor_distances(&raw);

    let normalized = normalize_gzip(&gzip(&raw), &input_root, paths.iter(), &paths[0]).unwrap();
    let normalized = gunzip(&normalized);
    assert!(normalized.contains("Input:1:main.tex\n"));
    assert!(normalized.contains(&format!("Input:2:{}\n", paths[1].as_str())));
    assert!(normalized.contains("Input:3:main.tex\n"));
    assert!(normalized.contains(&format!("Input:4:{}\n", paths[1].as_str())));
    assert_relative_anchor_distances(&normalized);
}

#[test]
fn recomputes_multiple_relative_anchors_across_a_digit_boundary() {
    let (_directory, input_root, paths) = fixture();
    let main = input_root.join("main.tex").to_str().unwrap().to_owned();
    let nested = input_root
        .join("sections")
        .join(format!("{}.tex", "\u{5b50}"))
        .to_str()
        .unwrap()
        .to_owned();
    let shortening = main.len() - "main.tex".len();
    let mut raw = String::new();
    let mut byte_count = 0usize;
    append_header(&mut raw, &mut byte_count, &main);
    append_line(&mut raw, &mut byte_count, "{1");
    append_line(&mut raw, &mut byte_count, "[1,1:0,0:0,0,0");
    let node = "h1,1:0,0:0,0,0";
    let record_bytes = node.len() + 1;
    assert!(shortening > record_bytes);
    let needed = 1000usize.saturating_sub(byte_count);
    let repeats = needed.div_ceil(record_bytes);
    let first_old = byte_count + repeats * record_bytes;
    assert!(first_old >= 1000 && first_old < 1000 + shortening);
    for _ in 0..repeats {
        append_line(&mut raw, &mut byte_count, node);
    }
    assert_eq!(byte_count, first_old);
    append_anchor(&mut raw, &mut byte_count);
    append_line(&mut raw, &mut byte_count, "]");
    append_line(&mut raw, &mut byte_count, "}");
    append_line(&mut raw, &mut byte_count, &format!("Input:2:{nested}"));
    append_line(&mut raw, &mut byte_count, "{2");
    append_line(&mut raw, &mut byte_count, "[2,1:0,0:0,0,0");
    append_line(&mut raw, &mut byte_count, "h2,1:0,0:0,0,0");
    append_anchor(&mut raw, &mut byte_count);
    append_line(&mut raw, &mut byte_count, "]");
    append_line(&mut raw, &mut byte_count, "}");
    append_line(&mut raw, &mut byte_count, "Postamble:");
    append_line(&mut raw, &mut byte_count, "Count:2");
    assert_relative_anchor_distances(&raw);
    let old_values = anchor_values(&raw);

    let normalized = normalize_gzip(&gzip(&raw), &input_root, paths.iter(), &paths[0]).unwrap();
    let normalized = gunzip(&normalized);
    let new_values = anchor_values(&normalized);
    assert_eq!(old_values.len(), 2);
    assert_eq!(new_values.len(), 2);
    assert_eq!(new_values[0], old_values[0] - shortening);
    assert!(old_values[0] >= 1000 && new_values[0] < 1000);
    assert_ne!(new_values[1], old_values[1]);
    assert!(normalized.contains(&format!("Input:2:{}\n", paths[1].as_str())));
    assert_relative_anchor_distances(&normalized);
}

#[test]
fn leaves_external_traversal_root_prefix_and_case_ambiguous_inputs_unmapped() {
    let (_directory, input_root, mut paths) = fixture();
    let main = input_root.join("main.tex").to_str().unwrap().to_owned();
    let root = input_root.to_str().unwrap();
    paths.push(RelativePath::parse("sections/case.tex").unwrap());
    paths.push(RelativePath::parse("sections/Case.tex").unwrap());
    let mut other_drive = main.clone();
    let replacement = if main.starts_with("C:") || main.starts_with("c:") {
        "D"
    } else {
        "C"
    };
    other_drive.replace_range(0..1, replacement);
    let untrusted = [
        format!("{root}-sibling/main.tex"),
        format!("{root}/../main.tex"),
        "//server/share/main.tex".to_owned(),
        "//?/UNC/server/share/main.tex".to_owned(),
        other_drive,
        "../main.tex".to_owned(),
    ];
    let ambiguous = format!("{root}/sections/case.tex");
    let mut raw = String::new();
    let mut byte_count = 0usize;
    append_header(&mut raw, &mut byte_count, &main);
    for (index, path) in untrusted.iter().enumerate() {
        append_line(
            &mut raw,
            &mut byte_count,
            &format!("Input:{}:{path}", index + 2),
        );
    }
    append_line(&mut raw, &mut byte_count, &format!("Input:20:{ambiguous}"));
    append_anchor(&mut raw, &mut byte_count);
    append_line(&mut raw, &mut byte_count, "Postamble:");
    append_line(&mut raw, &mut byte_count, "Count:1");

    let normalized = normalize_gzip(&gzip(&raw), &input_root, paths.iter(), &paths[0]).unwrap();
    let normalized = gunzip(&normalized);
    assert!(normalized.contains("Input:1:main.tex\n"));
    for (index, path) in untrusted.iter().enumerate() {
        assert!(normalized.contains(&format!("Input:{}:{path}\n", index + 2)));
    }
    assert!(normalized.contains(&format!("Input:20:{ambiguous}\n")));
    assert_relative_anchor_distances(&normalized);
}

#[test]
fn does_not_normalize_a_source_reached_through_an_unprivileged_junction() {
    let (directory, input_root, mut paths) = fixture();
    let outside = directory.path().join("external");
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("source.tex"), b"external source").unwrap();
    let junction = input_root.join("linked");
    let output = Command::new("cmd.exe")
        .args(["/D", "/C", "mklink", "/J"])
        .arg(&junction)
        .arg(&outside)
        .output()
        .expect("create a directory junction without symlink privilege");
    assert!(
        output.status.success(),
        "mklink /J failed: {}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let metadata = fs::symlink_metadata(&junction).unwrap();
    assert!(crate::platform::file_identity::is_symlink_or_reparse(
        &metadata
    ));

    paths.push(RelativePath::parse("linked/source.tex").unwrap());
    let main = input_root.join("main.tex").to_str().unwrap().to_owned();
    let linked = junction.join("source.tex").to_str().unwrap().to_owned();
    let mut raw = String::new();
    let mut byte_count = 0usize;
    append_header(&mut raw, &mut byte_count, &main);
    append_line(&mut raw, &mut byte_count, "{1");
    append_line(&mut raw, &mut byte_count, &format!("Input:2:{linked}"));
    append_anchor(&mut raw, &mut byte_count);
    append_line(&mut raw, &mut byte_count, "}");
    append_line(&mut raw, &mut byte_count, "Postamble:");
    append_line(&mut raw, &mut byte_count, "Count:1");

    let normalized = normalize_gzip(&gzip(&raw), &input_root, paths.iter(), &paths[0]).unwrap();
    let normalized = gunzip(&normalized);
    assert!(normalized.contains("Input:1:main.tex\n"));
    assert!(normalized.contains(&format!("Input:2:{linked}\n")));
    fs::remove_dir(&junction).unwrap();
}

#[test]
fn rejects_malformed_gzip_without_changing_compile_success() {
    let (_directory, input_root, paths) = fixture();
    assert!(normalize_gzip(b"not a gzip stream", &input_root, paths.iter(), &paths[0]).is_none());
}

#[test]
fn real_tectonic_normalized_artifact_preserves_entry_include_and_pdf_locations() {
    use crate::platform::process_tree::{cancellation_pair, run, ProcessSpec};
    use modutex_document_core::SynctexIndex;
    use std::{ffi::OsString, time::Duration};

    let repository = Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .take(8)
        .find(|path| {
            path.join("vendor/tectonic/windows-x64/tectonic.exe")
                .is_file()
        })
        .expect("repository with pinned Tectonic");
    let (directory, input, paths) = fixture();
    let output = directory.path().join("output");
    fs::create_dir(&output).unwrap();
    fs::write(input.join("main.tex"), format!(
        "\\documentclass{{article}}\n\\begin{{document}}\nEntry source line.\n\\par\\newpage\n\\input{{{}}}\n\\end{{document}}\n",
        paths[1].as_str()
    )).unwrap();
    fs::write(input.join(paths[1].as_str()), b"Included source line.\n").unwrap();
    let existing_cache = std::env::var_os("TECTONIC_CACHE_DIR");
    let cache = existing_cache
        .clone()
        .unwrap_or_else(|| directory.path().join("cache").into_os_string());
    let mut arguments: Vec<OsString> = ["--untrusted", "--keep-logs", "--synctex"]
        .into_iter()
        .map(OsString::from)
        .collect();
    if existing_cache.is_some() {
        arguments.push("--only-cached".into());
    }
    arguments.extend([
        OsString::from("--outdir"),
        output.clone().into_os_string(),
        OsString::from("main.tex"),
    ]);
    let spec = ProcessSpec::new(
        repository.join("vendor/tectonic/windows-x64/tectonic.exe"),
        input.clone(),
        arguments,
        Duration::from_secs(360),
        1024 * 1024,
    )
    .with_environment(vec![(OsString::from("TECTONIC_CACHE_DIR"), cache)]);
    let (_cancel, token) = cancellation_pair();
    let result = run(&spec, &token).expect("real engine drains successfully");
    assert_eq!(
        result.exit_code,
        0,
        "{}",
        String::from_utf8_lossy(&result.logs.stderr)
    );
    assert!(fs::read(output.join("main.pdf"))
        .unwrap()
        .starts_with(b"%PDF-"));
    let raw = fs::read(output.join("main.synctex.gz")).unwrap();
    let normalized = normalize_gzip(&raw, &input, paths.iter(), &paths[0]).unwrap_or_else(|| {
        let mut decoded = Vec::new();
        let decode_result = MultiGzDecoder::new(raw.as_slice()).read_to_end(&mut decoded);

        let excerpt = String::from_utf8_lossy(&decoded);
        panic!(
            "SyncTeX normalization failed\n\
             input root: {}\n\
             expected paths: {:?}\n\
             gzip decoding: {:?}\n\
             raw SyncTeX:\n{}",
            input.display(),
            paths.iter().map(|p| p.as_str()).collect::<Vec<_>>(),
            decode_result,
            excerpt.lines().take(30).collect::<Vec<_>>().join("\n")
        );
    });
    let normalized_text = gunzip(&normalized);
    assert_relative_anchor_distances(&normalized_text);
    assert!(anchor_values(&normalized_text).len() >= 4);
    let raw_index = SynctexIndex::parse(&raw).expect("raw engine SyncTeX parses");
    let index = SynctexIndex::parse(&normalized).expect("normalized engine SyncTeX parses");
    for (source, line) in [(&paths[0], 3), (&paths[1], 1)] {
        let absolute = input.join(source.as_str());
        let location = index
            .forward_search(source.as_str(), line, None)
            .expect("relative source maps");
        let original = raw_index
            .forward_search(absolute.to_str().unwrap(), line, None)
            .expect("original absolute source maps");
        assert_eq!(
            location, original,
            "normalization preserves exact PDF points"
        );
        let inverse = index
            .inverse_search(
                location.page,
                location.x + location.width / 2.0,
                location.y + location.height / 2.0,
            )
            .expect("inverse PDF point maps");
        assert_eq!(inverse.path, source.as_str());
        assert_eq!(inverse.line, line);
    }
    assert_eq!(
        fs::read(output.join("main.synctex.gz")).unwrap(),
        raw,
        "original engine file remains unchanged"
    );
}
