import type { MeshAgentView } from '@monad/protocol';
import type { MeshAgentSessionEvent } from '@monad/sdk-atom';

import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { hermesEventPage } from '../../src/agent-adapters/hermes/event-pages.ts';
import { hermesManagedMcpEnv, hermesMeshAgentAdapter } from '../../src/agent-adapters/hermes/index.ts';
import { toAgentObservationEvent } from '../../src/agent-adapters/neutral-observation.ts';

const agent = {
  name: 'hermes',
  provider: 'hermes',
  command: 'hermes',
  env: { HERMES_HOME: '/tmp/hermes' },
  enabled: true,
  allowAutopilot: true,
  approvalOwnership: 'provider-owned'
} satisfies MeshAgentView;

test('Hermes detection advertises gateway approval proxy support', () => {
  const detected = hermesMeshAgentAdapter.detect({
    which: (command) => (command === 'hermes' ? '/opt/bin/hermes' : undefined),
    exists: () => false
  });

  expect(detected.capabilities).toEqual({
    auth: 'pty',
    events: 'provider-owned',
    resume: 'pty',
    approval: 'provider-owned',
    approvalProxy: true,
    settingsImport: true,
    agentInstances: 'hosted'
  });
});

test('Hermes managed runtime injects Monad MCP through an isolated profile home', () => {
  const root = join(tmpdir(), `hermes-managed-mcp-${crypto.randomUUID()}`);
  const sourceHome = join(root, 'source');
  const workspace = join(root, 'workspace');
  mkdirSync(sourceHome, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  writeFileSync(
    join(sourceHome, 'config.yaml'),
    'model:\n  provider: test\nmcp_servers:\n  existing:\n    url: https://example.com/mcp\n',
    { mode: 0o600 }
  );
  writeFileSync(join(sourceHome, '.env'), 'TEST_KEY=value\n', { mode: 0o600 });
  mkdirSync(join(sourceHome, 'sessions'));
  const commands: unknown[] = [];
  const context = {
    workspace,
    workingPath: '/project',
    immutableInstructions: { text: 'Managed Hermes instructions', file: join(workspace, 'prompt.md') },
    skipProviderApprovals: true,
    agentCommand: 'hermes',
    agentEnv: { HERMES_HOME: sourceHome },
    mcpServer: {
      name: 'monad',
      command: 'monad',
      args: ['native-agent', 'mcp-server'],
      env: { MONAD_MESH_SESSION_ID: 'mesh_1234567890ab' }
    }
  };
  const run = (command: unknown) => {
    commands.push(command);
    return { exitCode: 0, stderr: '' };
  };

  const env = hermesManagedMcpEnv(context, run);

  const managedHome = env.HERMES_HOME;
  if (!managedHome) throw new Error('Hermes managed home required');
  expect(Bun.YAML.parse(readFileSync(join(managedHome, 'config.yaml'), 'utf8'))).toEqual({
    model: { provider: 'test' },
    mcp_servers: {
      existing: { url: 'https://example.com/mcp' },
      monad: {
        command: 'monad',
        args: ['native-agent', 'mcp-server'],
        env: { MONAD_MESH_SESSION_ID: 'mesh_1234567890ab' },
        enabled: true
      }
    }
  });
  expect(readFileSync(join(managedHome, '.env'), 'utf8')).toBe('TEST_KEY=value\n');
  expect(lstatSync(join(managedHome, 'sessions')).isSymbolicLink()).toBe(true);
  expect(commands).toEqual([
    {
      argv: ['hermes', 'config', 'set', 'agent.system_prompt', 'Managed Hermes instructions'],
      cwd: workspace,
      env: { HERMES_HOME: managedHome }
    }
  ]);

  writeFileSync(join(managedHome, 'state.db'), 'managed provider session history');
  writeFileSync(join(sourceHome, 'state.db'), 'source profile state');
  hermesManagedMcpEnv(context, run);
  expect(readFileSync(join(managedHome, 'state.db'), 'utf8')).toBe('managed provider session history');

  expect(() =>
    hermesManagedMcpEnv(context, (command) => {
      const commandHome = command.env.HERMES_HOME;
      if (!commandHome) throw new Error('Expected managed Hermes home');
      writeFileSync(join(commandHome, 'config.yaml'), 'agent:\n  system_prompt: overwritten\n');
      return { exitCode: 0, stderr: '' };
    })
  ).toThrow("Hermes managed MCP configuration failed: server 'monad' was not persisted");
});

test('Hermes discovers default and named profiles with exact profile homes', () => {
  const probe = hermesMeshAgentAdapter.discoverAgents?.(agent);
  expect(probe?.launch.argv).toEqual(['hermes', 'profile', 'list']);
  expect(
    probe?.parse(
      `
 Profile          Model       Gateway
 ───────────────  ──────────  ───────
 ◆default         model-a     running
  111             —           stopped
  test             —           stopped
`,
      0
    )
  ).toEqual([
    { externalId: 'default', displayName: 'default', env: { HERMES_HOME: '/tmp/hermes' } },
    { externalId: '111', displayName: '111', env: { HERMES_HOME: join('/tmp/hermes', 'profiles', '111') } },
    { externalId: 'test', displayName: 'test', env: { HERMES_HOME: join('/tmp/hermes', 'profiles', 'test') } }
  ]);
});

test('Hermes mints one gateway token for the child environment and WebSocket query', () => {
  const configured = {
    ...agent,
    env: { HERMES_HOME: '/tmp/hermes/profiles/test' }
  };
  const definition = hermesMeshAgentAdapter.createSessionRuntime?.(configured, {
    workingPath: '/tmp/project',
    providerSessionRef: 'stored-session-1'
  });
  if (definition?.plan.processModel !== 'resident' || definition.driver.processModel !== 'resident')
    throw new Error('Hermes resident runtime required');
  const token = definition.plan.launch.env?.HERMES_DASHBOARD_SESSION_TOKEN;
  if (!token) throw new Error('Hermes dashboard token required');
  expect(token?.length).toBeGreaterThanOrEqual(32);
  expect(definition.plan).toEqual({
    processModel: 'resident',
    launch: {
      args: ['serve', '--isolated', '--skip-build'],
      cwd: '/tmp/project',
      env: { ...configured.env, HERMES_DASHBOARD_SESSION_TOKEN: token }
    },
    channel: {
      kind: 'websocket',
      endpoint: 'daemon-loopback',
      path: '/api/ws',
      query: { token },
      portArgument: '--port'
    },
    startup: { timeoutMs: 30_000 },
    reconnect: { maxAttempts: 3, baseDelayMs: 250, maxDelayMs: 2_000 }
  });
  expect(definition.driver.controls).toMatchObject({
    approvalResolution: { resolve: expect.any(Function) },
    steer: { send: expect.any(Function) },
    interrupt: { run: expect.any(Function) }
  });
});

test('Hermes preserves an explicitly configured gateway token', () => {
  const definition = hermesMeshAgentAdapter.createSessionRuntime?.(
    {
      ...agent,
      env: { HERMES_HOME: '/tmp/hermes', HERMES_DASHBOARD_SESSION_TOKEN: 'configured-token-value-1234567890' }
    },
    { workingPath: '/tmp/project' }
  );
  if (definition?.plan.processModel !== 'resident') throw new Error('Hermes resident runtime required');
  expect({
    envToken: definition.plan.launch.env?.HERMES_DASHBOARD_SESSION_TOKEN,
    queryToken: definition.plan.channel.kind === 'websocket' ? definition.plan.channel.query?.token : undefined
  }).toEqual({
    envToken: 'configured-token-value-1234567890',
    queryToken: 'configured-token-value-1234567890'
  });
});

test('Hermes puts global gateway flags before the serve subcommand and lets the profile select its model', async () => {
  const definition = hermesMeshAgentAdapter.createSessionRuntime?.(agent, {
    workingPath: '/tmp/project',
    skipProviderApprovals: true,
    modelId: 'hermes-4'
  });
  if (definition?.plan.processModel !== 'resident' || definition.driver.processModel !== 'resident')
    throw new Error('Hermes resident runtime required');
  expect(definition.plan.launch.args).toEqual(['--yolo', 'serve', '--isolated', '--skip-build']);
  const sent: string[] = [];
  await definition.driver.openSession({ workingPath: '/tmp/project' });
  await definition.driver.attachChannel(
    {
      async send(frame) {
        sent.push(String(frame));
      },
      async close() {}
    },
    {}
  );
  expect(sent.map((frame) => JSON.parse(frame))).toEqual([
    { id: 0, method: 'session.create', params: { cwd: '/tmp/project', source: 'monad' } }
  ]);
});

test('Hermes turns an errored completion into a provider error', async () => {
  const definition = hermesMeshAgentAdapter.createSessionRuntime?.(
    { ...agent, env: { HERMES_HOME: '/tmp/hermes', HERMES_DASHBOARD_SESSION_TOKEN: 'token' } },
    { workingPath: '/tmp/project' }
  );
  if (definition?.plan.processModel !== 'resident' || definition.driver.processModel !== 'resident')
    throw new Error('Hermes resident runtime required');
  const events: MeshAgentSessionEvent[] = [];
  await definition.driver.openSession({ workingPath: '/tmp/project' });
  await definition.driver.attachChannel(
    {
      async send() {},
      async close() {}
    },
    {}
  );
  await definition.driver.accept(
    {
      source: 'provider-channel',
      bytes: new TextEncoder().encode(
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'event',
          params: {
            type: 'message.complete',
            session_id: 'live-1',
            payload: { text: 'invalid model', status: 'error' }
          }
        })
      ),
      receivedAt: '2026-07-23T00:00:00.000Z'
    },
    {
      async emit(event) {
        events.push(event);
      }
    }
  );
  expect(events).toEqual([{ type: 'provider_error', payload: { message: 'invalid model' } }]);
});

