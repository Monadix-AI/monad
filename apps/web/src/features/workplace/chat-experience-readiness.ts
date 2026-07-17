export function isChatExperienceReady(state: {
  activeProjectId: string | null;
  activeSessionId: string | null;
  projectSessionsLoading: boolean;
  streamLoading: boolean;
}): boolean {
  if (state.activeProjectId === null || state.projectSessionsLoading) return false;
  return state.activeSessionId === null || !state.streamLoading;
}
