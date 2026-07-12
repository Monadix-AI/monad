import type { SandboxProcess } from '@monad/sdk-atom';

import { expect, test } from 'bun:test';

import { bridgeAsyncProcess, sshArgv, waitForSsh } from '../../src/exec/ssh.ts';

test('sshArgv tunnels over the forward-sock and runs the argv with cwd + env in the guest', () => {
  const argv = sshArgv(['echo', 'hi there'], {
    sshHostPort: 52999,
    identity: '/t/id_ed25519',
    user: 'monad',
    cwd: '/ws',
    env: { HTTP_PROXY: 'http://192.168.127.254:8080' }
  });
  const j = argv.join(' ');
  // Reaches the guest sshd via gvproxy's host-loopback forward port.
  expect(j).toContain('-p 52999');
  expect(j).toContain('-i /t/id_ed25519');
  expect(j).toContain('monad@127.0.0.1');
  // The remote command cds, exports the env, and execs the argv — the last element is the command.
  const remote = argv[argv.length - 1] as string;
  expect(remote).toContain("cd '/ws'");
  expect(remote).toContain("export HTTP_PROXY='http://192.168.127.254:8080'");
  expect(remote).toContain("exec 'echo' 'hi there'"); // args single-quoted so the guest shell doesn't re-split
});

test('sshArgv disables host-key checking (host-local socket, no MITM surface)', () => {
  const argv = sshArgv(['true'], { sshHostPort: 52999, identity: '/t/i', user: 'monad' });
  const j = argv.join(' ');
  expect(j).toContain('StrictHostKeyChecking=no');
  expect(j).toContain('UserKnownHostsFile=/dev/null');
});

test('waitForSsh returns once the probe succeeds, retrying while it fails', async () => {
  let calls = 0;
  await waitForSsh(
    { sshHostPort: 1, identity: '/i', user: 'monad' },
    { timeoutMs: 5000, intervalMs: 1, probe: async () => ++calls >= 3 }
  );
  expect(calls).toBe(3);
});

test('waitForSsh throws when the guest never becomes ready', async () => {
  await expect(
    waitForSsh(
      { sshHostPort: 1, identity: '/i', user: 'monad' },
      { timeoutMs: 20, intervalMs: 5, probe: async () => false }
    )
  ).rejects.toThrow(/not ready/);
});

function fakeChild(code: number): SandboxProcess {
  return {
    stdout: new Response('out').body ?? undefined,
    stderr: undefined,
    exited: Promise.resolve(code),
    exitCode: code,
    kill: () => {}
  };
}

test('bridgeAsyncProcess wires the child streams and resolves its exit code + runs onFinally', async () => {
  let finalized = false;
  const proc = bridgeAsyncProcess(
    async () => fakeChild(0),
    () => {
      finalized = true;
    }
  );
  const out = await new Response(proc.stdout).text();
  expect(out).toBe('out');
  expect(await proc.exited).toBe(0);
  expect(finalized).toBe(true);
});

test('bridgeAsyncProcess surfaces a start failure and still runs onFinally', async () => {
  let finalized = false;
  const proc = bridgeAsyncProcess(
    async () => {
      throw new Error('boot failed');
    },
    () => {
      finalized = true;
    }
  );
  await expect(proc.exited).rejects.toThrow('boot failed');
  expect(finalized).toBe(true);
});
