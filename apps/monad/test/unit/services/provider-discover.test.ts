import { expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ModelProviderRegistry } from '@/agent/index.ts';

// The file-scan discovery path: drop a `.js` whose default export is a ModelProvider (or array)
// into a dir; registry.discover() loads + registers it. One bad file never blocks the others.

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'monad-providers-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const goodProvider = `export default {
  type: 'scanned',
  descriptor: { type: 'scanned', label: 'Scanned', strategy: 'native' },
  async *stream() { yield { type: 'text', token: 'hi' }; }
};`;

test('discover() registers a default-exported ModelProvider from a .js file', async () => {
  await withDir(async (dir) => {
    await writeFile(join(dir, 'scanned.js'), goodProvider);
    const reg = new ModelProviderRegistry();
    const result = await reg.discover(dir);
    expect(result.registered).toEqual(['scanned']);
    expect(reg.has('scanned')).toBe(true);
    expect(reg.get('scanned')?.descriptor.label).toBe('Scanned');
  });
});

test('discover() accepts a non-text ModelProvider without stream()', async () => {
  await withDir(async (dir) => {
    await writeFile(
      join(dir, 'image-only.js'),
      `export default {
        type: 'image-only',
        descriptor: { type: 'image-only', label: 'Image Only', strategy: 'native' },
        async generateImage() { return { image: new Uint8Array([1]), mediaType: 'image/png' }; }
      };`
    );
    const reg = new ModelProviderRegistry();
    const result = await reg.discover(dir);
    expect(result.registered).toEqual(['image-only']);
    expect(reg.has('image-only')).toBe(true);
  });
});

test('discover() accepts an array default export and registers each', async () => {
  await withDir(async (dir) => {
    await writeFile(
      join(dir, 'multi.js'),
      `const mk = (t) => ({ type: t, descriptor: { type: t, label: t, strategy: 'native' }, async *stream() {} });
       export default [mk('a'), mk('b')];`
    );
    const reg = new ModelProviderRegistry();
    const result = await reg.discover(dir);
    expect(new Set(result.registered)).toEqual(new Set(['a', 'b']));
    expect(reg.types().sort()).toEqual(['a', 'b']);
  });
});

test('a bad file is reported per-file and never blocks the good ones', async () => {
  await withDir(async (dir) => {
    await writeFile(join(dir, 'good.js'), goodProvider);
    await writeFile(join(dir, 'bad.js'), `export default { type: 'nope' };`); // no stream() ⇒ invalid
    const reg = new ModelProviderRegistry();
    const result = await reg.discover(dir);
    expect(reg.has('scanned')).toBe(true); // good one still registered
    expect(result.errors.some((e) => e.file === 'bad.js')).toBe(true);
  });
});

test('discover() on a missing dir resolves empty (never throws)', async () => {
  const reg = new ModelProviderRegistry();
  const result = await reg.discover(join(tmpdir(), 'monad-does-not-exist-xyz'));
  expect(result).toEqual({ registered: [], errors: [] });
});
