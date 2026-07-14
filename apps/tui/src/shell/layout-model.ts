export type TuiLayoutMode = 'wide' | 'medium' | 'compact' | 'too-small';

export function layoutMode(columns: number, rows: number): TuiLayoutMode {
  if (columns < 60 || rows < 18) return 'too-small';
  if (columns >= 120) return 'wide';
  if (columns >= 80) return 'medium';
  return 'compact';
}

export function shouldShowProjection(
  mode: TuiLayoutMode,
  chatOpen: boolean,
  hasSession: boolean,
  externalAgentCount: number
): boolean {
  return mode === 'wide' && chatOpen && hasSession && externalAgentCount > 0;
}

export function chatPaneWidths(
  columns: number,
  navigationWidth: number,
  projectionVisible: boolean
): { projection: number; transcript: number } {
  const available = Math.max(1, Math.floor(columns) - Math.max(0, Math.floor(navigationWidth)) - 2);
  if (!projectionVisible) return { projection: 0, transcript: available };

  const projection = Math.min(Math.max(1, available - 1), 52, Math.max(30, Math.floor(available * 0.42)));
  return { projection, transcript: available - projection };
}
const NAVIGATION_FIRST_ITEM_ROW = 4;
const TRANSCRIPT_WHEEL_PAGE = 20;

export function navigationIndexAtRow(row: number): number | null {
  return row < NAVIGATION_FIRST_ITEM_ROW ? null : row - NAVIGATION_FIRST_ITEM_ROW;
}

export function transcriptOffsetAfterWheel(offset: number, button: 'wheel-up' | 'wheel-down'): number {
  return Math.max(0, offset + (button === 'wheel-up' ? TRANSCRIPT_WHEEL_PAGE : -TRANSCRIPT_WHEEL_PAGE));
}
