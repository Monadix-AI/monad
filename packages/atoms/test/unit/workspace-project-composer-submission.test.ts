import { expect, test } from 'bun:test';

import { projectComposerSubmission } from '../../src/workplace-experiences/chat-room/components/composer/submission.ts';

test('projectComposerSubmission builds the room message without a busy-state policy', () => {
  expect(projectComposerSubmission({ attachments: [], text: '  second request  ' })).toEqual({
    attachments: [],
    text: 'second request'
  });
});

test('projectComposerSubmission rejects an empty room message', () => {
  expect(projectComposerSubmission({ attachments: [], text: '   ' })).toBeNull();
});
