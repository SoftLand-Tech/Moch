//! Browser management: launch a dedicated Chromium with CDP for the agent
//! browser pane, and let the UI + hermes both attach to it.
//!
//! The Chromium runs with its own persistent profile under the app state dir,
//! `--remote-debugging-port` on a free loopback port, headless=new (the app
//! renders the page via CDP screencast in the Browser pane; "open externally"
//! hands a URL to the real browser). Both the webview (UI) and the gateway
//! (hermes' browser tools) speak CDP to 127.0.0.1:<port> directly.

use std::net::TcpListener;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::sync::OnceLock;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

pub struct BrowserState {
    pub child: Mutex<Option<Child>>,
    pub info: Mutex<Option<BrowserInfo>>,
}

pub struct BrowserInfo {
    pub port: u16,
}

impl BrowserState {
    pub fn new() -> Self {
        Self {
            child: Mutex::new(None),
            info: Mutex::new(None),
        }
    }
}

pub fn state() -> &'static BrowserState {
    static STATE: OnceLock<BrowserState> = OnceLock::new();
    STATE.get_or_init(BrowserState::new)
}

#[derive(Serialize, Clone)]
pub struct BrowserStatus {
    pub running: bool,
    pub port: Option<u16>,
    pub executable: Option<String>,
    pub profile_dir: Option<String>,
}

fn chromium_binary() -> Option<PathBuf> {
    if let Ok(bin) = std::env::var("MOCH_BROWSER_BIN") {
        let p = PathBuf::from(bin);
        if p.exists() {
            return Some(p);
        }
    }
    for name in [
        "chromium",
        "chromium-browser",
        "google-chrome-stable",
        "google-chrome",
        "brave-browser",
        "microsoft-edge-stable",
        "vivaldi-stable",
    ] {
        if let Some(path) = which(name) {
            return Some(path);
        }
    }
    None
}

