import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const generatedDir = join(import.meta.dir, '..', '..', 'generated');
const inputDir = join(generatedDir, 'paraglide-input');
const outputDir = join(generatedDir, 'paraglide');

describe('Paraglide generated layout', () => {
  test('splits messages into common and client scopes', async () => {
    expect(await readdir(inputDir).then((entries) => entries.sort())).toEqual(['cli', 'common', 'web']);
    expect(await readdir(outputDir).then((entries) => entries.sort())).toEqual(['cli', 'common', 'web']);
  });

  test('keeps scoped message files with one shared runtime', async () => {
    for (const scope of ['cli', 'common', 'web']) {
      expect(existsSync(join(outputDir, scope, 'messages.js'))).toBe(true);
      expect(existsSync(join(outputDir, scope, 'messages', '_index.js'))).toBe(true);
      expect(existsSync(join(outputDir, scope, 'messages', 'en.js'))).toBe(true);
      expect(existsSync(join(outputDir, scope, 'messages', 'zh.js'))).toBe(true);
      expect(existsSync(join(outputDir, scope, 'registry.js'))).toBe(false);
      expect(existsSync(join(outputDir, scope, 'server.js'))).toBe(false);
    }
    expect(existsSync(join(outputDir, 'common', 'runtime.js'))).toBe(true);
    expect(existsSync(join(outputDir, 'cli', 'runtime.js'))).toBe(false);
    expect(existsSync(join(outputDir, 'web', 'runtime.js'))).toBe(false);
  });

  test('client scopes import the shared runtime', async () => {
    for (const scope of ['cli', 'web']) {
      const _index = await readFile(join(outputDir, scope, 'messages', '_index.js'), 'utf8');
    }
  });
});
