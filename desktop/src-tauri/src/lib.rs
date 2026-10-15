//! Moch Desktop — local-only PC build.
//!
//! The Rust shell does three things:
//!  1. SUPERVISE the local hermes agent: spawns the user's hermes fork
//!     (`app/hermes-src`, with their changes) as `serve` on a loopback
//!     port with a session token we mint ourselves. Attaching an
//!     already-running machine-level serve on 9119 is NOT a fallback:
//!     it only runs with the explicit MOCH_ATTACH=1 escape hatch.
//!  2. SERVE the built UI from 127.0.0.1:<port> — so the webview origin
//!     is a loopback origin hermes' WS host/origin guard accepts.
//!  3. OPEN the window on that origin. The UI talks to hermes directly
//!     over ws://127.0.0.1 using the app's own TS protocol stack.

use parking_lot::Mutex;
use std::io::{Read as _, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, OnceLock};
use std::time::Duration;

use tauri::{WebviewUrl, WebviewWindowBuilder};
use tiny_http::{Method, Response};

const HERMES_PORT: u16 = 9118;
/// A machine-level serve that may already be running (systemd service).
const ATTACH_PORT: u16 = 9119;

static HERMES_CHILD: LazyLock<Mutex<Option<std::process::Child>>> =
    LazyLock::new(|| Mutex::new(None));
/// Set by terminate_runtime() so the respawn watchdog stops before it can
/// restart a runtime the operator is tearing down.
static SHUTDOWN: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
/// CDP debug port of the agent browser spawned by runtime.py (from the
/// handshake JSON's browser_port). None = no browser this boot.
static BROWSER_PORT: OnceLock<u16> = OnceLock::new();
/// Loopback port of the raw CDP WebSocket proxy (set at boot, published
/// to the UI via GET /cdp/ws-port).
static CDP_WS_PORT: OnceLock<u16> = OnceLock::new();

fn hermes_child() -> &'static Mutex<Option<std::process::Child>> {
    &HERMES_CHILD
}

/// Resolve the desktop/ dir at RUNTIME, not compile time:
///  1. `MOCH_DESKTOP_DIR` env (explicit override — the installed-bundle path)
///  2. exe-relative scan: walk ancestors from the exe dir while a
///     `runtime.py` marker is missing (covers src-tauri/target/{debug,release})
///  3. the compile-time manifest path (cargo dev builds — always correct
///     there, and the binary was built from that tree)
/// Tier 1/2 exist so an installed deb/AppImage can at least be POINTED at
/// a checkout with env instead of silently using a baked build-machine
/// path. Packaging the runtime itself remains a future round.
fn desktop_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("MOCH_DESKTOP_DIR") {
        let p = PathBuf::from(dir);
        if p.join("runtime.py").is_file() {
            return p;
        }
        eprintln!("moch: MOCH_DESKTOP_DIR has no runtime.py — ignoring");
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(base) = exe.parent() {
            for anc in base.ancestors().skip(1).take(6) {
                if anc.join("runtime.py").is_file() {
                    return anc.to_path_buf();
                }
            }
        }
    }
    let compiled = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    if compiled.join("runtime.py").is_file() {
        return compiled;
    }
    eprintln!(
        "moch: desktop dir not found (tried MOCH_DESKTOP_DIR, exe-relative, baked {}) — set MOCH_DESKTOP_DIR",
        compiled.display()
    );
    compiled
}

/// The web UI the shell serves from disk when an asset is not embedded:
/// `app-desktop-web/` (the dedicated desktop bundle — what `npm run build`
/// writes in `desktop/app`) with `app-web/` (the shared expo export) and
/// `web-ui/` (the frozen fork) as legacy fallbacks. Embedded assets win.
fn ui_dir() -> Option<PathBuf> {
    let base = desktop_dir();
    for name in ["app-desktop-web", "app-web", "web-ui"] {
        let p = base.join(name);
        if p.is_dir() {
            return Some(p);
        }
    }
    None
}

fn repo_root() -> PathBuf {
    desktop_dir()
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../.."))
}

/// Refuse to start twice: flock() a lock file for the process lifetime.
/// The kernel releases the flock on exit; the file itself is left in
/// place (the next run just re-locks it). The lock sits at a FIXED
/// user-level path, NOT inside desktop_dir(): what it guards (the
/// gateway port) is machine-global, so a per-desktop_dir lock was
/// bypassable by two launches with different MOCH_DESKTOP_DIRs — and a
/// nonexistent desktop_dir used to make the open panic off-tree.
fn acquire_single_instance() {
    let lock_dir = std::env::var("XDG_RUNTIME_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir());
    if let Err(e) = std::fs::create_dir_all(&lock_dir) {
        eprintln!(
            "moch: cannot create lock dir {} ({e}) — set XDG_RUNTIME_DIR",
            lock_dir.display()
        );
        std::process::exit(1);
    }
    let lock_path = lock_dir.join("moch-desktop.lock");
    let lock = match std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(false)
        .open(&lock_path)
    {
        Ok(f) => f,
        Err(e) => {
            eprintln!(
                "moch: cannot open single-instance lock {} ({e}) — fix permissions or remove the file",
                lock_path.display()
            );
            std::process::exit(1);
        }
    };
    use std::os::unix::io::AsRawFd;
    if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        eprintln!("moch: already running");
        std::process::exit(0);
    }
    // Keep the fd (and thus the lock) alive until the process exits.
    std::mem::forget(lock);
}

/// Stop the supervised runtime politely: SIGTERM, wait up to 5s, then
/// SIGKILL. Shared by both exit paths (signal handler + RunEvent::Exit).
fn terminate_runtime() {
    SHUTDOWN.store(true, std::sync::atomic::Ordering::SeqCst);
    let mut child = match hermes_child().lock().take() {
        Some(c) => c,
        None => return,
    };
    let pid = child.id() as i32;
    unsafe {
        libc::kill(pid, libc::SIGTERM);
    }
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        match child.try_wait() {
            Ok(Some(_)) | Err(_) => break,
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    break;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
        }
    }
}

fn wait_port(port: u16, timeout_ms: u64) -> bool {
    let deadline = std::time::Instant::now() + Duration::from_millis(timeout_ms);
    while std::time::Instant::now() < deadline {
        if TcpStream::connect(("127.0.0.1", port)).is_ok() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(300));
    }
    false
}

