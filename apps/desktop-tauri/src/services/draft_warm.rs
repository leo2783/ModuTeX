// SPDX-License-Identifier: Apache-2.0
//! Persistent, bounded LuaLaTeX Draft paragraph engine.
//!
//! The renderer's TeX is never fed to the warm process. The warm subset is a
//! whole UTF-8 document body containing literal text only; TeX metacharacters,
//! comments, math, commands, and control characters route to the existing full
//! compiler. The host turns accepted characters into trusted `\char` tokens.
//! The request group only scopes the host-created box; it is not presented as
//! isolation for arbitrary TeX assignments.

use std::{
    ffi::OsString,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    panic::{catch_unwind, AssertUnwindSafe},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard, PoisonError},
    time::{Duration, Instant},
};

use crate::{
    platform::process_tree::{
        cancellation_pair, CancellationToken, ProcessSession, ProcessSpec,
        PROCESS_SESSION_MAX_INPUT_BYTES,
    },
    schemas::draft::DraftExtractionRecord,
    schemas::protocol::{FileKind, RunId},
    services::filesystem::CompileInputSnapshot,
    shared::relative_path::RelativePath,
};

const MAX_BODY_BYTES: usize = 32 * 1024;
const MAX_TEX_BODY_BYTES: usize = 512 * 1024;
const MAX_AUX_BYTES: usize = 4 * 1024 * 1024;
const MAX_BBL_BYTES: usize = 4 * 1024 * 1024;
const MAX_FLS_BYTES: usize = 8 * 1024 * 1024;
const MAX_EXTRACTION_BYTES: usize = 16 * 1024 * 1024;
const MAX_LOG_BYTES: usize = 2 * 1024 * 1024;

pub(crate) struct DraftWarmStartError {
    pub(crate) detail: String,
    pub(crate) pending: Option<Box<DraftWarmEngine>>,
}

pub(crate) struct DraftWarmFrame {
    pub(crate) extraction: DraftExtractionRecord,
    pub(crate) aux: Vec<u8>,
    pub(crate) bbl: Vec<u8>,
    pub(crate) fls: Vec<u8>,
    pub(crate) log: String,
}

struct PrivateTree {
    path: PathBuf,
    armed: bool,
}

impl PrivateTree {
    fn create(root: &Path, run_id: &RunId) -> Result<Self, String> {
        if !root.is_absolute() {
            return Err("Draft warm cache root is not absolute.".to_owned());
        }
        let requested = root.join(format!("warm-{}", run_id.as_str()));
        fs::create_dir(&requested)
            .map_err(|error| format!("Could not create the private Draft warm tree: {error}"))?;
        let path = match fs::canonicalize(&requested) {
            Ok(path) if path.is_absolute() => path,
            Ok(_) => {
                let _ = fs::remove_dir_all(&requested);
                return Err("Private Draft warm tree is not absolute.".to_owned());
            }
            Err(error) => {
                let _ = fs::remove_dir_all(&requested);
                return Err(format!(
                    "Could not verify the private Draft warm tree: {error}"
                ));
            }
        };
        Ok(Self { path, armed: false })
    }
}

impl Drop for PrivateTree {
    fn drop(&mut self) {
        if !self.armed {
            let _ = fs::remove_dir_all(&self.path);
        }
    }
}

type DrainCallback = Box<dyn FnOnce() + Send + 'static>;

#[derive(Default)]
struct DrainCallbacks {
    drained: bool,
    callbacks: Vec<DrainCallback>,
}

fn lock_callbacks(value: &Mutex<DrainCallbacks>) -> MutexGuard<'_, DrainCallbacks> {
    value.lock().unwrap_or_else(PoisonError::into_inner)
}

fn run_drain_callbacks(callbacks: &Arc<Mutex<DrainCallbacks>>) {
    let pending = {
        let mut state = lock_callbacks(callbacks);
        state.drained = true;
        std::mem::take(&mut state.callbacks)
    };
    for callback in pending {
        let _ = catch_unwind(AssertUnwindSafe(callback));
    }
}

pub(crate) struct DraftWarmEngine {
    session: ProcessSession,
    root: PathBuf,
    jobname: String,
    fingerprint: Vec<u8>,
    callbacks: Arc<Mutex<DrainCallbacks>>,
    poisoned: bool,
}

