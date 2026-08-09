import { expect, test } from 'bun:test';

import { builtinAgentAdapters } from '../../src/agent-adapters/index.ts';
import { agentObservationCards } from '../../src/agent-adapters/observation-cards.ts';
import { meshAgentNeutralStreamItems } from '../../src/workplace-experiences/experience/mesh-agent-observation/mesh-agent-observation.ts';

test('Claude live tool argument deltas settle into one canonical tool card', () => {
  const adapter = builtinAgentAdapters.find((candidate) => candidate.provider === 'claude-code');
  if (!adapter) throw new Error('claude-code adapter is unavailable');

  const callId = 'toolu_live_1';
  const uuid = 'assistant_live_1';
  const input = { query: 'project_post', max_results: 5 };
  const output = [
    {
      type: 'stream_event',
      uuid,
      session_id: 'session_live_1',
      event: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: callId, name: 'ToolSearch', input: {} }
      }
    },
    {
      type: 'stream_event',
      uuid,
      session_id: 'session_live_1',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"query":"project_post",' }
      }
    },
    {
      type: 'stream_event',
      uuid,
      session_id: 'session_live_1',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '"max_results":5}' }
      }
    },
    {
      type: 'assistant',
      uuid,
      session_id: 'session_live_1',
      message: {
        role: 'assistant',
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: callId, name: 'ToolSearch', input }]
      }
    },
    {
      type: 'user',
      uuid: 'tool_result_live_1',
      session_id: 'session_live_1',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: callId, content: 'posted' }]
      }
    }
  ]
    .map((record) => JSON.stringify(record))
    .join('\n');

  const events = meshAgentNeutralStreamItems({
    id: 'mesh_claude_live_tool',
    provider: 'claude-code',
    adapter,
    mode: 'live',
    output
  });
  const cards = agentObservationCards(events, 'claude-code');

  expect(
    cards.map((card) => {
      const call = card.payload.call;
      const result = card.payload.result;
      return {
        kind: card.kind,
        streaming: card.streaming,
        call: call && typeof call === 'object' && !Array.isArray(call) ? (call as { tool?: unknown }).tool : undefined,
        result:
          result && typeof result === 'object' && !Array.isArray(result)
            ? (result as { tool?: unknown }).tool
            : undefined
      };
    })
  ).toEqual([
    {
      kind: 'tool',
      streaming: false,
      call: { name: 'ToolSearch', input, callId },
      result: { name: 'tool', output: 'posted', callId, status: 'completed' }
    }
  ]);
});
