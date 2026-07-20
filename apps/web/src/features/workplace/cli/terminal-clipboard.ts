export interface TerminalClipboardData {
  getData(type: string): string;
}

export function terminalClipboardText(clipboardData: TerminalClipboardData | null): string | null {
  const text = clipboardData?.getData('text/plain') || clipboardData?.getData('text') || '';
  return text ? text : null;
}
