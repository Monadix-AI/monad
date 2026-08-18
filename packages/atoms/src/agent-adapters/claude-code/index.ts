import type {
  SDKAssistantMessage,
  SDKMessage,
  SDKPermissionDenial,
  SDKSystemMessage,
  SDKUserMessage
} from '@anthropic-ai/claude-agent-sdk';
import type { MeshAgentView } from '@monad/protocol';
import type {
  MeshAgentLaunchSpec,
  MeshAgentManagedRuntimeContext,
  MeshAgentOutputEvent,
  MeshAgentProviderAdapter,
  MeshAgentSessionRuntimeContext,
  SessionEventRuntimeDefinition
} from '@monad/sdk-atom';

import { homedir } from 'node:os';
import { join } from 'node:path';
import { getSessionMessages } from '@anthropic-ai/claude-agent-sdk';
import { defaultBinProbes, MeshAgentError, resolveBinary } from '@monad/sdk-atom';

import {
  compactObject,
  hasFlag,
  parseJsonObject,
  parseStructuredAuthState,
  textFromContentParts
} from '../adapter-shared.ts';
import { parseMeshAgentArgumentSupport } from '../argument-support.ts';
import { agentAdapterIcons } from '../icons.ts';
import { meshAgentAdapterSettings } from '../settings.ts';
import { createClaudeCodeSettingsImport } from '../settings-import/index.ts';
import { claudeTranscriptFallback, createClaudeEventSource } from './event-pages.ts';
import { deleteClaudeCodeSession } from './lifecycle.ts';

export { createClaudeSdkEventPageReader, createClaudeSdkHistoryOutputReader } from './event-pages.ts';

import { CLAUDE_CODE_SUPPORTED_MODELS, listClaudeModelOptions } from './model-options.ts';
import { claudeCodeObservationProjection } from './observation.ts';
import { ClaudeCodeSessionDriver } from './session-runtime.ts';
import { readClaudeSessionUsage } from './session-usage.ts';

// `-p`/`--print` (non-interactive/headless mode) + `--input-format`/`--output-format stream-json` —
// confirmed against code.claude.com/docs/en/permission-modes and Anthropic's documented headless
// recipe: `claude -p "..." --output-format stream-json` for automated pipelines.
function withClaudeStreamJsonArgs(args: string[]): string[] {
  const next = [...args];
  if (!next.includes('-p') && !next.includes('--print')) next.unshift('-p');
  if (!next.includes('--input-format')) next.push('--input-format', 'stream-json');
  if (!next.includes('--output-format')) next.push('--output-format', 'stream-json');
  if (!next.includes('--verbose')) next.push('--verbose');
  if (!next.includes('--include-partial-messages')) next.push('--include-partial-messages');
  // Re-emit stdin user messages back on stdout (`{type:'user'}` records) so the input a turn was given
  // — the join prompt, room messages — appears in the observation timeline as real provider output.
  // Needs both stream-json formats, which are set just above. Claude otherwise never echoes its input.
  if (!next.includes('--replay-user-messages')) next.push('--replay-user-messages');
  return next;
}

function applyClaudeUltracodeSetting(args: string[]): string[] {
  const next = [...args];
  const settingsIndex = next.findIndex((arg) => arg === '--settings' || arg.startsWith('--settings='));
  if (settingsIndex < 0) return [...next, '--settings', '{"ultracode":true}'];

  const rawSettings = next[settingsIndex]?.startsWith('--settings=')
    ? next[settingsIndex]?.slice('--settings='.length)
    : next[settingsIndex + 1];
  if (!rawSettings) return next;

  const settings = parseJsonObject(rawSettings);
  if (!settings) return next;

  const merged = JSON.stringify({ ...settings, ultracode: true });
  if (next[settingsIndex]?.startsWith('--settings=')) {
    next[settingsIndex] = `--settings=${merged}`;
  } else {
    next[settingsIndex + 1] = merged;
  }
  return next;
}

// A managed Claude session pre-approves every Monad MCP tool with one wildcard, so newly added managed
// tools (e.g. the session-plan tools) are covered without enumerating them per name — the Codex counterpart
// instead lists each tool explicitly (see codexManagedMcpConfigArgs).
export function allowManagedBridgeTools(args: string[], managed: boolean): string[] {
  if (!managed || hasFlag(args, '--allowedTools') || hasFlag(args, '--allowed-tools')) return args;
  return [...args, '--allowedTools', 'mcp__monad__*'];
}

