import type { ChannelContext } from '@monad/sdk-atom';

import { expect, test } from 'bun:test';

import { serveHttpInbound } from '../../src/channels/_http-inbound.ts';

function fakeCtx(): ChannelContext {
  return {
    onMessage: () => {},
    log: () => {},
    config: { type: 'test', options: {} } as ChannelContext['config'],
    secrets: {},
    signal: new AbortController().signal
  } as ChannelContext;
}

test('serveHttpInbound refuses to start without a verifier (fail closed)', () => {
  const server = serveHttpInbound(fakeCtx(), {
    port: 0,
    path: '/x',
    handle: () => ({ events: [] })
  });
  expect(() => server.start()).toThrow(/unauthenticated webhook listener/);
});

test('serveHttpInbound starts with explicit allowUnverified opt-out', () => {
  const server = serveHttpInbound(fakeCtx(), {
    port: 0,
    path: '/x',
    allowUnverified: true,
    handle: () => ({ events: [] })
  });
  expect(() => server.start()).not.toThrow();
  server.stop();
});