test('Hermes resident driver owns resume, turn, event, and approval frames', async () => {
  const definition = hermesMeshAgentAdapter.createSessionRuntime?.(
    { ...agent, env: { HERMES_HOME: '/tmp/hermes/profiles/test', HERMES_DASHBOARD_SESSION_TOKEN: 'token' } },
    { workingPath: '/tmp/project', providerSessionRef: 'stored-session-1' }
  );
  if (definition?.plan.processModel !== 'resident' || definition.driver.processModel !== 'resident')
    throw new Error('Hermes resident runtime required');
  const sent: string[] = [];
  const events: MeshAgentSessionEvent[] = [];
  const sink = {
    async emit(event: MeshAgentSessionEvent) {
      events.push(event);
    }
  };
  await definition.driver.openSession({ workingPath: '/tmp/project', providerSessionRef: 'stored-session-1' });
  await definition.driver.attachChannel(
    {
      async send(frame) {
        sent.push(String(frame));
      },
      async close() {}
    },
    { providerSessionRef: 'stored-session-1' }
  );
  await definition.driver.accept(
    {
      source: 'provider-channel',
      bytes: new TextEncoder().encode(
        JSON.stringify({ jsonrpc: '2.0', id: 0, result: { session_id: 'live-1', session_key: 'stored-session-1' } })
      ),
      receivedAt: '2026-07-22T00:00:00.000Z'
    },
    sink
  );
  await definition.driver.sendTurn({ text: 'hello', attachments: [] });
  const steer = definition.driver.controls.steer;
  if (!steer) throw new Error('Hermes steer control required');
  await steer.send({ text: 'change direction', attachments: [] });
  const interrupt = definition.driver.controls.interrupt;
  if (!interrupt) throw new Error('Hermes interrupt control required');
  await interrupt.run();
  await definition.driver.accept(
    {
      source: 'provider-channel',
      bytes: new TextEncoder().encode(
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'event',
          params: { type: 'approval.request', session_id: 'live-1', payload: { kind: 'exec', command: 'pwd' } }
        })
      ),
      receivedAt: '2026-07-22T00:00:01.000Z'
    },
    sink
  );
  const approval = definition.driver.controls.approvalResolution;
  if (!approval) throw new Error('Hermes approval control required');
  await approval.resolve({ requestId: 'live-1:1', allow: false });

  expect(events).toEqual([
    { type: 'provider_session_identified', payload: { providerSessionRef: 'stored-session-1' } },
    {
      type: 'approval_requested',
      payload: { requestId: 'live-1:1', kind: 'exec', command: 'pwd' }
    }
  ]);
  expect(sent.map((frame) => JSON.parse(frame))).toEqual([
    { id: 0, method: 'session.resume', params: { session_id: 'stored-session-1' } },
    { id: 1, method: 'prompt.submit', params: { session_id: 'live-1', text: 'hello' } },
    { id: 2, method: 'session.steer', params: { session_id: 'live-1', text: 'change direction' } },
    { id: 3, method: 'session.interrupt', params: { session_id: 'live-1' } },
    { id: 4, method: 'approval.respond', params: { session_id: 'live-1', choice: 'deny' } }
  ]);
});

