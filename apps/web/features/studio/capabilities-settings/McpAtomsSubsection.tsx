'use client';

import type { WebMessageIdWithoutParams } from '@monad/i18n';
import type { InstalledMcpAtom, McpRegistryEntry, McpServerView } from '@monad/protocol';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  Alert01Icon,
  Cancel01Icon,
  Delete02Icon,
  LoaderPinwheelIcon,
  Plug01Icon,
  PlusSignIcon,
  PowerIcon,
  Refresh01Icon,
  Search01Icon
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  useInstallMcpAtomMutation,
  useInstallMcpBinaryMutation,
  useLazySearchMcpRegistryQuery,
  useListInstalledMcpQuery,
  useRemoveMcpAtomMutation,
  useSetMcpAtomEnabledMutation
} from '@monad/client-rtk';
import { Badge, Button, cn, Input, Label } from '@monad/ui';
import { useState } from 'react';
import { useForm } from 'react-hook-form';

import { useT } from '@/components/I18nProvider';
import { mcpServerFormSchema } from '@/lib/form-validation';

type Mode = 'command' | 'url' | 'binary';
type InstallFormValues = {
  name: string;
  transport: 'stdio' | 'http';
  command: string;
  args: string;
  env: string;
  cwd: string;
  url: string;
};

const MODE_LABEL_KEYS: Record<Mode, WebMessageIdWithoutParams> = {
  binary: 'web.mcpAtom.mode.binary',
  command: 'web.mcpAtom.mode.command',
  url: 'web.mcpAtom.mode.url'
};

