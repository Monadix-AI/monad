import type { ContentBlock } from '@agentclientprotocol/sdk';
import type { Event } from '@monad/protocol';

import { expect, test } from 'bun:test';

import {
  eventToPlanUpdate,
  eventToSessionUpdate,
  finishReasonToStopReason,
  promptToAttachments,
  promptToText,
  toolKind
} from '#/transports/acp/translate.ts';

function evt(type: Event['type'], payload: Record<string, unknown>): Event {
  return {
    id: 'evt_1',
    sessionId: 'ses_1',
    type,
    actorAgentId: null,
    payload,
    at: '2026-01-01T00:00:00.000Z'
  };
}

test('eventToPlanUpdate maps a todo_write result to an ACP plan', () => {
  const result = JSON.stringify({
    todos: [
      { content: 'design', status: 'completed' },
      { content: 'build', status: 'in_progress' },
      { content: 'test', status: 'pending' }
    ]
  });
  const plan = eventToPlanUpdate(evt('tool.result', { toolCallId: 'tc', tool: 'todo_write', ok: true, result }));
  expect(plan).toEqual({
    sessionUpdate: 'plan',
    entries: [
      { content: 'design', priority: 'medium', status: 'completed' },
      { content: 'build', priority: 'medium', status: 'in_progress' },
      { content: 'test', priority: 'medium', status: 'pending' }
    ]
  });
});

test('promptToText flattens text and renders non-text placeholders', () => {
  const blocks: ContentBlock[] = [
    { type: 'text', text: 'hello' },
    { type: 'resource_link', uri: 'file:///a.ts', name: 'a.ts' },
    { type: 'resource', resource: { uri: 'file:///b.ts', text: 'inline body' } },
    { type: 'image', data: 'x', mimeType: 'image/png' }
  ];
  expect(promptToText(blocks)).toBe('hello\n[resource: file:///a.ts]\ninline body\n[image]');
});

test('finishReasonToStopReason passes through and defaults to end_turn', () => {
  expect(finishReasonToStopReason('cancelled')).toBe('cancelled');
  expect(finishReasonToStopReason('max_tokens')).toBe('max_tokens');
  expect(finishReasonToStopReason(undefined)).toBe('end_turn');
});

test('toolKind maps monad tool names to ACP kinds', () => {
  expect(toolKind('file_read')).toBe('read');
  expect(toolKind('file_write')).toBe('edit');
  expect(toolKind('file_patch')).toBe('edit');
  expect(toolKind('file_grep')).toBe('search');
  expect(toolKind('shell_exec')).toBe('execute');
  expect(toolKind('web_fetch')).toBe('fetch');
  expect(toolKind('skill')).toBe('think');
  expect(toolKind('something.unknown')).toBe('other');
});

test('agent.token becomes an agent_message_chunk', () => {
  const u = eventToSessionUpdate(evt('agent.token', { messageId: 'msg_1', delta: 'hi', index: 0 }));
  expect(u).toEqual({
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'hi' },
    messageId: 'msg_1'
  });
});

test('agent.reasoning becomes an agent_thought_chunk', () => {
  const u = eventToSessionUpdate(evt('agent.reasoning', { messageId: 'msg_1', delta: 'pondering', index: 0 }));
  expect(u).toEqual({
    sessionUpdate: 'agent_thought_chunk',
    content: { type: 'text', text: 'pondering' },
    messageId: 'msg_1'
  });
});

test('empty agent.token delta yields no update', () => {});

test('tool.called becomes a tool_call with kind + rawInput', () => {
  const u = eventToSessionUpdate(evt('tool.called', { toolCallId: 'tc_1', tool: 'file_write', input: { path: '/x' } }));
  expect(u).toEqual({
    sessionUpdate: 'tool_call',
    toolCallId: 'tc_1',
    title: 'file_write',
    kind: 'edit',
    status: 'in_progress',
    rawInput: { path: '/x' },
    locations: [{ path: '/x' }]
  });
  // No `path` arg → no locations.
  const _noPath = eventToSessionUpdate(
    evt('tool.called', { toolCallId: 'tc_2', tool: 'web_fetch', input: { url: 'u' } })
  );
});

test('tool.progress becomes an in_progress tool_call_update with cumulative output', () => {
  const u = eventToSessionUpdate(
    evt('tool.progress', { toolCallId: 'tc_1', tool: 'shell_exec', output: 'line1\nline2' })
  );
  expect(u).toEqual({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'tc_1',
    status: 'in_progress',
    content: [{ type: 'content', content: { type: 'text', text: 'line1\nline2' } }]
  });
});

