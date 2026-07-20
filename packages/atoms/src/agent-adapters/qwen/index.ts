import type { MeshAgentView } from '@monad/protocol';
import type {
  MeshAgentProviderAdapter,
  MeshAgentProviderEventContext,
  MeshAgentSessionRuntimeContext,
  SessionEventRuntimeDefinition
} from '@monad/sdk-atom';
import type { LegacyProviderLaunchOptions, LegacyProviderLaunchSpec } from '../legacy/runtime.ts';

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { defaultBinProbes, resolveBinary } from '@monad/sdk-atom';

import { hasFlag, parseStructuredAuthState, uniqueModelNames } from '../adapter-shared.ts';
import { parseMeshAgentArgumentSupport } from '../argument-support.ts';
import { readProviderEventFile } from '../event-files.ts';
import { createOutputEventSource } from '../event-source.ts';
import { meshAgentAdapterSettings } from '../settings.ts';
import { createBasicSettingsImport } from '../settings-import/index.ts';
import { archiveQwenSession, deleteQwenSession } from './lifecycle.ts';
import { qwenObservationProjection } from './observation.ts';
import { QwenSessionEventDriver } from './session-runtime.ts';
import { hasQwenStreamJsonMessages } from './stream-json.ts';

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

function withQwenSystemPromptArgs(args: string[], systemPromptFile: string | undefined): string[] {
  if (!systemPromptFile || hasFlag(args, '--system-prompt') || hasFlag(args, '--append-system-prompt')) return args;
  return [...args, '--append-system-prompt', readFileSync(systemPromptFile, 'utf8')];
}

function buildQwenLaunch(agent: MeshAgentView, opts: LegacyProviderLaunchOptions): LegacyProviderLaunchSpec {
  const launchMode = opts.launchMode ?? 'json-stream';
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
  args = withQwenSystemPromptArgs(args, opts.systemPromptFile);
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

function createQwenSessionRuntime(
  agent: MeshAgentView,
  context: MeshAgentSessionRuntimeContext
): SessionEventRuntimeDefinition {
  const launch = buildQwenLaunch(agent, {
    workingPath: context.workingPath,
    extraWorkingPaths: context.extraWorkingPaths,
    launchMode: 'json-stream',
    providerSessionRef: context.providerSessionRef,
    systemPromptFile: context.systemPromptFile,
    skipProviderApprovals: context.skipProviderApprovals,
    modelName: context.modelName,
    modelId: context.modelId
  });
  return {
    plan: {
      processModel: 'resident',
      launch: {
        args: launch.argv.slice(1),
        cwd: launch.cwd,
        ...(context.env || launch.env ? { env: { ...(launch.env ?? {}), ...(context.env ?? {}) } } : {})
      },
      channel: { kind: 'child-stdio' },
      startup: { timeoutMs: 20_000 }
    },
    driver: new QwenSessionEventDriver()
  };
}

function buildQwenAuthLaunch(agent: MeshAgentView, args: string[]): LegacyProviderLaunchSpec {
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

function readQwenHistoryOutput(context: MeshAgentProviderEventContext): string | null {
  const raw = readProviderEventFile({
    roots: [join(homedir(), '.qwen')],
    providerSessionRef: context.providerSessionRef,
    extensions: ['.jsonl', '.json'],
    maxDepth: 8
  });
  return raw && hasQwenStreamJsonMessages(raw) ? raw : null;
}

export const qwenMeshAgentAdapter: MeshAgentProviderAdapter = {
  provider: 'qwen',
  productIcon: 'qwen',
  label: 'Qwen Code',
  observation: qwenObservationProjection,
  events: createOutputEventSource({
    provider: 'qwen',
    projection: qwenObservationProjection,
    readOutput: readQwenHistoryOutput
  }),
  settings: () => meshAgentAdapterSettings(),
  settingsImport: createBasicSettingsImport('qwen', 'Qwen Code', 'qwen', '.qwen'),
  unsafeArgument: (args) =>
    args.find(
      (arg, index) =>
        arg === '--yolo' || arg === '--approval-mode=yolo' || (arg === '--approval-mode' && args[index + 1] === 'yolo')
    ),
  managedRuntime: {
    usesSystemPromptFile: true
  },
  detect(probes = defaultBinProbes) {
    const qwenBin = resolveBinary('qwen', [], probes);
    const installed = qwenBin !== undefined;
    return {
      id: 'qwen',
      label: qwenMeshAgentAdapter.label,
      provider: 'qwen',
      productIcon: qwenMeshAgentAdapter.productIcon,
      command: 'qwen',
      args: [],
      modelOptions: qwenMeshAgentAdapter.listSupportedModels(),
      installHint: 'Install Qwen Code, then complete its provider-owned authentication flow.',
      installUrl: 'https://qwenlm.github.io/qwen-code-docs/en/users/quickstart/',
      installed,
      resolvedBinPath: qwenBin,
      capabilities: {
        auth: 'pty',
        events: 'provider-owned',
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
  archiveSession: archiveQwenSession,
  deleteSession: deleteQwenSession,
  createSessionRuntime: createQwenSessionRuntime,
  buildAuthLaunch(agent) {
    return buildQwenAuthLaunch(agent, []);
  },
  buildAuthStatusLaunch(agent) {
    return buildQwenAuthLaunch(agent, ['--list-sessions']);
  },
  authStatus(agent) {
    return {
      launch: buildQwenAuthLaunch(agent, ['--list-sessions']),
      parse: (output, exitCode) => qwenMeshAgentAdapter.parseAuthStatus(output, exitCode)
    };
  },
  argumentSupport(agent) {
    return {
      launch: buildQwenAuthLaunch(agent, ['--help']),
      parse: (output) => parseMeshAgentArgumentSupport(output)
    };
  },
  parseAuthStatus(output, exitCode) {
    const structured = parseStructuredAuthState(output);
    if (structured) return structured;
    void exitCode;
    return 'unknown';
  }
};
