// SPDX-License-Identifier: Apache-2.0
use super::*;
use serde::de::DeserializeOwned;
use serde_json::{from_value, json, to_value, Value};

fn rejects<T: DeserializeOwned>(value: Value) {
    assert!(from_value::<T>(value.clone()).is_err(), "accepted {value}");
}

fn accepts<T: DeserializeOwned>(value: Value) -> T {
    from_value(value.clone()).unwrap_or_else(|error| panic!("rejected {value}: {error}"))
}

fn round_trip<T: Serialize + DeserializeOwned + PartialEq + fmt::Debug>(value: Value) {
    let parsed: T = accepts(value.clone());
    let encoded = to_value(&parsed).expect("serialize");
    assert_eq!(encoded, value);
    assert_eq!(accepts::<T>(encoded), parsed);
}

fn png(len: usize) -> Vec<u8> {
    let mut bytes = vec![0; len];
    bytes[..8].copy_from_slice(&[137, 80, 78, 71, 13, 10, 26, 10]);
    bytes
}

fn jpeg() -> Vec<u8> {
    vec![255, 216, 255, 0, 0, 0, 0, 0, 0, 0, 255, 217]
}

fn write_request() -> Value {
    json!({"workspaceId": "ws-1", "path": "main.tex", "bytes": [104, 105],
            "expectedRevision": "rev:1", "documentId": "doc_1", "documentVersion": 3})
}

fn compile_request() -> Value {
    json!({"workspaceId": "ws-1", "entryPath": "main.tex", "documentId": "doc_1",
            "documentVersion": 3, "savedRevision": "sha256:abc", "engine": "managed"})
}

fn identity() -> Value {
    json!({"runId": "run-1", "workspaceId": "ws-1", "entryPath": "main.tex",
            "documentId": "doc_1", "documentVersion": 3, "savedRevision": "sha256:abc"})
}

fn success() -> Value {
    json!({"status": "success", "identity": identity(), "pdf": [37, 80, 68, 70, 45, 49],
            "log": "ok", "diagnostics": [{"severity": "warning", "message": "w",
                "path": "main.tex", "line": 3, "column": null}]})
}

fn failure() -> Value {
    json!({"status": "failure", "identity": identity(), "log": "", "diagnostics": []})
}

fn save_as(images: Value) -> Value {
    json!({"images": images, "workspaceId": null, "bytes": [],
            "documentId": "doc_1", "documentVersion": 0})
}

#[test]
fn unknown_fields_are_rejected() {
    let mut request = write_request();
    request["extra"] = json!(true);
    rejects::<WriteRequest>(request);
    let mut request = compile_request();
    request["extra"] = json!(1);
    rejects::<CompileRequest>(request);
    let mut nested = failure();
    nested["identity"]["extra"] = json!("x");
    rejects::<CompileResult>(nested);
    let mut with_pdf = failure();
    with_pdf["pdf"] = json!([37, 80, 68, 70, 45]);
    rejects::<CompileResult>(with_pdf);
    rejects::<FileRef>(json!({"workspaceId": "ws-1", "path": "../escape.tex"}));
}

#[test]
fn bad_identifiers_are_rejected() {
    let bad_ids = [
        json!(""),
        json!("a b"),
        json!("a/b"),
        json!("é"),
        json!("a.b"),
        json!("a".repeat(129)),
        json!(5),
        json!(null),
    ];
    for bad in bad_ids {
        let mut request = write_request();
        request["workspaceId"] = bad.clone();
        rejects::<WriteRequest>(request);
        let mut request = write_request();
        request["documentId"] = bad;
        rejects::<WriteRequest>(request);
    }
    let mut edge = write_request();
    edge["workspaceId"] = json!("a".repeat(128));
    accepts::<WriteRequest>(edge);
    for bad in [
        json!(""),
        json!("a b"),
        json!("a/b"),
        json!("a".repeat(257)),
    ] {
        let mut request = write_request();
        request["expectedRevision"] = bad;
        rejects::<WriteRequest>(request);
    }
    let mut missing = write_request();
    missing
        .as_object_mut()
        .expect("object")
        .remove("expectedRevision");
    rejects::<WriteRequest>(missing);
}

