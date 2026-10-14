//! Moch Desktop — local-only PC build.
//!
//! The Rust shell does three things:
//!  1. SUPERVISE the local hermes agent: spawns the user's hermes fork
//!     (`app/hermes-src`, with their changes) as `serve` on a loopback
//!     port with a session token we mint ourselves. Falls back to
//!     attaching an already-running machine-level serve on 9119.
//!  2. SERVE the built UI from 127.0.0.1:<port> — so the webview origin
//!     is a loopback origin hermes' WS host/origin guard accepts.
//!  3. OPEN the window on that origin. The UI talks to hermes directly
//!     over ws://127.0.0.1 using the app's own TS protocol stack.

use std::io::{Read, Write};
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

fn mint_token() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let pid = std::process::id();
    format!("{:x}{:x}{:x}", nanos, pid, nanos.rotate_left(32) ^ 0x5eed)
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

    use std::process::Stdio;
    let mut child = std::process::Command::new(&python)
        .arg(&runner)
        .env("MOCH_FORK_SRC", &fork)
        .env("MOCH_RUNTIME_PKGS", root.join("app/python-runtime"))
        .env("MOCH_GATEWAY_PORT", HERMES_PORT.to_string())
        .env("HERMES_HOME", &home)
        .current_dir(&fork)
        .stdout(Stdio::piped())
        .stderr(log_err)
        .spawn()
        .map_err(|e| format!("spawn {}: {e}", python.display()))?;
    eprintln!("moch: runtime spawned pid={:?}", child.id());

    // Drain stdout into the log (observability only — the real handshake
    // is file-based).
    let stdout = child.stdout.take();
    if let Some(out) = stdout {
        std::thread::spawn(move || {
            use std::io::BufRead;
            let reader = std::io::BufReader::new(out);
            for line in reader.lines().map_while(Result::ok) {
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
    while std::time::Instant::now() < deadline {
        if let Ok(s) = std::fs::read_to_string(&info_path) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&s) {
                info = v;
                break;
            }
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    *hermes_child().lock().unwrap() = Some(child);
    if info.is_null() {
        return Err("runtime did not write gateway info in 150s".to_string());
    }
    eprintln!("moch: handshake received");
    let port = info["port"].as_u64().unwrap_or(HERMES_PORT as u64) as u16;
    let token = info["token"].as_str().unwrap_or_default().to_string();
    if token.is_empty() || !wait_port(port, 5_000) {
        return Err("gateway info arrived but port not accepting".to_string());
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

/// Serve web-ui/ + /moch-config.json + POST /dbg on a loopback port.
fn start_static_server(cfg: serde_json::Value) -> u16 {
    let server = tiny_http::Server::http("127.0.0.1:0").expect("static server bind");
    let port = match server.server_addr() {
        tiny_http::ListenAddr::IP(addr) => addr.port(),
        _ => 0,
    };
    let webui = desktop_dir().join("web-ui");

    std::thread::spawn(move || {
        for mut request in server.incoming_requests() {
            let method = request.method().clone();
            let url = request.url().to_string();
            let path = url.split('?').next().unwrap_or("/").to_string();

            if method == Method::Post && path == "/dbg" {
                let mut body = String::new();
                let _ = request.as_reader().read_to_string(&mut body);
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
                let rel = path.trim_start_matches('/');
                let file = if rel.is_empty() {
                    webui.join("index.html")
                } else {
                    let f = webui.join(rel);
                    // path traversal guard
                    if f.starts_with(&webui) { f } else { webui.join("index.html") }
                };
                if let Ok(bytes) = std::fs::read(&file) {
                    let ct = content_type(&file);
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
            let lines: Vec<&str> = s.lines().collect();
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
    let port = start_static_server(cfg);
    eprintln!("moch: static server on {port}");

    let selftest = std::env::var("MOCH_SELFTEST").ok().as_deref() == Some("1");
    let url = url::Url::parse(&format!(
        "http://127.0.0.1:{port}/{}",
        if selftest { "?selftest=1" } else { "" }
    ))
    .expect("window url");

    // Kill the supervised runtime on SIGTERM/SIGINT too — RunEvent::Exit
    // only fires on a clean loop exit, so signals used to orphan the
    // python child (which kept port 9118 bound).
    let _ = ctrlc::set_handler({
        move || {
            if let Some(mut child) = hermes_child().lock().unwrap().take() {
                let _ = child.kill();
            }
            std::process::exit(0);
        }
    });

    let app = tauri::Builder::default()
        .setup(move |app| {
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                .title("Moch")
                .inner_size(480.0, 900.0)
                .min_inner_size(420.0, 640.0)
                .resizable(true)
                .center()
                .build()?;
            eprintln!("moch: window built");
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|_app, event| {
        if let tauri::RunEvent::Exit = event {
            if let Some(mut child) = hermes_child().lock().unwrap().take() {
                let _ = child.kill();
            }
        }
    });
}
