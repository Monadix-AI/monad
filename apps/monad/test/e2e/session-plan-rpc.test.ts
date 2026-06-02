// e2e: proves the JSON-RPC wire (`sessions.plan.*` in RPC_HANDLERS, driven over the real
// WebSocket transport) routes into the same durable plan store as the REST controller —
// method-table.ts declaring the methods and methods.ts typechecking against RpcHandlerMap only
// proves the binding compiles, not that dispatch actually calls the right handler with a
// correctly-composed OperationSource.

import { afterEach, describe, expect, test } from 'bun:test';
import { CONTROL_API_VERSION } from '@monad/protocol';

import { createHttpTransport } from '#/transports/http.ts';
import { buildHandlers, mockModel } from '../helpers.ts';

interface RpcResponse {
  id?: number;
  result?: unknown;
  error?: { code: number; message: string };
}

function openApp() {
  const handlers = buildHandlers(mockModel());
  const app = createHttpTransport(handlers).listen({ hostname: '127.0.0.1', port: 0 }) as unknown as {
    server: { port: number; stop: (force?: boolean) => void };
  };
  const base = `http://127.0.0.1:${app.server.port}`;
  const wsUrl = `${base.replace(/^http/, 'ws')}/${CONTROL_API_VERSION}/stream`;
  return { handlers, base, wsUrl, stop: () => app.server.stop(true) };
}

