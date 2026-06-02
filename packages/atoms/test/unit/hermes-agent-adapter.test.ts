import type { MeshAgentView } from '@monad/protocol';
import type { MeshAgentSessionEvent } from '@monad/sdk-atom';

import { expect, test } from 'bun:test';
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
    settingsImport: true
  });
});

test('Hermes managed runtime injects Monad MCP through an isolated profile home', () => {
  const root = join(tmpdir(), `hermes-managed-mcp-${crypto.randomUUID()}`);
  const sourceHome = join(root, 'source');
  const workspace = join(root, 'workspace');
  mkdirSync(sourceHome, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(sourceHome, 'config.yaml'), 'model:\n  provider: test\n', { mode: 0o600 });
  writeFileSync(join(sourceHome, '.env'), 'TEST_KEY=value\n', { mode: 0o600 });
  mkdirSync(join(sourceHome, 'sessions'));
  const commands: unknown[] = [];

  const env = hermesManagedMcpEnv(
    {
      workspace,
      skipProviderApprovals: true,
      agentCommand: 'hermes',
      agentEnv: { HERMES_HOME: sourceHome },
      mcpServer: {
        name: 'monad',
        command: 'monad',
        args: ['native-agent', 'mcp-server'],
        env: { MONAD_MESH_SESSION_ID: 'mesh_1234567890ab' }
      }
    },
    (command) => {
      commands.push(command);
      return { exitCode: 0, stderr: '' };
    }
  );

  const managedHome = env.HERMES_HOME;
  if (!managedHome) throw new Error('Hermes managed home required');
  expect(readFileSync(join(managedHome, 'config.yaml'), 'utf8')).toBe('model:\n  provider: test\n');
  expect(readFileSync(join(managedHome, '.env'), 'utf8')).toBe('TEST_KEY=value\n');
  expect(lstatSync(join(managedHome, 'sessions')).isSymbolicLink()).toBe(true);
  expect(commands).toEqual([
    {
      argv: [
        'hermes',
        'mcp',
        'add',
        'monad',
        '--command',
        'monad',
        '--env',
        'MONAD_MESH_SESSION_ID=mesh_1234567890ab',
        '--args',
        'native-agent',
        'mcp-server'
      ],
      cwd: workspace,
      env: { HERMES_HOME: managedHome }
    }
  ]);
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

test('Hermes history maps user, reasoning, and assistant content separately', () => {
  const events = hermesMeshAgentAdapter.events.projectLive({
    id: 'stored-hermes',
    mode: 'events',
    output: [
      JSON.stringify({ id: 1, role: 'user', content: 'hi' }),
      JSON.stringify({
        id: 2,
        role: 'assistant',
        reasoning_content: 'Check the inbox.',
        content: 'Done.'
      })
    ].join('\n')
  }).events;
  expect(
    events.map((event) => {
      const neutral = toAgentObservationEvent(event, hermesMeshAgentAdapter.observation);
      return neutral ? { kind: neutral.kind, text: neutral.text } : null;
    })
  ).toEqual([
    { kind: 'user-message', text: 'hi' },
    { kind: 'reasoning', text: 'Check the inbox.' },
    { kind: 'assistant-message', text: 'Done.' }
  ]);
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
