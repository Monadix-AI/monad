import { expect, test } from 'bun:test';

import {
  clarifyRequestedPayloadSchema,
  clarifyRespondResponseSchema,
  inboxItemSchema,
  inboxSummarySchema,
  listInboxQuerySchema,
  markInboxReadRequestSchema
} from '../src/index.ts';

const context = {
  itemKey: 'hitl:clarify_ABCDEF123456',
  sessionId: 'ses_ABCDEF123456',
  createdAt: '2026-07-21T00:00:00.000Z',
  actionState: 'needs-response' as const
};

test('operator inbox parses mention, approval, and HITL items with independent read/action state', () => {
  const mention = inboxItemSchema.parse({
    ...context,
    itemKey: 'mention:msg_ABCDEF123456',
    actionState: 'informational',
    kind: 'mention',
    id: 'msg_ABCDEF123456',
    message: {
      id: 'msg_ABCDEF123456',
      sessionId: 'ses_ABCDEF123456',
      role: 'assistant',
      text: '@[name="zeke" id="human"] review this',
      type: 'text',
      stream: { status: 'settled' },
      active: true,
      createdAt: '2026-07-21T00:00:00.000Z'
    }
  });
  const approval = inboxItemSchema.parse({
    ...context,
    itemKey: 'approval:req_ABCDEF123456',
    kind: 'approval',
    id: 'req_ABCDEF123456',
    approvalKind: 'tool',
    tool: 'shell_exec',
    readAt: '2026-07-21T00:00:01.000Z'
  });
  const hitl = inboxItemSchema.parse({
    ...context,
    kind: 'hitl',
    id: 'clarify_ABCDEF123456',
    requestId: 'clarify_ABCDEF123456',
    question: 'Which environment?',
    options: ['staging', 'production']
  });

  expect(mention.actionState).toBe('informational');
  expect(approval.readAt).toBe('2026-07-21T00:00:01.000Z');
  expect(hitl.kind).toBe('hitl');
});

test('clarification auto-resolution is optional and bounded from one to four minutes', () => {
  const base = { requestId: 'clarify_ABCDEF123456', question: 'Proceed?' };
  expect(clarifyRequestedPayloadSchema.safeParse(base).success).toBe(true);
  expect(clarifyRequestedPayloadSchema.safeParse({ ...base, autoResolutionMs: 60_000 }).success).toBe(true);
  expect(clarifyRequestedPayloadSchema.safeParse({ ...base, autoResolutionMs: 240_000 }).success).toBe(true);
  expect(clarifyRequestedPayloadSchema.safeParse({ ...base, autoResolutionMs: 59_999 }).success).toBe(false);
  expect(clarifyRequestedPayloadSchema.safeParse({ ...base, autoResolutionMs: 240_001 }).success).toBe(false);
});

test('general inbox contracts parse filters, summaries, read batches, and terminal responses', () => {
  expect(listInboxQuerySchema.parse({ filter: 'needs-response', limit: 20 })).toEqual({
    filter: 'needs-response',
    limit: 20
  });
  expect(inboxSummarySchema.parse({ unreadCount: 2, needsResponseCount: 1 })).toEqual({
    unreadCount: 2,
    needsResponseCount: 1
  });
  expect(markInboxReadRequestSchema.safeParse({ itemKeys: ['mention:msg_ABCDEF123456'] }).success).toBe(true);
  expect(markInboxReadRequestSchema.safeParse({ itemKeys: [] }).success).toBe(false);
  expect(
    clarifyRespondResponseSchema.parse({
      status: 'answered',
      answer: 'production',
      resolvedAt: '2026-07-21T00:00:02.000Z'
    }).status
  ).toBe('answered');
  expect(clarifyRespondResponseSchema.parse({ status: 'not-found' }).status).toBe('not-found');
});
