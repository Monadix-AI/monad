import type { MeshAgentExperienceState, MeshAgentRuntimeStatusView } from '@monad/atoms/mesh-agent-state';
import type { MeshAgentLoginRequirement, MeshAgentPendingApproval, MeshAgentStateSession } from '@monad/protocol';

import { meshAgentRuntimeStatus } from '@monad/atoms/mesh-agent-state';

export interface ProjectionPanelModel {
  runtime: MeshAgentRuntimeStatusView;
  loginRequirements: MeshAgentLoginRequirement[];
  approvals: MeshAgentPendingApproval[];
}

// The TUI projection panel derives its status line and its blocked-on-login / pending-approval rows
// from the same shared atom fold the web surface uses, so both surfaces render identical neutral state.
export function projectionPanelModel(
  state: MeshAgentExperienceState,
  observed: MeshAgentStateSession
): ProjectionPanelModel {
  return {
    runtime: meshAgentRuntimeStatus(state, observed),
    loginRequirements: [...state.loginRequirements.values()],
    approvals: [...state.approvals.values()]
  };
}
