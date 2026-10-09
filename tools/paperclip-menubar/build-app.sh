#!/usr/bin/env bash
# Builds "Paperclip Menu Bar.app" from this crate.
#
#   tools/paperclip-menubar/build-app.sh [output-dir]
#
# The app is written to output-dir (default: tools/paperclip-menubar/dist). It
# records this checkout as its PaperclipSource, so it can be moved anywhere,
# for example ~/Applications, and still find the launcher scripts.
set -euo pipefail

CRATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "$CRATE_DIR/../.." && pwd -P)"
OUT_DIR="${1:-$CRATE_DIR/dist}"
APP="$OUT_DIR/Paperclip Menu Bar.app"

[ "$(uname -s)" = Darwin ] || { echo "The menu-bar helper is macOS only." >&2; exit 1; }
command -v cargo >/dev/null || { echo "Install Rust with rustup (https://rustup.rs) first." >&2; exit 1; }

cargo build --release --manifest-path "$CRATE_DIR/Cargo.toml"

xml_escape() {
  local s="$1"
  s="${s//&/&amp;}"; s="${s//</&lt;}"; s="${s//>/&gt;}"
  printf '%s' "$s"
}
VERSION="$(sed -n 's/^version = "\(.*\)"/\1/p' "$CRATE_DIR/Cargo.toml" | head -1)"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
cp "$CRATE_DIR/target/release/paperclip-menubar" "$APP/Contents/MacOS/paperclip-menubar"
cat > "$APP/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Paperclip Menu Bar</string>
  <key>CFBundleDisplayName</key><string>Paperclip Menu Bar</string>
  <key>CFBundleIdentifier</key><string>dev.barrycarrjr.paperclip.menubar</string>
  <key>CFBundleExecutable</key><string>paperclip-menubar</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
  <key>PaperclipSource</key><string>$(xml_escape "$REPO_ROOT")</string>
</dict>
</plist>
EOF
# Ad-hoc signature: required to run on Apple silicon, and gives notifications
# a stable app identity.
codesign --force --sign - "$APP" >/dev/null
echo "Built $APP"
