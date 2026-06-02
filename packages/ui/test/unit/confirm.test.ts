import { expect, test } from 'bun:test';

import { resolveConfirmActionLabel, resolveConfirmOpenChange } from '../../src/components/Confirm';

test('Confirm blocks dismissal while pending and allows every other controlled transition', () => {
  expect([
    resolveConfirmOpenChange(true, false),
    resolveConfirmOpenChange(true, true),
    resolveConfirmOpenChange(false, false),
    resolveConfirmOpenChange(false, true)
  ]).toEqual([null, true, false, true]);
});

test('Confirm replaces its action label only while the action is pending', () => {
  expect([
    resolveConfirmActionLabel(false, 'Delete', 'Deleting…'),
    resolveConfirmActionLabel(true, 'Delete', 'Deleting…'),
    resolveConfirmActionLabel(true, 'Delete')
  ]).toEqual(['Delete', 'Deleting…', 'Delete']);
});
