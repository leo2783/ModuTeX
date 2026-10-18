// SPDX-License-Identifier: Apache-2.0
#[cfg(all(windows, target_arch = "x86_64"))]
pub mod filesystem;
pub mod git_service;
#[cfg(all(windows, target_arch = "x86_64"))]
pub mod watch_native;
