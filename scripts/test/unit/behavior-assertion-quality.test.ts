import { expect, test } from 'bun:test';
import { relative } from 'node:path';

const root = new URL('../../..', import.meta.url).pathname;
const weakAssertionPatterns = [
  /\.(?:toBeDefined|toBeTruthy|toBeFalsy)\(\)/g,
  /\b(?:const|let)\s+_[A-Za-z][A-Za-z0-9_]*\s*=/g,
  /\b(?:test|it)\([^{}]*=>\s*\{\s*\}\s*\);/g
];

test('test assertions express observable outcomes instead of positive existence checks', async () => {
  const violations: string[] = [];
  const glob = new Bun.Glob('**/*.{test,spec}.{ts,tsx}');

  for await (const path of glob.scan({ cwd: root, absolute: true, onlyFiles: true })) {
    if (path.includes('/node_modules/') || path === import.meta.path) continue;
    const source = await Bun.file(path).text();
    for (const pattern of weakAssertionPatterns) {
      for (const match of source.matchAll(pattern)) {
        const line = source.slice(0, match.index).split('\n').length;
        violations.push(`${relative(root, path)}:${line}:${match[0]}`);
      }
    }
  }

  expect(violations).toEqual([]);
});
