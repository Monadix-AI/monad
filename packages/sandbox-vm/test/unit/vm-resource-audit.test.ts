import { expect, test } from 'bun:test';

import { bundleMarker, matchingProcessLines } from '../smoke/vm-resource-audit.ts';

test('bundle marker matches the pool safe-key prefix', () => {
  expect(bundleMarker('p05-fault')).toMatch(/^agt_[a-f0-9]{12}_$/);
});

test('process audit returns only owned resource lines', () => {
  const marker = bundleMarker('p05-fault');
  const processes = [
    '100 qemu-system-x86_64 -drive /home/a/.monad/vm/agents/agt_other_hash/rootfs.img',
    `101 virtiofsd --socket-path /home/a/.monad/vm/agents/${marker}deadbeef/w0.sock`,
    `102 socat UNIX-LISTEN:/home/a/.monad/vm/agents/${marker}deadbeef/vsock.sock VSOCK-CONNECT:3:1024`
  ].join('\n');

  expect(matchingProcessLines(processes, marker)).toEqual([
    `101 virtiofsd --socket-path /home/a/.monad/vm/agents/${marker}deadbeef/w0.sock`,
    `102 socat UNIX-LISTEN:/home/a/.monad/vm/agents/${marker}deadbeef/vsock.sock VSOCK-CONNECT:3:1024`
  ]);
});
