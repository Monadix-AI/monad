import { expect, test } from 'bun:test';

import { formatWebUiReadyValue } from '@/infra/banner.ts';

test('formatWebUiReadyValue combines dev Web UI and daemon API on one line', () => {
  expect(
    formatWebUiReadyValue({
      webUrl: 'https://localhost:3000',
      daemonUrl: 'https://127.0.0.1:52522'
    })
  ).toBe('https://localhost:3000  (Daemon API: https://127.0.0.1:52522)');
});

test('formatWebUiReadyValue omits daemon API when release serves the web UI from the daemon', () => {
  expect(
    formatWebUiReadyValue({
      webUrl: 'https://127.0.0.1:52522/',
      daemonUrl: 'https://127.0.0.1:52522'
    })
  ).toBe('https://127.0.0.1:52522/');
});
