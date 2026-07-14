# Sandbox VM P2 Syscall Observation Design

## Goal

Add bounded, diagnostic write-attempt observation to the Linux guest used by `@monad/sandbox-vm`. The observer reports selected filesystem syscalls through the existing violation stream while leaving enforcement exclusively to the VM boundary, mount namespace, and canonical mount plan.

P2 applies equally to vfkit, QEMU/KVM, and Hyper-V because every backend boots the same Linux guest agent. It does not depend on a host Linux kernel.

## Scope

P2 includes:

- a minimal vendored Linux seccomp USER_NOTIF helper for amd64 and arm64;
- protocol support for canonical write-policy inputs and filesystem violations;
- guest-side path resolution and classification;
- bounded delivery through `SandboxProcess.violations` and `SandboxViolationStore`;
- unit, native, cross-build, and capable-host conformance coverage.

P2 does not:

- authorize, deny, or continue a syscall based on a userspace policy decision;
- claim complete syscall or filesystem coverage;
- observe reads, network destinations, file contents, argv, or environment values;
- make diagnostic delivery a prerequisite for enforcement;
- add a user-facing policy field.

## Reference Semantics

Anthropic Sandbox Runtime uses seccomp USER_NOTIF to observe write-intent syscalls, resolves attacker-controlled paths, intersects them with the enforced mount policy, and treats the result as best-effort telemetry rather than an enforcement input. Monad adopts that separation while moving the observer inside the guest supervisor.

Reference: <https://github.com/anthropic-experimental/sandbox-runtime/blob/cf24a43eba92c9ab4140c380d11ca55771be9db2/src/sandbox/linux-violation-monitor.ts>

## Architecture

### Observer process

The guest image contains one statically linked `monad-seccomp-observer` launch stub built from a focused C source. It performs three bounded operations:

1. installs `PR_SET_NO_NEW_PRIVS` and a classic BPF filter with `SECCOMP_FILTER_FLAG_NEW_LISTENER`;
2. passes the listener fd to the Go run supervisor over an inherited owner-only socketpair;
3. drops to the requested workload identity and `execve`s the workload.

The existing Go run supervisor owns the listener, services notifications, reads bounded path arguments from the tracee, classifies observations, and always responds with `SECCOMP_USER_NOTIF_FLAG_CONTINUE`. The C stub becomes the workload process, so it does not add another long-lived process to reap.

The helper observes only the architecture-specific syscall numbers for:

- `open`, `openat`, and `openat2` when flags express write, create, truncate, or append intent;
- `creat`, `truncate`, and `ftruncate`;
- `unlink`, `unlinkat`, `mkdir`, `mkdirat`, `rmdir`, and `mknod` variants;
- `rename`, `renameat`, and `renameat2`, reporting both source and destination;
- `link`, `linkat`, `symlink`, and `symlinkat`, reporting both relevant paths.

Unknown architectures or unavailable USER_NOTIF support fail observer initialization without running a partially configured observer.

### Protocol v4

The guest protocol moves from version 3 to 4. The start request gains a trusted host-produced observation block:

```ts
interface FilesystemObservationPolicy {
  writableRoots: string[];
  noWriteRoots: string[];
}
```

`writableRoots` comes from canonical writable mount targets. `noWriteRoots` is derived from readable mounts, deny overlays, mask targets, and protected mask stores. Arrays are sorted, deduplicated, absolute guest paths with existing protocol bounds.

The public violation contract adds `kind: 'filesystem'`. `operation` is one of the fixed observed syscall names. `target` is a bounded absolute guest path. Protocol version and observer binary digest participate in `EffectiveVmIdentity`, so a protocol-v3 VM cannot be reused.

### Classification

The Go supervisor resolves relative paths against the tracee's current working directory or `dirfd` through `/proc/<pid>`. It lexically normalizes `.` and `..` after resolution. A write attempt is reported when either condition holds:

- the normalized target is outside every `writableRoots` prefix;
- the normalized target is within a `noWriteRoots` prefix, even when an ancestor is writable.

Unresolved, non-absolute, truncated, vanished, or structurally invalid paths are dropped rather than guessed. Mount enforcement remains authoritative because path memory and process state can change between observation and kernel execution.

### Limits and redaction

Per run:

- at most 256 filesystem events are emitted;
- `target` is limited to 4096 UTF-8 bytes;
- duplicate `(operation, target)` events are coalesced with a bounded repeat count internal to diagnostics;
- malformed helper records and helper stderr use existing bounded diagnostic tails;
- no record contains command text, file bytes, environment values, credential values, or raw tracee memory.

Once the event cap is reached, the supervisor emits one fixed `runtime/violation-limit` record and continues draining notifications.

## Lifecycle and Failure Semantics

The run supervisor creates the observer socketpair before workload start and owns the listener. Cancellation, connection loss, timeout, or normal exit closes the listener and terminates and reaps the workload process group.

Observer installation failure produces one `setup/seccomp-observer` violation with an enum-bounded detail and then executes the workload under the existing mount enforcement. This preserves availability without weakening enforcement. Real-VM conformance treats observer unavailability as a failed P2 capability check so releases cannot silently claim observation support.

A stalled notification handler cannot deadlock a workload: the Go supervisor's watchdog sends `CONTINUE` for pending notifications before disabling observation for that run. If the listener itself becomes unusable, the supervisor terminates the affected workload and reports a runtime failure rather than leaving it blocked in the kernel.

## Build and Supply Chain

The C source and architecture tables live under `packages/sandbox-vm/native/seccomp-observer`. A reproducible build script emits static Linux amd64 and arm64 artifacts into the package vendor directory. Build metadata records source digest, compiler identity, and artifact digest. The observer digest joins the guest artifact identity and invalidates existing VM bundles.

No build downloads source or binaries at runtime. Checked-in binaries must be reproducible by the documented build container or toolchain.

## Testing

Unit and native tests cover:

- architecture syscall tables and write-intent flag classification;
- fd handoff and mandatory `CONTINUE` responses;
- absolute, cwd-relative, and dirfd-relative path resolution;
- writable ancestor plus no-write child precedence;
- rename and link source/destination reporting;
- event coalescing, caps, malformed input, and redaction;
- protocol-v4 parsing and v3 rejection;
- cancellation and observer reaping.

Real-VM tests run on vfkit, KVM, and Hyper-V and assert that denied write attempts emit filesystem violations while host-side oracles remain unchanged. Allowed writes must not emit filesystem violations. A path-race stress test verifies only that enforcement holds; it does not require telemetry to win the race.

## Success Criteria

- selected write-intent syscalls produce bounded filesystem diagnostics on both guest architectures;
- every notification is continued independently of classification;
- observer failure cannot weaken or deadlock existing confinement;
- protocol, helper, and VM identities invalidate stale bundles;
- real-VM status remains `not run` until a capable runner executes the new cases.
