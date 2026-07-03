'use client';

import type { FrameworkAgentView, FrameworkProvider, FrameworkTransportKind } from '@monad/protocol';

import {
  Cancel01Icon,
  ChevronDownIcon,
  ChevronRightIcon,
  Delete02Icon,
  LoaderPinwheelIcon,
  PlusSignIcon,
  PowerIcon,
  Refresh01Icon,
  SaveIcon
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { Badge, Button, cn, Input, Label, ScrollArea, Switch } from '@monad/ui';
import { useId, useState } from 'react';

import { useT } from '@/components/I18nProvider';
import { PanelShell, PanelShellHeader } from '@/components/ui/panel-shell';
import { useAsyncAction } from '@/hooks/use-async-action';
import { useFrameworkAgentSettings } from '@/hooks/use-framework-agent-settings';

// `args` is edited as a single space-separated line; `env` as KEY=VALUE lines. Raw secret values are
// redacted to '••••••' by the daemon before they reach the store; secret-refs (`${env:NAME}`) are
// pointers, not secrets, so they stay visible. A re-saved mask round-trips unchanged server-side.
const argsToStr = (args?: string[]): string => (args ?? []).join(' ');
const strToArgs = (s: string): string[] => s.split(/\s+/).filter(Boolean);
const envToStr = (env?: Record<string, string>): string =>
  Object.entries(env ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
const strToEnv = (s: string): Record<string, string> => {
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

// The default wire mechanism for each provider — OpenClaw ships a one-shot CLI, Hermes a long-lived
// stdio one. Chosen when the operator picks a provider so the common case needs no transport tweak.
const PROVIDER_DEFAULT_TRANSPORT: Record<FrameworkProvider, FrameworkTransportKind> = {
  openclaw: 'cli-oneshot',
  hermes: 'cli-stdio'
};

const TRANSPORT_ORDER: FrameworkTransportKind[] = ['cli-oneshot', 'cli-stdio', 'http-openai-compat', 'custom'];

const isHttpTransport = (transport: FrameworkTransportKind): boolean => transport === 'http-openai-compat';

const BLANK_AGENT: FrameworkAgentView = {
  name: '',
  provider: 'openclaw',
  transport: 'cli-oneshot',
  command: '',
  args: [],
  osSandbox: false,
  forwardMcp: false,
  enabled: true
};

export function FrameworkAgentsSettings({ embedded = false }: { onClose: () => void; embedded?: boolean }) {
  const t = useT();
  const { agents, loading, error, saveAgent, removeAgent, setEnabled, refetch } = useFrameworkAgentSettings();
  // null = no form open; a blank draft = the add form is shown.
  const [draft, setDraft] = useState<FrameworkAgentView | null>(null);

  return (
    <PanelShell>
      {!embedded ? (
        <PanelShellHeader
          actions={
            <>
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
                aria-label={t('web.framework.addAgent')}
                className="size-7"
                onClick={() => setDraft(BLANK_AGENT)}
                size="icon"
                variant="ghost"
              >
                <HugeiconsIcon icon={PlusSignIcon} />
              </Button>
            </>
          }
          subtitle={t('web.framework.subtitle')}
          title={t('web.framework.title')}
        />
      ) : null}

      <ScrollArea className="flex-1">
        <div className="flex flex-col gap-2 p-4">
          {error ? (
            <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-destructive text-xs">
              {error}
            </p>
          ) : null}

          {draft ? (
            <AgentForm
              agent={draft}
              key={draft.name || 'blank'}
              onCancel={() => setDraft(null)}
              onSubmit={async (a) => {
                await saveAgent(a);
                setDraft(null);
              }}
              submitLabel={t('web.framework.create')}
              title={t('web.framework.addTitle')}
            />
          ) : null}

          {agents.length === 0 && !draft ? (
            <p className="px-1 py-8 text-center text-muted-foreground text-xs">{t('web.framework.empty')}</p>
          ) : null}

          {agents.map((a) => (
            <FrameworkAgentCard
              agent={a}
              key={a.name}
              onRemove={() => removeAgent(a.name)}
              onSave={saveAgent}
              onToggle={(enabled) => setEnabled(a, enabled)}
            />
          ))}
        </div>
      </ScrollArea>
    </PanelShell>
  );
}

function FrameworkAgentCard({
  agent,
  onToggle,
  onSave,
  onRemove
}: {
  agent: FrameworkAgentView;
  onToggle: (enabled: boolean) => Promise<void>;
  onSave: (a: FrameworkAgentView) => Promise<void>;
  onRemove: () => Promise<void>;
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
        <span className="truncate font-medium text-sm">{agent.name}</span>
        <Badge
          className="text-[10px] capitalize"
          variant="secondary"
        >
          {agent.provider}
        </Badge>
        {agent.osSandbox ? (
          <Badge
            className="text-[10px]"
            variant="outline"
          >
            {t('web.framework.sandboxBadge')}
          </Badge>
        ) : null}
        <div className="ml-auto flex items-center gap-2 text-muted-foreground text-xs">
          {agent.enabled ? null : <span>{t('web.framework.disabled')}</span>}
        </div>
      </button>

      {open ? (
        <div className="flex flex-col gap-3 border-t px-3 py-3">
          <div className="flex items-center gap-2">
            <Button
              disabled={busy}
              onClick={() => run(() => onToggle(!agent.enabled))}
              size="sm"
              variant={agent.enabled ? 'secondary' : 'outline'}
            >
              <HugeiconsIcon icon={PowerIcon} />{' '}
              {agent.enabled ? t('web.framework.enabled') : t('web.framework.disabled')}
            </Button>
          </div>

          <AgentForm
            agent={agent}
            nameLocked
            onSubmit={async (a) => {
              await run(() => onSave(a));
            }}
            submitLabel={t('web.save')}
          />

          <div className="flex items-center gap-2 border-t pt-2">
            {confirmRemove ? (
              <>
                <span className="text-muted-foreground text-xs">{t('web.framework.confirmRemove')}</span>
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
                  {t('web.framework.remove')}
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
                <HugeiconsIcon icon={Delete02Icon} /> {t('web.framework.remove')}
              </Button>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function AgentForm({
  agent,
  title,
  submitLabel,
  nameLocked,
  onSubmit,
  onCancel
}: {
  agent?: FrameworkAgentView;
  title?: string;
  submitLabel: string;
  nameLocked?: boolean;
  onSubmit: (a: FrameworkAgentView) => Promise<void>;
  onCancel?: () => void;
}) {
  const t = useT();
  const [name, setName] = useState(agent?.name ?? '');
  const [provider, setProvider] = useState<FrameworkProvider>(agent?.provider ?? 'openclaw');
  const [transport, setTransport] = useState<FrameworkTransportKind>(
    agent?.transport ?? PROVIDER_DEFAULT_TRANSPORT[agent?.provider ?? 'openclaw']
  );
  const [command, setCommand] = useState(agent?.command ?? '');
  const [args, setArgs] = useState(argsToStr(agent?.args));
  const [baseUrl, setBaseUrl] = useState(agent?.baseUrl ?? '');
  const [tokenRef, setTokenRef] = useState(agent?.tokenRef ?? '');
  const [defaultModel, setDefaultModel] = useState(agent?.defaultModel ?? '');
  const [env, setEnv] = useState(envToStr(agent?.env));
  const [osSandbox, setOsSandbox] = useState(agent?.osSandbox ?? false);
  const [forwardMcp, setForwardMcp] = useState(agent?.forwardMcp ?? false);
  const [enabled, setEnabled] = useState(agent?.enabled ?? true);
  const [busy, setBusy] = useState(false);
  const osSandboxId = useId();
  const forwardMcpId = useId();
  const enabledId = useId();

  const http = isHttpTransport(transport);
  const custom = transport === 'custom';
  // 'custom' is an SDK/socket escape hatch that may use either shape, so it shows both field groups and
  // drops neither on save. HTTP shows only its fields; the CLI transports only theirs.
  const showCliFields = !http;
  const showHttpFields = http || custom;
  // Each transport needs a different endpoint: HTTP needs a base URL, the CLI transports a command; custom
  // is unconstrained, so a name is enough.
  const canSubmit =
    name.trim().length > 0 && (http ? baseUrl.trim().length > 0 : custom ? true : command.trim().length > 0);

  // Picking a provider resets the transport to that provider's default so the common case is one click.
  const onProviderChange = (next: FrameworkProvider) => {
    setProvider(next);
    setTransport(PROVIDER_DEFAULT_TRANSPORT[next]);
  };

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    try {
      const envRec = strToEnv(env);
      await onSubmit({
        name: name.trim(),
        provider,
        transport,
        command: showCliFields ? command.trim() || undefined : undefined,
        args: showCliFields ? strToArgs(args) : undefined,
        baseUrl: showHttpFields ? baseUrl.trim() || undefined : undefined,
        tokenRef: showHttpFields ? tokenRef.trim() || undefined : undefined,
        defaultModel: showHttpFields ? defaultModel.trim() || undefined : undefined,
        env: Object.keys(envRec).length ? envRec : undefined,
        osSandbox,
        forwardMcp,
        // In the card (edit) the power button owns enable/disable via a dedicated endpoint; read the live
        // prop so saving another field never reverts a toggle. The add form uses the local Switch below.
        enabled: nameLocked ? (agent?.enabled ?? true) : enabled
      });
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
              <HugeiconsIcon icon={Cancel01Icon} />
            </Button>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-col gap-1">
        <Label className="text-xs">{t('web.framework.name')}</Label>
        <Input
          disabled={nameLocked}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('web.framework.namePlaceholder')}
          value={name}
        />
      </div>
      <div className="flex flex-col gap-1">
        <Label className="text-xs">{t('web.framework.provider')}</Label>
        <select
          className="rounded-md border bg-transparent px-2 py-2 text-sm"
          onChange={(e) => onProviderChange(e.target.value as FrameworkProvider)}
          value={provider}
        >
          <option value="openclaw">OpenClaw</option>
          <option value="hermes">Hermes</option>
        </select>
      </div>
      <div className="flex flex-col gap-1">
        <Label className="text-xs">{t('web.framework.transport')}</Label>
        <select
          className="rounded-md border bg-transparent px-2 py-2 text-sm"
          onChange={(e) => setTransport(e.target.value as FrameworkTransportKind)}
          value={transport}
        >
          {TRANSPORT_ORDER.map((kind) => (
            <option
              key={kind}
              value={kind}
            >
              {t(`web.framework.transport.${kind}` as Parameters<typeof t>[0])}
            </option>
          ))}
        </select>
        <p className="text-[11px] text-muted-foreground">{t('web.framework.transportHint')}</p>
      </div>

      {showCliFields ? (
        <>
          <div className="flex flex-col gap-1">
            <Label className="text-xs">{t('web.framework.command')}</Label>
            <Input
              onChange={(e) => setCommand(e.target.value)}
              placeholder={t('web.framework.commandPlaceholder')}
              value={command}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label className="text-xs">{t('web.framework.args')}</Label>
            <Input
              onChange={(e) => setArgs(e.target.value)}
              placeholder={t('web.framework.argsPlaceholder')}
              value={args}
            />
          </div>
        </>
      ) : null}
      {showHttpFields ? (
        <>
          <div className="flex flex-col gap-1">
            <Label className="text-xs">{t('web.framework.baseUrl')}</Label>
            <Input
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder={t('web.framework.baseUrlPlaceholder')}
              value={baseUrl}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label className="text-xs">{t('web.framework.tokenRef')}</Label>
            <Input
              onChange={(e) => setTokenRef(e.target.value)}
              placeholder={t('web.framework.tokenRefPlaceholder')}
              value={tokenRef}
            />
            <p className="text-[11px] text-muted-foreground">{t('web.framework.tokenRefHint')}</p>
          </div>
          <div className="flex flex-col gap-1">
            <Label className="text-xs">{t('web.framework.defaultModel')}</Label>
            <Input
              onChange={(e) => setDefaultModel(e.target.value)}
              placeholder={t('web.framework.defaultModelPlaceholder')}
              value={defaultModel}
            />
          </div>
        </>
      ) : null}

      <div className="flex flex-col gap-1">
        <Label className="text-xs">{t('web.framework.env')}</Label>
        <textarea
          className="min-h-16 rounded-md border bg-transparent px-2 py-1 font-mono text-xs"
          onChange={(e) => setEnv(e.target.value)}
          placeholder={t('web.framework.envPlaceholder')}
          value={env}
        />
      </div>

      {/* Headline control: the sandbox opt-in. Off by default because it redirects HOME. */}
      <div className="flex items-center justify-between gap-3 rounded-md border px-3 py-2.5">
        <div className="flex min-w-0 flex-col gap-1">
          <Label
            className="text-xs"
            htmlFor={osSandboxId}
          >
            {t('web.framework.osSandbox')}
          </Label>
          <p className="text-[11px] text-muted-foreground">{t('web.framework.osSandboxHint')}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="text-muted-foreground text-xs">
            {osSandbox ? t('web.framework.osSandboxOn') : t('web.framework.osSandboxOff')}
          </span>
          <Switch
            aria-label={t('web.framework.osSandbox')}
            checked={osSandbox}
            id={osSandboxId}
            onCheckedChange={setOsSandbox}
          />
        </div>
      </div>

      <div className="flex items-center justify-between gap-3 rounded-md border px-3 py-2.5">
        <div className="flex min-w-0 flex-col gap-1">
          <Label
            className="text-xs"
            htmlFor={forwardMcpId}
          >
            {t('web.framework.forwardMcp')}
          </Label>
          <p className="text-[11px] text-muted-foreground">{t('web.framework.forwardMcpHint')}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="text-muted-foreground text-xs">
            {forwardMcp ? t('web.framework.forwardMcpOn') : t('web.framework.forwardMcpOff')}
          </span>
          <Switch
            aria-label={t('web.framework.forwardMcp')}
            checked={forwardMcp}
            id={forwardMcpId}
            onCheckedChange={setForwardMcp}
          />
        </div>
      </div>

      {/* Enable/disable lives here only when adding. When editing an existing agent the card's power
          button owns it (a dedicated endpoint) — a second control here would let a stale value revert it. */}
      {nameLocked ? null : (
        <div className="flex items-center justify-between gap-3 rounded-md border px-3 py-2.5">
          <div className="flex min-w-0 flex-col gap-1">
            <Label
              className="text-xs"
              htmlFor={enabledId}
            >
              {t('web.framework.enabledLabel')}
            </Label>
            <p className="text-[11px] text-muted-foreground">{t('web.framework.enabledHint')}</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <span className="text-muted-foreground text-xs">
              {enabled ? t('web.framework.enabled') : t('web.framework.disabled')}
            </span>
            <Switch
              aria-label={t('web.framework.enabledLabel')}
              checked={enabled}
              id={enabledId}
              onCheckedChange={setEnabled}
            />
          </div>
        </div>
      )}

      <Button
        className="self-start"
        disabled={busy || !canSubmit}
        onClick={submit}
        size="sm"
      >
        {busy ? (
          <HugeiconsIcon
            className="animate-spin"
            icon={LoaderPinwheelIcon}
          />
        ) : title ? (
          <HugeiconsIcon icon={PlusSignIcon} />
        ) : (
          <HugeiconsIcon icon={SaveIcon} />
        )}{' '}
        {submitLabel}
      </Button>
    </div>
  );
}
