import { expect, test } from 'bun:test';

import { bridgeAsyncProcess, sshArgv, waitForSsh } from '../../src/exec/ssh.ts';

test('sshArgv tunnels over the forward-sock and runs the argv with cwd + env in the guest', () => {
  const argv = sshArgv(['echo', 'hi there'], {
    sshSock: '/t/ssh.sock',
    identity: '/t/id_ed25519',
    user: 'monad',
    cwd: '/ws',
    env: { HTTP_PROXY: 'http://192.168.127.254:8080' }
  });
  const j = argv.join(' ');
  // Reaches the guest sshd through the host-local unix socket, not a routable port.
  expect(j).toContain('ProxyCommand=nc -U /t/ssh.sock');
  expect(j).toContain('-i /t/id_ed25519');
  expect(j).toContain('monad@');
  // The remote command cds, exports the env, and execs the argv — the last element is the command.
  const remote = argv[argv.length - 1] as string;
  expect(remote).toContain("cd '/ws'");
  expect(remote).toContain("export HTTP_PROXY='http://192.168.127.254:8080'");
  expect(remote).toContain("exec 'echo' 'hi there'"); // args single-quoted so the guest shell doesn't re-split
});

test('sshArgv disables host-key checking (host-local socket, no MITM surface)', () => {
  const argv = sshArgv(['true'], { sshSock: '/t/s', identity: '/t/i', user: 'monad' });
  const j = argv.join(' ');
  expect(j).toContain('StrictHostKeyChecking=no');
  expect(j).toContain('UserKnownHostsFile=/dev/null');
});

const spec = { sshSock: '/t/s', identity: '/t/i', user: 'monad' };

test('waitForSsh retries until the guest accepts a command', async () => {
  let attempts = 0;
  await waitForSsh(spec, {
    timeoutMs: 100,
    intervalMs: 0,
    probe: async () => ++attempts === 3
  });
  expect(attempts).toBe(3);
});

test('waitForSsh reports a bounded readiness timeout', async () => {
  await expect(waitForSsh(spec, { timeoutMs: 0, intervalMs: 0, probe: async () => false })).rejects.toThrow(
    'guest ssh was not ready'
  );
});

test('bridgeAsyncProcess closes both output streams and preserves the setup error', async () => {
  const proc = bridgeAsyncProcess(async () => {
    await Bun.sleep(0);
    throw new Error('boot failed');
  });
  expect(proc.stdout).toBeDefined();
  expect(proc.stderr).toBeDefined();
  if (!proc.stdout || !proc.stderr) throw new Error('bridge did not expose output streams');

  const [stdout, stderr, exited] = await Promise.allSettled([
    proc.stdout.getReader().read(),
    proc.stderr.getReader().read(),
    proc.exited
  ]);
  expect(stdout).toEqual({ status: 'fulfilled', value: { done: true, value: undefined } });
  expect(stderr).toEqual({ status: 'fulfilled', value: { done: true, value: undefined } });
  expect(exited.status).toBe('rejected');
  expect((exited as PromiseRejectedResult).reason.message).toBe('boot failed');
});
