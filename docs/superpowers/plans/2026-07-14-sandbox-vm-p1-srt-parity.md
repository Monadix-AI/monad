# Sandbox VM P1 SRT Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add guest-native PTY execution, enforceable SRT-style credential masks and nested read-deny overlays, and bounded structured violation diagnostics to the reusable macOS, Linux, and Windows VM backend.

**Architecture:** Protocol v3 carries terminal control and guest-observed violations over the existing host-to-guest vsock channel. A canonical host mount planner produces separate host and guest paths, then Ignition orders base virtio-fs or Hyper-V 9p mounts before one guest mount-policy service that installs read-only protection, deny, and mask overlays. Public launcher contracts remain Bun-free and optional so existing local and cloud launchers keep structural compatibility.

**Tech Stack:** Bun 1.3, TypeScript, Web Streams, Go 1.26, `golang.org/x/sys/unix`, `github.com/creack/pty`, Fedora CoreOS Ignition 3.4, systemd, virtio-fs, Hyper-V 9p-over-hvsock.

## Global Constraints

- Use Bun commands for TypeScript installation, tests, builds, lint, and type checking.
- Preserve the same guest protocol and per-run behavior on vfkit/macOS, QEMU/Linux, and Hyper-V/Windows.
- Keep Windows host paths on the driver side and translated Linux guest paths on the Ignition and workload side.
- PTY dimensions are integers from 1 through 1000; PTY is opt-in and pipe mode never opens `/dev/ptmx`.
- Violation events are diagnostics only, contain no environment values or argv, retain the newest 100 events, and track total count separately.
- Allow mounts precede fake-store protection, read-deny overlays, and masked-file binds; explicit read-deny wins at an identical canonical target.
- Protocol frames remain bounded to 1 MiB for control and 64 KiB for streams.
- Real VM tests remain gated by `MONAD_VM_IT=1` and must be reported as skipped when the flag is absent.
- Native Swift Virtualization.framework support, snapshots, Windows guests, and seccomp USER_NOTIF remain outside P1.

---

### Task 1: Public terminal and violation contracts

**Files:**
- Modify: `packages/sdk-atom/src/sandbox.ts`
- Modify: `packages/sdk-atom/src/index.ts`
- Modify: `packages/sandbox/src/spawn.ts`
- Modify: `packages/sandbox/src/violation-monitor.ts`
- Create: `packages/sandbox/src/violation-store.ts`
- Modify: `packages/sandbox/src/index.ts`
- Create: `packages/sandbox/test/unit/violation-store.test.ts`
- Create: `packages/sandbox/test/unit/remote-pty-spawn.test.ts`

**Interfaces:**
- Produces: `SandboxTerminalOptions`, `SandboxTerminal`, `SandboxViolation`, optional `SandboxProcess.terminal`, optional `SandboxProcess.violations`.
- Produces: `SandboxViolationStore.snapshot(): { total: number; events: SandboxViolation[] }`, `append`, `clear`, and `subscribe`.
- Consumes: existing `SandboxPtySpawnOptions.terminal.data` callback and `SandboxLauncher.spawn` seam.

- [ ] **Step 1: Write failing public-contract and bounded-store tests**

```ts
test('retains the newest 100 violations while total remains monotonic', () => {
  const store = new SandboxViolationStore(100);
  for (let i = 0; i < 105; i++) store.append(violation(`op-${i}`));
  const first = store.snapshot();
  expect(first.total).toBe(105);
  expect(first.events.map((event) => event.operation)).toEqual(
    Array.from({ length: 100 }, (_, i) => `op-${i + 5}`)
  );
  store.clear();
  expect(store.snapshot()).toEqual({ total: 105, events: [] });
});

test('remote PTY adapts terminal controls and merged output', async () => {
  const launcher = remoteLauncherReturning({ terminal: fakeTerminal, stdout: bytes('ready') });
  configureSandboxLauncher(launcher);
  const seen: string[] = [];
  const proc = sandboxedPtySpawn(['sh'], {
    terminal: { cols: 80, rows: 24, data: (_terminal, data) => seen.push(new TextDecoder().decode(data)) }
  });
  await proc.exited;
  expect(seen).toEqual(['ready']);
  proc.terminal?.resize(100, 40);
  expect(fakeTerminal.resizes).toEqual([[100, 40]]);
});
```

