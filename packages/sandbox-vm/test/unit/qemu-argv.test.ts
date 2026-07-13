import type { VmSpec } from '../../src/driver/vfkit.ts';

import { expect, test } from 'bun:test';

import { describeBundle } from '../../src/bundle.ts';
import { guestCidFor, qemuArgv, virtiofsdSock } from '../../src/driver/qemu.ts';
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

test('guest CID is deterministic, stable, and >= 3', () => {
  const a = guestCidFor('agt:x');
  expect(a).toBe(guestCidFor('agt:x'));
  expect(a).toBeGreaterThanOrEqual(3);
  expect(guestCidFor('agt:y')).not.toBe(a);
});

test('base argv: EFI firmware, qcow2 rootfs, Ignition via fw_cfg, vhost-vsock', () => {
  const argv = qemuArgv('/bin/qemu', spec(), { firmwareCode: '/fw/OVMF.fd', kvm: true }, 42);
  const j = argv.join(' ');
  expect(j).toContain('-m 2048');
  expect(j).toContain('-smp 2');
  // Two pflash: readonly code (unit 0) + the per-VM writable vars store (unit 1, from the bundle).
  expect(j).toContain('if=pflash,format=raw,unit=0,readonly=on,file=/fw/OVMF.fd');
  expect(j).toContain('if=pflash,format=raw,unit=1,file=');
  expect(j).toContain('format=qcow2');
  expect(j).toContain('name=opt/com.coreos/config,file='); // Ignition over fw_cfg
  expect(j).toContain('vhost-vsock-pci,guest-cid=42'); // exec channel (bridged by socat)
  expect(j).toContain('accel=kvm'); // hardware acceleration when /dev/kvm is usable
});

test('no KVM → TCG software emulation (still boots, just slow)', () => {
  const argv = qemuArgv('/bin/qemu', spec(), { firmwareCode: '/fw/OVMF.fd', kvm: false }, 42);
  expect(argv.join(' ')).toContain('accel=tcg');
});

test('net:none → no virtio-net; with gvproxy socket → virtio-net over the stream socket', () => {
  const none = qemuArgv('/bin/qemu', spec({ gvproxyNetSock: undefined }), { firmwareCode: '/f', kvm: true }, 3);
  expect(none.join(' ')).not.toContain('virtio-net');
  const net = qemuArgv('/bin/qemu', spec({ gvproxyNetSock: '/t/gv.sock' }), { firmwareCode: '/f', kvm: true }, 3);
  const j = net.join(' ');
  expect(j).toContain('stream,id=net0,addr.type=unix,addr.path=/t/gv.sock');
  expect(j).toContain('virtio-net-pci,netdev=net0,mac=02:aa:bb:cc:dd:ee');
});

test('each mount → a virtiofsd chardev + vhost-user-fs device + shared memory backend', () => {
  const b = describeBundle('agt:test');
  const argv = qemuArgv(
    '/bin/qemu',
    spec({ mounts: [{ tag: 'w0', path: '/Users/x/ws', readOnly: false }] }),
    { firmwareCode: '/f', kvm: true },
    3
  );
  const j = argv.join(' ');
  expect(j).toContain('memory-backend-memfd,id=mem'); // shared pages for virtio-fs
  expect(j).toContain(`socket,id=vfs-w0,path=${virtiofsdSock(b.dir, 'w0')}`);
  expect(j).toContain('vhost-user-fs-pci,chardev=vfs-w0,tag=w0');
});
