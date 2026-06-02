export interface TerminalClipboardData {
  getData(type: string): string;
}

interface TerminalSelectionSource {
  buffer: {
    active: {
      getLine(index: number): { isWrapped: boolean } | undefined;
      length: number;
    };
  };
  getSelection(): string;
  getSelectionPosition(): { start: { y: number }; end: { y: number } } | undefined;
  getViewportY(): number;
  rows: number;
}

export function terminalClipboardText(clipboardData: TerminalClipboardData | null): string | null {
  const text = clipboardData?.getData('text/plain') || clipboardData?.getData('text') || '';
  return text ? text : null;
}

export function terminalSelectionText(terminal: TerminalSelectionSource): string {
  const selection = terminal.getSelection();
  const position = terminal.getSelectionPosition();
  if (!selection || !position) return selection;

  const rows = selection.split('\n');
  if (rows.length !== position.end.y - position.start.y + 1) return selection;

  const viewportStart = terminal.buffer.active.length - terminal.rows - Math.floor(terminal.getViewportY());
  let text = rows[0] ?? '';
  for (let index = 1; index < rows.length; index++) {
    const line = terminal.buffer.active.getLine(viewportStart + position.start.y + index);
    if (!line?.isWrapped) text += '\n';
    text += rows[index];
  }
  return text;
}
