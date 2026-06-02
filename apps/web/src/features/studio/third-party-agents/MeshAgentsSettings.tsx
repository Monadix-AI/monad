import type { MeshAgentPresetView, MeshAgentView } from '@monad/protocol';

import { useStartMeshAgentAuthMutation } from '@monad/client-rtk';
import { cn } from '@monad/ui';
import { useState } from 'react';

import { BrandIcon } from '#/components/BrandIcon';
import { useT } from '#/components/I18nProvider';
import { RefreshButton } from '#/components/RefreshButton';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '#/components/ui/dialog';
import { PanelShell, PanelShellBody } from '#/components/ui/panel-shell';
import { StudioBreadcrumbHeader } from '#/features/studio/StudioBreadcrumbHeader';
import { MeshAgentAuthModal } from '#/features/workplace/cli/MeshAgentAuthModal';
import { useAsyncAction } from '#/hooks/use-async-action';
import { useMeshAgentSettings } from '#/hooks/use-mesh-agent-settings';
import { isResolvedEmptyList } from '#/lib/async-list-state';
import { AgentForm } from './MeshAgentForm';
import { MeshAgentPresetPanel } from './MeshAgentPresetPanel';
import { connectMeshAgent } from './mesh-agent-connect-agent';
import { DETECTING_MESH_AGENT_PRESETS } from './mesh-agent-default-presets';
import { presetForAgent } from './mesh-agent-settings-utils';
import { studioVisibleMeshAgentPresets, studioVisibleMeshAgents } from './mesh-agent-studio-visibility';

