import type { Middleware } from '@reduxjs/toolkit';
import type { MonadApiError } from './endpoint-helpers.ts';

import { isRejectedWithValue } from '@reduxjs/toolkit';

/**
 * Called once for every failed RTK Query request, with the normalized error and the
 * endpoint that produced it. The app decides global vs. local handling here: e.g.
 * `status === 401` → re-auth, `status >= 500` → global toast, while leaving
 * client-shaped failures (`code === 'VALIDATION'`) to the component's inline display.
 * Kept as a callback so @monad/client-rtk carries no UI/toast dependency.
 */
export type ApiErrorSink = (error: MonadApiError, meta: { endpoint?: string }) => void;

interface RejectedMeta {
  arg?: { endpointName?: string };
}

/**
 * Redux middleware that funnels every rejected monadApi request into `sink`. Pair it with
 * the per-component `useXxxQuery().error` (also a MonadApiError) — middleware handles the
 * cross-cutting cases, the component handles the inline ones. Returns a middleware to
 * `.concat()` after `monadApi.middleware`.
 */
export function apiErrorMiddleware(sink: ApiErrorSink): Middleware {
  return () => (next) => (action) => {
    if (isRejectedWithValue(action)) {
      const endpoint = (action.meta as RejectedMeta | undefined)?.arg?.endpointName;
      sink(action.payload as MonadApiError, { endpoint });
    }
    return next(action);
  };
}
