// monad's own guest/host binaries for the VM backend: the guest vsock exec agent, the seccomp
// observer, gvforwarder (guest tap⇄vsock forwarder), and winvm-helper (the Windows Hyper-V host
// plane). They are built by native/*/build.sh and published as assets on the VENDOR_ASSET_RELEASE
// tag, then downloaded on demand into <vmDir>/bin — the same policy toolchain.ts already applies to
// qemu and gvproxy ("too large to vendor" / "downloads if absent"), so a multi-megabyte rebuild no
// longer lands a fresh copy in git history on every change.
//
// A source checkout that ran build.sh keeps its binaries under packages/sandbox-vm/vendor/ and those
// win: a local build is the developer's own artifact and its sha256 legitimately differs from the
// published one. Everything that comes off the network is sha256-pinned and fails closed.
//
// Regenerate the pins with `mise run vendor:vm:pins:own -- --release --write` after publishing a release.

import { chmodSync, existsSync } from 'node:fs';
import { mkdir, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { vmBinDir } from './toolchain.ts';
import { sha256OfFile } from './util.ts';

/** Release tag carrying the published vendor assets. Bump with the pins below. */
export const VENDOR_ASSET_RELEASE = 'vm-vendor-v1';

const BASE_URL = `https://github.com/Monadix-AI/monad/releases/download/${VENDOR_ASSET_RELEASE}`;

export type VendorAssetName =
  | 'gvforwarder-amd64'
  | 'gvforwarder-arm64'
  | 'seccomp-observer-amd64'
  | 'seccomp-observer-arm64'
  | 'vsock-agent-amd64'
  | 'vsock-agent-arm64'
  | 'winvm-helper-amd64.exe'
  | 'winvm-helper-arm64.exe';

/** PINNED — sha256 of the exact published asset bytes. The Go/C builds are reproducible
 *  (`-trimpath`, `CGO_ENABLED=0`, fixed ldflags), so CI re-verifies these on every publish. */
export const VENDOR_ASSET_SHA256: Record<VendorAssetName, string> = {
  'gvforwarder-amd64': 'ec39950e675561482787a0863d15ce2f42c75e91bbeb80daa522aec8ba9cbfed',
  'gvforwarder-arm64': '211eac3a013955521b3a8a201d09560c1ffb79422e7af9a5512cf586d3cfc228',
  'seccomp-observer-amd64': '2d2e19462e6ecca24d5794becade4aaf5163db86adbd057a3747486e2d038f5c',
  'seccomp-observer-arm64': '59a567904e98a6511c7e79ad51864a0117b04f4ae56886f3587e2e9a1cbbfead',
  'vsock-agent-amd64': '212029e98eb0f2c46a6a8faec00f51f6250b32fd692835774ce7e6c9678b5b21',
  'vsock-agent-arm64': '977339310e90b45f1fe0cc8afa3bfde37bf4d39d5eed52a6e78edff4ec4f6533',
  'winvm-helper-amd64.exe': 'cba006bf7b954b683f80892068da1680f5b962ccc9009bc34bc6233b9a274cdb',
  'winvm-helper-arm64.exe': '26c7fa881300750a6daaeae5fa3a60c141c60cc7d4f745549d8c83c2f75c375f'
};

export function vendorAssetUrl(name: VendorAssetName): string {
  return `${BASE_URL}/${name}`;
}

let localDirOverride: string | null = null;

/** Test seam: point the local-build lookup at a scratch dir instead of the package's vendor/. */
export function __setVendorLocalDirForTest(dir: string | null): void {
  localDirOverride = dir;
  inFlight.clear();
}

/** The in-tree copy written by a local `build.sh`. Present in a source checkout, absent in an install. */
function localVendorAsset(name: VendorAssetName): string {
  return join(localDirOverride ?? join(dirname(import.meta.dir), 'vendor'), name);
}

/** Where a downloaded asset is cached. */
export function cachedVendorAsset(name: VendorAssetName): string {
  return join(vmBinDir(), name);
}

async function download(url: string, dest: string): Promise<void> {
  await mkdir(dirname(dest), { recursive: true });
  const res = await fetch(url);
  if (!res.ok) throw new Error(`vm vendor asset: download failed ${res.status} ${url}`);
  const partial = `${dest}.partial`;
  await Bun.write(partial, res);
  await rename(partial, dest);
}

const inFlight: Map<VendorAssetName, Promise<string>> = new Map();

/**
 * Absolute path to a vendor asset: local build → verified cache → verified download.
 * Throws rather than returning an unverified binary.
 */
export function resolveVendorAsset(name: VendorAssetName): Promise<string> {
  // Two guest artifacts are requested concurrently on the same VM start; without this a cold cache
  // would run two downloads into the same destination.
  const pending = inFlight.get(name);
  if (pending) return pending;
  const task = resolveUncached(name).finally(() => inFlight.delete(name));
  inFlight.set(name, task);
  return task;
}

async function resolveUncached(name: VendorAssetName): Promise<string> {
  const local = localVendorAsset(name);
  if (existsSync(local)) return local;

  const expected = VENDOR_ASSET_SHA256[name];
  const dest = cachedVendorAsset(name);
  if (existsSync(dest) && (await sha256OfFile(dest)) === expected) return dest;

  const url = vendorAssetUrl(name);
  try {
    await download(url, dest);
  } catch (cause) {
    throw new Error(
      `vm vendor asset: could not fetch ${name} from ${VENDOR_ASSET_RELEASE} (${cause instanceof Error ? cause.message : String(cause)}). ` +
        'Run `mise run vendor:vm` in a monad checkout to fetch or build it.'
    );
  }
  const got = await sha256OfFile(dest);
  if (got !== expected) {
    throw new Error(`vm vendor asset: ${name} sha256 mismatch (pinned ${expected}, got ${got}) — refusing to run`);
  }
  chmodSync(dest, 0o755);
  return dest;
}
