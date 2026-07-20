import type { MeshAgentView } from '@monad/protocol';
import type { MeshAgentSessionEvent, PerTurnProviderDriver } from '@monad/sdk-atom';

import { describe, expect, test } from 'bun:test';

import { claudeCodeMeshAgentAdapter } from '../../src/agent-adapters/claude-code/index.ts';
import { codexMeshAgentAdapter } from '../../src/agent-adapters/codex/index.ts';
import { geminiMeshAgentAdapter } from '../../src/agent-adapters/gemini/index.ts';
import { qwenMeshAgentAdapter } from '../../src/agent-adapters/qwen/index.ts';

function agent(provider: 'codex' | 'claude-code' | 'gemini' | 'qwen'): MeshAgentView {
  return {
    name: provider,
    provider,
    productIcon: provider,
    command: provider === 'claude-code' ? 'claude' : provider,
    args: [],
    enabled: true,
    allowAutopilot: false,
    approvalOwnership: 'provider-owned'
  };
}

async function collect(
  driver: PerTurnProviderDriver,
  chunks: string[],
  source: 'stdout' | 'stderr' = 'stdout'
): Promise<MeshAgentSessionEvent[]> {
  const events: MeshAgentSessionEvent[] = [];
  await driver.attachTurnChannel({ async send() {}, async close() {} }, { turnId: 'turn-1' });
  for (const chunk of chunks) {
    await driver.accept(
      {
        bytes: new TextEncoder().encode(chunk),
        source,
        receivedAt: '2026-07-19T00:00:00.000Z'
      },
      {
        async emit(event) {
          events.push(event);
        }
      }
    );
  }
  await driver.completeTurn({ exitCode: 0 });
  return events;
}

describe('Codex per-turn session-event runtime', () => {
  test('builds exec and resume launches without app-server or PTY fields', () => {
    const definition = codexMeshAgentAdapter.createSessionRuntime?.(agent('codex'), {
      workingPath: '/workspace',
      modelId: 'gpt-5.4',
      reasoningEffort: 'high'
    });
    expect(definition?.plan.processModel).toBe('per-turn');
    if (definition?.plan.processModel !== 'per-turn') throw new Error('Codex per-turn runtime required');
    expect(definition.plan.buildTurnLaunch({})).toEqual({
      args: ['exec', '--json', '--color', 'never', '--model', 'gpt-5.4', '-c', 'model_reasoning_effort="high"', '-'],
      cwd: '/workspace'
    });
    expect(definition.plan.buildTurnLaunch({ providerSessionRef: 'thread-1' })).toEqual({
      args: [
        'exec',
        '--json',
        '--color',
        'never',
        'resume',
        '--model',
        'gpt-5.4',
        '-c',
        'model_reasoning_effort="high"',
        'thread-1',
        '-'
      ],
      cwd: '/workspace'
    });
    expect(definition.plan.encodeTurnInput({ text: 'hello', attachments: [] })).toEqual({
      delivery: 'stdin',
      bytes: new TextEncoder().encode('hello')
    });
  });

  test('decodes chunked exec JSONL and normalizes provider identity', async () => {
    const definition = codexMeshAgentAdapter.createSessionRuntime?.(agent('codex'), { workingPath: '/workspace' });
    if (definition?.driver.processModel !== 'per-turn') throw new Error('Codex per-turn driver required');
    const events = await collect(definition.driver, [
      '{"type":"thread.started","thread_id":"thread-1"}\n{"type":"item.com',
      'pleted","item":{"id":"item-1","type":"agent_message","text":"hello"}}\r\n',
      '{"type":"turn.completed","usage":{"input_tokens":1}}'
    ]);
    expect(events).toEqual([
      { type: 'provider_session_identified', payload: { providerSessionRef: 'thread-1' } },
      { type: 'agent_message', payload: { text: 'hello' } },
      { type: 'agent_message', payload: { text: '', final: true } }
    ]);
  });

  test('carries daemon-prepared managed context without exposing runtime topology', () => {
    const definition = codexMeshAgentAdapter.createSessionRuntime?.(agent('codex'), {
      workingPath: '/workspace',
      extraWorkingPaths: ['/managed'],
      developerInstructions: 'Post through the Monad bridge.',
      skipProviderApprovals: true,
      mcpConfigArgs: ['-c', 'mcp_servers.monad.command="monad"'],
      env: { MONAD_AGENT_RUNTIME_TOKEN: 'token' }
    });
    if (definition?.plan.processModel !== 'per-turn') throw new Error('Codex per-turn runtime required');
    expect(definition.plan.buildTurnLaunch({}).args).toEqual([
      '--ask-for-approval',
      'never',
      'exec',
      '--json',
      '--color',
      'never',
      '--add-dir',
      '/managed',
      '-c',
      'mcp_servers.monad.command="monad"',
      '-'
    ]);
    expect(definition.plan.buildTurnLaunch({ providerSessionRef: 'thread-1' }).args).toEqual([
      '--ask-for-approval',
      'never',
      'exec',
      '--json',
      '--color',
      'never',
      '--add-dir',
      '/managed',
      'resume',
      '-c',
      'mcp_servers.monad.command="monad"',
      'thread-1',
      '-'
    ]);
    const encoded = definition.plan.encodeTurnInput({ text: 'hello', attachments: [] });
    if (encoded.delivery !== 'stdin') throw new Error('Codex stdin delivery required');
    expect(new TextDecoder().decode(encoded.bytes)).toBe('Post through the Monad bridge.\n\nhello');
    expect(definition.plan.buildTurnLaunch({}).env).toEqual({ MONAD_AGENT_RUNTIME_TOKEN: 'token' });
  });

  test('keeps a configured approval policy before the exec subcommand', () => {
    const definition = codexMeshAgentAdapter.createSessionRuntime?.(
      { ...agent('codex'), args: ['--ask-for-approval', 'on-request'] },
      { workingPath: '/workspace' }
    );
    if (definition?.plan.processModel !== 'per-turn') throw new Error('Codex per-turn runtime required');
    expect(definition.plan.buildTurnLaunch({}).args).toEqual([
      '--ask-for-approval',
      'on-request',
      'exec',
      '--json',
      '--color',
      'never',
      '-'
    ]);
  });
});

