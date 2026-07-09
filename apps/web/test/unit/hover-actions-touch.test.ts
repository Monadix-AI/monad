import { expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const webRoot = join(import.meta.dir, '../..');
const scannedExtensions = new Set(['.ts', '.tsx', '.css']);
const touchFallback = '[@media_(hover:none),_(pointer:coarse)]';

function* files(root: string): Generator<string> {
  for (const entry of readdirSync(root)) {
    if (entry === 'node_modules' || entry === '.next' || entry === 'out' || entry === 'test') continue;
    const path = join(root, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      yield* files(path);
      continue;
    }
    if ([...scannedExtensions].some((extension) => path.endsWith(extension))) yield path;
  }
}

test('hover-hidden web actions stay visible on touch devices', () => {
  const violations: string[] = [];

  for (const file of files(webRoot)) {
    const source = readFileSync(file, 'utf8');
    const lines = source.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? '';
      if (!line.includes('opacity-0')) continue;
      if (!line.includes('group-hover') && !line.includes('focus-within')) continue;
      if (line.includes(touchFallback)) continue;
      violations.push(`${relative(process.cwd(), file)}:${index + 1}`);
    }
  }

  expect(violations).toEqual([]);
});
