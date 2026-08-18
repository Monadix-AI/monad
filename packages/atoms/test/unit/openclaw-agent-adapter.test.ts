import type { MeshAgentView } from '@monad/protocol';
import type { MeshAgentSessionEvent } from '@monad/sdk-atom';
import type { GatewayRuntimeHandle } from '../../src/agent-adapters/gateway/runtime.ts';

import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { toAgentObservationEvent } from '../../src/agent-adapters/neutral-observation.ts';
import { agentObservationCards } from '../../src/agent-adapters/observation-cards.ts';
import {
  echoOpenClawInput,
  openClawInitialize,
  parseOpenClawFrame
} from '../../src/agent-adapters/openclaw/gateway/index.ts';
import { openClawManagedMcpEnv, openClawMeshAgentAdapter } from '../../src/agent-adapters/openclaw/index.ts';
import { monadMcpToolView } from '../../src/workplace-experiences/chat-room/components/observation/monad-mcp-projection.ts';

const agent = {
  name: 'openclaw',
  provider: 'openclaw',
  command: 'openclaw',
  enabled: true,
  allowAutopilot: true,
  approvalOwnership: 'provider-owned'
} satisfies MeshAgentView;

test('OpenClaw managed runtime injects Monad MCP through an isolated config file', () => {
  const root = join(tmpdir(), `openclaw-managed-mcp-${crypto.randomUUID()}`);
  const stateDir = join(root, 'state');
  const workspace = join(root, 'workspace');
  const sourceConfig = join(stateDir, 'openclaw.json');
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  writeFileSync(sourceConfig, '{"agents":{"defaults":{"model":"test"}}}\n', { mode: 0o600 });
  const commands: unknown[] = [];

  const env = openClawManagedMcpEnv(
    {
      workspace,
      workingPath: '/project',
      immutableInstructions: { text: 'Managed OpenClaw instructions', file: join(workspace, 'prompt.md') },
      skipProviderApprovals: true,
      agentCommand: 'openclaw',
      agentEnv: { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: sourceConfig },
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

  const managedConfig = env.OPENCLAW_CONFIG_PATH;
  if (!managedConfig) throw new Error('OpenClaw managed config required');
  expect(readFileSync(managedConfig, 'utf8')).toBe('{"agents":{"defaults":{"model":"test"}}}\n');
  expect(readFileSync(join(workspace, 'AGENTS.md'), 'utf8')).toBe('Managed OpenClaw instructions');
  expect(commands).toEqual([
    {
      argv: [
        'openclaw',
        'mcp',
        'set',
        'monad',
        JSON.stringify({
          command: 'monad',
          args: ['native-agent', 'mcp-server'],
          env: { MONAD_MESH_SESSION_ID: 'mesh_1234567890ab' }
        })
      ],
      cwd: workspace,
      env: {
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: managedConfig
      }
    }
  ]);
});

test('OpenClaw discovers configured agents without prefixing display names', () => {
  const probe = openClawMeshAgentAdapter.discoverAgents?.(agent);
  expect(probe?.launch.argv).toEqual(['openclaw', 'agents', 'list', '--json']);
  expect(
    probe?.parse(
      JSON.stringify([
        { id: 'main', workspace: '/tmp/main' },
        { id: 'prd_expert', name: 'PRD Expert', workspace: '/tmp/prd' },
        { id: '', name: 'invalid' }
      ]),
      0
    )
  ).toEqual([
    { externalId: 'main', displayName: 'main', adapterSettings: { agentId: 'main' } },
    { externalId: 'prd_expert', displayName: 'PRD Expert', adapterSettings: { agentId: 'prd_expert' } }
  ]);
});

test('OpenClaw gateway creates the exact discovered provider agent session', () => {
  const sent: string[] = [];
  let nextId = 0;
  const handle: GatewayRuntimeHandle = {
    gateway: {
      send: (frame) => {
        sent.push(frame);
      },
      close: () => {}
    },
    nextRequestId: () => nextId++,
    pendingRequests: new Map()
  };

  openClawInitialize(handle, {
    workingPath: '/tmp/project',
    adapterSettings: { agentId: 'prd_expert' }
  });
  parseOpenClawFrame({ type: 'event', event: 'connect.challenge', payload: { nonce: 'nonce' } }, handle);
  const connect = JSON.parse(sent[0] as string) as { id: string; params: { scopes: string[] } };
  expect(connect.params.scopes).toEqual(['operator.read', 'operator.write']);
  parseOpenClawFrame({ type: 'res', id: connect.id, ok: true, payload: {} }, handle);

  const sessionCreate = JSON.parse(sent[1] as string) as { method: string; params: Record<string, unknown> };
  expect(sessionCreate.method).toBe('sessions.create');
  expect(sessionCreate.params).toEqual({ agentId: 'prd_expert' });
});

test('OpenClaw patches a managed session to load AGENTS.md as system context while preserving cwd', () => {
  const sent: string[] = [];
  let nextId = 0;
  const handle: GatewayRuntimeHandle = {
    gateway: {
      send: (frame) => {
        sent.push(frame);
      },
      close: () => {}
    },
    nextRequestId: () => nextId++,
    pendingRequests: new Map()
  };

  openClawInitialize(handle, {
    workingPath: '/tmp/project',
    systemPromptWorkspace: '/tmp/managed-prompt',
    adapterSettings: { agentId: 'prd_expert' }
  });
  parseOpenClawFrame({ type: 'event', event: 'connect.challenge', payload: { nonce: 'nonce' } }, handle);
  expect(JSON.parse(sent[0] as string)).toMatchObject({
    method: 'connect',
    params: { scopes: ['operator.read', 'operator.write', 'operator.admin'] }
  });
  parseOpenClawFrame({ type: 'res', id: '0', ok: true, payload: {} }, handle);
  const sessionCreate = JSON.parse(sent[1] as string) as {
    method: string;
    params: { agentId: string; key: string };
  };
  expect(sessionCreate).toMatchObject({ method: 'sessions.create', params: { agentId: 'prd_expert' } });
  expect(sessionCreate.params.key).toMatch(/^subagent:monad-[0-9a-f-]{36}$/);
  const providerSessionRef = `agent:prd_expert:${sessionCreate.params.key}`;

  expect(parseOpenClawFrame({ type: 'res', id: '1', ok: true, payload: { key: providerSessionRef } }, handle)).toEqual(
    []
  );
  expect(JSON.parse(sent[2] as string)).toEqual({
    type: 'req',
    id: '2',
    method: 'sessions.patch',
    params: {
      key: providerSessionRef,
      spawnedWorkspaceDir: '/tmp/managed-prompt',
      spawnedCwd: '/tmp/project'
    }
  });
  expect(parseOpenClawFrame({ type: 'res', id: '2', ok: true, payload: { ok: true } }, handle)).toEqual([
    {
      type: 'session_ref',
      payload: { providerSessionRef, responseId: '2' }
    }
  ]);
});

test('OpenClaw retries a transient startup rejection on the connected gateway', async () => {
  const sent: string[] = [];
  let nextId = 0;
  const handle: GatewayRuntimeHandle = {
    gateway: {
      send: (frame) => {
        sent.push(frame);
      },
      close: () => {}
    },
    nextRequestId: () => nextId++,
    pendingRequests: new Map()
  };

  openClawInitialize(handle, { workingPath: '/tmp/project' });
  parseOpenClawFrame({ type: 'event', event: 'connect.challenge', payload: { nonce: 'nonce' } }, handle);
  const firstConnect = JSON.parse(sent[0] as string) as { id: string };
  expect(
    parseOpenClawFrame(
      {
        type: 'res',
        id: firstConnect.id,
        ok: false,
        error: {
          code: 'UNAVAILABLE',
          message: 'gateway starting; retry shortly',
          retryable: true,
          retryAfterMs: 1
        }
      },
      handle
    )
  ).toEqual([]);
  await Bun.sleep(5);
  const retriedConnect = JSON.parse(sent[1] as string) as { id: string; method: string };
  expect(retriedConnect).toMatchObject({ id: '2', method: 'connect' });
  parseOpenClawFrame({ type: 'res', id: retriedConnect.id, ok: true, payload: {} }, handle);
  expect(JSON.parse(sent[2] as string)).toMatchObject({ id: '1', method: 'sessions.create' });
});

test('OpenClaw drops globally broadcast chat events for other provider sessions', () => {
  const handle = {
    providerSessionRef: 'agent:main:dashboard:target',
    pendingRequests: new Map()
  } satisfies GatewayRuntimeHandle;
  const frame = (sessionKey: string) => ({
    type: 'event',
    event: 'chat',
    payload: {
      sessionKey,
      state: 'delta',
      deltaText: 'hello'
    }
  });
  expect({
    foreign: parseOpenClawFrame(frame('agent:main:main'), handle),
    target: parseOpenClawFrame(frame('agent:main:dashboard:target'), handle)
  }).toEqual({
    foreign: [],
    target: [{ type: 'agent_message', payload: { text: 'hello' } }]
  });
});

test('OpenClaw exposes its signed gateway as a resident session-event runtime', () => {
  const definition = openClawMeshAgentAdapter.createSessionRuntime?.(
    { ...agent, adapterSettings: { agentId: 'prd_expert' } },
    { workingPath: '/tmp/project', providerSessionRef: 'agent:prd_expert:session:one' }
  );
  if (definition?.plan.processModel !== 'resident' || definition.driver.processModel !== 'resident')
    throw new Error('OpenClaw resident runtime required');
  const gatewayToken = definition.plan.launch.env?.OPENCLAW_GATEWAY_TOKEN;
  if (!gatewayToken) throw new Error('OpenClaw gateway token required');
  expect(definition.plan).toEqual({
    processModel: 'resident',
    launch: {
      args: ['gateway', 'run', '--allow-unconfigured'],
      cwd: '/tmp/project',
      env: { OPENCLAW_GATEWAY_TOKEN: gatewayToken }
    },
    channel: {
      kind: 'websocket',
      endpoint: 'daemon-loopback',
      portArgument: '--port',
      connectDelayMs: 500
    },
    startup: { timeoutMs: 30_000 },
    reconnect: { maxAttempts: 3, baseDelayMs: 250, maxDelayMs: 2_000 }
  });
  expect(gatewayToken.length).toBeGreaterThanOrEqual(32);
  expect(definition.driver.controls).toMatchObject({
    approvalResolution: { resolve: expect.any(Function) },
    steer: { send: expect.any(Function) },
    interrupt: { run: expect.any(Function) }
  });
});

test('OpenClaw resident driver owns handshake, session, turn, and approval frames', async () => {
  const definition = openClawMeshAgentAdapter.createSessionRuntime?.(
    { ...agent, adapterSettings: { agentId: 'prd_expert' } },
    { workingPath: '/tmp/project' }
  );
  if (definition?.plan.processModel !== 'resident' || definition.driver.processModel !== 'resident')
    throw new Error('OpenClaw resident runtime required');
  const sent: string[] = [];
  const events: MeshAgentSessionEvent[] = [];
  const sink = {
    async emit(event: MeshAgentSessionEvent) {
      events.push(event);
    }
  };
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
  await definition.driver.accept(
    {
      source: 'provider-channel',
      bytes: new TextEncoder().encode(
        JSON.stringify({ type: 'event', event: 'connect.challenge', payload: { nonce: 'n' } })
      ),
      receivedAt: '2026-07-22T00:00:00.000Z'
    },
    sink
  );
  const connect = JSON.parse(sent[0] as string) as { id: string };
  await definition.driver.accept(
    {
      source: 'provider-channel',
      bytes: new TextEncoder().encode(JSON.stringify({ type: 'res', id: connect.id, ok: true, payload: {} })),
      receivedAt: '2026-07-22T00:00:01.000Z'
    },
    sink
  );
  const session = JSON.parse(sent[1] as string) as { id: string };
  await definition.driver.accept(
    {
      source: 'provider-channel',
      bytes: new TextEncoder().encode(
        JSON.stringify({ type: 'res', id: session.id, ok: true, payload: { key: 'agent:prd_expert:session:one' } })
      ),
      receivedAt: '2026-07-22T00:00:02.000Z'
    },
    sink
  );
  await definition.driver.sendTurn({ text: 'hello', attachments: [] });
  const steer = definition.driver.controls.steer;
  if (!steer) throw new Error('OpenClaw steer control required');
  await steer.send({ text: 'change direction', attachments: [] });
  const interrupt = definition.driver.controls.interrupt;
  if (!interrupt) throw new Error('OpenClaw interrupt control required');
  await interrupt.run();
  const approval = definition.driver.controls.approvalResolution;
  if (!approval) throw new Error('OpenClaw approval control required');
  await approval.resolve({ requestId: 'approval-1', allow: true });

  expect(events).toEqual([
    { type: 'provider_session_identified', payload: { providerSessionRef: 'agent:prd_expert:session:one' } }
  ]);
  expect(sent.slice(1).map((frame) => JSON.parse(frame))).toEqual([
    { type: 'req', id: '1', method: 'sessions.create', params: { agentId: 'prd_expert' } },
    {
      type: 'req',
      id: '2',
      method: 'sessions.send',
      params: { key: 'agent:prd_expert:session:one', message: 'hello' }
    },
    {
      type: 'req',
      id: '3',
      method: 'sessions.steer',
      params: { key: 'agent:prd_expert:session:one', message: 'change direction' }
    },
    {
      type: 'req',
      id: '4',
      method: 'sessions.abort',
      params: { key: 'agent:prd_expert:session:one' }
    },
    {
      type: 'req',
      id: '5',
      method: 'exec.approval.resolve',
      params: { id: 'approval-1', decision: 'allow-once' }
    }
  ]);
});

test('OpenClaw projects only the target chat stream and deduplicates its parallel assistant surface', () => {
  const projector = openClawMeshAgentAdapter.events.createLiveProjector?.({
    id: 'mesh-openclaw',
    providerSessionRef: 'agent:main:dashboard:target'
  });
  if (!projector) throw new Error('OpenClaw incremental projector required');
  const frames = [
    {
      type: 'event',
      event: 'agent',
      payload: {
        runId: 'other-run',
        sessionKey: 'agent:main:main',
        stream: 'lifecycle',
        data: { phase: 'start' }
      }
    },
    {
      type: 'event',
      event: 'agent',
      payload: {
        runId: 'target-run',
        sessionKey: 'agent:main:dashboard:target',
        stream: 'lifecycle',
        data: { phase: 'start' }
      }
    },
    {
      type: 'event',
      event: 'agent',
      payload: {
        runId: 'target-run',
        sessionKey: 'agent:main:dashboard:target',
        stream: 'assistant',
        data: { text: 'Hi', delta: 'Hi' }
      }
    },
    {
      type: 'event',
      event: 'chat',
      payload: {
        runId: 'target-run',
        sessionKey: 'agent:main:dashboard:target',
        state: 'delta',
        deltaText: 'Hi',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Hi' }] }
      }
    },
    {
      type: 'event',
      event: 'chat',
      payload: {
        runId: 'target-run',
        sessionKey: 'agent:main:dashboard:target',
        state: 'delta',
        deltaText: '!',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Hi!' }] }
      }
    },
    {
      type: 'event',
      event: 'chat',
      payload: {
        runId: 'target-run',
        sessionKey: 'agent:main:dashboard:target',
        state: 'final',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Hi!' }] }
      }
    },
    {
      type: 'event',
      event: 'agent',
      payload: {
        runId: 'target-run',
        sessionKey: 'agent:main:dashboard:target',
        stream: 'lifecycle',
        data: { phase: 'end' }
      }
    }
  ];
  const output = `gateway startup\n${frames.map((frame) => JSON.stringify(frame)).join('')}`;
  projector.advance(output.slice(0, 97));
  const events = projector.advance(output.slice(97)).events;
  expect(
    events.map((event) => {
      const neutral = toAgentObservationEvent(event, openClawMeshAgentAdapter.observation);
      return neutral ? { kind: neutral.kind, streaming: neutral.streaming, text: neutral.text } : null;
    })
  ).toEqual([
    { kind: 'turn-start', streaming: false, text: 'Message started' },
    { kind: 'assistant-message', streaming: false, text: 'Hi!' },
    { kind: 'turn-end', streaming: false, text: 'complete' }
  ]);
});

test('OpenClaw closes an errored turn and preserves the provider error message', () => {
  const events = openClawMeshAgentAdapter.events.projectLive({
    id: 'mesh-openclaw-error',
    mode: 'events',
    output: [
      {
        type: 'event',
        event: 'agent',
        payload: {
          runId: 'error-run',
          sessionKey: 'agent:main:dashboard:error',
          stream: 'lifecycle',
          data: { phase: 'start' }
        }
      },
      {
        type: 'event',
        event: 'agent',
        payload: {
          runId: 'error-run',
          sessionKey: 'agent:main:dashboard:error',
          stream: 'reasoning',
          data: { delta: 'Checking the project.' }
        }
      },
      {
        type: 'event',
        event: 'agent',
        payload: {
          runId: 'error-run',
          sessionKey: 'agent:main:dashboard:error',
          stream: 'lifecycle',
          data: { phase: 'error', stopReason: 'stop', error: 'Agent could not generate a response.' }
        }
      },
      {
        type: 'event',
        event: 'chat',
        payload: {
          runId: 'error-run',
          sessionKey: 'agent:main:dashboard:error',
          state: 'error',
          errorMessage: 'Agent could not generate a response.',
          message: { role: 'assistant', content: [{ type: 'text', text: 'Agent could not generate a response.' }] }
        }
      }
    ]
      .map((frame) => JSON.stringify(frame))
      .join('')
  }).events;

  expect(
    events.map((event) => {
      const neutral = toAgentObservationEvent(event, openClawMeshAgentAdapter.observation);
      return neutral ? { kind: neutral.kind, streaming: neutral.streaming, text: neutral.text } : null;
    })
  ).toEqual([
    { kind: 'turn-start', streaming: false, text: 'Message started' },
    { kind: 'reasoning', streaming: true, text: 'Checking the project.' },
    { kind: 'turn-end', streaming: false, text: 'Agent could not generate a response.' },
    { kind: 'assistant-message', streaming: false, text: 'Agent could not generate a response.' }
  ]);
});

test('OpenClaw history maps user, reasoning blocks, and assistant text separately', () => {
  const events = openClawMeshAgentAdapter.events.projectLive({
    id: 'stored-openclaw',
    mode: 'events',
    output: [
      JSON.stringify({
        type: 'message',
        id: 'user-1',
        timestamp: '2026-08-09T13:20:59.901Z',
        message: { role: 'user', content: 'hi', timestamp: 1_786_281_659_928 }
      }),
      JSON.stringify({
        type: 'message',
        id: 'assistant-1',
        message: {
          role: 'assistant',
          timestamp: 1_786_281_671_507,
          content: [
            { type: 'thinking', thinking: 'Inspect the batch.' },
            { type: 'text', text: 'Done.' }
          ]
        }
      })
    ].join('\n')
  }).events;
  expect(
    events.map((event) => {
      const neutral = toAgentObservationEvent(event, openClawMeshAgentAdapter.observation);
      return neutral ? { kind: neutral.kind, text: neutral.text, at: neutral.at } : null;
    })
  ).toEqual([
    { kind: 'user-message', text: 'hi', at: '2026-08-09T13:20:59.901Z' },
    { kind: 'reasoning', text: 'Inspect the batch.', at: '2026-08-09T13:21:11.507Z' },
    { kind: 'assistant-message', text: 'Done.', at: '2026-08-09T13:21:11.507Z' }
  ]);
});

test('OpenClaw history pairs Monad tool calls and results into the semantic chat card', () => {
  const input = { text: 'Joined as monad CLI agent', requestId: 'idem_openclaw_join' };
  const output = { ok: true, message: { id: 'msg_openclaw_join', text: input.text } };
  const projected = openClawMeshAgentAdapter.events.projectLive({
    id: 'stored-openclaw-tools',
    mode: 'events',
    output: [
      JSON.stringify({
        type: 'message',
        id: 'assistant-tool-call',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'Post the join status.' },
            {
              type: 'toolCall',
              id: 'call-openclaw-project-post',
              name: 'monad__project_post',
              arguments: input
            }
          ]
        }
      }),
      JSON.stringify({
        type: 'message',
        id: 'tool-result',
        message: {
          role: 'toolResult',
          toolCallId: 'call-openclaw-project-post',
          toolName: 'monad__project_post',
          content: [{ type: 'text', text: JSON.stringify(output) }],
          details: { mcpServer: 'monad', mcpTool: 'project_post' },
          isError: false
        }
      })
    ].join('\n')
  });
  const events = projected.events.flatMap((event) => {
    const neutral = toAgentObservationEvent(event, openClawMeshAgentAdapter.observation);
    return neutral ? [neutral] : [];
  });
  const card = agentObservationCards(events, 'openclaw').find((candidate) => candidate.kind === 'tool');
  if (!card) throw new Error('OpenClaw Monad tool card required');
  const call = card.payload.call;
  if (!call || typeof call !== 'object') throw new Error('OpenClaw Monad tool call required');

  expect({
    events: events.map(({ kind, tool }) => ({ kind, tool })),
    view: monadMcpToolView(
      call as Parameters<typeof monadMcpToolView>[0],
      card.payload.result as Parameters<typeof monadMcpToolView>[1],
      card.provenance.contractEvents
    )
  }).toEqual({
    events: [
      { kind: 'reasoning', tool: undefined },
      {
        kind: 'tool-call',
        tool: {
          name: 'monad__project_post',
          input,
          callId: 'call-openclaw-project-post'
        }
      },
      {
        kind: 'tool-result',
        tool: {
          name: 'monad__project_post',
          output: [{ type: 'text', text: JSON.stringify(output) }],
          callId: 'call-openclaw-project-post',
          status: 'completed'
        }
      }
    ],
    view: {
      toolName: 'project_post',
      callId: 'call-openclaw-project-post',
      status: 'completed',
      input,
      output: [{ type: 'text', text: JSON.stringify(output) }],
      isError: false,
      action: 'project-post',
      text: input.text,
      attachments: []
    }
  });
});

test('OpenClaw turn echo projects the accepted user message the gateway never sends back', () => {
  const events = openClawMeshAgentAdapter.events.projectLive({
    id: 'live-openclaw',
    output: [
      echoOpenClawInput('run the tests'),
      JSON.stringify({
        type: 'message',
        id: 'assistant-1',
        message: { role: 'assistant', timestamp: 1_786_281_671_507, content: [{ type: 'text', text: 'Done.' }] }
      })
    ].join('')
  }).events;

  expect(
    events.map((event) => {
      const neutral = toAgentObservationEvent(event, openClawMeshAgentAdapter.observation);
      return neutral ? { kind: neutral.kind, text: neutral.text } : null;
    })
  ).toEqual([
    { kind: 'user-message', text: 'run the tests' },
    { kind: 'assistant-message', text: 'Done.' }
  ]);
});
