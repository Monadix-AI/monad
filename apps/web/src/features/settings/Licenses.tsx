import {
  Cancel01Icon,
  ExternalLinkIcon,
  JusticeScaleIcon,
  PackageIcon,
  Search01Icon
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useListLicensesQuery } from '@monad/client-rtk';
import { Button, Input, Skeleton } from '@monad/ui';
import { memo, useState } from 'react';

import { useT } from '#/components/I18nProvider';

interface LicenseRowProps {
  icon: typeof PackageIcon;
  name: string;
  subtitle: string;
  badge: string;
  linkUrl?: string;
  linkLabel: string;
}

const LicensePolishStyle = memo(function LicensePolishStyle() {
  return (
    <style data-impeccable-css="licenses-polish">{`
      .licenses-shell {
        background: var(--background);
      }

      .licenses-toolbar {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        align-items: end;
        gap: 14px;
      }

      .licenses-search {
        position: relative;
        min-width: 0;
      }

      .licenses-search-icon {
        position: absolute;
        top: 50%;
        left: 11px;
        width: 15px;
        height: 15px;
        color: var(--muted-foreground);
        transform: translateY(-50%);
        pointer-events: none;
      }

      .licenses-search-input {
        padding-left: 34px;
        padding-right: 34px;
      }

      .licenses-clear {
        position: absolute;
        top: 50%;
        right: 6px;
        width: 26px;
        height: 26px;
        transform: translateY(-50%);
      }

      .licenses-counts {
        display: flex;
        flex-wrap: wrap;
        justify-content: flex-end;
        gap: 6px;
      }

      .licenses-count {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        min-height: 28px;
        padding: 0 9px;
        color: var(--muted-foreground);
        background: var(--card);
        border: 1px solid var(--border);
        border-radius: 999px;
        font-size: 12px;
        line-height: 1;
        white-space: nowrap;
      }

      .licenses-section {
        display: flex;
        min-width: 0;
        flex-direction: column;
        gap: 10px;
      }

      .licenses-section-head {
        display: flex;
        align-items: flex-end;
        justify-content: space-between;
        gap: 12px;
      }

      .licenses-section-copy {
        max-width: 68ch;
        text-wrap: pretty;
      }

      .licenses-list {
        overflow: hidden;
        background: var(--card);
        border: 1px solid var(--border);
        border-radius: 12px;
      }

      .licenses-row {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        align-items: center;
        min-height: 48px;
        gap: 14px;
        padding: 9px 10px;
        border-bottom: 1px solid var(--border);
      }

      .licenses-row:last-child {
        border-bottom: 0;
      }

      .licenses-row:hover {
        background: color-mix(in srgb, var(--muted) 42%, transparent);
      }

      .licenses-package {
        display: grid;
        grid-template-columns: 30px minmax(0, 1fr);
        align-items: center;
        gap: 10px;
      }

      .licenses-icon {
        display: grid;
        place-items: center;
        width: 30px;
        height: 30px;
        color: color-mix(in srgb, var(--accent-blue) 68%, var(--foreground));
        background: color-mix(in srgb, var(--accent-blue) 10%, transparent);
        border: 1px solid color-mix(in srgb, var(--accent-blue) 18%, var(--border));
        border-radius: 8px;
      }

      .licenses-name {
        color: var(--foreground);
        line-height: 1.2;
      }

      .licenses-version {
        margin-top: 2px;
        line-height: 1.25;
      }

      .licenses-badge {
        max-width: 16rem;
        overflow: hidden;
        padding: 4px 7px;
        color: var(--foreground);
        text-overflow: ellipsis;
        white-space: nowrap;
        background: var(--muted);
        border: 1px solid color-mix(in srgb, var(--border) 78%, transparent);
        border-radius: 999px;
        font-size: 11px;
        font-weight: 600;
        line-height: 1;
      }

      .licenses-link {
        display: inline-grid;
        place-items: center;
        width: 28px;
        height: 28px;
        color: var(--muted-foreground);
        border-radius: 7px;
        transition:
          color 160ms ease,
          background-color 160ms ease;
      }

      .licenses-link:hover,
      .licenses-link:focus-visible {
        color: var(--foreground);
        background: var(--muted);
        outline: none;
      }

      .licenses-link-placeholder {
        width: 28px;
        height: 28px;
        flex: 0 0 28px;
      }

      .licenses-empty {
        display: grid;
        place-items: center;
        min-height: 180px;
        padding: 28px;
        text-align: center;
        background: var(--card);
        border: 1px solid var(--border);
        border-radius: 12px;
      }

      .licenses-empty-mark {
        display: grid;
        place-items: center;
        width: 34px;
        height: 34px;
        margin: 0 auto 10px;
        color: var(--muted-foreground);
        background: var(--muted);
        border-radius: 10px;
      }

      .licenses-skeleton-row {
        display: grid;
        grid-template-columns: minmax(0, 1fr) 7rem;
        align-items: center;
        gap: 14px;
        min-height: 48px;
        padding: 9px 10px;
        border-bottom: 1px solid var(--border);
      }

      .licenses-skeleton-row:last-child {
        border-bottom: 0;
      }

      @media (max-width: 720px) {
        .licenses-toolbar,
        .licenses-row {
          grid-template-columns: 1fr;
        }

        .licenses-counts {
          justify-content: flex-start;
        }

        .licenses-meta {
          justify-content: space-between;
        }
      }

      @media (prefers-reduced-motion: reduce) {
        .licenses-link {
          transition: none;
        }
      }
    `}</style>
  );
});

