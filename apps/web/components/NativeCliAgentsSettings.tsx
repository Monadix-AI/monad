'use client';

import type { WebMessageIdWithoutParams } from '@monad/i18n';
import type { NativeCliAgentPresetView, NativeCliAgentView, NativeCliProvider } from '@monad/protocol';

import {
  useGetNativeCliAuthQuery,
  useInputNativeCliAuthMutation,
  useStartNativeCliAuthMutation,
  useStopNativeCliAuthMutation
} from '@monad/client-rtk';
import { Badge, Button, cn, Input, Label, ScrollArea } from '@monad/ui';
import {
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Loader2,
  PlugZap,
  Plus,
  Power,
  RefreshCw,
  Save,
  Trash2,
  X
} from 'lucide-react';
import { useState } from 'react';

import { useT } from '@/components/I18nProvider';
import { providerLogo } from '@/lib/ProviderMeta';
import { useAsyncAction } from '../hooks/use-async-action';
import { useNativeCliAgentSettings } from '../hooks/use-native-cli-agent-settings';
import { StudioPanel, StudioPanelHeader } from './studio/StudioPanel';
import { CliTerminalModal } from './workplace/CliTerminalModal';

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

const BLANK_AGENT: NativeCliAgentView = {
  name: '',
  provider: 'codex',
  command: '',
  args: [],
  enabled: true,
  defaultLaunchMode: 'pty',
  allowDangerousMode: false,
  approvalOwnership: 'provider-owned'
};

const presetToView = (p: NativeCliAgentPresetView): NativeCliAgentView => ({
  name: p.id,
  provider: p.provider,
  command: p.command,
  args: p.args,
  enabled: true,
  defaultLaunchMode: p.defaultLaunchMode,
  allowDangerousMode: false,
  approvalOwnership: 'provider-owned'
});

function presetLogo(provider: NativeCliProvider) {
  const providerType = provider === 'claude-code' ? 'anthropic' : provider === 'gemini' ? 'google' : 'openai';
  return providerLogo(providerType).logo;
}

function presetHintKey(id: string): WebMessageIdWithoutParams {
  return `web.nativeCli.presetHint.${id}` as WebMessageIdWithoutParams;
}

