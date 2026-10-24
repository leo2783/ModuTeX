// SPDX-License-Identifier: Apache-2.0
pub mod protocol;

#[cfg(all(windows, target_arch = "x86_64"))]
pub mod draft;

#[cfg(all(windows, target_arch = "x86_64"))]
pub mod terminal;
