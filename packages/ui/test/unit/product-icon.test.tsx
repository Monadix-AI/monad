import { expect, test } from 'bun:test';

import { isProductIconId } from '../../src/components/ProductIcon';

test('recognizes supported product icon identifiers', () => {
  expect(['codex', 'hermes', 'openclaw', 'monad', 'unknown'].map(isProductIconId)).toEqual([
    true,
    true,
    true,
    true,
    false
  ]);
});
