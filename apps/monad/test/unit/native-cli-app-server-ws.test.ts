import { expect, test } from 'bun:test';

import { connectAppServerWs } from '@/services/native-cli/app-server-ws.ts';

function stderrWith(line: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(line));
    }
  });
}

test('connectAppServerWs parses the announced port, dials it, and bridges frames both ways', async () => {
  const serverReceived: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      if (srv.upgrade(req)) return undefined;
      return new Response('expected websocket upgrade', { status: 426 });
    },
    websocket: {
      message(ws, message) {
        serverReceived.push(String(message));
        ws.send(JSON.stringify({ id: 0, result: { thread: { id: 'codex-thread-ws' } } }));
      }
    }
  });

  const clientReceived: string[] = [];
  let closed = false;
  try {
    const connection = await connectAppServerWs({
      stderr: stderrWith(`codex app-server (WebSockets)\n  listening on: ws://127.0.0.1:${server.port}\n`),
      onMessage: (text) => clientReceived.push(text),
      onClose: () => {
        closed = true;
      },
      timeoutMs: 2_000
    });

    connection.send(JSON.stringify({ method: 'initialize', id: 0, params: {} }));
    await Bun.sleep(300);

    expect(serverReceived).toEqual([JSON.stringify({ method: 'initialize', id: 0, params: {} })]);
    expect(JSON.parse(clientReceived[0] ?? '')).toEqual({ id: 0, result: { thread: { id: 'codex-thread-ws' } } });

    // A clean our-side close is not an unexpected disconnect, so it must not raise onClose (that
    // signal is reserved for the remote/child dropping the connection).
    connection.close();
    await Bun.sleep(100);
    expect(closed).toBe(false);
  } finally {
    server.stop(true);
  }
});

test('connectAppServerWs raises onClose when the remote drops the connection', async () => {
  const server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      if (srv.upgrade(req)) return undefined;
      return new Response('expected websocket upgrade', { status: 426 });
    },
    websocket: {
      open(ws) {
        ws.close();
      },
      message() {}
    }
  });

  let closed = false;
  try {
    await connectAppServerWs({
      stderr: stderrWith(`listening on: ws://127.0.0.1:${server.port}\n`),
      onMessage: () => {},
      onClose: () => {
        closed = true;
      },
      timeoutMs: 2_000
    });
    await Bun.sleep(200);
    expect(closed).toBe(true);
  } finally {
    server.stop(true);
  }
});

test('connectAppServerWs rejects when the child never announces a port', async () => {
  const stderr = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('starting up, no port yet\n'));
      controller.close();
    }
  });
  await expect(connectAppServerWs({ stderr, onMessage: () => {}, onClose: () => {}, timeoutMs: 500 })).rejects.toThrow(
    /listen port/
  );
});