impl DraftWarmEngine {
    /// Returns the complete safe document body, not just the edited range.
    /// This avoids silently applying paragraph text in the wrong TeX context.
    pub(crate) fn safe_document_body(bytes: &[u8]) -> Option<String> {
        if bytes.len() > MAX_BODY_BYTES {
            return None;
        }
        let source = std::str::from_utf8(bytes).ok()?;
        let (_, _, body_start) = marker_line(bytes, b"\\begin{document}", 0)?;
        let (end_start, _, after_end) = marker_line(bytes, b"\\end{document}", body_start)?;
        if !bytes[after_end..].iter().all(u8::is_ascii_whitespace) {
            return None;
        }
        let body = source.get(body_start..end_start)?;
        if body.len() > MAX_BODY_BYTES
            || body.chars().any(|character| {
                matches!(
                    character,
                    '\\' | '{' | '}' | '$' | '%' | '&' | '#' | '_' | '^' | '~'
                ) || (character.is_control() && !matches!(character, '\r' | '\n' | '\t'))
            })
        {
            return None;
        }
        Some(body.to_owned())
    }

    pub(crate) fn start(
        executable: &Path,
        scratch_root: &Path,
        run_id: &RunId,
        entry_path: &RelativePath,
        snapshot: &CompileInputSnapshot,
        cancellation: &CancellationToken,
        timeout: Duration,
    ) -> Result<Self, DraftWarmStartError> {
        let fail = |detail: String| DraftWarmStartError {
            detail,
            pending: None,
        };
        if cancellation.is_cancelled() {
            return Err(fail("Draft warm startup was cancelled.".to_owned()));
        }
        if timeout.is_zero() {
            return Err(fail(
                "Draft warm startup timeout must be nonzero.".to_owned(),
            ));
        }
        let deadline = Instant::now()
            .checked_add(timeout)
            .ok_or_else(|| fail("Draft warm startup deadline overflowed.".to_owned()))?;
        let main = snapshot
            .files
            .iter()
            .find(|file| file.path == *entry_path)
            .ok_or_else(|| fail("Draft warm entry is missing.".to_owned()))?;
        let prefix_end = find_preamble_end(&main.bytes).ok_or_else(|| {
            fail("Draft warm requires a standalone document preamble.".to_owned())
        })?;
        let fingerprint = warm_fingerprint(snapshot, entry_path)
            .ok_or_else(|| fail("Draft warm preamble is unsupported.".to_owned()))?;

        let mut tree = PrivateTree::create(scratch_root, run_id).map_err(fail)?;
        let jobname = format!("modutex-draft-warm-{}", run_id.as_str());
        let runtime_name = format!(".modutex-draft-warm-runtime-{}", run_id.as_str());
        let input_name = format!(".modutex-draft-warm-input-{}.tex", run_id.as_str());
        let prepared = (|| -> Result<(), String> {
            stage_snapshot(&tree.path, snapshot)?;
            let runtime = tree.path.join(&runtime_name);
            fs::create_dir(&runtime)
                .map_err(|error| format!("Could not create the private Lua directory: {error}"))?;
            let mut lua = String::with_capacity(
                include_str!("../resources/draft/modutex-draft.lua").len()
                    + include_str!("../resources/draft/modutex-draft-warm.lua").len(),
            );
            lua.push_str(include_str!("../resources/draft/modutex-draft.lua"));
            lua.push_str(include_str!("../resources/draft/modutex-draft-warm.lua"));
            write_new_file(&runtime.join("modutex-draft.lua"), lua.as_bytes())?;

            let mut boot = Vec::with_capacity(prefix_end.saturating_add(192));
            boot.extend_from_slice(&main.bytes[..prefix_end]);
            boot.extend_from_slice(
                b"\n\\begin{document}\n\\newbox\\modutexdraftwarmbox\n\
              \\directlua{modutex_draft_warm_start()}\n",
            );
            write_new_file(&tree.path.join(&input_name), &boot)
        })();
        if let Err(detail) = prepared {
            return Err(fail(detail));
        }

        let spec_timeout = deadline.saturating_duration_since(Instant::now());
        if spec_timeout.is_zero() {
            return Err(fail(
                "Draft warm startup deadline expired before spawn.".to_owned(),
            ));
        }
        let environment = vec![
            (OsString::from("openin_any"), OsString::from("p")),
            (OsString::from("openout_any"), OsString::from("p")),
            (OsString::from("shell_escape"), OsString::from("f")),
            (
                OsString::from("TEXMFOUTPUT"),
                tree.path.as_os_str().to_os_string(),
            ),
        ];
        let spec = ProcessSpec::new(
            executable.to_path_buf(),
            tree.path.clone(),
            vec![
                OsString::from("-no-shell-escape"),
                OsString::from("-halt-on-error"),
                OsString::from("-interaction=nonstopmode"),
                OsString::from("-file-line-error"),
                OsString::from("-recorder"),
                OsString::from(format!("-jobname={jobname}")),
                OsString::from(format!("-output-directory={}", tree.path.display())),
                OsString::from(format!("--lua={runtime_name}/modutex-draft.lua")),
                OsString::from(input_name),
            ],
            spec_timeout,
            MAX_LOG_BYTES,
        )
        .with_environment(environment);

        // Arm before spawn: unwinding after CreateProcessW must never delete
        // files still reachable by a live or supervised child.
        tree.armed = true;
        let session = match ProcessSession::start(&spec, cancellation) {
            Ok(session) => session,
            Err(mut failure) => {
                let detail = failure.error.to_string();
                if let Some(session) = failure.pending.take() {
                    let engine = Self::own(*session, &mut tree, jobname, fingerprint);
                    return Err(DraftWarmStartError {
                        detail,
                        pending: Some(Box::new(engine)),
                    });
                }
                tree.armed = false;
                return Err(fail(detail));
            }
        };
        let mut engine = Self::own(session, &mut tree, jobname, fingerprint);
        let ready_timeout = deadline.saturating_duration_since(Instant::now());
        if ready_timeout.is_zero() {
            engine.poisoned = true;
            return Err(engine.finish_start_failure(
                "Draft warm readiness deadline expired.".to_owned(),
                cancellation,
            ));
        }
        match engine
            .session
            .exchange(&[], b"MODUTEX_WARM_READY", cancellation, ready_timeout)
        {
            Ok(_) => Ok(engine),
            Err(error) => {
                engine.poisoned = true;
                Err(engine.finish_start_failure(error.detail, cancellation))
            }
        }
    }

