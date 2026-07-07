import type { ExternalAgentRuntimeHandle } from '@monad/sdk-atom';

export function normalizePtyInput(input: string): string {
  return input.replace(/\n$/u, '\r');
}

export function sendPtyInput(handle: ExternalAgentRuntimeHandle, input: string): void {
  if (!handle.terminal) throw new Error('external agent session has no PTY input bridge');
  handle.terminal.write(normalizePtyInput(input));
}

export function resizePty(handle: ExternalAgentRuntimeHandle, cols: number, rows: number): void {
  if (!handle.terminal) throw new Error('external agent session has no PTY resize bridge');
  handle.terminal.resize(cols, rows);
}

export function stopPty(handle: ExternalAgentRuntimeHandle): void {
  handle.terminal?.close();
  handle.kill('SIGTERM');
}
