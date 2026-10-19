//! PTY host smoke test — spawns a real shell through the same portable-pty
//! path pty_spawn uses and asserts the shell answers. Run: cargo test.

use portable_pty::{CommandBuilder, NativePtySystem, PtySize, PtySystem};
use std::io::{Read, Write};

#[test]
fn pty_spawns_a_shell_and_echoes() {
    let pty_system = NativePtySystem::default();
    let pair = pty_system
        .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
        .expect("openpty");

    let mut cmd = CommandBuilder::new("bash");
    cmd.args(["-c", "echo PTY_OK_$((21+21)); sleep 30"]);
    let _child = pair.slave.spawn_command(cmd).expect("spawn bash");

    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().expect("reader");
    let mut out = String::new();
    let mut buf = [0u8; 512];
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while !out.contains("PTY_OK_42") && std::time::Instant::now() < deadline {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => out.push_str(&String::from_utf8_lossy(&buf[..n])),
            Err(_) => break,
        }
    }
    assert!(out.contains("PTY_OK_42"), "shell output did not contain the marker: {out:?}");
}
