# Sandbox VM Conformance

This document defines how `@monad/sandbox-vm` confinement evidence is produced and reported. A checked-in test or workflow is coverage, not evidence that a real hypervisor executed it.

## Evidence States

- `unit verified`: unit, static contract, type, lint, native Go, or cross-compilation gates passed without booting the named hypervisor.
- `real-VM passed on <driver>/<os>/<arch>`: the complete opt-in suite passed on a capable runner using that driver.
- `not run`: no capable runner executed the complete suite for this checkout.

Do not infer a real-VM pass from skipped test discovery, a successful preflight, workflow presence, or success on another driver.

## Evidence Matrix

| Host platform | Driver and transport | Unit/compile evidence | Real-VM evidence for this checkout |
| --- | --- | --- | --- |
| Linux x64 | QEMU/KVM, vsock, virtio-fs | `unit verified` | `not run` |
| Linux arm64 | QEMU/KVM, vsock, virtio-fs | `unit verified` | `not run` |
| macOS arm64 | vfkit, vsock, virtio-fs | `unit verified` | `real-VM passed on vfkit/macOS/arm64` — local, 2026-07-31 |
| Windows x64 | Hyper-V, hvsock, 9p | `unit verified` | `not run` |
| Windows arm64 | Hyper-V, hvsock, 9p | `unit verified` | `not run` |

Update the last column only after the complete suite runs for the exact checkout. Record whether the
evidence came from a local host or self-hosted workflow, and include its driver, OS, architecture,
commit, timestamp, and workflow URL when applicable.

## Test Surfaces

The common real-VM suites exercise unprivileged execution, PTY and pipe cancellation, host-oracle filesystem confinement, deny and credential-mask precedence across canonical and symlinked guest aliases, `net:none`, filtered egress with direct public and gvproxy DNS blocked, private PID and temporary namespaces, cgroup violation events, bounded passive filesystem syscall observations, policy identity, and cross-agent separation. The syscall suite requires denied `openat`, rename destinations, and nested no-write targets to emit diagnostics, requires allowed writable-root attempts to remain silent, and drains rapid attempts during cancellation. The Windows-only suite additionally checks drive and space-bearing path translation, Hyper-V teardown, hvsock execution, 9p share semantics, and junction-alias overlay coverage.

The baseline suite captures only while the protocol-v5 guest reports zero active runs and `everStarted:false`, reconstructs host sidecars, restores, verifies the same boot epoch and guest-agent digest, then admits the first pipe workload. vfkit is expected to report cold-only behavior. Unit or mocked restore results are not performance evidence.

Filesystem syscall events are diagnostic hints from a passive seccomp USER_NOTIF observer. Every notification is continued; mount plans, read-only shares, overlays, and host-side oracles remain the enforcement evidence. Observer setup failure is a conformance failure on a capable runner, not permission to claim reduced coverage.

All commands run inside a Linux guest. Tests translate host paths through the launcher's guest-path mapping and shell-quote them once. Host-side assertions use the original host paths. Guest output can prove guest-local facts such as UID or terminal size, but it cannot prove that a host file was protected.

Failed-boot rollback uses a unique agent marker and audits only marker-owned bundles, processes, and Hyper-V VMs. It must not use a process-name-only assertion because another concurrent run may legitimately own the same executable.

## Runner Provisioning

The dedicated workflow uses these exact self-hosted labels:

- Linux: `self-hosted, linux, x64, monad-vm, kvm`
- macOS: `self-hosted, macos, arm64, monad-vm, vfkit`
- Windows: `self-hosted, windows, x64, monad-vm, hyperv`

Every runner needs the repository's pinned Bun version, enough disk for the CoreOS image cache and per-test clones, and permission to remove all resources it creates. Pre-cache or permit the consented Fedora CoreOS download before making a lane required.

Linux provisioning requires readable and writable `/dev/kvm`, hardware virtualization exposed to the runner, QEMU, `virtiofsd`, `socat`, and compatible firmware. The preflight rejects QEMU TCG; it cannot stand in for KVM evidence.

macOS provisioning requires a vfkit-capable host with the Virtualization.framework entitlement and the resolved vfkit, gvproxy, and virtio-fs toolchain. Nested or hosted infrastructure that cannot boot vfkit is not a macOS conformance runner.

Windows provisioning requires Hyper-V enabled, the runner identity permitted to manage Hyper-V VMs, the vendored Windows helper buildable, hvsock service registration permitted, and the configured 9p and bridge ports available. Run the setup smoke from an elevated PowerShell session when initially provisioning the host.

## Commands

Prepare a clean checkout before running either the smoke tests or conformance suite. `bun install`
intentionally defers generated artifacts, and unpublished vendor assets fall back to local builds:

```sh
bun install --frozen-lockfile
bun run generate
bun run scripts/vm-vendor.ts
```

The local build fallback needs Go. Building the Linux-only seccomp observer from macOS or Windows
also needs Docker or Podman. Prime the verified CoreOS image cache and prove one guest command can
finish before starting the parallel suite:

```sh
bun packages/sandbox-vm/src/cli.ts run -- true
```

The first run downloads the current architecture's CoreOS image and can take several minutes.
Do not start the conformance suite until this command exits successfully.