export function MeshAgentsSettings({ embedded = false }: { onClose: () => void; embedded?: boolean }) {
  const t = useT();
  const {
    agents,
    presets,
    authStates,
    checkingAuth,
    loading,
    refreshing,
    saveAgent,
    removeAgent,
    setEnabled,
    refetch
  } = useMeshAgentSettings();
  const [editingAgent, setEditingAgent] = useState<MeshAgentView | null>(null);
  const [authSession, setAuthSession] = useState<{
    id: string;
    controlToken: string;
    agentName: string;
    agent: MeshAgentView;
    temporary: boolean;
  } | null>(null);
  const [connectingAgentName, setConnectingAgentName] = useState<string | null>(null);
  const [startAuth] = useStartMeshAgentAuthMutation();
  const { error: connectError, run: runConnect } = useAsyncAction();
  const studioAgents = studioVisibleMeshAgents(agents);
  const studioPresets = studioVisibleMeshAgentPresets(presets);

  const connectAgent = (agent: MeshAgentView) =>
    runConnect(async () => {
      setAuthSession(null);
      setConnectingAgentName(agent.name);
      const temporary = !studioAgents.some((entry) => entry.name === agent.name);
      try {
        const { session, persisted } = await connectMeshAgent(agent, {
          saveAgent,
          removeAgent,
          startAuth: (agentName) => startAuth(agentName).unwrap()
        });
        if (!persisted) {
          setAuthSession({
            id: session.id,
            controlToken: session.controlToken,
            agentName: agent.name,
            agent,
            temporary
          });
        }
      } finally {
        setConnectingAgentName(null);
      }
    });
  const closeAuthSession = () => {
    const session = authSession;
    setAuthSession(null);
    if (session?.temporary) void removeAgent(session.agentName);
  };
  const openInstallPage = (preset: MeshAgentPresetView) => {
    window.open(preset.installUrl, '_blank', 'noopener,noreferrer');
  };
  const visiblePresets = studioPresets.length > 0 ? studioPresets : DETECTING_MESH_AGENT_PRESETS;
  const detectingPresets = loading && studioPresets.length === 0;

  return (
    <PanelShell>
      {!embedded ? (
        <StudioBreadcrumbHeader
          actions={
            <RefreshButton
              className="size-7"
              iconOnly
              label={t('web.refresh')}
              loading={refreshing}
              onClick={refetch}
              size="icon"
              variant="ghost"
            />
          }
          title={t('web.meshAgent.title')}
        />
      ) : null}
      <PanelShellBody>
        <div className="flex flex-col gap-2 p-4">
          {connectError ? (
            <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-destructive text-xs">
              {connectError}
            </p>
          ) : null}

          {visiblePresets.length > 0 ? (
            <MeshAgentPresetPanel
              agents={studioAgents}
              authSessionAgentName={authSession?.agentName}
              authStates={authStates}
              checkingAuth={checkingAuth}
              connectAgent={connectAgent}
              connectingAgentName={connectingAgentName}
              detecting={detectingPresets}
              openInstallPage={openInstallPage}
              presets={visiblePresets}
              removeAgent={removeAgent}
              setEditingAgent={setEditingAgent}
            />
          ) : null}

          {isResolvedEmptyList({ isLoading: loading, itemCount: studioAgents.length }) ? (
            <p className="px-1 py-8 text-center text-muted-foreground text-xs">{t('web.meshAgent.empty')}</p>
          ) : null}

          {studioAgents.map((a) => (
            <MeshAgentCard
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
        <MeshAgentAuthModal
          agentName={authSession.agentName}
          controlToken={authSession.controlToken}
          onAuthenticated={async () => {
            await saveAgent(authSession.agent);
            setAuthSession(null);
          }}
          onClose={closeAuthSession}
          sessionId={authSession.id}
        />
      ) : null}
      <Dialog
        onOpenChange={(open) => {
          if (!open) setEditingAgent(null);
        }}
        open={!!editingAgent}
      >
        <DialogContent className="max-h-[min(42rem,calc(100dvh-2rem))] sm:max-w-2xl">
          {editingAgent ? (
            <MeshAgentSettingsDialogBody
              agent={editingAgent}
              onClose={() => setEditingAgent(null)}
              onSave={async (agent) => {
                await saveAgent(agent);
                setEditingAgent(null);
              }}
              preset={presetForAgent(editingAgent, studioPresets)}
              submitLabel={t('web.save')}
              variant="framed"
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </PanelShell>
  );
}
function MeshAgentSettingsDialogBody({
  agent,
  preset,
  submitLabel,
  variant = 'base',
  formLayout = 'default',
  onClose,
  onSave
}: {
  agent: MeshAgentView;
  preset?: MeshAgentPresetView;
  submitLabel: string;
  variant?: 'base' | 'framed' | 'compact' | 'quiet';
  formLayout?: 'default' | 'quiet';
  onClose: () => void;
  onSave: (agent: MeshAgentView) => Promise<void>;
}) {
  const t = useT();
  const headerClass = cn(variant === 'compact' && 'py-3');
  const iconClass = cn(
    'flex shrink-0 items-center justify-center rounded-md border bg-background',
    variant === 'compact' ? 'size-8' : 'size-10',
    variant === 'framed' && 'border-success/35 bg-success/10'
  );
  return (
    <>
      <DialogHeader className={headerClass}>
        <div className="flex min-w-0 items-center gap-3">
          <span className={iconClass}>
            {preset?.icon ? (
              <BrandIcon
                className={variant === 'compact' ? 'size-5' : 'size-6'}
                icon={preset.icon}
              />
            ) : null}
          </span>
          <span className="min-w-0">
            <DialogTitle className={cn('truncate', variant === 'compact' ? 'text-sm' : 'text-base')}>
              {agent.displayName ?? preset?.label ?? agent.name}
            </DialogTitle>
            <DialogDescription className="mt-1 text-xs">
              {t(agent.provider === 'monad' ? 'web.meshAgent.configureMonad' : 'web.meshAgent.configureProvider')}
            </DialogDescription>
          </span>
        </div>
      </DialogHeader>
      <AgentForm
        agent={agent}
        appearance={formLayout}
        layout="dialog"
        mode="settings"
        onCancel={onClose}
        onSubmit={onSave}
        preset={preset}
        submitLabel={submitLabel}
      />
    </>
  );
}

function MeshAgentCard(_props: {
  agent: MeshAgentView;
  onToggle: (enabled: boolean) => Promise<void>;
  onSave: (a: MeshAgentView) => Promise<void>;
  onRemove: () => Promise<void>;
}): null {
  return null;
}
