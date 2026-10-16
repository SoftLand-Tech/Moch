//! Gateway process management: spawn/supervise the moch_desktop Python runtime.
//!
//! Lifecycle: Tauri picks a free port, spawns `<runtime>/python -m moch_desktop
//! --port N` with env pinned (HERMES_PARENT_PID so the gateway self-exits if we
//! die), streams its stdout to the UI (`gateway://log`), and reports readiness
//! from the `HERMES_BACKEND_READY port=N` sentinel plus the runtime state file.

use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

pub struct GatewayState {
    pub child: Mutex<Option<Child>>,
    pub info: Mutex<Option<GatewayInfo>>,
}

pub struct GatewayInfo {
    pub port: u16,
    pub token: String,
    pub home: PathBuf,
    pub workspace: PathBuf,
}

impl GatewayState {
    pub fn new() -> Self {
        Self {
            child: Mutex::new(None),
            info: Mutex::new(None),
        }
    }
}

pub fn state() -> &'static GatewayState {
    static STATE: OnceLock<GatewayState> = OnceLock::new();
    STATE.get_or_init(GatewayState::new)
}

#[derive(Serialize, Clone)]
pub struct GatewayStatus {
    pub running: bool,
    pub port: Option<u16>,
    pub token: Option<String>,
    pub home: Option<String>,
    pub workspace: Option<String>,
}

fn repo_root() -> Option<PathBuf> {
    // Dev layout: <repo>/desktop/src-tauri. Packaged builds set MOCH_REPO_ROOT.
    if let Ok(root) = std::env::var("MOCH_REPO_ROOT") {
        let p = PathBuf::from(root);
        if p.is_dir() {
            return Some(p);
        }
    }
    let exe = std::env::current_exe().ok()?;
    exe.ancestors()
        .skip(1)
        .find(|p| p.join("desktop").join("runtime").is_dir() && p.join("app").is_dir())
        .map(|p| p.to_path_buf())
}

pub fn state_dir(app: &AppHandle) -> PathBuf {
    if let Ok(dir) = std::env::var("MOCH_DESKTOP_STATE_DIR") {
        return PathBuf::from(dir);
    }
    app.path().app_data_dir().unwrap_or_else(|_| {
        dirs::data_dir().unwrap_or_else(|| PathBuf::from(".")).join("moch-desktop")
    })
}

pub fn python_bin(_app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(bin) = std::env::var("MOCH_PYTHON_BIN") {
        return Ok(PathBuf::from(bin));
    }
    let root = repo_root().ok_or("cannot locate the Moch repo (dev: run via cargo tauri dev; set MOCH_REPO_ROOT otherwise)")?;
    let venv_python = root.join("desktop").join("runtime").join(".venv").join("bin").join("python");
    if venv_python.exists() {
        return Ok(venv_python);
    }
    Err("desktop runtime venv missing — create it with desktop/runtime/setup.sh".into())
}

fn free_port() -> std::io::Result<u16> {
    std::net::TcpListener::bind(("127.0.0.1", 0)).map(|s| s.local_addr().unwrap().port())
}

fn read_state_file(dir: &PathBuf) -> Option<serde_json::Value> {
    let text = std::fs::read_to_string(dir.join("desktop-runtime.json")).ok()?;
    serde_json::from_str(&text).ok()
}

fn spawn_lines(app: &AppHandle, child: &mut Child) -> Option<u16> {
    let stdout = child.stdout.take()?;
    let app2 = app.clone();
    let pid = child.id();
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            let Ok(line) = line else { break };
            let _ = app2.emit("gateway://log", line.clone());
            // The gateway's stdout may be a pipe that keeps other readers from
            // seeing EOF; we only scan for the sentinel here.
            if line.starts_with("HERMES_BACKEND_READY") {
                if let Some(port) = line
                    .split("port=")
                    .nth(1)
                    .and_then(|s| s.trim().parse::<u16>().ok())
                {
                    let _ = app2.emit("gateway://ready-port", port);
                }
            }
            let _ = pid; // keep the pid alive for debugging
        }
    });
    let stderr = child.stderr.take()?;
    let app3 = app.clone();
    std::thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines() {
            let Ok(line) = line else { break };
            let _ = app3.emit("gateway://log", format!("[stderr] {line}"));
        }
    });
    None
}

#[tauri::command]
pub fn gateway_start(app: AppHandle) -> Result<GatewayStatus, String> {
    gateway_start_impl(app)
}

