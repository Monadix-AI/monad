import { expect, test } from 'bun:test';

import { openClawObservationProjection, openClawRecordEvents } from '../../src/agent-adapters/openclaw/observation.ts';
import { createProjectedEventSource } from '../../src/agent-adapters/shared/events/event-source.ts';

function chatFrame(state: 'delta' | 'final', payload: Record<string, unknown>) {
  return { type: 'event', event: 'chat', payload: { runId: 'run-1', state, ...payload } };
}

test('a live chat final message projects its toolCall and thinking blocks, not just text', () => {
  const groupProjector = openClawObservationProjection.messageGroup;
  const finalRecord = chatFrame('final', {
    message: {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'planning the post' },
        {
          type: 'toolCall',
          name: 'monad__project_post',
          toolCallId: 'call-77',
          arguments: { text: 'hello project' }
        },
        { type: 'text', text: 'Posted the status.' }
      ],
      timestamp: 1730000000000
    }
  });
  const created = groupProjector.create(finalRecord);
  if (!created) throw new Error('chat frame did not open a message group');
  groupProjector.append(created.state, { record: finalRecord, raw: JSON.stringify(finalRecord) });
  const events = groupProjector.render('mesh_test', created.state);

  expect(
    events.map((event) => ({
      kind: event.providerEventType,
      text: event.text,
      callId: event.tool?.callId,
      input: event.tool?.input
    }))
  ).toEqual([
    { kind: 'reasoning', text: 'planning the post', callId: undefined, input: undefined },
    {
      kind: 'tool_call',
      text: 'Tool call monad__project_post {"text":"hello project"}',
      callId: 'call-77',
      input: { text: 'hello project' }
    },
    { kind: 'message', text: 'Posted the status.', callId: undefined, input: undefined }
  ]);
});

test('a delta-only group still projects the accumulated text message alone', () => {
  const groupProjector = openClawObservationProjection.messageGroup;
  const delta = chatFrame('delta', { deltaText: 'stream' });
  const created = groupProjector.create(delta);
  if (!created) throw new Error('chat frame did not open a message group');
  groupProjector.append(created.state, { record: delta, raw: JSON.stringify(delta) });
  const events = groupProjector.render('mesh_test', created.state);
  expect(events.map((event) => [event.providerEventType, event.text])).toEqual([['message.delta', 'stream']]);
});

test('agent assistant deltas update one live message until the chat final frame arrives', () => {
  const source = createProjectedEventSource({
    provider: 'openclaw',
    projection: openClawObservationProjection
  });
  const sessionKey = 'agent:main:main';
  const projector = source.createLiveProjector?.({ id: 'mesh_test', providerSessionRef: sessionKey });
  if (!projector) throw new Error('OpenClaw event source did not create an incremental projector');
  const first = {
    type: 'event',
    event: 'agent',
    payload: {
      runId: 'run-1',
      stream: 'assistant',
      data: { text: 'Heartbeat', delta: 'Heartbeat' },
      sessionKey,
      ts: 1787110479000
    }
  };
  const second = {
    type: 'event',
    event: 'agent',
    payload: {
      runId: 'run-1',
      stream: 'assistant',
      data: { text: 'Heartbeat ready', delta: ' ready' },
      sessionKey,
      ts: 1787110479570
    }
  };
  const final = {
    type: 'event',
    event: 'chat',
    payload: {
      runId: 'run-1',
      state: 'final',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Heartbeat ready.' }] },
      sessionKey,
      ts: 1787110480000
    }
  };

  const firstPage = projector.advance(`${JSON.stringify(first)}\n`);
  const secondPage = projector.advance(`${JSON.stringify(second)}\n`);
  const finalPage = projector.advance(`${JSON.stringify(final)}\n`);

  expect(
    [firstPage, secondPage, finalPage].map((page) =>
      page.events.map((event) => ({ id: event.id, type: event.providerEventType, text: event.text }))
    )
  ).toEqual([
    [{ id: 'mesh_test:chat:run-1:message', type: 'message.delta', text: 'Heartbeat' }],
    [{ id: 'mesh_test:chat:run-1:message', type: 'message.delta', text: 'Heartbeat ready' }],
    [{ id: 'mesh_test:chat:run-1:message', type: 'message', text: 'Heartbeat ready.' }]
  ]);
});

