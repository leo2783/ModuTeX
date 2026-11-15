// SPDX-License-Identifier: Apache-2.0
//! Staged LuaLaTeX/Biber/BibTeX compilation pipeline and bounded process/file I/O.

use std::{
    ffi::OsString,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    thread,
    time::{Duration, Instant},
};

use crate::{
    platform::process_tree::{
        CancellationToken, CleanupProof, ProcessError, ProcessErrorKind, ProcessLogs,
        ProcessOutput, ProcessSpec,
    },
    schemas::{
        draft::{DraftExtractionRecord, DraftGeometry},
        protocol::{validate_pdf, FileKind, RunId, MAX_LOG_CHARACTERS, MAX_PDF_BYTES},
    },
    services::filesystem::CompileInputSnapshot,
    shared::relative_path::RelativePath,
};

use super::{
    exports::{
        collect_workspace_images, parse_aux_exports, sanitize_log, valid_geometry, valid_page,
    },
    toolchain::{CompileArtifact, CompileFailure, TempTree, ToolFailure, Toolchain},
    Inner, DRAFT_TIMEOUT, LUA_SHIPOUT_RESOURCE, MAX_AUX_BYTES, MAX_BBL_BYTES, MAX_EXTRACTED_PAGES,
    MAX_EXTRACTED_RECORDS, MAX_EXTRACTION_BYTES, MAX_FLS_BYTES, MAX_PASSES, PROCESS_LOG_LIMIT,
};

pub(super) fn compile_staged(
    inner: &Inner,
    run_id: &RunId,
    entry_path: &RelativePath,
    snapshot: &CompileInputSnapshot,
    token: &CancellationToken,
    started: Instant,
) -> Result<CompileArtifact, CompileFailure> {
    let Some(toolchain) = inner.toolchain.as_ref() else {
        return Err(CompileFailure {
            message: "LuaLaTeX is unavailable. Install a TeX distribution that includes LuaLaTeX, or add its trusted executable directory to the desktop host PATH.".to_owned(),
            kind: None,
            log: String::new(),
            cleanup_proven: true,
            passes: 0,
            bibliography_passes: 0,
        });
    };
    let mut tree =
        TempTree::create(&inner.scratch_root, run_id).map_err(|error| CompileFailure {
            message: error.message,
            kind: None,
            log: String::new(),
            cleanup_proven: true,
            passes: 0,
            bibliography_passes: 0,
        })?;
    let result = compile_in_tree(
        toolchain, &tree.path, run_id, entry_path, snapshot, token, started,
    );
    let cleanup = tree.cleanup();
    match (result, cleanup) {
        (Ok(artifact), Ok(())) => Ok(artifact),
        (Err(mut failure), Err(_)) => {
            failure
                .message
                .push_str(" Private Draft work cleanup also failed.");
            failure.cleanup_proven = false;
            Err(failure)
        }
        (Err(failure), Ok(())) => Err(failure),
        (Ok(_), Err(error)) => Err(CompileFailure {
            message: error.message,
            kind: None,
            log: String::new(),
            cleanup_proven: false,
            passes: 0,
            bibliography_passes: 0,
        }),
    }
}

