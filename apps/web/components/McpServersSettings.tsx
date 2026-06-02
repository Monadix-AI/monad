'use client';

import type { WebMessageIdWithoutParams } from '@monad/i18n';
import type { McpCatalogEntry, McpServerStatus, McpServerView } from '@monad/protocol';

import {
  Badge,
  Button,
  cn,
  Input,
  Label,
  ScrollArea,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@monad/ui';
import {
  Boxes,
  ChevronDown,
  ChevronRight,
  KeyRound,
  Loader2,
  Plus,
  Power,
  RefreshCw,
  Save,
  Trash2,
  X
} from 'lucide-react';
import { useState } from 'react';

import { I18nTrans, useT } from '@/components/I18nProvider';
import { useAsyncAction } from '../hooks/use-async-action';
import { useMcpServerSettings } from '../hooks/use-mcp-server-settings';
import { StudioPanel, StudioPanelHeader } from './studio/StudioPanel';

const envRef = (name: string) => `\${env:${name}}`;

// `args` edited as one space-separated line; `env`/`headers` as KEY=VALUE lines; `autoApproveTools`
// as one space-separated line. Secret values are `${env:NAME}` refs by convention — shown as-is.
const argsToStr = (args?: string[]): string => (args ?? []).join(' ');
const strToArgs = (s: string): string[] => s.split(/\s+/).filter(Boolean);
const mapToStr = (m?: Record<string, string>): string =>
  Object.entries(m ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
const strToMap = (s: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const line of s.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
};

type AuthMode = 'none' | 'bearer' | 'headers' | 'oauth';
type McpStatusState = NonNullable<McpServerStatus['state']> | 'connecting' | 'disabled';

const MCP_STATUS_LABEL_KEYS: Record<McpStatusState, WebMessageIdWithoutParams> = {
  connected: 'web.mcp.state.connected',
  connecting: 'web.mcp.state.connecting',
  disabled: 'web.mcp.state.disabled',
  failed: 'web.mcp.state.failed'
};

// Map a catalog entry to a pre-filled (editable) add-form draft. Env vars become `${env:NAME}` refs
// the user fills in before saving; nothing connects until the upsert.
function catalogToServer(e: McpCatalogEntry): McpServerView {
  const trust = { autoApproveTools: [] as string[] };
  if (e.transport === 'http') {
    return { name: e.id, transport: 'http', url: e.url ?? '', auth: { mode: 'none' }, enabled: true, trust };
  }
  const env = e.env.length > 0 ? Object.fromEntries(e.env.map((k) => [k, envRef(k)])) : undefined;
  return { name: e.id, transport: 'stdio', command: e.command ?? '', args: e.args, env, enabled: true, trust };
}

export function McpServersSettings(_props: { onClose: () => void }) {
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
  // A pre-filled draft from the catalog → the add form opens populated (editable, name unlocked).
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
    <StudioPanel>
      <StudioPanelHeader
        actions={
          <>
            <Button
              aria-label={t('web.refresh')}
              className="size-7"
              onClick={refetch}
              size="icon"
              variant="ghost"
            >
              <RefreshCw className={cn(loading && 'animate-spin')} />
            </Button>
            <Button
              aria-label={t('web.mcp.catalog')}
              className="size-7"
              onClick={() => setCatalogOpen((v) => !v)}
              size="icon"
              variant={catalogOpen ? 'secondary' : 'ghost'}
            >
              <Boxes />
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
              <Plus />
            </Button>
          </>
        }
        subtitle={t('web.mcp.subtitle')}
        title={t('web.mcp.title')}
      />

      <p className="border-b bg-muted/30 px-5 py-2 text-muted-foreground text-xs">
        <I18nTrans
          components={{ code: <code /> }}
          i18nKey="web.mcp.bootHint"
          values={{ ref: envRef('NAME') }}
        />
      </p>

      <ScrollArea className="flex-1">
        <div className="flex flex-col gap-2 p-4">
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
            <p className="px-1 py-8 text-center text-muted-foreground text-xs">{t('web.mcp.empty')}</p>
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
      </ScrollArea>
    </StudioPanel>
  );
}

// Curated directory of popular MCP servers — click Add to open the add form pre-filled (the user
// reviews, fills any `${env:NAME}` secret refs, and saves).
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
              <Plus /> {t('web.mcp.catalogAdd')}
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}

