#!/usr/bin/env bash
# Monad installer
#
# Usage (production):
#   curl -fsSL https://raw.githubusercontent.com/monadix-labs/monad/main/scripts/install.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/monadix-labs/monad/main/scripts/install.sh | bash -s -- --channel beta
#
# Usage (local dev — fully self-contained inside dist/):
#   bun run build:release        # produces dist/monad-dev-darwin-arm64.tar.gz
#   bun run install:test         # installs into dist/test-install/, nothing else touched
#
# Flags (can also be set via environment variables):
#   --channel <channel>   — release channel: stable (default), beta, or nightly
#   --version <version>   — exact release tag to install (overrides channel latest)
#   --no-daemon           — skip auto-starting the daemon after install
#   --no-verify           — skip SHA256 checksum verification
#   --no-path-modify      — never touch shell config files
#
# Environment overrides:
#   MONAD_VERSION         — release tag to install (default: latest for the selected channel)
#   MONAD_INSTALL_DIR     — installation root       (default: ~/.monad)
#   MONAD_BIN_DIR         — where to place binaries (default: ~/.local/bin or /usr/local/bin)
#                           when set explicitly, PATH modification is skipped automatically
#   MONAD_NO_PATH_MODIFY  — set to 1 to never touch shell config files
#   MONAD_TARBALL         — path to a local tarball, skips download
#   MONAD_SKIP_VERIFY     — set to 1 to skip SHA256 verification
#   MONAD_NO_DAEMON       — set to 1 to skip auto-starting the daemon after install
#   MONAD_GITHUB_REPO     — GitHub owner/repo (default: OWNER/monad)

set -euo pipefail

# ── Constants ──────────────────────────────────────────────────────────────────

GITHUB_REPO="${MONAD_GITHUB_REPO:-monadix-labs/monad}"
INSTALL_DIR="${MONAD_INSTALL_DIR:-$HOME/.monad}"
CHANNEL="stable"
SKIP_VERIFY="${MONAD_SKIP_VERIFY:-0}"
NO_PATH_MODIFY="${MONAD_NO_PATH_MODIFY:-0}"
NO_DAEMON="${MONAD_NO_DAEMON:-0}"
# Track whether the caller explicitly chose a bin dir (suppress PATH changes)
_BIN_DIR_EXPLICIT="${MONAD_BIN_DIR:+1}"

# ── Colours (disabled when not a tty) ─────────────────────────────────────────

if [ -t 1 ]; then
  RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
  CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'
else
  RED=''; GREEN=''; YELLOW=''; CYAN=''; BOLD=''; RESET=''
fi

info()    { printf "${CYAN}[monad]${RESET} %s\n" "$*"; }
success() { printf "${GREEN}[monad]${RESET} %s\n" "$*"; }
warn()    { printf "${YELLOW}[monad]${RESET} %s\n" "$*" >&2; }
fatal()   { printf "${RED}[monad] error:${RESET} %s\n" "$*" >&2; exit 1; }

# ── OS + arch detection ────────────────────────────────────────────────────────

detect_platform() {
  local os arch

  case "$(uname -s)" in
    Darwin) os="darwin" ;;
    Linux)  os="linux"  ;;
    *)      fatal "Unsupported OS: $(uname -s). Only macOS and Linux are supported." ;;
  esac

  case "$(uname -m)" in
    x86_64|amd64) arch="x64"   ;;
    arm64|aarch64) arch="arm64" ;;
    *)             fatal "Unsupported architecture: $(uname -m)." ;;
  esac

  echo "${os}-${arch}"
}

# ── Downloader ────────────────────────────────────────────────────────────────

download() {
  local url="$1" dest="$2"
  if command -v curl &>/dev/null; then
    curl --proto '=https' --tlsv1.2 -fsSL --retry 3 --retry-delay 1 -o "$dest" "$url"
  elif command -v wget &>/dev/null; then
    wget -q --https-only -O "$dest" "$url"
  else
    fatal "Neither curl nor wget found. Please install one and re-run."
  fi
}

