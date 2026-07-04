'use client';

import type { WebMessageIdWithoutParams } from '@monad/i18n';
import type { NativeCliAgentPresetView, NativeCliAgentView, NativeCliProvider } from '@monad/protocol';

import {
  Cancel01Icon,
  CircleCheckIcon,
  ExternalLinkIcon,
  LoaderPinwheelIcon,
  Plug01Icon,
  PlusSignIcon,
  Refresh01Icon,
  SaveIcon,
  Search01Icon,
  Settings02Icon,
  ShieldQuestionMarkIcon
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useStartNativeCliAuthMutation } from '@monad/client-rtk';
import { Button, cn, Input, isProductIconId, Label, ProductIcon, ScrollArea } from '@monad/ui';
import { useState } from 'react';

import { useT } from '@/components/I18nProvider';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { PanelShell, PanelShellHeader } from '@/components/ui/panel-shell';
import { NativeCliAuthModal } from '@/features/workplace/cli/NativeCliAuthModal';
import { useAsyncAction } from '@/hooks/use-async-action';
import { useNativeCliAgentSettings } from '@/hooks/use-native-cli-agent-settings';
import { connectNativeCliAgent } from './native-cli-connect-agent';

const argsToStr = (args?: string[]): string => (args ?? []).join(' ');
const strToArgs = (s: string): string[] => s.split(/\s+/).filter(Boolean);
const modelOptionsToStr = (modelOptions?: string[]): string => (modelOptions ?? []).join('\n');
const strToModelOptions = (s: string): string[] =>
  s
    .split(/\r?\n|,/)
    .map((part) => part.trim())
    .filter(Boolean);
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
  modelOptions: [],
  enabled: true,
  defaultLaunchMode: 'pty',
  allowDangerousMode: false,
  approvalOwnership: 'provider-owned'
};

const presetToView = (p: NativeCliAgentPresetView): NativeCliAgentView => ({
  name: p.id,
  provider: p.provider,
  productIcon: p.productIcon,
  command: p.command,
  args: p.args,
  modelOptions: p.modelOptions,
  enabled: true,
  defaultLaunchMode: p.defaultLaunchMode,
  allowDangerousMode: false,
  approvalOwnership: 'provider-owned'
});

function presetHintKey(id: string): WebMessageIdWithoutParams {
  return `web.nativeCli.presetHint.${id}` as WebMessageIdWithoutParams;
}

