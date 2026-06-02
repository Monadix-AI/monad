import type { MonadClient } from '@monad/client';

export interface MonadExtra {
  client: MonadClient;
}

export function clientOf(api: { extra: unknown }): MonadClient {
  const extra = api.extra as Partial<MonadExtra> | undefined;
  if (!extra?.client) {
    throw new Error(
      'monadApi: the store has no MonadClient-compatible instance — build it with createMonadStore({ client }), ' +
        'or set middleware thunk.extraArgument.client yourself.'
    );
  }
  return extra.client;
}

/**
 * The error shape every endpoint surfaces to the UI (the apiSlice baseQuery error type).
 * `message` is always present for inline display; `status` and `code` are present for
 * server-originated failures so the UI can route them — `status` for transport-level
 * handling (401 → re-auth, ≥500 → global toast) and `code` for the daemon's machine code
 * from httpErrorSchema (`VALIDATION`, `NOT_FOUND`, `INTERNAL`, …). Both absent ⇒ a
 * client-side/network error that never reached the daemon.
 */
export interface MonadApiError {
  message: string;
  status?: number;
  code?: string;
  /** Raw server response body — present when the error came from the HTTP layer. */
  raw?: unknown;
}

/** Eden Treaty's failure object: an HTTP status plus the parsed response body. */
interface TreatyError {
  status?: number;
  value?: unknown;
}

/** Map a Treaty error (or a thrown network error) into the UI-facing MonadApiError. */
export function toError(e: unknown): MonadApiError {
  if (e && typeof e === 'object' && 'status' in e) {
    const { status, value } = e as TreatyError;
    const body = (value ?? {}) as { error?: string; code?: string };
    return {
      status,
      code: body.code,
      message: body.error ?? (status !== undefined ? `request failed (${status})` : 'request failed'),
      raw: value
    };
  }
  return { message: e instanceof Error ? e.message : String(e) };
}

/**
 * Run a Treaty call inside an RTK Query `queryFn`, collapsing the two failure paths
 * (Treaty's `{ error }` and a thrown exception) into one `{ error: MonadApiError }`.
 * Pass `map` to reshape the raw response (entity-adapter normalization, filtering, etc.).
 */
export async function runTreaty<T>(
  call: () => Promise<{ data: T | null | undefined; error: unknown }>
): Promise<{ data: T } | { error: MonadApiError }>;
export async function runTreaty<R, T>(
  call: () => Promise<{ data: R | null | undefined; error: unknown }>,
  map: (raw: R) => T
): Promise<{ data: T } | { error: MonadApiError }>;
export async function runTreaty<R, T>(
  call: () => Promise<{ data: R | null | undefined; error: unknown }>,
  map?: (raw: R) => T
): Promise<{ data: T } | { error: MonadApiError }> {
  try {
    const { data, error } = await call();
    if (error) return { error: toError(error) };
    const raw = data as R;
    return { data: (map ? map(raw) : raw) as T };
  } catch (err) {
    return { error: toError(err) };
  }
}
