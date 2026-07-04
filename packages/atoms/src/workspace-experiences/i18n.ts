import type { StrictTranslateForNamespace } from '@monad/i18n';

import { createI18n } from '@monad/i18n';

export function workspaceExperienceT(): StrictTranslateForNamespace<'web'> {
  const locale =
    typeof document === 'undefined' ? 'en' : document.documentElement.lang || navigator.language.split('-')[0] || 'en';
  return createI18n({ locale, packs: [] }).t as StrictTranslateForNamespace<'web'>;
}
