'use client';

import type { ComposerFollowUpBehavior, ComposerSendShortcut } from '@monad/protocol';

import { Cancel01Icon, SlidersHorizontalIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useGetAppearanceQuery, useSetAppearanceMutation } from '@monad/client-rtk';
import { DEFAULT_AVATAR_STYLE } from '@monad/protocol';
import { Button, ScrollArea } from '@monad/ui';
import { useMemo } from 'react';

import { useT } from '@/components/I18nProvider';
import { composerShortcutLabel, DEFAULT_COMPOSER_SETTINGS, normalizedComposerSettings } from '@/lib/composer-settings';

interface Props {
  onClose: () => void;
}

const SEND_SHORTCUTS: ComposerSendShortcut[] = ['enter', 'mod-enter-for-multiline', 'mod-enter-always'];
const FOLLOW_UP_BEHAVIORS: ComposerFollowUpBehavior[] = ['queue', 'steer'];

function isApplePlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform);
}

export function ComposerSettings({ onClose }: Props) {
  const t = useT();
  const { data: appearance } = useGetAppearanceQuery();
  const [setAppearance, { isLoading: saving }] = useSetAppearanceMutation();
  const composer = normalizedComposerSettings(appearance?.composer);
  const apple = useMemo(() => isApplePlatform(), []);

  async function updateComposer(patch: Partial<typeof composer>): Promise<void> {
    await setAppearance({
      avatarStyle: appearance?.avatarStyle ?? DEFAULT_AVATAR_STYLE,
      composer: { ...DEFAULT_COMPOSER_SETTINGS, ...composer, ...patch }
    }).unwrap();
  }

  return (
    <ScrollArea className="h-full">
      <div className="flex min-h-full flex-col">
        <div className="flex items-center justify-between border-b px-6 py-4">
          <div className="flex items-center gap-2">
            <HugeiconsIcon
              className="size-4 text-muted-foreground"
              icon={SlidersHorizontalIcon}
            />
            <span className="font-semibold text-sm">{t('web.settings.composer')}</span>
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

        <div className="flex flex-col gap-0 p-6">
          <section className="grid gap-4 rounded-t-md border px-4 py-4 sm:grid-cols-[minmax(0,1fr)_minmax(260px,480px)]">
            <div className="min-w-0">
              <h3 className="font-semibold text-sm">{t('web.settings.composer.sendShortcut')}</h3>
              <p className="mt-1 text-muted-foreground text-sm">{t('web.settings.composer.sendShortcutDesc')}</p>
            </div>
            <div className="flex min-w-0 flex-col gap-2 sm:items-end">
              <div className="inline-flex max-w-full rounded-md bg-muted p-1">
                {SEND_SHORTCUTS.map((shortcut) => (
                  <button
                    aria-pressed={composer.sendShortcut === shortcut}
                    className={`min-w-0 rounded px-3 py-1.5 text-left text-sm transition-colors ${
                      composer.sendShortcut === shortcut
                        ? 'bg-background text-foreground shadow-sm'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                    disabled={saving}
                    key={shortcut}
                    onClick={() => void updateComposer({ sendShortcut: shortcut })}
                    type="button"
                  >
                    {composerShortcutLabel(shortcut, apple)}
                  </button>
                ))}
              </div>
            </div>
          </section>

          <section className="grid gap-4 rounded-b-md border border-t-0 px-4 py-4 sm:grid-cols-[minmax(0,1fr)_minmax(260px,480px)]">
            <div className="min-w-0">
              <h3 className="font-semibold text-sm">{t('web.settings.composer.followUpBehavior')}</h3>
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
                    disabled={saving}
                    key={behavior}
                    onClick={() => void updateComposer({ followUpBehavior: behavior })}
                    type="button"
                  >
                    {behavior === 'queue' ? t('web.settings.composer.queue') : t('web.settings.composer.steer')}
                  </button>
                ))}
              </div>
            </div>
          </section>
        </div>
      </div>
    </ScrollArea>
  );
}