- [ ] **Step 2: Run the new tests and verify RED**

Run: `bun scripts/bun-test.ts packages/sandbox/test/unit/violation-store.test.ts packages/sandbox/test/unit/remote-pty-spawn.test.ts --only-failures`

Expected: FAIL because `SandboxViolationStore` is missing and remote PTY launchers are rejected.

- [ ] **Step 3: Add the Bun-free contracts and store**

```ts
export interface SandboxTerminalOptions { cols: number; rows: number }
export interface SandboxTerminal {
  write(data: Uint8Array | string): void | Promise<void>;
  close(): void | Promise<void>;
  resize(cols: number, rows: number): void | Promise<void>;
}
export interface SandboxViolation {
  kind: 'protocol' | 'setup' | 'memory' | 'process-limit' | 'runtime';
  operation: string;
  runId: string;
  timestamp: string;
  target?: string;
  pid?: number;
  detail?: string;
}
```

Make `SandboxSpawnOptions.terminal`, `SandboxProcess.terminal`, and `SandboxProcess.violations` optional. Move the Seatbelt monitor to the shared `SandboxViolation` type and stamp its events at receipt. Implement the store with defensive array/object copies and a `Set<(snapshot) => void>` subscriber list.

- [ ] **Step 4: Adapt remote PTY spawning and violation observation**

```ts
const remote = activeLauncher.spawn(argv, { ...spawnOptions, terminal: { cols, rows } }, policy);
remote.stdout?.pipeTo(new WritableStream({ write: (data) => options.terminal.data(remote.terminal!, data) }));
observeSandboxViolations(remote.violations);
return ptyProcessAdapter(remote);
```

Keep local `wrap()` launchers on Bun's native terminal path. Terminal output has no separate stderr. Process tracking and exit ownership remain unchanged.

- [ ] **Step 5: Run focused and package tests and verify GREEN**

Run: `bun scripts/bun-test.ts packages/sandbox/test/unit/violation-store.test.ts packages/sandbox/test/unit/remote-pty-spawn.test.ts packages/sandbox/test/unit/violation-monitor.test.ts --only-failures`

Expected: PASS with zero failures.

- [ ] **Step 6: Commit the public seam**

```bash
git add packages/sdk-atom/src packages/sandbox/src packages/sandbox/test/unit
git commit -m "feat(sandbox): expose terminal and violation contracts"
```

### Task 2: Protocol v3 host PTY and violation frames

**Files:**
- Modify: `packages/sandbox-vm/src/exec/protocol.ts`
- Modify: `packages/sandbox-vm/src/exec/vsock.ts`
- Modify: `packages/sandbox-vm/test/unit/vsock-protocol.test.ts`
- Modify: `packages/sandbox-vm/test/unit/vsock-process.test.ts`

**Interfaces:**
- Consumes: Task 1 `SandboxTerminalOptions`, `SandboxTerminal`, and `SandboxViolation`.
- Produces: `VSOCK_PROTOCOL_VERSION = 3`, `GuestFrameKind.Violation`, validated terminal start payload, resize control, and per-process violation stream.

- [ ] **Step 1: Write failing protocol-v3 behavior tests**

