// A per-VM bundle directory: the on-disk state a single agent's VM needs. Modeled on Claude Cowork's
// `claudevm.bundle` layout (EFI vars + rootfs + identity + sockets), but per-agent, not per-install.
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
  readonly sshKey: string;
  readonly sshPubKey: string;
  readonly gvproxySock: string;
  readonly sshSock: string;
  readonly vfkitSock: string;
  readonly vfkitPid: string;
}

function bundleDir(key: string): string {
  // Sanitize the key into a single path segment (agent/session ids are prefixed slugs; a policy
  // fingerprint is hex — both safe, but guard against separators just in case).
  const safe = key.replace(/[^A-Za-z0-9_.-]/g, '_');
  return join(vmDir(), 'agents', safe);
}

export function describeBundle(key: string): VmBundle {
  const dir = bundleDir(key);
  return {
    key,
    dir,
    rootfs: join(dir, 'rootfs.img'),
    efiVars: join(dir, 'efivars.fd'),
    ignition: join(dir, 'ignition.json'),
    sshKey: join(dir, 'id_ed25519'),
    sshPubKey: join(dir, 'id_ed25519.pub'),
    gvproxySock: join(dir, 'gvproxy.sock'),
    sshSock: join(dir, 'ssh.sock'),
    vfkitSock: join(dir, 'vfkit.sock'),
    vfkitPid: join(dir, 'vfkit.pid')
  };
}

/** APFS copy-on-write clone: instant + near-zero disk until the guest writes. Falls back to a plain
 *  copy on a non-APFS volume. */
async function cloneImage(base: string, dest: string): Promise<void> {
  const clone = Bun.spawn(['cp', '-c', base, dest], { stdout: 'ignore', stderr: 'pipe' });
  if ((await clone.exited) === 0) return;
  // -c (clonefile) unsupported on this filesystem — fall back to a regular copy.
  const plain = Bun.spawn(['cp', base, dest], { stdout: 'ignore', stderr: 'pipe' });
  if ((await plain.exited) !== 0) {
    throw new Error(`vm bundle: failed to clone base image ${base} → ${dest}`);
  }
}

/** Generate a one-shot ed25519 keypair (VM lifetime only) via ssh-keygen. */
async function generateSshKey(bundle: VmBundle): Promise<void> {
  const proc = Bun.spawn(
    ['ssh-keygen', '-t', 'ed25519', '-N', '', '-C', `monad-vm-${bundle.key}`, '-f', bundle.sshKey],
    { stdout: 'ignore', stderr: 'pipe' }
  );
  if ((await proc.exited) !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`vm bundle: ssh-keygen failed: ${err}`);
  }
  chmodSync(bundle.sshKey, 0o600);
}

/** Create (or reuse) a bundle dir for `key`, cloning the base rootfs and minting an ssh key. Does NOT
 *  write the ignition config — the driver assembles that from the policy + this bundle's pubkey. */
export async function ensureBundle(key: string, baseImage: string): Promise<VmBundle> {
  const bundle = describeBundle(key);
  if (existsSync(bundle.rootfs) && existsSync(bundle.sshKey)) return bundle;

  await mkdir(bundle.dir, { recursive: true });
  chmodSync(bundle.dir, 0o700);
  if (!existsSync(bundle.rootfs)) await cloneImage(baseImage, bundle.rootfs);
  if (!existsSync(bundle.sshKey)) await generateSshKey(bundle);
  return bundle;
}

/** Remove a bundle dir entirely (VM destroyed). Best-effort — a missing dir is fine. */
export async function destroyBundle(key: string): Promise<void> {
  await rm(bundleDir(key), { recursive: true, force: true });
}
