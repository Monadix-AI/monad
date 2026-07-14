// The VM backend's host tooling, resolved per platform when backend:'vm' is selected (a user who
// never selects it pays nothing):
//   • macOS → vfkit (Virtualization.framework front-end) + gvproxy. Detect a host copy (podman/crc
//     bundle them) or download the pinned release, verifying the virtualization entitlement + sha256.
//   • Linux → qemu-system-<arch> (user-installed, too large to vendor) + gvproxy + virtiofsd + socat
//     + an OVMF/edk2 firmware, all detected from the host; plus a /dev/kvm probe.
//   • Windows → winvm-helper (our vendored Go binary: Hyper-V lifecycle over WMI, KVP Ignition
//     injection, hvsock⇄TCP exec bridge, 9p-over-hvsock file server) + gvproxy-windows. Hyper-V
//     itself (Pro/Enterprise/Education) is probed by the helper in prepare().
//
// Downloaded pins are hard-coded (version + sha256); a mismatch fails closed rather than running an
// unknown binary. Regenerate with scripts/pin-vm-toolchain.ts when bumping a version.

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
  /** Windows: explicit winvm-helper path override (skips the vendored binary). */
  winvmHelperPath?: string;
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

// gvproxy ships one asset per platform+arch. macOS is a universal `gvproxy-darwin`; Linux is per-arch.
const GVPROXY_BASE = 'https://github.com/containers/gvisor-tap-vsock/releases/download/v0.8.9';
const GVPROXY_PINS: Record<string, ToolPin> = {
  'darwin-*': {
    version: 'v0.8.9',
    url: `${GVPROXY_BASE}/gvproxy-darwin`,
    sha256: 'c6f7b4bc7f21bf810b5cf54e04d979b014c5d96472a03a9e97fe62a00940067c',
    needsEntitlement: false
  },
  'linux-arm64': {
    version: 'v0.8.9',
    url: `${GVPROXY_BASE}/gvproxy-linux-arm64`,
    sha256: '6ecca02839254c9a0cc184bba7aac63755a22d7ed10d455b852528a99d7f7d4b',
    needsEntitlement: false
  },
  'linux-x64': {
    version: 'v0.8.9',
    url: `${GVPROXY_BASE}/gvproxy-linux-amd64`,
    sha256: '3011c5629c9138d2050fb23c510e09ae53e30ec52e6a9ab85632bc1550e8ef63',
    needsEntitlement: false
  },
  // The console-subsystem builds (`make cross`), not the -windowsgui ones — we own the process
  // lifecycle and want stderr; gvproxy on Windows is stopped via winquit/taskkill, not signals.
  'win32-x64': {
    version: 'v0.8.9',
    url: `${GVPROXY_BASE}/gvproxy-windows.exe`,
    sha256: 'a3b6915d8a976f5ed2bbba727af52c90c55b9d5e85f680b584c8a1c5d6b546bc',
    needsEntitlement: false
  },
  'win32-arm64': {
    version: 'v0.8.9',
    url: `${GVPROXY_BASE}/gvproxy-windows-arm64.exe`,
    sha256: 'a00867aaf0a6694877d3261d0c8e6df5dcfe8eec2fb4b81a084d2bf7a65d7ae8',
    needsEntitlement: false
  }
};
function gvproxyPin(): ToolPin {
  const key = process.platform === 'darwin' ? 'darwin-*' : `${process.platform}-${process.arch}`;
  const pin = GVPROXY_PINS[key];
  if (!pin) throw new Error(`vm toolchain: no gvproxy pin for ${process.platform}/${process.arch}`);
  return pin;
}

const GVPROXY: ToolPin = GVPROXY_PINS['darwin-*'] as ToolPin;

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

async function detectHostTool(binName: string, validate: (p: string) => Promise<boolean>): Promise<string | null> {
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
  binName: string,
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
  // Strip the download quarantine so the binary runs without a Gatekeeper prompt (macOS only —
  // `xattr` does not exist elsewhere and Bun.spawn throws synchronously on a missing executable).
  if (process.platform === 'darwin') await stripQuarantine(dest);
  // The crc-org release ships signed WITH the virtualization entitlement, so normally no re-sign is
  // needed — only adhoc re-sign (replacing the upstream signature) if the entitlement is somehow
  // absent, so we never run vfkit without it.
  if (pin.needsEntitlement && !(await hasVirtualizationEntitlement(dest))) {
    await adhocSignWithEntitlement(dest);
  }
  return dest;
}

