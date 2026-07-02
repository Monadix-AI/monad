'use client';

import { Cancel01Icon, ExternalLinkIcon, JusticeScaleIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useListLicensesQuery } from '@monad/client-rtk';
import { Button, Input } from '@monad/ui';
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

  const renderLicenses = () =>
    isLoading ? (
      <p className="text-muted-foreground text-sm">{t('web.licenses.loading')}</p>
    ) : filtered.length === 0 ? (
      <p className="text-muted-foreground text-sm">{t('web.licenses.empty')}</p>
    ) : (
      <div className="licenses-list">
        {filtered.map((pkg) => (
          <div
            className="licenses-row"
            key={pkg.name}
          >
            <div className="licenses-package flex min-w-0 flex-col">
              <span className="licenses-name truncate font-mono text-sm">{pkg.name}</span>
              <span className="licenses-version text-muted-foreground text-xs">{pkg.version}</span>
            </div>
            <div className="licenses-meta flex shrink-0 items-center gap-2">
              <span className="licenses-badge">{pkg.license}</span>
              {pkg.homepage && (
                <a
                  aria-label={`${pkg.name} homepage`}
                  className="licenses-link"
                  href={pkg.homepage}
                  rel="noreferrer"
                  target="_blank"
                >
                  <HugeiconsIcon
                    className="size-3.5"
                    icon={ExternalLinkIcon}
                  />
                </a>
              )}
            </div>
          </div>
        ))}
      </div>
    );

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex items-center justify-between border-b px-6 py-4">
        <div className="flex items-center gap-2">
          <HugeiconsIcon
            className="size-4 text-muted-foreground"
            icon={JusticeScaleIcon}
          />
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
          <HugeiconsIcon icon={Cancel01Icon} />
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

      <div className="licenses-scroll min-h-0 flex-1 overflow-y-auto px-6 pb-6">{renderLicenses()}</div>
    </div>
  );
}
