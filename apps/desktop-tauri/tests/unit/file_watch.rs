// SPDX-License-Identifier: Apache-2.0
use super::*;
use std::sync::mpsc;

#[test]
fn validates_watch_identity_bounds_and_charset() {
    assert!(valid_watch_identity("sub_1-ok", 1));
    assert!(valid_watch_identity(
        &"a".repeat(128),
        crate::schemas::protocol::MAX_SAFE_INTEGER
    ));

    assert!(!valid_watch_identity("", 1));
    assert!(!valid_watch_identity(&"a".repeat(129), 1));
    assert!(!valid_watch_identity("sub/invalid", 1));
    assert!(!valid_watch_identity("sub_1", 0));
    assert!(!valid_watch_identity(
        "sub_1",
        crate::schemas::protocol::MAX_SAFE_INTEGER + 1
    ));
}

#[test]
fn delivery_gate_transitions_pending_active_closed_and_wakes_waiters() {
    let gate = Arc::new(WatchDeliveryGate::new());
    assert!(gate.enter().is_none());

    let waiter_gate = Arc::clone(&gate);
    let waiter = thread::spawn(move || waiter_gate.wait_until_active());

    assert!(gate.activate());
    assert!(!gate.activate());
    assert!(waiter.join().unwrap());
    assert!(gate.enter().is_some());

    gate.deactivate();
    assert!(gate.enter().is_none());
    assert!(!gate.wait_until_active());
}

#[test]
fn delivery_gate_closed_before_activation_unblocks_waiters_with_false() {
    let gate = Arc::new(WatchDeliveryGate::new());
    let waiter_gate = Arc::clone(&gate);
    let waiter = thread::spawn(move || waiter_gate.wait_until_active());

    gate.deactivate();
    assert!(!waiter.join().unwrap());
    assert!(!gate.activate());
}

#[test]
fn cleanup_permit_executes_submitted_task_and_releases_reservation_on_drop() {
    let permit = WatchCleanupPermit::reserve().expect("reserve cleanup permit");
    drop(permit);

    let (tx, rx) = mpsc::sync_channel(1);
    let permit = WatchCleanupPermit::reserve().expect("reserve second cleanup permit");
    permit.submit(move || {
        let _ = tx.send(true);
    });
    assert_eq!(rx.recv_timeout(Duration::from_secs(5)), Ok(true));
}
