//! PTY host: real terminal sessions (xterm.js in the webview, portable-pty here).
//!
//! Sessions are keyed by uuid; output is base64-chunked onto `pty://output`
//! events (session id + b64 data) so binary-safe round-tripping works from JS;
//! input/resize arrive as commands. The shell defaults to $SHELL, cwd to the
//! workspace.

use base64::Engine;
use portable_pty::{ChildKiller, CommandBuilder, MasterPty, NativePtySystem, PtySize, PtySystem};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Mutex, OnceLock};

use tauri::Emitter;

struct PtySession {
    master: Box<dyn MasterPty + Send>,
    killer: Box<dyn ChildKiller + Send>,
}

pub struct PtyState {
    sessions: Mutex<HashMap<String, PtySession>>,
}

impl PtyState {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
        }
    }
}

pub fn state() -> &'static PtyState {
    static STATE: OnceLock<PtyState> = OnceLock::new();
    STATE.get_or_init(PtyState::new)
}

fn b64(data: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(data)
}

#[tauri::command]
pub fn pty_spawn(
    app: tauri::AppHandle,
    cwd: Option<String>,
    shell: Option<String>,
    cols: u16,
    rows: u16,
    env: Option<HashMap<String, String>>,
) -> Result<String, String> {
    let pty_system = NativePtySystem::default();
    let shell_path = shell
        .clone()
        .or_else(|| std::env::var("SHELL").ok())
        .unwrap_or_else(|| "/bin/bash".into());
    let cwd_path = cwd
        .map(std::path::PathBuf::from)
        .or_else(|| dirs::home_dir())
        .unwrap_or_else(|| std::path::PathBuf::from("/"));

    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let mut cmd = CommandBuilder::new(&shell_path);
    cmd.cwd(&cwd_path);
    if let Some(env) = env {
        for (k, v) in env {
            cmd.env(k, v);
        }
    }

    let mut child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);

    let mut master = pair.master;
    let mut reader = master.try_clone_reader().map_err(|e| e.to_string())?;
    let mut writer = master.take_writer().map_err(|e| e.to_string())?;
    let id = uuid::Uuid::new_v4().to_string();
    let app2 = app.clone();
    let id2 = id.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let payload = serde_json::json!({
                        "id": &id2,
                        "data": b64(&buf[..n]),
                    });
                    let _ = app2.emit("pty://output", payload);
                }
                Err(_) => break,
            }
        }
        let _ = app2.emit("pty://exit", &id2);
        state().sessions.lock().unwrap().remove(&id2);
    });

    let killer = child.clone_killer();
    std::thread::spawn(move || {
        let _ = child.wait();
    });

    state().sessions.lock().unwrap().insert(
        id.clone(),
        PtySession { master, killer },
    );
    writers().lock().unwrap().insert(id.clone(), writer);
    Ok(id)
}

static WRITERS: OnceLock<Mutex<HashMap<String, Box<dyn Write + Send>>>> = OnceLock::new();
fn writers() -> &'static Mutex<HashMap<String, Box<dyn Write + Send>>> {
    WRITERS.get_or_init(|| Mutex::new(HashMap::new()))
}

#[tauri::command]
pub fn pty_write(id: String, data_b64: String) -> Result<bool, String> {
    let mut guard = writers().lock().unwrap();
    let writer = guard.get_mut(&id).ok_or("no such pty session")?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&data_b64)
        .map_err(|e| e.to_string())?;
    writer
        .write_all(&bytes)
        .and_then(|_| writer.flush())
        .map_err(|e| e.to_string())?;
    Ok(true)
}

#[tauri::command]
pub fn pty_resize(id: String, cols: u16, rows: u16) -> Result<bool, String> {
    let guard = state().sessions.lock().unwrap();
    let session = guard.get(&id).ok_or("no such pty session")?;
    session
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;
    Ok(true)
}

#[tauri::command]
pub fn pty_kill(id: String) -> Result<bool, String> {
    let mut guard = state().sessions.lock().unwrap();
    if let Some(mut session) = guard.remove(&id) {
        let _ = session.killer.kill();
        writers().lock().unwrap().remove(&id);
        Ok(true)
    } else {
        writers().lock().unwrap().remove(&id);
        Ok(false)
    }
}
