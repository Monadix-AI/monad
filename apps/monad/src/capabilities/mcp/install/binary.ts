// Install a prebuilt MCP server BINARY from a GitHub release as a hot atoms/mcp atom: pick the asset
// for this platform/arch → MANDATORY SHA256 verify (a binary can't be statically scanned, so the
// hash is the only tamper guard) → default-deny consent → extract (.tar.gz) or store raw → chmod +x
// under atoms/mcp/<name>/bin/ → write atoms/mcp/<name>.json pointing `command` at the absolute path.
// A re-scan then connects it live. The asset fetch is injected so installs are testable offline.
//
// SECURITY: the binary runs UNSANDBOXED — same risk profile as an npx/uvx stdio server today. The
// SHA256 pin guarantees you run the exact bytes the publisher named; sandboxing every stdio MCP spawn
// is a separate, cross-cutting hardening (apps/monad/src/capabilities/tools/mcp.ts).

import { chmod, mkdir } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { untar } from '@/atoms/install/untar.ts';
import { unzip } from '@/capabilities/mcp/install/unzip.ts';
import { type DownloadProgress, downloadBytes } from '@/services/download.ts';

export class McpBinaryInstallError extends Error {}

export interface ReleaseSource {
  owner: string;
  repo: string;
  tag: string;
}

interface ReleaseAsset {
  name: string;
  bytes: Uint8Array;
  /** assetName → hex sha256, parsed from a SHA256SUMS/checksums asset in the release (if present),
   *  so the install can verify automatically when the caller didn't supply an explicit hash. */
  checksums?: Map<string, string>;
}

/** Parse a `sha256sum`-style checksums file: `<64-hex>  <filename>` (or ` *filename`) per line. */
export function parseChecksums(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of text.split('\n')) {
    const m = line.trim().match(/^([0-9a-f]{64})\s+\*?(.+)$/i);
    if (m?.[1] && m[2]) map.set(m[2].trim(), m[1].toLowerCase());
  }
  return map;
}

export type ReleaseAssetFetcher = (
  source: ReleaseSource,
  platform: NodeJS.Platform,
  arch: string
) => Promise<ReleaseAsset>;

export interface InstallMcpBinaryDeps {
  /** atoms/mcp — the global-tier MCP atom dir (paths.mcp). */
  mcpDir: string;
  fetch: ReleaseAssetFetcher;
  /** Expected SHA-256 of the asset (hex). When absent, the release's SHA256SUMS asset is used instead;
   *  if neither is available the install aborts (a binary is never run unverified). */
  expectedSha256?: string;
  /** Default-deny: must return true to proceed (after the asset is fetched + hash-verified). */
  consent: (info: { name: string; assetName: string; warnings: string[] }) => boolean | Promise<boolean>;
  /** Args passed to the binary when the agent connects (e.g. ['stdio']). */
  args?: string[];
  autoApproveTools?: string[];
  /** Executable name inside an archive (defaults to the repo/name heuristic). */
  binName?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  log?: (level: 'info' | 'warn' | 'error', msg: string) => void;
}

const SAFE_NAME = /^[a-z0-9][a-z0-9._-]*$/i;
const ARCHIVE_RE = /\.(tar\.gz|tgz)$/i;
const ZIP_RE = /\.zip$/i;

function sha256Hex(bytes: Uint8Array): string {
  return new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
}

/** Bun's zlib types want an ArrayBuffer-backed view; normalize (copies only a non-ArrayBuffer view). */
function asArrayBuffer(u: Uint8Array): Uint8Array<ArrayBuffer> {
  return (u.buffer instanceof ArrayBuffer ? u : new Uint8Array(u)) as Uint8Array<ArrayBuffer>;
}

/** Tokens that identify a release asset for a given platform/arch. */
function platformTokens(platform: NodeJS.Platform): string[] {
  if (platform === 'darwin') return ['darwin', 'macos', 'apple', 'osx', 'mac'];
  if (platform === 'win32') return ['windows', 'win64', 'win32', 'win'];
  return ['linux'];
}
function archTokens(arch: string): string[] {
  if (arch === 'arm64') return ['arm64', 'aarch64'];
  if (arch === 'x64') return ['x64', 'amd64', 'x86_64', 'x86-64'];
  return [arch];
}

