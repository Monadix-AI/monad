import { expect, test } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { defaultLocaleName, loadLocalePacksFromDir, resolvePackageLocaleDirs } from '../../src/disk.ts';

async function makeTempDir(): Promise<string> {
  const dir = join(tmpdir(), `monad-i18n-test-${process.pid}-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

// ── loadLocalePacksFromDir ─────────────────────────────────────────────────────

test('loadLocalePacksFromDir: returns empty array for nonexistent directory', async () => {
  const _packs = await loadLocalePacksFromDir('/nonexistent/locales/path');
});

test('loadLocalePacksFromDir: returns empty array for empty directory', async () => {
  const dir = await makeTempDir();
  try {
    const _packs = await loadLocalePacksFromDir(dir);
  } finally {
    await rm(dir, { recursive: true });
  }
});

test('loadLocalePacksFromDir: loads a single locale with one namespace file', async () => {
  const dir = await makeTempDir();
  try {
    await mkdir(join(dir, 'en'));
    await writeFile(join(dir, 'en', 'common.json'), JSON.stringify({ 'app.title': 'Monad', 'app.ok': 'OK' }));

    const packs = await loadLocalePacksFromDir(dir);
    expect(packs).toHaveLength(1);
    expect(packs[0]?.locale).toBe('en');
    expect(packs[0]?.messages['app.title']).toBe('Monad');
    expect(packs[0]?.messages['app.ok']).toBe('OK');
  } finally {
    await rm(dir, { recursive: true });
  }
});

test('loadLocalePacksFromDir: merges multiple namespace files for one locale', async () => {
  const dir = await makeTempDir();
  try {
    await mkdir(join(dir, 'zh'));
    await writeFile(join(dir, 'zh', 'common.json'), JSON.stringify({ 'app.title': '魔点' }));
    await writeFile(join(dir, 'zh', 'cli.json'), JSON.stringify({ 'cli.help': '帮助' }));

    const packs = await loadLocalePacksFromDir(dir);
    expect(packs).toHaveLength(1);
    expect(packs[0]?.messages['app.title']).toBe('魔点');
    expect(packs[0]?.messages['cli.help']).toBe('帮助');
  } finally {
    await rm(dir, { recursive: true });
  }
});

test('loadLocalePacksFromDir: loads multiple locales', async () => {
  const dir = await makeTempDir();
  try {
    await mkdir(join(dir, 'en'));
    await writeFile(join(dir, 'en', 'common.json'), JSON.stringify({ hello: 'Hello' }));
    await mkdir(join(dir, 'ja'));
    await writeFile(join(dir, 'ja', 'common.json'), JSON.stringify({ hello: 'こんにちは' }));

    const packs = await loadLocalePacksFromDir(dir);
    expect(packs).toHaveLength(2);
    const locales = packs.map((p) => p.locale).sort();
    expect(locales).toEqual(['en', 'ja']);
  } finally {
    await rm(dir, { recursive: true });
  }
});

test('loadLocalePacksFromDir: applies nameFor callback to set display name', async () => {
  const dir = await makeTempDir();
  try {
    await mkdir(join(dir, 'en'));
    await writeFile(join(dir, 'en', 'common.json'), JSON.stringify({ key: 'value' }));

    const packs = await loadLocalePacksFromDir(dir, (locale) => (locale === 'en' ? 'English' : undefined));
    expect(packs[0]?.name).toBe('English');
  } finally {
    await rm(dir, { recursive: true });
  }
});

test('loadLocalePacksFromDir: defaults name to locale tag when nameFor returns undefined', async () => {
  const dir = await makeTempDir();
  try {
    await mkdir(join(dir, 'fr'));
    await writeFile(join(dir, 'fr', 'common.json'), JSON.stringify({ key: 'valeur' }));

    const packs = await loadLocalePacksFromDir(dir, () => undefined);
    expect(packs[0]?.name).toBe('fr');
  } finally {
    await rm(dir, { recursive: true });
  }
});

test('loadLocalePacksFromDir: skips malformed JSON namespace files', async () => {
  const dir = await makeTempDir();
  try {
    await mkdir(join(dir, 'en'));
    await writeFile(join(dir, 'en', 'valid.json'), JSON.stringify({ key: 'value' }));
    await writeFile(join(dir, 'en', 'broken.json'), '{invalid json}');

    const packs = await loadLocalePacksFromDir(dir);
    expect(packs).toHaveLength(1);
    expect(packs[0]?.messages.key).toBe('value');
    // The broken file's key should not have been added.
  } finally {
    await rm(dir, { recursive: true });
  }
});

test('loadLocalePacksFromDir: skips namespace files that are not flat objects', async () => {
  const dir = await makeTempDir();
  try {
    await mkdir(join(dir, 'en'));
    await writeFile(join(dir, 'en', 'valid.json'), JSON.stringify({ key: 'value' }));
    await writeFile(join(dir, 'en', 'array.json'), JSON.stringify(['bad']));

    const packs = await loadLocalePacksFromDir(dir);
    expect(packs).toHaveLength(1);
    expect(packs[0]?.messages).toEqual({ key: 'value' });
  } finally {
    await rm(dir, { recursive: true });
  }
});

test('loadLocalePacksFromDir: skips namespace files with non-string values', async () => {
  const dir = await makeTempDir();
  try {
    await mkdir(join(dir, 'en'));
    await writeFile(join(dir, 'en', 'valid.json'), JSON.stringify({ key: 'value' }));
    await writeFile(join(dir, 'en', 'invalid.json'), JSON.stringify({ bad: 1 }));

    const packs = await loadLocalePacksFromDir(dir);
    expect(packs).toHaveLength(1);
    expect(packs[0]?.messages).toEqual({ key: 'value' });
  } finally {
    await rm(dir, { recursive: true });
  }
});

test('loadLocalePacksFromDir: skips locale dirs with no JSON files', async () => {
  const dir = await makeTempDir();
  try {
    await mkdir(join(dir, 'en'));
    await writeFile(join(dir, 'en', 'readme.txt'), 'not json');

    const _packs = await loadLocalePacksFromDir(dir);
  } finally {
    await rm(dir, { recursive: true });
  }
});

test('loadLocalePacksFromDir: ignores non-directory entries at root level', async () => {
  const dir = await makeTempDir();
  try {
    await mkdir(join(dir, 'en'));
    await writeFile(join(dir, 'en', 'common.json'), JSON.stringify({ key: 'value' }));
    await writeFile(join(dir, 'README.md'), '# locales');

    const packs = await loadLocalePacksFromDir(dir);
    expect(packs).toHaveLength(1);
    expect(packs[0]?.locale).toBe('en');
  } finally {
    await rm(dir, { recursive: true });
  }
});

// ── resolvePackageLocaleDirs ───────────────────────────────────────────────────

test('resolvePackageLocaleDirs: defaults to locales/ subdirectory', () => {
  const dirs = resolvePackageLocaleDirs('/opt/atoms/my-pack');
  expect(dirs).toHaveLength(1);
  expect(dirs[0]).toBe(join('/opt/atoms/my-pack', 'locales'));
});

test('resolvePackageLocaleDirs: respects custom localeDirs', () => {
  const dirs = resolvePackageLocaleDirs('/opt/atoms/my-pack', ['i18n', 'lang']);
  expect(dirs).toEqual([join('/opt/atoms/my-pack', 'i18n'), join('/opt/atoms/my-pack', 'lang')]);
});

// ── defaultLocaleName ──────────────────────────────────────────────────────────

test('defaultLocaleName: returns known locale display names', () => {
  expect(defaultLocaleName('en')).toBe('English');
  expect(defaultLocaleName('zh')).toBe('简体中文');
  expect(defaultLocaleName('zh-CN')).toBe('简体中文');
  expect(defaultLocaleName('zh-TW')).toBe('繁體中文');
  expect(defaultLocaleName('ja')).toBe('日本語');
  expect(defaultLocaleName('de')).toBe('Deutsch');
});

test('defaultLocaleName: returns locale tag for unknown locales', () => {
  expect(defaultLocaleName('xx-UNKNOWN')).toBe('xx-UNKNOWN');
  expect(defaultLocaleName('tlh')).toBe('tlh');
});
