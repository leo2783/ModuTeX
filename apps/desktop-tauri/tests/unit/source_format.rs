use super::*;

#[test]
fn cancellation_retains_owner_admission_until_formatter_drain_finishes() {
    let state = FrontendSourceFormatState::new();
    let owner = OwnerId::from_label("main").unwrap();
    let permit = state.begin(&owner).unwrap();
    assert!(!permit.cancellation_token().is_cancelled());
    state.revoke_owner(&owner);
    assert!(permit.cancellation_token().is_cancelled());
    assert!(matches!(state.begin(&owner), Err(BeginError::OwnerBusy)));
    drop(permit);
    let next = state.begin(&owner).unwrap();
    assert!(!next.cancellation_token().is_cancelled());
}

#[test]
fn formatter_admission_is_bounded_and_releases_only_finished_owners() {
    let state = FrontendSourceFormatState::new();
    let mut permits = Vec::new();
    for index in 0..MAX_ACTIVE_FORMATS {
        let owner = OwnerId::from_label(&format!("document-{index}")).unwrap();
        permits.push(state.begin(&owner).unwrap());
    }
    let waiting = OwnerId::from_label("main").unwrap();
    assert!(matches!(
        state.begin(&waiting),
        Err(BeginError::CapacityReached)
    ));
    permits.pop();
    assert!(state.begin(&waiting).is_ok());
}
