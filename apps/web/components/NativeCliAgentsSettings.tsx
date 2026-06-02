'use client';

import type { WebMessageIdWithoutParams } from '@monad/i18n';
import type { NativeCliAgentPresetView, NativeCliAgentView, NativeCliProvider } from '@monad/protocol';

import { Badge, Button, cn, Input, Label, ScrollArea } from '@monad/ui';
import { Check, ChevronDown, ChevronRight, Loader2, Plus, Power, RefreshCw, Save, Trash2, X } from 'lucide-react';
import { useState } from 'react';

import { useT } from '@/components/I18nProvider';
import { providerLogo } from '@/lib/ProviderMeta';
import { useAsyncAction } from '../hooks/use-async-action';
import { useNativeCliAgentSettings } from '../hooks/use-native-cli-agent-settings';
import { StudioPanel, StudioPanelHeader } from './studio/StudioPanel';

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

function presetLogo(id: string) {
  return providerLogo(id === 'claude-code' ? 'anthropic' : 'openai').logo;
}

function presetHintKey(id: string): WebMessageIdWithoutParams {
  return `web.nativeCli.presetHint.${id}` as WebMessageIdWithoutParams;
}

export function NativeCliAgentsSettings(_props: { onClose: () => void }) {
  const t = useT();
  const { agents, presets, loading, saveAgent, removeAgent, setEnabled, refetch } = useNativeCliAgentSettings();
  const [draft, setDraft] = useState<NativeCliAgentView | null>(null);

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
          {presets.length > 0 && !draft ? (
            <div className="flex flex-col gap-2 rounded-md border bg-muted/20 p-3">
              <span className="font-medium text-xs">{t('web.nativeCli.invite')}</span>
              <div className="flex flex-wrap gap-2">
                {presets.map((p) => {
                  const ProductLogo = presetLogo(p.id);
                  return (
                    <button
                      className="flex min-h-20 w-64 items-center gap-3 rounded-md border bg-card/60 p-3 text-left shadow-sm transition-colors hover:border-primary/40 hover:bg-accent/60"
                      key={p.id}
                      onClick={() => setDraft(presetToView(p))}
                      title={p.installed ? undefined : t(presetHintKey(p.id))}
                      type="button"
                    >
                      <span className="grid size-12 shrink-0 place-items-center rounded-md border bg-background shadow-xs">
                        <ProductLogo className="size-7" />
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col gap-2">
                        <span className="truncate font-medium text-sm">{p.label}</span>
                        {p.installed ? (
                          <Badge
                            className="w-fit gap-1 text-[10px]"
                            variant="secondary"
                          >
                            <Check className="size-3" />
                            {t('web.acp.installed')}
                          </Badge>
                        ) : (
                          <Badge
                            className="w-fit text-[10px]"
                            variant="outline"
                          >
                            {t('web.acp.notInstalled')}
                          </Badge>
                        )}
                      </span>
                    </button>
                  );
                })}
              </div>
              <p className="text-muted-foreground text-xs">{t('web.nativeCli.inviteHint')}</p>
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
    </StudioPanel>
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
