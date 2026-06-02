'use client';

import { useListLicensesQuery } from '@monad/client-rtk';
import { Button, Input } from '@monad/ui';
import { ExternalLink, Scale, X } from 'lucide-react';
import { useState } from 'react';

import { useT } from '@/components/I18nProvider';

interface Props {
  onClose: () => void;
}

export function LicensesSettings({ onClose }: Props) {
  const t = useT();
  const { data, isLoading } = useListLicensesQuery();
  const [search, setSearch] = useState('');

  const packages = data?.packages ?? [];
  const filtered = search
    ? packages.filter(
        (p) =>
          p.name.toLowerCase().includes(search.toLowerCase()) || p.license.toLowerCase().includes(search.toLowerCase())
      )
    : packages;

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex items-center justify-between border-b px-6 py-4">
        <div className="flex items-center gap-2">
          <Scale className="size-4 text-muted-foreground" />
          <span className="font-semibold text-sm">{t('web.licenses.title')}</span>
          {filtered.length > 0 && (
            <span className="rounded-full bg-muted px-2 py-0.5 text-muted-foreground text-xs">{filtered.length}</span>
          )}
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

      <div className="flex flex-col gap-3 px-6 py-4">
        <p className="text-muted-foreground text-sm">{t('web.licenses.desc')}</p>
        <Input
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('web.licenses.searchPlaceholder')}
          value={search}
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
        {isLoading ? (
          <p className="text-muted-foreground text-sm">{t('web.licenses.loading')}</p>
        ) : filtered.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t('web.licenses.empty')}</p>
        ) : (
          <div className="flex flex-col gap-1">
            {filtered.map((pkg) => (
              <div
                className="flex items-center justify-between rounded-md px-2 py-2 hover:bg-muted/50"
                key={pkg.name}
              >
                <div className="flex min-w-0 flex-col">
                  <span className="truncate font-mono text-sm">{pkg.name}</span>
                  <span className="text-muted-foreground text-xs">{pkg.version}</span>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span className="rounded border px-1.5 py-0.5 font-medium text-xs">{pkg.license}</span>
                  {pkg.homepage && (
                    <a
                      className="text-muted-foreground hover:text-foreground"
                      href={pkg.homepage}
                      rel="noreferrer"
                      target="_blank"
                    >
                      <ExternalLink className="size-3.5" />
                    </a>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