    fn own(
        mut session: ProcessSession,
        tree: &mut PrivateTree,
        jobname: String,
        fingerprint: Vec<u8>,
    ) -> Self {
        let callbacks = Arc::new(Mutex::new(DrainCallbacks::default()));
        let callback_queue = Arc::clone(&callbacks);
        let cleanup_path = tree.path.clone();
        session.on_drained(move || {
            let _ = fs::remove_dir_all(cleanup_path);
            run_drain_callbacks(&callback_queue);
        });
        tree.armed = true;
        Self {
            session,
            root: tree.path.clone(),
            jobname,
            fingerprint,
            callbacks,
            poisoned: false,
        }
    }

    fn finish_start_failure(
        mut self,
        detail: String,
        cancellation: &CancellationToken,
    ) -> DraftWarmStartError {
        let (_, cleanup_token) = cancellation_pair();
        let token = if cancellation.is_cancelled() {
            &cleanup_token
        } else {
            cancellation
        };
        match self.stop(token, Duration::from_secs(10)) {
            Ok(()) => DraftWarmStartError {
                detail,
                pending: None,
            },
            Err(cleanup) if self.is_drained() => DraftWarmStartError {
                detail: format!("{detail}; {cleanup}"),
                pending: None,
            },
            Err(cleanup) => DraftWarmStartError {
                detail: format!("{detail}; cleanup remains owned: {cleanup}"),
                pending: Some(Box::new(self)),
            },
        }
    }

    pub(crate) fn matches(
        &self,
        snapshot: &CompileInputSnapshot,
        entry_path: &RelativePath,
    ) -> bool {
        warm_fingerprint(snapshot, entry_path)
            .is_some_and(|fingerprint| fingerprint == self.fingerprint)
    }

    pub(crate) fn is_usable(&self) -> bool {
        !self.poisoned && !self.session.is_drained() && self.session.pid() != 0
    }

    pub(crate) fn is_drained(&self) -> bool {
        self.session.is_drained()
    }

    pub(crate) fn root(&self) -> &Path {
        &self.root
    }

