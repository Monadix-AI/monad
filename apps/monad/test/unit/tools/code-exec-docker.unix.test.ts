import { afterEach, expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectDockerRuntime, dockerLauncher, dockerRuntimeAvailable } from '@monad/atoms';

import { configureSandboxLauncher, noneLauncher, sandboxedSpawn } from '@/capabilities/tools';

const runtime = await detectDockerRuntime();
if (!runtime) {
  process.stdout.write('skip: no Docker or Podman detected\n');
  process.exit(0);
}

afterEach(() => configureSandboxLauncher(noneLauncher));

async function runInDocker(argv: string[], writableRoots: string[] = [], net: 'none' | 'unrestricted' = 'none') {
  configureSandboxLauncher(dockerLauncher);
  const proc = sandboxedSpawn(argv, { stdout: 'pipe', stderr: 'pipe' }, { writableRoots, net });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout as ReadableStream).text(),
    new Response(proc.stderr as ReadableStream).text(),
    proc.exited
  ]);
  return { stdout, stderr, exitCode };
}

test('dockerRuntimeAvailable() returns true after detection', () => {
  expect(dockerRuntimeAvailable()).toBe(true);
});

test('basic shell command runs in container', async () => {
  const r = await runInDocker(['/bin/sh', '-c', 'echo hello']);
  expect(r.stdout.trim()).toBe('hello');
  expect(r.exitCode).toBe(0);
}, 60_000);

test('non-zero exit code is preserved', async () => {
  const r = await runInDocker(['/bin/sh', '-c', 'exit 42']);
  expect(r.exitCode).toBe(42);
}, 60_000);

test('network isolation (net:none) blocks outbound', async () => {
  const r = await runInDocker(
    ['/bin/sh', '-c', 'wget -q --timeout=2 http://example.com -O /dev/null 2>&1; echo "exit:$?"'],
    [],
    'none'
  );
  expect(r.stdout).toMatch(/exit:[^0]/);
}, 15_000);

test('host env not leaked into container', async () => {
  process.env.MONAD_SECRET_DOCKER_TEST = 'should-not-appear';
  try {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell variable syntax, not JS template
    const r = await runInDocker(['/bin/sh', '-c', 'echo "${MONAD_SECRET_DOCKER_TEST:-empty}"']);
    expect(r.stdout.trim()).toBe('empty');
  } finally {
    // biome-ignore lint/suspicious/noUndeclaredEnvVars: test-only variable set and deleted here
    delete process.env.MONAD_SECRET_DOCKER_TEST;
  }
}, 60_000);

test('write inside writable root succeeds', async () => {
  const root = join(tmpdir(), 'docker-test-rw');
  await Bun.write(join(root, '.keep'), '');
  const r = await runInDocker(['/bin/sh', '-c', `echo ok > ${root}/out.txt && cat ${root}/out.txt`], [root]);
  expect(r.stdout.trim()).toBe('ok');
  expect(r.exitCode).toBe(0);
}, 60_000);

test('stderr is captured separately', async () => {
  const r = await runInDocker(['/bin/sh', '-c', 'echo out; echo err >&2']);
  expect(r.stdout.trim()).toBe('out');
  expect(r.stderr.trim()).toContain('err');
}, 60_000);
