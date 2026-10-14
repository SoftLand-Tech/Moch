//! Moch desktop shell — step 1 (proof): a plain Tauri window that loads the
//! Expo web export of the Moch app and lets it do what it already knows how
//! to do on the web: linked mode over wss to the Moch relay.
//!
//! Later steps add: supervised local `hermes serve` (localhost transport +
//! OS keyring for the session token), tray/global hotkey, desktop
//! notifications for knocks.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
