'use client';

import type { WebMessageIdWithoutParams } from '@monad/i18n';
import type { InstalledMcpAtom, McpRegistryEntry, McpServerView } from '@monad/protocol';

import {
  useInstallMcpAtomMutation,
  useInstallMcpBinaryMutation,
  useLazySearchMcpRegistryQuery,
  useListInstalledMcpQuery,
  useRemoveMcpAtomMutation,
  useSetMcpAtomEnabledMutation
} from '@monad/client-rtk';
import { Badge, Button, cn, Input, Label, ScrollArea } from '@monad/ui';
import { AlertTriangle, Loader2, Plug, Plus, Power, RefreshCw, Search, Trash2, X } from 'lucide-react';
import { useState } from 'react';

import { useT } from '@/components/I18nProvider';
import { StudioPanel, StudioPanelHeader } from './studio/StudioPanel';

type Mode = 'command' | 'url' | 'binary';
type Panel = 'installed' | 'browse';

const MODE_LABEL_KEYS: Record<Mode, WebMessageIdWithoutParams> = {
  binary: 'web.mcpAtom.mode.binary',
  command: 'web.mcpAtom.mode.command',
  url: 'web.mcpAtom.mode.url'
};

// Hot MCP atoms (atoms/mcp/): npx/uvx command, a remote http url, or a prebuilt GitHub-release binary.
// Mirrors `monad mcp`. The system config.json MCP servers live in McpServersSettings instead.
export function McpAtomsSettings(_props: { onClose: () => void }) {
  const t = useT();
  const { data, isFetching, refetch } = useListInstalledMcpQuery();
  const [adding, setAdding] = useState(false);
  const [panel, setPanel] = useState<Panel>('installed');
  const servers = data?.servers ?? [];

  return (
    <StudioPanel>
      <StudioPanelHeader
        actions={
          <>
            {panel === 'installed' ? (
              <>
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
                  aria-label={t('web.skills.add')}
                  className="size-7"
                  onClick={() => setAdding(true)}
                  size="icon"
                  variant="ghost"
                >
                  <Plus />
                </Button>
              </>
            ) : null}
            <Button
              className="h-7 gap-1 px-2 text-xs"
              onClick={() => {
                setPanel((p) => (p === 'browse' ? 'installed' : 'browse'));
                setAdding(false);
              }}
              size="sm"
              variant={panel === 'browse' ? 'secondary' : 'ghost'}
            >
              <Search className="size-3.5" />
              {t('web.mcpAtom.browse')}
            </Button>
          </>
        }
        subtitle={t('web.mcpAtom.subtitle')}
        title={t('web.mcpAtom.title')}
      />

      {panel === 'browse' ? (
        <BrowsePanel />
      ) : (
        <ScrollArea className="flex-1">
          <div className="flex flex-col gap-2 p-4">
            {adding ? <InstallForm onDone={() => setAdding(false)} /> : null}
            {servers.length === 0 && !adding ? (
              <p className="px-1 py-8 text-center text-muted-foreground text-xs">{t('web.mcp.empty')}</p>
            ) : null}
            {servers.map((s) => (
              <McpAtomCard
                key={s.name}
                server={s}
              />
            ))}
          </div>
        </ScrollArea>
      )}
    </StudioPanel>
  );
}

type McpPending = { server: McpServerView; warnings: string[] };

