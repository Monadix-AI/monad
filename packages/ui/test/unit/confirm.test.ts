import { expect, test } from 'bun:test';

import { resolveConfirmActionState, resolveConfirmOpenChange } from '../../src/components/Confirm';

test('Confirm blocks dismissal while pending and allows every other controlled transition', () => {
  expect([
    resolveConfirmOpenChange(true, false),
    resolveConfirmOpenChange(true, true),
    resolveConfirmOpenChange(false, false),
    resolveConfirmOpenChange(false, true)
  ]).toEqual([null, true, false, true]);
});

test('Confirm keeps cancel available when only the confirm action is disabled', () => {
  expect([
    resolveConfirmActionState(false, false),
    resolveConfirmActionState(false, true),
    resolveConfirmActionState(true, false),
    resolveConfirmActionState(true, true)
  ]).toEqual([
    { cancelDisabled: false, confirmDisabled: false },
    { cancelDisabled: false, confirmDisabled: true },
    { cancelDisabled: true, confirmDisabled: true },
    { cancelDisabled: true, confirmDisabled: true }
  ]);
});
