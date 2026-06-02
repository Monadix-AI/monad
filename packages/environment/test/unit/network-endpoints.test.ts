import { expect, test } from 'bun:test';

import { resolveDaemonNetwork } from '../../src/network-endpoints.ts';

test('endpoint resolution uses the HTTP config default before the home is initialized', () => {
  expect(resolveDaemonNetwork({})).toEqual({
    bindHost: '127.0.0.1',
    connectHost: '127.0.0.1',
    port: 47749,
    scheme: 'http',
    primaryUrl: 'http://127.0.0.1:47749',
    localUrl: 'http://127.0.0.1:47749',
    unixUrl: 'http://localhost'
  });
});
