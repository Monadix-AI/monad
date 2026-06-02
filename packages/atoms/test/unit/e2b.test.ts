// The e2b cloud launcher exercised OFFLINE: the e2b SDK is swapped for a fake via the test seam, so
// the full spawn() orchestration (create → stage local files → run + stream → exit → kill) is
// covered end-to-end with no network or API key. Types are the real e2b types, so a signature drift
// in a future e2b version fails the build.

import type { SandboxLauncher } from '@monad/sdk-atom';

import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureSandboxCredential } from '@monad/sdk-atom';

import { __setE2bLoaderForTest, configureE2bApiKey, e2bLauncher } from '../../src/sandbox/e2b.ts';

interface FakeCalls {
  created: { apiKey?: string }[];
  writes: [string, string][];
  ran?: string;
  killed: number;
}

function fakeE2b(calls: FakeCalls, exitCode = 0) {
  const sandbox = {
    files: {
      write: async (p: string, d: string) => {
        calls.writes.push([p, d]);
      }
    },
    commands: {
      run: async (cmd: string, opts: { onStdout?: (d: string) => void; onStderr?: (d: string) => void }) => {
        calls.ran = cmd;
        opts.onStdout?.('out-chunk\n');
        opts.onStderr?.('err-chunk\n');
        return { exitCode, stdout: 'out-chunk\n', stderr: 'err-chunk\n' };
      }
    },
    kill: async () => {
      calls.killed++;
      return true;
    }
  };
  return {
    Sandbox: {
      create: async (opts: { apiKey?: string }) => {
        calls.created.push(opts);
        return sandbox;
      }
    }
  } as unknown as typeof import('e2b');
}

afterEach(() => {
  configureE2bApiKey(undefined);
  configureSandboxCredential(undefined);
  __setE2bLoaderForTest(undefined);
});

test('cloud metadata — any platform, remote-only (spawn, no wrap), isolation declared', () => {
  const l: SandboxLauncher = e2bLauncher;
  expect(l.kind).toBe('e2b');
  expect(l.platforms).toBeUndefined();
  expect(l.wrap).toBeUndefined();
  expect(typeof l.spawn).toBe('function');
  expect(l.enforces).toEqual({
    writeConfine: true,
    readDeny: true,
    net: ['none', 'filtered', 'unrestricted']
  });
});

test('isAvailable() follows the configured API key', () => {
  expect(e2bLauncher.isAvailable?.()).toBe(false);
  configureE2bApiKey('e2b_key');
  expect(e2bLauncher.isAvailable?.()).toBe(true);
});

test('spawn() with no key (neither credential nor configured) throws', () => {
  expect(() => e2bLauncher.spawn?.(['echo', 'hi'], {}, {})).toThrow(/no API key/);
});

test('the daemon-configured sandbox credential drives isAvailable() and spawn()', async () => {
  const calls: FakeCalls = { created: [], writes: [], killed: 0 };
  __setE2bLoaderForTest(() => Promise.resolve(fakeE2b(calls, 0)));
  configureSandboxCredential('e2b_from_daemon');
  expect(e2bLauncher.isAvailable?.()).toBe(true);

  const proc = e2bLauncher.spawn?.(['echo', 'hi'], {}, {});
  if (!proc) return;
  await proc.exited;
  expect(calls.created[0]?.apiKey).toBe('e2b_from_daemon');
});

test('spawn() runs remotely: streams stdout/stderr, resolves exit code, kills the sandbox', async () => {
  const calls: FakeCalls = { created: [], writes: [], killed: 0 };
  __setE2bLoaderForTest(() => Promise.resolve(fakeE2b(calls, 0)));
  configureE2bApiKey('e2b_key');

  const proc = e2bLauncher.spawn?.(['python3', '-c', 'print(1)'], { cwd: '/work' }, {});
  expect(proc).toBeDefined();
  if (!proc) return;

  expect(await new Response(proc.stdout).text()).toBe('out-chunk\n');
  expect(await new Response(proc.stderr).text()).toBe('err-chunk\n');
  expect(await proc.exited).toBe(0);
  expect(proc.exitCode).toBe(0);
  expect(calls.created[0]?.apiKey).toBe('e2b_key');
  expect(calls.killed).toBe(1);
});

test('spawn() takes the per-run credential over the global key, and stages local files to the remote', async () => {
  const calls: FakeCalls = { created: [], writes: [], killed: 0 };
  __setE2bLoaderForTest(() => Promise.resolve(fakeE2b(calls, 0)));

  const dir = await mkdtemp(join(tmpdir(), 'e2b-stage-'));
  const script = join(dir, 'snippet.py');
  await writeFile(script, 'print("hi")');

  const proc = e2bLauncher.spawn?.(['python3', script], { credential: 'e2b_injected' }, {});
  if (!proc) return;
  await proc.exited;

  expect(calls.created[0]?.apiKey).toBe('e2b_injected');
  expect(calls.writes).toEqual([['/home/user/snippet.py', 'print("hi")']]);
  expect(calls.ran).toBe('python3 /home/user/snippet.py');
});

test('reuses ONE remote sandbox across calls in the same session, and disposes it on session end', async () => {
  const calls: FakeCalls = { created: [], writes: [], killed: 0 };
  __setE2bLoaderForTest(() => Promise.resolve(fakeE2b(calls, 0)));
  configureE2bApiKey('e2b_key');

  await e2bLauncher.spawn?.(['echo', '1'], { sessionId: 's1' }, {})?.exited;
  await e2bLauncher.spawn?.(['echo', '2'], { sessionId: 's1' }, {})?.exited;
  expect(calls.created.length).toBe(1);
  expect(calls.killed).toBe(0);

  await e2bLauncher.disposeSession?.('s1');
  expect(calls.killed).toBe(1);
});

test('runs with no sessionId are one-shot: a fresh sandbox per call, killed after', async () => {
  const calls: FakeCalls = { created: [], writes: [], killed: 0 };
  __setE2bLoaderForTest(() => Promise.resolve(fakeE2b(calls, 0)));
  configureE2bApiKey('e2b_key');
  await e2bLauncher.spawn?.(['echo', '1'], {}, {})?.exited;
  await e2bLauncher.spawn?.(['echo', '2'], {}, {})?.exited;
  expect(calls.created.length).toBe(2);
  expect(calls.killed).toBe(2);
});

test('a remote failure surfaces on stderr and exits non-zero (adapter still resolves)', async () => {
  __setE2bLoaderForTest(() =>
    Promise.resolve({
      Sandbox: {
        create: async () => {
          throw new Error('boom');
        }
      }
    } as unknown as typeof import('e2b'))
  );
  configureE2bApiKey('e2b_key');
  const proc = e2bLauncher.spawn?.(['echo', 'hi'], {}, {});
  if (!proc) return;
  expect(await proc.exited).toBe(1);
  expect(await new Response(proc.stderr).text()).toContain('e2b launcher error: boom');
});
