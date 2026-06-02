#!/usr/bin/env pwsh
# Windows-native verification for the @monad/sandbox-vm Hyper-V backend. Run INSIDE a Windows VM/host.
# Validates the parts that can't be exercised on the macOS/Linux dev host: the real Windows Go build,
# the junction-based 9p confinement test, hvsock registry setup, and (if Hyper-V is available) a full
# VM boot. Requires: Go 1.24+, and for the boot step, Hyper-V (Pro/Enterprise/Education + nested virt
# if this is itself a VM). Bun steps are optional.
#
#   pwsh packages/sandbox-vm/test/smoke/winvm-helper.ps1            # tier-0: build + tests + probe (no Hyper-V needed)
#   pwsh packages/sandbox-vm/test/smoke/winvm-helper.ps1 -Boot      # also attempt a full `msvm run` (needs Hyper-V)
#   pwsh packages/sandbox-vm/test/smoke/winvm-helper.ps1 -Conformance # run the complete real Hyper-V suite
#
# Run the elevated one-time hvsock registration separately (needs admin):
#   pwsh -Command "Start-Process pwsh -Verb RunAs -ArgumentList '-File','packages/sandbox-vm/test/smoke/winvm-helper.ps1','-SetupOnly'"

param([switch]$Boot, [switch]$SetupOnly, [switch]$Conformance)

$ErrorActionPreference = 'Stop'
# This smoke lives in the package (packages/sandbox-vm/test/smoke); the package root is two up.
$pkg = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$helperSrc = Join-Path $pkg 'native\winvm-helper'
$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'amd64' }
$helperExe = Join-Path $env:TEMP "winvm-helper-$arch.exe"

function Step($name) { Write-Host "`n=== $name ===" -ForegroundColor Cyan }
function Ok($m)  { Write-Host "PASS: $m" -ForegroundColor Green }
function Die($m) { Write-Host "FAIL: $m" -ForegroundColor Red; exit 1 }

if ($SetupOnly) {
  Step 'Register hvsock service ports (elevated)'
  & $helperExe setup --ports '1024,1025,1026-1057'
  if ($LASTEXITCODE -ne 0) { Die 'setup registration failed' }
  Ok 'hvsock ports registered'
  exit 0
}

Step 'Native Go build (winvm-helper)'
Push-Location $helperSrc
try {
  & go build -o $helperExe .
  if ($LASTEXITCODE -ne 0) { Die 'go build failed' }
  Ok "built $helperExe"

  Step 'go vet'
  & go vet ./...
  if ($LASTEXITCODE -ne 0) { Die 'go vet failed' }
  Ok 'vet clean'

  Step 'Confinement tests (symlink + Windows junction 9p escape)'
  & go test -run Confined -v ./...
  if ($LASTEXITCODE -ne 0) { Die 'confinement tests failed — 9p sandbox escape not closed' }
  Ok 'os.Root confinement holds against symlink AND junction escape'
} finally { Pop-Location }

Step 'Helper probe (Hyper-V availability)'
$probe = & $helperExe probe | ConvertFrom-Json
if ($probe.hyperv) { Ok 'Hyper-V usable' } else { Write-Host "Hyper-V NOT usable: $($probe.detail)" -ForegroundColor Yellow }

Step 'hvsock port registration state (--check, no admin)'
$reg = & $helperExe setup --check --ports '1024,1025,1026-1057' | ConvertFrom-Json
if ($reg.registered) { Ok 'all hvsock ports registered' }
else { Write-Host "Not registered (run: pwsh packages/sandbox-vm/test/smoke/winvm-helper.ps1 -SetupOnly, elevated). Missing: $($reg.missing -join ',')" -ForegroundColor Yellow }

# Optional: TS unit tests exercise the Windows path branches (winpath, image tar, bundle New-VHD).
if (Get-Command bun -ErrorAction SilentlyContinue) {
  Step 'Bun unit tests (sandbox-vm)'
  Push-Location ($pkg)
  try {
    & bun test test/unit/
    if ($LASTEXITCODE -ne 0) { Write-Host 'Bun unit tests failed (non-fatal here)' -ForegroundColor Yellow } else { Ok 'sandbox-vm unit tests' }
  } finally { Pop-Location }
} else { Write-Host 'bun not found — skipping TS unit tests' -ForegroundColor Yellow }

if ($Boot) {
  if (-not $probe.hyperv) { Die 'cannot boot: Hyper-V not usable (enable Hyper-V; if this is a VM, enable nested virtualization)' }
  if (-not $reg.registered) { Die 'cannot boot: hvsock ports not registered (run -SetupOnly elevated first)' }
  Step 'Full VM boot: msvm run -- echo monad-vm-ok (downloads the CoreOS image on first run)'
  Push-Location ($pkg)
  try {
    & bun src/cli.ts run -- echo monad-vm-ok
    if ($LASTEXITCODE -ne 0) { Die 'msvm run failed' }
    Ok 'guest booted and executed a command over vsock'
  } finally { Pop-Location }
}

if ($Conformance) {
  if (-not $probe.hyperv) { Die 'cannot run conformance: Hyper-V not usable' }
  if (-not $reg.registered) { Die 'cannot run conformance: hvsock ports not registered (run -SetupOnly elevated first)' }
  Step 'Real Hyper-V/hvsock/9p conformance'
  Push-Location ($pkg)
  try {
    $env:MONAD_VM_IT = '1'
    & bun run test:e2e
    if ($LASTEXITCODE -ne 0) { Die 'real Hyper-V conformance failed' }
    Ok 'real Hyper-V conformance'
  } finally { Pop-Location }
}

Write-Host "`nAll requested checks passed." -ForegroundColor Green