#[test]
fn document_version_must_be_a_safe_non_negative_integer() {
    let bad_versions = [
        json!(-1),
        json!(9_007_199_254_740_992u64),
        json!(1.5),
        json!("1"),
        json!(null),
    ];
    for bad in bad_versions {
        let mut request = write_request();
        request["documentVersion"] = bad;
        rejects::<WriteRequest>(request);
    }
    for good in [json!(0), json!(9_007_199_254_740_991u64)] {
        let mut request = write_request();
        request["documentVersion"] = good;
        accepts::<WriteRequest>(request);
    }
}

#[test]
fn invalid_byte_payloads_are_rejected() {
    let bad_bytes = [
        json!([256]),
        json!([-1]),
        json!([1.5]),
        json!([1, "a"]),
        json!("hi"),
        json!(null),
    ];
    for bad in bad_bytes {
        let mut request = write_request();
        request["bytes"] = bad;
        rejects::<WriteRequest>(request);
    }
    let mut empty = write_request();
    empty["bytes"] = json!([]);
    accepts::<WriteRequest>(empty);
    let mut no_header = success();
    no_header["pdf"] = json!([1, 2, 3, 4, 5]);
    rejects::<CompileResult>(no_header);
}

#[test]
fn pdf_and_read_limits_follow_the_renderer_adapter() {
    assert_eq!(MAX_PDF_BYTES, 32 * 1024 * 1024);
    assert_eq!(MAX_LOG_CHARACTERS, 256 * 1024);
    assert_eq!(MAX_DIAGNOSTICS, 256);
    let mut pdf = b"%PDF-".to_vec();
    pdf.resize(MAX_PDF_BYTES, 0);
    assert!(validate_pdf(&pdf).is_ok());
    pdf.push(0);
    assert!(validate_pdf(&pdf).is_err());
    assert!(validate_pdf(b"%PDF").is_err());

    assert_eq!(read_limit("a.PDF"), MAX_PDF_BYTES);
    assert_eq!(read_limit("a.tex"), MAX_READ_BYTES);
    let wire = |path: &str, len: usize| ReadReceiptWire {
        workspace_id: WorkspaceId::parse("ws-1").expect("id"),
        path: RelativePath::parse(path).expect("path"),
        bytes: vec![0; len],
        revision: Revision::parse("r1").expect("revision"),
        document_id: None,
        document_version: None,
    };
    assert!(ReadReceipt::try_from(wire("a.tex", MAX_READ_BYTES)).is_ok());
    assert!(ReadReceipt::try_from(wire("a.tex", MAX_READ_BYTES + 1)).is_err());
    assert!(ReadReceipt::try_from(wire("a.pdf", MAX_READ_BYTES + 1)).is_ok());

    let mut many = vec![failure()["diagnostics"].clone()];
    many.clear();
    let diagnostic = json!({"severity": "info", "message": "m",
            "path": null, "line": null, "column": null});
    let mut result = failure();
    result["diagnostics"] = Value::Array(vec![diagnostic.clone(); MAX_DIAGNOSTICS]);
    accepts::<CompileResult>(result.clone());
    result["diagnostics"] = Value::Array(vec![diagnostic; MAX_DIAGNOSTICS + 1]);
    rejects::<CompileResult>(result);
    let mut result = failure();
    result["log"] = json!("x".repeat(MAX_LOG_CHARACTERS));
    accepts::<CompileResult>(result.clone());
    result["log"] = json!("x".repeat(MAX_LOG_CHARACTERS + 1));
    rejects::<CompileResult>(result);
}

