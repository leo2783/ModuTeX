// SPDX-License-Identifier: Apache-2.0
//! Tauri compile runtime and bounded binary-artifact bindings.
//!
//! The CompileService owns run phases, process cleanup, and filesystem leases.
//! This state owns only the Tauri transport bindings for already-settled
//! artifacts; PDF bytes remain in the existing BinaryTokenStore.

use std::{
    collections::HashMap,
    env,
    ffi::OsString,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard, PoisonError},
    time::Duration,
};

use tauri::Manager;

use crate::{
    compile_config::{CompileConfigStore, CompileConfigUpdate, CompileConfigView, CompileOrigin},
    schemas::protocol::{CompileIdentity, CompileRequest, OwnerId, RunId, WorkspaceId},
    services::{
        compile_service::{
            resolve_trusted_executable, CompileDelivery, CompileOverlay, CompileService,
            CompileServiceError, ManagedProfile, SystemArgument, SystemProfile, SystemTool,
            TrustedCompileConfig,
        },
        filesystem::FilesystemService,
    },
    state::{
        binary_tokens::{BinaryTokenStore, CompileRunAdmission, OwnerAdmission},
        desktop::WorkspaceGrant,
        workspace_leases::SessionGeneration,
    },
};

const MAX_COMPILE_PDF_BINDINGS: usize = 128;
const MAX_RETAINED_SYNCTEX_BYTES: usize = 32 * 1024 * 1024;
const MAX_REPOSITORY_ANCESTORS: usize = 16;
const REPOSITORY_DESKTOP_MANIFEST: &str = "apps/desktop-tauri/Cargo.toml";
const REPOSITORY_FRONTEND_MARKER: &str = "packages/frontend-contracts/src/schemas/types.ts";
const PINNED_TECTONIC_RELATIVE_PATH: &str = "vendor/tectonic/windows-x64/tectonic.exe";

fn development_repository_root_matches(root: &Path) -> bool {
    root.join(REPOSITORY_DESKTOP_MANIFEST).is_file()
        && root.join(REPOSITORY_FRONTEND_MARKER).is_file()
}

/// Checks only a bounded number of compile-time source ancestors. This is not
/// a filesystem walk; the engine candidate is the one fixed vendor asset and
/// must pass the trusted executable validator used again when a run starts.
fn development_tectonic_executable(manifest_dir: &Path) -> Option<PathBuf> {
    for root in manifest_dir.ancestors().take(MAX_REPOSITORY_ANCESTORS) {
        if !development_repository_root_matches(root) {
            continue;
        }
        if let Ok(executable) =
            resolve_trusted_executable(&root.join(PINNED_TECTONIC_RELATIVE_PATH))
        {
            return Some(executable);
        }
    }
    None
}

fn select_managed_tectonic(resource_dir: &Path, manifest_dir: &Path) -> PathBuf {
    let resource_tectonic = resource_dir.join("tectonic").join("tectonic.exe");
    let packaged_candidates = [
        resource_tectonic.clone(),
        resource_dir
            .join("vendor")
            .join("tectonic")
            .join("windows-x64")
            .join("tectonic.exe"),
        resource_dir.join("vendor").join("tectonic.exe"),
    ];
    packaged_candidates
        .iter()
        .find_map(|candidate| resolve_trusted_executable(candidate).ok())
        .or_else(|| development_tectonic_executable(manifest_dir))
        .unwrap_or(resource_tectonic)
}

#[derive(Clone)]
pub(crate) struct CompileArtifactBinding {
    pub(crate) identity: CompileIdentity,
    pub(crate) filesystem_generation: SessionGeneration,
    pub(crate) epoch: u64,
}

pub(crate) struct CompilePdfBinding {
    pub(crate) artifact: CompileArtifactBinding,
    run_admission: CompileRunAdmission,
    token_store: Arc<BinaryTokenStore>,
}

impl CompilePdfBinding {
    pub(crate) fn take(&self, owner: &OwnerAdmission, token: &str) -> Result<Vec<u8>, String> {
        take_compile_pdf_ticket(&self.token_store, owner, &self.run_admission, token)
    }

