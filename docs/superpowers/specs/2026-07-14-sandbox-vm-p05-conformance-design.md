# Sandbox VM P0.5 Real-VM Conformance Design

## Goal

Turn the existing sandbox VM integration suite from an opt-in collection that is normally skipped into an honest, cross-platform release gate. The gate must exercise the actual vfkit, QEMU/KVM, and Hyper-V stacks, use host-side oracles for containment claims, and distinguish unavailable infrastructure from a passing backend.

P0.5 verifies the P0 and P1 behavior already implemented. It does not add new filesystem policy fields, syscall-attempt monitoring, dynamic approvals, snapshots, or guest distributions.

## Current Gaps

The current suite enables real execution only when `MONAD_VM_IT=1` and the host is macOS or Linux. Windows therefore skips every real-VM test even though the launcher advertises `win32` and includes Hyper-V, hvsock, 9p, and guest path translation.

The suite proves basic boot, PTY resize, masking, nested deny, host filesystem escape resistance, network modes, cancellation, private `/tmp`, PID-limit configuration, policy identity, and agent isolation. It does not yet prove all behavior promised by the P0/P1 designs:

- an actual cgroup OOM produces a bounded memory violation;
- an actual PID-limit hit produces a bounded process-limit violation;
- PTY cancellation reaps descendants;
- concurrent runs in one reused VM cannot observe each other's `/tmp` or processes;
- overlapping parent/child shares cannot re-expose a deny or mask;
- a failed boot leaves no owned VMM, mount server, proxy, bridge, or Hyper-V VM;
- Windows 9p and hvsock behavior works beyond argv construction tests.

## Approaches Considered

### Run every platform on GitHub-hosted runners

This is operationally simple but does not provide the required hypervisors. Hosted Linux runners do not offer a dependable KVM device, hosted macOS runners cannot be treated as vfkit-capable nested-virtualization hosts, and hosted Windows runners cannot be treated as Hyper-V hosts. A green hosted job would therefore either skip or exercise a different backend.

### Emulate everything with QEMU TCG

TCG can test much of the Linux guest plane but cannot prove KVM, Virtualization.framework, Hyper-V, hvsock, or Windows 9p lifecycle behavior. It is useful as an optional compatibility lane, not as the cross-platform containment oracle.

### Capability-specific self-hosted runners

Selected approach. A dedicated workflow targets labeled self-hosted runners whose provisioning contract guarantees one backend:

- `self-hosted, linux, x64, monad-vm, kvm`;
- `self-hosted, macos, arm64, monad-vm, vfkit` or an equivalent x64 label;
- `self-hosted, windows, x64, monad-vm, hyperv`.

The Linux KVM job is the required merge/release gate once the runner is registered. macOS and Windows run on manual dispatch and nightly schedules until their runners are promoted to required checks. The workflow never substitutes a hosted runner and never converts a failed preflight into success.

## Test Architecture

### Platform admission

`MONAD_VM_IT=1` remains the single explicit opt-in. When it is absent, Bun discovers and skips the real-VM suites. When it is present, Darwin, Linux, and Windows enter the suite. Missing images, hypervisor support, firmware, helper binaries, permissions, or platform preflight are test failures with actionable messages.

The workflow performs an explicit preflight step before invoking Bun so infrastructure failures are visible separately from conformance failures. It records the platform, architecture, selected driver, accelerator capability, image artifact, and tool versions without logging secrets or policy contents.

### Shared fixture boundary

The integration code is split before it exceeds the repository's file-size guideline:

- `vm-fixture.ts` owns launcher preparation, temporary host roots, process draining, violation draining, shell quoting, host-to-guest path mapping, and cleanup;
- `vm-conformance.it.test.ts` owns common filesystem, network, PTY, cancellation, reuse, and cross-agent behavior;
- `vm-resource-violations.it.test.ts` owns cgroup OOM and PID-limit event behavior;
- `vm-windows.it.test.ts` owns Hyper-V/hvsock/9p behavior that has no meaningful vfkit or QEMU equivalent;
- a fault-injection smoke owns boot rollback and platform-resource oracles.

All commands execute in the Linux guest. Host paths are never interpolated directly into shell programs. The fixture converts every policy-visible host path with the same Windows mapping used by the launcher and quotes it as a guest shell argument. Host assertions continue to read the original host path.

### Host-side oracles

Containment assertions trust only observations outside the workload:

- host files prove whether a mounted path was mutated;
- host fake and real credential bytes prove mask behavior;
- VMM/sidecar process arguments and Hyper-V VM identity prove cleanup;
- violation frames are validated by the host protocol parser and collected concurrently with output;
- a timeout is a failure, not evidence that an operation was blocked.

Guest output may establish terminal size, UID, cgroup values, or namespace-local state, but it cannot by itself prove that host data stayed protected.

