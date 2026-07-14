# Sandbox VM P5 SRT Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the remaining actionable SRT comparison gaps with explicit layer contracts and adversarial conformance coverage.

**Architecture:** Keep domain and credential decisions in `@monad/sandbox`; keep transport, mount, VM, and guest-firewall enforcement in `@monad/sandbox-vm`. Add real-VM cases at those seams and publish an evidence-scoped parity matrix.

**Tech Stack:** Bun, TypeScript, Bun test, Fedora CoreOS, nftables, virtio-fs, Hyper-V 9p-over-hvsock.

## Global Constraints

- Do not duplicate domain allowlists, MITM, or credential restoration in the VM package.
- Treat seccomp pathname events as telemetry only.
- Use host-side filesystem or network outcomes as enforcement oracles.
- Keep real-VM tests gated by `MONAD_VM_IT=1` and report skipped tests as not run.

---

### Task 1: Alias and filtered-network conformance

**Files:**
- Modify: `packages/sandbox-vm/test/e2e/vm-conformance.test.ts`
- Modify: `packages/sandbox-vm/test/e2e/vm-network.test.ts`

**Interfaces:**
- Consumes: `buildVmMountPlan`, `guestNftables`, and the existing real-VM fixture.
- Produces: host-oracle coverage for symlinked share aliases and direct DNS denial.

- [x] Add a real-VM case with a canonical child share and symlink alias that verifies deny and mask overlays at both guest paths.
- [x] Add a filtered-network case that probes UDP/TCP 53 on both a public resolver and gvproxy's resolver.
- [x] Run skipped discovery without `MONAD_VM_IT=1`; expect all new cases to be discovered as skipped.

### Task 2: Policy-boundary regression coverage

**Files:**
- Modify: `packages/sandbox/test/unit/credential-mask-files.test.ts`
- Create: `packages/sandbox-vm/test/unit/srt-parity-contract.test.ts`

**Interfaces:**
- Consumes: `MaskedFileStore`, sandbox backend docs, and conformance docs.
- Produces: a fail-closed special-file assertion and stable layer-boundary assertions.

- [x] Verify non-regular credential sources become read denies and never mask binds.
- [x] Verify documentation assigns domain and credential policy to `@monad/sandbox` and filtered transport enforcement to `@monad/sandbox-vm`.
- [x] Run focused tests and expect zero failures.

### Task 3: Evidence-scoped parity matrix

**Files:**
- Create: `docs/sandbox-vm-srt-parity.md`
- Modify: `docs/usage/sandbox-backends.md`

**Interfaces:**
- Produces: a durable feature/security comparison with explicit supported, stronger-isolation, not-applicable, and not-run states.

- [x] Document SRT-equivalent shared-policy features and VM enforcement features.
- [x] Record standalone/host-compatibility features that are intentionally not VM requirements.
- [x] Link the matrix from backend documentation.
- [x] Run documentation contract tests and `git diff --check`.

### Task 4: Verification

**Files:**
- Verify all files changed by P5 and the pending security fixes.

**Interfaces:**
- Produces: fresh Bun, Go, cross-compile, and diff-check evidence.

- [x] Run focused Bun unit tests.
- [x] Run sandbox-vm e2e discovery with the real-VM gate unset.
- [x] Run vsock-agent Go tests and Linux arm64/amd64 cross-compiles.
- [x] Run `git diff --check` and report real-VM lanes as not run.