function claudeExtraWorkingPathArgs(paths: string[] | undefined): string[] {
  return (paths ?? []).flatMap((path) => ['--add-dir', path]);
}

// `--dangerously-skip-permissions` ("Safe YOLO mode") — confirmed against
// code.claude.com/docs/en/permission-modes; Anthropic's docs note it refuses to start under root/sudo.
function withClaudeSkipApprovalArgs(args: string[], skipProviderApprovals: boolean): string[] {
  if (!skipProviderApprovals || hasFlag(args, '--dangerously-skip-permissions')) return args;
  return [...args, '--dangerously-skip-permissions'];
}

function withClaudeThinkingDisplayArgs(args: string[], showThinkingSummary: boolean): string[] {
  if (hasFlag(args, '--thinking-display')) return args;
  return [...args, '--thinking-display', showThinkingSummary ? 'summarized' : 'omitted'];
}

function claudeManagedMcpConfigArgs(context: MeshAgentManagedRuntimeContext): string[] {
  return [
    '--mcp-config',
    JSON.stringify({
      mcpServers: {
        monad: {
          type: 'stdio',
          command: context.monadCliEntry.command,
          args: [...context.monadCliEntry.args, 'native-agent', 'mcp-server'],
          env: context.env
        }
      }
    })
  ];
}

function buildClaudeAuthLaunch(agent: MeshAgentView, args: string[]): MeshAgentLaunchSpec {
  return {
    argv: [agent.command, ...args],
    cwd: homedir(),
    env: agent.env
  };
}

type ClaudeMessageContent = SDKAssistantMessage['message']['content'] | SDKUserMessage['message']['content'];
type ClaudeToolResultContent = Extract<
  Exclude<SDKUserMessage['message']['content'], string>[number],
  { type: 'tool_result' }
>['content'];

function stringifyToolResultContent(content: ClaudeToolResultContent): string | undefined {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return textFromContentParts(content) || JSON.stringify(content);
  return content === undefined ? undefined : JSON.stringify(content);
}

function parseClaudeContentBlocks(content: ClaudeMessageContent): MeshAgentOutputEvent[] {
  if (typeof content === 'string') return [];
  const events: MeshAgentOutputEvent[] = [];
  let text = '';
  for (const block of content) {
    switch (block.type) {
      case 'text':
        text += block.text;
        break;
      case 'tool_use':
        events.push({
          type: 'tool_call',
          payload: compactObject({ callId: block.id, tool: block.name, input: block.input })
        });
        break;
      case 'tool_result':
        events.push({
          type: 'tool_result',
          payload: compactObject({ callId: block.tool_use_id, output: stringifyToolResultContent(block.content) })
        });
        break;
    }
  }
  return text ? [{ type: 'agent_message', payload: { text } }, ...events] : events;
}

function claudePermissionDenialEvents(denials: SDKPermissionDenial[], result: string): MeshAgentOutputEvent[] {
  const messages = denials
    .map((denial) => {
      const command = typeof denial.tool_input.command === 'string' ? denial.tool_input.command : undefined;
      return command ? `${denial.tool_name}: ${command}` : denial.tool_name;
    })
    .filter(Boolean);
  if (messages.length === 0) return [];
  const prefix = result.trim();
  const blocked = `Blocked command: ${messages.join('; ')}`;
  return [
    {
      type: 'provider_error',
      payload: { code: 'permission_denied', message: prefix ? `${prefix}\n\n${blocked}` : blocked }
    }
  ];
}

function claudeSystemInitEvents(message: SDKSystemMessage): MeshAgentOutputEvent[] {
  return [
    {
      type: 'session_ref',
      payload: compactObject({
        providerSessionRef: message.session_id,
        cwd: message.cwd,
        model: message.model,
        permissionMode: message.permissionMode
      })
    }
  ];
}

function claudeMessageEvents(message: SDKMessage): MeshAgentOutputEvent[] {
  switch (message.type) {
    case 'system':
      return message.subtype === 'init' ? claudeSystemInitEvents(message) : [];
    case 'assistant':
    case 'user':
      return parseClaudeContentBlocks(message.message.content);
    case 'result':
      return message.subtype === 'success'
        ? [
            { type: 'agent_message', payload: { text: message.result, final: true } },
            ...claudePermissionDenialEvents(message.permission_denials ?? [], message.result)
          ]
        : [];
    default:
      return [];
  }
}

