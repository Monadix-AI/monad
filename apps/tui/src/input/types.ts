import type { ProjectId, SessionId } from '@monad/protocol';

export type TuiMouseButton = 'left' | 'middle' | 'right' | 'none' | 'wheel-up' | 'wheel-down';

export interface TuiMouseEvent {
  action: 'press' | 'release' | 'drag' | 'move' | 'scroll';
  button: TuiMouseButton;
  column: number;
  ctrl: boolean;
  meta: boolean;
  row: number;
  shift: boolean;
}

type TuiActionId = string;

export interface ActionBinding {
  action: TuiActionId;
  enabled?: boolean;
  priority: number;
  run: () => void;
}

export type TuiRoute =
  | { capabilityId: string; surface: 'workspace' | 'studio' | 'settings' }
  | { projectId?: ProjectId; sessionId: SessionId; surface: 'workspace'; view: 'chat' };

export interface TerminalCapabilities {
  colorDepth: number;
  columns: number;
  kittyKeyboard: boolean;
  rows: number;
  sgrMouse: boolean;
}
