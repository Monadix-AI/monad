import type { Dirent } from 'node:fs';
import type { I18n, LocalePack, MessageId, TParams, Translate } from '../../../../packages/i18n/src/index.ts';

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { getPaths, loadAll } from '@monad/environment';
import { z } from 'zod';

import { createI18n, defaultLocaleName, loadLocalePacksFromDir } from '../../../../packages/i18n/src/index.ts';
import { BUILTIN_LOCALES_DIR } from '../../../../packages/i18n/src/locale-dir.ts';

const installRecordSchema = z.object({ enabled: z.boolean().optional() });

let active: I18n = createI18n({ locale: 'en', packs: [] });

export const t: Translate = (key: MessageId, params?: TParams) => active.t(key, params);

export async function initTuiI18n(): Promise<void> {
  const paths = getPaths();
  let locale = 'en';
  try {
    const cfg = await loadAll(paths);
    if (cfg) locale = cfg.locale;
  } catch {
    // Invalid or missing config falls back to English.
  }

  const seen = new Map<string, LocalePack>();
  for (const p of await loadDropInLocalePacks(paths.packs)) {
    if (!seen.has(p.locale)) seen.set(p.locale, p);
  }
  for (const p of await loadLocalePacksFromDir(BUILTIN_LOCALES_DIR, defaultLocaleName)) {
    if (!seen.has(p.locale)) seen.set(p.locale, p);
  }

  active = createI18n({ locale, packs: [...seen.values()] });
}

async function loadDropInLocalePacks(packsDir: string): Promise<LocalePack[]> {
  const packs: LocalePack[] = [];
  let entries: Dirent[];
  try {
    entries = await readdir(packsDir, { withFileTypes: true });
  } catch {
    return packs;
  }

  for (const e of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    if (!e.isDirectory()) continue;
    const packDir = join(packsDir, e.name);
    try {
      const record = installRecordSchema.parse(JSON.parse(await Bun.file(join(packDir, '.install.json')).text()));
      if (record.enabled === false) continue;
    } catch {
      // Missing install record is treated as enabled.
    }
    for (const p of await loadLocalePacksFromDir(join(packDir, 'locales'), defaultLocaleName)) packs.push(p);
  }

  return packs;
}
