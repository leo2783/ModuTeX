// SPDX-License-Identifier: Apache-2.0
//! Host-only, process-memory tickets for the frontend's PDF binary routes.
//!
//! Integration pending: a trusted window coordinator must admit each owner generation once and
//! admit workspaces only after its own owner/session check; handlers retain the opaque capabilities.
//! PDF handlers move owned bytes into this store and use the current owner capability for takes.
//! Lifecycle cleanup must revoke workspace/run/owner generations; this mutex does not make external
//! SessionRegistry or compile-registry liveness checks atomic.

use std::{
	collections::{hash_map::Entry, HashMap},
	error::Error,
	fmt,
	sync::{Arc, Mutex, MutexGuard, PoisonError},
	time::{Duration, Instant}
};

use uuid::Uuid;

use crate::{
	schemas::protocol::{CompileIdentity, OwnerId, Revision, RunId, WorkspaceId, MAX_PDF_BYTES},
	shared::relative_path::RelativePath
};

/// Per-owner and process-wide limits for live PDF tickets.
#[derive(Clone, Copy, Debug)]
pub(crate) struct TokenLimits {
	pub(crate) max_owner_bytes: usize,
	pub(crate) max_global_bytes: usize,
	pub(crate) max_owner_tickets: usize,
	pub(crate) max_global_tickets: usize,
	pub(crate) lifetime: Duration
}

impl Default for TokenLimits {
	fn default() -> Self {
		Self {
			max_owner_bytes: 64 * 1024 * 1024,
			max_global_bytes: 128 * 1024 * 1024,
			max_owner_tickets: 8,
			max_global_tickets: 256,
			lifetime: Duration::from_secs(120)
		}
	}
}

/// Bounds the live host-issued owner, workspace, and compile-run admissions.
/// Re-admitting an existing owner or workspace replaces its current scope.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct AdmissionLimits {
	pub(crate) max_active_owners: usize,
	pub(crate) max_active_workspaces_per_owner: usize,
	pub(crate) max_active_workspaces_global: usize,
	pub(crate) max_active_runs_per_workspace: usize,
	pub(crate) max_active_runs_per_owner: usize,
	pub(crate) max_active_runs_global: usize
}

impl Default for AdmissionLimits {
	fn default() -> Self {
		Self {
			max_active_owners: 64,
			max_active_workspaces_per_owner: 64,
			max_active_workspaces_global: 1024,
			max_active_runs_per_workspace: 8,
			max_active_runs_per_owner: 32,
			max_active_runs_global: 256
		}
	}
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum TokenStoreConfigError {
	ZeroLifetime
}

impl fmt::Display for TokenStoreConfigError {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		f.write_str("binary token lifetime must be finite and nonzero")
	}
}

impl Error for TokenStoreConfigError {}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum AdmissionCapacity {
	Owners,
	WorkspacesPerOwner,
	WorkspacesGlobal,
	RunsPerWorkspace,
	RunsPerOwner,
	RunsGlobal
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum AdmissionError {
	StaleOwner,
	StaleWorkspace,
	WorkspaceMismatch,
	RunAlreadyActive,
	GenerationExhausted,
	CapacityExceeded(AdmissionCapacity)
}

impl fmt::Display for AdmissionError {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		f.write_str(match self {
			Self::StaleOwner => "owner generation is no longer active",
			Self::StaleWorkspace => "workspace generation is no longer active",
			Self::WorkspaceMismatch => "compile identity belongs to another workspace",
			Self::RunAlreadyActive => "compile run is already admitted",
			Self::GenerationExhausted => "binary token generations are exhausted",
			Self::CapacityExceeded(AdmissionCapacity::Owners) =>
				"active owner admission capacity exceeded",
			Self::CapacityExceeded(AdmissionCapacity::WorkspacesPerOwner) =>
				"per-owner workspace admission capacity exceeded",
			Self::CapacityExceeded(AdmissionCapacity::WorkspacesGlobal) =>
				"global workspace admission capacity exceeded",
			Self::CapacityExceeded(AdmissionCapacity::RunsPerWorkspace) =>
				"per-workspace compile admission capacity exceeded",
			Self::CapacityExceeded(AdmissionCapacity::RunsPerOwner) =>
				"per-owner compile admission capacity exceeded",
			Self::CapacityExceeded(AdmissionCapacity::RunsGlobal) =>
				"global compile admission capacity exceeded"
		})
	}
}

