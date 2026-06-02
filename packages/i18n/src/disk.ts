// Filesystem loader for locale packs stored in the monad flat JSON namespace directory convention:
//   <localesDir>/<lng>/<namespace>.json
// All namespace files for a <lng> are merged into one flat LocalePack.messages object
// (runtime stays single-namespace since keySeparator/nsSeparator are off).
// Plural keys: <key>_one / <key>_other (CLDR cardinal forms via Intl.PluralRules).

import type { LocalePack } from './types.ts';

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

function parseNamespaceMessages(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const messages: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== 'string') return undefined;
    messages[key] = value;
  }
  return messages;
}

/** Load all locale packs found under `localesDir` (non-recursive, one level of <lng> subdirs).
 *  Each <lng> subdir may contain one or more <namespace>.json files; all are merged into one
 *  flat messages object. The `name` field defaults to the locale tag; callers may override it
 *  via the returned array if a display name is needed. */
export async function loadLocalePacksFromDir(
  localesDir: string,
  nameFor?: (locale: string) => string | undefined
): Promise<LocalePack[]> {
  let lngDirs: string[];
  try {
    const entries = await readdir(localesDir, { withFileTypes: true });
    lngDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
  const packs: LocalePack[] = [];
  for (const lng of lngDirs) {
    const lngDir = join(localesDir, lng);
    let nsFiles: string[];
    try {
      const entries = await readdir(lngDir, { withFileTypes: true });
      nsFiles = entries.filter((e) => e.isFile() && e.name.endsWith('.json')).map((e) => e.name);
    } catch {
      continue;
    }
    const messages: Record<string, string> = {};
    for (const nsFile of nsFiles) {
      try {
        const raw = JSON.parse(await Bun.file(join(lngDir, nsFile)).text());
        const namespaceMessages = parseNamespaceMessages(raw);
        if (namespaceMessages) Object.assign(messages, namespaceMessages);
      } catch {
        // skip malformed namespace file
      }
    }
    if (Object.keys(messages).length > 0) {
      packs.push({ locale: lng, name: nameFor?.(lng) ?? lng, messages });
    }
  }
  return packs;
}

/** Resolve the absolute path to a locale pack directory shipped inside an installed npm package.
 *  `packageDir` is the root of the installed atom pack (e.g. ~/.monad/atoms/<name>/).
 *  `localeDirs` defaults to `['locales']` per the manifest convention. */
export function resolvePackageLocaleDirs(packageDir: string, localeDirs?: string[]): string[] {
  return (localeDirs ?? ['locales']).map((d) => join(packageDir, d));
}

/** Display names for common locale tags (used as fallback when no explicit name is provided). */
const LOCALE_DISPLAY_NAMES: Record<string, string> = {
  en: 'English',
  zh: '简体中文',
  'zh-CN': '简体中文',
  'zh-TW': '繁體中文',
  ja: '日本語',
  ko: '한국어',
  de: 'Deutsch',
  fr: 'Français',
  es: 'Español',
  pt: 'Português',
  ru: 'Русский',
  ar: 'العربية'
};

export function defaultLocaleName(locale: string): string {
  return LOCALE_DISPLAY_NAMES[locale] ?? locale;
}
