import type {
  SDKAssistantMessage,
  SDKMessage,
  SDKPermissionDenial,
  SDKSessionInfo,
  SDKSystemMessage,
  SDKUserMessage,
  SessionMessage
} from '@anthropic-ai/claude-agent-sdk';
import type { ExternalAgentView } from '@monad/protocol';
import type {
  BuildExternalAgentLaunchOptions,
  ExternalAgentLaunchSpec,
  ExternalAgentManagedRuntimeContext,
  ExternalAgentModelOption,
  ExternalAgentOutputEvent,
  ExternalAgentProviderAdapter,
  ExternalAgentProviderHistoryContext,
  ExternalAgentProviderHistoryPageContext,
  ExternalAgentProviderHistoryPageRequestContext
} from '@monad/sdk-atom';

import { homedir } from 'node:os';
import { join } from 'node:path';
import { getSessionInfo, getSessionMessages } from '@anthropic-ai/claude-agent-sdk';
import { defaultBinProbes, resolveBinary } from '@monad/sdk-atom';

import {
  compactObject,
  hasFlag,
  parseJsonObject,
  parseStructuredAuthState,
  textFromContentParts
} from '../adapter-shared.ts';
import { parseExternalAgentArgumentSupport } from '../argument-support.ts';
import { readProviderHistoryFile } from '../history-files.ts';
import { resizePty, sendPtyInput, stopPty } from '../pty.ts';
import { externalAgentAdapterSettings } from '../settings.ts';
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

