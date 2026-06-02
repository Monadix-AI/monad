import { expect, test } from 'bun:test';

import { preflightResult } from '../smoke/vm-preflight.ts';

const tools = { hypervisor: '/tools/hypervisor', gvproxy: '/tools/gvproxy' };

test('Linux preflight requires real KVM rather than silently accepting TCG', () => {
  expect(preflightResult({ ...tools, kvm: false }, 'linux')).toEqual({
    ok: false,
    driver: 'qemu-kvm',
    detail: '/dev/kvm is not readable and writable'
  });
  expect(preflightResult({ ...tools, kvm: true }, 'linux')).toEqual({ ok: true, driver: 'qemu-kvm' });
});

test('Darwin and Windows report their actual driver', () => {
  expect(preflightResult(tools, 'darwin')).toEqual({ ok: true, driver: 'vfkit' });
  expect(preflightResult(tools, 'win32')).toEqual({ ok: true, driver: 'hyperv' });
});

test('unsupported hosts fail admission', () => {
  expect(preflightResult(tools, 'aix')).toEqual({ ok: false, driver: 'unsupported', detail: 'unsupported host aix' });
});
