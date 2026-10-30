// SPDX-License-Identifier: Apache-2.0
//! Persisted, host-validated workspace compile configuration.
//!
//! Records are keyed by the trusted owner label and a hash of the canonical
//! root supplied by FilesystemService. Ephemeral workspace IDs are not used as
//! persistent identities. All mutations take the workspace save lease and use
//! revision compare-and-swap.

#![cfg(all(windows, target_arch = "x86_64"))]

use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard, OnceLock, PoisonError},
};

use serde::{de::Error as _, Deserialize, Deserializer, Serialize};
use sha2::{Digest, Sha256};

use crate::{
    schemas::protocol::{Engine, OwnerId, WorkspaceId, WorkspaceInfo, MAX_SAFE_INTEGER},
    services::filesystem::{FilesystemError, FilesystemService},
    shared::relative_path::RelativePath,
};

const STORE_FILENAME: &str = "frontend-compile-config-v1.json";
const STORE_VERSION: u32 = 1;
const MAX_STORE_BYTES: u64 = 512 * 1024;
const MAX_RECORDS: usize = 256;
const MAX_COMMAND_UTF16: usize = 4096;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum CompileProfile {
    Managed,
    System,
    Custom,
}

impl CompileProfile {
    pub(crate) fn engine(self) -> Engine {
        match self {
            Self::Managed => Engine::Managed,
            Self::System | Self::Custom => Engine::System,
        }
    }
}

/// Selected only by trusted Rust callers; this is not part of a renderer DTO.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum CompileOrigin {
    Ui,
    Mcp,
    McpPaths,
}

impl CompileOrigin {
    pub(crate) fn is_mcp(self) -> bool {
        matches!(self, Self::Mcp | Self::McpPaths)
    }

