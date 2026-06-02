// en is the canonical/fallback catalog: every key any other locale ships MUST also exist in en,
// or that locale's key falls back to the raw key string at runtime (English shows "cli.atom.foo"
// instead of text). This guards against the reverse drift — a key added only to a translation.

import { expect, test } from 'bun:test';

import { loadLocalePacksFromDir } from '../../src/index.ts';
import { BUILTIN_LOCALES_DIR } from '../../src/locale-dir.ts';

test('every zh key exists in en (en is the fallback superset)', async () => {
  const packs = await loadLocalePacksFromDir(BUILTIN_LOCALES_DIR);
  const en = packs.find((p) => p.locale === 'en');
  const zh = packs.find((p) => p.locale === 'zh');
  if (!en || !zh) throw new Error('en or zh locale pack not found in BUILTIN_LOCALES_DIR');
  const enKeys = new Set(Object.keys(en.messages));
  const missing = Object.keys(zh.messages).filter((k) => !enKeys.has(k));
  expect(missing).toEqual([]);
});