// ── Linux (QEMU) toolchain detection ────────────────────────────────────────────────────────────
// The Linux driver is QEMU (see driver/qemu.ts): detect the host binaries — qemu is user-installed
// (too large to vendor), gvproxy downloads if absent, virtiofsd/socat/firmware are distro-provided.

const LINUX_BIN_DIRS = [
  '/usr/bin',
  '/usr/local/bin',
  '/usr/sbin',
  '/usr/libexec',
  '/usr/lib/qemu',
  '/usr/libexec/podman'
];

/** Find an executable by name on PATH + the common Linux dirs. */
function findLinuxBin(name: string): string | null {
  for (const dir of [...(Bun.env.PATH?.split(':') ?? []), ...LINUX_BIN_DIRS]) {
    if (!dir) continue;
    const p = join(dir, name);
    try {
      accessSync(p, constants.X_OK);
      return p;
    } catch {
      /* next */
    }
  }
  return null;
}

/** EFI firmware for QEMU: the CODE image (readonly pflash) + a VARS template each VM copies to a
 *  writable pflash. On aarch64 `virt` BOTH pflash devices must be exactly 64 MiB, so we must pick the
 *  padded `*-pflash.raw` images, not the raw 2 MiB `.fd` code. */
export interface Firmware {
  code: string;
  vars: string;
}
function findFirmware(): Firmware | null {
  const sets: Firmware[] =
    process.arch === 'x64'
      ? [
          { code: '/usr/share/edk2/ovmf/OVMF_CODE.fd', vars: '/usr/share/edk2/ovmf/OVMF_VARS.fd' },
          { code: '/usr/share/OVMF/OVMF_CODE.fd', vars: '/usr/share/OVMF/OVMF_VARS.fd' }
        ]
      : [
          {
            code: '/usr/share/edk2/aarch64/QEMU_EFI-pflash.raw',
            vars: '/usr/share/edk2/aarch64/vars-template-pflash.raw'
          },
          { code: '/usr/share/AAVMF/AAVMF_CODE.fd', vars: '/usr/share/AAVMF/AAVMF_VARS.fd' }
        ];
  return sets.find((f) => existsSync(f.code) && existsSync(f.vars)) ?? null;
}

