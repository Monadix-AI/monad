# Sandbox VM P4 Pre-Workload Baseline Snapshot Design

## Goal

Reduce VM reconstruction latency by capturing a driver-native baseline after the guest is ready but before the first workload. Restore is an optimization for the same effective sandbox identity; any uncertainty falls back to the existing cold-boot transaction without changing confinement.

The first delivery supports QEMU/KVM and Hyper-V. vfkit reports snapshot capability as unavailable and continues cold boot until a separately reviewed native save/restore path exists.

## Scope and Non-Goals

P4 includes:

- an optional baseline capability on `VmDriver`;
- identity-bound artifact manifests and bounded cache management;
- guest quiescence and post-restore epoch handshakes;
- QEMU/KVM state capture/restore;
- Hyper-V Standard checkpoint capture/restore;
- cold-boot fallback for unsupported or failed restores;
- latency measurement and capable-host conformance.

P4 does not:

- snapshot a VM after any user workload has started;
- preserve or resume user processes;
- share one memory snapshot across agents or concurrent VMs;
- treat snapshots as backups;
- enable vfkit snapshots without a supported persistent-state API;
- make restore success a security prerequisite.

## Driver Contract

Snapshot-capable drivers implement:

```ts
interface VmBaselineArtifact {
  manifestPath: string;
  identity: string;
  byteSize: number;
}

interface VmBaselineDriver extends VmDriver {
  readonly baselineSupported: true;
  captureBaseline(spec: VmSpec, handle: VmHandle): Promise<VmBaselineArtifact>;
  restoreBaseline(spec: VmSpec, artifact: VmBaselineArtifact): Promise<VmHandle>;
  invalidateBaseline(artifact: VmBaselineArtifact): Promise<void>;
}
```

Drivers without the extension expose `baselineSupported: false` and use the existing `boot` path. Feature code checks the capability instead of branching on `process.platform`.

## Baseline Lifecycle

The first acquire for an identity follows the current transactional boot. After vsock readiness, the host sends `prepare-baseline`. The guest agent accepts only when:

- `activeRuns` is zero;
- no run has ever started in the current boot epoch;
- no cgroup or run namespace remains;
- pending protocol output is flushed;
- filesystems have completed `sync`.

The guest returns a random boot epoch, guest-agent digest, and `captureEligible: true`. The pool marks the VM paused for admission, calls the driver capture operation, atomically publishes the manifest, and only then permits the first workload.

Later reconstruction validates the manifest, starts fresh host sidecars, restores the driver state, and performs a `restored-baseline` handshake. The guest must report the captured epoch, zero active runs, matching agent digest, and no prior workload. Only then does the pool admit the VM.

Once any workload start is accepted, that VM instance can never create or replace a baseline.

## Artifact Identity

The manifest schema contains:

- format and schema version;
- effective VM identity digest and agent reuse key digest;
- driver kind, host architecture, driver version, and toolchain fingerprint;
- base image, guest-agent, seccomp-observer, protocol, ignition, and mount-plan digests;
- CPU, memory, firmware, device IDs, network mode, and mount topology;
- captured boot epoch;
- artifact filenames, byte sizes, and content digests;
- creation time for eviction only, never for correctness.

The manifest contains no secret values or secret-derived hashes. Full host paths remain in the existing effective identity input but are not copied into diagnostics. Any missing, unknown, mismatched, or malformed field invalidates the artifact before driver restore.

Artifacts publish through a temporary directory plus atomic rename. An incomplete directory is garbage, never a candidate.

## QEMU/KVM Backend

QEMU uses a QMP control socket and an external migration/state artifact paired with the identity's disk overlay. Device IDs remain deterministic. On restore, the driver starts fresh virtiofsd, socat, and gvproxy sidecars before loading incoming state, using the new bundle's socket paths.

Capture first probes whether the configured QEMU, machine type, vhost-vsock, and vhost-user-fs topology is migratable. A non-migratable device or failed QMP command marks baseline unsupported for that exact toolchain fingerprint and proceeds with cold boot. TCG results cannot establish KVM performance.

The QEMU artifact is never restored concurrently. The agent reuse key and pool lease guarantee one active consumer, preventing guest CID and MAC collisions.

## Hyper-V Backend