    /// Register request cleanup only after the process owner has reported a
    /// full drain. A callback registered after drain runs immediately.
    pub(crate) fn on_drained<F>(&mut self, callback: F)
    where
        F: FnOnce() + Send + 'static,
    {
        let mut callback: Option<DrainCallback> = Some(Box::new(callback));
        let immediate = {
            let mut state = lock_callbacks(&self.callbacks);
            if state.drained {
                true
            } else {
                state
                    .callbacks
                    .push(callback.take().expect("callback is present"));
                false
            }
        };
        if immediate {
            if let Some(callback) = callback {
                let _ = catch_unwind(AssertUnwindSafe(callback));
            }
        }
    }

    pub(crate) fn typeset(
        &mut self,
        run_id: &RunId,
        entry_path: &RelativePath,
        snapshot: &CompileInputSnapshot,
        body: &str,
        cancellation: &CancellationToken,
        timeout: Duration,
    ) -> Result<DraftWarmFrame, String> {
        let result = self.typeset_inner(run_id, entry_path, snapshot, body, cancellation, timeout);
        if result.is_err() {
            self.poisoned = true;
        }
        result
    }

    fn typeset_inner(
        &mut self,
        run_id: &RunId,
        entry_path: &RelativePath,
        snapshot: &CompileInputSnapshot,
        body: &str,
        cancellation: &CancellationToken,
        timeout: Duration,
    ) -> Result<DraftWarmFrame, String> {
        if self.poisoned || self.session.is_drained() {
            return Err("Draft warm process is not reusable.".to_owned());
        }
        if timeout.is_zero() || cancellation.is_cancelled() {
            return Err("Draft warm request was cancelled or expired.".to_owned());
        }
        if body.len() > MAX_BODY_BYTES
            || body.chars().any(|character| {
                matches!(
                    character,
                    '\\' | '{' | '}' | '$' | '%' | '&' | '#' | '_' | '^' | '~'
                ) || (character.is_control() && !matches!(character, '\r' | '\n' | '\t'))
            })
        {
            return Err("Paragraph is outside the safe warm-text subset.".to_owned());
        }
        let body_tex = plain_text_tex(body)?;
        let aux = baseline(snapshot, entry_path, "aux", MAX_AUX_BYTES)?.to_vec();
        let bbl = baseline(snapshot, entry_path, "bbl", MAX_BBL_BYTES)?.to_vec();
        let fls = baseline(snapshot, entry_path, "fls", MAX_FLS_BYTES)?.to_vec();
        let id = run_id.as_str();
        let stem = format!("{}.frame-{id}", self.jobname);
        let input_aux = self.root.join(format!("{stem}.aux"));
        let input_bbl = self.root.join(format!("{stem}.bbl"));
        let input_fls = self.root.join(format!("{stem}.fls"));
        let output_json = self.root.join(format!("{stem}.draft.json"));
        let output_aux = self.root.join(format!("{stem}.used.aux"));
        let output_bbl = self.root.join(format!("{stem}.used.bbl"));
        let output_fls = self.root.join(format!("{stem}.used.fls"));
        if output_json.exists() || output_aux.exists() || output_bbl.exists() || output_fls.exists()
        {
            return Err("Draft warm frame output already exists.".to_owned());
        }
        write_new_file(&input_aux, &aux)?;
        write_new_file(&input_bbl, &bbl)?;
        write_new_file(&input_fls, &fls)?;

        let line = format!(
            "{id}|{}|{}|{}|{}\n",
            hex_encode(body_tex.as_bytes()),
            hex_encode(&aux),
            hex_encode(&bbl),
            hex_encode(&fls),
        );
        if line.len() > PROCESS_SESSION_MAX_INPUT_BYTES {
            return Err("Draft warm request exceeds its native input limit.".to_owned());
        }
        let marker = format!("MODUTEX_FRAME_DONE_{id}");
        let reply = self
            .session
            .exchange(line.as_bytes(), marker.as_bytes(), cancellation, timeout)
            .map_err(|error| error.detail)?;

        let encoded = read_bounded(&output_json, MAX_EXTRACTION_BYTES)?;
        let used_aux = read_bounded(&output_aux, MAX_AUX_BYTES)?;
        let used_bbl = read_bounded(&output_bbl, MAX_BBL_BYTES)?;
        let used_fls = read_bounded(&output_fls, MAX_FLS_BYTES)?;
        if used_aux != aux || used_bbl != bbl || used_fls != fls {
            return Err("Draft warm child used another request's metadata baseline.".to_owned());
        }
        let extraction: DraftExtractionRecord = serde_json::from_slice(&encoded)
            .map_err(|error| format!("Draft warm extraction is invalid: {error}"))?;
        for path in [
            &input_aux,
            &input_bbl,
            &input_fls,
            &output_json,
            &output_aux,
            &output_bbl,
            &output_fls,
        ] {
            fs::remove_file(path)
                .map_err(|error| format!("Could not retire Draft warm frame data: {error}"))?;
        }
        let mut log_bytes = reply.stdout;
        let remaining = MAX_LOG_BYTES.saturating_sub(log_bytes.len());
        log_bytes.extend_from_slice(&reply.stderr[..reply.stderr.len().min(remaining)]);
        let log = String::from_utf8_lossy(&log_bytes).into_owned();
        Ok(DraftWarmFrame {
            extraction,
            aux: used_aux,
            bbl: used_bbl,
            fls: used_fls,
            log,
        })
    }

