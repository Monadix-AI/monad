// Platform-agnostic developer-record fan-out. The in-memory subscriber set (live SSE) lives here so
// both the API surface (subscribeDeveloperLogRecords) and every sink share one registry. Where the
// records ALSO go on disk is a sink concern (node appends jsonl; browser has no filesystem).

import type { DeveloperLogSubscriber, RawDeveloperLogRecord } from './types.ts';

const subscribers = new Set<DeveloperLogSubscriber>();

export function subscribeDeveloperLogRecords(subscriber: DeveloperLogSubscriber): () => void {
  subscribers.add(subscriber);
  return () => subscribers.delete(subscriber);
}

/** True when a sink must bother materialising records at all (a live subscriber or on-disk sink). */
export function hasDeveloperRecordSubscribers(): boolean {
  return subscribers.size > 0;
}

/** Fan a parsed record out to every live subscriber. Sinks call this after extracting the record. */
export function emitDeveloperRecord(record: RawDeveloperLogRecord): void {
  for (const subscriber of subscribers) subscriber(record);
}

/** Sanitise a channel/session id into a filesystem-safe log filename fragment. */
export function safeLogId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_.:-]/g, '_');
}
