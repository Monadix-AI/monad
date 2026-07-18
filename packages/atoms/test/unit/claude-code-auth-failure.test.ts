import { expect, test } from 'bun:test';

import { claudeCodeExternalAgentAdapter } from '../../src/agent-adapters/claude-code/index.ts';

const authFailureLine = JSON.stringify({
  type: 'assistant',
  message: {
    id: 'aa8b1bc4',
    model: '<synthetic>',
    role: 'assistant',
    content: [{ type: 'text', text: 'Not logged in · Please run /login' }]
  },
  session_id: 'ses_x',
  error: 'authentication_failed'
});

test('maps a top-level authentication_failed stream event to connection_required', () => {
  const events = claudeCodeExternalAgentAdapter.parseOutput?.(`${authFailureLine}\n`) ?? [];
  expect(events).toEqual([
    {
      type: 'connection_required',
      payload: { code: 'authentication_failed', reason: 'Not logged in · Please run /login' }
    }
  ]);
});

test('auth failure without content text falls back to a fixed reason', () => {
  const line = JSON.stringify({ type: 'assistant', message: { content: [] }, error: 'authentication_failed' });
  const events = claudeCodeExternalAgentAdapter.parseOutput?.(`${line}\n`) ?? [];
  expect(events).toEqual([
    {
      type: 'connection_required',
      payload: { code: 'authentication_failed', reason: 'Claude Code session is not signed in' }
    }
  ]);
});

test('maps an error result with a success subtype to connection_required', () => {
  const line = JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: true,
    result: 'Not logged in · Please run /login',
    permission_denials: []
  });
  const events = claudeCodeExternalAgentAdapter.parseOutput?.(`${line}\n`) ?? [];
  expect(events).toEqual([
    {
      type: 'connection_required',
      payload: { code: 'authentication_failed', reason: 'Not logged in · Please run /login' }
    }
  ]);
});

test('deduplicates matching assistant and result authentication failures', () => {
  const resultLine = JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: true,
    result: 'Not logged in · Please run /login',
    permission_denials: []
  });
  const events = claudeCodeExternalAgentAdapter.parseOutput?.(`${authFailureLine}\n${resultLine}\n`) ?? [];
  expect(events).toEqual([
    {
      type: 'connection_required',
      payload: { code: 'authentication_failed', reason: 'Not logged in · Please run /login' }
    }
  ]);
});

test('ordinary assistant events keep flowing as agent output, not connection_required', () => {
  const line = JSON.stringify({
    type: 'result',
    subtype: 'success',
    result: 'done',
    permission_denials: []
  });
  const events = claudeCodeExternalAgentAdapter.parseOutput?.(`${line}\n`) ?? [];
  expect(events).toEqual([{ type: 'agent_message', payload: { text: 'done', final: true } }]);
});
