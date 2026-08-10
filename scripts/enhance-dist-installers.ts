#!/usr/bin/env bun

import { copyFile, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: { dir: { type: 'string' } },
  strict: true
});
const root = resolve(import.meta.dir, '..');
const artifactsDir = resolve(values.dir ?? join(root, 'target', 'distrib'));

const artifactSizes = await collectArtifactSizes(artifactsDir);
const generatedShell = join(artifactsDir, 'monad-installer.sh');
const generatedPowerShell = join(artifactsDir, 'monad-installer.ps1');
const shellInstaller = join(artifactsDir, 'install.sh');
const powerShellInstaller = join(artifactsDir, 'install.ps1');
await enhanceShell(generatedShell, artifactSizes);
await enhancePowerShell(generatedPowerShell, artifactSizes);
await Promise.all([rm(shellInstaller, { force: true }), rm(powerShellInstaller, { force: true })]);
await Promise.all([copyFile(generatedShell, shellInstaller), copyFile(generatedPowerShell, powerShellInstaller)]);
process.stdout.write(
  `[enhance-dist-installers] wrote install.sh/install.ps1 and axoupdater protocol installers in ${artifactsDir}\n`
);

async function collectArtifactSizes(dir: string): Promise<Map<string, number>> {
  const sizes = new Map<string, number>();
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (
      !entry.isFile() ||
      entry.name.endsWith('-installer.sh') ||
      entry.name.endsWith('-installer.ps1') ||
      entry.name === 'install.sh' ||
      entry.name === 'install.ps1'
    ) {
      continue;
    }
    sizes.set(entry.name, (await stat(join(dir, entry.name))).size);
  }
  return sizes;
}

