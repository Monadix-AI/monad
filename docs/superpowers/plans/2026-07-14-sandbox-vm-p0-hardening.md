# Sandbox VM P0 Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `@monad/sandbox-vm` real guest-process cancellation, transactional lifecycle cleanup, complete policy identity, and per-run namespace/cgroup isolation.

**Architecture:** A bounded protocol-v2 codec is shared conceptually by the TypeScript host and Go guest. The guest broker launches an internal PID-1 supervisor for each run, while the host VM runtime owns a transaction of VMM and sidecar resources and invalidates unhealthy pool entries. VM reuse keys include all containment-relevant policy and artifact digests.

**Tech Stack:** Bun/TypeScript, Bun test, Go 1.24, Linux AF_VSOCK, PID/mount namespaces, cgroup v2, Fedora CoreOS, vfkit, QEMU, gvproxy.

## Global Constraints

- Runtime commands use Bun; Go is used only for `native/vsock-agent` and its tests/build script.
- No new environment variables. Backend settings are declared through the sandbox launcher descriptor and persisted in `config.json`.
- `@monad/sdk-atom` stays daemon-independent and Bun-independent.
- Invalid protocol, namespace, cgroup, or boot state fails closed before workload execution.
- The reusable VM root disk persists by agent; PID namespace, cgroup, process group, and `/tmp` are per run.
- PTY allocation is outside P0. Protocol resize is typed and returns unsupported for a non-PTY run.
- Each production behavior is preceded by a failing test and a verified RED run.
- Real-VM claims require `MONAD_VM_IT=1`; unit tests must not be presented as real-VM proof.

---

## File structure

- Create `packages/sandbox-vm/src/exec/protocol.ts`: protocol constants, frame codec, control schemas, signal normalization, and frame-size enforcement.
- Modify `packages/sandbox-vm/src/exec/vsock.ts`: protocol-v2 socket client and `SandboxProcess` bridge.
- Create `packages/sandbox-vm/test/unit/vsock-protocol.test.ts`: codec and malformed-frame behavior.
- Create `packages/sandbox-vm/test/unit/vsock-process.test.ts`: stdin, signal, disconnect, structured exit, and cancellation escalation behavior with a real local socket double.
- Modify `packages/sdk-atom/src/sandbox.ts`: typed stdin, exit metadata, limits, and launcher process invalidation contract.
- Modify `native/vsock-agent/main.go`: broker, protocol-v2 dispatcher, active-run ownership, and internal supervisor mode.
- Create `native/vsock-agent/protocol.go`: bounded frame read/write and wire types.
- Create `native/vsock-agent/supervisor_linux.go`: PID/mount namespace supervisor, private tmpfs, process group, signal forwarding, and descendant reaping.
- Create `native/vsock-agent/cgroup_linux.go`: cgroup-v2 run lifecycle and bounds.
- Create `native/vsock-agent/main_test.go`: protocol, process cancellation, disconnect, cgroup-path validation, and supervisor behavior.
- Modify `scripts/build-vsock-agent.sh`: run guest tests before replacing vendored binaries and use temporary outputs plus atomic rename.
- Create `packages/sandbox-vm/src/runtime/diagnostic-tail.ts`: bounded byte tail for sidecar output.
- Create `packages/sandbox-vm/src/runtime/boot-transaction.ts`: reverse-order idempotent rollback.
- Modify `packages/sandbox-vm/src/driver/vfkit.ts`: owned diagnostic drains and exit observation.
- Modify `packages/sandbox-vm/src/driver/qemu.ts`: one handle owns QEMU, virtiofsd, and socat lifecycle.
- Modify `packages/sandbox-vm/src/net/gvproxy.ts`: diagnostic drain and idempotent stop.
- Modify `packages/sandbox-vm/src/pool.ts`: explicit invalidation and race-safe teardown.
- Modify `packages/sandbox-vm/src/index.ts`: transactional boot, runtime health observation, artifact-aware identity, and new settings.
- Extend existing unit tests under `packages/sandbox-vm/test/unit/` for transaction, driver ownership, pool invalidation, and identity.
- Extend `packages/sandbox-vm/test/integration/vm-conformance.it.test.ts` with cancellation, descendant, per-run PID/tmp, limit, and policy-reuse tests.

