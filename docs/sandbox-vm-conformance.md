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
| macOS arm64 | vfkit, vsock, virtio-fs | `unit verified` | `not run` |
| Windows x64 | Hyper-V, hvsock, 9p | `unit verified` | `not run` |

Update the last column only from the exact self-hosted workflow run for the exact commit. Include its driver, OS, architecture, commit, workflow URL, and timestamp in a release record rather than editing the meaning of the states above.

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

## Cleanup and Diagnostics

Cleanup is part of conformance. Success requires removal of the unique bundle, VMM, proxy, mount servers, bridges, sockets or named pipes, Hyper-V VM, and marker-owned helper processes. Cleanup failure fails the job even when behavioral assertions passed.

The workflow retains at most the newest 1 MiB of each platform log on failure. Diagnostics must not include environment values, credentials, mask contents, or unbounded command data. Missing hypervisor support, image artifacts, helper binaries, firmware, or permissions after opt-in is a failure, never a skip.
