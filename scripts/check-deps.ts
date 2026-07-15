#!/usr/bin/env bun
// Enforce the repo's dependency direction while preserving explicitly recorded
// release-composition edges. Exits non-zero on any unrecorded violation.

import { resolve } from 'node:path';
import { Glob } from 'bun';

import { checkDependencyDirections, defaultDependencyPolicy, type WorkspacePackage } from './dependency-policy.ts';

const root = resolve(import.meta.dir, '..');
const glob = new Glob('{apps,packages}/*/package.json');

const packages: WorkspacePackage[] = [];
for await (const rel of glob.scan({ cwd: root })) {
  const json = (await Bun.file(`${root}/${rel}`).json()) as {
    name?: string;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  if (!json.name) continue;
  packages.push({
    dependencies: Object.keys(json.dependencies ?? {}),
    devDependencies: Object.keys(json.devDependencies ?? {}),
    dir: rel.replace(/\/package\.json$/, ''),
    name: json.name
  });
}

const violations = checkDependencyDirections(packages, defaultDependencyPolicy);

if (violations.length > 0) {
  process.stderr.write(
    `dependency-direction violations:\n${violations
      .map(
        (violation) =>
          `  - ${violation.from} (${violation.fromDir}) has an unrecorded ${violation.dependencyKind} dependency on app ${violation.to} (${violation.toDir})`
      )
      .join('\n')}\n`
  );
  process.exit(1);
}
process.stdout.write(`check-deps: ok (${packages.length} workspaces, explicit app composition policy)\n`);
