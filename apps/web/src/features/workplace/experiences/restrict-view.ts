import type { WorkplaceExperienceDefinition } from '@monad/protocol';
import type { ProjectExperienceView } from './types';

import { restrictWorkplaceExperienceActions } from '@monad/sdk-experience';

/**
 * Narrow the host view an experience receives to the actions its atom pack manifest was granted.
 * `permissions` is stamped by the daemon at registration, so an experience cannot widen it by
 * declaring permissions on the definition it ships.
 */
export function restrictProjectExperienceView(
  view: ProjectExperienceView,
  permissions: WorkplaceExperienceDefinition['permissions']
): ProjectExperienceView {
  return {
    ...view,
    runtime: {
      ...view.runtime,
      actions: restrictWorkplaceExperienceActions(view.runtime.actions, permissions)
    }
  };
}
