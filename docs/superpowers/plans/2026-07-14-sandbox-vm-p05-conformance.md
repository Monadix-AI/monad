# Sandbox VM P0.5 Real-VM Conformance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make vfkit, QEMU/KVM, and Hyper-V real-VM confinement tests discoverable, platform-correct, runnable on capability-labeled self-hosted CI, and honest about which hypervisor actually passed.

**Architecture:** Extract a platform-neutral real-VM fixture and an explicit admission function, then keep common guest behavior, resource violations, and Windows-only Hyper-V behavior in focused suites. Add a preflight smoke and a dedicated self-hosted workflow; hosted CI continues to discover the suites as skipped.

**Tech Stack:** Bun test, TypeScript, Fedora CoreOS, vfkit, QEMU/KVM, Hyper-V, hvsock, 9p, GitHub Actions, PowerShell.

**Execution note:** Critical review expanded Task 6 with a separate failed-boot rollback smoke and unique-resource audit. The workflow now runs that smoke after each platform preflight and before the conformance suite.

## Global Constraints

- Use Bun for TypeScript commands and `scripts/bun-test.ts` for test execution.
- `MONAD_VM_IT=1` is the only real-VM opt-in; with opt-in, missing capability is failure rather than skip.
- Test commands execute inside a Linux guest; translate and shell-quote host paths before embedding them.
- Containment claims use host-side oracles; guest output alone is not proof of host protection.
- Keep Windows Hyper-V/9p behavior from main intact.
- Never claim real-VM success unless the corresponding capable runner completed the suite.
- Do not add new product environment variables or user-facing sandbox policy fields.

---

### Task 1: Real-VM admission contract

**Files:**
- Create: `packages/sandbox-vm/test/e2e/vm-admission.ts`
- Create: `packages/sandbox-vm/test/unit/vm-admission.test.ts`
- Modify: `packages/sandbox-vm/package.json`

**Interfaces:**
- Produces: `realVmAdmission(envValue: string | undefined, platform: NodeJS.Platform): 'run' | 'skip'`.
- Produces: package-local `test:e2e` and `test:e2e:loud` scripts.

- [ ] **Step 1: Write the failing admission tests**

```ts
import { expect, test } from 'bun:test';
import { realVmAdmission } from '../e2e/vm-admission.ts';

test.each(['darwin', 'linux', 'win32'] as NodeJS.Platform[])('MONAD_VM_IT=1 admits %s', (platform) => {
  expect(realVmAdmission('1', platform)).toBe('run');
});

test('an absent opt-in skips discovery on every platform', () => {
  expect(realVmAdmission(undefined, 'win32')).toBe('skip');
  expect(realVmAdmission('0', 'linux')).toBe('skip');
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `bun scripts/bun-test.ts packages/sandbox-vm/test/unit/vm-admission.test.ts --only-failures`

Expected: import failure because `vm-admission.ts` does not exist.

- [ ] **Step 3: Implement the admission function and package scripts**

```ts
export function realVmAdmission(
  envValue: string | undefined,
  platform: NodeJS.Platform = process.platform
): 'run' | 'skip' {
  if (envValue !== '1') return 'skip';
  if (platform === 'darwin' || platform === 'linux' || platform === 'win32') return 'run';
  throw new Error(`sandbox-vm real integration is unsupported on ${platform}`);
}
```

Add scripts using `test/e2e/` to `packages/sandbox-vm/package.json`.

- [ ] **Step 4: Verify GREEN**

Run: `bun scripts/bun-test.ts packages/sandbox-vm/test/unit/vm-admission.test.ts --only-failures && bun run --cwd packages/sandbox-vm typecheck`

Expected: all admission tests pass and TypeScript reports no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/sandbox-vm/package.json packages/sandbox-vm/test/e2e/vm-admission.ts packages/sandbox-vm/test/unit/vm-admission.test.ts
git commit -m "test(sandbox-vm): admit Windows real-VM conformance"
```

### Task 2: Shared real-VM fixture and Windows-safe guest paths

