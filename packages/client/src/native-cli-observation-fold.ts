import type { NativeCliObservationAccessResponse } from '@monad/protocol';

import { NATIVE_CLI_OUTPUT_SNAPSHOT_MAX } from '@monad/protocol';

type ObservationHandler = (access: NativeCliObservationAccessResponse) => void;

/** Fold the daemon's per-token observation stream into full snapshots. The daemon pushes a full
 *  `output` only on first connect / resync and `append` deltas thereafter (see
 *  `nativeCliObservationAccessResponseSchema`); this accumulates them so every consumer reads a full
 *  `output`. `cursor` mirrors the daemon's cumulative `seq` — retained even when the bounded
 *  accumulator drops older text — so a reconnect can backfill from `last-event-id`. Stale/duplicate
 *  frames (`seq <= cursor`, e.g. a resync overlapping bytes already applied) add nothing and never
 *  rewind the cursor. Non-live frames pass through untouched. */
export function createNativeCliObservationFolder(onObservation: ObservationHandler): ObservationHandler {
  let accumulated = '';
  let cursor = 0;
  return (access) => {
    if (access.state !== 'live') {
      onObservation(access);
      return;
    }
    if (typeof access.output === 'string') {
      accumulated = access.output;
      cursor = access.seq ?? access.output.length;
    } else if (typeof access.append === 'string') {
      const seq = access.seq ?? cursor + access.append.length;
      if (seq > cursor) {
        const fresh = Math.min(access.append.length, seq - cursor);
        accumulated = `${accumulated}${access.append.slice(access.append.length - fresh)}`;
        if (accumulated.length > NATIVE_CLI_OUTPUT_SNAPSHOT_MAX) {
          accumulated = accumulated.slice(accumulated.length - NATIVE_CLI_OUTPUT_SNAPSHOT_MAX);
        }
        cursor = seq;
      }
    }
    onObservation({ ...access, output: accumulated, append: undefined, seq: cursor });
  };
}
