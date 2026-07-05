import type {
  SDKAssistantMessage,
  SDKMessage,
  SDKPermissionDenial,
  SDKSessionInfo,
  SDKSystemMessage,
  SDKUserMessage,
  SessionMessage
} from '@anthropic-ai/claude-agent-sdk';
import type { NativeCliAgentView } from '@monad/protocol';
import type {
  BuildNativeCliLaunchOptions,
  NativeCliLaunchSpec,
  NativeCliManagedRuntimeContext,
  NativeCliOutputEvent,
  NativeCliProviderAdapter,
  NativeCliProviderHistoryContext
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
import { parseNativeCliArgumentSupport } from '../argument-support.ts';
import { readProviderHistoryFile } from '../history-files.ts';
import { resizePty, sendPtyInput, stopPty } from '../pty.ts';
import { createClaudeCodeSettingsImport } from '../settings-import.ts';

// `claude --help` documents `--model` as accepting either a tier alias ("fable", "opus", "sonnet",
// "haiku" — each resolves to that tier's latest release) or a pinned full model name. There is no
// `claude models list`-style probe, so a hand-maintained list of exact dated model names would need
// an edit every time a new point release ships and would silently go stale between edits. The alias
// tier names never do — they're the CLI's own stable, permanent identifiers — so they're the fallback
// used here instead of a version-pinned enum.
const CLAUDE_CODE_SUPPORTED_MODELS = ['fable', 'opus', 'sonnet', 'haiku'];

// `-p`/`--print` (non-interactive/headless mode) + `--input-format`/`--output-format stream-json` —
// confirmed against code.claude.com/docs/en/permission-modes and Anthropic's documented headless
// recipe: `claude -p "..." --output-format stream-json` for automated pipelines.
function withClaudeStreamJsonArgs(args: string[]): string[] {
  const next = [...args];
  if (!next.includes('-p') && !next.includes('--print')) next.unshift('-p');
  if (!next.includes('--input-format')) next.push('--input-format', 'stream-json');
  if (!next.includes('--output-format')) next.push('--output-format', 'stream-json');
  if (!next.includes('--verbose')) next.push('--verbose');
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

function claudeManagedMcpConfigArgs(context: NativeCliManagedRuntimeContext): string[] {
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

function buildClaudeLaunch(agent: NativeCliAgentView, opts: BuildNativeCliLaunchOptions): NativeCliLaunchSpec {
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

function buildClaudeAuthLaunch(agent: NativeCliAgentView, args: string[]): NativeCliLaunchSpec {
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

function parseClaudeContentBlocks(content: ClaudeMessageContent): NativeCliOutputEvent[] {
  if (typeof content === 'string') return [];
  const events: NativeCliOutputEvent[] = [];
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

function claudePermissionDenialEvents(denials: SDKPermissionDenial[], result: string): NativeCliOutputEvent[] {
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

function claudeSystemInitEvents(message: SDKSystemMessage): NativeCliOutputEvent[] {
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

function claudeMessageEvents(message: SDKMessage): NativeCliOutputEvent[] {
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

function parseClaudeStreamJson(chunk: string): NativeCliOutputEvent[] {
  const events: NativeCliOutputEvent[] = [];
  for (const rawLine of chunk.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('{')) continue;
    const message = decodeClaudeMessage(line);
    if (message) events.push(...claudeMessageEvents(message));
  }
  return events;
}

function claudeTranscriptFallback(context: NativeCliProviderHistoryContext): string | null {
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

async function readClaudeHistoryOutput(context: NativeCliProviderHistoryContext): Promise<string | null> {
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

function sendClaudeInput(handle: Parameters<NativeCliProviderAdapter['sendInput']>[0], input: string): void {
  if (handle.launchMode !== 'json-stream') {
    sendPtyInput(handle, input);
    return;
  }
  if (!handle.stdin) throw new Error('native CLI session has no stream-json input bridge');
  handle.stdin.write(`${JSON.stringify(buildClaudeStreamJsonUserMessage(input))}\n`);
  void handle.stdin.flush?.();
}

function resizeClaude(handle: Parameters<NativeCliProviderAdapter['resize']>[0], cols: number, rows: number): void {
  if (handle.launchMode === 'json-stream') return;
  resizePty(handle, cols, rows);
}

function stopClaude(handle: Parameters<NativeCliProviderAdapter['stop']>[0]): void {
  if (handle.launchMode === 'json-stream') {
    void handle.stdin?.end?.();
    handle.kill('SIGTERM');
    return;
  }
  stopPty(handle);
}

function resolveClaudeApproval(): void {
  throw new Error('Claude Code native CLI approval resolution is not supported in json-stream mode');
}

export const claudeCodeNativeCliAdapter: NativeCliProviderAdapter = {
  provider: 'claude-code',
  productIcon: 'claude-code',
  label: 'Claude Code',
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
      label: claudeCodeNativeCliAdapter.label,
      provider: 'claude-code',
      productIcon: claudeCodeNativeCliAdapter.productIcon,
      command: 'claude',
      args: [],
      modelOptions: claudeCodeNativeCliAdapter.listSupportedModels(),
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
      parse: (output, exitCode) => claudeCodeNativeCliAdapter.parseAuthStatus(output, exitCode)
    };
  },
  argumentSupport(agent) {
    return {
      launch: buildClaudeAuthLaunch(agent, ['--help']),
      parse: (output) => parseNativeCliArgumentSupport(output)
    };
  },
  parseAuthStatus(output, exitCode) {
    const structured = parseStructuredAuthState(output);
    if (structured) return structured;
    if (exitCode === 0) return 'authenticated';
    if (exitCode === 1) return 'unauthenticated';
    return 'unknown';
  },
  historyOutput: readClaudeHistoryOutput,
  parseOutput: parseClaudeStreamJson,
  sendInput: sendClaudeInput,
  resolveApproval: resolveClaudeApproval,
  resize: resizeClaude,
  stop: stopClaude
};