#[test]
fn bad_engine_and_status_are_rejected() {
    for bad in [json!("remote"), json!("Managed"), json!(null), json!(1)] {
        let mut request = compile_request();
        request["engine"] = bad;
        rejects::<CompileRequest>(request);
    }
    let mut system = compile_request();
    system["engine"] = json!("system");
    accepts::<CompileRequest>(system);
    for bad in ["done", "Success", ""] {
        let mut result = failure();
        result["status"] = json!(bad);
        rejects::<CompileResult>(result);
    }
    let mut no_status = failure();
    no_status.as_object_mut().expect("object").remove("status");
    rejects::<CompileResult>(no_status);
    let mut no_pdf = success();
    no_pdf.as_object_mut().expect("object").remove("pdf");
    rejects::<CompileResult>(no_pdf);
    rejects::<FileWatchFailure>(json!("OTHER"));
}

#[test]
fn diagnostics_require_consistent_locations() {
    let base = |path: Value, line: Value, column: Value| {
        json!({"severity": "error", "message": "m",
                "path": path, "line": line, "column": column})
    };
    accepts::<Diagnostic>(base(json!(null), json!(null), json!(null)));
    accepts::<Diagnostic>(base(json!("a.tex"), json!(1), json!(2)));
    rejects::<Diagnostic>(base(json!(null), json!(1), json!(null)));
    rejects::<Diagnostic>(base(json!("a.tex"), json!(null), json!(2)));
    rejects::<Diagnostic>(base(json!("a.tex"), json!(0), json!(null)));
    rejects::<Diagnostic>(json!({"severity": "fatal", "message": "m",
            "path": null, "line": null, "column": null}));
    rejects::<Diagnostic>(json!({"severity": "error", "message": "m",
            "path": null, "line": null}));
}

#[test]
fn nullable_fields_must_be_explicit() {
    rejects::<WorkspaceInfo>(json!({"id": "ws-1", "label": "Thesis"}));
    round_trip::<WorkspaceInfo>(json!({"id": "ws-1", "label": "Thesis", "entryPath": null}));
}

#[test]
fn recent_documents_follow_the_contract_rules() {
    let id = "123e4567-e89b-42d3-a456-426614174000";
    let recent = |label: &str, entry: Value| json!({"id": id, "label": label, "entryPath": entry, "openedAt": 1});
    rejects::<RecentDocument>(recent("a/b", json!(null)));
    rejects::<RecentDocument>(recent("", json!(null)));
    rejects::<RecentDocument>(recent(&"x".repeat(4097), json!(null)));
    accepts::<RecentDocument>(recent(&"x".repeat(4096), json!(null)));
    rejects::<RecentDocument>(recent("Thesis", json!("dir/main.tex")));
    accepts::<RecentDocument>(recent("Thesis", json!("main.pdf")));
    accepts::<RecentDocument>(recent("Thesis", json!("MAIN.PDF")));
    rejects::<RecentDocument>(recent("Thesis", json!("folder/main.pdf")));
    rejects::<RecentDocument>(recent("Thesis", json!("main.pdf:stream")));
    accepts::<RecentDocument>(recent("Thesis", json!("MAIN.TEX")));
    let entry = |len: usize| json!(format!("{}.tex", "a".repeat(len - 4)));
    accepts::<RecentDocument>(recent("Thesis", entry(4096)));
    rejects::<RecentDocument>(recent("Thesis", entry(4097)));
}

