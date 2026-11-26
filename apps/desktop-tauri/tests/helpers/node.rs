// SPDX-License-Identifier: Apache-2.0
use std::{env, fs, path::PathBuf};

pub(crate) fn executable() -> PathBuf {
    if let Some(configured) = env::var_os("MODUTEX_TEST_NODE").map(PathBuf::from) {
        assert!(
            configured.is_absolute() && configured.is_file(),
            "MODUTEX_TEST_NODE must identify an existing absolute Node executable"
        );
        return fs::canonicalize(configured).expect("canonical test Node executable");
    }

    let path = env::var_os("PATH").unwrap_or_default();
    let program_files = env::var_os("ProgramFiles").map(|dir| PathBuf::from(dir).join("nodejs"));
    for directory in env::split_paths(&path).chain(program_files) {
        let candidate = directory.join("node.exe");
        if candidate.is_file() {
            return fs::canonicalize(candidate).expect("canonical test Node executable");
        }
    }
    panic!("node.exe required for Windows process tests");
}
