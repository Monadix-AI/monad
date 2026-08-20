// Exercises the shared JSON-RPC entrypoint (handleRpcMessage) that all three NDJSON
// transports (WS / Unix socket / stdio) funnel through. Focus: envelope errors and
// the schema-first params validation that the old hand-written switch lacked.

import type {
  InteractionPresenterCapabilities,
  InteractionProducer,
  InteractionRequest,
  JsonRpcNotification,
  JsonRpcResponse,
  PublicErrorDescriptor,
  SessionId
} from '@monad/protocol';

import { expect, test } from 'bun:test';
import { RPC_ERRORS } from '@monad/protocol';

import { HandlerError } from '#/handlers/handler-error.ts';
import { InteractionService } from '#/interactions/service.ts';
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

function expectRpcError(
  out: Msg[],
  id: string | number | null,
  error: { code: number; message: string },
  descriptor: Omit<PublicErrorDescriptor, 'requestId'>
): void {
  const requestId = (out[0] as JsonRpcResponse | undefined)?.error?.data?.requestId;
  if (!requestId) throw new Error('expected canonical JSON-RPC error data');
  expect(requestId).toMatch(/^req_[0-9a-zA-Z]{12}$/);
  expect(out).toEqual([
    {
      jsonrpc: '2.0',
      id,
      error: { ...error, data: { ...descriptor, requestId } }
    }
  ]);
}

const interactionSource: InteractionProducer = {
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
  expectRpcError(out, null, RPC_ERRORS.PARSE_ERROR, {
    code: 'PARSE_ERROR',
    message: 'Parse error',
    retryable: false
  });
});

test('bad envelope (missing method) → INVALID_REQUEST', async () => {
  const { out } = await call(JSON.stringify({ jsonrpc: '2.0', id: 7 }));
  expectRpcError(out, 7, RPC_ERRORS.INVALID_REQUEST, {
    code: 'INVALID_REQUEST',
    message: 'Invalid request',
    retryable: false
  });
});

test('JSON null → INVALID_REQUEST instead of throwing before projection', async () => {
  const { out } = await call('null');
  expectRpcError(out, null, RPC_ERRORS.INVALID_REQUEST, {
    code: 'INVALID_REQUEST',
    message: 'Invalid request',
    retryable: false
  });
});

test('non-object JSON → INVALID_REQUEST instead of escaping the boundary', async () => {
  const { out } = await call('null');
  expectRpcError(out, null, RPC_ERRORS.INVALID_REQUEST, {
    code: 'INVALID_REQUEST',
    message: 'Invalid request',
    retryable: false
  });
});

test('bad envelope with an invalid id → INVALID_REQUEST with null id', async () => {
  const { out } = await call(JSON.stringify({ jsonrpc: '2.0', id: { injected: true } }));
  expectRpcError(out, null, RPC_ERRORS.INVALID_REQUEST, {
    code: 'INVALID_REQUEST',
    message: 'Invalid request',
    retryable: false
  });
});

test('unknown method → METHOD_NOT_FOUND', async () => {
  const { out } = await call(rpc('sessions.frobnicate'));
  expectRpcError(out, 1, RPC_ERRORS.METHOD_NOT_FOUND, {
    code: 'METHOD_NOT_FOUND',
    message: 'Method not found',
    retryable: false
  });
});

test('sessions.get with empty params → INVALID_PARAMS with field detail', async () => {
  const { out } = await call(rpc('sessions.get', {}));
  expectRpcError(out, 1, RPC_ERRORS.INVALID_PARAMS, {
    code: 'VALIDATION',
    message: 'Invalid params',
    retryable: false,
    details: { issues: ['id: Invalid input: expected string, received undefined'] }
  });
});

test('rate-limited request → RATE_LIMITED with retryable descriptor', async () => {
  const handlers = buildHandlers(mockModel(['hi']));
  const state = createConnectionState({ capacity: 0, refillPerSec: 0 });
  const out: Msg[] = [];
  await handleRpcMessage(rpc('sessions.create', { title: 'x' }), state, handlers, (message) => out.push(message));
  expectRpcError(out, 1, RPC_ERRORS.RATE_LIMITED, {
    code: 'RATE_LIMITED',
    message: 'Rate limit exceeded',
    retryable: true
  });
});