**Files:**
- Create: `packages/sandbox-vm/test/e2e/vm-fixture.ts`
- Create: `packages/sandbox-vm/test/unit/vm-fixture.test.ts`
- Move: `packages/sandbox-vm/test/integration/vm-conformance.it.test.ts` to `packages/sandbox-vm/test/e2e/vm-conformance.test.ts`

**Interfaces:**
- Produces: `guestPath(path, platform?)`, `shellQuote(value)`, `guestArg(path, platform?)`.
- Produces: `spawnVm`, `runVm`, `runSh`, `drainBytes`, `drainViolations`, `prepareRealVm`, `disposeRealVm`.

- [ ] **Step 1: Write failing path and quote tests**

```ts
test('guestArg translates a Windows path with spaces and quotes it once', () => {
  expect(guestArg('C:\\Users\\First Last\\work', 'win32')).toBe("'/mnt/c/Users/First Last/work'");
});

test('shellQuote preserves apostrophes without permitting shell expansion', () => {
  expect(shellQuote("/tmp/a'b $HOME")).toBe("'/tmp/a'\\''b $HOME'");
});
```

- [ ] **Step 2: Verify RED**

Run: `bun scripts/bun-test.ts packages/sandbox-vm/test/unit/vm-fixture.test.ts --only-failures`

Expected: missing fixture module.

- [ ] **Step 3: Implement the fixture and move the suite**

Use `toGuestPath` as the sole Windows mapping implementation. `drainViolations` reads until stream close and returns defensive event values. `prepareRealVm` configures image consent, checks that the image cache directory exists, and calls `vmLauncher.prepare`; with admission `run`, every thrown preflight error remains a test failure.

- [ ] **Step 4: Replace every interpolated host path**

Convert scripts such as:

```ts
`cat ${hostPath}`
```

to:

```ts
`cat ${guestArg(hostPath)}`
```

Keep host-side `Bun.file(hostPath)` and `existsSync(hostPath)` assertions unchanged.

- [ ] **Step 5: Verify GREEN and skip discovery**

Run: `bun scripts/bun-test.ts packages/sandbox-vm/test/unit/vm-fixture.test.ts packages/sandbox-vm/test/e2e/vm-conformance.test.ts --only-failures`

Expected on an ordinary host: fixture unit tests pass; real-VM cases are discovered and skipped.

- [ ] **Step 6: Commit**

```bash
git add packages/sandbox-vm/test packages/sandbox-vm/package.json
git commit -m "test(sandbox-vm): share cross-platform VM fixtures"
```

### Task 3: Missing common host-oracle cases

**Files:**
- Modify: `packages/sandbox-vm/test/e2e/vm-conformance.test.ts`

**Interfaces:**
- Consumes: `spawnVm`, `runSh`, `guestArg`, `drainBytes`.
- Produces: common vfkit/QEMU/Hyper-V coverage for PTY cancellation, overlapping shares, and concurrent isolation.

- [ ] **Step 1: Add the gated tests before changing fixture behavior**

Add cases that:

1. start a PTY workload whose descendant writes a host marker after two seconds, send `SIGTERM`, and prove the marker never appears;
2. mount a writable parent plus readable child, deny and mask targets below the child, and prove real bytes remain absent;
3. run two commands concurrently in one agent VM, write a secret in run A's `/tmp`, and prove run B cannot read it while both are alive.

- [ ] **Step 2: Verify discovery**

Run: `bun scripts/bun-test.ts packages/sandbox-vm/test/e2e/vm-conformance.test.ts --only-failures`

Expected without opt-in: every new case is reported as skipped and the file has no setup errors.

- [ ] **Step 3: Implement only fixture support required by the tests**

Keep process output and exit promises consumed concurrently. Use bounded polling for host readiness markers and always terminate surviving processes in `finally`.

- [ ] **Step 4: Verify unit and discovery coverage**

Run: `bun scripts/bun-test.ts packages/sandbox-vm/test/unit packages/sandbox-vm/test/e2e/vm-conformance.test.ts --only-failures`

- [ ] **Step 5: Commit**

