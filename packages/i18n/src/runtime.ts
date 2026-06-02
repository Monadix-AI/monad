import type { LocalePack, MessageId, TParams, Translate } from './types.ts';

import { buildBuiltinCatalog } from './messages.ts';

export const BUILTIN_LOCALES = ['en', 'zh'] as const;
export const DEFAULT_LOCALE = 'en';

const BUILTIN_LOCALE_SET = new Set<string>(BUILTIN_LOCALES);

export interface CreateI18nOptions {
  /** Active locale tag (e.g. 'en', 'zh'). */
  locale: string;
  /** Available packs. Later packs for the same locale override earlier keys. */
  packs: LocalePack[];
  /** Locale used when the active locale lacks a key. Defaults to 'en'. */
  fallback?: string;
}

export interface I18n {
  readonly locale: string;
  readonly t: Translate;
}

function supportedLocale(locale: string, fallback: string = DEFAULT_LOCALE): string {
  if (BUILTIN_LOCALE_SET.has(locale)) return locale;
  if (BUILTIN_LOCALE_SET.has(fallback)) return fallback;
  return DEFAULT_LOCALE;
}

function byLocale(packs: LocalePack[]): Map<string, Record<string, string>> {
  const map = new Map<string, Record<string, string>>();
  for (const pack of packs) {
    map.set(pack.locale, { ...(map.get(pack.locale) ?? {}), ...pack.messages });
  }
  return map;
}

function pluralKey(
  key: string,
  locale: string,
  fallback: string,
  params: TParams | undefined,
  catalogs: Map<string, Record<string, string>>
): string {
  if (typeof params?.count !== 'number') return key;
  const category = new Intl.PluralRules(locale).select(params.count);
  const candidate = `${key}_${category}`;
  if (resolveOverlayTemplate(candidate, locale, fallback, catalogs) !== undefined) {
    return candidate;
  }
  if (builtinTemplate(locale, fallback, candidate) !== undefined) {
    return candidate;
  }
  return key;
}

function formatTemplate(template: string, params?: TParams): string {
  if (!params) return template;
  return template.replaceAll(/{{\s*([A-Za-z_$][\w$]*)\s*}}/g, (_match, name: string) => String(params[name] ?? ''));
}

function resolveOverlayTemplate(
  key: string,
  locale: string,
  fallback: string,
  catalogs: Map<string, Record<string, string>>
): string | undefined {
  return catalogs.get(locale)?.[key] ?? catalogs.get(fallback)?.[key];
}

function builtinTemplate(locale: string, fallback: string, key: string): string | undefined {
  return buildBuiltinCatalog(locale, fallback)[key];
}

function tFrom(opts: CreateI18nOptions): Translate {
  const fallback = opts.fallback ?? DEFAULT_LOCALE;
  const builtinLocale = supportedLocale(opts.locale, fallback);
  const catalogs = byLocale(opts.packs);
  return ((key: MessageId, params?: TParams) => {
    const rawKey = String(key);
    const resolvedKey = pluralKey(rawKey, opts.locale, fallback, params, catalogs);
    const overlay = resolveOverlayTemplate(resolvedKey, opts.locale, fallback, catalogs);
    if (overlay !== undefined && overlay !== builtinTemplate(opts.locale, fallback, resolvedKey)) {
      return formatTemplate(overlay, params);
    }

    const builtin = builtinTemplate(builtinLocale, fallback, resolvedKey);
    if (builtin !== undefined) return formatTemplate(builtin, params);

    if (overlay !== undefined) return formatTemplate(overlay, params);
    return rawKey;
  }) as Translate;
}

export function createI18n(opts: CreateI18nOptions): I18n {
  return { locale: opts.locale, t: tFrom(opts) };
}

export function buildResources(packs: LocalePack[]): Record<string, Record<string, string>> {
  return Object.fromEntries(byLocale(packs));
}

export function buildCatalog(locale: string, packs: LocalePack[], fallback = DEFAULT_LOCALE): Record<string, string> {
  const catalogs = byLocale(packs);
  const builtin = buildBuiltinCatalog(locale, fallback);
  const active = catalogs.get(locale) ?? {};
  const fb = catalogs.get(fallback) ?? {};
  const allKeys = new Set([...Object.keys(builtin), ...Object.keys(fb), ...Object.keys(active)]);
  const out: Record<string, string> = {};
  for (const id of allKeys) {
    out[id] = active[id] ?? fb[id] ?? builtin[id] ?? id;
  }
  return out;
}

export function buildCatalogOverlay(
  locale: string,
  messages: Record<string, string>,
  fallback = DEFAULT_LOCALE
): Record<string, string> {
  const builtin = buildBuiltinCatalog(locale, fallback);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(messages)) {
    if (value !== builtin[key]) out[key] = value;
  }
  return out;
}