describe('Qwen resident session-event runtime', () => {
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
    await definition.driver.openSession({ workingPath: '/workspace', providerSessionRef: 'qwen-1' });
    await definition.driver.attachChannel(
      {
        async send(frame) {
          sent.push(String(frame));
        },
        async close() {}
      },
      { providerSessionRef: 'qwen-1' }
    );
    await definition.driver.sendTurn({ text: 'hello', attachments: [] });
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
    expect(sent.map((line) => JSON.parse(line))).toEqual([
      { type: 'control_request', request_id: 'init-0', request: { subtype: 'initialize', hooks: null } },
      {
        type: 'user',
        session_id: 'qwen-1',
        parent_tool_use_id: null,
        message: { role: 'user', content: [{ type: 'text', text: 'hello' }] }
      },
      {
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: 'approval-1',
          response: { behavior: 'allow', updatedInput: { command: 'pwd' } }
        }
      }
    ]);
  });
});

describe('Gemini per-turn session-event runtime', () => {
  test('builds headless stream-json turns and resumes by provider session ref', async () => {
    const definition = geminiMeshAgentAdapter.createSessionRuntime?.(agent('gemini'), {
      workingPath: '/workspace',
      modelId: 'gemini-2.5-pro'
    });
    if (definition?.plan.processModel !== 'per-turn' || definition.driver.processModel !== 'per-turn')
      throw new Error('Gemini per-turn runtime required');
    expect(definition.plan.buildTurnLaunch({})).toEqual({
      args: ['-p', '', '--model', 'gemini-2.5-pro', '--output-format', 'stream-json'],
      cwd: '/workspace'
    });
    expect(definition.plan.buildTurnLaunch({ providerSessionRef: 'gemini-1' })).toEqual({
      args: ['-p', '', '--resume', 'gemini-1', '--model', 'gemini-2.5-pro', '--output-format', 'stream-json'],
      cwd: '/workspace'
    });
    const events = await collect(definition.driver, [
      '{"type":"init","session_id":"gemini-1","model":"gemini"}\n{"type":"message","role":"assistant","content":"hel","delta":true}\n',
      '{"type":"message","role":"assistant","content":"lo","delta":true}\n{"type":"result","status":"success"}'
    ]);
    expect(events).toEqual([
      { type: 'provider_session_identified', payload: { providerSessionRef: 'gemini-1' } },
      { type: 'agent_message', payload: { text: 'hel' } },
      { type: 'agent_message', payload: { text: 'lo' } },
      { type: 'agent_message', payload: { text: 'hello', final: true } }
    ]);
  });
});