test('mapped HandlerError uses its RPC code and safe refined descriptor', async () => {
  const handlers = buildHandlers(mockModel(['hi']));
  handlers.session.get = async () => {
    throw new HandlerError('not_found', 'session was not found', 'SESSION_NOT_FOUND');
  };
  const state = createConnectionState();
  const out: Msg[] = [];
  await handleRpcMessage(rpc('sessions.get', { id: 'ses_100000000000' }), state, handlers, (message) =>
    out.push(message)
  );
  expectRpcError(
    out,
    1,
    { code: -32001, message: 'session was not found' },
    {
      code: 'SESSION_NOT_FOUND',
      message: 'session was not found',
      retryable: false
    }
  );
});

test('bad-gateway HandlerError redacts raw upstream text and remains retryable', async () => {
  const handlers = buildHandlers(mockModel(['hi']));
  handlers.session.get = async () => {
    throw new HandlerError('bad_gateway', 'upstream token=secret raw response', 'BAD_GATEWAY');
  };
  const state = createConnectionState();
  const out: Msg[] = [];
  await handleRpcMessage(rpc('sessions.get', { id: 'ses_100000000000' }), state, handlers, (message) =>
    out.push(message)
  );
  expectRpcError(
    out,
    1,
    { code: -32005, message: 'upstream service unavailable' },
    {
      code: 'BAD_GATEWAY',
      message: 'upstream service unavailable',
      retryable: true
    }
  );
});

test('unknown handler failure exposes a generic internal error', async () => {
  const handlers = buildHandlers(mockModel(['hi']));
  handlers.session.get = async () => {
    throw new Error('secret internal path');
  };
  const state = createConnectionState();
  const out: Msg[] = [];
  await handleRpcMessage(rpc('sessions.get', { id: 'ses_100000000000' }), state, handlers, (message) =>
    out.push(message)
  );
  expectRpcError(out, 1, RPC_ERRORS.INTERNAL_ERROR, {
    code: 'INTERNAL',
    message: 'internal server error',
    retryable: false
  });
});

test('invalid notifications receive no error response', async () => {
  const handlers = buildHandlers(mockModel(['hi']));
  const state = createConnectionState();
  const out: Msg[] = [];
  await handleRpcMessage(
    JSON.stringify({ jsonrpc: '2.0', method: 'sessions.frobnicate' }),
    state,
    handlers,
    (message) => out.push(message)
  );
  await handleRpcMessage(
    JSON.stringify({ jsonrpc: '2.0', method: 'sessions.get', params: {} }),
    state,
    handlers,
    (message) => out.push(message)
  );
  expect(out).toEqual([]);
});

test('explicit null id is a request id and receives error responses', async () => {
  const handlers = buildHandlers(mockModel(['hi']));
  const state = createConnectionState();
  const unknownOut: Msg[] = [];
  await handleRpcMessage(
    JSON.stringify({ jsonrpc: '2.0', id: null, method: 'sessions.frobnicate' }),
    state,
    handlers,
    (message) => unknownOut.push(message)
  );
  expectRpcError(unknownOut, null, RPC_ERRORS.METHOD_NOT_FOUND, {
    code: 'METHOD_NOT_FOUND',
    message: 'Method not found',
    retryable: false
  });

  const invalidParamsOut: Msg[] = [];
  await handleRpcMessage(
    JSON.stringify({ jsonrpc: '2.0', id: null, method: 'sessions.get', params: {} }),
    state,
    handlers,
    (message) => invalidParamsOut.push(message)
  );
  expectRpcError(invalidParamsOut, null, RPC_ERRORS.INVALID_PARAMS, {
    code: 'VALIDATION',
    message: 'Invalid params',
    retryable: false,
    details: { issues: ['id: Invalid input: expected string, received undefined'] }
  });
});