    /// A graceful stop is only a request. The process session owns all native
    /// resources until it verifies job drain, reader joins, and handle closure.
    pub(crate) fn stop(
        &mut self,
        cancellation: &CancellationToken,
        timeout: Duration,
    ) -> Result<(), String> {
        if timeout.is_zero() {
            return Err("Draft warm cleanup timeout must be nonzero.".to_owned());
        }
        if self.session.is_drained() {
            return Ok(());
        }
        if !self.poisoned && !cancellation.is_cancelled() {
            let _ = self.session.exchange(
                b"QUIT\n",
                b"MODUTEX_WARM_STOP",
                cancellation,
                timeout.min(Duration::from_secs(5)),
            );
        }
        self.poisoned = true;
        self.session.stop(timeout)?;
        if self.session.is_drained() {
            Ok(())
        } else {
            Err("Draft warm process drain was not verified.".to_owned())
        }
    }
}

fn marker_line(bytes: &[u8], marker: &[u8], from: usize) -> Option<(usize, usize, usize)> {
    let mut line_start = from;
    while line_start <= bytes.len() {
        let line_end = bytes[line_start..]
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(bytes.len(), |offset| line_start + offset);
        let content_end = if line_end > line_start && bytes[line_end - 1] == b'\r' {
            line_end - 1
        } else {
            line_end
        };
        let mut first = line_start;
        let mut last = content_end;
        while first < last && matches!(bytes[first], b' ' | b'\t') {
            first += 1;
        }
        while last > first && matches!(bytes[last - 1], b' ' | b'\t') {
            last -= 1;
        }
        if &bytes[first..last] == marker {
            let next_line = if line_end < bytes.len() {
                line_end + 1
            } else {
                line_end
            };
            return Some((first, last, next_line));
        }
        if line_end == bytes.len() {
            break;
        }
        line_start = line_end + 1;
    }
    None
}

fn find_preamble_end(bytes: &[u8]) -> Option<usize> {
    // The warm boot supplies the document-begin marker itself.
    marker_line(bytes, b"\\begin{document}", 0).map(|(begin, _, _)| begin)
}

fn plain_text_tex(source: &str) -> Result<String, String> {
    let mut output = String::with_capacity(source.len().saturating_mul(8));
    let mut characters = source.chars().peekable();
    while let Some(character) = characters.next() {
        if matches!(character, '\r' | '\n') {
            let mut breaks = 1usize;
            if character == '\r' && characters.peek() == Some(&'\n') {
                characters.next();
            }
            while matches!(characters.peek(), Some('\r' | '\n')) {
                let next = characters.next().expect("peeked line break");
                if next == '\r' && characters.peek() == Some(&'\n') {
                    characters.next();
                }
                breaks = breaks.saturating_add(1);
            }
            if breaks == 1 {
                output.push_str("\\char32 ");
            } else {
                output.push_str("\\par ");
            }
        } else if character == '\t' || character == ' ' {
            output.push_str("\\char32 ");
        } else {
            if matches!(
                character,
                '\\' | '{' | '}' | '$' | '%' | '&' | '#' | '_' | '^' | '~'
            ) || character.is_control()
            {
                return Err("Paragraph is outside the safe warm-text subset.".to_owned());
            }
            output.push_str("\\char");
            output.push_str(&(character as u32).to_string());
            output.push(' ');
        }
        if output.len() > MAX_TEX_BODY_BYTES {
            return Err("Draft warm text expansion exceeds its limit.".to_owned());
        }
    }
    Ok(output)
}

