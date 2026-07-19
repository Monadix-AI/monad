import type { CodexLegacyRuntimeHandle as LegacyProviderRuntimeHandle } from './runtime.ts';

export interface CodexRuntimeState {
  deferredThreadFrame?: string;
  threadResumeRetry?: { params: Record<string, unknown>; attempts: number };
  currentTurnId?: string;
  lastTurnInput?: string;
  turnRecoveries: number;
}

const states = new WeakMap<LegacyProviderRuntimeHandle, CodexRuntimeState>();

export function codexRuntimeState(handle: LegacyProviderRuntimeHandle): CodexRuntimeState {
  const existing = states.get(handle);
  if (existing) return existing;
  const state: CodexRuntimeState = { turnRecoveries: 0 };
  states.set(handle, state);
  return state;
}

export function findCodexRuntimeState(handle: LegacyProviderRuntimeHandle | undefined): CodexRuntimeState | undefined {
  return handle ? states.get(handle) : undefined;
}