export function NativeCliAgentsSettings({ embedded = false }: { onClose: () => void; embedded?: boolean }) {
  const t = useT();
  const { agents, presets, loading, saveAgent, removeAgent, setEnabled, refetch } = useNativeCliAgentSettings();
  const [draft, setDraft] = useState<NativeCliAgentView | null>(null);
  const [editingAgent, setEditingAgent] = useState<NativeCliAgentView | null>(null);
  const [authSession, setAuthSession] = useState<{
    id: string;
    controlToken: string;
    agentName: string;
    agent: NativeCliAgentView;
  } | null>(null);
  const [connectingAgentName, setConnectingAgentName] = useState<string | null>(null);
  const [startAuth] = useStartNativeCliAuthMutation();
  const { busy: connectBusy, error: connectError, run: runConnect } = useAsyncAction();

  const connectAgent = (agent: NativeCliAgentView) =>
    runConnect(async () => {
      setAuthSession(null);
      setConnectingAgentName(agent.name);
      try {
        const { session, persisted } = await connectNativeCliAgent(agent, {
          saveAgent,
          removeAgent,
          startAuth: (agentName) => startAuth(agentName).unwrap()
        });
        if (!persisted) {
          setAuthSession({ id: session.id, controlToken: session.controlToken, agentName: agent.name, agent });
        }
      } finally {
        setConnectingAgentName(null);
      }
    });
  const openInstallPage = (preset: NativeCliAgentPresetView) => {
    window.open(preset.installUrl, '_blank', 'noopener,noreferrer');
  };

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
                aria-label={t('web.nativeCli.addAgent')}
                className="size-7"
                onClick={() => setDraft(BLANK_AGENT)}
                size="icon"
                variant="ghost"
              >
                <HugeiconsIcon icon={PlusSignIcon} />
              </Button>
            </>
          }
          subtitle={t('web.nativeCli.subtitle')}
          title={t('web.nativeCli.title')}
        />
      ) : null}
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

                .native-cli-live-v2__actions {
                  display: flex;
                  align-items: center;
                  gap: 6px;
                }

                .native-cli-live-v2__row--connected {
                  background: var(--card);
                }

                .native-cli-live-v2__row--connected .native-cli-live-v2__logo {
                  border-color: color-mix(in srgb, var(--success) 28%, var(--border));
                  box-shadow: 0 0 0 5px color-mix(in srgb, var(--success) 12%, transparent);
                }

                .native-cli-live-v2__status {
                  display: inline-flex;
                  align-items: center;
                  gap: 5px;
                  border-radius: 999px;
                  padding: 3px 8px;
                  font-size: 12px;
                  font-weight: 650;
                }

                .native-cli-live-v2__status--connected {
                  background: color-mix(in srgb, var(--success) 12%, transparent);
                  color: color-mix(in srgb, var(--success) 55%, var(--foreground));
                }

                .native-cli-live-v2__status--detected {
                  background: color-mix(in srgb, var(--info) 13%, transparent);
                  color: color-mix(in srgb, var(--info) 65%, var(--foreground));
                }

                .native-cli-live-v2__status--missing {
                  background: color-mix(in srgb, var(--warning) 12%, transparent);
                  color: color-mix(in srgb, var(--warning) 68%, var(--foreground));
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
                  const agent = presetToView(p);
                  const connectedAgent = agents.find((entry) => entry.name === agent.name);
                  const checkingAuth = connectingAgentName === agent.name || authSession?.agentName === agent.name;
                  const status = checkingAuth
                    ? 'checking'
                    : connectedAgent
                      ? 'connected'
                      : p.installed
                        ? 'detected'
                        : 'missing';
                  return (
                    <div
                      className={cn(
                        'native-cli-live-v2__row',
                        status === 'connected' && 'native-cli-live-v2__row--connected'
                      )}
                      key={p.id}
                      title={status === 'missing' ? t(presetHintKey(p.id)) : undefined}
                    >
                      <span className="native-cli-live-v2__logo">
                        {isProductIconId(p.productIcon) ? (
                          <ProductIcon
                            className="size-6"
                            product={p.productIcon}
                          />
                        ) : null}
                      </span>
                      <span className="native-cli-live-v2__main">
                        <span className="native-cli-live-v2__name">{p.label}</span>
                      </span>
                      <span className="native-cli-live-v2__actions">
                        {status === 'checking' ? (
                          <span className="native-cli-live-v2__status native-cli-live-v2__status--detected">
                            <HugeiconsIcon
                              className="size-3.5 animate-spin"
                              icon={LoaderPinwheelIcon}
                            />
                            {t('web.nativeCli.checkingAuth')}
                          </span>
                        ) : status === 'connected' && connectedAgent ? (
                          <>
                            <span className="native-cli-live-v2__status native-cli-live-v2__status--connected">
                              <HugeiconsIcon
                                className="size-3.5"
                                icon={CircleCheckIcon}
                              />
                              {t('web.nativeCli.connected')}
                            </span>
                            <Button
                              aria-label={`Settings for ${connectedAgent.name}`}
                              className="border-transparent"
                              onClick={() => setEditingAgent(connectedAgent)}
                              size="sm"
                              type="button"
                              variant="ghost"
                            >
                              <HugeiconsIcon icon={Settings02Icon} />
                              {t('web.settings.title')}
                            </Button>
                            <Button
                              className="border-transparent"
                              disabled={connectBusy}
                              onClick={() => removeAgent(connectedAgent.name)}
                              size="sm"
                              type="button"
                              variant="ghost"
                            >
                              <HugeiconsIcon icon={Plug01Icon} />
                              {t('web.nativeCli.disconnect')}
                            </Button>
                          </>
                        ) : status === 'detected' ? (
                          <>
                            <span className="native-cli-live-v2__status native-cli-live-v2__status--detected">
                              <HugeiconsIcon
                                className="size-3.5"
                                icon={Search01Icon}
                              />
                              {t('web.nativeCli.detected')}
                            </span>
                            <Button
                              className="border-transparent"
                              disabled={connectBusy}
                              onClick={() => connectAgent(agent)}
                              size="sm"
                              type="button"
                              variant="ghost"
                            >
                              {connectBusy ? (
                                <HugeiconsIcon
                                  className="animate-spin"
                                  icon={LoaderPinwheelIcon}
                                />
                              ) : (
                                <HugeiconsIcon icon={Plug01Icon} />
                              )}
                              {t('web.nativeCli.connect')}
                            </Button>
                          </>
                        ) : (
                          <>
                            <span className="native-cli-live-v2__status native-cli-live-v2__status--missing">
                              <HugeiconsIcon
                                className="size-3.5"
                                icon={Search01Icon}
                              />
                              {t('web.nativeCli.notDetected')}
                            </span>
                            <Button
                              className="border-transparent"
                              onClick={() => openInstallPage(p)}
                              size="sm"
                              type="button"
                              variant="ghost"
                            >
                              <HugeiconsIcon icon={ExternalLinkIcon} />
                              {t('web.nativeCli.install')}
                            </Button>
                          </>
                        )}
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
        <NativeCliAuthModal
          agentName={authSession.agentName}
          controlToken={authSession.controlToken}
          onAuthenticated={async () => {
            await saveAgent(authSession.agent);
            setAuthSession(null);
          }}
          onClose={() => setAuthSession(null)}
          sessionId={authSession.id}
        />
      ) : null}
      <Dialog
        onOpenChange={(open) => {
          if (!open) setEditingAgent(null);
        }}
        open={!!editingAgent}
      >
        <DialogContent className="max-h-[min(42rem,calc(100vh-2rem))] overflow-hidden p-0 sm:max-w-2xl">
          {editingAgent ? (
            <NativeCliSettingsDialogBody
              agent={editingAgent}
              onSave={async (agent) => {
                await saveAgent(agent);
                setEditingAgent(null);
              }}
              submitLabel={t('web.save')}
              variant="framed"
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </PanelShell>
  );
}