```ts
test('PTY start carries validated dimensions and resize sends a control frame', async () => {
  const frames: Array<{ kind: number; payload: unknown }> = [];
  const socketPath = await protocolServer((frame, send) => {
    frames.push({ kind: frame.kind, payload: json(frame.payload) });
    if (frame.kind === HostFrameKind.Start) send(GuestFrameKind.Started, { runId: 'pty-1', pid: 42 });
    if (frame.kind === HostFrameKind.Resize) send(GuestFrameKind.Exit, { code: 0, signal: 0 });
  });
  const proc = vsockExec(['sh'], { socketPath, runId: 'pty-1', terminal: { cols: 80, rows: 24 } });
  await proc.terminal?.resize(120, 40);
  await proc.exited;
  expect(frames[0]?.payload).toMatchObject({ version: 3, terminal: { cols: 80, rows: 24 } });
  expect(frames[1]).toEqual({ kind: HostFrameKind.Resize, payload: { cols: 120, rows: 40 } });
});

test('validated violation frames receive a host timestamp', async () => {
  const proc = vsockExec(['true'], violationServerSpec({ kind: 'memory', operation: 'oom-kill', runId: 'v-1' }));
  const events = await collect(proc.violations!);
  expect(events[0]).toMatchObject({ kind: 'memory', operation: 'oom-kill', runId: 'v-1' });
  expect(Number.isNaN(Date.parse(events[0]!.timestamp))).toBe(false);
});
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `bun scripts/bun-test.ts packages/sandbox-vm/test/unit/vsock-protocol.test.ts packages/sandbox-vm/test/unit/vsock-process.test.ts --only-failures`

Expected: FAIL because the protocol is version 2 and process handles have no terminal or violation stream.

- [ ] **Step 3: Implement protocol v3 parsing and host controls**

```ts
export const VSOCK_PROTOCOL_VERSION = 3;
export enum GuestFrameKind { Started = 16, Stdout = 17, Stderr = 18, Error = 19, Exit = 20, Unsupported = 21, Violation = 22 }

function terminalSize(cols: number, rows: number): SandboxTerminalOptions {
  if (![cols, rows].every((n) => Number.isInteger(n) && n >= 1 && n <= 1000)) {
    throw new Error('vsock protocol: terminal dimensions must be integers from 1 through 1000');
  }
  return { cols, rows };
}
```

`vsockExec` includes terminal options in `Start`, exposes `write/close/resize`, merges PTY output through stdout, schema-checks violation enums and bounded strings, stamps `new Date().toISOString()`, and closes the violation stream only after confirmed exit. `bridgeAsyncProcess` queues terminal operations alongside existing stdin operations and forwards the child violation stream.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `bun scripts/bun-test.ts packages/sandbox-vm/test/unit/vsock-protocol.test.ts packages/sandbox-vm/test/unit/vsock-process.test.ts --only-failures`

Expected: PASS with zero failures.

- [ ] **Step 5: Commit protocol v3 host support**

```bash
git add packages/sandbox-vm/src/exec packages/sandbox-vm/test/unit/vsock-protocol.test.ts packages/sandbox-vm/test/unit/vsock-process.test.ts
git commit -m "feat(sandbox-vm): add protocol v3 terminal controls"
```

### Task 3: Guest-native PTY supervisor

**Files:**
- Modify: `native/vsock-agent/go.mod`
- Modify: `native/vsock-agent/go.sum`
- Modify: `native/vsock-agent/protocol.go`
- Modify: `native/vsock-agent/main.go`
- Modify: `native/vsock-agent/supervisor_linux.go`
- Modify: `native/vsock-agent/supervisor_other.go`
- Create: `native/vsock-agent/pty_linux.go`
- Create: `native/vsock-agent/pty_other.go`
- Modify: `native/vsock-agent/main_test.go`
- Create: `native/vsock-agent/pty_linux_test.go`

**Interfaces:**
- Consumes: protocol v3 `terminal` start object and resize frame.
- Produces: `supervisorCommand(req) (*exec.Cmd, io.ReadCloser, io.WriteCloser, error)` and a supervisor control pipe carrying `resizeRequest` JSON.

- [ ] **Step 1: Add `github.com/creack/pty` and failing PTY tests**

```go
func TestPTYReportsInitialAndUpdatedWindowSize(t *testing.T) {
	req := startRequest{Version: 3, RunID: "pty-size", Argv: []string{"sh", "-c", "stty size; read x; stty size"}, Terminal: &terminalOptions{Cols: 80, Rows: 24}}
	run := startHarness(t, req)
	run.Resize(120, 40)
	run.Write("x\n")
	if got := run.Output(); !strings.Contains(got, "24 80") || !strings.Contains(got, "40 120") { t.Fatalf("output %q", got) }
}

