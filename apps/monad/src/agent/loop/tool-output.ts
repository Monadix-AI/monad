export const DEFAULT_MAX_TOOL_RESULT_CHARS = 24_000;

// Keep head + tail so the model sees the start and end of long outputs, such as stack traces.
export function truncateToolOutput(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.7);
  const tail = max - head;
  const omitted = text.length - head - tail;
  return `${text.slice(0, head)}\n\n…[tool output truncated: ${omitted} of ${text.length} chars omitted; narrow the call (e.g. fs_read offset/limit, grep) to see more]…\n\n${text.slice(text.length - tail)}`;
}

// Production logs keep inputs out of info streams; development logs keep a short preview.
export function logInput(input: unknown): unknown {
  if (Bun.env.NODE_ENV === 'production') {
    return input !== null && typeof input === 'object' ? Object.keys(input as object) : typeof input;
  }
  const s = JSON.stringify(input);
  return s && s.length > 500 ? `${s.slice(0, 500)}…` : input;
}
