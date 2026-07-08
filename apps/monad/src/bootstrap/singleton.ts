import type { MonadPaths } from '@monad/home';

import { createI18n, defaultLocaleName, loadLocalePacksFromDir } from '@monad/i18n';
import { BUILTIN_LOCALES_DIR } from '@monad/i18n/locale-dir';

import { acquireSingletonLock } from '#/infra/singleton-lock.ts';

export async function acquireDaemonSingletonLock(paths: MonadPaths): Promise<void> {
  // Bootstrap a minimal i18n instance just for the singleton lock error — locale comes from a
  // fast config peek so the error message is localized even before full config loading.
  const earlyLocale = await Bun.file(paths.config)
    .json()
    .then((c: { locale?: string }) => c?.locale ?? 'en')
    .catch(() => 'en');
  const earlyPacks = await loadLocalePacksFromDir(BUILTIN_LOCALES_DIR, defaultLocaleName);
  const earlyI18n = createI18n({ locale: earlyLocale, packs: earlyPacks });
  await acquireSingletonLock(earlyI18n.t, paths.pid);
}
