import { expect, test } from 'bun:test';

import { vmBaselineMetrics } from '../../src/index.ts';

test('vfkit explicitly remains cold-start only', () => {
  expect(vmBaselineMetrics()).toMatchObject({ restored: 0 });
});