    pub(crate) fn revoke(&self) {
        self.token_store.revoke_compile_run(&self.run_admission);
    }
}

pub(crate) fn take_compile_pdf_ticket(
    token_store: &BinaryTokenStore,
    owner: &OwnerAdmission,
    run_admission: &CompileRunAdmission,
    token: &str,
) -> Result<Vec<u8>, String> {
    let result = token_store
        .take_compile_pdf(owner, token)
        .map_err(|_| "TokenDenied".to_owned());
    token_store.revoke_compile_run(run_admission);
    result
}

struct PdfBinding {
    owner: OwnerId,
    binding: CompileArtifactBinding,
    run_admission: CompileRunAdmission,
    token_store: Arc<BinaryTokenStore>,
    order: u64,
}

struct SynctexBinding {
    owner: OwnerId,
    binding: CompileArtifactBinding,
    bytes: Vec<u8>,
    order: u64,
}

pub(crate) struct CompileSynctexArtifact {
    pub(crate) binding: CompileArtifactBinding,
    pub(crate) bytes: Vec<u8>,
}

struct CompileArtifacts {
    pdf: HashMap<String, PdfBinding>,
    synctex: HashMap<RunId, SynctexBinding>,
    synctex_bytes: usize,
    next_order: u64,
}

impl Default for CompileArtifacts {
    fn default() -> Self {
        Self {
            pdf: HashMap::new(),
            synctex: HashMap::new(),
            synctex_bytes: 0,
            next_order: 1,
        }
    }
}

struct CompileRuntime {
    service: CompileService,
    filesystem: Arc<FilesystemService>,
    config_store: CompileConfigStore,
    artifacts: Mutex<CompileArtifacts>,
}

/// The same app-lifetime FilesystemService used by G2 is passed into the
/// coordinator. This wrapper does not create a second workspace registry.
#[derive(Clone)]
pub struct FrontendCompileState {
    inner: Arc<CompileRuntime>,
}

impl FrontendCompileState {
    pub(crate) fn from_app(
        app: &tauri::App,
        filesystem: Arc<FilesystemService>,
    ) -> Result<Self, String> {
        let resource_dir = app
            .path()
            .resource_dir()
            .map_err(|error| error.to_string())?;
        let cache_dir = app
            .path()
            .app_cache_dir()
            .map_err(|error| error.to_string())?;

        // Packaged resources take precedence over the bounded development
        // lookup. Neither renderer input nor PATH participates in selection.
        let executable =
            select_managed_tectonic(&resource_dir, Path::new(env!("CARGO_MANIFEST_DIR")));

        let managed = ManagedProfile::new(
            executable,
            cache_dir.join("tectonic"),
            Vec::new(),
            Vec::new(),
        )
        .map_err(|error| error.to_string())?;
        let system = trusted_system_tex_profile();
        let config =
            TrustedCompileConfig::new(cache_dir.join("compile-temp"), Some(managed), system)
                .map_err(|error| error.to_string())?;
        let app_data_dir = app
            .path()
            .app_data_dir()
            .map_err(|error| error.to_string())?;
        let config_store = CompileConfigStore::new(app_data_dir);
        let service = CompileService::new(Arc::clone(&filesystem), config)
            .map_err(|error| error.to_string())?;

        Ok(Self {
            inner: Arc::new(CompileRuntime {
                service,
                filesystem,
                config_store,
                artifacts: Mutex::new(CompileArtifacts::default()),
            }),
        })
    }

    fn lock_artifacts(&self) -> MutexGuard<'_, CompileArtifacts> {
        self.inner
            .artifacts
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    pub(crate) fn start(
        &self,
        owner: &OwnerId,
        request: CompileRequest,
        origin: CompileOrigin,
    ) -> Result<CompileIdentity, String> {
        self.start_with_overlay(owner, request, CompileOverlay::default(), origin)
    }

