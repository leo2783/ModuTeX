// SPDX-License-Identifier: Apache-2.0
//! Terminal DTOs, wire payloads, and error classifications (`src/schemas/terminal.rs`).

use serde::{
    de::{self, Visitor},
    Deserialize, Deserializer, Serialize,
};
use std::{error::Error, fmt};

use crate::{
    schemas::protocol::WorkspaceId,
    services::{
        filesystem::FilesystemError,
        terminal_service::{
            TerminalCleanupProof, TerminalError, TerminalErrorKind, TerminalEvent,
            TerminalEventPayload, TerminalExitReason, TerminalSessionId, TerminalSize,
            DEFAULT_MAX_INPUT_CHUNK_BYTES,
        },
    },
};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TerminalSpawnRequest {
    pub workspace_id: WorkspaceId,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TerminalInputRequest {
    pub session_id: TerminalSessionId,
    #[serde(deserialize_with = "bounded_terminal_input")]
    pub data: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TerminalResizeRequest {
    pub session_id: TerminalSessionId,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TerminalKillRequest {
    pub session_id: TerminalSessionId,
}

pub fn bounded_terminal_input<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    struct InputVisitor;

    impl<'de> Visitor<'de> for InputVisitor {
        type Value = String;

        fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            formatter.write_str("a terminal input string within the UTF-8 byte limit")
        }

        fn visit_str<E>(self, value: &str) -> Result<Self::Value, E>
        where
            E: de::Error,
        {
            validate_input_chunk(value).map_err(E::custom)?;
            Ok(value.to_owned())
        }

        fn visit_string<E>(self, value: String) -> Result<Self::Value, E>
        where
            E: de::Error,
        {
            validate_input_chunk(&value).map_err(E::custom)?;
            Ok(value)
        }
    }

    deserializer.deserialize_string(InputVisitor)
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSessionReceipt {
    pub session_id: TerminalSessionId,
    pub workspace_id: WorkspaceId,
    pub generation: u64,
    pub size: TerminalSize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalWireEvent {
    pub owner_id: String,
    pub workspace_id: WorkspaceId,
    pub session_id: TerminalSessionId,
    pub generation: u64,
    pub sequence: u64,
    pub payload: TerminalWirePayload,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum TerminalWirePayload {
    Data {
        bytes: Vec<u8>,
        text: String,
    },
    Exit {
        #[serde(rename = "exitCode")]
        exit_code: Option<u32>,
        reason: TerminalExitReason,
    },
}

impl TerminalWireEvent {
    pub fn from_event(event: TerminalEvent) -> Self {
        let payload = match event.payload {
            TerminalEventPayload::Data { bytes, text } => TerminalWirePayload::Data { bytes, text },
            TerminalEventPayload::Exit { exit_code, reason } => {
                TerminalWirePayload::Exit { exit_code, reason }
            }
        };
        Self {
            owner_id: event.owner.as_str().to_owned(),
            workspace_id: event.workspace_id,
            session_id: event.session_id,
            generation: event.generation,
            sequence: event.sequence,
            payload,
        }
    }
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum TerminalHostErrorCode {
    UntrustedWindow,
    OwnerRevoked,
    WorkspaceUnavailable,
    WorkspaceClosed,
    SessionNotFound,
    OwnerMismatch,
    InvalidRequest,
    ResourceExhausted,
    CleanupUnproven,
    Internal,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(untagged)]
pub enum TerminalCommandErrorCode {
    Host(TerminalHostErrorCode),
    Service(TerminalErrorKind),
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalCommandError {
    pub code: TerminalCommandErrorCode,
    pub detail: String,
    pub cleanup: TerminalCleanupProof,
}

impl TerminalCommandError {
    pub fn host(code: TerminalHostErrorCode, detail: impl Into<String>) -> Self {
        Self {
            code: TerminalCommandErrorCode::Host(code),
            detail: detail.into(),
            cleanup: TerminalCleanupProof::NotRequired,
        }
    }

    pub fn deferred(detail: impl Into<String>) -> Self {
        Self {
            code: TerminalCommandErrorCode::Host(TerminalHostErrorCode::CleanupUnproven),
            detail: detail.into(),
            cleanup: TerminalCleanupProof::Deferred,
        }
    }

    pub fn detail(&self) -> &str {
        &self.detail
    }

    pub fn cleanup(&self) -> TerminalCleanupProof {
        self.cleanup
    }
}

impl From<TerminalError> for TerminalCommandError {
    fn from(error: TerminalError) -> Self {
        Self {
            code: TerminalCommandErrorCode::Service(error.kind),
            detail: error.detail,
            cleanup: error.cleanup,
        }
    }
}

impl fmt::Display for TerminalCommandError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{:?}: {}", self.code, self.detail)
    }
}

impl Error for TerminalCommandError {}

pub fn map_filesystem_error(_error: FilesystemError) -> TerminalCommandError {
    TerminalCommandError::host(
        TerminalHostErrorCode::WorkspaceUnavailable,
        "workspace is not active for this owner",
    )
}

pub fn validate_input_chunk(data: &str) -> Result<(), &'static str> {
    if data.is_empty() {
        return Err("terminal input must not be empty");
    }
    if data.len() > DEFAULT_MAX_INPUT_CHUNK_BYTES {
        return Err("terminal input chunk exceeds 16 KiB");
    }
    Ok(())
}
