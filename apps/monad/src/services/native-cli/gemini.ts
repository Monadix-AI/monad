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

function hasFlag(args: string[], flag: string): boolean {
  return args.some((arg) => arg === flag || arg.startsWith(`${flag}=`));
}

function withGeminiStreamJsonArgs(args: string[]): string[] {
  const next = [...args];
  if (!hasFlag(next, '-p') && !hasFlag(next, '--prompt')) next.unshift('-p', '');
  if (!hasFlag(next, '--output-format') && !hasFlag(next, '-o')) next.push('--output-format', 'stream-json');
  return next;
}

function buildGeminiLaunch(agent: NativeCliAgentView, opts: BuildNativeCliLaunchOptions): NativeCliLaunchSpec {
  const launchMode = opts.launchMode ?? agent.defaultLaunchMode;
  const args = [...(agent.args ?? [])];
  if (opts.providerSessionRef && !hasFlag(args, '--resume') && !hasFlag(args, '-r')) {
    args.push('--resume', opts.providerSessionRef);
  }
  const launchArgs = launchMode === 'json-stream' ? withGeminiStreamJsonArgs(args) : args;
  return {
    argv: [agent.command, ...launchArgs],
    cwd: opts.workingPath,
    env: agent.env,
    launchMode,
    provider: 'gemini',
    approvalOwnership: 'provider-owned',
    capabilities: ['pty', 'json-stream', 'provider-approval', 'structured-output', 'session-resume']
  };
}

function buildGeminiAuthLaunch(agent: NativeCliAgentView, args: string[]): NativeCliLaunchSpec {
  return {
    argv: [agent.command, ...args],
    cwd: homedir(),
    env: agent.env,
    launchMode: 'pty',
    provider: 'gemini',
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

function compactObject(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function stringValue(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
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

function parseGeminiStreamJson(chunk: string): NativeCliOutputEvent[] {
  const events: NativeCliOutputEvent[] = [];
  for (const rawLine of chunk.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('{')) continue;
    const record = parseJsonObject(line);
    if (!record) continue;

    if (record.type === 'init') {
      const providerSessionRef = stringValue(record.session_id, record.sessionId, record.session);
      if (providerSessionRef) {
        events.push({
          type: 'session_ref',
          payload: compactObject({
            providerSessionRef,
            model: record.model
          })
        });
      }
      continue;
    }

    if (record.type === 'message') {
      const text = stringValue(record.text, record.content, record.delta, record.message);
      if (text) events.push({ type: 'agent_message', payload: { text } });
      continue;
    }

    if (record.type === 'tool_use') {
      events.push({
        type: 'tool_call',
        payload: compactObject({
          callId: record.id ?? record.call_id ?? record.tool_call_id,
          tool: record.name ?? record.tool,
          input: record.args ?? record.arguments ?? record.input
        })
      });
      continue;
    }

    if (record.type === 'tool_result') {
      events.push({
        type: 'tool_result',
        payload: compactObject({
          callId: record.id ?? record.call_id ?? record.tool_call_id,
          output: record.output ?? record.result ?? record.content
        })
      });
      continue;
    }

    if (record.type === 'result') {
      const text = stringValue(record.response, record.result, record.text);
      if (text) events.push({ type: 'agent_message', payload: { text } });
    }
  }
  return events;
}

function sendGeminiInput(handle: Parameters<NativeCliProviderAdapter['sendInput']>[0], input: string): void {
  if (handle.launchMode !== 'json-stream') {
    sendPtyInput(handle, input);
    return;
  }
  if (!handle.stdin) throw new Error('native CLI session has no stream-json input bridge');
  handle.stdin.write(input);
  void handle.stdin.flush?.();
}

function resizeGemini(handle: Parameters<NativeCliProviderAdapter['resize']>[0], cols: number, rows: number): void {
  if (handle.launchMode === 'json-stream') return;
  resizePty(handle, cols, rows);
}

function stopGemini(handle: Parameters<NativeCliProviderAdapter['stop']>[0]): void {
  if (handle.launchMode === 'json-stream') {
    void handle.stdin?.end?.();
    handle.kill('SIGTERM');
    return;
  }
  stopPty(handle);
}

function resolveGeminiApproval(
  handle: Parameters<NativeCliProviderAdapter['resolveApproval']>[0],
  resolution: Parameters<NativeCliProviderAdapter['resolveApproval']>[1]
): void {
  void resolution;
  if (handle.launchMode === 'json-stream') {
    throw new Error('Gemini native CLI approval resolution is provider-owned and not supported over stream-json');
  }
}

export const geminiNativeCliAdapter: NativeCliProviderAdapter = {
  provider: 'gemini',
  detect(probes = defaultBinProbes) {
    const geminiBin = resolveBinary('gemini', [], probes);
    const installed = geminiBin !== undefined || probes.exists(join(homedir(), '.gemini'));
    return {
      id: 'gemini',
      label: 'Gemini CLI',
      provider: 'gemini',
      command: 'gemini',
      args: [],
      defaultLaunchMode: 'pty',
      supportedLaunchModes: ['pty', 'json-stream'],
      installHint: 'Install Gemini CLI, then complete its provider-owned authentication flow.',
      installUrl: 'https://github.com/google-gemini/gemini-cli',
      installed,
      resolvedBinPath: geminiBin,
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
  buildLaunch: buildGeminiLaunch,
  buildAuthLaunch(agent) {
    return buildGeminiAuthLaunch(agent, []);
  },
  buildAuthStatusLaunch(agent) {
    return buildGeminiAuthLaunch(agent, ['--list-sessions']);
  },
  parseAuthStatus(output, exitCode) {
    const structured = parseStructuredAuthState(output);
    if (structured) return structured;
    void exitCode;
    return 'unknown';
  },
  parseOutput: parseGeminiStreamJson,
  sendInput: sendGeminiInput,
  resolveApproval: resolveGeminiApproval,
  resize: resizeGemini,
  stop: stopGemini
};
