// Real fetchers for the install pipeline. github uses the contents API (raw media type) so no
// tar extraction is needed and private repos work with a token. local reads a staged dir (dev /
// offline). npm downloads + extracts the registry tarball (npm packs files under `package/`).

import type { Dirent } from 'node:fs';
import type { AtomPackFetcher, FileAtoms, StagedAtomPack } from '@/atoms/install/index.ts';
import type { AtomPackSource } from '@/atoms/install/source.ts';
import type { DownloadProgress } from '@/services/download.ts';

import { readdir } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { z } from 'zod';

import { InstallError } from '@/atoms/install/index.ts';
import { untar } from '@/atoms/install/untar.ts';
import { type DownloadFetch, downloadBytes } from '@/services/download.ts';

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
  fetch?: DownloadFetch;
  onDownloadProgress?: (progress: DownloadProgress & { source: string }) => void;
}

const ENTRY_DEFAULT = 'dist/atom-pack.js';
const GITHUB_FILE_ATOM_MAX_BYTES = 5 * 1024 * 1024;
const GITHUB_FILE_ATOM_TOTAL_MAX_BYTES = 25 * 1024 * 1024;
const GITHUB_FILE_ATOM_MAX_COUNT = 200;

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

async function collectLocalFiles(dir: string, prefix = ''): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>();
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  await Promise.all(
    entries.map(async (entry) => {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        for (const [childPath, bytes] of await collectLocalFiles(fullPath, path)) files.set(childPath, bytes);
      } else if (entry.isFile()) {
        files.set(path, await Bun.file(fullPath).bytes());
      }
    })
  );
  return files;
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
  const files = await collectLocalFiles(path);
  const fileAtoms = await scanLocalDir(path);
  return { manifestRaw, bundle, fileAtoms, files };
}

async function fetchGithub(
  source: Extract<AtomPackSource, { kind: 'github' }>,
  opts: FetcherOptions
): Promise<StagedAtomPack> {
  const root = source.path ? `${source.path.replace(/\/+$/, '')}/` : '';
  const get = async (filePath: string, maxBytes?: number): Promise<Uint8Array> => {
    const repoPath = `${root}${filePath}`;
    const url = `https://api.github.com/repos/${source.owner}/${source.repo}/contents/${repoPath}?ref=${encodeURIComponent(source.ref)}`;
    const headers = {
      Accept: 'application/vnd.github.raw',
      'User-Agent': 'monad',
      ...(opts.githubToken ? { Authorization: `Bearer ${opts.githubToken}` } : {})
    };
    return (
      await downloadBytes(url, {
        fetch: opts.fetch,
        headers,
        maxBytes,
        allowedContentTypes: [
          'application/vnd.github.raw',
          'application/octet-stream',
          'application/json',
          'text/plain'
        ],
        onProgress: (progress) => opts.onDownloadProgress?.({ ...progress, source: url })
      }).catch((error: unknown) => {
        if (filePath === 'atom-pack.json') {
          throw new InstallError(
            `github source ${source.owner}/${source.repo}@${source.ref}${source.path ? `/${source.path}` : ''} is not an installable atom pack: atom-pack.json not found`
          );
        }
        throw new InstallError(
          `github fetch ${repoPath}@${source.ref} failed: ${error instanceof Error ? error.message : String(error)}`
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
    const treeRes = await (opts.fetch ?? globalThis.fetch)(treeUrl, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'monad',
        ...(opts.githubToken ? { Authorization: `Bearer ${opts.githubToken}` } : {})
      }
    });
    if (treeRes.ok) {
      const tree = (await treeRes.json()) as { tree?: { path?: string; type?: string }[] };
      const fakeMap = new Map<string, Uint8Array>();
      const files = new Map<string, Uint8Array>();
      let fileAtomCount = 0;
      let fileAtomBytes = 0;
      const getFileAtom = async (relPath: string): Promise<Uint8Array | undefined> => {
        fileAtomCount += 1;
        if (fileAtomCount > GITHUB_FILE_ATOM_MAX_COUNT) {
          throw new InstallError(`github file atom scan exceeds ${GITHUB_FILE_ATOM_MAX_COUNT} files`);
        }
        const bytes = await get(relPath, GITHUB_FILE_ATOM_MAX_BYTES).catch((error: unknown) => {
          if (error instanceof Error && error.message.includes('exceeds')) throw error;
          return undefined;
        });
        if (!bytes) return undefined;
        fileAtomBytes += bytes.byteLength;
        if (fileAtomBytes > GITHUB_FILE_ATOM_TOTAL_MAX_BYTES) {
          throw new InstallError(`github file atom scan exceeds ${GITHUB_FILE_ATOM_TOTAL_MAX_BYTES} bytes`);
        }
        return bytes;
      };
      for (const node of tree.tree ?? []) {
        if (!node.path || node.type !== 'blob') continue;
        if (root && !node.path.startsWith(root)) continue;
        const relPath = root ? node.path.slice(root.length) : node.path;
        if (!relPath) continue;
        fakeMap.set(`pkg/${relPath}`, new Uint8Array(0));
        if (relPath === 'mcp.json' || relPath.startsWith('skills/') || relPath.startsWith('locales/')) {
          const bytes = await getFileAtom(relPath);
          if (bytes) files.set(posix.normalize(relPath), bytes);
        }
      }
      // Also try to fetch mcp.json for server names
      const mcpBytes = files.get('mcp.json') ?? (await getFileAtom('mcp.json'));
      if (mcpBytes) fakeMap.set('pkg/mcp.json', mcpBytes);
      fileAtoms = scanFileMap(fakeMap, 'pkg');
      return { manifestRaw, bundle, fileAtoms, files };
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('exceeds')) throw error;
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

  const metaRes = await (opts.fetch ?? globalThis.fetch)(`${registry}/${source.name.replace('/', '%2F')}`, {
    headers: auth
  });
  if (!metaRes.ok) throw new InstallError(`npm metadata ${source.name} failed: ${metaRes.status}`);
  const meta = (await metaRes.json()) as { versions?: Record<string, { dist?: { tarball?: string } }> };
  const tarUrl = meta.versions?.[source.version]?.dist?.tarball;
  if (!tarUrl) throw new InstallError(`npm: ${source.name}@${source.version} not found`);

  const { bytes } = await downloadBytes(tarUrl, {
    fetch: opts.fetch,
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
  const packageFiles = new Map<string, Uint8Array>();
  for (const [path, bytes] of files) {
    if (path.startsWith('package/')) packageFiles.set(path.slice('package/'.length), bytes);
  }
  return { manifestRaw, bundle, fileAtoms, files: packageFiles };
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
