// SPDX-License-Identifier: Apache-2.0
use super::*;
use crate::schemas::protocol::{DocumentId, DocumentVersion};

struct TestClock {
    base: Instant,
    offset: Mutex<Duration>,
}

impl TestClock {
    fn new() -> Self {
        Self {
            base: Instant::now(),
            offset: Mutex::new(Duration::ZERO),
        }
    }

    fn advance(&self, delta: Duration) {
        let mut offset = self.offset.lock().unwrap();
        *offset += delta;
    }
}

impl Clock for TestClock {
    fn now(&self) -> Instant {
        self.base + *self.offset.lock().unwrap()
    }
}

fn sample_pdf(size: usize) -> Vec<u8> {
    let mut bytes = b"%PDF-1.7\n".to_vec();
    if bytes.len() < size {
        bytes.resize(size, b'0');
    }
    bytes
}

fn sample_identity(workspace_id: &str, run_id: &str) -> CompileIdentity {
    CompileIdentity {
        workspace_id: WorkspaceId::parse(workspace_id).unwrap(),
        run_id: RunId::parse(run_id).unwrap(),
        entry_path: RelativePath::parse("main.tex").unwrap(),
        document_id: DocumentId::parse("doc-1").unwrap(),
        document_version: DocumentVersion::new(1).unwrap(),
        saved_revision: Revision::parse("rev-1").unwrap(),
    }
}

#[test]
fn rejects_zero_lifetime_configuration() {
    let limits = TokenLimits {
        lifetime: Duration::ZERO,
        ..TokenLimits::default()
    };
    assert_eq!(
        BinaryTokenStore::new(limits).err(),
        Some(TokenStoreConfigError::ZeroLifetime)
    );
}

#[test]
fn enforces_admission_limits_across_owners_workspaces_and_runs() {
    let clock = Arc::new(TestClock::new());
    let store = BinaryTokenStore::with_admission_limits(
        TokenLimits::default(),
        AdmissionLimits {
            max_active_owners: 1,
            max_active_workspaces_per_owner: 1,
            max_active_workspaces_global: 1,
            max_active_runs_per_workspace: 1,
            max_active_runs_per_owner: 1,
            max_active_runs_global: 1,
        },
        clock,
    )
    .unwrap();

    let owner1 = store
        .admit_owner_generation(OwnerId::from_label("main").unwrap())
        .unwrap();
    assert_eq!(
        store
            .admit_owner_generation(OwnerId::from_label("secondary").unwrap())
            .err(),
        Some(AdmissionError::CapacityExceeded(AdmissionCapacity::Owners))
    );

    let ws1 = store
        .admit_workspace_generation(&owner1, WorkspaceId::parse("ws-1").unwrap())
        .unwrap();
    assert_eq!(
        store
            .admit_workspace_generation(&owner1, WorkspaceId::parse("ws-2").unwrap())
            .err(),
        Some(AdmissionError::CapacityExceeded(
            AdmissionCapacity::WorkspacesPerOwner
        ))
    );

    assert_eq!(
        store
            .admit_compile_run(&ws1, sample_identity("ws-2", "run-mismatch"))
            .err(),
        Some(AdmissionError::WorkspaceMismatch)
    );

    let run1 = store
        .admit_compile_run(&ws1, sample_identity("ws-1", "run-1"))
        .unwrap();
    assert_eq!(
        store
            .admit_compile_run(&ws1, sample_identity("ws-1", "run-1"))
            .err(),
        Some(AdmissionError::RunAlreadyActive)
    );
    assert_eq!(
        store
            .admit_compile_run(&ws1, sample_identity("ws-1", "run-2"))
            .err(),
        Some(AdmissionError::CapacityExceeded(
            AdmissionCapacity::RunsPerWorkspace
        ))
    );

    assert!(store.revoke_compile_run(&run1));
    assert!(!store.revoke_compile_run(&run1));
}

