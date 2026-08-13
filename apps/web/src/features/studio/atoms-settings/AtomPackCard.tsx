import type { AtomConflict, AtomPackUpdateCheck, InstalledAtomPack } from '@monad/protocol';
import type { ReactNode } from 'react';

import { Delete02Icon, PackageIcon, PinIcon, Refresh01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  useLazyCheckAtomPackUpdateQuery,
  useRemoveAtomPackMutation,
  useSetAtomPackEnabledMutation,
  useSetAtomPinMutation,
  useUpdateAtomPackMutation
} from '@monad/client-rtk';
import { Badge, Button, Confirm, Switch } from '@monad/ui';
import { useState } from 'react';

import { useT } from '#/components/I18nProvider';
import { AtomPackUpdateDialog } from './AtomPackUpdateDialog';
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
      <span className="font-ui">{c.bareId}</span>
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
  const [update] = useUpdateAtomPackMutation();
  const [checkUpdate, { isFetching: checkingUpdate }] = useLazyCheckAtomPackUpdateQuery();
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [removeFailed, setRemoveFailed] = useState(false);
  const [updateOpen, setUpdateOpen] = useState(false);
  const [updateCheck, setUpdateCheck] = useState<AtomPackUpdateCheck | null>(null);
  const [checkFailed, setCheckFailed] = useState(false);

  const packHeader = (
    <div className="flex items-center gap-2.5 px-3 py-2.5">
      <span className="mt-px grid size-6 shrink-0 place-items-center rounded-md bg-transparent text-foreground">
        <HugeiconsIcon
          className="size-3.5"
          icon={PackageIcon}
        />
      </span>

      <div className="atom-pack-header-flow flex min-w-0 flex-1 items-baseline gap-x-3.5 max-[760px]:flex-wrap max-[760px]:items-start max-[760px]:gap-y-1">
        <div className="atom-pack-header-flow__identity flex min-w-0 shrink-0 items-center gap-1.5">
          <span className="truncate font-medium text-sm">{pack.displayName ?? pack.name}</span>
          <Badge
            className="text-[10px]"
            variant="secondary"
          >
            v{pack.version}
          </Badge>
          {!pack.builtin && !pack.enabled ? (
            <span className="text-muted-foreground text-xs">{t('web.atoms.disabled')}</span>
          ) : null}
        </div>
        <AtomPackMeta
          pack={pack}
          placement="header"
        />
      </div>

      {pack.builtin ? (
        <Badge
          className="shrink-0 text-[10px]"
          variant="outline"
        >
          {t('web.atoms.builtin')}
        </Badge>
      ) : (
        <div className="flex shrink-0 items-center gap-1">
          {pack.canUpdate && pack.source ? (
            <Button
              className="gap-1.5"
              disabled={checkingUpdate}
              onClick={() => {
                setCheckFailed(false);
                void checkUpdate(pack.name)
                  .unwrap()
                  .then((result) => {
                    setUpdateCheck(result);
                    setUpdateOpen(true);
                  })
                  .catch(() => setCheckFailed(true));
              }}
              size="sm"
              variant="outline"
            >
              <HugeiconsIcon
                className="size-3.5"
                icon={Refresh01Icon}
              />
              {checkingUpdate ? t('web.atoms.checkingUpdate') : t('web.atoms.checkUpdate')}
            </Button>
          ) : null}
          {checkFailed ? <span className="text-destructive text-xs">{t('web.atoms.checkUpdateFailed')}</span> : null}
          <Switch
            aria-label={pack.enabled ? t('web.atoms.enabled') : t('web.atoms.disabled')}
            checked={pack.enabled}
            disabled={toggling}
            onCheckedChange={(enabled) => void setEnabled({ name: pack.name, enabled })}
          />
          <Button
            aria-label={t('web.atoms.remove')}
            className="size-7"
            onClick={() => {
              setRemoveFailed(false);
              setConfirmRemove(true);
            }}
            size="icon"
            variant="ghost"
          >
            <HugeiconsIcon
              className="size-3.5"
              icon={Delete02Icon}
            />
          </Button>
        </div>
      )}
    </div>
  );

  return (
    <div className="rounded-md border">
      {packHeader}
      {pack.description ? (
        <p className="border-t px-3 py-2 text-muted-foreground text-xs leading-relaxed">{pack.description}</p>
      ) : null}
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
      {pack.canUpdate && updateCheck ? (
        <AtomPackUpdateDialog
          onConfirm={async () => {
            await update({ name: pack.name, revision: updateCheck.latestRevision }).unwrap();
          }}
          onOpenChange={setUpdateOpen}
          open={updateOpen}
          packName={pack.displayName ?? pack.name}
          update={updateCheck}
        />
      ) : null}
      <Confirm
        cancelLabel={t('web.common.cancel')}
        confirmLabel={t('web.atoms.remove')}
        confirmVariant="destructive"
        description={t('web.atoms.confirmRemoveDescription', { name: pack.displayName ?? pack.name })}
        error={removeFailed ? t('web.atoms.removeFailed') : undefined}
        onConfirm={() => {
          setRemoveFailed(false);
          void remove(pack.name)
            .unwrap()
            .then(() => setConfirmRemove(false))
            .catch(() => setRemoveFailed(true));
        }}
        onOpenChange={setConfirmRemove}
        open={confirmRemove}
        pending={removing}
        pendingLabel={t('web.atoms.removing')}
        title={t('web.atoms.confirmRemove')}
      />
    </div>
  );
}

function AtomPackMeta({ pack, placement = 'footer' }: { pack: InstalledAtomPack; placement?: 'footer' | 'header' }) {
  const t = useT();
  const codeText = (value: string) => <span className="font-ui">{value}</span>;
  const items: { key: string; label: string; value: ReactNode }[] = [];
  if (pack.author) items.push({ key: 'author', label: t('web.atoms.author'), value: pack.author });
  if (pack.monadVersion)
    items.push({ key: 'compat', label: t('web.atoms.compatibility'), value: codeText(pack.monadVersion) });
  if (pack.sdkVersion) items.push({ key: 'sdk', label: t('web.atoms.sdkVersion'), value: codeText(pack.sdkVersion) });
  if (pack.repository)
    items.push({
      key: 'repo',
      label: t('web.atoms.repository'),
      value: codeText(`${pack.repository.repo}@${pack.repository.commit.slice(0, 7)}`)
    });
  if (pack.sourceKind === 'local' && pack.source)
    items.push({ key: 'source', label: t('web.atoms.source'), value: codeText(pack.source) });
  if (items.length === 0) return null;

  return (
    <dl
      className={
        placement === 'header'
          ? 'atom-pack-meta atom-pack-meta--inline flex min-w-0 flex-1 flex-nowrap items-baseline gap-x-3.5 gap-y-0.5 text-[10px] [opacity:.76] max-[760px]:basis-full max-[760px]:flex-wrap'
          : 'atom-pack-meta atom-pack-meta--inline flex min-w-0 flex-wrap items-baseline gap-x-3.5 gap-y-0.5 text-[10px] [opacity:.76]'
      }
    >
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
