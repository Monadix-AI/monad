import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const adapterRoot = join(import.meta.dir, '../../src/agent-adapters');

function filesBelow(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesBelow(path) : [relative(adapterRoot, path)];
  });
}

const APP_SERVER_IMPORT = /from\s+['"][^'"]*codex\/app-server[^'"]*['"]/;

test('keeps app-server ownership inside the Codex adapter', () => {
  const violations = filesBelow(adapterRoot)
    .filter((path) => !path.startsWith('codex/'))
    .filter((path) => APP_SERVER_IMPORT.test(readFileSync(join(adapterRoot, path), 'utf8')))
    .sort();

  expect(violations).toEqual([]);
});