/// True for lines that must never reach the serve log:
///  - MOCH_GATEWAY_INFO handshake markers (they carry the live token),
///  - `"token":"<alnum>` JSON fragments — covers lines arriving BEFORE
///    the handshake, when the literal token string is still unknown,
///  - the literal token itself, once the handshake mints it.
fn line_carries_token(line: &str, token: &str) -> bool {
    if line.contains("MOCH_GATEWAY_INFO") {
        return true;
    }
    const TOKEN_PREFIX: &str = "\"token\":\"";
    if let Some(i) = line.find(TOKEN_PREFIX) {
        let rest = &line[i + TOKEN_PREFIX.len()..];
        if matches!(rest.chars().next(), Some(c) if c.is_ascii_alphanumeric()) {
            return true;
        }
    }
    !token.is_empty() && line.contains(token)
}

/// Drain a child stream (stdout AND stderr) into the serve log through
/// the redaction above — one thread per stream, sharing the token cell
/// the handshake fills in.
fn spawn_log_drain<R>(stream: R, mut log: std::fs::File, token: Arc<Mutex<String>>)
where
    R: std::io::Read + Send + 'static,
{
    std::thread::spawn(move || {
        use std::io::BufRead;
        for line in std::io::BufReader::new(stream).lines().map_while(Result::ok) {
            let tok = token.lock().clone();
            if line_carries_token(&line, &tok) {
                continue;
            }
            let _ = writeln!(log, "{line}");
        }
    });
}

/// One-shot in-place redaction of the PREVIOUS run's log before the new
/// runtime appends to it: old builds wired the child's stderr to this
/// file RAW, so token-bearing lines can already be sitting in it. Cheap
/// no-op unless a line scan finds a marker; rewrites only when it does.
fn scrub_serve_log(path: &Path) {
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(_) => return, // missing/unreadable: nothing to scrub
    };
    let contents = String::from_utf8_lossy(&bytes);
    if !contents.lines().any(|l| line_carries_token(l, "")) {
        return;
    }
    let mut kept = contents
        .lines()
        .filter(|l| !line_carries_token(l, ""))
        .collect::<Vec<&str>>()
        .join("\n");
    if !kept.is_empty() {
        kept.push('\n');
    }
    let _ = std::fs::write(path, kept);
}

/// Spawn the user's hermes fork (app/hermes-src) as a local serve.
/// Returns (ws_url, token, mode) or an error string.
fn start_fork() -> Result<(String, String, &'static str), String> {
    let root = repo_root();
    let fork = root.join("app/hermes-src");
    let cli = fork.join("cli.py");
    if !cli.is_file() {
        return Err(format!("fork cli not found at {}", cli.display()));
    }

    // Prefer the venv python the installed hermes uses (has all deps),
    // fall back to system python3.
    let venv_py = PathBuf::from(
        std::env::var("MOCH_HERMES_PYTHON").unwrap_or_else(|_| {
            "/home/mamoun/.hermes/hermes-agent/venv/bin/python".to_string()
        }),
    );
    let python: PathBuf = if venv_py.is_file() {
        venv_py
    } else {
        PathBuf::from("python3")
    };

    // Moch-owned hermes home — same architecture as the phone's embedded
    // mode (app-private home), separate from any CLI install. Override
    // with MOCH_HERMES_HOME.
    let home = std::env::var("MOCH_HERMES_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| desktop_dir().join("runtime-home"));
    let _ = std::fs::create_dir_all(&home);

    // Run the phone's embedded gateway (moch/gateway_server.py) as a child:
    // headless serve, MOCH_FLEET=1 (bots/crew surface), supervised boots.
    let runner = desktop_dir().join("runtime.py");
    let log_path = desktop_dir().join(".hermes-serve.log");
    let log = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|e| format!("open serve log: {e}"))?;
    // Owner-only perms: defense in depth on top of the redaction below —
    // this file used to land world-readable (umask default 0644) and its
    // lines can carry the session token.
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = log.set_permissions(std::fs::Permissions::from_mode(0o600));
    }
    let log_err = log
        .try_clone()
        .map_err(|e| format!("clone serve log: {e}"))?;

    use std::os::unix::process::CommandExt;
    use std::process::Stdio;
    let mut child = std::process::Command::new(&python)
        .arg(&runner)
        .env("MOCH_FORK_SRC", &fork)
        .env("MOCH_RUNTIME_PKGS", root.join("app/python-runtime"))
        .env("MOCH_GATEWAY_PORT", std::env::var("MOCH_PORT").unwrap_or_else(|_| HERMES_PORT.to_string()))
        .env("HERMES_HOME", &home)
        .current_dir(&fork)
        // Own process group: terminal signals reach us, not the child —
        // we shut it down explicitly via terminate_runtime().
        .process_group(0)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("spawn {}: {e}", python.display()))?;
    eprintln!("moch: runtime spawned pid={:?}", child.id());

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    // Register the child right away (not after the handshake) so a signal
    // arriving during boot still finds it and tears it down.
    *hermes_child().lock() = Some(child);

    // Drain BOTH streams into the log through the same redaction (the
    // old wiring sent stderr to the file RAW, so any traceback echoing
    // the handshake line leaked the token). Observability only — the
    // real handshake is file-based. The token is only minted after the
    // handshake, so pre-handshake lines are filtered structurally; once
    // known, the literal token is dropped too (see line_carries_token).
    let token_cell = Arc::new(Mutex::new(String::new()));
    if let Some(out) = stdout {
        spawn_log_drain(out, log, token_cell.clone());
    }
    if let Some(err) = stderr {
        spawn_log_drain(err, log_err, token_cell.clone());
    }

    // File-based handshake: runtime.py writes .moch-gateway.json into its
    // home once the gateway accepts connections. Poll up to 150s (cold
    // boots on an existing home can be slow — MCP reconnects etc.).
    let info_path = home.join(".moch-gateway.json");
    let _ = std::fs::remove_file(&info_path);
    let mut info = serde_json::Value::Null;
    let deadline = std::time::Instant::now() + Duration::from_secs(150);
    loop {
        // Fast-fail: don't sit out the whole timeout if the child already
        // died — report its exit status immediately.
        if let Some(status) = hermes_child()
            .lock()
            .as_mut()
            .and_then(|c| c.try_wait().ok())
            .flatten()
        {
            return Err(format!("runtime exited early: {status}"));
        }
        if let Ok(s) = std::fs::read_to_string(&info_path) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&s) {
                info = v;
                break;
            }
        }
        if std::time::Instant::now() >= deadline {
            break;
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    if info.is_null() {
        // The exit check at the top of the last iteration just saw the
        // child alive, so say so instead of a bare timeout.
        return Err(
            "runtime did not write gateway info in 150s (child still running)".to_string(),
        );
    }
    eprintln!("moch: handshake received");
    let port = info["port"].as_u64().unwrap_or(HERMES_PORT as u64) as u16;
    let token = info["token"].as_str().unwrap_or_default().to_string();
    // Publish the token to the drain threads — from here on, any line
    // quoting it verbatim (debug prints, tracebacks) is dropped too.
    *token_cell.lock() = token.clone();
    if token.is_empty() || !wait_port(port, 5_000) {
        // The handshake JSON carries the runtime's own error, if any —
        // surface it instead of the generic "port not accepting".
        return Err(match info["error"].as_str().filter(|e| !e.is_empty()) {
            Some(e) => format!("gateway startup failed: {e}"),
            None => "gateway info arrived but port not accepting".to_string(),
        });
    }
    // Zombie-gateway defuse: the port probe can pass even if the child
    // died right after binding — a race that used to hand run() a dead
    // runtime. Refuse to return Ok unless the child is still alive.
    // (The poll loop above already fast-fails DURING the wait.)
    if let Some(status) = hermes_child()
        .lock()
        .as_mut()
        .and_then(|c| c.try_wait().ok())
        .flatten()
    {
        return Err(format!("runtime exited during handshake: {status}"));
    }
    if let Some(bp) = info["browser_port"].as_u64() {
        let _ = BROWSER_PORT.set(bp as u16);
    }
    Ok((
        format!("ws://127.0.0.1:{port}/api/ws"),
        token,
        "fork",
    ))
}

