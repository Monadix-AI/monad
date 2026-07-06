<#
.SYNOPSIS
  Monad installer (Windows). PowerShell counterpart of scripts/install.sh.

.DESCRIPTION
  Usage (production):
    irm https://raw.githubusercontent.com/monadix-labs/monad/main/scripts/install.ps1 | iex

  Usage (local dev — fully self-contained inside dist\):
    bun run build:release        # produces dist\monad-<ver>-windows-x64.tar.gz
    $env:MONAD_TARBALL="dist\monad-<ver>-windows-x64.tar.gz"; ./scripts/install.ps1

  Environment overrides (same names/semantics as install.sh):
    MONAD_VERSION         release tag to install (default: latest for the selected channel)
    MONAD_CHANNEL         release channel: stable (default), beta, or nightly
    MONAD_INSTALL_DIR     installation root       (default: $HOME\.monad)
    MONAD_BIN_DIR         where to place binaries (default: <install dir>\bin)
                          when set explicitly, PATH modification is skipped automatically
    MONAD_NO_PATH_MODIFY  set to 1 to never touch the user PATH
    MONAD_TARBALL         path to a local .tar.gz, skips download
    MONAD_SKIP_VERIFY     set to 1 to skip SHA256 verification
    MONAD_START_MENU_DIR  Start Menu shortcut directory override
    MONAD_DESKTOP_DIR     Desktop shortcut directory override
#>

#Requires -Version 5.1
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# ── Constants ──────────────────────────────────────────────────────────────────

$ReleaseRepository = if ($env:MONAD_GITHUB_REPO) { $env:MONAD_GITHUB_REPO } else { 'Monadix-AI/monad' }
$InstallDir  = if ($env:MONAD_INSTALL_DIR)  { $env:MONAD_INSTALL_DIR }  else { Join-Path $HOME '.monad' }
$Channel     = if ($env:MONAD_CHANNEL)      { $env:MONAD_CHANNEL }      else { 'stable' }
$SkipVerify  = $env:MONAD_SKIP_VERIFY -eq '1'
$NoPathMod   = $env:MONAD_NO_PATH_MODIFY -eq '1'
$BinExplicit = [bool]$env:MONAD_BIN_DIR

# PortableGit provides bash + full MSYS2 coreutils (ls/grep/awk/…) for shell_exec.
# Pin a specific release for reproducibility; update when a new Git for Windows ships.
$GitTag      = 'v2.54.0.windows.1'
$GitVersion  = '2.54.0'

# ── Logging ─────────────────────────────────────────────────────────────────────

function Info    ([string]$m) { Write-Host "[monad] $m"        -ForegroundColor Cyan }
function Success ([string]$m) { Write-Host "[monad] $m"        -ForegroundColor Green }
function Warn    ([string]$m) { Write-Host "[monad] $m"        -ForegroundColor Yellow }
function Fatal   ([string]$m) { Write-Host "[monad] error: $m" -ForegroundColor Red; exit 1 }

# ── OS + arch detection ──────────────────────────────────────────────────────────
# The release build (scripts/build-release.ts) ships windows-x64 only; on ARM64 Windows the
# x64 binary runs under the OS emulation layer.

function Get-Platform {
  switch ($env:PROCESSOR_ARCHITECTURE) {
    'AMD64' { 'windows-x64' }
    'ARM64' { Warn 'No native windows-arm64 build — installing windows-x64 (runs under emulation).'; 'windows-x64' }
    'x86'   { Fatal 'Unsupported architecture: x86. A 64-bit Windows is required.' }
    default { Warn "Unknown architecture '$($env:PROCESSOR_ARCHITECTURE)' — assuming windows-x64."; 'windows-x64' }
  }
}

function Get-LatestVersion {
  $headers = @{ 'User-Agent' = 'monad-installer' }
  if ($Channel -eq 'stable') {
    $api = "https://api.github.com/repos/$ReleaseRepository/releases/latest"
    return (Invoke-RestMethod -Uri $api -UseBasicParsing -Headers $headers).tag_name
  }
  # beta/nightly: fetch the releases list and return the first tag that matches the channel.
  $api = "https://api.github.com/repos/$ReleaseRepository/releases?per_page=50"
  $releases = Invoke-RestMethod -Uri $api -UseBasicParsing -Headers $headers
  $tag = ($releases | Where-Object { $_.tag_name -match "-$Channel\." } | Select-Object -First 1).tag_name
  if (-not $tag) {
    Fatal "No $Channel release found. Check https://github.com/$ReleaseRepository/releases or set MONAD_VERSION."
  }
  return $tag
}

