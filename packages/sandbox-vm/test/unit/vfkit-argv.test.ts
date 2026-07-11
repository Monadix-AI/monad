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

test('net:none retains the control-plane virtio-net device', () => {
  const argv = vfkitArgv('/bin/vfkit', spec({ gvproxyNetSock: '/tmp/gv.sock' }));
  expect(argv.join(' ')).toContain('virtio-net,unixSocketPath=/tmp/gv.sock');
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
