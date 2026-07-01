<#
.SYNOPSIS
  Fake-package e2e coverage for scripts\install.ps1.

.DESCRIPTION
  Exercises installer environment overrides and edge cases without requiring a
  release build. Intended to run inside the Windows VM.
#>

#Requires -Version 5.1
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path $MyInvocation.MyCommand.Path
$Root = Split-Path (Split-Path $ScriptDir)
$Installer = Join-Path $Root 'scripts\install.ps1'
$TestDir = Join-Path $Root 'dist\test-install-fake-win'
$PackageDir = Join-Path $TestDir 'packages'

function Ok([string]$m) { Write-Host "  v $m" -ForegroundColor Green }
function Fail([string]$m) { Write-Host "  x $m" -ForegroundColor Red; exit 1 }
function Step([string]$m) { Write-Host ""; Write-Host "[install-fake-e2e] $m" -ForegroundColor Cyan }

function New-FakePackage([string]$Version) {
  $pkg = Join-Path $PackageDir "monad-$Version"
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $pkg
  New-Item -ItemType Directory -Path (Join-Path $pkg 'bin') -Force | Out-Null
  Set-Content -Path (Join-Path $pkg 'bin\monad.exe') -Value "fake monad $Version" -NoNewline
  $tarball = Join-Path $PackageDir "monad-$Version.tar.gz"
  Remove-Item -Force -ErrorAction SilentlyContinue $tarball
  tar -czf $tarball -C $pkg .
  return $tarball
}

function Invoke-FakeInstaller([string]$Tarball) {
  $env:MONAD_TARBALL = $Tarball
  $env:MONAD_SKIP_VERIFY = '1'
  $env:MONAD_INSTALL_DIR = Join-Path $TestDir 'install'
  $env:MONAD_BIN_DIR = Join-Path $TestDir 'bin'
  $env:MONAD_HOME = Join-Path $TestDir 'home'
  $env:MONAD_NO_PATH_MODIFY = '1'
  $env:MONAD_SKIP_GIT = '1'
  & powershell -NoProfile -ExecutionPolicy Bypass -File $Installer
  if ($LASTEXITCODE -ne 0) { Fail "installer exited with code $LASTEXITCODE" }
  Remove-Item Env:\MONAD_TARBALL, Env:\MONAD_SKIP_VERIFY, Env:\MONAD_INSTALL_DIR,
    Env:\MONAD_BIN_DIR, Env:\MONAD_HOME, Env:\MONAD_NO_PATH_MODIFY,
    Env:\MONAD_SKIP_GIT -ErrorAction SilentlyContinue
}

function Assert-BinaryContent([string]$Expected) {
  $monad = Join-Path $TestDir 'bin\monad.exe'
  if (-not (Test-Path $monad)) { Fail 'monad.exe was not copied to explicit bin dir' }
  $actual = Get-Content -Raw $monad
  if ($actual -ne $Expected) { Fail "expected '$Expected', got '$actual'" }
}

Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $TestDir
New-Item -ItemType Directory -Path $PackageDir -Force | Out-Null
$v1 = New-FakePackage '1.0.0'
$v2 = New-FakePackage '1.1.0'

Step 'Flow 1: local fake tarball fresh install with explicit dirs'
Invoke-FakeInstaller $v1
Assert-BinaryContent 'fake monad 1.0.0'
Ok 'fresh install copied fake binary'

Step 'Flow 2: upgrade replaces binary and preserves home data'
$HomeDir = Join-Path $TestDir 'home'
New-Item -ItemType Directory -Path $HomeDir -Force | Out-Null
$sentinel = Join-Path $HomeDir 'sentinel.txt'
Set-Content -Path $sentinel -Value 'keep'
Invoke-FakeInstaller $v2
Assert-BinaryContent 'fake monad 1.1.0'
if ((Test-Path $sentinel) -and ((Get-Content -Raw $sentinel) -match 'keep')) {
  Ok 'home data preserved across upgrade'
} else {
  Fail 'home data was wiped during upgrade'
}

Step 'Flow 3: explicit bin dir skips user PATH writes'
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$binDir = Join-Path $TestDir 'bin'
if ($userPath -and (($userPath -split ';') -contains $binDir)) { Fail 'installer added explicit bin dir to user PATH' }
Ok 'user PATH was not modified for explicit bin dir'

Step 'Flow 4: missing local tarball fails before install completes'
$env:MONAD_TARBALL = Join-Path $TestDir 'packages\missing.tar.gz'
$env:MONAD_SKIP_VERIFY = '1'
$env:MONAD_NO_PATH_MODIFY = '1'
$err = Join-Path $TestDir 'missing-tarball.log'
$out = Join-Path $TestDir 'missing-tarball.out.log'
$proc = Start-Process powershell -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $Installer) -Wait -PassThru -NoNewWindow -RedirectStandardOutput $out -RedirectStandardError $err
$code = $proc.ExitCode
Remove-Item Env:\MONAD_TARBALL, Env:\MONAD_SKIP_VERIFY, Env:\MONAD_NO_PATH_MODIFY -ErrorAction SilentlyContinue
if ($code -eq 0) { Fail 'missing local tarball unexpectedly succeeded' }
$failureOutput = (Get-Content -Raw $out) + (Get-Content -Raw $err)
if ($failureOutput -match 'tar extraction failed|Cannot open|Failed to open') {
  Ok 'missing local tarball rejected'
} else {
  Fail 'missing local tarball error missing'
}

Write-Host ""
Write-Host "[install-fake-e2e] Fake install.ps1 e2e passed."