test('Hermes projects concatenated gateway frames into turn, reasoning, and assistant events', () => {
  const source = hermesMeshAgentAdapter.events;
  const projector = source.createLiveProjector?.({ id: 'mesh-hermes' });
  if (!projector) throw new Error('Hermes incremental projector required');
  const frames = [
    {
      jsonrpc: '2.0',
      method: 'event',
      params: { type: 'message.start', session_id: 'live-1' }
    },
    {
      jsonrpc: '2.0',
      method: 'event',
      params: { type: 'thinking.delta', session_id: 'live-1', payload: { text: '◉_◉ computing...' } }
    },
    {
      jsonrpc: '2.0',
      method: 'event',
      params: { type: 'reasoning.delta', session_id: 'live-1', payload: { text: 'We' } }
    },
    {
      jsonrpc: '2.0',
      method: 'event',
      params: { type: 'reasoning.delta', session_id: 'live-1', payload: { text: ' think' } }
    },
    {
      jsonrpc: '2.0',
      method: 'event',
      params: { type: 'message.delta', session_id: 'live-1', payload: { text: 'Hi' } }
    },
    {
      jsonrpc: '2.0',
      method: 'event',
      params: { type: 'message.delta', session_id: 'live-1', payload: { text: '!' } }
    },
    {
      jsonrpc: '2.0',
      method: 'event',
      params: { type: 'reasoning.available', session_id: 'live-1', payload: { text: 'Hi!' } }
    },
    {
      jsonrpc: '2.0',
      method: 'event',
      params: { type: 'message.complete', session_id: 'live-1', payload: { text: 'Hi!', status: 'complete' } }
    }
  ];
  const output = `HERMES_DASHBOARD_READY port=65465\n${frames.map((frame) => JSON.stringify(frame)).join('')}`;
  projector.advance(output.slice(0, 113));
  const events = projector.advance(output.slice(113)).events;
  expect(
    events.map((event) => {
      const neutral = toAgentObservationEvent(event, hermesMeshAgentAdapter.observation);
      return neutral ? { kind: neutral.kind, streaming: neutral.streaming, text: neutral.text } : null;
    })
  ).toEqual([
    { kind: 'turn-start', streaming: false, text: 'Message started' },
    { kind: 'reasoning', streaming: true, text: 'We think' },
    { kind: 'assistant-message', streaming: true, text: 'Hi!' },
    { kind: 'turn-end', streaming: false, text: 'complete' }
  ]);
});

