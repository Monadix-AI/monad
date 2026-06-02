import type { Dirent } from 'node:fs';
import type { AtomPackFetcher, FileAtoms, StagedAtomPack } from '#/atoms/install/index.ts';
import type { AtomPackSource } from '#/atoms/install/source.ts';
import type { DownloadProgress } from '#/services/download.ts';

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

import { InstallError } from '#/atoms/install/index.ts';
import { untar } from '#/atoms/install/untar.ts';
import { type DownloadFetch, downloadBytes } from '#/services/download.ts';

const stagedManifestSchema = z.object({ entry: z.string().optional() }).loose();
const mcpJsonSchema = z.object({ mcpServers: z.record(z.string(), z.unknown()).optional() });
const ENTRY_DEFAULT = 'dist/atom-pack.js';
const GITHUB_ARCHIVE_MAX_BYTES = 25 * 1024 * 1024;
const GITHUB_EXPANDED_MAX_BYTES = 100 * 1024 * 1024;
const GITHUB_MAX_ENTRIES = 2_000;

export interface FetcherOptions {
  githubToken?: string;
  fetch?: DownloadFetch;
  onDownloadProgress?: (progress: DownloadProgress & { source: string }) => void;
}

function githubHeaders(token?: string): Record<string, string> {
  return {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'monad',
    ...(token ? { Authorization: `Bearer ${token}` } : {})
  };
}

function scanFileMap(files: Map<string, Uint8Array>): FileAtoms {
  const skills = new Set<string>();
  const mcpServers = new Set<string>();
  const locales = new Set<string>();
  for (const path of files.keys()) {
    const skill = path.match(/^skills\/([^/]+)\/SKILL\.md$/)?.[1];
    if (skill) skills.add(skill);
    const locale = path.match(/^locales\/([^/]+)\//)?.[1];
    if (locale) locales.add(locale);
  }
  const mcpBytes = files.get('mcp.json');
  if (mcpBytes) {
    try {
      const parsed = mcpJsonSchema.parse(JSON.parse(new TextDecoder().decode(mcpBytes)));
      for (const name of Object.keys(parsed.mcpServers ?? {})) mcpServers.add(name);
    } catch {
      // The full install validation reports malformed package content.
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
    throw new InstallError(`local Atom Pack directory is not readable: ${dir}`);
  }
  await Promise.all(
    entries.map(async (entry) => {
      if (entry.name === '.git') return;
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

function atomPackRevision(files: Map<string, Uint8Array>): string {
  const hasher = new Bun.CryptoHasher('sha256');
  for (const path of [...files.keys()].sort()) {
    const bytes = files.get(path);
    if (!bytes || path === '.install.json') continue;
    hasher.update(`${path}\0${bytes.byteLength}\0`);
    hasher.update(bytes);
  }
  return hasher.digest('hex');
}

function stageFiles(files: Map<string, Uint8Array>, revision: string): StagedAtomPack {
  const manifestBytes = files.get('atom-pack.json');
  if (!manifestBytes) throw new InstallError('Atom Pack repository has no atom-pack.json at its root');
  const manifestRaw = stagedManifestSchema.parse(JSON.parse(new TextDecoder().decode(manifestBytes)));
  const entry = manifestRaw.entry ?? ENTRY_DEFAULT;
  const bundle = files.get(entry);
  if (!bundle) throw new InstallError(`Atom Pack entry "${entry}" is missing; build the pack before installing it`);
  return { manifestRaw, bundle, fileAtoms: scanFileMap(files), files, revision };
}

async function fetchLocal(path: string): Promise<StagedAtomPack> {
  const files = await collectLocalFiles(path);
  return stageFiles(files, atomPackRevision(files));
}

function filesBelowPath(files: Map<string, Uint8Array>, path?: string): Map<string, Uint8Array> {
  if (!path) return files;
  const prefix = `${path.replace(/\/+$/, '')}/`;
  const selected = new Map<string, Uint8Array>();
  for (const [file, bytes] of files) {
    if (file.startsWith(prefix)) selected.set(file.slice(prefix.length), bytes);
  }
  return selected;
}

async function gunzipBounded(bytes: Uint8Array): Promise<Uint8Array> {
  const reader = new Blob([bytes as Uint8Array<ArrayBuffer>])
    .stream()
    .pipeThrough(new DecompressionStream('gzip'))
    .getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    size += next.value.byteLength;
    if (size > GITHUB_EXPANDED_MAX_BYTES) {
      await reader.cancel();
      throw new InstallError(`github repository archive expands beyond ${GITHUB_EXPANDED_MAX_BYTES} bytes`);
    }
    chunks.push(next.value);
  }
  const expanded = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    expanded.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return expanded;
}

async function fetchGithub(
  source: Extract<AtomPackSource, { kind: 'github' }>,
  opts: FetcherOptions
): Promise<StagedAtomPack> {
  const request = opts.fetch ?? globalThis.fetch;
  const headers = githubHeaders(opts.githubToken);
  const commitResponse = await request(
    `https://api.github.com/repos/${source.owner}/${source.repo}/commits/${encodeURIComponent(source.ref)}`,
    { headers: { ...headers, Accept: 'application/vnd.github.sha' } }
  );
  if (!commitResponse.ok) {
    throw new InstallError(
      `github: resolving ${source.owner}/${source.repo}@${source.ref} failed: ${commitResponse.status}`
    );
  }
  const commit = (await commitResponse.text()).trim();
  if (!/^[0-9a-f]{40}$/i.test(commit)) throw new InstallError('github returned an invalid commit revision');
  const archiveUrl = `https://api.github.com/repos/${source.owner}/${source.repo}/tarball/${commit}`;
  const { bytes } = await downloadBytes(archiveUrl, {
    fetch: opts.fetch,
    headers: { ...headers, Accept: 'application/octet-stream' },
    allowedContentTypes: ['application/gzip', 'application/x-gzip', 'application/octet-stream'],
    maxBytes: GITHUB_ARCHIVE_MAX_BYTES,
    onProgress: (progress) => opts.onDownloadProgress?.({ ...progress, source: archiveUrl })
  }).catch((error: unknown) => {
    throw new InstallError(
      `github repository download failed: ${error instanceof Error ? error.message : String(error)}`
    );
  });
  const archive = untar(await gunzipBounded(bytes));
  if (archive.size > GITHUB_MAX_ENTRIES) throw new InstallError('github repository archive has too many files');
  const repositoryFiles = new Map<string, Uint8Array>();
  for (const [path, value] of archive) {
    const slash = path.indexOf('/');
    if (slash >= 0 && slash < path.length - 1) repositoryFiles.set(path.slice(slash + 1), value);
  }
  return stageFiles(filesBelowPath(repositoryFiles, source.path), commit);
}

export function createAtomFetcher(opts: FetcherOptions = {}): AtomPackFetcher {
  return (source) => (source.kind === 'local' ? fetchLocal(source.path) : fetchGithub(source, opts));
}
