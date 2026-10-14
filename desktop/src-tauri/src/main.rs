// Prevents an additional console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // WebKitGTK on fractional-scale Wayland compositors (Hyprland 1.25 etc.)
    // renders at the wrong device scale (top-left quarter crop). The X11/
    // XWayland backend sidesteps it. Override with GDK_BACKEND=wayland if
    // you prefer to test Wayland.
    #[cfg(target_os = "linux")]
    if std::env::var_os("GDK_BACKEND").is_none() {
        std::env::set_var("GDK_BACKEND", "x11");
    }
    moch_desktop_lib::run()
}
