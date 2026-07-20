// Exercises the shared JSON-RPC entrypoint (handleRpcMessage) that all three NDJSON
// transports (WS / Unix socket / stdio) funnel through. Focus: envelope errors and
// the schema-first params validation that the old hand-written switch lacked.

import type {
  InteractionPresenterCapabilities,
  InteractionRequest,
  InteractionSource,
  JsonRpcNotification,
  JsonRpcResponse,
  SessionId
} from '@monad/protocol';

import { expect, test } from 'bun:test';
import { RPC_ERRORS } from '@monad/protocol';

import { HostInteractionService } from '#/interactions/service.ts';
import { createConnectionState, handleRpcMessage } from '#/transports/jsonrpc/index.ts';
import { buildHandlers, mockModel } from '../../helpers.ts';

type Msg = JsonRpcResponse | JsonRpcNotification;

/** Drive one raw frame through the handler and collect everything it pushes back. */
async function call(raw: string): Promise<{ out: Msg[]; handlers: ReturnType<typeof buildHandlers> }> {
  const handlers = buildHandlers(mockModel(['hi']));
  const state = createConnectionState();
  const out: Msg[] = [];
  await handleRpcMessage(raw, state, handlers, (m) => out.push(m));
  return { out, handlers };
}

function rpc(method: string, params?: unknown, id: number | string = 1): string {
  return JSON.stringify({ jsonrpc: '2.0', id, method, params });
}

const interactionSource: InteractionSource = {
  kind: 'atom-pack',
  packId: 'example.pack',
  atomId: 'configure'
};

const interactionRequest: InteractionRequest = {
  type: 'confirm',
  title: 'Allow?'
};

const interactionCapabilities: InteractionPresenterCapabilities = {
  interactionTypes: ['confirm', 'select', 'form'],
  fieldTypes: ['string', 'secret', 'number', 'boolean', 'select'],
  supportsSecretInput: true,
  supportsBackgroundQueue: true
};

test('malformed JSON → PARSE_ERROR with null id', async () => {
  const { out } = await call('{not json');
  expect(out).toEqual([{ jsonrpc: '2.0', id: null, error: RPC_ERRORS.PARSE_ERROR }]);
});

test('bad envelope (missing method) → INVALID_REQUEST', async () => {
  const { out } = await call(JSON.stringify({ jsonrpc: '2.0', id: 7 }));
  expect(out).toEqual([{ jsonrpc: '2.0', id: 7, error: RPC_ERRORS.INVALID_REQUEST }]);
});

test('non-object JSON → INVALID_REQUEST instead of escaping the boundary', async () => {
  const { out } = await call('null');
  expect(out).toEqual([{ jsonrpc: '2.0', id: null, error: RPC_ERRORS.INVALID_REQUEST }]);
});

test('bad envelope with an invalid id → INVALID_REQUEST with null id', async () => {
  const { out } = await call(JSON.stringify({ jsonrpc: '2.0', id: { injected: true } }));
  expect(out).toEqual([{ jsonrpc: '2.0', id: null, error: RPC_ERRORS.INVALID_REQUEST }]);
});

test('unknown method → METHOD_NOT_FOUND', async () => {
  const { out } = await call(rpc('sessions.frobnicate'));
  expect(out).toEqual([{ jsonrpc: '2.0', id: 1, error: RPC_ERRORS.METHOD_NOT_FOUND }]);
});

test('sessions.get with empty params → INVALID_PARAMS with field detail', async () => {
  const { out } = await call(rpc('sessions.get', {}));
  const res = out[0] as JsonRpcResponse;
  expect(res.error?.code).toBe(RPC_ERRORS.INVALID_PARAMS.code);
  expect(res.error?.data).toEqual([{ path: 'id', message: 'Invalid input: expected string, received undefined' }]);
});

test('sessions.send with wrong-typed text → INVALID_PARAMS', async () => {
  const { out } = await call(rpc('sessions.send', { id: 'ses_x00000000000', text: 42 }));
  expect((out[0] as JsonRpcResponse).error?.code).toBe(RPC_ERRORS.INVALID_PARAMS.code);
});

