import type { MessageAttachment } from '../../src/workplace-experiences/experience/types.ts';

import { expect, test } from 'bun:test';

import { isAttachmentPreviewable } from '../../src/workplace-experiences/chat-room/components/attachment-chip.tsx';

function attachment(overrides: Partial<MessageAttachment>): MessageAttachment {
  return {
    bytes: 24,
    createdAt: '2026-08-11T04:05:56.881Z',
    id: 'att_preview',
    mime: 'image/png',
    name: 'preview.png',
    path: '/workspace/preview.png',
    ...overrides
  };
}

test('attachment View opens every available file while unavailable references stay download-only', () => {
  expect([
    isAttachmentPreviewable(attachment({})),
    isAttachmentPreviewable(attachment({ mime: 'text/markdown', name: 'notes.md' })),
    isAttachmentPreviewable(attachment({ mime: 'application/pdf', name: 'report.pdf' })),
    isAttachmentPreviewable(attachment({ path: undefined }))
  ]).toEqual([true, true, true, false]);
});
