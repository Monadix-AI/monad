import { expect, test } from 'bun:test';

import { deleteProjectDialogState } from '../../src/features/workplace/delete-project-dialog-model.ts';

test('project delete confirmation blocks dismissal and duplicate confirmation while deleting', () => {
  const pending = deleteProjectDialogState({ deleting: true, error: false }, 'dismiss');
  const duplicate = deleteProjectDialogState({ deleting: true, error: false }, 'confirm');
  expect({ pending, duplicate }).toEqual({
    pending: { deleting: true, error: false, effect: 'none' },
    duplicate: { deleting: true, error: false, effect: 'none' }
  });
});

test('project delete confirmation preserves a retry path after failure', () => {
  const failed = deleteProjectDialogState({ deleting: true, error: false }, 'failed');
  const retried = deleteProjectDialogState(failed, 'confirm');
  expect({ failed, retried }).toEqual({
    failed: { deleting: false, error: true, effect: 'none' },
    retried: { deleting: true, error: false, effect: 'confirm' }
  });
});
