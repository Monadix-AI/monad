'use client';

import type { AtomConflict, AtomDescriptor, AtomKind, InstalledAtomPack } from '@monad/protocol';

import {
  Alert01Icon,
  BotIcon,
  BrainIcon,
  Cancel01Icon,
  Delete02Icon,
  LanguageSquareIcon,
  LoaderPinwheelIcon,
  MessageMultiple01Icon,
  MessageSquareCodeIcon,
  PackageIcon,
  PinIcon,
  Plug01Icon,
  PlusSignIcon,
  PowerIcon,
  PuzzleIcon,
  Refresh01Icon,
  ScanIcon,
  ServerStack01Icon,
  ShieldIcon,
  SparklesIcon,
  TerminalIcon,
  WorkflowSquare01Icon
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
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
import { Fragment, type ReactNode, useState } from 'react';

import { useT } from '@/components/I18nProvider';
import { PanelShell, PanelShellHeader } from '@/components/ui/panel-shell';
import { providerLogo, useProviderMeta } from '@/lib/ProviderMeta';

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
              <HugeiconsIcon
                className={cn(rescanning && 'animate-pulse')}
                icon={ScanIcon}
              />
            </Button>
            <Button
              aria-label={t('web.refresh')}
              className="size-7"
              onClick={() => refetch()}
              size="icon"
              variant="ghost"
            >
              <HugeiconsIcon
                className={cn(isFetching && 'animate-spin')}
                icon={Refresh01Icon}
              />
            </Button>
            <Button
              aria-label={t('web.atoms.add')}
              className="size-7"
              onClick={() => setAdding(true)}
              size="icon"
              variant="ghost"
            >
              <HugeiconsIcon icon={PlusSignIcon} />
            </Button>
          </>
        }
        subtitle={t('web.atoms.subtitle')}
        title={t('web.atoms.title')}
      />

      {rescanErrors.length > 0 ? (
        <div className="flex flex-col gap-1 border-amber-500/30 border-b bg-amber-500/10 px-5 py-2 text-xs">
          <span className="flex items-center gap-1 font-medium text-warning">
            <HugeiconsIcon
              className="size-3"
              icon={Alert01Icon}
            />
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
            <HugeiconsIcon
              className="size-3"
              icon={Alert01Icon}
            />
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

      <ScrollArea className="min-h-0 flex-1">
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

function AtomPackCard({ pack }: { pack: InstalledAtomPack }) {
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

// Each atom kind gets its own identity (icon + label + one-line definition) and the layout `form`
// that best fits the metadata that kind actually carries: bare identifiers → code chips, invocable
// slash commands → a two-column palette, everything descriptive → info-rich identity rows.
type AtomForm = 'chips' | 'command' | 'detail';
type KindMeta = { label: string; icon: typeof PackageIcon; blurb: string; form: AtomForm };

const KIND_META: Record<AtomKind, KindMeta> = {
  skill: {
    label: 'Skills',
    icon: SparklesIcon,
    blurb: 'Portable capability packets the agent loads on demand.',
    form: 'detail'
  },
  command: {
    label: 'Commands',
    icon: TerminalIcon,
    blurb: 'Slash commands available across every client.',
    form: 'command'
  },
  mcp: {
    label: 'MCP servers',
    icon: ServerStack01Icon,
    blurb: 'Model Context Protocol servers exposing external tools.',
    form: 'detail'
  },
  provider: {
    label: 'Model providers',
    icon: BrainIcon,
    blurb: 'Upstream gateways the model router can send requests to.',
    form: 'detail'
  },
  channel: {
    label: 'Channels',
    icon: MessageMultiple01Icon,
    blurb: 'Inbound chat gateways that route messages into sessions.',
    form: 'detail'
  },
  connector: {
    label: 'Connectors',
    icon: Plug01Icon,
    blurb: 'Webhook and integration endpoints.',
    form: 'detail'
  },
  'agent-adapter': {
    label: 'Agent adapters',
    icon: BotIcon,
    blurb: 'Native CLI agents managed as workplace members.',
    form: 'detail'
  },
  hook: {
    label: 'Hooks',
    icon: WorkflowSquare01Icon,
    blurb: 'Lifecycle handlers that run on daemon events.',
    form: 'detail'
  },
  sandbox: {
    label: 'Sandboxes',
    icon: ShieldIcon,
    blurb: 'OS-level confinement backends for tool execution.',
    form: 'detail'
  },
  'message-type': {
    label: 'Message types',
    icon: MessageSquareCodeIcon,
    blurb: 'Custom transcript payload renderers.',
    form: 'detail'
  },
  'workspace-experience': {
    label: 'Workspace experiences',
    icon: PuzzleIcon,
    blurb: 'Embedded UI surfaces mounted inside the workspace.',
    form: 'detail'
  },
  locale: {
    label: 'Locales',
    icon: LanguageSquareIcon,
    blurb: 'Language packs for the CLI, TUI, and web UI.',
    form: 'chips'
  }
};

const KIND_ORDER = Object.keys(KIND_META) as AtomKind[];

function AtomPackAtoms({ atoms }: { atoms: AtomDescriptor[] }) {
  const byKind = new Map<AtomKind, AtomDescriptor[]>();
  for (const atom of atoms) {
    const list = byKind.get(atom.kind) ?? [];
    list.push(atom);
    byKind.set(atom.kind, list);
  }
  const groups = [...byKind.entries()].sort(([a], [b]) => KIND_ORDER.indexOf(a) - KIND_ORDER.indexOf(b));

  return (
    <div className="flex flex-col gap-3.5 border-t px-3 py-3">
      {groups.map(([kind, list]) => {
        const meta = KIND_META[kind];
        return (
          <section
            className="flex flex-col gap-2"
            key={kind}
          >
            <header className="flex items-start gap-2.5">
              <div className="mt-px grid size-6 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
                <HugeiconsIcon
                  className="size-3.5"
                  icon={meta?.icon ?? PackageIcon}
                />
              </div>
              <div className="flex min-w-0 flex-1 flex-col">
                <div className="flex items-baseline gap-1.5">
                  <h4 className="font-medium text-foreground text-xs">{meta?.label ?? kind}</h4>
                  <span className="text-[10px] text-muted-foreground/50 tabular-nums">{list.length}</span>
                </div>
                {meta?.blurb ? (
                  <p className="text-[10.5px] text-muted-foreground/60 leading-snug">{meta.blurb}</p>
                ) : null}
              </div>
            </header>
            <div className="pl-[34px]">
              <AtomKindBody
                atoms={list}
                form={meta?.form ?? 'detail'}
              />
            </div>
          </section>
        );
      })}
    </div>
  );
}

function providerHost(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

// The provider's own brand logo (local, no network), rendered in a small tile.
function ProviderMark({ id, className }: { id: string; className?: string }) {
  const { logo: Logo, color } = providerLogo(id);
  return (
    <span className={cn('grid shrink-0 place-items-center rounded-md border bg-card', className)}>
      <Logo className={cn('size-4', color)} />
    </span>
  );
}

function AtomKindBody({ atoms, form }: { atoms: AtomDescriptor[]; form: AtomForm }) {
  const { metaFor } = useProviderMeta();
  const isProvider = atoms[0]?.kind === 'provider';

  if (form === 'chips') {
    return (
      <div className="flex flex-wrap gap-1">
        {atoms.map((atom) => (
          <Badge
            className="font-mono text-[10px]"
            key={atom.id}
            title={atom.name ?? atom.description}
            variant="outline"
          >
            {atom.id}
          </Badge>
        ))}
      </div>
    );
  }

  if (form === 'command') {
    return (
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-3 gap-y-1.5">
        {atoms.map((atom) => (
          <Fragment key={atom.id}>
            <dt className="whitespace-nowrap font-mono text-[color:var(--link)] text-xs">/{atom.id}</dt>
            <dd className="min-w-0 truncate text-[11px] text-muted-foreground/80">
              {atom.description ?? atom.name ?? ''}
            </dd>
          </Fragment>
        ))}
      </dl>
    );
  }

  if (isProvider) {
    return (
      <ul className="pv-table">
        {atoms.map((atom) => {
          const meta = metaFor(atom.id);
          const host = providerHost(meta.defaultBaseUrl);
          return (
            <li
              className="pv-trow"
              key={atom.id}
            >
              <span className="pv-cell">
                <ProviderMark
                  className="pv-mark"
                  id={atom.id}
                />
              </span>
              <span className="pv-name">{atom.name ?? atom.id}</span>
              <code className="pv-id">{atom.id}</code>
              <span className="pv-strategy">{meta.strategy === 'native' ? 'Native' : 'OpenAI-compat'}</span>
              <span className="pv-host">{host ?? ''}</span>
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <ul className="flex flex-col gap-2">
      {atoms.map((atom) => (
        <li
          className="flex flex-col gap-0.5"
          key={atom.id}
        >
          <div className="flex min-w-0 items-baseline gap-2">
            <span className="truncate font-mono text-foreground/90 text-xs">{atom.id}</span>
            {atom.name ? <span className="truncate text-[11px] text-muted-foreground">{atom.name}</span> : null}
          </div>
          {atom.description ? (
            <span className="text-[11px] text-muted-foreground/70 leading-snug">{atom.description}</span>
          ) : null}
        </li>
      ))}
    </ul>
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
          <HugeiconsIcon icon={Cancel01Icon} />
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
                <HugeiconsIcon
                  className="size-3"
                  icon={Alert01Icon}
                />
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
            {isLoading ? (
              <HugeiconsIcon
                className="size-3.5 animate-spin"
                icon={LoaderPinwheelIcon}
              />
            ) : null}
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
          {isLoading ? (
            <HugeiconsIcon
              className="size-3.5 animate-spin"
              icon={LoaderPinwheelIcon}
            />
          ) : (
            <HugeiconsIcon icon={PlusSignIcon} />
          )}
          {isLoading ? t('web.atoms.installing') : t('web.atoms.install')}
        </Button>
      )}

      {error ? <p className="text-destructive text-xs">{error}</p> : null}
    </div>
  );
}
