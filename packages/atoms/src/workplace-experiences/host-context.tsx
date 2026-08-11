import type { WorkplaceExperienceProjectDialogRequest, WorkplaceExperienceStudioSection } from '@monad/protocol';
import type { WorkplaceExperienceAgentIdentityResolver } from '@monad/sdk-experience';
import type { ReactNode } from 'react';

import { createContext, useContext } from 'react';

export type { WorkplaceExperienceStudioSection };
export type VoiceModelState = 'checking' | 'configured' | 'missing' | 'failed';

export interface WorkplaceExperienceHostAction {
  id: string;
  label: string;
  disabled?: boolean;
  run: (payload: unknown) => void | Promise<void>;
}

/** Ambient host capabilities a built-in workplace experience reads from context instead of receiving as
 *  renderer props or reaching for a module-global client. The React counterpart of the third-party
 *  event-bridge `WorkplaceExperienceHostApi` (@monad/protocol) — `requestProjectDialog` reuses the same
 *  protocol type so the two host contracts stay aligned. The web app supplies the value; atoms never
 *  imports the web layer.
 *
 *  Daemon reads/writes go through `@monad/sdk-experience/react` hooks (host-component experiences already
 *  render inside the web app's Redux `<Provider>`), not a `fetch` escape hatch on this object. */
export interface WorkplaceExperienceHost {
  voiceModelState?: VoiceModelState;
  actions?: readonly WorkplaceExperienceHostAction[];
  resolveAgentIdentity: WorkplaceExperienceAgentIdentityResolver;
  /** Imperative Studio navigation (replaces the old meshAgentsHref link + openModelSettings). */
  openStudio: (section?: WorkplaceExperienceStudioSection) => void;
  requestProjectDialog: (request: WorkplaceExperienceProjectDialogRequest) => void;
}

const WorkplaceExperienceHostContext = createContext<WorkplaceExperienceHost | null>(null);

export function WorkplaceExperienceHostProvider({
  value,
  children
}: {
  value: WorkplaceExperienceHost;
  children: ReactNode;
}): ReactNode {
  return <WorkplaceExperienceHostContext.Provider value={value}>{children}</WorkplaceExperienceHostContext.Provider>;
}

export function useWorkplaceExperienceHost(): WorkplaceExperienceHost {
  const value = useContext(WorkplaceExperienceHostContext);
  if (!value) throw new Error('useWorkplaceExperienceHost must be used inside WorkplaceExperienceHostProvider');
  return value;
}

export function useOptionalWorkplaceExperienceHost(): WorkplaceExperienceHost | null {
  return useContext(WorkplaceExperienceHostContext);
}

export const spawnAgentMemberDialogRequest = {
  intent: 'spawn-agent',
  open: true,
  type: 'project-settings'
} satisfies WorkplaceExperienceProjectDialogRequest;

export function requestSpawnAgentMemberDialog(
  requestProjectDialog: WorkplaceExperienceHost['requestProjectDialog']
): void {
  requestProjectDialog(spawnAgentMemberDialogRequest);
}
