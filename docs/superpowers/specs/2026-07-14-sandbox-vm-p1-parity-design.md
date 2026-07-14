# Sandbox VM P1 Parity Design

## Implementation Status

This document preserves the P1 scope decision made before Windows support landed on `main`. The merged Hyper-V driver now consumes protocol v3, the canonical mount plan, PTY execution, deny and mask overlays, and bounded violation contracts. Windows is covered by the P0.5 conformance suites, with real-hypervisor evidence reported independently from unit and compile evidence.

## Goal

Extend `@monad/sandbox-vm` with interactive PTY execution, enforceable credential-file masking and nested read-deny overlays, and bounded structured violation diagnostics. The design follows the security semantics of Anthropic Sandbox Runtime at commit `cf24a43eba92c9ab4140c380d11ca55771be9db2` while preserving Monad's reusable-VM and per-run guest-supervisor architecture.

P1 builds directly on the protocol, process cancellation, cgroup, mount-namespace, VM identity, and transactional lifecycle work delivered by P0.

## Scope

P1 contains three connected capabilities:

1. Explicit PTY allocation with input, resize, signals, confirmed exit, and the same per-run isolation as pipe execution.
2. SRT-style read-only fake-file binds and deny-after-allow filesystem overlay precedence inside the guest.
3. A structured, bounded violation stream for events the VM backend can determine reliably.

The following remain outside P1:

- macOS Virtualization.framework integration without vfkit;
- VM suspend, resume, and snapshots;
- Windows VM support was outside the original P1 change and subsequently landed from `main`;
- guest-distribution selection;
- syscall-attempt observation through seccomp USER_NOTIF, audit, fanotify, or eBPF;
- interactive policy approval or dynamic domain approval.

## SRT Reference Semantics

The design adopts these behaviors from SRT rather than only matching feature names:

- PTY access is explicit. A pipe run does not implicitly receive terminal devices or terminal semantics.
- A masked credential file is represented by a fake file containing sentinels. The fake store is read-only, and the fake file is bind-mounted over the real path.
- Allow mounts are established before read-deny and credential-mask overlays. Later mounts must never re-expose a denied or masked target.
- Deny paths are canonicalized through symlinks and ordered shallow-first. File, directory, missing-component, and conflicting-path cases are handled deliberately.
- Violation events are diagnostic telemetry, not an enforcement input. They are retained in a bounded in-memory tail with a separate total count.
- Event payloads and errors must not expose credentials, environment contents, fake-file contents, or unbounded command data.

Monad differs where the stronger VM boundary makes a direct port inappropriate. SRT's Linux violation monitor uses seccomp USER_NOTIF to observe attacker-controlled write-intent syscall arguments. P1 does not claim that coverage. It reports only protocol, setup, cgroup, and runtime events backed by a definitive guest observation.

## Considered Approaches

### Host-side terminal emulation

The host could run a pseudo-terminal and forward its byte stream through the existing pipe protocol. That would not give the workload a controlling terminal inside its PID and mount namespace, so terminal detection, job control, signals, and window-size ioctls would be incorrect.

### Guest-native protocol v3

The selected approach extends the host and guest protocol together. The per-run supervisor creates and owns the PTY, while the broker continues to own socket framing and cancellation. Filesystem overlays are represented in the VM boot plan and installed before the broker accepts workloads.

### Full SRT syscall observation

Porting SRT's seccomp USER_NOTIF observer would add write-attempt telemetry, but it requires a security-sensitive filter, listener-fd handoff, cross-process path reads, syscall-specific argument decoding, and kernel compatibility handling. Those events are best-effort even in SRT and do not strengthen enforcement. They are deferred to a separately reviewed change.

## Protocol v3

The host and guest move together from protocol version 2 to 3. Existing VM bundles cannot be reused because the protocol version and guest-agent digest already participate in `EffectiveVmIdentity`.

The start request gains an optional terminal object:

```ts
interface SandboxTerminalOptions {
  cols: number;
  rows: number;
}

interface StartRequest {
  version: 3;
  runId: string;
  argv: string[];
  cwd?: string;
  env: Record<string, string>;
  limits: SandboxRunLimits;
  terminal?: SandboxTerminalOptions;
}
```

The existing resize frame becomes active and carries `{cols, rows}`. Both dimensions must be integers from 1 through 1000. Resize on a pipe run returns an `unsupported` frame without terminating a valid run. A malformed resize frame fails the run closed.

The guest adds a `violation` frame with a bounded JSON payload. Unknown frame kinds, invalid JSON, invalid enum values, and payloads exceeding the control-frame limit remain protocol errors.

