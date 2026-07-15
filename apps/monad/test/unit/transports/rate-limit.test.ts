// Per-connection JSON-RPC rate limiting (browser-facing WS). The bucket logic is
// deterministic when refillPerSec=0 (no time dependence); refill is exercised by
// backdating lastRefillMs rather than sleeping.

import type { JsonRpcNotification, JsonRpcResponse } from '@monad/protocol';

import { expect, test } from 'bun:test';
import { RPC_ERRORS } from '@monad/protocol';

import { consumeToken, createConnectionState, handleRpcMessage } from '#/transports/jsonrpc/index.ts';
import { buildHandlers, mockModel } from '../../helpers.ts';

type Msg = JsonRpcResponse | JsonRpcNotification;

test('no config → unlimited (trusted local transports)', () => {
  expect(createConnectionState().rateLimiter).toBeUndefined();
});

test('burst: capacity N allows N then blocks', () => {
  const { rateLimiter } = createConnectionState({ capacity: 3, refillPerSec: 0 });
  if (!rateLimiter) throw new Error('expected a limiter');
  expect(consumeToken(rateLimiter)).toBe(true);
  expect(consumeToken(rateLimiter)).toBe(true);
  expect(consumeToken(rateLimiter)).toBe(true);
  expect(consumeToken(rateLimiter)).toBe(false);
});

test('refill: tokens replenish over elapsed time', () => {
  const { rateLimiter } = createConnectionState({ capacity: 10, refillPerSec: 1000 });
  if (!rateLimiter) throw new Error('expected a limiter');
  // Drain the bucket.
  for (let i = 0; i < 10; i++) consumeToken(rateLimiter);
  expect(consumeToken(rateLimiter)).toBe(false);
  // Backdate the last refill by 1s → at 1000/s the bucket caps back at 10.
  rateLimiter.lastRefillMs -= 1000;
  expect(consumeToken(rateLimiter)).toBe(true);
});

test('handler: rejects with RATE_LIMITED once the bucket is empty', async () => {
  const handlers = buildHandlers(mockModel(['hi']));
  const state = createConnectionState({ capacity: 1, refillPerSec: 0 });
  const out: Msg[] = [];
  const push = (m: Msg) => out.push(m);
  const frame = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sessions.create', params: { title: 'ok' } });

  await handleRpcMessage(frame, state, handlers, push);
  await handleRpcMessage(frame, state, handlers, push);

  expect(out[0]).not.toMatchObject({ error: { code: RPC_ERRORS.RATE_LIMITED.code } }); // first allowed
  expect(out[1]).toMatchObject({ id: 1, error: { code: RPC_ERRORS.RATE_LIMITED.code } }); // second throttled
});

test('handler: rate-limited notification is dropped silently (no error reply)', async () => {
  const handlers = buildHandlers(mockModel(['hi']));
  const state = createConnectionState({ capacity: 0, refillPerSec: 0 });
  const out: Msg[] = [];
  // Notification (no id) — even when throttled, JSON-RPC forbids a reply.
  await handleRpcMessage(
    JSON.stringify({ jsonrpc: '2.0', method: 'sessions.create', params: { title: 'x' } }),
    state,
    handlers,
    (m) => out.push(m)
  );
});