// Live connection health dot. No status yet (still polling) on an enabled server reads as
// "connecting"; a disabled server is dimmed; connected/failed map to emerald/destructive.
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
          <ChevronDown className="size-4 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-4 text-muted-foreground" />
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
              <Power /> {server.enabled ? t('web.mcp.enabled') : t('web.mcp.disabled')}
            </Button>
            {server.transport === 'http' && server.auth.mode === 'oauth' ? (
              <Button
                disabled={busy}
                onClick={() => run(onAuthorize)}
                size="sm"
                variant="outline"
              >
                {busy ? <Loader2 className="animate-spin" /> : <KeyRound />} {t('web.mcp.authorize')}
              </Button>
            ) : null}
            {server.enabled ? (
              <Button
                disabled={busy}
                onClick={() => run(onReconnect)}
                size="sm"
                variant="outline"
              >
                {busy ? <Loader2 className="animate-spin" /> : <RefreshCw />} {t('web.mcp.reconnect')}
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
                  {busy ? <Loader2 className="animate-spin" /> : <Trash2 />} {t('web.mcp.remove')}
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
                <Trash2 /> {t('web.mcp.remove')}
              </Button>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ServerForm({
  server,
  title,
  submitLabel,
  nameLocked,
  onSubmit,
  onCancel
}: {
  server?: McpServerView;
  title?: string;
  submitLabel: string;
  nameLocked?: boolean;
  onSubmit: (s: McpServerView) => Promise<void>;
  onCancel?: () => void;
}) {
  const t = useT();
  const [name, setName] = useState(server?.name ?? '');
  const [transport, setTransport] = useState<'stdio' | 'http'>(server?.transport ?? 'stdio');
  // stdio fields
  const [command, setCommand] = useState(server?.transport === 'stdio' ? server.command : '');
  const [args, setArgs] = useState(argsToStr(server?.transport === 'stdio' ? server.args : undefined));
  const [env, setEnv] = useState(mapToStr(server?.transport === 'stdio' ? server.env : undefined));
  const [cwd, setCwd] = useState((server?.transport === 'stdio' ? server.cwd : '') ?? '');
  // http fields
  const [url, setUrl] = useState(server?.transport === 'http' ? server.url : '');
  const originalAuthMode: AuthMode = server?.transport === 'http' ? server.auth.mode : 'none';
  const [authMode, setAuthMode] = useState<AuthMode>(originalAuthMode);
  const [token, setToken] = useState(
    server?.transport === 'http' && server.auth.mode === 'bearer' ? server.auth.token : ''
  );
  const [headers, setHeaders] = useState(
    mapToStr(server?.transport === 'http' && server.auth.mode === 'headers' ? server.auth.headers : undefined)
  );
  const [busy, setBusy] = useState(false);

  // OAuth is configured in config.json (it needs the daemon's redirect/device flow); the form keeps
  // an existing oauth server's auth intact rather than letting a token field clobber it.
  const oauthLocked = originalAuthMode === 'oauth' && authMode === 'oauth';

  const buildAuth = (): Extract<McpServerView, { transport: 'http' }>['auth'] => {
    if (authMode === 'bearer') return { mode: 'bearer', token: token.trim() };
    if (authMode === 'headers') return { mode: 'headers', headers: strToMap(headers) };
    if (authMode === 'oauth' && server?.transport === 'http' && server.auth.mode === 'oauth') return server.auth;
    return { mode: 'none' };
  };

  const submit = async () => {
    if (!name.trim()) return;
    if (transport === 'stdio' && !command.trim()) return;
    if (transport === 'http' && !url.trim()) return;
    setBusy(true);
    try {
      const trust = server?.trust ?? { autoApproveTools: [] };
      let next: McpServerView;
      if (transport === 'stdio') {
        const envRec = strToMap(env);
        next = {
          name: name.trim(),
          transport: 'stdio',
          command: command.trim(),
          args: strToArgs(args),
          env: Object.keys(envRec).length ? envRec : undefined,
          cwd: cwd.trim() || undefined,
          enabled: server?.enabled ?? true,
          trust
        };
      } else {
        next = {
          name: name.trim(),
          transport: 'http',
          url: url.trim(),
          auth: buildAuth(),
          enabled: server?.enabled ?? true,
          trust
        };
      }
      await onSubmit(next);
    } finally {
      setBusy(false);
    }
  };

  const wrapper = title
    ? 'flex flex-col gap-3 rounded-md border border-primary/30 bg-primary/5 p-3'
    : 'flex flex-col gap-3';

  return (
    <div className={wrapper}>
      {title ? (
        <div className="flex items-center justify-between">
          <span className="font-medium text-sm">{title}</span>
          {onCancel ? (
            <Button
              className="size-6"
              onClick={onCancel}
              size="icon"
              variant="ghost"
            >
              <X />
            </Button>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-col gap-1">
        <Label className="text-xs">{t('web.mcp.name')}</Label>
        <Input
          disabled={nameLocked}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('web.mcp.namePlaceholder')}
          value={name}
        />
      </div>
      <div className="flex flex-col gap-1">
        <Label className="text-xs">{t('web.mcp.transport')}</Label>
        <Select
          onValueChange={(v) => setTransport(v as 'stdio' | 'http')}
          value={transport}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="stdio">{t('web.mcp.transportStdio')}</SelectItem>
            <SelectItem value="http">{t('web.mcp.transportHttp')}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {transport === 'stdio' ? (
        <>
          <div className="flex flex-col gap-1">
            <Label className="text-xs">{t('web.mcp.command')}</Label>
            <Input
              onChange={(e) => setCommand(e.target.value)}
              placeholder={t('web.mcp.commandPlaceholder')}
              value={command}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label className="text-xs">{t('web.mcp.args')}</Label>
            <Input
              onChange={(e) => setArgs(e.target.value)}
              placeholder={t('web.mcp.argsPlaceholder')}
              value={args}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label className="text-xs">{t('web.mcp.workingDir')}</Label>
            <Input
              onChange={(e) => setCwd(e.target.value)}
              placeholder={t('web.mcp.workingDirPlaceholder')}
              value={cwd}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label className="text-xs">{t('web.mcp.env')}</Label>
            <textarea
              className="min-h-16 rounded-md border bg-transparent px-2 py-1 font-mono text-xs"
              onChange={(e) => setEnv(e.target.value)}
              placeholder={t('web.mcp.envPlaceholder')}
              value={env}
            />
          </div>
        </>
      ) : (
        <>
          <div className="flex flex-col gap-1">
            <Label className="text-xs">{t('web.mcp.url')}</Label>
            <Input
              onChange={(e) => setUrl(e.target.value)}
              placeholder={t('web.mcp.urlPlaceholder')}
              value={url}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label className="text-xs">{t('web.mcp.auth')}</Label>
            <Select
              onValueChange={(v) => setAuthMode(v as AuthMode)}
              value={authMode}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">{t('web.mcp.authNone')}</SelectItem>
                <SelectItem value="bearer">{t('web.mcp.authBearer')}</SelectItem>
                <SelectItem value="headers">{t('web.mcp.authHeaders')}</SelectItem>
                {originalAuthMode === 'oauth' ? <SelectItem value="oauth">{t('web.mcp.authOauth')}</SelectItem> : null}
              </SelectContent>
            </Select>
          </div>
          {oauthLocked ? <p className="text-muted-foreground text-xs">{t('web.mcp.authOauthNote')}</p> : null}
          {authMode === 'bearer' ? (
            <div className="flex flex-col gap-1">
              <Label className="text-xs">{t('web.mcp.token')}</Label>
              <Input
                onChange={(e) => setToken(e.target.value)}
                placeholder={t('web.mcp.tokenPlaceholder')}
                value={token}
              />
            </div>
          ) : null}
          {authMode === 'headers' ? (
            <div className="flex flex-col gap-1">
              <Label className="text-xs">{t('web.mcp.headers')}</Label>
              <textarea
                className="min-h-16 rounded-md border bg-transparent px-2 py-1 font-mono text-xs"
                onChange={(e) => setHeaders(e.target.value)}
                placeholder={t('web.mcp.headersPlaceholder')}
                value={headers}
              />
            </div>
          ) : null}
        </>
      )}

      <Button
        className="self-start"
        disabled={busy || !name.trim() || (transport === 'stdio' ? !command.trim() : !url.trim())}
        onClick={submit}
        size="sm"
      >
        {busy ? <Loader2 className="animate-spin" /> : title ? <Plus /> : <Save />} {submitLabel}
      </Button>
    </div>
  );
}
