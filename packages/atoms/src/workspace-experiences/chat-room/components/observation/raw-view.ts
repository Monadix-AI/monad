import type { ExternalAgentRawFrame } from '@monad/protocol';

export interface RawFrameRow {
  cursor: string;
  stream: 'stdout' | 'stderr' | 'pty' | 'app-server' | 'unknown';
  preview: string;
}

// A string payload is the exact accepted transport frame — show it verbatim. A structured payload
// (an app-server record) is serialized to compact JSON for display; the raw plane never normalizes
// the underlying value, this is presentation only.
export function rawFrameRow(frame: ExternalAgentRawFrame): RawFrameRow {
  const preview = typeof frame.data === 'string' ? frame.data : JSON.stringify(frame.data);
  return {
    cursor: frame.cursor,
    stream: frame.stream ?? 'unknown',
    preview
  };
}

export function rawFrameRows(frames: ExternalAgentRawFrame[]): RawFrameRow[] {
  return frames.map(rawFrameRow);
}