test('agent thinking frames use provider ts values to report the merged reasoning duration', () => {
  const source = createProjectedEventSource({
    provider: 'openclaw',
    projection: openClawObservationProjection
  });
  const frames = [
    {
      type: 'event',
      event: 'agent',
      payload: {
        runId: 'run-1',
        stream: 'thinking',
        data: { text: 'The user is', delta: 'The user is' },
        sessionKey: 'agent:main:subagent:monad-test',
        ts: 1787109835000
      }
    },
    {
      type: 'event',
      event: 'agent',
      payload: {
        runId: 'run-1',
        stream: 'thinking',
        data: { text: 'The user is telling', delta: ' telling' },
        sessionKey: 'agent:main:subagent:monad-test',
        ts: 1787109835694
      }
    }
  ];
  const events = source.projectLive({
    id: 'mesh_test',
    output: frames.map((frame) => JSON.stringify(frame)).join('\n'),
    providerSessionRef: 'agent:main:subagent:monad-test'
  }).events;

  expect(
    events.map((event) => ({
      type: event.providerEventType,
      text: event.text,
      createdAt: event.createdAt,
      durationMs: event.durationMs
    }))
  ).toEqual([
    {
      type: 'thinking.delta',
      text: 'The user is telling',
      createdAt: '2026-08-19T03:23:55.000Z',
      durationMs: 694
    }
  ]);
});

test('agent item tool frames project live tool-call and tool-result events', () => {
  const start = {
    type: 'event',
    event: 'agent',
    payload: {
      runId: 'run-1',
      stream: 'item',
      data: {
        itemId: 'tool:call-77',
        phase: 'start',
        kind: 'tool',
        title: 'monad__project_post idem_x',
        status: 'running',
        name: 'monad__project_post',
        toolCallId: 'call-77',
        startedAt: 1787057090166
      }
    }
  };
  const end = {
    type: 'event',
    event: 'agent',
    payload: {
      runId: 'run-1',
      stream: 'item',
      data: {
        itemId: 'tool:call-77',
        phase: 'end',
        kind: 'tool',
        title: 'monad__project_post idem_x',
        status: 'completed',
        name: 'monad__project_post',
        toolCallId: 'call-77',
        startedAt: 1787057090166,
        endedAt: 1787057090177
      }
    }
  };
  const events = [...openClawRecordEvents('mesh_test', start, 5), ...openClawRecordEvents('mesh_test', end, 6)];
  expect(
    events.map((event) => ({
      type: event.providerEventType,
      callId: event.tool?.callId,
      status: event.tool?.status,
      durationMs: event.tool?.durationMs,
      hasContent: event.hasContent
    }))
  ).toEqual([
    { type: 'tool_call', callId: 'call-77', status: 'running', durationMs: undefined, hasContent: false },
    { type: 'tool_result', callId: 'call-77', status: 'completed', durationMs: 11, hasContent: false }
  ]);
});

test('agent item tool end frames carry the failure as output', () => {
  const failed = {
    type: 'event',
    event: 'agent',
    payload: {
      runId: 'run-1',
      stream: 'item',
      data: {
        itemId: 'tool:call-88',
        phase: 'end',
        kind: 'tool',
        status: 'failed',
        name: 'memory_search',
        toolCallId: 'call-88',
        error: 'OAuth token refresh failed',
        startedAt: 1787057074679,
        endedAt: 1787057075147
      }
    }
  };
  const events = openClawRecordEvents('mesh_test', failed, 9);
  expect(
    events.map((event) => ({
      type: event.providerEventType,
      status: event.tool?.status,
      output: event.tool?.output,
      text: event.text,
      hasContent: event.hasContent
    }))
  ).toEqual([
    {
      type: 'tool_result',
      status: 'failed',
      output: 'OAuth token refresh failed',
      text: 'OAuth token refresh failed',
      hasContent: true
    }
  ]);
});

test('hermes gateway empty-string args decode as an absent input, not a malformed one', async () => {
  const { hermesObservationProjection } = await import('../../src/agent-adapters/hermes/observation.ts');
  const record = {
    jsonrpc: '2.0',
    method: 'event',
    params: {
      type: 'tool.start',
      session_id: 's1',
      payload: { name: 'mcp__monad__project_inbox_check', tool_id: 'call-10', args: '' }
    }
  };
  const events =
    hermesObservationProjection.recordProjectors.flatMap((projector) =>
      projector.parse({ id: 'mesh_test', record, recordIndex: 3 })
    ) ?? [];
  const call = events.find((event) => event.providerEventType === 'tool_call');
  expect({ name: call?.tool?.name, input: call?.tool?.input }).toEqual({
    name: 'mcp__monad__project_inbox_check',
    input: undefined
  });
});

test('hermes gateway tool.complete de-envelopes the { result } payload at emission', async () => {
  const { hermesObservationProjection } = await import('../../src/agent-adapters/hermes/observation.ts');
  const payload = { ok: true, message: { id: 'msg_env', text: 'hello' } };
  const record = {
    jsonrpc: '2.0',
    method: 'event',
    params: {
      type: 'tool.complete',
      session_id: 's1',
      payload: {
        name: 'mcp__monad__project_post',
        tool_id: 'call-11',
        result: { result: JSON.stringify(payload) }
      }
    }
  };
  const events =
    hermesObservationProjection.recordProjectors.flatMap((projector) =>
      projector.parse({ id: 'mesh_test', record, recordIndex: 4 })
    ) ?? [];
  const result = events.find((event) => event.providerEventType === 'tool_result');
  expect(result?.tool?.output).toEqual(payload);
});
