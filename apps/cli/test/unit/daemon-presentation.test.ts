import { expect, test } from 'bun:test';

import { relayDaemonOutput, resolveDaemonPresentation } from '../../src/lib/daemon.ts';

test('silent daemon lifecycle disables standalone status and startup relay presentation', () => {
  expect({
    defaultPresentation: resolveDaemonPresentation(),
    silentPresentation: resolveDaemonPresentation({ silent: true })
  }).toEqual({
    defaultPresentation: { relayStartup: true, reportLifecycle: true },
    silentPresentation: { relayStartup: false, reportLifecycle: false }
  });
});

test('silent startup relay drains daemon output without forwarding its banner', async () => {
  const writes: string[] = [];
  let pulls = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls++;
      controller.enqueue(new TextEncoder().encode('BRANDED BANNER'));
      controller.close();
    }
  });

  await relayDaemonOutput(stream, false, (value) => writes.push(new TextDecoder().decode(value)));

  expect({ pulls, writes }).toEqual({ pulls: 1, writes: [] });
});

test('startup relay releases an open daemon stream when readiness polling finishes', async () => {
  const abort = new AbortController();
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
    },
    start(controller) {
      controller.enqueue(new TextEncoder().encode('ready'));
    }
  });

  const relay = relayDaemonOutput(stream, false, undefined, abort.signal);
  abort.abort();
  await relay;

  expect(cancelled).toBe(true);
});