func TestPipeRunDoesNotOpenPTY(t *testing.T) {
	req := startRequest{Version: 3, RunID: "pipe", Argv: []string{"sh", "-c", "test ! -t 0"}}
	if code := runSupervisorForTest(t, req); code != 0 { t.Fatalf("code %d", code) }
}
```

- [ ] **Step 2: Run Go tests and verify RED**

Run: `cd native/vsock-agent && go test -count=1 ./...`

Expected: FAIL because `terminalOptions`, resize forwarding, and the PTY harness do not exist.

- [ ] **Step 3: Implement the PTY path**

```go
type terminalOptions struct { Cols int `json:"cols"`; Rows int `json:"rows"` }
type resizeRequest struct { Cols int `json:"cols"`; Rows int `json:"rows"` }

func startPTY(cmd *exec.Cmd, size terminalOptions) (*os.File, error) {
	cmd.SysProcAttr.Setsid = true
	cmd.SysProcAttr.Setctty = true
	return pty.StartWithSize(cmd, &pty.Winsize{Cols: uint16(size.Cols), Rows: uint16(size.Rows)})
}
```

Add fd 5 as a newline-delimited supervisor control pipe. The broker validates resize dimensions before encoding; the supervisor applies `pty.Setsize`. In terminal mode, copy broker stdin to the master, copy the master to broker stdout, and attach no separate stderr. Terminal close closes the master and relies on the real wait result; signals still target the workload process group. Pipe mode keeps the existing three-pipe path.

- [ ] **Step 4: Run Go tests and verify GREEN**

Run: `cd native/vsock-agent && go test -count=1 ./...`

Expected: PASS with zero failures.

- [ ] **Step 5: Commit guest PTY support**

```bash
git add native/vsock-agent
git commit -m "feat(sandbox-vm): run interactive workloads in a guest PTY"
```

### Task 4: Canonical cross-platform mount planner

**Files:**
- Create: `packages/sandbox-vm/src/mount-plan.ts`
- Modify: `packages/sandbox-vm/src/index.ts`
- Modify: `packages/sandbox-vm/src/ignition.ts`
- Modify: `packages/sandbox-vm/src/driver/vfkit.ts`
- Modify: `packages/sandbox-vm/src/driver/qemu.ts`
- Modify: `packages/sandbox-vm/src/driver/hyperv.ts`
- Create: `packages/sandbox-vm/test/unit/mount-plan.test.ts`
- Modify: `packages/sandbox-vm/test/unit/policy-map.test.ts`
- Modify: `packages/sandbox-vm/test/unit/hyperv-argv.test.ts`
- Modify: `packages/sandbox-vm/test/unit/vfkit-argv.test.ts`
- Modify: `packages/sandbox-vm/test/unit/qemu-argv.test.ts`

**Interfaces:**
- Produces: `VmMountPlan { shares: SharedMount[]; overlays: MountOverlay[] }`.
- Produces: `SharedMount { tag; hostPath; guestPath; readOnly; vsockPort? }`.
- Produces ordered `MountOverlay` variants `protect-store`, `deny-directory`, `deny-file`, and `mask-file`.
- Consumes: `SandboxPolicy`, platform path translation, and Hyper-V's 32-share limit.

- [ ] **Step 1: Write failing SRT-derived and Windows mapping tests**

```ts
test('nested deny follows its writable ancestor and survives masks', async () => {
  const plan = await buildVmMountPlan({
    writableRoots: ['/work', '/tmp'],
    readDenyRoots: ['/work/.ssh'],
    maskedFiles: [{ real: '/work/token', fake: '/tmp/masks/token' }]
  }, posixHost);
  expect(plan.overlays.map((item) => item.kind)).toEqual(['protect-store', 'deny-directory', 'mask-file']);
  expect(plan.overlays.map((item) => item.target)).toEqual(['/tmp/masks', '/work/.ssh', '/work/token']);
});