`winvm-helper` gains bounded JSON commands for baseline create, restore, inspect, and delete. Capture explicitly selects a Standard checkpoint because it contains VM memory state; a Production checkpoint is not accepted. The checkpoint is exported or retained under Monad's owner-controlled baseline directory with a manifest rather than relying on Hyper-V's default location.

Restore queries the resulting VM ID before starting new hvsock exec, 9p, and network bridge helpers. Every helper remains outside the snapshot and is recreated transactionally. Checkpoint and VM removal are idempotent and marker-scoped.

Reference: <https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/checkpoints>

## vfkit Fallback

The current vfkit REST API exposes running, paused, resumed, and stopped transitions but no persistent save/restore operation. `vfkitDriver.baselineSupported` is therefore false. Metrics report a cold boot, not a restore miss or success.

Reference: <https://github.com/crc-org/vfkit/blob/main/doc/usage.md#change-the-virtual-machines-state>

A future macOS design may extend vfkit or add a thin native Virtualization.framework driver. It must preserve the same `VmBaselineDriver` contract and pass the same restore conformance before being enabled.

## Cache and Configuration

Snapshot caching is on only after a driver passes its capability probe. User-facing settings use `config.json`, not environment variables:

- enabled or disabled;
- maximum inactive artifact count;
- maximum total bytes.

Defaults remain disabled until capable-host burn-in produces stable latency and restore evidence. LRU eviction considers only inactive artifacts and runs under a cache lock. An artifact with an active restore lease cannot be removed.

## Failure and Rollback

Capture and restore are explicit resource transactions. Failures stop the VMM and sidecars, remove temporary artifacts, release leases, and preserve the original error in bounded diagnostics. A restore failure invalidates that artifact before one cold-boot retry. The same acquire never loops between restore and cold boot.

Restore timeout, epoch mismatch, active-run mismatch, helper exit, corrupt digest, unsupported device, or cleanup failure all reject the restored VM. Snapshot failure affects latency only; it cannot select a weaker policy or driver.

Crash recovery scans marker-owned temporary directories, leases, QEMU processes, Hyper-V VMs, checkpoints, and sidecars. It never removes resources owned by another concurrent daemon instance without a matching lease token.

## Security Properties

- capture occurs before the first workload and cannot be re-enabled later;
- restored memory contains only the trusted guest boot and policy setup state;
- host sidecars and their live connections are recreated rather than trusted from memory state;
- the guest proves epoch, digest, and zero-run state before admission;
- identity mismatch always cold boots;
- snapshot directories are owner-only and bounded;
- snapshot data is local sensitive runtime state and never uploaded as a CI artifact.

## Performance Measurement

Before enabling a driver, measure at least 30 cold boots and 30 restores on the same runner and identity. Record p50 and p95 from acquire start through successful post-restore handshake, plus artifact bytes and failure rate. The change is beneficial only when restore p95 materially improves cold-boot p95 without increasing conformance failures.

No performance claim is made from unit tests, mocked drivers, or a different hypervisor.

## Testing

Unit and contract tests cover:

- manifest parsing, identity invalidation, atomic publish, and bounded LRU;
- one-writer capture and one-consumer restore leases;
- no capture after a workload start;
- restore failure followed by exactly one cold boot;
- every capture and restore rollback stage;
- QMP and Hyper-V helper command contracts;
- vfkit's explicit cold-boot fallback;
- crash recovery with unrelated concurrent resources.

Capable-host tests cover baseline creation, daemon restart, restore, first-run PTY and pipe execution, cancellation, mounts, masks, filtered networking, cgroup violations, and cleanup. Host-side oracles rerun the high-value P0/P1 confinement cases after restore.

## Delivery Order

1. P2 syscall observation and protocol v4.
2. P3 structured credentials on the shared sandbox/egress layer.
3. P4 driver abstraction and fake-driver lifecycle tests.
4. QEMU/KVM baseline implementation and measurement.
5. Hyper-V baseline implementation and measurement.
6. Separate future vfkit/native macOS snapshot design.

## Success Criteria

- no captured VM has accepted a workload;
- valid QEMU/KVM and Hyper-V baselines restore only into the same effective identity;
- restore failure safely cold boots once;
- restored VMs pass the same confinement oracles as cold-booted VMs;
- vfkit remains explicit cold boot;
- before/after measurements exist before snapshot caching is enabled by default.
