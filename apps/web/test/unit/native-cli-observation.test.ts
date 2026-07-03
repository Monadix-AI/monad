import { expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { NativeCliObservationPanel } from '../../features/workplace/cli/NativeCliStreamModal.tsx';
import { observationTimelineEntries } from '../../features/workplace/cli/observation-cards.tsx';
import { nativeCliStreamItems, nativeCliUsageLimitMeter } from '../../features/workplace/native-cli-observation.ts';

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

test('Claude Code observation maps server errors to readable system events', () => {
  const output = JSON.stringify({
    type: 'result',
    subtype: 'server_error',
    is_error: true,
    result: 'API Error: overloaded_error. Claude Code is currently overloaded.',
    session_id: 'claude-session'
  });

  expect(nativeCliStreamItems({ id: 'ncli_claude', provider: 'claude-code', output })).toEqual([
    {
      id: 'ncli_claude:result',
      role: 'system',
      text: 'API Error: overloaded_error. Claude Code is currently overloaded.',
      source: 'claude-code-sdk',
      providerEventType: 'server_error',
      raw: {
        type: 'result',
        subtype: 'server_error',
        is_error: true,
        result: 'API Error: overloaded_error. Claude Code is currently overloaded.',
        session_id: 'claude-session'
      }
    }
  ]);
});

test('Qwen Code observation uses SDK-shaped assistant and result messages', () => {
  const output = [
    JSON.stringify({
      type: 'system',
      subtype: 'session_start',
      uuid: 'sys_1',
      session_id: 'qwen-session',
      cwd: '/tmp/project'
    }),
    JSON.stringify({
      type: 'assistant',
      uuid: 'msg_1',
      session_id: 'qwen-session',
      message: {
        id: 'assistant_1',
        type: 'message',
        role: 'assistant',
        model: 'qwen3-coder-plus',
        content: [{ type: 'text', text: 'I will inspect the project first.' }],
        usage: { input_tokens: 1, output_tokens: 1 }
      },
      parent_tool_use_id: null
    }),
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      uuid: 'result_1',
      session_id: 'qwen-session',
      is_error: false,
      duration_ms: 1000,
      duration_api_ms: 900,
      num_turns: 1,
      result: 'I will inspect the project first.',
      usage: { input_tokens: 1, output_tokens: 1 },
      permission_denials: []
    })
  ].join('\n');

  const items = nativeCliStreamItems({ id: 'ncli_qwen', provider: 'qwen', output });

  expect(
    items.map((item) => ({ role: item.role, source: item.source, type: item.providerEventType, text: item.text }))
  ).toEqual([
    { role: 'system', source: 'qwen-code-sdk', type: 'system', text: 'session_start' },
    { role: 'agent', source: 'qwen-code-sdk', type: 'assistant', text: 'I will inspect the project first.' },
    { role: 'agent', source: 'qwen-code-sdk', type: 'result', text: 'Result: success' }
  ]);
});

test('Qwen Code observation merges partial stream-json deltas', () => {
  const output = [
    JSON.stringify({
      type: 'stream_event',
      uuid: 'delta_1',
      session_id: 'qwen-session',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } },
      parent_tool_use_id: null
    }),
    JSON.stringify({
      type: 'stream_event',
      uuid: 'delta_2',
      session_id: 'qwen-session',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' world' } },
      parent_tool_use_id: null
    })
  ].join('\n');

  expect(nativeCliStreamItems({ id: 'ncli_qwen', provider: 'qwen', output })).toMatchObject([
    {
      role: 'agent',
      source: 'qwen-code-sdk',
      providerEventType: 'content_block_delta',
      text: 'hello world'
    }
  ]);
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

