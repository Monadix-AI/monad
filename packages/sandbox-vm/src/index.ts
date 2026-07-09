// @monad/sandbox-vm — a HEAVY, VM-based sandbox backend (skeleton).
//
// A VM backend is not another light launcher: it is a subsystem. A real implementation owns a VM
// pool + reuse/snapshots (boot is seconds, not milliseconds), a workspace mount/sync in-and-out (the
// guest has its own filesystem, so `writableRoots` means "bind these into the guest"), guest→host
// egress-proxy reachability (host-only networking), and a per-OS hypervisor driver + image
// (Virtualization.framework / Firecracker / Hyper-V). None of that exists yet.
//
// This skeleton exists so the plumbing is real end-to-end: `vmLauncher` implements the SandboxLauncher
// contract and registers as the `vm` heavy backend (via @monad/monad-power-pack). Because
// isAvailable() is false, selecting `agent.sandbox.backend:'vm'` today resolves the launcher, runs its
// no-op prepare(), finds it unavailable, and falls back to the light OS sandbox with a warning — the
// safe behavior until the subsystem is built.

import type { SandboxLauncher, SandboxProcess, SandboxSpawnOptions } from '@monad/sdk-atom';

export class VmBackendNotImplementedError extends Error {
  constructor() {
    super(
      '@monad/sandbox-vm: the VM backend is not implemented yet (skeleton). Select a different agent.sandbox.backend.'
    );
    this.name = 'VmBackendNotImplementedError';
  }
}

export const vmLauncher: SandboxLauncher = {
  kind: 'vm',
  // Any platform — a VM backend is OS-agnostic at the contract level; the concrete driver is per-OS.
  platforms: undefined,
  // The containment a real VM backend is intended to provide (own kernel → strongest isolation).
  enforces: { writeConfine: true, readDeny: true, net: ['none', 'filtered', 'unrestricted'] },
  // Not available until the subsystem lands. Keeps `backend:'vm'` a safe no-op that falls back to light.
  isAvailable: () => false,
  // A real impl would ensure the VM pool/image is ready here; nothing to warm up in the skeleton.
  async prepare(): Promise<void> {},
  // REMOTE execution model (like e2b/docker): a real impl boots/reuses a VM and runs the argv inside it.
  spawn(_argv: string[], _options: SandboxSpawnOptions): SandboxProcess {
    throw new VmBackendNotImplementedError();
  }
};
