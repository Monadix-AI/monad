export type AtomPackUpdateDialogState = { updating: boolean; error: boolean };

export type AtomPackUpdateDialogResult = AtomPackUpdateDialogState & {
  effect: 'confirm' | 'dismiss' | 'none';
};

export function atomPackUpdateDialogState(
  state: AtomPackUpdateDialogState,
  event: 'confirm' | 'dismiss' | 'failed' | 'succeeded'
): AtomPackUpdateDialogResult {
  if (event === 'failed') return { updating: false, error: true, effect: 'none' };
  if (event === 'succeeded') return { updating: false, error: false, effect: 'dismiss' };
  if (state.updating) return { ...state, effect: 'none' };
  if (event === 'dismiss') return { ...state, effect: 'dismiss' };
  return { updating: true, error: false, effect: 'confirm' };
}