test('Codex app-server observation groups one agent message item lifecycle into one card', () => {
  const records = [
    {
      method: 'item/started',
      params: {
        item: { type: 'agentMessage', id: 'msg_1', text: '', phase: 'commentary' },
        threadId: 'thread_1',
        turnId: 'turn_1',
        startedAtMs: 1
      }
    },
    {
      method: 'item/agentMessage/delta',
      params: {
        itemId: 'msg_1',
        threadId: 'thread_1',
        turnId: 'turn_1',
        delta: "I'll fetch zeke's pending message now."
      }
    },
    {
      method: 'item/completed',
      params: {
        item: {
          type: 'agentMessage',
          id: 'msg_1',
          text: "I'll fetch zeke's pending message now.",
          phase: 'commentary'
        },
        threadId: 'thread_1',
        turnId: 'turn_1',
        completedAtMs: 2
      }
    }
  ];
  const output = records.map((record) => JSON.stringify(record)).join('\n');

  const items = nativeCliStreamItems({ id: 'ncli_codex', provider: 'codex', output });

  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({
    role: 'agent',
    source: 'codex-app-server',
    providerEventType: 'item/agentMessage',
    text: "I'll fetch zeke's pending message now."
  });
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

test('Codex app-server usage meter reads rate limit updates', () => {
  const output = JSON.stringify({
    method: 'account/rateLimits/updated',
    params: {
      rateLimits: {
        primary: { usedPercent: 6, windowDurationMins: 300, resetsAt: 1_782_935_600_000 },
        secondary: { usedPercent: 25, windowDurationMins: 10_080, resetsAt: 1_783_022_400_000 }
      }
    }
  });

  expect(nativeCliUsageLimitMeter({ provider: 'codex', output })).toMatchObject({
    title: 'Usage remaining',
    rows: [
      { id: 'primary', label: '5-hour limit', percent: 94 },
      { id: 'secondary', label: 'Weekly · all models', percent: 75 }
    ]
  });
  expect(nativeCliStreamItems({ id: 'ncli_codex', provider: 'codex', output }).map((item) => item.text)).toEqual([
    'Usage limits updated'
  ]);
});

test('Claude Code usage meter reads rate limit events', () => {
  const output = [
    JSON.stringify({
      type: 'rate_limit_event',
      rate_limit_info: { rateLimitType: 'five_hour', utilization: 74, resetsAt: 1_782_935_600_000 }
    }),
    JSON.stringify({
      type: 'rate_limit_event',
      rate_limit_info: { rateLimitType: 'seven_day', utilization: 31, resetsAt: 1_783_022_400_000 }
    })
  ].join('\n');

  expect(nativeCliUsageLimitMeter({ provider: 'claude-code', output })).toMatchObject({
    title: 'Usage remaining',
    rows: [
      { id: 'five_hour', label: '5h', percent: 26 },
      { id: 'seven_day', label: 'Weekly', percent: 69 }
    ]
  });
});

test('observation panel shows a usage limits entry when the stream has limit data', () => {
  const output = JSON.stringify({
    method: 'account/rateLimits/updated',
    params: { rateLimits: { primary: { usedPercent: 6, windowDurationMins: 300, resetsAt: 1_782_935_600_000 } } }
  });
  const html = renderToStaticMarkup(
    React.createElement(NativeCliObservationPanel, {
      onStop: () => {},
      stream: {
        id: 'ncli_codex',
        agentName: 'codex',
        provider: 'codex',
        tag: 'Codex',
        status: 'running',
        output,
        items: nativeCliStreamItems({ id: 'ncli_codex', provider: 'codex', output })
      }
    })
  );

  expect(html).toContain('aria-label="Show usage limits"');
});

test('observation panel distinguishes unavailable provider history from empty live activity', () => {
  const html = renderToStaticMarkup(
    React.createElement(NativeCliObservationPanel, {
      onStop: () => {},
      stream: {
        id: 'ncli_codex',
        agentName: 'codex',
        provider: 'codex',
        tag: 'Codex',
        status: 'ok',
        output: '',
        items: []
      }
    })
  );

  expect(html).toContain('Provider history unavailable.');
});

test('Codex app-server observation renders a standalone commandExecution result as a command card', () => {
  const raw = {
    method: 'item/completed',
    params: {
      item: {
        type: 'commandExecution',
        id: 'call_1',
        command: 'monad project read | tail -100',
        cwd: '/tmp/project-agent',
        status: 'completed',
        aggregatedOutput: '{"messages":[{"text":"ok"}]}'
      }
    }
  };
  const html = renderToStaticMarkup(
    React.createElement(NativeCliObservationPanel, {
      onStop: () => {},
      stream: {
        id: 'ncli_codex',
        agentName: 'codex',
        provider: 'codex',
        tag: 'Codex',
        status: 'running',
        output: '',
        items: [
          {
            id: 'ncli_codex:json:0:tool-result',
            role: 'tool',
            text: JSON.stringify(raw.params.item),
            source: 'codex-app-server',
            providerEventType: 'function_call_output',
            raw,
            createdAt: '2026-07-03T06:28:03.751Z'
          } as never
        ]
      }
    })
  );

  expect(html).toContain('commandExecution');
  expect(html).toContain('input');
  expect(html).toContain('monad project read | tail -100');
  expect(html).toContain('output');
  expect(html).toContain('&quot;messages&quot;');
  expect(html).toContain('<time');
});

test('observation card projection maps Codex and Claude command tools to the shared public card', () => {
  const codexEntries = observationTimelineEntries([
    {
      id: 'codex-command',
      role: 'tool',
      text: '{"type":"commandExecution","command":"bun test","aggregatedOutput":"pass"}',
      source: 'codex-app-server',
      providerEventType: 'function_call_output',
      raw: {
        method: 'item/completed',
        params: {
          item: {
            type: 'commandExecution',
            command: 'bun test',
            status: 'completed',
            aggregatedOutput: 'pass'
          }
        }
      }
    }
  ]);
  const claudeEntries = observationTimelineEntries([
    {
      id: 'claude-call',
      role: 'tool',
      text: 'Tool call Bash',
      source: 'claude-code-sdk',
      providerEventType: 'tool_use',
      raw: {
        message: {
          content: [{ type: 'tool_use', name: 'Bash', input: { command: 'git status' } }]
        }
      }
    },
    {
      id: 'claude-result',
      role: 'tool',
      text: 'On branch main',
      source: 'claude-code-sdk',
      providerEventType: 'tool_result',
      raw: { type: 'tool_result', output: 'On branch main' }
    }
  ]);

  expect(codexEntries).toMatchObject([{ kind: 'public', card: { type: 'command-tool' } }]);
  expect(claudeEntries).toMatchObject([{ kind: 'public', card: { type: 'command-tool' } }]);
});

test('observation card projection keeps generic tool pairs on the default public card', () => {
  const entries = observationTimelineEntries([
    {
      id: 'call',
      role: 'tool',
      text: 'Tool call Search',
      source: 'unknown',
      providerEventType: 'tool_use',
      raw: { name: 'Search' }
    },
    {
      id: 'result',
      role: 'tool',
      text: 'No results',
      source: 'unknown',
      providerEventType: 'tool_result',
      raw: { output: 'No results' }
    }
  ]);

  expect(entries).toMatchObject([{ kind: 'public', card: { type: 'tool-pair' } }]);
});

test('Claude Code Read tool result renders as a file read card', () => {
  const items = [
    {
      id: 'claude-read-call',
      role: 'tool',
      text: 'Tool call Read',
      source: 'claude-code-sdk',
      providerEventType: 'tool_use',
      raw: {
        message: {
          content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/tmp/example.tsx' } }]
        }
      }
    },
    {
      id: 'claude-read-result',
      role: 'tool',
      text: 'export function Example() { return <div />; }',
      source: 'claude-code-sdk',
      providerEventType: 'tool_result',
      raw: { type: 'tool_result', output: 'export function Example() { return <div />; }' }
    }
  ] as const;
  const entries = observationTimelineEntries(items as never);
  const html = renderToStaticMarkup(
    React.createElement(NativeCliObservationPanel, {
      onStop: () => {},
      stream: {
        id: 'ncli_claude',
        agentName: 'claude',
        provider: 'claude-code',
        tag: 'Claude',
        status: 'running',
        output: '',
        items: items as never
      }
    })
  );

  expect(entries).toMatchObject([{ kind: 'public', card: { type: 'file-read-tool' } }]);
  expect(html).toContain('/tmp/example.tsx');
  expect(html).toContain('export');
  expect(html).toContain('Example');
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
