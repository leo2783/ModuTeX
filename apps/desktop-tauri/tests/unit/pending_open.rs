use super::*;

const OWNER_ONE: &str = "document-00000000-0000-4000-8000-000000000001";
const OWNER_TWO: &str = "document-00000000-0000-4000-8000-000000000002";

fn test_owner(label: &str) -> OwnerId {
    OwnerId::from_label(label).unwrap()
}

fn absolute_file(name: &str) -> PathBuf {
    std::env::current_dir().unwrap().join(name)
}

#[test]
fn startup_and_second_instance_arguments_accept_only_bounded_tex_and_pdf_paths() {
    let cwd = std::env::current_dir().unwrap();
    let unicode_name = "\u{6587}\u{4ef6}.tex";
    let paths = collect_native_open_paths(
        [
            OsString::from("modutex.exe"),
            OsString::from(unicode_name),
            OsString::from("preview.PDF"),
            OsString::from("draft.typ"),
            OsString::from("--help"),
            OsString::from(unicode_name),
        ],
        &cwd,
    );

    assert_eq!(paths, vec![cwd.join(unicode_name), cwd.join("preview.PDF")]);
    assert!(parse_native_open_argument(OsStr::new("../outside.tex"), &cwd).is_none());
    let too_long = format!("{}.tex", "a".repeat(MAX_NATIVE_PATH_UTF16_UNITS));
    assert!(parse_native_open_argument(OsStr::new(&too_long), &cwd).is_none());
}

#[test]
fn pending_paths_are_available_only_to_the_assigned_owner() {
    let state = PendingOpenState::default();
    let owner = test_owner(OWNER_ONE);
    let other = test_owner(OWNER_TWO);
    let path = absolute_file("owner-fenced.tex");

    assert!(state.enqueue(&owner, OWNER_TWO, path.clone()).is_err());
    assert!(state.enqueue(&owner, OWNER_ONE, path.clone()).unwrap());
    assert!(state.take_for_owner(&other).is_none());
    assert_eq!(
        state.owner_for_path(&path),
        Some((owner.clone(), OWNER_ONE.to_owned()))
    );
    assert_eq!(state.take_for_owner(&owner), Some(path));
    assert!(!state.has_pending_for_owner(&owner));
}

#[test]
fn pending_paths_are_bounded_per_window_and_across_the_host() {
    let state = PendingOpenState::default();
    let label = OWNER_ONE;
    let owner = test_owner(label);
    let paths: Vec<PathBuf> = (0..MAX_PENDING_OPEN_PER_WINDOW)
        .map(|index| absolute_file(&format!("bounded-{index}.tex")))
        .collect();
    for path in &paths {
        assert!(state.enqueue(&owner, label, path.clone()).unwrap());
    }
    assert!(!state.enqueue(&owner, label, paths[0].clone()).unwrap());
    assert!(state
        .enqueue(&owner, label, absolute_file("bounded-overflow.tex"))
        .is_err());

    let state = PendingOpenState::default();
    for owner_index in 0..(MAX_PENDING_OPEN_TOTAL / MAX_PENDING_OPEN_PER_WINDOW) {
        let label = format!("document-00000000-0000-4000-8000-{:012x}", owner_index + 10);
        let owner = test_owner(&label);
        for path_index in 0..MAX_PENDING_OPEN_PER_WINDOW {
            let path = absolute_file(&format!("limit-{owner_index}-{path_index}.pdf"));
            assert!(state.enqueue(&owner, &label, path).unwrap());
        }
    }
    let overflow_owner = test_owner("document-00000000-0000-4000-8000-000000000099");
    assert!(state
        .enqueue(
            &overflow_owner,
            "document-00000000-0000-4000-8000-000000000099",
            absolute_file("total-overflow.tex")
        )
        .is_err());
}

#[test]
fn native_paths_reject_excessive_directory_depth() {
    let mut path = std::env::current_dir().unwrap();
    for index in 0..MAX_NATIVE_PATH_COMPONENTS {
        path.push(format!("d{index}"));
    }
    path.push("deep.tex");
    assert!(!is_native_open_path(&path));
}
