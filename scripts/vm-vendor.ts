#!/usr/bin/env bun
// Put the VM backend's guest/host binaries in packages/sandbox-vm/vendor/.
//
// Nobody has to run this: the daemon resolves each asset on demand and caches it under <vmDir>/bin.
// It exists for the cases where on-demand is the wrong time — a CI runner that should fail fast
// instead of downloading mid-test, an offline machine that needs to prefetch, and a contributor
// changing native/ who wants the binaries rebuilt from their own source.
//
//   mise run vendor:vm                    # download the pinned assets (build from source if unpublished)
//   mise run vendor:vm -- --build         # always build from source (requires Go, and gcc on Linux)
//   mise run vendor:vm -- --check         # report what is present, change nothing
//   mise run vendor:vm:pins:own -- --write # verify and update pins from local build output
//
// Downloads are sha256-verified against packages/sandbox-vm/src/vendor-assets.ts. Local builds are
// not: they are your own bytes, and their digest legitimately differs until you re-pin.

import { chmodSync, existsSync } from 'node:fs';
import { mkdir, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import {
  VENDOR_ASSET_RELEASE,
  VENDOR_ASSET_SHA256,
  type VendorAssetName,
  vendorAssetUrl
} from '../packages/sandbox-vm/src/vendor-assets.ts';

const ROOT = resolve(import.meta.dir, '..');
const VENDOR_DIR = join(ROOT, 'packages/sandbox-vm/vendor');
const NATIVE_DIR = join(ROOT, 'packages/sandbox-vm/native');
const PINS_FILE = join(ROOT, 'packages/sandbox-vm/src/vendor-assets.ts');

const NAMES = Object.keys(VENDOR_ASSET_SHA256) as VendorAssetName[];

const OBSERVER_ARCH = process.arch === 'x64' ? 'amd64' : 'arm64';
const OBSERVER_SCRIPT = join(NATIVE_DIR, 'seccomp-observer/build.sh');

/** The container image the observer's CI job builds in — same image, same bytes. */
const OBSERVER_IMAGE = 'gcc:15-bookworm';

function containerRuntime(): string | null {
  return Bun.which('docker') ?? Bun.which('podman');
}

// The observer is Linux-only C (`linux/audit.h`, and a self-test that installs a real seccomp
// filter), so a macOS or Windows host cannot compile it natively even though its guest needs it.
// Building it in the same image CI uses keeps that host usable without a Linux box.
function observerArgv(): string[] | null {
  if (process.platform === 'linux') return ['bash', OBSERVER_SCRIPT];
  const runtime = containerRuntime();
  if (!runtime) return null;
  return [
    runtime,
    'run',
    '--rm',
    '--platform',
    `linux/${OBSERVER_ARCH}`,
    '--security-opt',
    'seccomp=unconfined',
    '-v',
    `${ROOT}:/src`,
    '-w',
    '/src/packages/sandbox-vm/native/seccomp-observer',
    OBSERVER_IMAGE,
    './build.sh'
  ];
}

// Which build produces which assets. The Go targets cross-compile from any host; the observer is
// built for the host arch only, because its script runs a self-test against the binary it produced.
const BUILD_SCRIPTS: Array<{ argv: () => string[] | null; produces: VendorAssetName[] }> = [
  {
    argv: () => ['bash', join(NATIVE_DIR, 'vsock-agent/build.sh')],
    produces: ['vsock-agent-amd64', 'vsock-agent-arm64']
  },
  {
    argv: () => ['bash', join(NATIVE_DIR, 'winvm-helper/build.sh')],
    produces: ['gvforwarder-amd64', 'gvforwarder-arm64', 'winvm-helper-amd64.exe', 'winvm-helper-arm64.exe']
  },
  {
    argv: observerArgv,
    produces: [`seccomp-observer-${OBSERVER_ARCH}`]
  }
];

const {
  positionals: selected,
  values: {
    build: buildOnly = false,
    check: checkOnly = false,
    pin: pinOnly = false,
    release: fromRelease = false,
    write = false
  }
} = parseArgs({
  allowPositionals: true,
  args: Bun.argv.slice(2),
  options: {
    build: { type: 'boolean' },
    check: { type: 'boolean' },
    pin: { type: 'boolean' },
    release: { type: 'boolean' },
    write: { type: 'boolean' }
  },
  strict: true
});
if ([buildOnly, checkOnly, pinOnly].filter(Boolean).length > 1)
  throw new Error('--build, --check, and --pin are mutually exclusive');
if (!pinOnly && (fromRelease || write || selected.length > 0))
  throw new Error('--release, --write, and asset names require --pin');

function log(message: string): void {
  process.stdout.write(`[vendor:vm] ${message}\n`);
}

function digestBytes(bytes: Uint8Array): string {
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(bytes);
  return hasher.digest('hex');
}

async function digest(path: string): Promise<string> {
  return digestBytes(await Bun.file(path).bytes());
}

async function pinDigest(name: VendorAssetName): Promise<string> {
  if (!fromRelease) {
    const path = join(VENDOR_DIR, name);
    if (!existsSync(path)) throw new Error(`missing ${path} — run with --build first`);
    return digest(path);
  }
  const url = vendorAssetUrl(name);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`download failed ${response.status} ${url}`);
  return digestBytes(new Uint8Array(await response.arrayBuffer()));
}