---

### Task 1: Protocol-v2 codec and public process contract

**Files:**
- Create: `packages/sandbox-vm/src/exec/protocol.ts`
- Create: `packages/sandbox-vm/test/unit/vsock-protocol.test.ts`
- Modify: `packages/sdk-atom/src/sandbox.ts`

**Interfaces:**
- Produces: `VSOCK_PROTOCOL_VERSION`, `MAX_CONTROL_FRAME_BYTES`, `MAX_STREAM_FRAME_BYTES`, `encodeFrame()`, `FrameDecoder`, `normalizeSignal()`.
- Produces: `SandboxStdin`, `SandboxExit`, `SandboxRunLimits`, and optional `SandboxProcess.exit`.
- Consumes: no runtime modules outside `@monad/sdk-atom` and Node/Bun byte primitives.

- [ ] **Step 1: Write failing codec and contract tests**

```ts
test('decoder rejects an oversized control frame before allocating its body', () => {
  const decoder = new FrameDecoder();
  const header = Buffer.alloc(5);
  header[0] = HostFrameKind.Start;
  header.writeUInt32BE(MAX_CONTROL_FRAME_BYTES + 1, 1);
  expect(() => decoder.push(header)).toThrow('control frame exceeds');
});

test('signal normalization accepts TERM and rejects arbitrary strings', () => {
  expect(normalizeSignal('SIGTERM')).toBe(15);
  expect(normalizeSignal('TERM')).toBe(15);
  expect(() => normalizeSignal('DELETE_EVERYTHING')).toThrow('unsupported signal');
});
```

- [ ] **Step 2: Verify RED**

Run: `bun scripts/bun-test.ts packages/sandbox-vm/test/unit/vsock-protocol.test.ts --only-failures`

Expected: FAIL because `exec/protocol.ts` and its exports do not exist.

- [ ] **Step 3: Implement the bounded codec and SDK types**

```ts
export const VSOCK_PROTOCOL_VERSION = 2;
export const MAX_CONTROL_FRAME_BYTES = 1024 * 1024;
export const MAX_STREAM_FRAME_BYTES = 64 * 1024;

export enum HostFrameKind {
  Start = 1,
  Stdin = 2,
  CloseStdin = 3,
  Signal = 4,
  Resize = 5
}

export enum GuestFrameKind {
  Started = 16,
  Stdout = 17,
  Stderr = 18,
  Error = 19,
  Exit = 20,
  Unsupported = 21
}
```

`FrameDecoder.push()` must validate the kind-specific limit from the header before concatenating or allocating the body. `normalizeSignal()` maps the supported POSIX signal names and validates numeric values from 1 through 64.

Add these Bun-free SDK shapes:

```ts
export interface SandboxStdin {
  write(data: Uint8Array | string): void | Promise<void>;
  end(): void | Promise<void>;
}

export interface SandboxExit {
  code: number | null;
  signal: number | null;
}

export interface SandboxRunLimits {
  memoryMiB?: number;
  maxProcesses?: number;
  terminateGraceMs?: number;
}

// Added to SandboxSpawnOptions:
limits?: SandboxRunLimits;

// Added to SandboxProcess:
readonly stdin?: SandboxStdin;
readonly exit?: Promise<SandboxExit>;
```

- [ ] **Step 4: Verify GREEN**

Run: `bun scripts/bun-test.ts packages/sandbox-vm/test/unit/vsock-protocol.test.ts --only-failures && bun run --cwd packages/sandbox-vm typecheck`

Expected: protocol tests PASS and typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add packages/sandbox-vm/src/exec/protocol.ts packages/sandbox-vm/test/unit/vsock-protocol.test.ts packages/sdk-atom/src/sandbox.ts
git commit -m "feat(sandbox-vm): define bounded exec protocol"
```

### Task 2: Guest protocol broker and real process cancellation

**Files:**
- Create: `native/vsock-agent/protocol.go`
- Modify: `native/vsock-agent/main.go`
- Create: `native/vsock-agent/main_test.go`

**Interfaces:**
- Consumes: Task 1 frame numbers and JSON field names exactly.
- Produces: `serveConnection(io.ReadWriteCloser, *runRegistry)`, `runRegistry.cancelAll()`, and structured started/error/exit frames.

- [ ] **Step 1: Write failing Go protocol and disconnect tests**

```go
func TestReadFrameRejectsOversizedControlBeforeBodyRead(t *testing.T) {
    header := []byte{frameStart, 0x00, 0x10, 0x00, 0x01}
    _, err := readFrame(bytes.NewReader(header))
    if err == nil || !strings.Contains(err.Error(), "exceeds") { t.Fatalf("got %v", err) }
}

