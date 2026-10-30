// SPDX-License-Identifier: Apache-2.0
use super::*;
use windows_sys::Win32::Foundation::{GetHandleInformation, HANDLE_FLAG_INHERIT};

		pub(crate) static TEST_CAPACITY_LOCK: std::sync::RwLock<()> = std::sync::RwLock::new(());

		pub(crate) fn test_capacity_read_lock() -> std::sync::RwLockReadGuard<'static, ()> {
			match TEST_CAPACITY_LOCK.read() {
				Ok(guard) => guard,
				Err(poisoned) => poisoned.into_inner(),
			}
		}

		pub(crate) fn test_capacity_write_lock() -> std::sync::RwLockWriteGuard<'static, ()> {
			match TEST_CAPACITY_LOCK.write() {
				Ok(guard) => guard,
				Err(poisoned) => poisoned.into_inner(),
			}
		}

		#[test]
		fn working_directory_representation_preserves_drive_unc_unicode_and_long_paths() {
			for (input, expected) in [
				(r"C:\work\資料", r"C:\work\資料"),
				(r"\\?\C:\work\資料", r"C:\work\資料"),
				(r"\\server\share\work\資料", r"\\server\share\work\資料"),
				(
					r"\\?\UNC\server\share\work\資料",
					r"\\server\share\work\資料",
				),
			] {
				let wide = working_directory_for_create_process(
					std::path::Path::new(input),
				)
				.expect("supported absolute working directory");
				assert_eq!(wide.last(), Some(&0));
				assert_eq!(
					String::from_utf16(&wide[..wide.len() - 1]).expect("valid UTF-16 path"),
					expected
				);
			}

			let long_relative = (0..8)
				.map(|index| format!("資料{index}-{}", "x".repeat(32)))
				.collect::<Vec<_>>()
				.join("\\");
			let extended_long = format!(r"\\?\C:\{long_relative}");
			let standard_long = format!(r"C:\{long_relative}");
			assert!(standard_long.encode_utf16().count() > 260);
			let wide = working_directory_for_create_process(
				std::path::Path::new(&extended_long),
			)
			.expect("long extended drive path");
			assert_eq!(
				String::from_utf16(&wide[..wide.len() - 1]).expect("valid UTF-16 path"),
				standard_long
			);

			for unsupported in [
				r"\\?\Volume{00000000-0000-0000-0000-000000000000}\work",
				r"\\?\GLOBALROOT\Device\HarddiskVolume1\work",
				r"\\.\PhysicalDrive0",
				r"\??\C:\work",
				r"C:relative",
			] {
				let error = working_directory_for_create_process(
					std::path::Path::new(unsupported),
				)
				.expect_err("unsupported or non-absolute namespace must fail closed");
				assert_eq!(error.kind, ProcessErrorKind::InvalidWorkingDirectory);
			}
		}

		#[test]
		fn pipe_handles_are_inheritable_only_in_the_explicit_launch_list() {
			let mut pipes = Pipes::new().expect("create pipe endpoints");
			let originals = [
				pipes.stdin_for_child.raw(),
				pipes.stdin_for_parent.raw(),
				pipes.stdout_for_parent.raw(),
				pipes.stdout_for_child.raw(),
				pipes.stderr_for_parent.raw(),
				pipes.stderr_for_child.raw(),
			];
			let is_inheritable = |handle: HANDLE| {
				let mut flags = 0u32;
				assert_ne!(
					unsafe { GetHandleInformation(handle, &mut flags) },
					0,
					"GetHandleInformation must inspect a live pipe handle"
				);
				flags & HANDLE_FLAG_INHERIT != 0
			};
			assert!(
				originals.iter().all(|handle| !is_inheritable(*handle)),
				"backing pipe endpoints must not be process-wide inheritable"
			);

			let child_handles = pipes.prepare_child_handles().expect("duplicate stdio handles");
			assert!(
				child_handles
					.iter()
					.all(|handle| !originals.contains(handle) && is_inheritable(*handle)),
				"the allowlisted launch handles must be distinct inheritable duplicates"
			);
			assert!(
				originals.iter().all(|handle| !is_inheritable(*handle)),
				"preparing the child allowlist must not change backing handle flags"
			);

			pipes.close_all_handles().expect("close every pipe handle");
			assert!(pipes.all_handles_closed());
		}

        fn reviewer_wait_all_slots_free() {
            let end = Instant::now() + Duration::from_secs(5);
            loop {
                if host_supervisor().slots.iter().all(|s| s.state.load(Ordering::Acquire) == SLOT_FREE) { return; }
                assert!(Instant::now() < end, "cleanup slots must remain owned until actual drain, then become reusable");
                thread::sleep(Duration::from_millis(20));
            }
        }
        fn reviewer_node_spec(marker: &std::path::Path) -> ProcessSpec {
            ProcessSpec::new(PathBuf::from(r"C:\Program Files\nodejs\node.exe"), std::env::temp_dir(), vec![OsString::from("-e"),OsString::from("require('node:fs').writeFileSync(process.argv[1], 'spawned')"), marker.as_os_str().to_owned()],Duration::from_secs(5),65536)
        }
        #[test]
        fn reviewer_capacity_and_startup_fault_reject_before_child_creation() {
            let marker=std::env::temp_dir().join(format!("modutex-review-no-spawn-{}",uuid::Uuid::new_v4()));
            let spec=reviewer_node_spec(&marker);let(_,token)=cancellation_pair();
            for (fault,expected) in [(TestFault::CleanupCapacity,ProcessErrorKind::CleanupCapacityExceeded),(TestFault::SupervisorStart,ProcessErrorKind::CleanupSupervisorUnavailable)] {
                let error=run_with_fault(&spec,&token,fault).expect_err("injected pre-spawn rejection");
                assert_eq!(error.kind,expected);assert_eq!(error.cleanup,CleanupProof::NotRequired);assert!(!error.has_pending_cleanup());assert!(!marker.exists());
            }
        }
        #[test]
        fn reviewer_actual_sixteen_reservations_reject_seventeenth_without_wait() {
            let _exclusive_guard = test_capacity_write_lock();
            reviewer_wait_all_slots_free();let mut held=Vec::new();
            for _ in 0..MAX_SUPERVISED_CLEANUPS { held.push(reserve_cleanup_slot(None).expect("one of sixteen actual bounded slots")); }
            let begin=Instant::now();let error=reserve_cleanup_slot(None).err().expect("capacity must reject");
            assert_eq!(error.kind,ProcessErrorKind::CleanupCapacityExceeded);assert!(begin.elapsed()<Duration::from_secs(1));
            drop(held);reviewer_wait_all_slots_free();
        }
        fn reviewer_live_node_children()->Vec<u32> {
            use windows_sys::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot,Process32FirstW,Process32NextW,PROCESSENTRY32W,TH32CS_SNAPPROCESS};
            let snapshot=unsafe{CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS,0)};assert_ne!(snapshot,INVALID_HANDLE_VALUE);
            let mut entry:PROCESSENTRY32W=unsafe{mem::zeroed()};entry.dwSize=mem::size_of::<PROCESSENTRY32W>() as u32;let mut ids=Vec::new();let mut more=unsafe{Process32FirstW(snapshot,&mut entry)};
            while more!=0 {let length=entry.szExeFile.iter().position(|&x|x==0).unwrap_or(entry.szExeFile.len());let exe=String::from_utf16_lossy(&entry.szExeFile[..length]);if entry.th32ParentProcessID==std::process::id() && exe.eq_ignore_ascii_case("node.exe"){ids.push(entry.th32ProcessID)}more=unsafe{Process32NextW(snapshot,&mut entry)};}
            unsafe{CloseHandle(snapshot)};ids
        }
        #[test]
        fn reviewer_post_spawn_unwind_hands_off_and_reaps_the_suspended_native_child() {
            reviewer_wait_all_slots_free();let before=reviewer_live_node_children();let marker=std::env::temp_dir().join(format!("modutex-review-unwind-{}",uuid::Uuid::new_v4()));let spec=reviewer_node_spec(&marker);let(_,token)=cancellation_pair();let begin=Instant::now();
            let panic=std::panic::catch_unwind(std::panic::AssertUnwindSafe(||run_with_fault(&spec,&token,TestFault::PostSpawnPanic)));
            assert!(panic.is_err());assert!(begin.elapsed()<Duration::from_secs(2),"unwinding must transfer ownership promptly");
            reviewer_wait_all_slots_free();assert!(!marker.exists());let after=reviewer_live_node_children();assert!(after.iter().all(|id|before.contains(id)),"suspended child remains alive after cleanup proof: {after:?}");
        }

		/// Runs one process invocation with a deterministic, test-only fault.
		/// `PostSpawnPanic` deliberately unwinds after `OwnedCleanupState` has
		/// taken ownership, exercising its reserved-slot transfer on drop.
		pub(crate) fn run_with_fault(
			spec: &ProcessSpec,
			cancellation: &CancellationToken,
			fault: TestFault,
		) -> Result<ProcessOutput, ProcessError> {
			run_inner(
				spec,
				cancellation,
				Some(fault),
				StartupVariant::Production,
			)
		}

		/// Runs the complete process-tree path while varying only startup window
		/// flags, for native differential diagnostics.
		pub(crate) fn run_with_startup_variant(
			spec: &ProcessSpec,
			cancellation: &CancellationToken,
			variant: StartupVariant,
		) -> Result<ProcessOutput, ProcessError> {
			run_inner(spec, cancellation, None, variant)
		}

		/// Constructs a real `ProcessError` holding a live `PendingCleanup`
		/// ticket over a spawned helper child before `ensure_drained` runs,
		/// exercising owner retry/cancel/drain and drop transfer to bounded
		/// host supervision.
		#[cfg(test)]
		pub(crate) fn test_environment_block(
			explicit: &[(OsString, OsString)],
		) -> Result<Vec<u16>, ProcessErrorKind> {
			environment_block(explicit).map_err(|error| error.kind)
		}

		pub(crate) fn spawn_unproven_cleanup_error(
			spec: &ProcessSpec,
		) -> Result<ProcessError, ProcessError> {
			let _read_guard = test_capacity_read_lock();
			validate_limits(spec)?;
			let deadline = Instant::now()
				.checked_add(spec.timeout)
				.ok_or_else(|| {
					ProcessError::simple(
						ProcessErrorKind::InvalidTimeout,
						"timeout cannot be represented by the platform clock",
					)
				})?;
			let paths = verify_paths(spec).map_err(simple_failure)?;
			let mut command_line =
				command_line(&paths.executable, &spec.arguments).map_err(simple_failure)?;
			let pipes = Pipes::new().map_err(simple_failure)?;
			let job = create_kill_on_close_job().map_err(simple_failure)?;
			let readers = ReaderSet::new();
			let reservation = reserve_cleanup_slot(None)?;
			if Instant::now() >= deadline {
				return Err(ProcessError::simple(
					ProcessErrorKind::DeadlineExceeded,
					"deadline expired before spawn",
				));
			}
			let mut state = create_suspended(
				&paths,
				&mut command_line,
				None,
				OwnedSpawnResources {
					pipes,
					readers,
					job,
					reservation,
				},
				StartupVariant::Production,
			)
			.map_err(simple_failure)?;
			let setup_result = (|| -> Result<(), FailureCause> {
				state
					.pipes_mut()
					.close_parent_copies()
					.map_err(|err| FailureCause::new(ProcessErrorKind::Spawn, err))?;
				state.child_mut().assign_to_job().map_err(|err| {
					FailureCause::new(ProcessErrorKind::AssignToJob, err)
				})?;
				let (stdout, stderr) = state.pipes_mut().take_output_readers();
				state
					.readers_mut()
					.start(
						stdout,
						stderr,
						spec.max_log_bytes_per_stream,
					)?;
				state
					.child_mut()
					.resume()
					.map_err(|err| FailureCause::new(ProcessErrorKind::Resume, err))?;
				state.child_mut().close_thread_handle().map_err(|err| {
					FailureCause::new(ProcessErrorKind::CleanupFailed, err)
				})?;
				Ok(())
			})();
			if let Err(cause) = setup_result {
				let logs = state.snapshot_logs();
				let pending = PendingCleanup {
					inner: Some(Box::new(state)),
				};
				return Err(process_error(
					cause,
					logs,
					None,
					None,
					CleanupProof::Failed,
					Some(pending),
				));
			}


			let pending = PendingCleanup {
				inner: Some(Box::new(state)),
			};
			Ok(process_error(
				FailureCause::new(
					ProcessErrorKind::DeadlineExceeded,
					"simulated unproven cleanup failure with live process and readers",
				),
				ProcessLogs::default(),
				None,
				Some("cleanup not yet proven".to_string()),
				CleanupProof::Failed,
				Some(pending),
			))
		}
	
