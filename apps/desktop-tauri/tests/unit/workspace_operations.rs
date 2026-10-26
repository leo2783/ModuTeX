// SPDX-License-Identifier: Apache-2.0
use super::*;

#[test]
fn duplicate_ids_and_cancellation_are_scoped_without_consuming_capacity() {
    let state = WorkspaceFilesState::default();
    let owner = OwnerId::from_label("main").unwrap();
    let foreign = OwnerId::from_label("other-document").unwrap();
    let workspace = WorkspaceId::parse("workspace-one").unwrap();
    let other = WorkspaceId::parse("workspace-two").unwrap();
    let id = RunId::parse("operation-one").unwrap();
    let first = state
        .register_operation(owner.clone(), workspace.clone(), id.clone())
        .unwrap();
    let second = state
        .register_operation(owner.clone(), other.clone(), id.clone())
        .unwrap();
    assert!(matches!(
        state.register_operation(owner.clone(), workspace.clone(), id.clone()),
        Err(FilesystemError::ResourceExhausted)
    ));
    state.cancel_operation(&owner, &other, &id);
    assert!(second.cancellation().load(Ordering::Acquire));
    assert!(!first.cancellation().load(Ordering::Acquire));
    state.cancel_operation(&foreign, &workspace, &id);
    assert!(!first.cancellation().load(Ordering::Acquire));
    state.cancel_operation(&owner, &workspace, &id);
    assert!(first.cancellation().load(Ordering::Acquire));
    drop(first);
    let replacement = state
        .register_operation(owner.clone(), workspace.clone(), id)
        .unwrap();
    assert!(!replacement.cancellation().load(Ordering::Acquire));
    drop(replacement);
    drop(second);
    state.quiesce_workspace(&owner, &workspace).unwrap();
    state.finish_workspace_close(&owner, &workspace);
    assert!(matches!(
        state.admit_operation(owner, workspace),
        Err(FilesystemError::SessionClosed)
    ));
}

#[test]
fn full_registry_cancels_named_operations_and_drains_before_close() {
    let state = Arc::new(WorkspaceFilesState::default());
    let owner = OwnerId::from_label("main").unwrap();
    let workspace = WorkspaceId::parse("workspace-one").unwrap();
    let unnamed = state
        .admit_operation(owner.clone(), workspace.clone())
        .unwrap();
    let mut named = Vec::new();
    for index in 1..MAX_ACTIVE_OPERATIONS_PER_WORKSPACE {
        named.push(
            state
                .register_operation(
                    owner.clone(),
                    workspace.clone(),
                    RunId::parse(&format!("operation-{index}")).unwrap(),
                )
                .unwrap(),
        );
    }
    assert!(matches!(
        state.admit_operation(owner.clone(), workspace.clone()),
        Err(FilesystemError::ResourceExhausted)
    ));
    let closing = Arc::clone(&state);
    let closing_owner = owner.clone();
    let closing_workspace = workspace.clone();
    let (sender, receiver) = std::sync::mpsc::channel();
    let worker = std::thread::spawn(move || {
        sender
            .send(closing.quiesce_workspace(&closing_owner, &closing_workspace))
            .unwrap();
    });
    let deadline = Instant::now() + Duration::from_secs(2);
    while named
        .iter()
        .any(|operation| !operation.cancellation().load(Ordering::Acquire))
    {
        assert!(
            Instant::now() < deadline,
            "named operations must receive cancellation"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(matches!(
        state.admit_operation(owner.clone(), workspace.clone()),
        Err(FilesystemError::SessionClosed)
    ));
    assert!(
        matches!(
            receiver.try_recv(),
            Err(std::sync::mpsc::TryRecvError::Empty)
        ),
        "unnamed active operations must also finish before close"
    );
    drop(named);
    drop(unnamed);
    receiver
        .recv_timeout(Duration::from_secs(2))
        .expect("close must settle after all guards drop")
        .unwrap();
    worker.join().unwrap();
    state.finish_workspace_close(&owner, &workspace);
    assert!(matches!(
        state.admit_operation(owner, workspace),
        Err(FilesystemError::SessionClosed)
    ));
}
