import { expect, test } from 'bun:test';
import { mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { connectAppServerUnix } from '#/services/mesh-agent/app-server-unix.ts';

function socketPath(name: string): string {
  const dir = join(realpathSync(tmpdir()), 'monad-appserver-test');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${name}-${process.pid}.sock`);
  rmSync(path, { force: true });
  return path;
}

test('connectAppServerUnix performs the WS upgrade over the socket and bridges frames both ways', async () => {
  const path = socketPath('rt');
  const serverReceived: string[] = [];
  const server = Bun.serve({
    unix: path,
    fetch(req, srv) {
      if (srv.upgrade(req)) return undefined;
      return new Response('expected websocket upgrade', { status: 426 });
    },
    websocket: {
      open(ws) {
        ws.send('server-hello');
      },
      message(ws, message) {
        serverReceived.push(String(message));
        ws.send(JSON.stringify({ id: 0, result: { thread: { id: 'codex-thread-unix' } } }));
      }
    }
  });

  const clientReceived: string[] = [];
  let closed = false;
  try {
    const connection = await connectAppServerUnix({
      socketPath: path,
      onMessage: (text) => clientReceived.push(text),
      onClose: () => {
        closed = true;
      },
      timeoutMs: 3_000
    });

    connection.send(JSON.stringify({ method: 'initialize', id: 0, params: {} }));
    await Bun.sleep(300);

    expect(serverReceived).toEqual([JSON.stringify({ method: 'initialize', id: 0, params: {} })]);

    // A clean our-side close is not an unexpected disconnect → must not raise onClose.
    connection.close();
    await Bun.sleep(100);
    expect(closed).toBe(false);
  } finally {
    server.stop(true);
    rmSync(path, { force: true });
  }
});

test('connectAppServerUnix raises onClose when the remote drops the connection', async () => {
  const path = socketPath('drop');
  const server = Bun.serve({
    unix: path,
    fetch(req, srv) {
      if (srv.upgrade(req)) return undefined;
      return new Response('x', { status: 426 });
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
    await connectAppServerUnix({
      socketPath: path,
      onMessage: () => {},
      onClose: () => {
        closed = true;
      },
      timeoutMs: 3_000
    });
    await Bun.sleep(300);
    expect(closed).toBe(true);
  } finally {
    server.stop(true);
    rmSync(path, { force: true });
  }
});

test('connectAppServerUnix rejects when nothing is listening on the socket', async () => {
  const path = socketPath('missing');
  await expect(
    connectAppServerUnix({ socketPath: path, onMessage: () => {}, onClose: () => {}, timeoutMs: 400 })
  ).rejects.toThrow(/could not connect/);
});
