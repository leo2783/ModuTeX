// SPDX-License-Identifier: Apache-2.0
use super::*;
use std::collections::HashSet;

struct TempDir(PathBuf);

impl TempDir {
    fn new(tag: &str) -> Self {
        let path = std::env::temp_dir().join(format!("modutex-sessions-{tag}-{}", Uuid::new_v4()));
        fs::create_dir_all(&path).expect("create temp dir");
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn owner(label: &str) -> OwnerId {
    OwnerId::from_label(label).expect("valid owner label")
}

#[test]
fn open_and_get_return_the_registered_selection() {
    let dir = TempDir::new("open");
    let registry = SessionRegistry::new();
    let main = owner("main");
    let entry = RelativePath::parse("main.tex").expect("valid path");
    let session = registry
        .open(&main, dir.path(), Some(entry.clone()))
        .expect("open");
    assert!(session.id().as_str().is_ascii());
    assert_eq!(session.root(), dir.path());
    assert_eq!(session.entry(), Some(&entry));
    assert_eq!(session.owner(), &main);
    assert_eq!(registry.get(&main, session.id()), Ok(session));
    let folder = registry.open(&main, dir.path(), None).expect("open folder");
    assert_eq!(folder.entry(), None);
}

#[test]
fn ids_are_opaque_and_differ_between_registries() {
    let dir = TempDir::new("opaque");
    let main = owner("main");
    let first = SessionRegistry::new();
    let second = SessionRegistry::new();
    let a = first.open(&main, dir.path(), None).expect("open");
    let b = second.open(&main, dir.path(), None).expect("open");
    assert_ne!(a.id(), b.id());
    assert_eq!(second.get(&main, a.id()), Err(SessionError::UnknownSession));
}

#[test]
fn rejects_relative_missing_and_non_directory_roots() {
    let dir = TempDir::new("roots");
    let file = dir.path().join("plain.txt");
    fs::write(&file, b"x").expect("write file");
    let registry = SessionRegistry::new();
    let main = owner("main");
    assert_eq!(
        registry.open(&main, Path::new("relative/dir"), None),
        Err(SessionError::RootNotAbsolute)
    );
    assert_eq!(
        registry.open(&main, &file, None),
        Err(SessionError::RootNotDirectory)
    );
    assert_eq!(
        registry.open(&main, &dir.path().join("missing"), None),
        Err(SessionError::RootNotDirectory)
    );
    assert_eq!(registry.live_count(), 0);
}

#[test]
fn owners_cannot_read_or_close_each_others_sessions() {
    let dir = TempDir::new("isolation");
    let registry = SessionRegistry::new();
    let (a, b) = (owner("main"), owner("other"));
    let session = registry.open(&a, dir.path(), None).expect("open");
    assert_eq!(
        registry.get(&b, session.id()),
        Err(SessionError::UnknownSession)
    );
    assert_eq!(
        registry.close(&b, session.id()),
        Err(SessionError::UnknownSession)
    );
    assert_eq!(registry.get(&a, session.id()), Ok(session));
    assert_eq!(registry.live_count(), 1);
}

#[test]
fn closed_ids_are_stale_and_never_reused() {
    let dir = TempDir::new("stale");
    let registry = SessionRegistry::new();
    let main = owner("main");
    let first = registry.open(&main, dir.path(), None).expect("open");
    assert_eq!(registry.close(&main, first.id()), Ok(()));
    assert_eq!(
        registry.get(&main, first.id()),
        Err(SessionError::UnknownSession)
    );
    assert_eq!(
        registry.close(&main, first.id()),
        Err(SessionError::UnknownSession)
    );
    let mut seen = HashSet::from([first.id().clone()]);
    for _ in 0..64 {
        let session = registry.open(&main, dir.path(), None).expect("open");
        assert!(seen.insert(session.id().clone()), "ID reused");
        assert_eq!(registry.close(&main, session.id()), Ok(()));
    }
    assert_eq!(registry.live_count(), 0);
    let unknown = WorkspaceId::parse("not-a-session").expect("valid identifier");
    assert_eq!(
        registry.get(&main, &unknown),
        Err(SessionError::UnknownSession)
    );
}

#[test]
fn counter_exhaustion_is_rejected_without_wrapping() {
    let dir = TempDir::new("exhaust");
    let registry = SessionRegistry::new();
    let main = owner("main");
    registry.lock().next = Some(u64::MAX);
    let last = registry.open(&main, dir.path(), None).expect("last id");
    assert!(last.id().as_str().ends_with(&format!("-{}", u64::MAX)));
    assert_eq!(
        registry.open(&main, dir.path(), None),
        Err(SessionError::IdsExhausted)
    );
    assert_eq!(registry.close(&main, last.id()), Ok(()));
    assert_eq!(
        registry.open(&main, dir.path(), None),
        Err(SessionError::IdsExhausted)
    );
    assert_eq!(registry.live_count(), 0);
}

#[test]
fn revoke_owner_drops_only_that_owners_sessions() {
    let dir = TempDir::new("revoke");
    let registry = SessionRegistry::new();
    let (a, b) = (owner("main"), owner("other"));
    let a1 = registry.open(&a, dir.path(), None).expect("a1");
    let a2 = registry.open(&a, dir.path(), None).expect("a2");
    let b1 = registry.open(&b, dir.path(), None).expect("b1");
    assert_eq!(registry.revoke_owner(&a), 2);
    assert_eq!(registry.get(&a, a1.id()), Err(SessionError::UnknownSession));
    assert_eq!(registry.get(&a, a2.id()), Err(SessionError::UnknownSession));
    assert_eq!(registry.get(&b, b1.id()), Ok(b1));
    assert_eq!(registry.revoke_owner(&a), 0);
    let a3 = registry.open(&a, dir.path(), None).expect("a3");
    assert_ne!(a3.id(), a1.id());
    assert_ne!(a3.id(), a2.id());
    assert_eq!(registry.live_count(), 2);
}

#[test]
fn global_registry_is_shared_and_revocable() {
    let dir = TempDir::new("global");
    let owner = owner("global-test-owner");
    assert!(std::ptr::eq(registry(), registry()));
    let session = registry().open(&owner, dir.path(), None).expect("open");
    assert_eq!(registry().get(&owner, session.id()), Ok(session.clone()));
    assert_eq!(registry().revoke_owner(&owner), 1);
    assert_eq!(
        registry().get(&owner, session.id()),
        Err(SessionError::UnknownSession)
    );
}
