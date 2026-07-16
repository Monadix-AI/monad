// CLI-local i18n. The CLI emits text (usage, errors, init flow) before/around any daemon call, so it
// resolves its own translator from config.locale + the built-in en/zh packs + any drop-in `locale`
// atom pack under ~/.monad/atoms — the same packs the daemon loads, so a dropped-in language works in
// the CLI too. `initCliI18n()` runs once at startup; `t` is a stable indirection to the active build.

import type { Dirent } from 'node:fs';
import type { I18n, LocalePack, Translate } from '@monad/i18n';

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { getPaths, loadAll } from '@monad/environment';
import { createI18n, defaultLocaleName, loadLocalePacksFromDir } from '@monad/i18n';
import { BUILTIN_LOCALES_DIR } from '@monad/i18n/locale-dir';

let active: I18n = createI18n({ locale: 'en', packs: [] });

/** Translate against the active CLI locale. Stable across `initCliI18n()` rebuilds. */
export const t: Translate = (...args: Parameters<Translate>) => active.t(...args);

/** Resolve the locale from config + load all language packs (built-in + drop-in). Best-effort:
 *  a missing/invalid config or a broken atom pack never blocks the CLI — it falls back to English. */
export async function initCliI18n(): Promise<void> {
  const paths = getPaths();
  let locale = 'en';
  try {
    const cfg = await loadAll(paths);
    if (cfg) locale = cfg.locale;
  } catch {
    /* no/invalid config → English */
  }
  const seen = new Map<string, LocalePack>();
  // Drop-in packs win over built-in for a given locale tag (mirrors the daemon's first-wins order).
  for (const p of await loadDropInLocalePacks(paths.packs)) {
    if (!seen.has(p.locale)) seen.set(p.locale, p);
  }
  for (const p of await loadLocalePacksFromDir(BUILTIN_LOCALES_DIR, defaultLocaleName)) {
    if (!seen.has(p.locale)) seen.set(p.locale, p);
  }
  active = createI18n({ locale, packs: [...seen.values()] });
}

/** Discover `<pack>/locales/` dirs under the installed-packs dir (CLI only needs language packs).
 *  Disabled packs (`.install.json` enabled:false) are skipped. Best-effort: never throws. */
async function loadDropInLocalePacks(packsDir: string): Promise<LocalePack[]> {
  const packs: LocalePack[] = [];
  let entries: Dirent[];
  try {
    entries = await readdir(packsDir, { withFileTypes: true });
  } catch {
    return packs; // packs dir absent → nothing to discover
  }
  for (const e of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    if (!e.isDirectory()) continue;
    const packDir = join(packsDir, e.name);
    try {
      const record = JSON.parse(await Bun.file(join(packDir, '.install.json')).text()) as { enabled?: boolean };
      if (record.enabled === false) continue;
    } catch {
      /* no install record → treat as enabled */
    }
    for (const p of await loadLocalePacksFromDir(join(packDir, 'locales'), defaultLocaleName)) packs.push(p);
  }
  return packs;
}
