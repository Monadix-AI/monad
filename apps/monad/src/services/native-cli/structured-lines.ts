export interface StructuredLineBufferState {
  text: string;
  discarding: boolean;
}

export function takeCompleteStructuredLines(
  state: StructuredLineBufferState,
  chunk: string,
  maxLineLength: number
): string {
  if (state.discarding) {
    const newline = chunk.indexOf('\n');
    if (newline === -1) return '';
    state.text = '';
    state.discarding = false;
    return takeCompleteStructuredLines(state, chunk.slice(newline + 1), maxLineLength);
  }

  // Invariant: state.text is an in-progress line and never contains '\n', so only the new chunk can
  // hold a line boundary. Scanning the chunk (not the whole accumulated buffer) keeps a long line
  // split across many chunks from being O(n²).
  const lastNewline = chunk.lastIndexOf('\n');
  if (lastNewline === -1) {
    if (state.text.length + chunk.length > maxLineLength) {
      state.text = '';
      state.discarding = true;
      return '';
    }
    state.text += chunk;
    return '';
  }

  const completeLines = `${state.text}${chunk.slice(0, lastNewline + 1)}`;
  const parseableLines = completeLines
    .split(/(?<=\n)/)
    .filter((line) => line.length <= maxLineLength)
    .join('');
  const tail = chunk.slice(lastNewline + 1);
  if (tail.length > maxLineLength) {
    state.text = '';
    state.discarding = true;
  } else {
    state.text = tail;
    state.discarding = false;
  }
  return parseableLines;
}
