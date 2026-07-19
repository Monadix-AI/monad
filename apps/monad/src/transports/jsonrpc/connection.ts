import type { Disposer } from '#/handlers/session/context.ts';
import type { RateLimitConfig } from '#/transports/types.ts';
import type { TokenBucket } from './rate-limit.ts';

import { consumeToken, createTokenBucket } from './rate-limit.ts';

export { consumeToken };

/** Per-connection control-stream + rate-limit state. */
export interface ConnectionState {
  /** Disposer for this connection's cross-session control subscription, if any. */
  control?: Disposer;
  /** Disposer for this connection's host-interaction subscription, if any. */
  interactions?: Disposer;
  /** Message-scoped generation subscriptions keyed by session and message id. */
  messageGenerations?: Map<string, Disposer>;
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
  state.interactions?.();
  state.interactions = undefined;
  state.messageGenerations?.forEach((dispose) => {
    dispose();
  });
  state.messageGenerations = undefined;
}