/// Attach to an already-running machine-level serve (token from its env file).
fn attach_existing() -> Result<(String, String, &'static str), String> {
    if TcpStream::connect(("127.0.0.1", ATTACH_PORT)).is_err() {
        return Err("no local hermes on 9118 (fork) or 9119 (attached)".into());
    }
    let env_path = std::env::var("HERMES_SERVE_ENV")
        .unwrap_or_else(|_| format!("{}/.config/hermes-serve.env", std::env::var("HOME").unwrap_or_default()));
    let body = std::fs::read_to_string(&env_path).map_err(|e| format!("read {env_path}: {e}"))?;
    let token = body
        .lines()
        .find_map(|l| l.strip_prefix("HERMES_DASHBOARD_SESSION_TOKEN="))
        .map(|t| t.trim().to_string())
        .ok_or_else(|| "no token in env file".to_string())?;
    Ok((
        format!("ws://127.0.0.1:{ATTACH_PORT}/api/ws"),
        token,
        "attached",
    ))
}

/// Minimal HTTP/1.1 GET against the agent browser's CDP HTTP endpoint
/// (GET /json — the target list). Hand-rolled: loopback, no TLS, one
/// short-lived connection per call. Chromium answers with Content-Length
/// and leaves the socket open even under `Connection: close`, so the body
/// is read by length — read_to_end would only ever hit the read timeout.
fn cdp_get_json(port: u16, path: &str) -> Result<String, String> {
    let mut stream = TcpStream::connect(("127.0.0.1", port))
        .map_err(|e| format!("cdp connect: {e}"))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .map_err(|e| format!("cdp timeout: {e}"))?;
    let req = format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
    stream
        .write_all(req.as_bytes())
        .map_err(|e| format!("cdp write: {e}"))?;
    let mut buf = Vec::with_capacity(4096);
    let mut chunk = [0u8; 4096];
    let head_end = loop {
        let n = stream.read(&mut chunk).map_err(|e| format!("cdp read: {e}"))?;
        if n == 0 {
            return Err("cdp: connection closed before a response head".into());
        }
        buf.extend_from_slice(&chunk[..n]);
        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break i;
        }
        if buf.len() > 64 * 1024 {
            return Err("cdp: response head too large".into());
        }
    };
    let head = String::from_utf8_lossy(&buf[..head_end]);
    let status_ok = head.starts_with("HTTP/1.1 200") || head.starts_with("HTTP/1.0 200");
    if !status_ok {
        return Err(format!("cdp: non-200 from {path}"));
    }
    let content_length: usize = header(&head, "Content-Length")
        .and_then(|v| v.parse().ok())
        .ok_or_else(|| format!("cdp: no Content-Length from {path}"))?;
    let mut body = buf.split_off(head_end + 4);
    while body.len() < content_length {
        let n = stream.read(&mut chunk).map_err(|e| format!("cdp read: {e}"))?;
        if n == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..n]);
    }
    body.truncate(content_length);
    String::from_utf8(body).map_err(|_| format!("cdp: non-utf8 body from {path}"))
}

// ---------------------------------------------------------------------------
// CDP WebSocket proxy
//
// The UI (origin http://127.0.0.1:<ui-port>) cannot open a WebSocket
// straight to the agent browser's CDP port: Chromium rejects upgrades
// carrying a foreign Origin header. The shell therefore terminates the
// webview's WebSocket itself on a second loopback listener and splices the
// raw bytes through to ws://127.0.0.1:<browser_port>/devtools/<target> —
// the same raw-splice pattern the phone relay uses. tiny_http cannot
// upgrade (its upgrade() yields an opaque, non-cloneable stream, and the
// splice needs two duplex handles per direction), so this listener is
// hand-rolled on std. Framing needs no code on our side: the webview sends
// masked client frames and Chromium answers with unmasked server frames,
// and a verbatim byte relay preserves both. Loopback-only by bind; the
// browser port comes from BROWSER_PORT, never from the request.
// ---------------------------------------------------------------------------