async function enhanceShell(path: string, artifactSizes: Map<string, number>): Promise<void> {
  let source = await readFile(path, 'utf8');
  if (source.includes('# MONAD_INSTALLER_UI')) return;

  const shellArtifactSizes = [...artifactSizes]
    .map(([name, size]) => `        '${name.replaceAll("'", "'\\''")}') printf '${size}' ;;`)
    .join('\n');

  source = replaceOnce(
    source,
    'AUTH_TOKEN="$'.concat('{MONAD_GITHUB_TOKEN:-}"\n'),
    `AUTH_TOKEN="\${MONAD_GITHUB_TOKEN:-}"

# MONAD_INSTALLER_UI
MONAD_DOWNLOAD_PID=''

monad_is_json() {
    [ "\${MONAD_OUTPUT:-}" = "json" ]
}

monad_event() {
    monad_is_json || return 0
    _monad_event_type="$1"
    _monad_event_message=$(printf '%s' "$2" | sed 's/[\\\\"]/\\\\&/g')
    printf '{"type":"%s","message":"%s","version":"%s"}\\n' \
        "$_monad_event_type" "$_monad_event_message" "$APP_VERSION"
}

monad_is_interactive() {
    ! monad_is_json && [ "$PRINT_QUIET" = "0" ] && { [ "\${MONAD_FORCE_INTERACTIVE:-}" = "1" ] || { [ -t 2 ] && [ "\${TERM:-}" != "dumb" ]; }; }
}

monad_banner() {
    if monad_is_json; then monad_event started "Installing Monad"; return 0; fi
    [ "$PRINT_QUIET" = "0" ] || return 0
    if monad_is_interactive && [ -z "\${NO_COLOR:-}" ]; then
        printf '\\n\\033[1;36m  ◆ MONAD\\033[0m  \\033[1m%s\\033[0m\\n' "$APP_VERSION" >&2
        printf '\\033[2m    Daemon-first agent team runtime with headless architecture.\\033[0m\\n\\n' >&2
    else
        printf '\\n  MONAD  %s\\n    Daemon-first agent team runtime with headless architecture.\\n\\n' "$APP_VERSION" >&2
    fi
}

monad_step() {
    if monad_is_json; then monad_event stage "$1"; return 0; fi
    [ "$PRINT_QUIET" = "0" ] || return 0
    if monad_is_interactive && [ -z "\${NO_COLOR:-}" ]; then
        printf '\\033[1;36m  ◇\\033[0m \\033[1m%s\\033[0m\\n' "$1" >&2
    else
        printf '  - %s\\n' "$1" >&2
    fi
}

monad_done() {
    if monad_is_json; then monad_event completed "$1"; return 0; fi
    [ "$PRINT_QUIET" = "0" ] || return 0
    if monad_is_interactive && [ -z "\${NO_COLOR:-}" ]; then
        printf '\\033[1;32m  ✓\\033[0m \\033[2m%s\\033[0m\\n' "$1" >&2
    else
        printf '  + %s\\n' "$1" >&2
    fi
}

monad_error() {
    monad_activity_stop
    if monad_is_json; then monad_event error "$1"; return 0; fi
    [ "$PRINT_QUIET" = "0" ] || return 0
    if monad_is_interactive && [ -z "\${NO_COLOR:-}" ]; then
        printf '\\n\\033[1;31m  ✖ Installation failed\\033[0m\\n\\033[2m    %s\\033[0m\\n\\n' "$1" >&2
    else
        printf '\\n  ! Installation failed\\n    %s\\n\\n' "$1" >&2
    fi
}

MONAD_ACTIVITY_PID=''

monad_activity_start() {
    _monad_activity_label="$1"
    if ! monad_is_interactive; then
        monad_step "$_monad_activity_label"
        return 0
    fi
    monad_activity_stop
    (
        set -- '◐' '◓' '◑' '◒'
        while :; do
            for _monad_activity_frame in "$@"; do
                printf '\\r\\033[1;36m  %s\\033[0m \\033[1m%s\\033[0m' \
                    "$_monad_activity_frame" "$_monad_activity_label" >&2
                sleep 0.12
            done
        done
    ) &
    MONAD_ACTIVITY_PID=$!
}

monad_activity_stop() {
    [ -n "\${MONAD_ACTIVITY_PID:-}" ] || return 0
    kill "$MONAD_ACTIVITY_PID" 2>/dev/null || true
    wait "$MONAD_ACTIVITY_PID" 2>/dev/null || true
    MONAD_ACTIVITY_PID=''
    printf '\\r\\033[K' >&2
}

monad_cleanup() {
    monad_activity_stop
    if [ -n "\${MONAD_DOWNLOAD_PID:-}" ]; then
        kill "$MONAD_DOWNLOAD_PID" 2>/dev/null || true
        wait "$MONAD_DOWNLOAD_PID" 2>/dev/null || true
        MONAD_DOWNLOAD_PID=''
    fi
}

trap 'monad_cleanup' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

MONAD_BAR_WIDTH=20

monad_format_bytes() {
    _monad_bytes="$1"
    if [ "$_monad_bytes" -ge 1073741824 ]; then
        printf '%d.%d GiB' $(( _monad_bytes / 1073741824 )) $(( (_monad_bytes % 1073741824) * 10 / 1073741824 ))
    elif [ "$_monad_bytes" -ge 1048576 ]; then
        printf '%d.%d MiB' $(( _monad_bytes / 1048576 )) $(( (_monad_bytes % 1048576) * 10 / 1048576 ))
    elif [ "$_monad_bytes" -ge 1024 ]; then
        printf '%d.%d KiB' $(( _monad_bytes / 1024 )) $(( (_monad_bytes % 1024) * 10 / 1024 ))
    else
        printf '%d B' "$_monad_bytes"
    fi
}

monad_draw_bar() {
    _monad_pct="$1"
    _monad_pulse="$2"
    _monad_current="$3"
    _monad_total="$4"
    _monad_rate="$5"
    _monad_eta="$6"
    [ "$_monad_pct" -gt 100 ] && _monad_pct=100
    [ "$_monad_pct" -lt 0 ] && _monad_pct=0
    _monad_columns=$(tput cols 2>/dev/null || printf '80')
    case "$_monad_columns" in *[!0-9]*|'') _monad_columns=80 ;; esac
    if [ "$_monad_columns" -lt 72 ]; then MONAD_BAR_WIDTH=10; else MONAD_BAR_WIDTH=20; fi
    _monad_filled=$(( _monad_pct * MONAD_BAR_WIDTH / 100 ))
    _monad_i=0

    if [ "$_monad_columns" -lt 72 ]; then
        printf ' ] %3d%%' "$_monad_pct" >&2
    elif [ -z "\${NO_COLOR:-}" ]; then
        printf '\\r\\033[2m    [\\033[0m ' >&2
    else
        printf '\\r    [ ' >&2
    fi
    while [ "$_monad_i" -lt "$MONAD_BAR_WIDTH" ]; do
        if [ "$_monad_i" -lt "$_monad_filled" ]; then
            if [ "$_monad_i" -eq $(( _monad_filled - 1 )) ] && [ "$_monad_pct" -lt 100 ] && [ "$_monad_pulse" = "0" ]; then
                printf '\\033[2m▯\\033[0m' >&2
            elif [ -z "\${NO_COLOR:-}" ]; then
                printf '\\033[32m▮\\033[0m' >&2
            else
                printf '▮' >&2
            fi
        elif [ -z "\${NO_COLOR:-}" ]; then
            printf '\\033[2m▯\\033[0m' >&2
        else
            printf '▯' >&2
        fi
        _monad_i=$(( _monad_i + 1 ))
    done
    if [ -z "\${NO_COLOR:-}" ]; then
        printf ' \\033[2m]\\033[0m \\033[1m%3d%%\\033[0m  \\033[2m%s / %s' \
            "$_monad_pct" "$(monad_format_bytes "$_monad_current")" "$(monad_format_bytes "$_monad_total")" >&2
    else
        printf ' ] %3d%%  %s / %s' \
            "$_monad_pct" "$(monad_format_bytes "$_monad_current")" "$(monad_format_bytes "$_monad_total")" >&2
    fi
    if [ "$_monad_columns" -ge 100 ] && [ "$_monad_rate" -gt 0 ]; then
        printf '  %s/s' "$(monad_format_bytes "$_monad_rate")" >&2
        [ "$_monad_eta" -ge 0 ] && printf '  %ds left' "$_monad_eta" >&2
    fi
    [ -z "\${NO_COLOR:-}" ] || return 0
    printf '\\033[0m' >&2
}

monad_expected_size() {
    case "\${1##*/}" in
${shellArtifactSizes}
        *) printf '0' ;;
    esac
}

monad_download_progress() {
    _monad_url="$1"
    _monad_dest="$2"
    _monad_auth="$3"

    _monad_total=$(monad_expected_size "$_monad_url")

    if ! [ "\${_monad_total:-0}" -gt 0 ] 2>/dev/null; then
        if [ -n "$_monad_auth" ]; then
            curl --fail --location --progress-bar --retry 3 --retry-delay 1 --connect-timeout 10 --speed-limit 1024 --speed-time 30 --header "Authorization: Bearer $_monad_auth" "$_monad_url" -o "$_monad_dest"
        else
            curl --fail --location --progress-bar --retry 3 --retry-delay 1 --connect-timeout 10 --speed-limit 1024 --speed-time 30 "$_monad_url" -o "$_monad_dest"
        fi
        return
    fi

    : > "$_monad_dest"
    if [ -n "$_monad_auth" ]; then
        curl --fail --location --silent --show-error --retry 3 --retry-delay 1 --connect-timeout 10 --speed-limit 1024 --speed-time 30 --header "Authorization: Bearer $_monad_auth" "$_monad_url" -o "$_monad_dest" &
    else
        curl --fail --location --silent --show-error --retry 3 --retry-delay 1 --connect-timeout 10 --speed-limit 1024 --speed-time 30 "$_monad_url" -o "$_monad_dest" &
    fi
    _monad_pid=$!
    MONAD_DOWNLOAD_PID=$_monad_pid
    _monad_frame=0
    _monad_started=$(date +%s)
    while kill -0 "$_monad_pid" 2>/dev/null; do
        _monad_current=$(wc -c < "$_monad_dest" | tr -dc '0-9')
        [ -n "$_monad_current" ] || _monad_current=0
        _monad_pct=$(( _monad_current * 100 / _monad_total ))
        _monad_elapsed=$(( $(date +%s) - _monad_started ))
        if [ "$_monad_elapsed" -gt 0 ]; then
            _monad_rate=$(( _monad_current / _monad_elapsed ))
        else
            _monad_rate=0
        fi
        if [ "$_monad_rate" -gt 0 ]; then
            _monad_eta=$(( (_monad_total - _monad_current) / _monad_rate ))
        else
            _monad_eta=-1
        fi
        monad_draw_bar "$_monad_pct" $(( (_monad_frame / 2) % 2 )) \
            "$_monad_current" "$_monad_total" "$_monad_rate" "$_monad_eta"
        _monad_frame=$(( _monad_frame + 1 ))
        sleep 0.12
    done
    if wait "$_monad_pid"; then
        MONAD_DOWNLOAD_PID=''
        _monad_elapsed=$(( $(date +%s) - _monad_started ))
        [ "$_monad_elapsed" -gt 0 ] || _monad_elapsed=1
        _monad_rate=$(( _monad_total / _monad_elapsed ))
        monad_draw_bar 100 1 "$_monad_total" "$_monad_total" "$_monad_rate" 0
        printf '\\n' >&2
    else
        _monad_status=$?
        MONAD_DOWNLOAD_PID=''
        printf '\\r\\033[K' >&2
        return "$_monad_status"
    fi
}

monad_channel() {
    case "$APP_VERSION" in
        *-nightly.*) printf 'nightly' ;;
        *-beta.*) printf 'beta' ;;
        *) printf 'stable' ;;
    esac
}

monad_summary() {
    _monad_install_dir="$1"
    _monad_arch="$2"
    monad_activity_stop
    monad_done "Monad $APP_VERSION installed"
    if monad_is_json; then
        printf '{"type":"summary","version":"%s","channel":"%s","target":"%s","location":"%s"}\\n' \
            "$APP_VERSION" "$(monad_channel)" "$_monad_arch" "$_monad_install_dir"
        return 0
    fi
    [ "$PRINT_QUIET" = "0" ] || return 0
    printf '\\n    Channel    %s\\n    Target     %s\\n    Location   %s\\n' \
        "$(monad_channel)" "$_monad_arch" "$_monad_install_dir" >&2
    if monad_is_interactive && [ -z "\${NO_COLOR:-}" ]; then
        printf '\\n    \\033[2mRun\\033[0m \\033[1;36mmonad up\\033[0m \\033[2mto get started\\033[0m\\n\\n' >&2
    else
        printf '\\n    Run monad up to get started\\n\\n' >&2
    fi
}
`
  );
  source = replaceOnce(
    source,
    '    done\n\n    get_architecture || return 1',
    '    done\n\n    monad_banner\n    get_architecture || return 1'
  );
  source = replaceOnce(
    source,
    '    say "downloading $APP_NAME $APP_VERSION $'.concat('{_arch}" 1>&2'),
    '    monad_step "Downloading release archive ($'.concat('{_arch})"')
  );
  source = replaceOnce(
    source,
    `        if [ -n "\${_checksum_style:-}" ]; then
            verify_checksum "$_file" "$_checksum_style" "$_checksum_value"
        else
            say "no checksums to verify" 1>&2
        fi`,
    `        monad_done "Release archive downloaded"
        if [ -n "\${_checksum_style:-}" ]; then
            monad_activity_start "Verifying \${_checksum_style} checksum"
            verify_checksum "$_file" "$_checksum_style" "$_checksum_value"
            monad_activity_stop
            monad_done "Checksum verified"
        else
            say "no checksums to verify" 1>&2
        fi`
  );
  source = replaceOnce(
    source,
    `    if [ "$_download_result" = "0" ]; then
        say "this may be a standard network error, but it may also indicate" 1>&2
        say "that $APP_NAME's release process is not working. When in doubt" 1>&2
        say "please feel free to open an issue!" 1>&2
        exit 1
    fi`,
    `    if [ "$_download_result" = "0" ]; then
        monad_error "Could not download a release archive from any configured source. Check the network or release assets, then try again."
        exit 1
    fi`
  );
  source = replaceOnce(
    source,
    `            if ! downloader "$_updater_url" "$_updater_file"; then
                say "failed to download $_updater_url"
                continue
            fi`,
    `            monad_step "Downloading updater"
            if ! downloader "$_updater_url" "$_updater_file"; then
                say "failed to download $_updater_url"
                continue
            fi
            monad_done "Updater downloaded"`
  );
  source = replaceOnce(
    source,
    '    # unpack the archive\n    case "$_zip_ext" in',
    '    # unpack the archive\n    monad_activity_start "Unpacking release"\n    case "$_zip_ext" in'
  );
  source = replaceOnce(
    source,
    '    esac\n\n    install "$_dir"',
    '    esac\n    monad_activity_stop\n    monad_done "Release unpacked"\n\n    install "$_dir"'
  );
  source = replaceOnce(
    source,
    '    say "installing to $_install_dir"',
    '    monad_activity_start "Installing to $_install_dir"'
  );
  source = replaceOnce(source, '        say "  $_bin_name"', '        say_verbose "  $_bin_name"');
  source = replaceOnce(source, '        say "  $_lib_name"', '        say_verbose "  $_lib_name"');
  source = replaceOnce(source, '    say "everything\'s installed!"', '    monad_summary "$_install_dir" "$_arch"');

  source = replaceOnce(
    source,
    `        if [ -n "\${AUTH_TOKEN:-}" ]; then
            curl -sSfL --header "Authorization: Bearer \${AUTH_TOKEN}" "$1" -o "$2"
        else
            curl -sSfL "$1" -o "$2"
        fi`,
    `        if monad_is_interactive; then
            monad_download_progress "$1" "$2" "\${AUTH_TOKEN:-}"
        elif [ -n "\${AUTH_TOKEN:-}" ]; then
            curl -sSfL --retry 3 --retry-delay 1 --connect-timeout 10 --speed-limit 1024 --speed-time 30 --header "Authorization: Bearer \${AUTH_TOKEN}" "$1" -o "$2"
        else
            curl -sSfL --retry 3 --retry-delay 1 --connect-timeout 10 --speed-limit 1024 --speed-time 30 "$1" -o "$2"
        fi`
  );
  source = replaceOnce(
    source,
    `        sha256)
            if ! check_cmd sha256sum; then
                say "skipping sha256 checksum verification (it requires the 'sha256sum' command)"
                return 0
            fi
            _calculated_checksum="$(sha256sum -b "$_file" | awk '{printf $1}')"
            ;;`,
    `        sha256)
            if check_cmd sha256sum; then
                _calculated_checksum="$(sha256sum -b "$_file" | awk '{printf $1}')"
            elif check_cmd shasum; then
                _calculated_checksum="$(shasum -a 256 "$_file" | awk '{printf $1}')"
            else
                err "cannot verify sha256 checksum: install sha256sum or shasum"
            fi
            ;;`
  );

  await writeFile(path, source);
}