```bash
git add packages/sandbox-vm/test/e2e/vm-conformance.test.ts packages/sandbox-vm/test/e2e/vm-fixture.ts
git commit -m "test(sandbox-vm): extend host-oracle confinement cases"
```

### Task 4: Real cgroup violation tests

**Files:**
- Create: `packages/sandbox-vm/test/e2e/vm-resource-violations.test.ts`
- Modify: `packages/sandbox-vm/test/e2e/vm-fixture.ts`

**Interfaces:**
- Consumes: `spawnVm`, `drainBytes`, `drainViolations`.
- Produces: real `memory/oom|oom-kill` and `process-limit/pids-max` assertions.

- [ ] **Step 1: Write the gated OOM test**

Spawn a shell with `memoryMiB: 32` that writes more than 128 MiB into its private tmpfs, drain stdout and violations concurrently, and assert unsuccessful exit plus a same-run memory event. Assert serialized events omit a sentinel placed in argv and env.

- [ ] **Step 2: Write the gated PID-limit test**

Spawn bounded fork pressure with `maxProcesses: 4`, ensure the workload terminates, and assert a same-run `process-limit/pids-max` event. Use a deadline and cleanup path so a kernel behavior difference cannot hang CI.

- [ ] **Step 3: Verify discovery without a VM**

Run: `bun scripts/bun-test.ts packages/sandbox-vm/test/e2e/vm-resource-violations.test.ts --only-failures`

Expected: tests are discovered and skipped.

- [ ] **Step 4: Verify parser/store regressions**

Run: `bun scripts/bun-test.ts packages/sandbox-vm/test/unit/vsock-process.test.ts packages/sandbox/test/unit/violation-store.test.ts --only-failures`

- [ ] **Step 5: Commit**

```bash
git add packages/sandbox-vm/test/e2e/vm-resource-violations.test.ts packages/sandbox-vm/test/e2e/vm-fixture.ts
git commit -m "test(sandbox-vm): exercise real cgroup violations"
```

### Task 5: Windows Hyper-V/9p conformance

**Files:**
- Create: `packages/sandbox-vm/test/e2e/vm-hyperv.windows.test.ts`
- Modify: `packages/sandbox-vm/test/smoke/winvm-helper.ps1`

**Interfaces:**
- Consumes: shared fixture and Windows platform suffix routing.
- Produces: real hvsock/9p/path/cleanup coverage and `-Conformance` smoke mode.

- [ ] **Step 1: Add Windows-only gated tests**

Cover a writable path containing spaces, a read-only share, nested deny, credential mask, more than one 9p share, filtered egress, and disposal followed by host assertions that the bundle and owned named-pipe/helper resources are gone.

- [ ] **Step 2: Verify platform routing on the current host**

Run: `bun scripts/bun-test.ts packages/sandbox-vm/test/e2e/ --only-failures`

Expected on non-Windows: the `.windows.test.ts` file is excluded by the repository runner rather than loaded and skipped.

- [ ] **Step 3: Extend the PowerShell smoke**

Add `-Conformance` so a prepared Windows runner executes:

```powershell
$env:MONAD_VM_IT = '1'
& bun ..\..\..\..\scripts\bun-test.ts test\e2e\ --only-failures
if ($LASTEXITCODE -ne 0) { Die 'real Hyper-V conformance failed' }
```

The smoke must fail if `probe.hyperv` or hvsock registration is false.

- [ ] **Step 4: Verify PowerShell syntax and Bun discovery**

Run the Bun discovery locally; syntax validation runs on the existing Windows CI lane and the new Hyper-V runner.

- [ ] **Step 5: Commit**

```bash
git add packages/sandbox-vm/test/e2e/vm-hyperv.windows.test.ts packages/sandbox-vm/test/smoke/winvm-helper.ps1
git commit -m "test(sandbox-vm): add Hyper-V real conformance"
```

### Task 6: Capability-specific workflow and preflight

**Files:**
- Create: `packages/sandbox-vm/test/smoke/vm-preflight.ts`
- Create: `packages/sandbox-vm/test/unit/vm-preflight.test.ts`
- Create: `packages/sandbox-vm/test/unit/real-vm-workflow.test.ts`
- Create: `.github/workflows/sandbox-vm-real.yml`