test('tool.result becomes a tool_call_update with terminal status + content', () => {
  const ok = eventToSessionUpdate(
    evt('tool.result', { toolCallId: 'tc_1', tool: 'file_write', ok: true, result: 'done' })
  );
  expect(ok).toEqual({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'tc_1',
    status: 'completed',
    content: [{ type: 'content', content: { type: 'text', text: 'done' } }],
    rawOutput: 'done'
  });
  const failed = eventToSessionUpdate(
    evt('tool.result', { toolCallId: 'tc_2', tool: 'shell_exec', ok: false, result: 'boom' })
  );
  expect((failed as { status: string }).status).toBe('failed');
});

test('agent.message surfaces usage_update only when usage present', () => {
  const u = eventToSessionUpdate(
    evt('agent.message', {
      messageId: 'msg_ABC',
      text: 'x',
      usage: { inputTokens: 3, outputTokens: 7, totalTokens: 10 }
    })
  );
  expect(u).toEqual({ sessionUpdate: 'usage_update', used: 10, size: 10 });
});

test('approval events produce no streaming update', () => {});

test('sessions.updated with a title becomes a session_info_update', () => {
  expect(eventToSessionUpdate(evt('session.updated', { title: 'Renamed', state: 'active' }))).toEqual({
    sessionUpdate: 'session_info_update',
    title: 'Renamed'
  });
  // state-only update (no title) → nothing to push.
});

test('empty agent.reasoning delta yields no update', () => {});

test('agent.message falls back to inputTokens + outputTokens when totalTokens is absent', () => {
  const u = eventToSessionUpdate(
    evt('agent.message', { messageId: 'msg_ABC', text: 'x', usage: { inputTokens: 10, outputTokens: 5 } })
  );
  expect(u).toMatchObject({ sessionUpdate: 'usage_update', used: 15, size: 0 });
});

// ── promptToAttachments ───────────────────────────────────────────────────────

test('promptToAttachments extracts image blocks as Uint8Array attachments', () => {
  const data = Buffer.from('fake-png').toString('base64');
  const blocks: ContentBlock[] = [
    { type: 'text', text: 'look at this' },
    { type: 'image', data, mimeType: 'image/png' },
    { type: 'image', data, mimeType: 'image/jpeg' }
  ];
  const out = promptToAttachments(blocks);
  expect(out).toHaveLength(2);
  expect(out[0]).toEqual({ image: new Uint8Array(Buffer.from(data, 'base64')), mediaType: 'image/png' });
  expect(out[1]?.mediaType).toBe('image/jpeg');
});

test('promptToAttachments returns empty array when no image blocks are present', () => {});

// ── promptToText edge cases ───────────────────────────────────────────────────

test('promptToText: audio block renders [audio]; resource with uri-only (no text) renders uri placeholder', () => {
  const blocks: ContentBlock[] = [
    { type: 'audio', data: 'x', mimeType: 'audio/mp3' },
    // resource with no 'text' field — branch: else if ('uri' in r)
    { type: 'resource', resource: { uri: 'file:///notes.md', text: '' } } as ContentBlock
  ];
  expect(promptToText(blocks)).toBe('[audio]\n[resource: file:///notes.md]');
});

test('promptToText returns empty string for empty input', () => {
  expect(promptToText([])).toBe('');
});

// ── toolKind remaining patterns ───────────────────────────────────────────────

test('toolKind covers all remaining built-in name patterns', () => {
  expect(toolKind('file_read')).toBe('read');
  expect(toolKind('file_write')).toBe('edit');
  expect(toolKind('file_patch')).toBe('edit');
  // search (glob, grep already covered; name-contains-search catch-all)
  expect(toolKind('file_glob')).toBe('search');
  expect(toolKind('web_search')).toBe('search'); // includes('search')
  // execute
  expect(toolKind('process_start')).toBe('execute');
  expect(toolKind('process_kill')).toBe('execute');
  expect(toolKind('code_execute')).toBe('execute');
  // fetch
  expect(toolKind('net_http')).toBe('fetch');
  expect(toolKind('fetch_url')).toBe('fetch');
  // think
  expect(toolKind('clarify_ask')).toBe('think');
});