test('Windows shares retain host paths while overlays use translated guest paths', async () => {
  const plan = await buildVmMountPlan({
    writableRoots: ['C:\\work'],
    readDenyRoots: ['C:\\work\\.ssh']
  }, windowsHost);
  expect(plan.shares[0]).toMatchObject({ hostPath: 'C:\\work', guestPath: '/mnt/c/work' });
  expect(plan.overlays[0]?.target).toBe('/mnt/c/work/.ssh');
});
```

Cover canonical symlinks, a 40-resolution bound, cycles, deepest-existing-ancestor handling, file ancestors, same-target deny-over-mask, fake files that are missing/non-regular/unreadable, and deterministic shallow-first ordering.

- [ ] **Step 2: Run planner tests and verify RED**

Run: `bun scripts/bun-test.ts packages/sandbox-vm/test/unit/mount-plan.test.ts packages/sandbox-vm/test/unit/policy-map.test.ts packages/sandbox-vm/test/unit/hyperv-argv.test.ts --only-failures`

Expected: FAIL because nested denies are rejected and mounts do not distinguish host and guest paths uniformly.

- [ ] **Step 3: Implement the canonical planner**

```ts
export interface SharedMount {
  tag: string;
  hostPath: string;
  guestPath: string;
  readOnly: boolean;
  vsockPort?: number;
}
export type MountOverlay =
  | { kind: 'protect-store' | 'mask-file'; source: string; target: string }
  | { kind: 'deny-directory' | 'deny-file'; target: string };
export interface VmMountPlan { shares: SharedMount[]; overlays: MountOverlay[] }
```

Inject filesystem operations and platform translation into `buildVmMountPlan` so tests do not mutate global `process.platform`. Resolve existing prefixes with `realpath`, walk missing suffixes from the deepest existing ancestor, reject cycles/type conflicts/escapes, and deduplicate equivalent shares. A deny outside every share produces no overlay because the host path is absent; a missing nested deny covers its first missing component. Add fake-store protection only when another share exposes the store's canonical path. On Windows, assign hvsock ports after fake-store shares are included and reject more than 32 total shares. Drivers consume only `hostPath`; Ignition and workload cwd/argv consume only `guestPath`.

- [ ] **Step 4: Run planner and driver tests and verify GREEN**

Run: `bun scripts/bun-test.ts packages/sandbox-vm/test/unit/mount-plan.test.ts packages/sandbox-vm/test/unit/policy-map.test.ts packages/sandbox-vm/test/unit/hyperv-argv.test.ts packages/sandbox-vm/test/unit/vfkit-argv.test.ts packages/sandbox-vm/test/unit/qemu-argv.test.ts --only-failures`

Expected: PASS with zero failures.

- [ ] **Step 5: Commit the mount planner**

```bash
git add packages/sandbox-vm/src packages/sandbox-vm/test/unit
git commit -m "feat(sandbox-vm): plan canonical cross-platform mounts"
```

### Task 5: Guest-enforced deny and mask overlays

**Files:**
- Modify: `packages/sandbox-vm/src/ignition.ts`
- Modify: `packages/sandbox-vm/test/unit/ignition.test.ts`
- Modify: `native/vsock-agent/main.go`
- Create: `native/vsock-agent/mount_policy_linux.go`
- Create: `native/vsock-agent/mount_policy_other.go`
- Create: `native/vsock-agent/mount_policy_linux_test.go`

**Interfaces:**
- Consumes: Task 4 ordered `MountOverlay[]` and base mount unit names.
- Produces: `/etc/monad/mount-policy.json` and `monad-mount-policy.service` ordered after all base shares and before firewall/broker startup.
- Produces: guest mode `mount-policy --config <path>`.

- [ ] **Step 1: Write failing Ignition ordering and mount-operation tests**

```ts
test('overlay policy runs after every base mount and before firewall', () => {
  const config = buildIgnition(specWithWindowsShareAndOverlays());
  const unit = config.systemd.units.find((item) => item.name === 'monad-mount-policy.service')!;
  expect(unit.contents).toContain('After=monad-9p-w0.service monad-9p-mask0.service');
  expect(unit.contents).toContain('Before=monad-firewall.service');
  expect(unit.contents).toContain('ExecStart=/usr/local/bin/monad-vsock-agent mount-policy');
});
```

```go
func TestApplyMountPolicyPreservesOrder(t *testing.T) {
	var calls []mountCall
	policy := mountPolicy{Overlays: []mountOverlay{
		{Kind: "protect-store", Source: "/run/monad/masks/0", Target: "/tmp/masks"},
		{Kind: "deny-directory", Target: "/work/.ssh"},
		{Kind: "mask-file", Source: "/run/monad/masks/0/token", Target: "/work/token"},
	}}
	if err := applyMountPolicy(policy, recordingMounter(&calls)); err != nil { t.Fatal(err) }
	if got := kinds(calls); !reflect.DeepEqual(got, []string{"bind-ro", "tmpfs-ro", "bind-ro"}) { t.Fatal(got) }
}
```

- [ ] **Step 2: Run Ignition and Go tests and verify RED**

Run: `bun scripts/bun-test.ts packages/sandbox-vm/test/unit/ignition.test.ts --only-failures && (cd native/vsock-agent && go test -count=1 ./...)`

Expected: FAIL because no mount-policy service or guest mode exists.

- [ ] **Step 3: Implement fail-closed guest overlays**

```go
func bindReadOnly(source, target string) error {
	if err := unix.Mount(source, target, "", unix.MS_BIND, ""); err != nil { return err }
	return unix.Mount("", target, "", unix.MS_BIND|unix.MS_REMOUNT|unix.MS_RDONLY|unix.MS_NOSUID|unix.MS_NODEV, "")
}

