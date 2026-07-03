import type { NativeCliAgentView } from '@monad/protocol';
import type {
  BuildNativeCliLaunchOptions,
  NativeCliLaunchSpec,
  NativeCliOutputEvent,
  NativeCliProviderAdapter
} from '@/services/native-cli/types.ts';

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { defaultBinProbes, resolveBinary } from '@/infra/resolve-binary.ts';
import { parseNativeCliArgumentSupport } from '@/services/native-cli/argument-support.ts';
import { resizePty, sendPtyInput, stopPty } from '@/services/native-cli/pty.ts';

const QWEN_SUPPORTED_MODELS = ['qwen3-coder-plus', 'qwen3-coder-flash'];

function uniqueModelNames(names: string[]): string[] {
  return [...new Set(names.map((name) => name.trim()).filter(Boolean))];
}

function readQwenConfiguredModels(): string[] {
  try {
    const raw = readFileSync(join(homedir(), '.qwen', 'settings.json'), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
    const providers = (parsed as Record<string, unknown>).modelProviders;
    if (!providers || typeof providers !== 'object' || Array.isArray(providers)) return [];
    const models: string[] = [];
    for (const provider of Object.values(providers)) {
      if (!provider || typeof provider !== 'object' || Array.isArray(provider)) continue;
      const providerModels = (provider as Record<string, unknown>).models;
      if (!Array.isArray(providerModels)) continue;
      for (const model of providerModels) {
        if (typeof model === 'string') {
          models.push(model);
          continue;
        }
        if (!model || typeof model !== 'object' || Array.isArray(model)) continue;
        const item = model as Record<string, unknown>;
        const id = typeof item.id === 'string' ? item.id : typeof item.name === 'string' ? item.name : undefined;
        if (id) models.push(id);
      }
    }
    return uniqueModelNames(models);
  } catch {
    return [];
  }
}

function hasFlag(args: string[], flag: string): boolean {
  return args.some((arg) => arg === flag || arg.startsWith(`${flag}=`));
}

function withQwenStreamJsonArgs(args: string[]): string[] {
  const next = [...args];
  if (!hasFlag(next, '-p') && !hasFlag(next, '--prompt')) next.unshift('-p', '');
  if (!hasFlag(next, '--output-format') && !hasFlag(next, '-o')) next.push('--output-format', 'stream-json');
  return next;
}

function withQwenSkipApprovalArgs(args: string[], skipProviderApprovals: boolean): string[] {
  if (!skipProviderApprovals || hasFlag(args, '--approval-mode') || hasFlag(args, '--yolo')) return args;
  return [...args, '--approval-mode=yolo'];
}

function buildQwenLaunch(agent: NativeCliAgentView, opts: BuildNativeCliLaunchOptions): NativeCliLaunchSpec {
  const launchMode = opts.launchMode ?? agent.defaultLaunchMode;
  let args = [...(agent.args ?? [])];
  if (opts.providerSessionRef && !hasFlag(args, '--resume') && !hasFlag(args, '-r')) {
    args.push('--resume', opts.providerSessionRef);
  }
  const modelId = opts.modelId ?? opts.modelName;
  if (modelId && !hasFlag(args, '--model') && !hasFlag(args, '-m')) {
    args.push('--model', modelId);
  }
  args = withQwenSkipApprovalArgs(args, !!opts.skipProviderApprovals);
  const launchArgs = launchMode === 'json-stream' ? withQwenStreamJsonArgs(args) : args;
  return {
    argv: [agent.command, ...launchArgs],
    cwd: opts.workingPath,
    env: agent.env,
    launchMode,
    provider: 'qwen',
    approvalOwnership: 'provider-owned',
    capabilities: ['pty', 'json-stream', 'provider-approval', 'structured-output', 'session-resume']
  };
}

function buildQwenAuthLaunch(agent: NativeCliAgentView, args: string[]): NativeCliLaunchSpec {
  return {
    argv: [agent.command, ...args],
    cwd: homedir(),
    env: agent.env,
    launchMode: 'pty',
    provider: 'qwen',
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

function parseQwenStreamJson(chunk: string): NativeCliOutputEvent[] {
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

function sendQwenInput(handle: Parameters<NativeCliProviderAdapter['sendInput']>[0], input: string): void {
  if (handle.launchMode !== 'json-stream') {
    sendPtyInput(handle, input);
    return;
  }
  if (!handle.stdin) throw new Error('native CLI session has no stream-json input bridge');
  handle.stdin.write(input);
  void handle.stdin.flush?.();
}

function resizeQwen(handle: Parameters<NativeCliProviderAdapter['resize']>[0], cols: number, rows: number): void {
  if (handle.launchMode === 'json-stream') return;
  resizePty(handle, cols, rows);
}

function stopQwen(handle: Parameters<NativeCliProviderAdapter['stop']>[0]): void {
  if (handle.launchMode === 'json-stream') {
    void handle.stdin?.end?.();
    handle.kill('SIGTERM');
    return;
  }
  stopPty(handle);
}

function resolveQwenApproval(
  handle: Parameters<NativeCliProviderAdapter['resolveApproval']>[0],
  resolution: Parameters<NativeCliProviderAdapter['resolveApproval']>[1]
): void {
  void resolution;
  if (handle.launchMode === 'json-stream') {
    throw new Error('Qwen native CLI approval resolution is provider-owned and not supported over stream-json');
  }
}

export const qwenNativeCliAdapter: NativeCliProviderAdapter = {
  provider: 'qwen',
  productIcon: 'qwen',
  detect(probes = defaultBinProbes) {
    const qwenBin = resolveBinary('qwen', [], probes);
    const installed = qwenBin !== undefined || probes.exists(join(homedir(), '.qwen'));
    return {
      id: 'qwen',
      label: 'Qwen Code',
      provider: 'qwen',
      productIcon: qwenNativeCliAdapter.productIcon,
      command: 'qwen',
      args: [],
      modelOptions: qwenNativeCliAdapter.listSupportedModels(),
      defaultLaunchMode: 'pty',
      supportedLaunchModes: ['pty', 'json-stream'],
      installHint: 'Install Qwen Code, then complete its provider-owned authentication flow.',
      installUrl: 'https://qwenlm.github.io/qwen-code-docs/en/users/quickstart/',
      installed,
      resolvedBinPath: qwenBin,
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
    if (agent?.modelOptions?.length) return agent.modelOptions;
    const configured = readQwenConfiguredModels();
    return configured.length > 0 ? configured : QWEN_SUPPORTED_MODELS;
  },
  buildLaunch: buildQwenLaunch,
  buildAuthLaunch(agent) {
    return buildQwenAuthLaunch(agent, []);
  },
  buildAuthStatusLaunch(agent) {
    return buildQwenAuthLaunch(agent, ['--list-sessions']);
  },
  authStatus(agent) {
    return {
      launch: buildQwenAuthLaunch(agent, ['--list-sessions']),
      parse: (output, exitCode) => qwenNativeCliAdapter.parseAuthStatus(output, exitCode)
    };
  },
  argumentSupport(agent) {
    return {
      launch: buildQwenAuthLaunch(agent, ['--help']),
      parse: (output) => parseNativeCliArgumentSupport(output)
    };
  },
  parseAuthStatus(output, exitCode) {
    const structured = parseStructuredAuthState(output);
    if (structured) return structured;
    void exitCode;
    return 'unknown';
  },
  parseOutput: parseQwenStreamJson,
  sendInput: sendQwenInput,
  resolveApproval: resolveQwenApproval,
  resize: resizeQwen,
  stop: stopQwen
};
