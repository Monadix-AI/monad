import type { MeshAgentView } from '@monad/protocol';
import type { MeshAgentLaunchSpec, MeshAgentModelOption, MeshAgentProcessLaunchPlan } from '@monad/sdk-atom';

import { homedir } from 'node:os';

import { hasFlag, parseJsonObject, uniqueModelNames } from '../adapter-shared.ts';
import { parseMeshAgentArgumentSupport } from '../argument-support.ts';

export const CODEX_APP_BIN = '/Applications/Codex.app/Contents/Resources/codex';
export const CODEX_NON_INTERACTIVE_ENV = { CODEX_NON_INTERACTIVE: '1' };
export const CODEX_SUPPORTED_MODELS = ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex', 'gpt-5.2'];

function codexSkipApprovalArgs(args: string[], skipProviderApprovals: boolean): string[] {
  if (!skipProviderApprovals || hasFlag(args, '--ask-for-approval')) return [];
  return ['--ask-for-approval', 'never'];
}

function splitCodexApprovalArgs(args: string[]): { approvalArgs: string[]; remainingArgs: string[] } {
  const approvalArgs: string[] = [];
  const remainingArgs: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    if (arg === '--ask-for-approval') {
      approvalArgs.push(arg);
      const value = args[index + 1];
      if (value !== undefined) {
        approvalArgs.push(value);
        index += 1;
      }
      continue;
    }
    if (arg.startsWith('--ask-for-approval=')) {
      approvalArgs.push(arg);
      continue;
    }
    remainingArgs.push(arg);
  }
  return { approvalArgs, remainingArgs };
}

function codexExtraWorkingPathArgs(paths: string[] | undefined): string[] {
  return (paths ?? []).flatMap((path) => ['--add-dir', path]);
}

function codexNonInteractiveEnv(env?: Record<string, string>): Record<string, string> {
  return { ...(env ?? {}), ...CODEX_NON_INTERACTIVE_ENV };
}

interface CodexSessionLaunchOptions {
  workingPath: string;
  extraWorkingPaths?: string[];
  skipProviderApprovals?: boolean;
  speed?: 'standard' | 'fast';
  mcpConfigArgs?: string[];
}

function codexFastModeArgs(speed: CodexSessionLaunchOptions['speed']): string[] {
  return speed === 'fast' ? ['-c', 'features.fast_mode=true', '-c', 'service_tier="fast"'] : [];
}

export function parseCodexModelOptions(output: string): MeshAgentModelOption[] {
  const catalog = parseJsonObject(output);
  const models = Array.isArray(catalog?.models) ? catalog.models : [];
  const options = models
    .map((model) => {
      if (!model || typeof model !== 'object' || Array.isArray(model)) return undefined;
      const item = model as Record<string, unknown>;
      if (item.visibility !== 'list' || typeof item.slug !== 'string') return undefined;
      const speeds = Array.isArray(item.additional_speed_tiers)
        ? uniqueModelNames(item.additional_speed_tiers.filter((tier): tier is string => typeof tier === 'string'))
        : [];
      return {
        value: item.slug,
        ...(typeof item.display_name === 'string' && item.display_name ? { displayName: item.display_name } : {}),
        ...(speeds.length > 0 ? { speeds } : {})
      };
    })
    .filter((option): option is MeshAgentModelOption => !!option);
  const seen = new Set<string>();
  return options.filter((option) => {
    if (seen.has(option.value)) return false;
    seen.add(option.value);
    return true;
  });
}

