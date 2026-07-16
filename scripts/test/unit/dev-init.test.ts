import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildDevInitSummary,
  buildDevStepProgressFrame,
  buildDevStepStatusFrame,
  buildGeneratedArtifactProgressFrame,
  buildGeneratedArtifactStatusFrame,
  codeGraphStatus,
  devCliShimText,
  ensurePortLines,
  isExpectedPhoenixImage,
  portOffset,
  postCheckoutHookText,
  removeBlankXdgLines,
  resolvePhoenixContainerImage,
  shouldRenderDevInitCommandSpinner,
  withSharedDirectoryLock,
  worktreePorts
} from '../../dev-init.ts';

test('devCliShimText forwards POSIX arguments to the worktree CLI entry point', () => {
  expect(devCliShimText('/repo with space', 'darwin')).toBe(
    `#!/bin/sh\nexec bun '/repo with space/apps/cli/src/bin.ts' "$@"\n`
  );
});

test('devCliShimText forwards Windows arguments to the worktree CLI entry point', () => {
  expect(devCliShimText('C:\\repo', 'win32')).toBe('@echo off\r\nbun "C:\\repo\\apps\\cli\\src\\bin.ts" %*\r\n');
});

test('bun install initializes the worktree without auto-authorizing direnv', async () => {
  const root = new URL('../../../', import.meta.url);
  const packageJson = await Bun.file(new URL('package.json', root)).json();
  const envrc = await Bun.file(new URL('.envrc', root)).text();

  expect(packageJson.scripts?.postinstall).toBe('bun run scripts/dev-init.ts');
  expect(envrc).toMatch(/^PATH_add \.dev\/bin$/m);
  expect(envrc).toMatch(/^\[\[ -f \.env\.local \]\] && dotenv \.env\.local$/m);
  expect(envrc).not.toMatch(/^\s*direnv allow\s*$/m);
});

test('portOffset is deterministic and within 0–999', () => {
  const a = portOffset('/Users/x/Projects/monad');
  expect(a).toBe(portOffset('/Users/x/Projects/monad')); // stable
  expect(a).toBeGreaterThanOrEqual(0);
  expect(a).toBeLessThan(1000);
});

test('different worktree paths get different ports', () => {
  const p1 = worktreePorts('/Users/x/Projects/monad');
  const p2 = worktreePorts('/Users/x/Projects/monad-feature');
  expect(p1.MONAD_PORT).not.toBe(p2.MONAD_PORT);
  expect(p1.MONAD_HTTP_PORT).not.toBe(p2.MONAD_HTTP_PORT);
  expect(p1.WEB_PORT).not.toBe(p2.WEB_PORT);
  expect(p1.WEB_STORYBOOK_PORT).not.toBe(p2.WEB_STORYBOOK_PORT);
  expect(p1.UI_STORYBOOK_PORT).not.toBe(p2.UI_STORYBOOK_PORT);
  expect(p1.MONAD_KV_UI_PORT).not.toBe(p2.MONAD_KV_UI_PORT);
  expect(p1.AI_SDK_DEVTOOLS_PORT).not.toBe(p2.AI_SDK_DEVTOOLS_PORT);
});

test('ports land in their documented non-overlapping ranges', () => {
  const p = worktreePorts('/some/worktree');
  expect(Number(p.MONAD_PORT)).toBeGreaterThanOrEqual(52000);
  expect(Number(p.MONAD_PORT)).toBeLessThan(53000);
  expect(Number(p.MONAD_HTTP_PORT)).toBeGreaterThanOrEqual(53000);
  expect(Number(p.MONAD_HTTP_PORT)).toBeLessThan(54000);
  expect(Number(p.WEB_PORT)).toBeGreaterThanOrEqual(3100);
  expect(Number(p.WEB_PORT)).toBeLessThan(4100);
  expect(Number(p.WEB_STORYBOOK_PORT)).toBeGreaterThanOrEqual(4100);
  expect(Number(p.WEB_STORYBOOK_PORT)).toBeLessThan(5100);
  expect(Number(p.UI_STORYBOOK_PORT)).toBeGreaterThanOrEqual(8400);
  expect(Number(p.UI_STORYBOOK_PORT)).toBeLessThan(9400);
  expect(Number(p.MONAD_KV_UI_PORT)).toBeGreaterThanOrEqual(6400);
  expect(Number(p.MONAD_KV_UI_PORT)).toBeLessThan(7400);
  expect(Number(p.AI_SDK_DEVTOOLS_PORT)).toBeGreaterThanOrEqual(7400);
  expect(Number(p.AI_SDK_DEVTOOLS_PORT)).toBeLessThan(8400);
});

