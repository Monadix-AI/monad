'use client';

import type { WebMessageIdWithoutParams } from '@monad/i18n';
import type { McpCatalogEntry, McpServerStatus, McpServerView } from '@monad/protocol';

import {
  BoxesIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  Delete02Icon,
  Key01Icon,
  LoaderPinwheelIcon,
  PlusSignIcon,
  PowerIcon,
  Refresh01Icon
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { Badge, Button, cn } from '@monad/ui';
import { useState } from 'react';

import { I18nTrans, useT } from '@/components/I18nProvider';
import { useAsyncAction } from '@/hooks/use-async-action';
import { useMcpServerSettings } from '@/hooks/use-mcp-server-settings';
import { ServerForm } from './mcp-servers/server-form';

const envRef = (name: string) => `\${env:${name}}`;

type McpStatusState = NonNullable<McpServerStatus['state']> | 'connecting' | 'disabled';

const MCP_STATUS_LABEL_KEYS: Record<McpStatusState, WebMessageIdWithoutParams> = {
  connected: 'web.mcp.state.connected',
  connecting: 'web.mcp.state.connecting',
  disabled: 'web.mcp.state.disabled',
  failed: 'web.mcp.state.failed'
};

// Map a catalog entry to a pre-filled (editable) add-form draft.
function catalogToServer(e: McpCatalogEntry): McpServerView {
  const trust = { autoApproveTools: [] as string[] };
  if (e.transport === 'http') {
    return { name: e.id, transport: 'http', url: e.url ?? '', auth: { mode: 'none' }, enabled: true, trust };
  }
  const env = e.env.length > 0 ? Object.fromEntries(e.env.map((k) => [k, envRef(k)])) : undefined;
  return { name: e.id, transport: 'stdio', command: e.command ?? '', args: e.args, env, enabled: true, trust };
}

// The "built-in" half of the MCP section: system MCP servers declared in config.json, connected at
// daemon boot. Editable here; changes apply on the next restart.
export function McpServersSubsection() {
  const t = useT();
  const {
    servers,
    statusByName,
    catalog,
    loading,
    saveServer,
    removeServer,
    setEnabled,
    authorize,
    reconnect,
    refetch
  } = useMcpServerSettings();
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<McpServerView | null>(null);
  const [catalogOpen, setCatalogOpen] = useState(false);

  const addFromCatalog = (e: McpCatalogEntry) => {
    setDraft(catalogToServer(e));
    setCatalogOpen(false);
    setAdding(true);
  };
  const closeForm = () => {
    setAdding(false);
    setDraft(null);
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <div className="min-w-0">
          <p className="font-medium text-sm">{t('web.mcp.configuredServers')}</p>
          <p className="mt-0.5 text-muted-foreground text-xs">{t('web.mcp.configuredServersHint')}</p>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <Button
            aria-label={t('web.refresh')}
            className="size-7"
            onClick={refetch}
            size="icon"
            variant="ghost"
          >
            <HugeiconsIcon
              className={cn(loading && 'animate-spin')}
              icon={Refresh01Icon}
            />
          </Button>
          <Button
            aria-label={t('web.mcp.catalog')}
            className="size-7"
            onClick={() => setCatalogOpen((v) => !v)}
            size="icon"
            variant={catalogOpen ? 'secondary' : 'ghost'}
          >
            <HugeiconsIcon icon={BoxesIcon} />
          </Button>
          <Button
            aria-label={t('web.mcp.addServer')}
            className="size-7"
            onClick={() => {
              setDraft(null);
              setAdding(true);
            }}
            size="icon"
            variant="ghost"
          >
            <HugeiconsIcon icon={PlusSignIcon} />
          </Button>
        </div>
      </div>

      <p className="rounded-md border bg-muted/30 px-3 py-2 text-muted-foreground text-xs">
        <I18nTrans
          components={{ code: <code /> }}
          i18nKey="web.mcp.bootHint"
          values={{ ref: envRef('NAME') }}
        />
      </p>

      {catalogOpen ? (
        <McpCatalog
          catalog={catalog}
          onAdd={addFromCatalog}
        />
      ) : null}

      {adding ? (
        <ServerForm
          onCancel={closeForm}
          onSubmit={async (s) => {
            await saveServer(s);
            closeForm();
          }}
          server={draft ?? undefined}
          submitLabel={t('web.mcp.create')}
          title={draft ? t('web.mcp.addFromCatalogTitle', { name: draft.name }) : t('web.mcp.addTitle')}
        />
      ) : null}

      {servers.length === 0 && !adding ? (
        <p className="px-1 py-6 text-center text-muted-foreground text-xs">{t('web.mcp.empty')}</p>
      ) : null}

      {servers.map((s) => (
        <McpServerCard
          key={s.name}
          onAuthorize={() => authorize(s.name)}
          onReconnect={() => reconnect(s.name)}
          onRemove={() => removeServer(s.name)}
          onSave={saveServer}
          onToggle={(enabled) => setEnabled(s, enabled)}
          server={s}
          status={statusByName.get(s.name)}
        />
      ))}
    </div>
  );
}

function McpCatalog({ catalog, onAdd }: { catalog: McpCatalogEntry[]; onAdd: (e: McpCatalogEntry) => void }) {
  const t = useT();
  return (
    <div className="rounded-md border bg-muted/20">
      <p className="border-b px-3 py-2 font-medium text-xs">{t('web.mcp.catalogTitle')}</p>
      <div className="flex flex-col">
        {catalog.map((e) => (
          <div
            className="flex items-center gap-3 border-b px-3 py-2 last:border-b-0"
            key={e.id}
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="font-medium text-sm">{e.name}</span>
                <Badge
                  className="text-[10px]"
                  variant="secondary"
                >
                  {e.transport}
                </Badge>
                {e.env.length > 0 ? (
                  <Badge
                    className="text-[10px]"
                    variant="outline"
                  >
                    {t('web.mcp.needsKey')}
                  </Badge>
                ) : null}
              </div>
              <p className="truncate text-muted-foreground text-xs">{e.description}</p>
            </div>
            {e.homepage ? (
              <a
                className="shrink-0 text-muted-foreground text-xs underline"
                href={e.homepage}
                rel="noreferrer"
                target="_blank"
              >
                {t('web.mcp.docs')}
              </a>
            ) : null}
            <Button
              className="shrink-0"
              onClick={() => onAdd(e)}
              size="sm"
              variant="outline"
            >
              <HugeiconsIcon icon={PlusSignIcon} /> {t('web.mcp.catalogAdd')}
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}

function McpStatusDot({ status, enabled }: { status?: McpServerStatus; enabled: boolean }) {
  const t = useT();
  const state = status?.state ?? (enabled ? 'connecting' : 'disabled');
  const color =
    state === 'connected'
      ? 'bg-emerald-500'
      : state === 'failed'
        ? 'bg-destructive'
        : state === 'connecting'
          ? 'bg-amber-500'
          : 'bg-muted-foreground/40';
  const label = t(MCP_STATUS_LABEL_KEYS[state]);
  return (
    <span
      aria-label={label}
      className={cn('size-2 shrink-0 rounded-full', color)}
      role="img"
      title={label}
    />
  );
}

function McpServerCard({
  server,
  status,
  onToggle,
  onSave,
  onRemove,
  onAuthorize,
  onReconnect
}: {
  server: McpServerView;
  status?: McpServerStatus;
  onToggle: (enabled: boolean) => Promise<void>;
  onSave: (s: McpServerView) => Promise<void>;
  onRemove: () => Promise<void>;
  onAuthorize: () => Promise<void>;
  onReconnect: () => Promise<void>;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const { busy, run } = useAsyncAction();
  const [confirmRemove, setConfirmRemove] = useState(false);

  return (
    <div className="rounded-md border">
      <button
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
        onClick={() => setOpen((v) => !v)}
        type="button"
      >
        {open ? (
          <HugeiconsIcon
            className="size-4 text-muted-foreground"
            icon={ChevronDownIcon}
          />
        ) : (
          <HugeiconsIcon
            className="size-4 text-muted-foreground"
            icon={ChevronRightIcon}
          />
        )}
        <McpStatusDot
          enabled={server.enabled}
          status={status}
        />
        <span className="truncate font-medium text-sm">{server.name}</span>
        <Badge
          className="text-[10px]"
          variant="secondary"
        >
          {server.transport}
        </Badge>
        <Badge
          className="text-[10px]"
          variant="outline"
        >
          {t('web.mcp.sourceBuiltIn')}
        </Badge>
        <div className="ml-auto flex items-center gap-2 text-muted-foreground text-xs">
          {status?.state === 'connected' ? (
            <span>{t('web.mcp.toolCount', { n: status.toolCount })}</span>
          ) : server.enabled ? null : (
            <span>{t('web.mcp.disabled')}</span>
          )}
        </div>
      </button>

      {open ? (
        <div className="flex flex-col gap-3 border-t px-3 py-3">
          <div className="flex items-center gap-2">
            <Button
              disabled={busy}
              onClick={() => run(() => onToggle(!server.enabled))}
              size="sm"
              variant={server.enabled ? 'secondary' : 'outline'}
            >
              <HugeiconsIcon icon={PowerIcon} /> {server.enabled ? t('web.mcp.enabled') : t('web.mcp.disabled')}
            </Button>
            {server.transport === 'http' && server.auth.mode === 'oauth' ? (
              <Button
                disabled={busy}
                onClick={() => run(onAuthorize)}
                size="sm"
                variant="outline"
              >
                {busy ? (
                  <HugeiconsIcon
                    className="animate-spin"
                    icon={LoaderPinwheelIcon}
                  />
                ) : (
                  <HugeiconsIcon icon={Key01Icon} />
                )}{' '}
                {t('web.mcp.authorize')}
              </Button>
            ) : null}
            {server.enabled ? (
              <Button
                disabled={busy}
                onClick={() => run(onReconnect)}
                size="sm"
                variant="outline"
              >
                {busy ? (
                  <HugeiconsIcon
                    className="animate-spin"
                    icon={LoaderPinwheelIcon}
                  />
                ) : (
                  <HugeiconsIcon icon={Refresh01Icon} />
                )}{' '}
                {t('web.mcp.reconnect')}
              </Button>
            ) : null}
          </div>

          <ServerForm
            nameLocked
            onSubmit={async (s) => {
              await run(() => onSave(s));
            }}
            server={server}
            submitLabel={t('web.save')}
          />

          <div className="flex items-center gap-2 border-t pt-2">
            {confirmRemove ? (
              <>
                <span className="text-muted-foreground text-xs">{t('web.mcp.confirmRemove')}</span>
                <Button
                  disabled={busy}
                  onClick={() => run(onRemove)}
                  size="sm"
                  variant="destructive"
                >
                  {busy ? (
                    <HugeiconsIcon
                      className="animate-spin"
                      icon={LoaderPinwheelIcon}
                    />
                  ) : (
                    <HugeiconsIcon icon={Delete02Icon} />
                  )}{' '}
                  {t('web.mcp.remove')}
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
                onClick={() => setConfirmRemove(true)}
                size="sm"
                variant="ghost"
              >
                <HugeiconsIcon icon={Delete02Icon} /> {t('web.mcp.remove')}
              </Button>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
