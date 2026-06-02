export interface ProjectMemberTargetDialogState {
  openGroupId: string | null;
  selectedCandidateId: string | null;
}

export type ProjectMemberTargetDialogEvent =
  | { type: 'open'; groupId: string }
  | { type: 'select'; candidateId: string; enabled: boolean }
  | { type: 'confirm' }
  | { type: 'dismiss' };

export type ProjectMemberTargetDialogEffect = { type: 'add'; candidateId: string } | null;

export const initialProjectMemberTargetDialogState: ProjectMemberTargetDialogState = {
  openGroupId: null,
  selectedCandidateId: null
};

export function projectMemberTargetDialogTransition(
  state: ProjectMemberTargetDialogState,
  event: ProjectMemberTargetDialogEvent
): { state: ProjectMemberTargetDialogState; effect: ProjectMemberTargetDialogEffect } {
  switch (event.type) {
    case 'open':
      return {
        state: { openGroupId: event.groupId, selectedCandidateId: null },
        effect: null
      };
    case 'select':
      return event.enabled
        ? {
            state: { ...state, selectedCandidateId: event.candidateId },
            effect: null
          }
        : { state, effect: null };
    case 'confirm':
      return state.selectedCandidateId
        ? {
            state: initialProjectMemberTargetDialogState,
            effect: { type: 'add', candidateId: state.selectedCandidateId }
          }
        : { state, effect: null };
    case 'dismiss':
      return { state: initialProjectMemberTargetDialogState, effect: null };
  }
}
