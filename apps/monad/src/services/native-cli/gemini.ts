import type { NativeCliAgentView } from '@monad/protocol';
import type {
  BuildNativeCliLaunchOptions,
  NativeCliLaunchSpec,
  NativeCliOutputEvent,
  NativeCliProviderAdapter,
  NativeCliProviderHistoryContext
} from '@/services/native-cli/types.ts';

import { homedir } from 'node:os';
import { join } from 'node:path';

import { defaultBinProbes, resolveBinary } from '@/infra/resolve-binary.ts';
import { parseNativeCliArgumentSupport } from '@/services/native-cli/argument-support.ts';
import { readProviderHistoryFile } from '@/services/native-cli/history-files.ts';
import { resizePty, sendPtyInput, stopPty } from '@/services/native-cli/pty.ts';

const GEMINI_SUPPORTED_MODELS = ['gemini-2.5-pro', 'gemini-2.5-flash'];

function hasFlag(args: string[], flag: string): boolean {
  return args.some((arg) => arg === flag || arg.startsWith(`${flag}=`));
}

function withGeminiStreamJsonArgs(args: string[]): string[] {
  const next = [...args];
  if (!hasFlag(next, '-p') && !hasFlag(next, '--prompt')) next.unshift('-p', '');
  if (!hasFlag(next, '--output-format') && !hasFlag(next, '-o')) next.push('--output-format', 'stream-json');
  return next;
}

function withGeminiSkipApprovalArgs(args: string[], skipProviderApprovals: boolean): string[] {
  if (!skipProviderApprovals || hasFlag(args, '--approval-mode') || hasFlag(args, '--yolo')) return args;
  return [...args, '--approval-mode=yolo'];
}

function geminiExtraWorkingPathArgs(paths: string[] | undefined): string[] {
  return (paths ?? []).flatMap((path) => ['--include-directories', path]);
}

function buildGeminiLaunch(agent: NativeCliAgentView, opts: BuildNativeCliLaunchOptions): NativeCliLaunchSpec {
  const launchMode = opts.launchMode ?? agent.defaultLaunchMode;
  let args = [...(agent.args ?? [])];
  if (opts.providerSessionRef && !hasFlag(args, '--resume') && !hasFlag(args, '-r')) {
    args.push('--resume', opts.providerSessionRef);
  }
  const modelId = opts.modelId ?? opts.modelName;
  if (modelId && !hasFlag(args, '--model') && !hasFlag(args, '-m')) {
    args.push('--model', modelId);
  }
  args = withGeminiSkipApprovalArgs(args, !!opts.skipProviderApprovals);
  args = [...args, ...geminiExtraWorkingPathArgs(opts.extraWorkingPaths)];
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
    env: {
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      ...agent.env,
      NO_BROWSER: 'true'
    },
    launchMode: 'pty',
    provider: 'gemini',
    approvalOwnership: 'provider-owned',
    capabilities: ['pty', 'provider-approval']
  };
}

function buildGeminiAuthStatusLaunch(agent: NativeCliAgentView): NativeCliLaunchSpec {
  void agent;
  const script = String.raw`
const { existsSync, readFileSync } = require('node:fs');
const { homedir } = require('node:os');
const { join } = require('node:path');

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

const home = homedir();
const settings = readJson(join(home, '.gemini', 'settings.json'));
const accounts = readJson(join(home, '.gemini', 'google_accounts.json'));
const selectedType = settings?.security?.auth?.selectedType;
const hasApiKey = Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);
const hasActiveGoogleAccount = typeof accounts?.active === 'string' && accounts.active.length > 0;
const hasAdc =
  (process.env.GOOGLE_APPLICATION_CREDENTIALS && existsSync(process.env.GOOGLE_APPLICATION_CREDENTIALS)) ||
  existsSync(join(home, '.config', 'gcloud', 'application_default_credentials.json'));

let state = 'unknown';
if (hasApiKey || hasActiveGoogleAccount || hasAdc) state = 'authenticated';
else if (selectedType === 'oauth-personal' || selectedType === 'gemini-api-key' || selectedType === 'vertex-ai') {
  state = 'unauthenticated';
}

process.stdout.write(JSON.stringify({ state }) + '\n');
`;
  return {
    argv: [process.execPath, '--eval', script],
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
      if (text) events.push({ type: 'agent_message', payload: { text, final: true } });
    }
  }
  return events;
}

