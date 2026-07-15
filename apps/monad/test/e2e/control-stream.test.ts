// e2e: cross-client sync over the control stream. Two independent WS connections
// to the same daemon — a "TUI" subscribed to the control stream and a "web UI"
// that creates a session. The TUI must see the new session appear without ever
// subscribing to its (yet-unknown) id. This is the multiplexed-push contract that
// REST cannot provide.

import { afterEach, beforeEach, expect, test } from 'bun:test';
import { CONTROL_API_VERSION, type InteractionRequest, type InteractionSource } from '@monad/protocol';

import { HostInteractionService } from '#/interactions/service.ts';
import { createHttpTransport } from '#/transports/http.ts';
import { buildHandlers, listen, mockModel } from '../helpers.ts';

let daemon: { base: string; stop: () => void };
let wsUrl: string;

beforeEach(() => {
  daemon = listen(mockModel());
  wsUrl = `${daemon.base.replace(/^http/, 'ws')}/${CONTROL_API_VERSION}/stream`;
});

afterEach(() => daemon.stop());

/** Open a ws and resolve once it's connected. */
function openWs(): Promise<WebSocket> {
  const ws = new WebSocket(wsUrl);
  return new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve(ws), { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
}

function send(ws: WebSocket, id: number, method: string, params: unknown): void {
  ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
}

/** The slice of a JSON-RPC response/notification frame these tests inspect. */
interface Frame {
  id?: number;
  method?: string;
  result?: { subscribed?: boolean; sessionId?: string };
  params?: {
    event?: {
      interaction?: { id?: string };
      payload?: { title?: string };
      sessionId?: string;
      type?: string;
    };
  };
}

/** Resolve with the first frame whose JSON satisfies `match`. */
function waitFor(ws: WebSocket, match: (msg: Frame) => boolean, timeoutMs = 2000): Promise<Frame> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for frame')), timeoutMs);
    const onMessage = (ev: MessageEvent) => {
      const msg = JSON.parse(String(ev.data)) as Frame;
      if (match(msg)) {
        clearTimeout(timer);
        ws.removeEventListener('message', onMessage);
        resolve(msg);
      }
    };
    ws.addEventListener('message', onMessage);
  });
}

test('a control subscriber sees a session created on another connection', async () => {
  const tui = await openWs();
  const web = await openWs();
  try {
    // TUI subscribes to the control stream and waits for the ack before the web UI acts,
    // so the create cannot race ahead of the subscription.
    send(tui, 1, 'control.subscribe', {});
    await waitFor(tui, (m) => m.id === 1 && m.result?.subscribed === true);

    const created = waitFor(tui, (m) => m.method === 'sessions.event' && m.params?.event?.type === 'session.created');

    // Web UI creates a session over its own connection.
    send(web, 1, 'sessions.create', { title: 'from web ui' });
    const ack = await waitFor(web, (m) => m.id === 1 && m.result?.sessionId != null);

    const evt = await created;
    // The TUI saw the new session's id without ever subscribing to it.
    expect(evt.params?.event?.sessionId).toBe(ack.result?.sessionId);
    expect(evt.params?.event?.payload?.title).toBe('from web ui');
  } finally {
    tui.close();
    web.close();
  }
});

test('a control subscriber sees host interaction events over the websocket', async () => {
  const interactions = new HostInteractionService({ createId: () => 'interaction-ws-1' });
  const app = createHttpTransport(buildHandlers(mockModel()), { interactions }).listen({
    hostname: '127.0.0.1',
    port: 0
  }) as unknown as { server: { port: number; stop: (force?: boolean) => void } };
  const url = `ws://127.0.0.1:${app.server.port}/${CONTROL_API_VERSION}/stream`;
  const ws = new WebSocket(url);
  const source: InteractionSource = { kind: 'atom-pack', packId: 'example.pack', atomId: 'configure' };
  const request: InteractionRequest = { type: 'confirm', title: 'Allow?' };
  try {
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true });
      ws.addEventListener('error', reject, { once: true });
    });

    send(ws, 1, 'control.subscribe', {});
    await waitFor(ws, (m) => m.id === 1 && m.result?.subscribed === true);

    const event = waitFor(
      ws,
      (m) => m.method === 'interactions.event' && m.params?.event?.interaction?.id === 'interaction-ws-1'
    );
    void interactions.request(source, request, { mode: 'foreground' });

    expect((await event).params?.event?.type).toBe('upsert');
  } finally {
    ws.close();
    app.server.stop(true);
  }
});
