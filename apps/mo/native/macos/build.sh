#!/usr/bin/env bash
# Build the macOS Mo sprite into Mo.app. Requires the Xcode command line tools (clang +
# the macOS SDK, which ships Cocoa and libcurl). Run on macOS.
set -euo pipefail
cd "$(dirname "$0")"
bash ../common/ensure-atlas.sh

if [[ "$(uname)" != "Darwin" ]]; then
  echo "mo: the macOS shell builds on macOS only (got $(uname))" >&2
  exit 1
fi
if ! command -v clang >/dev/null; then
  echo "mo: clang not found — install the Xcode command line tools (xcode-select --install)" >&2
  exit 1
fi

app="${1:-Mo.app}"
macos="$app/Contents/MacOS"
rm -rf "$app"
mkdir -p "$macos" "$app/Contents/Resources"

# MO_UNIVERSAL=1 builds a fat arm64+x86_64 binary (release: one Mo.app serves both darwin arches).
# Use a string rather than array: bash 3.2 (macOS default) treats empty array[@] as unbound under set -u.
archflags=""
if [[ -n "${MO_UNIVERSAL:-}" ]]; then archflags="-arch arm64 -arch x86_64"; fi

# shellcheck disable=SC2086
clang -fobjc-arc -O2 -Wall -Wextra -I../common $archflags \
  mo.m input_panel.m ../common/daemon.c ../common/behavior.c \
  -framework Cocoa -lcurl \
  -o "$macos/mo"

cp ../../assets/mochi.png "$app/Contents/Resources/" 2>/dev/null || true
cp ../../assets/atlas.json "$app/Contents/Resources/" 2>/dev/null || true

cat > "$app/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Mo</string>
  <key>CFBundleDisplayName</key><string>Mo</string>
  <key>CFBundleIdentifier</key><string>ai.monad.mo</string>
  <key>CFBundleVersion</key><string>0.0.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>mo</string>
  <!-- Agent app: no Dock icon, no menu bar. -->
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST

echo "mo: built ./$app"
echo "mo: to autostart at login, add $app in System Settings → General → Login Items"