const WS_GUID: &str = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/// SHA-1, only for the RFC 6455 Sec-WebSocket-Accept handshake. No crate
/// for one hash over ~60 bytes.
fn sha1(data: &[u8]) -> [u8; 20] {
    let mut h: [u32; 5] = [0x6745_2301, 0xEFCD_AB89, 0x98BA_DCFE, 0x1032_5476, 0xC3D2_E1F0];
    let bit_len = (data.len() as u64).wrapping_mul(8);
    let mut msg = data.to_vec();
    msg.push(0x80);
    while msg.len() % 64 != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&bit_len.to_be_bytes());
    for block in msg.chunks_exact(64) {
        let mut w = [0u32; 80];
        for (i, word) in block.chunks_exact(4).enumerate() {
            w[i] = u32::from_be_bytes([word[0], word[1], word[2], word[3]]);
        }
        for i in 16..80 {
            w[i] = (w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]).rotate_left(1);
        }
        let (mut a, mut b, mut c, mut d, mut e) = (h[0], h[1], h[2], h[3], h[4]);
        for (i, &wi) in w.iter().enumerate() {
            let (f, k) = match i {
                0..=19 => ((b & c) | (!b & d), 0x5A82_7999u32),
                20..=39 => (b ^ c ^ d, 0x6ED9_EBA1),
                40..=59 => ((b & c) | (b & d) | (c & d), 0x8F1B_BCDC),
                _ => (b ^ c ^ d, 0xCA62_C1D6),
            };
            let tmp = a
                .rotate_left(5)
                .wrapping_add(f)
                .wrapping_add(e)
                .wrapping_add(k)
                .wrapping_add(wi);
            e = d;
            d = c;
            c = b.rotate_left(30);
            b = a;
            a = tmp;
        }
        h[0] = h[0].wrapping_add(a);
        h[1] = h[1].wrapping_add(b);
        h[2] = h[2].wrapping_add(c);
        h[3] = h[3].wrapping_add(d);
        h[4] = h[4].wrapping_add(e);
    }
    let mut out = [0u8; 20];
    for (i, word) in h.iter().enumerate() {
        out[i * 4..i * 4 + 4].copy_from_slice(&word.to_be_bytes());
    }
    out
}

fn base64_encode(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    out
}

fn sec_websocket_accept(client_key: &str) -> String {
    base64_encode(&sha1(format!("{client_key}{WS_GUID}").as_bytes()))
}

/// The Sec-WebSocket-Key we send upstream. Chromium echoes whatever we
/// send; random bytes keep the handshake honest.
fn random_ws_key() -> String {
    use std::io::Read as _;
    let mut bytes = [0u8; 16];
    if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
        let _ = f.read_exact(&mut bytes);
    }
    base64_encode(&bytes)
}

/// Read one HTTP message head a byte at a time so nothing beyond the
/// terminator is consumed — both peers may begin WebSocket framing on the
/// segment right after it.
fn read_http_head(stream: &mut TcpStream, cap: usize) -> std::io::Result<String> {
    let mut head = Vec::with_capacity(512);
    let mut byte = [0u8; 1];
    loop {
        let n = stream.read(&mut byte)?;
        if n == 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "eof inside handshake",
            ));
        }
        head.push(byte[0]);
        if head.ends_with(b"\r\n\r\n") {
            return Ok(String::from_utf8_lossy(&head).into_owned());
        }
        if head.len() > cap {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "handshake head too large",
            ));
        }
    }
}

fn header<'a>(head: &'a str, name: &str) -> Option<&'a str> {
    head.lines().skip(1).find_map(|l| {
        let (k, v) = l.split_once(':')?;
        if k.trim().eq_ignore_ascii_case(name) {
            Some(v.trim())
        } else {
            None
        }
    })
}

fn query_param(url: &str, name: &str) -> Option<String> {
    let query = url.split_once('?')?.1;
    for pair in query.split('&') {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        if k == name {
            return Some(percent_decode(v));
        }
    }
    None
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(std::str::from_utf8(&b[i + 1..i + 3]).unwrap_or(""), 16)
            {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// CDP target ids are hex-with-dashes tokens; this gets spliced into the
/// upstream request path, so anything else is refused outright.
fn valid_target_id(t: &str) -> bool {
    (8..=64).contains(&t.len()) && t.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
}

fn respond_simple(stream: &mut TcpStream, status: u16, reason: &str, body: &str) {
    let resp = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(resp.as_bytes());
}

/// One direction of the splice. Pure byte relay — no framing awareness.
/// When this direction ends (either side closed), BOTH clones are shut
/// down: fd-level shutdown is per-socket, so this tears the whole
/// connection down and unblocks the opposite direction's blocking read —
/// a session can never strand one direction.
fn splice_bytes(mut from: TcpStream, mut to: TcpStream) {
    let mut buf = [0u8; 64 * 1024];
    loop {
        match from.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                if to.write_all(&buf[..n]).is_err() {
                    break;
                }
            }
        }
    }
    let _ = from.shutdown(std::net::Shutdown::Both);
    let _ = to.shutdown(std::net::Shutdown::Both);
}

