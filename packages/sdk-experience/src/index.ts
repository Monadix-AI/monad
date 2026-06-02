import type {
  WorkplaceExperienceDefinition,
  WorkplaceExperienceEntry,
  WorkplaceExperienceHostApi
} from '@monad/protocol';
import type { WorkplaceExperienceActions, WorkplaceExperienceSnapshot } from './runtime.ts';

import { WORKPLACE_EXPERIENCE_API_VERSION } from './runtime.ts';

export type {
  WorkplaceApprovalDecision,
  WorkplaceExperienceActions,
  WorkplaceExperienceAddMemberOptions,
  WorkplaceExperienceApiVersion,
  WorkplaceExperienceGraphActivityRow,
  WorkplaceExperienceGraphCanvas,
  WorkplaceExperienceGraphParticipant,
  WorkplaceExperienceIcon,
  WorkplaceExperienceMember,
  WorkplaceExperienceMemberCandidate,
  WorkplaceExperienceMemberSettings,
  WorkplaceExperienceMemberType,
  WorkplaceExperienceProductIconId,
  WorkplaceExperienceProject,
  WorkplaceExperienceSnapshot,
  WorkplaceExperienceWorkdir
} from './runtime.ts';
export type { WorkplaceExperienceDefinition, WorkplaceExperienceEntry, WorkplaceExperienceHostApi };

export {
  isWorkplaceExperienceActionGranted,
  restrictWorkplaceExperienceActions,
  WORKPLACE_EXPERIENCE_ACTION_PERMISSIONS,
  WorkplaceExperiencePermissionError
} from './permissions.ts';

export { WORKPLACE_EXPERIENCE_API_VERSION };

/** Concrete first-party binding of the event-bridge host API: snapshot/actions resolved to the
 *  published WorkplaceExperienceSnapshot/Actions. Third-party experiences type their host against this
 *  instead of the `unknown`-defaulted generic. */
export type WorkplaceExperienceHostApiV1 = WorkplaceExperienceHostApi<
  WorkplaceExperienceSnapshot,
  WorkplaceExperienceActions
>;

export const WORKPLACE_EXPERIENCE_UPDATE_EVENT = 'monad-workplace-experience:update';

export interface WorkplaceExperienceElement<Api extends WorkplaceExperienceHostApi = WorkplaceExperienceHostApi> {
  monadWorkplaceExperience?: Api;
}

export interface WorkplaceExperienceUpdateEvent<Api extends WorkplaceExperienceHostApi = WorkplaceExperienceHostApi> {
  type: typeof WORKPLACE_EXPERIENCE_UPDATE_EVENT;
  detail: Api;
}

export interface WorkplaceExperienceEventTarget<Api extends WorkplaceExperienceHostApi = WorkplaceExperienceHostApi> {
  monadWorkplaceExperience?: Api;
  addEventListener(
    type: typeof WORKPLACE_EXPERIENCE_UPDATE_EVENT,
    listener: (event: WorkplaceExperienceUpdateEvent<Api>) => void
  ): void;
  removeEventListener(
    type: typeof WORKPLACE_EXPERIENCE_UPDATE_EVENT,
    listener: (event: WorkplaceExperienceUpdateEvent<Api>) => void
  ): void;
}

export function defineWorkplaceExperience(definition: WorkplaceExperienceDefinition): WorkplaceExperienceDefinition {
  return definition;
}

/** Two host-API versions are compatible when they share a major (the integer part). A component built
 *  for major N can consume any host payload of major N; a mismatch means the snapshot/actions shape may
 *  have changed incompatibly. `expected` defaults to the version this SDK build ships. */
export function isWorkplaceExperienceApiCompatible(
  hostVersion: number,
  expected: number = WORKPLACE_EXPERIENCE_API_VERSION
): boolean {
  return Math.trunc(hostVersion) === Math.trunc(expected);
}

/** Subscribe a workplace-experience element to its host API (initial value + update events). Delivery
 *  is version-guarded: a major mismatch between the host payload and this SDK build is warned once (the
 *  payload is still delivered — the component decides how to degrade). */
export function bindWorkplaceExperience<Api extends WorkplaceExperienceHostApi>(
  target: WorkplaceExperienceEventTarget<Api>,
  onUpdate: (api: Api) => void
): () => void {
  let warnedIncompatible = false;
  const deliver = (api: Api): void => {
    if (!warnedIncompatible && !isWorkplaceExperienceApiCompatible(api.version)) {
      warnedIncompatible = true;
      // biome-ignore lint/suspicious/noConsole: surface a host/experience API version mismatch to the developer.
      console.warn(
        `workplace experience: host API v${api.version} may be incompatible with this component ` +
          `(built for major ${Math.trunc(WORKPLACE_EXPERIENCE_API_VERSION)})`
      );
    }
    onUpdate(api);
  };
  const listener = (event: WorkplaceExperienceUpdateEvent<Api>) => deliver(event.detail);
  target.addEventListener(WORKPLACE_EXPERIENCE_UPDATE_EVENT, listener);
  if (target.monadWorkplaceExperience) deliver(target.monadWorkplaceExperience);
  return () => target.removeEventListener(WORKPLACE_EXPERIENCE_UPDATE_EVENT, listener);
}
