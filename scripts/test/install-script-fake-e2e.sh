#!/usr/bin/env bash
# Fake-package e2e coverage for scripts/install.sh.
# Exercises installer flags and upgrade behavior without requiring a release build.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
INSTALLER="${ROOT}/scripts/install.sh"
TEST_DIR="${ROOT}/dist/test-install-fake"
PKG_DIR="${TEST_DIR}/packages"

ok() { echo "  ✓ $*"; }
fail() { echo "  ✗ $*" >&2; exit 1; }
step() { echo ""; echo "[install-fake-e2e] $*"; }

make_package() {
  local version="$1"
  local pkg="${PKG_DIR}/monad-${version}"
  rm -rf "$pkg"
  mkdir -p "${pkg}/bin" "${pkg}/assets"
  printf '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"></svg>\n' >"${pkg}/assets/monad-icon-vector-solid.svg"
  printf 'fake ico\n' >"${pkg}/assets/favicon.ico"
  cat >"${pkg}/bin/monad" <<EOF
#!/usr/bin/env bash
set -euo pipefail
case "\${1:-}" in
  --version)
    echo "monad ${version}"
    ;;
  --help|-h)
    echo "monad ${version}"
    echo "Usage: monad [command]"
    ;;
  init)
    mkdir -p "\${MONAD_HOME:-$HOME/.monad}"
    if [ ! -f "\${MONAD_HOME:-$HOME/.monad}/config.json" ]; then
      printf '{"model":{"providers":[{"id":"sample-openai-compatible"}]}}\n' >"\${MONAD_HOME:-$HOME/.monad}/config.json"
    fi
    ;;
  stop)
    exit 0
    ;;
  *)
    echo "monad fake ${version}"
    ;;
esac
EOF
  chmod +x "${pkg}/bin/monad"
  tar -czf "${PKG_DIR}/monad-${version}.tar.gz" -C "$pkg" .
}

run_installer() {
  local tarball="$1"
  MONAD_TARBALL="$tarball" \
  MONAD_SKIP_VERIFY=1 \
  MONAD_INSTALL_DIR="${TEST_DIR}/install" \
  MONAD_BIN_DIR="${TEST_DIR}/bin" \
  MONAD_HOME="${TEST_DIR}/home" \
  MONAD_NO_PATH_MODIFY=1 \
  MONAD_NO_DAEMON=1 \
  HOME="${TEST_DIR}/fake-home" \
  bash "$INSTALLER" --no-daemon --no-verify --no-path-modify
}

assert_launcher() {
  case "$(uname -s)" in
    Darwin)
      local app="${TEST_DIR}/fake-home/Applications/Monad.app"
      [ -x "${app}/Contents/MacOS/monad" ] || fail "macOS app launcher was not created"
      grep -q "${TEST_DIR}/bin/monad" "${app}/Contents/MacOS/monad" \
        || fail "macOS app launcher does not target installed monad"
      grep -q "Monad" "${app}/Contents/Info.plist" \
        || fail "macOS app launcher Info.plist missing"
      grep -q "CFBundleIconFile" "${app}/Contents/Info.plist" \
        || fail "macOS app launcher icon plist key missing"
      [ -f "${app}/Contents/Resources/MonadIcon.icns" ] || [ -f "${app}/Contents/Resources/MonadIcon.svg" ] \
        || fail "macOS app launcher icon resource was not created"
      ;;
    Linux)
      local menu="${TEST_DIR}/fake-home/.local/share/applications/monad.desktop"
      local desktop="${TEST_DIR}/fake-home/Desktop/Monad.desktop"
      [ -f "$menu" ] || fail "Linux application-menu launcher was not created"
      [ -f "$desktop" ] || fail "Linux desktop launcher was not created"
      grep -q "Exec=${TEST_DIR}/bin/monad up" "$menu" \
        || fail "Linux menu launcher does not target installed monad"
      grep -q "Exec=${TEST_DIR}/bin/monad up" "$desktop" \
        || fail "Linux desktop launcher does not target installed monad"
      grep -q "Icon=${TEST_DIR}/install/assets/monad-icon-vector-solid.svg" "$menu" \
        || fail "Linux menu launcher does not use Monad icon"
      grep -q "Icon=${TEST_DIR}/install/assets/monad-icon-vector-solid.svg" "$desktop" \
        || fail "Linux desktop launcher does not use Monad icon"
      ;;
  esac
}

assert_version() {
  local expected="$1"
  local actual
  actual="$("${TEST_DIR}/bin/monad" --version)"
  [ "$actual" = "monad ${expected}" ] || fail "expected monad ${expected}, got ${actual}"
}

rm -rf "$TEST_DIR"
mkdir -p "$PKG_DIR" "${TEST_DIR}/fake-home"
make_package "1.0.0"
make_package "1.1.0"

step "Flow 1: local fake tarball fresh install with explicit dirs and no daemon"
run_installer "${PKG_DIR}/monad-1.0.0.tar.gz"
[ -L "${TEST_DIR}/bin/monad" ] || fail "monad link was not created in explicit bin dir"
assert_version "1.0.0"
[ -f "${TEST_DIR}/home/config.json" ] || fail "monad init did not seed explicit MONAD_HOME"
assert_launcher
ok "fresh install seeded explicit home and linked fake binary"

step "Flow 2: upgrade replaces the linked binary and preserves home data"
printf '\n{"_test":"sentinel"}\n' >>"${TEST_DIR}/home/config.json"
run_installer "${PKG_DIR}/monad-1.1.0.tar.gz"
assert_version "1.1.0"
assert_launcher
grep -q '"_test":"sentinel"' "${TEST_DIR}/home/config.json" \
  && ok "home data preserved across upgrade" \
  || fail "home data was wiped during upgrade"

step "Flow 3: PATH modification is skipped for explicit bin dir / no-path"
for cfg in "${TEST_DIR}/fake-home/.bashrc" "${TEST_DIR}/fake-home/.zshrc" "${TEST_DIR}/fake-home/.config/fish/config.fish"; do
  [ ! -e "$cfg" ] || ! grep -q "${TEST_DIR}/bin" "$cfg" || fail "installer modified PATH config ${cfg}"
done
ok "shell PATH files were not modified"

step "Flow 4: invalid arguments fail before install"
if bash "$INSTALLER" --channel canary >/tmp/monad-install-invalid-channel.log 2>&1; then
  fail "invalid channel unexpectedly succeeded"
fi
grep -q "Unknown channel 'canary'" /tmp/monad-install-invalid-channel.log \
  && ok "invalid channel rejected" \
  || fail "invalid channel error message missing"

if bash "$INSTALLER" --version >/tmp/monad-install-missing-version.log 2>&1; then
  fail "missing --version argument unexpectedly succeeded"
fi
grep -q -- "--version requires an argument" /tmp/monad-install-missing-version.log \
  && ok "missing --version argument rejected" \
  || fail "missing --version error message missing"

echo ""
echo "[install-fake-e2e] Fake install.sh e2e passed."
