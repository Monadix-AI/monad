// The VM backend's host tooling: vfkit (the Virtualization.framework front-end) and gvproxy (the
// gvisor-tap-vsock user-space network stack). Neither ships in monad's release tarball — a user who
// never selects backend:'vm' pays nothing. When the backend IS selected, prepare() resolves both:
//   1. DETECT a host copy (podman/crc bundle it) and, for vfkit, verify it declares the
//      com.apple.security.virtualization entitlement and meets the version floor.
//   2. Else DOWNLOAD the pinned release to <vmDir>/bin, verify sha256, strip the quarantine xattr,
//      and adhoc re-sign vfkit with the virtualization entitlement (gvproxy needs no entitlement).
//
// Pins are hard-coded (version + sha256); a mismatch fails closed rather than running an unknown
// binary. Regenerate them with scripts/pin-vm-toolchain.ts when bumping a version.

import { accessSync, chmodSync, constants, existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { sha256OfFile } from './util.ts';

export interface VmToolchainConfig {
  /** Base dir for downloaded tools + images (default <home>/vm). */
  vmDir?: string;
  /** Explicit vfkit path override (skips detect + download). */
  vfkitPath?: string;
  /** Explicit gvproxy path override. */
  gvproxyPath?: string;
}

let config: VmToolchainConfig = {};

/** Wire VM toolchain config at daemon boot (from cfg.sandbox.vm). */
export function configureVmToolchain(cfg: VmToolchainConfig): void {
  config = { ...cfg };
}

function defaultVmDir(): string {
  const home = Bun.env.MONAD_HOME || join(Bun.env.HOME || Bun.env.USERPROFILE || homedir(), '.monad');
  return join(home, 'vm');
}

export function vmDir(): string {
  return config.vmDir ?? defaultVmDir();
}

export function vmBinDir(): string {
  return join(vmDir(), 'bin');
}

// Pinned releases. sha256 is of the exact asset bytes; regenerate via scripts/pin-vm-toolchain.ts.
interface ToolPin {
  version: string;
  url: string;
  sha256: string;
  /** Does the tool need the virtualization entitlement (adhoc re-sign on download)? */
  needsEntitlement: boolean;
}

const VFKIT: ToolPin = {
  version: 'v0.6.4',
  url: 'https://github.com/crc-org/vfkit/releases/download/v0.6.4/vfkit',
  // PINNED — regenerate with `bun scripts/pin-vm-toolchain.ts`. The signed release ships WITH the
  // virtualization entitlement; needsEntitlement means "ensure it's present, adhoc re-sign if not".
  sha256: '0ed83fc8ca7aa708598835480dba1362406aa7cd1dab3b27464eb76327d9652d',
  needsEntitlement: true
};

const GVPROXY: ToolPin = {
  version: 'v0.8.9',
  url: 'https://github.com/containers/gvisor-tap-vsock/releases/download/v0.8.9/gvproxy-darwin',
  sha256: 'c6f7b4bc7f21bf810b5cf54e04d979b014c5d96472a03a9e97fe62a00940067c',
  needsEntitlement: false
};

/** vfkit version floor — a detected host binary older than this is rejected (falls to download). */
const VFKIT_MIN_VERSION = [0, 6, 0] as const;

const VIRTUALIZATION_ENTITLEMENT = 'com.apple.security.virtualization';

// Host-detection search roots. podman/crc bundle vfkit + gvproxy in their libexec dirs.
function detectRoots(): string[] {
  const roots = ['/opt/homebrew/bin', '/usr/local/bin', join(homedir(), '.crc', 'bin')];
  // podman keg: /opt/homebrew/Cellar/podman/*/libexec/podman
  for (const cellar of ['/opt/homebrew/Cellar/podman', '/usr/local/Cellar/podman']) {
    if (existsSync(cellar)) {
      try {
        for (const v of new Bun.Glob('*/libexec/podman').scanSync({ cwd: cellar, onlyFiles: false })) {
          roots.push(join(cellar, v));
        }
      } catch {
        /* ignore */
      }
    }
  }
  return roots;
}

async function runCapture(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  return { code, stdout, stderr };
}

function parseVfkitVersion(text: string): [number, number, number] | null {
  const m = text.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function meetsFloor(v: [number, number, number], floor: readonly [number, number, number]): boolean {
  const [a, b, c] = v;
  const [fa, fb, fc] = floor;
  if (a !== fa) return a > fa;
  if (b !== fb) return b > fb;
  return c >= fc;
}

/** Does the binary at `path` declare the virtualization entitlement? */
async function hasVirtualizationEntitlement(path: string): Promise<boolean> {
  const { code, stdout, stderr } = await runCapture(['codesign', '-d', '--entitlements', '-', path]);
  if (code !== 0) return false;
  return `${stdout}${stderr}`.includes(VIRTUALIZATION_ENTITLEMENT);
}

/** A detected gvproxy must at least be an executable file (not just present). A host build's sha
 *  differs from the pinned release, so we can't sha-pin the detect path without breaking legitimate
 *  podman/crc bundles; the executable check is the floor. */
async function gvproxyUsable(path: string): Promise<boolean> {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** A detected vfkit is usable only if it meets the version floor AND carries the entitlement. */
async function vfkitUsable(path: string): Promise<boolean> {
  const ver = await runCapture([path, '--version']);
  if (ver.code !== 0) return false;
  const parsed = parseVfkitVersion(`${ver.stdout}${ver.stderr}`);
  if (!parsed || !meetsFloor(parsed, VFKIT_MIN_VERSION)) return false;
  return hasVirtualizationEntitlement(path);
}

async function detectHostTool(
  binName: 'vfkit' | 'gvproxy',
  validate: (p: string) => Promise<boolean>
): Promise<string | null> {
  for (const root of detectRoots()) {
    const candidate = join(root, binName);
    if (existsSync(candidate) && (await validate(candidate))) return candidate;
  }
  return null;
}

async function download(url: string, dest: string): Promise<void> {
  await mkdir(dirname(dest), { recursive: true });
  const res = await fetch(url);
  if (!res.ok) throw new Error(`vm toolchain: download failed ${res.status} ${url}`);
  const partial = `${dest}.partial`;
  await Bun.write(partial, res);
  const { rename } = await import('node:fs/promises');
  await rename(partial, dest);
}

/** Strip the quarantine xattr so an adhoc-signed download runs without a Gatekeeper prompt. */
async function stripQuarantine(path: string): Promise<void> {
  await runCapture(['xattr', '-d', 'com.apple.quarantine', path]).catch(() => {});
}

/** Adhoc re-sign a binary with the virtualization entitlement (no Developer ID needed). */
async function adhocSignWithEntitlement(path: string): Promise<void> {
  const plist = join(dirname(path), 'vfkit.entitlements.plist');
  await Bun.write(
    plist,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>${VIRTUALIZATION_ENTITLEMENT}</key><true/>
  <key>com.apple.security.network.client</key><true/>
  <key>com.apple.security.network.server</key><true/>
</dict></plist>
`
  );
  const { code, stderr } = await runCapture(['codesign', '--force', '--sign', '-', '--entitlements', plist, path]);
  if (code !== 0) throw new Error(`vm toolchain: adhoc re-sign failed for ${path}: ${stderr}`);
}

async function resolveTool(
  binName: 'vfkit' | 'gvproxy',
  pin: ToolPin,
  override: string | undefined,
  validateHost: (p: string) => Promise<boolean>
): Promise<string> {
  if (override) {
    if (!existsSync(override)) throw new Error(`vm toolchain: ${binName} override path does not exist: ${override}`);
    return override;
  }

  // 1. Detected host copy (version + entitlement verified for vfkit).
  const host = await detectHostTool(binName, validateHost);
  if (host) return host;

  // 2. Cached download.
  const dest = join(vmBinDir(), binName);
  if (existsSync(dest) && (await sha256OfFile(dest)) === pin.sha256) return dest;

  // 3. Fresh download → verify sha256 → chmod → strip quarantine → (vfkit) ensure the entitlement.
  await download(pin.url, dest);
  const got = await sha256OfFile(dest);
  if (got !== pin.sha256) {
    throw new Error(`vm toolchain: ${binName} sha256 mismatch (pinned ${pin.sha256}, got ${got}) — refusing to run`);
  }
  chmodSync(dest, 0o755);
  // Strip the download quarantine so the binary runs without a Gatekeeper prompt.
  await stripQuarantine(dest);
  // The crc-org release ships signed WITH the virtualization entitlement, so normally no re-sign is
  // needed — only adhoc re-sign (replacing the upstream signature) if the entitlement is somehow
  // absent, so we never run vfkit without it.
  if (pin.needsEntitlement && !(await hasVirtualizationEntitlement(dest))) {
    await adhocSignWithEntitlement(dest);
  }
  return dest;
}

export interface ResolvedToolchain {
  vfkit: string;
  gvproxy: string;
}

let cached: ResolvedToolchain | null = null;

/** Resolve both tools (detect or download+verify+resign). Cached after first success. Called from
 *  the launcher's prepare(); throws if either can't be made available. */
export async function resolveVmToolchain(): Promise<ResolvedToolchain> {
  if (cached) return cached;
  if (process.platform !== 'darwin') {
    throw new Error('vm toolchain: the macOS VM backend requires darwin');
  }
  const [vfkit, gvproxy] = await Promise.all([
    resolveTool('vfkit', VFKIT, config.vfkitPath, vfkitUsable),
    resolveTool('gvproxy', GVPROXY, config.gvproxyPath, gvproxyUsable)
  ]);
  cached = { vfkit, gvproxy };
  return cached;
}

/** Sync availability probe for isAvailable(): darwin + either a resolved cache or a plausible host
 *  binary present. The authoritative check (entitlement, sha) runs in prepare()/resolveVmToolchain. */
export function vmToolchainMaybeAvailable(): boolean {
  if (process.platform !== 'darwin') return false;
  if (cached) return true;
  if (config.vfkitPath && config.gvproxyPath) return true;
  // A cached download from a previous run, or a host bundle, makes it worth attempting.
  if (existsSync(join(vmBinDir(), 'vfkit')) && existsSync(join(vmBinDir(), 'gvproxy'))) return true;
  return detectRoots().some((r) => existsSync(join(r, 'vfkit')));
}

/** Test seam: reset the resolved cache. */
export function __resetVmToolchainForTest(): void {
  cached = null;
  config = {};
}

// Exposed for the pin script + unit tests.
export const __pins = { VFKIT, GVPROXY, VFKIT_MIN_VERSION };
