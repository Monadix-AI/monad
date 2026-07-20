import type { MeshAgentProvider, MeshRawEventPage, MeshRawEventRecord } from '@monad/protocol';

import { ObservationSanitizer } from './observation-sanitize.ts';

export interface ObservationFixture {
  provider: MeshAgentProvider;
  page: MeshRawEventPage;
}

export interface ObservationFixtureFrame {
  data: unknown;
  cursor?: string;
  providerIdentity?: string;
  observedAt?: string;
}

/**
 * A capture is only useful as a fixture if it is a contiguous prefix of one provider stream, so the
 * sanitizer is shared across every frame in the page: cross-frame identity (a tool call and its
 * output, a session id repeated in a later record) is what the projectors under test correlate on.
 */
export function buildObservationFixture(
  provider: MeshAgentProvider,
  frames: readonly ObservationFixtureFrame[],
  coverage: MeshRawEventPage['coverage'] = 'settled'
): ObservationFixture {
  const sanitizer = new ObservationSanitizer();
  const records: MeshRawEventRecord[] = frames.map((frame) => {
    const record: MeshRawEventRecord = { data: sanitizer.sanitize(frame.data) };
    if (frame.cursor !== undefined) record.cursor = sanitizer.sanitize(frame.cursor, 'cursor') as string;
    if (frame.providerIdentity !== undefined)
      record.providerIdentity = sanitizer.sanitize(frame.providerIdentity, 'providerIdentity') as string;
    if (frame.observedAt !== undefined)
      record.observedAt = sanitizer.sanitize(frame.observedAt, 'observedAt') as string;
    return record;
  });
  return { provider, page: { records, coverage } };
}

export function parseJsonlFrames(text: string): unknown[] {
  const frames: unknown[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      frames.push(JSON.parse(trimmed));
    } catch {
      // A live capture can be cut mid-line; a partial trailing frame is not a fixture record.
    }
  }
  return frames;
}
