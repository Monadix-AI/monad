import type { MeshAgentExperienceInput, MeshAgentRuntimeStatusView } from '@monad/atoms/mesh-agent-state';

import { foldMeshAgentExperienceState, meshAgentRuntimeStatus } from '@monad/atoms/mesh-agent-state';

export interface MeshWorkspaceStatusView {
  /** Runtime status of the observed session, localized by the shared atom (the TUI panel renders it). */
  runtime: MeshAgentRuntimeStatusView | null;
  /** The neutral mesh-state stream lost its live snapshot and is resubscribing. */
  reconnecting: boolean;
}

// Both Web and TUI derive their MeshAgent status view from this same shared fold + status atom, so the
// daemon never ships presentation copy. ProjectHeader renders `reconnecting` today; `runtime` is the same
// neutral status the TUI panel renders, kept here so both surfaces share one derivation. Accepts the atom
// fold input (protocol-structural) rather than the client-rtk cache type so test fixtures stay client-free.
export function meshWorkspaceStatusView(snapshot: MeshAgentExperienceInput | undefined): MeshWorkspaceStatusView {
  if (!snapshot) return { runtime: null, reconnecting: false };
  const state = foldMeshAgentExperienceState(snapshot);
  const sessions = [...state.sessions.values()];
  const observed = sessions.find((session) => session.lifecycle.state !== 'terminal') ?? sessions[0];
  return {
    runtime: observed ? meshAgentRuntimeStatus(state, observed) : null,
    reconnecting: state.stale
  };
}
