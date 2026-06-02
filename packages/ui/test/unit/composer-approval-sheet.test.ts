import { expect, test } from 'bun:test';

import { composerApprovalSheetKeyAction } from '../../src/components/ComposerApprovalSheet';

test('ComposerApprovalSheet keeps Enter and Escape scoped to approval decisions', () => {
  expect([
    composerApprovalSheetKeyAction({ inButton: false, isComposing: false, key: 'Enter' }),
    composerApprovalSheetKeyAction({ inButton: false, isComposing: false, key: 'Escape' }),
    composerApprovalSheetKeyAction({ inButton: true, isComposing: false, key: 'Enter' }),
    composerApprovalSheetKeyAction({ inButton: false, isComposing: true, key: 'Escape' })
  ]).toEqual(['approve', 'deny', 'ignore', 'ignore']);
});
