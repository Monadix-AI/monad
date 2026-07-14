import type { SandboxPolicy } from '@monad/sdk-atom';

import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import { posix, win32 } from 'node:path';

import { toGuestPath } from './winpath.ts';

export interface SharedMount {
  tag: string;
  hostPath: string;
  guestPath: string;
  readOnly: boolean;
  vsockPort?: number;
}

export type MountOverlay =
  | { kind: 'protect-store' | 'mask-file'; source: string; target: string }
  | { kind: 'deny-directory' | 'deny-file'; target: string };

export interface VmMountPlan {
  shares: SharedMount[];
  overlays: MountOverlay[];
}

export const MOUNT_PLAN_SCHEMA_VERSION = 1;

export function fingerprintVmMountPlan(plan: VmMountPlan): string {
  return new Bun.CryptoHasher('sha256').update(JSON.stringify(plan)).digest('hex');
}

type PathKind = 'file' | 'directory' | 'other' | 'missing';

export interface MountPlanHost {
  platform: NodeJS.Platform;
  realpath(path: string): Promise<string>;
  kind(path: string): Promise<PathKind>;
  assertReadable(path: string): Promise<void>;
}

interface CanonicalPath {
  path: string;
  exists: boolean;
  kind: PathKind;
  firstMissing?: string;
}

interface CanonicalShare extends SharedMount {
  rawPath: string;
}

const defaultHost: MountPlanHost = {
  platform: process.platform,
  realpath,
  async kind(path) {
    try {
      const value = await stat(path);
      if (value.isFile()) return 'file';
      if (value.isDirectory()) return 'directory';
      return 'other';
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return 'missing';
      throw error;
    }
  },
  async assertReadable(path) {
    await access(path, constants.R_OK);
  }
};

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error ? String((error as NodeJS.ErrnoException).code) : undefined;
}

function pathApi(host: MountPlanHost): typeof posix | typeof win32 {
  return host.platform === 'win32' ? win32 : posix;
}

