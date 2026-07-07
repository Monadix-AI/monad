#!/usr/bin/env bun
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

// The style SET is enumerated from @dicebear/styles in exactly one generated protocol file; this
// script derives its credits from that list.
import { AVATAR_STYLE_SLUGS } from '../packages/protocol/generated/avatar-styles.ts';

// Mirror of @monad/protocol's `avatarStyleLabel` (kept local because this build script isn't a
// workspace package and can't resolve the workspace import). A style's display name is exactly its
// slug in title case — @dicebear/styles ships no label.
function avatarStyleLabel(slug: string): string {
  return slug
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

const ROOT = resolve(import.meta.dir, '..');

type PkgMeta = { dependencies?: Record<string, string>; peerDependencies?: Record<string, string> };
type LockWorkspace = { name?: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
type Lockfile = {
  workspaces: Record<string, LockWorkspace>;
  packages: Record<string, [string, string, PkgMeta, string]>;
};

const rawLock = await Bun.file(join(ROOT, 'bun.lock')).text();
// bun.lock is JSON5 (trailing commas allowed); strip them before parsing.
const cleanLock = rawLock.replace(/,(\s*[}\]])/g, '$1');
const lockfile: Lockfile = JSON.parse(cleanLock);

const visited = new Set<string>();
const queue: string[] = [];

function enqueue(deps: Record<string, string> | undefined) {
  for (const name of Object.keys(deps ?? {})) {
    if (!name.startsWith('@monad/') && !visited.has(name)) {
      visited.add(name);
      queue.push(name);
    }
  }
}

for (const ws of Object.values(lockfile.workspaces)) {
  enqueue(ws.dependencies);
}

while (queue.length > 0) {
  const name = queue.shift();
  if (name) enqueue(lockfile.packages[name]?.[2]?.dependencies);
}

// In a git worktree, node_modules lives in the main checkout rather than the worktree.
// Use git's common dir to find the main repo root.
const gitCommonDir = await Bun.$`git rev-parse --git-common-dir`
  .cwd(ROOT)
  .text()
  .then((t) => t.trim())
  .catch(() => '');
const mainRoot = gitCommonDir ? resolve(gitCommonDir, '..') : ROOT;

// Bun installs workspace-specific deps in each workspace's own node_modules rather than hoisting
// all of them to the root. Build a list of all candidate node_modules dirs to search. A worktree
// can also have its own independently-installed node_modules (e.g. a dependency added only there),
// so search both roots rather than assuming everything is hoisted to the main checkout.
const roots = mainRoot === ROOT ? [mainRoot] : [mainRoot, ROOT];
const nmDirs = roots.flatMap((root) => [
  join(root, 'node_modules'),
  ...Object.keys(lockfile.workspaces)
    .filter((k) => k !== '')
    .map((k) => join(root, k, 'node_modules'))
]);

async function readPkgJson(pkgName: string): Promise<Record<string, unknown> | null> {
  const segments = pkgName.split('/');
  for (const nmDir of nmDirs) {
    try {
      return await Bun.file(join(nmDir, ...segments, 'package.json')).json();
    } catch {
      // not in this node_modules — try next
    }
  }
  return null;
}

interface DicebearStyleMeta {
  license?: { name?: string; url?: string };
  creator?: { name?: string; url?: string };
  source?: { name?: string; url?: string };
}

async function readStyleMeta(slug: string): Promise<DicebearStyleMeta | null> {
  for (const nmDir of nmDirs) {
    try {
      const json = await Bun.file(join(nmDir, '@dicebear', 'styles', 'dist', `${slug}.min.json`)).json();
      return (json.meta as DicebearStyleMeta) ?? {};
    } catch {
      // not in this node_modules — try next
    }
  }
  return null;
}

const avatarStyles = await Promise.all(
  AVATAR_STYLE_SLUGS.map(async (slug) => {
    const meta = (await readStyleMeta(slug)) ?? {};
    const label = avatarStyleLabel(slug);
    return {
      slug,
      label,
      creator: meta.creator?.name ?? 'Unknown',
      ...(meta.creator?.url ? { creatorUrl: meta.creator.url } : {}),
      source: meta.source?.name ?? label,
      ...(meta.source?.url ? { sourceUrl: meta.source.url } : {}),
      license: meta.license?.name ?? 'Unknown',
      licenseUrl: meta.license?.url ?? ''
    };
  })
);

const entries: Array<{ name: string; version: string; license: string; homepage?: string; author?: string }> = [];

await Promise.all(
  [...visited].map(async (pkgName) => {
    const pkg = await readPkgJson(pkgName);
    if (!pkg) return;
    const version: string = (pkg.version as string) ?? '';
    const license: string =
      typeof pkg.license === 'string' ? pkg.license : ((pkg.license as Record<string, string>)?.type ?? 'unknown');
    const rawUrl: string | undefined =
      (pkg.homepage as string) ??
      (typeof pkg.repository === 'object' ? (pkg.repository as Record<string, string>)?.url : undefined);
    const normalized = rawUrl ? rawUrl.replace(/^git\+/, '').replace(/\.git$/, '') : undefined;
    const homepage = normalized && /^https?:\/\//.test(normalized) ? normalized : undefined;
    const author: string | undefined =
      typeof pkg.author === 'string' ? pkg.author : (pkg.author as Record<string, string>)?.name;
    entries.push({ name: pkgName, version, license, ...(homepage ? { homepage } : {}), ...(author ? { author } : {}) });
  })
);

entries.sort((a, b) => a.name.localeCompare(b.name));

const outDir = join(ROOT, 'apps/monad/generated');
await mkdir(outDir, { recursive: true });
await Bun.write(join(outDir, 'licenses.json'), `${JSON.stringify({ packages: entries, avatarStyles }, null, 2)}\n`);
