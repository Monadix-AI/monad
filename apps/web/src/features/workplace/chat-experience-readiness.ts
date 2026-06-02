export interface ChatExperienceReadinessState {
  activeProjectId: string | null;
  activeSessionId: string | null;
  projectSessionsLoading: boolean;
  streamLoading: boolean;
  streamSnapshotReceived?: boolean;
  meshStateSubscribed?: boolean;
  meshStateSnapshotReceived?: boolean;
}

export function isChatExperienceReady(state: ChatExperienceReadinessState): boolean {
  if (state.activeProjectId === null || state.projectSessionsLoading) return false;
  if (state.activeSessionId === null) return true;
  if (state.streamLoading || state.streamSnapshotReceived !== true) return false;
  return state.meshStateSubscribed !== true || state.meshStateSnapshotReceived === true;
}
