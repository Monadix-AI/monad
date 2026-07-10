import type { DraftChatSession } from '../../src/lib/workspace-shell-store.ts';

import { expect, test } from 'bun:test';

import {
  buildDraftSessionFeedback,
  resolveDraftAgentLabel
} from '../../src/features/session/draft-session-feedback.ts';

const draft = (status: DraftChatSession['status']): DraftChatSession => ({
  id: 'ses_draft00000001',
  title: 'Investigate launch feedback',
  text: 'Investigate launch feedback',
  status,
  createIdempotencyKey: 'idem_create',
  sendIdempotencyKey: 'idem_send',
  createdAt: '2026-07-10T00:00:00.000Z',
  updatedAt: '2026-07-10T00:00:00.000Z'
});

test('creating draft shows the user message and a pending named agent', () => {
  expect(buildDraftSessionFeedback({ agentLabel: 'Research Agent', draft: draft('creating') })).toEqual([
    {
      id: 'draft:ses_draft00000001',
      role: 'user',
      text: 'Investigate launch feedback'
    },
    {
      id: 'draft:ses_draft00000001:assistant',
      label: 'Research Agent',
      pending: true,
      role: 'assistant',
      text: ''
    }
  ]);
});

test('failed draft stops the pending shimmer and marks the user message as failed', () => {
  expect(buildDraftSessionFeedback({ agentLabel: 'Research Agent', draft: draft('failed') })).toEqual([
    {
      error: true,
      id: 'draft:ses_draft00000001',
      role: 'user',
      text: 'Investigate launch feedback'
    }
  ]);
});

test('draft agent label resolves the selected agent and falls back to Default Agent', () => {
  const agents = [{ id: 'agt_research', name: 'Research Agent' }];
  expect(
    resolveDraftAgentLabel({
      agents,
      agentId: 'agt_research',
      defaultLabel: 'Default Agent'
    })
  ).toBe('Research Agent');
  expect(resolveDraftAgentLabel({ agents, agentId: undefined, defaultLabel: 'Default Agent' })).toBe('Default Agent');
});