async function enhancePowerShell(path: string, artifactSizes: Map<string, number>): Promise<void> {
  let source = await readFile(path, 'utf8');
  if (source.includes('# MONAD_INSTALLER_UI')) return;

  const powershellArtifactSizes = [...artifactSizes]
    .map(([name, size]) => `  '${name.replaceAll("'", "''")}' = [int64]${size}`)
    .join('\n');

  source = replaceOnce(
    source,
    '$auth_token = $env:MONAD_GITHUB_TOKEN\n',
    `$auth_token = $env:MONAD_GITHUB_TOKEN

# MONAD_INSTALLER_UI
$MonadArtifactSizes = @{
${powershellArtifactSizes}
}

function Test-MonadJson { return $env:MONAD_OUTPUT -eq 'json' }

function Write-MonadEvent($type, $message, $extra = @{}) {
  if (-not (Test-MonadJson)) { return }
  $event = @{ type = $type; message = $message; version = $app_version }
  foreach ($key in $extra.Keys) { $event[$key] = $extra[$key] }
  Write-Output ($event | ConvertTo-Json -Compress)
}

function Test-MonadInteractive {
  return (-not (Test-MonadJson)) -and ((-not [Console]::IsErrorRedirected) -or ($env:MONAD_FORCE_INTERACTIVE -eq '1')) -and ($env:MONAD_PRINT_QUIET -ne '1')
}

function Write-MonadBanner {
  if (Test-MonadJson) { Write-MonadEvent 'started' 'Installing Monad'; return }
  if ($env:MONAD_PRINT_QUIET -eq '1') { return }
  Write-Host ""
  Write-Host "  ◆ MONAD" -NoNewline -ForegroundColor Cyan
  Write-Host "  $app_version" -ForegroundColor White
  Write-Host "    Daemon-first agent team runtime with headless architecture." -ForegroundColor DarkGray
  Write-Host ""
}

function Write-MonadStep($message) {
  if (Test-MonadJson) { Write-MonadEvent 'stage' $message; return }
  if ($env:MONAD_PRINT_QUIET -eq '1') { return }
  Write-Host "  ◇" -NoNewline -ForegroundColor Cyan
  Write-Host " $message" -ForegroundColor White
}

function Write-MonadDone($message) {
  if (Test-MonadJson) { Write-MonadEvent 'completed' $message; return }
  if ($env:MONAD_PRINT_QUIET -eq '1') { return }
  Write-Host "  ✓" -NoNewline -ForegroundColor Green
  Write-Host " $message" -ForegroundColor DarkGray
}

function Write-MonadError($message) {
  Stop-MonadActivity "Installing Monad"
  if (Test-MonadJson) { Write-MonadEvent 'error' $message; return }
  if ($env:MONAD_PRINT_QUIET -eq '1') { return }
  Write-Host ""
  Write-Host "  ✖ Installation failed" -ForegroundColor Red
  Write-Host "    $message" -ForegroundColor DarkGray
  Write-Host ""
}

function Start-MonadActivity($message) {
  if (Test-MonadInteractive) {
    Write-Progress -Id 2 -Activity $message -Status "Working…" -PercentComplete -1
  } else {
    Write-MonadStep $message
  }
}

function Stop-MonadActivity($message) {
  if (Test-MonadInteractive) { Write-Progress -Id 2 -Activity $message -Completed }
}

function Format-MonadBytes([int64]$bytes) {
  if ($bytes -ge 1GB) { return ('{0:N1} GiB' -f ($bytes / 1GB)) }
  if ($bytes -ge 1MB) { return ('{0:N1} MiB' -f ($bytes / 1MB)) }
  if ($bytes -ge 1KB) { return ('{0:N1} KiB' -f ($bytes / 1KB)) }
  return "$bytes B"
}

function Get-MonadChannel {
  if ($app_version -match '-nightly\\.') { return 'nightly' }
  if ($app_version -match '-beta\\.') { return 'beta' }
  return 'stable'
}

function Write-MonadSummary($installDir, $arch) {
  Stop-MonadActivity "Installing Monad"
  Write-MonadDone "Monad $app_version installed"
  if (Test-MonadJson) {
    Write-MonadEvent 'summary' 'Monad installed' @{ channel = Get-MonadChannel; target = $arch; location = $installDir }
    return
  }
  if ($env:MONAD_PRINT_QUIET -eq '1') { return }
  Write-Host ""
  Write-Host "    Channel    $(Get-MonadChannel)" -ForegroundColor DarkGray
  Write-Host "    Target     $arch" -ForegroundColor DarkGray
  Write-Host "    Location   $installDir" -ForegroundColor DarkGray
  Write-Host ""
  Write-Host "    Run " -NoNewline -ForegroundColor DarkGray
  Write-Host "monad up" -NoNewline -ForegroundColor Cyan
  Write-Host " to get started" -ForegroundColor DarkGray
  Write-Host ""
}
`
  );
  source = replaceOnce(source, '  Initialize-Environment\n', '  Write-MonadBanner\n  Initialize-Environment\n');
  source = replaceOnce(
    source,
    `function Invoke-DownloadFile($client, $url, $path) {
  try {
    $client.DownloadFile($url, $path)
  } catch {
    $message = Get-ExceptionMessage $_.Exception
    throw "failed to download $url to \${path}: $message"
  }
}`,
    `function Invoke-DownloadFile($client, $url, $path) {
  $lastError = $null
  foreach ($attempt in 1..3) {
    try {
      Invoke-MonadDownloadFileOnce $client $url $path
      return
    } catch {
      $lastError = $_
      if ($attempt -lt 3) { Start-Sleep -Seconds $attempt }
    }
  }
  throw $lastError
}

function Invoke-MonadDownloadFileOnce($client, $url, $path) {
  $inputStream = $null
  $outputStream = $null
  $showProgress = Test-MonadInteractive
  try {
    $inputStream = $client.OpenRead($url)
    $outputStream = [System.IO.File]::Open($path, [System.IO.FileMode]::Create)
    $total = [int64]0
    $artifactName = [System.IO.Path]::GetFileName(([Uri]$url).AbsolutePath)
    if ($MonadArtifactSizes.ContainsKey($artifactName)) {
      $total = $MonadArtifactSizes[$artifactName]
    } else {
      [void][int64]::TryParse($client.ResponseHeaders['Content-Length'], [ref]$total)
    }
    $received = [int64]0
    $startedAt = [DateTime]::UtcNow
    $buffer = New-Object byte[] 65536
    while (($read = $inputStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
      $outputStream.Write($buffer, 0, $read)
      $received += $read
      if ($showProgress -and $total -gt 0) {
        $percent = [Math]::Min(100, [int](($received * 100) / $total))
        try { $columns = $Host.UI.RawUI.WindowSize.Width } catch { $columns = 80 }
        $barWidth = if ($columns -lt 72) { 10 } else { 20 }
        $filled = [Math]::Floor(($percent * $barWidth) / 100)
        $bar = ('▮' * $filled) + ('▯' * ($barWidth - $filled))
        $elapsed = ([DateTime]::UtcNow - $startedAt).TotalSeconds
        $rate = if ($elapsed -gt 0) { [int64]($received / $elapsed) } else { [int64]0 }
        $eta = if ($rate -gt 0) { [Math]::Max(0, [int](($total - $received) / $rate)) } else { $null }
        $status = if ($columns -lt 72) { "[$bar] $percent%" } else { "[$bar] $percent%  $(Format-MonadBytes $received) / $(Format-MonadBytes $total)" }
        if ($columns -ge 100 -and $rate -gt 0) { $status += "  $(Format-MonadBytes $rate)/s" }
        if ($columns -ge 100 -and $null -ne $eta) { $status += "  $eta sec left" }
        Write-Progress -Activity "Downloading Monad $app_version" -Status $status -PercentComplete $percent
      } elseif ($showProgress) {
        Write-Progress -Activity "Downloading Monad $app_version" -Status "$(Format-MonadBytes $received) downloaded" -PercentComplete -1
      }
    }
  } catch {
    $message = Get-ExceptionMessage $_.Exception
    throw "failed to download $url to \${path}: $message"
  } finally {
    if ($showProgress) { Write-Progress -Activity "Downloading Monad $app_version" -Completed }
    if ($null -ne $outputStream) { $outputStream.Dispose() }
    if ($null -ne $inputStream) { $inputStream.Dispose() }
  }
}`
  );
  source = replaceOnce(
    source,
    '  Invoke-DownloadFile -client $wc -url $url -path $dir_path',
    '  Write-MonadStep "Downloading release archive ($arch)"\n  Invoke-DownloadFile -client $wc -url $url -path $dir_path\n  Write-MonadDone "Release archive downloaded"'
  );
  source = replaceOnce(
    source,
    '  Write-Verbose "Unpacking to $tmp"',
    '  Start-MonadActivity "Unpacking release"\n  Write-Verbose "Unpacking to $tmp"'
  );
  source = replaceOnce(
    source,
    '  # Let the next step know what to copy',
    '  Stop-MonadActivity "Unpacking release"\n  Write-MonadDone "Release unpacked"\n\n  # Let the next step know what to copy'
  );
  source = replaceOnce(
    source,
    '  Invoke-DownloadFile -client $wc -url $updater_url -path $out_name',
    '  Write-MonadStep "Downloading updater"\n    Invoke-DownloadFile -client $wc -url $updater_url -path $out_name\n    Write-MonadDone "Updater downloaded"'
  );
  source = replaceOnce(
    source,
    '  Write-Information "installing to $dest_dir"',
    '  Start-MonadActivity "Installing to $dest_dir"'
  );
  source = replaceEvery(
    source,
    '    Write-Information "  $installed_file"',
    '    Write-Verbose "  $installed_file"',
    3
  );
  source = replaceOnce(
    source,
    '  Write-Information "everything\'s installed!"',
    '  Write-MonadSummary $dest_dir $arch'
  );
  source = replaceOnce(
    source,
    `} catch {
  Write-Information $_
  exit 1
}`,
    `} catch {
  Write-MonadError (Get-ExceptionMessage $_.Exception)
  exit 1
}`
  );

  await writeFile(path, source);
}

function replaceOnce(source: string, search: string, replacement: string): string {
  const first = source.indexOf(search);
  if (first < 0) throw new Error(`dist installer template changed; missing anchor: ${search.slice(0, 80)}`);
  if (source.indexOf(search, first + search.length) >= 0) {
    throw new Error(`dist installer template changed; ambiguous anchor: ${search.slice(0, 80)}`);
  }
  return `${source.slice(0, first)}${replacement}${source.slice(first + search.length)}`;
}

function replaceEvery(source: string, search: string, replacement: string, expectedCount: number): string {
  const count = source.split(search).length - 1;
  if (count !== expectedCount) {
    throw new Error(`dist installer template changed; expected ${expectedCount} anchors, found ${count}: ${search}`);
  }
  return source.split(search).join(replacement);
}
