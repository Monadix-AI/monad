import { expect, test } from 'bun:test';

import { createPushSseResponse, startSseHeartbeat } from '#/transports/http/sessions/sse.ts';

const encoder = new TextEncoder();
const encode = (v: { n: number }): Uint8Array => encoder.encode(`event: t\ndata: ${JSON.stringify(v)}\n\n`);

function bodyReader(res: Response) {
  const reader = res.body?.getReader();
  if (!reader) throw new Error('SSE response has no body');
  return reader;
}

async function readFrames(res: Response): Promise<number[]> {
  const reader = bodyReader(res);
  const decoder = new TextDecoder();
  let buf = '';
  const ns: number[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let sep = buf.indexOf('\n\n');
    while (sep !== -1) {
      const frame = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      const data = frame.split('data: ')[1];
      if (data) ns.push((JSON.parse(data) as { n: number }).n);
      sep = buf.indexOf('\n\n');
    }
  }
  return ns;
}

test('buffers snapshots emitted before the stream opens and flushes them in order', async () => {
  const res = createPushSseResponse<{ n: number }>({
    encoder,
    encode,
    subscribe: (emit) => {
      emit({ n: 1 });
      emit({ n: 2 });
      return { dispose: () => {} };
    }
  });
  // Never marked done and no live emits, so close the producer by disposing via cancel after reading.
  const reader = bodyReader(res);
  const decoder = new TextDecoder();
  const ns: number[] = [];
  for (let i = 0; i < 2; i++) {
    const { value } = await reader.read();
    const data = decoder.decode(value).split('data: ')[1];
    if (data) ns.push((JSON.parse(data.trim()) as { n: number }).n);
  }
  await reader.cancel();
  expect(ns).toEqual([1, 2]);
});

test('flushes a done-marked value then closes the stream and disposes the subscription', async () => {
  let disposed = 0;
  const res = createPushSseResponse<{ n: number }>({
    encoder,
    encode,
    subscribe: (emit) => {
      emit({ n: 1 });
      emit({ n: 2 }, true); // terminal — flush then close
      return { dispose: () => disposed++ };
    }
  });
  expect(await readFrames(res)).toEqual([1, 2]); // read runs to natural close
  expect(disposed).toBe(1);
});

test('delivers a live value emitted after the stream opens', async () => {
  let emit!: (v: { n: number }, done?: boolean) => void;
  const res = createPushSseResponse<{ n: number }>({
    encoder,
    encode,
    subscribe: (fn) => {
      emit = fn;
      emit({ n: 1 });
      return { dispose: () => {} };
    }
  });
  const reader = bodyReader(res);
  const decoder = new TextDecoder();

  const first = await reader.read();
  expect(decoder.decode(first.value)).toContain('"n":1');

  emit({ n: 2 });
  const second = await reader.read();
  expect(decoder.decode(second.value)).toContain('"n":2');
  await reader.cancel();
});

test('disposes the subscription when the client cancels', async () => {
  let disposed = 0;
  const res = createPushSseResponse<{ n: number }>({
    encoder,
    encode,
    subscribe: (emit) => {
      emit({ n: 1 });
      return { dispose: () => disposed++ };
    }
  });
  const reader = bodyReader(res);
  await reader.read();
  await reader.cancel();
  expect(disposed).toBe(1);
});

test('startSseHeartbeat emits keepalive comments on interval and stops when cancelled', async () => {
  const encoder = new TextEncoder();
  let stop: (() => void) | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(ctrl) {
      stop = startSseHeartbeat(ctrl, encoder, 10);
    },
    cancel() {
      stop?.();
    }
  });
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const first = await reader.read();
  const second = await reader.read();
  expect(decoder.decode(first.value)).toContain(': keepalive');
  expect(decoder.decode(second.value)).toContain(': keepalive');
  await reader.cancel(); // triggers stop() → clearInterval
});