async function pin(): Promise<void> {
  for (const name of selected) {
    if (!NAMES.includes(name as VendorAssetName)) throw new Error(`unknown asset '${name}' — expected one of ${NAMES}`);
  }
  const names = selected.length > 0 ? (selected as VendorAssetName[]) : NAMES;
  const digests = await Promise.all(names.map(async (name) => [name, await pinDigest(name)] as const));
  const changed = digests.filter(([name, value]) => VENDOR_ASSET_SHA256[name] !== value);
  for (const [name, value] of digests) {
    const mark = VENDOR_ASSET_SHA256[name] === value ? ' ' : '~';
    process.stdout.write(`${mark} '${name}': '${value}',\n`);
  }
  if (changed.length === 0) {
    process.stdout.write(`\nall ${names.length} pins already match\n`);
    return;
  }
  if (!write) {
    process.stdout.write(`\n${changed.length} pin(s) differ — re-run with --write to patch vendor-assets.ts\n`);
    process.exitCode = 1;
    return;
  }
  let source = await Bun.file(PINS_FILE).text();
  for (const [name, value] of changed) {
    const pattern = new RegExp(`('${name}': ')[0-9a-f]{64}(')`);
    if (!pattern.test(source)) throw new Error(`could not locate the pin line for ${name}`);
    source = source.replace(pattern, `$1${value}$2`);
  }
  await Bun.write(PINS_FILE, source);
  process.stdout.write(`\nwrote ${changed.length} pin(s) to ${PINS_FILE}\n`);
}

// A hypervisor runs same-arch guests, so only the host-arch variants can ever be loaded here. The
// other arch is still fetched when it is free to do so (the Go builds emit both), but its absence
// is not a failure — otherwise an arm64 Mac could never satisfy this check, since the observer
// builds for one arch at a time.
const REQUIRED_HERE = new Set<VendorAssetName>(
  NAMES.filter((name) => name.includes(process.arch === 'x64' ? 'amd64' : 'arm64'))
);

/** Print the state of every asset; count only the ones this host actually needs as missing. */
async function report(): Promise<number> {
  let missingRequired = 0;
  for (const name of NAMES) {
    const path = join(VENDOR_DIR, name);
    if (!existsSync(path)) {
      const required = REQUIRED_HERE.has(name);
      if (required) missingRequired += 1;
      log(`${required ? 'missing ' : 'n/a     '} ${name}`);
      continue;
    }
    const got = await digest(path);
    log(`${got === VENDOR_ASSET_SHA256[name] ? 'pinned  ' : 'local   '} ${name}`);
  }
  return missingRequired;
}

async function download(name: VendorAssetName): Promise<void> {
  const url = vendorAssetUrl(name);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed ${res.status} ${url}`);
  const dest = join(VENDOR_DIR, name);
  const partial = `${dest}.partial`;
  await mkdir(VENDOR_DIR, { recursive: true });
  await Bun.write(partial, res);
  const got = await digest(partial);
  if (got !== VENDOR_ASSET_SHA256[name]) {
    throw new Error(`${name} sha256 mismatch (pinned ${VENDOR_ASSET_SHA256[name]}, got ${got})`);
  }
  await rename(partial, dest);
  chmodSync(dest, 0o755);
}

/** Build what this host can, reporting what it cannot rather than failing the whole run. */
async function build(only?: VendorAssetName[]): Promise<string[]> {
  if (!Bun.which('go')) {
    throw new Error('building the VM vendor binaries needs Go on PATH — install Go, or wait for the pinned release');
  }
  const skipped: string[] = [];
  for (const { argv, produces } of BUILD_SCRIPTS) {
    if (only && !produces.some((name) => only.includes(name))) continue;
    const command = argv();
    if (!command) {
      skipped.push(
        `${produces.join(', ')}: Linux-only, and no container runtime found — install Docker or Podman, or take it from the ${VENDOR_ASSET_RELEASE} release`
      );
      continue;
    }
    log(`building ${produces.join(', ')}`);
    const proc = Bun.spawn(command, { stdout: 'inherit', stderr: 'inherit' });
    if ((await proc.exited) !== 0) throw new Error(`build failed: ${command.join(' ')}`);
  }
  return skipped;
}

if (pinOnly) {
  await pin();
  process.exit(process.exitCode ?? 0);
}

if (checkOnly) {
  const missing = await report();
  process.exit(missing === 0 ? 0 : 1);
}

if (buildOnly) {
  const skipped = await build();
  const missing = await report();
  for (const reason of skipped) log(`skipped  ${reason}`);
  process.exit(missing === 0 ? 0 : 1);
}

const wanted = NAMES.filter((name) => !existsSync(join(VENDOR_DIR, name)));
if (wanted.length === 0) {
  log('all assets already present');
  process.exit(0);
}

log(`fetching ${wanted.length} asset(s) from ${VENDOR_ASSET_RELEASE}`);
const failures: Array<{ name: VendorAssetName; reason: string }> = [];
await Promise.all(
  wanted.map(async (name) => {
    try {
      await download(name);
      log(`fetched  ${name}`);
    } catch (cause) {
      failures.push({ name, reason: cause instanceof Error ? cause.message : String(cause) });
    }
  })
);

if (failures.length === 0) process.exit(0);

// The release is cut from the same sources this checkout has, so building locally is the correct
// fallback while it is unpublished — and the only option on an air-gapped machine.
log(`${failures.length} asset(s) could not be fetched:`);
for (const { name, reason } of failures) log(`  ${name}: ${reason}`);
if (!Bun.which('go')) {
  log('install Go to build them from source instead, or set sandbox.vm.winvmHelperPath to your own copy');
  process.exit(1);
}
log('falling back to building from source');
const skipped = await build(failures.map((failure) => failure.name));
const missing = await report();
for (const reason of skipped) log(`skipped  ${reason}`);
process.exit(missing === 0 ? 0 : 1);
