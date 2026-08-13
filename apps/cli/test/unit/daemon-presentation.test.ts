import { expect, test } from 'bun:test';
import { DAEMON_STARTUP_READY_MARKER } from '@monad/protocol';

import {
  isDaemonReachable,
  parseDaemonStartupOutput,
  relayDaemonOutput,
  resolveDaemonPresentation
} from '../../src/lib/daemon.ts';

test('daemon reachability treats a partially written first-run config as not ready', async () => {
  const reachable = await isDaemonReachable(async () => {
    throw new Error('monad: agents.json is missing at /home/user/.monad/configs/agents.json.');
  });

  expect(reachable).toBe(false);
});

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

test('startup relay waits for a split completion marker and keeps it out of terminal output', async () => {
  const writes: Uint8Array[] = [];
  const markerSplit = Math.floor(DAEMON_STARTUP_READY_MARKER.length / 2);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`banner\n${DAEMON_STARTUP_READY_MARKER.slice(0, markerSplit)}`));
      controller.enqueue(new TextEncoder().encode(DAEMON_STARTUP_READY_MARKER.slice(markerSplit)));
    }
  });

  const complete = await relayDaemonOutput(stream, true, (value) => writes.push(value), undefined, {
    marker: DAEMON_STARTUP_READY_MARKER
  });

  expect({ complete, output: new TextDecoder().decode(Buffer.concat(writes)) }).toEqual({
    complete: true,
    output: 'banner\n'
  });
});

test('release startup output removes the completion marker before presenting the banner', () => {
  expect(parseDaemonStartupOutput(`banner\n${DAEMON_STARTUP_READY_MARKER}`)).toEqual({
    complete: true,
    output: 'banner\n'
  });
});

test('supervisor forwards the completion marker into the release startup output file', async () => {
  const writes: Uint8Array[] = [];
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`banner\n${DAEMON_STARTUP_READY_MARKER}`));
    }
  });

  const complete = await relayDaemonOutput(stream, true, (value) => writes.push(value), undefined, {
    forwardMarker: true,
    marker: DAEMON_STARTUP_READY_MARKER
  });

  expect({ complete, output: new TextDecoder().decode(Buffer.concat(writes)) }).toEqual({
    complete: true,
    output: `banner\n${DAEMON_STARTUP_READY_MARKER}`
  });
});