test('Hermes keeps a streaming reasoning card stable while appending gateway deltas', () => {
  const projector = hermesMeshAgentAdapter.events.createLiveProjector?.({ id: 'mesh-hermes-stable' });
  if (!projector) throw new Error('Hermes incremental projector required');
  const frame = (text: string) =>
    JSON.stringify({
      jsonrpc: '2.0',
      method: 'event',
      params: { type: 'reasoning.delta', session_id: 'live-1', payload: { text } }
    });

  const first = projector.advance(frame('We')).events;
  const second = projector.advance(frame(' think')).events;

  expect(
    [first, second].map((events) => {
      const event = events.find((candidate) => candidate.providerEventType === 'reasoning.delta');
      return event ? { dedupeKey: event.dedupeKey, id: event.id, text: event.text } : null;
    })
  ).toEqual([
    {
      dedupeKey: 'hermes:mesh-hermes-stable:json:index-0:reasoning:agent:reasoning.delta',
      id: 'mesh-hermes-stable:json:index-0:reasoning',
      text: 'We'
    },
    {
      dedupeKey: 'hermes:mesh-hermes-stable:json:index-0:reasoning:agent:reasoning.delta',
      id: 'mesh-hermes-stable:json:index-0:reasoning',
      text: 'We think'
    }
  ]);
});