test('ensurePortLines appends all ports to a file missing them', () => {
  const ports = worktreePorts('/wt');
  const { text, added } = ensurePortLines('MONAD_HOME=/wt/.dev/.monad\nOPENROUTER_API_KEY=sk\n', ports);
  expect(added).toEqual([
    `MONAD_PORT=${ports.MONAD_PORT}`,
    `MONAD_HTTP_PORT=${ports.MONAD_HTTP_PORT}`,
    `WEB_PORT=${ports.WEB_PORT}`,
    `WEB_STORYBOOK_PORT=${ports.WEB_STORYBOOK_PORT}`,
    `MONAD_KV_UI_PORT=${ports.MONAD_KV_UI_PORT}`,
    `AI_SDK_DEVTOOLS_PORT=${ports.AI_SDK_DEVTOOLS_PORT}`,
    `UI_STORYBOOK_PORT=${ports.UI_STORYBOOK_PORT}`
  ]);
  expect(text).toContain(`MONAD_PORT=${ports.MONAD_PORT}\n`);
});

test('ensurePortLines is idempotent — a second pass adds nothing and never duplicates', () => {
  const ports = worktreePorts('/wt');
  const first = ensurePortLines('MONAD_HOME=/wt\n', ports);
  const second = ensurePortLines(first.text, ports);
  expect((second.text.match(/^MONAD_PORT=/gm) ?? []).length).toBe(1);
});

test('ensurePortLines never clobbers a hand-set value', () => {
  const ports = worktreePorts('/wt');
  const { text, added } = ensurePortLines('WEB_PORT=9999\n', ports);
  expect(added).not.toContain(`WEB_PORT=${ports.WEB_PORT}`); // existing value respected
  expect(text).not.toContain(`WEB_PORT=${ports.WEB_PORT}`);
});

test('ensurePortLines treats a blank assignment as absent', () => {
  const ports = worktreePorts('/wt');
  const { added } = ensurePortLines('MONAD_PORT=\n', ports);
  expect(added).toContain(`MONAD_PORT=${ports.MONAD_PORT}`);
});

test('ensurePortLines inserts a newline before appending when the file lacks a trailing one', () => {
  const ports = worktreePorts('/wt');
  const { text } = ensurePortLines('MONAD_HOME=/wt', ports);
  expect(text.startsWith('MONAD_HOME=/wt\nMONAD_PORT=')).toBe(true);
});

test('removeBlankXdgLines removes empty optional XDG assignments', () => {
  const { text, removed } = removeBlankXdgLines('MONAD_HOME=/wt\nXDG_CACHE_HOME=\nXDG_DATA_HOME=""\nWEB_PORT=3000\n');
  expect(text).toBe('MONAD_HOME=/wt\nWEB_PORT=3000\n');
  expect(removed).toEqual(['XDG_CACHE_HOME', 'XDG_DATA_HOME']);
});

test('removeBlankXdgLines preserves real XDG overrides and comments', () => {
  const { text, removed } = removeBlankXdgLines('# XDG_CACHE_HOME=/tmp/cache\nXDG_CACHE_HOME=/tmp/cache\n');
  expect(text).toBe('# XDG_CACHE_HOME=/tmp/cache\nXDG_CACHE_HOME=/tmp/cache\n');
  expect(removed).toEqual([]);
});

test('CodeGraph status leaves indexing as an explicit project-owner action', () => {
  expect(codeGraphStatus(false, false)).toBe('unavailable');
  expect(codeGraphStatus(true, false)).toBe('available-unindexed');
  expect(codeGraphStatus(true, true)).toBe('indexed');
});

test('postCheckoutHookText runs monad bootstrap before lefthook', () => {
  const hook = postCheckoutHookText();
  expect(hook.indexOf('scripts/git-hooks/post-checkout.sh')).toBeLessThan(hook.indexOf('lefthook run "post-checkout"'));
});

test('buildDevInitSummary groups the initialized dev environment for terminal output', () => {
  const lines = buildDevInitSummary({
    apiKeySet: false,
    monadHome: '/repo/.dev/.monad',
    otelUiUrl: 'http://localhost:6006',
    ports: {
      AI_SDK_DEVTOOLS_PORT: '7401',
      MONAD_KV_UI_PORT: '6401',
      MONAD_HTTP_PORT: '53001',
      MONAD_PORT: '52001',
      UI_STORYBOOK_PORT: '8401',
      WEB_PORT: '3101',
      WEB_STORYBOOK_PORT: '4101'
    }
  });

  expect(lines).toEqual([
    '',
    'Monad dev init',
    'Environment',
    '  Data directory    /repo/.dev/.monad',
    '  API key           not set - add apiKey to packages/home/config.init.json',
    'Ports',
    '  Daemon API        https://127.0.0.1:52001',
    '  Local HTTP        http://127.0.0.1:53001',
    '  Web app           http://127.0.0.1:3101',
    '  Web Storybook     http://127.0.0.1:4101',
    '  UI Storybook      http://127.0.0.1:8401',
    '  KV inspector      http://127.0.0.1:6401',
    '  AI SDK DevTools   http://127.0.0.1:7401',
    'Runtime URL priority',
    '  Daemon proxy      MONAD_URL > config network.host/https/port',
    'Services',
    '  Phoenix / OTel    http://localhost:6006',
    ''
  ]);
});