func TestDisconnectTerminatesRunningProcessGroup(t *testing.T) {
    proc := startTestRun(t, []string{"sh", "-c", "sleep 60 & wait"})
    proc.disconnect()
    proc.expectExitWithin(3 * time.Second)
    proc.expectNoDescendants()
}
```

- [ ] **Step 2: Verify RED**

Run: `cd native/vsock-agent && go test ./...`

Expected: FAIL because protocol-v2 and run-registry APIs do not exist.

- [ ] **Step 3: Implement broker ownership and cancellation**

`serveConnection` must require `start` as the first frame, reject a duplicate active run ID, start one run, and then concurrently read host control frames while writing guest output frames through a serialized writer. On EOF it invokes the same termination sequence as an explicit signal.

Each run owns an `exec.Cmd` process group. Cancellation sends `SIGTERM` to `-pid`, waits for the configured grace, then sends `SIGKILL`. `cancelAll()` performs this for every run during agent shutdown. A signalled command reports `{code:null, signal:<n>}` rather than casting a negative exit code to `uint32`.

- [ ] **Step 4: Verify GREEN**

Run: `cd native/vsock-agent && go test ./...`

Expected: all Go tests PASS.

- [ ] **Step 5: Commit**

```bash
git add native/vsock-agent/protocol.go native/vsock-agent/main.go native/vsock-agent/main_test.go
git commit -m "fix(sandbox-vm): cancel guest workloads on disconnect"
```

### Task 3: Per-run PID, mount, tmpfs, and cgroup isolation

**Files:**
- Create: `native/vsock-agent/supervisor_linux.go`
- Create: `native/vsock-agent/cgroup_linux.go`
- Modify: `native/vsock-agent/main.go`
- Modify: `native/vsock-agent/main_test.go`

**Interfaces:**
- Consumes: validated start request and `SandboxRunLimits` fields from Task 1.
- Produces: internal `--supervise-run` mode, `runCgroup`, private `/tmp`, descendant reaping, and workload exit metadata.

- [ ] **Step 1: Write failing namespace and cgroup tests**

```go
func TestSupervisorReapsDescendantsAndUsesPrivateTmp(t *testing.T) {
    first := runSupervisorTest(t, "echo secret >/tmp/only-this-run; sleep 60 & echo $!")
    first.cancel()
    second := runSupervisorTest(t, "test ! -e /tmp/only-this-run")
    second.expectCode(0)
    first.expectNoDescendants()
}