**Interfaces:**
- Produces: `preflightResult(toolchain, platform): {ok: boolean; driver: string; detail?: string}` pure formatter.
- Produces: self-hosted jobs labeled `kvm`, `vfkit`, and `hyperv`.

- [ ] **Step 1: Write failing preflight tests**

Assert Linux rejects `kvm:false`, accepts `kvm:true`, Darwin reports `vfkit`, and Windows reports `hyperv`. The executable path resolves the real toolchain and Windows probe, prints bounded JSON, and exits 69 on capability failure.

- [ ] **Step 2: Verify RED then implement the preflight smoke**

Run: `bun scripts/bun-test.ts packages/sandbox-vm/test/unit/vm-preflight.test.ts --only-failures` before and after implementation.

- [ ] **Step 3: Add the workflow**

Use `workflow_dispatch` and nightly schedule with three jobs. Each uses only its capability labels, runs preflight, sets `MONAD_VM_IT=1`, invokes `bun run --cwd packages/sandbox-vm test:e2e`, and uploads bounded diagnostics on failure. Do not add these jobs to hosted `ci.yml`.

- [ ] **Step 4: Add a workflow contract unit test**

Read the YAML and assert all three capability labels, the preflight command, `MONAD_VM_IT: "1"`, and the package `test:e2e` command are present. This is a configuration contract test, not a claim that a runner executed it.

- [ ] **Step 5: Verify GREEN**

Run: `bun scripts/bun-test.ts packages/sandbox-vm/test/unit/vm-preflight.test.ts packages/sandbox-vm/test/unit/real-vm-workflow.test.ts --only-failures`

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/sandbox-vm-real.yml packages/sandbox-vm/test/smoke/vm-preflight.ts packages/sandbox-vm/test/unit/vm-preflight.test.ts packages/sandbox-vm/test/unit/real-vm-workflow.test.ts
git commit -m "ci(sandbox-vm): add real hypervisor conformance lanes"
```

### Task 7: Documentation reconciliation and final verification

**Files:**
- Modify: `docs/superpowers/specs/2026-07-14-sandbox-vm-p0-hardening-design.md`
- Modify: `docs/superpowers/specs/2026-07-14-sandbox-vm-p1-parity-design.md`
- Create: `docs/sandbox-vm-conformance.md`

**Interfaces:**
- Produces: a platform evidence matrix with `unit verified`, `real-VM passed`, and `not run` states.

- [ ] **Step 1: Update historical scope statements**

Record that Windows landed from main and is covered by the same guest protocol/mount plan, while preserving the historical P0/P1 chronology.

- [ ] **Step 2: Document runner provisioning and commands**

Include labels, Hyper-V hvsock setup, KVM permissions, vfkit entitlement, image cache, manual commands, cleanup expectations, and the rule that checked-in workflows are not execution evidence.

- [ ] **Step 3: Run the complete verification gate**

```bash
bun scripts/bun-test.ts packages/sandbox-vm/test packages/sandbox/test/unit --only-failures
bun run --cwd packages/sandbox-vm typecheck
bun run --cwd packages/sandbox-vm lint
bun run --cwd packages/sandbox typecheck
bun run --cwd packages/sandbox lint
bun run --cwd packages/sdk-atom typecheck
cd packages/sandbox-vm/native/vsock-agent && go test -count=1 ./...
GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go test -c -o /tmp/monad-vsock-agent-amd64.test .
GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go test -c -o /tmp/monad-vsock-agent-arm64.test .
```

Expected locally without a capable VM run: all unit/type/lint/Go gates pass, all common real-VM tests skip, and Windows-only files are excluded on non-Windows.

- [ ] **Step 4: Verify repository state**

Run: `git diff --check && git status --short`

- [ ] **Step 5: Commit**

```bash
git add docs packages/sandbox-vm .github/workflows/sandbox-vm-real.yml
git commit -m "docs(sandbox-vm): define real-VM evidence matrix"
```