fn handle_cdp_ws_session(
    mut client: TcpStream,
    resolve_browser_port: &dyn Fn() -> Option<u16>,
    ui_port: u16,
) {
    let ws_port = client.local_addr().map(|a| a.port()).unwrap_or(0);
    let _ = client.set_read_timeout(Some(Duration::from_secs(3)));
    let head = match read_http_head(&mut client, 8 * 1024) {
        Ok(h) => h,
        Err(_) => return,
    };
    let request_line = head.lines().next().unwrap_or("");
    let mut parts = request_line.split_whitespace();
    let url = parts.nth(1).unwrap_or("");
    let path = url.split(['?', '#']).next().unwrap_or("");
    if parts.next() != Some("HTTP/1.1") || url.is_empty() {
        respond_simple(&mut client, 400, "Bad Request", "{\"error\":\"bad request\"}");
        return;
    }
    if path != "/cdp/ws" {
        respond_simple(&mut client, 404, "Not Found", "{\"error\":\"not found\"}");
        return;
    }
    // Same host-pinning guard as the static server: blocks DNS rebinding
    // against this port.
    if header(&head, "Host").map(|h| h != format!("127.0.0.1:{ws_port}")).unwrap_or(true) {
        respond_simple(&mut client, 403, "Forbidden", "{\"error\":\"bad host\"}");
        return;
    }
    // A page on our own origin (or a local tool sending no Origin) only.
    if let Some(origin) = header(&head, "Origin") {
        if origin != format!("http://127.0.0.1:{ui_port}") {
            respond_simple(&mut client, 403, "Forbidden", "{\"error\":\"bad origin\"}");
            return;
        }
    }
    let upgrade_ok = header(&head, "Upgrade")
        .map(|v| v.to_ascii_lowercase().contains("websocket"))
        .unwrap_or(false);
    let conn_ok = header(&head, "Connection")
        .map(|v| v.to_ascii_lowercase().contains("upgrade"))
        .unwrap_or(false);
    let client_key = header(&head, "Sec-WebSocket-Key").unwrap_or("");
    let version_ok = header(&head, "Sec-WebSocket-Version") == Some("13");
    if !upgrade_ok || !conn_ok || client_key.is_empty() || !version_ok {
        respond_simple(&mut client, 400, "Bad Request", "{\"error\":\"not a websocket handshake\"}");
        return;
    }
    let Some(target) = query_param(url, "target").filter(|t| valid_target_id(t)) else {
        respond_simple(&mut client, 400, "Bad Request", "{\"error\":\"bad target\"}");
        return;
    };
    // Chromium's devtools endpoint is /devtools/<kind>/<id> — page for
    // normal tabs. The kind is validated, never taken raw.
    let kind = query_param(url, "kind")
        .filter(|k| !k.is_empty() && k.len() <= 20 && k.bytes().all(|c| c.is_ascii_lowercase() || c == b'_'))
        .unwrap_or_else(|| "page".to_string());
    let Some(browser_port) = resolve_browser_port() else {
        respond_simple(
            &mut client,
            503,
            "Service Unavailable",
            "{\"error\":\"agent browser not running\"}",
        );
        return;
    };

    // Upstream: act as a plain WebSocket client of the agent browser. No
    // Origin header — a foreign origin is exactly what it rejects.
    let mut upstream = match TcpStream::connect(("127.0.0.1", browser_port)) {
        Ok(s) => s,
        Err(e) => {
            respond_simple(&mut client, 502, "Bad Gateway", &format!("{{\"error\":\"cdp connect: {e}\"}}"));
            return;
        }
    };
    let _ = upstream.set_read_timeout(Some(Duration::from_secs(3)));
    let our_key = random_ws_key();
    let req = format!(
        "GET /devtools/{kind}/{target} HTTP/1.1\r\n\
         Host: 127.0.0.1:{browser_port}\r\n\
         Upgrade: websocket\r\n\
         Connection: Upgrade\r\n\
         Sec-WebSocket-Key: {our_key}\r\n\
         Sec-WebSocket-Version: 13\r\n\r\n"
    );
    if let Err(e) = upstream.write_all(req.as_bytes()) {
        respond_simple(&mut client, 502, "Bad Gateway", &format!("{{\"error\":\"cdp write: {e}\"}}"));
        return;
    }
    let upstream_head = match read_http_head(&mut upstream, 16 * 1024) {
        Ok(h) => h,
        Err(e) => {
            respond_simple(&mut client, 502, "Bad Gateway", &format!("{{\"error\":\"cdp handshake: {e}\"}}"));
            return;
        }
    };
    if !upstream_head.starts_with("HTTP/1.1 101") && !upstream_head.starts_with("HTTP/1.0 101") {
        respond_simple(&mut client, 502, "Bad Gateway", "{\"error\":\"cdp refused upgrade\"}");
        return;
    }

    let resp = format!(
        "HTTP/1.1 101 Switching Protocols\r\n\
         Upgrade: websocket\r\n\
         Connection: Upgrade\r\n\
         Sec-WebSocket-Accept: {}\r\n\r\n",
        sec_websocket_accept(client_key)
    );
    if client.write_all(resp.as_bytes()).is_err() {
        return;
    }

    // Splice. After the upgrade neither side speaks HTTP; drop the
    // handshake timeouts and relay until either direction closes, then
    // shut both sockets down so the surviving thread unblocks. Each
    // direction gets its own clones; the originals stay here for the
    // shutdown below.
    let _ = client.set_read_timeout(None);
    let _ = upstream.set_read_timeout(None);
    let (Ok(client_in), Ok(upstream_in), Ok(client_out), Ok(upstream_out)) = (
        client.try_clone(),
        upstream.try_clone(),
        client.try_clone(),
        upstream.try_clone(),
    ) else {
        return;
    };
    let to_cdp = std::thread::Builder::new()
        .name("cdp-ws-in".into())
        .spawn(move || splice_bytes(client_in, upstream_in));
    let to_client = std::thread::Builder::new()
        .name("cdp-ws-out".into())
        .spawn(move || splice_bytes(upstream_out, client_out));
    if let Ok(handle) = to_cdp {
        let _ = handle.join();
    }
    let _ = client.shutdown(std::net::Shutdown::Both);
    let _ = upstream.shutdown(std::net::Shutdown::Both);
    if let Ok(handle) = to_client {
        let _ = handle.join();
    }
}

/// Bind the raw CDP WebSocket proxy on an ephemeral loopback port,
/// publish it in CDP_WS_PORT, and serve forever. The browser port is read
/// through `resolve_browser_port` per connection so sessions pick up a
/// browser spawned after this listener (and tests can inject a fake).
fn spawn_cdp_ws_proxy(
    resolve_browser_port: impl Fn() -> Option<u16> + Send + Sync + 'static,
    ui_port: u16,
) -> u16 {
    let listener = match std::net::TcpListener::bind("127.0.0.1:0") {
        Ok(l) => l,
        Err(e) => {
            eprintln!("moch: cdp ws proxy bind failed ({e}) — browser screen stays offline");
            return 0;
        }
    };
    let port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
    let _ = CDP_WS_PORT.set(port);
    let resolver = std::sync::Arc::new(resolve_browser_port);
    if let Err(e) = std::thread::Builder::new().name("cdp-ws-accept".into()).spawn(move || {
        for conn in listener.incoming() {
            let Ok(stream) = conn else { continue };
            let resolver = std::sync::Arc::clone(&resolver);
            let _ = std::thread::Builder::new().name("cdp-ws-session".into()).spawn(move || {
                handle_cdp_ws_session(stream, resolver.as_ref(), ui_port);
            });
        }
    }) {
        eprintln!("moch: cdp ws proxy thread spawn failed ({e})");
    }
    port
}

fn content_type(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json",
        "png" => "image/png",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "map" => "application/json",
        _ => "application/octet-stream",
    }
}

