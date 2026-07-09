'use client';

import type { WebMessageIdWithoutParams } from '@monad/i18n/browser';
import type { ComposerFollowUpBehavior, ComposerSendShortcut } from '@monad/protocol';
import type { MouseEvent } from 'react';

import { CheckIcon, HandIcon, LanguageSquareIcon, Moon02Icon, Sun03Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  localeAdapter,
  localeSelectors,
  useGetAppearanceQuery,
  useGetLocaleQuery,
  useGetProfileSettingsQuery,
  useListLocalesQuery,
  useSetAppearanceMutation,
  useSetLocaleMutation
} from '@monad/client-rtk';
import { DEFAULT_AVATAR_STYLE, entityAvatarUrl } from '@monad/protocol';
import { Button, cn, ScrollArea, Separator, Switch } from '@monad/ui';
import { useEffect, useMemo, useState } from 'react';

import { useT } from '#/components/I18nProvider';
import { AVATAR_STYLES } from '#/lib/avatar-styles';
import { composerShortcutLabel, DEFAULT_COMPOSER_SETTINGS, normalizedComposerSettings } from '#/lib/composer-settings';
import { isInteractiveCursorEnabled, setInteractiveCursorEnabled } from '#/lib/interactive-cursor';
import { applyThemePreference, getThemePreference, type ThemePreference, transitionThemePreference } from '#/lib/theme';

const SEND_SHORTCUTS: ComposerSendShortcut[] = ['enter', 'mod-enter-for-multiline', 'mod-enter-always'];
const FOLLOW_UP_BEHAVIORS: ComposerFollowUpBehavior[] = ['queue', 'steer'];
const THEME_PREFERENCES: ThemePreference[] = ['light', 'dark', 'auto'];
const THEME_LABEL_KEYS: Record<ThemePreference, WebMessageIdWithoutParams> = {
  auto: 'web.settings.experience.theme.auto',
  dark: 'web.settings.experience.theme.dark',
  light: 'web.settings.experience.theme.light'
};

function isApplePlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform);
}

