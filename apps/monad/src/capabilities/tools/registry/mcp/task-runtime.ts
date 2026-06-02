export interface TaskRuntimeStats {
  active: number;
  cancelled: number;
  completed: number;
  failed: number;
  pendingDeliveries: number;
  queued: number;
  recovered: number;
  retries: number;
  started: number;
  totalDurationMs: number;
}

const MAX_ACTIVE_PER_SERVER = 8;
const MAX_QUEUED_PER_SERVER = 64;
const stats = new Map<string, TaskRuntimeStats>();
const queues = new Map<string, Array<() => void>>();

export async function acquireTaskSlot(server: string, signal?: AbortSignal): Promise<() => void> {
  const current = statsFor(server);
  if (current.active < MAX_ACTIVE_PER_SERVER) return activate(server);
  const queue = queues.get(server) ?? [];
  if (queue.length >= MAX_QUEUED_PER_SERVER) {
    throw new Error(`MCP server "${server}" has too many queued Tasks`);
  }
  current.queued += 1;
  await new Promise<void>((resolve, reject) => {
    const enter = () => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    };
    const onAbort = () => {
      const index = queue.indexOf(enter);
      if (index >= 0) queue.splice(index, 1);
      current.queued -= 1;
      reject(signal?.reason ?? new DOMException('MCP task cancelled', 'AbortError'));
    };
    queue.push(enter);
    queues.set(server, queue);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
  current.queued -= 1;
  return activate(server);
}

export function recordTaskOutcome(
  server: string,
  outcome: 'cancelled' | 'completed' | 'failed' | 'recovered' | 'retry',
  durationMs = 0
): void {
  const current = statsFor(server);
  if (outcome === 'retry') current.retries += 1;
  else if (outcome === 'recovered') {
    current.recovered += 1;
    current.pendingDeliveries += 1;
  } else {
    current[outcome] += 1;
    current.totalDurationMs += durationMs;
  }
}

export function setPendingTaskDeliveries(server: string, count: number): void {
  statsFor(server).pendingDeliveries = Math.max(0, Math.trunc(count));
}

export function recordTaskDeliveryAcknowledged(server: string): void {
  const current = statsFor(server);
  current.pendingDeliveries = Math.max(0, current.pendingDeliveries - 1);
}

export function mcpTaskRuntimeSnapshot(): Record<string, TaskRuntimeStats> {
  return Object.fromEntries([...stats].map(([server, value]) => [server, { ...value }]));
}

function activate(server: string): () => void {
  const current = statsFor(server);
  current.active += 1;
  current.started += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    current.active -= 1;
    const queue = queues.get(server);
    const next = queue?.shift();
    if (!queue?.length) queues.delete(server);
    next?.();
  };
}

function statsFor(server: string): TaskRuntimeStats {
  const current = stats.get(server);
  if (current) return current;
  const created: TaskRuntimeStats = {
    active: 0,
    cancelled: 0,
    completed: 0,
    failed: 0,
    pendingDeliveries: 0,
    queued: 0,
    recovered: 0,
    retries: 0,
    started: 0,
    totalDurationMs: 0
  };
  stats.set(server, created);
  return created;
}
