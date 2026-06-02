export type DeleteProjectDialogState = { deleting: boolean; error: boolean };

export type DeleteProjectDialogResult = DeleteProjectDialogState & {
  effect: 'confirm' | 'dismiss' | 'none';
};

export function deleteProjectDialogState(
  state: DeleteProjectDialogState,
  event: 'confirm' | 'dismiss' | 'failed'
): DeleteProjectDialogResult {
  if (event === 'failed') return { deleting: false, error: true, effect: 'none' };
  if (state.deleting) return { ...state, effect: 'none' };
  if (event === 'dismiss') return { ...state, effect: 'dismiss' };
  return { deleting: true, error: false, effect: 'confirm' };
}
