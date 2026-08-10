#!/usr/bin/env bun

import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { $ } from 'bun';

import rootPkg from '../package.json' with { type: 'json' };
import { releaseTargetFromDistTarget, releaseTargetSuffix } from './lib/release-target.ts';

const root = resolve(import.meta.dir, '..');
const distPackage = Bun.TOML.parse(await Bun.file(join(root, 'distribution/dist.toml')).text()) as {
  package?: { version?: string };
};
const version = (Bun.env.MONAD_DIST_VERSION ?? rootPkg.version).replace(/^v/, '');
if (!Bun.env.MONAD_DIST_VERSION && distPackage.package?.version !== rootPkg.version) {
  throw new Error(
    `distribution/dist.toml version ${distPackage.package?.version ?? '(missing)'} does not match package.json ${rootPkg.version}`
  );
}

const distTarget = Bun.env.CARGO_DIST_TARGET;
if (!distTarget) throw new Error('CARGO_DIST_TARGET is required; run this script through dist');

const target = releaseTargetFromDistTarget(distTarget);
await $`bun run scripts/build-release.ts --target=${distTarget} --version=${version} --no-archive`.cwd(root);

const builtPackage = join(root, 'dist', `monad-${version}-${releaseTargetSuffix(target)}`);
const outDir = join(root, 'distribution', 'out');
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
mkdirSync(join(outDir, 'assets'), { recursive: true });
mkdirSync(join(outDir, 'helpers'), { recursive: true });

for (const entry of ['bin', 'assets', 'helpers']) {
  const source = join(builtPackage, entry);
  if (!existsSync(source)) continue;
  if (entry === 'bin') {
    cpSync(source, outDir, { recursive: true, dereference: true });
  } else {
    cpSync(source, join(outDir, entry), { recursive: true, dereference: true });
  }
}

process.stdout.write(`[build-dist] staged complete ${target.os}/${target.arch} runtime from ${builtPackage}\n`);
