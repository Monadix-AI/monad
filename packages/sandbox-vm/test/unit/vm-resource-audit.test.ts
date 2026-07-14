import { expect, test } from 'bun:test';

import { bundleMarker, matchingProcessLines } from '../smoke/vm-resource-audit.ts';

test('bundle marker matches the pool safe-key prefix', () => {
  expect(bundleMarker('p05-fault')).toBe('agt_p05-fault_');
});

test('process audit returns only owned resource lines', () => {
  const processes = [
    '100 qemu-system-x86_64 -drive /home/a/.monad/vm/agents/agt_other_hash/rootfs.img',
    '101 virtiofsd --socket-path /home/a/.monad/vm/agents/agt_p05-fault_deadbeef/w0.sock',
    '102 socat UNIX-LISTEN:/home/a/.monad/vm/agents/agt_p05-fault_deadbeef/vsock.sock VSOCK-CONNECT:3:1024'
  ].join('\n');

  expect(matchingProcessLines(processes, bundleMarker('p05-fault'))).toEqual([
    '101 virtiofsd --socket-path /home/a/.monad/vm/agents/agt_p05-fault_deadbeef/w0.sock',
    '102 socat UNIX-LISTEN:/home/a/.monad/vm/agents/agt_p05-fault_deadbeef/vsock.sock VSOCK-CONNECT:3:1024'
  ]);
});
