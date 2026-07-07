<#
.SYNOPSIS
  Self-contained install simulation for Windows inside dist\test-install\.
  Tests three flows: fresh install, upgrade, overwrite-install (home data preserved).
  Nothing outside the project directory is touched.

.DESCRIPTION
  Usage:
    bun run install:test:win
    bun run install:test:win -- --clean

  MONAD_SKIP_GIT=1 is always set so the ~150 MB PortableGit download is skipped.
  Set MONAD_SKIP_GIT=0 to test the full Git Bash download path (requires network).
#>

#Requires -Version 5.1
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ScriptDir  = Split-Path $MyInvocation.MyCommand.Path
$Root       = Split-Path (Split-Path $ScriptDir)
$Dist       = Join-Path $Root 'dist'
$Installer  = Join-Path $Root 'scripts\install.ps1'

function Ok   ([string]$m) { Write-Host "  v $m" -ForegroundColor Green }
function Fail ([string]$m) { Write-Host "  x $m" -ForegroundColor Red; exit 1 }
function Step ([string]$m) { Write-Host ""; Write-Host "[install-test] $m" -ForegroundColor Cyan }

if (-not (Test-Path $Dist)) {
  Write-Host "[install-test] dist\ not found — run 'bun run build:release' first."
  exit 1
}

$Tarball = Get-ChildItem $Dist -Filter 'monad-*-windows-*.tar.gz' |
           Where-Object { $_.Name -notmatch 'test-install' } |
           Sort-Object LastWriteTime -Descending |
           Select-Object -First 1 -ExpandProperty FullName

if (-not $Tarball) {
  Write-Host "[install-test] No windows tarball found in dist\ — run 'bun run build:release --all' first."
  exit 1
}

$TestDir    = Join-Path $Dist 'test-install'
$InstallDir = Join-Path $TestDir 'install'
$BinDir     = Join-Path $TestDir 'bin'
$HomeDir    = Join-Path $TestDir 'home'

if ($args -contains '--clean') {
  Step 'Cleaning dist\test-install\…'
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $TestDir
}

Write-Host "[install-test] tarball : $(Split-Path $Tarball -Leaf)"
Write-Host "[install-test] install : $InstallDir"

function Invoke-Installer {
  $env:MONAD_TARBALL        = $Tarball
  $env:MONAD_SKIP_VERIFY    = '1'
  $env:MONAD_INSTALL_DIR    = $InstallDir
  $env:MONAD_BIN_DIR        = $BinDir
  $env:MONAD_HOME           = $HomeDir
  $env:MONAD_NO_PATH_MODIFY = '1'
  # Skip the ~150 MB PortableGit download in CI; set MONAD_SKIP_GIT=0 for a full test.
  if (-not $env:MONAD_SKIP_GIT) { $env:MONAD_SKIP_GIT = '1' }
  & powershell -NoProfile -ExecutionPolicy Bypass -File $Installer
  if ($LASTEXITCODE -ne 0) { Fail "installer exited with code $LASTEXITCODE" }
  Remove-Item Env:\MONAD_TARBALL, Env:\MONAD_SKIP_VERIFY, Env:\MONAD_INSTALL_DIR,
              Env:\MONAD_BIN_DIR, Env:\MONAD_HOME, Env:\MONAD_NO_PATH_MODIFY,
              Env:\MONAD_SKIP_GIT -ErrorAction SilentlyContinue
}

$MonadExe = Join-Path $BinDir 'monad.exe'

function Invoke-SmokeTest {
  & $MonadExe --help | Select-Object -First 4 | Write-Host
  Ok 'monad --help'
  $cfg = Join-Path $HomeDir 'config.json'
  if ((Test-Path $cfg) -and (Get-Content $cfg -Raw) -match 'sample-openai-compatible') {
    Ok 'config.json provider sample'
  }
}

# ── Flow 1: Fresh install ──────────────────────────────────────────────────────
Step 'Flow 1: fresh install'
Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $InstallDir, $BinDir, $HomeDir
Invoke-Installer
if (-not (Test-Path $MonadExe)) { Fail 'binary not found after fresh install' }
Invoke-SmokeTest
$Mtime1 = (Get-Item $MonadExe).LastWriteTimeUtc