function BrowsePanel() {
  const t = useT();
  const [query, setQuery] = useState('');
  const [search, { data, isFetching, isError }] = useLazySearchMcpRegistryQuery();
  const [installAtom] = useInstallMcpAtomMutation();
  const [installed, setInstalled] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState<Map<string, McpPending>>(new Map());
  const [installingId, setInstallingId] = useState<string | null>(null);

  const run = () => {
    const q = query.trim();
    if (q) void search(q);
  };

  const buildServer = (entry: McpRegistryEntry): McpServerView => {
    const trust = { autoApproveTools: [] };
    return entry.transport === 'http'
      ? { name: entry.name, transport: 'http', url: entry.url ?? '', auth: { mode: 'none' }, enabled: true, trust }
      : {
          name: entry.name,
          transport: 'stdio',
          command: entry.command ?? 'npx',
          args: entry.args ?? [],
          enabled: true,
          trust
        };
  };

  const startInstall = async (entry: McpRegistryEntry) => {
    setInstallingId(entry.id);
    try {
      const server = buildServer(entry);
      const res = await installAtom({ server, consent: false })
        .unwrap()
        .catch(() => null);
      if (!res) return;
      if (res.needsConsent) {
        setPending((prev) => new Map(prev).set(entry.id, { server, warnings: res.warnings }));
      } else {
        setInstalled((prev) => new Set(prev).add(entry.id));
      }
    } finally {
      setInstallingId(null);
    }
  };

  const confirmInstall = async (id: string) => {
    const p = pending.get(id);
    if (!p) return;
    setInstallingId(id);
    try {
      const res = await installAtom({ server: p.server, consent: true })
        .unwrap()
        .catch(() => null);
      if (res && !res.needsConsent) {
        setInstalled((prev) => new Set(prev).add(id));
        setPending((prev) => {
          const m = new Map(prev);
          m.delete(id);
          return m;
        });
      }
    } finally {
      setInstallingId(null);
    }
  };

  const cancelPending = (id: string) =>
    setPending((prev) => {
      const m = new Map(prev);
      m.delete(id);
      return m;
    });

  const install = startInstall;

  return (
    <div className="flex flex-1 flex-col gap-0 overflow-hidden">
      <div className="flex gap-2 border-b px-4 py-3">
        <Input
          className="flex-1"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && run()}
          placeholder={t('web.mcpAtom.browsePlaceholder')}
          value={query}
        />
        <Button
          disabled={isFetching || !query.trim()}
          onClick={run}
          size="sm"
          variant="secondary"
        >
          {isFetching ? <Loader2 className="size-3.5 animate-spin" /> : <Search className="size-3.5" />}
        </Button>
      </div>
      <ScrollArea className="flex-1">
        <div className="flex flex-col gap-2 p-4">
          {isError ? (
            <p className="px-1 py-8 text-center text-destructive text-xs">{t('web.mcpAtom.browseError')}</p>
          ) : data && data.entries.length === 0 ? (
            <p className="px-1 py-8 text-center text-muted-foreground text-xs">{t('web.mcpAtom.browseEmpty')}</p>
          ) : null}
          {(data?.entries ?? []).map((e) => {
            const done = installed.has(e.id);
            const consent = pending.get(e.id);
            const isInstalling = installingId === e.id;
            return (
              <div
                className="flex flex-col gap-1.5 rounded-md border p-3"
                key={e.id}
              >
                <div className="flex items-center gap-2">
                  <Plug className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate font-medium text-sm">{e.name}</span>
                  <Badge
                    className="text-[10px]"
                    variant="secondary"
                  >
                    {e.transport}
                  </Badge>
                  {e.verified ? (
                    <Badge
                      className="text-[10px]"
                      variant="secondary"
                    >
                      verified
                    </Badge>
                  ) : null}
                  {!consent ? (
                    <Button
                      className="ml-auto h-6 px-2 text-xs"
                      disabled={done || isInstalling || installingId !== null}
                      onClick={() => void install(e)}
                      size="sm"
                      variant={done ? 'secondary' : 'outline'}
                    >
                      {isInstalling ? (
                        <Loader2 className="size-3 animate-spin" />
                      ) : done ? (
                        t('web.mcpAtom.browseInstalled')
                      ) : (
                        t('web.mcpAtom.browseInstall')
                      )}
                    </Button>
                  ) : null}
                </div>
                {e.description ? <p className="text-muted-foreground text-xs">{e.description}</p> : null}
                {e.command ? (
                  <span className="truncate font-mono text-[10px] text-muted-foreground">
                    {e.command} {(e.args ?? []).join(' ')}
                  </span>
                ) : e.url ? (
                  <span className="truncate font-mono text-[10px] text-muted-foreground">{e.url}</span>
                ) : null}
                {e.env.length > 0 ? (
                  <div className="flex flex-wrap gap-1">
                    {e.env.map((v) => (
                      <Badge
                        className="text-[10px]"
                        key={v}
                        variant="outline"
                      >
                        {v}
                      </Badge>
                    ))}
                  </div>
                ) : null}
                {consent ? (
                  <div className="flex flex-col gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2.5 text-xs">
                    <span className="flex items-center gap-1 font-medium text-warning">
                      <AlertTriangle className="size-3" />
                      {t('web.skills.warningsTitle')}
                    </span>
                    {consent.warnings.map((w) => (
                      <span
                        className="text-muted-foreground"
                        key={w}
                      >
                        {w}
                      </span>
                    ))}
                    <div className="flex gap-2">
                      <Button
                        disabled={isInstalling}
                        onClick={() => void confirmInstall(e.id)}
                        size="sm"
                      >
                        {isInstalling ? <Loader2 className="size-3.5 animate-spin" /> : null}
                        {t('web.skills.consentConfirm')}
                      </Button>
                      <Button
                        onClick={() => cancelPending(e.id)}
                        size="sm"
                        variant="ghost"
                      >
                        {t('web.cancel')}
                      </Button>
                    </div>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </ScrollArea>
    </div>
  );
}

function McpAtomCard({ server }: { server: InstalledMcpAtom }) {
  const t = useT();
  const [remove, { isLoading: removing }] = useRemoveMcpAtomMutation();
  const [setEnabled, { isLoading: toggling }] = useSetMcpAtomEnabledMutation();
  const [confirm, setConfirm] = useState(false);

  return (
    <div className="rounded-md border">
      <div className="flex items-center gap-2 px-3 py-2.5">
        <Plug className="size-4 text-muted-foreground" />
        <span className="truncate font-medium text-sm">{server.name}</span>
        <Badge
          className="text-[10px]"
          variant="secondary"
        >
          {server.transport}
        </Badge>
        {!server.enabled ? <span className="text-muted-foreground text-xs">{t('web.mcp.disabled')}</span> : null}
        <span className="truncate font-mono text-[10px] text-muted-foreground">{server.command ?? server.url}</span>
        <div className="ml-auto flex items-center gap-1">
          <Button
            className="gap-1.5"
            disabled={toggling}
            onClick={() =>
              void setEnabled({ name: server.name, enabled: !server.enabled })
                .unwrap()
                .catch(() => {})
            }
            size="sm"
            variant={server.enabled ? 'secondary' : 'outline'}
          >
            <Power className="size-3.5" />
            {server.enabled ? t('web.mcp.enabled') : t('web.mcp.disabled')}
          </Button>
          {confirm ? (
            <>
              <span className="text-muted-foreground text-xs">{t('web.mcp.confirmRemove')}</span>
              <Button
                disabled={removing}
                onClick={async () => {
                  await remove({ name: server.name })
                    .unwrap()
                    .catch(() => {});
                  setConfirm(false);
                }}
                size="sm"
                variant="destructive"
              >
                {removing ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
              </Button>
              <Button
                onClick={() => setConfirm(false)}
                size="sm"
                variant="ghost"
              >
                {t('web.cancel')}
              </Button>
            </>
          ) : (
            <Button
              aria-label={t('web.mcp.remove')}
              className="size-7"
              onClick={() => setConfirm(true)}
              size="icon"
              variant="ghost"
            >
              <Trash2 className="size-3.5" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function InstallForm({ onDone }: { onDone: () => void }) {
  const t = useT();
  const [installAtom, { isLoading: installingAtom }] = useInstallMcpAtomMutation();
  const [installBinary, { isLoading: installingBinary }] = useInstallMcpBinaryMutation();
  const [mode, setMode] = useState<Mode>('command');
  const [name, setName] = useState('');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const [url, setUrl] = useState('');
  const [release, setRelease] = useState(''); // owner/repo@tag
  const [sha256, setSha256] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[] | null>(null);

  const isLoading = installingAtom || installingBinary;
  const trust = { autoApproveTools: [] };

  const submit = async (consent: boolean) => {
    if (!name.trim()) return;
    setError(null);
    try {
      if (mode === 'binary') {
        const m = release.trim().match(/^([^/]+)\/([^@]+)@(.+)$/);
        if (!m) return setError(t('web.mcpAtom.releaseInvalid'));
        const res = await installBinary({
          name,
          owner: m[1] as string,
          repo: m[2] as string,
          tag: m[3] as string,
          sha256: sha256.trim(),
          consent
        }).unwrap();
        if (res.needsConsent) return setWarnings(res.warnings);
      } else {
        const server: McpServerView =
          mode === 'url'
            ? { name, transport: 'http', url: url.trim(), auth: { mode: 'none' }, enabled: true, trust }
            : {
                name,
                transport: 'stdio',
                command: command.trim(),
                args: args.trim() ? args.trim().split(/\s+/) : [],
                enabled: true,
                trust
              };
        const res = await installAtom({ server, consent }).unwrap();
        if (res.needsConsent) return setWarnings(res.warnings);
      }
      onDone();
    } catch {
      setError(t('web.skills.installFailed'));
    }
  };

  return (
    <div className="flex flex-col gap-3 rounded-md border border-primary/30 bg-primary/5 p-3">
      <div className="flex items-center justify-between">
        <span className="font-medium text-sm">{t('web.mcpAtom.addTitle')}</span>
        <Button
          className="size-6"
          onClick={onDone}
          size="icon"
          variant="ghost"
        >
          <X />
        </Button>
      </div>

      <div className="flex gap-1">
        {(['command', 'url', 'binary'] as Mode[]).map((mo) => (
          <Button
            key={mo}
            onClick={() => {
              setMode(mo);
              setWarnings(null);
            }}
            size="sm"
            variant={mode === mo ? 'secondary' : 'ghost'}
          >
            {t(MODE_LABEL_KEYS[mo])}
          </Button>
        ))}
      </div>

      <div className="flex flex-col gap-1">
        <Label className="text-xs">{t('web.mcp.name')}</Label>
        <Input
          onChange={(e) => setName(e.target.value)}
          placeholder="filesystem"
          value={name}
        />
      </div>

      {mode === 'command' ? (
        <>
          <Field
            label={t('web.mcp.command')}
            onChange={setCommand}
            placeholder="npx"
            value={command}
          />
          <Field
            label={t('web.mcp.args')}
            onChange={setArgs}
            placeholder="-y @scope/server"
            value={args}
          />
        </>
      ) : mode === 'url' ? (
        <Field
          label={t('web.mcp.url')}
          onChange={setUrl}
          placeholder="https://mcp.example.com/mcp"
          value={url}
        />
      ) : (
        <>
          <Field
            label={t('web.mcpAtom.release')}
            onChange={setRelease}
            placeholder="owner/repo@v1.0.0"
            value={release}
          />
          <Field
            label={t('web.mcpAtom.sha256')}
            onChange={setSha256}
            placeholder="64-char hex"
            value={sha256}
          />
        </>
      )}

      {warnings ? (
        <div className="flex flex-col gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2.5 text-xs">
          <span className="flex items-center gap-1 font-medium text-warning">
            <AlertTriangle className="size-3" />
            {t('web.skills.warningsTitle')}
          </span>
          {warnings.map((w) => (
            <span
              className="text-muted-foreground"
              key={w}
            >
              {w}
            </span>
          ))}
          <Button
            className="self-start"
            disabled={isLoading}
            onClick={() => void submit(true)}
            size="sm"
          >
            {isLoading ? <Loader2 className="size-3.5 animate-spin" /> : null}
            {t('web.skills.consentConfirm')}
          </Button>
        </div>
      ) : (
        <Button
          className="self-start"
          disabled={isLoading || !name.trim()}
          onClick={() => void submit(false)}
          size="sm"
        >
          {isLoading ? <Loader2 className="size-3.5 animate-spin" /> : <Plus />}
          {isLoading ? t('web.skills.installing') : t('web.skills.install')}
        </Button>
      )}

      {error ? <p className="text-destructive text-xs">{error}</p> : null}
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <Label className="text-xs">{label}</Label>
      <Input
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        value={value}
      />
    </div>
  );
}
