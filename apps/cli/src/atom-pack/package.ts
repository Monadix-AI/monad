import type { AtomPackManifestWire } from '@monad/protocol';

import { lstat, mkdir, readdir } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { parseAtomPackManifest } from '@monad/protocol';

import { createZip, type ZipEntry } from './zip.ts';

const DEFAULT_ENTRY = 'dist/atom-pack.js';
const MAX_ARCHIVE_BYTES = 25 * 1024 * 1024;

export interface PackageAtomPackOptions {
  sourceDir: string;
  output?: string;
}

export interface PackageAtomPackResult {
  name: string;
  version: string;
  artifact: string;
  checksumFile: string;
  sha256: string;
  integrity: string;
  files: string[];
  bytes: number;
}

function sha256(bytes: Uint8Array): string {
  return new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
}

function safeRelativePath(value: string, field: string): string {
  if (!value || isAbsolute(value) || value.includes('\\') || value.includes('\0')) {
    throw new Error(`${field} must be a relative path inside the Atom Pack`);
  }
  const normalized = posix.normalize(value);
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`${field} must be a relative path inside the Atom Pack`);
  }
  return normalized;
}

async function collectPath(root: string, relativePath: string, files: Map<string, Uint8Array>): Promise<void> {
  const path = join(root, relativePath);
  const info = await lstat(path).catch(() => null);
  if (!info) return;
  if (info.isSymbolicLink()) throw new Error(`Atom Pack cannot contain symlinks: ${relativePath}`);
  if (info.isFile()) {
    files.set(relativePath, await Bun.file(path).bytes());
    return;
  }
  if (!info.isDirectory()) throw new Error(`Atom Pack contains an unsupported file type: ${relativePath}`);
  const entries = await readdir(path, { withFileTypes: true });
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) await collectPath(root, posix.join(relativePath, entry.name), files);
}

function distributablePaths(manifest: AtomPackManifestWire): string[] {
  const paths = new Set<string>(['dist', 'assets']);
  for (const path of manifest.skillDirs ?? ['skills']) paths.add(safeRelativePath(path, 'skillDirs'));
  for (const path of manifest.localeDirs ?? ['locales']) paths.add(safeRelativePath(path, 'localeDirs'));
  paths.add(safeRelativePath(manifest.mcpConfig ?? 'mcp.json', 'mcpConfig'));
  paths.add(safeRelativePath(manifest.entry ?? DEFAULT_ENTRY, 'entry'));
  return [...paths].sort();
}

export async function packageAtomPack(options: PackageAtomPackOptions): Promise<PackageAtomPackResult> {
  const sourceDir = resolve(options.sourceDir);
  if (!(await lstat(sourceDir).catch(() => null))?.isDirectory()) {
    throw new Error(`Atom Pack directory not found: ${sourceDir}`);
  }

  const manifest = parseAtomPackManifest(JSON.parse(await Bun.file(join(sourceDir, 'atom-pack.json')).text()));
  const entry = safeRelativePath(manifest.entry ?? DEFAULT_ENTRY, 'entry');
  const entryPath = join(sourceDir, entry);
  if (!(await lstat(entryPath).catch(() => null))?.isFile()) throw new Error(`Atom Pack entry is missing: ${entry}`);

  const bundle = await Bun.file(entryPath).bytes();
  const integrity = `sha256-${sha256(bundle)}`;
  const packagedManifest: AtomPackManifestWire = { ...manifest, entry, integrity };
  const files = new Map<string, Uint8Array>();
  for (const path of distributablePaths(packagedManifest)) await collectPath(sourceDir, path, files);
  files.set('atom-pack.json', new TextEncoder().encode(`${JSON.stringify(packagedManifest, null, 2)}\n`));

  const artifact = resolve(options.output ?? join(sourceDir, 'release', 'atom-pack.zip'));
  if (!artifact.toLowerCase().endsWith('.zip')) throw new Error('Atom Pack output must end in .zip');
  const checksumFile = `${artifact}.sha256`;
  files.delete(posix.normalize(relative(sourceDir, artifact).split(sep).join('/')));
  files.delete(posix.normalize(relative(sourceDir, checksumFile).split(sep).join('/')));

  const entries: ZipEntry[] = [...files].map(([name, bytes]) => ({ name, bytes }));
  const archive = createZip(entries);
  if (archive.byteLength > MAX_ARCHIVE_BYTES) {
    throw new Error(`Atom Pack ZIP exceeds the ${MAX_ARCHIVE_BYTES}-byte upload limit`);
  }
  const archiveHash = sha256(archive);
  await mkdir(dirname(artifact), { recursive: true });
  await Bun.write(artifact, archive);
  await Bun.write(checksumFile, `${archiveHash}  ${basename(artifact)}\n`);

  return {
    name: manifest.name,
    version: manifest.version,
    artifact,
    checksumFile,
    sha256: archiveHash,
    integrity,
    files: entries.map((item) => item.name).sort(),
    bytes: archive.byteLength
  };
}
