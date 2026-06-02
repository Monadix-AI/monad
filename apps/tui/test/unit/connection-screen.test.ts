import type { NetworkSettings } from '@monad/protocol';

import { expect, test } from 'bun:test';

import { connectionInputAction } from '../../src/components/OperationalScreens.tsx';

const settings: NetworkSettings = {
  host: '127.0.0.1',
  https: { enabled: true },
  localHttpFallback: { enabled: false, port: 47780 },
  port: 52749,
  remoteAccess: { enabled: true, token: 'secret' },
  remoteUrls: [],
  restartRequired: false,
  transport: 'uds'
};

test('TUI requires a second explicit keypress before remote HTTP', () => {
  expect(connectionInputAction('h', settings, false)).toEqual({ kind: 'confirm' });
  expect(connectionInputAction('n', settings, true)).toEqual({ kind: 'cancel' });
  expect(connectionInputAction('y', settings, true)).toEqual({
    kind: 'request',
    request: { confirmInsecureRemoteAccess: true, https: { enabled: false } }
  });
});

test('TUI connection input ignores unrelated keys instead of growing a second network settings surface', () => {
  expect(connectionInputAction('r', settings, false)).toEqual({ kind: 'none' });
});