test('sessions.send with wrong-typed text → INVALID_PARAMS', async () => {
  const { out } = await call(rpc('sessions.send', { id: 'ses_x00000000000', text: 42 }));
  expect((out[0] as JsonRpcResponse).error?.code).toBe(RPC_ERRORS.INVALID_PARAMS.code);
});

test('sessions.send rejects reply-bearing steer identically while idle and active', async () => {
  const expectReplyControlError = (error: JsonRpcResponse['error']) => {
    const requestId = error?.data.requestId;
    if (!requestId) throw new Error('expected canonical reply control error');
    expect(requestId).toMatch(/^req_[0-9a-zA-Z]{12}$/);
    expect(error).toEqual({
      code: RPC_ERRORS.INVALID_PARAMS.code,
      message: 'request validation failed',
      data: {
        code: 'VALIDATION',
        message: 'request validation failed',
        retryable: false,
        requestId,
        details: { issues: ['request validation failed'] }
      }
    });
  };

  async function createReplyTarget(handlers: ReturnType<typeof buildHandlers>) {
    const { sessionId } = await handlers.session.create({ title: 'reply steer rpc' });
    await handlers.session.send({ generate: false, sessionId, text: 'target' });
    const target = (await handlers.session.messages({ id: sessionId })).messages[0];
    if (!target) throw new Error('expected RPC reply target');
    return { sessionId, target };
  }

  async function sendReplyControl(
    handlers: ReturnType<typeof buildHandlers>,
    method: 'sessions.send' | 'sessions.generate',
    sessionId: SessionId,
    targetId: string,
    control: { steer?: boolean; continueFromHistory?: boolean }
  ) {
    const out: Msg[] = [];
    await handleRpcMessage(
      rpc(method, {
        id: sessionId,
        text: control.continueFromHistory ? '' : 'redirect',
        ...control,
        replyToMessageId: targetId
      }),
      createConnectionState(),
      handlers,
      (message) => out.push(message)
    );
    return (out[0] as JsonRpcResponse).error;
  }

  const idleHandlers = buildHandlers(mockModel(['idle']));
  const idle = await createReplyTarget(idleHandlers);
  const idleSendError = await sendReplyControl(idleHandlers, 'sessions.send', idle.sessionId, idle.target.id, {
    steer: true
  });
  const idleGenerateError = await sendReplyControl(idleHandlers, 'sessions.generate', idle.sessionId, idle.target.id, {
    continueFromHistory: true
  });

  let markStarted: (() => void) | undefined;
  let release: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const activeHandlers = buildHandlers({
    async *stream() {
      markStarted?.();
      yield { type: 'text' as const, token: 'working' };
      await released;
    },
    async complete() {
      return { finishReason: 'stop', text: 'working' };
    }
  });
  const active = await createReplyTarget(activeHandlers);
  await activeHandlers.session.send({ sessionId: active.sessionId, text: 'long running turn' });
  await started;
  const activeSendError = await sendReplyControl(activeHandlers, 'sessions.send', active.sessionId, active.target.id, {
    steer: true
  });
  const activeGenerateError = await sendReplyControl(
    activeHandlers,
    'sessions.generate',
    active.sessionId,
    active.target.id,
    { continueFromHistory: true }
  );
  release?.();

  expectReplyControlError(idleSendError);
  expectReplyControlError(idleGenerateError);
  expectReplyControlError(activeSendError);
  expectReplyControlError(activeGenerateError);
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
  expect(out).toEqual([{ jsonrpc: '2.0', id: 1, result: { session: handlers.store.getSession(sessionId) } }]);
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
  // Per-session generation is SSE-only now (docs/internals/infra/realtime-channels.md); the control stream is the
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
  const interactions = new InteractionService({
    now: () => 0,
    createId: () => 'interaction-rpc-1',
    createLeaseToken: () => 'lease-rpc-1'
  });
  const handlers = buildHandlers(mockModel(['hi']), undefined, { interactions });
  void interactions.request(interactionSource, interactionRequest, { mode: 'foreground' });
  const state = createConnectionState();
  const out: Msg[] = [];
  const push = (m: Msg) => out.push(m);

  await handleRpcMessage(rpc('control.subscribe', {}), state, handlers, push);

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