func TestCgroupWritesLimitsBeforeAttachingRun(t *testing.T) {
    fs := newFakeCgroupFS(t)
    group := createRunCgroup(fs.root, "run-safe", runLimits{MemoryMiB: 128, MaxProcesses: 32})
    expectFile(t, group.path+"/memory.max", "134217728")
    expectFile(t, group.path+"/pids.max", "32")
}
```

- [ ] **Step 2: Verify RED**

Run: `cd native/vsock-agent && go test ./...`

Expected: FAIL because supervisor and cgroup files do not exist.

- [ ] **Step 3: Implement internal PID-1 supervisor and cgroup lifecycle**

The broker launches its own executable with `CLONE_NEWPID | CLONE_NEWNS` into an internal mode. The internal supervisor mounts a private tmpfs at `/tmp`, starts the target in its own process group as `monad`, forwards control signals, waits for the workload, and reaps all children before returning structured exit metadata over dedicated inherited pipes.

The broker discovers its cgroup-v2 service path from `/proc/self/cgroup`, creates only validated `run-<safe-id>` child names, writes `memory.max` and `pids.max`, attaches the supervisor PID through `cgroup.procs`, and removes the empty group after exit. Any setup error terminates the supervisor and returns a start error without running the target.

- [ ] **Step 4: Verify GREEN**

Run: `cd native/vsock-agent && go test ./...`

Expected: all Go tests PASS, including tests that skip only when the host kernel forbids namespace creation.

- [ ] **Step 5: Commit**

```bash
git add native/vsock-agent/supervisor_linux.go native/vsock-agent/cgroup_linux.go native/vsock-agent/main.go native/vsock-agent/main_test.go
git commit -m "feat(sandbox-vm): isolate every guest run"
```

### Task 4: Host process adapter with stdin, signals, and confirmed exit

**Files:**
- Modify: `packages/sandbox-vm/src/exec/vsock.ts`
- Create: `packages/sandbox-vm/test/unit/vsock-process.test.ts`

**Interfaces:**
- Consumes: Task 1 codec and SDK process contract.
- Produces: `vsockExec()` that reports started PID, writable stdin, real signal exit, protocol errors, and cancellation timeout through `onUnresponsive`.

- [ ] **Step 1: Write failing socket-double behavior tests**

```ts
test('kill sends a signal frame and waits for the guest exit frame', async () => {
  const server = await protocolServer(async (peer) => {
    expect(await peer.readKind()).toBe(HostFrameKind.Start);
    peer.started({ runId: 'run-1', pid: 42 });
    expect(await peer.readJson()).toMatchObject({ signal: 15 });
    peer.exit({ code: null, signal: 15 });
  });
  const proc = vsockExec(['sleep', '60'], server.spec);
  proc.kill('SIGTERM');
  expect(await proc.exit).toEqual({ code: null, signal: 15 });
});

test('stdin writes are chunked to the protocol stream limit', async () => {
  const proc = connectToRecordingPeer();
  await proc.stdin?.write(new Uint8Array(MAX_STREAM_FRAME_BYTES + 1));
  expect(recordedStdinFrameSizes()).toEqual([MAX_STREAM_FRAME_BYTES, 1]);
});
```

- [ ] **Step 2: Verify RED**

Run: `bun scripts/bun-test.ts packages/sandbox-vm/test/unit/vsock-process.test.ts --only-failures`

Expected: FAIL because the current adapter destroys the socket and exposes no stdin or exit metadata.

- [ ] **Step 3: Implement protocol-v2 process adapter**

Use the codec for every inbound and outbound frame. Resolve `exited` only from a terminal guest exit frame. On socket loss before confirmation, reject with a transport error and invoke the supplied VM invalidation callback. `kill()` sends a signal and arms a grace timer; expiry invokes invalidation rather than pretending the run exited.

- [ ] **Step 4: Verify GREEN**

Run: `bun scripts/bun-test.ts packages/sandbox-vm/test/unit/vsock-protocol.test.ts packages/sandbox-vm/test/unit/vsock-process.test.ts --only-failures && bun run --cwd packages/sandbox-vm typecheck`

Expected: all targeted tests PASS and typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add packages/sandbox-vm/src/exec/vsock.ts packages/sandbox-vm/test/unit/vsock-process.test.ts
git commit -m "feat(sandbox-vm): supervise guest process lifecycle"
```

### Task 5: Complete effective VM identity

**Files:**
- Modify: `packages/sandbox-vm/src/pool.ts`
- Modify: `packages/sandbox-vm/src/index.ts`
- Modify: `packages/sandbox-vm/test/unit/pool.test.ts`
- Modify: `packages/sandbox-vm/test/unit/policy-map.test.ts`

**Interfaces:**
- Produces: `effectiveVmIdentity()`, `policyFingerprint(identity)`, explicit artifact digests and schema versions.
- Consumes: agent binary SHA-256, resolved image SHA-256, protocol version, normalized policy, and run-isolation settings.

- [ ] **Step 1: Write failing identity-dimension tests**