#[test]
fn validates_pdf_inputs_and_enforces_single_use_and_kind_isolation() {
    let clock = Arc::new(TestClock::new());
    let store = BinaryTokenStore::with_admission_limits(
        TokenLimits {
            lifetime: Duration::from_secs(30),
            ..TokenLimits::default()
        },
        AdmissionLimits::default(),
        Arc::clone(&clock) as Arc<dyn Clock>,
    )
    .unwrap();

    let owner = store
        .admit_owner_generation(OwnerId::from_label("main").unwrap())
        .unwrap();
    let other_owner = store
        .admit_owner_generation(OwnerId::from_label("other").unwrap())
        .unwrap();
    let ws = store
        .admit_workspace_generation(&owner, WorkspaceId::parse("ws-1").unwrap())
        .unwrap();
    let run = store
        .admit_compile_run(&ws, sample_identity("ws-1", "run-1"))
        .unwrap();

    assert_eq!(
        store
            .issue_file_read_pdf(
                &ws,
                RelativePath::parse("notes.txt").unwrap(),
                Revision::parse("rev-1").unwrap(),
                sample_pdf(32),
            )
            .err(),
        Some(IssueError::NotPdfPath)
    );
    assert_eq!(
        store
            .issue_file_read_pdf(
                &ws,
                RelativePath::parse("paper.pdf").unwrap(),
                Revision::parse("rev-1").unwrap(),
                b"not-a-pdf".to_vec(),
            )
            .err(),
        Some(IssueError::InvalidPdfHeader)
    );

    let file_token = store
        .issue_file_read_pdf(
            &ws,
            RelativePath::parse("paper.pdf").unwrap(),
            Revision::parse("rev-1").unwrap(),
            sample_pdf(64),
        )
        .unwrap();
    let compile_token = store.issue_compile_pdf(&run, sample_pdf(96)).unwrap();

    // Cross-kind and cross-owner takes are denied without consuming the valid ticket.
    assert_eq!(
        store.take_compile_pdf(&owner, &file_token.to_wire()),
        Err(TokenDenied)
    );
    assert_eq!(
        store.take_file_pdf(&other_owner, &file_token.to_wire()),
        Err(TokenDenied)
    );

    // First take succeeds; second take is denied (single-use).
    let file_bytes = store.take_file_pdf(&owner, &file_token.to_wire()).unwrap();
    assert_eq!(file_bytes.len(), 64);
    assert_eq!(
        store.take_file_pdf(&owner, &file_token.to_wire()),
        Err(TokenDenied)
    );

    let compile_bytes = store
        .take_compile_pdf(&owner, &compile_token.to_wire())
        .unwrap();
    assert_eq!(compile_bytes.len(), 96);
    assert_eq!(
        store.take_compile_pdf(&owner, &compile_token.to_wire()),
        Err(TokenDenied)
    );
}

#[test]
fn expires_and_revokes_outstanding_tickets() {
    let clock = Arc::new(TestClock::new());
    let store = BinaryTokenStore::with_admission_limits(
        TokenLimits {
            lifetime: Duration::from_secs(10),
            max_owner_tickets: 2,
            ..TokenLimits::default()
        },
        AdmissionLimits::default(),
        Arc::clone(&clock) as Arc<dyn Clock>,
    )
    .unwrap();

    let owner = store
        .admit_owner_generation(OwnerId::from_label("main").unwrap())
        .unwrap();
    let ws = store
        .admit_workspace_generation(&owner, WorkspaceId::parse("ws-1").unwrap())
        .unwrap();

    let expiring = store
        .issue_file_read_pdf(
            &ws,
            RelativePath::parse("a.pdf").unwrap(),
            Revision::parse("rev-1").unwrap(),
            sample_pdf(32),
        )
        .unwrap();
    clock.advance(Duration::from_secs(11));
    assert_eq!(
        store.take_file_pdf(&owner, &expiring.to_wire()),
        Err(TokenDenied)
    );

    let revocable = store
        .issue_file_read_pdf(
            &ws,
            RelativePath::parse("b.pdf").unwrap(),
            Revision::parse("rev-2").unwrap(),
            sample_pdf(32),
        )
        .unwrap();
    assert!(store.revoke_workspace_generation(&ws));
    assert_eq!(
        store.take_file_pdf(&owner, &revocable.to_wire()),
        Err(TokenDenied)
    );
}
