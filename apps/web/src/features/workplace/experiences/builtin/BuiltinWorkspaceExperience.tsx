import type { ProjectExperienceView } from '../types';

import { renderBuiltinWorkspaceExperience } from '@monad/atoms/workspace-experiences';
import {
  type WorkspaceExperienceHost,
  type WorkspaceExperienceHostAction,
  WorkspaceExperienceHostProvider
} from '@monad/atoms/workspace-experiences/host-context';
import { useStartMeshAgentAuthMutation } from '@monad/client-rtk';
import { useCallback, useMemo, useState } from 'react';

import { studioPath } from '#/features/shell/routing/paths';
import { MeshAgentAuthModal } from '#/features/workplace/cli/MeshAgentAuthModal';
import { pushShellUrl } from '#/hooks/use-shell-location';

export function BuiltinWorkspaceExperienceHost({
  component,
  view
}: {
  component: string;
  view: ProjectExperienceView;
}): React.ReactElement {
  const [startMeshAgentAuth] = useStartMeshAgentAuthMutation();
  const [authSession, setAuthSession] = useState<{ agentName: string; controlToken: string; id: string } | null>(null);
  const startSignIn = useCallback(
    (payload: unknown) => {
      if (!payload || typeof payload !== 'object' || !('agentName' in payload) || typeof payload.agentName !== 'string')
        return;
      const { agentName } = payload;
      void startMeshAgentAuth(agentName)
        .unwrap()
        .then((session) => setAuthSession({ agentName, controlToken: session.controlToken, id: session.id }))
        .catch(() => {});
    },
    [startMeshAgentAuth]
  );
  const actions = useMemo<WorkspaceExperienceHostAction[]>(
    () => [
      {
        id: 'mesh-agent.sign-in',
        label: 'Sign in',
        run: startSignIn
      }
    ],
    [startSignIn]
  );
  const host = useMemo<WorkspaceExperienceHost>(
    () => ({
      voiceModelState: view.voiceModelState,
      actions,
      openStudio: (section = 'models') => pushShellUrl(studioPath(section)),
      requestProjectDialog: view.onProjectDialogRequest ?? (() => {})
    }),
    [view.voiceModelState, actions, view.onProjectDialogRequest]
  );
  const rendered = renderBuiltinWorkspaceExperience({ component, view: { runtime: view.runtime } });
  if (!rendered) {
    return <div className="workspace-experience-error">Unknown built-in workspace experience: {component}</div>;
  }
  return (
    <WorkspaceExperienceHostProvider value={host}>
      {rendered}
      {authSession ? (
        <MeshAgentAuthModal
          agentName={authSession.agentName}
          controlToken={authSession.controlToken}
          onAuthenticated={() => setAuthSession(null)}
          onClose={() => setAuthSession(null)}
          sessionId={authSession.id}
        />
      ) : null}
    </WorkspaceExperienceHostProvider>
  );
}