function NativeCliSettingsDialogBody({
  agent,
  submitLabel,
  variant = 'base',
  onSave
}: {
  agent: NativeCliAgentView;
  submitLabel: string;
  variant?: 'base' | 'framed' | 'compact' | 'quiet';
  onSave: (agent: NativeCliAgentView) => Promise<void>;
}) {
  const t = useT();
  const headerClass = cn(
    'border-b px-5 pr-12',
    variant === 'compact' ? 'py-3' : 'py-4',
    variant === 'framed' ? 'bg-card/80' : variant === 'quiet' ? 'bg-background' : 'bg-muted/20'
  );
  const iconClass = cn(
    'flex shrink-0 items-center justify-center rounded-md border bg-background',
    variant === 'compact' ? 'size-8' : 'size-10',
    variant === 'framed' &&
      'border-success/35 bg-success/10 shadow-[0_0_0_5px_color-mix(in_srgb,var(--success)_10%,transparent)]'
  );
  const bodyClass = cn('min-h-0 flex-1', variant === 'framed' && 'bg-muted/10', variant === 'quiet' && 'bg-background');
  const formWrapClass = cn(
    variant === 'compact' ? 'p-4' : 'p-5',
    variant === 'framed' && 'm-4 rounded-md border bg-card/70 p-4',
    variant === 'quiet' && 'px-5 py-4'
  );

  return (
    <div className="flex max-h-[inherit] flex-col">
      <DialogHeader className={headerClass}>
        <div className="flex min-w-0 items-center gap-3">
          <span className={iconClass}>
            {isProductIconId(agent.productIcon) ? (
              <ProductIcon
                className={variant === 'compact' ? 'size-5' : 'size-6'}
                product={agent.productIcon}
              />
            ) : null}
          </span>
          <span className="min-w-0">
            <DialogTitle className={cn('truncate', variant === 'compact' ? 'text-sm' : 'text-base')}>
              {agent.name}
            </DialogTitle>
            <DialogDescription className="mt-1 text-xs">{t('web.nativeCli.configureProvider')}</DialogDescription>
          </span>
        </div>
      </DialogHeader>
      <ScrollArea className={bodyClass}>
        <div className={formWrapClass}>
          <AgentForm
            agent={agent}
            nameLocked
            onSubmit={onSave}
            submitLabel={submitLabel}
          />
        </div>
      </ScrollArea>
    </div>
  );
}

function NativeCliAgentCard(_props: {
  agent: NativeCliAgentView;
  onToggle: (enabled: boolean) => Promise<void>;
  onSave: (a: NativeCliAgentView) => Promise<void>;
  onRemove: () => Promise<void>;
}): null {
  return null;
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
  const [modelOptions, setModelOptions] = useState(modelOptionsToStr(agent?.modelOptions));
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
        productIcon: agent?.productIcon,
        command: command.trim(),
        args: strToArgs(args),
        modelOptions: strToModelOptions(modelOptions),
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
              <HugeiconsIcon icon={Cancel01Icon} />
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
          <option value="qwen">Qwen Code</option>
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
        <Label className="text-xs">{t('web.nativeCli.modelOptions')}</Label>
        <textarea
          className="min-h-16 rounded-md border bg-transparent px-2 py-1 font-mono text-xs"
          onChange={(e) => setModelOptions(e.target.value)}
          placeholder={t('web.nativeCli.modelOptionsPlaceholder')}
          value={modelOptions}
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
          <HugeiconsIcon icon={ShieldQuestionMarkIcon} />{' '}
          {allowDangerousMode ? t('web.acp.osSandboxOn') : t('web.acp.osSandboxOff')}
        </Button>
        <p className="text-[11px] text-muted-foreground">{t('web.nativeCli.dangerousModeHint')}</p>
      </div>

      <Button
        className="self-start"
        disabled={busy || !name.trim() || !command.trim()}
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
