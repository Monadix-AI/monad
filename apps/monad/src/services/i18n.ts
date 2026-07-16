// I18nService — the locale gateway. Modeled on ModelService: constructed in main.ts, holds the
// active I18n built from cfg.locale + the language packs registered by `locale` atom packs, and
// hot-reloads when the locale setting changes (settings handler calls reload()) or when atom packs are
// re-discovered (setPacks()). Exposes a STABLE `t` that always delegates to the latest build, so
// consumers (channel renderer, command services) can capture it once at wiring time.

import type { MonadConfig } from '@monad/environment';
import type { I18n, LocalePack, MessageId, TParams, Translate } from '@monad/i18n';

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { buildCatalog, createI18n, loadLocalePacksFromDir } from '@monad/i18n';

/**
 * Load all LocalePacks from two sources:
 *   1. `userLocalesDir` — user-manually-installed flat dir (`<lng>/<ns>.json`); wins over atom packs
 *   2. `<atomsDir>/<packName>/locales/` — locale dirs embedded in each installed atom pack
 * First-wins per locale tag: user dir > atom packs (sorted alphabetically) > builtin (handled upstream).
 */
export async function loadInstalledLocalePacks(
  atomsDir: string,
  userLocalesDir: string,
  nameFor?: (locale: string) => string | undefined
): Promise<LocalePack[]> {
  const seen = new Map<string, LocalePack>();

  const register = (p: LocalePack) => {
    if (!seen.has(p.locale)) seen.set(p.locale, p);
  };

  // User-installed locales win first.
  for (const p of await loadLocalePacksFromDir(userLocalesDir, nameFor)) register(p);

  // Atom pack embedded locales, sorted by pack name for stable ordering.
  let packNames: string[];
  try {
    const entries = await readdir(atomsDir, { withFileTypes: true });
    packNames = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    packNames = [];
  }
  for (const packName of packNames) {
    const localesDir = join(atomsDir, packName, 'locales');
    for (const p of await loadLocalePacksFromDir(localesDir, nameFor)) register(p);
  }

  return [...seen.values()];
}

export class I18nService {
  private packs: LocalePack[];
  private i18n: I18n;
  /** Stable translator — captures `this`, resolves against the current i18n on every call. */
  readonly t: Translate = (key: MessageId, params?: TParams) => this.i18n.t(key, params);

  constructor(packs: LocalePack[], locale: string) {
    this.packs = packs;
    this.i18n = createI18n({ locale, packs });
  }

  get locale(): string {
    return this.i18n.locale;
  }

  /** Rebuild for the locale in `cfg` (called after a settings commit). */
  reload(cfg: MonadConfig): void {
    this.i18n = createI18n({ locale: cfg.locale, packs: this.packs });
  }

  /** Swap the registered packs (e.g. after an atom pack install/remove re-discovers), keeping locale. */
  setPacks(packs: LocalePack[], locale: string): void {
    this.packs = packs;
    this.i18n = createI18n({ locale, packs });
  }

  /** Distinct registered locales for the language picker (first display name per locale wins). */
  list(): { locale: string; name: string }[] {
    const seen = new Map<string, string>();
    for (const p of this.packs) if (!seen.has(p.locale)) seen.set(p.locale, p.name);
    return [...seen].map(([locale, name]) => ({ locale, name }));
  }

  /** Raw (unformatted) message templates for a locale — the web catalog endpoint payload. */
  catalog(locale: string): Record<string, string> {
    return buildCatalog(locale, this.packs);
  }
}
