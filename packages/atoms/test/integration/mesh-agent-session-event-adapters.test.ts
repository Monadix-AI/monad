import type { MeshAgentView } from '@monad/protocol';
import type { MeshAgentSessionEvent, ResidentProviderDriver } from '@monad/sdk-atom';

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { antigravityMeshAgentAdapter } from '../../src/agent-adapters/antigravity/index.ts';
import { claudeCodeMeshAgentAdapter } from '../../src/agent-adapters/claude-code/index.ts';
import { codexMeshAgentAdapter } from '../../src/agent-adapters/codex/index.ts';
import { geminiMeshAgentAdapter } from '../../src/agent-adapters/gemini/index.ts';
import { monadMeshAgentAdapter } from '../../src/agent-adapters/monad/index.ts';
import { qwenMeshAgentAdapter } from '../../src/agent-adapters/qwen/index.ts';

function agent(provider: 'antigravity' | 'codex' | 'claude-code' | 'gemini' | 'qwen'): MeshAgentView {
  return {
    name: provider,
    provider,
    productIcon: provider,
    command: provider === 'claude-code' ? 'claude' : provider === 'antigravity' ? 'agy' : provider,
    args: [],
    enabled: true,
    allowAutopilot: false,
    approvalOwnership: 'provider-owned'
  };
}

test('Antigravity applies the effective working path to every turn launch', () => {
  const definition = antigravityMeshAgentAdapter.createSessionRuntime?.(agent('antigravity'), {
    workingPath: '/workspace'
  });
  if (definition?.plan.processModel !== 'per-turn') throw new Error('Antigravity per-turn runtime required');

  expect(definition.plan.buildTurnLaunch({}).cwd).toBe('/workspace');
});

test('Antigravity selects the managed custom agent without folding instructions into user input', () => {
  const definition = antigravityMeshAgentAdapter.createSessionRuntime?.(agent('antigravity'), {
    workingPath: '/workspace',
    extraWorkingPaths: ['/managed'],
    startInput: {
      immutableInstructions: { text: 'Managed Antigravity instructions', file: '/managed/prompt.md' },
      initialTurn: { text: 'hello', attachments: [] }
    }
  });
  if (definition?.plan.processModel !== 'per-turn') throw new Error('Antigravity per-turn runtime required');

  expect(definition.plan.buildTurnLaunch({}).args).toEqual([
    '--output-format',
    'stream-json',
    '--agent',
    'monad-managed',
    '--add-dir',
    '/managed'
  ]);
  expect(definition.plan.encodeTurnInput?.({ text: 'hello', attachments: [] })).toEqual({
    delivery: 'argv-tail',
    values: ['--print', 'hello']
  });
});

async function collectResident(driver: ResidentProviderDriver, chunks: string[]): Promise<MeshAgentSessionEvent[]> {
  const events: MeshAgentSessionEvent[] = [];
  await driver.attachChannel({ async send() {}, async close() {} }, {});
  for (const chunk of chunks) {
    await driver.accept(
      {
        bytes: new TextEncoder().encode(chunk),
        source: 'stdout',
        receivedAt: '2026-07-30T00:00:00.000Z'
      },
      {
        async emit(event) {
          events.push(event);
        }
      }
    );
  }
  return events;
}