    pub(crate) fn can_set_command(self, mcp_permission: bool) -> bool {
        match self {
            Self::Ui => true,
            Self::Mcp | Self::McpPaths => mcp_permission,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CompileWorkspaceConfig {
    pub(crate) revision: u64,
    pub(crate) main_file: Option<RelativePath>,
    pub(crate) profile: CompileProfile,
    pub(crate) output_dir: Option<RelativePath>,
    #[serde(rename = "pdf")]
    pub(crate) pdf_path: Option<RelativePath>,
    #[serde(rename = "log")]
    pub(crate) log_path: Option<RelativePath>,
    pub(crate) custom_command: Option<String>,
}

impl CompileWorkspaceConfig {
    pub(crate) fn effective_main<'a>(&'a self, requested: &'a RelativePath) -> &'a RelativePath {
        self.main_file.as_ref().unwrap_or(requested)
    }

    pub(crate) fn snapshot_exclusions(&self) -> Vec<RelativePath> {
        let mut paths = Vec::new();
        if let Some(path) = &self.output_dir {
            paths.push(path.clone());
        }
        if let Some(path) = &self.pdf_path {
            paths.push(path.clone());
        }
        if let Some(path) = &self.log_path {
            paths.push(path.clone());
        }
        let mut seen = HashSet::new();
        paths.retain(|path| seen.insert(path.as_str().to_lowercase()));
        paths
    }

    fn validate_internal(&self) -> Result<(), String> {
        if self.revision > MAX_SAFE_INTEGER {
            return Err("INVALID_CONFIG".to_owned());
        }
        if let Some(main) = &self.main_file {
            let lower = main.as_str().to_ascii_lowercase();
            if !lower.ends_with(".tex") {
                return Err("INVALID_MAIN_FILE".to_owned());
            }
        }
        if let Some(path) = &self.pdf_path {
            if !path.as_str().to_ascii_lowercase().ends_with(".pdf") {
                return Err("INVALID_PDF_PATH".to_owned());
            }
        }
        if let Some(path) = &self.log_path {
            if !path.as_str().to_ascii_lowercase().ends_with(".log") {
                return Err("INVALID_LOG_PATH".to_owned());
            }
        }
        if self
            .pdf_path
            .as_ref()
            .zip(self.log_path.as_ref())
            .is_some_and(|(pdf, log)| pdf.as_str().eq_ignore_ascii_case(log.as_str()))
        {
            return Err("OUTPUT_PATH_COLLISION".to_owned());
        }
        if self.profile == CompileProfile::Custom {
            let command = self
                .custom_command
                .as_deref()
                .ok_or("CUSTOM_COMMAND_REQUIRED")?;
            if command.encode_utf16().count() > MAX_COMMAND_UTF16
                || !command.contains("{main}")
                || !command.contains("{out}")
                || command.chars().any(char::is_control)
            {
                return Err("INVALID_CUSTOM_COMMAND".to_owned());
            }
        } else if self.custom_command.is_some() {
            return Err("UNUSED_CUSTOM_COMMAND".to_owned());
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CompileConfigUpdate {
    pub workspace_id: WorkspaceId,
    pub expected_revision: u64,
    #[serde(deserialize_with = "required_nullable")]
    pub main_file: Option<RelativePath>,
    pub(crate) profile: CompileProfile,
    #[serde(deserialize_with = "required_nullable")]
    pub output_dir: Option<RelativePath>,
    #[serde(rename = "pdf", deserialize_with = "required_nullable")]
    pub pdf_path: Option<RelativePath>,
    #[serde(rename = "log", deserialize_with = "required_nullable")]
    pub log_path: Option<RelativePath>,
    #[serde(deserialize_with = "required_nullable_command")]
    pub custom_command: Option<String>,
}

fn required_nullable<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)
}

fn required_nullable_command<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: Deserializer<'de>,
{
    let value = Option::<String>::deserialize(deserializer)?;
    if value.as_ref().is_some_and(|text| {
        text.encode_utf16().count() > MAX_COMMAND_UTF16 || text.chars().any(char::is_control)
    }) {
        return Err(D::Error::custom("customCommand exceeds its text policy"));
    }
    Ok(value)
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompileConfigView {
    pub workspace_id: WorkspaceId,
    pub revision: u64,
    pub main_file: Option<RelativePath>,
    pub(crate) profile: CompileProfile,
    pub engine: Engine,
    pub output_dir: Option<RelativePath>,
    #[serde(rename = "pdf")]
    pub pdf_path: Option<RelativePath>,
    #[serde(rename = "log")]
    pub log_path: Option<RelativePath>,
    pub custom_command: Option<String>,
    pub can_set_command: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredConfigEntry {
    owner: String,
    root_hash: String,
    config: CompileWorkspaceConfig,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredConfigFile {
    version: u32,
    records: Vec<StoredConfigEntry>,
}

fn lock_map() -> &'static Mutex<std::collections::HashMap<String, Arc<Mutex<()>>>> {
    static LOCKS: OnceLock<Mutex<std::collections::HashMap<String, Arc<Mutex<()>>>>> =
        OnceLock::new();
    LOCKS.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

fn lock_for(path: &Path) -> Arc<Mutex<()>> {
    let key = path.to_string_lossy().to_lowercase();
    let mut locks = lock_map().lock().unwrap_or_else(PoisonError::into_inner);
    Arc::clone(locks.entry(key).or_insert_with(|| Arc::new(Mutex::new(()))))
}

#[derive(Clone)]
pub(crate) struct CompileConfigStore {
    data_dir: PathBuf,
    lock: Arc<Mutex<()>>,
}

impl CompileConfigStore {
    pub(crate) fn new(data_dir: PathBuf) -> Self {
        let path = data_dir.join(STORE_FILENAME);
        Self {
            data_dir,
            lock: lock_for(&path),
        }
    }

    fn lock(&self) -> MutexGuard<'_, ()> {
        self.lock.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn root_hash(root: &Path) -> Result<String, String> {
        let text = root.to_str().ok_or("INVALID_WORKSPACE_ROOT")?;
        let normalized = text.replace('/', "\\").to_lowercase();
        let mut digest = Sha256::new();
        for unit in normalized.encode_utf16() {
            digest.update(unit.to_le_bytes());
        }
        Ok(format!("{:x}", digest.finalize()))
    }

    fn read_locked(&self) -> Result<Vec<StoredConfigEntry>, String> {
        use crate::state::recent::bounded_read_store_bytes;
        let path = self.data_dir.join(STORE_FILENAME);
        let Some(bytes) = bounded_read_store_bytes(&path, &self.data_dir, MAX_STORE_BYTES)
            .map_err(|_| "COMPILE_CONFIG_STORE_IO")?
        else {
            return Ok(Vec::new());
        };
        let envelope: StoredConfigFile =
            serde_json::from_slice(&bytes).map_err(|_| "COMPILE_CONFIG_STORE_MALFORMED")?;
        if envelope.version != STORE_VERSION || envelope.records.len() > MAX_RECORDS {
            return Err("COMPILE_CONFIG_STORE_MALFORMED".to_owned());
        }
        let mut seen = HashSet::new();
        for record in &envelope.records {
            OwnerId::from_label(&record.owner).map_err(|_| "COMPILE_CONFIG_STORE_MALFORMED")?;
            if record.root_hash.len() != 64
                || !record
                    .root_hash
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit())
                || !seen.insert((record.owner.clone(), record.root_hash.clone()))
            {
                return Err("COMPILE_CONFIG_STORE_MALFORMED".to_owned());
            }
            record.config.validate_internal()?;
        }
        Ok(envelope.records)
    }

    fn write_locked(&self, records: &[StoredConfigEntry]) -> Result<(), String> {
        use crate::state::recent::atomic_write_store_bytes;
        if records.len() > MAX_RECORDS {
            return Err("CAPACITY".to_owned());
        }
        let envelope = StoredConfigFile {
            version: STORE_VERSION,
            records: records.to_vec(),
        };
        let mut bytes =
            serde_json::to_vec_pretty(&envelope).map_err(|_| "COMPILE_CONFIG_SERIALIZE")?;
        bytes.push(b'\n');
        if bytes.len() as u64 > MAX_STORE_BYTES {
            return Err("COMPILE_CONFIG_STORE_TOO_LARGE".to_owned());
        }
        atomic_write_store_bytes(&self.data_dir, STORE_FILENAME, &bytes, |from, to| {
            fs::rename(from, to)
        })
        .map_err(|_| "COMPILE_CONFIG_PERSISTENCE_FAILED")?;
        Ok(())
    }

    fn current_config(
        &self,
        records: &[StoredConfigEntry],
        owner: &OwnerId,
        root_hash: &str,
        info: &WorkspaceInfo,
    ) -> Result<CompileWorkspaceConfig, String> {
        Ok(records
            .iter()
            .find(|entry| entry.owner == owner.as_str() && entry.root_hash == root_hash)
            .map(|entry| entry.config.clone())
            .unwrap_or_else(|| CompileWorkspaceConfig {
                revision: 0,
                main_file: info.entry_path.clone(),
                profile: CompileProfile::Managed,
                output_dir: None,
                pdf_path: None,
                log_path: None,
                custom_command: None,
            }))
    }

    pub(crate) fn with_workspace_config<T>(
        &self,
        filesystem: &FilesystemService,
        owner: &OwnerId,
        workspace_id: &WorkspaceId,
        origin: CompileOrigin,
        operation: impl FnOnce(&CompileWorkspaceConfig, bool) -> Result<T, String>,
    ) -> Result<T, String> {
        self.with_workspace_config_checked(
            filesystem,
            owner,
            workspace_id,
            origin,
            || Ok(()),
            operation,
        )
    }

    /// Keeps the persisted permission lock and config snapshot stable through
    /// the native admission callback. MCP callers provide a final route and
    /// deadline check for the side effect.
    pub(crate) fn with_workspace_config_checked<T>(
        &self,
        filesystem: &FilesystemService,
        owner: &OwnerId,
        workspace_id: &WorkspaceId,
        origin: CompileOrigin,
        validate_current: impl Fn() -> Result<(), String> + Copy,
        operation: impl FnOnce(&CompileWorkspaceConfig, bool) -> Result<T, String>,
    ) -> Result<T, String> {
        let (_, info) = filesystem
            .workspace_info(owner, workspace_id)
            .map_err(|_| "STALE_WORKSPACE")?;
        let generation = filesystem
            .workspace_generation(owner, workspace_id)
            .map_err(|_| "STALE_WORKSPACE")?
            .get();
        let root = filesystem
            .workspace_root_path(owner, workspace_id)
            .map_err(|_| "STALE_WORKSPACE")?;
        let root_hash = Self::root_hash(&root)?;
        let execute = |mcp_permission| {
            let _guard = self.lock();
            let records = self.read_locked()?;
            let config = self.current_config(&records, owner, &root_hash, &info)?;
            validate_current()?;
            let can_set_command = origin.can_set_command(mcp_permission);
            let result = operation(&config, can_set_command)?;
            let current = filesystem
                .workspace_generation(owner, workspace_id)
                .map_err(|_| "STALE_WORKSPACE")?
                .get();
            if current != generation {
                return Err("STALE_WORKSPACE".to_owned());
            }
            Ok(result)
        };
        if origin.is_mcp() {
            filesystem
                .settings_store()
                .with_mcp_compile_command_permission(execute)
        } else {
            execute(false)
        }
    }

    pub(crate) fn view_for_workspace(
        &self,
        filesystem: &FilesystemService,
        owner: &OwnerId,
        workspace_id: &WorkspaceId,
        origin: CompileOrigin,
    ) -> Result<CompileConfigView, String> {
        self.with_workspace_config(
            filesystem,
            owner,
            workspace_id,
            origin,
            |config, allowed| {
                let (_, info) = filesystem
                    .workspace_info(owner, workspace_id)
                    .map_err(|_| "STALE_WORKSPACE")?;
                Ok(view(&info.id, config, allowed))
            },
        )
    }

    pub(crate) fn update(
        &self,
        filesystem: &FilesystemService,
        owner: &OwnerId,
        request: CompileConfigUpdate,
        origin: CompileOrigin,
    ) -> Result<CompileConfigView, String> {
        self.update_checked(filesystem, owner, request, origin, || Ok(()))
    }

    /// CAS mutation with a native last-moment owner/workspace/deadline check.
    /// For MCP, the permission lock is acquired before the workspace lease and
    /// held through the config write; the permission setter uses that same
    /// lock. UI callers retain their separate, permission-independent path.
    pub(crate) fn update_checked<F>(
        &self,
        filesystem: &FilesystemService,
        owner: &OwnerId,
        request: CompileConfigUpdate,
        origin: CompileOrigin,
        validate_current: F,
    ) -> Result<CompileConfigView, String>
    where
        F: Fn() -> Result<(), String> + Copy,
    {
        if request.expected_revision > MAX_SAFE_INTEGER {
            return Err("INVALID_INPUT".to_owned());
        }
        let store = self.clone();
        let workspace_id = request.workspace_id.clone();
        let update = |mcp_permission| {
            let store = store.clone();
            let result = filesystem.with_workspace_config_write(
                owner,
                &workspace_id,
                move |root, info, _generation, trusted_root| {
                    if info.id != request.workspace_id {
                        return Err(FilesystemError::Store {
                            code: "COMPILE_CONFIG",
                            message: "STALE_WORKSPACE".to_owned(),
                        });
                    }
                    let entries = trusted_root.list_files().map_err(FilesystemError::from)?;
                    let root_hash =
                        Self::root_hash(root).map_err(|message| FilesystemError::Store {
                            code: "COMPILE_CONFIG",
                            message,
                        })?;
                    let _guard = store.lock();
                    let mut stored =
                        store
                            .read_locked()
                            .map_err(|message| FilesystemError::Store {
                                code: "COMPILE_CONFIG",
                                message,
                            })?;
                    let current = store
                        .current_config(&stored, owner, &root_hash, info)
                        .map_err(|message| FilesystemError::Store {
                            code: "COMPILE_CONFIG",
                            message,
                        })?;
                    if current.revision != request.expected_revision {
                        return Err(FilesystemError::Store {
                            code: "COMPILE_CONFIG_CONFLICT",
                            message: "CONFIG_CONFLICT".to_owned(),
                        });
                    }
                    let can_set_command = origin.can_set_command(mcp_permission);
                    if origin == CompileOrigin::McpPaths {
                        if request.profile != current.profile
                            || request.custom_command.as_deref()
                                != current.custom_command.as_deref()
                        {
                            return Err(FilesystemError::Store {
                                code: "COMPILE_CONFIG",
                                message: "PERMISSION_DENIED".to_owned(),
                            });
                        }
                    } else if origin == CompileOrigin::Mcp
                        && (request.profile == CompileProfile::Custom
                            || request.profile != current.profile
                            || request.custom_command.as_deref()
                                != current.custom_command.as_deref())
                        && !can_set_command
                    {
                        return Err(FilesystemError::Store {
                            code: "COMPILE_CONFIG",
                            message: "PERMISSION_DENIED".to_owned(),
                        });
                    }
                    let changes_custom_command = request.profile == CompileProfile::Custom
                        && (current.profile != CompileProfile::Custom
                            || current.custom_command.as_deref()
                                != request.custom_command.as_deref());
                    if changes_custom_command {
                        let command = request.custom_command.as_deref().ok_or_else(|| {
                            FilesystemError::Store {
                                code: "COMPILE_CONFIG",
                                message: "CUSTOM_COMMAND_REQUIRED".to_owned(),
                            }
                        })?;
                        crate::services::compile_service::validate_custom_command_template(command)
                            .map_err(|_| FilesystemError::Store {
                                code: "COMPILE_CONFIG",
                                message: "INVALID_CUSTOM_COMMAND".to_owned(),
                            })?;
                    }
                    validate_update_paths(&request, info, &entries).map_err(|message| {
                        FilesystemError::Store {
                            code: "COMPILE_CONFIG",
                            message,
                        }
                    })?;
                    let revision = current
                        .revision
                        .checked_add(1)
                        .filter(|revision| *revision <= MAX_SAFE_INTEGER)
                        .ok_or(FilesystemError::ResourceExhausted)?;
                    let config = CompileWorkspaceConfig {
                        revision,
                        main_file: request.main_file.clone(),
                        profile: request.profile,
                        output_dir: request.output_dir.clone(),
                        pdf_path: request.pdf_path.clone(),
                        log_path: request.log_path.clone(),
                        custom_command: request.custom_command.clone(),
                    };
                    config
                        .validate_internal()
                        .map_err(|message| FilesystemError::Store {
                            code: "COMPILE_CONFIG",
                            message,
                        })?;
                    validate_current().map_err(|message| FilesystemError::Store {
                        code: "COMPILE_CONFIG",
                        message,
                    })?;
                    let record = StoredConfigEntry {
                        owner: owner.as_str().to_owned(),
                        root_hash: root_hash.clone(),
                        config: config.clone(),
                    };
                    if let Some(existing) = stored.iter_mut().find(|entry| {
                        entry.owner == record.owner && entry.root_hash == record.root_hash
                    }) {
                        *existing = record;
                    } else {
                        if stored.len() >= MAX_RECORDS {
                            return Err(FilesystemError::ResourceExhausted);
                        }
                        stored.push(record);
                    }
                    store
                        .write_locked(&stored)
                        .map_err(|message| FilesystemError::Store {
                            code: "COMPILE_CONFIG",
                            message,
                        })?;
                    Ok(view(&info.id, &config, can_set_command))
                },
            );
            result.map_err(|error| {
                if matches!(
                    &error,
                    FilesystemError::Store {
                        code: "COMPILE_CONFIG_CONFLICT",
                        ..
                    }
                ) {
                    "CONFIG_CONFLICT".to_owned()
                } else {
                    error.to_string()
                }
            })
        };
        if origin.is_mcp() {
            filesystem
                .settings_store()
                .with_mcp_compile_command_permission(update)
        } else {
            update(false)
        }
    }
}

fn view(
    workspace_id: &WorkspaceId,
    config: &CompileWorkspaceConfig,
    allowed: bool,
) -> CompileConfigView {
    CompileConfigView {
        workspace_id: workspace_id.clone(),
        revision: config.revision,
        main_file: config.main_file.clone(),
        profile: config.profile,
        engine: config.profile.engine(),
        output_dir: config.output_dir.clone(),
        pdf_path: config.pdf_path.clone(),
        log_path: config.log_path.clone(),
        custom_command: config.custom_command.clone(),
        can_set_command: allowed,
    }
}

fn validate_update_paths(
    request: &CompileConfigUpdate,
    info: &WorkspaceInfo,
    entries: &[crate::schemas::protocol::FileEntry],
) -> Result<(), String> {
    let files = entries
        .iter()
        .map(|entry| (entry.path.as_str().to_lowercase(), entry.kind))
        .collect::<std::collections::HashMap<_, _>>();
    let main = request.main_file.as_ref();
    if main.is_some_and(|main| {
        !main.as_str().to_ascii_lowercase().ends_with(".tex")
            || files.get(&main.as_str().to_lowercase())
                != Some(&crate::schemas::protocol::FileKind::File)
    }) {
        return Err("INVALID_MAIN_FILE".to_owned());
    }
    if let Some(directory) = &request.output_dir {
        if files.get(&directory.as_str().to_lowercase())
            != Some(&crate::schemas::protocol::FileKind::Directory)
        {
            return Err("INVALID_OUTPUT_DIRECTORY".to_owned());
        }
        let prefix = format!("{}/", directory.as_str().to_lowercase());
        if main.is_some_and(|main| main.as_str().to_lowercase().starts_with(&prefix)) {
            return Err("OUTPUT_DIRECTORY_CONTAINS_MAIN_FILE".to_owned());
        }
        for entry in entries {
            let path = entry.path.as_str().to_lowercase();
            if path.starts_with(&prefix) && entry.kind == crate::schemas::protocol::FileKind::File {
                let generated = [
                    ".pdf",
                    ".log",
                    ".aux",
                    ".fls",
                    ".fdb_latexmk",
                    ".synctex.gz",
                    ".out",
                    ".toc",
                    ".xdv",
                    ".bbl",
                    ".blg",
                ]
                .iter()
                .any(|extension| path.ends_with(extension));
                if !generated {
                    return Err("OUTPUT_DIRECTORY_CONTAINS_INPUT".to_owned());
                }
            }
        }
    }
    let mut targets = HashSet::new();
    for (path, extension) in [
        (request.pdf_path.as_ref(), Some(".pdf")),
        (request.log_path.as_ref(), Some(".log")),
    ] {
        if let Some(path) = path {
            let lower = path.as_str().to_lowercase();
            if extension.is_some_and(|extension| !lower.ends_with(extension))
                || main.is_some_and(|main| lower == main.as_str().to_lowercase())
                || !targets.insert(lower.clone())
            {
                return Err("INVALID_OR_COLLIDING_OUTPUT_PATH".to_owned());
            }
            if let Some((parent, _)) = lower.rsplit_once('/') {
                if files.get(parent) != Some(&crate::schemas::protocol::FileKind::Directory) {
                    return Err("OUTPUT_PARENT_NOT_DIRECTORY".to_owned());
                }
            }
            if files.get(&lower) == Some(&crate::schemas::protocol::FileKind::Directory) {
                return Err("OUTPUT_PATH_IS_DIRECTORY".to_owned());
            }
        }
    }
    if request.profile == CompileProfile::Custom {
        let command = request
            .custom_command
            .as_deref()
            .ok_or("CUSTOM_COMMAND_REQUIRED")?;
        if command.encode_utf16().count() > MAX_COMMAND_UTF16 || !command.contains("{main}") {
            return Err("INVALID_CUSTOM_COMMAND".to_owned());
        }
    } else if request.custom_command.is_some() {
        return Err("UNUSED_CUSTOM_COMMAND".to_owned());
    }
    let _ = info;
    Ok(())
}

#[cfg(test)]
#[path = "../../tests/unit/compile_config.rs"]
mod tests;