test('dev-init summary can be colorized for terminal output', () => {
  const lines = buildDevInitSummary(
    {
      apiKeySet: true,
      monadHome: '/repo/.dev/.monad',
      ports: {
        AI_SDK_DEVTOOLS_PORT: '7401',
        MONAD_HTTP_PORT: '53001',
        MONAD_KV_UI_PORT: '6401',
        MONAD_PORT: '52001',
        UI_STORYBOOK_PORT: '8401',
        WEB_PORT: '3101',
        WEB_STORYBOOK_PORT: '4101'
      }
    },
    { color: true }
  );

  expect(lines.join('\n')).toContain('\u001b[');
  expect(lines.join('\n')).toContain('Monad dev init');
});

test('dev-init step frames support generic progress animation', () => {
  expect(
    buildDevStepProgressFrame({
      color: false,
      frame: '/',
      label: 'Phoenix',
      target: 'http://localhost:6006',
      verb: 'checking'
    })
  ).toBe('\r[dev-init] / checking Phoenix -> http://localhost:6006');
  expect(
    buildDevStepStatusFrame({
      color: false,
      label: 'Phoenix',
      state: 'done',
      target: 'http://localhost:6006',
      tty: true,
      verb: 'ready'
    })
  ).toBe('[dev-init] ready Phoenix -> http://localhost:6006\n');
});

test('dev-init command steps only render Monad progress animation when output is piped', () => {
  expect(shouldRenderDevInitCommandSpinner('pipe', true)).toBe(true);
  expect(shouldRenderDevInitCommandSpinner('inherit', true)).toBe(false);
  expect(shouldRenderDevInitCommandSpinner('pipe', false)).toBe(false);
});

test('Phoenix only reuses the expected shared image', () => {
  expect(isExpectedPhoenixImage('arizephoenix/phoenix')).toBe(true);
  expect(isExpectedPhoenixImage('arizephoenix/phoenix:latest')).toBe(true);
  expect(isExpectedPhoenixImage('docker.io/arizephoenix/phoenix:latest')).toBe(true);
  expect(isExpectedPhoenixImage('other/image:latest')).toBe(false);
});

test('Phoenix identity falls back to the container list when inspect cannot read stale state', () => {
  expect(resolvePhoenixContainerImage('', 'docker.io/arizephoenix/phoenix:latest')).toBe(
    'docker.io/arizephoenix/phoenix:latest'
  );
  expect(resolvePhoenixContainerImage('arizephoenix/phoenix:latest', 'other/image')).toBe(
    'arizephoenix/phoenix:latest'
  );
});

test('shared service lock is released after the initializer finishes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'monad-dev-init-lock-'));
  const lockPath = join(dir, 'phoenix.lock');
  try {
    const value = await withSharedDirectoryLock(lockPath, async () => {
      expect(existsSync(lockPath)).toBe(true);
      return 'ready';
    });
    expect(value).toBe('ready');
    expect(existsSync(lockPath)).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('generated artifact progress frame is an overwrite-only terminal animation frame', () => {
  expect(
    buildGeneratedArtifactProgressFrame({
      color: false,
      frame: '|',
      label: 'Avatar styles',
      target: 'packages/protocol/generated/avatar-styles.ts'
    })
  ).toBe('\r[dev-init] | generating Avatar styles -> packages/protocol/generated/avatar-styles.ts');
});

test('generated artifact status frames emit one final visible line per artifact', () => {
  const artifact = {
    color: false,
    label: 'Avatar styles',
    target: 'packages/protocol/generated/avatar-styles.ts'
  };

  expect(buildGeneratedArtifactStatusFrame({ ...artifact, state: 'running', tty: true })).toBe('');
  expect(buildGeneratedArtifactStatusFrame({ ...artifact, state: 'done', tty: true })).toBe(
    '[dev-init] generated Avatar styles -> packages/protocol/generated/avatar-styles.ts\n'
  );
  expect(buildGeneratedArtifactStatusFrame({ ...artifact, state: 'running', tty: false })).toBe('');
  expect(buildGeneratedArtifactStatusFrame({ ...artifact, state: 'done', tty: false })).toBe(
    '[dev-init] generated Avatar styles -> packages/protocol/generated/avatar-styles.ts\n'
  );
});

test('dev-init regenerates Codex app-server protocol artifacts', async () => {
  const source = await Bun.file(new URL('../../dev-init.ts', import.meta.url)).text();
  expect(source).toContain('scripts/generate-codex-app-server-protocol.ts');
});
