import type { NetworkSettings } from '@monad/protocol';

import { expect, test } from 'bun:test';

import { localHttpFallbackState, localHttpFallbackUrl } from '../../src/features/settings/network-endpoints';

const baseSettings: NetworkSettings = {
  host: '127.0.0.1',
  port: 52749,
  transport: 'uds',
  https: { enabled: true },
  remoteAccess: { enabled: false, token: null },
  localHttpFallback: { enabled: false, port: 52780 },
  remoteUrls: [],
  restartRequired: false
};

test('local HTTP fallback display is disabled until the listener is enabled', () => {
  expect(localHttpFallbackState(baseSettings)).toBe('disabled');
  expect(localHttpFallbackUrl(baseSettings)).toBeNull();
});

test('local HTTP fallback display requires a matching runtime listener when runtime status is present', () => {
  const enabled = {
    ...baseSettings,
    localHttpFallback: { enabled: true, port: 52780 },
    runtime: {
      listeners: [{ scheme: 'https' as const, host: '127.0.0.1', port: 52749 }],
      remoteAccess: { enabled: false, tokenRevision: 0 }
    }
  };

  expect(localHttpFallbackState(enabled)).toBe('unavailable');
  expect(localHttpFallbackUrl(enabled)).toBeNull();
});

test('local HTTP fallback display returns the URL for the active listener', () => {
  const enabled = {
    ...baseSettings,
    localHttpFallback: { enabled: true, port: 52780 },
    runtime: {
      listeners: [
        { scheme: 'https' as const, host: '127.0.0.1', port: 52749 },
        { scheme: 'http' as const, host: '127.0.0.1', port: 52780 }
      ],
      remoteAccess: { enabled: false, tokenRevision: 0 }
    }
  };

  expect(localHttpFallbackState(enabled)).toBe('listening');
  expect(localHttpFallbackUrl(enabled)).toBe('http://127.0.0.1:52780');
});
