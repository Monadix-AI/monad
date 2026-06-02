import { expect, test } from 'bun:test';

import { atomPackUpdateDialogState } from '../../src/features/studio/atoms-settings/atom-pack-update-dialog-model.ts';

test('Atom Pack update confirmation blocks dismissal and duplicate confirmation while updating', () => {
  const pending = atomPackUpdateDialogState({ updating: true, error: false }, 'dismiss');
  const duplicate = atomPackUpdateDialogState({ updating: true, error: false }, 'confirm');
  expect({ pending, duplicate }).toEqual({
    pending: { updating: true, error: false, effect: 'none' },
    duplicate: { updating: true, error: false, effect: 'none' }
  });
});

test('Atom Pack update confirmation preserves retry after failure and dismisses after success', () => {
  const failed = atomPackUpdateDialogState({ updating: true, error: false }, 'failed');
  const retried = atomPackUpdateDialogState(failed, 'confirm');
  const succeeded = atomPackUpdateDialogState(retried, 'succeeded');
  expect({ failed, retried, succeeded }).toEqual({
    failed: { updating: false, error: true, effect: 'none' },
    retried: { updating: true, error: false, effect: 'confirm' },
    succeeded: { updating: false, error: false, effect: 'dismiss' }
  });
});
