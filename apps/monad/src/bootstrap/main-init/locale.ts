// Locale gateway: file-scan loading from the builtin locale dir + any installed atom-pack locale
// dirs (~/.monad/locales/<packName>/<lng>/<namespace>.json). Third-party packs override the
// built-in for the same tag (first discovered per tag wins across pack directories).

import type { MonadConfig, MonadPaths } from '@monad/home';

import { defaultLocaleName, loadLocalePacksFromDir } from '@monad/i18n';
import { BUILTIN_LOCALES_DIR } from '@monad/i18n/locale-dir';

import { I18nService, loadInstalledLocalePacks } from '@/services/i18n.ts';

export async function createLocaleService(paths: MonadPaths, locale: MonadConfig['locale']): Promise<I18nService> {
  const builtinLocalePacks = await loadLocalePacksFromDir(BUILTIN_LOCALES_DIR, defaultLocaleName);
  const installedLocalePacks = await loadInstalledLocalePacks(paths.packs, paths.locales, defaultLocaleName);
  return new I18nService([...builtinLocalePacks, ...installedLocalePacks], locale);
}