function LicenseRow({ icon, name, subtitle, badge, linkUrl, linkLabel }: LicenseRowProps) {
  return (
    <div className="licenses-row">
      <div className="licenses-package min-w-0">
        <span
          aria-hidden
          className="licenses-icon"
        >
          <HugeiconsIcon
            className="size-4"
            icon={icon}
          />
        </span>
        <div className="min-w-0">
          <span className="licenses-name block truncate font-mono text-sm">{name}</span>
          <span className="licenses-version block truncate text-muted-foreground text-xs">{subtitle}</span>
        </div>
      </div>
      <div className="licenses-meta flex shrink-0 items-center gap-2">
        <span className="licenses-badge">{badge}</span>
        {linkUrl && (
          <a
            aria-label={linkLabel}
            className="licenses-link"
            href={linkUrl}
            rel="noreferrer"
            target="_blank"
          >
            <HugeiconsIcon
              className="size-3.5"
              icon={ExternalLinkIcon}
            />
          </a>
        )}
        {!linkUrl && (
          <span
            aria-hidden
            className="licenses-link-placeholder"
          />
        )}
      </div>
    </div>
  );
}

function LicenseSkeleton({ rows = 8 }: { rows?: number }) {
  const skeletonRows = Array.from({ length: rows }, (_, row) => `license-skeleton-row-${row + 1}`);

  return (
    <div
      aria-hidden
      className="licenses-list"
    >
      {skeletonRows.map((rowKey) => (
        <div
          className="licenses-skeleton-row"
          key={rowKey}
        >
          <div className="grid min-w-0 grid-cols-[30px_minmax(0,1fr)] items-center gap-3">
            <Skeleton className="size-[30px] rounded-lg" />
            <span className="grid gap-2">
              <Skeleton className="h-2.5 w-3/5 rounded-full" />
              <Skeleton className="h-2.5 w-1/4 rounded-full" />
            </span>
          </div>
          <Skeleton className="h-2.5 w-full rounded-full" />
        </div>
      ))}
    </div>
  );
}