function openWs(url: string): Promise<WebSocket> {
  const ws = new WebSocket(url);
  return new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve(ws), { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
}

// Request/response pairing by id — this suite only needs call/await, not the broadcast frame
// matching control-stream.test.ts uses for push events.
function rpcCaller(ws: WebSocket) {
  let nextId = 0;
  const pending = new Map<number, (res: RpcResponse) => void>();
  ws.addEventListener('message', (ev: MessageEvent) => {
    const msg = JSON.parse(String(ev.data)) as RpcResponse;
    if (msg.id === undefined) return;
    pending.get(msg.id)?.(msg);
    pending.delete(msg.id);
  });
  return (method: string, params: unknown): Promise<RpcResponse> => {
    const id = ++nextId;
    return new Promise((resolve) => {
      pending.set(id, resolve);
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  };
}

describe('sessions.plan.* over JSON-RPC (WebSocket)', () => {
  let stop: (() => void) | undefined;
  let ws: WebSocket | undefined;

  afterEach(() => {
    ws?.close();
    stop?.();
  });

  test('add/list/update/delete round-trip through RPC_HANDLERS attributes to a human actor with no projectMemberId', async () => {
    const app = openApp();
    stop = app.stop;
    ws = await openWs(app.wsUrl);
    const call = rpcCaller(ws);

    const created = await call('sessions.create', { title: 'rpc plan e2e' });
    expect(created.error).toBeUndefined();
    const { sessionId } = created.result as { sessionId: string };

    const added = await call('sessions.plan.todo.add', {
      id: sessionId,
      requestId: 'idem_rpcaddtod010',
      text: 'Ship the RPC wire'
    });
    expect(added.error).toBeUndefined();
    const { todo } = added.result as { todo: { id: string; version: number; sessionId: string; createdBy: unknown } };
    expect(todo).toMatchObject({ sessionId, text: 'Ship the RPC wire', status: 'pending', version: 0 });
    // Default RPC origin (methods.ts `nativeOrigin`): surface 'tui', client 'monad-cli', transport 'http'.
    expect(todo.createdBy).toEqual({ source: { surface: 'tui', client: 'monad-cli', transport: 'http' } });
    expect((todo.createdBy as { projectMemberId?: unknown }).projectMemberId).toBeUndefined();

    const listed = await call('sessions.plan.list', { id: sessionId });
    expect(listed.error).toBeUndefined();
    expect(listed.result).toEqual({ plan: { sessionId, todos: [todo] } });

    const updated = await call('sessions.plan.todo.update', {
      id: sessionId,
      todoId: todo.id,
      requestId: 'idem_rpcupdtod010',
      expectedVersion: 0,
      patch: { status: 'in_progress' }
    });
    expect(updated.error).toBeUndefined();
    expect((updated.result as { todo: { status: string; version: number } }).todo).toMatchObject({
      status: 'in_progress',
      version: 1
    });

    const deleted = await call('sessions.plan.todo.delete', {
      id: sessionId,
      todoId: todo.id,
      requestId: 'idem_rpcdeltod010',
      expectedVersion: 1
    });
    expect(deleted.error).toBeUndefined();
    expect(deleted.result).toEqual({ deleted: true, todoId: todo.id });

    const afterDelete = await call('sessions.plan.list', { id: sessionId });
    expect(afterDelete.result).toEqual({ plan: { sessionId, todos: [] } });

    // Cross-transport parity: state mutated over RPC is visible to a REST read.
    const restRead = await fetch(`${app.base}/v1/sessions/${sessionId}/plan`);
    expect(await restRead.json()).toEqual({ plan: { sessionId, todos: [] } });
  });

  test('an origin hint composes into a full server-built OperationSource, and a stale requestId with a different payload is a stable conflict', async () => {
    const app = openApp();
    stop = app.stop;
    ws = await openWs(app.wsUrl);
    const call = rpcCaller(ws);

    const created = await call('sessions.create', { title: 'rpc plan e2e origin' });
    const { sessionId } = created.result as { sessionId: string };

    const withHint = await call('sessions.plan.todo.add', {
      id: sessionId,
      requestId: 'idem_rpchinttd010',
      text: 'From a hinted client',
      origin: { surface: 'web', client: 'monad-web' }
    });
    expect(withHint.error).toBeUndefined();
    const { todo } = withHint.result as { todo: { createdBy: unknown } };
    // transport is server-stamped 'http' regardless of the hint (RPC socket shares the http write-class).
    expect(todo.createdBy).toEqual({ source: { surface: 'web', client: 'monad-web', transport: 'http' } });

    const conflict = await call('sessions.plan.todo.add', {
      id: sessionId,
      requestId: 'idem_rpchinttd010',
      text: 'Different text, same requestId'
    });
    expect(conflict.error).toMatchObject({ code: -32003 });
    expect(conflict.result).toBeUndefined();

    const listed = await call('sessions.plan.list', { id: sessionId });
    expect((listed.result as { plan: { todos: unknown[] } }).plan.todos).toHaveLength(1);
  });

  test('a channel-origin session accepts sessions.plan.* over RPC', async () => {
    const app = openApp();
    stop = app.stop;
    const at = new Date().toISOString();
    const sessionId = 'ses_rpcplanchn01';
    app.handlers.store.insertSession({
      id: sessionId as never,
      title: 'channel-owned',
      state: 'active',
      agentIds: [],
      archived: false,
      restoreCount: 0,
      activityAt: at,
      createdAt: at,
      updatedAt: at,
      origin: { surface: 'im', client: 'telegram', transport: 'channel' }
    });
    ws = await openWs(app.wsUrl);
    const call = rpcCaller(ws);

    const res = await call('sessions.plan.todo.add', {
      id: sessionId,
      requestId: 'idem_rpcauthz0001',
      text: 'Cross-transport task'
    });

    const todo = (
      res.result as { todo: { createdBy: unknown; sessionId: string; status: string; text: string; version: number } }
    ).todo;
    expect({
      error: res.error,
      todo: {
        createdBy: todo.createdBy,
        sessionId: todo.sessionId,
        status: todo.status,
        text: todo.text,
        version: todo.version
      }
    }).toEqual({
      error: undefined,
      todo: {
        createdBy: { source: { surface: 'tui', client: 'monad-cli', transport: 'http' } },
        sessionId,
        status: 'pending',
        text: 'Cross-transport task',
        version: 0
      }
    });
  });
});
