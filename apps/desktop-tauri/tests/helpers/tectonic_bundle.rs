// SPDX-License-Identifier: Apache-2.0
use sha2::{Digest, Sha256};
use std::{fs, path::PathBuf, sync::OnceLock};

const BUNDLE_SHA256: &str = "ee245adea88005bc83f404c47cfd90f7e936bc382435339427ebcc45768dc1db";

fn verify(bytes: &[u8]) {
    assert_eq!(
        format!("{:x}", Sha256::digest(bytes)),
        BUNDLE_SHA256,
        "native Tectonic test bundle SHA-256 mismatch"
    );
}

pub(crate) fn verified_path() -> PathBuf {
    static VERIFIED: OnceLock<PathBuf> = OnceLock::new();
    VERIFIED
        .get_or_init(|| {
            let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../.verification-artifacts/tectonic-test-bundle.zip");
            verify(&fs::read(&path).expect("read pinned native Tectonic test bundle"));
            path
        })
        .clone()
}

#[test]
fn bundle_verification_rejects_modified_bytes() {
    let mut bytes = fs::read(verified_path()).unwrap();
    bytes[0] ^= 1;
    assert!(std::panic::catch_unwind(|| verify(&bytes)).is_err());
}
