import type {
  WorkspaceExperienceDefinition,
  WorkspaceExperienceEntry,
  WorkspaceExperienceHostApi
} from '@monad/protocol';

export type { WorkspaceExperienceDefinition, WorkspaceExperienceEntry, WorkspaceExperienceHostApi };

export const WORKSPACE_EXPERIENCE_UPDATE_EVENT = 'monad-workspace-experience:update';

export interface WorkspaceExperienceElement<Api extends WorkspaceExperienceHostApi = WorkspaceExperienceHostApi> {
  monadWorkspaceExperience?: Api;
}

export interface WorkspaceExperienceUpdateEvent<Api extends WorkspaceExperienceHostApi = WorkspaceExperienceHostApi> {
  type: typeof WORKSPACE_EXPERIENCE_UPDATE_EVENT;
  detail: Api;
}

export interface WorkspaceExperienceEventTarget<Api extends WorkspaceExperienceHostApi = WorkspaceExperienceHostApi> {
  monadWorkspaceExperience?: Api;
  addEventListener(
    type: typeof WORKSPACE_EXPERIENCE_UPDATE_EVENT,
    listener: (event: WorkspaceExperienceUpdateEvent<Api>) => void
  ): void;
  removeEventListener(
    type: typeof WORKSPACE_EXPERIENCE_UPDATE_EVENT,
    listener: (event: WorkspaceExperienceUpdateEvent<Api>) => void
  ): void;
}

export function defineWorkspaceExperience(definition: WorkspaceExperienceDefinition): WorkspaceExperienceDefinition {
  return definition;
}

export function bindWorkspaceExperience<Api extends WorkspaceExperienceHostApi>(
  target: WorkspaceExperienceEventTarget<Api>,
  onUpdate: (api: Api) => void
): () => void {
  const listener = (event: WorkspaceExperienceUpdateEvent<Api>) => onUpdate(event.detail);
  target.addEventListener(WORKSPACE_EXPERIENCE_UPDATE_EVENT, listener);
  if (target.monadWorkspaceExperience) onUpdate(target.monadWorkspaceExperience);
  return () => target.removeEventListener(WORKSPACE_EXPERIENCE_UPDATE_EVENT, listener);
}
