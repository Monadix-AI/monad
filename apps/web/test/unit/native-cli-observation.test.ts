import { expect, test } from 'bun:test';

import { nativeCliStreamItems } from '../../features/workplace/native-cli-observation.ts';

test('Claude Code observation keeps a result marker without repeating assistant text', () => {
  const output = [
    JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Joined the project and posted status.' }]
      }
    }),
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      result: 'Joined the project and posted status.'
    })
  ].join('\n');

  expect(nativeCliStreamItems({ id: 'ncli_claude', provider: 'claude-code', output }).map((item) => item.text)).toEqual(
    ['Joined the project and posted status.', 'Result: success']
  );
});

test('observation preserves unparsed JSONL records verbatim', () => {
  const raw = '{"type":"unexpected_event","payload":{"value":42}}';

  expect(nativeCliStreamItems({ id: 'ncli_unknown', provider: 'claude-code', output: raw })).toEqual([
    {
      id: 'ncli_unknown:json:0:raw',
      role: 'system',
      text: raw,
      source: 'unknown',
      providerEventType: 'raw_json',
      raw: { type: 'unexpected_event', payload: { value: 42 } }
    }
  ]);
});

test('Codex app-server observation merges adjacent agent message chunks', () => {
  const output = [
    JSON.stringify({
      method: 'item/agentMessage/delta',
      params: { delta: 'Hello' }
    }),
    JSON.stringify({
      method: 'item/agentMessage/delta',
      params: { delta: ', world' }
    })
  ].join('\n');

  expect(nativeCliStreamItems({ id: 'ncli_codex', provider: 'codex', output }).map((item) => item.text)).toEqual([
    'Hello, world'
  ]);
});

test('Codex app-server observation collects merged chunk raw records into a flat array', () => {
  const records = [
    { method: 'item/agentMessage/delta', params: { delta: 'a' } },
    { method: 'item/agentMessage/delta', params: { delta: 'b' } },
    { method: 'item/agentMessage/delta', params: { delta: 'c' } }
  ];
  const output = records.map((record) => JSON.stringify(record)).join('\n');

  const items = nativeCliStreamItems({ id: 'ncli_codex', provider: 'codex', output });

  expect(items).toHaveLength(1);
  expect(items[0]?.text).toBe('abc');
  expect(items[0]?.raw).toEqual(records);
});

test('Codex app-server observation keeps a lone chunk raw record unwrapped', () => {
  const record = { method: 'item/agentMessage/delta', params: { delta: 'solo' } };

  const items = nativeCliStreamItems({ id: 'ncli_codex', provider: 'codex', output: JSON.stringify(record) });

  expect(items).toHaveLength(1);
  expect(items[0]?.raw).toEqual(record);
});

test('Codex app-server observation concatenates deltas verbatim without injecting spaces', () => {
  const output = [
    JSON.stringify({ method: 'item/agentMessage/delta', params: { delta: 'impl' } }),
    JSON.stringify({ method: 'item/agentMessage/delta', params: { delta: 'ementation' } })
  ].join('\n');

  expect(nativeCliStreamItems({ id: 'ncli_codex', provider: 'codex', output }).map((item) => item.text)).toEqual([
    'implementation'
  ]);
});

test('Codex app-server observation does not insert spaces between CJK deltas', () => {
  const output = [
    JSON.stringify({ method: 'item/agentMessage/delta', params: { delta: '我来' } }),
    JSON.stringify({ method: 'item/agentMessage/delta', params: { delta: '先做大文件' } }),
    JSON.stringify({ method: 'item/agentMessage/delta', params: { delta: '盘点' } })
  ].join('\n');

  expect(nativeCliStreamItems({ id: 'ncli_codex', provider: 'codex', output }).map((item) => item.text)).toEqual([
    '我来先做大文件盘点'
  ]);
});

test('Codex app-server observation keeps codex-sent whitespace across clause punctuation', () => {
  const output = [
    JSON.stringify({ method: 'item/agentMessage/delta', params: { delta: 'already gone;' } }),
    JSON.stringify({ method: 'item/agentMessage/delta', params: { delta: ' I am checking now.' } }),
    JSON.stringify({ method: 'item/agentMessage/delta', params: { delta: ' Two branches remain.' } })
  ].join('\n');

  expect(nativeCliStreamItems({ id: 'ncli_codex', provider: 'codex', output }).map((item) => item.text)).toEqual([
    'already gone; I am checking now. Two branches remain.'
  ]);
});

