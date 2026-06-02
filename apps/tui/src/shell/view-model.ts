export function transcriptWindow<T>(items: readonly T[], limit: number, offsetFromTail: number): T[] {
  const safeLimit = Math.max(1, limit);
  const offset = Math.max(0, offsetFromTail);
  const end = Math.max(safeLimit, items.length - offset);
  const boundedEnd = Math.min(items.length, end);
  const start = Math.max(0, boundedEnd - safeLimit);
  return items.slice(start, boundedEnd);
}

export function filterByTitle<T extends { title: string }>(items: readonly T[], query: string): T[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [...items];
  return items.filter((item) => item.title.toLocaleLowerCase().includes(needle));
}

export function mergeById<T extends { id: string }>(history: readonly T[], live: readonly T[]): T[] {
  const liveIds = new Set(live.map((item) => item.id));
  return [...history.filter((item) => !liveIds.has(item.id)), ...live];
}

export function enqueueFollowUp(queue: readonly string[], text: string): string[] {
  const value = text.trim();
  return value ? [...queue, value] : [...queue];
}

export function safeErrorMessage(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === 'object' && value !== null && 'message' in value) {
    const message = Reflect.get(value, 'message');
    if (typeof message === 'string') return message;
  }
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) || 'request failed';
  } catch {
    return 'request failed';
  }
}
