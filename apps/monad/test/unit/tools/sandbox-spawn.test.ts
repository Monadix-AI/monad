import type { SandboxLauncher } from '@monad/sdk-atom';

import { afterEach, expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { isActiveLocalOsSandbox } from '@monad/sandbox';
import { configureSandboxCredential } from '@monad/sdk-atom';

import {
  buildSandboxPolicy,
  configureSandboxExtraEnv,
  configureSandboxLauncher,
  configureSandboxNet,
  configureSandboxProxyEnv,
  noneLauncher,
  sandboxedSpawn,
  sandboxLauncher
} from '#/capabilities/tools';

afterEach(() => {
  configureSandboxLauncher(noneLauncher);
  configureSandboxNet('unrestricted');
  configureSandboxProxyEnv(undefined);
  configureSandboxExtraEnv({});
  configureSandboxCredential(undefined);
});

test('noneLauncher returns argv unchanged', () => {
  expect(noneLauncher.kind).toBe('none');
  expect(noneLauncher.wrap?.(['echo', 'hi'], {})).toEqual(['echo', 'hi']);
});

test('default launcher is none (passthrough)', () => {
  expect(sandboxLauncher().kind).toBe('none');
});

test('isActiveLocalOsSandbox only returns true for local sandboxed roots', () => {
  const fakeLocal: SandboxLauncher = { kind: 'fake-local', wrap: (argv) => argv };
  configureSandboxLauncher(fakeLocal);
  expect(isActiveLocalOsSandbox({ sandboxRoots: ['/work'] })).toBe(true);
  expect(isActiveLocalOsSandbox({ sandboxRoots: undefined })).toBe(false);
  expect(
    isActiveLocalOsSandbox({
      sandboxRoots: ['/work'],
      backends: { terminal: { delegated: true } }
    })
  ).toBe(false);
});

test('sandboxedSpawn passes argv straight through under the none launcher', async () => {
  // Spawn the bun binary itself, not a shell builtin like `echo`: `echo` is not a standalone
  // executable on Windows (it's a cmd/bash builtin), so spawning it directly is ENOENT there.
  const proc = sandboxedSpawn([process.execPath, '-e', 'process.stdout.write("plain")'], { stdout: 'pipe' });
  expect((await new Response(proc.stdout).text()).trim()).toBe('plain');
  expect(await proc.exited).toBe(0);
});

test('a REMOTE launcher (spawn(), no wrap) routes through the seam and returns its SandboxProcess', async () => {
  // Stands in for a cloud launcher (e2b/Vercel): runs off-box, streams output back, no local argv wrap.
  let killed = false;
  const remote: SandboxLauncher = {
    kind: 'fake-cloud',
    isAvailable: () => true,
    spawn: (argv) => ({
      pid: 4242,
      stdout: new Response(`ran: ${argv.join(' ')}`).body ?? undefined,
      stderr: new Response('').body ?? undefined,
      exited: Promise.resolve(0),
      exitCode: 0,
      kill: () => {
        killed = true;
      }
    })
  };
  configureSandboxLauncher(remote);
  const proc = sandboxedSpawn(['echo', 'hi'], { stdout: 'pipe' });
  expect(proc.pid).toBe(4242);
  expect((await new Response(proc.stdout).text()).trim()).toBe('ran: echo hi');
  expect(await proc.exited).toBe(0);
  proc.kill('SIGKILL');
  expect(killed).toBe(true);
});

test('a launcher with neither wrap() nor spawn() throws a clear error', () => {
  configureSandboxLauncher({ kind: 'broken' });
  expect(() => sandboxedSpawn(['echo', 'x'], { stdout: 'pipe' })).toThrow(/neither wrap\(\) nor spawn\(\)/);
});

test('the seam injects the daemon-configured credential into a remote launcher spawn', () => {
  let seen: string | undefined = 'UNSET';
  const remote: SandboxLauncher = {
    kind: 'fake-cloud',
    isAvailable: () => true,
    spawn: (_argv, options) => {
      seen = options.credential;
      return {
        stdout: new Response('').body ?? undefined,
        stderr: new Response('').body ?? undefined,
        exited: Promise.resolve(0),
        exitCode: 0,
        kill: () => {}
      };
    }
  };
  configureSandboxCredential('seam_key');
  configureSandboxLauncher(remote);
  sandboxedSpawn(['echo', 'x'], { stdout: 'pipe' });
  expect(seen).toBe('seam_key');
});

test('the seam threads opts.sessionId into the remote launcher spawn options (per-session reuse)', () => {
  let seen: string | undefined = 'UNSET';
  const remote: SandboxLauncher = {
    kind: 'fake-cloud',
    isAvailable: () => true,
    spawn: (_argv, options) => {
      seen = options.sessionId;
      return {
        stdout: new Response('').body ?? undefined,
        stderr: new Response('').body ?? undefined,
        exited: Promise.resolve(0),
        exitCode: 0,
        kill: () => {}
      };
    }
  };
  configureSandboxLauncher(remote);
  sandboxedSpawn(['echo', 'x'], { stdout: 'pipe' }, {}, { sessionId: 'sess-1' });
  expect(seen).toBe('sess-1');
});

test('buildSandboxPolicy: roots add TMPDIR + extras and take net from config; undefined stays unconfined', () => {
  configureSandboxNet('none');
  const confined = buildSandboxPolicy(['/work'], ['/snippet']);
  expect(confined.net).toBe('none');
  expect(confined.writableRoots).toEqual(['/work', tmpdir(), '/snippet']);

  const unconfined = buildSandboxPolicy(undefined);
  expect(unconfined.net).toBe('none');
});
