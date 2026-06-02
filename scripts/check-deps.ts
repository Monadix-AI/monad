#!/usr/bin/env bun
// Enforce the repo's dependency direction:
//   Leaf apps (apps/*) are the top of the graph — no workspace may depend on one.
//   Shared code belongs in packages/*; apps compose it, never the reverse.
// Exits non-zero on any violation.

import { resolve } from 'node:path';
import { Glob } from 'bun';

interface Pkg {
  name: string;
  dir: string;
  deps: string[];
}

const root = resolve(import.meta.dir, '..');
const glob = new Glob('{apps,packages}/*/package.json');

const byName = new Map<string, Pkg>();
for await (const rel of glob.scan({ cwd: root })) {
  const json = (await Bun.file(`${root}/${rel}`).json()) as {
    name?: string;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  if (!json.name) continue;
  const deps = [...Object.keys(json.dependencies ?? {}), ...Object.keys(json.devDependencies ?? {})];
  byName.set(json.name, { name: json.name, dir: rel.replace(/\/package\.json$/, ''), deps });
}

const isLeafApp = (p: Pkg): boolean => p.dir.startsWith('apps/');

const violations: string[] = [];
for (const pkg of byName.values()) {
  for (const dep of pkg.deps) {
    const target = byName.get(dep);
    if (!target) continue; // external dep
    if (isLeafApp(target)) {
      violations.push(`${pkg.name} (${pkg.dir}) depends on leaf app ${target.name} (${target.dir})`);
    }
  }
}

if (violations.length > 0) {
  process.stderr.write(`dependency-direction violations:\n${violations.map((v) => `  - ${v}`).join('\n')}\n`);
  process.exit(1);
}
process.stdout.write(`check-deps: ok (${byName.size} workspaces)\n`);