test('Hermes projects gateway tool lifecycle events into one pairable tool card', () => {
  const events = hermesMeshAgentAdapter.events.projectLive({
    id: 'mesh-hermes-tools',
    mode: 'events',
    output: [
      {
        jsonrpc: '2.0',
        method: 'event',
        params: {
          type: 'tool.start',
          session_id: 'live-1',
          payload: { tool_id: 'terminal_1', name: 'terminal', context: 'pwd' }
        }
      },
      {
        jsonrpc: '2.0',
        method: 'event',
        params: {
          type: 'tool.complete',
          session_id: 'live-1',
          payload: {
            tool_id: 'terminal_1',
            name: 'terminal',
            args: { command: 'pwd' },
            result: '/project',
            duration_s: 0.125
          }
        }
      }
    ]
      .map((frame) => JSON.stringify(frame))
      .join('\n')
  }).events;

  expect(
    events.map((event) => {
      const neutral = toAgentObservationEvent(event, hermesMeshAgentAdapter.observation);
      return neutral?.kind === 'tool-call' || neutral?.kind === 'tool-result'
        ? { dedupeKey: event.dedupeKey, kind: neutral.kind, tool: neutral.tool }
        : null;
    })
  ).toEqual([
    {
      dedupeKey: 'hermes:terminal_1:tool:tool_call',
      kind: 'tool-call',
      tool: { name: 'terminal', category: 'shell', callId: 'terminal_1', input: 'pwd', status: 'running' }
    },
    {
      dedupeKey: 'hermes:terminal_1:tool:tool_result',
      kind: 'tool-result',
      tool: {
        name: 'terminal',
        category: 'shell',
        callId: 'terminal_1',
        input: { command: 'pwd' },
        output: '/project',
        status: 'completed',
        durationMs: 125
      }
    }
  ]);
});

test('Hermes history maps user, reasoning, and assistant content separately', () => {
  const events = hermesMeshAgentAdapter.events.projectLive({
    id: 'stored-hermes',
    mode: 'events',
    output: [
      JSON.stringify({ id: 1, role: 'user', content: 'hi', timestamp: 1_786_281_662.88606 }),
      JSON.stringify({
        id: 2,
        role: 'assistant',
        timestamp: 1_786_281_672.404487,
        reasoning_content: 'Check the inbox.',
        content: 'Done.'
      })
    ].join('\n')
  }).events;
  expect(
    events.map((event) => {
      const neutral = toAgentObservationEvent(event, hermesMeshAgentAdapter.observation);
      return neutral ? { id: neutral.id, kind: neutral.kind, text: neutral.text, at: neutral.at } : null;
    })
  ).toEqual([
    {
      id: 'stored-hermes:json:1:message',
      kind: 'user-message',
      text: 'hi',
      at: '2026-08-09T13:21:02.886Z'
    },
    {
      id: 'stored-hermes:json:2:reasoning',
      kind: 'reasoning',
      text: 'Check the inbox.',
      at: '2026-08-09T13:21:12.404Z'
    },
    {
      id: 'stored-hermes:json:2:message',
      kind: 'assistant-message',
      text: 'Done.',
      at: '2026-08-09T13:21:12.404Z'
    }
  ]);
});

test('Hermes history preserves matching tool call ids for card pairing', () => {
  const events = hermesMeshAgentAdapter.events.projectLive({
    id: 'stored-hermes-tools',
    mode: 'events',
    output: [
      JSON.stringify({
        id: 1,
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'terminal_1',
            type: 'function',
            function: { name: 'terminal', arguments: '{"command":"pwd"}' }
          }
        ]
      }),
      JSON.stringify({
        id: 2,
        role: 'tool',
        content: '/project',
        tool_call_id: 'terminal_1',
        tool_name: 'terminal'
      })
    ].join('\n')
  }).events;

  expect(
    events.map((event) => {
      const neutral = toAgentObservationEvent(event, hermesMeshAgentAdapter.observation);
      return neutral?.kind === 'tool-call' || neutral?.kind === 'tool-result'
        ? { kind: neutral.kind, tool: neutral.tool }
        : null;
    })
  ).toEqual([
    {
      kind: 'tool-call',
      tool: { name: 'terminal', category: 'shell', callId: 'terminal_1', input: '{"command":"pwd"}' }
    },
    {
      kind: 'tool-result',
      tool: { name: 'terminal', category: 'shell', callId: 'terminal_1', output: '/project' }
    }
  ]);
});

