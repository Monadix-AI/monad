import type { NativeCliAgentView } from '@monad/protocol';
import type {
  BuildNativeCliLaunchOptions,
  NativeCliLaunchSpec,
  NativeCliProviderAdapter,
  NativeCliProviderHistoryContext
} from '@monad/sdk-atom';

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { defaultBinProbes, resolveBinary } from '@monad/sdk-atom';

import { hasFlag, parseStructuredAuthState, uniqueModelNames } from '../adapter-shared.ts';
import { parseNativeCliArgumentSupport } from '../argument-support.ts';
import { readProviderHistoryFile } from '../history-files.ts';
import { resizePty, sendPtyInput, stopPty } from '../pty.ts';
import { nativeCliAdapterSettings } from '../settings.ts';
import { createBasicSettingsImport } from '../settings-import.ts';
import { qwenObservationProjection } from './observation.ts';
import {
  hasQwenStreamJsonMessages,
  initializeQwenStreamJson,
  parseQwenStreamJson,
  resolveQwenStreamJsonApproval,
  sendQwenStreamJsonInput
} from './stream-json.ts';

const QWEN_SUPPORTED_MODELS = ['qwen3-coder-plus', 'qwen3-coder-flash'];

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

// Qwen Code's SDK integration channel (`@qwen-code/sdk` ProcessTransport): a persistent bidirectional
// stream-json session — user turns and control responses in on stdin, `SDKMessage`s and control
// requests out on stdout — rather than a one-shot `-p` run. This is what makes multi-turn and
// provider approval resolution possible over the same process.
function withQwenStreamJsonArgs(args: string[]): string[] {
  const next = [...args];
  if (!hasFlag(next, '--input-format')) next.push('--input-format', 'stream-json');
  if (!hasFlag(next, '--output-format') && !hasFlag(next, '-o')) next.push('--output-format', 'stream-json');
  return next;
}

// `--approval-mode=yolo` — confirmed against qwenlm.github.io/qwen-code-docs (Qwen Code shares Gemini
// CLI's approval-mode vocabulary: default/auto_edit/yolo, settable via CLI flag or config).
function withQwenSkipApprovalArgs(args: string[], skipProviderApprovals: boolean): string[] {
  if (!skipProviderApprovals || hasFlag(args, '--approval-mode') || hasFlag(args, '--yolo')) return args;
  return [...args, '--approval-mode=yolo'];
}

function qwenExtraWorkingPathArgs(paths: string[] | undefined): string[] {
  return (paths ?? []).flatMap((path) => ['--include-directories', path]);
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
  args = [...args, ...qwenExtraWorkingPathArgs(opts.extraWorkingPaths)];
  const launchArgs = launchMode === 'json-stream' ? withQwenStreamJsonArgs(args) : args;
  return {
    argv: [agent.command, ...launchArgs],
    cwd: opts.workingPath,
    env: agent.env,
    launchMode,
    provider: 'qwen',
    approvalOwnership: 'provider-owned',
    capabilities: [
      'pty',
      'json-stream',
      'provider-approval',
      'approval-resolution',
      'structured-output',
      'session-resume'
    ]
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

function readQwenHistoryOutput(context: NativeCliProviderHistoryContext): string | null {
  const raw = readProviderHistoryFile({
    roots: [join(homedir(), '.qwen')],
    providerSessionRef: context.providerSessionRef,
    extensions: ['.jsonl', '.json'],
    limitBytes: context.limitBytes,
    maxDepth: 8
  });
  return raw && hasQwenStreamJsonMessages(raw) ? raw : null;
}

function sendQwenInput(handle: Parameters<NativeCliProviderAdapter['sendInput']>[0], input: string): void {
  if (handle.launchMode !== 'json-stream') {
    sendPtyInput(handle, input);
    return;
  }
  sendQwenStreamJsonInput(handle, input);
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
  if (handle.launchMode !== 'json-stream') return;
  resolveQwenStreamJsonApproval(handle, resolution);
}

export const qwenNativeCliAdapter: NativeCliProviderAdapter = {
  provider: 'qwen',
  productIcon: 'qwen',
  label: 'Qwen Code',
  observation: qwenObservationProjection,
  settings: () => nativeCliAdapterSettings({ launchModes: ['pty', 'json-stream'] }),
  settingsImport: createBasicSettingsImport('qwen', 'Qwen Code', 'qwen', '.qwen'),
  managedRuntime: {
    launchMode: () => 'json-stream'
  },
  detect(probes = defaultBinProbes) {
    const qwenBin = resolveBinary('qwen', [], probes);
    const installed = qwenBin !== undefined;
    return {
      id: 'qwen',
      label: qwenNativeCliAdapter.label,
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
        approval: 'provider-owned',
        approvalProxy: true,
        settingsImport: true
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
  historyOutput: readQwenHistoryOutput,
  initialize: initializeQwenStreamJson,
  parseOutput: parseQwenStreamJson,
  sendInput: sendQwenInput,
  supportsApprovalResolution: (launchMode) => launchMode === 'json-stream',
  resolveApproval: resolveQwenApproval,
  resize: resizeQwen,
  stop: stopQwen
};
