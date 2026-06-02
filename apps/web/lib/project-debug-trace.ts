type ProjectDebugTraceDirection = 'input' | 'output' | 'event' | 'internal' | 'error';
type ProjectDebugTraceLayer = 'web' | 'http' | 'sse' | 'daemon' | 'log';

export interface ProjectDebugTraceEntry {
  id: string;
  at: string;
  direction: ProjectDebugTraceDirection;
  layer: ProjectDebugTraceLayer;
  label: string;
  data?: unknown;
  sessionId?: string;
}

export interface ProjectDebugTraceInput {
  direction: ProjectDebugTraceDirection;
  layer: ProjectDebugTraceLayer;
  label: string;
  data?: unknown;
  sessionId?: string;
}

// Dev-only developer trace. Captures message text, operation results and request bodies into an
// in-memory ring — sensitive data we must never collect in production. Gated on NODE_ENV so the
// bundler dead-code-eliminates the capture paths (and the global hook below) from release builds.
const TRACE_ENABLED = process.env.NODE_ENV !== 'production';

const TRACE_LIMIT = 1000;
let seq = 0;
let entries: ProjectDebugTraceEntry[] = [];
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

export function appendProjectDebugTrace(input: ProjectDebugTraceInput): ProjectDebugTraceEntry {
  const entry: ProjectDebugTraceEntry = {
    id: `dbg_${Date.now().toString(36)}_${(seq++).toString(36)}`,
    at: new Date().toISOString(),
    direction: input.direction,
    layer: input.layer,
    label: input.label,
    ...(input.data !== undefined ? { data: input.data } : {}),
    ...(input.sessionId ? { sessionId: input.sessionId } : {})
  };
  if (!TRACE_ENABLED) return entry;
  entries = [...entries, entry].slice(-TRACE_LIMIT);
  notify();
  return entry;
}

export function clearProjectDebugTrace(): void {
  entries = [];
  notify();
}

export function projectDebugTraceSnapshot(): ProjectDebugTraceEntry[] {
  return entries;
}

export function subscribeProjectDebugTrace(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function traceProjectDebugOperation<T>(
  input: Omit<ProjectDebugTraceInput, 'direction'>,
  operation: () => Promise<T>
): Promise<T> {
  if (!TRACE_ENABLED) return operation();
  const startedAt = performance.now();
  appendProjectDebugTrace({ ...input, direction: 'input' });
  try {
    const result = await operation();
    appendProjectDebugTrace({
      ...input,
      direction: 'output',
      data: { result, latencyMs: Math.round(performance.now() - startedAt) }
    });
    return result;
  } catch (error) {
    appendProjectDebugTrace({
      ...input,
      direction: 'error',
      data: {
        message: error instanceof Error ? error.message : String(error),
        latencyMs: Math.round(performance.now() - startedAt)
      }
    });
    throw error;
  }
}

type GlobalDebugTrace = (entry: ProjectDebugTraceInput) => void;

declare global {
  var __MONAD_DEBUG_TRACE__: GlobalDebugTrace | undefined;
}

if (TRACE_ENABLED && typeof globalThis !== 'undefined') {
  globalThis.__MONAD_DEBUG_TRACE__ = appendProjectDebugTrace;
}