func denyDirectory(target string) error {
	if err := os.MkdirAll(target, 0o000); err != nil { return err }
	return unix.Mount("tmpfs", target, "tmpfs", unix.MS_RDONLY|unix.MS_NOSUID|unix.MS_NODEV|unix.MS_NOEXEC, "size=4k,mode=000")
}
```

For file denies, create one root-owned empty file under `/run/monad/empty`, ensure the target exists, and bind it read-only. Reject unknown kinds, relative paths, non-absolute sources, and any mount syscall failure. Ignition marks the overlay service `RequiredBy=monad-firewall.service`; the broker cannot start under a partial policy.

- [ ] **Step 4: Run Ignition and Go tests and verify GREEN**

Run: `bun scripts/bun-test.ts packages/sandbox-vm/test/unit/ignition.test.ts --only-failures && (cd native/vsock-agent && go test -count=1 ./...)`

Expected: PASS with zero failures.

- [ ] **Step 5: Commit guest overlay enforcement**

```bash
git add packages/sandbox-vm/src/ignition.ts packages/sandbox-vm/test/unit/ignition.test.ts native/vsock-agent
git commit -m "feat(sandbox-vm): enforce guest deny and mask overlays"
```

### Task 6: Guest violation events and host storage integration

**Files:**
- Modify: `native/vsock-agent/cgroup.go`
- Modify: `native/vsock-agent/cgroup_linux.go`
- Modify: `native/vsock-agent/cgroup_other.go`
- Modify: `native/vsock-agent/protocol.go`
- Modify: `native/vsock-agent/main.go`
- Modify: `native/vsock-agent/supervisor_linux.go`
- Modify: `native/vsock-agent/cgroup_test.go`
- Modify: `native/vsock-agent/main_test.go`
- Modify: `packages/sandbox-vm/src/exec/vsock.ts`
- Modify: `packages/sandbox-vm/test/unit/vsock-process.test.ts`
- Modify: `packages/sandbox/src/spawn.ts`
- Modify: `packages/sandbox/test/unit/violation-store.test.ts`

**Interfaces:**
- Produces wire event `{ kind, operation, runId, target?, pid?, detail? }` without a guest timestamp.
- Produces supervisor-result pipe records `{ type: 'violation'; event }` followed by exactly one `{ type: 'exit'; exit }`; the broker forwards violations and resolves the run only from the exit record.
- Produces cgroup snapshots and positive deltas for `memory.events` `oom`/`oom_kill` and `pids.events` `max`.
- Consumes Task 1 global store and Task 2 per-process validated stream.

- [ ] **Step 1: Write failing cgroup-delta, protocol rejection, and draining tests**

```go
func TestCgroupEventDeltas(t *testing.T) {
	before := cgroupEvents{OOM: 1, OOMKill: 2, PidsMax: 3}
	after := cgroupEvents{OOM: 2, OOMKill: 4, PidsMax: 5}
	got := violationDeltas("run-1", before, after)
	if !reflect.DeepEqual(operations(got), []string{"oom", "oom-kill", "pids-max"}) { t.Fatal(got) }
}
```

```ts
test('spawn seam drains VM violations without delaying exit', async () => {
  configureSandboxLauncher(remoteLauncherWithViolations([wireViolation('oom-kill')]));
  const proc = sandboxedSpawn(['true'], undefined);
  expect(await proc.exited).toBe(0);
  await violationsDrained();
  expect(sandboxViolationSnapshot().events.at(-1)?.operation).toBe('oom-kill');
});
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `(cd native/vsock-agent && go test -count=1 ./...) && bun scripts/bun-test.ts packages/sandbox-vm/test/unit/vsock-process.test.ts packages/sandbox/test/unit/violation-store.test.ts --only-failures`