    /// Unsaved overlays remain host-owned, and use the same persisted profile,
    /// main-file selection, output exclusions, and compile lease as disk builds.
    pub(crate) fn start_with_overlay(
        &self,
        owner: &OwnerId,
        request: CompileRequest,
        overlay: CompileOverlay,
        origin: CompileOrigin,
    ) -> Result<CompileIdentity, String> {
        let workspace_id = request.workspace_id.clone();
        self.inner.config_store.with_workspace_config(
            &self.inner.filesystem,
            owner,
            &workspace_id,
            origin,
            |config, custom_allowed| {
                self.inner
                    .service
                    .start_with_workspace_config(
                        owner,
                        request,
                        overlay,
                        config.clone(),
                        custom_allowed,
                    )
                    .map_err(|error| error.to_string())
            },
        )
    }

    pub(crate) fn get_compile_config(
        &self,
        owner: &OwnerId,
        workspace_id: &WorkspaceId,
        origin: CompileOrigin,
    ) -> Result<CompileConfigView, String> {
        self.inner.config_store.view_for_workspace(
            &self.inner.filesystem,
            owner,
            workspace_id,
            origin,
        )
    }

    pub(crate) fn update_compile_config(
        &self,
        owner: &OwnerId,
        request: CompileConfigUpdate,
        origin: CompileOrigin,
    ) -> Result<CompileConfigView, String> {
        self.inner
            .config_store
            .update(&self.inner.filesystem, owner, request, origin)
    }

    #[cfg(feature = "mcp")]
    pub(crate) fn get_mcp_compile_command_permission(&self) -> Result<bool, String> {
        self.inner
            .filesystem
            .settings_store()
            .mcp_compile_command_allowed()
            .map_err(|error| error.to_string())
    }

    #[cfg(feature = "mcp")]
    pub(crate) fn set_mcp_compile_command_permission(&self, enabled: bool) -> Result<bool, String> {
        self.inner
            .filesystem
            .settings_store()
            .set_mcp_compile_command_allowed(enabled)
            .map_err(|error| error.to_string())
    }

    pub(crate) fn cancel_run(
        &self,
        owner: &OwnerId,
        run_id: &RunId,
    ) -> Result<bool, CompileServiceError> {
        self.inner.service.cancel_run(owner, run_id)
    }

    pub(crate) fn wait_run_result_with_artifacts(
        &self,
        owner: &OwnerId,
        run_id: &RunId,
        timeout: Duration,
    ) -> Result<Option<CompileDelivery>, CompileServiceError> {
        self.inner
            .service
            .wait_run_result_with_artifacts(owner, run_id, timeout)
    }

    fn next_order(artifacts: &mut CompileArtifacts) -> Result<u64, String> {
        let order = artifacts.next_order;
        artifacts.next_order = order
            .checked_add(1)
            .ok_or_else(|| "compile artifact sequence exhausted".to_owned())?;
        Ok(order)
    }

    fn remove_oldest_pdf(artifacts: &mut CompileArtifacts) {
        if let Some(oldest) = artifacts
            .pdf
            .iter()
            .min_by_key(|(_, item)| item.order)
            .map(|(key, _)| key.clone())
        {
            if let Some(removed) = artifacts.pdf.remove(&oldest) {
                removed
                    .token_store
                    .revoke_compile_run(&removed.run_admission);
            }
        }
    }

    fn remove_oldest_synctex(artifacts: &mut CompileArtifacts) {
        if let Some(oldest) = artifacts
            .synctex
            .iter()
            .min_by_key(|(_, item)| item.order)
            .map(|(run_id, _)| run_id.clone())
        {
            if let Some(removed) = artifacts.synctex.remove(&oldest) {
                artifacts.synctex_bytes =
                    artifacts.synctex_bytes.saturating_sub(removed.bytes.len());
            }
        }
    }

