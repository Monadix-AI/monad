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
import { resizePty, sendPtyInput, stopPty } from '@/services/native-cli/pty.ts';

function withClaudeStreamJsonArgs(args: string[]): string[] {
  const next = [...args];
  if (!next.includes('-p') && !next.includes('--print')) next.unshift('-p');
  if (!next.includes('--input-format')) next.push('--input-format', 'stream-json');
  if (!next.includes('--output-format')) next.push('--output-format', 'stream-json');
  if (!next.includes('--verbose')) next.push('--verbose');
  return next;
}

function buildClaudeLaunch(agent: NativeCliAgentView, opts: BuildNativeCliLaunchOptions): NativeCliLaunchSpec {
  const launchMode = opts.launchMode ?? agent.defaultLaunchMode;
  const args = [...(agent.args ?? [])];
  if (opts.providerSessionRef && !args.includes('--resume') && !args.includes('-r')) {
    args.push('--resume', opts.providerSessionRef);
  }
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
      events.push({ type: 'agent_message', payload: { text: record.result } });
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
  detect(probes = defaultBinProbes) {
    const claudeBin = resolveBinary('claude', [], probes);
    const installed = claudeBin !== undefined || probes.exists(join(homedir(), '.claude'));
    return {
      id: 'claude-code',
      label: 'Claude Code',
      provider: 'claude-code',
      command: 'claude',
      args: [],
      defaultLaunchMode: 'pty',
      supportedLaunchModes: ['pty', 'json-stream', 'remote-control'],
      installHint: 'Install Claude Code, then sign in with claude auth.',
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
  buildLaunch: buildClaudeLaunch,
  buildAuthLaunch(agent) {
    return buildClaudeAuthLaunch(agent, ['auth', 'login']);
  },
  buildAuthStatusLaunch(agent) {
    return buildClaudeAuthLaunch(agent, ['auth', 'status']);
  },
  parseAuthStatus(output, exitCode) {
    const structured = parseStructuredAuthState(output);
    if (structured) return structured;
    if (exitCode === 0 && /logged in|authenticated|signed in/i.test(output)) return 'authenticated';
    if (/not logged in|not authenticated|logged out|unauthenticated|sign in|login/i.test(output))
      return 'unauthenticated';
    return 'unknown';
  },
  parseOutput: parseClaudeStreamJson,
  sendInput: sendClaudeInput,
  resolveApproval: resolveClaudeApproval,
  resize: resizeClaude,
  stop: stopClaude
};
