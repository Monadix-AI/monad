# Sandbox VM P4 Baseline Snapshot Implementation Plan

**Goal:** Restore an identity-bound VM baseline captured after trusted guest boot and before any workload, with exactly one cold-boot fallback on failure.

**Architecture:** Extend `VmDriver` with an explicit baseline capability, add an owner-only manifest/cache layer, add protocol-v5 guest quiescence handshakes, then implement QEMU migration-state and Hyper-V Standard-checkpoint backends. vfkit remains an explicit cold boot.

## Task 1: Driver capability contract

- Define baseline artifact, capture, restore, invalidate, and capability types next to `VmDriver`.
- Mark vfkit unsupported, QEMU/Hyper-V capability-probed, and keep platform branching behind drivers.
- Add pure contract tests and no-snapshot vfkit assertions.

## Task 2: Manifest, cache, and leases

- Add strict schema parsing for identity, driver/toolchain, guest artifacts, topology, epoch, file digests, and sizes.
- Publish through owner-only temporary directories plus atomic rename.
- Implement inactive-count/byte LRU limits, one-writer capture leases, one-consumer restore leases, digest validation, and marker-scoped crash cleanup.

## Task 3: Protocol-v5 baseline handshake

- Add prepare-baseline and restored-baseline frames without starting a workload.
- Track a random boot epoch, active run count, and irreversible ever-started state in the guest agent.
- Require zero runs, no prior workload, filesystem sync, matching epoch, and matching build identity.
- Rebuild both guest agents and add Go/TypeScript protocol tests.

## Task 4: Baseline lifecycle orchestration

- After cold boot readiness, pause admission, perform prepare handshake, capture once, then admit the first workload.
- On later reconstruction validate and lease the artifact, recreate host sidecars, restore, and perform restored handshake.
- On any restore failure invalidate once and cold boot once; never loop or select a weaker identity.
- Cover every transition with a fake baseline driver.

## Task 5: QEMU/KVM backend

- Add deterministic QMP socket/device IDs and bounded QMP request handling.
- Probe migratability, capture external migration state paired with the baseline disk state, and restore after fresh virtiofsd/socat/gvproxy sidecars start.
- Reject TCG as performance evidence and invalidate unsupported toolchain fingerprints.

## Task 6: Hyper-V backend

- Add bounded `baseline-create`, `baseline-restore`, `baseline-inspect`, and `baseline-delete` helper commands.
- Use Standard checkpoints with memory state, marker-owned export paths, idempotent cleanup, and restored VM-ID discovery.
- Recreate hvsock, 9p, and networking helpers outside the checkpoint transaction.

## Task 7: Configuration, measurement, and real-VM conformance

- Add config.json settings for enabled, max inactive artifacts, and max bytes; default disabled.
- Add gated cold/restore conformance for QEMU/KVM and Hyper-V and explicit vfkit cold fallback.
- Record at least 30 cold and 30 restore samples before enabling any driver by default; never claim measurements from mocks or unsupported hosts.
- Run full Bun, Go, native, cross-platform compile, diff, and cleanup gates.