    pub(crate) fn record_success(
        &self,
        owner: &OwnerId,
        identity: &CompileIdentity,
        grant: &WorkspaceGrant,
        token_store: &Arc<BinaryTokenStore>,
        publication: (String, CompileRunAdmission),
        synctex: Option<Vec<u8>>,
    ) -> Result<(), String> {
        let (pdf_token, run_admission) = publication;
        if run_admission.identity() != identity {
            return Err("compile PDF ticket is for another compilation".to_owned());
        }
        if &identity.workspace_id != grant.admission.workspace_id() {
            return Err("compile PDF ticket is for another workspace".to_owned());
        }

        let keep_synctex = synctex
            .as_ref()
            .is_some_and(|bytes| !bytes.is_empty() && bytes.len() <= MAX_RETAINED_SYNCTEX_BYTES);
        let mut artifacts = self.lock_artifacts();
        if artifacts.pdf.contains_key(&pdf_token) {
            return Err("compile PDF token collision".to_owned());
        }

        let binding = CompileArtifactBinding {
            identity: identity.clone(),
            filesystem_generation: grant.filesystem_generation,
            epoch: grant.epoch,
        };
        let pdf_order = Self::next_order(&mut artifacts)?;
        let synctex_order = if keep_synctex {
            Some(Self::next_order(&mut artifacts)?)
        } else {
            None
        };

        while artifacts.pdf.len() >= MAX_COMPILE_PDF_BINDINGS {
            Self::remove_oldest_pdf(&mut artifacts);
        }
        artifacts.pdf.insert(
            pdf_token,
            PdfBinding {
                owner: owner.clone(),
                binding: binding.clone(),
                run_admission,
                token_store: Arc::clone(token_store),
                order: pdf_order,
            },
        );

        if let (Some(bytes), Some(order)) = (synctex, synctex_order) {
            while artifacts.synctex_bytes.saturating_add(bytes.len()) > MAX_RETAINED_SYNCTEX_BYTES {
                if artifacts.synctex.is_empty() {
                    break;
                }
                Self::remove_oldest_synctex(&mut artifacts);
            }
            if artifacts.synctex_bytes.saturating_add(bytes.len()) <= MAX_RETAINED_SYNCTEX_BYTES {
                artifacts.synctex_bytes += bytes.len();
                artifacts.synctex.insert(
                    identity.run_id.clone(),
                    SynctexBinding {
                        owner: owner.clone(),
                        binding,
                        bytes,
                        order,
                    },
                );
            }
        }
        Ok(())
    }

    pub(crate) fn take_pdf_binding(
        &self,
        owner: &OwnerId,
        token: &str,
    ) -> Result<CompilePdfBinding, String> {
        let mut artifacts = self.lock_artifacts();
        let Some(found) = artifacts.pdf.get(token) else {
            return Err("TokenDenied".to_owned());
        };
        if &found.owner != owner {
            return Err("TokenDenied".to_owned());
        }
        artifacts
            .pdf
            .remove(token)
            .map(|found| CompilePdfBinding {
                artifact: found.binding,
                run_admission: found.run_admission,
                token_store: found.token_store,
            })
            .ok_or_else(|| "TokenDenied".to_owned())
    }

    pub(crate) fn take_synctex(
        &self,
        owner: &OwnerId,
        run_id: &RunId,
    ) -> Result<CompileSynctexArtifact, String> {
        let mut artifacts = self.lock_artifacts();
        let Some(found) = artifacts.synctex.get(run_id) else {
            return Err("SyncTeX artifact unavailable".to_owned());
        };
        if &found.owner != owner {
            return Err("SyncTeX artifact unavailable".to_owned());
        }
        let found = artifacts
            .synctex
            .remove(run_id)
            .ok_or_else(|| "SyncTeX artifact unavailable".to_owned())?;
        artifacts.synctex_bytes = artifacts.synctex_bytes.saturating_sub(found.bytes.len());
        Ok(CompileSynctexArtifact {
            binding: found.binding,
            bytes: found.bytes,
        })
    }