/** Pick the asset matching this platform AND arch, preferring an archive/raw binary over a checksum
 *  or signature sidecar. Returns null when nothing fits (caller errors with the available names). */
export function selectReleaseAsset(names: string[], platform: NodeJS.Platform, arch: string): string | null {
  const plat = platformTokens(platform);
  const ar = archTokens(arch);
  const candidates = names.filter((n) => {
    const low = n.toLowerCase();
    if (/\.(sha256|sha256sum|sha256sums|asc|sig|pem|txt|md)$/i.test(low) || /checksums?/i.test(low)) return false;
    return plat.some((p) => low.includes(p)) && ar.some((a) => low.includes(a));
  });
  // Prefer an archive (predictable single-binary layout) over a bare file when both match.
  return candidates.find((n) => ARCHIVE_RE.test(n) || ZIP_RE.test(n)) ?? candidates[0] ?? null;
}

/** Resolve the executable bytes + filename from the fetched asset: a .tar.gz / .zip is unpacked and
 *  the `binName` (or repo-named, or sole) entry chosen; anything else is treated as the raw binary. */
function resolveBinary(
  asset: ReleaseAsset,
  source: ReleaseSource,
  binName?: string
): { file: string; bytes: Uint8Array } {
  let entries: [string, Uint8Array][] | null = null;
  if (ZIP_RE.test(asset.name)) {
    entries = [...unzip(asset.bytes)].filter(([p]) => !p.endsWith('/'));
  } else if (ARCHIVE_RE.test(asset.name)) {
    entries = [...untar(Bun.gunzipSync(asArrayBuffer(asset.bytes)))].filter(([p]) => !p.endsWith('/'));
  }
  if (!entries) return { file: binName ?? source.repo, bytes: asset.bytes }; // raw binary asset

  if (entries.length === 0) throw new McpBinaryInstallError(`archive ${asset.name} is empty`);
  const want = binName ?? source.repo;
  const hit = entries.find(([p]) => basename(p) === want) ?? (entries.length === 1 ? entries[0] : undefined);
  if (!hit) {
    throw new McpBinaryInstallError(
      `cannot pick the binary in ${asset.name} — pass binName (entries: ${entries.map(([p]) => basename(p)).join(', ')})`
    );
  }
  return { file: basename(hit[0]), bytes: hit[1] };
}

/** Windows can only launch a binary when the path carries an executable extension. A raw asset (or an
 *  archive entry) named without one is unlaunchable via `command: binPath`, so default it to `.exe`. */
const WIN_EXEC_EXT_RE = /\.(exe|cmd|bat|com)$/i;
function ensureExecutableExtension(file: string, platform: NodeJS.Platform): string {
  if (platform !== 'win32') return file;
  return WIN_EXEC_EXT_RE.test(file) ? file : `${file}.exe`;
}

export interface InstallMcpBinaryOutcome {
  name: string;
  assetName: string;
  needsConsent?: boolean;
  warnings: string[];
}

