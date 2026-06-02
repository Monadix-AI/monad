import { expect, test } from 'bun:test';

import { daemonHttpContract } from '../src/http.ts';
import {
  type ConsumeSessionAttentionRequest,
  consumeSessionAttentionRequestSchema,
  type ListSessionAttentionResponse,
  listSessionAttentionResponseSchema,
  type ReorderWorkplaceProjectRequest,
  reorderWorkplaceProjectRequestSchema
} from '../src/session-attention.ts';

test('session attention HTTP query normalizes one session id into an array', () => {
  expect(
    daemonHttpContract.sessions.attention.list.query.parse({
      sessionIds: 'ses_100000000000'
    })
  ).toEqual({
    sessionIds: ['ses_100000000000']
  });
});

test('session attention HTTP query preserves repeated session ids', () => {
  expect(
    daemonHttpContract.sessions.attention.list.query.parse({
      sessionIds: ['ses_100000000000', 'ses_200000000000']
    })
  ).toEqual({
    sessionIds: ['ses_100000000000', 'ses_200000000000']
  });
});

test('session attention response binds one priority state to exact unread activity keys', () => {
  const response: ListSessionAttentionResponse = {
    summaries: [
      {
        sessionId: 'ses_100000000000',
        state: 'need-response',
        generationState: 'running',
        activityAt: '2026-07-22T10:00:00.000Z',
        unreadItemKeys: ['message:msg_100000000000']
      }
    ]
  };

  expect(listSessionAttentionResponseSchema.parse(response)).toEqual(response);
});

test('attention consumption carries exact keys and a visible-reading cause', () => {
  const request: ConsumeSessionAttentionRequest = {
    itemKeys: ['message:msg_100000000000'],
    cause: 'visible'
  };

  expect(consumeSessionAttentionRequestSchema.parse(request)).toEqual(request);
});

test('project reorder identifies one top-level breakpoint at a known revision', () => {
  const request: ReorderWorkplaceProjectRequest = {
    projectId: 'prj_100000000000',
    beforeProjectId: 'prj_200000000000',
    expectedRevision: 4
  };

  expect(reorderWorkplaceProjectRequestSchema.parse(request)).toEqual(request);
  expect(() =>
    reorderWorkplaceProjectRequestSchema.parse({
      ...request,
      afterProjectId: 'prj_300000000000'
    })
  ).toThrow();
});