```ts
test.each([
  ['readDenyRoots', { readDenyRoots: ['/secret-a'] }, { readDenyRoots: ['/secret-b'] }],
  ['maskedFiles', { maskedFiles: [{ real: '/a', fake: '/x' }] }, { maskedFiles: [{ real: '/a', fake: '/y' }] }]
])('%s changes the VM fingerprint', (_name, a, b) => {
  expect(policyFingerprint(identity(a))).not.toBe(policyFingerprint(identity(b)));
});

test('agent and image digests change the VM fingerprint', () => {
  expect(policyFingerprint(identity({}, { agentDigest: 'a' }))).not.toBe(
    policyFingerprint(identity({}, { agentDigest: 'b' }))
  );
});
```

- [ ] **Step 2: Verify RED**

Run: `bun scripts/bun-test.ts packages/sandbox-vm/test/unit/pool.test.ts packages/sandbox-vm/test/unit/policy-map.test.ts --only-failures`

Expected: FAIL because the current fingerprint ignores these dimensions.

- [ ] **Step 3: Implement canonical effective identity**

Canonicalize sorted path lists and sorted `{real,fake}` mappings, preserving undefined versus empty values. Include protocol and ignition schema constants, base-image digest, vendored agent digest, network endpoint, and run-isolation settings. Hash the canonical JSON rather than delimiter-joining fields.

- [ ] **Step 4: Verify GREEN**

Run: `bun scripts/bun-test.ts packages/sandbox-vm/test/unit/pool.test.ts packages/sandbox-vm/test/unit/policy-map.test.ts --only-failures`

Expected: all targeted tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/sandbox-vm/src/pool.ts packages/sandbox-vm/src/index.ts packages/sandbox-vm/test/unit/pool.test.ts packages/sandbox-vm/test/unit/policy-map.test.ts
git commit -m "fix(sandbox-vm): bind reuse to complete policy identity"
```

### Task 6: Transactional boot, diagnostic drains, and runtime invalidation

**Files:**
- Create: `packages/sandbox-vm/src/runtime/boot-transaction.ts`
- Create: `packages/sandbox-vm/src/runtime/diagnostic-tail.ts`
- Create: `packages/sandbox-vm/test/unit/boot-transaction.test.ts`
- Create: `packages/sandbox-vm/test/unit/diagnostic-tail.test.ts`
- Modify: `packages/sandbox-vm/src/driver/vfkit.ts`
- Modify: `packages/sandbox-vm/src/driver/qemu.ts`
- Modify: `packages/sandbox-vm/src/net/gvproxy.ts`
- Modify: `packages/sandbox-vm/src/pool.ts`
- Modify: `packages/sandbox-vm/src/index.ts`
- Modify: driver, network, pool, and launcher unit tests.

**Interfaces:**
- Produces: `BootTransaction.defer(cleanup)`, `commit()`, `rollback(cause)`, `DiagnosticTail`, `VmPool.invalidate(key)`, and a driver handle that owns every sidecar.
- Consumes: Task 5 VM key and Task 4 unresponsive-run invalidation callback.

- [ ] **Step 1: Write failing rollback, tail, and invalidation tests**

```ts
test('rollback releases acquired resources in reverse order and remains idempotent', async () => {
  const calls: string[] = [];
  const tx = new BootTransaction();
  tx.defer(async () => void calls.push('bundle'));
  tx.defer(async () => void calls.push('gvproxy'));
  await tx.rollback(new Error('readiness failed'));
  await tx.rollback(new Error('again'));
  expect(calls).toEqual(['gvproxy', 'bundle']);
});

test('unexpected VM exit invalidates an idle or running pool entry', async () => {
  const pool = makePool();
  await pool.acquire('key', 'agent', 'a', boot);
  await pool.invalidate('key');
  expect(pool.has('key')).toBe(false);
});
```

- [ ] **Step 2: Verify RED**

Run: `bun scripts/bun-test.ts packages/sandbox-vm/test/unit/boot-transaction.test.ts packages/sandbox-vm/test/unit/diagnostic-tail.test.ts packages/sandbox-vm/test/unit/pool.test.ts --only-failures`

Expected: FAIL because transaction, tail, and invalidation APIs do not exist.

- [ ] **Step 3: Implement ownership and health transitions**

Every spawned helper is immediately registered with the transaction. Driver `stop()` kills children and awaits their exits exactly once. Diagnostic pipes are drained continuously into fixed-size byte tails. After readiness and commit, VMM/gvproxy exit observers call `pool.invalidate(key)` unless teardown is already in progress. `vsockExec` timeout or transport failure uses the same invalidation path.

- [ ] **Step 4: Verify GREEN**

Run: `bun scripts/bun-test.ts packages/sandbox-vm/test/unit --only-failures && bun run --cwd packages/sandbox-vm typecheck`

Expected: all sandbox-vm unit tests PASS and typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add packages/sandbox-vm/src packages/sandbox-vm/test/unit
git commit -m "fix(sandbox-vm): make VM lifecycle transactional"
```

