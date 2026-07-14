# Sandbox VM P2 Syscall Observation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Report bounded filesystem write-attempt diagnostics from every sandbox VM guest without moving enforcement out of the mount boundary.

**Architecture:** Upgrade the host/guest wire contract to protocol v4 and send one canonical observation policy with each run. A Linux C launch stub installs a passive seccomp USER_NOTIF filter and writes raw observations to the existing Go run supervisor, which classifies, bounds, and forwards them through the current violation stream.

**Tech Stack:** Bun test, TypeScript, Go 1.26, Linux seccomp USER_NOTIF, classic BPF, C11, Fedora CoreOS Ignition, Docker-based reproducible native builds.

## Global Constraints

- Follow strict RED-GREEN-REFACTOR; no production behavior is added before its focused test fails for the expected reason.
- The observer always replies with `SECCOMP_USER_NOTIF_FLAG_CONTINUE`; mount namespaces and read-only overlays remain the only filesystem enforcement input.
- The public event cap is 256 per run and all event text fields remain at most 4096 UTF-8 bytes.
- Unknown or unresolved paths are dropped rather than classified.
- Observer setup failure emits bounded setup telemetry and preserves existing mount confinement.
- No argv, environment value, file content, credential value, or raw tracee memory enters a violation.
- Use Bun for TypeScript commands and `scripts/bun-test.ts` for targeted tests.
- Never claim real-VM success unless a capable vfkit, KVM, or Hyper-V runner executes the opt-in suite.

---

### Task 1: Protocol-v4 observation contract

**Files:**
- Modify: `packages/sdk-atom/src/sandbox.ts`
- Modify: `packages/sandbox-vm/src/exec/protocol.ts`
- Modify: `packages/sandbox-vm/src/exec/vsock.ts`
- Modify: `packages/sandbox-vm/test/unit/vsock-protocol.test.ts`
- Modify: `packages/sandbox-vm/test/unit/vsock-process.test.ts`

**Interfaces:**
- Produces: `SandboxViolation['kind']` including `'filesystem'`.
- Produces: `FilesystemObservationPolicy { writableRoots: string[]; noWriteRoots: string[] }`.
- Produces: `VsockExecSpec.observation?: FilesystemObservationPolicy` and protocol version `4`.

- [ ] Write failing tests asserting protocol version 4, start-frame observation serialization, accepted `filesystem/openat`, and rejection of unknown operations and targets over 4096 UTF-8 bytes.
- [ ] Run `bun scripts/bun-test.ts packages/sandbox-vm/test/unit/vsock-protocol.test.ts packages/sandbox-vm/test/unit/vsock-process.test.ts --only-failures`; expect version `3`, missing observation, and rejected filesystem events.
- [ ] Add the public kind and observation type, set `VSOCK_PROTOCOL_VERSION = 4`, serialize the optional policy, and extend the fixed violation operation set without changing frame numbers or bounds.
- [ ] Run the focused tests plus `bun run --cwd packages/sandbox-vm typecheck` and `bun run --cwd packages/sdk-atom typecheck`; expect all green.
- [ ] Commit as `feat(sandbox-vm): define protocol v4 observation`.

### Task 2: Canonical guest observation policy

**Files:**
- Create: `packages/sandbox-vm/src/observation-policy.ts`
- Create: `packages/sandbox-vm/test/unit/observation-policy.test.ts`
- Modify: `packages/sandbox-vm/src/index.ts`
- Modify: `packages/sandbox-vm/test/unit/vm-launcher.test.ts`

**Interfaces:**
- Consumes: `VmMountPlan`.
- Produces: `observationPolicyFor(plan: VmMountPlan): FilesystemObservationPolicy`.

