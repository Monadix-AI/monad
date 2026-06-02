import type { VmSpec } from '../../src/driver/vfkit.ts';

import { expect, test } from 'bun:test';

import { describeBundle } from '../../src/bundle.ts';
import { HVSOCK_PORTS, hvsockSetupPortSpec, hypervServiceArgv } from '../../src/driver/hyperv.ts';
import { withHvsockMountPlan } from '../../src/index.ts';
import { configureVmToolchain } from '../../src/toolchain.ts';

configureVmToolchain({ vmDir: '/tmp/vmtest' });

const VM_ID = 'A0B1C2D3-0000-0000-0000-000000000001';

function spec(overrides: Partial<VmSpec> = {}): VmSpec {
  return {
    cpus: 2,
    memoryMiB: 2048,
    bundle: describeBundle('agt:test'),
    mounts: [],
    mac: '02:aa:bb:cc:dd:ee',
    vsockSock: '\\\\.\\pipe\\monad-vm-agt_test',
    vsockPort: HVSOCK_PORTS.exec,
    ...overrides
  };
}

test('setup port spec covers exec, net, and the whole 9p range', () => {
  expect(hvsockSetupPortSpec()).toBe('1024,1025,1026-1057');
});

test('execbridge is always present and targets the exec port over the bundle pipe', () => {
  const services = hypervServiceArgv(spec(), VM_ID);
  const exec = services.find((s) => s[0] === 'execbridge');
  const j = (exec as string[]).join(' ');
  expect(j).toContain(`--vm-id ${VM_ID}`);
  expect(j).toContain(`--port ${HVSOCK_PORTS.exec}`);
  expect(j).toContain('--pipe \\\\.\\pipe\\monad-vm-agt_test');
});

test('net:none → no netbridge (no NIC plane at all); gvproxy socket → netbridge on the net port', () => {
  const none = hypervServiceArgv(spec(), VM_ID);
  expect(none.some((s) => s[0] === 'netbridge')).toBe(false);

  const net = hypervServiceArgv(spec({ gvproxyNetSock: '/t/gv.sock' }), VM_ID);
  const bridge = net.find((s) => s[0] === 'netbridge');
  const j = (bridge as string[]).join(' ');
  expect(j).toContain(`--port ${HVSOCK_PORTS.net}`);
  expect(j).toContain('--connect-unix /t/gv.sock');
});

test('each mount gets a VMID-pinned serve9p on its assigned port; read-only roots pass --ro', () => {
  const mounts = withHvsockMountPlan([
    { tag: 'w0', hostPath: 'C:\\Users\\z\\proj', guestPath: '/mnt/c/Users/z/proj', readOnly: false },
    { tag: 'r0', hostPath: 'D:\\data', guestPath: '/mnt/d/data', readOnly: true }
  ]);
  const services = hypervServiceArgv(spec({ mounts }), VM_ID);
  const nine = services.filter((s) => s[0] === 'serve9p');
  expect(nine).toHaveLength(2);
  expect(nine[0]?.join(' ')).toContain(`--port ${HVSOCK_PORTS.mountBase}`);
  expect(nine[0]?.join(' ')).toContain('--root C:\\Users\\z\\proj'); // host path, not the guest translation
  expect(nine[0]?.includes('--ro')).toBe(false); // exact arg — `--root` must not satisfy this
  expect(nine[1]?.join(' ')).toContain(`--port ${HVSOCK_PORTS.mountBase + 1}`);
  expect(nine[1]?.includes('--ro')).toBe(true);
  // every service is pinned to the VM — the wildcard-VMID cross-VM hole must stay closed
  for (const s of services) expect(s.join(' ')).toContain(`--vm-id ${VM_ID}`);
});

test('mount plan translates guest paths and rejects over-cap policies', () => {
  const planned = withHvsockMountPlan([{ tag: 'w0', hostPath: 'C:\\proj', guestPath: '/mnt/c/proj', readOnly: false }]);
  expect(planned[0]?.guestPath).toBe('/mnt/c/proj');
  expect(planned[0]?.vsockPort).toBe(HVSOCK_PORTS.mountBase);

  const tooMany = Array.from({ length: HVSOCK_PORTS.maxMounts + 1 }, (_, i) => ({
    tag: `w${i}`,
    hostPath: `C:\\p${i}`,
    guestPath: `/mnt/c/p${i}`,
    readOnly: false
  }));
  expect(() => withHvsockMountPlan(tooMany)).toThrow(/at most/);
});

test('a mount without a port plan fails closed instead of silently skipping the share', () => {
  const mounts = [{ tag: 'w0', hostPath: 'C:\\proj', guestPath: '/mnt/c/proj', readOnly: false }];
  expect(() => hypervServiceArgv(spec({ mounts }), VM_ID)).toThrow(/vsockPort/);
});