impl Error for AdmissionError {}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum IssueError {
	NotPdfPath,
	InvalidPdfHeader,
	PdfTooLarge,
	StaleWorkspace,
	StaleRun,
	CapacityExceeded,
	ExpiryOverflow,
	TokenCollision
}

impl fmt::Display for IssueError {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		f.write_str(match self {
			Self::NotPdfPath => "file-read ticket requires a PDF path",
			Self::InvalidPdfHeader => "missing PDF header",
			Self::PdfTooLarge => "PDF byte limit exceeded",
			Self::StaleWorkspace => "workspace generation is no longer active",
			Self::StaleRun => "compile run is no longer active",
			Self::CapacityExceeded => "binary token capacity exceeded",
			Self::ExpiryOverflow => "binary token expiry is out of range",
			Self::TokenCollision => "binary token collision"
		})
	}
}

impl Error for IssueError {}

/// Deliberately identical for malformed, unknown, expired, revoked, wrong-owner,
/// wrong-kind, and stale-generation tokens.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct TokenDenied;

impl fmt::Display for TokenDenied {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		f.write_str("binary PDF token unavailable")
	}
}

impl Error for TokenDenied {}

/// Opaque UUIDv4 bearer token. It has no serde implementation or public constructor.
#[derive(Clone, Copy, Eq, Hash, PartialEq)]
pub(crate) struct BinaryToken(Uuid);

impl BinaryToken {
	pub(crate) fn to_wire(self) -> String {
		self.0.hyphenated().to_string()
	}
}

/// Opaque capability for one trusted window lifetime; it is never renderer-deserializable.
#[derive(Clone)]
pub(crate) struct OwnerAdmission {
	store_id: Uuid,
	owner: OwnerId,
	generation: Generation
}

/// Opaque capability for one owner-bound workspace lifetime.
#[derive(Clone)]
pub(crate) struct WorkspaceAdmission {
	owner: OwnerAdmission,
	workspace_id: WorkspaceId,
	generation: Generation
}

impl WorkspaceAdmission {
	pub(crate) fn workspace_id(&self) -> &WorkspaceId {
		&self.workspace_id
	}

	fn key(&self) -> WorkspaceKey {
		WorkspaceKey {
			owner: self.owner.owner.clone(),
			owner_generation: self.owner.generation,
			workspace_id: self.workspace_id.clone()
		}
	}

	fn scope_key(&self) -> ScopeKey {
		ScopeKey {
			key: self.key(),
			workspace_generation: self.generation
		}
	}
}

/// Opaque capability for one host-admitted compile identity.
#[derive(Clone)]
pub(crate) struct CompileRunAdmission {
	workspace: WorkspaceAdmission,
	identity: CompileIdentity,
	generation: Generation
}

impl CompileRunAdmission {
	pub(crate) fn identity(&self) -> &CompileIdentity {
		&self.identity
	}

	fn key(&self) -> RunKey {
		RunKey {
			scope: self.workspace.scope_key(),
			run_id: self.identity.run_id.clone()
		}
	}
}

trait Clock: Send + Sync {
	fn now(&self) -> Instant;
}

struct MonotonicClock;

impl Clock for MonotonicClock {
	fn now(&self) -> Instant {
		Instant::now()
	}
}

/// Stores only host-issued, single-use PDF snapshots; it performs no filesystem or process I/O.
pub(crate) struct BinaryTokenStore {
	store_id: Uuid,
	limits: TokenLimits,
	admission_limits: AdmissionLimits,
	clock: Arc<dyn Clock>,
	state: Mutex<State>
}

