import type { AgentObservationEvent, AgentObservationKind, MeshAgentObservationEvent } from '@monad/protocol';
import type { MeshAgentObservationActivity, MeshAgentObservationProjector } from './agent-adapter.ts';

/** Deterministic string hash (FNV-1a) for content-derived ids — same input always yields the same
 *  key, with no dependency on delivery order or pagination window. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? String(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

export function contentHash(value: string): string {
  let result = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 0x01000193);
  }
  return (result >>> 0).toString(16).padStart(8, '0');
}

function kindFromActivity(activity: MeshAgentObservationActivity | undefined): AgentObservationKind | undefined {
  switch (activity) {
    case 'thinking':
      return 'reasoning';
    case 'message':
      return 'assistant-message';
    case 'tool-call':
      return 'tool-call';
    case 'tool-result':
      return 'tool-result';
    case 'user':
      return 'user-message';
    case 'turn-end':
      return 'turn-end';
    case 'system':
      return 'system';
    case 'status':
      return undefined;
    default:
      return undefined;
  }
}

function kindFromRole(event: MeshAgentObservationEvent): AgentObservationKind {
  switch (event.role) {
    case 'agent':
      return 'assistant-message';
    case 'user':
      return 'user-message';
    case 'tool':
      return 'tool-result';
    case 'system':
      return 'system';
  }
}

// A custom adapter (no `observationRuntime`) may not compute its own `dedupeKey` — without one, a
// consumer joining this event across two delivery windows (a history page vs. the live tail; see
// `event-pages.ts`'s `livePageProjectionId`) falls back to the positional `event.id` and renders the
// same underlying record twice. Content-hashing the raw provenance gives a key that is identical for
// the same event regardless of which window it was read through, with no adapter cooperation needed.
// `role`/`providerEventType` are folded in as a discriminator (mirroring the same fields
// `event-source.ts`'s `eventDedupeKey` uses) because one raw record can legitimately decode into more
// than one `MeshAgentObservationEvent` sharing identical `provenance.rawEvents` — e.g. a reasoning
// event and a following tool-call event both citing the record that triggered them. Content hash
// alone would collide those into the same key; a plain positional index would reintroduce the
// window-instability this function exists to avoid, so only adapter-independent, content-derived
// fields are used.
function fallbackDedupeKey(event: MeshAgentObservationEvent): string {
  if (event.dedupeKey) return event.dedupeKey;
  const discriminator = [event.role, event.providerEventType].filter(Boolean).join(':');
  return `${event.source}:${contentHash(canonicalJson(event.provenance.rawEvents))}:${discriminator}`;
}

export function toFallbackAgentObservationEvent(
  event: MeshAgentObservationEvent,
  projector?: Pick<MeshAgentObservationProjector, 'classifyActivity' | 'isStreamingFragment'>
): AgentObservationEvent | null {
  const activity = event.projection === 'unknown' ? undefined : projector?.classifyActivity?.(event);
  if (activity === 'status') return null;
  const kind = event.projection === 'unknown' ? 'unknown' : (kindFromActivity(activity) ?? kindFromRole(event));
  const decoded: AgentObservationEvent = {
    id: event.id,
    dedupeKey: fallbackDedupeKey(event),
    kind,
    streaming: event.projection === 'unknown' ? false : (projector?.isStreamingFragment?.(event) ?? false),
    provenance: { contractEvents: [event] },
    ...(event.diagnostic ? { diagnostic: event.diagnostic } : {}),
    ...(event.createdAt ? { at: event.createdAt } : {})
  };
  // No `callId` is synthesized here: a generic (provider-unaware) fallback has no field shared
  // between a `tool-call` and its `tool-result` to correlate them by, and a per-event id derived
  // only from that event's own content would be worse than today — it would make the callId lookup
  // in `observation-cards.ts` fail (mismatched keys) *and* suppress the positional
  // `events[index + 1]` fallback that path already uses when `callId` is absent, since that fallback
  // only runs when `callId` is falsy. Leaving it unset keeps the existing (working) positional pairing.
  if (kind === 'tool-call' || kind === 'tool-result') decoded.tool = { name: 'tool', output: event.text };
  if (kind === 'turn-end') decoded.reason = 'completed';
  if (event.text) decoded.text = event.text;
  return decoded;
}