function Test-Sha256 ([string]$File, [string]$ChecksumFile) {
  $expected = ((Get-Content -Raw $ChecksumFile).Trim() -split '\s+')[0]
  $actual   = (Get-FileHash -Algorithm SHA256 -Path $File).Hash.ToLower()
  if ($actual -ne $expected.ToLower()) {
    Fatal "SHA256 mismatch for $File`n  expected: $expected`n  got:      $actual"
  }
}

# ── PATH setup (user scope; production only) ──────────────────────────────────────

function Add-ToUserPath ([string]$Dir) {
  if ($NoPathMod -or $BinExplicit) { return }
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if (-not $userPath) { $userPath = '' }
  $entries  = @($userPath -split ';' | Where-Object { $_ -ne '' })
  if ($entries -contains $Dir) { return }
  $newPath = (@($userPath.TrimEnd(';')) + $Dir | Where-Object { $_ -ne '' }) -join ';'
  [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
  $env:Path = "$env:Path;$Dir"  # current session, too
  Info "  Added $Dir to your user PATH (restart open terminals to pick it up)"
}

# ── Start Menu / desktop shortcut setup ─────────────────────────────────────────

function New-MonadShortcut([string]$Path, [string]$Target) {
  $dir = Split-Path $Path
  New-Item -ItemType Directory -Path $dir -Force | Out-Null
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($Path)
  $shortcut.TargetPath = $Target
  $shortcut.Arguments = 'up'
  $shortcut.WorkingDirectory = Split-Path $Target
  $shortcut.Description = 'Start Monad and open the Web UI'
  $shortcut.Save()
}

function Install-AppLaunchers([string]$MonadExe) {
  $startMenuDir = if ($env:MONAD_START_MENU_DIR) {
    $env:MONAD_START_MENU_DIR
  } else {
    Join-Path ([Environment]::GetFolderPath('Programs')) 'Monad'
  }
  $desktopDir = if ($env:MONAD_DESKTOP_DIR) {
    $env:MONAD_DESKTOP_DIR
  } else {
    [Environment]::GetFolderPath('DesktopDirectory')
  }

  $startMenuLink = Join-Path $startMenuDir 'Monad.lnk'
  $desktopLink = Join-Path $desktopDir 'Monad.lnk'
  New-MonadShortcut -Path $startMenuLink -Target $MonadExe
  New-MonadShortcut -Path $desktopLink -Target $MonadExe
  Info "  Start Menu shortcut: $startMenuLink"
  Info "  Desktop shortcut: $desktopLink"
}

# ── Main ──────────────────────────────────────────────────────────────────────────

Info 'Installing monad…'

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("monad-" + [System.IO.Path]::GetRandomFileName())
New-Item -ItemType Directory -Path $tmp -Force | Out-Null
try {
  # ── 1. Determine source tarball ───────────────────────────────────────────────
  if ($env:MONAD_TARBALL) {
    $tarball = $env:MONAD_TARBALL
    Info "Using local tarball: $tarball"
  } else {
    $platform = Get-Platform
    $version  = if ($env:MONAD_VERSION) { $env:MONAD_VERSION } else { Info "Fetching latest $Channel release version…"; Get-LatestVersion }
    if (-not $version) { Fatal 'Could not determine release version.' }

    $releaseTag = if ($version.StartsWith('v')) { $version } else { "v$version" }
    $artifactVersion = if ($version.StartsWith('v')) { $version.Substring(1) } else { $version }
    $artifact   = "monad-$artifactVersion-$platform"
    $releaseUrl = "https://github.com/$ReleaseRepository/releases/download/$releaseTag/$artifact.tar.gz"
    $tarball    = Join-Path $tmp "$artifact.tar.gz"

    Info "Downloading $artifact…"
    Invoke-WebRequest -Uri $releaseUrl -OutFile $tarball -UseBasicParsing

    if (-not $SkipVerify) {
      $checksum = "$tarball.sha256"
      Invoke-WebRequest -Uri "$releaseUrl.sha256" -OutFile $checksum -UseBasicParsing
      Info 'Verifying checksum…'
      Test-Sha256 -File $tarball -ChecksumFile $checksum
      Success 'Checksum verified'
    }
  }

  # ── 2. Extract (Windows 10+ ships bsdtar as tar.exe, which reads .tar.gz) ──────
  if (-not (Get-Command tar -ErrorAction SilentlyContinue)) {
    Fatal 'tar not found. Windows 10 (1803+) and 11 include it; please update or extract manually.'
  }
  Info "Extracting to $InstallDir…"
  New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
  tar -xzf $tarball -C $InstallDir --strip-components=1
  if ($LASTEXITCODE -ne 0) { Fatal 'tar extraction failed.' }
  Success 'Extracted'

  # ── 3. Git Bash (PortableGit) ────────────────────────────────────────────────
  # monad's shell_exec and code_execute use bash on Windows. Skip if already present
  # (re-install or MONAD_SKIP_GIT=1) to avoid a ~150 MB download on every upgrade.
  $gitDir   = Join-Path $InstallDir 'git'
  $bashExe  = Join-Path $gitDir 'bin\bash.exe'
  $skipGit  = ($env:MONAD_SKIP_GIT -eq '1') -or (Test-Path $bashExe)
  if ($skipGit) {
    if (Test-Path $bashExe) { Info 'Git Bash already present — skipping download' }
  } else {
    $arch    = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { '64-bit' }
    $gitExe  = "PortableGit-$GitVersion-$arch.7z.exe"
    $gitUrl  = "https://github.com/git-for-windows/git/releases/download/$GitTag/$gitExe"
    $gitPath = Join-Path $tmp $gitExe
    Info "Downloading Git Bash ($GitVersion $arch)…"
    Invoke-WebRequest -Uri $gitUrl -OutFile $gitPath -UseBasicParsing
    Info 'Extracting Git Bash…'
    New-Item -ItemType Directory -Path $gitDir -Force | Out-Null
    # PortableGit ships as a 7-zip self-extracting archive; run with -o and -y to extract silently.
    & $gitPath -o"$gitDir" -y | Out-Null
    if ($LASTEXITCODE -ne 0) { Fatal 'Git Bash extraction failed.' }
    Success 'Git Bash installed'
  }

  # ── 4. Place binaries ─────────────────────────────────────────────────────────
  $srcBin = Join-Path $InstallDir 'bin'
  if ($BinExplicit) {
    $binDir = $env:MONAD_BIN_DIR
    New-Item -ItemType Directory -Path $binDir -Force | Out-Null
    Copy-Item -Path (Join-Path $srcBin '*') -Destination $binDir -Recurse -Force
  } else {
    $binDir = $srcBin
  }
  Info "  binaries in $binDir"

  # ── 5. App launchers ─────────────────────────────────────────────────────────
  $monadExe = Join-Path $binDir 'monad.exe'
  Install-AppLaunchers -MonadExe $monadExe

  # ── 6. PATH (skipped when bin dir is explicit or opted out) ───────────────────
  Add-ToUserPath -Dir $binDir

  # ── 7. First-run init ─────────────────────────────────────────────────────────
  try {
    & $monadExe init --quiet 2>$null
    if ($LASTEXITCODE -eq 0) { Success 'Monad home initialised' } else { throw }
  } catch {
    Warn "Could not run 'monad init' — run it manually after restarting your terminal."
  }

  # ── 8. Done ────────────────────────────────────────────────────────────────────
  Success 'monad installed successfully!'
  $monadHome = if ($env:MONAD_HOME) { $env:MONAD_HOME } else { Join-Path $HOME '.monad' }
  Write-Host ''
  Write-Host '  Start everything:  monad up         # daemon + web UI in one process'
  Write-Host '  Web UI:            http://localhost:3000'
  Write-Host '  Daemon only:       monad daemon'
  Write-Host '  Use the CLI:       monad --help'
  Write-Host "  Provider sample:   $monadHome\config.json (model.providers + model.profiles)"
  Write-Host ''
}
finally {
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $tmp
}
