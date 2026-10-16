//! Moch Desktop — Tauri shell.

mod browser;
mod fs;
mod gateway;
mod pty;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            use tauri::Manager;
            // Focus the existing window on a second launch.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
                let _ = window.unminimize();
            }
        }))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            gateway::gateway_start,
            gateway::gateway_status,
            gateway::gateway_restart,
            gateway::gateway_stop,
            gateway::runtime_setup_hint,
            gateway::gw_fetch,
            gateway::read_media_file,
            fs::fs_list,
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            browser::browser_launch,
            browser::browser_status,
            browser::browser_stop,
            browser::cdp_fetch,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