export function LicensesSettings() {
  const t = useT();
  const { data, isLoading } = useListLicensesQuery();
  const [search, setSearch] = useState('');

  const packages = data?.packages ?? [];
  const avatarStyles = data?.avatarStyles ?? [];
  const normalizedSearch = search.trim().toLowerCase();
  const filtered = normalizedSearch
    ? packages.filter(
        (p) =>
          p.name.toLowerCase().includes(normalizedSearch) ||
          p.license.toLowerCase().includes(normalizedSearch) ||
          p.version.toLowerCase().includes(normalizedSearch)
      )
    : packages;
  const visiblePackageCount = filtered.length;
  const totalPackageCount = packages.length;

  const renderLicenses = () =>
    isLoading ? (
      <>
        <p className="sr-only">{t('web.licenses.loading')}</p>
        <LicenseSkeleton />
      </>
    ) : filtered.length === 0 ? (
      <div className="licenses-empty">
        <div>
          <span className="licenses-empty-mark">
            <HugeiconsIcon
              className="size-4"
              icon={Search01Icon}
            />
          </span>
          <p className="font-medium text-sm">{t('web.licenses.empty')}</p>
          <p className="mt-1 text-muted-foreground text-xs">{t('web.licenses.emptyHint')}</p>
          {search ? (
            <Button
              className="mt-4"
              onClick={() => setSearch('')}
              size="sm"
              variant="secondary"
            >
              {t('web.licenses.clearSearch')}
            </Button>
          ) : null}
        </div>
      </div>
    ) : (
      <div className="licenses-list">
        {filtered.map((pkg) => (
          <LicenseRow
            badge={pkg.license}
            icon={PackageIcon}
            key={pkg.name}
            linkLabel={`${pkg.name} homepage`}
            linkUrl={pkg.homepage}
            name={pkg.name}
            subtitle={pkg.version}
          />
        ))}
      </div>
    );

  return (
    <div className="licenses-shell flex min-h-0 min-w-0 flex-1 flex-col">
      <LicensePolishStyle />
      <div className="flex flex-col gap-4 border-b px-6 py-4">
        <div className="licenses-toolbar">
          <div className="min-w-0">
            <p className="licenses-section-copy text-muted-foreground text-sm">{t('web.licenses.desc')}</p>
            <p className="mt-1 text-muted-foreground text-xs">{t('web.licenses.thanks')}</p>
          </div>
          <div className="licenses-counts">
            <span className="licenses-count">{t('web.licenses.packageCount', { count: totalPackageCount })}</span>
            <span className="licenses-count">{t('web.licenses.avatarStyleCount', { count: avatarStyles.length })}</span>
          </div>
        </div>
        <div className="licenses-search">
          <HugeiconsIcon
            aria-hidden
            className="licenses-search-icon"
            icon={Search01Icon}
          />
          <Input
            aria-label={t('web.licenses.searchLabel')}
            className="licenses-search-input"
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('web.licenses.searchPlaceholder')}
            value={search}
          />
          {search ? (
            <Button
              aria-label={t('web.licenses.clearSearchInput')}
              className="licenses-clear"
              onClick={() => setSearch('')}
              size="icon"
              type="button"
              variant="ghost"
            >
              <HugeiconsIcon
                className="size-3.5"
                icon={Cancel01Icon}
              />
            </Button>
          ) : null}
        </div>
      </div>

      <div className="licenses-scroll min-h-0 flex-1 overflow-y-auto px-6 pb-6">
        <div className="flex flex-col gap-6 pt-5">
          <section className="licenses-section">
            <div className="licenses-section-head">
              <div>
                <h3 className="font-semibold text-sm">{t('web.licenses.packagesTitle')}</h3>
                <p className="licenses-section-copy text-muted-foreground text-xs">
                  {normalizedSearch
                    ? t('web.licenses.filteredSummary', { count: visiblePackageCount, total: totalPackageCount })
                    : t('web.licenses.packageSummary', { count: totalPackageCount })}
                </p>
              </div>
            </div>
            {renderLicenses()}
          </section>

          <div className="licenses-section">
            <div className="licenses-section-head">
              <div>
                <h3 className="font-semibold text-sm">{t('web.licenses.avatarStylesTitle')}</h3>
                <p className="licenses-section-copy text-muted-foreground text-sm">
                  {t('web.licenses.avatarStylesDesc')}
                </p>
              </div>
              {avatarStyles.length > 0 ? (
                <span className="licenses-count">
                  {t('web.licenses.avatarStyleCount', { count: avatarStyles.length })}
                </span>
              ) : null}
            </div>
            {isLoading && avatarStyles.length === 0 ? <LicenseSkeleton rows={3} /> : null}
            {!isLoading && avatarStyles.length === 0 ? (
              <div className="licenses-empty">
                <div>
                  <span className="licenses-empty-mark">
                    <HugeiconsIcon
                      className="size-4"
                      icon={JusticeScaleIcon}
                    />
                  </span>
                  <p className="font-medium text-sm">{t('web.licenses.avatarStylesEmpty')}</p>
                </div>
              </div>
            ) : null}
            {avatarStyles.length > 0 ? (
              <div className="licenses-list">
                {avatarStyles.map((credit) => (
                  <LicenseRow
                    badge={credit.license}
                    icon={JusticeScaleIcon}
                    key={credit.slug}
                    linkLabel={`${credit.label} license`}
                    linkUrl={credit.licenseUrl}
                    name={credit.label}
                    subtitle={t('web.licenses.avatarStyleCreator', { creator: credit.creator })}
                  />
                ))}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
