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
use std::io::Write;
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
/// `app-web/` (the shared Moch app's expo web export — what `npm run
/// build:app-web` writes and `tauri.conf.json` embeds) with `web-ui/` as the
/// frozen fork's old directory. This is the re-export path, not the normal
/// one; embedded assets win.
fn ui_dir() -> Option<PathBuf> {
    let base = desktop_dir();
    for name in ["app-web", "web-ui"] {
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
/// short-lived connection per call.
fn cdp_get_json(port: u16, path: &str) -> Result<String, String> {
    let mut stream = TcpStream::connect(("127.0.0.1", port))
        .map_err(|e| format!("cdp connect: {e}"))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .map_err(|e| format!("cdp timeout: {e}"))?;
    use std::io::{Read as _, Write as _};
    let req = format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
    stream
        .write_all(req.as_bytes())
        .map_err(|e| format!("cdp write: {e}"))?;
    let mut raw = Vec::new();
    stream
        .read_to_end(&mut raw)
        .map_err(|e| format!("cdp read: {e}"))?;
    let text = String::from_utf8_lossy(&raw);
    let body = text
        .split_once("\r\n\r\n")
        .map(|(_, b)| b)
        .ok_or("cdp: malformed response")?;
    let status_ok = text.starts_with("HTTP/1.1 200") || text.starts_with("HTTP/1.0 200");
    if !status_ok {
        return Err(format!("cdp: non-200 from {path}"));
    }
    Ok(body.to_string())
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
                    let _ = request.respond(
                        Response::from_data(bytes).with_header(
                            tiny_http::Header::from_bytes(&b"Content-Type"[..], ct.as_bytes()).unwrap(),
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
