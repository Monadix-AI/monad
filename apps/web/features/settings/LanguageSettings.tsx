'use client';

import {
  localeAdapter,
  localeSelectors,
  useGetLocaleQuery,
  useListLocalesQuery,
  useSetLocaleMutation
} from '@monad/client-rtk';
import { Button, cn } from '@monad/ui';
import { Check, Languages, X } from 'lucide-react';

import { useT } from '@/components/I18nProvider';

interface Props {
  onClose: () => void;
}

export function LanguageSettings({ onClose }: Props) {
  const t = useT();
  const { data } = useListLocalesQuery();
  const locales = localeSelectors.selectAll(data ?? localeAdapter.getInitialState());
  const { data: active } = useGetLocaleQuery();
  const [setLocale, { isLoading }] = useSetLocaleMutation();

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex items-center justify-between border-b px-6 py-4">
        <div className="flex items-center gap-2">
          <Languages className="size-4 text-muted-foreground" />
          <span className="font-semibold text-sm">{t('web.settings.language')}</span>
        </div>
        <Button
          aria-label={t('web.close')}
          className="size-7"
          onClick={onClose}
          size="icon"
          variant="ghost"
        >
          <X />
        </Button>
      </div>

      <div className="flex flex-1 flex-col gap-4 px-6 py-6">
        <p className="text-muted-foreground text-sm">{t('web.settings.languageDesc')}</p>

        <div className="flex flex-col gap-1">
          {locales.map(({ locale, name }) => {
            const current = locale === active;
            return (
              <Button
                className={cn('justify-between')}
                disabled={isLoading}
                key={locale}
                onClick={() => void setLocale({ locale })}
                variant={current ? 'secondary' : 'ghost'}
              >
                <span>{name}</span>
                {current && <Check className="size-4" />}
              </Button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