function geminiCheckpointText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (!part || typeof part !== 'object' || Array.isArray(part)) return '';
      const item = part as Record<string, unknown>;
      return typeof item.text === 'string' ? item.text : '';
    })
    .join('');
}

function geminiCheckpointOutput(context: NativeCliProviderHistoryContext, raw: string): string | null {
  const records: Record<string, unknown>[] = [];
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('{')) continue;
    const record = parseJsonObject(line);
    if (!record) continue;
    if (record.sessionId === context.providerSessionRef) {
      records.push({ type: 'init', session_id: record.sessionId });
      continue;
    }
    const set = record.$set;
    if (!set || typeof set !== 'object' || Array.isArray(set)) continue;
    const messages = (set as Record<string, unknown>).messages;
    if (!Array.isArray(messages)) continue;
    for (const message of messages) {
      if (!message || typeof message !== 'object' || Array.isArray(message)) continue;
      const item = message as Record<string, unknown>;
      if (item.type !== 'model' && item.type !== 'assistant') continue;
      const text = geminiCheckpointText(item.content);
      if (text) records.push({ type: 'message', text });
    }
  }
  return records.length > 0 ? records.map((record) => JSON.stringify(record)).join('\n') : null;
}

function readGeminiHistoryOutput(context: NativeCliProviderHistoryContext): string | null {
  const raw = readProviderHistoryFile({
    roots: [join(homedir(), '.gemini', 'tmp'), join(homedir(), '.gemini', 'history')],
    providerSessionRef: context.providerSessionRef,
    extensions: ['.jsonl', '.json'],
    limitBytes: context.limitBytes,
    maxDepth: 8
  });
  if (!raw) return null;
  if (parseGeminiStreamJson(raw).length > 0) return raw;
  return geminiCheckpointOutput(context, raw);
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
  productIcon: 'gemini',
  detect(probes = defaultBinProbes) {
    const geminiBin = resolveBinary('gemini', [], probes);
    const installed = geminiBin !== undefined || probes.exists(join(homedir(), '.gemini'));
    return {
      id: 'gemini',
      label: 'Gemini CLI',
      provider: 'gemini',
      productIcon: geminiNativeCliAdapter.productIcon,
      command: 'gemini',
      args: [],
      modelOptions: geminiNativeCliAdapter.listSupportedModels(),
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
  listSupportedModels(agent) {
    return agent?.modelOptions?.length ? agent.modelOptions : GEMINI_SUPPORTED_MODELS;
  },
  buildLaunch: buildGeminiLaunch,
  buildAuthLaunch(agent) {
    return buildGeminiAuthLaunch(agent, []);
  },
  buildAuthStatusLaunch(agent) {
    return buildGeminiAuthStatusLaunch(agent);
  },
  authStatus(agent) {
    return {
      launch: buildGeminiAuthStatusLaunch(agent),
      parse: (output, exitCode) => geminiNativeCliAdapter.parseAuthStatus(output, exitCode)
    };
  },
  argumentSupport(agent) {
    return {
      launch: buildGeminiAuthLaunch(agent, ['--help']),
      parse: (output) => parseNativeCliArgumentSupport(output)
    };
  },
  parseAuthStatus(output, exitCode) {
    const structured = parseStructuredAuthState(output);
    if (structured) return structured;
    void exitCode;
    return 'unknown';
  },
  historyOutput: readGeminiHistoryOutput,
  parseOutput: parseGeminiStreamJson,
  sendInput: sendGeminiInput,
  resolveApproval: resolveGeminiApproval,
  resize: resizeGemini,
  stop: stopGemini
};
