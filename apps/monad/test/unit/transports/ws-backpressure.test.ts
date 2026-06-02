import { expect, test } from 'bun:test';

import { pushBounded, type StreamWs } from '@/transports/http/stream/controller.ts';
import { createConnectionState } from '@/transports/jsonrpc/index.ts';

function fakeWs(buffered: () => number): { ws: StreamWs; sent: string[]; closed: () => boolean } {
  const sent: string[] = [];
  let isClosed = false;
  const ws: StreamWs = {
    send: (d) => {
      sent.push(d);
      return d.length;
    },
    close: () => {
      isClosed = true;
    },
    raw: { getBufferedAmount: buffered }
  };
  return { ws, sent, closed: () => isClosed };
}

test('pushBounded delivers while the socket buffer stays under the cap', () => {
  const { ws, sent, closed } = fakeWs(() => 0); // socket always drained
  const state = createConnectionState();
  for (let i = 0; i < 100; i++) pushBounded(ws, state, { i });
  expect(sent.length).toBe(100);
  expect(closed()).toBe(false);
  expect(state.dropped).toBeFalsy();
});

test('pushBounded drops a consumer whose send buffer exceeds the cap', () => {
  const { ws, closed } = fakeWs(() => 16 * 1024 * 1024); // 16 MiB buffered > 8 MiB cap
  const state = createConnectionState();
  pushBounded(ws, state, { hello: 'world' });
  expect(state.dropped).toBe(true);
  expect(closed()).toBe(true);
});

test('pushBounded is a no-op once the connection is marked dropped', () => {
  const { ws, sent } = fakeWs(() => 0);
  const state = createConnectionState();
  state.dropped = true;
  pushBounded(ws, state, { x: 1 });
  expect(sent.length).toBe(0); // nothing sent on a dropped connection
});

test('pushBounded tolerates a socket with no backpressure API (non-Bun/raw absent)', () => {
  const sent: string[] = [];
  const ws: StreamWs = { send: (d) => sent.push(d) }; // no .raw, no .close
  const state = createConnectionState();
  expect(() => pushBounded(ws, state, { ok: true })).not.toThrow();
  expect(sent.length).toBe(1);
  expect(state.dropped).toBeFalsy();
});