test('Hermes history backfill reads the managed profile home and keeps raw records chronological', async () => {
  const runtimeWorkspace = mkdtempSync(join(tmpdir(), 'hermes-history-'));
  const home = join(runtimeWorkspace, '.hermes-managed');
  mkdirSync(home, { recursive: true });
  const db = new Database(join(home, 'state.db'));
  try {
    db.run(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        session_key TEXT,
        parent_session_id TEXT,
        end_reason TEXT,
        model_config TEXT,
        source TEXT,
        started_at REAL
      )
    `);
    db.run(`
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY,
        session_id TEXT,
        role TEXT,
        content TEXT,
        tool_call_id TEXT,
        tool_calls TEXT,
        tool_name TEXT,
        timestamp REAL,
        reasoning TEXT,
        reasoning_content TEXT,
        active INTEGER
      )
    `);
    db.run('INSERT INTO sessions (id, end_reason, model_config, source, started_at) VALUES (?, ?, ?, ?, ?)', [
      'managed-session',
      'completed',
      '{}',
      'monad',
      1
    ]);
    db.run(
      'INSERT INTO messages (id, session_id, role, content, timestamp, reasoning_content, active) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [1, 'managed-session', 'assistant', 'Ready.', 2, 'Checked managed history.', 1]
    );
    db.run(
      'INSERT INTO messages (id, session_id, role, content, timestamp, reasoning_content, active) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [2, 'managed-session', 'user', 'Continue.', 3, null, 1]
    );
  } finally {
    db.close();
  }

  try {
    const page = await hermesEventPage({
      providerSessionRef: 'managed-session',
      workingPath: '/project',
      managedRuntimeWorkspace: runtimeWorkspace,
      env: {
        HERMES_API_BASE_URL: 'http://127.0.0.1:1',
        PATH: '/nonexistent'
      },
      request: { limit: 50, sortDirection: 'desc', itemsView: 'full' }
    });
    expect({ items: page?.items, nextCursor: page?.nextCursor }).toEqual({
      items: [
        {
          id: 1,
          session_id: 'managed-session',
          role: 'assistant',
          content: 'Ready.',
          tool_call_id: null,
          tool_calls: null,
          tool_name: null,
          timestamp: 2,
          reasoning: null,
          reasoning_content: 'Checked managed history.'
        },
        {
          id: 2,
          session_id: 'managed-session',
          role: 'user',
          content: 'Continue.',
          tool_call_id: null,
          tool_calls: null,
          tool_name: null,
          timestamp: 3,
          reasoning: null,
          reasoning_content: null
        }
      ],
      nextCursor: undefined
    });

    const raw = await hermesMeshAgentAdapter.events.readPage?.(
      {
        providerSessionRef: 'managed-session',
        workingPath: '/project',
        managedRuntimeWorkspace: runtimeWorkspace,
        env: { HERMES_API_BASE_URL: 'http://127.0.0.1:1', PATH: '/nonexistent' }
      },
      { view: 'raw', limit: 50 }
    );
    expect(
      raw?.state === 'available' && raw.view === 'raw'
        ? raw.records.map(({ cursor, data, providerIdentity }) => ({
            id: data && typeof data === 'object' && 'id' in data ? data.id : undefined,
            cursor,
            providerIdentity
          }))
        : raw
    ).toEqual([
      { id: 1, cursor: '1', providerIdentity: '1' },
      { id: 2, cursor: '2', providerIdentity: '2' }
    ]);
  } finally {
    rmSync(runtimeWorkspace, { recursive: true, force: true });
  }
});

test('Hermes gives the reasoning and message events of one record distinct dedupe keys', () => {
  const record = { role: 'assistant', reasoning_content: 'Check the inbox.', content: 'Done.' };
  const events = hermesMeshAgentAdapter.events.projectLive({
    id: 'stored-hermes',
    mode: 'events',
    output: JSON.stringify(record)
  }).events;

  expect(events.map((event) => event.dedupeKey)).toEqual([
    'hermes:791b9e7f:agent:reasoning:reasoning',
    'hermes:791b9e7f:agent:message:message'
  ]);
});
