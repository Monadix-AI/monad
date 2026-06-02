export interface CodexRuntimeState {
  deferredThreadFrame?: string;
  threadResumeRetry?: { params: Record<string, unknown>; attempts: number };
  currentTurnId?: string;
  lastTurnInput?: string;
  turnRecoveries: number;
}

const states = new WeakMap<object, CodexRuntimeState>();

export function codexRuntimeState(handle: object): CodexRuntimeState {
  const existing = states.get(handle);
  if (existing) return existing;
  const state: CodexRuntimeState = { turnRecoveries: 0 };
  states.set(handle, state);
  return state;
}

export function findCodexRuntimeState(handle: object | undefined): CodexRuntimeState | undefined {
  return handle ? states.get(handle) : undefined;
}
