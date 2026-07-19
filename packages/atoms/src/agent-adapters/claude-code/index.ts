import type {
  SDKAssistantMessage,
  SDKMessage,
  SDKPermissionDenial,
  SDKSystemMessage,
  SDKUserMessage,
  SessionMessage
} from '@anthropic-ai/claude-agent-sdk';
import type { MeshAgentView } from '@monad/protocol';
import type {
  MeshAgentManagedRuntimeContext,
  MeshAgentModelOption,
  MeshAgentOutputEvent,
  MeshAgentProviderAdapter,
  MeshAgentProviderEventContext,
  MeshAgentProviderEventPageContext,
  MeshAgentProviderEventPageRequestContext,
  MeshAgentSessionRuntimeContext,
  SessionEventRuntimeDefinition
} from '@monad/sdk-atom';
import type { LegacyProviderLaunchSpec } from '../legacy/runtime.ts';

import { homedir } from 'node:os';
import { join } from 'node:path';
import { getSessionMessages } from '@anthropic-ai/claude-agent-sdk';
import { defaultBinProbes, resolveBinary } from '@monad/sdk-atom';

import {
  compactObject,
  hasFlag,
  parseJsonObject,
  parseStructuredAuthState,
  textFromContentParts
} from '../adapter-shared.ts';
import { parseMeshAgentArgumentSupport } from '../argument-support.ts';
import { readProviderEventFile } from '../event-files.ts';
import { createOutputEventSource } from '../event-source.ts';
import { SessionEventJsonlDriver } from '../session-event-jsonl-driver.ts';
import { meshAgentAdapterSettings } from '../settings.ts';
import { createClaudeCodeSettingsImport } from '../settings-import/index.ts';
import { claudeCodeObservationProjection } from './observation.ts';

// `claude --help` documents `--model` as accepting tier aliases (each resolves to that tier's latest
// release) or a pinned full model name. There is no `claude models list`-style catalog probe, so the
// fallback intentionally stays on the CLI's stable alias tier names instead of version-pinned enums.
const CLAUDE_CODE_SUPPORTED_MODELS = ['fable', 'opus', 'sonnet', 'haiku'];
const CLAUDE_CODE_SUPPORTED_MODEL_SET = new Set(CLAUDE_CODE_SUPPORTED_MODELS);

