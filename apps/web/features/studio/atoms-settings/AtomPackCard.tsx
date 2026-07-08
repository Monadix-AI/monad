import type { AtomConflict, InstalledAtomPack } from '@monad/protocol';
import type { ReactNode } from 'react';

import { Delete02Icon, LoaderPinwheelIcon, PackageIcon, PinIcon, PowerIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useRemoveAtomPackMutation, useSetAtomPackEnabledMutation, useSetAtomPinMutation } from '@monad/client-rtk';
import { Badge, Button } from '@monad/ui';
import { useState } from 'react';

import { useT } from '#/components/I18nProvider';
import { AtomPackAtoms } from './atom-pack-atoms';

export function ConflictRow({ conflict: c }: { conflict: AtomConflict }) {
  const t = useT();
  const [setPin, { isLoading }] = useSetAtomPinMutation();
  const pin = (packId: string) =>
    void setPin({ kind: c.kind, bareId: c.bareId, packId })
      .unwrap()
      .catch(() => {});

  return (
    <span className="flex flex-wrap items-center gap-1.5 text-muted-foreground">
      <Badge
        className="text-[10px]"
        variant="outline"
      >
        {c.kind}
      </Badge>
      <span className="font-mono">{c.bareId}</span>
      <span>
        - <span className="font-medium text-foreground">{c.winner}</span> {t('web.atoms.conflictActive')}
      </span>
      <span className="text-muted-foreground/70">{t('web.atoms.conflictShadowed')}</span>
      {c.shadowed.map((packId) => (
        <Button
          className="h-5 gap-1 px-1.5 text-[10px]"
          disabled={isLoading}
          key={packId}
          onClick={() => pin(packId)}
          size="sm"
          variant="ghost"
        >
          <HugeiconsIcon
            className="size-3"
            icon={PinIcon}
          />
          {packId}
        </Button>
      ))}
    </span>
  );
}

export function AtomPackCard({ pack }: { pack: InstalledAtomPack }) {
  const t = useT();
  const [setEnabled, { isLoading: toggling }] = useSetAtomPackEnabledMutation();
  const [remove, { isLoading: removing }] = useRemoveAtomPackMutation();
  const [confirmRemove, setConfirmRemove] = useState(false);

  return (
    <div className="rounded-md border">
      <div className="flex items-center gap-2 px-3 py-2.5">
        <HugeiconsIcon
          className="size-4 text-muted-foreground"
          icon={PackageIcon}
        />
        <span className="truncate font-medium text-sm">{pack.displayName ?? pack.name}</span>
        <Badge
          className="text-[10px]"
          variant="secondary"
        >
          v{pack.version}
        </Badge>
        {!pack.builtin && !pack.enabled && (
          <span className="text-muted-foreground text-xs">{t('web.atoms.disabled')}</span>
        )}
        {pack.builtin ? (
          <Badge
            className="ml-auto text-[10px]"
            variant="outline"
          >
            {t('web.atoms.builtin')}
          </Badge>
        ) : (
          <div className="ml-auto flex items-center gap-1">
            <Button
              className="gap-1.5"
              disabled={toggling}
              onClick={() => void setEnabled({ name: pack.name, enabled: !pack.enabled })}
              size="sm"
              variant={pack.enabled ? 'secondary' : 'outline'}
            >
              <HugeiconsIcon
                className="size-3.5"
                icon={PowerIcon}
              />
              {pack.enabled ? t('web.atoms.enabled') : t('web.atoms.disabled')}
            </Button>
            {confirmRemove ? (
              <>
                <span className="text-muted-foreground text-xs">{t('web.atoms.confirmRemove')}</span>
                <Button
                  disabled={removing}
                  onClick={async () => {
                    await remove(pack.name)
                      .unwrap()
                      .catch(() => {});
                    setConfirmRemove(false);
                  }}
                  size="sm"
                  variant="destructive"
                >
                  {removing ? (
                    <HugeiconsIcon
                      className="size-3.5 animate-spin"
                      icon={LoaderPinwheelIcon}
                    />
                  ) : (
                    <HugeiconsIcon
                      className="size-3.5"
                      icon={Delete02Icon}
                    />
                  )}
                </Button>
                <Button
                  onClick={() => setConfirmRemove(false)}
                  size="sm"
                  variant="ghost"
                >
                  {t('web.cancel')}
                </Button>
              </>
            ) : (
              <Button
                aria-label={t('web.atoms.remove')}
                className="size-7"
                onClick={() => setConfirmRemove(true)}
                size="icon"
                variant="ghost"
              >
                <HugeiconsIcon
                  className="size-3.5"
                  icon={Delete02Icon}
                />
              </Button>
            )}
          </div>
        )}
      </div>
      {pack.description ? (
        <p className="border-t px-3 py-2 text-muted-foreground text-xs leading-relaxed">{pack.description}</p>
      ) : null}
      <AtomPackMeta pack={pack} />
      {pack.atomDetails.length > 0 ? (
        <AtomPackAtoms atoms={pack.atomDetails} />
      ) : (
        <div className="flex flex-wrap items-center gap-1.5 border-t px-3 py-2 text-muted-foreground text-xs">
          <span>{t('web.atoms.provides')}:</span>
          {pack.atoms.map((a) => (
            <Badge
              className="text-[10px]"
              key={a}
              variant="outline"
            >
              {a}
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}

function formatInstalledAt(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString();
}

function AtomPackMeta({ pack }: { pack: InstalledAtomPack }) {
  const t = useT();
  const mono = (value: string) => <span className="font-mono">{value}</span>;
  const items: { key: string; label: string; value: ReactNode }[] = [];
  if (pack.displayName && pack.name !== pack.displayName)
    items.push({ key: 'id', label: t('web.atoms.packId'), value: mono(pack.name) });
  if (pack.author) items.push({ key: 'author', label: t('web.atoms.author'), value: pack.author });
  if (pack.monadVersion)
    items.push({ key: 'compat', label: t('web.atoms.compatibility'), value: mono(pack.monadVersion) });
  if (pack.sdkVersion) items.push({ key: 'sdk', label: t('web.atoms.sdkVersion'), value: mono(pack.sdkVersion) });
  if (pack.repository)
    items.push({
      key: 'repo',
      label: t('web.atoms.repository'),
      value: mono(`${pack.repository.repo}@${pack.repository.commit.slice(0, 7)}`)
    });
  if (pack.source) items.push({ key: 'source', label: t('web.atoms.source'), value: mono(pack.source) });
  if (pack.installedAt)
    items.push({ key: 'installed', label: t('web.atoms.installedAt'), value: formatInstalledAt(pack.installedAt) });
  if (items.length === 0) return null;

  return (
    <dl className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-t bg-muted/30 px-3 py-2 text-[11px]">
      {items.map((item) => (
        <div
          className="flex min-w-0 items-baseline gap-1.5"
          key={item.key}
        >
          <dt className="whitespace-nowrap text-muted-foreground/60">{item.label}</dt>
          <dd className="min-w-0 truncate text-foreground/80">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