Expected: FAIL because cgroup deltas and VM stream draining are absent.

- [ ] **Step 3: Emit bounded guest events**

Capture cgroup counters immediately after cgroup creation and immediately after descendant reaping but before cgroup removal. Replace the supervisor result pipe's single JSON object with newline-delimited discriminated records so setup/runtime/cgroup violations reach the broker before the one terminal exit record. Emit fixed operations only: `oom`, `oom-kill`, `pids-max`, `namespace-init`, `cgroup-init`, `pty-init`, `mount-init`, `runtime-exit`, and `unsupported-operation`. Bound `detail` and `target` to 4096 UTF-8 bytes and never include argv or environment data. Supervisor setup failures return their existing error and one matching violation frame when the connection is still writable.

- [ ] **Step 4: Drain host events without affecting process completion**

```ts
export function observeSandboxViolations(stream?: ReadableStream<SandboxViolation>): void {
  if (!stream) return;
  void (async () => {
    for await (const event of stream) sandboxViolationStore.append(event);
  })().catch(() => {});
}
```

Malformed guest frames remain fatal to the run and invalidate the VM through `onUnresponsive`. A consumer/store failure does not alter enforcement or exit status.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run: `(cd native/vsock-agent && go test -count=1 ./...) && bun scripts/bun-test.ts packages/sandbox-vm/test/unit/vsock-process.test.ts packages/sandbox/test/unit/violation-store.test.ts --only-failures`

Expected: PASS with zero failures.

- [ ] **Step 6: Commit violation diagnostics**

```bash
git add native/vsock-agent packages/sandbox-vm/src/exec packages/sandbox-vm/test/unit/vsock-process.test.ts packages/sandbox/src packages/sandbox/test/unit/violation-store.test.ts
git commit -m "feat(sandbox-vm): report bounded guest violations"
```

### Task 7: Identity, vendored agents, and cross-platform conformance

**Files:**
- Modify: `packages/sandbox-vm/src/pool.ts`
- Modify: `packages/sandbox-vm/src/index.ts`
- Modify: `packages/sandbox-vm/test/unit/pool.test.ts`
- Modify: `packages/sandbox-vm/test/unit/vm-launcher.test.ts`
- Modify: `packages/sandbox-vm/test/integration/vm-conformance.it.test.ts`
- Modify: `packages/sandbox-vm/vendor/vsock-agent-amd64`
- Modify: `packages/sandbox-vm/vendor/vsock-agent-arm64`