    fn purge_workspace(&self, owner: &OwnerId, workspace_id: &WorkspaceId) {
        let mut artifacts = self.lock_artifacts();
        let pdf_tokens = artifacts
            .pdf
            .iter()
            .filter_map(|(token, item)| {
                (&item.owner == owner && &item.binding.identity.workspace_id == workspace_id)
                    .then_some(token.to_owned())
            })
            .collect::<Vec<_>>();
        for token in pdf_tokens {
            if let Some(removed) = artifacts.pdf.remove(&token) {
                removed
                    .token_store
                    .revoke_compile_run(&removed.run_admission);
            }
        }
        artifacts.synctex.retain(|_, item| {
            &item.owner != owner || &item.binding.identity.workspace_id != workspace_id
        });
        artifacts.synctex_bytes = artifacts
            .synctex
            .values()
            .map(|item| item.bytes.len())
            .sum();
    }

    fn purge_owner(&self, owner: &OwnerId) {
        let mut artifacts = self.lock_artifacts();
        let pdf_tokens = artifacts
            .pdf
            .iter()
            .filter_map(|(token, item)| (&item.owner == owner).then_some(token.to_owned()))
            .collect::<Vec<_>>();
        for token in pdf_tokens {
            if let Some(removed) = artifacts.pdf.remove(&token) {
                removed
                    .token_store
                    .revoke_compile_run(&removed.run_admission);
            }
        }
        artifacts.synctex.retain(|_, item| &item.owner != owner);
        artifacts.synctex_bytes = artifacts
            .synctex
            .values()
            .map(|item| item.bytes.len())
            .sum();
    }

    pub(crate) fn close_workspace(&self, owner: &OwnerId, workspace_id: &WorkspaceId) -> usize {
        let affected = self.inner.service.close_workspace(owner, workspace_id);
        self.purge_workspace(owner, workspace_id);
        affected
    }

    pub(crate) fn revoke_owner(&self, owner: &OwnerId) -> usize {
        let affected = self.inner.service.revoke_owner(owner);
        self.purge_owner(owner);
        affected
    }
}

fn trusted_system_tex_profile() -> Option<SystemProfile> {
    let path_value = env::var_os("PATH")?;
    let directories = env::split_paths(&path_value)
        .filter(|directory| directory.is_absolute())
        .collect::<Vec<_>>();

    // The executable name, argv template, environment policy, and output
    // substitutions are host-owned. PATH is consulted only by the host to
    // discover an installed System TeX executable; no shell or renderer argv
    // is used.
    let candidates = [
        ("latexmk.exe", SystemTool::LatexMk),
        ("pdflatex.exe", SystemTool::PdfLatex),
        ("xelatex.exe", SystemTool::XeLatex),
        ("lualatex.exe", SystemTool::LuaLatex),
    ];
    for (executable_name, tool) in candidates {
        for directory in &directories {
            let executable = directory.join(executable_name);
            if !executable.is_file() {
                continue;
            }
            let arguments = match tool {
                SystemTool::LatexMk => vec![
                    SystemArgument::Literal(OsString::from("-pdf")),
                    SystemArgument::Literal(OsString::from("-interaction=nonstopmode")),
                    SystemArgument::OutputDirectoryWithPrefix(OsString::from("-outdir=")),
                    SystemArgument::EntryPath,
                ],
                SystemTool::PdfLatex | SystemTool::XeLatex | SystemTool::LuaLatex => vec![
                    SystemArgument::Literal(OsString::from("-interaction=nonstopmode")),
                    SystemArgument::Literal(OsString::from("-halt-on-error")),
                    SystemArgument::Literal(OsString::from("-file-line-error")),
                    SystemArgument::Literal(OsString::from("-output-directory")),
                    SystemArgument::OutputDirectory,
                    SystemArgument::EntryPath,
                ],
                SystemTool::TrustedCustom => continue,
            };
            if let Ok(profile) = SystemProfile::new(
                tool,
                executable,
                arguments,
                vec![directory.clone()],
                Vec::new(),
                Duration::from_secs(300),
                None,
            ) {
                return Some(profile);
            }
        }
    }
    None
}

#[cfg(test)]
#[path = "../../tests/unit/compile_state.rs"]
mod tests;

#[cfg(test)]
#[path = "../../tests/unit/compile_resource_location.rs"]
mod resource_location_tests;
