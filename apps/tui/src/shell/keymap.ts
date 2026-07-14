export type GlobalAction = 'palette.toggle' | 'surface.settings' | 'surface.workspace' | 'help.toggle';

export function globalShortcut(
  input: string,
  key: { ctrl: boolean; escape: boolean; shift: boolean; tab: boolean },
  composerActive: boolean
): GlobalAction | null {
  if (key.ctrl && input.toLowerCase() === 'k') return 'palette.toggle';
  if (key.ctrl && input === ',') return 'surface.settings';
  if (key.ctrl && input === '`') return 'surface.workspace';
  if (!composerActive && !key.ctrl && input === '?') return 'help.toggle';
  return null;
}
