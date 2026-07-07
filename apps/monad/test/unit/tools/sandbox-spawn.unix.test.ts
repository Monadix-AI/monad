if (process.platform === 'win32') process.exit(0);

import { afterEach, expect, test } from 'bun:test';

import {
  configureSandboxExtraEnv,
  configureSandboxLauncher,
  configureSandboxNet,
  configureSandboxProxyEnv,
  noneLauncher,
  type SandboxLauncher,
  type SandboxPolicy,
  sandboxedSpawn,
  sandboxHomeEnv,
  sandboxLauncher
} from '@/capabilities/tools';

// The sandbox env/launcher model is POSIX-only: HOME/XDG_CACHE_HOME redirection,
// /bin/sh + /usr/bin/env probes. Windows has no launcher yet.

afterEach(() => {
  configureSandboxLauncher(noneLauncher);
  configureSandboxNet('unrestricted');
  configureSandboxProxyEnv(undefined);
  configureSandboxExtraEnv({});
});

test('sandboxHomeEnv: redirects HOME and package caches under the writable root', () => {
  const env = sandboxHomeEnv('/work/sbx');
  expect(env.HOME).toBe('/work/sbx');
  expect(env.XDG_CACHE_HOME).toBe('/work/sbx/.cache');
  expect(env.npm_config_cache).toBe('/work/sbx/.npm');
  expect(env.PIP_CACHE_DIR).toBe('/work/sbx/.cache/pip');
});

test('a confined spawn gets HOME pointed at the writable root; an unconfined one keeps real HOME', async () => {
  const realHome = Bun.env.HOME;
  const cmd = ['/bin/sh', '-c', 'printf "%s" "$HOME"'];

  configureSandboxLauncher({ kind: 'landlock', wrap: (a) => a });
  const confined = sandboxedSpawn(cmd, { stdout: 'pipe' }, { writableRoots: ['/tmp'] });
  expect((await new Response(confined.stdout).text()).startsWith('/tmp')).toBe(true);

  configureSandboxLauncher(noneLauncher);
  const plain = sandboxedSpawn(cmd, { stdout: 'pipe' }, { writableRoots: ['/tmp'] });
  expect(await new Response(plain.stdout).text()).toBe(realHome ?? '');
});

test('configureSandboxProxyEnv: proxy vars are injected into the child, inherited env preserved', async () => {
  configureSandboxProxyEnv({ HTTPS_PROXY: 'http://127.0.0.1:9' });
  const proc = sandboxedSpawn(['/bin/sh', '-c', 'printf "%s|%s" "$HTTPS_PROXY" "$PATH"'], { stdout: 'pipe' }, {});
  const out = await new Response(proc.stdout).text();
  const [proxy, path] = out.split('|');
  expect(proxy).toBe('http://127.0.0.1:9');
  expect(path?.length ?? 0).toBeGreaterThan(0);
});

test('configureSandboxExtraEnv: static env vars reach the child', async () => {
  configureSandboxExtraEnv({ MY_API_BASE: 'https://api.example.com', MY_LOCALE: 'zh' });
  const proc = sandboxedSpawn(['/bin/sh', '-c', 'printf "%s|%s" "$MY_API_BASE" "$MY_LOCALE"'], { stdout: 'pipe' }, {});
  const out = (await new Response(proc.stdout).text()).trim();
  expect(out).toBe('https://api.example.com|zh');
});

test('proxyEnv overrides extraEnv for the same key', async () => {
  configureSandboxExtraEnv({ HTTPS_PROXY: 'http://extra:1' });
  configureSandboxProxyEnv({ HTTPS_PROXY: 'http://proxy:2' });
  const proc = sandboxedSpawn(['/bin/sh', '-c', 'printf "%s" "$HTTPS_PROXY"'], { stdout: 'pipe' }, {});
  expect((await new Response(proc.stdout).text()).trim()).toBe('http://proxy:2');
});

test('configureSandboxLauncher: the active launcher rewrites argv and receives the policy', async () => {
  let seenArgv: string[] | undefined;
  let seenPolicy: SandboxPolicy | undefined;
  const recording: SandboxLauncher = {
    kind: 'seatbelt',
    wrap(argv, policy) {
      seenArgv = argv;
      seenPolicy = policy;
      return ['/usr/bin/env', ...argv];
    }
  };
  configureSandboxLauncher(recording);
  expect(sandboxLauncher().kind).toBe('seatbelt');

  const policy: SandboxPolicy = { writableRoots: ['/tmp/x'], net: 'none' };
  const _proc = sandboxedSpawn(['echo', 'wrapped'], { stdout: 'pipe' }, policy);

  expect(seenArgv).toEqual(['echo', 'wrapped']);
  expect(seenPolicy).toEqual(policy);
});
