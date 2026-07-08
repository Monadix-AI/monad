import type { Disposer } from '#/handlers/session/context.ts';
import type { RateLimitConfig } from '#/transports/types.ts';
import type { TokenBucket } from './rate-limit.ts';

import { consumeToken, createTokenBucket } from './rate-limit.ts';

export { consumeToken };

/** Per-connection control-stream + rate-limit state. */
export interface ConnectionState {
  /** Disposer for this connection's cross-session control subscription, if any. */
  control?: Disposer;
  /** Per-session live subscriptions keyed by session id. Used by session.subscribe RPC. */
  sessions?: Map<string, Disposer>;
  /** Per-connection RPC rate limiter. Absent → unlimited (trusted local transports). */
  rateLimiter?: TokenBucket;
  /** Set once a WS consumer is dropped for buffering too much; short-circuits further pushes. */
  dropped?: boolean;
}

export function createConnectionState(rateLimit?: RateLimitConfig): ConnectionState {
  return {
    rateLimiter: createTokenBucket(rateLimit)
  };
}

export function closeConnection(state: ConnectionState): void {
  state.control?.();
  state.control = undefined;
  state.sessions?.forEach((dispose) => {
    dispose();
  });
  state.sessions = undefined;
}
