import type { NativeCliRuntimeHandle } from '@/services/native-cli/types.ts';

export function sendPtyInput(handle: NativeCliRuntimeHandle, input: string): void {
  if (!handle.terminal) throw new Error('native CLI session has no PTY input bridge');
  handle.terminal.write(input);
}

export function resizePty(handle: NativeCliRuntimeHandle, cols: number, rows: number): void {
  if (!handle.terminal) throw new Error('native CLI session has no PTY resize bridge');
  handle.terminal.resize(cols, rows);
}

export function stopPty(handle: NativeCliRuntimeHandle): void {
  handle.terminal?.close();
  handle.kill('SIGTERM');
}
