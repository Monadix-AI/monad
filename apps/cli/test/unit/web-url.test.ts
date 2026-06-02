import { expect, test } from 'bun:test';

import { resolveUpWebUrl } from '../../src/lib/web-url.ts';

test('resolveUpWebUrl inherits HTTPS for the dev web server', () => {
  expect(resolveUpWebUrl({ daemonUrl: 'https://127.0.0.1:52522', nodeEnv: 'development', webPort: '3000' })).toBe(
    'https://localhost:3000'
  );
});

test('resolveUpWebUrl keeps HTTP when the daemon is explicitly plain HTTP', () => {
  expect(resolveUpWebUrl({ daemonUrl: 'http://127.0.0.1:52522/', nodeEnv: 'development', webPort: '3000' })).toBe(
    'http://localhost:3000'
  );
});

test('resolveUpWebUrl ignores leaked WEB_PORT in production', () => {
  expect(resolveUpWebUrl({ daemonUrl: 'https://127.0.0.1:52522/', nodeEnv: 'production', webPort: '3000' })).toBe(
    'https://127.0.0.1:52522'
  );
});
