#!/usr/bin/env bun

import { relative } from 'node:path';

import { findWeakAssertions } from './lib/weak-assertions.ts';

const root = new URL('..', import.meta.url).pathname;
const glob = new Bun.Glob('{apps,packages,scripts,test}/**/*.{test,spec}.{ts,tsx}');
const violations: string[] = [];

for await (const path of glob.scan({ cwd: root, absolute: true, onlyFiles: true })) {
  // The checker's own test embeds weak-matcher strings as fixtures.
  if (path.includes('/node_modules/') || path.endsWith('scripts/test/unit/weak-assertions.test.ts')) continue;
  const source = await Bun.file(path).text();
  for (const violation of findWeakAssertions(source)) {
    violations.push(`${relative(root, path)}:${violation.line}: ${violation.match} — ${violation.hint}`);
  }
}

if (violations.length > 0) {
  process.stderr.write(`${violations.join('\n')}\n\n`);
  process.stderr.write(
    `[test-assertions] ${violations.length} indirect layout snapshot(s). Exercise an operation and assert ` +
      'its observable outcome instead of restating CSS or geometry. Mark an intentional contract with ' +
      '`behavior-ok: <reason>`.\n' +
      'Rules: docs/internal/development/testing.md §1\n'
  );
  process.exit(1);
}

process.stdout.write('[test-assertions] no weak assertions found\n');