Pipe mode keeps separate stdout and stderr frames. PTY mode merges the slave's stdout and stderr and emits the master stream as stdout frames, matching terminal behavior. Terminal EOF never synthesizes success; only the supervisor result produces the terminal exit frame.

## Public Process Contracts

`@monad/sdk-atom` owns Bun-free contracts shared by local, VM, and cloud launchers:

```ts
interface SandboxTerminalOptions {
  cols: number;
  rows: number;
}

interface SandboxTerminal {
  write(data: Uint8Array | string): void | Promise<void>;
  close(): void | Promise<void>;
  resize(cols: number, rows: number): void | Promise<void>;
}

interface SandboxViolation {
  kind: 'protocol' | 'setup' | 'memory' | 'process-limit' | 'runtime';
  operation: string;
  runId: string;
  timestamp: string;
  target?: string;
  pid?: number;
  detail?: string;
}
```

`SandboxSpawnOptions` gains optional `terminal`. `SandboxProcess` gains optional `terminal` and optional `violations: ReadableStream<SandboxViolation>`. Both process fields are optional so existing local and cloud launchers remain structurally compatible; the VM launcher supplies both for a terminal run and supplies the violation stream for every run.

For a remote launcher, `sandboxedPtySpawn()` calls `launcher.spawn()` with terminal options instead of rejecting the launcher. It adapts the returned terminal and stdout stream onto the existing `SandboxPtyProcess` shape consumed by `process_start`. Pipe spawning is unchanged.

The adapter does not expose PTY stderr because a real terminal has one combined byte stream. It preserves the existing process tracker, supervision, timeout, abort, signal, and shutdown ownership paths.

## Guest PTY Supervisor

The supervisor creates a PTY only when the start request contains terminal options. It uses the pinned `github.com/creack/pty` Linux implementation to open a master/slave pair and apply window sizes, while retaining explicit `SysProcAttr` ownership for the new session, controlling terminal, and process group. The workload's stdin, stdout, and stderr attach to the slave.

The supervisor retains the master and performs these operations:

- broker stdin frames write to the master;
- terminal close closes the PTY master, causing normal terminal hangup semantics; PTYs have no reliable half-close equivalent to pipe EOF;
- resize applies `TIOCSWINSZ` to the master;
- signals continue to target the workload process group;
- PTY output is pumped through the same 64 KiB stream frames;
- workload exit kills and reaps descendants before reporting structured exit metadata.

After terminal close, no additional output delivery is promised, but the supervisor retains the process handle, completes descendant cleanup, and reports only the real wait result. Further writes and resizes are idempotent no-ops at the public seam. PTY setup runs after cgroup and mount-namespace setup but before workload start. Any failure returns a setup error and no workload is executed. Pipe runs retain the P0 stdin/stdout/stderr path and never open `/dev/ptmx`.

## Canonical Mount Plan

P1 replaces the implicit same-path mount list with a canonical plan whose virtiofs entries distinguish host source from guest target:

```ts
interface VirtiofsMount {
  tag: string;
  hostPath: string;
  guestPath: string;
  readOnly: boolean;
}

interface BindOverlay {
  source: string;
  target: string;
  readOnly: true;
  after: string[];
}

interface TmpfsOverlay {
  target: string;
  after: string[];
}
```

Normal writable and readable roots remain same-path virtiofs mounts. Each unique fake-store directory is mounted read-only at a deterministic `/run/monad/masks/<index>` target. Each fake file is then read-only bind-mounted from that staging target onto its canonical real path.

The fake store may live under the host temporary directory, which is also an ordinary writable root. To prevent the workload from modifying a fake file through that alternate same-path mount, the plan first bind-mounts the read-only staging directory back over the fake store's canonical guest path. This matches SRT's explicit read-only re-bind of the fake store even when an allow-write rule covers its parent.

Read-deny paths outside every host-backed root are already absent and need no overlay. A nested directory deny gets an empty, read-only tmpfs overlay. A nested file deny gets a read-only bind of a guest-created empty file. A missing deny path covers the first missing component so the workload cannot create the path after startup.

The host canonicalizes policy paths before producing the plan:

- every path must be absolute;
- existing paths resolve through `realpath`;
- missing suffixes are joined to the deepest canonical existing ancestor;
- symlink chains are bounded at 40 resolutions;
- cycles, file ancestors that make the target impossible, type conflicts, and attempts to escape the declared mount boundary fail closed;
- mask sources must exist, be regular readable files, and reside in a fake-store directory rather than a user-writable policy root.

Overlay ordering is part of the plan, not incidental systemd behavior:

