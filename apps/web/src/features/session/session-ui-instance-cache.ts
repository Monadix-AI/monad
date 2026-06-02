const SESSION_UI_INSTANCE_LIMIT = 20;

export interface SessionUiInstance<T> {
  key: string;
  sessionId: string;
  value: T;
}

export function activateSessionUiInstance<T>(
  entries: SessionUiInstance<T>[],
  active: SessionUiInstance<T>,
  limit = SESSION_UI_INSTANCE_LIMIT
): SessionUiInstance<T>[] {
  return [active, ...entries.filter((entry) => entry.key !== active.key)].slice(0, limit);
}

export function pruneSessionUiInstances<T>(
  entries: SessionUiInstance<T>[],
  activeSessionIds: ReadonlySet<string>
): SessionUiInstance<T>[] {
  return entries.filter((entry) => activeSessionIds.has(entry.sessionId));
}
