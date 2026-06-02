import { DaemonError } from './daemon-error.ts';

/** Eden Treaty's failure shape: the parsed error body lives on `error.value`, not on `data`. */
interface TreatyResult<T> {
  data: T | Response | null;
  status: number;
  error?: { status?: number; value?: unknown } | null;
}

/** Unwrap an Eden Treaty result, throwing a `DaemonError` (with the daemon's own code/requestId)
 *  on a null body — i.e. a non-2xx response. */
export function requireTreatyData<T>(result: TreatyResult<T>): Exclude<T, Response> {
  if (result.data === null) throw new DaemonError(result.error?.status ?? result.status, result.error?.value);
  if (result.data instanceof Response) throw new Error('request returned a raw Response instead of JSON data');
  return result.data as Exclude<T, Response>;
}