pub(super) fn compile_in_tree(
    toolchain: &Toolchain,
    root: &Path,
    run_id: &RunId,
    entry_path: &RelativePath,
    snapshot: &CompileInputSnapshot,
    token: &CancellationToken,
    started: Instant,
) -> Result<CompileArtifact, CompileFailure> {
    stage_snapshot(root, snapshot).map_err(|message| CompileFailure {
        message,
        kind: None,
        log: String::new(),
        cleanup_proven: true,
        passes: 0,
        bibliography_passes: 0,
    })?;

    let jobname = format!("modutex-draft-{}", run_id.as_str());
    let runtime_dir_name = format!(".modutex-draft-runtime-{}", run_id.as_str());
    let runtime_dir = root.join(&runtime_dir_name);
    fs::create_dir(&runtime_dir).map_err(|_| CompileFailure {
        message: "Could not create the private Draft Lua resource directory.".to_owned(),
        kind: None,
        log: String::new(),
        cleanup_proven: true,
        passes: 0,
        bibliography_passes: 0,
    })?;
    write_new_file(
        &runtime_dir.join("modutex-draft.lua"),
        LUA_SHIPOUT_RESOURCE.as_bytes(),
    )
    .map_err(|_| CompileFailure {
        message: "Could not materialize the packaged Draft shipout extractor.".to_owned(),
        kind: None,
        log: String::new(),
        cleanup_proven: true,
        passes: 0,
        bibliography_passes: 0,
    })?;

    let deadline = started.checked_add(DRAFT_TIMEOUT).unwrap_or(started);
    let mut log = String::new();
    let mut passes = 0u8;
    let mut bibliography_passes = 0u8;
    run_latex_pass(
        toolchain,
        root,
        entry_path,
        &jobname,
        &runtime_dir_name,
        token,
        deadline,
        &mut log,
    )
    .map_err(|failure| {
        passes = 1;
        compile_failure(
            "LuaLaTeX did not complete the first pass.",
            failure,
            &log,
            passes,
            0,
        )
    })?;
    passes = 1;

    let bcf_path = root.join(format!("{jobname}.bcf"));
    let aux_path = root.join(format!("{jobname}.aux"));
    if bcf_path.is_file() {
        let Some(biber) = toolchain.biber.as_ref() else {
            return Err(CompileFailure {
                message: "This document requires Biber, but no trusted biber.exe was found beside LuaLaTeX or on the host PATH.".to_owned(),
                kind: None,
                log,
                cleanup_proven: true,
                passes,
                bibliography_passes,
            });
        };
        run_bibliography_tool(biber, &jobname, root, token, deadline, &mut log, "Biber").map_err(
            |failure| {
                compile_failure(
                    "Biber did not complete the bibliography pass.",
                    failure,
                    &log,
                    passes,
                    bibliography_passes,
                )
            },
        )?;
        bibliography_passes = 1;
    } else if read_optional_text(&aux_path, MAX_AUX_BYTES)
        .ok()
        .flatten()
        .is_some_and(|aux| aux.contains("\\bibdata"))
    {
        let Some(bibtex) = toolchain.bibtex.as_ref() else {
            return Err(CompileFailure {
                message: "This document requires BibTeX, but no trusted bibtex.exe was found beside LuaLaTeX or on the host PATH.".to_owned(),
                kind: None,
                log,
                cleanup_proven: true,
                passes,
                bibliography_passes,
            });
        };
        run_bibliography_tool(bibtex, &jobname, root, token, deadline, &mut log, "BibTeX")
            .map_err(|failure| {
                compile_failure(
                    "BibTeX did not complete the bibliography pass.",
                    failure,
                    &log,
                    passes,
                    bibliography_passes,
                )
            })?;
        bibliography_passes = 1;
    }

    let minimum_passes = if bibliography_passes > 0 { 3 } else { 2 };
    let mut previous_aux = read_optional_bytes(&aux_path, MAX_AUX_BYTES).ok().flatten();
    while passes < MAX_PASSES {
        if token.is_cancelled() {
            return Err(CompileFailure {
                message: "Draft compilation was cancelled.".to_owned(),
                kind: Some(ProcessErrorKind::Cancelled),
                log,
                cleanup_proven: true,
                passes,
                bibliography_passes,
            });
        }
        run_latex_pass(
            toolchain,
            root,
            entry_path,
            &jobname,
            &runtime_dir_name,
            token,
            deadline,
            &mut log,
        )
        .map_err(|failure| {
            compile_failure(
                "LuaLaTeX did not complete a reference pass.",
                failure,
                &log,
                passes.saturating_add(1),
                bibliography_passes,
            )
        })?;
        passes = passes.saturating_add(1);
        let current_aux = read_optional_bytes(&aux_path, MAX_AUX_BYTES).ok().flatten();
        let changed = current_aux != previous_aux;
        previous_aux = current_aux;
        let lower_log = log.to_ascii_lowercase();
        let requested_rerun = lower_log.contains("rerun to get cross-references")
            || lower_log.contains("please (re)run");
        if passes >= minimum_passes && !changed && !requested_rerun {
            break;
        }
    }
    if token.is_cancelled() {
        return Err(CompileFailure {
            message: "Draft compilation was cancelled.".to_owned(),
            kind: Some(ProcessErrorKind::Cancelled),
            log,
            cleanup_proven: true,
            passes,
            bibliography_passes,
        });
    }

    let pdf_path = root.join(format!("{jobname}.pdf"));
    let pdf = read_bounded_file(&pdf_path, MAX_PDF_BYTES).map_err(|_| CompileFailure {
        message: "LuaLaTeX did not produce a readable PDF within the 32 MiB limit.".to_owned(),
        kind: None,
        log: log.clone(),
        cleanup_proven: true,
        passes,
        bibliography_passes,
    })?;
    validate_pdf(&pdf).map_err(|_| CompileFailure {
        message: "LuaLaTeX produced an invalid PDF header.".to_owned(),
        kind: None,
        log: log.clone(),
        cleanup_proven: true,
        passes,
        bibliography_passes,
    })?;

    let mut geometry = DraftGeometry::default();
    let mut pages = Vec::new();
    let extraction_path = root.join(format!("{jobname}.draft.json"));
    let mut unsupported = Vec::new();
    match read_bounded_file(&extraction_path, MAX_EXTRACTION_BYTES)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<DraftExtractionRecord>(&bytes).ok())
    {
        Some(extraction) => {
            geometry = extraction.geometry;
            pages = extraction.pages;
            if pages.len() > MAX_EXTRACTED_PAGES
                || pages
                    .iter()
                    .map(|page| page.renderable_records.len())
                    .sum::<usize>()
                    > MAX_EXTRACTED_RECORDS
                || !valid_geometry(&geometry)
                || pages.iter().any(|page| !valid_page(page))
            {
                pages.clear();
                geometry = DraftGeometry::default();
                unsupported.push("shipout-record-limits-or-invalid-metrics".to_owned());
            }
        }
        None => unsupported.push("shipout-records-unavailable".to_owned()),
    }

    let aux = read_optional_text(&aux_path, MAX_AUX_BYTES)
        .ok()
        .flatten()
        .unwrap_or_default();
    let bbl = read_optional_text(&root.join(format!("{jobname}.bbl")), MAX_BBL_BYTES)
        .ok()
        .flatten()
        .unwrap_or_default();
    let (references, bibliography) = parse_aux_exports(&aux, &bbl);
    let images = read_optional_text(&root.join(format!("{jobname}.fls")), MAX_FLS_BYTES)
        .ok()
        .flatten()
        .map(|fls| collect_workspace_images(root, &fls))
        .unwrap_or_default();
    let log = sanitize_log(&log, root, &toolchain.lualatex);
    Ok(CompileArtifact {
        pdf,
        geometry,
        pages,
        references,
        bibliography,
        images,
        unsupported,
        log,
        passes,
        bibliography_passes,
    })
}

