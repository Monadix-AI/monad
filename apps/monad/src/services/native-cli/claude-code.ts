import type { NativeCliAgentView } from '@monad/protocol';
import type {
  BuildNativeCliLaunchOptions,
  NativeCliLaunchSpec,
  NativeCliOutputEvent,
  NativeCliProviderAdapter
} from '@/services/native-cli/types.ts';

import { homedir } from 'node:os';
import { join } from 'node:path';

import { defaultBinProbes, resolveBinary } from '@/infra/resolve-binary.ts';
import { parseNativeCliArgumentSupport } from '@/services/native-cli/argument-support.ts';
import { resizePty, sendPtyInput, stopPty } from '@/services/native-cli/pty.ts';

const CLAUDE_CODE_SUPPORTED_MODELS = [
  'claude-fable-5',
  'claude-opus-4-8',
  'claude-sonnet-5',
  'claude-haiku-4-5',
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-sonnet-4-6'
];
function hasFlag(args: string[], flag: string): boolean {
  return args.some((arg) => arg === flag || arg.startsWith(`${flag}=`));
}

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
  return [...args, '--allowedTools', 'Bash(monad project *)', 'Bash(monad agent *)', 'Bash(monad runtime info)'];
}

function withClaudeSkipApprovalArgs(args: string[], skipProviderApprovals: boolean): string[] {
  if (!skipProviderApprovals || hasFlag(args, '--dangerously-skip-permissions')) return args;
  return [...args, '--dangerously-skip-permissions'];
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

function parseJsonObject(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function parseStructuredAuthState(output: string): 'authenticated' | 'unauthenticated' | 'unknown' | undefined {
  for (const rawLine of output.split(/\r?\n/)) {
    const record = parseJsonObject(rawLine.trim());
    if (!record) continue;
    if (record.state === 'authenticated' || record.authenticated === true || record.loggedIn === true)
      return 'authenticated';
    if (record.state === 'unauthenticated' || record.authenticated === false || record.loggedIn === false)
      return 'unauthenticated';
    if (record.state === 'unknown') return 'unknown';
  }
  return undefined;
}

function compactObject(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function stringifyToolResultContent(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const text = content
      .map((part) =>
        part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
          ? (part as { text: string }).text
          : ''
      )
      .join('');
    return text || JSON.stringify(content);
  }
  return content === undefined ? undefined : JSON.stringify(content);
}

function parseClaudeMessageContent(content: unknown): NativeCliOutputEvent[] {
  if (!Array.isArray(content)) return [];
  const events: NativeCliOutputEvent[] = [];
  let text = '';

  for (const part of content) {
    if (!part || typeof part !== 'object' || Array.isArray(part)) continue;
    const item = part as Record<string, unknown>;
    if (item.type === 'text' && typeof item.text === 'string') {
      text += item.text;
      continue;
    }
    if (item.type === 'tool_use') {
      events.push({
        type: 'tool_call',
        payload: compactObject({
          callId: item.id,
          tool: item.name,
          input: item.input
        })
      });
      continue;
    }
    if (item.type === 'tool_result') {
      events.push({
        type: 'tool_result',
        payload: compactObject({
          callId: item.tool_use_id,
          output: stringifyToolResultContent(item.content)
        })
      });
    }
  }

  return text ? [{ type: 'agent_message', payload: { text } }, ...events] : events;
}

function parseClaudePermissionDenials(record: Record<string, unknown>): NativeCliOutputEvent[] {
  const denials = record.permission_denials;
  if (!Array.isArray(denials) || denials.length === 0) return [];
  const messages = denials
    .map((denial) => {
      if (!denial || typeof denial !== 'object' || Array.isArray(denial)) return '';
      const item = denial as Record<string, unknown>;
      const toolName = typeof item.tool_name === 'string' ? item.tool_name : 'tool';
      const toolInput = item.tool_input;
      const input =
        toolInput && typeof toolInput === 'object' && !Array.isArray(toolInput)
          ? (toolInput as Record<string, unknown>)
          : {};
      const command = typeof input.command === 'string' ? input.command : undefined;
      return command ? `${toolName}: ${command}` : toolName;
    })
    .filter(Boolean);
  if (messages.length === 0) return [];
  const result = typeof record.result === 'string' ? record.result.trim() : '';
  return [
    {
      type: 'provider_error',
      payload: {
        code: 'permission_denied',
        message: result
          ? `${result}\n\nBlocked command: ${messages.join('; ')}`
          : `Blocked command: ${messages.join('; ')}`
      }
    }
  ];
}

function parseClaudeStreamJson(chunk: string): NativeCliOutputEvent[] {
  const events: NativeCliOutputEvent[] = [];
  for (const rawLine of chunk.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('{')) continue;
    const record = parseJsonObject(line);
    if (!record) continue;

    if (record.type === 'system' && record.subtype === 'init') {
      events.push({
        type: 'session_ref',
        payload: compactObject({
          providerSessionRef: record.session_id,
          cwd: record.cwd,
          model: record.model,
          permissionMode: record.permissionMode
        })
      });
      continue;
    }

    const message = record.message;
    if (record.type === 'assistant' && message && typeof message === 'object' && !Array.isArray(message)) {
      events.push(...parseClaudeMessageContent((message as Record<string, unknown>).content));
      continue;
    }

    if (record.type === 'user' && message && typeof message === 'object' && !Array.isArray(message)) {
      events.push(...parseClaudeMessageContent((message as Record<string, unknown>).content));
      continue;
    }

    if (record.type === 'result' && typeof record.result === 'string') {
      events.push({ type: 'agent_message', payload: { text: record.result, final: true } });
      events.push(...parseClaudePermissionDenials(record));
    }
  }
  return events;
}

function buildClaudeStreamJsonUserMessage(input: string): Record<string, unknown> {
  return {
    type: 'user',
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
  detect(probes = defaultBinProbes) {
    const claudeBin = resolveBinary('claude', [], probes);
    const installed = claudeBin !== undefined || probes.exists(join(homedir(), '.claude'));
    return {
      id: 'claude-code',
      label: 'Claude Code',
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
        approval: 'provider-owned'
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
  parseOutput: parseClaudeStreamJson,
  sendInput: sendClaudeInput,
  resolveApproval: resolveClaudeApproval,
  resize: resizeClaude,
  stop: stopClaude
};
