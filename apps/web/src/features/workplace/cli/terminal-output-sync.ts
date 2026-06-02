export type TerminalOutputSyncPlan =
  | { kind: 'noop'; writtenOutput: string }
  | { kind: 'append'; text: string; writtenOutput: string }
  | { kind: 'replay'; text: string; writtenOutput: string };

export function terminalOutputSyncPlan(previous: string, next: string): TerminalOutputSyncPlan {
  if (next === previous) return { kind: 'noop', writtenOutput: previous };
  return { kind: 'replay', text: next, writtenOutput: next };
}