// The SDKMessage union doesn't model the top-level `error` field the CLI attaches to synthetic
// failure events (e.g. {"type":"assistant","error":"authentication_failed",...} when the session's
// credentials expire mid-run), so auth failure is detected on the raw record before narrowing.
function claudeAuthFailureEvent(record: Record<string, unknown>): MeshAgentOutputEvent | undefined {
  const resultText = typeof record.result === 'string' ? record.result.trim() : '';
  const isErrorResult =
    record.type === 'result' && record.is_error === true && /(?:not logged in|please run\s+\/login)/i.test(resultText);
  if (record.error !== 'authentication_failed' && !isErrorResult) return undefined;
  const message = record.message as { content?: unknown } | undefined;
  const messageText = Array.isArray(message?.content)
    ? message.content
        .map((block) => (block && typeof block === 'object' && 'text' in block ? String(block.text) : ''))
        .join('')
        .trim()
    : '';
  const text = messageText || resultText;
  return {
    type: 'connection_required',
    payload: { code: 'authentication_failed', reason: text || 'Claude Code session is not signed in' }
  };
}

function claudeResultFailureEvent(record: Record<string, unknown>): MeshAgentOutputEvent | undefined {
  if (record.type !== 'result' || record.subtype === 'success') return undefined;
  const code = typeof record.subtype === 'string' ? record.subtype : 'claude_error';
  const result = typeof record.result === 'string' ? record.result.trim() : '';
  return {
    type: 'provider_error',
    payload: {
      code,
      message: result || `Claude Code turn failed with ${code}`
    }
  };
}

export function parseClaudeStreamJson(chunk: string): MeshAgentOutputEvent[] {
  const events: MeshAgentOutputEvent[] = [];
  const authFailures = new Set<string>();
  for (const rawLine of chunk.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('{')) continue;
    const record = parseJsonObject(line);
    if (!record) continue;
    const authFailure = claudeAuthFailureEvent(record);
    if (authFailure) {
      const key = `${String(authFailure.payload.code)}:${String(authFailure.payload.reason)}`;
      if (!authFailures.has(key)) {
        authFailures.add(key);
        events.push(authFailure);
      }
      continue;
    }
    const resultFailure = claudeResultFailureEvent(record);
    if (resultFailure) {
      events.push(resultFailure);
      continue;
    }
    if (typeof record.type === 'string') events.push(...claudeMessageEvents(record as SDKMessage));
  }
  return events;
}

function createClaudeSessionRuntime(
  agent: MeshAgentView,
  context: MeshAgentSessionRuntimeContext
): SessionEventRuntimeDefinition {
  let args = withClaudeStreamJsonArgs(agent.args ?? []);
  const model = context.modelId ?? context.modelName;
  if (model && !hasFlag(args, '--model')) args.push('--model', model);
  if (context.reasoningEffort === 'ultracode') {
    args = applyClaudeUltracodeSetting(args);
  } else if (context.reasoningEffort && !hasFlag(args, '--effort')) {
    args.push('--effort', context.reasoningEffort);
  }
  if (context.speed === 'fast') {
    if (hasFlag(args, '--settings')) {
      throw new MeshAgentError(
        'unsupported_capability',
        'Claude Code fast mode cannot be combined with a custom --settings argument'
      );
    }
    args.push('--settings', JSON.stringify({ fastMode: true }));
  }
  const immutableInstructions = context.startInput?.immutableInstructions;
  if (immutableInstructions && !args.includes('--append-system-prompt-file')) {
    args.push('--append-system-prompt-file', immutableInstructions.file);
  }
  args = allowManagedBridgeTools(args, !!immutableInstructions);
  args = withClaudeSkipApprovalArgs(args, !!context.skipProviderApprovals);
  args = [...args, ...claudeExtraWorkingPathArgs(context.extraWorkingPaths)];
  args = [...args, ...(context.mcpConfigArgs ?? [])];
  args = withClaudeThinkingDisplayArgs(args, agent.adapterSettings?.showThinkingSummary !== false);
  const buildLaunch = (providerSessionRef?: string) => ({
    args: [...args, ...(providerSessionRef ? ['--resume', providerSessionRef] : [])],
    cwd: context.workingPath,
    ...(context.env || agent.env ? { env: { ...(agent.env ?? {}), ...(context.env ?? {}) } } : {})
  });
  return {
    plan: {
      processModel: 'resident',
      launch: buildLaunch(),
      buildLaunch: ({ providerSessionRef }) => buildLaunch(providerSessionRef),
      channel: { kind: 'child-stdio' },
      startup: { timeoutMs: 20_000 },
      suspend: { idleTimeoutMs: 300_000 }
    },
    driver: new ClaudeCodeSessionDriver({ parseOutput: parseClaudeStreamJson })
  };
}