describe('Codex resident app-server runtime', () => {
  test('builds one resident launch with a bounded idle policy', () => {
    const definition = codexMeshAgentAdapter.createSessionRuntime?.(agent('codex'), {
      workingPath: '/workspace',
      modelId: 'gpt-5.4',
      reasoningEffort: 'high'
    });
    if (definition?.plan.processModel !== 'resident') throw new Error('Codex resident runtime required');
    expect(definition.plan).toEqual({
      processModel: 'resident',
      launch: { args: ['app-server', '--stdio'], cwd: '/workspace' },
      channel: { kind: 'child-stdio' },
      startup: { timeoutMs: 20_000 },
      suspend: { idleTimeoutMs: 300_000 }
    });
  });

  test('enables the documented fast service tier for a fast session', () => {
    const definition = codexMeshAgentAdapter.createSessionRuntime?.(agent('codex'), {
      workingPath: '/workspace',
      speed: 'fast'
    });
    if (definition?.plan.processModel !== 'resident') throw new Error('Codex resident runtime required');
    expect(definition.plan.launch).toEqual({
      args: ['-c', 'features.fast_mode=true', '-c', 'service_tier="fast"', 'app-server', '--stdio'],
      cwd: '/workspace'
    });
  });

  test('keeps stderr diagnostics out of the Codex JSON protocol stream', async () => {
    const definition = codexMeshAgentAdapter.createSessionRuntime?.(agent('codex'), {
      workingPath: '/workspace'
    });
    if (definition?.plan.processModel !== 'resident') throw new Error('Codex resident runtime required');
    const events: MeshAgentSessionEvent[] = [];
    const sink = {
      async emit(event: MeshAgentSessionEvent) {
        events.push(event);
      }
    };

    await definition.driver.accept(
      {
        source: 'stderr',
        bytes: new TextEncoder().encode('error: app-server diagnostic\n'),
        receivedAt: '2026-08-03T06:51:47.000Z'
      },
      sink
    );
    await definition.driver.accept(
      {
        source: 'stdout',
        bytes: new TextEncoder().encode(
          `${JSON.stringify({ method: 'item/agentMessage/delta', params: { delta: 'OK' } })}\n`
        ),
        receivedAt: '2026-08-03T06:51:48.000Z'
      },
      sink
    );

    expect(events).toEqual([{ type: 'agent_message', payload: { text: 'OK' } }]);
  });

  test('starts, steers accepted mid-turn messages, then starts again after completion', async () => {
    const definition = codexMeshAgentAdapter.createSessionRuntime?.(agent('codex'), {
      workingPath: '/workspace',
      modelId: 'gpt-5.4',
      reasoningEffort: 'high',
      startInput: {
        immutableInstructions: { text: 'Post through the Monad bridge.', file: '/managed/AGENTS.md' },
        initialTurn: { text: 'first', attachments: [] }
      }
    });
    if (definition?.plan.processModel !== 'resident') throw new Error('Codex resident runtime required');
    const residentDriver = definition.driver as ResidentProviderDriver;
    const sent: string[] = [];
    const events: MeshAgentSessionEvent[] = [];
    const sink = {
      async emit(event: MeshAgentSessionEvent) {
        events.push(event);
      }
    };
    await residentDriver.openSession({ workingPath: '/workspace' });
    const attached = residentDriver.attachChannel(
      {
        async send(frame) {
          sent.push(String(frame));
        },
        async close() {}
      },
      {}
    );
    await Bun.sleep(0);
    const respond = async (id: number, result: unknown) => {
      await residentDriver.accept(
        {
          bytes: new TextEncoder().encode(`${JSON.stringify({ id, result })}\n`),
          source: 'stdout',
          receivedAt: '2026-07-30T00:00:00.000Z'
        },
        sink
      );
      await Bun.sleep(0);
    };
    await respond(1, {});
    await respond(2, { thread: { id: 'thread-1' } });
    await attached;

    const first = residentDriver.sendTurn({ text: 'first', attachments: [] });
    await Bun.sleep(0);
    let firstSettled = false;
    void first.then(() => {
      firstSettled = true;
    });
    expect(firstSettled).toBe(false);
    await respond(3, { turn: { id: 'turn-1' } });
    await first;

    const second = residentDriver.sendTurn({ text: 'focus on tests', attachments: [] });
    await Bun.sleep(0);
    await respond(4, { turnId: 'turn-1' });
    await second;
    await residentDriver.accept(
      {
        bytes: new TextEncoder().encode(
          `${JSON.stringify({
            method: 'item/agentMessage/delta',
            params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'answer-1', delta: 'do' }
          })}\n`
        ),
        source: 'stdout',
        receivedAt: '2026-07-30T00:00:00.500Z'
      },
      sink
    );
    await residentDriver.accept(
      {
        bytes: new TextEncoder().encode(
          `${JSON.stringify({
            method: 'thread/tokenUsage/updated',
            params: {
              threadId: 'thread-1',
              tokenUsage: {
                total: {
                  totalTokens: 14,
                  inputTokens: 10,
                  cachedInputTokens: 6,
                  outputTokens: 4,
                  reasoningOutputTokens: 2
                },
                last: { totalTokens: 8, inputTokens: 6, outputTokens: 2 },
                modelContextWindow: 100
              }
            }
          })}\n`
        ),
        source: 'stdout',
        receivedAt: '2026-07-30T00:00:00.750Z'
      },
      sink
    );
    await residentDriver.accept(
      {
        bytes: new TextEncoder().encode(
          `${JSON.stringify({
            method: 'turn/completed',
            params: {
              threadId: 'thread-1',
              turn: { id: 'turn-1', items: [{ type: 'agentMessage', id: 'answer-1', text: 'done' }] }
            }
          })}\n`
        ),
        source: 'stdout',
        receivedAt: '2026-07-30T00:00:01.000Z'
      },
      sink
    );

    const third = residentDriver.sendTurn({ text: 'next task', attachments: [] });
    await Bun.sleep(0);
    await respond(5, { turn: { id: 'turn-2' } });
    await third;

    expect(sent.map((line) => JSON.parse(line))).toEqual([
      {
        method: 'initialize',
        id: 1,
        params: {
          clientInfo: { name: 'monad', title: 'Monad', version: '0.0.1' },
          capabilities: { experimentalApi: true, requestAttestation: false }
        }
      },
      { method: 'initialized', params: {} },
      {
        method: 'thread/start',
        id: 2,
        params: {
          cwd: '/workspace',
          model: 'gpt-5.4',
          developerInstructions: 'Post through the Monad bridge.'
        }
      },
      {
        method: 'turn/start',
        id: 3,
        params: {
          threadId: 'thread-1',
          clientUserMessageId: 'monad-1',
          input: [{ type: 'text', text: 'first', text_elements: [] }],
          model: 'gpt-5.4',
          effort: 'high',
          summary: 'auto'
        }
      },
      {
        method: 'turn/steer',
        id: 4,
        params: {
          threadId: 'thread-1',
          expectedTurnId: 'turn-1',
          clientUserMessageId: 'monad-2',
          input: [{ type: 'text', text: 'focus on tests', text_elements: [] }]
        }
      },
      {
        method: 'turn/start',
        id: 5,
        params: {
          threadId: 'thread-1',
          clientUserMessageId: 'monad-3',
          input: [{ type: 'text', text: 'next task', text_elements: [] }],
          model: 'gpt-5.4',
          effort: 'high',
          summary: 'auto'
        }
      }
    ]);
    expect(events).toEqual([
      { type: 'provider_session_identified', payload: { providerSessionRef: 'thread-1' } },
      { type: 'agent_message', payload: { text: 'do' } },
      {
        type: 'session_usage_updated',
        payload: {
          total: 14,
          input: 10,
          output: 4,
          cachedInput: 6,
          reasoningOutput: 2,
          context: { used: 8, window: 100 }
        }
      },
      { type: 'agent_message', payload: { text: 'done', final: true } }
    ]);
  });

  test('carries daemon-prepared managed context without exposing runtime topology', () => {
    const definition = codexMeshAgentAdapter.createSessionRuntime?.(agent('codex'), {
      workingPath: '/workspace',
      extraWorkingPaths: ['/managed'],
      startInput: {
        immutableInstructions: { text: 'Post through the Monad bridge.', file: '/managed/prompt.md' },
        initialTurn: { text: 'hello', attachments: [] }
      },
      skipProviderApprovals: true,
      mcpConfigArgs: ['-c', 'mcp_servers.monad.command="monad"'],
      env: { MONAD_AGENT_RUNTIME_TOKEN: 'token' }
    });
    if (definition?.plan.processModel !== 'resident') throw new Error('Codex resident runtime required');
    expect(definition.plan.launch).toEqual({
      args: [
        '--add-dir',
        '/managed',
        '--ask-for-approval',
        'never',
        '-c',
        'mcp_servers.monad.command="monad"',
        'app-server',
        '--stdio'
      ],
      cwd: '/workspace',
      env: { MONAD_AGENT_RUNTIME_TOKEN: 'token' }
    });
  });

  test('keeps a configured approval policy before the app-server subcommand', () => {
    const definition = codexMeshAgentAdapter.createSessionRuntime?.(
      { ...agent('codex'), args: ['--ask-for-approval', 'on-request'] },
      { workingPath: '/workspace' }
    );
    if (definition?.plan.processModel !== 'resident') throw new Error('Codex resident runtime required');
    expect(definition.plan.launch.args).toEqual(['--ask-for-approval', 'on-request', 'app-server', '--stdio']);
  });
});

