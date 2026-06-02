if (process.platform !== 'darwin') process.exit(0);

import type { SandboxPolicy } from '@/capabilities/tools';

import { afterEach, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { configureSandboxLauncher, noneLauncher, sandboxedSpawn } from '@/capabilities/tools';
import { seatbeltLauncher } from '../../../../../packages/atoms/src/sandbox/seatbelt.ts';

// Real Seatbelt enforcement — requires the macOS kernel.

afterEach(() => configureSandboxLauncher(noneLauncher));

async function runConfined(command: string, policy: Partial<SandboxPolicy> & { writableRoots: string[] }) {
  configureSandboxLauncher(seatbeltLauncher);
  const proc = sandboxedSpawn(
    ['/bin/sh', '-c', command],
    { stdout: 'pipe', stderr: 'pipe' },
    {
      net: 'none',
      ...policy
    }
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited
  ]);
  return { stdout, stderr, exitCode };
}

test('a write inside the writable root succeeds', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sb-in-')));
  const r = await runConfined(`echo hi > "${root}/ok.txt" && cat "${root}/ok.txt"`, { writableRoots: [root] });
  expect(r.exitCode).toBe(0);
  expect(r.stdout.trim()).toBe('hi');
  expect(existsSync(join(root, 'ok.txt'))).toBe(true);
});

test('a write OUTSIDE the writable root is blocked by the kernel', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sb-root-')));
  const outside = await realpath(await mkdtemp(join(tmpdir(), 'sb-out-')));
  const target = join(outside, 'escape.txt');
  const r = await runConfined(`echo pwned > "${target}"`, { writableRoots: [root] });
  expect(r.exitCode).not.toBe(0);
  expect(existsSync(target)).toBe(false);
});

test('writing to a daemon-private path (~/.ssh sibling) is blocked', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sb-home-')));
  const target = join(Bun.env.HOME ?? tmpdir(), '.monad-seatbelt-escape-probe');
  const r = await runConfined(`echo leak > "${target}"`, { writableRoots: [root] });
  expect(r.exitCode).not.toBe(0);
  expect(existsSync(target)).toBe(false);
});

test('a confined child can write into its redirected $HOME/.cache (pip/npm work)', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sb-home-')));
  const r = await runConfined(
    'mkdir -p "$HOME/.cache/pkg" && echo ok > "$HOME/.cache/pkg/probe" && cat "$HOME/.cache/pkg/probe"',
    { writableRoots: [root], net: 'unrestricted' }
  );
  expect(r.exitCode).toBe(0);
  expect(r.stdout.trim()).toBe('ok');
  expect(existsSync(join(root, '.cache/pkg/probe'))).toBe(true);
});

test('readDenyRoots blocks reading a credential-like directory', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sb-wr-')));
  const secrets = await realpath(await mkdtemp(join(tmpdir(), 'sb-sec-')));
  await Bun.write(join(secrets, 'token'), 'SUPER_SECRET');

  // Without readDenyRoots: the file is readable.
  const open = await runConfined(`cat "${join(secrets, 'token')}"`, {
    writableRoots: [root],
    net: 'unrestricted'
  });
  expect(open.exitCode).toBe(0);
  expect(open.stdout.trim()).toBe('SUPER_SECRET');

  // With readDenyRoots: the kernel denies the read (last-match-wins in SBPL).
  const denied = await runConfined(`cat "${join(secrets, 'token')}" 2>&1`, {
    writableRoots: [root],
    net: 'unrestricted',
    readDenyRoots: [secrets]
  });
  expect(denied.exitCode).not.toBe(0);
  expect(denied.stdout).not.toContain('SUPER_SECRET');
});

test('net:none blocks an outbound connection to a local server', async () => {
  const server = Bun.serve({ port: 0, fetch: () => new Response('reached') });
  const serverPort = Number(server.port);
  try {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'sb-net-')));
    const r = await runConfined(
      `bun -e 'const res = await fetch("http://127.0.0.1:${serverPort}"); console.log(await res.text())' 2>&1`,
      { writableRoots: [root], net: 'none' }
    );
    expect(r.stdout).not.toContain('reached');
  } finally {
    server.stop(true);
  }
});

test('proxy-only net allows traffic to the proxy port and blocks everything else', async () => {
  const origin = Bun.serve({ port: 0, fetch: () => new Response('from-origin') });
  const restricted = Bun.serve({ port: 0, fetch: () => new Response('should-not-arrive') });
  const originPort = Number(origin.port);
  const restrictedPort = Number(restricted.port);
  try {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'sb-proxy-')));
    // Proxy port is originPort; confined child can only reach that port.
    const r = await runConfined(
      [
        `bun -e 'fetch("http://127.0.0.1:${originPort}").then(r=>r.text()).then(console.log).catch(()=>console.log("origin-denied"))' 2>&1`,
        `bun -e 'fetch("http://127.0.0.1:${restrictedPort}").then(r=>r.text()).then(console.log).catch(()=>console.log("restricted-denied"))' 2>&1`
      ].join(' & wait; '),
      { writableRoots: [root], net: { allowProxyPort: originPort } }
    );
    expect(r.stdout).toContain('from-origin');
    expect(r.stdout).not.toContain('should-not-arrive');
  } finally {
    origin.stop(true);
    restricted.stop(true);
  }
});
