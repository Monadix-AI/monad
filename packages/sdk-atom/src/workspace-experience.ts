import type {
  WorkspaceExperienceDefinition,
  WorkspaceExperienceEntry,
  WorkspaceExperienceHostApi
} from '@monad/protocol';
import type { WorkspaceExperienceActions, WorkspaceExperienceSnapshot } from './workspace-experience-runtime.ts';

import { WORKSPACE_EXPERIENCE_API_VERSION } from './workspace-experience-runtime.ts';

export type { WorkspaceExperienceDefinition, WorkspaceExperienceEntry, WorkspaceExperienceHostApi };

/** Concrete first-party binding of the event-bridge host API: snapshot/actions resolved to the
 *  published WorkspaceExperienceSnapshot/Actions. Third-party experiences type their host against this
 *  instead of the `unknown`-defaulted generic. */
export type WorkspaceExperienceHostApiV1 = WorkspaceExperienceHostApi<
  WorkspaceExperienceSnapshot,
  WorkspaceExperienceActions
>;

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

/** Two host-API versions are compatible when they share a major (the integer part). A component built
 *  for major N can consume any host payload of major N; a mismatch means the snapshot/actions shape may
 *  have changed incompatibly. `expected` defaults to the version this SDK build ships. */
export function isWorkspaceExperienceApiCompatible(
  hostVersion: number,
  expected: number = WORKSPACE_EXPERIENCE_API_VERSION
): boolean {
  return Math.trunc(hostVersion) === Math.trunc(expected);
}

/** Subscribe a workspace-experience element to its host API (initial value + update events). Delivery
 *  is version-guarded: a major mismatch between the host payload and this SDK build is warned once (the
 *  payload is still delivered — the component decides how to degrade). */
export function bindWorkspaceExperience<Api extends WorkspaceExperienceHostApi>(
  target: WorkspaceExperienceEventTarget<Api>,
  onUpdate: (api: Api) => void
): () => void {
  let warnedIncompatible = false;
  const deliver = (api: Api): void => {
    if (!warnedIncompatible && !isWorkspaceExperienceApiCompatible(api.version)) {
      warnedIncompatible = true;
      // biome-ignore lint/suspicious/noConsole: surface a host/experience API version mismatch to the developer.
      console.warn(
        `workspace experience: host API v${api.version} may be incompatible with this component ` +
          `(built for major ${Math.trunc(WORKSPACE_EXPERIENCE_API_VERSION)})`
      );
    }
    onUpdate(api);
  };
  const listener = (event: WorkspaceExperienceUpdateEvent<Api>) => deliver(event.detail);
  target.addEventListener(WORKSPACE_EXPERIENCE_UPDATE_EVENT, listener);
  if (target.monadWorkspaceExperience) deliver(target.monadWorkspaceExperience);
  return () => target.removeEventListener(WORKSPACE_EXPERIENCE_UPDATE_EVENT, listener);
}
