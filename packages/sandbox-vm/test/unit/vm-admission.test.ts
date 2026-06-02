import { expect, test } from 'bun:test';

import { realVmAdmission } from '../e2e/vm-admission.ts';

test.each(['darwin', 'linux', 'win32'] as NodeJS.Platform[])('MONAD_VM_IT=1 admits %s', (platform) => {
  expect(realVmAdmission('1', platform)).toBe('run');
});

test('an absent opt-in skips discovery on every supported platform', () => {
  expect(realVmAdmission(undefined, 'win32')).toBe('skip');
  expect(realVmAdmission('0', 'linux')).toBe('skip');
  expect(realVmAdmission('', 'darwin')).toBe('skip');
});

test('an opted-in unsupported platform fails instead of claiming a skip', () => {
  expect(() => realVmAdmission('1', 'aix')).toThrow('unsupported on aix');
});
