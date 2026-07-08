import { expect, test } from 'bun:test';

import { formatReadyInfoTable, formatReadyPath, formatWebUiReadyValue } from '#/infra/banner.ts';

function stripAnsi(value: string): string {
  return value.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '');
}

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

test('formatReadyInfoTable wraps long values under the value column', () => {
  expect(
    stripAnsi(
      formatReadyInfoTable(
        [
          ['Web UI:', 'https://localhost:3158  (Daemon API: https://127.0.0.1:52058)'],
          ['Unix socket:', '/Users/zeke/.codex/worktrees/4fc5/monad/.dev/.monad/runtime/monad.sock'],
          ['Configure providers:', '/Users/zeke/.codex/worktrees/4fc5/monad/.dev/.monad/configs/config.json']
        ],
        64
      )
    )
  ).toBe(
    [
      '  Web UI:                 https://localhost:3158  (Daemon API:',
      '                          https://127.0.0.1:52058)',
      '  Unix socket:            /Users/zeke/.codex/worktrees/4fc5/',
      '                          monad/.dev/.monad/runtime/monad.sock',
      '  Configure providers:    /Users/zeke/.codex/worktrees/4fc5/',
      '                          monad/.dev/.monad/configs/config.json'
    ].join('\n')
  );
});

test('formatReadyPath renders home paths with tilde', () => {
  expect(
    formatReadyPath('/Users/zeke/.codex/worktrees/4fc5/monad/.dev/.monad/configs/config.json', '/Users/zeke')
  ).toBe('~/.codex/worktrees/4fc5/monad/.dev/.monad/configs/config.json');
  expect(formatReadyPath('/tmp/monad.sock', '/Users/zeke')).toBe('/tmp/monad.sock');
});