## Required Conformance Cases

### Common on Darwin, Linux, and Windows

- unprivileged boot and confirmed exit;
- explicit PTY allocation, initial size, resize, input, merged output, signal, and descendant cleanup;
- writable and read-only shares with direct and symlinked host-oracle writes;
- nested directory deny, file deny, missing-component deny, and credential mask;
- overlapping writable parent/readable child shares with deny and mask still applied last;
- `net:none` without an egress-capable NIC;
- filtered egress through only the configured proxy, including direct IP, metadata, alternate DNS, and unset proxy variables;
- pipe and PTY disconnect/cancellation cleanup;
- private PID namespace and `/tmp` for sequential and concurrent runs;
- policy, artifact, protocol, and canonical mount-plan identity changes preventing stale reuse;
- separate agents never sharing mounts or VM identity.

### Linux guest resource events

Resource tests drain `violations` before awaiting exit so stream backpressure cannot hide an event.

- a small memory limit plus a tmpfs-backed allocation must increase `memory.events`; the process must exit unsuccessfully and emit `memory/oom` or `memory/oom-kill` for the same run ID;
- a small process limit plus bounded fork pressure must increase `pids.events max`; the run must emit `process-limit/pids-max` and then be terminated without leaving descendants;
- event payloads must remain enum-bounded and must not contain argv, environment values, or credential bytes.

### Windows Hyper-V

- hvsock exec over the owner-only named pipe;
- 9p writable and read-only mounts;
- drive-letter conversion and paths containing spaces;
- nested deny and mask overlays over 9p shares;
- filtered networking through the VM-specific hvsock service;
- multiple shares receive distinct bounded ports;
- teardown removes the Hyper-V VM, named pipes, 9p servers, network bridge, bundle, and helper processes.

## Boot Failure Injection

Boot rollback is tested in a separate process so global launcher configuration cannot contaminate other cases. Each run uses a unique bundle key. The fault harness fails one acquired stage at a time after the resource starts: mount service, proxy, bridge, and VMM readiness. After the launcher rejects, a platform oracle searches only for resources carrying that unique key.

On Unix the oracle inspects owned process arguments and bundle/socket paths. On Windows it additionally queries the unique Hyper-V VM ID/name and named-pipe/helper ownership. A generic `pgrep` or process-name-only assertion is forbidden because parallel test runs may legitimately own another VM.

## CI and Release Semantics

A new real-VM workflow supports `workflow_dispatch` and nightly execution. Jobs use only capability-specific self-hosted labels. Each job:

1. checks out the exact commit;
2. installs the pinned Bun and repository dependencies;
3. runs platform preflight;
4. verifies or downloads the consented CoreOS image into a runner-local cache;
5. runs only the sandbox VM real-integration suites with `MONAD_VM_IT=1`;
6. uploads bounded diagnostics and test output on failure;
7. always invokes cleanup and fails if uniquely owned resources remain.

The normal hosted CI continues to discover the suites as skipped and runs all unit, protocol, argv, Go, and cross-compilation tests. Documentation and status reports must use three distinct terms:

- `unit verified` for hosted unit/compile coverage;
- `real-VM passed on <driver>/<os>/<arch>` only for a completed self-hosted job;
- `not run` when no capable runner executed the suite.

Linux KVM becomes a required check only after the labeled runner exists and has completed a burn-in period. Repository configuration is an operational prerequisite and cannot be simulated by code in this branch.

## Error Handling and Diagnostics

- Opt-in plus failed preflight is red, never skipped.
- Every run and VM has a bounded deadline; timeout diagnostics include driver tails and owned-resource state.
- Cleanup runs after setup failure, assertion failure, and timeout.
- Diagnostic artifacts omit environment values, command arguments containing test sentinels, real credential bytes, and unbounded guest output.
- A cleanup failure is a test failure even when the containment assertion passed.

## Documentation Reconciliation

The P0 and P1 design documents are updated to record that Windows support arrived from main and was preserved through protocol v3 and canonical mount plans. Their historical out-of-scope statements are retained only as dated context or replaced with an explicit implementation-status note. The P0.5 matrix records unit, compile, and real-VM evidence independently per platform.

## Success Criteria

P0.5 is code-complete when:

- Windows is admitted by the real-VM test gate;
- all required common and platform-specific tests are implemented and discoverable;
- unit tests verify platform admission, guest path conversion, violation collection, and workflow contracts;
- Go tests and both Linux guest-agent cross-builds pass;
- the self-hosted workflow and cleanup steps are checked in;
- docs no longer claim Windows is absent;
- hosted verification stays green and reports real-VM tests as skipped;
- no response claims real KVM, vfkit, or Hyper-V success until the corresponding workflow actually completes.
