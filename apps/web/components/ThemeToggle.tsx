'use client';

import { Button, Tooltip, TooltipContent, TooltipTrigger } from '@monad/ui';
import { Moon, Sun } from 'lucide-react';
import { useEffect, useState } from 'react';

import { useT } from '@/components/I18nProvider';

const KEY = 'monad:theme';

function apply(dark: boolean): void {
  document.documentElement.classList.toggle('dark', dark);
}

export function ThemeToggle() {
  const t = useT();
  const [dark, setDark] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem(KEY);
    const isDark = stored ? stored === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
    setDark(isDark);
    apply(isDark);
  }, []);

  const toggle = () => {
    setDark((prev) => {
      const next = !prev;
      apply(next);
      localStorage.setItem(KEY, next ? 'dark' : 'light');
      return next;
    });
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
          {dark ? <Sun /> : <Moon />}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{dark ? t('web.theme.light') : t('web.theme.dark')}</TooltipContent>
    </Tooltip>
  );
}