**Interfaces:**
- Consumes: protocol version 3, canonical mount plan, updated guest agent digest, and `SandboxSpawnOptions.terminal`.
- Produces: VM identity with `mountPlanSchemaVersion: 1`, `mountPlanDigest`, and terminal-aware spawn.

- [ ] **Step 1: Write failing identity and gated conformance cases**

```ts
test('mount-plan schema participates in VM identity', () => {
  expect(policyFingerprint(identity({}, { mountPlanSchemaVersion: 1 }))).not.toBe(
    policyFingerprint(identity({}, { mountPlanSchemaVersion: 2 }))
  );
});

test('canonical mount-plan changes cannot reuse a stale VM', () => {
  expect(policyFingerprint(identity({}, { mountPlanDigest: 'a' }))).not.toBe(
    policyFingerprint(identity({}, { mountPlanDigest: 'b' }))
  );
});
```

Add gated host-oracle cases that assert `test -t 0`, PTY echo and resize, masked sentinel visibility without real credential bytes, nested deny under both writable and readable shares, deny survival after parent mounts, OOM/PID events, and descendant cleanup. Parameterize host path expectations so Windows host paths map to `/mnt/<drive>` guest targets.

- [ ] **Step 2: Run identity and discovery tests and verify RED**

Run: `bun scripts/bun-test.ts packages/sandbox-vm/test/unit/pool.test.ts packages/sandbox-vm/test/unit/vm-launcher.test.ts packages/sandbox-vm/test/integration/vm-conformance.it.test.ts --only-failures`

Expected: identity test FAIL; real-VM cases report SKIP without `MONAD_VM_IT=1`.

- [ ] **Step 3: Wire identity, terminal spawn, and atomic guest builds**

```ts
const identity = effectiveVmIdentity(policy, {
  agentDigest: agent.digest,
  baseImageDigest: image.digest,
  cpus: shape.cpus,
  ignitionSchemaVersion: IGNITION_SCHEMA_VERSION,
  memoryMiB: shape.memoryMiB,
  mountPlanDigest: fingerprintMountPlan(plan),
  mountPlanSchemaVersion: 1,
  protocolVersion: VSOCK_PROTOCOL_VERSION,
  runIsolation: DEFAULT_RUN_LIMITS,
  vsockPort: VSOCK_EXEC_PORT
});
```

Build the canonical mount plan before identity/boot, pass terminal options into `vsockExec`, and preserve `translateArgvPaths`/`toGuestPath` for Windows. Run `bash scripts/build-vsock-agent.sh`; it must run Go tests before atomically replacing both vendored architectures.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `bun scripts/bun-test.ts packages/sandbox-vm/test/unit packages/sandbox-vm/test/integration/vm-conformance.it.test.ts --only-failures`

Expected: all unit tests PASS; real-VM cases explicitly SKIP without `MONAD_VM_IT=1`.

- [ ] **Step 5: Run package quality gates**

Run: `cd native/vsock-agent && go test -count=1 ./...`

Expected: PASS.

Run: `bun run --cwd packages/sandbox-vm typecheck && bun run --cwd packages/sandbox-vm lint`

Expected: PASS, or report only independently reproduced repository-baseline failures with exact paths.

Run: `bun run --cwd packages/sandbox typecheck && bun run --cwd packages/sandbox lint`

Expected: PASS, or report only independently reproduced repository-baseline failures with exact paths.

Run: `git diff --check`

Expected: no output and exit code 0.

- [ ] **Step 6: Commit P1 rollout and vendored agents**

```bash
git add packages/sandbox-vm packages/sandbox native/vsock-agent scripts/build-vsock-agent.sh bun.lock
git commit -m "feat(sandbox-vm): complete P1 SRT parity"
```

- [ ] **Step 7: Run final fresh verification**

Run: `bun scripts/bun-test.ts packages/sandbox-vm/test packages/sandbox/test/unit --only-failures && (cd native/vsock-agent && go test -count=1 ./...)`

Expected: zero failures; real-VM tests explicitly skipped unless `MONAD_VM_IT=1` is set.

Run: `git status --short`

Expected: empty output.