export function NativeCliAgentsSettings(_props: { onClose: () => void }) {
  const t = useT();
  const { agents, presets, loading, saveAgent, removeAgent, setEnabled, refetch } = useNativeCliAgentSettings();
  const [draft, setDraft] = useState<NativeCliAgentView | null>(null);
  const [authSession, setAuthSession] = useState<{ id: string; agentName: string } | null>(null);
  const [startAuth] = useStartNativeCliAuthMutation();
  const { busy: connectBusy, error: connectError, run: runConnect } = useAsyncAction();

  const connectAgent = (agent: NativeCliAgentView) =>
    runConnect(async () => {
      await saveAgent(agent);
      const session = await startAuth(agent.name).unwrap();
      setAuthSession({ id: session.id, agentName: agent.name });
    });
  const openInstallPage = (preset: NativeCliAgentPresetView) => {
    window.open(preset.installUrl, '_blank', 'noopener,noreferrer');
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
              aria-label={t('web.nativeCli.addAgent')}
              className="size-7"
              onClick={() => setDraft(BLANK_AGENT)}
              size="icon"
              variant="ghost"
            >
              <Plus />
            </Button>
          </>
        }
        subtitle={t('web.nativeCli.subtitle')}
        title={t('web.nativeCli.title')}
      />

      <p className="border-b bg-muted/30 px-5 py-2 text-muted-foreground text-xs">{t('web.nativeCli.bootHint')}</p>

      <ScrollArea className="flex-1">
        <div className="flex flex-col gap-2 p-4">
          {connectError ? (
            <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-destructive text-xs">
              {connectError}
            </p>
          ) : null}

          {presets.length > 0 && !draft ? (
            <div className="native-cli-live-v2">
              <style>{`
                .native-cli-live-v2 {
                  display: grid;
                  grid-template-columns: minmax(160px, 0.72fr) minmax(0, 1.9fr);
                  gap: 14px;
                  border: 1px solid var(--border);
                  border-radius: 10px;
                  background: color-mix(in srgb, var(--muted) 54%, transparent);
                  padding: 12px;
                }

                .native-cli-live-v2__header {
                  display: flex;
                  flex-direction: column;
                  gap: 6px;
                  padding: 2px 4px;
                }

                .native-cli-live-v2__header > span {
                  font-size: 13px;
                  font-weight: 650;
                }

                .native-cli-live-v2 p {
                  margin: 0;
                  color: var(--muted-foreground);
                  font-size: 12px;
                  line-height: 1.45;
                }

                .native-cli-live-v2__list {
                  display: flex;
                  flex-direction: column;
                  gap: 6px;
                }

                .native-cli-live-v2__row {
                  display: grid;
                  grid-template-columns: 34px minmax(0, 1fr) auto;
                  align-items: center;
                  gap: 10px;
                  min-height: 54px;
                  border: 1px solid var(--border);
                  border-radius: 8px;
                  background: var(--card);
                  padding: 8px 9px;
                }

                .native-cli-live-v2__logo {
                  display: grid;
                  place-items: center;
                  width: 34px;
                  height: 34px;
                  border: 1px solid var(--border);
                  border-radius: 7px;
                  background: var(--background);
                }

                .native-cli-live-v2__main {
                  display: flex;
                  min-width: 0;
                  flex-direction: column;
                  gap: 2px;
                }

                .native-cli-live-v2__name {
                  overflow: hidden;
                  text-overflow: ellipsis;
                  white-space: nowrap;
                  font-size: 13px;
                  font-weight: 650;
                }

                .native-cli-live-v2__meta {
                  color: var(--muted-foreground);
                  font-family: var(--font-mono), ui-monospace, monospace;
                  font-size: 10px;
                }

                .native-cli-live-v2__actions {
                  display: flex;
                  align-items: center;
                  gap: 6px;
                }

                @media (max-width: 760px) {
                  .native-cli-live-v2 {
                    grid-template-columns: 1fr;
                  }

                  .native-cli-live-v2__row {
                    grid-template-columns: 34px minmax(0, 1fr);
                  }

                  .native-cli-live-v2__actions {
                    grid-column: 2;
                  }
                }
              `}</style>
              <div className="native-cli-live-v2__header">
                <span>{t('web.nativeCli.invite')}</span>
                <p>{t('web.nativeCli.inviteHint')}</p>
              </div>
              <div className="native-cli-live-v2__list">
                {presets.map((p) => {
                  const ProductLogo = presetLogo(p.provider);
                  const agent = presetToView(p);
                  return (
                    <div
                      className="native-cli-live-v2__row"
                      key={p.id}
                      title={p.installed ? undefined : t(presetHintKey(p.id))}
                    >
                      <span className="native-cli-live-v2__logo">
                        <ProductLogo className="size-6" />
                      </span>
                      <span className="native-cli-live-v2__main">
                        <span className="native-cli-live-v2__name">{p.label}</span>
                        <span className="native-cli-live-v2__meta">
                          {p.installed ? t('web.acp.installed') : t('web.acp.notInstalled')}
                          {p.capabilities?.auth ? ` · ${p.capabilities.auth}` : ''}
                        </span>
                      </span>
                      <span className="native-cli-live-v2__actions">
                        {p.installed ? (
                          <Button
                            disabled={connectBusy}
                            onClick={() => connectAgent(agent)}
                            size="sm"
                            type="button"
                            variant="secondary"
                          >
                            {connectBusy ? <Loader2 className="animate-spin" /> : <PlugZap />}
                            {t('web.nativeCli.connect')}
                          </Button>
                        ) : (
                          <Button
                            onClick={() => openInstallPage(p)}
                            size="sm"
                            type="button"
                            variant="secondary"
                          >
                            <ExternalLink />
                            {t('web.nativeCli.install')}
                          </Button>
                        )}
                        <Button
                          onClick={() => setDraft(agent)}
                          size="sm"
                          type="button"
                          variant="ghost"
                        >
                          {t('web.nativeCli.review')}
                        </Button>
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
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
              submitLabel={t('web.nativeCli.create')}
              title={t('web.nativeCli.addTitle')}
            />
          ) : null}

          {agents.length === 0 && !draft ? (
            <p className="px-1 py-8 text-center text-muted-foreground text-xs">{t('web.nativeCli.empty')}</p>
          ) : null}

          {agents.map((a) => (
            <NativeCliAgentCard
              agent={a}
              key={a.name}
              onRemove={() => removeAgent(a.name)}
              onSave={saveAgent}
              onToggle={(enabled) => setEnabled(a, enabled)}
            />
          ))}
        </div>
      </ScrollArea>
      {authSession ? (
        <NativeCliAuthBridge
          agentName={authSession.agentName}
          onClose={() => setAuthSession(null)}
          sessionId={authSession.id}
        />
      ) : null}
    </StudioPanel>
  );
}

function NativeCliAuthBridge({
  sessionId,
  agentName,
  onClose
}: {
  sessionId: string;
  agentName: string;
  onClose: () => void;
}) {
  const t = useT();
  const { data } = useGetNativeCliAuthQuery(sessionId, { pollingInterval: 750 });
  const [inputAuth] = useInputNativeCliAuthMutation();
  const [stopAuth] = useStopNativeCliAuthMutation();
  const output = data?.outputSnapshot ?? '';
  const isLive = data ? data.state === 'starting' || data.state === 'running' : true;
  const status = data?.state === 'failed' ? 'error' : isLive ? 'running' : 'ok';

  return (
    <CliTerminalModal
      eyebrow={t('web.nativeCli.connectTitle')}
      footerLabel={t('web.nativeCli.connectTerminalHint')}
      id={sessionId}
      onClose={onClose}
      onInput={(input) => {
        if (isLive) void inputAuth({ id: sessionId, input }).unwrap();
      }}
      onStop={() => {
        void stopAuth(sessionId).unwrap();
        onClose();
      }}
      output={output}
      status={status}
      stopLabel={t('web.nativeCli.stopConnect')}
      subtitle={t('web.nativeCli.connectHint')}
      tag={t('web.nativeCli.providerOwned')}
      title={agentName}
    />
  );
}

function NativeCliAgentCard({
  agent,
  onToggle,
  onSave,
  onRemove
}: {
  agent: NativeCliAgentView;
  onToggle: (enabled: boolean) => Promise<void>;
  onSave: (a: NativeCliAgentView) => Promise<void>;
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
          <ChevronDown className="size-4 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-4 text-muted-foreground" />
        )}
        <span className="truncate font-medium text-sm">{agent.name}</span>
        <Badge
          className="text-[10px]"
          variant="secondary"
        >
          {agent.provider}
        </Badge>
        <Badge
          className="text-[10px]"
          variant="outline"
        >
          {agent.defaultLaunchMode}
        </Badge>
        <div className="ml-auto flex items-center gap-2 text-muted-foreground text-xs">
          {agent.enabled ? null : <span>{t('web.acp.disabled')}</span>}
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
              <Power /> {agent.enabled ? t('web.acp.enabled') : t('web.acp.disabled')}
            </Button>
            <Badge variant="outline">{t('web.nativeCli.providerOwned')}</Badge>
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
                <span className="text-muted-foreground text-xs">{t('web.acp.confirmRemove')}</span>
                <Button
                  disabled={busy}
                  onClick={() => run(onRemove)}
                  size="sm"
                  variant="destructive"
                >
                  {busy ? <Loader2 className="animate-spin" /> : <Trash2 />} {t('web.acp.remove')}
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
                <Trash2 /> {t('web.acp.remove')}
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
  agent?: NativeCliAgentView;
  title?: string;
  submitLabel: string;
  nameLocked?: boolean;
  onSubmit: (a: NativeCliAgentView) => Promise<void>;
  onCancel?: () => void;
}) {
  const t = useT();
  const [name, setName] = useState(agent?.name ?? '');
  const [provider, setProvider] = useState<NativeCliProvider>(agent?.provider ?? 'codex');
  const [command, setCommand] = useState(agent?.command ?? '');
  const [args, setArgs] = useState(argsToStr(agent?.args));
  const [env, setEnv] = useState(envToStr(agent?.env));
  const [allowDangerousMode, setAllowDangerousMode] = useState(agent?.allowDangerousMode ?? false);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!name.trim() || !command.trim()) return;
    setBusy(true);
    try {
      const envRec = strToEnv(env);
      await onSubmit({
        name: name.trim(),
        provider,
        command: command.trim(),
        args: strToArgs(args),
        env: Object.keys(envRec).length ? envRec : undefined,
        enabled: agent?.enabled ?? true,
        defaultLaunchMode: agent?.defaultLaunchMode ?? 'pty',
        allowDangerousMode,
        approvalOwnership: 'provider-owned'
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
              <X />
            </Button>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-col gap-1">
        <Label className="text-xs">{t('web.acp.name')}</Label>
        <Input
          disabled={nameLocked}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('web.nativeCli.namePlaceholder')}
          value={name}
        />
      </div>
      <div className="flex flex-col gap-1">
        <Label className="text-xs">{t('web.nativeCli.provider')}</Label>
        <select
          className="rounded-md border bg-transparent px-2 py-2 text-sm"
          onChange={(e) => setProvider(e.target.value as NativeCliProvider)}
          value={provider}
        >
          <option value="codex">Codex</option>
          <option value="claude-code">Claude Code</option>
          <option value="gemini">Gemini</option>
        </select>
      </div>
      <div className="flex flex-col gap-1">
        <Label className="text-xs">{t('web.acp.command')}</Label>
        <Input
          onChange={(e) => setCommand(e.target.value)}
          placeholder={t('web.nativeCli.commandPlaceholder')}
          value={command}
        />
      </div>
      <div className="flex flex-col gap-1">
        <Label className="text-xs">{t('web.acp.args')}</Label>
        <Input
          onChange={(e) => setArgs(e.target.value)}
          placeholder={t('web.nativeCli.argsPlaceholder')}
          value={args}
        />
      </div>
      <div className="flex flex-col gap-1">
        <Label className="text-xs">{t('web.acp.env')}</Label>
        <textarea
          className="min-h-16 rounded-md border bg-transparent px-2 py-1 font-mono text-xs"
          onChange={(e) => setEnv(e.target.value)}
          placeholder={t('web.acp.envPlaceholder')}
          value={env}
        />
      </div>
      <div className="flex flex-col gap-1">
        <Label className="text-xs">{t('web.nativeCli.dangerousMode')}</Label>
        <Button
          className="self-start"
          onClick={() => setAllowDangerousMode((v) => !v)}
          size="sm"
          type="button"
          variant={allowDangerousMode ? 'secondary' : 'outline'}
        >
          <Power /> {allowDangerousMode ? t('web.acp.osSandboxOn') : t('web.acp.osSandboxOff')}
        </Button>
        <p className="text-[11px] text-muted-foreground">{t('web.nativeCli.dangerousModeHint')}</p>
      </div>

      <Button
        className="self-start"
        disabled={busy || !name.trim() || !command.trim()}
        onClick={submit}
        size="sm"
      >
        {busy ? <Loader2 className="animate-spin" /> : title ? <Plus /> : <Save />} {submitLabel}
      </Button>
    </div>
  );
}
