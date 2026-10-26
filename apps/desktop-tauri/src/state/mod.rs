// SPDX-License-Identifier: Apache-2.0
#[cfg(all(windows, target_arch = "x86_64"))]
pub mod binary_tokens;
#[cfg(all(windows, target_arch = "x86_64"))]
pub mod compile;
#[cfg(all(windows, target_arch = "x86_64"))]
pub mod desktop;
#[cfg(all(windows, target_arch = "x86_64"))]
pub mod draft;
#[cfg(all(windows, target_arch = "x86_64"))]
pub mod git;
#[cfg(all(windows, target_arch = "x86_64", feature = "mcp"))]
pub mod mcp;
#[cfg(all(windows, target_arch = "x86_64"))]
pub mod pending_open;
pub mod recent;
pub mod sessions;
pub mod settings;
#[cfg(all(windows, target_arch = "x86_64"))]
pub mod source_format;
#[cfg(all(windows, target_arch = "x86_64"))]
pub mod terminal;
#[cfg(all(windows, target_arch = "x86_64"))]
pub mod workspace_files;
pub mod workspace_leases;
