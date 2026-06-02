#!/usr/bin/env bun
// Regenerate the sha256 pins in packages/sandbox-vm/src/toolchain.ts. Downloads each pinned release
// asset, computes its sha256, and prints the constants to paste. Run after bumping a tool version.
//
//   bun scripts/pin-vm-toolchain.ts

const ASSETS = {
  VFKIT: 'https://github.com/crc-org/vfkit/releases/download/v0.6.4/vfkit',
  GVPROXY: 'https://github.com/containers/gvisor-tap-vsock/releases/download/v0.8.9/gvproxy-darwin'
} as const;

async function sha256(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed ${res.status} ${url}`);
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(new Uint8Array(await res.arrayBuffer()));
  return hasher.digest('hex');
}

for (const [name, url] of Object.entries(ASSETS)) {
  const hex = await sha256(url);
  process.stdout.write(`${name} sha256: ${hex}\n  (${url})\n`);
}
