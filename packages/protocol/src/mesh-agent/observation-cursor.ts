import { z } from 'zod';

// One grammar for "where a consumer is" in a MeshAgent's observation, across both planes and
// both origins. It exists because a position is not an identity: the raw plane previously emitted a
// bare row sequence (which cannot detect an epoch rotation, so a reconnect resumed into a different
// epoch's numbering) and the convenience plane emitted the projected event id (an identity, not a
// position — leaving no way to express "everything after here", which forced a full re-projection of
// the whole snapshot on every tick).
//
//   live:<observationEpoch>:<seq>   a row in that epoch's live raw store
//   provider:<token>                an adapter-native earlier-events position
//
// Every opaque component is percent-encoded. Provider cursors can be JSON; leaving commas and quotes
// on the wire lets query parsers split one `before` value into an array before schema validation.
const LIVE_PREFIX = 'live:';
const PROVIDER_PREFIX = 'provider:';

export type ObservationCursor = `live:${string}:${number}` | `provider:${string}`;

export type ObservationPosition =
  | { kind: 'live'; observationEpoch: string; seq: number }
  | { kind: 'provider'; token: string };

// `provider:` with an empty token is legal and means "provider events, starting at the latest page"
// — the same statement an omitted `before` makes, expressed inside a typed cursor so a caller can
// carry "earlier events exist, no position yet" without falling back to a bare string.
const OBSERVATION_CURSOR_PATTERN = /^(?:live:[^:]*:\d+|provider:.*)$/;

// Hand-written type + regex schema + cast: a template-literal union cannot round-trip through
// z.infer (docs/engineering/conventions.md §6).
export const observationCursorSchema: z.ZodType<ObservationCursor> = z
  .string()
  .regex(OBSERVATION_CURSOR_PATTERN)
  .refine((cursor) => parseObservationCursor(cursor) !== undefined) as unknown as z.ZodType<ObservationCursor>;

export function formatObservationCursor(position: ObservationPosition): ObservationCursor {
  if (position.kind === 'live') return `${LIVE_PREFIX}${encodeURIComponent(position.observationEpoch)}:${position.seq}`;
  return `${PROVIDER_PREFIX}${encodeURIComponent(position.token)}`;
}

/** Returns `undefined` for anything unparseable. A foreign, corrupt, or merely position-SHAPED value
 *  (a client-side dedup key such as `disconnected:latest`) must degrade to "no position" — never be
 *  forwarded to a provider as an opaque token, and never be misread as a row sequence. */
export function parseObservationCursor(cursor: string | undefined): ObservationPosition | undefined {
  if (!cursor) return undefined;
  if (cursor.startsWith(PROVIDER_PREFIX)) {
    try {
      return { kind: 'provider', token: decodeURIComponent(cursor.slice(PROVIDER_PREFIX.length)) };
    } catch {
      return undefined;
    }
  }
  if (!cursor.startsWith(LIVE_PREFIX)) return undefined;
  const [epoch, seq, ...rest] = cursor.slice(LIVE_PREFIX.length).split(':');
  if (rest.length > 0 || epoch === undefined || seq === undefined || !/^\d+$/.test(seq)) return undefined;
  const parsedSeq = Number(seq);
  if (!Number.isSafeInteger(parsedSeq)) return undefined;
  try {
    return { kind: 'live', observationEpoch: decodeURIComponent(epoch), seq: parsedSeq };
  } catch {
    return undefined;
  }
}

/** The live-subscribe resume position. Only a `live:` cursor is meaningful here; a provider-events
 *  position names a place in a different sequence entirely. */
export function parseObservationAfter(
  cursor: string | undefined
): Extract<ObservationPosition, { kind: 'live' }> | undefined {
  const position = parseObservationCursor(cursor);
  return position?.kind === 'live' ? position : undefined;
}

/** The earlier-events paging position is an adapter-native token. A
 *  live position is never valid here — it names a row in an ephemeral store the provider knows nothing
 *  about. An absent value is the legal, explicit spelling of "start from the latest page". */
export function parseObservationBefore(
  cursor: string | undefined
): Extract<ObservationPosition, { kind: 'provider' }> | undefined {
  const position = parseObservationCursor(cursor);
  return position?.kind === 'provider' ? position : undefined;
}

export type ObservationResume = { kind: 'after'; seq: number } | { kind: 'epoch-start' };

/** The single place the stale-cursor rule is decided, so the raw and convenience planes cannot drift
 *  into different answers. A cursor from a rotated (or unknown) epoch resumes the CURRENT epoch from
 *  its start rather than at a sequence that means something else there; the `ready` frame's epoch and
 *  cursor are what tell the client to discard its old window and re-anchor. */
export function observationResume(cursor: string | undefined, currentEpoch: string): ObservationResume {
  const position = parseObservationAfter(cursor);
  if (!position || position.observationEpoch !== currentEpoch) return { kind: 'epoch-start' };
  return { kind: 'after', seq: position.seq };
}