export const claudeCodeMeshAgentAdapter: MeshAgentProviderAdapter = {
  provider: 'claude-code',
  icon: agentAdapterIcons['claude-code'],
  productIcon: 'claude-code',
  label: 'Claude Code',
  executionCapabilities: { autopilot: true, fastMode: true },
  observation: claudeCodeObservationProjection,
  events: createClaudeEventSource({ getSessionMessages, readFallbackOutput: claudeTranscriptFallback }),
  settings: () => [
    ...meshAgentAdapterSettings(),
    {
      key: 'showThinkingSummary',
      label: 'Show thinking summary',
      description: 'Pass --thinking-display summarized when enabled; omitted when disabled.',
      kind: 'switch',
      defaultValue: true
    }
  ],
  settingsImport: createClaudeCodeSettingsImport(),
  unsafeArgument: (args) =>
    args.find((arg) => arg === '--dangerously-skip-permissions' || arg === '--allow-dangerously-skip-permissions'),
  // ACP delivery variant: same Claude Code agent, launched as an external ACP sub-agent via the
  // claude-agent-acp wrapper. Version-pinned so `npx -y <pkg>@<ver>` resolves a known build.
  acp: {
    command: 'npx',
    args: ['-y', '@agentclientprotocol/claude-agent-acp@0.49.0'],
    env: { ANTHROPIC_API_KEY: '${env:' + 'ANTHROPIC_API_KEY}' },
    loginDirectories: [join(homedir(), '.claude')],
    credentialDirectories: [{ path: join(homedir(), '.claude'), env: 'CLAUDE_CONFIG_DIR' }],
    authEnvironmentVariables: ['ANTHROPIC_API_KEY']
  },
  managedRuntime: {
    mcpConfigArgs: claudeManagedMcpConfigArgs,
    usesManagedMcpBridge: true
  },
  detect(probes = defaultBinProbes) {
    const claudeBin = resolveBinary('claude', [], probes);
    const installed = claudeBin !== undefined;
    return {
      id: 'claude-code',
      label: claudeCodeMeshAgentAdapter.label,
      provider: 'claude-code',
      productIcon: claudeCodeMeshAgentAdapter.productIcon,
      command: 'claude',
      args: [],
      modelOptions: claudeCodeMeshAgentAdapter.listSupportedModels(),
      installHint: 'Install Claude Code, then sign in with claude auth.',
      installUrl: 'https://docs.anthropic.com/en/docs/claude-code/setup',
      installed,
      resolvedBinPath: claudeBin,
      capabilities: {
        auth: 'pty',
        events: 'paged',
        resume: 'pty',
        approval: 'provider-owned',
        settingsImport: true
      }
    };
  },
  resolveCommand(command, probes = defaultBinProbes) {
    return resolveBinary(command, [], probes);
  },
  listSupportedModels(agent) {
    return agent?.modelOptions?.length ? agent.modelOptions : CLAUDE_CODE_SUPPORTED_MODELS;
  },
  deleteSession: deleteClaudeCodeSession,
  modelOptions(agent) {
    return {
      resolve: () => listClaudeModelOptions(agent)
    };
  },
  sessionUsage: { read: readClaudeSessionUsage },
  createSessionRuntime: createClaudeSessionRuntime,
  buildAuthLaunch(agent) {
    return buildClaudeAuthLaunch(agent, ['auth', 'login']);
  },
  buildAuthStatusLaunch(agent) {
    return buildClaudeAuthLaunch(agent, ['auth', 'status']);
  },
  authStatus(agent) {
    return {
      launch: buildClaudeAuthLaunch(agent, ['auth', 'status', '--json']),
      parse: (output, exitCode) => claudeCodeMeshAgentAdapter.parseAuthStatus(output, exitCode)
    };
  },
  argumentSupport(agent) {
    return {
      launch: buildClaudeAuthLaunch(agent, ['--help']),
      parse: (output) => parseMeshAgentArgumentSupport(output)
    };
  },
  parseAuthStatus(output, exitCode) {
    const structured = parseStructuredAuthState(output);
    if (structured) return structured;
    if (exitCode === 0) return 'authenticated';
    if (exitCode === 1) return 'unauthenticated';
    return 'unknown';
  }
};
