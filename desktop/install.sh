#!/usr/bin/env bash
# Install Moch Desktop for the current user: launcher entry + binary on PATH.
# The AppImage stays where it is; the .desktop points at it.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APPIMAGE="$HERE/src-tauri/target/release/bundle/appimage/Moch_0.1.0_amd64.AppImage"

if [ ! -f "$APPIMAGE" ]; then
  echo "error: AppImage not built yet — run the build first:" >&2
  echo "  cd $HERE/src-tauri && npx tauri build" >&2
  exit 1
fi

mkdir -p ~/.local/bin ~/.local/share/applications
install -m 755 "$APPIMAGE" ~/.local/bin/moch-desktop

cat > ~/.local/share/applications/moch-desktop.desktop <<EOF
[Desktop Entry]
Type=Application
Name=Moch
Comment=Your own hermes agents, on your desktop — fully local
Exec=$HOME/.local/bin/moch-desktop
Icon=moch
Terminal=false
Categories=Network;InstantMessaging;Development;
StartupWMClass=moch-desktop
EOF

# Icon from the repo's assets (any PNG the launcher can scale)
if [ -f "$HERE/../app/assets/icon.png" ]; then
  mkdir -p ~/.local/share/icons/hicolor/512x512/apps
  cp "$HERE/../app/assets/icon.png" ~/.local/share/icons/hicolor/512x512/apps/moch.png
fi

update-desktop-database ~/.local/share/applications 2>/dev/null || true
echo "installed: moch-desktop on PATH + launcher entry 'Moch'"