function claudeManagedMcpConfigArgs(context: ExternalAgentManagedRuntimeContext): string[] {
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

function buildClaudeLaunch(agent: ExternalAgentView, opts: BuildExternalAgentLaunchOptions): ExternalAgentLaunchSpec {
  const launchMode = opts.launchMode ?? agent.defaultLaunchMode;
  let args = [...(agent.args ?? [])];
  if (opts.providerSessionRef && !args.includes('--resume') && !args.includes('-r')) {
    args.push('--resume', opts.providerSessionRef);
  }
  const modelId = opts.modelId ?? opts.modelName;
  if (modelId && !hasFlag(args, '--model')) {
    args.push('--model', modelId);
  }
  if (opts.reasoningEffort === 'ultracode') {
    args = applyClaudeUltracodeSetting(args);
  } else if (opts.reasoningEffort && !hasFlag(args, '--effort')) {
    args.push('--effort', opts.reasoningEffort);
  }
  if (opts.systemPromptFile && !args.includes('--append-system-prompt-file')) {
    args.push('--append-system-prompt-file', opts.systemPromptFile);
  }
  args = allowManagedBridgeTools(args, !!opts.systemPromptFile);
  args = withClaudeSkipApprovalArgs(args, !!opts.skipProviderApprovals);
  args = withClaudeThinkingDisplayArgs(args, agent.adapterSettings?.showThinkingSummary !== false);
  args = [...args, ...claudeExtraWorkingPathArgs(opts.extraWorkingPaths)];
  args = [...args, ...(opts.mcpConfigArgs ?? [])];
  const launchArgs = launchMode === 'json-stream' ? withClaudeStreamJsonArgs(args) : args;
  return {
    argv: [agent.command, ...launchArgs],
    cwd: opts.workingPath,
    env: agent.env,
    launchMode,
    provider: 'claude-code',
    approvalOwnership: 'provider-owned',
    capabilities: ['pty', 'json-stream', 'remote-control', 'provider-approval', 'structured-output', 'session-resume']
  };
}

function buildClaudeAuthLaunch(agent: ExternalAgentView, args: string[]): ExternalAgentLaunchSpec {
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

export function parseClaudeModelOptions(output: string): ExternalAgentModelOption[] {
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

function parseClaudeContentBlocks(content: ClaudeMessageContent): ExternalAgentOutputEvent[] {
  if (typeof content === 'string') return [];
  const events: ExternalAgentOutputEvent[] = [];
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

function claudePermissionDenialEvents(denials: SDKPermissionDenial[], result: string): ExternalAgentOutputEvent[] {
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

function claudeSystemInitEvents(message: SDKSystemMessage): ExternalAgentOutputEvent[] {
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

function claudeMessageEvents(message: SDKMessage): ExternalAgentOutputEvent[] {
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

// The `claude` CLI's `--output-format stream-json` emits one `SDKMessage` per line — the SDK's own wire
// contract — so each decoded line is narrowed through the SDK's discriminated union directly instead of
// being re-typed by hand.
function decodeClaudeMessage(line: string): SDKMessage | undefined {
  const record = parseJsonObject(line);
  return record && typeof record.type === 'string' ? (record as SDKMessage) : undefined;
}

function parseClaudeStreamJson(chunk: string): ExternalAgentOutputEvent[] {
  const events: ExternalAgentOutputEvent[] = [];
  for (const rawLine of chunk.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('{')) continue;
    const message = decodeClaudeMessage(line);
    if (message) events.push(...claudeMessageEvents(message));
  }
  return events;
}

function claudeTranscriptFallback(context: ExternalAgentProviderHistoryContext): string | null {
  return readProviderHistoryFile({
    roots: [join(homedir(), '.claude', 'projects')],
    providerSessionRef: context.providerSessionRef,
    extensions: ['.jsonl'],
    limitBytes: context.limitBytes
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

function claudeHistoryItemToJsonLine(item: unknown): string | null {
  if (typeof item === 'string') return item;
  if (!item || typeof item !== 'object') return null;
  return JSON.stringify(item);
}

function claudeSdkMessagesOutput(messages: SessionMessage[], info: SDKSessionInfo | undefined): string | null {
  const records = messages.map(claudeSdkMessageToJsonLine);
  if (records.length === 0) return null;
  if (info?.cwd) {
    records.unshift(
      JSON.stringify({
        type: 'system',
        subtype: 'init',
        session_id: info.sessionId,
        cwd: info.cwd
      })
    );
  }
  return records.join('\n');
}

function claudeSdkHistoryPageOutput(context: ExternalAgentProviderHistoryPageContext): string | null {
  const records = context.page.items.flatMap((item) => {
    const line = claudeHistoryItemToJsonLine(item);
    return line ? [line] : [];
  });
  return records.length > 0 ? records.join('\n') : null;
}

function claudeHistoryOffset(cursor: string | undefined): number {
  if (!cursor) return 0;
  const offset = Number.parseInt(cursor, 10);
  return Number.isFinite(offset) && offset > 0 ? offset : 0;
}

interface ClaudeSdkHistoryPageDeps {
  getSessionInfo: typeof getSessionInfo;
  getSessionMessages: typeof getSessionMessages;
}

export function createClaudeSdkHistoryPageReader(deps: ClaudeSdkHistoryPageDeps) {
  return async function readClaudeHistoryPage(
    context: ExternalAgentProviderHistoryPageRequestContext
  ): Promise<ExternalAgentProviderHistoryPageContext['page'] | null> {
    try {
      const offset = claudeHistoryOffset(context.request.before);
      const [info, messages] = await Promise.all([
        deps.getSessionInfo(context.providerSessionRef, { dir: context.workingPath }),
        deps.getSessionMessages(context.providerSessionRef, {
          dir: context.workingPath,
          limit: context.request.limit,
          offset,
          includeSystemMessages: true
        })
      ]);
      const items: unknown[] = [];
      if (info?.cwd) {
        items.push({
          type: 'system',
          subtype: 'init',
          session_id: info.sessionId,
          cwd: info.cwd
        });
      }
      items.push(
        ...messages.map((message) => ({
          type: message.type,
          uuid: message.uuid,
          session_id: message.session_id,
          message: message.message,
          parent_tool_use_id: message.parent_tool_use_id
        }))
      );
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

const readClaudeHistoryPage = createClaudeSdkHistoryPageReader({ getSessionInfo, getSessionMessages });

async function readClaudeHistoryOutput(context: ExternalAgentProviderHistoryContext): Promise<string | null> {
  try {
    const info = await getSessionInfo(context.providerSessionRef, { dir: context.workingPath });
    if ((info?.fileSize ?? 0) > context.limitBytes) return claudeTranscriptFallback(context);
    const messages = await getSessionMessages(context.providerSessionRef, {
      dir: context.workingPath,
      limit: 200,
      includeSystemMessages: true
    });
    return claudeSdkMessagesOutput(messages, info) ?? claudeTranscriptFallback(context);
  } catch {
    return claudeTranscriptFallback(context);
  }
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

function sendClaudeInput(handle: Parameters<ExternalAgentProviderAdapter['sendInput']>[0], input: string): void {
  if (handle.launchMode !== 'json-stream') {
    sendPtyInput(handle, input);
    return;
  }
  if (!handle.stdin) throw new Error('external agent session has no stream-json input bridge');
  handle.stdin.write(`${JSON.stringify(buildClaudeStreamJsonUserMessage(input))}\n`);
  void handle.stdin.flush?.();
}

function resizeClaude(handle: Parameters<ExternalAgentProviderAdapter['resize']>[0], cols: number, rows: number): void {
  if (handle.launchMode === 'json-stream') return;
  resizePty(handle, cols, rows);
}

function stopClaude(handle: Parameters<ExternalAgentProviderAdapter['stop']>[0]): void {
  if (handle.launchMode === 'json-stream') {
    void handle.stdin?.end?.();
    handle.kill('SIGTERM');
    return;
  }
  stopPty(handle);
}

function resolveClaudeApproval(): void {
  throw new Error('Claude Code external agent approval resolution is not supported in json-stream mode');
}

export const claudeCodeExternalAgentAdapter: ExternalAgentProviderAdapter = {
  provider: 'claude-code',
  productIcon: 'claude-code',
  label: 'Claude Code',
  observation: claudeCodeObservationProjection,
  settings: () => [
    ...externalAgentAdapterSettings({ launchModes: ['pty', 'json-stream', 'remote-control'] }),
    {
      key: 'showThinkingSummary',
      label: 'Show thinking summary',
      description: 'Pass --thinking-display summarized when enabled; omitted when disabled.',
      kind: 'switch',
      defaultValue: true
    }
  ],
  settingsImport: createClaudeCodeSettingsImport(),
  // ACP delivery variant: same Claude Code agent, launched as an external ACP sub-agent via the
  // claude-agent-acp wrapper. Version-pinned so `npx -y <pkg>@<ver>` resolves a known build.
  acp: {
    command: 'npx',
    args: ['-y', '@agentclientprotocol/claude-agent-acp@0.49.0'],
    env: { ANTHROPIC_API_KEY: '${env:' + 'ANTHROPIC_API_KEY}' }
  },
  managedRuntime: {
    launchMode: () => 'json-stream',
    mcpConfigArgs: claudeManagedMcpConfigArgs,
    usesManagedMcpBridge: true,
    usesSystemPromptFile: true
  },
  detect(probes = defaultBinProbes) {
    const claudeBin = resolveBinary('claude', [], probes);
    const installed = claudeBin !== undefined;
    return {
      id: 'claude-code',
      label: claudeCodeExternalAgentAdapter.label,
      provider: 'claude-code',
      productIcon: claudeCodeExternalAgentAdapter.productIcon,
      command: 'claude',
      args: [],
      modelOptions: claudeCodeExternalAgentAdapter.listSupportedModels(),
      defaultLaunchMode: 'pty',
      supportedLaunchModes: ['pty', 'json-stream', 'remote-control'],
      installHint: 'Install Claude Code, then sign in with claude auth.',
      installUrl: 'https://docs.anthropic.com/en/docs/claude-code/setup',
      installed,
      resolvedBinPath: claudeBin,
      capabilities: {
        auth: 'pty',
        history: 'provider-owned',
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
  buildLaunch: buildClaudeLaunch,
  buildAuthLaunch(agent) {
    return buildClaudeAuthLaunch(agent, ['auth', 'login']);
  },
  buildAuthStatusLaunch(agent) {
    return buildClaudeAuthLaunch(agent, ['auth', 'status']);
  },
  authStatus(agent) {
    return {
      launch: buildClaudeAuthLaunch(agent, ['auth', 'status', '--json']),
      parse: (output, exitCode) => claudeCodeExternalAgentAdapter.parseAuthStatus(output, exitCode)
    };
  },
  argumentSupport(agent) {
    return {
      launch: buildClaudeAuthLaunch(agent, ['--help']),
      parse: (output) => parseExternalAgentArgumentSupport(output)
    };
  },
  parseAuthStatus(output, exitCode) {
    const structured = parseStructuredAuthState(output);
    if (structured) return structured;
    if (exitCode === 0) return 'authenticated';
    if (exitCode === 1) return 'unauthenticated';
    return 'unknown';
  },
  historyPage: readClaudeHistoryPage,
  historyPageOutput: claudeSdkHistoryPageOutput,
  historyOutput: readClaudeHistoryOutput,
  parseOutput: parseClaudeStreamJson,
  sendInput: sendClaudeInput,
  resolveApproval: resolveClaudeApproval,
  resize: resizeClaude,
  stop: stopClaude
};