#[test]
fn recent_ids_are_exact_lowercase_uuid_v4() {
    let valid = "123e4567-e89b-42d3-a456-426614174000";
    let recent = |id: Value| json!({"id": id, "label": "Thesis", "entryPath": null, "openedAt": 1});
    let accepted = [
        valid,
        "00000000-0000-4000-8000-000000000000",
        "ffffffff-ffff-4fff-bfff-ffffffffffff",
        "123e4567-e89b-42d3-9456-426614174000",
        "123e4567-e89b-42d3-b456-426614174000",
    ];
    for id in accepted {
        round_trip::<RecentDocument>(recent(json!(id)));
    }
    let rejected = [
        "",
        "doc_1",
        "ws-1",
        "123E4567-E89B-42D3-A456-426614174000",
        "123e4567-e89b-42d3-A456-426614174000",
        "123e4567-e89b-12d3-a456-426614174000",
        "123e4567-e89b-52d3-a456-426614174000",
        "123e4567-e89b-42d3-c456-426614174000",
        "123e4567-e89b-42d3-7456-426614174000",
        "123e4567-e89b-42d3-a456-42661417400",
        "123e4567-e89b-42d3-a456-4266141740000",
        " 123e4567-e89b-42d3-a456-426614174000",
        "123e4567-e89b-42d3-a456-426614174000 ",
        "123e4567-e89b-42d3-a456-426614174000\n",
        "123e4567e89b42d3a456426614174000",
        "{123e4567-e89b-42d3-a456-426614174000}",
        "123e4567-e89b-42d3-a456-42661417400g",
        "123e4567_e89b_42d3_a456_426614174000",
        "123e4567-e89b-42d3-a456-42661417400é",
    ];
    for id in rejected {
        rejects::<RecentDocument>(recent(json!(id)));
        rejects::<RecentId>(json!(id));
    }
    rejects::<RecentId>(json!(5));
    rejects::<RecentId>(json!(null));
    let id = RecentId::parse(valid).expect("valid UUID v4");
    assert_eq!(id.as_str(), valid);
    assert_eq!(to_value(&id).expect("serialize"), json!(valid));
    assert!(RecentId::parse("doc_1").is_err());
}

#[test]
fn image_signature_size_and_extension_are_enforced() {
    assert_eq!(image_type(&png(12)), Ok(ImageType::Png));
    assert_eq!(image_type(&jpeg()), Ok(ImageType::Jpeg));
    assert!(image_type(&png(11)).is_err());
    assert!(image_type(&png(IMAGE_BYTES_LIMIT)).is_ok());
    assert!(image_type(&png(IMAGE_BYTES_LIMIT + 1)).is_err());
    assert!(image_type(&[255, 216, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0]).is_err());
    assert!(image_type(&[0; 16]).is_err());
    assert!(validate_image_file("a.PNG", &png(12)).is_ok());
    assert!(validate_image_file("a.jpeg", &jpeg()).is_ok());
    assert!(validate_image_file("a.jpg", &png(12)).is_err());
    assert!(validate_image_file("a.png", &jpeg()).is_err());
}

#[test]
fn image_batches_are_validated() {
    let image = |path: &str, bytes: Vec<u8>| json!({"path": path, "bytes": bytes});
    accepts::<SaveAsRequest>(save_as(json!([image(
        "modutex-image-0a1b-2c.PNG",
        png(12)
    )])));
    rejects::<SaveAsRequest>(save_as(json!([image("photo.png", png(12))])));
    rejects::<SaveAsRequest>(save_as(json!([
        image("modutex-image-aa.png", png(12)),
        image("modutex-image-AA.png", png(12)),
    ])));
    rejects::<SaveAsRequest>(save_as(json!([image("modutex-image-aa.jpg", png(12))])));
    rejects::<SaveAsRequest>(save_as(json!([image("modutex-image-aa.png", jpeg())])));
    rejects::<SaveAsRequest>(save_as(json!([image("modutex-image-aa.png", vec![1])])));
    rejects::<SaveAsRequest>(save_as(json!(null)));
    let mut absent = save_as(json!([]));
    absent.as_object_mut().expect("object").remove("images");
    assert!(accepts::<SaveAsRequest>(absent).images.is_none());
}

#[test]
fn image_batch_count_and_aggregate_limits() {
    let entry = |name: String, bytes: Vec<u8>| ManagedImage {
        path: RelativePath::parse(&name).expect("path"),
        bytes,
    };
    let tiny = |count: usize| {
        (0..count)
            .map(|i| entry(format!("modutex-image-{i:x}.png"), png(12)))
            .collect::<Vec<_>>()
    };
    assert!(ImageBatch::new(tiny(MAX_IMAGES)).is_ok());
    assert!(ImageBatch::new(tiny(MAX_IMAGES + 1)).is_err());
    let large = |count: usize| {
        (0..count)
            .map(|i| entry(format!("modutex-image-{i}.png"), png(IMAGE_BYTES_LIMIT)))
            .collect::<Vec<_>>()
    };
    assert!(ImageBatch::new(large(6)).is_ok());
    assert!(ImageBatch::new(large(7)).is_err());
}

