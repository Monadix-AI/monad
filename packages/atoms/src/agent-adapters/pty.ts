import type { MeshAgentRuntimeHandle } from '@monad/sdk-atom';

export function normalizePtyInput(input: string): string {
  return input.replace(/\n$/u, '\r');
}

export function sendPtyInput(handle: MeshAgentRuntimeHandle, input: string): void {
  if (!handle.terminal) throw new Error('MeshAgent session has no PTY input bridge');
  handle.terminal.write(normalizePtyInput(input));
}

export function resizePty(handle: MeshAgentRuntimeHandle, cols: number, rows: number): void {
  if (!handle.terminal) throw new Error('MeshAgent session has no PTY resize bridge');
  handle.terminal.resize(cols, rows);
}

export function stopPty(handle: MeshAgentRuntimeHandle): void {
  handle.terminal?.close();
  handle.kill('SIGTERM');
}
