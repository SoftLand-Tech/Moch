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
    // WebKitGTK's accelerated compositor leaves STALE FRAMES behind on some
    // X11/Wayland setups — semi-transparent ghost copies of scrolled content
    // (mascot faces tiled down the chat screen, 2026-10-15 report). Forcing
    // software compositing is the standard webkit2gtk workaround; the UI is
    // text-first, so the perf cost is negligible. Override by setting the
    // variable to 0 yourself.
    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_DISABLE_COMPOSITING_MODE").is_none() {
        std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
    }
    moch_desktop_lib::run()
}
