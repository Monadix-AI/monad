import type { MeshAgentView } from '@monad/protocol';
import type {
  MeshAgentLaunchSpec,
  MeshAgentProcessLaunchPlan,
  MeshAgentProviderAdapter,
  MeshAgentProviderEventContext,
  MeshAgentSessionRuntimeContext,
  SessionEventRuntimeDefinition
} from '@monad/sdk-atom';

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { defaultBinProbes, resolveBinary } from '@monad/sdk-atom';

import { hasFlag, parseStructuredAuthState, uniqueModelNames } from '../adapter-shared.ts';
import { parseMeshAgentArgumentSupport } from '../argument-support.ts';
import { readProviderEventFile } from '../event-files.ts';
import { createOutputEventSource } from '../event-source.ts';
import { agentAdapterIcons } from '../icons.ts';
import { writeManagedMcpConfigFile } from '../managed-mcp-config.ts';
import { meshAgentAdapterSettings } from '../settings.ts';
import { createBasicSettingsImport } from '../settings-import/index.ts';
import { archiveQwenSession, deleteQwenSession, unarchiveQwenSession } from './lifecycle.ts';
import { qwenObservationProjection } from './observation.ts';
import { QwenSessionEventDriver } from './session-runtime.ts';
import { readQwenSessionUsage } from './session-usage.ts';
import { hasQwenStreamJsonMessages } from './stream-json.ts';

const QWEN_SUPPORTED_MODELS = ['qwen3-coder-plus', 'qwen3-coder-flash'];

function readQwenConfiguredModels(): string[] {
  try {
    const raw = readFileSync(join(homedir(), '.qwen', 'settings.json'), 'utf8');
    const parsed = z.json().parse(JSON.parse(raw));
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

function buildQwenSessionLaunch(
  agent: MeshAgentView,
  context: MeshAgentSessionRuntimeContext
): MeshAgentProcessLaunchPlan {
  let args = [...(agent.args ?? [])];
  if (context.providerSessionRef && !hasFlag(args, '--resume') && !hasFlag(args, '-r')) {
    args.push('--resume', context.providerSessionRef);
  }
  const modelId = context.modelId ?? context.modelName;
  if (modelId && !hasFlag(args, '--model') && !hasFlag(args, '-m')) {
    args.push('--model', modelId);
  }
  args = withQwenSkipApprovalArgs(args, !!context.skipProviderApprovals);
  args = [...args, ...qwenExtraWorkingPathArgs(context.extraWorkingPaths)];
  args = withQwenSystemPromptArgs(args, context.startInput?.immutableInstructions?.file);
  return {
    args: withQwenStreamJsonArgs(args),
    cwd: context.workingPath,
    ...(context.env || agent.env ? { env: { ...(agent.env ?? {}), ...(context.env ?? {}) } } : {})
  };
}

function createQwenSessionRuntime(
  agent: MeshAgentView,
  context: MeshAgentSessionRuntimeContext
): SessionEventRuntimeDefinition {
  return {
    plan: {
      processModel: 'resident',
      launch: buildQwenSessionLaunch(agent, context),
      channel: { kind: 'child-stdio' },
      startup: { timeoutMs: 20_000 }
    },
    driver: new QwenSessionEventDriver()
  };
}

function buildQwenAuthLaunch(agent: MeshAgentView, args: string[]): MeshAgentLaunchSpec {
  return {
    argv: [agent.command, ...args],
    cwd: homedir(),
    env: agent.env
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
  icon: agentAdapterIcons.qwen,
  productIcon: 'qwen',
  label: 'Qwen Code',
  executionCapabilities: { autopilot: true, fastMode: false },
  observation: qwenObservationProjection,
  events: createOutputEventSource({
    provider: 'qwen',
    projection: qwenObservationProjection,
    readOutput: readQwenHistoryOutput
  }),
  settings: () => meshAgentAdapterSettings(),
  settingsImport: createBasicSettingsImport('qwen', 'Qwen Code', 'qwen', '.qwen'),
  managedRuntime: {
    env: ({ workspace, mcpServer }) => {
      if (!mcpServer) throw new Error('Qwen managed runtime requires an MCP server');
      writeManagedMcpConfigFile(join(workspace, '.qwen', 'settings.json'), mcpServer, {
        server: { trust: true }
      });
      return {};
    },
    usesManagedMcpBridge: true
  },
  unsafeArgument: (args) =>
    args.find(
      (arg, index) =>
        arg === '--yolo' || arg === '--approval-mode=yolo' || (arg === '--approval-mode' && args[index + 1] === 'yolo')
    ),
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
  unarchiveSession: unarchiveQwenSession,
  deleteSession: deleteQwenSession,
  sessionUsage: { read: readQwenSessionUsage },
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

import { z } from 'zod';
