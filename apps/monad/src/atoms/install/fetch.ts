// Real fetchers for the install pipeline. github uses the contents API (raw media type) so no
// tar extraction is needed and private repos work with a token. local reads a staged dir (dev /
// offline). npm downloads + extracts the registry tarball (npm packs files under `package/`).

import type { AtomPackFetcher, FileAtoms, StagedAtomPack } from '@/atoms/install/index.ts';
import type { AtomPackSource } from '@/atoms/install/source.ts';
import type { DownloadProgress } from '@/services/download.ts';

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

import { InstallError } from '@/atoms/install/index.ts';
import { untar } from '@/atoms/install/untar.ts';
import { downloadBytes } from '@/services/download.ts';

// Untrusted downloaded/staged JSON — parsed (not cast) on read. The atom-pack.json read here only
// needs `entry` to locate the bundle; the full manifest is validated later by parseAtomPackManifest.
const stagedManifestSchema = z.object({ entry: z.string().optional() }).loose();
const mcpJsonSchema = z.object({ mcpServers: z.record(z.string(), z.unknown()).optional() });

export interface FetcherOptions {
  /** Token for private GitHub repos (from auth.json.atomRegistries.github or ${env:GITHUB_TOKEN}). */
  githubToken?: string;
  /** npm registry token + base URL (private packages). */
  npmToken?: string;
  npmRegistry?: string;
  onDownloadProgress?: (progress: DownloadProgress & { source: string }) => void;
}

const ENTRY_DEFAULT = 'dist/atom-pack.js';

/** Scan a flat file map (path → bytes) for file-based atoms under a given path prefix. */
function scanFileMap(files: Map<string, Uint8Array>, prefix: string): FileAtoms {
  const skills = new Set<string>();
  const mcpServers = new Set<string>();
  const locales = new Set<string>();
  const p = prefix.endsWith('/') ? prefix : `${prefix}/`;

  for (const path of files.keys()) {
    if (!path.startsWith(p)) continue;
    const rel = path.slice(p.length);
    // skills/<name>/SKILL.md
    const skillMatch = rel.match(/^skills\/([^/]+)\/SKILL\.md$/);
    if (skillMatch?.[1]) skills.add(skillMatch[1]);
    // locales/<lng>/<anything>.json
    const localeMatch = rel.match(/^locales\/([^/]+)\//);
    if (localeMatch?.[1]) locales.add(localeMatch[1]);
  }

  // mcp.json at the package root
  const mcpBytes = files.get(`${p}mcp.json`);
  if (mcpBytes) {
    try {
      const parsed = mcpJsonSchema.parse(JSON.parse(new TextDecoder().decode(mcpBytes)));
      for (const name of Object.keys(parsed.mcpServers ?? {})) mcpServers.add(name);
    } catch {
      /* malformed mcp.json — skip */
    }
  }

  return { skills: [...skills].sort(), mcpServers: [...mcpServers].sort(), locales: [...locales].sort() };
}

/** Scan a local directory for file-based atoms. Non-fatal — returns empty on error. */
async function scanLocalDir(dir: string): Promise<FileAtoms> {
  const skills: string[] = [];
  const mcpServers: string[] = [];
  const locales: string[] = [];
  try {
    const skillsDir = join(dir, 'skills');
    const entries = await readdir(skillsDir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory() && (await Bun.file(join(skillsDir, e.name, 'SKILL.md')).exists())) skills.push(e.name);
    }
  } catch {
    /* dir absent */
  }
  try {
    const localesDir = join(dir, 'locales');
    const entries = await readdir(localesDir, { withFileTypes: true });
    for (const e of entries) if (e.isDirectory()) locales.push(e.name);
  } catch {
    /* dir absent */
  }
  try {
    const mcpPath = join(dir, 'mcp.json');
    const parsed = mcpJsonSchema.parse(JSON.parse(await Bun.file(mcpPath).text()));
    mcpServers.push(...Object.keys(parsed.mcpServers ?? {}));
  } catch {
    /* absent or malformed */
  }
  return { skills: skills.sort(), mcpServers: mcpServers.sort(), locales: locales.sort() };
}

async function fetchLocal(path: string): Promise<StagedAtomPack> {
  const manifestRaw = stagedManifestSchema.parse(JSON.parse(await Bun.file(join(path, 'atom-pack.json')).text()));
  const bundle = await Bun.file(join(path, manifestRaw.entry ?? ENTRY_DEFAULT)).bytes();
  const fileAtoms = await scanLocalDir(path);
  return { manifestRaw, bundle, fileAtoms };
}