// `-p`/`--print` (non-interactive/headless mode) + `--input-format`/`--output-format stream-json` —
// confirmed against code.claude.com/docs/en/permission-modes and Anthropic's documented headless
// recipe: `claude -p "..." --output-format stream-json` for automated pipelines.
function withClaudeStreamJsonArgs(args: string[]): string[] {
  const next = [...args];
  if (!next.includes('-p') && !next.includes('--print')) next.unshift('-p');
  if (!next.includes('--input-format')) next.push('--input-format', 'stream-json');
  if (!next.includes('--output-format')) next.push('--output-format', 'stream-json');
  if (!next.includes('--verbose')) next.push('--verbose');
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

function allowManagedBridgeTools(args: string[], managed: boolean): string[] {
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

function buildClaudeAuthLaunch(agent: MeshAgentView, args: string[]): LegacyProviderLaunchSpec {
  return {
    argv: [agent.command, ...args],
    cwd: homedir(),
    env: agent.env,
    launchMode: 'pty',
    provider: 'claude-code',
    approvalOwnership: 'provider-owned',
    capabilities: ['pty', 'provider-approval']
  };
}

function claudeModelDisplayName(model: string): string {
  return model
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export function parseClaudeModelOptions(output: string): MeshAgentModelOption[] {
  const lines = output.split(/\r?\n/);
  let modelWindow = '';
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (!/^\s*--model\s+<model>(?:\s|$)/.test(line)) continue;
    const windowLines = [line];
    for (let next = index + 1; next < lines.length; next += 1) {
      const candidate = lines[next] ?? '';
      if (/^\s*-\w|^\s*--[a-z0-9-]+/i.test(candidate)) break;
      windowLines.push(candidate);
    }
    modelWindow = windowLines.join('\n');
    break;
  }
  if (!modelWindow) return [];
  const aliases = [
    ...new Set(
      [...modelWindow.matchAll(/['"`]([a-z][a-z0-9_-]*)['"`]/gi)]
        .map((match) => match[1] ?? '')
        .filter((value) => CLAUDE_CODE_SUPPORTED_MODEL_SET.has(value))
    )
  ];
  const values = [...aliases, ...CLAUDE_CODE_SUPPORTED_MODELS.filter((model) => !aliases.includes(model))];
  return values.map((value) => ({ value, displayName: claudeModelDisplayName(value) }));
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
    if (typeof record.type === 'string') events.push(...claudeMessageEvents(record as SDKMessage));
  }
  return events;
}

function claudeTranscriptFallback(context: MeshAgentProviderEventContext): string | null {
  return readProviderEventFile({
    roots: [join(homedir(), '.claude', 'projects')],
    providerSessionRef: context.providerSessionRef,
    extensions: ['.jsonl']
  });
}

function claudeSdkMessageToJsonLine(message: SessionMessage): string {
  return JSON.stringify({
    type: message.type,
    uuid: message.uuid,
    session_id: message.session_id,
    message: message.message,
    parent_tool_use_id: message.parent_tool_use_id
  });
}

function claudeSdkMessagesOutput(messages: SessionMessage[]): string | null {
  const records = messages.map(claudeSdkMessageToJsonLine);
  if (records.length === 0) return null;
  return records.join('\n');
}

function claudeHistoryOffset(cursor: string | undefined): number {
  if (!cursor) return 0;
  const offset = Number.parseInt(cursor, 10);
  return Number.isFinite(offset) && offset > 0 ? offset : 0;
}

interface ClaudeSdkHistoryDeps {
  getSessionMessages: typeof getSessionMessages;
}

export function createClaudeSdkEventPageReader(deps: ClaudeSdkHistoryDeps) {
  return async function readClaudeEventPage(
    context: MeshAgentProviderEventPageRequestContext
  ): Promise<MeshAgentProviderEventPageContext['page'] | null> {
    try {
      const offset = claudeHistoryOffset(context.request.before);
      const messages = await deps.getSessionMessages(context.providerSessionRef, {
        dir: context.workingPath,
        limit: context.request.limit,
        offset,
        includeSystemMessages: true
      });
      const items: unknown[] = messages.map((message) => ({
        type: message.type,
        uuid: message.uuid,
        session_id: message.session_id,
        message: message.message,
        parent_tool_use_id: message.parent_tool_use_id
      }));
      if (items.length === 0) return null;
      return {
        items,
        ...(messages.length >= context.request.limit ? { nextCursor: String(offset + messages.length) } : {})
      };
    } catch {
      return null;
    }
  };
}

export function createClaudeSdkHistoryOutputReader(deps: ClaudeSdkHistoryDeps) {
  return async function readClaudeSdkHistoryOutput(context: MeshAgentProviderEventContext): Promise<string | null> {
    try {
      const messages = await deps.getSessionMessages(context.providerSessionRef, {
        dir: context.workingPath,
        includeSystemMessages: true
      });
      return claudeSdkMessagesOutput(messages);
    } catch {
      return null;
    }
  };
}

const readClaudeSdkHistoryOutput = createClaudeSdkHistoryOutputReader({ getSessionMessages });

async function readClaudeHistoryOutput(context: MeshAgentProviderEventContext): Promise<string | null> {
  return (await readClaudeSdkHistoryOutput(context)) ?? claudeTranscriptFallback(context);
}

function buildClaudeStreamJsonUserMessage(input: string): SDKUserMessage {
  return {
    type: 'user',
    parent_tool_use_id: null,
    message: {
      role: 'user',
      content: [{ type: 'text', text: input }]
    }
  };
}

function claudeTurnText(input: { text: string; attachments: readonly { name: string; path: string }[] }): string {
  if (input.attachments.length === 0) return input.text;
  const references = input.attachments.map((attachment) => `- ${attachment.name}: ${attachment.path}`).join('\n');
  return `${input.text}\n\nAttachments available in the workspace:\n${references}`;
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
  if (context.systemPromptFile && !args.includes('--append-system-prompt-file')) {
    args.push('--append-system-prompt-file', context.systemPromptFile);
  }
  args = allowManagedBridgeTools(args, !!context.systemPromptFile);
  args = withClaudeSkipApprovalArgs(args, !!context.skipProviderApprovals);
  args = [...args, ...claudeExtraWorkingPathArgs(context.extraWorkingPaths)];
  args = [...args, ...(context.mcpConfigArgs ?? [])];
  args = withClaudeThinkingDisplayArgs(args, agent.adapterSettings?.showThinkingSummary !== false);
  return {
    plan: {
      processModel: 'per-turn',
      buildTurnLaunch: ({ providerSessionRef }) => ({
        args: [...args, ...(providerSessionRef ? ['--resume', providerSessionRef] : [])],
        cwd: context.workingPath,
        ...(context.env || agent.env ? { env: { ...(agent.env ?? {}), ...(context.env ?? {}) } } : {})
      }),
      encodeTurnInput: (input) => ({
        delivery: 'stdin',
        bytes: new TextEncoder().encode(`${JSON.stringify(buildClaudeStreamJsonUserMessage(claudeTurnText(input)))}\n`)
      }),
      startup: { timeoutMs: 20_000 },
      continuation: { strategy: 'provider-session-ref' }
    },
    driver: new SessionEventJsonlDriver({ parseOutput: parseClaudeStreamJson })
  };
}

export const claudeCodeMeshAgentAdapter: MeshAgentProviderAdapter = {
  provider: 'claude-code',
  productIcon: 'claude-code',
  label: 'Claude Code',
  observation: claudeCodeObservationProjection,
  events: createOutputEventSource({
    provider: 'claude-code',
    projection: claudeCodeObservationProjection,
    readOutput: readClaudeHistoryOutput
  }),
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
    usesManagedMcpBridge: true,
    usesSystemPromptFile: true
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
        events: 'provider-owned',
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
  modelOptions(agent) {
    return {
      launch: buildClaudeAuthLaunch(agent, ['--help']),
      parse: (output) => parseClaudeModelOptions(output)
    };
  },
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
