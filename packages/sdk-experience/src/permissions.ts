import type { WorkplaceExperiencePermission } from '@monad/protocol';
import type { WorkplaceExperienceActions } from './runtime.ts';

/**
 * The host action surface is granted per manifest permission, not handed over wholesale. An action
 * mapped to `null` is host navigation the experience already controls by being rendered; everything
 * else needs the pack to have declared the permission.
 */
export const WORKPLACE_EXPERIENCE_ACTION_PERMISSIONS: Record<
  keyof WorkplaceExperienceActions,
  WorkplaceExperiencePermission | null
> = {
  addProjectMember: 'project.members.invite',
  loadOlder: 'project.sessions.read',
  openProjectSession: null,
  pauseAll: 'project.agents.control',
  removeProjectMember: 'project.members.remove',
  resolveApproval: 'project.approvals.resolve',
  sendDirective: 'project.sessions.send',
  sendMeshAgentInput: 'project.sessions.send',
  stopMeshAgent: 'project.agents.control',
  switchExperience: null,
  updateProjectMemberSettings: 'project.members.update'
};

export class WorkplaceExperiencePermissionError extends Error {
  readonly action: keyof WorkplaceExperienceActions;
  readonly permission: WorkplaceExperiencePermission;

  constructor(action: keyof WorkplaceExperienceActions, permission: WorkplaceExperiencePermission) {
    super(`workplace experience action "${action}" requires the "${permission}" permission`);
    this.name = 'WorkplaceExperiencePermissionError';
    this.action = action;
    this.permission = permission;
  }
}

function deniedAction(action: keyof WorkplaceExperienceActions, permission: WorkplaceExperiencePermission) {
  return () => {
    throw new WorkplaceExperiencePermissionError(action, permission);
  };
}

export function isWorkplaceExperienceActionGranted(
  action: keyof WorkplaceExperienceActions,
  granted: readonly WorkplaceExperiencePermission[] = []
): boolean {
  const required = WORKPLACE_EXPERIENCE_ACTION_PERMISSIONS[action];
  return required === null || granted.includes(required);
}

/**
 * Return the same action surface with every ungranted entry replaced by a throwing stub. Stubs rather
 * than omissions keep the published `WorkplaceExperienceActions` shape intact, so a component that
 * calls a denied action fails loudly at its own call site instead of hitting `undefined is not a
 * function` — and never reaches the host callback.
 */
export function restrictWorkplaceExperienceActions(
  actions: WorkplaceExperienceActions,
  granted: readonly WorkplaceExperiencePermission[] = []
): WorkplaceExperienceActions {
  // Written out per action rather than looped: the exhaustive object literal makes TypeScript fail a
  // newly added action that nobody classified, instead of silently forwarding it ungated.
  const gate = <K extends keyof WorkplaceExperienceActions>(
    key: K,
    action: WorkplaceExperienceActions[K]
  ): WorkplaceExperienceActions[K] => {
    const required = WORKPLACE_EXPERIENCE_ACTION_PERMISSIONS[key];
    if (required === null || granted.includes(required)) return action;
    return deniedAction(key, required) as WorkplaceExperienceActions[K];
  };
  return {
    ...actions,
    addProjectMember: gate('addProjectMember', actions.addProjectMember),
    loadOlder: gate('loadOlder', actions.loadOlder),
    pauseAll: gate('pauseAll', actions.pauseAll),
    removeProjectMember: gate('removeProjectMember', actions.removeProjectMember),
    resolveApproval: gate('resolveApproval', actions.resolveApproval),
    sendDirective: gate('sendDirective', actions.sendDirective),
    sendMeshAgentInput: gate('sendMeshAgentInput', actions.sendMeshAgentInput),
    stopMeshAgent: gate('stopMeshAgent', actions.stopMeshAgent),
    switchExperience: gate('switchExperience', actions.switchExperience),
    updateProjectMemberSettings: gate('updateProjectMemberSettings', actions.updateProjectMemberSettings)
  };
}
