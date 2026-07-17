import type { ExternalAgentPresetView, ExternalAgentView } from '@monad/protocol';

import { PlusSignIcon, Refresh01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useStartExternalAgentAuthMutation } from '@monad/client-rtk';
import { Button, cn, isProductIconId, ProductIcon, ScrollArea } from '@monad/ui';
import { useState } from 'react';

import { useT } from '#/components/I18nProvider';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '#/components/ui/dialog';
import { PanelShell, PanelShellBody } from '#/components/ui/panel-shell';
import { StudioBreadcrumbHeader } from '#/features/studio/StudioBreadcrumbHeader';
import { ExternalAgentAuthModal } from '#/features/workplace/cli/ExternalAgentAuthModal';
import { useAsyncAction } from '#/hooks/use-async-action';
import { useExternalAgentSettings } from '#/hooks/use-external-agent-settings';
import { isResolvedEmptyList } from '#/lib/async-list-state';
import { AgentForm } from './ExternalAgentForm';
import { ExternalAgentPresetPanel } from './ExternalAgentPresetPanel';
import { connectExternalAgent } from './external-agent-connect-agent';
import { DETECTING_EXTERNAL_AGENT_PRESETS } from './external-agent-default-presets';
import { BLANK_AGENT, presetForAgent } from './external-agent-settings-utils';

export function ExternalAgentsSettings({ embedded = false }: { onClose: () => void; embedded?: boolean }) {
  const t = useT();
  const { agents, presets, authStates, loading, saveAgent, removeAgent, setEnabled, refetch } =
    useExternalAgentSettings();
  const [draft, setDraft] = useState<ExternalAgentView | null>(null);
  const [editingAgent, setEditingAgent] = useState<ExternalAgentView | null>(null);
  const [authSession, setAuthSession] = useState<{
    id: string;
    controlToken: string;
    agentName: string;
    agent: ExternalAgentView;
  } | null>(null);
  const [connectingAgentName, setConnectingAgentName] = useState<string | null>(null);
  const [startAuth] = useStartExternalAgentAuthMutation();
  const { error: connectError, run: runConnect } = useAsyncAction();

  const connectAgent = (agent: ExternalAgentView) =>
    runConnect(async () => {
      setAuthSession(null);
      setConnectingAgentName(agent.name);
      try {
        const { session, persisted } = await connectExternalAgent(agent, {
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
  const openInstallPage = (preset: ExternalAgentPresetView) => {
    window.open(preset.installUrl, '_blank', 'noopener,noreferrer');
  };
  const visiblePresets = presets.length > 0 ? presets : DETECTING_EXTERNAL_AGENT_PRESETS;
  const detectingPresets = loading && presets.length === 0;

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
                aria-label={t('web.externalAgent.addAgent')}
                className="size-7"
                onClick={() => setDraft(BLANK_AGENT)}
                size="icon"
                variant="ghost"
              >
                <HugeiconsIcon icon={PlusSignIcon} />
              </Button>
            </>
          }
          title={t('web.externalAgent.title')}
        />
      ) : null}
      <PanelShellBody>
        <div className="flex flex-col gap-2 p-4">
          {connectError ? (
            <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-destructive text-xs">
              {connectError}
            </p>
          ) : null}

          {visiblePresets.length > 0 && !draft ? (
            <ExternalAgentPresetPanel
              agents={agents}
              authSessionAgentName={authSession?.agentName}
              authStates={authStates}
              connectAgent={connectAgent}
              connectingAgentName={connectingAgentName}
              detecting={detectingPresets}
              openInstallPage={openInstallPage}
              presets={visiblePresets}
              removeAgent={removeAgent}
              setEditingAgent={setEditingAgent}
            />
          ) : null}

          {draft ? (
            <AgentForm
              agent={draft}
              key={draft.name || 'blank'}
              mode="create"
              onCancel={() => setDraft(null)}
              onSubmit={async (a) => {
                await saveAgent(a);
                setDraft(null);
              }}
              submitLabel={t('web.externalAgent.create')}
              title={t('web.externalAgent.addTitle')}
            />
          ) : null}

          {isResolvedEmptyList({ isLoading: loading, itemCount: agents.length }) && !draft ? (
            <p className="px-1 py-8 text-center text-muted-foreground text-xs">{t('web.externalAgent.empty')}</p>
          ) : null}

          {agents.map((a) => (
            <ExternalAgentCard
              agent={a}
              key={a.name}
              onRemove={() => removeAgent(a.name)}
              onSave={saveAgent}
              onToggle={(enabled) => setEnabled(a, enabled)}
            />
          ))}
        </div>
      </PanelShellBody>
      {authSession ? (
        <ExternalAgentAuthModal
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
            <ExternalAgentSettingsDialogBody
              agent={editingAgent}
              onSave={async (agent) => {
                await saveAgent(agent);
                setEditingAgent(null);
              }}
              preset={presetForAgent(editingAgent, presets)}
              submitLabel={t('web.save')}
              variant="framed"
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </PanelShell>
  );
}
function ExternalAgentSettingsDialogBody({
  agent,
  preset,
  submitLabel,
  variant = 'base',
  onSave
}: {
  agent: ExternalAgentView;
  preset?: ExternalAgentPresetView;
  submitLabel: string;
  variant?: 'base' | 'framed' | 'compact' | 'quiet';
  onSave: (agent: ExternalAgentView) => Promise<void>;
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
            <DialogDescription className="mt-1 text-xs">{t('web.externalAgent.configureProvider')}</DialogDescription>
          </span>
        </div>
      </DialogHeader>
      <ScrollArea className={bodyClass}>
        <div className={formWrapClass}>
          <AgentForm
            agent={agent}
            mode="settings"
            onSubmit={onSave}
            preset={preset}
            submitLabel={submitLabel}
          />
        </div>
      </ScrollArea>
    </div>
  );
}

function ExternalAgentCard(_props: {
  agent: ExternalAgentView;
  onToggle: (enabled: boolean) => Promise<void>;
  onSave: (a: ExternalAgentView) => Promise<void>;
  onRemove: () => Promise<void>;
}): null {
  return null;
}
