import type { DraftChatSession } from '../../src/lib/workspace-shell-store.ts';

import { expect, test } from 'bun:test';

import {
  buildDraftSessionFeedback,
  buildPendingTurnFeedback,
  resolveDraftAgentLabel
} from '../../src/features/session/draft-session-feedback.ts';

const draft = (status: DraftChatSession['status']): DraftChatSession => ({
  attachments: [
    {
      kind: 'file-meta',
      mediaType: 'application/zip',
      name: 'bundle.zip',
      size: 2048
    }
  ],
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
      attachments: [
        {
          id: 'att_000000000000',
          bytes: 2048,
          createdAt: '2026-07-10T00:00:00.000Z',
          mime: 'application/zip',
          name: 'bundle.zip'
        }
      ],
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

test('real session handoff preserves the pending named agent beside the initial user message', () => {
  expect(
    buildPendingTurnFeedback({
      agentLabel: 'Research Agent',
      id: 'local-home-turn-1',
      message: { text: 'Investigate launch feedback' }
    })
  ).toEqual([
    {
      id: 'local-home-turn-1',
      role: 'user',
      text: 'Investigate launch feedback'
    },
    {
      id: 'local-home-turn-1:assistant',
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
      attachments: [
        {
          id: 'att_000000000000',
          bytes: 2048,
          createdAt: '2026-07-10T00:00:00.000Z',
          mime: 'application/zip',
          name: 'bundle.zip'
        }
      ],
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
