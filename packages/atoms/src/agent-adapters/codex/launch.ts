import type { MeshAgentView } from '@monad/protocol';
import type { BuildMeshAgentLaunchOptions, MeshAgentLaunchSpec, MeshAgentModelOption } from '@monad/sdk-atom';

import { homedir } from 'node:os';
import { MeshAgentError } from '@monad/sdk-atom';

import { hasFlag, parseJsonObject, uniqueModelNames } from '../adapter-shared.ts';
import { parseMeshAgentArgumentSupport } from '../argument-support.ts';

export const CODEX_APP_BIN = '/Applications/Codex.app/Contents/Resources/codex';
export const CODEX_NON_INTERACTIVE_ENV = { CODEX_NON_INTERACTIVE: '1' };
export const CODEX_SUPPORTED_MODELS = ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex', 'gpt-5.2'];
// The app-server transports codex actually supports, declared once: `detect()` surfaces this to the
// UI and `buildCodexLaunch` gates on it, so adding a transport is a single edit here rather than two
// lists that can drift. All three are verified against the real codex binary (see test/smoke) and
// against developers.openai.com/codex/app-server: `--stdio`|`--listen stdio://` (default daemon-owned
// pipe), `--listen ws://IP:PORT`, `--listen unix://[PATH]`.
export const CODEX_APP_SERVER_TRANSPORTS = ['stdio', 'ws', 'unix'] as const;

// `--ask-for-approval never|on-request` — confirmed against developers.openai.com/codex/cli/reference;
// `untrusted` is documented as deprecated in favor of these two, so it's never produced here.
function withCodexSkipApprovalArgs(args: string[], skipProviderApprovals: boolean): string[] {
  if (!skipProviderApprovals || hasFlag(args, '--ask-for-approval')) return args;
  return [...args, '--ask-for-approval', 'never'];
}

function codexSkipApprovalArgs(args: string[], skipProviderApprovals: boolean): string[] {
  if (!skipProviderApprovals || hasFlag(args, '--ask-for-approval')) return [];
  return ['--ask-for-approval', 'never'];
}

function codexExtraWorkingPathArgs(paths: string[] | undefined): string[] {
  return (paths ?? []).flatMap((path) => ['--add-dir', path]);
}

function codexNonInteractiveEnv(env?: Record<string, string>): Record<string, string> {
  return { ...(env ?? {}), ...CODEX_NON_INTERACTIVE_ENV };
}

export function parseCodexModelOptions(output: string): MeshAgentModelOption[] {
  const catalog = parseJsonObject(output);
  const models = Array.isArray(catalog?.models) ? catalog.models : [];
  const options = models
    .map((model) => {
      if (!model || typeof model !== 'object' || Array.isArray(model)) return undefined;
      const item = model as Record<string, unknown>;
      if (item.visibility !== 'list' || typeof item.slug !== 'string') return undefined;
      return {
        value: item.slug,
        ...(typeof item.display_name === 'string' && item.display_name ? { displayName: item.display_name } : {})
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
    env: codexNonInteractiveEnv(agent.env),
    launchMode: 'pty',
    provider: 'codex',
    approvalOwnership: 'provider-owned',
    capabilities: ['pty', 'provider-approval']
  };
}

export function buildCodexLaunch(agent: MeshAgentView, opts: BuildMeshAgentLaunchOptions): MeshAgentLaunchSpec {
  let args = [...(agent.args ?? [])];
  const launchMode = opts.launchMode ?? agent.defaultLaunchMode;
  if (launchMode === 'app-server') {
    const transport = opts.appServerTransport ?? agent.appServerTransport ?? 'stdio';
    if (!(CODEX_APP_SERVER_TRANSPORTS as readonly string[]).includes(transport)) {
      // unix has quirky directory/path semantics we don't launch yet (schema keeps it for future
      // providers); the supported set is declared once in CODEX_APP_SERVER_TRANSPORTS.
      throw new MeshAgentError(
        'unsupported_capability',
        `codex app-server transport "${transport}" is not supported yet; use ${CODEX_APP_SERVER_TRANSPORTS.join(' or ')}`
      );
    }
    // stdio: the daemon owns the child's stdin/stdout. ws: codex binds an ephemeral loopback port
    // (`:0`) and prints it; the daemon parses it from stderr, then dials the WebSocket. unix: the
    // daemon allocates an AF_UNIX socket path and dials it (browser-unreachable channel).
    //
    // No `--ws-auth` is passed: codex's docs (developers.openai.com — WebSocket App Server PRs
    // #14847/#14853) document it as opt-in hardening (`capability-token`/`signed-bearer-token`) for
    // non-loopback deployments; the daemon only ever dials `ws://127.0.0.1:<port>`, and codex's own
    // guidance is that plain (unauthenticated) `ws://` is fine on loopback.
    if (transport === 'unix' && !opts.appServerSocketPath) {
      throw new MeshAgentError('provider_protocol_error', 'codex app-server unix transport requires a socket path');
    }
    const transportArgs =
      transport === 'ws'
        ? ['--listen', 'ws://127.0.0.1:0']
        : transport === 'unix'
          ? ['--listen', `unix://${opts.appServerSocketPath}`]
          : ['--stdio'];
    return {
      argv: [
        agent.command,
        ...codexExtraWorkingPathArgs(opts.extraWorkingPaths),
        ...codexSkipApprovalArgs(args, !!opts.skipProviderApprovals),
        ...(opts.mcpConfigArgs ?? []),
        'app-server',
        ...transportArgs,
        ...args
      ],
      cwd: opts.workingPath,
      env: agent.env,
      launchMode,
      appServerTransport: transport,
      provider: 'codex',
      approvalOwnership: 'provider-owned',
      capabilities: [
        'pty',
        'app-server',
        'provider-approval',
        'approval-resolution',
        'structured-output',
        'session-resume',
        'rollout-json-fallback'
      ]
    };
  }

  // --cd/-C, --no-alt-screen, --model/-m, -c key=value — all confirmed against
  // developers.openai.com/codex/cli/reference.
  const hasCd = args.includes('--cd') || args.includes('-C');
  const hasAltScreen = args.includes('--no-alt-screen');
  args = withCodexSkipApprovalArgs(args, !!opts.skipProviderApprovals);
  const modelId = opts.modelId ?? opts.modelName;
  if (modelId && !hasFlag(args, '--model') && !hasFlag(args, '-m')) {
    args.push('--model', modelId);
  }
  if (opts.reasoningEffort && !args.some((arg) => arg.startsWith('model_reasoning_effort'))) {
    args.push('-c', `model_reasoning_effort="${opts.reasoningEffort}"`);
  }
  return {
    argv: [
      agent.command,
      ...(hasCd ? [] : ['--cd', opts.workingPath]),
      ...codexExtraWorkingPathArgs(opts.extraWorkingPaths),
      ...(hasAltScreen ? [] : ['--no-alt-screen']),
      ...args
    ],
    cwd: opts.workingPath,
    env: agent.env,
    launchMode,
    provider: 'codex',
    approvalOwnership: 'provider-owned',
    capabilities: [
      'pty',
      'app-server',
      'provider-approval',
      'approval-resolution',
      'structured-output',
      'session-resume',
      'rollout-json-fallback'
    ]
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
  'runtime_info'
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