impl BinaryTokenStore {
	pub(crate) fn new(limits: TokenLimits) -> Result<Self, TokenStoreConfigError> {
		Self::with_admission_limits(limits, AdmissionLimits::default(), Arc::new(MonotonicClock))
	}

	#[cfg(test)]
	fn with_clock(
		limits: TokenLimits,
		clock: Arc<dyn Clock>
	) -> Result<Self, TokenStoreConfigError> {
		Self::with_admission_limits(limits, AdmissionLimits::default(), clock)
	}

	fn with_admission_limits(
		limits: TokenLimits,
		admission_limits: AdmissionLimits,
		clock: Arc<dyn Clock>
	) -> Result<Self, TokenStoreConfigError> {
		if limits.lifetime.is_zero() {
			return Err(TokenStoreConfigError::ZeroLifetime);
		}
		Ok(Self {
			store_id: Uuid::new_v4(),
			limits,
			admission_limits,
			clock,
			state: Mutex::new(State::new())
		})
	}

	fn lock(&self) -> MutexGuard<'_, State> {
		self.state.lock().unwrap_or_else(PoisonError::into_inner)
	}

	fn owner_is_current(&self, state: &State, owner: &OwnerAdmission) -> bool {
		owner.store_id == self.store_id
			&& state.owner_generations.get(&owner.owner).copied() == Some(owner.generation)
	}

	fn workspace_is_current(&self, state: &State, workspace: &WorkspaceAdmission) -> bool {
		self.owner_is_current(state, &workspace.owner)
			&& state.workspace_generations.get(&workspace.key()).copied()
				== Some(workspace.generation)
	}

	fn run_is_current(&self, state: &State, run: &CompileRunAdmission) -> bool {
		if !self.workspace_is_current(state, &run.workspace) {
			return false;
		}
		let key = run.key();
		state.runs.get(&key).is_some_and(|record| {
			record.generation == run.generation && &record.identity == &run.identity
		})
	}

	/// Called only by trusted window-lifecycle coordination, never by a renderer command.
	/// Each call rotates the owner's generation and revokes all older scoped tickets.
	pub(crate) fn admit_owner_generation(
		&self,
		owner: OwnerId
	) -> Result<OwnerAdmission, AdmissionError> {
		let mut state = self.lock();
		if !state.owner_generations.contains_key(&owner)
			&& state.owner_generations.len() >= self.admission_limits.max_active_owners
		{
			return Err(AdmissionError::CapacityExceeded(AdmissionCapacity::Owners));
		}
		let generation = state.allocate_generation()?;
		state.invalidate_owner(&owner);
		state.owner_generations.insert(owner.clone(), generation);
		Ok(OwnerAdmission {
			store_id: self.store_id,
			owner,
			generation
		})
	}

	/// Call only after trusted coordination has verified the owner/workspace session.
	/// Re-admitting the same workspace ID creates a fresh generation and removes old tickets.
	pub(crate) fn admit_workspace_generation(
		&self,
		owner: &OwnerAdmission,
		workspace_id: WorkspaceId
	) -> Result<WorkspaceAdmission, AdmissionError> {
		let mut state = self.lock();
		if !self.owner_is_current(&state, owner) {
			return Err(AdmissionError::StaleOwner);
		}
		let key = WorkspaceKey {
			owner: owner.owner.clone(),
			owner_generation: owner.generation,
			workspace_id: workspace_id.clone()
		};
		if !state.workspace_generations.contains_key(&key) {
			if state.active_workspaces_for_owner(owner)
				>= self.admission_limits.max_active_workspaces_per_owner
			{
				return Err(AdmissionError::CapacityExceeded(
					AdmissionCapacity::WorkspacesPerOwner
				));
			}
			if state.workspace_generations.len()
				>= self.admission_limits.max_active_workspaces_global
			{
				return Err(AdmissionError::CapacityExceeded(
					AdmissionCapacity::WorkspacesGlobal
				));
			}
		}
		let generation = state.allocate_generation()?;
		state.invalidate_workspace(&key);
		state.workspace_generations.insert(key, generation);
		Ok(WorkspaceAdmission {
			owner: owner.clone(),
			workspace_id,
			generation
		})
	}

	/// Admits the exact host-owned identity before a compile can publish a PDF ticket.
	pub(crate) fn admit_compile_run(
		&self,
		workspace: &WorkspaceAdmission,
		identity: CompileIdentity
	) -> Result<CompileRunAdmission, AdmissionError> {
		let mut state = self.lock();
		if !self.workspace_is_current(&state, workspace) {
			return Err(AdmissionError::StaleWorkspace);
		}
		if identity.workspace_id != workspace.workspace_id {
			return Err(AdmissionError::WorkspaceMismatch);
		}
		let scope = workspace.scope_key();
		let key = RunKey {
			scope: scope.clone(),
			run_id: identity.run_id.clone()
		};
		if state.runs.contains_key(&key) {
			return Err(AdmissionError::RunAlreadyActive);
		}
		if state.active_runs_for_workspace(&scope)
			>= self.admission_limits.max_active_runs_per_workspace
		{
			return Err(AdmissionError::CapacityExceeded(
				AdmissionCapacity::RunsPerWorkspace
			));
		}
		if state.active_runs_for_owner(&workspace.owner)
			>= self.admission_limits.max_active_runs_per_owner
		{
			return Err(AdmissionError::CapacityExceeded(
				AdmissionCapacity::RunsPerOwner
			));
		}
		if state.runs.len() >= self.admission_limits.max_active_runs_global {
			return Err(AdmissionError::CapacityExceeded(
				AdmissionCapacity::RunsGlobal
			));
		}
		let generation = state.allocate_generation()?;
		state.runs.insert(
			key,
			RunRecord {
				generation,
				identity: identity.clone()
			}
		);
		Ok(CompileRunAdmission {
			workspace: workspace.clone(),
			identity,
			generation
		})
	}

	pub(crate) fn revoke_owner_generation(&self, owner: &OwnerAdmission) -> bool {
		let mut state = self.lock();
		if !self.owner_is_current(&state, owner) {
			return false;
		}
		state.invalidate_owner(&owner.owner);
		true
	}

	pub(crate) fn revoke_workspace_generation(&self, workspace: &WorkspaceAdmission) -> bool {
		let mut state = self.lock();
		if !self.workspace_is_current(&state, workspace) {
			return false;
		}
		state.invalidate_workspace(&workspace.key());
		true
	}

	pub(crate) fn revoke_compile_run(&self, run: &CompileRunAdmission) -> bool {
		let mut state = self.lock();
		if !self.run_is_current(&state, run) {
			return false;
		}
		state.invalidate_run(&run.key(), run.generation, &run.identity);
		true
	}

	/// Publishes a moved file-read snapshot bound to this workspace, path, and disk revision.
	pub(crate) fn issue_file_read_pdf(
		&self,
		workspace: &WorkspaceAdmission,
		path: RelativePath,
		revision: Revision,
		bytes: Vec<u8>
	) -> Result<BinaryToken, IssueError> {
		validate_pdf(&bytes)?;
		if !is_pdf_path(&path) {
			return Err(IssueError::NotPdfPath);
		}
		self.publish(PendingTicket::FileRead {
			workspace,
			path,
			revision
		}, bytes)
	}

	/// Publishes a moved PDF snapshot bound to the entire admitted compile identity.
	pub(crate) fn issue_compile_pdf(
		&self,
		run: &CompileRunAdmission,
		bytes: Vec<u8>
	) -> Result<BinaryToken, IssueError> {
		validate_pdf(&bytes)?;
		self.publish(PendingTicket::Compile { run }, bytes)
	}

	pub(crate) fn take_file_pdf(
		&self,
		owner: &OwnerAdmission,
		wire_token: &str
	) -> Result<Vec<u8>, TokenDenied> {
		self.take(owner, wire_token, TokenKind::FileRead)
	}

	pub(crate) fn take_compile_pdf(
		&self,
		owner: &OwnerAdmission,
		wire_token: &str
	) -> Result<Vec<u8>, TokenDenied> {
		self.take(owner, wire_token, TokenKind::Compile)
	}

	fn publish(
		&self,
		pending: PendingTicket<'_>,
		bytes: Vec<u8>
	) -> Result<BinaryToken, IssueError> {
		let (workspace, binding, run) = match pending {
			PendingTicket::FileRead {
				workspace,
				path,
				revision
			} => (
				workspace,
				TicketBinding::FileRead { path, revision },
				None
			),
			PendingTicket::Compile { run } => (
				&run.workspace,
				TicketBinding::Compile {
					identity: run.identity.clone(),
					run_generation: run.generation
				},
				Some(run)
			)
		};

		let scope = workspace.scope_key();
		let mut state = self.lock();
		let now = self.clock.now();
		state.purge_expired(now);
		let expires_at = now
			.checked_add(self.limits.lifetime)
			.ok_or(IssueError::ExpiryOverflow)?;
		if !self.workspace_is_current(&state, workspace) {
			return Err(IssueError::StaleWorkspace);
		}
		if let Some(run) = run {
			if !self.run_is_current(&state, run) {
				return Err(IssueError::StaleRun);
			}
		}

		let accounted_bytes = bytes.capacity();
		let owner = scope.key.owner.clone();
		let next_owner = state
			.owner_usage
			.get(&owner)
			.copied()
			.unwrap_or_default()
			.checked_add(accounted_bytes)
			.ok_or(IssueError::CapacityExceeded)?;
		let next_global = state
			.total_usage
			.checked_add(accounted_bytes)
			.ok_or(IssueError::CapacityExceeded)?;
		if next_owner.bytes > self.limits.max_owner_bytes
			|| next_owner.tickets > self.limits.max_owner_tickets
			|| next_global.bytes > self.limits.max_global_bytes
			|| next_global.tickets > self.limits.max_global_tickets
		{
			return Err(IssueError::CapacityExceeded);
		}

		let token = Uuid::new_v4();
		match state.tickets.entry(token) {
			Entry::Occupied(_) => return Err(IssueError::TokenCollision),
			Entry::Vacant(entry) => {
				entry.insert(Ticket {
					scope,
					binding,
					bytes,
					accounted_bytes,
					expires_at
				});
			}
		}
		state.owner_usage.insert(owner, next_owner);
		state.total_usage = next_global;
		Ok(BinaryToken(token))
	}

	fn take(
		&self,
		owner: &OwnerAdmission,
		wire_token: &str,
		kind: TokenKind
	) -> Result<Vec<u8>, TokenDenied> {
		let token = parse_token(wire_token).ok_or(TokenDenied)?;
		let mut state = self.lock();
		let now = self.clock.now();
		state.purge_expired(now);
		if !self.owner_is_current(&state, owner) {
			return Err(TokenDenied);
		}
		let authorized = state.tickets.get(&token).is_some_and(|ticket| {
			if ticket.scope.key.owner.as_str() != owner.owner.as_str()
				|| ticket.scope.key.owner_generation != owner.generation
				|| !scope_is_current(&state, &ticket.scope)
			{
				return false;
			}
			match (kind, &ticket.binding) {
				(TokenKind::FileRead, TicketBinding::FileRead { .. }) => true,
				(TokenKind::Compile, TicketBinding::Compile { identity, .. }) => {
					identity.workspace_id == ticket.scope.key.workspace_id
						&& compile_ticket_is_current(&state, ticket)
				}
				_ => false
			}
		});
		if !authorized {
			return Err(TokenDenied);
		}
		let ticket = state.remove_ticket(&token).ok_or(TokenDenied)?;
		Ok(ticket.bytes)
	}
}