#[test]
fn identities_round_trip_unchanged() {
    round_trip::<FileRef>(json!({"workspaceId": "ws-1", "path": "chapters/one.tex"}));
    round_trip::<RecentDocument>(json!({"id": "123e4567-e89b-42d3-a456-426614174000",
            "label": "Thesis", "entryPath": "main.tex", "openedAt": 1_760_000_000_000u64}));
    round_trip::<FileEntry>(json!({"path": "figs", "kind": "directory"}));
    round_trip::<ReadReceipt>(json!({"workspaceId": "ws-1", "path": "main.tex",
            "bytes": [0, 255], "revision": "sha256:abc", "documentId": null,
            "documentVersion": null}));
    round_trip::<ReadReceipt>(json!({"workspaceId": "ws-1", "path": "main.tex",
            "bytes": [0, 255], "revision": "sha256:abc", "documentId": "doc_1",
            "documentVersion": 3}));
    rejects::<ReadReceipt>(json!({"workspaceId": "ws-1", "path": "main.tex",
            "bytes": [0, 255], "revision": "sha256:abc", "documentId": "doc_1",
            "documentVersion": null}));
    rejects::<ReadReceipt>(json!({"workspaceId": "ws-1", "path": "main.tex",
            "bytes": [0, 255], "revision": "sha256:abc", "documentId": null,
            "documentVersion": 3}));
    round_trip::<WriteRequest>(write_request());
    round_trip::<WriteReceipt>(json!({"workspaceId": "ws-1", "path": "main.tex",
            "revision": "rev:2", "documentId": "doc_1", "documentVersion": 3}));
    round_trip::<SaveAsRequest>(json!({
            "images": [
                {"path": "modutex-image-0a1b-2c.png", "bytes": png(12)},
                {"path": "modutex-image-ab-1.jpg", "bytes": jpeg()}
            ],
            "workspaceId": "ws-1", "bytes": [1], "documentId": "doc_1", "documentVersion": 1}));
    round_trip::<SaveAsReceipt>(json!({
            "workspace": {"id": "ws-2", "label": "New", "entryPath": "main.tex"},
            "write": {"workspaceId": "ws-2", "path": "main.tex", "revision": "r1",
                "documentId": "doc_1", "documentVersion": 1}}));
    round_trip::<FileEvent>(json!({"workspaceId": "ws-1", "path": "a.tex", "kind": "removed"}));
    round_trip::<FileWatchFailure>(json!("TREE_TOO_DEEP"));
    round_trip::<CompileIdentity>(identity());
    round_trip::<CompileRequest>(compile_request());
    round_trip::<CompileResult>(success());
    round_trip::<CompileResult>(failure());
    let mut cancelled = failure();
    cancelled["status"] = json!("cancelled");
    round_trip::<CompileResult>(cancelled);
    match accepts::<CompileResult>(success()) {
        CompileResult::Success { identity, pdf, .. } => {
            assert_eq!(identity.run_id.as_str(), "run-1");
            assert_eq!(identity.document_version.get(), 3);
            assert_eq!(pdf, b"%PDF-1");
        }
        other => panic!("unexpected {other:?}"),
    }
}

#[test]
fn owner_comes_from_trusted_label_and_reports_host_health() {
    assert!(OwnerId::from_label("a/b").is_err());
    assert!(OwnerId::from_label("").is_err());
    let owner = OwnerId::from_label("main").expect("main");
    assert_eq!(
        to_value(HostHealth::for_owner(&owner)).expect("serialize"),
        json!({"protocolVersion": 1, "hostVersion": env!("CARGO_PKG_VERSION"), "owner": "main"})
    );
}