// The "atom-pack" half of the MCP section: hot MCP atoms (atoms/mcp/) — npx/uvx command, a remote
// http url, or a prebuilt GitHub-release binary. Mirrors `monad mcp`; connect live, no restart.
export function McpAtomsSubsection() {
  const t = useT();
  const { data, isFetching, refetch } = useListInstalledMcpQuery();
  const [adding, setAdding] = useState(false);
  const [browseOpen, setBrowseOpen] = useState(false);
  const servers = data?.servers ?? [];

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <div className="min-w-0">
          <p className="font-medium text-sm">{t('web.mcp.atomPackServers')}</p>
          <p className="mt-0.5 text-muted-foreground text-xs">{t('web.mcp.atomPackServersHint')}</p>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1">
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
            aria-label={t('web.skills.add')}
            className="size-7"
            onClick={() => {
              setAdding((v) => !v);
              setBrowseOpen(false);
            }}
            size="icon"
            variant={adding ? 'secondary' : 'ghost'}
          >
            <HugeiconsIcon icon={PlusSignIcon} />
          </Button>
          <Button
            className="h-7 gap-1 px-2 text-xs"
            onClick={() => {
              setBrowseOpen((v) => !v);
              setAdding(false);
            }}
            size="sm"
            variant={browseOpen ? 'secondary' : 'ghost'}
          >
            <HugeiconsIcon
              className="size-3.5"
              icon={Search01Icon}
            />
            {t('web.mcpAtom.browse')}
          </Button>
        </div>
      </div>

      {browseOpen ? <BrowsePanel /> : null}
      {adding ? <InstallForm onDone={() => setAdding(false)} /> : null}

      {servers.length === 0 && !adding && !browseOpen ? (
        <p className="px-1 py-6 text-center text-muted-foreground text-xs">{t('web.mcp.empty')}</p>
      ) : null}

      {servers.map((s) => (
        <McpAtomCard
          key={s.name}
          server={s}
        />
      ))}
    </div>
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

  return (
    <div className="flex flex-col overflow-hidden rounded-md border">
      <div className="flex gap-2 border-b px-3 py-2.5">
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
          {isFetching ? (
            <HugeiconsIcon
              className="size-3.5 animate-spin"
              icon={LoaderPinwheelIcon}
            />
          ) : (
            <HugeiconsIcon
              className="size-3.5"
              icon={Search01Icon}
            />
          )}
        </Button>
      </div>
      <div className="flex flex-col gap-2 p-3">
        {isError ? (
          <p className="px-1 py-6 text-center text-destructive text-xs">{t('web.mcpAtom.browseError')}</p>
        ) : data && data.entries.length === 0 ? (
          <p className="px-1 py-6 text-center text-muted-foreground text-xs">{t('web.mcpAtom.browseEmpty')}</p>
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
                <HugeiconsIcon
                  className="size-3.5 shrink-0 text-muted-foreground"
                  icon={Plug01Icon}
                />
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
                    onClick={() => void startInstall(e)}
                    size="sm"
                    variant={done ? 'secondary' : 'outline'}
                  >
                    {isInstalling ? (
                      <HugeiconsIcon
                        className="size-3 animate-spin"
                        icon={LoaderPinwheelIcon}
                      />
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
                    <HugeiconsIcon
                      className="size-3"
                      icon={Alert01Icon}
                    />
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
                      {isInstalling ? (
                        <HugeiconsIcon
                          className="size-3.5 animate-spin"
                          icon={LoaderPinwheelIcon}
                        />
                      ) : null}
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
        <HugeiconsIcon
          className="size-4 text-muted-foreground"
          icon={Plug01Icon}
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
          {t('web.mcp.sourceAtomPack')}
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
            <HugeiconsIcon
              className="size-3.5"
              icon={PowerIcon}
            />
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
              <HugeiconsIcon
                className="size-3.5"
                icon={Delete02Icon}
              />
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
  const installForm = useForm<InstallFormValues>({
    values: {
      name,
      transport: mode === 'url' ? 'http' : 'stdio',
      command,
      args,
      env: '',
      cwd: '',
      url
    },
    resolver: zodResolver(mcpServerFormSchema)
  });
  const errors = installForm.formState.errors;

  const submit = async (consent: boolean) => {
    setError(null);
    try {
      if (mode === 'binary') {
        if (!name.trim()) return;
        const m = release.trim().match(/^([^/]+)\/([^@]+)@(.+)$/);
        if (!m) return setError(t('web.mcpAtom.releaseInvalid'));
        const res = await installBinary({
          name: name.trim(),
          owner: m[1] as string,
          repo: m[2] as string,
          tag: m[3] as string,
          sha256: sha256.trim(),
          consent
        }).unwrap();
        if (res.needsConsent) return setWarnings(res.warnings);
      } else {
        const values = await new Promise<InstallFormValues | null>((resolve) => {
          void installForm.handleSubmit(
            (valid) => resolve(valid),
            () => resolve(null)
          )();
        });
        if (!values) return;
        const server: McpServerView =
          values.transport === 'http'
            ? { name: values.name, transport: 'http', url: values.url, auth: { mode: 'none' }, enabled: true, trust }
            : {
                name: values.name,
                transport: 'stdio',
                command: values.command,
                args: values.args.trim() ? values.args.trim().split(/\s+/) : [],
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
          <HugeiconsIcon icon={Cancel01Icon} />
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
          aria-invalid={!!errors.name || undefined}
          onChange={(e) => setName(e.target.value)}
          placeholder="filesystem"
          value={name}
        />
        {errors.name ? <p className="text-destructive text-xs">{t('web.url.required')}</p> : null}
      </div>

      {mode === 'command' ? (
        <>
          <Field
            error={errors.command ? t('web.url.required') : undefined}
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
          error={errors.url ? t('web.url.httpOnly') : undefined}
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
            <HugeiconsIcon
              className="size-3"
              icon={Alert01Icon}
            />
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
            {isLoading ? (
              <HugeiconsIcon
                className="size-3.5 animate-spin"
                icon={LoaderPinwheelIcon}
              />
            ) : null}
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
          {isLoading ? (
            <HugeiconsIcon
              className="size-3.5 animate-spin"
              icon={LoaderPinwheelIcon}
            />
          ) : (
            <HugeiconsIcon icon={PlusSignIcon} />
          )}
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
  placeholder,
  error
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  error?: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <Label className="text-xs">{label}</Label>
      <Input
        aria-invalid={!!error || undefined}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        value={value}
      />
      {error ? <p className="text-destructive text-xs">{error}</p> : null}
    </div>
  );
}