fn sibling(entry: &RelativePath, extension: &str) -> String {
    let stem = entry
        .as_str()
        .rsplit_once('.')
        .map_or(entry.as_str(), |(stem, _)| stem);
    format!("{stem}.{extension}")
}

fn baseline<'a>(
    snapshot: &'a CompileInputSnapshot,
    entry: &RelativePath,
    extension: &str,
    maximum: usize,
) -> Result<&'a [u8], String> {
    let path = sibling(entry, extension);
    let bytes = snapshot
        .files
        .iter()
        .find(|file| file.path.as_str() == path)
        .map_or(&[][..], |file| file.bytes.as_slice());
    if bytes.len() > maximum {
        return Err(format!(
            "Draft warm {extension} baseline exceeds its limit."
        ));
    }
    Ok(bytes)
}

fn warm_fingerprint(snapshot: &CompileInputSnapshot, entry: &RelativePath) -> Option<Vec<u8>> {
    let main = snapshot.files.iter().find(|file| file.path == *entry)?;
    let prefix_end = find_preamble_end(&main.bytes)?;
    let dynamic = [
        sibling(entry, "aux"),
        sibling(entry, "bbl"),
        sibling(entry, "fls"),
        sibling(entry, "log"),
    ];
    let mut key = Vec::new();
    append_blob(&mut key, entry.as_str().as_bytes());
    append_blob(&mut key, &main.bytes[..prefix_end]);
    for item in &snapshot.entries {
        if item.path == *entry || dynamic.iter().any(|path| path == item.path.as_str()) {
            continue;
        }
        append_blob(&mut key, item.path.as_str().as_bytes());
        key.push(if item.kind == FileKind::File { 1 } else { 2 });
    }
    for file in &snapshot.files {
        if file.path == *entry || dynamic.iter().any(|path| path == file.path.as_str()) {
            continue;
        }
        append_blob(&mut key, file.path.as_str().as_bytes());
        append_blob(&mut key, file.revision.as_str().as_bytes());
        append_blob(&mut key, &(file.bytes.len() as u64).to_le_bytes());
    }
    Some(key)
}

fn append_blob(output: &mut Vec<u8>, bytes: &[u8]) {
    output.extend_from_slice(&(bytes.len() as u64).to_le_bytes());
    output.extend_from_slice(bytes);
}

fn stage_snapshot(root: &Path, snapshot: &CompileInputSnapshot) -> Result<(), String> {
    for entry in &snapshot.entries {
        if entry.kind == FileKind::Directory {
            fs::create_dir_all(join_relative(root, entry.path.as_str()))
                .map_err(|error| format!("Could not stage Draft warm directory: {error}"))?;
        }
    }
    for file in &snapshot.files {
        let path = join_relative(root, file.path.as_str());
        let parent = path
            .parent()
            .ok_or_else(|| "Draft warm input has no parent directory.".to_owned())?;
        fs::create_dir_all(parent)
            .map_err(|error| format!("Could not stage Draft warm input directory: {error}"))?;
        write_new_file(&path, &file.bytes)?;
    }
    Ok(())
}

fn join_relative(root: &Path, relative: &str) -> PathBuf {
    let mut output = root.to_path_buf();
    for segment in relative.split('/') {
        output.push(segment);
    }
    output
}

fn write_new_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|error| format!("Could not create private Draft warm data: {error}"))?;
    file.write_all(bytes)
        .map_err(|error| format!("Could not write private Draft warm data: {error}"))
}

fn read_bounded(path: &Path, maximum: usize) -> Result<Vec<u8>, String> {
    let file =
        File::open(path).map_err(|error| format!("Could not read Draft warm frame: {error}"))?;
    let mut limited = file.take(maximum as u64 + 1);
    let mut bytes = Vec::new();
    limited
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Could not read Draft warm frame: {error}"))?;
    if bytes.len() > maximum {
        return Err("Draft warm frame exceeded its byte limit.".to_owned());
    }
    Ok(bytes)
}

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len().saturating_mul(2));
    for byte in bytes {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0x0f) as usize] as char);
    }
    output
}

#[cfg(test)]
#[path = "../../tests/unit/draft.rs"]
mod acceptance_tests;
