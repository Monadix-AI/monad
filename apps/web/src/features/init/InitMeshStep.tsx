import type { MeshAgentView } from '@monad/protocol';
import type { useT } from '#/components/I18nProvider';

import { useStartMeshAgentAuthMutation } from '@monad/client-rtk';
import { Button } from '@monad/ui';
import { useState } from 'react';

import { MeshAgentPresetPanel } from '#/features/studio/third-party-agents/MeshAgentPresetPanel';
import { connectMeshAgent } from '#/features/studio/third-party-agents/mesh-agent-connect-agent';
import { DETECTING_MESH_AGENT_PRESETS } from '#/features/studio/third-party-agents/mesh-agent-default-presets';
import { MeshAgentAuthModal } from '#/features/workplace/cli/MeshAgentAuthModal';
import { useAsyncAction } from '#/hooks/use-async-action';
import { useMeshAgentSettings } from '#/hooks/use-mesh-agent-settings';

type TFunction = ReturnType<typeof useT>;

export function InitMeshStep({ onBack, onEnter, t }: { onBack: () => void; onEnter: () => void; t: TFunction }) {
  const { agents, presets, authStates, loading, saveAgent, removeAgent } = useMeshAgentSettings();
  const [startAuth] = useStartMeshAgentAuthMutation();
  const [connectingAgentName, setConnectingAgentName] = useState<string | null>(null);
  const [authSession, setAuthSession] = useState<{
    id: string;
    controlToken: string;
    agentName: string;
    agent: MeshAgentView;
  } | null>(null);
  const { error: connectError, run: runConnect } = useAsyncAction();
  const visiblePresets = presets.length > 0 ? presets : DETECTING_MESH_AGENT_PRESETS;
  const detectingPresets = loading && presets.length === 0;
  const connectedCount = agents.length;

  const connectAgent = (agent: MeshAgentView) =>
    runConnect(async () => {
      setAuthSession(null);
      setConnectingAgentName(agent.name);
      try {
        const { session, persisted } = await connectMeshAgent(agent, {
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

  const openInstallPage = (preset: (typeof visiblePresets)[number]) => {
    window.open(preset.installUrl, '_blank', 'noopener,noreferrer');
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-lg border bg-muted/25 px-3 py-3">
        <p className="font-medium text-sm">
          {connectedCount > 0 ? t('web.init.meshConnected', { count: connectedCount }) : t('web.init.meshNotConnected')}
        </p>
        <p className="mt-1 text-muted-foreground text-xs">{t('web.init.meshSkipHint')}</p>
      </div>

      {connectError ? (
        <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-destructive text-xs">
          {connectError}
        </p>
      ) : null}

      <MeshAgentPresetPanel
        agents={agents}
        authSessionAgentName={authSession?.agentName}
        authStates={authStates}
        connectAgent={connectAgent}
        connectingAgentName={connectingAgentName}
        detecting={detectingPresets}
        openInstallPage={openInstallPage}
        presets={visiblePresets}
        removeAgent={removeAgent}
      />

      <div className="flex items-center justify-between">
        <button
          className="text-muted-foreground text-xs hover:text-foreground"
          onClick={onBack}
          type="button"
        >
          {t('web.init.back')}
        </button>
        <Button
          onClick={onEnter}
          size="sm"
        >
          {connectedCount > 0 ? t('web.init.enterMonad') : t('web.init.skipForNow')}
        </Button>
      </div>

      {authSession ? (
        <MeshAgentAuthModal
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
    </div>
  );
}