1. writable/readable virtiofs roots;
2. read-only fake-store protection binds;
3. read-deny overlays, shallowest target first;
4. masked-file binds whose target is not explicitly denied;
5. firewall and guest broker startup.

Ignition emits explicit unit dependencies for this order. Any later change that introduces another guest mount must prove it cannot re-expose a deny or mask.

## Violation Diagnostics

The guest emits only events it can establish without attacker-controlled inference:

- invalid or unsupported protocol operations;
- namespace, cgroup, PTY, mount, or overlay initialization failure;
- cgroup `memory.events` showing `oom` or `oom_kill` growth;
- cgroup `pids.events` showing `max` growth;
- abnormal supervisor/runtime termination without a normal workload exit.

The guest uses fixed `kind` and `operation` enums. `detail` is bounded, produced by trusted code, and stripped of environment values and command arguments. Paths are included only when they are policy targets already known to the host. Wire events carry no authoritative wall-clock value; the host stamps the public ISO timestamp when a validated frame arrives, matching SRT's host-side event timestamping.

The host parses every violation frame before exposing it. Each VM process receives a readable violation stream. The existing `@monad/sandbox` spawn seam observes that optional stream without delaying stdout, stderr, or exit handling and drains it into one module-level `SandboxViolationStore` modeled on SRT. The module exports snapshot and subscription operations rather than exposing mutable storage:

- retain the newest 100 events;
- track a monotonic total count separately;
- return defensive copies;
- support subscribe/unsubscribe;
- clear retained events without resetting the total count.

Observation is fail-open with respect to diagnostics and fail-closed with respect to malformed protocol. Failure to derive a cgroup event does not weaken cgroup enforcement. A malformed guest event invalidates the run and VM because it indicates protocol incompatibility or corruption.

## Error Handling

- PTY dimensions outside 1 through 1000 fail before workload spawn.
- PTY creation, controlling-terminal assignment, and initial resize failures return structured setup errors.
- Resize on a completed process is idempotent at the public seam; no new guest work is created.
- A mask source that is missing, unreadable, non-regular, or ambiguously canonicalized fails VM boot. Monad does not silently skip an already-materialized mandatory `maskedFiles` policy.
- Overlay mount failure prevents the broker from starting, so no workload can run with partial policy.
- Deny/mask conflicts use the strongest result. Explicit read-deny wins over ordinary allow mounts and suppresses a mask bind for the same canonical target, leaving the path unreadable rather than risking exposure through ordering.
- Violation payloads are schema-validated, size-bounded, and secret-free.
- Existing P0 transport-loss, cancellation escalation, active-run registry, transactional boot rollback, and runtime invalidation rules remain in force.

## Testing

TypeScript unit tests cover:

- protocol-v3 terminal start and resize encoding;
- terminal dimension validation;
- remote `sandboxedPtySpawn()` adaptation;
- PTY stdout delivery and confirmed exit;
- pipe resize returning unsupported;
- violation schema rejection and bounded store behavior;
- canonical path resolution, symlink chains, cycles, missing components, and file ancestors;
- SRT-derived ordering regressions: allow followed by deny, deny surviving an ancestor remount, file deny under allowed parent, and mask remaining last;
- Ignition unit dependencies and driver use of separate host/guest mount paths.

Go tests cover:

- PTY echo and combined output;
- initial and updated `TIOCGWINSZ` dimensions;
- signal delivery, disconnect cancellation, and descendant reaping in PTY mode;
- pipe mode never opening a PTY;
- malformed resize and protocol rejection;
- cgroup memory and PID event deltas mapped to bounded violations.

The gated real-VM suite adds host-oracle cases for:

- an interactive shell that detects a TTY;
- input and resize across the vsock bridge;
- fake credential content visible at the real path while the real credential bytes never appear;
- nested read-deny under a mounted root;
- parent remounts not re-exposing denied or masked paths;
- OOM and PID ceilings producing structured events;
- pipe and PTY cancellation leaving no descendants.

Real-VM tests continue to require `MONAD_VM_IT=1`. Discovery without that flag must report the tests as skipped, and unit results must not be described as real-VM proof.

## Compatibility and Rollout

Protocol v3 is an intentional lockstep upgrade. The package rebuilds both vendored Linux agent architectures atomically after Go tests pass. VM identity includes the protocol version, guest-agent digest, policy paths, mask mappings, and the new mount-plan schema version, so old bundles are not reused.

PTY is opt-in and leaves existing pipe callers unchanged. Filesystem behavior becomes stricter only where the VM backend previously rejected nested read-deny or recorded masked files in identity without enforcing them. No durable user-data migration is required because VM bundles are disposable cache state.