test('Codex app-server observation keeps provider events in timeline order', () => {
  const output = [
    JSON.stringify({ method: 'mcpServer/startupStatus/updated', params: { name: 'codegraph', status: 'starting' } }),
    JSON.stringify({ id: 1, result: { turn: { id: 'turn_a', status: 'inProgress' } } }),
    JSON.stringify({ method: 'turn/started', params: {} }),
    JSON.stringify({ method: 'item/agentMessage/delta', params: { delta: 'First' } }),
    JSON.stringify({ method: 'turn/completed', params: {} }),
    JSON.stringify({ id: 2, result: { turn: { id: 'turn_b', status: 'inProgress' } } }),
    JSON.stringify({ method: 'turn/started', params: {} }),
    JSON.stringify({ method: 'item/agentMessage/delta', params: { delta: 'Second' } }),
    JSON.stringify({ method: 'turn/completed', params: {} })
  ].join('\n');

  const items = nativeCliStreamItems({ id: 'ncli_codex', provider: 'codex', output });

  expect(items.map((item) => item.text)).toEqual([
    'codegraph starting',
    '{"id":1,"result":{"turn":{"id":"turn_a","status":"inProgress"}}}',
    'turn/started',
    'First',
    'turn/completed',
    '{"id":2,"result":{"turn":{"id":"turn_b","status":"inProgress"}}}',
    'turn/started',
    'Second',
    'turn/completed'
  ]);
  expect(items.map((item) => item.source)).toEqual([
    'codex-app-server',
    'unknown',
    'codex-app-server',
    'codex-app-server',
    'codex-app-server',
    'unknown',
    'codex-app-server',
    'codex-app-server',
    'codex-app-server'
  ]);
});

test('Codex app-server observation projects raw response tool calls and results', () => {
  const output = [
    JSON.stringify({
      method: 'rawResponseItem/completed',
      params: {
        item: {
          type: 'function_call',
          name: 'Bash',
          call_id: 'call_1',
          arguments: JSON.stringify({ command: 'git status', description: 'Check status' })
        }
      }
    }),
    JSON.stringify({
      method: 'rawResponseItem/completed',
      params: {
        item: {
          type: 'function_call_output',
          call_id: 'call_1',
          output: 'On branch main'
        }
      }
    })
  ].join('\n');

  const items = nativeCliStreamItems({ id: 'ncli_codex', provider: 'codex', output });

  expect(items.map((item) => ({ role: item.role, type: item.providerEventType, text: item.text }))).toEqual([
    {
      role: 'tool',
      type: 'function_call',
      text: 'Tool call Bash {"command":"git status","description":"Check status"}'
    },
    { role: 'tool', type: 'function_call_output', text: 'On branch main' }
  ]);
});

test('Codex app-server observation projects item tool lifecycle and output deltas', () => {
  const output = [
    JSON.stringify({
      method: 'item/started',
      params: {
        item: {
          type: 'commandExecution',
          command: 'bun test'
        }
      }
    }),
    JSON.stringify({
      method: 'item/commandExecution/outputDelta',
      params: { delta: 'running' }
    }),
    JSON.stringify({
      method: 'item/commandExecution/outputDelta',
      params: { delta: ' tests' }
    }),
    JSON.stringify({
      method: 'item/completed',
      params: {
        item: {
          type: 'commandExecution',
          output: 'ok'
        }
      }
    })
  ].join('\n');

  const items = nativeCliStreamItems({ id: 'ncli_codex', provider: 'codex', output });

  expect(items.map((item) => ({ role: item.role, type: item.providerEventType, text: item.text }))).toEqual([
    { role: 'tool', type: 'function_call', text: 'Tool call commandExecution bun test' },
    { role: 'tool', type: 'item/commandExecution/outputDelta', text: 'running tests' },
    { role: 'tool', type: 'function_call_output', text: 'ok' }
  ]);
});

test('Claude Code observation keeps result-delimited SDK queries in timeline order', () => {
  const output = [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 'claude_session' }),
    JSON.stringify({
      type: 'assistant',
      session_id: 'claude_session',
      message: { role: 'assistant', content: [{ type: 'text', text: 'First response' }] }
    }),
    JSON.stringify({ type: 'result', subtype: 'success', session_id: 'claude_session', result: 'First response' }),
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 'claude_session' }),
    JSON.stringify({
      type: 'assistant',
      session_id: 'claude_session',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Second response' }] }
    }),
    JSON.stringify({ type: 'result', subtype: 'success', session_id: 'claude_session', result: 'Second response' })
  ].join('\n');

  const items = nativeCliStreamItems({ id: 'ncli_claude', provider: 'claude-code', output });

  expect(items.map((item) => item.text)).toEqual([
    'init',
    'First response',
    'Result: success',
    'init',
    'Second response',
    'Result: success'
  ]);
  expect(items.map((item) => item.source)).toEqual([
    'claude-code-sdk',
    'claude-code-sdk',
    'claude-code-sdk',
    'claude-code-sdk',
    'claude-code-sdk',
    'claude-code-sdk'
  ]);
});
