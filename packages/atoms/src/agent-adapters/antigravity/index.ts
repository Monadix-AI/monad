import type { MeshAgentTurnInput, MeshAgentView } from '@monad/protocol';
import type {
  MeshAgentLaunchSpec,
  MeshAgentProcessLaunchPlan,
  MeshAgentProviderAdapter,
  MeshAgentSessionRuntimeContext,
  SessionEventRuntimeDefinition
} from '@monad/sdk-atom';

import { homedir } from 'node:os';
import { join } from 'node:path';
import { defaultBinProbes, resolveBinary } from '@monad/sdk-atom';

import { hasFlag } from '../adapter-shared.ts';
import { parseMeshAgentArgumentSupport } from '../argument-support.ts';
import { createProjectedEventSource } from '../event-source.ts';
import { agentAdapterIcons } from '../icons.ts';
import { writeManagedMcpConfigFile } from '../managed-mcp-config.ts';
import { SessionEventJsonlDriver } from '../session-event-jsonl-driver.ts';
import { meshAgentAdapterSettings } from '../settings.ts';
import { listAntigravityModelOptions, parseAntigravityModelOptions } from './model-options.ts';
import { antigravityObservationProjection } from './observation.ts';
import { parseAntigravityStreamJson } from './stream-json.ts';

export { parseAntigravityModelOptions } from './model-options.ts';

function withFlag(args: string[], names: string[], name: string, value: string | undefined): string[] {
  if (!value || names.some((flag) => hasFlag(args, flag))) return args;
  return [...args, name, value];
}

function turnText(input: MeshAgentTurnInput, immutableInstructions?: string): string {
  const attachments =
    input.attachments.length === 0
      ? ''
      : `\n\nAttachments available in the workspace:\n${input.attachments
          .map((attachment) => `- ${attachment.name}: ${attachment.path}`)
          .join('\n')}`;
  const prompt = `${input.text}${attachments}`;
  return immutableInstructions ? `${immutableInstructions}\n\n${prompt}` : prompt;
}

function buildAntigravityTurnLaunch(
  agent: MeshAgentView,
  context: MeshAgentSessionRuntimeContext,
  providerSessionRef?: string
): MeshAgentProcessLaunchPlan {
  let args = [...(agent.args ?? [])];
  args = withFlag(args, ['--output-format'], '--output-format', 'stream-json');
  args = withFlag(args, ['--conversation'], '--conversation', providerSessionRef);
  args = withFlag(args, ['--model'], '--model', context.modelId ?? context.modelName);
  args = withFlag(args, ['--effort'], '--effort', context.reasoningEffort);
  for (const path of context.extraWorkingPaths ?? []) args.push('--add-dir', path);
  if (context.skipProviderApprovals && !hasFlag(args, '--dangerously-skip-permissions')) {
    args.push('--dangerously-skip-permissions');
  }
  return {
    args,
    cwd: context.workingPath,
    ...(context.env || agent.env ? { env: { ...(agent.env ?? {}), ...(context.env ?? {}) } } : {})
  };
}

function createAntigravitySessionRuntime(
  agent: MeshAgentView,
  context: MeshAgentSessionRuntimeContext
): SessionEventRuntimeDefinition {
  let firstTurn = true;
  return {
    plan: {
      processModel: 'per-turn',
      buildTurnLaunch: ({ providerSessionRef }) => buildAntigravityTurnLaunch(agent, context, providerSessionRef),
      encodeTurnInput: (input) => {
        const prompt = turnText(input, firstTurn ? context.startInput?.immutableInstructions?.text : undefined);
        firstTurn = false;
        return { delivery: 'argv-tail', values: ['--print', prompt] };
      },
      startup: { timeoutMs: 20_000 },
      continuation: { strategy: 'provider-session-ref' }
    },
    driver: new SessionEventJsonlDriver({ parseOutput: parseAntigravityStreamJson })
  };
}

function authLaunch(agent: MeshAgentView, args: string[]): MeshAgentLaunchSpec {
  return { argv: [agent.command, ...args], cwd: homedir(), env: agent.env };
}

export const antigravityMeshAgentAdapter: MeshAgentProviderAdapter = {
  provider: 'antigravity',
  icon: agentAdapterIcons.antigravity,
  productIcon: 'antigravity',
  label: 'Antigravity',
  executionCapabilities: { autopilot: true, fastMode: false },
  observation: antigravityObservationProjection,
  events: createProjectedEventSource({
    provider: 'antigravity',
    projection: antigravityObservationProjection
  }),
  settings: () => meshAgentAdapterSettings(),
  managedRuntime: {
    env: ({ workspace, mcpServer }) => {
      if (!mcpServer) throw new Error('Antigravity managed runtime requires an MCP server');
      writeManagedMcpConfigFile(join(workspace, '.agents', 'mcp_config.json'), mcpServer);
      return {};
    },
    usesManagedMcpBridge: true
  },
  unsafeArgument: (args) => args.find((arg) => arg === '--dangerously-skip-permissions'),
  detect(probes = defaultBinProbes) {
    const binary = resolveBinary('agy', [], probes);
    return {
      id: 'antigravity',
      label: antigravityMeshAgentAdapter.label,
      provider: 'antigravity',
      productIcon: antigravityMeshAgentAdapter.productIcon,
      command: 'agy',
      args: [],
      modelOptions: [],
      installHint: 'Install Antigravity CLI, then complete its browser sign-in flow.',
      installUrl: 'https://antigravity.google/docs/cli-getting-started',
      installed: binary !== undefined,
      resolvedBinPath: binary,
      capabilities: {
        auth: 'pty',
        events: 'provider-owned',
        resume: 'structured',
        approval: 'provider-owned',
        approvalProxy: false
      }
    };
  },
  resolveCommand(command, probes = defaultBinProbes) {
    return resolveBinary(command, [], probes);
  },
  listSupportedModels(agent) {
    return agent?.modelOptions ?? [];
  },
  modelOptions(agent) {
    return {
      resolve: () => listAntigravityModelOptions(agent)
    };
  },
  createSessionRuntime: createAntigravitySessionRuntime,
  buildAuthLaunch(agent) {
    return authLaunch(agent, ['models']);
  },
  buildAuthStatusLaunch(agent) {
    return authLaunch(agent, ['models']);
  },
  authStatus(agent) {
    return {
      launch: authLaunch(agent, ['models']),
      parse: (output, exitCode) => antigravityMeshAgentAdapter.parseAuthStatus(output, exitCode)
    };
  },
  argumentSupport(agent) {
    return {
      launch: authLaunch(agent, ['--help']),
      parse: (output) => parseMeshAgentArgumentSupport(output)
    };
  },
  parseAuthStatus(output, exitCode) {
    if (/not logged into antigravity|authentication failed|timed out/i.test(output)) return 'unauthenticated';
    if (exitCode === 0 && parseAntigravityModelOptions(output).length > 0) return 'authenticated';
    return 'unknown';
  }
};
