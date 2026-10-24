// SPDX-License-Identifier: Apache-2.0
use std::sync::Arc;

use crate::{
    schemas::{
        protocol::{OwnerId, WorkspaceId},
        terminal::{
            TerminalInputRequest, TerminalSpawnRequest, TerminalWireEvent, TerminalWirePayload,
        },
    },
    services::terminal_service::{
        TerminalEvent, TerminalEventPayload, TerminalEventSink, TerminalExitReason,
        TerminalSessionId, TerminalSinkError, TerminalSize, DEFAULT_MAX_INPUT_CHUNK_BYTES,
        DEFAULT_MAX_OUTPUT_CHUNKS, MAX_TERMINAL_DIMENSION,
    },
    state::terminal::{lock, TerminalEventBus},
};

fn owner(label: &str) -> OwnerId {
    OwnerId::from_label(label).expect("valid test owner")
}

fn workspace(value: &str) -> WorkspaceId {
    WorkspaceId::parse(value).expect("valid test workspace")
}

fn session() -> TerminalSessionId {
    TerminalSessionId::parse("123e4567-e89b-42d3-a456-426614174000").expect("canonical UUID v4")
}

fn data_event(owner: &OwnerId, workspace: &WorkspaceId, sequence: u64) -> TerminalEvent {
    TerminalEvent {
        owner: owner.clone(),
        workspace_id: workspace.clone(),
        session_id: session(),
        generation: 7,
        sequence,
        payload: TerminalEventPayload::Data {
            bytes: vec![b'x'],
            text: "x".to_owned(),
        },
    }
}

#[test]
fn command_dtos_reject_unknown_fields_and_bound_input_before_service_dispatch() {
    let valid_spawn = serde_json::json!({
        "workspaceId": "ws-1",
        "cols": 80,
        "rows": 24
    });
    assert!(serde_json::from_value::<TerminalSpawnRequest>(valid_spawn).is_ok());

    let unknown_spawn = serde_json::json!({
        "workspaceId": "ws-1",
        "cols": 80,
        "rows": 24,
        "cwd": "C:\\outside"
    });
    assert!(serde_json::from_value::<TerminalSpawnRequest>(unknown_spawn).is_err());

    let unknown_input = serde_json::json!({
        "sessionId": session().as_str(),
        "data": "echo safe",
        "ownerId": "forged-owner"
    });
    assert!(serde_json::from_value::<TerminalInputRequest>(unknown_input).is_err());

    let max_input = serde_json::json!({
        "sessionId": session().as_str(),
        "data": "x".repeat(DEFAULT_MAX_INPUT_CHUNK_BYTES)
    });
    assert!(serde_json::from_value::<TerminalInputRequest>(max_input).is_ok());

    let oversized_input = serde_json::json!({
        "sessionId": session().as_str(),
        "data": "x".repeat(DEFAULT_MAX_INPUT_CHUNK_BYTES + 1)
    });
    assert!(serde_json::from_value::<TerminalInputRequest>(oversized_input).is_err());
}

#[test]
fn dimensions_and_session_ids_are_validated_at_the_wire_boundary() {
    assert!(TerminalSize::new(1, 1).is_ok());
    assert!(TerminalSize::new(MAX_TERMINAL_DIMENSION, MAX_TERMINAL_DIMENSION).is_ok());
    assert!(TerminalSize::new(0, 24).is_err());
    assert!(TerminalSize::new(MAX_TERMINAL_DIMENSION + 1, 24).is_err());

    assert!(
        serde_json::from_str::<TerminalSessionId>("\"123e4567-e89b-42d3-a456-426614174000\"")
            .is_ok()
    );
    assert!(serde_json::from_str::<TerminalSessionId>("\"not-a-session-id\"").is_err());
    assert!(
        serde_json::from_str::<TerminalSessionId>("\"123E4567-E89B-42D3-A456-426614174000\"")
            .is_err()
    );
}