async function fetchGithub(
  source: Extract<AtomPackSource, { kind: 'github' }>,
  opts: FetcherOptions
): Promise<StagedAtomPack> {
  const get = async (filePath: string): Promise<Uint8Array> => {
    const url = `https://api.github.com/repos/${source.owner}/${source.repo}/contents/${filePath}?ref=${encodeURIComponent(source.ref)}`;
    const headers = {
      Accept: 'application/vnd.github.raw',
      'User-Agent': 'monad',
      ...(opts.githubToken ? { Authorization: `Bearer ${opts.githubToken}` } : {})
    };
    return (
      await downloadBytes(url, {
        headers,
        allowedContentTypes: [
          'application/vnd.github.raw',
          'application/octet-stream',
          'application/json',
          'text/plain'
        ],
        onProgress: (progress) => opts.onDownloadProgress?.({ ...progress, source: url })
      }).catch((error: unknown) => {
        throw new InstallError(
          `github fetch ${filePath}@${source.ref} failed: ${error instanceof Error ? error.message : String(error)}`
        );
      })
    ).bytes;
  };

  const manifestRaw = stagedManifestSchema.parse(JSON.parse(new TextDecoder().decode(await get('atom-pack.json'))));
  const bundle = await get(manifestRaw.entry ?? ENTRY_DEFAULT);

  // Best-effort: scan tree for file-based atoms (one extra API call; non-fatal on failure).
  let fileAtoms: FileAtoms | undefined;
  try {
    const treeUrl = `https://api.github.com/repos/${source.owner}/${source.repo}/git/trees/${encodeURIComponent(source.ref)}?recursive=1`;
    const treeRes = await fetch(treeUrl, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'monad',
        ...(opts.githubToken ? { Authorization: `Bearer ${opts.githubToken}` } : {})
      }
    });
    if (treeRes.ok) {
      const tree = (await treeRes.json()) as { tree?: { path?: string; type?: string }[] };
      const fakeMap = new Map<string, Uint8Array>();
      for (const node of tree.tree ?? []) {
        if (node.path && node.type === 'blob') fakeMap.set(`pkg/${node.path}`, new Uint8Array(0));
      }
      // Also try to fetch mcp.json for server names
      const mcpBytes = await get('mcp.json').catch(() => undefined);
      if (mcpBytes) fakeMap.set('pkg/mcp.json', mcpBytes);
      fileAtoms = scanFileMap(fakeMap, 'pkg');
    }
  } catch {
    /* non-fatal */
  }

  return { manifestRaw, bundle, fileAtoms };
}

async function fetchNpm(
  source: Extract<AtomPackSource, { kind: 'npm' }>,
  opts: FetcherOptions
): Promise<StagedAtomPack> {
  const registry = (opts.npmRegistry ?? 'https://registry.npmjs.org').replace(/\/+$/, '');
  const auth: Record<string, string> = opts.npmToken ? { Authorization: `Bearer ${opts.npmToken}` } : {};

  const metaRes = await fetch(`${registry}/${source.name.replace('/', '%2F')}`, { headers: auth });
  if (!metaRes.ok) throw new InstallError(`npm metadata ${source.name} failed: ${metaRes.status}`);
  const meta = (await metaRes.json()) as { versions?: Record<string, { dist?: { tarball?: string } }> };
  const tarUrl = meta.versions?.[source.version]?.dist?.tarball;
  if (!tarUrl) throw new InstallError(`npm: ${source.name}@${source.version} not found`);

  const { bytes } = await downloadBytes(tarUrl, {
    headers: auth,
    accept: 'application/gzip, application/x-gzip, application/octet-stream',
    allowedContentTypes: ['application/gzip', 'application/x-gzip', 'application/octet-stream'],
    onProgress: (progress) => opts.onDownloadProgress?.({ ...progress, source: tarUrl })
  }).catch((error: unknown) => {
    throw new InstallError(`npm tarball fetch failed: ${error instanceof Error ? error.message : String(error)}`);
  });
  const files = untar(Bun.gunzipSync(bytes as Uint8Array<ArrayBuffer>));

  const read = (p: string): Uint8Array | undefined => files.get(`package/${p}`);
  const manifestBytes = read('atom-pack.json');
  if (!manifestBytes) throw new InstallError('npm package has no atom-pack.json');
  const manifestRaw = stagedManifestSchema.parse(JSON.parse(new TextDecoder().decode(manifestBytes)));
  const bundle = read(manifestRaw.entry ?? ENTRY_DEFAULT);
  if (!bundle) throw new InstallError(`npm package entry "${manifestRaw.entry ?? ENTRY_DEFAULT}" missing`);
  const fileAtoms = scanFileMap(files, 'package');
  return { manifestRaw, bundle, fileAtoms };
}

export function createAtomFetcher(opts: FetcherOptions = {}): AtomPackFetcher {
  return async (source) => {
    switch (source.kind) {
      case 'local':
        return fetchLocal(source.path);
      case 'github':
        return fetchGithub(source, opts);
      case 'npm':
        return fetchNpm(source, opts);
    }
  };
}
