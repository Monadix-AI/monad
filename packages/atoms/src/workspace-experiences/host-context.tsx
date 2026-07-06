import type { WorkspaceExperienceProjectDialogRequest, WorkspaceExperienceStudioSection } from '@monad/protocol';
import type { ReactNode } from 'react';

import { createContext, useContext } from 'react';

export type { WorkspaceExperienceStudioSection };
export type VoiceModelState = 'checking' | 'configured' | 'missing' | 'failed';

/** Ambient host capabilities a built-in workspace experience reads from context instead of receiving as
 *  renderer props or reaching for a module-global client. The React counterpart of the third-party
 *  event-bridge `WorkspaceExperienceHostApi` (@monad/protocol) — `requestProjectDialog` reuses the same
 *  protocol type so the two host contracts stay aligned. The web app supplies the value; atoms never
 *  imports the web layer.
 *
 *  Daemon reads/writes go through `@monad/sdk-atom-client-rtk` hooks (host-component experiences already
 *  render inside the web app's Redux `<Provider>`), not a `fetch` escape hatch on this object. */
export interface WorkspaceExperienceHost {
  voiceModelState?: VoiceModelState;
  /** Imperative Studio navigation (replaces the old nativeCliAgentsHref link + openModelSettings). */
  openStudio: (section?: WorkspaceExperienceStudioSection) => void;
  requestProjectDialog: (request: WorkspaceExperienceProjectDialogRequest) => void;
}

const WorkspaceExperienceHostContext = createContext<WorkspaceExperienceHost | null>(null);

export function WorkspaceExperienceHostProvider({
  value,
  children
}: {
  value: WorkspaceExperienceHost;
  children: ReactNode;
}): ReactNode {
  return <WorkspaceExperienceHostContext.Provider value={value}>{children}</WorkspaceExperienceHostContext.Provider>;
}

export function useWorkspaceExperienceHost(): WorkspaceExperienceHost {
  const value = useContext(WorkspaceExperienceHostContext);
  if (!value) throw new Error('useWorkspaceExperienceHost must be used inside WorkspaceExperienceHostProvider');
  return value;
}

export const spawnAgentMemberDialogRequest = {
  intent: 'spawn-agent',
  open: true,
  type: 'project-settings'
} satisfies WorkspaceExperienceProjectDialogRequest;

export function requestSpawnAgentMemberDialog(
  requestProjectDialog: WorkspaceExperienceHost['requestProjectDialog']
): void {
  requestProjectDialog(spawnAgentMemberDialogRequest);
}
