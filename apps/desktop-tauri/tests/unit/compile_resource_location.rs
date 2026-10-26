// SPDX-License-Identifier: Apache-2.0
use super::{
    development_tectonic_executable, select_managed_tectonic, MAX_REPOSITORY_ANCESTORS,
    PINNED_TECTONIC_RELATIVE_PATH, REPOSITORY_DESKTOP_MANIFEST, REPOSITORY_FRONTEND_MARKER,
};
use std::{
    env, fs,
    path::{Path, PathBuf},
};
use uuid::Uuid;

struct TestDirectory(PathBuf);

impl TestDirectory {
    fn new() -> Self {
        let path = env::temp_dir().join(format!(
            "modutex-compile-resource-{}-{}",
            std::process::id(),
            Uuid::new_v4().simple()
        ));
        fs::create_dir(&path).expect("create isolated resource test directory");
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TestDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn fixture_file(path: &Path) {
    fs::create_dir_all(path.parent().expect("fixture file has a parent"))
        .expect("create fixture parent");
    fs::write(path, b"fixture").expect("write fixture file");
}

fn mark_repository_root(root: &Path) {
    fixture_file(&root.join(REPOSITORY_DESKTOP_MANIFEST));
    fixture_file(&root.join(REPOSITORY_FRONTEND_MARKER));
}

fn canonical(path: &Path) -> PathBuf {
    fs::canonicalize(path).expect("canonicalize fixture path")
}

#[test]
fn normal_app_manifest_resolves_the_fixed_pinned_asset() {
    let directory = TestDirectory::new();
    let root = directory.path().join("checkout");
    mark_repository_root(&root);
    let engine = root.join(PINNED_TECTONIC_RELATIVE_PATH);
    fixture_file(&engine);
    let manifest_dir = root.join("apps/desktop-tauri");

    assert_eq!(
        development_tectonic_executable(&manifest_dir),
        Some(canonical(&engine))
    );
}

#[test]
fn nested_private_manifest_skips_a_partial_staging_root() {
    let directory = TestDirectory::new();
    let root = directory.path().join("checkout-𠮷");
    mark_repository_root(&root);
    let pinned_engine = root.join(PINNED_TECTONIC_RELATIVE_PATH);
    fixture_file(&pinned_engine);

    let private_root = root.join(".verification-artifacts/tauri/compile-config-owner-review");
    let manifest_dir = private_root.join("apps/desktop-tauri");
    fixture_file(&manifest_dir.join("Cargo.toml"));
    let staged_engine = private_root.join(PINNED_TECTONIC_RELATIVE_PATH);
    fixture_file(&staged_engine);

    let selected = development_tectonic_executable(&manifest_dir);
    assert_eq!(selected, Some(canonical(&pinned_engine)));
    assert_ne!(selected, Some(canonical(&staged_engine)));
}

#[test]
fn packaged_layouts_precede_the_development_vendor_asset() {
    let directory = TestDirectory::new();
    let root = directory.path().join("checkout");
    mark_repository_root(&root);
    let development_engine = root.join(PINNED_TECTONIC_RELATIVE_PATH);
    fixture_file(&development_engine);
    let manifest_dir = root.join("apps/desktop-tauri");

    let resource_dir = directory.path().join("resources");
    let primary = resource_dir.join("tectonic/tectonic.exe");
    let bundled = resource_dir.join(PINNED_TECTONIC_RELATIVE_PATH);
    let secondary = resource_dir.join("vendor/tectonic.exe");
    fixture_file(&primary);
    fixture_file(&bundled);
    fixture_file(&secondary);

    assert_eq!(
        select_managed_tectonic(&resource_dir, &manifest_dir),
        canonical(&primary)
    );

    fs::remove_file(&primary).expect("remove primary resource fixture");
    assert_eq!(
        select_managed_tectonic(&resource_dir, &manifest_dir),
        canonical(&bundled)
    );

    fs::remove_file(&bundled).expect("remove bundled resource fixture");
    assert_eq!(
        select_managed_tectonic(&resource_dir, &manifest_dir),
        canonical(&secondary)
    );

    fs::remove_file(&secondary).expect("remove secondary resource fixture");
    assert_eq!(
        select_managed_tectonic(&resource_dir, &manifest_dir),
        canonical(&development_engine)
    );
}

#[test]
fn installed_bundle_resolves_its_engine_without_a_development_checkout() {
    let directory = TestDirectory::new();
    let resource_dir = directory.path().join("installed-app");
    let bundled = resource_dir.join(PINNED_TECTONIC_RELATIVE_PATH);
    fixture_file(&bundled);
    let missing_checkout = directory.path().join("absent-checkout/apps/desktop-tauri");

    assert_eq!(
        select_managed_tectonic(&resource_dir, &missing_checkout),
        canonical(&bundled)
    );
}

#[test]
fn unmarked_or_missing_vendor_paths_are_not_selected() {
    let directory = TestDirectory::new();

    let unmarked_root = directory.path().join("lookalike");
    let unmarked_manifest = unmarked_root.join("apps/desktop-tauri");
    fixture_file(&unmarked_manifest.join("Cargo.toml"));
    fixture_file(&unmarked_root.join(PINNED_TECTONIC_RELATIVE_PATH));
    assert_eq!(development_tectonic_executable(&unmarked_manifest), None);

    let marked_root = directory.path().join("marked-without-engine");
    mark_repository_root(&marked_root);
    let marked_manifest = marked_root.join("apps/desktop-tauri");
    assert_eq!(development_tectonic_executable(&marked_manifest), None);

    let resource_dir = directory.path().join("resources");
    assert_eq!(
        select_managed_tectonic(&resource_dir, &unmarked_manifest),
        resource_dir.join("tectonic/tectonic.exe")
    );
}

#[test]
fn development_lookup_is_bounded_to_source_ancestors() {
    let directory = TestDirectory::new();
    let root = directory.path().join("distant-checkout");
    mark_repository_root(&root);
    fixture_file(&root.join(PINNED_TECTONIC_RELATIVE_PATH));

    let mut manifest_dir = root;
    for depth in 0..=MAX_REPOSITORY_ANCESTORS {
        manifest_dir = manifest_dir.join(format!("nested-{depth}"));
    }
    fs::create_dir_all(&manifest_dir).expect("create deeply nested manifest directory");

    assert_eq!(development_tectonic_executable(&manifest_dir), None);
}
