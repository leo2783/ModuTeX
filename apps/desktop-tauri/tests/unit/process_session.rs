// SPDX-License-Identifier: Apache-2.0
use super::*;
use std::{ffi::OsString, sync::atomic::AtomicUsize, time::Instant};

fn session(mode: &str, limit: usize) -> ProcessSession {
    let (_, cancel) = cancellation_pair();
    let spec = ProcessSpec::new(
        std::env::current_exe().unwrap(),
        std::env::current_dir().unwrap(),
        vec![
            OsString::from("--exact"),
            OsString::from("platform::process_tree::session_acceptance_tests::session_child"),
            OsString::from("--ignored"),
            OsString::from("--nocapture"),
        ],
        Duration::from_secs(20),
        limit,
    )
    .with_environment(vec![(
        OsString::from("MODUTEX_SESSION_TEST_MODE"),
        OsString::from(mode),
    )]);
    let mut child = ProcessSession::start(&spec, &cancel).unwrap_or_else(|mut failure| {
        if let Some(mut pending) = failure.pending.take() {
            pending.stop(Duration::from_secs(3)).unwrap();
        }
        panic!("native session start failed: {}", failure.error);
    });
    child
        .exchange(&[], b"SESSION_READY\n", &cancel, Duration::from_secs(5))
        .unwrap();
    child
}

#[test]
fn two_unicode_requests_keep_the_same_real_process_and_drain_callback_runs_once() {
    let mut child = session("echo", 1024 * 1024);
    let pid = child.pid();
    assert_ne!(pid, 0);
    let calls = Arc::new(AtomicUsize::new(0));
    let count = Arc::clone(&calls);
    child.on_drained(move || {
        count.fetch_add(1, Ordering::SeqCst);
    });
    let (_, cancel) = cancellation_pair();
    for input in ["first 漢字\n", "second café\n"] {
        let reply = child
            .exchange(
                input.as_bytes(),
                b"FRAME_END\n",
                &cancel,
                Duration::from_secs(3),
            )
            .unwrap();
        let text = String::from_utf8(reply.stdout).unwrap();
        assert!(
            text.contains(input.trim_end()),
            "payload must preserve Unicode: {text}"
        );
        assert!(
            text.contains(&format!("PID={pid}")),
            "same child must answer both requests: {text}"
        );
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }
    child.stop(Duration::from_secs(3)).unwrap();
    assert!(child.is_drained());
    child.stop(Duration::from_secs(3)).unwrap();
    drop(child);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[test]
fn blocked_stdin_times_out_and_drains_its_writer_readers_and_job() {
    let mut child = session("no-read", 1024 * 1024);
    let (_, cancel) = cancellation_pair();
    let started = Instant::now();
    let error = child
        .exchange(
            &vec![b'x'; 2 * 1024 * 1024],
            b"NEVER\n",
            &cancel,
            Duration::from_millis(150),
        )
        .unwrap_err();
    assert_eq!(error.kind, SessionErrorKind::DeadlineExceeded);
    assert!(
        child.is_drained(),
        "timeout must prove cleanup before replacement"
    );
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "stdin backpressure must not block deadline cleanup"
    );
}

#[test]
fn cancellation_interrupts_a_blocked_input_exchange_and_drains() {
    let mut child = session("no-read", 1024 * 1024);
    let (handle, cancel) = cancellation_pair();
    let canceller = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(100));
        handle.cancel();
    });
    let started = Instant::now();
    let error = child
        .exchange(
            &vec![b'x'; 2 * 1024 * 1024],
            b"NEVER\n",
            &cancel,
            Duration::from_secs(3),
        )
        .unwrap_err();
    canceller.join().unwrap();
    assert_eq!(error.kind, SessionErrorKind::Cancelled);
    assert!(child.is_drained());
    assert!(started.elapsed() < Duration::from_secs(5));
}

#[test]
fn output_is_pumped_while_the_child_has_not_yet_consumed_large_stdin() {
    let mut child = session("flood", 4 * 1024 * 1024);
    let (_, cancel) = cancellation_pair();
    let mut input = vec![b'y'; 2 * 1024 * 1024];
    input.push(b'\n');
    let reply = child
        .exchange(&input, b"FRAME_END\n", &cancel, Duration::from_secs(5))
        .unwrap();
    assert!(reply.stdout.len() >= 512 * 1024);
    let text = String::from_utf8(reply.stdout).unwrap();
    assert!(text.contains(&format!("READ={}", input.len())));
    child.stop(Duration::from_secs(3)).unwrap();
    assert!(child.is_drained());
}

#[test]
#[ignore]
fn session_child() {
    use std::io::{BufRead, Write};
    let mode = std::env::var("MODUTEX_SESSION_TEST_MODE").expect("self-hosted child mode");
    println!("SESSION_READY");
    std::io::stdout().flush().unwrap();
    if mode == "no-read" {
        loop {
            std::thread::sleep(Duration::from_secs(1));
        }
    }
    if mode == "flood" {
        std::io::stdout()
            .write_all(&vec![b'x'; 512 * 1024])
            .unwrap();
        std::io::stdout().flush().unwrap();
    }
    for line in std::io::stdin().lock().lines() {
        let line = line.unwrap();
        if mode == "flood" {
            println!("READ={} PID={}", line.len() + 1, std::process::id());
        } else {
            println!("PID={} {line}", std::process::id());
        }
        println!("FRAME_END");
        std::io::stdout().flush().unwrap();
    }
}