describe('Qwen resident session-event runtime', () => {
  test('appends managed instructions through Qwen native system prompt configuration', () => {
    const root = mkdtempSync(join(tmpdir(), 'monad-qwen-instructions-'));
    const promptFile = join(root, 'prompt.md');
    writeFileSync(promptFile, 'Post through Monad.');
    try {
      const definition = qwenMeshAgentAdapter.createSessionRuntime?.(agent('qwen'), {
        workingPath: '/workspace',
        startInput: {
          immutableInstructions: { text: 'Post through Monad.', file: promptFile },
          initialTurn: { text: 'hello', attachments: [] }
        }
      });
      if (definition?.plan.processModel !== 'resident') throw new Error('Qwen resident runtime required');
      expect(definition.plan.launch.args).toEqual([
        '--append-system-prompt',
        'Post through Monad.',
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json'
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('owns stream-json framing, session identity, and approval correlation in its driver', async () => {
    const definition = qwenMeshAgentAdapter.createSessionRuntime?.(agent('qwen'), {
      workingPath: '/workspace',
      providerSessionRef: 'qwen-1',
      modelId: 'qwen3-coder'
    });
    if (definition?.plan.processModel !== 'resident' || definition.driver.processModel !== 'resident')
      throw new Error('Qwen resident runtime required');
    expect(definition.plan.launch).toEqual({
      args: [
        '--resume',
        'qwen-1',
        '--model',
        'qwen3-coder',
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json'
      ],
      cwd: '/workspace'
    });
    const sent: string[] = [];
    expect(await definition.driver.openSession({ workingPath: '/workspace', providerSessionRef: 'qwen-1' })).toEqual({
      capabilities: {
        input: true,
        steer: true,
        interrupt: true,
        approvalResolution: true,
        providerSessionContinuation: true,
        runtimeRestoration: true,
        sessionReopen: true
      }
    });
    await definition.driver.attachChannel(
      {
        async send(frame) {
          sent.push(String(frame));
        },
        async close() {}
      },
      { providerSessionRef: 'qwen-1' }
    );
    await definition.driver.sendTurn({
      text: 'hello',
      attachments: [{ id: 'att_spec', name: 'spec.md', path: '/workspace/spec.md', mime: 'text/markdown', bytes: 42 }]
    });
    const events: MeshAgentSessionEvent[] = [];
    await definition.driver.accept(
      {
        bytes: new TextEncoder().encode(
          '{"type":"system","subtype":"init","session_id":"qwen-1"}\n{"type":"control_request","request_id":"approval-1","request":{"subtype":"can_use_tool","tool_name":"shell","input":{"command":"pwd"}}}\n'
        ),
        source: 'stdout',
        receivedAt: '2026-07-19T00:00:00.000Z'
      },
      {
        async emit(event) {
          events.push(event);
        }
      }
    );
    expect(events).toEqual([
      { type: 'provider_session_identified', payload: { providerSessionRef: 'qwen-1' } },
      {
        type: 'approval_requested',
        payload: { requestId: 'approval-1', kind: 'can_use_tool', tool: 'shell', input: { command: 'pwd' } }
      }
    ]);
    const approval = definition.driver.controls.approvalResolution;
    if (!approval) throw new Error('Qwen approval control required');
    await approval.resolve({ requestId: 'approval-1', allow: true });
    const interrupt = definition.driver.controls.interrupt;
    if (!interrupt) throw new Error('Qwen interrupt control required');
    await interrupt.run();
    expect(sent.map((line) => JSON.parse(line))).toEqual([
      { type: 'control_request', request_id: 'init-0', request: { subtype: 'initialize', hooks: null } },
      {
        type: 'user',
        session_id: 'qwen-1',
        parent_tool_use_id: null,
        message: {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'hello\n\nAttachments available in the workspace:\n- spec.md: /workspace/spec.md'
            }
          ]
        }
      },
      {
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: 'approval-1',
          response: { behavior: 'allow', updatedInput: { command: 'pwd' } }
        }
      },
      {
        type: 'control_request',
        request_id: 'interrupt-1',
        request: { subtype: 'interrupt' }
      }
    ]);
  });
});

describe('Monad resident session-event runtime', () => {
  test('owns app-server framing, exact Studio agent selection, resume, and controls', async () => {
    const definition = monadMeshAgentAdapter.createSessionRuntime?.(
      {
        name: 'monad-architect',
        provider: 'monad',
        productIcon: 'monad',
        command: 'monad',
        enabled: true,
        allowAutopilot: false,
        approvalOwnership: 'provider-owned',
        adapterSettings: { agentId: 'agt_1234567890ab' }
      },
      {
        workingPath: '/workspace',
        providerSessionRef: 'ses_1234567890ab',
        managedMcpServer: {
          name: 'monad',
          command: 'monad',
          args: ['native-agent', 'mcp-server'],
          env: { MONAD_MESH_SESSION_ID: 'mesh_1234567890ab' }
        }
      }
    );
    if (definition?.plan.processModel !== 'resident' || definition.driver.processModel !== 'resident')
      throw new Error('Monad resident runtime required');
    expect(definition.plan).toEqual({
      processModel: 'resident',
      launch: { args: ['app-server'], cwd: '/workspace' },
      channel: { kind: 'child-stdio' },
      startup: { timeoutMs: 20_000 }
    });

    const sent: string[] = [];
    const events: MeshAgentSessionEvent[] = [];
    const sink = {
      async emit(event: MeshAgentSessionEvent) {
        events.push(event);
      }
    };
    await definition.driver.openSession({ workingPath: '/workspace', providerSessionRef: 'ses_1234567890ab' });
    const attached = definition.driver.attachChannel(
      {
        async send(frame) {
          sent.push(String(frame));
        },
        async close() {}
      },
      { providerSessionRef: 'ses_1234567890ab' }
    );
    await Bun.sleep(0);
    await definition.driver.accept(
      {
        bytes: new TextEncoder().encode(
          `${JSON.stringify({
            kind: 'response',
            id: '1',
            method: 'initialize',
            result: {
              protocolVersion: 1,
              capabilities: {
                input: true,
                steer: true,
                interrupt: true,
                approvalResolution: true,
                providerSessionContinuation: true,
                runtimeRestoration: true,
                sessionReopen: true
              }
            }
          })}\n`
        ),
        source: 'stdout',
        receivedAt: '2026-07-22T00:00:00.000Z'
      },
      sink
    );
    await Bun.sleep(0);
    await definition.driver.accept(
      {
        bytes: new TextEncoder().encode(
          `${[
            {
              kind: 'response',
              id: '2',
              method: 'session/open',
              result: { sessionId: 'ses_1234567890ab' }
            },
            {
              kind: 'notification',
              method: 'session/identified',
              params: { sessionId: 'ses_1234567890ab' }
            },
            {
              kind: 'notification',
              method: 'session/event',
              params: {
                event: {
                  id: 'evt_1234567890ab',
                  sessionId: 'ses_1234567890ab',
                  type: 'tool.called',
                  actorAgentId: 'agt_1234567890ab',
                  payload: { toolCallId: 'call-1', tool: 'shell', input: { command: 'pwd' } },
                  at: '2026-07-22T00:00:00.000Z'
                }
              }
            },
            {
              kind: 'notification',
              method: 'session/event',
              params: {
                event: {
                  id: 'evt_abcdef123456',
                  sessionId: 'ses_1234567890ab',
                  type: 'session.message.completed',
                  actorAgentId: 'agt_1234567890ab',
                  payload: {
                    transcriptTargetId: 'ses_1234567890ab',
                    producer: { kind: 'agent', agentId: 'agt_1234567890ab' },
                    message: {
                      id: 'msg_1234567890ab',
                      sessionId: 'ses_1234567890ab',
                      role: 'assistant',
                      text: 'done',
                      type: 'text',
                      stream: { status: 'complete' },
                      active: true,
                      createdAt: '2026-07-22T00:00:00.000Z'
                    },
                    messageRevision: 2
                  },
                  at: '2026-07-22T00:00:01.000Z'
                }
              }
            }
          ]
            .map((message) => JSON.stringify(message))
            .join('\n')}\n`
        ),
        source: 'stdout',
        receivedAt: '2026-07-22T00:00:01.000Z'
      },
      sink
    );
    await attached;
    const respond = async (id: string, method: string, result: unknown) => {
      await definition.driver.accept(
        {
          bytes: new TextEncoder().encode(`${JSON.stringify({ kind: 'response', id, method, result })}\n`),
          source: 'stdout',
          receivedAt: '2026-07-22T00:00:02.000Z'
        },
        sink
      );
    };
    const turn = definition.driver.sendTurn({ text: 'hello', attachments: [] });
    await Bun.sleep(0);
    await respond('3', 'turn/start', { accepted: true });
    await turn;
    const steer = definition.driver.controls.steer;
    const interrupt = definition.driver.controls.interrupt;
    const approval = definition.driver.controls.approvalResolution;
    if (!steer || !interrupt || !approval) throw new Error('Monad controls required');
    const steering = steer.send({ text: 'focus', attachments: [] });
    await Bun.sleep(0);
    await respond('4', 'turn/steer', { accepted: true });
    await steering;
    const interrupting = interrupt.run();
    await Bun.sleep(0);
    await respond('5', 'turn/interrupt', { ok: true });
    await interrupting;
    const resolving = approval.resolve({ requestId: 'approval-1', allow: true, scope: 'session' });
    await Bun.sleep(0);
    await respond('6', 'approval/resolve', { ok: true });
    await resolving;

    expect(sent.map((line) => JSON.parse(line))).toEqual([
      { kind: 'request', id: '1', method: 'initialize', params: { protocolVersion: 1 } },
      {
        kind: 'request',
        id: '2',
        method: 'session/open',
        params: {
          agentId: 'agt_1234567890ab',
          cwd: '/workspace',
          providerSessionRef: 'ses_1234567890ab',
          mcpServers: [
            {
              name: 'monad',
              command: 'monad',
              args: ['native-agent', 'mcp-server'],
              env: { MONAD_MESH_SESSION_ID: 'mesh_1234567890ab' }
            }
          ]
        }
      },
      {
        kind: 'request',
        id: '3',
        method: 'turn/start',
        params: { sessionId: 'ses_1234567890ab', input: { text: 'hello', attachments: [] } }
      },
      {
        kind: 'request',
        id: '4',
        method: 'turn/steer',
        params: { sessionId: 'ses_1234567890ab', input: { text: 'focus', attachments: [] } }
      },
      {
        kind: 'request',
        id: '5',
        method: 'turn/interrupt',
        params: { sessionId: 'ses_1234567890ab' }
      },
      {
        kind: 'request',
        id: '6',
        method: 'approval/resolve',
        params: { sessionId: 'ses_1234567890ab', requestId: 'approval-1', allow: true, scope: 'session' }
      }
    ]);
    expect(events).toEqual([
      { type: 'provider_session_identified', payload: { providerSessionRef: 'ses_1234567890ab' } },
      { type: 'tool_call', payload: { callId: 'call-1', tool: 'shell', input: { command: 'pwd' } } },
      { type: 'agent_message', payload: { text: 'done', final: true } }
    ]);
  });
});

describe('Gemini resident ACP session-event runtime', () => {
  test('owns ACP session setup, interrupt, output, and approval correlation without advertising steer', async () => {
    const definition = geminiMeshAgentAdapter.createSessionRuntime?.(agent('gemini'), {
      workingPath: '/workspace',
      extraWorkingPaths: ['/managed'],
      modelId: 'gemini-2.5-pro',
      managedMcpServer: {
        name: 'monad',
        command: '/bin/monad',
        args: ['native-agent', 'mcp-server'],
        env: { MONAD_AGENT_RUNTIME_TOKEN: 'token' }
      }
    });
    if (definition?.plan.processModel !== 'resident' || definition.driver.processModel !== 'resident')
      throw new Error('Gemini resident runtime required');
    expect(definition.plan).toEqual({
      processModel: 'resident',
      launch: {
        args: ['--model', 'gemini-2.5-pro', '--include-directories', '/managed', '--acp'],
        cwd: '/workspace'
      },
      channel: { kind: 'child-stdio' },
      startup: { timeoutMs: 20_000 },
      suspend: { idleTimeoutMs: 300_000 }
    });
    expect(await definition.driver.openSession({ workingPath: '/workspace' })).toEqual({
      capabilities: {
        input: true,
        steer: false,
        interrupt: true,
        approvalResolution: true,
        providerSessionContinuation: true,
        runtimeRestoration: true,
        sessionReopen: true
      }
    });
    const sent: string[] = [];
    const events: MeshAgentSessionEvent[] = [];
    const sink = {
      async emit(event: MeshAgentSessionEvent) {
        events.push(event);
      }
    };
    await definition.driver.attachChannel(
      {
        async send(frame) {
          sent.push(String(frame));
        },
        async close() {}
      },
      {}
    );
    const accept = async (value: unknown) => {
      await definition.driver.accept(
        {
          bytes: new TextEncoder().encode(`${JSON.stringify(value)}\n`),
          source: 'stdout',
          receivedAt: '2026-07-30T00:00:00.000Z'
        },
        sink
      );
      await Bun.sleep(0);
    };
    await accept({
      jsonrpc: '2.0',
      id: 1,
      result: { protocolVersion: 1, agentCapabilities: { loadSession: true } }
    });
    await accept({ jsonrpc: '2.0', id: 2, result: { sessionId: 'gemini-1' } });
    await definition.driver.sendTurn({
      text: 'hello',
      attachments: [{ id: 'att_spec', name: 'spec.md', path: '/workspace/spec.md', mime: 'text/markdown', bytes: 42 }]
    });
    expect(definition.driver.controls.steer).toBe(false);
    const interrupt = definition.driver.controls.interrupt;
    if (!interrupt) throw new Error('Gemini interrupt control required');
    await interrupt.run();
    await accept({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'gemini-1',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } }
      }
    });
    await accept({ jsonrpc: '2.0', id: 3, result: { stopReason: 'end_turn' } });
    await accept({
      jsonrpc: '2.0',
      id: 'permission-1',
      method: 'session/request_permission',
      params: {
        sessionId: 'gemini-1',
        toolCall: { toolCallId: 'call-1', name: 'shell', rawInput: { command: 'pwd' } },
        options: [
          { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' }
        ]
      }
    });
    const approval = definition.driver.controls.approvalResolution;
    if (!approval) throw new Error('Gemini approval control required');
    await approval.resolve({ requestId: 'permission-1', allow: true });

    expect(sent.map((line) => JSON.parse(line))).toEqual([
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: 1,
          clientCapabilities: {},
          clientInfo: { name: 'monad', version: '0.0.1' }
        }
      },
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'session/new',
        params: {
          cwd: '/workspace',
          additionalDirectories: ['/managed'],
          mcpServers: [
            {
              name: 'monad',
              command: '/bin/monad',
              args: ['native-agent', 'mcp-server'],
              env: [{ name: 'MONAD_AGENT_RUNTIME_TOKEN', value: 'token' }]
            }
          ]
        }
      },
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'session/prompt',
        params: {
          sessionId: 'gemini-1',
          prompt: [
            {
              type: 'text',
              text: 'hello\n\nAttachments available in the workspace:\n- spec.md: /workspace/spec.md'
            }
          ]
        }
      },
      { jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 'gemini-1' } },
      {
        jsonrpc: '2.0',
        id: 'permission-1',
        result: { outcome: { outcome: 'selected', optionId: 'allow-once' } }
      }
    ]);
    expect(events).toEqual([
      { type: 'provider_session_identified', payload: { providerSessionRef: 'gemini-1' } },
      { type: 'agent_message', payload: { text: 'done' } },
      { type: 'agent_message', payload: { text: 'done', final: true } },
      {
        type: 'approval_requested',
        payload: {
          requestId: 'permission-1',
          kind: 'can_use_tool',
          callId: 'call-1',
          tool: 'shell',
          input: { command: 'pwd' },
          options: [
            { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' }
          ]
        }
      }
    ]);
  });

  test('loads an existing provider session through ACP instead of CLI rollout files', async () => {
    const definition = geminiMeshAgentAdapter.createSessionRuntime?.(agent('gemini'), {
      workingPath: '/workspace',
      providerSessionRef: 'gemini-existing'
    });
    if (definition?.plan.processModel !== 'resident' || definition.driver.processModel !== 'resident')
      throw new Error('Gemini resident runtime required');
    const sent: string[] = [];
    await definition.driver.attachChannel(
      {
        async send(frame) {
          sent.push(String(frame));
        },
        async close() {}
      },
      { providerSessionRef: 'gemini-existing' }
    );
    await definition.driver.accept(
      {
        bytes: new TextEncoder().encode(
          `${JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: { protocolVersion: 1, agentCapabilities: { loadSession: true } }
          })}\n`
        ),
        source: 'stdout',
        receivedAt: '2026-07-30T00:00:00.000Z'
      },
      { async emit() {} }
    );
    await Bun.sleep(0);
    expect(sent.map((line) => JSON.parse(line))).toEqual([
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: 1,
          clientCapabilities: {},
          clientInfo: { name: 'monad', version: '0.0.1' }
        }
      },
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'session/load',
        params: {
          cwd: '/workspace',
          additionalDirectories: [],
          mcpServers: [],
          sessionId: 'gemini-existing'
        }
      }
    ]);
  });

  test('loads managed instructions from the renamed Gemini context file', () => {
    const root = mkdtempSync(join(tmpdir(), 'monad-gemini-instructions-'));
    const managedEnv = geminiMeshAgentAdapter.managedRuntime?.env?.({
      workspace: root,
      workingPath: '/workspace',
      immutableInstructions: { text: 'Managed Gemini instructions', file: join(root, 'custom-system-prompt.md') },
      skipProviderApprovals: true
    });
    const settingsFile = join(root, 'gemini-system-settings.json');
    expect(managedEnv).toEqual({ GEMINI_CLI_SYSTEM_SETTINGS_PATH: settingsFile });
    expect(JSON.parse(readFileSync(settingsFile, 'utf8'))).toEqual({
      context: {
        fileName: 'custom-system-prompt.md',
        loadMemoryFromIncludeDirectories: true
      }
    });
    const definition = geminiMeshAgentAdapter.createSessionRuntime?.(agent('gemini'), {
      workingPath: '/workspace',
      extraWorkingPaths: [root],
      startInput: {
        immutableInstructions: { text: 'Post through Monad.', file: join(root, 'custom-system-prompt.md') },
        initialTurn: { text: 'hello', attachments: [] }
      },
      env: managedEnv
    });
    if (definition?.plan.processModel !== 'resident') throw new Error('Gemini resident runtime required');
    expect(definition.plan.launch).toEqual({
      args: ['--include-directories', root, '--acp'],
      cwd: '/workspace',
      env: { GEMINI_CLI_SYSTEM_SETTINGS_PATH: settingsFile }
    });
    rmSync(root, { recursive: true, force: true });
  });
});