#[test]
fn event_sink_stages_pre_registration_events_and_rejects_foreign_routes() {
    let bus = Arc::new(TerminalEventBus::new());
    let trusted = owner("main");
    let other = owner("secondary");
    let workspace_id = workspace("ws-1");
    let _admission = bus
        .reserve_spawn(trusted.clone(), workspace_id.clone())
        .expect("bounded spawn admission");

    assert_eq!(bus.emit(data_event(&trusted, &workspace_id, 1)), Ok(()));
    assert!(bus.output.drain_for_owner(&trusted).is_empty());
    assert_eq!(lock(&bus.staged).events.len(), 1);

    assert_eq!(
        bus.emit(data_event(&other, &workspace_id, 1)),
        Err(TerminalSinkError::Disconnected)
    );
    assert_eq!(
        bus.emit(data_event(&trusted, &workspace("ws-2"), 2)),
        Err(TerminalSinkError::Disconnected)
    );

    assert!(bus.fence_owner(&trusted));
    assert!(lock(&bus.staged).events.is_empty());
    assert_eq!(
        bus.emit(data_event(&trusted, &workspace_id, 3)),
        Err(TerminalSinkError::Disconnected)
    );
}

#[test]
fn pending_event_storage_is_bounded_and_reports_backpressure() {
    let bus = Arc::new(TerminalEventBus::new());
    let trusted = owner("main");
    let workspace_id = workspace("ws-1");
    let _admission = bus
        .reserve_spawn(trusted.clone(), workspace_id.clone())
        .expect("bounded spawn admission");

    for sequence in 1..=DEFAULT_MAX_OUTPUT_CHUNKS as u64 {
        assert_eq!(
            bus.emit(data_event(&trusted, &workspace_id, sequence)),
            Ok(())
        );
    }
    assert_eq!(
        bus.emit(data_event(
            &trusted,
            &workspace_id,
            DEFAULT_MAX_OUTPUT_CHUNKS as u64 + 1
        )),
        Err(TerminalSinkError::Backpressure)
    );
}

#[test]
fn terminal_wire_event_serializes_with_camel_case_exit_code() {
    let wire = TerminalWireEvent {
        owner_id: "main".to_owned(),
        workspace_id: WorkspaceId::parse("ws-1").expect("valid workspace"),
        session_id: TerminalSessionId::parse("123e4567-e89b-42d3-a456-426614174000")
            .expect("valid session id"),
        generation: 7,
        sequence: 1,
        payload: TerminalWirePayload::Exit {
            exit_code: Some(0),
            reason: TerminalExitReason::GracefulExit,
        },
    };
    let serialized = serde_json::to_string(&wire).expect("serialize wire event");
    let expected = r#"{"ownerId":"main","workspaceId":"ws-1","sessionId":"123e4567-e89b-42d3-a456-426614174000","generation":7,"sequence":1,"payload":{"type":"exit","exitCode":0,"reason":"GRACEFUL_EXIT"}}"#;
    assert_eq!(serialized, expected);
}

#[test]
fn terminal_wire_event_from_event_serializes_exit_and_data_correctly() {
    let exit_event = TerminalEvent {
        owner: OwnerId::from_label("main").expect("valid owner"),
        workspace_id: WorkspaceId::parse("ws-1").expect("valid workspace"),
        session_id: TerminalSessionId::parse("123e4567-e89b-42d3-a456-426614174000")
            .expect("valid session id"),
        generation: 7,
        sequence: 2,
        payload: TerminalEventPayload::Exit {
            exit_code: None,
            reason: TerminalExitReason::KilledByOwner,
        },
    };
    let exit_wire = TerminalWireEvent::from_event(exit_event);
    let exit_json = serde_json::to_string(&exit_wire).expect("serialize exit event");
    let expected_exit = r#"{"ownerId":"main","workspaceId":"ws-1","sessionId":"123e4567-e89b-42d3-a456-426614174000","generation":7,"sequence":2,"payload":{"type":"exit","exitCode":null,"reason":"KILLED_BY_OWNER"}}"#;
    assert_eq!(exit_json, expected_exit);

    let data_event = TerminalEvent {
        owner: OwnerId::from_label("main").expect("valid owner"),
        workspace_id: WorkspaceId::parse("ws-1").expect("valid workspace"),
        session_id: TerminalSessionId::parse("123e4567-e89b-42d3-a456-426614174000")
            .expect("valid session id"),
        generation: 7,
        sequence: 3,
        payload: TerminalEventPayload::Data {
            bytes: vec![120],
            text: "x".to_owned(),
        },
    };
    let data_wire = TerminalWireEvent::from_event(data_event);
    let data_json = serde_json::to_string(&data_wire).expect("serialize data event");
    let expected_data = r#"{"ownerId":"main","workspaceId":"ws-1","sessionId":"123e4567-e89b-42d3-a456-426614174000","generation":7,"sequence":3,"payload":{"type":"data","bytes":[120],"text":"x"}}"#;
    assert_eq!(data_json, expected_data);
}
