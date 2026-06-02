if (process.platform !== 'linux') process.exit(0);
if (!Bun.which('bwrap')) process.exit(0);

// Real bwrap enforcement — requires Linux kernel + bubblewrap installed.

import { afterEach, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { configureSandboxLauncher, noneLauncher, sandboxedSpawn } from '@/capabilities/tools';
import { buildBwrapArgs, bwrapLauncher } from '../../../../../packages/atoms/src/sandbox/bwrap.ts';

afterEach(() => configureSandboxLauncher(noneLauncher));

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'monad-bwrap-'));
}

async function runConfined(command: string, writableRoots: string[], net: 'none' | 'unrestricted' = 'unrestricted') {
  configureSandboxLauncher(bwrapLauncher);
  const proc = sandboxedSpawn(['/bin/sh', '-c', command], { stdout: 'pipe', stderr: 'pipe' }, { writableRoots, net });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited
  ]);
  return { stdout, stderr, exitCode };
}

test('a write inside the writable root succeeds', async () => {
  const root = await tmp();
  const r = await runConfined(`echo hi > "${root}/ok.txt" && cat "${root}/ok.txt"`, [root]);
  expect(r.exitCode).toBe(0);
  expect(r.stdout.trim()).toBe('hi');
  expect(existsSync(join(root, 'ok.txt'))).toBe(true);
});

test('a write outside the writable root is blocked', async () => {
  const root = await tmp();
  const outside = await tmp();
  const target = join(outside, 'escape.txt');
  const r = await runConfined(`echo pwned > "${target}"`, [root]);
  expect(r.exitCode).not.toBe(0);
  expect(existsSync(target)).toBe(false);
});

test('writing to the real HOME is blocked when HOME is outside writable roots', async () => {
  const root = await tmp();
  const realHome = Bun.env.HOME ?? tmpdir();
  const probe = join(realHome, '.monad-bwrap-escape-probe');
  const r = await runConfined(`echo leak > "${probe}"`, [root]);
  expect(r.exitCode).not.toBe(0);
  expect(existsSync(probe)).toBe(false);
});

test('net:none blocks an outbound connection', async () => {
  const server = Bun.serve({ port: 0, fetch: () => new Response('reached') });
  try {
    const root = await tmp();
    const r = await runConfined(
      // Use nc/curl/bun whichever is available — just try to connect
      `bun -e 'await fetch("http://127.0.0.1:${server.port}").then(r=>r.text()).then(console.log)' 2>&1 || true`,
      [root],
      'none'
    );
    expect(r.stdout).not.toContain('reached');
  } finally {
    server.stop(true);
  }
});

test('common system utilities are reachable inside the confined sandbox', async () => {
  const root = await tmp();
  // Basic shell commands rely on /usr/bin, /bin etc. being accessible.
  const r = await runConfined('ls /usr/bin/env && echo ok', [root]);
  expect(r.exitCode).toBe(0);
  expect(r.stdout).toContain('ok');
});

test('--die-with-parent flag is present in bwrap invocation args', () => {
  expect(buildBwrapArgs({ writableRoots: ['/work'], net: 'none' })).toContain('--die-with-parent');
});
