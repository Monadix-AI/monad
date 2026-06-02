import { expect, test } from 'bun:test';

import { sessionReplyPreviewTargetId } from '../../src/features/session/session-reply-preview.ts';

test('ordinary chat hides persisted agent references while preserving explicit user replies', () => {
  const targetId = 'msg_target';

  expect({
    assistant: sessionReplyPreviewTargetId({
      isProjectSession: false,
      message: { role: 'assistant', replyToMessageId: targetId }
    }),
    user: sessionReplyPreviewTargetId({
      isProjectSession: false,
      message: { role: 'user', replyToMessageId: targetId }
    })
  }).toEqual({
    assistant: undefined,
    user: targetId
  });
});

test('project chat keeps non-adjacent agent references and all chats collapse adjacent references', () => {
  const targetId = 'msg_target';

  expect({
    projectAssistant: sessionReplyPreviewTargetId({
      isProjectSession: true,
      message: { role: 'assistant', replyToMessageId: targetId }
    }),
    adjacentUser: sessionReplyPreviewTargetId({
      isProjectSession: false,
      message: { role: 'user', replyToMessageId: targetId },
      previousVisibleItemId: targetId
    })
  }).toEqual({
    projectAssistant: targetId,
    adjacentUser: undefined
  });
});
