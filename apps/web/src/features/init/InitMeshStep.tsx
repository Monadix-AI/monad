import type { MeshAgentView, ProjectId } from '@monad/protocol';
import type { useT } from '#/components/I18nProvider';

import {
  useCreateWorkplaceProjectMutation,
  useStartMeshAgentAuthMutation,
  useUpdateWorkplaceProjectMutation
} from '@monad/client-rtk';
import {
  defaultWorkplaceProjectMemberSettings,
  meshAgentProductDisplayName,
  newMeshAgentInstanceId
} from '@monad/protocol';
import { Button, cn, Input, Label } from '@monad/ui';
import { useEffect, useState } from 'react';

import { projectPath } from '#/features/shell/routing/paths';
import { MeshAgentPresetPanel } from '#/features/studio/third-party-agents/MeshAgentPresetPanel';
import { connectMeshAgent } from '#/features/studio/third-party-agents/mesh-agent-connect-agent';
import { DETECTING_MESH_AGENT_PRESETS } from '#/features/studio/third-party-agents/mesh-agent-default-presets';
import { MeshAgentAuthModal } from '#/features/workplace/cli/MeshAgentAuthModal';
import { useAsyncAction } from '#/hooks/use-async-action';
import { useMeshAgentSettings } from '#/hooks/use-mesh-agent-settings';

type TFunction = ReturnType<typeof useT>;

export function InitMeshStep({
  onBack,
  onEnter,
  onStepChange,
  step,
  t
}: {
  onBack: () => void;
  onEnter: () => void;
  onStepChange: (step: 'cli' | 'project') => void;
  step: 'cli' | 'project';
  t: TFunction;
}) {
  const { agents, presets, authStates, checkingAuth, loading, saveAgent, removeAgent } = useMeshAgentSettings();
  const [startAuth] = useStartMeshAgentAuthMutation();
  const [createProject] = useCreateWorkplaceProjectMutation();
  const [updateProject] = useUpdateWorkplaceProjectMutation();
  const [connectingAgentName, setConnectingAgentName] = useState<string | null>(null);
  const [selectedAgentName, setSelectedAgentName] = useState('');
  const [projectName, setProjectName] = useState('');
  const [createdProjectId, setCreatedProjectId] = useState<ProjectId | null>(null);
  const [creatingProject, setCreatingProject] = useState(false);
  const [projectError, setProjectError] = useState('');
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

  useEffect(() => {
    if (agents.some((agent) => agent.name === selectedAgentName)) return;
    setSelectedAgentName(agents[0]?.name ?? '');
  }, [agents, selectedAgentName]);

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
        } else {
          setSelectedAgentName(agent.name);
        }
      } finally {
        setConnectingAgentName(null);
      }
    });

  const openInstallPage = (preset: (typeof visiblePresets)[number]) => {
    window.open(preset.installUrl, '_blank', 'noopener,noreferrer');
  };

  const createFirstProject = async () => {
    const agent = agents.find((entry) => entry.name === selectedAgentName);
    if (!agent || !projectName.trim()) return;
    setCreatingProject(true);
    setProjectError('');
    try {
      const projectId =
        createdProjectId ?? (await createProject({ title: projectName.trim(), origin: { surface: 'web' } }).unwrap());
      if (!createdProjectId) setCreatedProjectId(projectId);
      const displayName =
        agent.displayName ?? meshAgentProductDisplayName(agent.productIcon, agent.provider, agent.name);
      await updateProject({
        id: projectId,
        title: projectName.trim(),
        memberTemplates: [
          {
            id: newMeshAgentInstanceId(agent.name),
            type: 'mesh-agent',
            name: agent.name,
            displayName,
            settings: defaultWorkplaceProjectMemberSettings('mesh-agent', agent)
          }
        ]
      }).unwrap();
      window.location.assign(projectPath(projectId));
    } catch (error) {
      setProjectError(error instanceof Error ? error.message : t('web.init.meshProjectError'));
    } finally {
      setCreatingProject(false);
    }
  };

  if (step === 'project') {
    return (
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="init-project-name">{t('web.workplace.projectNameLabel')}</Label>
          <Input
            autoFocus
            id="init-project-name"
            onChange={(event) => setProjectName(event.target.value)}
            placeholder={t('web.workplace.projectNamePlaceholder')}
            value={projectName}
          />
        </div>

        <div className="flex flex-col gap-2">
          <Label>{t('web.init.meshProjectCliLabel')}</Label>
          <div className="grid gap-2 sm:grid-cols-2">
            {agents.map((agent) => (
              <button
                className={cn(
                  'rounded-md border px-3 py-2 text-left text-sm transition-colors',
                  selectedAgentName === agent.name
                    ? 'border-foreground/40 bg-accent text-foreground'
                    : 'border-border bg-background text-muted-foreground hover:bg-accent/60'
                )}
                key={agent.name}
                onClick={() => setSelectedAgentName(agent.name)}
                type="button"
              >
                {agent.displayName ?? meshAgentProductDisplayName(agent.productIcon, agent.provider, agent.name)}
              </button>
            ))}
          </div>
          <p className="text-muted-foreground text-xs">{t('web.init.meshProjectCliHint')}</p>
        </div>

        {projectError ? (
          <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-destructive text-xs">
            {projectError}
          </p>
        ) : null}

        <div className="flex items-center justify-between">
          <button
            className="text-muted-foreground text-xs hover:text-foreground"
            onClick={() => onStepChange('cli')}
            type="button"
          >
            {t('web.init.back')}
          </button>
          <Button
            disabled={creatingProject || !projectName.trim() || !selectedAgentName}
            onClick={() => void createFirstProject()}
            size="sm"
          >
            {creatingProject ? t('web.init.creating') : t('web.workplace.createProject')}
          </Button>
        </div>
      </div>
    );
  }

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
        checkingAuth={checkingAuth}
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
          onClick={() => (connectedCount > 0 ? onStepChange('project') : onEnter())}
          size="sm"
        >
          {connectedCount > 0 ? t('web.init.continueArrow') : t('web.init.skipForNow')}
        </Button>
      </div>

      {authSession ? (
        <MeshAgentAuthModal
          agentName={authSession.agentName}
          controlToken={authSession.controlToken}
          onAuthenticated={async () => {
            await saveAgent(authSession.agent);
            setSelectedAgentName(authSession.agent.name);
            setAuthSession(null);
          }}
          onClose={() => setAuthSession(null)}
          sessionId={authSession.id}
        />
      ) : null}
    </div>
  );
}
