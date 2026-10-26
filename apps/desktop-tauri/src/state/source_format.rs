// SPDX-License-Identifier: Apache-2.0
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, MutexGuard},
};

use crate::{
    platform::process_tree::{cancellation_pair, CancellationHandle, CancellationToken},
    schemas::protocol::OwnerId,
};

const MAX_ACTIVE_FORMATS: usize = 16;

struct ActiveFormat {
    id: u64,
    cancellation: CancellationHandle,
}

struct Inner {
    active: HashMap<OwnerId, ActiveFormat>,
    next_id: u64,
}

pub struct FrontendSourceFormatState {
    inner: Arc<Mutex<Inner>>,
}

pub(crate) struct SourceFormatPermit {
    inner: Arc<Mutex<Inner>>,
    owner: OwnerId,
    id: u64,
    cancellation: CancellationToken,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum BeginError {
    OwnerBusy,
    CapacityReached,
}

impl FrontendSourceFormatState {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(Inner {
                active: HashMap::new(),
                next_id: 1,
            })),
        }
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|error| error.into_inner())
    }

    pub(crate) fn begin(&self, owner: &OwnerId) -> Result<SourceFormatPermit, BeginError> {
        let mut inner = self.lock();
        if inner.active.contains_key(owner) {
            return Err(BeginError::OwnerBusy);
        }
        if inner.active.len() >= MAX_ACTIVE_FORMATS {
            return Err(BeginError::CapacityReached);
        }
        let id = inner.next_id;
        let Some(next_id) = id.checked_add(1) else {
            return Err(BeginError::CapacityReached);
        };
        inner.next_id = next_id;
        let (cancellation, token) = cancellation_pair();
        inner
            .active
            .insert(owner.clone(), ActiveFormat { id, cancellation });
        Ok(SourceFormatPermit {
            inner: Arc::clone(&self.inner),
            owner: owner.clone(),
            id,
            cancellation: token,
        })
    }

    /// Signals cancellation and leaves the slot reserved until the runner drains.
    pub fn revoke_owner(&self, owner: &OwnerId) {
        if let Some(active) = self.lock().active.get(owner) {
            active.cancellation.cancel();
        }
    }
}

impl Default for FrontendSourceFormatState {
    fn default() -> Self {
        Self::new()
    }
}

impl SourceFormatPermit {
    pub(crate) fn cancellation_token(&self) -> CancellationToken {
        self.cancellation.clone()
    }
}

impl Drop for SourceFormatPermit {
    fn drop(&mut self) {
        let mut inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        if inner
            .active
            .get(&self.owner)
            .is_some_and(|active| active.id == self.id)
        {
            inner.active.remove(&self.owner);
        }
    }
}

#[cfg(test)]
#[path = "../../tests/unit/source_format.rs"]
mod tests;