pub(super) fn stage_snapshot(root: &Path, snapshot: &CompileInputSnapshot) -> Result<(), String> {
    for entry in &snapshot.entries {
        if entry.kind == FileKind::Directory {
            let path = join_relative(root, entry.path.as_str());
            fs::create_dir_all(path).map_err(|_| {
                "Could not materialize a validated workspace directory for Draft.".to_owned()
            })?;
        }
    }
    for file in &snapshot.files {
        if file.bytes.len() > 32 * 1024 * 1024 {
            return Err("A Draft input file exceeds the 32 MiB per-file limit.".to_owned());
        }
        let path = join_relative(root, file.path.as_str());
        let parent = path
            .parent()
            .ok_or_else(|| "A validated Draft input has no parent directory.".to_owned())?;
        fs::create_dir_all(parent)
            .map_err(|_| "Could not create a private directory for Draft input.".to_owned())?;
        write_new_file(&path, &file.bytes).map_err(|_| {
            "Could not copy a validated workspace file into the private Draft snapshot.".to_owned()
        })?;
    }
    Ok(())
}

pub(super) fn join_relative(root: &Path, relative: &str) -> PathBuf {
    let mut output = root.to_path_buf();
    for segment in relative.split('/') {
        output.push(segment);
    }
    output
}