- [ ] Write failing tests for sorted/deduplicated writable shares, readable shares in `noWriteRoots`, overlay targets in `noWriteRoots`, Windows guest paths, and writable-parent/read-only-child precedence.
- [ ] Run `bun scripts/bun-test.ts packages/sandbox-vm/test/unit/observation-policy.test.ts --only-failures`; expect an import failure.
- [ ] Derive writable roots from writable shares and no-write roots from read-only shares plus every overlay target. Normalize guest POSIX paths, sort shallow-first, and preserve more-specific no-write entries.
- [ ] Pass the derived policy from the exact `VmMountPlan` used for boot and identity into every `vsockExec` call.
- [ ] Run observation-policy and VM-launcher tests plus package typecheck; commit as `feat(sandbox-vm): derive guest observation policy`.

### Task 3: Guest classification and event bounds

**Files:**
- Create: `packages/sandbox-vm/native/vsock-agent/observation.go`
- Create: `packages/sandbox-vm/native/vsock-agent/observation_test.go`
- Modify: `packages/sandbox-vm/native/vsock-agent/protocol.go`
- Modify: `packages/sandbox-vm/native/vsock-agent/main.go`

**Interfaces:**
- Consumes: protocol JSON `observation { writableRoots, noWriteRoots }`.
- Produces: `classifyObservedPath(policy observationPolicy, operation, path string) *violationMessage`.
- Produces: `observationLimiter` with 256-event and 4096-byte bounds.

- [ ] Write failing Go tests for path normalization, prefix component boundaries, no-write precedence, allowed-write suppression, relative path suppression, UTF-8 limits, duplicate coalescing, and one-time limit telemetry.
- [ ] Run `cd packages/sandbox-vm/native/vsock-agent && go test -count=1 ./...`; expect undefined observation symbols.
- [ ] Implement absolute `path.Clean` classification and a limiter that admits 256 unique records, suppresses duplicates, and emits one fixed `runtime/violation-limit` record.
- [ ] Add protocol-v4 observation structs and validate at most 256 roots per list, each absolute and at most 4096 UTF-8 bytes, before workload start.
- [ ] Re-run Go tests and commit as `feat(sandbox-vm): classify guest write attempts`.

### Task 4: Passive seccomp observer launch stub

**Files:**
- Create: `packages/sandbox-vm/native/seccomp-observer/observer.c`
- Create: `packages/sandbox-vm/native/seccomp-observer/observer_test.c`
- Create: `packages/sandbox-vm/native/seccomp-observer/build.sh`
- Create: `packages/sandbox-vm/native/seccomp-observer/NOTICE`
- Create: `.github/workflows/sandbox-vm-native.yml`

**Interfaces:**
- Produces: `/usr/local/bin/monad-seccomp-observer --event-fd 3 -- <argv...>`.
- Produces: newline-delimited `{syscall,pid,path}` records.
- Produces: static Linux `seccomp-observer-amd64` and `seccomp-observer-arm64` artifacts.

- [ ] Write a failing C contract test: an `openat(O_WRONLY|O_CREAT)` produces one record and still succeeds, read-only `openat` produces none, and a closed event fd cannot block the child.
- [ ] Run `docker run --rm --platform linux/amd64 -v "$PWD:/src" -w /src/packages/sandbox-vm/native/seccomp-observer gcc:15-bookworm ./build.sh --test-only`; expect compile failure because the observer is absent.
- [ ] Implement an architecture-checked BPF USER_NOTIF filter. The parent polls notifications and child exit, reads at most 4096 tracee bytes, resolves cwd/dirfd paths through `/proc/<pid>`, writes bounded JSON, always sends `CONTINUE`, forwards signals, and relays exit status.
- [ ] Make `build.sh` use temporary output, run native tests, strip, hash, and atomically install artifacts. Build amd64 and arm64 in matching Linux containers. Add a workflow that rebuilds on matching runners and compares checked-in digests.
- [ ] Commit source, NOTICE, workflow, and both artifacts as `feat(sandbox-vm): add passive seccomp observer`.

### Task 5: Guest supervisor integration

