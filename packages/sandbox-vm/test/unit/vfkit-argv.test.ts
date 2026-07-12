import { expect, test } from 'bun:test';

import { describeBundle } from '../../src/bundle.ts';
import { type VmSpec, vfkitArgv } from '../../src/driver/vfkit.ts';
import { configureVmToolchain } from '../../src/toolchain.ts';

configureVmToolchain({ vmDir: '/tmp/vmtest' });

function spec(overrides: Partial<VmSpec> = {}): VmSpec {
  return {
    cpus: 2,
    memoryMiB: 2048,
    bundle: describeBundle('agt:test'),
    mounts: [],
    mac: '02:aa:bb:cc:dd:ee',
    vsockSock: '/tmp/vmtest/agents/agt_test/vsock.sock',
    vsockPort: 1024,
    ...overrides
  };
}

test('base argv: EFI boot, rootfs blk, ignition, rng, restful-uri, pidfile', () => {
  const argv = vfkitArgv('/bin/vfkit', spec());
  const joined = argv.join(' ');
  expect(argv[0]).toBe('/bin/vfkit');
  expect(joined).toContain('--cpus 2');
  expect(joined).toContain('--memory 2048');
  expect(joined).toContain('--bootloader efi,variable-store=');
  expect(joined).toContain(',create');
  expect(joined).toContain('--ignition ');
  expect(joined).toContain('--device virtio-blk,path=');
  expect(joined).toContain('--device virtio-rng');
  expect(joined).toContain('--restful-uri unix://');
  expect(joined).toContain('--pidfile ');
});

test('net:none → no virtio-net device, but the vsock exec device is always present', () => {
  const argv = vfkitArgv('/bin/vfkit', spec({ gvproxyNetSock: undefined }));
  const j = argv.join(' ');
  expect(j).not.toContain('virtio-net');
  // The exec channel is vsock (connect mode), independent of the NIC — present even in net:none.
  expect(j).toContain('--device virtio-vsock,port=1024,socketURL=/tmp/vmtest/agents/agt_test/vsock.sock,connect');
});

test('with gvproxy socket → virtio-net wired to the datagram socket + MAC', () => {
  const argv = vfkitArgv('/bin/vfkit', spec({ gvproxyNetSock: '/tmp/gv.sock' }));
  expect(argv.join(' ')).toContain('--device virtio-net,unixSocketPath=/tmp/gv.sock,mac=02:aa:bb:cc:dd:ee');
});

test('each mount → a virtio-fs device at the same guest path', () => {
  const argv = vfkitArgv(
    '/bin/vfkit',
    spec({
      mounts: [
        { tag: 'w0', path: '/Users/x/ws', readOnly: false },
        { tag: 'r0', path: '/usr/lib', readOnly: true }
      ]
    })
  );
  const joined = argv.join(' ');
  expect(joined).toContain('--device virtio-fs,sharedDir=/Users/x/ws,mountTag=w0');
  expect(joined).toContain('--device virtio-fs,sharedDir=/usr/lib,mountTag=r0');
});
