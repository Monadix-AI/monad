import { expect, test } from 'bun:test';

import { builtinAgentAdapters } from '../../src/agent-adapters/index.ts';
import { meshAgentNeutralStreamItems } from '../../src/workplace-experiences/experience/mesh-agent-observation/mesh-agent-observation.ts';

test('Claude live projection replaces partial thinking and text with the final SDK message blocks', () => {
  const adapter = builtinAgentAdapters.find((candidate) => candidate.provider === 'claude-code');
  if (!adapter) throw new Error('Claude adapter is required');
  const messageId = 'msg_live_1';
  const records = [
    { type: 'stream_event', event: { type: 'message_start', message: { id: messageId } } },
    {
      type: 'stream_event',
      event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }
    },
    {
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Need ' } }
    },
    { type: 'system', subtype: 'thinking_tokens', estimated_tokens: 61 },
    {
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'context.' } }
    },
    { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
    {
      type: 'stream_event',
      event: { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }
    },
    {
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Final answer.' } }
    },
    {
      type: 'assistant',
      uuid: 'assistant-live-1',
      message: {
        id: messageId,
        content: [
          { type: 'thinking', thinking: 'Need context.', signature: 'signed' },
          { type: 'text', text: 'Final answer.' }
        ]
      }
    },
    { type: 'result', uuid: 'result-live-1', result: 'Final answer.', is_error: false }
  ];

  const projectedThrough = (through: number) =>
    meshAgentNeutralStreamItems({
      id: 'mesh_claude_live',
      provider: 'claude-code',
      adapter,
      output: records
        .slice(0, through)
        .map((record) => JSON.stringify(record))
        .join('\n')
    });

  const started = projectedThrough(2).map(({ hasContent, id, kind, streaming, text }) => ({
    hasContent,
    id,
    kind,
    streaming,
    text
  }));
  const firstDelta = projectedThrough(3).map(({ hasContent, id, kind, streaming, text }) => ({
    hasContent,
    id,
    kind,
    streaming,
    text
  }));
  const blockStopped = projectedThrough(6).map(({ hasContent, id, kind, streaming, summary, text }) => ({
    hasContent,
    id,
    kind,
    streaming,
    summary,
    text
  }));

  expect({
    started,
    firstDelta,
    blockStopped,
    settled: projectedThrough(records.length).map(({ kind, streaming, summary, text }) => ({
      kind,
      streaming,
      summary,
      text
    }))
  }).toEqual({
    started: [
      {
        hasContent: false,
        id: 'mesh_claude_live:json:1:stream-boundary',
        kind: 'reasoning',
        streaming: true,
        text: 'Thinking…'
      }
    ],
    firstDelta: [
      {
        hasContent: true,
        id: 'mesh_claude_live:json:1:stream-boundary',
        kind: 'reasoning',
        streaming: true,
        text: 'Need '
      }
    ],
    blockStopped: [
      {
        hasContent: true,
        id: 'mesh_claude_live:json:1:stream-boundary',
        kind: 'reasoning',
        streaming: false,
        summary: 'Thinking… 61 tokens',
        text: 'Need context.'
      }
    ],
    settled: [
      { kind: 'reasoning', streaming: false, summary: 'Thinking… 61 tokens', text: 'Need context.' },
      { kind: 'assistant-message', streaming: false, summary: undefined, text: 'Final answer.' },
      { kind: 'turn-end', streaming: false, summary: undefined, text: 'Final answer.' }
    ]
  });
});