/// Serve the EMBEDDED web-ui (compile-time assets) + /moch-config.json +
/// POST /dbg on a loopback port — the bundles no longer depend on the
/// repo's web-ui/ directory.
fn start_static_server(cfg: serde_json::Value, assets: Box<dyn tauri::Assets<tauri::Wry>>) -> u16 {
    let server = tiny_http::Server::http("127.0.0.1:0").expect("static server bind");
    let port = match server.server_addr() {
        tiny_http::ListenAddr::IP(addr) => addr.port(),
        _ => 0,
    };

    std::thread::spawn(move || {
        // DNS-rebinding guard: every request (any method) must target this
        // server's own loopback host:port.
        let expected_host = format!("127.0.0.1:{port}");
        // CSRF guard for the state-changing POSTs below: a hostile
        // website can fire no-cors POSTs at this loopback host (the Host
        // check above passes for them — the browser targets OUR host).
        // Browsers ALWAYS attach Origin on cross-origin POSTs; local
        // curl/tools send none — so any POST whose Origin isn't exactly
        // our own page origin is rejected with 403.
        let expected_origin = format!("http://127.0.0.1:{port}");
        let cross_site_post = |req: &tiny_http::Request| {
            req.headers().iter().any(|h| {
                h.field.as_str().as_str().eq_ignore_ascii_case("origin")
                    && h.value.as_str() != expected_origin
            })
        };
        for mut request in server.incoming_requests() {
            let host_ok = request.headers().iter().any(|h| {
                h.field.as_str().as_str().eq_ignore_ascii_case("host")
                    && h.value.as_str().eq_ignore_ascii_case(&expected_host)
            });
            if !host_ok {
                let _ = request.respond(Response::from_string("forbidden").with_status_code(403));
                continue;
            }

            let method = request.method().clone();
            let url = request.url().to_string();
            let path = url.split('?').next().unwrap_or("/").to_string();

            if method == Method::Post && path == "/dbg" {
                if cross_site_post(&request) {
                    let _ = request.respond(
                        Response::from_string("forbidden").with_status_code(403),
                    );
                    continue;
                }
                // Cap the body: a runaway client must not grow .dbg.log.
                use std::io::Read;
                let mut body = String::new();
                let _ = request
                    .as_reader()
                    .take(64 * 1024)
                    .read_to_string(&mut body);
                if let Ok(mut f) = std::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(desktop_dir().join(".dbg.log"))
                {
                    let _ = writeln!(f, "{body}");
                }
                let _ = request.respond(Response::from_string("ok"));
                continue;
            }

            if method == Method::Get && path == "/setup.json" {
                let done = std::fs::read_to_string(desktop_dir().join(".setup.json")).is_ok();
                let _ = request.respond(
                    Response::from_string(format!("{{\"done\":{}}}", done))
                        .with_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], b"application/json").unwrap()),
                );
                continue;
            }

            if method == Method::Post && path == "/setup-done" {
                if cross_site_post(&request) {
                    let _ = request.respond(
                        Response::from_string("forbidden").with_status_code(403),
                    );
                    continue;
                }
                let _ = std::fs::write(
                    desktop_dir().join(".setup.json"),
                    serde_json::json!({ "done": true, "t": std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs() }).to_string(),
                );
                let _ = request.respond(Response::from_string("ok"));
                continue;
            }

            if method == Method::Get && path == "/moch-config.json" {
                let _ = request.respond(
                    Response::from_string(cfg.to_string())
                        .with_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], b"application/json").unwrap()),
                );
                continue;
            }

            // Agent-browser target list proxy: the UI can't fetch the CDP
            // port cross-origin, so the shell relays GET /json for it.
            if method == Method::Get && path == "/cdp/json" {
                let (code, body) = match BROWSER_PORT.get() {
                    Some(bp) => match cdp_get_json(*bp, "/json") {
                        Ok(b) => (200, b),
                        Err(e) => (503, format!("{{\"error\":\"{e}\"}}")),
                    },
                    None => (503, "{\"error\":\"agent browser not running\"}".to_string()),
                };
                let _ = request.respond(
                    Response::from_string(body)
                        .with_status_code(code)
                        .with_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], b"application/json").unwrap()),
                );
                continue;
            }

            // Publish the raw CDP WebSocket proxy's port for the Browser
            // screen. Not in /moch-config.json because that snapshot is
            // built before the proxy binds its ephemeral port.
            if method == Method::Get && path == "/cdp/ws-port" {
                let body = match CDP_WS_PORT.get() {
                    Some(p) => format!("{{\"port\":{p}}}"),
                    None => "{\"port\":null}".to_string(),
                };
                let _ = request.respond(
                    Response::from_string(body)
                        .with_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], b"application/json").unwrap()),
                );
                continue;
            }

            if method == Method::Get {
                // Embedded assets: map lookup only, so the key can't
                // traverse. The DISK fallback below is a real filesystem
                // read and guards explicitly: reject ".."/absolute keys,
                // then verify containment in the UI dir.
                let rel = path.trim_start_matches('/').to_string();
                let key: &str = if rel.is_empty() { "index.html" } else { &rel };
                // SPA routing: expo-router owns the URL space client-side, so
                // a ROUTE (no file extension) falls back to index.html. A
                // missing ASSET must 404 instead — serving HTML under a .js/
                // .css/.ttf content type is a MIME error the page cannot
                // recover from, and it hid real 404s.
                let is_route = key == "index.html"
                    || !key.rsplit('/').next().unwrap_or("").contains('.');
                let ik = key.into();
                let mut served: Option<(&'static str, Vec<u8>)> = None;
                if let Some(b) = assets.get(&ik) {
                    served = Some((content_type(std::path::Path::new(key)), b.into_owned()));
                } else if is_route {
                    if let Some(b) = assets.get(&"index.html".into()) {
                        served = Some(("text/html; charset=utf-8", b.into_owned()));
                    }
                }
                if served.is_none() && !key.contains("..") && !key.starts_with('/') {
                    if let Some(web_ui) = ui_dir() {
                        let f = web_ui.join(key);
                        if f.is_file() {
                            let inside = f
                                .canonicalize()
                                .ok()
                                .zip(web_ui.canonicalize().ok())
                                .map(|(c, root)| c.starts_with(root))
                                .unwrap_or(false);
                            if inside {
                                if let Ok(bytes) = std::fs::read(&f) {
                                    served = Some((content_type(&f), bytes));
                                }
                            }
                        } else if is_route {
                            if let Ok(bytes) = std::fs::read(web_ui.join("index.html")) {
                                served = Some(("text/html; charset=utf-8", bytes));
                            }
                        }
                    }
                }
                if let Some((ct, bytes)) = served {
                    // no-store on every response: the UI is served from a
                    // loopback origin and must never come back stale from
                    // the WebKit disk cache after a rebuild (that shipped a
                    // frozen onboarding screen over a fresh bundle once).
                    let _ = request.respond(
                        Response::from_data(bytes)
                            .with_header(
                                tiny_http::Header::from_bytes(
                                    &b"Content-Type"[..],
                                    ct.as_bytes(),
                                )
                                .unwrap(),
                            )
                            .with_header(
                                tiny_http::Header::from_bytes(
                                    &b"Cache-Control"[..],
                                    &b"no-store, max-age=0"[..],
                                )
                                .unwrap(),
                            ),
                    );
                    continue;
                }
            }
            let _ = request.respond(Response::from_string("not found").with_status_code(404));
        }
    });

    port
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Dev-only inspector seam: MOCH_DEV=1 exposes the WebKit inspector on a
    // fixed loopback port so verify lanes can read DOM text instead of
    // screenshot OCR. Must run before webkit initializes in this process.
    if std::env::var("MOCH_DEV").ok().as_deref() == Some("1") {
        std::env::set_var("WEBKIT_INSPECTOR_SERVER", "127.0.0.1:9223");
        eprintln!("moch: dev inspector on http://127.0.0.1:9223");
    }
    // Single instance first — before spawning anything.
    acquire_single_instance();
    // Scrub token-bearing lines the PREVIOUS run left in the serve log
    // (old builds piped the child's stderr there raw) before this run
    // appends to it. Cheap no-op unless a marker line is present.
    scrub_serve_log(&desktop_dir().join(".hermes-serve.log"));
    // Install the signal handler BEFORE start_fork(): the handshake can
    // take up to 150s, and a signal in that window used to hit the
    // default disposition — killing the shell and orphaning the python
    // gateway (which kept port 9118 bound). terminate_runtime() already
    // tolerates HERMES_CHILD still being None (pre-spawn). Requires
    // ctrlc's "termination" feature; without it only SIGINT is handled.
    if let Err(e) = ctrlc::set_handler(move || {
        terminate_runtime();
        std::process::exit(0);
    }) {
        eprintln!(
            "moch: ctrlc handler not installed ({e}) — a signal during boot may orphan the runtime"
        );
    }
    // Supervisor first, then the window onto it. Moch runs ITS OWN runtime
    // (the fork, in a Moch-owned home) — attach is an explicit emergency
    // escape hatch (MOCH_ATTACH=1), never the default path.
    let (ws_url, token, mode) = if std::env::var("MOCH_ATTACH").ok().as_deref() == Some("1") {
        attach_existing().unwrap_or_else(|e| {
            eprintln!("moch: attach failed ({e})");
            ("".to_string(), "".to_string(), "error")
        })
    } else {
        start_fork().unwrap_or_else(|e| {
            eprintln!("moch: fork spawn failed ({e})");
            ("".to_string(), "".to_string(), "error")
        })
    };
    eprintln!("moch: hermes mode={mode} ws={ws_url}");

    // Watchdog: if the supervised runtime dies while the app lives, spawn
    // it again. The pairing token is stable per hermes home, so the UI's
    // saved config stays valid across a respawn. In ATTACH mode
    // HERMES_CHILD stays None and this loop is a no-op. The SHUTDOWN check
    // before each respawn keeps the watchdog from racing a teardown that
    // just took the child away.
    std::thread::spawn(|| loop {
        if SHUTDOWN.load(std::sync::atomic::Ordering::SeqCst) {
            return;
        }
        std::thread::sleep(Duration::from_secs(3));
        let exited = {
            let mut guard = hermes_child().lock();
            match guard.as_mut() {
                Some(child) => match child.try_wait() {
                    Ok(Some(_)) => {
                        guard.take();
                        true
                    }
                    _ => false,
                },
                None => false,
            }
        };
        if !exited || SHUTDOWN.load(std::sync::atomic::Ordering::SeqCst) {
            continue;
        }
        eprintln!("moch: runtime exited — respawning in 5s");
        std::thread::sleep(Duration::from_secs(5));
        while !SHUTDOWN.load(std::sync::atomic::Ordering::SeqCst) {
            match start_fork() {
                Ok((ws, _tok, rmode)) => {
                    eprintln!("moch: runtime respawned mode={rmode} ws={ws}");
                    break;
                }
                Err(e) => {
                    eprintln!("moch: respawn failed ({e}) — retry in 15s");
                    std::thread::sleep(Duration::from_secs(15));
                }
            }
        }
    });

    let log_tail = std::fs::read_to_string(desktop_dir().join(".hermes-serve.log"))
        .map(|s| {
            // Redact anything that could carry the live token: handshake
            // lines, or any line quoting the token string itself.
            let lines: Vec<&str> = s
                .lines()
                .filter(|l| {
                    if l.contains("MOCH_GATEWAY_INFO") {
                        return false;
                    }
                    token.is_empty() || !l.contains(token.as_str())
                })
                .collect();
            let n = lines.len();
            lines[n.saturating_sub(12)..].join("\n")
        })
        .unwrap_or_default();
    let home = std::env::var("MOCH_HERMES_HOME")
        .unwrap_or_else(|_| desktop_dir().join("runtime-home").to_string_lossy().to_string());

    let cfg = serde_json::json!({
        "wsUrl": ws_url, "token": token, "mode": mode,
        "home": home, "logTail": log_tail,
    });
    let mut ctx = tauri::generate_context!();
    // The shell serves the UI itself (loopback origin for hermes' guard),
    // so tauri's own asset serving is never used — swap in a null provider
    // and move the embedded assets into our static server.
    struct NullAssets;
    impl tauri::Assets<tauri::Wry> for NullAssets {
      fn get(&self, _k: &tauri::utils::assets::AssetKey) -> Option<std::borrow::Cow<'_, [u8]>> { None }
      fn iter(&self) -> Box<tauri::utils::assets::AssetsIter<'_>> { Box::new(std::iter::empty()) }
      fn csp_hashes(&self, _p: &tauri::utils::assets::AssetKey) -> Box<dyn std::iter::Iterator<Item = tauri::utils::assets::CspHash<'_>> + '_> { Box::new(std::iter::empty()) }
    }
    let assets = std::mem::replace(&mut ctx.assets, Box::new(NullAssets));
    let port = start_static_server(cfg, assets);
    eprintln!("moch: static server on {port} (embedded UI)");
    let ws_port = spawn_cdp_ws_proxy(|| BROWSER_PORT.get().copied(), port);
    eprintln!("moch: cdp ws proxy on {ws_port}");

    let selftest = std::env::var("MOCH_SELFTEST").ok().as_deref() == Some("1");
    let url = url::Url::parse(&format!(
        "http://127.0.0.1:{port}/{}",
        if selftest { "?selftest=1" } else { "" }
    ))
    .expect("window url");

    let app = tauri::Builder::default()
        .setup(move |app| {
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                .title("Moch")
                .inner_size(1280.0, 840.0)
                .min_inner_size(960.0, 600.0)
                .resizable(true)
                .center()
                .build()?;
            eprintln!("moch: window built");
            Ok(())
        })
        .build(ctx)
        .expect("error while building tauri application");

    app.run(|_app, event| {
        if let tauri::RunEvent::Exit = event {
            terminate_runtime();
        }
    });
}