export async function installMcpBinary(
  name: string,
  source: ReleaseSource,
  deps: InstallMcpBinaryDeps
): Promise<InstallMcpBinaryOutcome> {
  if (!SAFE_NAME.test(name)) throw new McpBinaryInstallError(`invalid MCP server name: ${name}`);
  const platform = deps.platform ?? process.platform;
  const arch = deps.arch ?? process.arch;

  const asset = await deps.fetch(source, platform, arch);

  // Integrity FIRST — abort before any prompt or disk write. Verify against the caller's explicit
  // hash, or the release's SHA256SUMS asset; refuse to run an unverifiable binary.
  const expected = (deps.expectedSha256 ?? asset.checksums?.get(asset.name))?.toLowerCase();
  if (!expected) {
    throw new McpBinaryInstallError(
      `cannot verify ${asset.name}: pass sha256, or the release must publish a SHA256SUMS/checksums asset`
    );
  }
  const got = sha256Hex(asset.bytes);
  if (got !== expected) {
    throw new McpBinaryInstallError(`SHA-256 mismatch for ${asset.name}: ${got} ≠ ${expected}`);
  }

  const warnings = [`runs a downloaded binary (${asset.name}) on your machine when the agent uses it`];
  const granted = await deps.consent({ name, assetName: asset.name, warnings });
  if (!granted) return { name, assetName: asset.name, needsConsent: true, warnings };

  const { file: rawFile, bytes } = resolveBinary(asset, source, deps.binName);
  const file = ensureExecutableExtension(rawFile, platform);
  const binDir = join(deps.mcpDir, name, 'bin');
  await mkdir(binDir, { recursive: true });
  const binPath = join(binDir, file);
  await Bun.write(binPath, bytes);
  if (platform !== 'win32') await chmod(binPath, 0o755);

  const entry = {
    command: binPath,
    args: deps.args,
    trust: { autoApproveTools: deps.autoApproveTools ?? [] }
  };
  await Bun.write(join(deps.mcpDir, `${name}.json`), `${JSON.stringify({ mcpServers: { [name]: entry } }, null, 2)}\n`);
  deps.log?.(
    'info',
    `installed MCP binary "${name}" from ${source.owner}/${source.repo}@${source.tag} (${asset.name})`
  );
  return { name, assetName: asset.name, warnings };
}

export type ReleaseAssetDownloadProgress = DownloadProgress & { assetName: string };

/** Real fetcher: resolve the release by tag, pick the platform/arch asset, download its bytes. */
export function createReleaseAssetFetcher(
  opts: { githubToken?: string; onDownloadProgress?: (progress: ReleaseAssetDownloadProgress) => void } = {}
): ReleaseAssetFetcher {
  const headers = {
    'User-Agent': 'monad',
    Accept: 'application/vnd.github+json',
    ...(opts.githubToken ? { Authorization: `Bearer ${opts.githubToken}` } : {})
  };
  return async (source, platform, arch) => {
    const relUrl = `https://api.github.com/repos/${source.owner}/${source.repo}/releases/tags/${encodeURIComponent(source.tag)}`;
    const relRes = await fetch(relUrl, { headers });
    if (!relRes.ok)
      throw new McpBinaryInstallError(
        `github release ${source.owner}/${source.repo}@${source.tag} failed: ${relRes.status}`
      );
    const release = (await relRes.json()) as { assets?: { name: string; browser_download_url: string }[] };
    const assets = release.assets ?? [];
    const chosen = selectReleaseAsset(
      assets.map((a) => a.name),
      platform,
      arch
    );
    if (!chosen)
      throw new McpBinaryInstallError(
        `no release asset for ${platform}/${arch} in ${source.owner}/${source.repo}@${source.tag} (have: ${assets.map((a) => a.name).join(', ') || 'none'})`
      );
    const asset = assets.find((a) => a.name === chosen);
    if (!asset) throw new McpBinaryInstallError(`release asset ${chosen} not found`);
    const dlHeaders = {
      'User-Agent': 'monad',
      ...(opts.githubToken ? { Authorization: `Bearer ${opts.githubToken}` } : {})
    };
    const download = await downloadBytes(asset.browser_download_url, {
      headers: dlHeaders,
      accept: 'application/gzip, application/zip, application/octet-stream',
      allowedContentTypes: ['application/gzip', 'application/x-gzip', 'application/zip', 'application/octet-stream'],
      onProgress: (progress) => opts.onDownloadProgress?.({ ...progress, assetName: chosen })
    }).catch((error: unknown) => {
      throw new McpBinaryInstallError(error instanceof Error ? error.message : String(error));
    });

    // Best-effort: a SHA256SUMS/checksums asset lets the install verify without a caller-supplied hash.
    const sums = assets.find((a) => /(^|[._-])(sha256sums?|checksums?)(\.txt)?$/i.test(a.name));
    let checksums: Map<string, string> | undefined;
    if (sums) {
      const sumRes = await fetch(sums.browser_download_url, { headers: dlHeaders }).catch(() => null);
      if (sumRes?.ok) checksums = parseChecksums(await sumRes.text());
    }
    return { name: chosen, bytes: download.bytes, checksums };
  };
}