**Files:**
- Modify: `packages/sandbox-vm/native/vsock-agent/supervisor_linux.go`
- Create: `packages/sandbox-vm/native/vsock-agent/observation_linux.go`
- Create: `packages/sandbox-vm/native/vsock-agent/observation_linux_test.go`
- Create: `packages/sandbox-vm/native/vsock-agent/observation_other.go`

**Interfaces:**
- Consumes: `/usr/local/bin/monad-seccomp-observer` and newline raw records.
- Produces: existing `supervisorRecord{Type:"violation"}` values.

- [ ] Write failing tests using a fake observer that emits allowed, denied, duplicate, malformed, and oversized records. Assert setup failure telemetry and descendant cleanup.
- [ ] Run `cd packages/sandbox-vm/native/vsock-agent && go test -count=1 ./...`; expect missing wrapper and drain symbols.
- [ ] Wrap pipe and PTY commands while retaining cwd, env, credentials, process group, cgroup, namespace, terminal, and signal behavior. Pass an owner-only event pipe as fd 3 and drain it concurrently.
- [ ] If the helper is absent or reports unsupported USER_NOTIF, emit one `setup/seccomp-observer` violation and execute the original command. After listener installation, a broken helper fails the run instead of leaving a blocked syscall.
- [ ] Run `go test -race -count=1 ./...` and commit as `feat(sandbox-vm): stream filesystem observations`.

### Task 6: Ignition and artifact identity

**Files:**
- Modify: `packages/sandbox-vm/src/ignition.ts`
- Modify: `packages/sandbox-vm/src/index.ts`
- Modify: `packages/sandbox-vm/src/pool.ts`
- Modify: `packages/sandbox-vm/test/unit/ignition.test.ts`
- Modify: `packages/sandbox-vm/test/unit/pool.test.ts`
- Modify: `packages/sandbox-vm/native/vsock-agent/build.sh`
- Modify: `packages/sandbox-vm/vendor/vsock-agent-amd64`
- Modify: `packages/sandbox-vm/vendor/vsock-agent-arm64`

**Interfaces:**
- Produces: `IgnitionSpec.observerBinaryB64` installed at `/usr/local/bin/monad-seccomp-observer`.
- Produces: `EffectiveVmArtifacts.observerDigest`.

- [ ] Write failing tests that Ignition installs the observer executable and changing only `observerDigest` changes the VM fingerprint.
- [ ] Run Ignition and pool tests; expect missing observer field/file/identity dimension.
- [ ] Load the arch-specific observer once, digest it, inject it into Ignition, and include its digest in `effectiveVmIdentity`; keep bytes and paths out of diagnostics.
- [ ] Run `packages/sandbox-vm/native/vsock-agent/build.sh` to test and atomically rebuild both guest agents.
- [ ] Run focused tests and typecheck; commit as `feat(sandbox-vm): bind observer into VM identity`.

### Task 7: Real-VM conformance and final verification

**Files:**
- Create: `packages/sandbox-vm/test/e2e/vm-syscall-observation.test.ts`
- Modify: `docs/sandbox-vm-conformance.md`
- Modify: `.github/workflows/sandbox-vm-real.yml`

**Interfaces:**
- Consumes: common real-VM fixture and filesystem violation stream.
- Produces: capable-runner host-oracle coverage for P2.

- [ ] Add gated cases for denied `openat`, rename destination, nested no-write target, allowed writable-root suppression, and cancellation under rapid attempts. Drain violations concurrently and keep host files as enforcement oracles.
- [ ] Run the new suite without `MONAD_VM_IT`; expect cases discovered and skipped.
- [ ] Document observer coverage while retaining `not run` evidence states. Ensure the existing real workflow includes the suite through `test:e2e`.
- [ ] Run the complete sandbox-vm/sandbox Bun gate, relevant typechecks and lints, `go test -race`, and Linux amd64/arm64 Go cross-compiles.
- [ ] Run `git diff --check main...HEAD` and verify a clean status after committing as `test(sandbox-vm): cover syscall observations in real VMs`.
