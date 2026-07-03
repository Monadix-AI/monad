'use client';

import { Cancel01Icon, ColorsIcon, HandIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useGetAppearanceQuery, useGetProfileSettingsQuery, useSetAppearanceMutation } from '@monad/client-rtk';
import { AVATAR_STYLES, entityAvatarUrl } from '@monad/protocol';
import { Button, ScrollArea, Separator, Switch } from '@monad/ui';
import Image from 'next/image';
import { useEffect, useState } from 'react';

import { useT } from '@/components/I18nProvider';
import { isInteractiveCursorEnabled, setInteractiveCursorEnabled } from '@/lib/interactive-cursor';

interface Props {
  onClose: () => void;
}

export function AppearanceSettings({ onClose }: Props) {
  const t = useT();
  const { data: appearance } = useGetAppearanceQuery();
  const [setAppearance, { isLoading: isSavingAppearance }] = useSetAppearanceMutation();
  const { data: profile } = useGetProfileSettingsQuery();
  const [interactiveCursor, setInteractiveCursor] = useState(false);
  // Stable seed for the style-picker swatches so switching styles doesn't refetch on every keystroke elsewhere.
  const styleSwatchSeed = `user:${profile?.displayName || 'Operator'}`;

  useEffect(() => {
    setInteractiveCursor(isInteractiveCursorEnabled());
  }, []);

  async function handleAvatarStyle(avatarStyle: (typeof AVATAR_STYLES)[number]['slug']) {
    await setAppearance({ avatarStyle }).unwrap();
  }

  function handleInteractiveCursor(enabled: boolean) {
    setInteractiveCursor(enabled);
    setInteractiveCursorEnabled(enabled);
  }

  return (
    <ScrollArea className="h-full">
      <div className="flex min-h-full flex-col">
        <div className="flex items-center justify-between border-b px-6 py-4">
          <div className="flex items-center gap-2">
            <HugeiconsIcon
              className="size-4 text-muted-foreground"
              icon={ColorsIcon}
            />
            <span className="font-semibold text-sm">{t('web.settings.appearance')}</span>
          </div>
          <Button
            aria-label={t('web.close')}
            className="size-7"
            onClick={onClose}
            size="icon"
            variant="ghost"
          >
            <HugeiconsIcon icon={Cancel01Icon} />
          </Button>
        </div>

        <div className="flex flex-col gap-6 p-6">
          <p className="text-muted-foreground text-sm">{t('web.settings.appearanceDesc')}</p>

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
                    <Image
                      alt=""
                      className="size-full object-cover"
                      fill
                      src={entityAvatarUrl(styleSwatchSeed, style.slug)}
                      unoptimized
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
