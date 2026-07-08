export { enMessages, zhMessages } from './messages.generated.ts';

import { enMessages, zhMessages } from './messages.generated.ts';

export function builtinMessagesForLocale(locale: string): Record<string, string> {
  return locale === 'zh' ? zhMessages : enMessages;
}

const builtinCatalogCache = new Map<string, Readonly<Record<string, string>>>();

export function buildBuiltinCatalog(locale: string, fallback = 'en'): Record<string, string> {
  const cacheKey = `${locale}\0${fallback}`;
  const cached = builtinCatalogCache.get(cacheKey);
  if (cached) return cached;

  const active = builtinMessagesForLocale(locale);
  const fb = builtinMessagesForLocale(fallback);
  const out: Record<string, string> = {};
  for (const key of new Set([...Object.keys(fb), ...Object.keys(active)])) {
    out[key] = active[key] ?? fb[key] ?? key;
  }
  const catalog = Object.freeze(out);
  builtinCatalogCache.set(cacheKey, catalog);
  return catalog;
}