fn which(name: &str) -> Option<PathBuf> {
    let path = std::env::var("PATH").ok()?;
    for dir in path.split(':') {
        let candidate = PathBuf::from(dir).join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

fn free_port() -> std::io::Result<u16> {
    TcpListener::bind(("127.0.0.1", 0)).map(|s| s.local_addr().unwrap().port())
}

fn port_accepts(port: u16) -> bool {
    std::net::TcpStream::connect_timeout(
        &std::net::SocketAddr::from(([127, 0, 0, 1], port)),
        std::time::Duration::from_millis(300),
    )
    .is_ok()
}

fn state_dir(app: &AppHandle) -> PathBuf {
    if let Ok(dir) = std::env::var("MOCH_DESKTOP_STATE_DIR") {
        return PathBuf::from(dir);
    }
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| dirs::data_dir().unwrap_or_else(|| PathBuf::from(".")).join("moch-desktop"))
}


/// The port of a previously launched agent Chromium (`<state>/browser-port`),
/// so a new app run ADOPTS the still-alive browser instead of spawning a
/// second instance against the same profile (which would delegate to the
/// singleton and silently never come up).
fn persisted_port(app: &AppHandle) -> Option<u16> {
    let file = state_dir(app).join("browser-port");
    let text = std::fs::read_to_string(file).ok()?;
    text.trim().parse::<u16>().ok().filter(|p| *p > 0)
}

fn persist_port(app: &AppHandle, port: u16) {
    let _ = std::fs::write(state_dir(app).join("browser-port"), port.to_string());
}

fn clear_persisted_port(app: &AppHandle) {
    let _ = std::fs::remove_file(state_dir(app).join("browser-port"));
}

/// A live CDP endpoint answers /json/version on loopback.
fn cdp_alive(port: u16) -> bool {
    use std::io::{Read, Write};
    let Ok(mut stream) = std::net::TcpStream::connect(("127.0.0.1", port)) else { return false };
    stream.set_read_timeout(Some(std::time::Duration::from_millis(600))).ok();
    let req = format!("GET /json/version HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    if stream.write_all(req.as_bytes()).is_err() {
        return false;
    }
    let mut buf = [0u8; 256];
    match stream.read(&mut buf) {
        Ok(n) => String::from_utf8_lossy(&buf[..n]).contains("200"),
        Err(_) => false,
    }
}

/// Adopt a previously launched, still-alive agent browser (if any).
fn adopt_alive(app: &AppHandle) -> Option<u16> {
    let port = persisted_port(app)?;
    if port_accepts(port) && cdp_alive(port) {
        Some(port)
    } else {
        None
    }
}

#[tauri::command]
pub fn browser_status(app: AppHandle) -> BrowserStatus {
    {
        let mut info = state().info.lock().unwrap();
        if info.is_none() {
            if let Some(port) = adopt_alive(&app) {
                *info = Some(BrowserInfo { port });
            }
        }
    }
    let info = state().info.lock().unwrap();
    match info.as_ref() {
        Some(i) if port_accepts(i.port) => BrowserStatus {
            running: true,
            port: Some(i.port),
            executable: chromium_binary().map(|p| p.display().to_string()),
            profile_dir: None,
        },
        _ => BrowserStatus {
            running: false,
            port: None,
            executable: chromium_binary().map(|p| p.display().to_string()),
            profile_dir: None,
        },
    }
}

#[tauri::command]
pub fn browser_launch(app: AppHandle) -> Result<BrowserStatus, String> {
    {
        let guard = state().info.lock().unwrap();
        if let Some(info) = guard.as_ref() {
            if port_accepts(info.port) {
                let status = browser_status(app.clone());
                let _ = app.emit("browser://status", &status);
                return Ok(status);
            }
        }
    }
    // A previous run's browser may still be alive — adopt it (spawning a
    // second instance on the same profile silently delegates and dies).
    if let Some(port) = adopt_alive(&app) {
        *state().info.lock().unwrap() = Some(BrowserInfo { port });
        let status = browser_status(app.clone());
        let _ = app.emit("browser://status", &status);
        return Ok(status);
    }

    let bin = chromium_binary().ok_or("no Chromium/Chrome browser found on this machine")?;
    let port = free_port().map_err(|e| e.to_string())?;
    let profile = state_dir(&app).join("chromium-profile");
    std::fs::create_dir_all(&profile).map_err(|e| e.to_string())?;

    let mut cmd = Command::new(&bin);
    cmd.args([
        "--headless=new",
        "--remote-debugging-port",
        &port.to_string(),
        "--remote-debugging-address=127.0.0.1",
        // The webview (tauri.localhost / vite dev origin) and loopback tools
        // connect to the CDP websocket; Chromium >=111 rejects foreign Origins.
        "--remote-allow-origins=*",
        &format!("--user-data-dir={}", profile.display()),
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
        "--disable-features=Translate,MediaRouter,OptimizationHints",
        "--hide-scrollbars",
        "--window-size=1600,1200",
        "--mute-audio",
        "about:blank",
    ]);
    cmd.stdout(Stdio::null());
    cmd.stderr(Stdio::null());

    let child = cmd.spawn().map_err(|e| format!("launch {} failed: {e}", bin.display()))?;
    *state().child.lock().unwrap() = Some(child);
    *state().info.lock().unwrap() = Some(BrowserInfo { port });

    // Wait for the DevTools endpoint.
    for _ in 0..100 {
        std::thread::sleep(std::time::Duration::from_millis(100));
        if port_accepts(port) {
            persist_port(&app, port);
            let status = browser_status(app.clone());
            let _ = app.emit("browser://status", &status);
            return Ok(status);
        }
    }
    Err("chromium did not expose the CDP port".into())
}

#[tauri::command]
pub fn browser_stop(app: AppHandle) -> Result<bool, String> {
    clear_persisted_port(&app);
    let mut child_guard = state().child.lock().unwrap();
    *state().info.lock().unwrap() = None;
    if let Some(mut child) = child_guard.take() {
        let _ = child.kill();
        let _ = child.wait();
        Ok(true)
    } else {
        Ok(false)
    }
}

/// Proxy one HTTP request to a loopback CDP endpoint (Chromium's DevTools
/// HTTP server sends no CORS headers — the webview can never fetch it
/// directly). Std-only HTTP/1.1 GET/PUT over a TcpStream; returns the body
/// text unchanged (the caller parses JSON when it is JSON).
#[tauri::command]
pub fn cdp_fetch(port: u16, path: String, method: String) -> Result<String, String> {
    use std::io::{Read, Write};
    use std::net::TcpStream;
    let method = if method.eq_ignore_ascii_case("PUT") { "PUT" } else { "GET" };
    let mut stream = TcpStream::connect(("127.0.0.1", port)).map_err(|e| e.to_string())?;
    stream.set_read_timeout(Some(std::time::Duration::from_secs(5))).ok();
    stream.set_write_timeout(Some(std::time::Duration::from_secs(5))).ok();
    let req = format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
    );
    stream.write_all(req.as_bytes()).map_err(|e| e.to_string())?;
    let mut buf = Vec::new();
    stream.read_to_end(&mut buf).map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&buf).to_string();
    // Split headers/body; surface non-2xx as an error with the body attached.
    let split = text.find("\r\n\r\n").ok_or("cdp: malformed response")?;
    let (head, body) = text.split_at(split);
    let body = &body[4..];
    let status: u16 = head
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse().ok())
        .unwrap_or(0);
    if !(200..300).contains(&status) {
        return Err(format!("cdp: HTTP {status} for {path}: {}", body.chars().take(200).collect::<String>()));
    }
    // Handle chunked transfer-encoding minimally (DevTools uses it for some
    // endpoints): concatenate the chunk bodies.
    if head.to_ascii_lowercase().contains("transfer-encoding: chunked") {
        let mut out = String::new();
        let mut rest = body;
        loop {
            let Some(line_end) = rest.find("\r\n") else { break };
            let size = usize::from_str_radix(rest[..line_end].trim(), 16).unwrap_or(0);
            if size == 0 {
                break;
            }
            let start = line_end + 2;
            let end = (start + size).min(rest.len());
            out.push_str(&rest[start..end]);
            rest = if end + 2 <= rest.len() { &rest[end + 2..] } else { "" };
        }
        return Ok(out);
    }
    Ok(body.to_string())
}
