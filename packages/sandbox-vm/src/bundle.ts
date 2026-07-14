// A per-VM bundle directory: the on-disk state a single agent's VM needs. A self-contained bundle
// layout (EFI vars + rootfs + identity + sockets), scoped per-agent, not per-install.
//
//   <vmDir>/agents/<key>/
//     rootfs.img        APFS copy-on-write clone of the base image (near-zero until written)
//     efivars.fd        EFI variable store (vfkit --bootloader efi,variable-store=…,create)
//     ignition.json      Ignition config injected at boot (monad user + ssh pubkey + bootstrap)
//     id_ed25519         one-shot ssh private key (host side); pubkey goes into ignition
//     id_ed25519.pub
//     gvproxy.sock       vfkit ⇄ gvproxy datagram socket
//     ssh.sock           gvproxy -forward-sock → guest sshd (host-side unix socket)
//     vfkit.sock         vfkit --restful-uri control socket
//     vfkit.pid
//
// The whole dir is 0700 and every socket 0600 — the VM's control plane must not be reachable by
// other local users.

import { chmodSync, existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { vmDir } from './toolchain.ts';

export interface VmBundle {
  /** Stable reuse key: `agentId ?? sessionId` (+ policy fingerprint appended by the pool). */
  readonly key: string;
  readonly dir: string;
  readonly rootfs: string;
  readonly efiVars: string;
  readonly ignition: string;
  readonly gvproxySock: string;
  /** The host exec-channel endpoint: a unix socket (vfkit exposes it, socat bridges it on Linux) or
   *  a named pipe on Windows (winvm-helper's execbridge; node dials pipe paths natively). */
  readonly vsockSock: string;
  readonly vfkitSock: string;
  readonly vfkitPid: string;
  /** Windows: the Hyper-V VM name (WMI ElementName) this bundle boots as. */
  readonly vmName: string;
}

function safeKey(key: string): string {
  // Sanitize the key into a single path segment (agent/session ids are prefixed slugs; a policy
  // fingerprint is hex — both safe, but guard against separators just in case).
  return key.replace(/[^A-Za-z0-9_.-]/g, '_');
}

function bundleDir(key: string): string {
  return join(vmDir(), 'agents', safeKey(key));
}

export function describeBundle(key: string): VmBundle {
  const dir = bundleDir(key);
  const win = process.platform === 'win32';
  return {
    key,
    dir,
    // Hyper-V refuses disks without a .vhdx extension; vfkit/QEMU don't care about .img.
    rootfs: join(dir, win ? 'rootfs.vhdx' : 'rootfs.img'),
    efiVars: join(dir, 'efivars.fd'),
    ignition: join(dir, 'ignition.json'),
    gvproxySock: join(dir, 'gvproxy.sock'),
    vsockSock: win ? `\\\\.\\pipe\\monad-vm-${safeKey(key)}` : join(dir, 'vsock.sock'),
    vfkitSock: join(dir, 'vfkit.sock'),
    vfkitPid: join(dir, 'vfkit.pid'),
    vmName: `monad-${safeKey(key)}`
  };
}

/** APFS copy-on-write clone: instant + near-zero disk until the guest writes. Falls back to a plain
 *  copy on a non-APFS volume. On Windows the equivalent is a differencing VHDX (child references the
 *  read-only base), created via PowerShell New-VHD; plain copy if that fails (e.g. no Hyper-V module). */
async function cloneImage(base: string, dest: string): Promise<void> {
  if (process.platform === 'win32') {
    const diff = Bun.spawn(
      ['powershell', '-NoProfile', '-Command', `New-VHD -Path '${dest}' -ParentPath '${base}' -Differencing`],
      { stdout: 'ignore', stderr: 'pipe' }
    );
    if ((await diff.exited) === 0) return;
    const { copyFile } = await import('node:fs/promises');
    await copyFile(base, dest);
    chmodSync(dest, 0o600);
    return;
  }
  const clone = Bun.spawn(['cp', '-c', base, dest], { stdout: 'ignore', stderr: 'pipe' });
  if ((await clone.exited) !== 0) {
    // -c (clonefile) unsupported on this filesystem — fall back to a regular copy.
    const plain = Bun.spawn(['cp', base, dest], { stdout: 'ignore', stderr: 'pipe' });
    if ((await plain.exited) !== 0) {
      throw new Error(`vm bundle: failed to clone base image ${base} → ${dest}`);
    }
  }
  // The base image is read-only (0444); cp/clonefile preserves that mode, but vfkit's virtio-blk
  // needs a WRITABLE disk (it mounts rw) or rejects the config ("storage device attachment is
  // invalid"). Make the per-VM clone writable.
  chmodSync(dest, 0o600);
}

/** Create (or reuse) a bundle dir for `key`, cloning the base rootfs. Does NOT write the ignition
 *  config — the launcher assembles that from the policy + the vsock agent binary. */
export async function ensureBundle(key: string, baseImage: string): Promise<VmBundle> {
  const bundle = describeBundle(key);
  if (existsSync(bundle.rootfs)) return bundle;

  await mkdir(bundle.dir, { recursive: true });
  chmodSync(bundle.dir, 0o700);
  await cloneImage(baseImage, bundle.rootfs);
  return bundle;
}

/** Remove a bundle dir entirely (VM destroyed). Best-effort — a missing dir is fine. */
export async function destroyBundle(key: string): Promise<void> {
  await rm(bundleDir(key), { recursive: true, force: true });
}
