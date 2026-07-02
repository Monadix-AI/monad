import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const WORKPLACE_ROOT = join(import.meta.dir, '../../features/workplace');
const checkedRoots = [WORKPLACE_ROOT, join(import.meta.dir, '../../features/routes/workspace/ProjectTopBar.tsx')];
const checkedExtensions = new Set(['.ts', '.tsx']);

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...sourceFiles(path));
      continue;
    }
    if ([...checkedExtensions].some((ext) => entry.name.endsWith(ext))) files.push(path);
  }
  return files;
}

test('workplace controls do not bypass the interactive cursor preference', () => {
  const offenders = checkedRoots
    .flatMap((root) => (root.endsWith('.tsx') ? [root] : sourceFiles(root)))
    .flatMap((file) => {
      const source = readFileSync(file, 'utf8');
      return source
        .split('\n')
        .map((line, index) => ({ file, line, number: index + 1 }))
        .filter(({ line }) => /cursor:.*(?:['"`](?:pointer|default)['"`]|\bpointer\b)/.test(line))
        .map(({ file, line, number }) => `${file.replace(`${import.meta.dir}/../../`, '')}:${number}: ${line.trim()}`);
    });

  expect(offenders).toEqual([]);
});