### Task 7: Build reproducibility and real-VM conformance

**Files:**
- Modify: `scripts/build-vsock-agent.sh`
- Modify: `packages/sandbox-vm/vendor/vsock-agent-amd64`
- Modify: `packages/sandbox-vm/vendor/vsock-agent-arm64`
- Modify: `packages/sandbox-vm/test/integration/vm-conformance.it.test.ts`

**Interfaces:**
- Consumes: all previous task behavior.
- Produces: tested vendored binaries and adversarial real-VM coverage.

- [ ] **Step 1: Add failing conformance cases and safe build assertions**

Add host-oracle cases for a cancelled process and descendant, PID isolation between concurrent runs, private `/tmp`, process limit, and policy identity non-reuse. Extend the build script test or shell assertions so a Go test failure leaves existing vendored binaries unchanged.

- [ ] **Step 2: Verify RED where locally possible**

Run: `cd native/vsock-agent && go test ./... && bun scripts/bun-test.ts packages/sandbox-vm/test/integration/vm-conformance.it.test.ts --only-failures`

Expected: Go tests PASS; integration cases are reported skipped without `MONAD_VM_IT=1`, proving they are discovered but not falsely executed.

- [ ] **Step 3: Build both vendored binaries atomically**

Run: `scripts/build-vsock-agent.sh`

Expected: Go tests run first, both architectures build to temporary files, hashes are printed, and the final binaries are atomically replaced only after both builds succeed.

- [ ] **Step 4: Run changed-path quality gate**

Run all commands, collecting every failure before repair:

```bash
bun scripts/bun-test.ts packages/sandbox-vm/test/unit --only-failures
bun run --cwd packages/sandbox-vm typecheck
bun run --cwd packages/sandbox-vm lint
cd native/vsock-agent && go test ./...
```

Expected: every command exits 0.

- [ ] **Step 5: Commit**

```bash
git add scripts/build-vsock-agent.sh packages/sandbox-vm/vendor packages/sandbox-vm/test/integration/vm-conformance.it.test.ts
git commit -m "test(sandbox-vm): verify hardened guest runtime"
```

### Task 8: Final requirements and regression verification

**Files:**
- Review all files changed by Tasks 1–7.
- Update the design/plan only if implementation truth required a documented correction.

**Interfaces:**
- Consumes: complete implementation.
- Produces: evidence-backed handoff with exact live versus skipped verification.

- [ ] **Step 1: Re-read the design and map every P0 invariant to code and tests**

Record the exact test name for real cancellation, rollback, policy identity, per-run process isolation, private tmp, and cgroup ceilings. Any missing mapping returns to RED before proceeding.

- [ ] **Step 2: Run the final changed-path gate fresh**

```bash
bun scripts/bun-test.ts packages/sandbox-vm/test/unit --only-failures
bun run --cwd packages/sandbox-vm typecheck
bun run --cwd packages/sandbox-vm lint
(cd native/vsock-agent && go test ./...)
git diff --check
git status --short
```

Expected: tests, typecheck, lint, Go tests, and diff check exit 0; status contains only intentional implementation files.

- [ ] **Step 3: Inspect the diff for security and lifecycle regressions**

Confirm no unbounded allocation from wire lengths, no synthetic successful exit on socket loss, no cleanup path that can run twice unsafely, no policy dimension omitted from identity, no root workload execution, and no undrained helper pipe.

- [ ] **Step 4: Commit any verification-driven corrections**

If corrections were required, repeat their focused RED/GREEN cycle and commit them with a scoped conventional message. If none were required, do not create an empty commit.