# ── Flow 2: Upgrade (re-run installer over existing install) ──────────────────
Step 'Flow 2: upgrade (overwrite existing install)'
Start-Sleep -Seconds 1   # ensure LastWriteTime advances if binary is replaced
Invoke-Installer
if (-not (Test-Path $MonadExe)) { Fail 'binary missing after upgrade' }
Invoke-SmokeTest
$Mtime2 = (Get-Item $MonadExe).LastWriteTimeUtc
if ($Mtime2 -ge $Mtime1) { Ok 'binary replaced (mtime advanced)' }
else { Fail 'binary mtime did not advance — upgrade may not have replaced it' }

# ── Flow 3: Overwrite-install with pre-existing home data ─────────────────────
Step 'Flow 3: overwrite-install (home data must survive)'
$CfgPath = Join-Path $HomeDir 'config.json'
if (-not (Test-Path $HomeDir)) { New-Item -ItemType Directory -Path $HomeDir -Force | Out-Null }
$existing = if (Test-Path $CfgPath) { Get-Content $CfgPath -Raw } else { '' }
Set-Content $CfgPath ($existing.TrimEnd() + "`n# _test_sentinel")
Invoke-Installer
if ((Get-Content $CfgPath -Raw) -match '_test_sentinel') {
  Ok 'home data preserved across overwrite-install'
} else {
  Fail 'home data was wiped by overwrite-install'
}

# ── Daemon + web smoke test ────────────────────────────────────────────────────
Step 'Runtime smoke tests'
$DPort = 4399; $WPort = 3099
$env:MONAD_HOME       = $HomeDir
$env:MONAD_MOCK_MODEL = '1'
$env:MONAD_PORT       = $DPort
$DaemonUrl = "https://127.0.0.1:$DPort"
$WebUrl = "http://localhost:$WPort"
$DProc = Start-Process $MonadExe -ArgumentList 'daemon' -PassThru -RedirectStandardOutput "$env:TEMP\it-daemon.log" -RedirectStandardError "$env:TEMP\it-daemon-err.log"
$env:WEB_PORT  = $WPort
$env:MONAD_URL = $DaemonUrl
$WProc = Start-Process $MonadExe -ArgumentList 'web' -PassThru -RedirectStandardOutput "$env:TEMP\it-web.log" -RedirectStandardError "$env:TEMP\it-web-err.log"

function Stop-Procs { $DProc, $WProc | ForEach-Object { try { $_.Kill() } catch {} } }
try {
  # Wait for readiness
  $ready = $false
  for ($i = 0; $i -lt 40; $i++) {
    try { Invoke-RestMethod "$DaemonUrl/health" -SkipCertificateCheck -ErrorAction Stop | Out-Null; $ready = $true; break } catch {}
    Start-Sleep -Milliseconds 100
  }
  if (-not $ready) { Fail 'daemon did not become ready in time' }
  $ready = $false
  for ($i = 0; $i -lt 40; $i++) {
    try { Invoke-WebRequest "$WebUrl/" -UseBasicParsing -ErrorAction Stop | Out-Null; $ready = $true; break } catch {}
    Start-Sleep -Milliseconds 100
  }
  if (-not $ready) { Fail 'web did not become ready in time' }

  Invoke-RestMethod "$DaemonUrl/health" -SkipCertificateCheck -ErrorAction Stop | Out-Null; Ok 'daemon /health'
  $html = (Invoke-WebRequest "$WebUrl/" -UseBasicParsing).Content
  if ($html -match '<html') { Ok 'web / serves embedded SPA' } else { Fail 'web / did not return HTML' }
  Invoke-RestMethod "$WebUrl/api/daemon/health" -ErrorAction Stop | Out-Null; Ok 'web -> daemon proxy'
} finally {
  Stop-Procs
}

Write-Host ""
Write-Host "[install-test] All outputs inside dist\test-install\ — nothing outside the project was touched."
