import type { ObservationCursor, ObservationPosition } from '@monad/protocol';

import { formatObservationCursor } from '@monad/protocol';

// Earlier-event cursors are opaque to clients and adapter-native inside `provider:<token>`. An
// unprefixed, unknown, or live-plane cursor decodes to `none`: paging restarts from the latest page
// instead of forwarding a foreign token to an adapter.
//
// The grammar itself lives in `@monad/protocol` (observation-cursor.ts) next to the live-plane
// positions, so exactly one module decides what a position is.

export type EventCursor = Extract<ObservationPosition, { kind: 'provider' }> | { kind: 'none' };

export function eventCursorFromPosition(position: ObservationPosition | undefined): EventCursor {
  return position?.kind === 'provider' ? position : { kind: 'none' };
}

export function encodeEventCursor(cursor: string): ObservationCursor {
  return formatObservationCursor({ kind: 'provider', token: cursor });
}
