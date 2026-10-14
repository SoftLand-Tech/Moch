// Prevents an additional console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // WebKitGTK's DMA-BUF renderer breaks webview resize tracking on
    // Wayland compositors (content stays at the launch size when the
    // window is tiled/maximized). Must be set before the webview is
    // created. See FEATURE-DESKTOP-TAURI.md, "Known gaps".
    std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    moch_desktop_lib::run()
}