fn validate_pdf(bytes: &[u8]) -> Result<(), IssueError> {
	if bytes.len() > MAX_PDF_BYTES {
		return Err(IssueError::PdfTooLarge);
	}
	if !bytes.starts_with(b"%PDF-") {
		return Err(IssueError::InvalidPdfHeader);
	}
	Ok(())
}

fn is_pdf_path(path: &RelativePath) -> bool {
	path.as_str()
		.rsplit_once('.')
		.is_some_and(|(_, extension)| extension.eq_ignore_ascii_case("pdf"))
}

fn parse_token(wire_token: &str) -> Option<Uuid> {
	let token = Uuid::parse_str(wire_token).ok()?;
	(token.get_version_num() == 4 && token.hyphenated().to_string() == wire_token)
		.then_some(token)
}

fn scope_is_current(state: &State, scope: &ScopeKey) -> bool {
	state.owner_generations.get(&scope.key.owner).copied()
		== Some(scope.key.owner_generation)
		&& state.workspace_generations.get(&scope.key).copied()
			== Some(scope.workspace_generation)
}

fn compile_ticket_is_current(state: &State, ticket: &Ticket) -> bool {
	let TicketBinding::Compile {
		identity,
		run_generation
	} = &ticket.binding
	else {
		return false;
	};
	if identity.workspace_id != ticket.scope.key.workspace_id {
		return false;
	}
	let key = RunKey {
		scope: ticket.scope.clone(),
		run_id: identity.run_id.clone()
	};
	state.runs.get(&key).is_some_and(|record| {
		record.generation == *run_generation && &record.identity == identity
	})
}

