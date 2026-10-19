// SPDX-License-Identifier: Apache-2.0
pub(crate) mod file_identity;
#[cfg(all(windows, target_arch = "x86_64"))]
pub mod dialogs;
#[cfg(all(windows, target_arch = "x86_64"))]
pub mod windows_files;