# ── SHA256 verification ───────────────────────────────────────────────────────

verify_sha256() {
  local file="$1" checksum_file="$2"
  local expected actual

  expected=$(awk '{print $1}' "$checksum_file")

  if command -v sha256sum &>/dev/null; then
    actual=$(sha256sum "$file" | awk '{print $1}')
  elif command -v shasum &>/dev/null; then
    actual=$(shasum -a 256 "$file" | awk '{print $1}')
  else
    warn "No sha256sum or shasum found — skipping checksum verification."
    return 0
  fi

  if [ "$actual" != "$expected" ]; then
    fatal "SHA256 mismatch for $file\n  expected: $expected\n  got:      $actual"
  fi
}

# ── PATH setup (production only) ──────────────────────────────────────────────

ensure_on_path() {
  local bin_dir="$1"

  # Skip when the caller opted out or chose an explicit bin dir
  if [ "$NO_PATH_MODIFY" = "1" ] || [ "${_BIN_DIR_EXPLICIT:-}" = "1" ]; then
    return 0
  fi

  # Already on PATH
  if echo ":$PATH:" | grep -q ":${bin_dir}:"; then
    return 0
  fi

  local export_line="export PATH=\"${bin_dir}:\$PATH\""
  local configs=()
  [ -f "$HOME/.bashrc" ]       && configs+=("$HOME/.bashrc")
  [ -f "$HOME/.bash_profile" ] && configs+=("$HOME/.bash_profile")
  [ -f "$HOME/.zshrc" ]        && configs+=("$HOME/.zshrc")
  [ -f "$HOME/.zprofile" ]     && configs+=("$HOME/.zprofile")

  if [ ${#configs[@]} -eq 0 ]; then
    warn "No shell config found. Add ${bin_dir} to your PATH manually."
    return 0
  fi

  for cfg in "${configs[@]}"; do
    if ! grep -qF "$bin_dir" "$cfg" 2>/dev/null; then
      printf '\n# Added by monad installer\n%s\n' "$export_line" >> "$cfg"
      info "  Added PATH entry to ${cfg}"
    fi
  done

  local fish_cfg="$HOME/.config/fish/config.fish"
  if [ -f "$fish_cfg" ] && ! grep -qF "$bin_dir" "$fish_cfg" 2>/dev/null; then
    printf '\n# Added by monad installer\nfish_add_path %s\n' "$bin_dir" >> "$fish_cfg"
    info "  Added PATH entry to ${fish_cfg}"
  fi
}

# ── Stop a running daemon before its binary is overwritten ──────────────────────

# Uses the currently-installed binary (pre-overwrite) to stop the daemon, then waits for the
# process to actually exit so the freshly installed one starts against a released lock + port.
# Best-effort and a no-op on a clean machine (no binary / no daemon).
stop_existing_daemon() {
  local home="$1" bin_dir="$2"
  local monad_bin="${bin_dir}/monad"
  [ -x "$monad_bin" ] || return 0

  local pid="" pidfile="${home}/runtime/monad.pid"
  [ -f "$pidfile" ] && pid=$(tr -dc '0-9' <"$pidfile" 2>/dev/null)

  info "Stopping running monad…"
  MONAD_HOME="$home" "$monad_bin" stop >/dev/null 2>&1 || true

  [ -n "$pid" ] || return 0
  local i=0
  while [ $i -lt 10 ]; do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 1
    i=$((i + 1))
  done
  warn "Running daemon (pid ${pid}) did not exit; continuing anyway."
}

# ── Main ───────────────────────────────────────────────────────────────────────

main() {
  # ── 0. Parse CLI flags ────────────────────────────────────────────────────────
  while [ $# -gt 0 ]; do
    case "$1" in
      --channel)
        [ -n "${2:-}" ] || fatal "--channel requires an argument (stable|beta|nightly)"
        CHANNEL="$2"; shift 2 ;;
      --version)
        [ -n "${2:-}" ] || fatal "--version requires an argument"
        MONAD_VERSION="$2"; shift 2 ;;
      --no-daemon)
        NO_DAEMON=1; shift ;;
      --no-verify)
        SKIP_VERIFY=1; shift ;;
      --no-path-modify)
        NO_PATH_MODIFY=1; shift ;;
      --*)
        fatal "Unknown flag: $1 (see script header for supported flags)" ;;
      *)
        fatal "Unexpected argument: $1" ;;
    esac
  done

  case "$CHANNEL" in
    stable|beta|nightly) ;;
    *) fatal "Unknown channel '${CHANNEL}'. Use: stable, beta, or nightly" ;;
  esac

  # ── 1. Determine install type ─────────────────────────────────────────────────

  local bin_dir_probe="${MONAD_BIN_DIR:-}"
  if [ -z "$bin_dir_probe" ]; then
    if [ "$(id -u)" -eq 0 ]; then
      bin_dir_probe="/usr/local/bin"
    else
      bin_dir_probe="$HOME/.local/bin"
    fi
  fi
  local existing_version=""
  if [ -x "${bin_dir_probe}/monad" ]; then
    existing_version=$("${bin_dir_probe}/monad" --version 2>/dev/null | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9][^ ]*' || echo "")
  fi

  # ── 2. Determine source tarball ──────────────────────────────────────────────

  local tarball platform artifact_name
  # Global var so the EXIT trap can reach it after main() returns
  _MONAD_TMP=$(mktemp -d)
  trap 'rm -rf "${_MONAD_TMP:-}"' EXIT

  if [ -n "${MONAD_TARBALL:-}" ]; then
    tarball="$MONAD_TARBALL"
    info "Using local tarball: $tarball"
  else
    platform=$(detect_platform)
    local version="${MONAD_VERSION:-}"

    if [ -z "$version" ]; then
      info "Fetching latest ${CHANNEL} release version…"
      version=$(download_latest_version)
    fi

    # Log install type now that we know the target version
    if [ -n "$existing_version" ]; then
      if [ "$existing_version" = "$version" ]; then
        info "Reinstalling monad ${version} (${CHANNEL} channel)…"
      else
        info "Upgrading monad ${existing_version} → ${version} (${CHANNEL} channel)…"
      fi
    else
      info "Installing monad ${version} (${CHANNEL} channel)…"
    fi

    artifact_name="monad-${version}-${platform}"
    local release_url="https://github.com/${GITHUB_REPO}/releases/download/${version}/${artifact_name}.tar.gz"
    local checksum_url="${release_url}.sha256"

    info "Downloading ${artifact_name}…"
    tarball="${_MONAD_TMP}/${artifact_name}.tar.gz"
    download "$release_url" "$tarball"

    if [ "$SKIP_VERIFY" != "1" ]; then
      local checksum_file="${tarball}.sha256"
      download "$checksum_url" "$checksum_file"
      info "Verifying checksum…"
      verify_sha256 "$tarball" "$checksum_file"
      success "Checksum verified"
    fi
  fi

  # ── 4. Resolve install locations ─────────────────────────────────────────────

  local bin_dir="${bin_dir_probe}"
  mkdir -p "$bin_dir"

  # Resolve the data home — honour explicit MONAD_HOME (e.g. install-test.sh sets MONAD_BIN_DIR)
  # but never inherit a dev value injected by direnv.
  local init_home
  if [ "${_BIN_DIR_EXPLICIT:-}" = "1" ] && [ -n "${MONAD_HOME:-}" ]; then
    init_home="$MONAD_HOME"
  else
    init_home="$HOME/.monad"
  fi

  # ── 5. Stop any running daemon (before we overwrite its binary) ───────────────

  # The upgrade order is stop → overwrite → start: stop with the currently-installed binary so the
  # singleton lock + port are released, then extract the new one over it, then start fresh.
  stop_existing_daemon "$init_home" "$bin_dir"

  # ── 6. Extract ───────────────────────────────────────────────────────────────

  info "Extracting to ${INSTALL_DIR}…"
  mkdir -p "$INSTALL_DIR"
  tar -xzf "$tarball" -C "$INSTALL_DIR" --strip-components=1
  # macOS: remove quarantine attribute so Gatekeeper doesn't silently block execution
  if [ "$(uname -s)" = "Darwin" ]; then
    xattr -dr com.apple.quarantine "$INSTALL_DIR" 2>/dev/null || true
  fi
  success "Extracted"

  # ── 7. Place binaries ─────────────────────────────────────────────────────────

  for binary in "$INSTALL_DIR"/bin/*; do
    local name
    name=$(basename "$binary")
    ln -sf "$binary" "${bin_dir}/${name}"
    info "  ${name} → ${bin_dir}/${name}"
  done

  # ── 8. PATH (production only — skipped when bin dir is explicit or opted out) ──

  ensure_on_path "$bin_dir"

  # ── 9. Start — hand off to monad ──────────────────────────────────────────────

  if [ "${NO_DAEMON}" != "1" ]; then
    # Bare `monad` (→ `monad up`) seeds the home on boot, relays the ready banner, and opens the
    # browser for setup. The old daemon was already stopped above, so this starts cleanly. Keeping
    # start/browser in monad means a hand-run `monad` behaves identically to install. Logs land in
    # ${init_home}/logs/daemon.log.
    printf "\n"
    if ! MONAD_HOME="$init_home" "${bin_dir}/monad"; then
      warn "Daemon did not start cleanly — check ${init_home}/logs/daemon.log"
    fi
    if ! echo ":$PATH:" | grep -q ":${bin_dir}:"; then
      warn "Add ${bin_dir} to your PATH to use monad from any directory."
    fi
  else
    # No daemon: nothing will boot it, so seed the home explicitly — config.json + templates must
    # exist for offline inspection (and the install smoke test asserts on them).
    local init_log="${_MONAD_TMP}/init.log"
    if MONAD_HOME="$init_home" "${bin_dir}/monad" init --non-interactive >"$init_log" 2>&1; then
      success "Monad home initialised"
    else
      warn "Could not initialise monad home"
      [ -s "$init_log" ] && warn "$(cat "$init_log")"
    fi
    success "monad installed successfully!"
    printf "\n"
    printf "  ${BOLD}Start:${RESET}                monad\n"
    printf "  ${BOLD}CLI:${RESET}                  monad --help\n"
    printf "\n"
    if ! echo ":$PATH:" | grep -q ":${bin_dir}:"; then
      warn "Add ${bin_dir} to your PATH to use monad from any directory."
    fi
  fi
}

# ── Fetch latest GitHub release tag ───────────────────────────────────────────

download_latest_version() {
  local response

  # stable → /releases/latest (pre-releases excluded by GitHub).
  # beta/nightly → /releases list, filter by tag pattern, take the first hit.
  if [ "$CHANNEL" = "stable" ]; then
    local api_url="https://api.github.com/repos/${GITHUB_REPO}/releases/latest"
    if command -v curl &>/dev/null; then
      response=$(curl --proto '=https' --tlsv1.2 -fsSL "$api_url")
    else
      response=$(wget -q --https-only -O - "$api_url")
    fi
    echo "$response" | grep '"tag_name"' | sed -E 's/.*"tag_name": *"([^"]+)".*/\1/'
  else
    local api_url="https://api.github.com/repos/${GITHUB_REPO}/releases?per_page=50"
    if command -v curl &>/dev/null; then
      response=$(curl --proto '=https' --tlsv1.2 -fsSL "$api_url")
    else
      response=$(wget -q --https-only -O - "$api_url")
    fi
    local tag
    tag=$(echo "$response" | grep '"tag_name"' | grep -- "-${CHANNEL}\." | head -1 \
          | sed -E 's/.*"tag_name": *"([^"]+)".*/\1/')
    if [ -z "$tag" ]; then
      fatal "No ${CHANNEL} release found. Check https://github.com/${GITHUB_REPO}/releases or use MONAD_VERSION."
    fi
    echo "$tag"
  fi
}

main "$@"
