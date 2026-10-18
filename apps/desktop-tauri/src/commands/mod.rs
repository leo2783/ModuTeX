// SPDX-License-Identifier: Apache-2.0
#[cfg(all(windows, target_arch = "x86_64"))]
pub mod frontend_files;
#[cfg(feature = "g1-prototypes")]
pub mod prototype;
