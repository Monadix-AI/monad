import type { BunPlugin, OnResolveArgs } from 'bun';

import { existsSync } from 'node:fs';
import { basename, resolve } from 'node:path';

export type ReleasePlatform = 'darwin' | 'linux' | 'windows';

export interface PlatformModuleRule {
  seam: string;
  targets: Record<ReleasePlatform, string>;
}

interface NormalizedRule extends PlatformModuleRule {
  seam: string;
  targets: Record<ReleasePlatform, string>;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function requestedPath(args: OnResolveArgs): string {
  return resolve(args.resolveDir, args.path);
}

export function createPlatformModulePlugin(options: { platform: ReleasePlatform; rules: PlatformModuleRule[] }): {
  plugin: BunPlugin;
  assertResolved(): void;
} {
  const normalized: NormalizedRule[] = options.rules.map((rule) => ({
    seam: resolve(rule.seam),
    targets: {
      darwin: resolve(rule.targets.darwin),
      linux: resolve(rule.targets.linux),
      windows: resolve(rule.targets.windows)
    }
  }));
  const seams = new Set<string>();
  for (const rule of normalized) {
    if (seams.has(rule.seam)) throw new Error(`platform modules: duplicate seam ${rule.seam}`);
    seams.add(rule.seam);
    if (!existsSync(rule.seam)) throw new Error(`platform modules: seam does not exist: ${rule.seam}`);
    for (const target of Object.values(rule.targets)) {
      if (!existsSync(target)) throw new Error(`platform modules: target does not exist: ${target}`);
    }
  }

  const resolvedSeams = new Set<string>();
  const plugin: BunPlugin = {
    name: `platform-modules-${options.platform}`,
    setup(build) {
      for (const rule of normalized) {
        const file = basename(rule.seam);
        build.onResolve({ filter: new RegExp(`^(?:\\./)?${escapeRegExp(file)}$`) }, (args) => {
          if (requestedPath(args) !== rule.seam) return;
          resolvedSeams.add(rule.seam);
          return { path: rule.targets[options.platform] };
        });
      }
    }
  };

  return {
    plugin,
    assertResolved() {
      const unresolved = normalized.filter((rule) => !resolvedSeams.has(rule.seam)).map((rule) => rule.seam);
      if (unresolved.length > 0) {
        throw new Error(`platform modules: build did not resolve configured seams: ${unresolved.join(', ')}`);
      }
    }
  };
}
