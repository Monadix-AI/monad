import { expect, test } from 'bun:test';

import {
  type MessageRow,
  rowToMessage,
  rowToSession,
  rowToWorkplaceProject,
  type SessionRow,
  type WorkplaceProjectRow
} from '#/store/db/row-mappers.ts';

const now = '2026-07-21T00:00:00.000Z';

const sessionRow: SessionRow = {
  id: 'ses_100000000000',
  projectId: null,
  title: 'test',
  state: 'idle',
  agentIds: '{}',
  archived: 0,
  restoreCount: 0,
  model: null,
  cwd: null,
  origin: null,
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  costUsd: 0,
  createdAt: now,
  activityAt: now,
  updatedAt: now
};

const projectRow: WorkplaceProjectRow = {
  id: 'prj_100000000000',
  title: 'test',
  state: 'idle',
  archived: 0,
  model: null,
  cwd: null,
  origin: null,
  memberTemplates: '{}',
  sortRank: 0,
  createdAt: now,
  updatedAt: now
};

test('rowToSession rejects a persisted agentIds value that is not an id array', () => {
  expect(() => rowToSession(sessionRow)).toThrow();
});

test('rowToWorkplaceProject rejects a persisted memberTemplates value that is not an array', () => {
  expect(() => rowToWorkplaceProject(projectRow)).toThrow();
});

test('rowToMessage degrades a malformed metadata cell to no origin instead of throwing', () => {
  const messageRow: MessageRow = {
    id: 'msg_100000000000',
    transcriptTargetId: 'ses_100000000000',
    role: 'user',
    text: 'hello',
    type: 'text',
    data: null,
    replyToMessageId: null,
    streamStatus: 'settled',
    active: 1,
    includeInContext: null,
    metadata: '{not valid json',
    idempotencyKey: null,
    commandFingerprint: null,
    createdAt: now,
    updatedAt: null
  };

  const message = rowToMessage(messageRow);
  expect(message.metadata).toBeUndefined();
});

test('rowToMessage carries a well-formed metadata.origin through unchanged', () => {
  const origin = { transport: 'channel' as const, surface: 'im' as const, client: 'slack', senderId: 'U1' };
  const messageRow: MessageRow = {
    id: 'msg_100000000001',
    transcriptTargetId: 'ses_100000000000',
    role: 'user',
    text: 'hello',
    type: 'text',
    data: null,
    replyToMessageId: null,
    streamStatus: 'settled',
    active: 1,
    includeInContext: null,
    metadata: JSON.stringify({ origin }),
    idempotencyKey: null,
    commandFingerprint: null,
    createdAt: now,
    updatedAt: null
  };

  const message = rowToMessage(messageRow);
  expect(message.metadata).toEqual({ origin });
});