fn gateway_start_impl(app: AppHandle) -> Result<GatewayStatus, String> {
    {
        let mut guard = state().child.lock().unwrap();
        if let Some(child) = guard.as_mut() {
            if child.try_wait().map(|r| r.is_some()).unwrap_or(true) {
                let _ = child.kill();
            }
        }
    }

    let dir = state_dir(&app);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    // A healthy gateway from a previous run is adopted when its state file
    // names a live port + token (fast path: "opens fast" after a UI crash).
    // The port accepting connections is the ground truth; the recorded pid is
    // only a hint (it can live outside our PID namespace under sandboxes).
    if let Some(v) = read_state_file(&dir) {
        let port = v.get("port").and_then(|p| p.as_u64()).and_then(|p| u16::try_from(p).ok());
        let token = v.get("token").and_then(|t| t.as_str()).map(|s| s.to_string());
        let home = v.get("home").and_then(|h| h.as_str()).map(PathBuf::from);
        let workspace = v.get("workspace").and_then(|h| h.as_str()).map(PathBuf::from);
        if let (Some(port), Some(token)) = (port, token) {
            if port_accepts(port) {
                let status = GatewayStatus {
                    running: true,
                    port: Some(port),
                    token: Some(token),
                    home: home.map(|p| p.display().to_string()),
                    workspace: workspace.map(|p| p.display().to_string()),
                };
                publish(&app, &status);
                return Ok(status);
            }
        }
    }

    let python = python_bin(&app)?;
    let port = free_port().map_err(|e| e.to_string())?;
    let root = repo_root().ok_or("repo root not found")?;
    let runtime_dir = root.join("desktop").join("runtime");

    let mut cmd = Command::new(&python);
    cmd.arg("-m").arg("moch_desktop").arg("--port").arg(port.to_string());
    cmd.current_dir(&runtime_dir);
    cmd.env("MOCH_DESKTOP_STATE_DIR", &dir);
    cmd.env("HERMES_PARENT_PID", std::process::id().to_string());
    cmd.env("MOCH_HERMES_SRC", root.join("app").join("hermes-src"));
    cmd.env("MOCH_PYTHON_RUNTIME", root.join("app").join("python-runtime"));
    cmd.env_remove("PYTHONPATH"); // the launcher builds its own
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| format!("spawn {} failed: {e}", python.display()))?;
    spawn_lines(&app, &mut child);
    *state().child.lock().unwrap() = Some(child);

    // Wait for the port (cold boot can take ~30s: skills seed + imports).
    let started = Instant::now();
    let deadline = Duration::from_secs(120);
    loop {
        std::thread::sleep(Duration::from_millis(300));
        {
            let mut guard = state().child.lock().unwrap();
            if let Some(child) = guard.as_mut() {
                if let Ok(None) = child.try_wait() {
                    // still running
                } else {
                    *guard = None;
                    let status = status_offline();
                    publish(&app, &status);
                    return Err("gateway process exited during boot (see logs)".into());
                }
            }
        }
        if let Some(v) = read_state_file(&dir) {
            let t = v.get("token").and_then(|t| t.as_str()).map(|s| s.to_string());
            if let Some(token) = t {
                if port_accepts(port) {
                    let info = GatewayInfo {
                        port,
                        token: token.clone(),
                        home: PathBuf::from(v.get("home").and_then(|h| h.as_str()).unwrap_or("")),
                        workspace: PathBuf::from(v.get("workspace").and_then(|h| h.as_str()).unwrap_or("")),
                    };
                    let status = GatewayStatus {
                        running: true,
                        port: Some(port),
                        token: Some(token),
                        home: Some(info.home.display().to_string()),
                        workspace: Some(info.workspace.display().to_string()),
                    };
                    *state().info.lock().unwrap() = Some(info);
                    publish(&app, &status);
                    let _ = started;
                    return Ok(status);
                }
            }
        }
        if started.elapsed() > deadline {
            let status = status_offline();
            publish(&app, &status);
            return Err("gateway did not become ready in 120s".into());
        }
    }
}

fn publish(app: &AppHandle, status: &GatewayStatus) {
    let _ = app.emit("gateway://status", status);
}

fn status_offline() -> GatewayStatus {
    GatewayStatus {
        running: false,
        port: None,
        token: None,
        home: None,
        workspace: None,
    }
}

fn port_accepts(port: u16) -> bool {
    std::net::TcpStream::connect_timeout(
        &std::net::SocketAddr::from(([127, 0, 0, 1], port)),
        Duration::from_millis(300),
    )
    .is_ok()
}

#[tauri::command]
pub fn gateway_status() -> GatewayStatus {
    let child_alive = {
        let mut guard = state().child.lock().unwrap();
        guard
            .as_mut()
            .map(|c| matches!(c.try_wait(), Ok(None)))
            .unwrap_or(false)
    };
    let info = state().info.lock().unwrap();
    match info.as_ref() {
        Some(i) if child_alive || port_accepts(i.port) => GatewayStatus {
            running: true,
            port: Some(i.port),
            token: Some(i.token.clone()),
            home: Some(i.home.display().to_string()),
            workspace: Some(i.workspace.display().to_string()),
        },
        _ => status_offline(),
    }
}

#[tauri::command]
pub fn gateway_restart(app: AppHandle) -> Result<GatewayStatus, String> {
    stop_gateway_everyway(&app);
    std::thread::sleep(Duration::from_millis(400));
    gateway_start_impl(app)
}

/// Kill our child OR an adopted gateway (named by the state file) so a
/// restart never adopts the very process it was asked to replace.
fn stop_gateway_everyway(app: &AppHandle) {
    {
        let mut guard = state().child.lock().unwrap();
        if let Some(mut child) = guard.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
    *state().info.lock().unwrap() = None;
    let dir = state_dir(app);
    if let Some(v) = read_state_file(&dir) {
        if let (Some(port), Some(pid)) = (
            v.get("port").and_then(|p| p.as_u64()).and_then(|p| u16::try_from(p).ok()),
            v.get("pid").and_then(|p| p.as_i64()),
        ) {
            if pid > 0 && port_accepts(port) {
                // SIGTERM the recorded python — it is the gateway we adopted
                // (or a corpse we should not re-adopt either way).
                let _ = std::process::Command::new("kill")
                    .arg("-TERM")
                    .arg(pid.to_string())
                    .status();
                for _ in 0..40 {
                    std::thread::sleep(Duration::from_millis(100));
                    if !port_accepts(port) {
                        break;
                    }
                }
            }
        }
    }
}

#[tauri::command]
pub fn gateway_stop(app: AppHandle) -> Result<bool, String> {
    let had_child = state().child.lock().unwrap().is_some();
    stop_gateway_everyway(&app);
    Ok(had_child)
}

#[tauri::command]
pub fn runtime_setup_hint() -> Option<String> {
    repo_root().map(|r| r.join("desktop").join("runtime").display().to_string())
}