export function parseCodexArgumentSupport(output: string): ReturnType<typeof parseMeshAgentArgumentSupport> {
  const catalog = parseJsonObject(output);
  const models = Array.isArray(catalog?.models) ? catalog.models : [];
  const reasoningEfforts = uniqueModelNames(
    models.flatMap((model) => {
      if (!model || typeof model !== 'object' || Array.isArray(model)) return [];
      const levels = (model as Record<string, unknown>).supported_reasoning_levels;
      if (!Array.isArray(levels)) return [];
      return levels
        .map((level) => {
          if (!level || typeof level !== 'object' || Array.isArray(level)) return undefined;
          const effort = (level as Record<string, unknown>).effort;
          return typeof effort === 'string' ? effort : undefined;
        })
        .filter((effort): effort is string => !!effort);
    })
  );
  const speeds = uniqueModelNames(
    models.flatMap((model) => {
      if (!model || typeof model !== 'object' || Array.isArray(model)) return [];
      const tiers = (model as Record<string, unknown>).additional_speed_tiers;
      return Array.isArray(tiers) ? tiers.filter((tier): tier is string => typeof tier === 'string') : [];
    })
  );
  const reasoningEffortsByModel: Record<string, string[]> = {};
  for (const model of models) {
    if (!model || typeof model !== 'object' || Array.isArray(model)) continue;
    const item = model as Record<string, unknown>;
    if (item.visibility !== 'list' || typeof item.slug !== 'string') continue;
    const levels = Array.isArray(item.supported_reasoning_levels) ? item.supported_reasoning_levels : [];
    const efforts = uniqueModelNames(
      levels
        .map((level) =>
          level &&
          typeof level === 'object' &&
          !Array.isArray(level) &&
          typeof (level as { effort?: unknown }).effort === 'string'
            ? (level as { effort: string }).effort
            : undefined
        )
        .filter((effort): effort is string => !!effort)
    );
    if (efforts.length > 0) reasoningEffortsByModel[item.slug] = efforts;
  }
  return { ...parseMeshAgentArgumentSupport(output), reasoningEfforts, speeds, reasoningEffortsByModel };
}

export function buildCodexAuthLaunch(agent: MeshAgentView, args: string[]): MeshAgentLaunchSpec {
  return {
    argv: [agent.command, ...args],
    cwd: homedir(),
    env: codexNonInteractiveEnv(agent.env)
  };
}

export function buildCodexSessionLaunch(
  agent: MeshAgentView,
  options: CodexSessionLaunchOptions
): MeshAgentProcessLaunchPlan {
  const { approvalArgs, remainingArgs } = splitCodexApprovalArgs([...(agent.args ?? [])]);
  return {
    args: [
      ...codexExtraWorkingPathArgs(options.extraWorkingPaths),
      ...approvalArgs,
      ...codexSkipApprovalArgs(remainingArgs, !!options.skipProviderApprovals),
      ...codexFastModeArgs(options.speed),
      ...(options.mcpConfigArgs ?? []),
      'app-server',
      '--stdio',
      ...remainingArgs
    ],
    cwd: options.workingPath,
    env: agent.env
  };
}

// Managed project-agent runtime wiring is codex-specific: codex mounts monad's managed MCP server
// (and pre-approves its tools) through repeated `-c mcp_servers.monad.*` config args, runs in
// app-server mode, needs CODEX_NON_INTERACTIVE, and its managed prompt uses the MCP-tools template.
// This lives with the adapter so the daemon's managed-runtime code stays provider-agnostic.
const CODEX_MANAGED_MCP_APPROVED_TOOLS = [
  'project_post',
  'project_ask',
  'project_read',
  'project_inbox_check',
  'project_inbox_ack',
  'agent_send',
  'agent_read',
  'session_members',
  'runtime_info',
  'project_plan_list',
  'project_plan_add',
  'project_plan_update',
  'project_plan_delete'
] as const;

function codexManagedMcpApprovalConfigArgs(): string[] {
  return CODEX_MANAGED_MCP_APPROVED_TOOLS.flatMap((tool) => [
    '-c',
    `mcp_servers.monad.tools.${tool}.approval_mode="approve"`
  ]);
}

function codexManagedMcpEnvConfigArgs(env: Record<string, string>): string[] {
  return Object.entries(env).flatMap(([key, value]) => ['-c', `mcp_servers.monad.env.${key}=${JSON.stringify(value)}`]);
}

export function codexManagedMcpConfigArgs(
  monadCliEntry: { command: string; args: string[] },
  env: Record<string, string>
): string[] {
  return [
    '-c',
    `mcp_servers.monad.command=${JSON.stringify(monadCliEntry.command)}`,
    '-c',
    `mcp_servers.monad.args=${JSON.stringify([...monadCliEntry.args, 'native-agent', 'mcp-server'])}`,
    ...codexManagedMcpEnvConfigArgs(env),
    ...codexManagedMcpApprovalConfigArgs()
  ];
}
