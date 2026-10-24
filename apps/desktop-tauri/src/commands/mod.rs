// SPDX-License-Identifier: Apache-2.0
#[cfg(all(windows, target_arch = "x86_64"))]
pub mod frontend_compile;
#[cfg(all(windows, target_arch = "x86_64"))]
pub mod frontend_compile_config;
#[cfg(all(windows, target_arch = "x86_64"))]
pub mod frontend_draft;
#[cfg(all(windows, target_arch = "x86_64"))]
pub mod frontend_files;
#[cfg(all(windows, target_arch = "x86_64"))]
pub mod frontend_git;
#[cfg(all(windows, target_arch = "x86_64"))]
pub mod frontend_settings;
#[cfg(all(windows, target_arch = "x86_64"))]
pub mod frontend_terminal;
#[cfg(all(windows, target_arch = "x86_64"))]
pub mod frontend_window;
#[cfg(all(windows, target_arch = "x86_64", feature = "mcp"))]
pub mod mcp;
#[cfg(feature = "g1-prototypes")]
pub mod prototype;
