'use client';

import type { WebMessageIdWithoutParams } from '@monad/i18n';
import type { AcpAgentPresetView, AcpAgentView } from '@monad/protocol';

import {
  Cancel01Icon,
  CheckIcon,
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
import { Badge, Button, cn, Input, isProductIconId, Label, ProductIcon, Switch } from '@monad/ui';
import { useId, useState } from 'react';

import { I18nTrans, useT } from '#/components/I18nProvider';
import { PanelShell, PanelShellBody } from '#/components/ui/panel-shell';
import { StudioBreadcrumbHeader } from '#/features/studio/StudioBreadcrumbHeader';
import { useAcpAgentSettings } from '#/hooks/use-acp-agent-settings';
import { useAsyncAction } from '#/hooks/use-async-action';

const envRef = (name: string) => `\${env:${name}}`;

// `args` is edited as a single space-separated line; `env` as KEY=VALUE lines. Values are `${env:NAME}`
// refs by convention, so they're shown as-is (no secret masking).
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

// A blank draft for the "+" add flow; a chosen invite preset seeds the same form with its adapter
// command/args/env so the operator just confirms instead of hand-typing the incantation.
const BLANK_AGENT: AcpAgentView = {
  name: '',
  command: '',
  args: [],
  enabled: true,
  osSandbox: false,
  forwardMcp: false
};
const presetToView = (p: AcpAgentPresetView): AcpAgentView => ({
  name: p.id,
  productIcon: p.productIcon,
  command: p.command,
  args: p.args,
  env: p.env,
  enabled: true,
  osSandbox: false,
  forwardMcp: false
});

function presetHintKey(id: string): WebMessageIdWithoutParams {
  return `web.acp.presetHint.${id}` as WebMessageIdWithoutParams;
}

export function AcpAgentsSettings({ embedded = false }: { onClose: () => void; embedded?: boolean }) {
  const t = useT();
  const { agents, presets, loading, saveAgent, removeAgent, setEnabled, refetch } = useAcpAgentSettings();
  // null = no form open; a draft (blank or preset-seeded) = the add/invite form is shown.
  const [draft, setDraft] = useState<AcpAgentView | null>(null);

  return (
    <PanelShell>
      {!embedded ? (
        <StudioBreadcrumbHeader
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
                aria-label={t('web.acp.addAgent')}
                className="size-7"
                onClick={() => setDraft(BLANK_AGENT)}
                size="icon"
                variant="ghost"
              >
                <HugeiconsIcon icon={PlusSignIcon} />
              </Button>
            </>
          }
          title={t('web.acp.title')}
        />
      ) : null}

      <p className="border-b bg-muted/30 px-5 py-2 text-muted-foreground text-xs">
        <I18nTrans
          components={{ code: <code /> }}
          i18nKey="web.acp.bootHint"
          values={{ ref: envRef('NAME') }}
        />
      </p>

      <PanelShellBody>
        <div className="flex flex-col gap-2 p-4">
          {/* One-click invite for same-machine third-party agents; badge shows local detection. */}
          {presets.length > 0 && !draft ? (
            <div className="flex flex-col gap-2 rounded-md border bg-muted/20 p-3">
              <span className="font-medium text-xs">{t('web.acp.invite')}</span>
              <div className="flex flex-wrap gap-2">
                {presets.map((p) => {
                  return (
                    <button
                      className="flex min-h-20 w-64 items-center gap-3 rounded-md border bg-card/60 p-3 text-left shadow-sm transition-colors hover:border-primary/40 hover:bg-accent/60"
                      key={p.id}
                      onClick={() => setDraft(presetToView(p))}
                      title={p.installed ? undefined : t(presetHintKey(p.id))}
                      type="button"
                    >
                      <span className="grid size-12 shrink-0 place-items-center rounded-md border bg-background shadow-xs">
                        {isProductIconId(p.productIcon) ? (
                          <ProductIcon
                            className="size-7"
                            product={p.productIcon}
                          />
                        ) : null}
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col gap-2">
                        <span className="truncate font-medium text-sm">{p.label}</span>
                        {p.installed ? (
                          <Badge
                            className="w-fit gap-1 text-[10px]"
                            variant="secondary"
                          >
                            <HugeiconsIcon
                              className="size-3"
                              icon={CheckIcon}
                            />
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
              <p className="text-muted-foreground text-xs">{t('web.acp.inviteHint')}</p>
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
              submitLabel={t('web.acp.create')}
              title={t('web.acp.addTitle')}
            />
          ) : null}

          {agents.length === 0 && !draft ? (
            <p className="px-1 py-8 text-center text-muted-foreground text-xs">{t('web.acp.empty')}</p>
          ) : null}

          {agents.map((a) => (
            <AcpAgentCard
              agent={a}
              key={a.name}
              onRemove={() => removeAgent(a.name)}
              onSave={saveAgent}
              onToggle={(enabled) => setEnabled(a, enabled)}
            />
          ))}
        </div>
      </PanelShellBody>
    </PanelShell>
  );
}

function AcpAgentCard({
  agent,
  onToggle,
  onSave,
  onRemove
}: {
  agent: AcpAgentView;
  onToggle: (enabled: boolean) => Promise<void>;
  onSave: (a: AcpAgentView) => Promise<void>;
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
          className="text-[10px]"
          variant="secondary"
        >
          {agent.command}
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
              <HugeiconsIcon icon={PowerIcon} /> {agent.enabled ? t('web.acp.enabled') : t('web.acp.disabled')}
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
                <span className="text-muted-foreground text-xs">{t('web.acp.confirmRemove')}</span>
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
                  {t('web.acp.remove')}
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
                <HugeiconsIcon icon={Delete02Icon} /> {t('web.acp.remove')}
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
  agent?: AcpAgentView;
  title?: string;
  submitLabel: string;
  nameLocked?: boolean;
  onSubmit: (a: AcpAgentView) => Promise<void>;
  onCancel?: () => void;
}) {
  const t = useT();
  const [name, setName] = useState(agent?.name ?? '');
  const [command, setCommand] = useState(agent?.command ?? '');
  const [args, setArgs] = useState(argsToStr(agent?.args));
  const [cwd, setCwd] = useState(agent?.cwd ?? '');
  const [env, setEnv] = useState(envToStr(agent?.env));
  const [osSandbox, setOsSandbox] = useState(agent?.osSandbox ?? false);
  const [forwardMcp, setForwardMcp] = useState(agent?.forwardMcp ?? false);
  const [busy, setBusy] = useState(false);
  const forwardMcpId = useId();

  const submit = async () => {
    if (!name.trim() || !command.trim()) return;
    setBusy(true);
    try {
      const envRec = strToEnv(env);
      await onSubmit({
        name: name.trim(),
        productIcon: agent?.productIcon,
        command: command.trim(),
        args: strToArgs(args),
        env: Object.keys(envRec).length ? envRec : undefined,
        cwd: cwd.trim() || undefined,
        enabled: agent?.enabled ?? true,
        osSandbox,
        forwardMcp
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
          placeholder={t('web.acp.namePlaceholder')}
          value={name}
        />
      </div>
      <div className="flex flex-col gap-1">
        <Label className="text-xs">{t('web.acp.command')}</Label>
        <Input
          onChange={(e) => setCommand(e.target.value)}
          placeholder={t('web.acp.commandPlaceholder')}
          value={command}
        />
      </div>
      <div className="flex flex-col gap-1">
        <Label className="text-xs">{t('web.acp.args')}</Label>
        <Input
          onChange={(e) => setArgs(e.target.value)}
          placeholder={t('web.acp.argsPlaceholder')}
          value={args}
        />
      </div>
      <div className="flex flex-col gap-1">
        <Label className="text-xs">{t('web.acp.workingDir')}</Label>
        <Input
          onChange={(e) => setCwd(e.target.value)}
          placeholder={t('web.acp.workingDirPlaceholder')}
          value={cwd}
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
        <Label className="text-xs">{t('web.acp.osSandbox')}</Label>
        <Button
          className="self-start"
          onClick={() => setOsSandbox((v) => !v)}
          size="sm"
          type="button"
          variant={osSandbox ? 'secondary' : 'outline'}
        >
          <HugeiconsIcon icon={PowerIcon} /> {osSandbox ? t('web.acp.osSandboxOn') : t('web.acp.osSandboxOff')}
        </Button>
        <p className="text-[11px] text-muted-foreground">{t('web.acp.osSandboxHint')}</p>
      </div>
      <div className="flex items-center justify-between gap-3 rounded-md border px-3 py-2.5">
        <div className="flex min-w-0 flex-col gap-1">
          <Label
            className="text-xs"
            htmlFor={forwardMcpId}
          >
            {t('web.acp.forwardMcp')}
          </Label>
          <p className="text-[11px] text-muted-foreground">{t('web.acp.forwardMcpHint')}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="text-muted-foreground text-xs">
            {forwardMcp ? t('web.acp.forwardMcpOn') : t('web.acp.forwardMcpOff')}
          </span>
          <Switch
            aria-label={t('web.acp.forwardMcp')}
            checked={forwardMcp}
            id={forwardMcpId}
            onCheckedChange={setForwardMcp}
          />
        </div>
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