pub(super) fn write_new_file(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut file = OpenOptions::new().write(true).create_new(true).open(path)?;
    file.write_all(bytes)
}

#[expect(
    clippy::too_many_arguments,
    reason = "Keep the validated per-run inputs explicit at the LuaLaTeX pass boundary."
)]
pub(super) fn run_latex_pass(
    toolchain: &Toolchain,
    root: &Path,
    entry_path: &RelativePath,
    jobname: &str,
    runtime_dir: &str,
    token: &CancellationToken,
    deadline: Instant,
    log: &mut String,
) -> Result<(), ToolFailure> {
    let arguments = vec![
        OsString::from("-no-shell-escape"),
        OsString::from("-halt-on-error"),
        OsString::from("-interaction=nonstopmode"),
        OsString::from("-file-line-error"),
        OsString::from("-recorder"),
        OsString::from(format!("-jobname={jobname}")),
        OsString::from(format!("-output-directory={}", root.display())),
        OsString::from(format!("--lua={runtime_dir}/modutex-draft.lua")),
        OsString::from(format!("./{}", entry_path.as_str())),
    ];
    let output = run_tool(&toolchain.lualatex, root, arguments, token, deadline)?;
    append_process_logs(log, &output.logs);
    if output.active_processes_after_exit != 0 || output.exit_code != 0 {
        return Err(ToolFailure {
            kind: ProcessErrorKind::JobQueryFailure,
            exit_code: Some(output.exit_code),
            log: log.clone(),
            cleanup_proven: false,
        });
    }
    Ok(())
}

pub(super) fn run_bibliography_tool(
    executable: &Path,
    jobname: &str,
    root: &Path,
    token: &CancellationToken,
    deadline: Instant,
    log: &mut String,
    label: &str,
) -> Result<(), ToolFailure> {
    let output = run_tool(
        executable,
        root,
        vec![OsString::from(jobname)],
        token,
        deadline,
    )?;
    append_process_logs(log, &output.logs);
    if output.active_processes_after_exit != 0 || output.exit_code != 0 {
        return Err(ToolFailure {
            kind: ProcessErrorKind::JobQueryFailure,
            exit_code: Some(output.exit_code),
            log: format!("{label} exited without a verified process-tree drain."),
            cleanup_proven: false,
        });
    }
    Ok(())
}

pub(super) fn run_tool(
    executable: &Path,
    root: &Path,
    arguments: Vec<OsString>,
    token: &CancellationToken,
    deadline: Instant,
) -> Result<ProcessOutput, ToolFailure> {
    if token.is_cancelled() {
        return Err(ToolFailure {
            kind: ProcessErrorKind::Cancelled,
            exit_code: None,
            log: String::new(),
            cleanup_proven: true,
        });
    }
    let timeout = deadline.saturating_duration_since(Instant::now());
    if timeout.is_zero() {
        return Err(ToolFailure {
            kind: ProcessErrorKind::DeadlineExceeded,
            exit_code: None,
            log: String::new(),
            cleanup_proven: true,
        });
    }
    let environment = vec![
        (OsString::from("openin_any"), OsString::from("p")),
        (OsString::from("openout_any"), OsString::from("p")),
        (OsString::from("shell_escape"), OsString::from("f")),
        (
            OsString::from("TEXMFOUTPUT"),
            root.as_os_str().to_os_string(),
        ),
    ];
    let spec = ProcessSpec::new_with_environment(
        executable.to_path_buf(),
        root.to_path_buf(),
        arguments,
        environment,
        timeout,
        PROCESS_LOG_LIMIT,
    );
    match crate::platform::process_tree::run(&spec, token) {
        Ok(output) => Ok(output),
        Err(mut error) => Err(resolve_process_error(&mut error)),
    }
}