function comparisonPath(path: string, host: MountPlanHost): string {
  const normalized = pathApi(host).normalize(path);
  return host.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isUnder(child: string, parent: string, host: MountPlanHost): boolean {
  const api = pathApi(host);
  const relative = api.relative(comparisonPath(parent, host), comparisonPath(child, host));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${api.sep}`) && !api.isAbsolute(relative));
}

function guestPath(path: string, host: MountPlanHost): string {
  return host.platform === 'win32' ? toGuestPath(path) : path;
}

function guestTarget(canonical: string, shares: CanonicalShare[], host: MountPlanHost, fallback: string): string {
  const api = pathApi(host);
  const share = shares
    .filter((candidate) => isUnder(canonical, candidate.hostPath, host))
    .sort((a, b) => b.hostPath.length - a.hostPath.length)[0];
  if (!share) return guestPath(api.normalize(fallback), host);
  const relative = api.relative(share.hostPath, canonical);
  return relative === '' ? share.guestPath : posix.join(share.guestPath, ...relative.split(api.sep));
}

function guestTargets(canonical: string, shares: CanonicalShare[], host: MountPlanHost, fallback: string): string[] {
  const api = pathApi(host);
  const targets = shares
    .filter((share) => isUnder(canonical, share.hostPath, host))
    .map((share) => {
      const relative = api.relative(share.hostPath, canonical);
      return relative === '' ? share.guestPath : posix.join(share.guestPath, ...relative.split(api.sep));
    });
  if (targets.length === 0) return [guestPath(api.normalize(fallback), host)];
  return [...new Set(targets)].sort((a, b) => targetDepth(a) - targetDepth(b) || a.localeCompare(b));
}

async function canonicalize(input: string, host: MountPlanHost): Promise<CanonicalPath> {
  const api = pathApi(host);
  if (!api.isAbsolute(input)) throw new Error(`mount policy path must be absolute: ${input}`);
  let cursor = api.normalize(input);
  const missing: string[] = [];
  while (true) {
    try {
      const resolved = api.normalize(await host.realpath(cursor));
      const kind = await host.kind(resolved);
      if (kind === 'missing') throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      if (missing.length === 0) return { path: resolved, exists: true, kind };
      if (kind !== 'directory') throw new Error(`mount policy has a file ancestor at ${resolved}`);
      return {
        path: api.join(resolved, ...missing),
        exists: false,
        kind: 'missing',
        firstMissing: api.join(resolved, missing[0] as string)
      };
    } catch (error) {
      const code = errorCode(error);
      if (code === 'ELOOP')
        throw new Error(`mount policy symlink chain exceeds 40 resolutions or contains a cycle: ${input}`);
      if (code !== 'ENOENT') throw error;
      const parent = api.dirname(cursor);
      if (parent === cursor) throw new Error(`mount policy path has no existing ancestor: ${input}`);
      missing.unshift(api.basename(cursor));
      cursor = parent;
    }
  }
}

function targetDepth(target: string): number {
  return target.split('/').filter(Boolean).length;
}

function sourceInStaging(store: string, fake: string, staging: string, host: MountPlanHost): string {
  const api = pathApi(host);
  const relative = api.relative(store, fake);
  return posix.join(staging, ...relative.split(api.sep));
}

function ensureNoEscape(raw: string, canonical: string, shares: CanonicalShare[], host: MountPlanHost): void {
  const rawShares = shares.filter((share) => isUnder(raw, share.rawPath, host));
  if (rawShares.length > 0 && !shares.some((share) => isUnder(canonical, share.hostPath, host))) {
    throw new Error(`mount policy path ${raw} escapes mounted root through a symlink`);
  }
}

export async function buildVmMountPlan(policy: SandboxPolicy, host: MountPlanHost = defaultHost): Promise<VmMountPlan> {
  const api = pathApi(host);
  const shares: CanonicalShare[] = [];
  const seenShares = new Set<string>();
  const appendShares = async (roots: string[], readOnly: boolean, prefix: 'w' | 'r') => {
    let index = 0;
    for (const rawPath of roots) {
      const canonical = await canonicalize(rawPath, host);
      if (!canonical.exists || canonical.kind !== 'directory') {
        throw new Error(`mounted root must be an existing directory: ${rawPath}`);
      }
      const key = comparisonPath(canonical.path, host);
      if (seenShares.has(key)) continue;
      seenShares.add(key);
      shares.push({
        tag: `${prefix}${index++}`,
        hostPath: canonical.path,
        guestPath: guestTarget(canonical.path, shares, host, rawPath),
        readOnly,
        rawPath: api.normalize(rawPath)
      });
    }
  };
  await appendShares(policy.writableRoots ?? [], false, 'w');
  await appendShares(policy.readableRoots ?? [], true, 'r');
  const baseShares = [...shares];

  const denyOverlays: MountOverlay[] = [];
  for (const rawDeny of policy.readDenyRoots ?? []) {
    const canonical = await canonicalize(rawDeny, host);
    ensureNoEscape(rawDeny, canonical.path, baseShares, host);
    if (!baseShares.some((share) => isUnder(canonical.path, share.hostPath, host))) continue;
    if (canonical.exists && canonical.kind !== 'directory' && canonical.kind !== 'file') {
      throw new Error(`read-deny target has unsupported type: ${rawDeny}`);
    }
    for (const target of guestTargets(canonical.firstMissing ?? canonical.path, baseShares, host, rawDeny)) {
      denyOverlays.push({
        kind: canonical.exists && canonical.kind === 'file' ? 'deny-file' : 'deny-directory',
        target
      });
    }
  }
  denyOverlays.sort((a, b) => targetDepth(a.target) - targetDepth(b.target) || a.target.localeCompare(b.target));

  const protectionOverlays: MountOverlay[] = [];
  const maskOverlays: MountOverlay[] = [];
  const stores = new Map<string, { path: string; staging: string }>();
  const masks = [...(policy.maskedFiles ?? [])].sort(
    (a, b) => a.real.localeCompare(b.real) || a.fake.localeCompare(b.fake)
  );
  for (const mask of masks) {
    let fake: CanonicalPath;
    try {
      fake = await canonicalize(mask.fake, host);
    } catch (error) {
      throw new Error(
        `mask source ${mask.fake} is unavailable: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (!fake.exists) throw new Error(`mask source ${mask.fake} is unavailable`);
    if (fake.kind !== 'file') throw new Error(`mask source must be a regular file: ${mask.fake}`);
    try {
      await host.assertReadable(fake.path);
    } catch {
      throw new Error(`mask source is unreadable: ${mask.fake}`);
    }
    const storePath = api.dirname(fake.path);
    const storeKey = comparisonPath(storePath, host);
    let store = stores.get(storeKey);
    if (!store) {
      const staging = `/run/monad/masks/${stores.size}`;
      store = { path: storePath, staging };
      stores.set(storeKey, store);
      shares.push({
        tag: `m${stores.size - 1}`,
        hostPath: storePath,
        guestPath: staging,
        readOnly: true,
        rawPath: storePath
      });
      const writableExposures = shares.filter((share) => !share.readOnly && isUnder(storePath, share.hostPath, host));
      for (const writableExposure of writableExposures) {
        if (comparisonPath(writableExposure.hostPath, host) === storeKey) {
          throw new Error(`mask store cannot equal a writable policy root: ${storePath}`);
        }
        protectionOverlays.push({
          kind: 'protect-store',
          source: staging,
          target: guestTarget(storePath, [writableExposure], host, storePath)
        });
      }
    }
    const real = await canonicalize(mask.real, host);
    ensureNoEscape(mask.real, real.path, baseShares, host);
    for (const target of guestTargets(real.path, baseShares, host, mask.real)) {
      if (denyOverlays.some((deny) => isUnder(target, deny.target, { ...host, platform: 'linux' }))) continue;
      maskOverlays.push({
        kind: 'mask-file',
        source: sourceInStaging(store.path, fake.path, store.staging, host),
        target
      });
    }
  }

  return {
    shares: shares.map(({ rawPath: _rawPath, ...share }) => share),
    overlays: [...protectionOverlays, ...denyOverlays, ...maskOverlays]
  };
}
