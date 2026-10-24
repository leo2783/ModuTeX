use super::*;
use crate::schemas::protocol::Timestamp;

#[test]
fn local_settings_are_folder_scoped_and_release_the_read_lease() {
    let directory = env::temp_dir().join(format!("modutex-format-settings-{}", Uuid::new_v4()));
    fs::create_dir(&directory).unwrap();
    let document = directory.join("main.tex");
    fs::write(&document, b"source").unwrap();
    let settings = b"defaultIndent: '  '\n";
    fs::write(directory.join(LOCAL_SETTINGS_NAME), settings).unwrap();
    let host_data = directory.join("host-data");
    let filesystem = FilesystemService::new(
        std::sync::Arc::new(crate::state::sessions::SessionRegistry::new()),
        crate::state::workspace_leases::WorkspaceLeaseCoordinator::new(),
        crate::state::recent::RecentStore::new(&host_data),
        crate::state::settings::SettingsStore::new(&host_data),
    );
    let owner = OwnerId::from_label("main").unwrap();
    let timestamp = Timestamp::new(1).unwrap();
    let file = filesystem
        .open_workspace_file(&owner, &document, timestamp)
        .unwrap()
        .opened;
    assert_eq!(
        read_local_settings(&filesystem, &owner, &file.id).unwrap(),
        None
    );
    filesystem.close_workspace(&owner, &file.id).unwrap();
    let folder = filesystem
        .open_workspace_folder(&owner, &directory, None, timestamp)
        .unwrap()
        .opened;
    assert_eq!(
        read_local_settings(&filesystem, &owner, &folder.id).unwrap(),
        Some(settings.to_vec())
    );
    let write = filesystem
        .workspace_file_write_access(&owner, &folder.id)
        .expect("format settings snapshot must release its read lease");
    drop(write);
    fs::write(
        directory.join(LOCAL_SETTINGS_NAME),
        vec![b'a'; MAX_LOCAL_SETTINGS_BYTES + 1],
    )
    .unwrap();
    assert_eq!(
        read_local_settings(&filesystem, &owner, &folder.id),
        Err(SourceFormatError::SettingsUnavailable)
    );
    filesystem.close_workspace(&owner, &folder.id).unwrap();
    assert_eq!(
        read_local_settings(&filesystem, &owner, &folder.id),
        Err(SourceFormatError::WorkspaceUnavailable)
    );
    drop(filesystem);
    fs::remove_dir_all(directory).unwrap();
}