export function AppearanceSettings() {
  const t = useT();
  const { data: appearance } = useGetAppearanceQuery();
  const [setAppearance, { isLoading: isSavingAppearance }] = useSetAppearanceMutation();
  const { data: profile } = useGetProfileSettingsQuery();
  const { data: localeData } = useListLocalesQuery();
  const locales = localeSelectors.selectAll(localeData ?? localeAdapter.getInitialState());
  const { data: activeLocale } = useGetLocaleQuery();
  const [setLocale, { isLoading: isSavingLocale }] = useSetLocaleMutation();
  const [interactiveCursor, setInteractiveCursor] = useState(false);
  const [themePreference, setThemePreference] = useState<ThemePreference>('auto');
  const [darkTheme, setDarkTheme] = useState(false);
  const composer = normalizedComposerSettings(appearance?.composer);
  const apple = useMemo(() => isApplePlatform(), []);
  // Stable seed for the style-picker swatches so switching styles doesn't refetch on every keystroke elsewhere.
  const styleSwatchSeed = `user:${profile?.displayName || 'Operator'}`;

  useEffect(() => {
    setInteractiveCursor(isInteractiveCursorEnabled());
    const preference = getThemePreference();
    setThemePreference(preference);
    setDarkTheme(applyThemePreference(preference));
  }, []);

  useEffect(() => {
    if (themePreference !== 'auto') return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const sync = () => setDarkTheme(applyThemePreference('auto'));
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, [themePreference]);

  async function handleAvatarStyle(avatarStyle: (typeof AVATAR_STYLES)[number]['slug']) {
    await setAppearance({
      avatarStyle,
      composer: appearance?.composer ?? DEFAULT_COMPOSER_SETTINGS
    }).unwrap();
  }

  async function updateComposer(patch: Partial<typeof composer>): Promise<void> {
    await setAppearance({
      avatarStyle: appearance?.avatarStyle ?? DEFAULT_AVATAR_STYLE,
      composer: { ...DEFAULT_COMPOSER_SETTINGS, ...composer, ...patch }
    }).unwrap();
  }

  function handleInteractiveCursor(enabled: boolean) {
    setInteractiveCursor(enabled);
    setInteractiveCursorEnabled(enabled);
  }

  function handleTheme(preference: ThemePreference, event: MouseEvent<HTMLButtonElement>) {
    setThemePreference(preference);
    void transitionThemePreference(preference, event.currentTarget).then(setDarkTheme);
  }

  return (
    <ScrollArea className="h-full">
      <div className="flex min-h-full flex-col">
        <div className="flex flex-col gap-6 p-6">
          <p className="text-muted-foreground text-sm">{t('web.settings.appearanceDesc')}</p>

          <section className="flex flex-col gap-3">
            <h3 className="font-semibold text-sm">{t('web.settings.experience.interface')}</h3>
            <div className="grid gap-3 rounded-md border px-3 py-2.5 sm:grid-cols-[minmax(0,1fr)_auto]">
              <div className="flex min-w-0 items-start gap-2">
                <HugeiconsIcon
                  className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
                  icon={darkTheme ? Moon02Icon : Sun03Icon}
                />
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-sm">{t('web.settings.experience.theme')}</span>
                  <span className="text-muted-foreground text-xs">{t('web.settings.experience.themeDesc')}</span>
                </div>
              </div>
              <div className="inline-flex w-fit rounded-md bg-muted p-1">
                {THEME_PREFERENCES.map((preference) => (
                  <button
                    aria-pressed={themePreference === preference}
                    className={cn(
                      'rounded px-3 py-1.5 text-sm transition-colors',
                      themePreference === preference
                        ? 'bg-background text-foreground shadow-sm'
                        : 'text-muted-foreground hover:text-foreground'
                    )}
                    key={preference}
                    onClick={(event) => handleTheme(preference, event)}
                    type="button"
                  >
                    {t(THEME_LABEL_KEYS[preference])}
                  </button>
                ))}
              </div>
            </div>

            <div className="rounded-md border p-2">
              <div className="mb-1 flex items-center gap-2 px-1.5 py-1">
                <HugeiconsIcon
                  className="size-3.5 text-muted-foreground"
                  icon={LanguageSquareIcon}
                />
                <span className="font-medium text-sm">{t('web.settings.language')}</span>
              </div>
              <div className="flex flex-col gap-1">
                {locales.map(({ locale, name }) => {
                  const current = locale === activeLocale;
                  return (
                    <Button
                      className={cn('justify-between')}
                      disabled={isSavingLocale}
                      key={locale}
                      onClick={() => void setLocale({ locale })}
                      variant={current ? 'secondary' : 'ghost'}
                    >
                      <span>{name}</span>
                      {current ? (
                        <HugeiconsIcon
                          className="size-4"
                          icon={CheckIcon}
                        />
                      ) : null}
                    </Button>
                  );
                })}
              </div>
            </div>
          </section>

          <Separator />

          <section className="flex flex-col gap-3">
            <h3 className="font-semibold text-sm">{t('web.settings.composer')}</h3>
            <div className="grid gap-4 rounded-t-md border px-4 py-4 sm:grid-cols-[minmax(0,1fr)_minmax(260px,480px)]">
              <div className="min-w-0">
                <h4 className="font-semibold text-sm">{t('web.settings.composer.sendShortcut')}</h4>
                <p className="mt-1 text-muted-foreground text-sm">{t('web.settings.composer.sendShortcutDesc')}</p>
              </div>
              <div className="flex min-w-0 flex-col gap-2 sm:items-end">
                <div className="inline-flex max-w-full flex-wrap rounded-md bg-muted p-1">
                  {SEND_SHORTCUTS.map((shortcut) => (
                    <button
                      aria-pressed={composer.sendShortcut === shortcut}
                      className={`min-w-0 rounded px-3 py-1.5 text-left text-sm transition-colors ${
                        composer.sendShortcut === shortcut
                          ? 'bg-background text-foreground shadow-sm'
                          : 'text-muted-foreground hover:text-foreground'
                      }`}
                      disabled={isSavingAppearance}
                      key={shortcut}
                      onClick={() => void updateComposer({ sendShortcut: shortcut })}
                      type="button"
                    >
                      {composerShortcutLabel(shortcut, apple)}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="grid gap-4 rounded-b-md border border-t-0 px-4 py-4 sm:grid-cols-[minmax(0,1fr)_minmax(260px,480px)]">
              <div className="min-w-0">
                <h4 className="font-semibold text-sm">{t('web.settings.composer.followUpBehavior')}</h4>
                <p className="mt-1 text-muted-foreground text-sm">
                  {t('web.settings.composer.followUpBehaviorDesc', {
                    shortcut: apple ? '⌘↵' : 'Ctrl↵'
                  })}
                </p>
              </div>
              <div className="flex min-w-0 justify-start sm:justify-end">
                <div className="inline-flex rounded-md bg-muted p-1">
                  {FOLLOW_UP_BEHAVIORS.map((behavior) => (
                    <button
                      aria-pressed={composer.followUpBehavior === behavior}
                      className={`rounded px-4 py-1.5 text-sm capitalize transition-colors ${
                        composer.followUpBehavior === behavior
                          ? 'bg-background text-foreground shadow-sm'
                          : 'text-muted-foreground hover:text-foreground'
                      }`}
                      disabled={isSavingAppearance}
                      key={behavior}
                      onClick={() => void updateComposer({ followUpBehavior: behavior })}
                      type="button"
                    >
                      {behavior === 'queue' ? t('web.settings.composer.queue') : t('web.settings.composer.steer')}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </section>

          <Separator />

          <section className="flex flex-col gap-3">
            <div>
              <h3 className="font-semibold text-sm">{t('web.settings.appearance.avatarStyle')}</h3>
              <p className="text-muted-foreground text-xs">{t('web.settings.appearance.avatarStyleDesc')}</p>
            </div>
            <div className="grid grid-cols-5 gap-3 sm:grid-cols-8">
              {AVATAR_STYLES.map((style) => (
                <button
                  aria-label={style.label}
                  aria-pressed={appearance?.avatarStyle === style.slug}
                  className={`flex flex-col items-center gap-1 rounded-md border p-2 text-center transition-colors ${
                    appearance?.avatarStyle === style.slug
                      ? 'border-primary bg-primary/5'
                      : 'border-transparent hover:bg-muted'
                  }`}
                  disabled={isSavingAppearance}
                  key={style.slug}
                  onClick={() => void handleAvatarStyle(style.slug)}
                  type="button"
                >
                  <div className="relative size-10 shrink-0 overflow-hidden rounded-full bg-muted">
                    <img
                      alt=""
                      className="absolute inset-0 size-full object-cover"
                      src={entityAvatarUrl(styleSwatchSeed, style.slug)}
                    />
                  </div>
                  <span className="truncate text-xs">{style.label}</span>
                </button>
              ))}
            </div>
          </section>

          <Separator />

          <section className="flex flex-col gap-3">
            <h3 className="font-semibold text-sm">{t('web.settings.appearance.interactiveCursor')}</h3>
            <div className="flex items-center justify-between gap-4 rounded-md border px-3 py-2.5">
              <div className="flex min-w-0 items-start gap-2">
                <HugeiconsIcon
                  className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
                  icon={HandIcon}
                />
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-sm">{t('web.settings.appearance.interactiveCursor')}</span>
                  <span className="text-muted-foreground text-xs">
                    {t('web.settings.appearance.interactiveCursorDesc')}
                  </span>
                </div>
              </div>
              <Switch
                aria-label={t('web.settings.appearance.interactiveCursor')}
                checked={interactiveCursor}
                onCheckedChange={handleInteractiveCursor}
              />
            </div>
          </section>
        </div>
      </div>
    </ScrollArea>
  );
}