describe('Claude Code per-turn session-event runtime', () => {
  test('uses the Claude auth login subcommand for provider-owned login', () => {
    const launch = claudeCodeMeshAgentAdapter.buildAuthLaunch(agent('claude-code'));
    expect({ argv: launch.argv, cwd: typeof launch.cwd, env: launch.env }).toEqual({
      argv: ['claude', 'auth', 'login'],
      cwd: 'string',
      env: undefined
    });
    expect(launch as unknown as Record<string, unknown>).toMatchObject({
      launchMode: 'pty',
      provider: 'claude-code',
      approvalOwnership: 'provider-owned',
      capabilities: ['pty', 'provider-approval']
    });
  });

  test('builds stream-json launches and resumes the provider session', () => {
    const definition = claudeCodeMeshAgentAdapter.createSessionRuntime?.(agent('claude-code'), {
      workingPath: '/workspace',
      modelId: 'sonnet',
      reasoningEffort: 'high'
    });
    if (definition?.plan.processModel !== 'per-turn') throw new Error('Claude per-turn runtime required');
    const initial = definition.plan.buildTurnLaunch({});
    expect(initial).toEqual({
      args: [
        '-p',
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
        '--verbose',
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
    expect(definition.plan.buildTurnLaunch({ providerSessionRef: 'claude-1' })).toEqual({
      ...initial,
      args: [...initial.args, '--resume', 'claude-1']
    });
    const encoded = definition.plan.encodeTurnInput({ text: 'hello', attachments: [] });
    expect(encoded.delivery).toBe('stdin');
    if (encoded.delivery !== 'stdin') throw new Error('Claude stdin delivery required');
    expect(new TextDecoder().decode(encoded.bytes)).toBe(
      '{"type":"user","parent_tool_use_id":null,"message":{"role":"user","content":[{"type":"text","text":"hello"}]}}\n'
    );
  });

  test('reuses stream-json parsing through a session-scoped chunk decoder', async () => {
    const definition = claudeCodeMeshAgentAdapter.createSessionRuntime?.(agent('claude-code'), {
      workingPath: '/workspace'
    });
    if (definition?.driver.processModel !== 'per-turn') throw new Error('Claude per-turn driver required');
    const events = await collect(definition.driver, [
      '{"type":"system","subtype":"init","session_id":"claude-1","cwd":"/workspace","model":"sonnet","permissionMode":"default"}\n',
      '{"type":"result","subtype":"success","result":"done","session_id":"claude-1","is_error":false}'
    ]);
    expect(events).toEqual([
      { type: 'provider_session_identified', payload: { providerSessionRef: 'claude-1' } },
      { type: 'agent_message', payload: { text: 'done', final: true } }
    ]);
  });

  test('maps managed system prompt, MCP, workspace, approvals, and env into the per-turn launch', () => {
    const definition = claudeCodeMeshAgentAdapter.createSessionRuntime?.(agent('claude-code'), {
      workingPath: '/workspace',
      extraWorkingPaths: ['/managed'],
      systemPromptFile: '/managed/prompt.md',
      skipProviderApprovals: true,
      mcpConfigArgs: ['--mcp-config', '{"mcpServers":{}}'],
      env: { MONAD_AGENT_RUNTIME_TOKEN: 'token' }
    });
    if (definition?.plan.processModel !== 'per-turn') throw new Error('Claude per-turn runtime required');
    expect(definition.plan.buildTurnLaunch({}).args).toEqual([
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
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
    expect(definition.plan.buildTurnLaunch({}).env).toEqual({ MONAD_AGENT_RUNTIME_TOKEN: 'token' });
  });
});
