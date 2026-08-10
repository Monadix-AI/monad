#!/usr/bin/env bun
import type { BunPlugin } from 'bun';

import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { listAvatarStyleSlugs } from './avatar-style-slugs.ts';
import { mem0OptionalPeerExternals, optionalPeerExternals } from './lib/release-optional-peers.ts';

interface DicebearStyleMeta {
  creator?: { name?: string; url?: string };
  license?: { name?: string; url?: string };
  source?: { name?: string; url?: string };
}

const ROOT = resolve(import.meta.dir, '..');
const APP_TARGETS = [
  { id: 'monad', path: 'apps/monad', entrypoint: 'apps/monad/src/main.ts', target: 'bun' },
  { id: 'cli', path: 'apps/cli', entrypoint: 'apps/cli/src/main.ts', target: 'bun' },
  { id: 'web', path: 'apps/web', entrypoint: 'apps/web/src/main.tsx', target: 'browser' },
  { id: 'tui', path: 'apps/tui', entrypoint: 'apps/tui/src/Main.tsx', target: 'bun' }
] as const;
const LICENSE_OVERRIDES: Record<string, string> = {
  '@dicebear/styles': 'MIT'
};

interface PackageAuthor {
  name?: string;
}

interface PackageRepository {
  url?: string;
}

interface PackageLicense {
  name?: string;
  type?: string;
}

export interface PackageManifest {
  author?: PackageAuthor | string;
  dependencies?: Record<string, string>;
  homepage?: string;
  license?: PackageLicense | string;
  licenses?: Array<PackageLicense | string>;
  name?: string;
  optionalDependencies?: Record<string, string>;
  private?: boolean;
  repository?: PackageRepository | string;
  version?: string;
}

interface WorkspacePackage {
  manifest: PackageManifest;
  path: string;
}

export interface LicensePackage {
  author?: string;
  homepage?: string;
  license: string;
  name: string;
  version: string;
}

function avatarStyleLabel(slug: string): string {
  return slug
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function normalizeUrl(value: string | undefined): string | undefined {
  const normalized = value
    ?.replace('git+ssh://git@', 'git://')
    .replace('git+https://github.com', 'https://github.com')
    .replace('git://github.com', 'https://github.com')
    .replace('git@github.com:', 'https://github.com/')
    .replace(/^git\+/, '')
    .replace(/\.git$/, '');
  return normalized && /^https?:\/\//.test(normalized) ? normalized : undefined;
}

function repositoryUrl(repository: PackageManifest['repository']): string | undefined {
  const value = typeof repository === 'string' ? repository : repository?.url;
  const githubPath = value?.replace(/^github:/, '');
  return normalizeUrl(githubPath && /^[^/:]+\/[^/]+$/.test(githubPath) ? `https://github.com/${githubPath}` : value);
}

function authorName(author: PackageManifest['author']): string | undefined {
  if (typeof author !== 'string') return author?.name;
  return author.match(/^([^(<]+)/)?.[0].trim();
}

function licenseValue(value: PackageLicense | string): string | undefined {
  const raw = typeof value === 'string' ? value : (value.type ?? value.name);
  const fileReference = raw?.match(/SEE LICENSE IN (.*)/i)?.[1];
  return fileReference ? `Custom: ${fileReference}` : raw;
}

function licenseName(manifest: PackageManifest): string {
  const override = manifest.name ? LICENSE_OVERRIDES[manifest.name] : undefined;
  if (override) return override;
  if (manifest.license) return licenseValue(manifest.license) ?? 'unknown';
  const licenses = manifest.licenses?.map(licenseValue).filter((license): license is string => license !== undefined);
  return licenses?.length ? licenses.join(' OR ') : 'unknown';
}

export function licensePackageFromManifest(manifest: PackageManifest): LicensePackage | undefined {
  if (!manifest.name || !manifest.version || manifest.private) return undefined;
  const homepage = repositoryUrl(manifest.repository);
  const author = authorName(manifest.author);
  return {
    name: manifest.name,
    version: manifest.version,
    license: licenseName(manifest),
    ...(homepage ? { homepage } : {}),
    ...(author ? { author } : {})
  };
}

function productionDependencies(manifest: PackageManifest): string[] {
  return Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies });
}

async function loadWorkspacePackages(): Promise<Map<string, WorkspacePackage>> {
  const packages = new Map<string, WorkspacePackage>();
  for await (const relativePath of new Bun.Glob('packages/*/package.json').scan({ cwd: ROOT })) {
    const manifest = (await Bun.file(join(ROOT, relativePath)).json()) as PackageManifest;
    if (manifest.name) packages.set(manifest.name, { manifest, path: dirname(join(ROOT, relativePath)) });
  }
  return packages;
}

async function reportPackages(workspacePackage: WorkspacePackage, workspaceNames: ReadonlySet<string>) {
  return mergePackages(
    await Promise.all(
      productionDependencies(workspacePackage.manifest)
        .filter((name) => !workspaceNames.has(name))
        .map(async (name) => {
          const manifest = (await Bun.file(
            join(workspacePackage.path, 'node_modules', name, 'package.json')
          ).json()) as PackageManifest;
          const pkg = licensePackageFromManifest(manifest);
          return pkg ? [pkg] : [];
        })
    )
  );
}

