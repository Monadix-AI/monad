import { expect, test } from 'bun:test';

import { sshArgv } from '../../src/exec/ssh.ts';

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
