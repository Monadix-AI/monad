import { ComputerIcon, Moon02Icon, Sun03Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { Button, Tooltip, TooltipContent, TooltipTrigger } from '@monad/ui';
import { useEffect, useRef, useState } from 'react';

import { useT } from '#/components/I18nProvider';
import { applyThemePreference, getThemePreference, type ThemePreference, transitionThemePreference } from '#/lib/theme';

const THEME_OPTIONS = [
  { icon: ComputerIcon, label: 'web.settings.experience.theme.auto', value: 'auto' },
  { icon: Moon02Icon, label: 'web.settings.experience.theme.dark', value: 'dark' },
  { icon: Sun03Icon, label: 'web.settings.experience.theme.light', value: 'light' }
] as const satisfies ReadonlyArray<{
  icon: typeof ComputerIcon;
  label:
    | 'web.settings.experience.theme.auto'
    | 'web.settings.experience.theme.dark'
    | 'web.settings.experience.theme.light';
  value: ThemePreference;
}>;

export function nextThemePreference(preference: ThemePreference): ThemePreference {
  if (preference === 'auto') return 'dark';
  if (preference === 'dark') return 'light';
  return 'auto';
}

export function ThemeToggle() {
  const t = useT();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [preference, setPreference] = useState<ThemePreference>('auto');

  useEffect(() => {
    const storedPreference = getThemePreference();
    setPreference(storedPreference);
    applyThemePreference(storedPreference);
  }, []);

  useEffect(() => {
    if (preference !== 'auto') return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const sync = () => applyThemePreference('auto');
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, [preference]);

  const currentOption = THEME_OPTIONS.find((option) => option.value === preference) ?? THEME_OPTIONS[0];

  const cycleTheme = () => {
    const nextPreference = nextThemePreference(preference);
    setPreference(nextPreference);
    void transitionThemePreference(nextPreference, triggerRef.current);
  };

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          aria-label={t('web.theme.toggle')}
          className="size-7"
          onClick={cycleTheme}
          ref={triggerRef}
          size="icon"
          variant="ghost"
        >
          <HugeiconsIcon icon={currentOption.icon} />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{t(currentOption.label)}</TooltipContent>
    </Tooltip>
  );
}