test('agents.create with junk params → INVALID_PARAMS', async () => {
  const { out } = await call(rpc('agents.create', { name: 42 }));
  expect((out[0] as JsonRpcResponse).error?.code).toBe(RPC_ERRORS.INVALID_PARAMS.code);
});

test('sessions.get happy path: wire id reaches the handler', async () => {
  const handlers = buildHandlers(mockModel(['hi']));
  const { sessionId } = await handlers.session.create({ title: 't' });
  const state = createConnectionState();
  const out: Msg[] = [];
  await handleRpcMessage(rpc('sessions.get', { id: sessionId }), state, handlers, (m) => out.push(m));
  const res = out[0] as JsonRpcResponse;
  expect((res.result as { session: { id: SessionId } }).session.id).toBe(sessionId);
});

test('unknown extra params are stripped, not rejected', async () => {
  const handlers = buildHandlers(mockModel(['hi']));
  const { sessionId } = await handlers.session.create({ title: 't' });
  const state = createConnectionState();
  const out: Msg[] = [];
  await handleRpcMessage(rpc('sessions.get', { id: sessionId, bogus: true }), state, handlers, (m) => out.push(m));
  expect((out[0] as JsonRpcResponse).result).toEqual({ session: handlers.store.getSession(sessionId) });
});

test('control.subscribe is idempotent and unsubscribe disposes', async () => {
  // Per-session generation is SSE-only now (docs/internals/realtime-channels.md); the control stream is the
  // only per-connection RPC subscription left.
  const handlers = buildHandlers(mockModel(['hi']));
  const state = createConnectionState();
  const out: Msg[] = [];
  const push = (m: Msg) => out.push(m);

  await handleRpcMessage(rpc('control.subscribe', {}), state, handlers, push);
  await handleRpcMessage(rpc('control.subscribe', {}), state, handlers, push);

  await handleRpcMessage(rpc('control.unsubscribe', {}), state, handlers, push);
  expect(out).toEqual([
    { jsonrpc: '2.0', id: 1, result: { subscribed: true } },
    { jsonrpc: '2.0', id: 1, result: { subscribed: true } },
    { jsonrpc: '2.0', id: 1, result: {} }
  ]);
});

test('control.subscribe forwards pending and live host interaction events', async () => {
  const handlers = buildHandlers(mockModel(['hi']));
  const interactions = new HostInteractionService({
    now: () => 0,
    createId: () => 'interaction-rpc-1',
    createLeaseToken: () => 'lease-rpc-1'
  });
  void interactions.request(interactionSource, interactionRequest, { mode: 'foreground' });
  const state = createConnectionState();
  const out: Msg[] = [];
  const push = (m: Msg) => out.push(m);

  await handleRpcMessage(rpc('control.subscribe', {}), state, handlers, push, 'rpc', { interactions });

  expect(out[0]).toEqual({
    jsonrpc: '2.0',
    method: 'interactions.event',
    params: {
      event: {
        type: 'upsert',
        interaction: {
          id: 'interaction-rpc-1',
          source: interactionSource,
          request: interactionRequest,
          mode: 'foreground',
          state: 'pending',
          createdAt: '1970-01-01T00:00:00.000Z',
          expiresAt: '1970-01-01T00:05:00.000Z'
        }
      }
    }
  });
  expect(out[1]).toEqual({ jsonrpc: '2.0', id: 1, result: { subscribed: true } });

  const claim = interactions.claim('interaction-rpc-1', 'web-1', interactionCapabilities);
  interactions.cancel('interaction-rpc-1', claim.leaseToken, 'close');

  expect(out.slice(2)).toEqual([
    {
      jsonrpc: '2.0',
      method: 'interactions.event',
      params: {
        event: {
          type: 'upsert',
          interaction: {
            id: 'interaction-rpc-1',
            source: interactionSource,
            request: interactionRequest,
            mode: 'foreground',
            state: 'claimed',
            createdAt: '1970-01-01T00:00:00.000Z',
            expiresAt: '1970-01-01T00:05:00.000Z'
          }
        }
      }
    },
    {
      jsonrpc: '2.0',
      method: 'interactions.event',
      params: { event: { type: 'removed', id: 'interaction-rpc-1', outcome: 'cancelled' } }
    }
  ]);
});