#[cfg(test)]
mod cdp_ws_tests {
    use super::*;
    use std::io::Write as _;

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    #[test]
    fn sha1_matches_published_vectors() {
        assert_eq!(hex(&sha1(b"abc")), "a9993e364706816aba3e25717850c26c9cd0d89d");
        assert_eq!(
            hex(&sha1(b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")),
            "84983e441c3bd26ebaae4aa1f95129e5e54670f1"
        );
    }

    #[test]
    fn websocket_accept_matches_rfc6455_example() {
        assert_eq!(
            sec_websocket_accept("dGhlIHNhbXBsZSBub25jZQ=="),
            "s3pPLMBiTxaQ9kYGzzhZRbK+xOo="
        );
    }

    #[test]
    fn base64_handles_all_padding_cases() {
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
        assert_eq!(base64_encode(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64_encode(b"foob"), "Zm9vYg==");
    }

    #[test]
    fn target_ids_beyond_alnum_dashes_are_refused() {
        assert!(valid_target_id("0123456789ABCDEF"));
        assert!(!valid_target_id("../etc/passwd"));
        assert!(!valid_target_id("short"));
        assert!(!valid_target_id(""));
    }

    /// Hand-craft a masked client frame (what a browser sends) and an
    /// unmasked server frame (what Chromium sends); the proxy must relay
    /// both VERBATIM.
    #[test]
    fn proxy_splices_frames_both_ways_verbatim() {
        let upstream = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let upstream_port = upstream.local_addr().unwrap().port();
        let upstream_handle = std::thread::spawn(move || {
            let (mut sock, _) = upstream.accept().unwrap();
            let head = read_http_head(&mut sock, 8 * 1024).unwrap();
            assert!(head.contains("GET /devtools/page/0123456789ABCDEF "), "upstream path: {head}");
            let key = header(&head, "Sec-WebSocket-Key").unwrap().to_string();
            let resp = format!(
                "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {}\r\n\r\n",
                sec_websocket_accept(&key)
            );
            sock.write_all(resp.as_bytes()).unwrap();
            // Read the client frame the proxy relayed upstream, byte for byte.
            // 2 header + 4 mask + 5 payload.
            let mut relayed = [0u8; 11];
            std::io::Read::read_exact(&mut sock, &mut relayed).unwrap();
            let payload = b"ping!";
            let mask = [0x01u8, 0x02, 0x03, 0x04];
            let mut masked = vec![0x81, 0x80 | 5, mask[0], mask[1], mask[2], mask[3]];
            masked.extend(payload.iter().enumerate().map(|(i, &b)| b ^ mask[i % 4]));
            assert_eq!(relayed.to_vec(), masked, "upstream must see the masked frame verbatim");
            // And answer with an unmasked server frame.
            sock.write_all(b"\x81\x05hello").unwrap();
        });

        let proxy_port = spawn_cdp_ws_proxy(move || Some(upstream_port), 1);
        let mut client = TcpStream::connect(("127.0.0.1", proxy_port)).unwrap();
        let handshake = format!(
            "GET /cdp/ws?target=0123456789ABCDEF HTTP/1.1\r\n\
             Host: 127.0.0.1:{proxy_port}\r\n\
             Upgrade: websocket\r\n\
             Connection: Upgrade\r\n\
             Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\
             Sec-WebSocket-Version: 13\r\n\r\n"
        );
        client.write_all(handshake.as_bytes()).unwrap();
        let head = read_http_head(&mut client, 8 * 1024).unwrap();
        assert!(head.starts_with("HTTP/1.1 101"), "upgrade refused: {head}");
        assert!(header(&head, "Sec-WebSocket-Accept").is_some());

        let payload = b"ping!";
        let mask = [0x01u8, 0x02, 0x03, 0x04];
        let mut frame = vec![0x81, 0x80 | 5, mask[0], mask[1], mask[2], mask[3]];
        frame.extend(payload.iter().enumerate().map(|(i, &b)| b ^ mask[i % 4]));
        client.write_all(&frame).unwrap();

        let mut relayed_back = [0u8; 7];
        std::io::Read::read_exact(&mut client, &mut relayed_back).unwrap();
        assert_eq!(&relayed_back, b"\x81\x05hello", "client must see the server frame verbatim");
        upstream_handle.join().unwrap();
    }

    #[test]
    fn proxy_rejects_without_browser_and_with_bad_target() {
        let proxy_port = spawn_cdp_ws_proxy(|| None, 1);
        let dial = |url: &str| -> String {
            let mut client = TcpStream::connect(("127.0.0.1", proxy_port)).unwrap();
            let handshake = format!(
                "GET {url} HTTP/1.1\r\n\
                 Host: 127.0.0.1:{proxy_port}\r\n\
                 Upgrade: websocket\r\n\
                 Connection: Upgrade\r\n\
                 Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\
                 Sec-WebSocket-Version: 13\r\n\r\n"
            );
            client.write_all(handshake.as_bytes()).unwrap();
            read_http_head(&mut client, 8 * 1024).unwrap()
        };
        assert!(dial("/cdp/ws?target=0123456789ABCDEF").starts_with("HTTP/1.1 503"));
        assert!(dial("/cdp/ws?target=%2E%2E%2Fetc").starts_with("HTTP/1.1 400"));
    }
}
