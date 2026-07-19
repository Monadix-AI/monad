import type { MeshRawEvent } from '@monad/protocol';

export interface RawFrameRow {
  identity: string;
  cursor: string;
  stream: 'stdout' | 'stderr' | 'pty' | 'app-server' | 'unknown';
  preview: string;
}

export type RawDisplayMode = 'lines' | 'parsed';

export function rawDisplayEntries(data: unknown, mode: RawDisplayMode): string[] {
  const text = typeof data === 'string' ? data : JSON.stringify(data);
  if (mode === 'lines') {
    const lines = text.split(/\r?\n/);
    if (lines.at(-1) === '') lines.pop();
    return lines.length > 0 ? lines : [''];
  }
  if (typeof data !== 'string') return [JSON.stringify(data, null, 2)];
  const trimmed = data.trim();
  if (!trimmed) return [data];
  try {
    return [JSON.stringify(JSON.parse(trimmed) as unknown, null, 2)];
  } catch {
    const lines = trimmed.split(/\r?\n/);
    try {
      return lines.map((line) => JSON.stringify(JSON.parse(line) as unknown, null, 2));
    } catch {
      return [data];
    }
  }
}

// A string payload is the exact accepted transport frame — show it verbatim. A structured payload
// (an app-server record) is serialized to compact JSON for display; the raw plane never normalizes
// the underlying value, this is presentation only.
export function rawFrameRow(frame: MeshRawEvent): RawFrameRow {
  const preview = typeof frame.data === 'string' ? frame.data : JSON.stringify(frame.data);
  return {
    identity: frame.providerIdentity ?? frame.cursor,
    cursor: frame.cursor,
    stream: frame.stream ?? 'unknown',
    preview
  };
}

export function rawFrameRows(frames: MeshRawEvent[]): RawFrameRow[] {
  return frames.map(rawFrameRow);
}
