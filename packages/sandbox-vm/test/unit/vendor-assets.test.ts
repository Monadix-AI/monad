import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { __resetVmToolchainForTest, configureVmToolchain } from '../../src/toolchain.ts';
import {
  __setVendorLocalDirForTest,
  cachedVendorAsset,
  resolveVendorAsset,
  VENDOR_ASSET_RELEASE,
  VENDOR_ASSET_SHA256,
  type VendorAssetName,
  vendorAssetUrl
} from '../../src/vendor-assets.ts';

const ASSET: VendorAssetName = 'vsock-agent-amd64';
const PAYLOAD = 'pinned-agent-bytes';
const PAYLOAD_SHA256 = new Bun.CryptoHasher('sha256').update(PAYLOAD).digest('hex');

const realFetch = globalThis.fetch;
let dirs: string[] = [];
let localDir: string;
let vmRoot: string;
let requested: string[] = [];

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `monad-vendor-${prefix}-`));
  dirs.push(dir);
  return dir;
}

/** Serve PAYLOAD for every asset URL and record what was requested. */
function stubFetch(body: string = PAYLOAD): void {
  globalThis.fetch = (async (input: string | URL | Request) => {
    requested.push(typeof input === 'string' ? input : input.toString());
    return new Response(body);
  }) as typeof fetch;
}

beforeEach(() => {
  requested = [];
  localDir = scratch('local');
  vmRoot = scratch('vm');
  __setVendorLocalDirForTest(localDir);
  configureVmToolchain({ vmDir: vmRoot });
});

afterEach(() => {
  globalThis.fetch = realFetch;
  __setVendorLocalDirForTest(null);
  __resetVmToolchainForTest();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

test('every asset is pinned to a real digest on the declared release tag', () => {
  const names = Object.keys(VENDOR_ASSET_SHA256) as VendorAssetName[];

  expect(names).toEqual([
    'gvforwarder-amd64',
    'gvforwarder-arm64',
    'seccomp-observer-amd64',
    'seccomp-observer-arm64',
    'vsock-agent-amd64',
    'vsock-agent-arm64',
    'winvm-helper-amd64.exe',
    'winvm-helper-arm64.exe'
  ]);
  // A placeholder digest would let an unverified binary through the download path.
  for (const name of names) expect(VENDOR_ASSET_SHA256[name]).toMatch(/^[0-9a-f]{64}$/);
  expect(vendorAssetUrl(ASSET)).toBe(
    `https://github.com/Monadix-AI/monad/releases/download/${VENDOR_ASSET_RELEASE}/${ASSET}`
  );
});

test('a local build is used as-is and suppresses the download', async () => {
  const local = join(localDir, ASSET);
  await Bun.write(local, 'locally-built-bytes-with-a-different-digest');
  stubFetch();

  expect(await resolveVendorAsset(ASSET)).toBe(local);
  expect(requested).toEqual([]);
});

test('a missing asset is downloaded, verified, and cached for the next call', async () => {
  const pins = VENDOR_ASSET_SHA256 as Record<VendorAssetName, string>;
  const pinned = pins[ASSET];
  pins[ASSET] = PAYLOAD_SHA256;
  stubFetch();

  try {
    const first = await resolveVendorAsset(ASSET);
    expect(first).toBe(cachedVendorAsset(ASSET));
    expect(await Bun.file(first).text()).toBe(PAYLOAD);
    expect(requested).toEqual([vendorAssetUrl(ASSET)]);

    const second = await resolveVendorAsset(ASSET);
    expect(second).toBe(first);
    expect(requested).toEqual([vendorAssetUrl(ASSET)]);
  } finally {
    pins[ASSET] = pinned;
  }
});

test('concurrent callers share one download instead of racing on the destination', async () => {
  const pins = VENDOR_ASSET_SHA256 as Record<VendorAssetName, string>;
  const pinned = pins[ASSET];
  pins[ASSET] = PAYLOAD_SHA256;
  stubFetch();

  try {
    const [a, b, c] = await Promise.all([
      resolveVendorAsset(ASSET),
      resolveVendorAsset(ASSET),
      resolveVendorAsset(ASSET)
    ]);
    expect([a, b, c]).toEqual([cachedVendorAsset(ASSET), cachedVendorAsset(ASSET), cachedVendorAsset(ASSET)]);
    expect(requested).toEqual([vendorAssetUrl(ASSET)]);
  } finally {
    pins[ASSET] = pinned;
  }
});

test('a digest that does not match the pin fails closed instead of returning the binary', async () => {
  stubFetch('tampered-payload');

  await expect(resolveVendorAsset(ASSET)).rejects.toThrow(/sha256 mismatch/);
});

test('a corrupted cache entry is replaced by a fresh verified download', async () => {
  const pins = VENDOR_ASSET_SHA256 as Record<VendorAssetName, string>;
  const pinned = pins[ASSET];
  pins[ASSET] = PAYLOAD_SHA256;
  await Bun.write(cachedVendorAsset(ASSET), 'truncated-or-tampered');
  stubFetch();

  try {
    const resolved = await resolveVendorAsset(ASSET);
    expect(await Bun.file(resolved).text()).toBe(PAYLOAD);
    expect(requested).toEqual([vendorAssetUrl(ASSET)]);
  } finally {
    pins[ASSET] = pinned;
  }
});

test('a failed download surfaces the status instead of leaving a partial file in place', async () => {
  globalThis.fetch = (async (_input: string | URL | Request) => new Response('nope', { status: 404 })) as typeof fetch;

  await expect(resolveVendorAsset(ASSET)).rejects.toThrow(/download failed 404/);
  expect(await Bun.file(cachedVendorAsset(ASSET)).exists()).toBe(false);
});
