'use client';

import type { AtomConflict, InstalledAtomPack } from '@monad/protocol';

import {
  useDiscoverAtomKindsMutation,
  useInstallAtomPackMutation,
  useListAtomKindsQuery,
  useListAtomPacksQuery,
  useRemoveAtomPackMutation,
  useSetAtomPackEnabledMutation,
  useSetAtomPinMutation
} from '@monad/client-rtk';
import { Badge, Button, cn, Input, Label, ScrollArea } from '@monad/ui';
import { AlertTriangle, Loader2, Package, Pin, Plus, Power, RefreshCw, ScanLine, Trash2, X } from 'lucide-react';
import { useState } from 'react';

import { useT } from '@/components/I18nProvider';
import { PanelShell, PanelShellHeader } from '@/components/ui/panel-shell';

export function AtomsSettings(_props: { onClose: () => void }) {
  const t = useT();
  const { data, isFetching, refetch } = useListAtomPacksQuery();
  const { data: kindsData } = useListAtomKindsQuery();
  const [discover, { isLoading: rescanning }] = useDiscoverAtomKindsMutation();
  const [adding, setAdding] = useState(false);
  const [rescanErrors, setRescanErrors] = useState<{ file: string; error: string }[]>([]);
  const packs = data?.atomPacks ?? [];
  const conflicts = data?.conflicts ?? [];

  const rescan = async () => {
    const res = await discover()
      .unwrap()
      .catch(() => null);
    setRescanErrors(res?.errors ?? []);
  };

  return (
    <PanelShell>
      <PanelShellHeader
        actions={
          <>
            <Button
              aria-label={t('web.atoms.rescan')}
              className="size-7"
              disabled={rescanning}
              onClick={() => void rescan()}
              size="icon"
              variant="ghost"
            >
              <ScanLine className={cn(rescanning && 'animate-pulse')} />
            </Button>
            <Button
              aria-label={t('web.refresh')}
              className="size-7"
              onClick={() => refetch()}
              size="icon"
              variant="ghost"
            >
              <RefreshCw className={cn(isFetching && 'animate-spin')} />
            </Button>
            <Button
              aria-label={t('web.atoms.add')}
              className="size-7"
              onClick={() => setAdding(true)}
              size="icon"
              variant="ghost"
            >
              <Plus />
            </Button>
          </>
        }
        subtitle={t('web.atoms.subtitle')}
        title={t('web.atoms.title')}
      />

      {rescanErrors.length > 0 ? (
        <div className="flex flex-col gap-1 border-amber-500/30 border-b bg-amber-500/10 px-5 py-2 text-xs">
          <span className="flex items-center gap-1 font-medium text-warning">
            <AlertTriangle className="size-3" />
            {t('web.atoms.rescanErrors')}
          </span>
          {rescanErrors.map((e) => (
            <span
              className="text-muted-foreground"
              key={e.file}
            >
              <span className="font-mono">{e.file}</span>: {e.error}
            </span>
          ))}
        </div>
      ) : null}

      {conflicts.length > 0 ? (
        <div className="flex flex-col gap-1.5 border-amber-500/30 border-b bg-amber-500/10 px-5 py-2 text-xs">
          <span className="flex items-center gap-1 font-medium text-warning">
            <AlertTriangle className="size-3" />
            {t('web.atoms.conflicts')}
          </span>
          {conflicts.map((c) => (
            <ConflictRow
              conflict={c}
              key={`${c.kind}:${c.bareId}`}
            />
          ))}
        </div>
      ) : null}

      <ScrollArea className="flex-1">
        <div className="flex flex-col gap-2 p-4">
          {adding ? (
            <InstallForm
              onCancel={() => setAdding(false)}
              onInstalled={() => setAdding(false)}
            />
          ) : null}

          {packs.length === 0 && !adding ? (
            <p className="px-1 py-8 text-center text-muted-foreground text-xs">{t('web.atoms.empty')}</p>
          ) : null}

          {packs.map((p) => (
            <AtomPackCard
              key={p.name}
              pack={p}
            />
          ))}
        </div>
      </ScrollArea>

      {kindsData && kindsData.kinds.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5 border-t px-5 py-2 text-muted-foreground text-xs">
          <span>{t('web.atoms.registeredKinds')}:</span>
          {kindsData.kinds.map((k) => (
            <Badge
              className="text-[10px]"
              key={k}
              variant="secondary"
            >
              {k}
            </Badge>
          ))}
        </div>
      ) : null}
    </PanelShell>
  );
}

function ConflictRow({ conflict: c }: { conflict: AtomConflict }) {
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
        — <span className="font-medium text-foreground">{c.winner}</span> {t('web.atoms.conflictActive')}
      </span>
      {/* Each shadowed pack can be pinned to win the bare name; clicking re-resolves live. */}
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
          <Pin className="size-3" />
          {packId}
        </Button>
      ))}
    </span>
  );
}

