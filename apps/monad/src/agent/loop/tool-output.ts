export const DEFAULT_MAX_TOOL_RESULT_CHARS = 24_000;

// Keep head + tail so the model sees the start and end of long outputs, such as stack traces.
// `handle`, when given, is the tool-call id the full pre-truncation output was spilled under (see
// AgentLoopDeps.persistRawToolOutput) — point the model at read_tool_output instead of re-running
// the call, which may be non-reproducible or side-effecting.
export function truncateToolOutput(text: string, max: number, handle?: string): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.7);
  const tail = max - head;
  const omitted = text.length - head - tail;
  const recover = handle
    ? `read_tool_output({ id: "${handle}", offset, limit }) to page through the rest`
    : 'narrow the call (e.g. file_read offset/limit, grep) to see more';
  return `${text.slice(0, head)}\n\n…[tool output truncated: ${omitted} of ${text.length} chars omitted; ${recover}]…\n\n${text.slice(text.length - tail)}`;
}

// Production logs keep inputs out of info streams; development logs keep a short preview.
export function logInput(input: unknown): unknown {
  if (Bun.env.NODE_ENV === 'production') {
    return input !== null && typeof input === 'object' ? Object.keys(input as object) : typeof input;
  }
  const s = JSON.stringify(input);
  return s && s.length > 500 ? `${s.slice(0, 500)}…` : input;
}
