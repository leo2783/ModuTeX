// SPDX-License-Identifier: Apache-2.0
#[cfg(all(windows, target_arch = "x86_64"))]
pub mod compile_service;
#[cfg(all(windows, target_arch = "x86_64"))]
pub mod draft_service;
#[cfg(all(windows, target_arch = "x86_64"))]
pub mod draft_warm;
#[cfg(all(windows, target_arch = "x86_64"))]
pub mod file_watch;
#[cfg(all(windows, target_arch = "x86_64"))]
pub mod filesystem;
#[cfg(all(windows, target_arch = "x86_64"))]
pub mod git_native;
pub mod git_service;
#[cfg(all(windows, target_arch = "x86_64", feature = "mcp"))]
pub mod mcp;
#[cfg(all(windows, target_arch = "x86_64"))]
pub mod source_format;
#[cfg(all(windows, target_arch = "x86_64"))]
mod synctex_artifact;
#[cfg(all(windows, target_arch = "x86_64"))]
pub mod terminal_service;
#[cfg(all(windows, target_arch = "x86_64"))]
pub mod watch_native;
#[cfg(all(windows, target_arch = "x86_64"))]
pub mod workspace_files;
