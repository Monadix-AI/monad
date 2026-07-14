import { expect, test } from 'bun:test';

import { hypervBaselineCreateArgv, hypervBaselineRestoreArgv } from '../../src/driver/hyperv.ts';

test('Hyper-V baseline helper commands keep names and paths in separate argv entries', () => {
  expect(hypervBaselineCreateArgv('vm name', 'C:\\cache path')).toEqual([
    'baseline-create',
    '--name',
    'vm name',
    '--path',
    'C:\\cache path'
  ]);
  expect(hypervBaselineRestoreArgv('vm name', 'C:\\cache path')[0]).toBe('baseline-restore');
});
