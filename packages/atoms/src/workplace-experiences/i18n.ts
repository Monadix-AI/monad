import type { StrictTranslateForNamespace } from '@monad/i18n/browser';

import { createI18n } from '@monad/i18n/browser';

export function workplaceExperienceLocale(): string {
  return typeof document === 'undefined'
    ? 'en'
    : document.documentElement.lang || navigator.language.split('-')[0] || 'en';
}

export function workplaceExperienceT(): StrictTranslateForNamespace<'web'> {
  const locale = workplaceExperienceLocale();
  return createI18n({ locale, packs: [] }).t as StrictTranslateForNamespace<'web'>;
}