enum PendingTicket<'a> {
	FileRead {
		workspace: &'a WorkspaceAdmission,
		path: RelativePath,
		revision: Revision
	},
	Compile {
		run: &'a CompileRunAdmission
	}
}

#[derive(Clone, Copy)]
enum TokenKind {
	FileRead,
	Compile
}

#[derive(Debug, Eq, PartialEq)]
enum TicketBinding {
	FileRead {
		path: RelativePath,
		revision: Revision
	},
	Compile {
		identity: CompileIdentity,
		run_generation: Generation
	}
}

struct Ticket {
	scope: ScopeKey,
	binding: TicketBinding,
	bytes: Vec<u8>,
	accounted_bytes: usize,
	expires_at: Instant
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
struct Generation(u64);

#[derive(Clone, Eq, Hash, PartialEq)]
struct WorkspaceKey {
	owner: OwnerId,
	owner_generation: Generation,
	workspace_id: WorkspaceId
}

#[derive(Clone, Eq, Hash, PartialEq)]
struct ScopeKey {
	key: WorkspaceKey,
	workspace_generation: Generation
}

#[derive(Clone, Eq, Hash, PartialEq)]
struct RunKey {
	scope: ScopeKey,
	run_id: RunId
}

struct RunRecord {
	generation: Generation,
	identity: CompileIdentity
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
struct Usage {
	bytes: usize,
	tickets: usize
}

impl Usage {
	fn checked_add(self, bytes: usize) -> Option<Self> {
		Some(Self {
			bytes: self.bytes.checked_add(bytes)?,
			tickets: self.tickets.checked_add(1)?
		})
	}

