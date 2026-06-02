import type { MouseEvent } from 'react';

import { Moon02Icon, Sun03Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { Button, Tooltip, TooltipContent, TooltipTrigger } from '@monad/ui';
import { useEffect, useState } from 'react';

import { useT } from '#/components/I18nProvider';
import {
  applyThemePreference,
  getThemePreference,
  resolveThemePreference,
  transitionThemePreference
} from '#/lib/theme';

export function ThemeToggle() {
  const t = useT();
  const [dark, setDark] = useState(false);

  useEffect(() => {
    const preference = getThemePreference();
    setDark(applyThemePreference(preference));
    if (preference !== 'auto') return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const sync = () => setDark(applyThemePreference('auto'));
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, []);

  const toggle = (event: MouseEvent<HTMLButtonElement>) => {
    const nextPreference = resolveThemePreference(getThemePreference()) ? 'light' : 'dark';
    void transitionThemePreference(nextPreference, event.currentTarget).then(setDark);
  };

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          aria-label={t('web.theme.toggle')}
          className="size-7"
          onClick={toggle}
          size="icon"
          variant="ghost"
        >
          {dark ? <HugeiconsIcon icon={Sun03Icon} /> : <HugeiconsIcon icon={Moon02Icon} />}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{dark ? t('web.theme.light') : t('web.theme.dark')}</TooltipContent>
    </Tooltip>
  );
}