Run the platform preflight before any opt-in suite:

```sh
bun packages/sandbox-vm/test/smoke/vm-preflight.ts
```

Audit rollback from a deliberately failed boot:

```sh
bun packages/sandbox-vm/test/smoke/vm-boot-rollback.ts
```

Run the complete real-VM suite on a capable Unix runner:

```sh
MONAD_VM_IT=1 bun run --cwd packages/sandbox-vm test:e2e
```

Collect the required 30 cold and 30 restore samples on a QEMU/KVM or Hyper-V capable host:

```sh
MONAD_VM_IT=1 MONAD_VM_BASELINE_BENCH=1 bun packages/sandbox-vm/test/e2e/vm-baseline.test.ts
```

Do not enable a driver by default or claim a latency improvement until this command reports 30 samples in both groups on the same runner and commit. TCG and vfkit results do not qualify as QEMU/KVM or Hyper-V restore evidence.

Provision or run conformance on a capable Windows host from PowerShell:

```powershell
packages\sandbox-vm\test\smoke\winvm-helper.ps1 -SetupOnly
packages\sandbox-vm\test\smoke\winvm-helper.ps1 -Conformance
```

Without `MONAD_VM_IT=1`, the common real-VM cases must be discovered as skipped. Windows-suffixed cases are excluded on non-Windows hosts by the repository test runner.

## Local Platform Verification

A Linux guest hosted by UTM can validate native Linux sandbox behavior, but it is not automatically
a Linux real-VM conformance runner. Run the preflight inside the guest. If `/dev/kvm` is absent or
not readable and writable, record the QEMU/KVM lane as `not run`; do not substitute TCG or the outer
UTM VM.

For a clean Linux guest checkout:

```sh
bun install --frozen-lockfile
bun run generate
gcc -O2 -Wall -Wextra \
  -o "$(dirname "$(command -v bun)")/monad-sandbox-launcher" \
  apps/monad/native/sandbox-launcher/main.c
bun scripts/bun-test.ts \
  packages/sandbox/test/unit/ \
  apps/monad/test/unit/tools/ \
  apps/monad/test/e2e/sandbox-bwrap.linux.test.ts \
  --only-failures
bun run --cwd packages/sandbox-vm test
bun packages/sandbox-vm/test/smoke/vm-preflight.ts
```

The native sandbox result is valid only when the test command exits zero. The VM unit result remains
`unit verified`; a preflight exit of 69 with `driver:"qemu-kvm"` means the Linux real-VM lane was not
run.

### Local verification record

On 2026-07-31, an Apple silicon macOS host completed the vfkit preflight, failed-boot rollback
audit, and every applicable real-VM file serially. The results were:

- conformance: 16 passed;
- mount alias: 1 passed;
- network: 5 passed;
- resource violations: 2 passed;
- syscall observation: 5 passed;
- baseline discovery: 1 passed and 2 platform-gated cases skipped, because vfkit has no restore
  implementation.

The same host completed the macOS native sandbox unit and daemon-tool scope with 475 passed and 1
platform-gated skip. The UTM Ubuntu 26.04 arm64 guest completed the Linux native sandbox,
daemon-tool, and Bubblewrap e2e scope, plus the `@monad/sandbox-vm` unit and typecheck scopes.
This is Linux arm64 unit and native-sandbox evidence. Linux preflight exited 69 with
`driver:"qemu-kvm"` because the guest has no `/dev/kvm`; therefore this record does not claim Linux
arm64 QEMU/KVM real-VM evidence, or any Linux x64 or Windows Hyper-V evidence.

The UTM Windows arm64 guest completed the Windows-applicable native sandbox and daemon-tool unit
scope with 418 passed and 13 platform-gated skips, the sandbox settings e2e case, and the native
ARM64 AppContainer subprocess smoke. The smoke verified writable-root access, blocked writes
outside that root, blocked reads from a deny-read directory, complete matching-profile cleanup, and
reversal of both deny-read and writable-root ACEs after child exit. This is Windows arm64 unit and
native-sandbox evidence; it does not claim Windows arm64 Hyper-V real-VM evidence.
The full sandbox spawn seam also passed with automatic AppContainer selection, daemon-style policy
construction, inside-root writes, outside-root and credential-read denial, cancellation, and
per-session profile disposal.
The Low Integrity fallback was also exercised on the same guest. Launcher selection and the
`S-1-16-4096` child token were confirmed, but the writable-root case failed because the launcher's
DACL grant does not override Windows mandatory integrity control. This is recorded as a failed
fallback check, not Windows Hyper-V or Low Integrity conformance evidence.

## Cleanup and Diagnostics

Cleanup is part of conformance. Success requires removal of the unique bundle, VMM, proxy, mount servers, bridges, sockets or named pipes, Hyper-V VM, and marker-owned helper processes. Cleanup failure fails the job even when behavioral assertions passed.

The workflow retains at most the newest 1 MiB of each platform log on failure. Diagnostics must not include environment values, credentials, mask contents, or unbounded command data. Missing hypervisor support, image artifacts, helper binaries, firmware, or permissions after opt-in is a failure, never a skip.