describe('Claude Code resident session-event runtime', () => {
  test('uses the Claude auth login subcommand for provider-owned login', () => {
    const launch = claudeCodeMeshAgentAdapter.buildAuthLaunch(agent('claude-code'));
    expect(launch).toEqual({
      argv: ['claude', 'auth', 'login'],
      cwd: homedir(),
      env: undefined
    });
  });

  test('builds stream-json launches and resumes the provider session', () => {
    const definition = claudeCodeMeshAgentAdapter.createSessionRuntime?.(agent('claude-code'), {
      workingPath: '/workspace',
      modelId: 'sonnet',
      reasoningEffort: 'high'
    });
    if (definition?.plan.processModel !== 'resident') throw new Error('Claude resident runtime required');
    if (!definition.plan.buildLaunch) throw new Error('Claude dynamic launch required');
    const initial = definition.plan.buildLaunch({});
    expect(initial).toEqual({
      args: [
        '-p',
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
        '--verbose',
        '--include-partial-messages',
        '--replay-user-messages',
        '--model',
        'sonnet',
        '--effort',
        'high',
        '--thinking-display',
        'summarized'
      ],
      cwd: '/workspace'
    });
    expect(definition.plan.buildLaunch({ providerSessionRef: 'claude-1' })).toEqual({
      ...initial,
      args: [...initial.args, '--resume', 'claude-1']
    });
    expect({
      channel: definition.plan.channel,
      startup: definition.plan.startup,
      suspend: definition.plan.suspend
    }).toEqual({
      channel: { kind: 'child-stdio' },
      startup: { timeoutMs: 20_000 },
      suspend: { idleTimeoutMs: 300_000 }
    });
  });

  test('loads fast mode as an invocation-scoped Claude setting', () => {
    const definition = claudeCodeMeshAgentAdapter.createSessionRuntime?.(agent('claude-code'), {
      workingPath: '/workspace',
      speed: 'fast'
    });
    if (definition?.plan.processModel !== 'resident') throw new Error('Claude resident runtime required');
    expect(definition.plan.launch.args).toEqual([
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--replay-user-messages',
      '--settings',
      '{"fastMode":true}',
      '--thinking-display',
      'summarized'
    ]);
  });

  test('reuses stream-json parsing through a session-scoped chunk decoder', async () => {
    const definition = claudeCodeMeshAgentAdapter.createSessionRuntime?.(agent('claude-code'), {
      workingPath: '/workspace'
    });
    if (definition?.driver.processModel !== 'resident') throw new Error('Claude resident driver required');
    const events = await collectResident(definition.driver, [
      '{"type":"system","subtype":"init","session_id":"claude-1","cwd":"/workspace","model":"sonnet","permissionMode":"default"}\n',
      '{"type":"result","subtype":"success","result":"done","session_id":"claude-1","is_error":false}\n'
    ]);
    expect(events).toEqual([
      { type: 'provider_session_identified', payload: { providerSessionRef: 'claude-1' } },
      { type: 'agent_message', payload: { text: 'done', final: true } }
    ]);
  });

  test('sends turns and steer messages over stdin and resolves an interrupt response', async () => {
    const definition = claudeCodeMeshAgentAdapter.createSessionRuntime?.(agent('claude-code'), {
      workingPath: '/workspace'
    });
    if (definition?.driver.processModel !== 'resident') throw new Error('Claude resident driver required');
    const sent: string[] = [];
    expect(await definition.driver.openSession({ workingPath: '/workspace' })).toEqual({
      capabilities: {
        input: true,
        steer: true,
        interrupt: true,
        approvalResolution: false,
        providerSessionContinuation: true,
        runtimeRestoration: true,
        sessionReopen: true
      }
    });
    await definition.driver.attachChannel(
      {
        async send(frame) {
          sent.push(String(frame));
        },
        async close() {}
      },
      {}
    );

    await definition.driver.sendTurn({ text: 'first', attachments: [] });
    if (!definition.driver.controls.steer) throw new Error('Claude steer control required');
    await definition.driver.controls.steer.send({
      text: 'focus on tests',
      attachments: [{ id: 'att_spec', name: 'spec.md', path: '/workspace/spec.md', mime: 'text/markdown', bytes: 42 }]
    });
    if (!definition.driver.controls.interrupt) throw new Error('Claude interrupt control required');
    const interrupted = definition.driver.controls.interrupt.run();
    await Bun.sleep(0);

    const frames = sent.map((frame) => JSON.parse(frame) as Record<string, unknown>);
    expect(frames.slice(0, 2)).toEqual([
      {
        type: 'user',
        uuid: expect.any(String),
        parent_tool_use_id: null,
        message: { role: 'user', content: [{ type: 'text', text: 'first' }] }
      },
      {
        type: 'user',
        uuid: expect.any(String),
        parent_tool_use_id: null,
        message: {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'focus on tests\n\nAttachments available in the workspace:\n- spec.md: /workspace/spec.md'
            }
          ]
        }
      }
    ]);
    const control = frames[2] as {
      request_id: string;
      request: Record<string, unknown>;
      type: string;
    };
    expect(control).toEqual({
      type: 'control_request',
      request_id: expect.any(String),
      request: { subtype: 'interrupt' }
    });
    await definition.driver.accept(
      {
        bytes: new TextEncoder().encode(
          `${JSON.stringify({
            type: 'control_response',
            response: { subtype: 'success', request_id: control.request_id, response: {} }
          })}\n`
        ),
        source: 'stdout',
        receivedAt: '2026-07-30T00:00:00.000Z'
      },
      { async emit() {} }
    );
    await interrupted;
  });

  test('maps managed system prompt, MCP, workspace, approvals, and env into the resident launch', () => {
    const definition = claudeCodeMeshAgentAdapter.createSessionRuntime?.(agent('claude-code'), {
      workingPath: '/workspace',
      extraWorkingPaths: ['/managed'],
      startInput: {
        immutableInstructions: { text: 'Post through Monad.', file: '/managed/prompt.md' },
        initialTurn: { text: 'hello', attachments: [] }
      },
      skipProviderApprovals: true,
      mcpConfigArgs: ['--mcp-config', '{"mcpServers":{}}'],
      env: { MONAD_AGENT_RUNTIME_TOKEN: 'token' }
    });
    if (definition?.plan.processModel !== 'resident') throw new Error('Claude resident runtime required');
    if (!definition.plan.buildLaunch) throw new Error('Claude dynamic launch required');
    expect(definition.plan.buildLaunch({}).args).toEqual([
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--replay-user-messages',
      '--append-system-prompt-file',
      '/managed/prompt.md',
      '--allowedTools',
      'mcp__monad__*',
      '--dangerously-skip-permissions',
      '--add-dir',
      '/managed',
      '--mcp-config',
      '{"mcpServers":{}}',
      '--thinking-display',
      'summarized'
    ]);
    expect(definition.plan.buildLaunch({}).env).toEqual({ MONAD_AGENT_RUNTIME_TOKEN: 'token' });
  });
});
