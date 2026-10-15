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

use std::io::Write;
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use tauri::{WebviewUrl, WebviewWindowBuilder};
use tiny_http::{Method, Response};

const HERMES_PORT: u16 = 9118;
/// A machine-level serve that may already be running (systemd service).
const ATTACH_PORT: u16 = 9119;

static HERMES_CHILD: OnceLock<Mutex<Option<std::process::Child>>> = OnceLock::new();

fn hermes_child() -> &'static Mutex<Option<std::process::Child>> {
    HERMES_CHILD.get_or_init(|| Mutex::new(None))
}

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../..")
        .canonicalize()
        .expect("repo root")
}

fn desktop_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..")
}

/// Refuse to start twice: flock() the desktop lock file for the process
/// lifetime. The kernel releases the flock on exit; the file itself is
/// left in place (the next run just re-locks it).
fn acquire_single_instance() {
    let lock = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(false)
        .open(desktop_dir().join(".moch-desktop.lock"))
        .expect("open .moch-desktop.lock");
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
    let mut child = match hermes_child().lock().unwrap().take() {
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
    let mut log = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(desktop_dir().join(".hermes-serve.log"))
        .map_err(|e| format!("open serve log: {e}"))?;
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
        .stderr(log_err)
        .spawn()
        .map_err(|e| format!("spawn {}: {e}", python.display()))?;
    eprintln!("moch: runtime spawned pid={:?}", child.id());

    let stdout = child.stdout.take();
    // Register the child right away (not after the handshake) so a signal
    // arriving during boot still finds it and tears it down.
    *hermes_child().lock().unwrap() = Some(child);

    // Drain stdout into the log (observability only — the real handshake
    // is file-based). Skip MOCH_GATEWAY_INFO lines: they carry the live
    // session token and this file is world-readable.
    if let Some(out) = stdout {
        std::thread::spawn(move || {
            use std::io::BufRead;
            let reader = std::io::BufReader::new(out);
            for line in reader.lines().map_while(Result::ok) {
                if line.starts_with("MOCH_GATEWAY_INFO") {
                    continue;
                }
                let _ = writeln!(log, "{line}");
            }
        });
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
            .unwrap()
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
    if token.is_empty() || !wait_port(port, 5_000) {
        // The handshake JSON carries the runtime's own error, if any —
        // surface it instead of the generic "port not accepting".
        return Err(match info["error"].as_str().filter(|e| !e.is_empty()) {
            Some(e) => format!("gateway startup failed: {e}"),
            None => "gateway info arrived but port not accepting".to_string(),
        });
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

            if method == Method::Get {
                // Embedded assets: map lookup only, so the key can't
                // traverse. The DISK fallback below is a real filesystem
                // read and guards explicitly: reject ".."/absolute keys,
                // then verify containment in web-ui/.
                let rel = path.trim_start_matches('/').to_string();
                let key: &str = if rel.is_empty() { "index.html" } else { &rel };
                let ik = key.into();
                let bytes = assets
                    .get(&ik)
                    .or_else(|| assets.get(&"index.html".into()))
                    .map(|b| b.into_owned())
                    .or_else(|| {
                        if key.contains("..") || key.starts_with('/') {
                            return None;
                        }
                        let web_ui = desktop_dir().join("web-ui");
                        let f = web_ui.join(key);
                        if f.is_file() {
                            let inside = f
                                .canonicalize()
                                .ok()
                                .zip(web_ui.canonicalize().ok())
                                .map(|(c, root)| c.starts_with(root))
                                .unwrap_or(false);
                            if !inside {
                                return None;
                            }
                            std::fs::read(f).ok()
                        } else {
                            std::fs::read(web_ui.join("index.html")).ok()
                        }
                    });
                if let Some(bytes) = bytes {
                    let ct = content_type(std::path::Path::new(key));
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
    // Single instance first — before spawning anything.
    acquire_single_instance();
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

    // Tear the supervised runtime down on SIGTERM/SIGINT too — RunEvent::Exit
    // only fires on a clean loop exit, so signals used to orphan the
    // python child (which kept port 9118 bound). Requires ctrlc's
    // "termination" feature; without it only SIGINT is handled.
    let _ = ctrlc::set_handler(move || {
        terminate_runtime();
        std::process::exit(0);
    });

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
