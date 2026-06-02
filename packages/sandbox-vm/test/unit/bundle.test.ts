import { expect, test } from 'bun:test';

import { describeBundle, safeKey } from '../../src/bundle.ts';

test('bundle keys remain distinct while bounding macOS unix socket paths', () => {
  const firstKey = `agt:${'resource-violation-agent-'.repeat(8)}#${'a'.repeat(16)}`;
  const secondKey = `agt:${'resource-violation-agent-'.repeat(8)}other#${'a'.repeat(16)}`;
  const first = describeBundle(firstKey);
  const second = describeBundle(secondKey);

  expect({
    firstKey: safeKey(firstKey),
    secondKey: safeKey(secondKey),
    distinctDirectories: first.dir !== second.dir,
    socketPathWithinMacOsLimit: Buffer.byteLength(first.vsockSock) < 104
  }).toEqual({
    firstKey: 'agt_99cf660ae65c_aaaaaaaaaaaaaaaa',
    secondKey: 'agt_800581bbfb26_aaaaaaaaaaaaaaaa',
    distinctDirectories: true,
    socketPathWithinMacOsLimit: true
  });
});
