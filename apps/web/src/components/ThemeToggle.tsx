import { ComputerIcon, Moon02Icon, Sun03Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger
} from '@monad/ui';
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

  const selectTheme = (value: string) => {
    if (value !== 'auto' && value !== 'dark' && value !== 'light') return;
    setPreference(value);
    void transitionThemePreference(value, triggerRef.current);
  };

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              aria-label={t('web.theme.toggle')}
              className="size-7"
              ref={triggerRef}
              size="icon"
              variant="ghost"
            >
              <HugeiconsIcon icon={currentOption.icon} />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>{t(currentOption.label)}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent
        align="end"
        side="top"
      >
        <DropdownMenuRadioGroup
          onValueChange={selectTheme}
          value={preference}
        >
          {THEME_OPTIONS.map((option) => (
            <DropdownMenuRadioItem
              key={option.value}
              value={option.value}
            >
              <HugeiconsIcon icon={option.icon} />
              {t(option.label)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
