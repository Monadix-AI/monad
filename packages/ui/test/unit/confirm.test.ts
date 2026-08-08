import { expect, test } from 'bun:test';

import { resolveConfirmOpenChange } from '../../src/components/Confirm';

test('Confirm blocks dismissal while pending and allows every other controlled transition', () => {
  expect([
    resolveConfirmOpenChange(true, false),
    resolveConfirmOpenChange(true, true),
    resolveConfirmOpenChange(false, false),
    resolveConfirmOpenChange(false, true)
  ]).toEqual([null, true, false, true]);
});