function mergePackages(groups: LicensePackage[][]): LicensePackage[] {
  const packages = new Map<string, LicensePackage>();
  for (const group of groups) {
    for (const pkg of group) packages.set(`${pkg.name}@${pkg.version}`, pkg);
  }
  return [...packages.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

const dependencyGraphPlugin: BunPlugin = {
  name: 'license-dependency-graph',
  setup(build) {
    build.onResolve({ filter: /^react-devtools-core$/ }, () => ({
      path: 'react-devtools-core',
      namespace: 'license-stub'
    }));
    build.onLoad({ filter: /.*/, namespace: 'license-stub' }, () => ({
      contents: 'export default {}; export function connectToDevTools(){}',
      loader: 'js'
    }));
    build.onResolve({ filter: /generated\/codex-app-server/ }, ({ path }) => ({ path, external: true }));
    build.onResolve({ filter: /generated\/licenses\.json$/ }, ({ path }) => ({ path, external: true }));
  }
};

function externalPackageName(input: string): string | undefined {
  const normalized = `/${input.replaceAll('\\', '/')}`;
  const marker = '/node_modules/';
  const index = normalized.lastIndexOf(marker);
  if (index === -1) return undefined;
  const path = normalized.slice(index + marker.length);
  const [first, second] = path.split('/');
  if (!first) return undefined;
  return first.startsWith('@') && second ? `${first}/${second}` : first;
}

async function usedExternalPackages(target: (typeof APP_TARGETS)[number], external: string[]): Promise<Set<string>> {
  const result = await Bun.build({
    entrypoints: [join(ROOT, target.entrypoint)],
    target: target.target,
    metafile: true,
    external,
    plugins: [dependencyGraphPlugin],
    define: { 'process.env.NODE_ENV': JSON.stringify('production') }
  });
  if (!result.metafile) throw new Error(`Missing dependency graph for ${target.entrypoint}`);
  return new Set(
    Object.keys(result.metafile.inputs)
      .map(externalPackageName)
      .filter((name): name is string => name !== undefined)
  );
}

async function scanPackageGroups() {
  const workspacePackages = await loadWorkspacePackages();
  const appManifests = await Promise.all(
    APP_TARGETS.map(async (target) => ({
      ...target,
      manifest: (await Bun.file(join(ROOT, target.path, 'package.json')).json()) as PackageManifest
    }))
  );
  const scanPaths = new Set<string>();
  const packagesByPath = new Map([...workspacePackages.values()].map((pkg) => [pkg.path, pkg]));
  const pathsByApp = appManifests.map((target) => {
    const appPath = join(ROOT, target.path);
    packagesByPath.set(appPath, { manifest: target.manifest, path: appPath });
    const paths = [appPath];
    const queued = productionDependencies(target.manifest);
    const visited = new Set<string>();
    while (queued.length > 0) {
      const name = queued.shift();
      if (!name || visited.has(name)) continue;
      const workspacePackage = workspacePackages.get(name);
      if (!workspacePackage) continue;
      visited.add(name);
      paths.push(workspacePackage.path);
      queued.push(...productionDependencies(workspacePackage.manifest));
    }
    for (const path of paths) scanPaths.add(path);
    return { id: target.id, paths };
  });
  const workspaceNames = new Set(workspacePackages.keys());
  const reports = new Map(
    await Promise.all(
      [...scanPaths].map(async (path) => {
        const workspacePackage = packagesByPath.get(path);
        if (!workspacePackage) throw new Error(`missing workspace package for license scan: ${path}`);
        return [path, await reportPackages(workspacePackage, workspaceNames)] as const;
      })
    )
  );
  const monadManifest = appManifests.find((target) => target.id === 'monad')?.manifest;
  const optionalExternals = await optionalPeerExternals(
    join(ROOT, 'apps/monad/node_modules/mem0ai/package.json'),
    Object.keys(monadManifest?.dependencies ?? {})
  );
  const external = [...optionalExternals, ...mem0OptionalPeerExternals];
  const packageGroups = await Promise.all(
    pathsByApp.map(async (target) => {
      const appTarget = APP_TARGETS.find((candidate) => candidate.id === target.id);
      if (!appTarget) throw new Error(`missing application target: ${target.id}`);
      const used = await usedExternalPackages(appTarget, external);
      return {
        id: target.id,
        packages: mergePackages(target.paths.map((path) => reports.get(path) ?? [])).filter((pkg) => used.has(pkg.name))
      };
    })
  );
  return { packageGroups, packages: mergePackages(packageGroups.map((group) => group.packages)) };
}

async function scanAvatarStyles() {
  const stylesEntry = Bun.resolveSync('@dicebear/styles/adventurer.json', join(ROOT, 'apps/monad'));
  const stylesDir = dirname(stylesEntry);
  return Promise.all(
    (await listAvatarStyleSlugs(ROOT)).map(async (slug) => {
      const style = await Bun.file(join(stylesDir, `${slug}.min.json`)).json();
      const meta = (style.meta as DicebearStyleMeta | undefined) ?? {};
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
}

async function generateLicenses() {
  const [{ packages, packageGroups }, avatarStyles] = await Promise.all([scanPackageGroups(), scanAvatarStyles()]);
  const outDir = join(ROOT, 'apps/monad/generated');
  await mkdir(outDir, { recursive: true });
  await Bun.write(
    join(outDir, 'licenses.json'),
    `${JSON.stringify({ packages, packageGroups, avatarStyles }, null, 2)}\n`
  );
}

if (import.meta.main) await generateLicenses();
