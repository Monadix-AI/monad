// Detect and install runtime tools (Node.js, uv) that MCP servers need but may be absent on the
// target machine — especially relevant for a standalone binary install where node/uv are not
// guaranteed. Called by the daemon handler for POST /init/env-deps (triggered interactively during
// `monad init`). The daemon startup only does PATH prepending — no downloads, no detection.

import type { Logger } from '@monad/logger';
import type { DownloadProgress } from '#/services/download.ts';

import { existsSync } from 'node:fs';
import { chmod, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

import { untar } from '#/atoms/install/untar.ts';
import { parseChecksums, selectReleaseAsset } from '#/capabilities/mcp/install/binary.ts';
import { downloadBytes } from '#/services/download.ts';

type EnvDepResult = 'found' | 'installed' | 'failed' | 'skipped';
type EnvDepsDownloadProgress = DownloadProgress & { dependency: 'node' | 'uv'; artifact: string };
const nodeIndexSchema = z.array(z.object({ version: z.string(), lts: z.union([z.string(), z.literal(false)]) }));
const uvReleaseSchema = z.object({
  tag_name: z.string(),
  assets: z.array(z.object({ name: z.string(), browser_download_url: z.string() }))
});

// ─── Node.js ─────────────────────────────────────────────────────────────────

function nodeBinName(file: 'node' | 'npx'): string {
  return process.platform === 'win32' ? `${file}.exe` : file;
}

function nodePlatformStr(): string {
  if (process.platform === 'darwin') return 'darwin';
  if (process.platform === 'win32') return 'win';
  return 'linux';
}

function nodeArchStr(arch: string): string {
  if (arch === 'arm64') return 'arm64';
  return 'x64';
}

async function resolveNodeVersion(): Promise<string> {
  const res = await fetch('https://nodejs.org/dist/index.json', {
    signal: AbortSignal.timeout(15_000),
    headers: { 'User-Agent': 'monad' }
  });
  if (!res.ok) throw new Error(`nodejs.org index fetch failed: ${res.status}`);
  const index = nodeIndexSchema.parse(await res.json());
  const lts = index.find((e) => e.lts !== false);
  if (!lts) throw new Error('no LTS version found in nodejs.org index');
  return lts.version; // e.g. "v22.13.1"
}

async function ensureNode(
  binDir: string,
  log: Logger,
  onDownloadProgress?: (progress: EnvDepsDownloadProgress) => void
): Promise<EnvDepResult> {
  const nodeBin = join(binDir, nodeBinName('node'));

  // Already installed by us — skip. Don't re-check PATH: PATH varies; our binDir is canonical.
  if (existsSync(nodeBin)) return 'found';

  // Not installed — download Node.js LTS.
  if (process.platform === 'win32') {
    log.warn('env-deps: Node.js auto-install not supported on Windows — install Node.js manually');
    return 'failed';
  }

  const platform = nodePlatformStr();
  const arch = nodeArchStr(process.arch);
  const version = await resolveNodeVersion();
  const archiveName = `node-${version}-${platform}-${arch}.tar.gz`;
  const baseUrl = `https://nodejs.org/dist/${version}`;

  log.info(`env-deps: downloading Node.js ${version}…`);

  const [download, sumsRes] = await Promise.all([
    downloadBytes(`${baseUrl}/${archiveName}`, {
      headers: { 'User-Agent': 'monad' },
      accept: 'application/gzip, application/x-gzip, application/octet-stream',
      allowedContentTypes: ['application/gzip', 'application/x-gzip', 'application/octet-stream'],
      timeoutMs: 120_000,
      onProgress: (progress) => onDownloadProgress?.({ ...progress, dependency: 'node', artifact: archiveName })
    }),
    fetch(`${baseUrl}/SHASUMS256.txt`, {
      signal: AbortSignal.timeout(15_000),
      headers: { 'User-Agent': 'monad' }
    }).catch(() => null)
  ]);
  const { bytes } = download;

  // Verify checksum when SHASUMS256.txt is available.
  if (sumsRes?.ok) {
    const checksums = parseChecksums(await sumsRes.text());
    const expected = checksums.get(archiveName)?.toLowerCase();
    if (expected) {
      const got = new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
      if (got !== expected) throw new Error(`Node.js SHA-256 mismatch for ${archiveName}: ${got} ≠ ${expected}`);
    }
  } else {
    log.warn('env-deps: SHASUMS256.txt unavailable — proceeding on HTTPS trust');
  }

  // Extract bin/node and bin/npx from the tar.gz.
  const files = untar(Bun.gunzipSync(bytes as Uint8Array<ArrayBuffer>));
  await mkdir(binDir, { recursive: true });

  for (const target of ['node', 'npx'] as const) {
    const entry = [...files.entries()].find(([k]) => k.endsWith(`/bin/${target}`));
    if (!entry) throw new Error(`${target} not found in Node.js archive`);
    const dest = join(binDir, nodeBinName(target));
    await Bun.write(dest, entry[1]);
    await chmod(dest, 0o755);
  }

  log.info(`env-deps: Node.js ${version} installed to ${binDir}`);
  return 'installed';
}

// ─── uv ──────────────────────────────────────────────────────────────────────

function uvBinName(file: 'uv' | 'uvx'): string {
  return process.platform === 'win32' ? `${file}.exe` : file;
}

async function ensureUv(
  binDir: string,
  log: Logger,
  onDownloadProgress?: (progress: EnvDepsDownloadProgress) => void
): Promise<EnvDepResult> {
  const uvBin = join(binDir, uvBinName('uv'));
  if (existsSync(uvBin)) return 'found';

  const headers = { 'User-Agent': 'monad', Accept: 'application/vnd.github+json' };
  const relRes = await fetch('https://api.github.com/repos/astral-sh/uv/releases/latest', {
    signal: AbortSignal.timeout(15_000),
    headers
  });
  if (!relRes.ok) throw new Error(`uv latest release fetch failed: ${relRes.status}`);
  const release = uvReleaseSchema.parse(await relRes.json());
  const tag = release.tag_name;
  const assets = release.assets ?? [];

  const chosen = selectReleaseAsset(
    assets.map((a) => a.name),
    process.platform,
    process.arch
  );
  if (!chosen) throw new Error(`no uv release asset for ${process.platform}/${process.arch}`);
  const assetMeta = assets.find((a) => a.name === chosen);
  if (!assetMeta) throw new Error(`uv asset ${chosen} not in release`);

  log.info(`env-deps: downloading uv ${tag}…`);

  const { bytes } = await downloadBytes(assetMeta.browser_download_url, {
    headers: { 'User-Agent': 'monad' },
    accept: 'application/gzip, application/x-gzip, application/octet-stream',
    allowedContentTypes: ['application/gzip', 'application/x-gzip', 'application/octet-stream'],
    timeoutMs: 120_000,
    onProgress: (progress) => onDownloadProgress?.({ ...progress, dependency: 'uv', artifact: chosen })
  });

  // Best-effort checksum from the companion checksums asset.
  const sumsMeta = assets.find((a) => /(^|[._-])(sha256sums?|checksums?)(\.txt)?$/i.test(a.name));
  let checksums: Map<string, string> | undefined;
  if (sumsMeta) {
    const sumsRes = await fetch(sumsMeta.browser_download_url, {
      signal: AbortSignal.timeout(15_000),
      headers: { 'User-Agent': 'monad' }
    }).catch(() => null);
    if (sumsRes?.ok) checksums = parseChecksums(await sumsRes.text());
  }

  const expected = checksums?.get(chosen)?.toLowerCase();
  if (expected) {
    const got = new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
    if (got !== expected) throw new Error(`uv SHA-256 mismatch for ${chosen}: ${got} ≠ ${expected}`);
  } else {
    log.warn('env-deps: uv release published no checksums — proceeding on HTTPS trust');
  }

  const files = untar(Bun.gunzipSync(bytes as Uint8Array<ArrayBuffer>));
  await mkdir(binDir, { recursive: true });

  for (const target of ['uv', 'uvx'] as const) {
    const name = uvBinName(target);
    const entry = [...files.entries()].find(([k]) => {
      const base = k.split('/').pop() ?? '';
      return base === name || base === target; // handle with or without .exe
    });
    if (!entry) {
      if (target === 'uvx') {
        // uvx may be absent (symlink-only in some builds) — copy uv as uvx
        const uvDest = join(binDir, uvBinName('uv'));
        const uvxDest = join(binDir, name);
        await Bun.write(uvxDest, Bun.file(uvDest));
        await chmod(uvxDest, 0o755);
        continue;
      }
      throw new Error(`uv binary not found in archive ${chosen}`);
    }
    const dest = join(binDir, name);
    await Bun.write(dest, entry[1]);
    await chmod(dest, 0o755);
  }

  log.info(`env-deps: uv ${tag} installed to ${binDir}`);
  return 'installed';
}

// ─── Combined ─────────────────────────────────────────────────────────────────

export interface EnvDepsInstallResult {
  node: EnvDepResult;
  uv: EnvDepResult;
  errors?: Record<string, string>;
}

export interface EnvDepsInstallOptions {
  installNode?: boolean;
  installUv?: boolean;
  onDownloadProgress?: (progress: EnvDepsDownloadProgress) => void;
}

export async function installEnvDeps(
  binDir: string,
  opts: EnvDepsInstallOptions,
  log: Logger
): Promise<EnvDepsInstallResult> {
  const errors: Record<string, string> = {};

  const [node, uv] = await Promise.all([
    opts.installNode
      ? ensureNode(binDir, log, opts.onDownloadProgress).catch((err: unknown) => {
          errors.node = String(err);
          log.warn(`env-deps: node install failed: ${String(err)}`);
          return 'failed' as const;
        })
      : Promise.resolve('skipped' as const),
    opts.installUv
      ? ensureUv(binDir, log, opts.onDownloadProgress).catch((err: unknown) => {
          errors.uv = String(err);
          log.warn(`env-deps: uv install failed: ${String(err)}`);
          return 'failed' as const;
        })
      : Promise.resolve('skipped' as const)
  ]);

  return { node, uv, ...(Object.keys(errors).length ? { errors } : {}) };
}