	fn checked_remove(self, bytes: usize) -> Option<Self> {
		Some(Self {
			bytes: self.bytes.checked_sub(bytes)?,
			tickets: self.tickets.checked_sub(1)?
		})
	}

	fn saturating_add(self, bytes: usize) -> Self {
		Self {
			bytes: self.bytes.saturating_add(bytes),
			tickets: self.tickets.saturating_add(1)
		}
	}

	fn is_empty(self) -> bool {
		self.bytes == 0 && self.tickets == 0
	}
}

struct State {
	next_generation: Option<u64>,
	owner_generations: HashMap<OwnerId, Generation>,
	workspace_generations: HashMap<WorkspaceKey, Generation>,
	runs: HashMap<RunKey, RunRecord>,
	tickets: HashMap<Uuid, Ticket>,
	owner_usage: HashMap<OwnerId, Usage>,
	total_usage: Usage
}

impl State {
	fn new() -> Self {
		Self {
			next_generation: Some(1),
			owner_generations: HashMap::new(),
			workspace_generations: HashMap::new(),
			runs: HashMap::new(),
			tickets: HashMap::new(),
			owner_usage: HashMap::new(),
			total_usage: Usage::default()
		}
	}

	fn active_workspaces_for_owner(&self, owner: &OwnerAdmission) -> usize {
		self.workspace_generations
			.keys()
			.filter(|key| {
				key.owner.as_str() == owner.owner.as_str()
					&& key.owner_generation == owner.generation
			})
			.count()
	}