/** /dev/kvm present and read/write accessible → hardware acceleration available. */
function kvmAvailable(): boolean {
  try {
    accessSync('/dev/kvm', constants.R_OK | constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

const QEMU_BIN = process.arch === 'x64' ? 'qemu-system-x86_64' : 'qemu-system-aarch64';

export interface ResolvedToolchain {
  /** The hypervisor front-end: vfkit on macOS, qemu-system-<arch> on Linux, winvm-helper on Windows
   *  (Hyper-V is the hypervisor; the helper is our WMI/hvsock/9p front-end to it). */
  hypervisor: string;
  gvproxy: string;
  /** Linux only: virtio-fs daemon, vsock bridge, EFI firmware (code + vars template). */
  virtiofsd?: string;
  socat?: string;
  firmware?: Firmware;
  /** Linux only: whether /dev/kvm is usable (false → slow TCG emulation). */
  kvm?: boolean;
}

let cached: ResolvedToolchain | null = null;

/** Resolve the platform toolchain (detect or download+verify). Cached after first success. Called from
 *  the launcher's prepare(); throws if a required tool can't be made available. */
export async function resolveVmToolchain(): Promise<ResolvedToolchain> {
  if (cached) return cached;
  cached =
    process.platform === 'darwin'
      ? await resolveDarwin()
      : process.platform === 'win32'
        ? await resolveWindows()
        : await resolveLinux();
  return cached;
}

async function resolveDarwin(): Promise<ResolvedToolchain> {
  const [hypervisor, gvproxy] = await Promise.all([
    resolveTool('vfkit', VFKIT, config.vfkitPath, vfkitUsable),
    resolveTool('gvproxy', gvproxyPin(), config.gvproxyPath, gvproxyUsable)
  ]);
  return { hypervisor, gvproxy };
}

async function resolveLinux(): Promise<ResolvedToolchain> {
  if (process.platform !== 'linux') throw new Error('vm toolchain: the VM backend requires darwin or linux');
  const qemu = config.vfkitPath ?? findLinuxBin(QEMU_BIN);
  if (!qemu) throw new Error(`vm toolchain: ${QEMU_BIN} not found — install QEMU (e.g. dnf install qemu-kvm)`);
  const virtiofsd = findLinuxBin('virtiofsd');
  if (!virtiofsd) throw new Error('vm toolchain: virtiofsd not found — install it (e.g. dnf install virtiofsd)');
  const socat = findLinuxBin('socat');
  if (!socat) throw new Error('vm toolchain: socat not found — install it (needed for the vsock bridge)');
  const firmware = findFirmware();
  if (!firmware) throw new Error('vm toolchain: no OVMF/edk2 firmware found — install edk2-ovmf / AAVMF');
  const gvproxy = config.gvproxyPath ?? (await resolveTool('gvproxy', gvproxyPin(), undefined, gvproxyUsable));
  return { hypervisor: qemu, gvproxy, virtiofsd, socat, firmware, kvm: kvmAvailable() };
}

// ── Windows (Hyper-V) toolchain detection ───────────────────────────────────────────────────────
// The host plane is winvm-helper, our vendored Go binary (Bun has no AF_HYPERV or WMI access):
// VM lifecycle via WMI (libhvee), Ignition over KVP, an hvsock⇄TCP bridge for the exec channel, and
// a 9p-over-hvsock file server for mounts. Hyper-V itself (Pro/Enterprise/Education, one-time
// elevated setup) is probed by the helper in prepare(); here we only locate binaries.

const WINVM_HELPER_ARCH = process.arch === 'x64' ? 'amd64' : 'arm64';

/** The vendored winvm-helper (next to the package, like the guest vsock agents). */
export function vendoredWinvmHelper(): string {
  return join(dirname(import.meta.dir), 'vendor', `winvm-helper-${WINVM_HELPER_ARCH}.exe`);
}

async function resolveWindows(): Promise<ResolvedToolchain> {
  const helper = config.winvmHelperPath ?? vendoredWinvmHelper();
  if (!existsSync(helper)) {
    throw new Error(
      `vm toolchain: winvm-helper not found at ${helper} — run scripts/build-winvm-helper.sh (requires Go) or set sandbox.vm.winvmHelperPath`
    );
  }
  const gvproxy = config.gvproxyPath ?? (await resolveTool('gvproxy.exe', gvproxyPin(), undefined, gvproxyUsable));
  return { hypervisor: helper, gvproxy };
}

/** Sync availability probe for isAvailable(): the host looks capable of running the backend. The
 *  authoritative check (entitlement/sha on mac, real tool resolution on Linux, Hyper-V probe on
 *  Windows) runs in prepare(). */
export function vmToolchainMaybeAvailable(): boolean {
  if (cached) return true;
  if (process.platform === 'darwin') {
    if (config.vfkitPath && config.gvproxyPath) return true;
    if (existsSync(join(vmBinDir(), 'vfkit')) && existsSync(join(vmBinDir(), 'gvproxy'))) return true;
    return detectRoots().some((r) => existsSync(join(r, 'vfkit')));
  }
  if (process.platform === 'linux') {
    // Needs KVM + QEMU at minimum; the rest is checked authoritatively in prepare().
    return kvmAvailable() && findLinuxBin(QEMU_BIN) !== null;
  }
  if (process.platform === 'win32') {
    // The helper must be present; whether Hyper-V is enabled is the helper's probe in prepare().
    return existsSync(config.winvmHelperPath ?? vendoredWinvmHelper());
  }
  return false;
}

/** Test seam: reset the resolved cache. */
export function __resetVmToolchainForTest(): void {
  cached = null;
  config = {};
}

// Exposed for the pin script + unit tests.
export const __pins = { VFKIT, GVPROXY, GVPROXY_PINS, VFKIT_MIN_VERSION };
