// Exercises the shared JSON-RPC entrypoint (handleRpcMessage) that all three NDJSON
// transports (WS / Unix socket / stdio) funnel through. Focus: envelope errors and
// the schema-first params validation that the old hand-written switch lacked.

import type { JsonRpcNotification, JsonRpcResponse, SessionId } from '@monad/protocol';

import { expect, test } from 'bun:test';
import { RPC_ERRORS } from '@monad/protocol';

import { createConnectionState, handleRpcMessage } from '@/transports/jsonrpc/index.ts';
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

test('malformed JSON → PARSE_ERROR with null id', async () => {
  const { out } = await call('{not json');
  expect(out).toEqual([{ jsonrpc: '2.0', id: null, error: RPC_ERRORS.PARSE_ERROR }]);
});

test('bad envelope (missing method) → INVALID_REQUEST', async () => {
  const { out } = await call(JSON.stringify({ jsonrpc: '2.0', id: 7 }));
  expect(out[0]).toMatchObject({ id: 7, error: { code: RPC_ERRORS.INVALID_REQUEST.code } });
});

test('unknown method → METHOD_NOT_FOUND', async () => {
  const { out } = await call(rpc('sessions.frobnicate'));
  expect(out[0]).toMatchObject({ id: 1, error: { code: RPC_ERRORS.METHOD_NOT_FOUND.code } });
});

test('sessions.get with empty params → INVALID_PARAMS with field detail', async () => {
  const { out } = await call(rpc('sessions.get', {}));
  const res = out[0] as JsonRpcResponse;
  expect(res.error?.code).toBe(RPC_ERRORS.INVALID_PARAMS.code);
  expect(res.error?.data).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'id' })]));
});

test('sessions.send with wrong-typed text → INVALID_PARAMS', async () => {
  const { out } = await call(rpc('sessions.send', { id: 'ses_x', text: 42 }));
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
});

test('control.subscribe is idempotent and unsubscribe disposes', async () => {
  // Per-session generation is SSE-only now (docs/realtime-channels.md); the control stream is the
  // only per-connection RPC subscription left.
  const handlers = buildHandlers(mockModel(['hi']));
  const state = createConnectionState();
  const out: Msg[] = [];
  const push = (m: Msg) => out.push(m);

  await handleRpcMessage(rpc('control.subscribe', {}), state, handlers, push);
  await handleRpcMessage(rpc('control.subscribe', {}), state, handlers, push);

  await handleRpcMessage(rpc('control.unsubscribe', {}), state, handlers, push);
});