	fn active_runs_for_workspace(&self, scope: &ScopeKey) -> usize {
		self.runs
			.keys()
			.filter(|key| &key.scope == scope)
			.count()
	}

	fn active_runs_for_owner(&self, owner: &OwnerAdmission) -> usize {
		self.runs
			.keys()
			.filter(|key| {
				key.scope.key.owner.as_str() == owner.owner.as_str()
					&& key.scope.key.owner_generation == owner.generation
			})
			.count()
	}

	fn allocate_generation(&mut self) -> Result<Generation, AdmissionError> {
		let value = self
			.next_generation
			.ok_or(AdmissionError::GenerationExhausted)?;
		self.next_generation = value.checked_add(1);
		Ok(Generation(value))
	}

	fn remove_ticket(&mut self, token: &Uuid) -> Option<Ticket> {
		let ticket = self.tickets.remove(token)?;
		let owner = ticket.scope.key.owner.clone();
		let global_after = self.total_usage.checked_remove(ticket.accounted_bytes);
		let owner_after = self
			.owner_usage
			.get(&owner)
			.copied()
			.and_then(|usage| usage.checked_remove(ticket.accounted_bytes));
		match (global_after, owner_after) {
			(Some(global), Some(per_owner)) => {
				self.total_usage = global;
				if per_owner.is_empty() {
					self.owner_usage.remove(&owner);
				} else {
					self.owner_usage.insert(owner, per_owner);
				}
			}
			_ => self.rebuild_usage()
		}
		Some(ticket)
	}

	fn remove_tickets_where(&mut self, mut predicate: impl FnMut(&Ticket) -> bool) {
		let tokens = self
			.tickets
			.iter()
			.filter_map(|(token, ticket)| predicate(ticket).then_some(*token))
			.collect::<Vec<_>>();
		for token in tokens {
			drop(self.remove_ticket(&token));
		}
	}

	fn purge_expired(&mut self, now: Instant) {
		self.remove_tickets_where(|ticket| ticket.expires_at <= now);
	}

	fn invalidate_owner(&mut self, owner: &OwnerId) {
		self.owner_generations.remove(owner);
		self.workspace_generations
			.retain(|key, _| &key.owner != owner);
		self.runs
			.retain(|key, _| &key.scope.key.owner != owner);
		self.remove_tickets_where(|ticket| &ticket.scope.key.owner == owner);
	}

	fn invalidate_workspace(&mut self, key: &WorkspaceKey) {
		self.workspace_generations.remove(key);
		self.runs
			.retain(|run, _| &run.scope.key != key);
		self.remove_tickets_where(|ticket| &ticket.scope.key == key);
	}

	fn invalidate_run(
		&mut self,
		key: &RunKey,
		generation: Generation,
		identity: &CompileIdentity
	) {
		self.runs.remove(key);
		self.remove_tickets_where(|ticket| match &ticket.binding {
			TicketBinding::Compile {
				identity: ticket_identity,
				run_generation
			} => {
				&ticket.scope == &key.scope
					&& ticket_identity == identity
					&& *run_generation == generation
			}
			TicketBinding::FileRead { .. } => false
		});
	}

	fn rebuild_usage(&mut self) {
		let mut total = Usage::default();
		let mut owners = HashMap::<OwnerId, Usage>::new();
		for ticket in self.tickets.values() {
			total = total.saturating_add(ticket.accounted_bytes);
			let usage = owners
				.entry(ticket.scope.key.owner.clone())
				.or_default();
			*usage = usage.saturating_add(ticket.accounted_bytes);
		}
		self.total_usage = total;
		self.owner_usage = owners;
	}
}
