import { expect, test } from 'bun:test';

import { assertAtomPackSdkCompatibility } from '#/atoms/compat.ts';

test('accepts an atom pack SDK range containing the host version', () => {
  expect(() => assertAtomPackSdkCompatibility('compatible', '^0.1.0', '0.1.5')).not.toThrow();
});

test('keeps legacy SDK epoch 0 inside the 0.1 compatibility line', () => {
  expect(() => assertAtomPackSdkCompatibility('legacy', '0', '0.1.5')).not.toThrow();
  expect(() => assertAtomPackSdkCompatibility('legacy', '0', '0.2.0')).toThrow(
    'Atom Pack "legacy" requires sdkVersion 0, but running 0.2.0'
  );
});

test('rejects an atom pack SDK range outside the host version', () => {
  expect(() => assertAtomPackSdkCompatibility('future', '^0.2.0', '0.1.5')).toThrow(
    'Atom Pack "future" requires sdkVersion ^0.2.0, but running 0.1.5'
  );
});