function AtomPackCard({ pack }: { pack: InstalledAtomPack }) {
  const t = useT();
  const [setEnabled, { isLoading: toggling }] = useSetAtomPackEnabledMutation();
  const [remove, { isLoading: removing }] = useRemoveAtomPackMutation();
  const [confirmRemove, setConfirmRemove] = useState(false);

  return (
    <div className="rounded-md border">
      <div className="flex items-center gap-2 px-3 py-2.5">
        <Package className="size-4 text-muted-foreground" />
        <span className="truncate font-medium text-sm">{pack.displayName ?? pack.name}</span>
        <Badge
          className="text-[10px]"
          variant="secondary"
        >
          v{pack.version}
        </Badge>
        {!pack.enabled && <span className="text-muted-foreground text-xs">{t('web.atoms.disabled')}</span>}
        <div className="ml-auto flex items-center gap-1">
          <Button
            className="gap-1.5"
            disabled={toggling}
            onClick={() => void setEnabled({ name: pack.name, enabled: !pack.enabled })}
            size="sm"
            variant={pack.enabled ? 'secondary' : 'outline'}
          >
            <Power className="size-3.5" />
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
                {removing ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
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
              <Trash2 className="size-3.5" />
            </Button>
          )}
        </div>
      </div>
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
        {pack.source ? <span className="ml-auto truncate font-mono text-[10px]">{pack.source}</span> : null}
      </div>
    </div>
  );
}

function InstallForm({ onCancel, onInstalled }: { onCancel: () => void; onInstalled: () => void }) {
  const t = useT();
  const [install, { isLoading }] = useInstallAtomPackMutation();
  const [source, setSource] = useState('');
  const [error, setError] = useState<string | null>(null);
  // After a default-deny install, hold the declared atoms/warnings for the consent confirmation.
  const [consent, setConsent] = useState<{ atoms: string[]; warnings: string[] } | null>(null);

  const submit = async (withConsent: boolean) => {
    const src = source.trim();
    if (!src) return;
    setError(null);
    const res = await install({ source: src, consent: withConsent })
      .unwrap()
      .catch(() => null);
    if (!res) {
      setError(t('web.atoms.installFailed'));
      return;
    }
    if (res.needsConsent) {
      setConsent({ atoms: res.atoms, warnings: res.warnings });
      return;
    }
    onInstalled();
  };

  return (
    <div className="flex flex-col gap-3 rounded-md border border-primary/30 bg-primary/5 p-3">
      <div className="flex items-center justify-between">
        <span className="font-medium text-sm">{t('web.atoms.addTitle')}</span>
        <Button
          className="size-6"
          onClick={onCancel}
          size="icon"
          variant="ghost"
        >
          <X />
        </Button>
      </div>
      <div className="flex flex-col gap-1">
        <Label className="text-xs">{t('web.atoms.source')}</Label>
        <Input
          onChange={(e) => {
            setSource(e.target.value);
            setConsent(null);
          }}
          placeholder={t('web.atoms.sourcePlaceholder')}
          value={source}
        />
      </div>
      <p className="text-muted-foreground text-xs">{t('web.atoms.addHint')}</p>

      {consent ? (
        <div className="flex flex-col gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2.5 text-xs">
          <span className="font-medium text-warning">{t('web.atoms.consentTitle')}</span>
          <div className="flex flex-wrap gap-1.5">
            {consent.atoms.map((a) => (
              <Badge
                className="text-[10px]"
                key={a}
                variant="outline"
              >
                {a}
              </Badge>
            ))}
          </div>
          {consent.warnings.length > 0 && (
            <div className="flex flex-col gap-1">
              <span className="flex items-center gap-1 font-medium text-warning">
                <AlertTriangle className="size-3" />
                {t('web.atoms.warningsTitle')}
              </span>
              {consent.warnings.map((w) => (
                <span
                  className="text-muted-foreground"
                  key={w}
                >
                  {w}
                </span>
              ))}
            </div>
          )}
          <Button
            className="self-start"
            disabled={isLoading}
            onClick={() => void submit(true)}
            size="sm"
          >
            {isLoading ? <Loader2 className="size-3.5 animate-spin" /> : null}
            {t('web.atoms.consentConfirm')}
          </Button>
        </div>
      ) : (
        <Button
          className="self-start"
          disabled={isLoading || !source.trim()}
          onClick={() => void submit(false)}
          size="sm"
        >
          {isLoading ? <Loader2 className="size-3.5 animate-spin" /> : <Plus />}
          {isLoading ? t('web.atoms.installing') : t('web.atoms.install')}
        </Button>
      )}

      {error ? <p className="text-destructive text-xs">{error}</p> : null}
    </div>
  );
}