pub(super) fn resolve_process_error(error: &mut ProcessError) -> ToolFailure {
    let kind = error.cause.unwrap_or(error.kind);
    let exit_code = error.exit_code;
    let mut logs = error.logs.clone();
    let mut cleanup_proven = matches!(
        error.cleanup,
        CleanupProof::NotRequired | CleanupProof::JobDrained
    );
    if let Some(mut pending) = error.take_pending_cleanup() {
        loop {
            match pending.retry(Duration::from_millis(250)) {
                Ok(final_logs) => {
                    logs = final_logs;
                    cleanup_proven = true;
                    break;
                }
                Err(_) => thread::sleep(Duration::from_millis(100)),
            }
        }
    }
    ToolFailure {
        kind,
        exit_code,
        log: logs_to_text(&logs),
        cleanup_proven,
    }
}

pub(super) fn compile_failure(
    message: &str,
    failure: ToolFailure,
    current_log: &str,
    passes: u8,
    bibliography_passes: u8,
) -> CompileFailure {
    let mut log = current_log.to_owned();
    append_bounded(&mut log, &failure.log);
    let reason = match failure.kind {
        ProcessErrorKind::Cancelled => "Draft compilation was cancelled.",
        ProcessErrorKind::DeadlineExceeded => "The total Draft compilation deadline expired.",
        ProcessErrorKind::OutputLimitExceeded => "LuaLaTeX output exceeded its bounded log limit.",
        #[cfg(not(all(windows, target_arch = "x86_64")))]
        ProcessErrorKind::UnsupportedPlatform => {
            "Native Draft execution is supported only on Windows x64."
        }
        ProcessErrorKind::NonZeroExit => "The TeX tool exited with a nonzero status.",
        ProcessErrorKind::CleanupFailed => "Native process-tree cleanup could not be proven.",
        _ => message,
    };
    let detail = failure
        .exit_code
        .map(|code| format!("{reason} Exit code: {code}."))
        .unwrap_or_else(|| reason.to_owned());
    CompileFailure {
        message: detail,
        kind: Some(failure.kind),
        log,
        cleanup_proven: failure.cleanup_proven,
        passes,
        bibliography_passes,
    }
}

pub(super) fn append_process_logs(target: &mut String, logs: &ProcessLogs) {
    if !logs.stdout.is_empty() {
        append_bounded(target, &String::from_utf8_lossy(&logs.stdout));
    }
    if !logs.stderr.is_empty() {
        append_bounded(target, &String::from_utf8_lossy(&logs.stderr));
    }
}

pub(super) fn logs_to_text(logs: &ProcessLogs) -> String {
    let mut output = String::new();
    append_process_logs(&mut output, logs);
    output
}

pub(super) fn append_bounded(target: &mut String, source: &str) {
    let remaining = MAX_LOG_CHARACTERS.saturating_sub(target.chars().count());
    if remaining == 0 {
        return;
    }
    target.extend(source.chars().take(remaining));
}

pub(super) fn read_bounded_file(path: &Path, maximum: usize) -> std::io::Result<Vec<u8>> {
    let file = File::open(path)?;
    let mut limited = file.take(maximum as u64 + 1);
    let mut output = Vec::new();
    limited.read_to_end(&mut output)?;
    if output.len() > maximum {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "bounded Draft output exceeded its limit",
        ));
    }
    Ok(output)
}

pub(super) fn read_optional_bytes(path: &Path, maximum: usize) -> std::io::Result<Option<Vec<u8>>> {
    match read_bounded_file(path, maximum) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

pub(super) fn read_optional_text(path: &Path, maximum: usize) -> std::io::Result<Option<String>> {
    read_optional_bytes(path, maximum)
        .map(|bytes| bytes.map(|bytes| String::from_utf8_lossy(&bytes).into_owned()))
}
